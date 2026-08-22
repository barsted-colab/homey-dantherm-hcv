'use strict';

const Homey = require('homey');
const {
  DanthermDevice, CONFIG, estimateAirflow, estimatePower, fitPowerCurve, supplyImbalance,
  coolingDecision,
} = require('../../lib/dantherm');
const { discover } = require('../../lib/discovery');

/** The controller needs ~3 s before a read reflects a preceding write. */
const WRITE_SETTLE_MS = 3000;

/** Default fan level when the unit is switched on via the onoff capability. */
const DEFAULT_ON_LEVEL = 2;

/**
 * The level Dantherm commissions at, and the one the report's Standard column
 * describes. A fixed part of the procedure rather than a property of any given
 * installation, so it is not worth a settings field.
 */
const NOMINAL_LEVEL = 3;

/**
 * Fallback negative-pressure imbalance, used until the exchanger has been
 * asked. Danish commissioning practice puts extract 4-8 % above supply, so 6 %
 * is the middle of the band rather than any particular unit's figure.
 */
const TYPICAL_IMBALANCE = 0.94;

/**
 * Summer mode keeps its own copies of the bypass thresholds. Two numbers that
 * mean the same thing invite exactly one outcome — the forgotten one quietly
 * overruling the one you set — so the settings screen shows one of each and
 * both copies are kept in step.
 */
const BYPASS_MIRRORS = {
  bypass_min_temp: 'bypass_min_temp_summer',
  bypass_max_temp: 'bypass_max_temp_summer',
};

class DanthermHCVDevice extends Homey.Device {

  async onInit() {
    this.pollTimer = null;
    this.unit = null;
    this.consecutiveFailures = 0;
    this.rediscovering = false;
    this.warnedInverted = false;

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
      // the commissioning figures the estimate is anchored to. Ticking the box
      // is not enough on its own: without the numbers these would be tiles that
      // can never hold a value, which is the same trap as the bitmask above.
      'measure_airflow.extract': this.airflowConfigured('report_flow_standard'),
      'measure_airflow.supply': this.airflowConfigured('report_flow_standard'),
      measure_power: this.airflowConfigured() && this.powerCurve() !== null,
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

  /**
   * Whether a derived reading has everything it needs. Airflow wants the
   * Standard row and power wants two rows, so each tile is asked separately
   * rather than sharing one flag.
   */
  airflowConfigured(key) {
    const s = this.getSettings();
    if (s.airflow_enabled !== true) return false;
    return key ? s[key] > 0 : true;
  }

  /** The fitted P = idle + k·Q³, or null when the report rows are too sparse. */
  powerCurve() {
    const s = this.getSettings();
    return fitPowerCurve([
      { flow: s.report_flow_min, watts: s.report_watt_min },
      { flow: s.report_flow_standard, watts: s.report_watt_standard },
      { flow: s.report_flow_boost, watts: s.report_watt_boost },
    ]);
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
      // Summer's mirrored copies are not on the settings screen, and neither is
      // anything a future version drops, so only mirror back what is shown.
      const shown = this.getSettings();
      const known = Object.fromEntries(
        Object.entries(config).filter(([key, value]) => value !== null && key in shown),
      );
      if (Object.keys(known).length) await this.setSettings(known);
      await this.alignBypassMirrors(config);
    } catch (err) {
      this.error(`Could not read configuration: ${err.message}`);
    }
  }

  /**
   * Brings summer's copies of the bypass thresholds into line with the ones on
   * the settings screen.
   *
   * Done on every connect rather than only when the user edits something. A
   * unit commissioned with a summer minimum of 17 °C will refuse to free-cool
   * on a 15 °C afternoon no matter what the screen says, and the owner has no
   * field to look at that would explain why. Waiting for an edit that may never
   * come would leave that trap armed.
   */
  async alignBypassMirrors(config) {
    for (const [source, mirror] of Object.entries(BYPASS_MIRRORS)) {
      const want = config[source];
      if (want === null || want === undefined) continue;
      if (config[mirror] === want) continue;

      try {
        const written = await this.unit.writeConfig(mirror, want);
        this.log(`Aligned ${mirror} with ${source}: ${config[mirror]} -> ${written}`);
      } catch (err) {
        this.error(`Could not align ${mirror}: ${err.message}`);
      }
    }
  }

  /**
   * The controller silently ignores out-of-range values, so writeConfig clamps
   * and returns what actually landed. Where that differs from what was typed,
   * the settings screen is corrected afterwards — leaving a rejected number on
   * screen would be a lie about the unit's state.
   */
  async applyConfigChanges(changedKeys, newSettings) {
    const corrections = {};
    const failed = [];

    for (const key of changedKeys) {
      if (!(key in CONFIG)) continue;

      // From newSettings, not getSetting — the latter still holds the previous
      // value while this handler is running, so the unit would be sent the
      // number the user just changed away from.
      const requested = newSettings[key];
      try {
        const written = await this.unit.writeConfig(key, requested);
        if (written !== requested) corrections[key] = written;

        // The mirror has its own accepted range, so it clamps on its own terms
        // and its result is deliberately not reported back to the screen.
        if (BYPASS_MIRRORS[key]) await this.unit.writeConfig(BYPASS_MIRRORS[key], requested);
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

      // Kept off the failure path: not being able to nudge the fans is not the
      // same as having lost the unit.
      await this.applyCooling(state)
        .catch((err) => this.error(`Cooling control failed: ${err.message}`));
      this.checkCoolingRecovery(state);

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
   * Leans on the fans while there is free cooling worth having.
   *
   * The unit decides for itself whether the bypass opens, and once it is open
   * the cool air comes in at whatever rate the fans happen to be running. It
   * has no notion of wanting the house cooler faster. This supplies that: run
   * up while the house is above the setpoint and the air outside is genuinely
   * colder, and hand the level back on arrival.
   *
   * The level is borrowed, not taken. Whatever it was is remembered and
   * restored — and if anything else moves it in the meantime, that is treated
   * as someone overriding us on purpose and the boost is abandoned rather than
   * fought over.
   */
  async applyCooling(state) {
    const s = this.getSettings();
    const from = this.getStoreValue('coolBoostFrom');
    let boosting = from !== null && from !== undefined;

    if (boosting && state.fanLevel !== s.cool_boost_level) {
      this.log(`Cooling boost released: level is ${state.fanLevel}, not the `
        + `${s.cool_boost_level} we set — something else has it`);
      await this.setStoreValue('coolBoostFrom', null);
      await this.setStoreValue('coolBoostMode', null);

      // Standing down properly, not just for one poll. Releasing and grabbing
      // again thirty seconds later is not deference, it is an argument — and it
      // is one the user cannot win, since the conditions that started the boost
      // are still true. Anyone putting the unit back on automatic mid-cooling
      // would watch it flip to manual again and reasonably conclude the app was
      // broken.
      await this.setStoreValue('coolBoostBlocked', true);
      this.fireCooling('cooling_stopped');
      boosting = false;
    }

    if (s.control_mode !== 'app') {
      if (boosting) await this.endCoolBoost(from, state);
      return;
    }

    const decision = coolingDecision({
      indoor: state.extractTemp,
      outdoor: state.outdoorTemp,
      setpoint: s.bypass_max_temp,
      bypassOpen: ['opened', 'opening'].includes(state.bypassState),
      mode: state.mode,
      boosting,
    });

    if (decision === 'boost') {
      // Held off until this round of cooling has run its course on its own.
      if (this.getStoreValue('coolBoostBlocked')) return;

      // Already moving more air than we would ask for — leave it alone.
      if (state.fanLevel >= s.cool_boost_level) return;

      // The mode goes with it: a fan level is only obeyed in manual, so
      // borrowing the level means borrowing the mode too.
      await this.setStoreValue('coolBoostFrom', state.fanLevel);
      await this.setStoreValue('coolBoostMode', state.mode);
      this.log(`Free cooling worth having: ${state.extractTemp.toFixed(1)} inside, `
        + `${state.outdoorTemp.toFixed(1)} outside — level ${state.fanLevel} `
        + `to ${s.cool_boost_level}`);
      await this.setFanLevel(s.cool_boost_level);
      this.fireCooling('cooling_started');
    } else if (decision === 'release') {
      await this.endCoolBoost(from, state);
    } else if (!boosting) {
      // Cooling is no longer called for, so whatever the user overrode is over.
      // Arming again here rather than on a timer means the app comes back when
      // the next warm afternoon does, not in the middle of this one.
      if (this.getStoreValue('coolBoostBlocked')) {
        await this.setStoreValue('coolBoostBlocked', null);
        this.log('Cooling no longer called for — the boost may take over again');
      }
    }
  }

  /**
   * Watches for the bypass standing open while it is warmer outside than in.
   *
   * That is the one case where an open damper actively costs you: with the
   * exchanger out of the loop the outside heat arrives undiluted, where a shut
   * damper would have let the outgoing cool air chill it on the way past. In
   * summer that is the whole point of the exchanger, running the other way.
   *
   * Closing it is the controller's job and only the controller's. The protocol
   * has a command to force the damper open and one to hand control back, but
   * none to force it shut — so all this can do is notice and say so. It should
   * never fire; if it does, the unit is not doing something every heat
   * exchanger is expected to do, and that is worth knowing about.
   */
  checkCoolingRecovery(state) {
    const settled = state.bypassState === 'opened';
    const inverted = state.outdoorTemp !== null && state.extractTemp !== null
      && state.outdoorTemp > state.extractTemp + 0.5;
    const wrong = settled && inverted;

    // Once per transition. A damper caught mid-swing on a borderline day would
    // otherwise fill the log with the same line.
    if (wrong && !this.warnedInverted) {
      this.error(`Bypass open with ${state.outdoorTemp.toFixed(1)} °C outside against `
        + `${state.extractTemp.toFixed(1)} °C inside — the exchanger should be cooling `
        + 'the incoming air, not being bypassed');
    }
    this.warnedInverted = wrong;
  }

  fireCooling(card) {
    this.homey.flow.getDeviceTriggerCard(card)
      .trigger(this)
      .catch((err) => this.error(`${card} trigger failed: ${err.message}`));
  }

  /**
   * Who runs the unit: itself, or this app.
   *
   * Written as a state rather than a pair of actions, because that is what it
   * is. An action that undoes an earlier action leaves you having to remember
   * which one you pressed last; a setting you can look at tells you where you
   * stand. It also collapses two settings that were saying the same thing
   * twice — whether the boost was allowed, and whether the app should let go.
   */
  async setControlMode(mode) {
    await this.setSettings({ control_mode: mode });
    await this.applyControlMode(mode);
  }

  async applyControlMode(mode) {
    // Choosing a side, either way, outranks having stood down earlier.
    await this.setStoreValue('coolBoostBlocked', null);

    if (mode !== 'normal') {
      this.log('Unit handed to Homey: the boost may take the fan level');
      await this.poll();
      return;
    }

    await this.handBack();
  }

  /**
   * Gives back everything the app is holding.
   *
   * Deliberately not a factory reset, and it erases nothing. The commissioning,
   * the bypass temperatures and the filter life belong to the unit and are left
   * exactly where an engineer put them. This is only the app taking its hands
   * off: the borrowed fan level and operating mode go back, and a manual bypass
   * is released so the damper is the controller's own decision again.
   */
  async handBack() {
    if (!this.unit) return;

    if (this.isCooling()) {
      const from = this.getStoreValue('coolBoostFrom');
      await this.endCoolBoost(from, await this.unit.readState());
    }
    await this.setManualBypass(false);
    this.log('Unit handed back: fan level and mode returned, manual bypass released');
  }

  /** Whether the app is currently holding the fan level up for free cooling. */
  isCooling() {
    const from = this.getStoreValue('coolBoostFrom');
    return from !== null && from !== undefined;
  }

  /** Lets a Flow hold a different cooling temperature, and keeps summer in step. */
  async setCoolSetpoint(temperature) {
    if (!this.unit) throw new Error(this.homey.__('error.not_connected'));

    const written = await this.unit.writeConfig('bypass_max_temp', temperature);
    await this.unit.writeConfig(BYPASS_MIRRORS.bypass_max_temp, temperature);
    await this.setSettings({ bypass_max_temp: written });

    if (written !== temperature) {
      this.log(`Cooling setpoint ${temperature} °C was clamped to ${written} °C by the unit`);
    }
    return written;
  }

  /** Gives the fan level back to whoever had it before the boost. */
  async endCoolBoost(from, state) {
    const mode = this.getStoreValue('coolBoostMode');
    await this.setStoreValue('coolBoostFrom', null);
    await this.setStoreValue('coolBoostMode', null);
    this.fireCooling('cooling_stopped');

    if (from !== state.fanLevel) {
      this.log(`Cooling finished — level ${state.fanLevel} back to ${from}`);
      await this.setFanLevel(from);
    }

    // After the level, never before. Setting a fan level forces the unit into
    // manual — it will not honour one otherwise — so restoring the mode first
    // would only have it knocked straight back out again. Without this the unit
    // is left in manual for good, and whoever was relying on automatic loses
    // humidity-driven ventilation without being told.
    if (mode && mode !== state.mode && mode !== 'manual') {
      this.log(`Cooling finished — mode back to ${mode}`);
      await this.setMode(mode);
    }
  }

  /**
   * Scales fan speed into airflow, and airflow into power draw.
   *
   * Both need figures the unit cannot supply — it measures speed, not volume
   * or watts — so they come from the commissioning report for THIS unit.
   * Nothing is assumed: an HCV 700 moving three times the air has its own
   * numbers in its own report, and a default borrowed from another
   * installation would be a plausible-looking lie.
   *
   * The two halves fail independently. Airflow needs one flow figure; power
   * needs two operating points, because with one the standing draw cannot be
   * told apart from the fan power.
   *
   * Both fans are anchored to that one flow figure — a balanced unit is meant
   * to move the same volume each way, and the few percent a report records
   * between supply and extract is commissioning tolerance. Each fan is then
   * scaled by its own speed, so the two readings part company when the unit
   * actually runs them apart: summer bypass stops the supply fan while extract
   * keeps going, and the tiles show exactly that.
   */
  estimateFlows(state) {
    const absent = { extract: null, supply: null, power: null };
    const nominal = this.getSetting('report_flow_standard');
    if (!this.airflowConfigured('report_flow_standard')) return absent;

    let extractRef = this.getStoreValue('rpmExtractRef');
    let supplyRef = this.getStoreValue('rpmSupplyRef');

    // The fan speeds behind that figure are captured rather than typed in:
    // they are the unit's own measurements, and asking for them would be
    // asking the user to read a value the app is already holding.
    if ((!extractRef || !supplyRef)
      && state.fanLevel === NOMINAL_LEVEL
      && state.fan1Speed > 0 && state.fan2Speed > 0) {
      extractRef = Math.round(state.fan1Speed);
      supplyRef = Math.round(state.fan2Speed);

      this.log(`Captured airflow reference at level ${NOMINAL_LEVEL}: `
        + `${extractRef} rpm extract, ${supplyRef} rpm supply`);
      Promise.all([
        this.setStoreValue('rpmExtractRef', extractRef),
        this.setStoreValue('rpmSupplyRef', supplyRef),
      ]).catch((err) => this.error(`Could not store airflow reference: ${err.message}`));
    }

    const extract = estimateAirflow(state.fan1Speed, extractRef, nominal);

    return {
      extract,
      supply: estimateAirflow(state.fan2Speed, supplyRef, nominal * this.imbalance(state)),
      power: estimatePower(extract, this.powerCurve()),
    };
  }

  /**
   * How much less air comes in than goes out, as a factor on the extract flow.
   *
   * Read off the exchanger where the weather allows it, since that answer is
   * this installation's own. It only works with a real temperature difference
   * to divide by, so the last good reading is kept and used through the mild
   * months, and a unit commissioned in summer falls back on the typical figure
   * until the first cold spell settles it.
   */
  imbalance(state) {
    if (state.bypassState !== 'closed' && state.bypassState !== null) {
      return this.getStoreValue('supplyRatio') || TYPICAL_IMBALANCE;
    }

    const measured = supplyImbalance({
      supply: state.supplyTemp,
      outdoor: state.outdoorTemp,
      extract: state.extractTemp,
      exhaust: state.exhaustTemp,
    });

    if (measured !== null && measured !== this.getStoreValue('supplyRatio')) {
      this.log(`Exchanger balance puts supply at ${(measured * 100).toFixed(1)} % of extract`);
      this.setStoreValue('supplyRatio', measured)
        .catch((err) => this.error(`Could not store supply ratio: ${err.message}`));
    }

    return measured ?? this.getStoreValue('supplyRatio') ?? TYPICAL_IMBALANCE;
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

  async onSettings({ newSettings, changedKeys }) {
    const failed = this.unit ? await this.applyConfigChanges(changedKeys, newSettings) : [];

    const report = changedKeys.filter((k) => k.startsWith('report_'));

    // A re-typed flow figure describes a different operating point, so the
    // speeds captured against the old one no longer belong to it.
    if (report.includes('report_flow_standard')) {
      await this.setStoreValue('rpmExtractRef', null);
      await this.setStoreValue('rpmSupplyRef', null);
    }

    const reconnect = report.length
      || ['host', 'port', 'airflow_enabled'].some((k) => changedKeys.includes(k));

    if (changedKeys.includes('polling_interval')) {
      this.startPolling();
    }

    // Deferred rather than awaited: getSettings() still returns the old values
    // until this handler resolves, and connectUnit decides the capability set
    // from them. Reconnecting inline would read the settings the user just
    // replaced and, for instance, leave the airflow tiles switched off.
    if (reconnect) {
      this.homey.setTimeout(() => {
        this.connectUnit().catch((err) => this.error(`Reconnect failed: ${err.message}`));
      }, 500);
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
