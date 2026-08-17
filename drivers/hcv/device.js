'use strict';

const Homey = require('homey');
const {
  DanthermDevice, CONFIG, estimateAirflow, estimatePower,
} = require('../../lib/dantherm');
const { discover } = require('../../lib/discovery');

/** The controller needs ~3 s before a read reflects a preceding write. */
const WRITE_SETTLE_MS = 3000;

/** Default fan level when the unit is switched on via the onoff capability. */
const DEFAULT_ON_LEVEL = 2;

class DanthermHCVDevice extends Homey.Device {

  async onInit() {
    this.pollTimer = null;
    this.unit = null;
    this.consecutiveFailures = 0;
    this.rediscovering = false;

    this.registerCapabilityListener('onoff', (value) => this.onCapabilityOnoff(value));
    this.registerCapabilityListener('dantherm_mode', (value) => this.setMode(value));
    this.registerCapabilityListener('dantherm_fan_level', (value) => this.setFanLevel(Number(value)));

    await this.connectUnit();
    this.startPolling();

    this.log(`Dantherm HCV device initialised (${this.getSetting('host')})`);
  }

  // --- Connection ---

  async connectUnit() {
    const host = this.getSetting('host');
    const port = this.getSetting('port') || 502;

    if (!host) {
      await this.setUnavailable(this.homey.__('error.no_ip'));
      return;
    }

    if (this.unit) this.unit.disconnect();
    this.unit = new DanthermDevice({ host, port });

    try {
      await this.unit.connect();
      const info = await this.unit.readInfo();

      await this.setStoreValue('modelName', info.modelName);
      await this.setStoreValue('firmwareVersion', info.firmwareVersion);
      await this.setStoreValue('components', info.components);
      // Kept for re-discovery: the serial survives an IP change, the IP does not.
      if (info.serialNumber !== '0') await this.setStoreValue('serialNumber', info.serialNumber);

      // One real reading before deciding the capability set — see syncCapabilities.
      const state = await this.unit.readState();
      await this.syncCapabilities(info, state);
      await this.applyState(state);
      await this.loadConfig();

      await this.setAvailable();
      this.log(`Connected to ${info.modelName}, firmware ${info.firmwareVersion}, `
        + `components 0x${info.components.toString(16).padStart(4, '0')}`);
    } catch (err) {
      this.error(`Connection failed: ${err.message}`);
      await this.setUnavailable(err.message);
    }
  }

  /**
   * The range spans everything from a bare WG200 to a fully equipped HCV460,
   * so the capability set is decided per unit.
   *
   * The component bitmask alone is not enough: a controller happily reports
   * HRC2 and VOC support while neither sensor is actually fitted, and then
   * answers 88 °C and 0 ppm forever. So the bitmask acts as the precondition
   * and the first real reading casts the deciding vote — a tile that can never
   * hold a value is worse than no tile at all.
   */
  async syncCapabilities(info, state) {
    const optional = {
      'measure_temperature.room': (info.components & 0x0400) !== 0 && state.roomTemp !== null,
      measure_humidity: (info.components & 0x0040) !== 0 && state.humidity !== null,
      measure_air_quality: (info.components & 0x0080) !== 0 && state.airQuality !== null,
      dantherm_bypass: (info.components & 0x0004) !== 0 && state.bypassState !== null,
      // ServoFlow units report a condition level instead of counting down days.
      measure_filter_remain: !info.servoFlow && state.filterRemain !== null,
      // Derived rather than measured — only shown when the user has supplied
      // the commissioning figures the estimate is anchored to.
      'measure_airflow.extract': this.getSetting('airflow_enabled') === true,
      'measure_airflow.supply': this.getSetting('airflow_enabled') === true,
      measure_power: this.getSetting('airflow_enabled') === true,
    };

    for (const [capability, supported] of Object.entries(optional)) {
      try {
        if (supported && !this.hasCapability(capability)) {
          await this.addCapability(capability);
          this.log(`Added capability ${capability}`);
        } else if (!supported && this.hasCapability(capability)) {
          await this.removeCapability(capability);
          this.log(`Removed unsupported capability ${capability}`);
        }
      } catch (err) {
        this.error(`Could not sync capability ${capability}: ${err.message}`);
      }
    }
  }

  // --- Configuration ---

  /**
   * Mirrors the unit's own configuration into the settings screen. Values the
   * firmware does not support come back null and are left untouched, so an
   * older unit simply shows the defaults rather than zeroes.
   */
  async loadConfig() {
    if (!this.unit) return;

    try {
      const config = await this.unit.readConfig();
      const known = Object.fromEntries(
        Object.entries(config).filter(([, value]) => value !== null),
      );
      if (Object.keys(known).length) await this.setSettings(known);
    } catch (err) {
      this.error(`Could not read configuration: ${err.message}`);
    }
  }

  /**
   * The controller silently ignores out-of-range values, so writeConfig clamps
   * and returns what actually landed. Where that differs from what was typed,
   * the settings screen is corrected afterwards — leaving a rejected number on
   * screen would be a lie about the unit's state.
   */
  async applyConfigChanges(changedKeys) {
    const corrections = {};
    const failed = [];

    for (const key of changedKeys) {
      if (!(key in CONFIG)) continue;

      const requested = this.getSetting(key);
      try {
        const written = await this.unit.writeConfig(key, requested);
        if (written !== requested) corrections[key] = written;
      } catch (err) {
        this.error(`Could not write ${key}: ${err.message}`);
        failed.push(key);
      }
    }

    if (Object.keys(corrections).length) {
      // Deferred: setSettings must not run while onSettings is still resolving.
      this.homey.setTimeout(() => {
        this.setSettings(corrections).catch((err) => this.error(err.message));
      }, 1000);
    }

    return failed;
  }

  // --- Polling ---

  startPolling() {
    this.stopPolling();
    const interval = Math.max(10, this.getSetting('polling_interval') || 30);
    this.pollTimer = this.homey.setInterval(() => this.poll(), interval * 1000);
    this.poll();
  }

  stopPolling() {
    if (!this.pollTimer) return;
    this.homey.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async poll() {
    if (!this.unit) return;

    try {
      if (!this.unit.client.connected) await this.unit.connect();

      const state = await this.unit.readState();
      await this.applyState(state);

      this.consecutiveFailures = 0;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.consecutiveFailures += 1;
      this.error(`Poll failed (${this.consecutiveFailures}): ${err.message}`);

      // Tolerate a couple of dropped polls before flagging the device — a
      // single timeout on a busy network is not worth alarming the user over.
      if (this.consecutiveFailures >= 3) {
        await this.setUnavailable(err.message);
        if (this.unit) this.unit.disconnect();

        // The usual cause of a unit going quiet for good is a new DHCP lease,
        // not a broken unit. Look for it again before giving up.
        if (this.consecutiveFailures % 3 === 0) await this.rediscover();
      }
    }
  }

  /**
   * Finds the unit again after its IP changed and updates the stored address.
   *
   * Matching is on serial number: the IP is exactly the thing that just became
   * unreliable, so anything keyed on it would defeat the purpose. Units that
   * never reported a serial fall back to being the only answer on the network.
   */
  async rediscover() {
    if (this.rediscovering || !this.getSetting('auto_rediscover')) return false;

    const serial = this.getStoreValue('serialNumber');
    const currentHost = this.getSetting('host');
    const port = this.getSetting('port') || 502;

    this.rediscovering = true;
    try {
      const candidates = await discover({ logger: (msg) => this.log(msg) });
      this.log(`Re-discovery found ${candidates.length} candidate(s)`);

      for (const { host } of candidates) {
        if (host === currentHost) continue;

        const probe = new DanthermDevice({ host, port, timeout: 2000 });
        try {
          await probe.connect();
          const info = await probe.readInfo();
          const sameUnit = serial ? info.serialNumber === serial : candidates.length === 1;

          if (sameUnit) {
            this.log(`Unit moved from ${currentHost} to ${host} — updating`);
            await this.setSettings({ host });
            await this.connectUnit();
            this.consecutiveFailures = 0;
            return true;
          }
        } catch (err) {
          this.log(`Candidate ${host} did not answer: ${err.message}`);
        } finally {
          probe.disconnect();
        }
      }

      return false;
    } catch (err) {
      this.error(`Re-discovery failed: ${err.message}`);
      return false;
    } finally {
      this.rediscovering = false;
    }
  }

  async applyState(state) {
    const previous = {
      bypass: this.getCapabilityValue('dantherm_bypass'),
      alarm: this.getCapabilityValue('alarm_generic'),
      mode: this.getCapabilityValue('dantherm_mode'),
      fanLevel: this.getCapabilityValue('dantherm_fan_level'),
      filterLevel: this.getStoreValue('filterLevel'),
    };

    await this.setCapability('onoff', state.fanLevel > 0);
    await this.setCapability('dantherm_mode', state.mode);
    await this.setCapability('dantherm_fan_level', String(state.fanLevel));
    await this.setCapability('measure_temperature.outdoor', state.outdoorTemp);
    await this.setCapability('measure_temperature.supply', state.supplyTemp);
    await this.setCapability('measure_temperature.extract', state.extractTemp);
    await this.setCapability('measure_temperature.exhaust', state.exhaustTemp);
    await this.setCapability('measure_temperature.room', state.roomTemp);
    await this.setCapability('measure_humidity', state.humidity);
    await this.setCapability('measure_air_quality', state.airQuality);
    await this.setCapability('dantherm_bypass', state.bypassState);
    await this.setCapability('measure_filter_remain', state.filterRemain);
    await this.setCapability('measure_rpm.fan1', this.round(state.fan1Speed));
    await this.setCapability('measure_rpm.fan2', this.round(state.fan2Speed));

    const estimated = this.estimateFlows(state);
    await this.setCapability('measure_airflow.extract', estimated.extract);
    await this.setCapability('measure_airflow.supply', estimated.supply);
    await this.setCapability('measure_power', estimated.power);
    await this.setCapability('alarm_generic', state.alarm === null ? null : state.alarm !== 0);

    await this.triggerOnChange(state, previous);
  }

  async triggerOnChange(state, previous) {
    const { flow } = this.homey;
    const fire = (card, tokens) => flow.getDeviceTriggerCard(card)
      .trigger(this, tokens)
      .catch((err) => this.error(`${card} trigger failed: ${err.message}`));

    // A null previous value means this is the first reading after start-up.
    // Firing then would announce "changed" for something that merely became
    // known, so every trigger below requires a genuine transition.
    if (previous.bypass !== null && state.bypassState !== null
      && previous.bypass !== state.bypassState) {
      await fire('bypass_changed', { state: state.bypassState });
    }

    if (previous.mode !== null && previous.mode !== state.mode) {
      await fire('mode_changed', { mode: state.mode });
    }

    const fanLevel = String(state.fanLevel);
    if (previous.fanLevel !== null && previous.fanLevel !== fanLevel) {
      await fire('fan_level_changed', { level: state.fanLevel });
    }

    // A failed alarm read is not an alarm — only a real non-zero code is.
    const hasAlarm = state.alarm !== null && state.alarm !== 0;
    if (hasAlarm && previous.alarm !== true) {
      await fire('alarm_raised', { code: state.alarm });
    }

    if (state.filterLevel !== previous.filterLevel) {
      await this.setStoreValue('filterLevel', state.filterLevel);
      if (state.filterLevel === 3 && previous.filterLevel !== undefined
        && previous.filterLevel !== null) {
        await fire('filter_needs_replacement');
      }
    }
  }

  /**
   * Scales fan speed into airflow, and airflow into power draw.
   *
   * Both need a commissioned reference point, which the unit cannot supply —
   * it measures speed, not volume. The user provides the volumes from their
   * commissioning report; the matching fan speeds are captured here the first
   * time the unit is seen running at that level, so the two halves of the
   * reference always come from the same operating point.
   */
  estimateFlows(state) {
    const absent = { extract: null, supply: null, power: null };
    const s = this.getSettings();
    if (!s.airflow_enabled) return absent;

    let extractRef = s.airflow_rpm_extract_ref;
    let supplyRef = s.airflow_rpm_supply_ref;

    if ((!extractRef || !supplyRef)
      && state.fanLevel === s.airflow_nominal_level
      && state.fan1Speed > 0 && state.fan2Speed > 0) {
      extractRef = Math.round(state.fan1Speed);
      supplyRef = Math.round(state.fan2Speed);

      this.log(`Captured airflow reference at level ${state.fanLevel}: `
        + `${extractRef} rpm extract, ${supplyRef} rpm supply`);
      this.setSettings({
        airflow_rpm_extract_ref: extractRef,
        airflow_rpm_supply_ref: supplyRef,
      }).catch((err) => this.error(`Could not store airflow reference: ${err.message}`));
    }

    const extract = estimateAirflow(state.fan1Speed, extractRef, s.airflow_extract_nominal);
    const supply = estimateAirflow(state.fan2Speed, supplyRef, s.airflow_supply_nominal);

    return {
      extract,
      supply,
      power: estimatePower(extract, s.airflow_extract_nominal, s.power_nominal, s.power_idle),
    };
  }

  /** Rounds without turning an absent reading into a hard zero. */
  round(value) {
    return value === null || value === undefined ? null : Math.round(value);
  }

  /** Skips null values so a temporarily invalid reading does not clear insights. */
  async setCapability(capability, value) {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;

    await this.setCapabilityValue(capability, value)
      .catch((err) => this.error(`Could not set ${capability}: ${err.message}`));
  }

  // --- Commands ---

  /** Runs a write, then re-polls once the controller has settled. */
  async command(fn) {
    if (!this.unit) throw new Error(this.homey.__('error.not_connected'));

    try {
      if (!this.unit.client.connected) await this.unit.connect();
      await fn(this.unit);
    } catch (err) {
      this.error(`Command failed: ${err.message}`);
      throw new Error(this.homey.__('error.command_failed'));
    }

    this.homey.setTimeout(() => this.poll(), WRITE_SETTLE_MS);
  }

  async onCapabilityOnoff(value) {
    return value
      ? this.command((unit) => unit.setFanLevel(DEFAULT_ON_LEVEL))
      : this.command((unit) => unit.setMode('standby'));
  }

  async setMode(mode) {
    return this.command((unit) => unit.setMode(mode));
  }

  async setFanLevel(level) {
    return this.command((unit) => unit.setFanLevel(level));
  }

  async setManualBypass(enabled) {
    return this.command((unit) => unit.setManualBypass(enabled));
  }

  async resetFilter() {
    return this.command((unit) => unit.resetFilter());
  }

  async resetAlarm() {
    return this.command((unit) => unit.resetAlarm());
  }

  async setAwayMode(enabled) {
    return this.command((unit) => unit.setAwayMode(enabled));
  }

  async setNightMode(enabled) {
    return this.command((unit) => unit.setNightMode(enabled));
  }

  async setWeekProgram(program) {
    return this.command((unit) => unit.setWeekProgram(program));
  }

  /**
   * Writing the thresholds from a Flow bypasses the settings screen, so the
   * stored settings are refreshed afterwards to keep the two views in step.
   */
  async setBypassTemperatures(min, max, summer) {
    await this.command((unit) => unit.setBypassTemperatures(min, max, { summer }));
    await this.loadConfig();
  }

  // --- Lifecycle ---

  async onSettings({ changedKeys }) {
    const failed = this.unit ? await this.applyConfigChanges(changedKeys) : [];

    if (changedKeys.includes('host') || changedKeys.includes('port')) {
      await this.connectUnit();
    }
    if (changedKeys.includes('polling_interval')) {
      this.startPolling();
    }
    if (changedKeys.includes('airflow_enabled')) {
      // Adding or dropping the estimated tiles needs the identity and a fresh
      // reading, which connectUnit gathers in one pass.
      await this.connectUnit();
    }

    if (failed.length) {
      throw new Error(this.homey.__('error.setting_rejected', { keys: failed.join(', ') }));
    }
  }

  async onDeleted() {
    this.stopPolling();
    if (this.unit) this.unit.disconnect();
    this.log('Dantherm HCV device removed');
  }

  async onUninit() {
    this.stopPolling();
    if (this.unit) this.unit.disconnect();
  }

}

module.exports = DanthermHCVDevice;
