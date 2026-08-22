'use strict';

const ModbusTCP = require('./modbus-tcp');

/**
 * Holding register addresses. Every value on this controller is 32 bit and
 * therefore occupies two consecutive registers (N and N+1) — there are no
 * 16-bit values, which is the single most common way to get this wrong.
 */
const REG = {
  SYSTEM_ID: 2, // u32 — device type in high byte, component bitmask in low word
  SERIAL_NUMBER: 4, // u64 — four registers
  FIRMWARE_VERSION: 24, // u32 — (v >> 8) & 0xFF major, v & 0xFF minor
  FAN1_SPEED: 100, // f32 — rpm
  FAN2_SPEED: 102, // f32 — rpm
  OUTDOOR_TEMP: 132, // f32 — °C
  SUPPLY_TEMP: 134, // f32 — °C
  EXTRACT_TEMP: 136, // f32 — °C
  EXHAUST_TEMP: 138, // f32 — °C
  ROOM_TEMP: 140, // f32 — °C, requires HRC2
  ACTIVE_MODE: 168, // u32 — read/write command bitmask
  HUMIDITY: 196, // u32 — %, requires RH sensor
  BYPASS_DAMPER: 198, // u32 — state enum, requires bypass
  MANUAL_BYPASS_DURATION: 264, // u32 — minutes, 60..480 step 15
  FAN_LEVEL: 324, // u32 — 0..4
  NIGHT_MODE_START_HOUR: 332, // u32
  NIGHT_MODE_START_MINUTE: 334, // u32
  NIGHT_MODE_END_HOUR: 336, // u32
  NIGHT_MODE_END_MINUTE: 338, // u32
  HUMIDITY_SETPOINT: 340, // u32 — %, 35..65
  AIR_QUALITY: 430, // u32 — ppm, requires VOC sensor
  BYPASS_MIN_TEMP: 444, // f32 — °C, firmware >= 2.70
  BYPASS_MAX_TEMP: 446, // f32 — °C, firmware >= 2.70
  SERVOFLOW_ENABLED: 448, // u32 — 1 = active
  WEEK_PROGRAM: 466, // u32 — 0..10, requires week program
  CURRENT_MODE: 472, // u32 — observed state enum
  ALARM_RESET: 514, // u32 — write only
  ALARM: 516, // u32 — 0 = no alarm
  FILTER_REMAIN: 554, // u32 — days
  FILTER_LIFETIME: 556, // u32 — days
  FILTER_RESET: 558, // u32 — write 1
  SYSTEM_ID_COMPONENTS: 610, // u32 — additional component bits
  FILTER_DIRTINESS: 612, // u32 — level, ServoFlow units only
  WORK_TIME: 624, // u32 — hours
  // Note the reversed order compared with the pair above: 764 is the MAXIMUM
  // and 766 the MINIMUM. Firmware >= 3.08 only.
  BYPASS_MAX_TEMP_SUMMER: 764, // f32 — °C, 21..30
  BYPASS_MIN_TEMP_SUMMER: 766, // f32 — °C, 12..17
};

/**
 * Writable configuration exposed as Homey device settings. `min`/`max` mirror
 * the ranges the controller accepts — it silently ignores values outside them,
 * which looks like a broken app rather than a rejected value.
 */
const CONFIG = {
  bypass_min_temp: { address: REG.BYPASS_MIN_TEMP, type: 'f32', min: 12, max: 15, firmware: 2.70 },
  bypass_max_temp: { address: REG.BYPASS_MAX_TEMP, type: 'f32', min: 21, max: 27, firmware: 2.70 },
  bypass_min_temp_summer: { address: REG.BYPASS_MIN_TEMP_SUMMER, type: 'f32', min: 12, max: 17, firmware: 3.08 },
  bypass_max_temp_summer: { address: REG.BYPASS_MAX_TEMP_SUMMER, type: 'f32', min: 21, max: 30, firmware: 3.08 },
  manual_bypass_duration: { address: REG.MANUAL_BYPASS_DURATION, type: 'u32', min: 60, max: 480, firmware: 2.70 },
  humidity_setpoint: { address: REG.HUMIDITY_SETPOINT, type: 'u32', min: 35, max: 65, firmware: 2.70 },
  filter_lifetime: { address: REG.FILTER_LIFETIME, type: 'u32', min: 0, max: 360 },
  night_mode_start_hour: { address: REG.NIGHT_MODE_START_HOUR, type: 'u32', min: 0, max: 23 },
  night_mode_start_minute: { address: REG.NIGHT_MODE_START_MINUTE, type: 'u32', min: 0, max: 59 },
  night_mode_end_hour: { address: REG.NIGHT_MODE_END_HOUR, type: 'u32', min: 0, max: 23 },
  night_mode_end_minute: { address: REG.NIGHT_MODE_END_MINUTE, type: 'u32', min: 0, max: 59 },
};

/** Values read back from REG.CURRENT_MODE. Note the gaps — 4, 7, 8, 10-15 are undocumented. */
const CURRENT_MODE = {
  0: 'standby',
  1: 'manual',
  2: 'automatic',
  3: 'week_program',
  5: 'away',
  6: 'summer',
  9: 'fireplace',
  16: 'night',
};

/**
 * Command values written to REG.ACTIVE_MODE. Bit 15 (0x8000) set means
 * "end/disable" the corresponding function.
 */
const ACTIVE_MODE = {
  AUTOMATIC: 0x0002,
  MANUAL: 0x0004,
  WEEK_PROGRAM: 0x0008,
  START_AWAY: 0x0010,
  END_AWAY: 0x8010,
  NIGHT_ENABLE: 0x0020,
  NIGHT_DISABLE: 0x8020,
  START_FIREPLACE: 0x0040,
  END_FIREPLACE: 0x8040,
  SELECT_MANUAL_BYPASS: 0x0080,
  DESELECT_MANUAL_BYPASS: 0x8080,
  START_SUMMER: 0x0800,
  END_SUMMER: 0x8800,
};

const BYPASS_STATE = {
  0: 'closed',
  1: 'in_progress',
  32: 'closing',
  64: 'opening',
  255: 'opened',
};

/** Component bitmask from (SYSTEM_ID & 0xFFFF) | (SYSTEM_ID_COMPONENTS & 0xFFFF). */
const COMPONENT = {
  FP1: 0x0001,
  WEEK: 0x0002,
  BYPASS: 0x0004,
  LR_SWITCH: 0x0008,
  INTERNAL_PREHEATER: 0x0010,
  SERVO_FLOW: 0x0020,
  RH_SENSOR: 0x0040,
  VOC_SENSOR: 0x0080,
  EXT_OVERRIDE: 0x0100,
  HAC1: 0x0200,
  HRC2: 0x0400,
  PC_TOOL: 0x0800,
  APPS: 0x1000,
  ZIGBEE: 0x2000,
  DI1_OVERRIDE: 0x4000,
  DI2_OVERRIDE: 0x8000,
};

const DEVICE_TYPES = {
  1: 'WG200', 2: 'WG300', 3: 'WG500', 4: 'HCC 2', 5: 'HCC 2 ALU',
  6: 'HCV300 ALU', 7: 'HCV500 ALU', 8: 'HCV700 ALU', 9: 'HCV400 P2',
  10: 'HCV400 E1', 11: 'HCV400 P1', 12: 'HCC 2 E1', 14: 'HCV400 P1-E1',
  15: 'HCV460 P2', 19: 'HCV460 E1', 21: 'RCV320 P2', 23: 'HCH 5 MKII',
  26: 'RCV320 P1', 27: 'RCC220 P2',
};

/**
 * Heat recovery efficiency as the temperature ratio — how much of the available
 * temperature difference the exchanger actually transfers. The unit does not
 * report this itself.
 *
 * Returns null rather than a number whenever the figure would be misleading:
 * a missing sensor, too small a difference to measure against, or a result
 * outside what a physical exchanger can produce.
 */
function recoveryEfficiency({ supply, extract, outdoor }) {
  if ([supply, extract, outdoor].some((v) => v === null || v === undefined || Number.isNaN(v))) {
    return null;
  }

  // Under a couple of degrees the ratio is dominated by sensor tolerance and
  // swings wildly between polls, which reads as a broken gauge.
  const available = extract - outdoor;
  if (Math.abs(available) < 2) return null;

  const ratio = ((supply - outdoor) / available) * 100;

  // Slightly over 100 is normal — fan motor heat lands in the supply air — but
  // far outside the range means something other than recovery is going on.
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 110) return null;
  return Math.round(ratio);
}

/**
 * Airflow, estimated from fan speed against a commissioned reference point.
 *
 * The unit measures fan RPM but not volume — only ServoFlow models have the
 * pressure sensors for that. Affinity law says flow scales linearly with speed
 * *for a fixed system curve*, so a single commissioning measurement anchors the
 * whole range. The commissioning report every Danish installation must have
 * provides exactly that anchor.
 *
 * The estimate drifts as filters load: resistance climbs, real flow drops, and
 * RPM does not move. It snaps back after a filter change.
 */
function estimateAirflow(rpm, rpmReference, flowReference) {
  // A stopped fan is a reading of zero, not a missing reading — the two must
  // not collapse together, or standby shows a blank tile instead of "0".
  if (rpm === null || rpm === undefined || Number.isNaN(rpm)) return null;
  if (!rpmReference || !flowReference) return null;
  if (rpm <= 0) return 0;
  return Math.round(flowReference * (rpm / rpmReference));
}

/**
 * Power draw, estimated from extract airflow.
 *
 * Fan power follows the cube of speed, but a pure cube law misses by up to 20%
 * across the range because the electronics draw a constant floor regardless of
 * how slowly the fans turn. Splitting it into that floor plus a cubic term
 * fits a commissioning report's three operating points to within about 4%.
 *
 * The unit itself measures no power. A full sweep of the register map across a
 * 2.45x fan speed range found ten registers that move, all of them linear with
 * speed — rpm, its integer copies, and fan output percentage. A wattmeter would
 * have scaled by nearly fifteen and been impossible to miss.
 *
 * Accurate over the range a commissioning report covers, roughly 0.85 to 1.2
 * times the nominal flow. It stays well behaved outside that — zero flow gives
 * the standing draw, and the curve is monotonic — but expect it to read low
 * near maximum fan speed, where motor efficiency falls off and the fitted
 * cubic no longer holds. The nameplate maximum is a far better guide there:
 * 170 W for an HCV 400 P2 without a preheater, against roughly 40 W at the
 * nominal setting.
 */
function estimatePower(flow, flowNominal, powerNominal, powerIdle) {
  if (flow === null || flow === undefined || !flowNominal) return null;
  if (powerNominal <= powerIdle) return null;

  const watts = powerIdle + (powerNominal - powerIdle) * ((flow / flowNominal) ** 3);
  return Math.round(watts * 10) / 10;
}

/**
 * Thermal power the exchanger hands back to the incoming air, in kW.
 *
 *   P = ṁ · cp · ΔT     ṁ = flow · ρ / 3600
 *
 * This is the heat you are not paying to produce, which makes it the figure
 * that actually justifies the unit — the efficiency percentage says how well
 * it works, this says what it is worth.
 *
 * Sensible heat only. That is the complete picture on the plastic and aluminium
 * exchangers, which move no moisture; an enthalpy exchanger (the E1 variants)
 * also transfers latent heat, and there this understates the recovery. Getting
 * that part right needs outdoor humidity, which no HCV unit measures.
 */
const AIR_DENSITY = 1.2; // kg/m³ at room conditions
const AIR_HEAT_CAPACITY = 1.006; // kJ/(kg·K)

function recoveredHeat(flow, supply, outdoor) {
  if ([flow, supply, outdoor].some((v) => v === null || v === undefined || Number.isNaN(v))) {
    return null;
  }
  if (flow <= 0) return 0;

  const massFlow = (flow * AIR_DENSITY) / 3600;
  const kw = massFlow * AIR_HEAT_CAPACITY * (supply - outdoor);

  // A negative figure means the incoming air is being cooled, which is what
  // free cooling does on purpose — but it is not recovery, so do not label it
  // as such.
  return kw < 0 ? 0 : Math.round(kw * 100) / 100;
}

// --- Codecs -----------------------------------------------------------------
//
// The controller uses word-swapped big-endian ("CDAB"): the register at
// `address` holds the LOW word and `address + 1` the HIGH word, while the two
// bytes inside each register are big-endian as usual.
//
// Buffer.readFloatLE() is NOT equivalent — that would give DCBA.

function decodeUInt32([low, high]) {
  return ((high * 0x10000) + low) >>> 0;
}

function decodeFloat32([low, high]) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(high, 0);
  buf.writeUInt16BE(low, 2);
  return buf.readFloatBE(0);
}

function decodeUInt64([w0, w1, w2, w3]) {
  return (BigInt(w3) << 48n) | (BigInt(w2) << 32n) | (BigInt(w1) << 16n) | BigInt(w0);
}

function encodeUInt32(value) {
  const v = value >>> 0;
  return [v & 0xFFFF, (v >>> 16) & 0xFFFF];
}

function encodeFloat32(value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  return [buf.readUInt16BE(2), buf.readUInt16BE(0)];
}

/**
 * Register blocks fetched in one FC3 transaction each. Grouping adjacent
 * registers keeps the poll cheap.
 *
 * `requires` gates a block on a component bit — the range spans everything from
 * a bare WG200 to a fully equipped HCV460, and asking a unit for a sensor it
 * does not have is at best meaningless and at worst a Modbus exception.
 * Only the blocks that define the unit's basic state are mandatory; the rest
 * degrade to null so one absent option cannot break the whole poll.
 */
const READ_BLOCKS = [
  { address: REG.ACTIVE_MODE, count: 2, keys: ['activeMode'], type: 'u32', required: true },
  { address: REG.FAN_LEVEL, count: 2, keys: ['fanLevel'], type: 'u32', required: true },
  { address: REG.CURRENT_MODE, count: 2, keys: ['currentMode'], type: 'u32', required: true },
  { address: REG.FAN1_SPEED, count: 4, keys: ['fan1Speed', 'fan2Speed'], type: 'f32' },
  {
    address: REG.OUTDOOR_TEMP,
    count: 8,
    keys: ['outdoorTemp', 'supplyTemp', 'extractTemp', 'exhaustTemp'],
    type: 'f32',
  },
  { address: REG.ROOM_TEMP, count: 2, keys: ['roomTemp'], type: 'f32', requires: 0x0400 },
  { address: REG.HUMIDITY, count: 2, keys: ['humidity'], type: 'u32', requires: 0x0040 },
  { address: REG.BYPASS_DAMPER, count: 2, keys: ['bypassDamper'], type: 'u32', requires: 0x0004 },
  { address: REG.AIR_QUALITY, count: 2, keys: ['airQuality'], type: 'u32', requires: 0x0080 },
  { address: REG.WEEK_PROGRAM, count: 2, keys: ['weekProgram'], type: 'u32', requires: 0x0002 },
  { address: REG.ALARM, count: 2, keys: ['alarm'], type: 'u32' },
];

class DanthermDevice {

  constructor({ host, port = 502, unitId = 1, timeout = 3000 }) {
    this.client = new ModbusTCP({ host, port, unitId, timeout });
    this.components = 0;
    this.servoFlow = false;
    this.firmware = 0;
  }

  get host() {
    return this.client.host;
  }

  async connect() {
    await this.client.connect();
  }

  disconnect() {
    this.client.disconnect();
  }

  // --- Typed register access ---

  async readUInt32(address) {
    return decodeUInt32(await this.client.readHoldingRegisters(address, 2));
  }

  async readFloat32(address) {
    return decodeFloat32(await this.client.readHoldingRegisters(address, 2));
  }

  async writeUInt32(address, value) {
    await this.client.writeMultipleRegisters(address, encodeUInt32(value));
  }

  async writeFloat32(address, value) {
    await this.client.writeMultipleRegisters(address, encodeFloat32(value));
  }

  // --- Identity ---

  /**
   * Reads device type, serial and firmware. Doubles as a connection check —
   * if the word order were wrong, deviceType would land outside DEVICE_TYPES.
   */
  async readInfo() {
    const systemId = await this.readUInt32(REG.SYSTEM_ID);
    const deviceType = systemId >>> 24;

    this.components = systemId & 0xFFFF;
    try {
      const extra = await this.readUInt32(REG.SYSTEM_ID_COMPONENTS);
      this.components |= extra & 0xFFFF;
    } catch (err) {
      // Not present on every firmware — the base mask from SYSTEM_ID stands.
    }

    const fw = await this.readUInt32(REG.FIRMWARE_VERSION);
    const major = (fw >> 8) & 0xFF;
    const minor = fw & 0xFF;
    this.firmware = major + (minor / 100);

    // ServoFlow changes where filter condition is read from, so it has to be
    // resolved before the first poll rather than guessed at every read.
    if (this.hasComponent(COMPONENT.SERVO_FLOW)) {
      try {
        this.servoFlow = (await this.readUInt32(REG.SERVOFLOW_ENABLED)) === 1;
      } catch (err) {
        this.servoFlow = false;
      }
    }

    let serialNumber = '0';
    try {
      serialNumber = decodeUInt64(await this.client.readHoldingRegisters(REG.SERIAL_NUMBER, 4)).toString();
    } catch (err) {
      // Older firmware does not expose it; pairing falls back to the IP.
    }

    return {
      deviceType,
      // An unrecognised type is still a Dantherm unit speaking this protocol —
      // name it plainly rather than refusing to pair with a newer model.
      modelName: DEVICE_TYPES[deviceType] || `Dantherm (type ${deviceType})`,
      serialNumber,
      firmwareVersion: `${major}.${String(minor).padStart(2, '0')}`,
      components: this.components,
      servoFlow: this.servoFlow,
    };
  }

  hasComponent(mask) {
    return (this.components & mask) !== 0;
  }

  // --- Bulk read ---

  async readState() {
    const state = {};
    let fatal = null;

    for (const block of READ_BLOCKS) {
      if (block.requires && !this.hasComponent(block.requires)) {
        block.keys.forEach((key) => { state[key] = null; });
        continue;
      }

      try {
        const registers = await this.client.readHoldingRegisters(block.address, block.count);
        block.keys.forEach((key, i) => {
          const pair = [registers[i * 2], registers[(i * 2) + 1]];
          state[key] = block.type === 'f32' ? decodeFloat32(pair) : decodeUInt32(pair);
        });
      } catch (err) {
        block.keys.forEach((key) => { state[key] = null; });
        if (block.required) fatal = err;
      }
    }

    // Losing the registers that define what the unit is actually doing means
    // the reading is not trustworthy — surface that rather than publishing a
    // half-empty snapshot.
    if (fatal) throw fatal;

    Object.assign(state, await this.readFilterState());

    state.mode = this.resolveMode(state);
    state.bypassState = state.bypassDamper === null
      ? null
      : (BYPASS_STATE[state.bypassDamper] || 'unknown');

    // The unit reports meaningless supply/outdoor readings while the bypass
    // damper is moving, and while summer mode bypasses the exchanger entirely.
    const damperMoving = ['in_progress', 'opening', 'closing'].includes(state.bypassState);
    if (damperMoving) {
      state.supplyTemp = null;
      state.exhaustTemp = null;
    }
    if (state.currentMode === 6) {
      state.supplyTemp = null;
      state.outdoorTemp = null;
    }

    // A zero reading from these sensors means "not fitted", not a real value.
    if (state.humidity === 0) state.humidity = null;
    if (state.airQuality === 0) state.airQuality = null;
    if (state.roomTemp !== null && (state.roomTemp > 70 || state.roomTemp < -40)) {
      state.roomTemp = null;
    }

    return state;
  }

  /**
   * ServoFlow units report filter condition as a level from a dedicated
   * register and leave the day counters at zero; everything else counts days
   * and needs the level derived in software.
   */
  async readFilterState() {
    if (this.servoFlow) {
      try {
        const level = await this.readUInt32(REG.FILTER_DIRTINESS);
        return { filterRemain: null, filterLifetime: null, filterLevel: Math.min(3, level) };
      } catch (err) {
        return { filterRemain: null, filterLifetime: null, filterLevel: null };
      }
    }

    try {
      const registers = await this.client.readHoldingRegisters(REG.FILTER_REMAIN, 4);
      const filterRemain = decodeUInt32([registers[0], registers[1]]);
      const filterLifetime = decodeUInt32([registers[2], registers[3]]);
      return { filterRemain, filterLifetime, filterLevel: this.filterLevel(filterRemain, filterLifetime) };
    } catch (err) {
      return { filterRemain: null, filterLifetime: null, filterLevel: null };
    }
  }

  /**
   * Derives the user-facing mode. The observed mode register wins for the
   * transient modes; otherwise the active command bitmask decides.
   */
  resolveMode({ currentMode, activeMode, fanLevel }) {
    if (currentMode === 5) return 'away';
    if (currentMode === 6) return 'summer';
    if (currentMode === 9) return 'fireplace';
    if (currentMode === 16) return 'night';

    if (activeMode === 0 || fanLevel === 0) return 'standby';
    if (activeMode & ACTIVE_MODE.AUTOMATIC) return 'automatic';
    if (activeMode & ACTIVE_MODE.MANUAL) return 'manual';
    if (activeMode & ACTIVE_MODE.WEEK_PROGRAM) return 'week_program';
    return 'manual';
  }

  /** 0 = fresh … 3 = replace now. Computed in software; there is no register for it. */
  filterLevel(remain, lifetime) {
    if (!lifetime || remain > lifetime) return 0;
    return Math.min(3, Math.floor((lifetime - remain) / (lifetime / 3)));
  }

  // --- Commands ---

  /**
   * The unit will not move directly from away/fireplace/summer into another
   * mode — the current one has to be ended first.
   */
  async endTransientMode() {
    const currentMode = await this.readUInt32(REG.CURRENT_MODE);
    const enders = {
      5: ACTIVE_MODE.END_AWAY,
      6: ACTIVE_MODE.END_SUMMER,
      9: ACTIVE_MODE.END_FIREPLACE,
    };
    if (enders[currentMode]) {
      await this.writeUInt32(REG.ACTIVE_MODE, enders[currentMode]);
    }
  }

  async setMode(mode) {
    await this.endTransientMode();

    switch (mode) {
      case 'automatic':
        return this.writeUInt32(REG.ACTIVE_MODE, ACTIVE_MODE.AUTOMATIC);
      case 'week_program':
        return this.writeUInt32(REG.ACTIVE_MODE, ACTIVE_MODE.WEEK_PROGRAM);
      case 'away':
        return this.writeUInt32(REG.ACTIVE_MODE, ACTIVE_MODE.START_AWAY);
      case 'fireplace':
        return this.writeUInt32(REG.ACTIVE_MODE, ACTIVE_MODE.START_FIREPLACE);
      case 'summer':
        return this.writeUInt32(REG.ACTIVE_MODE, ACTIVE_MODE.START_SUMMER);
      case 'night':
        return this.writeUInt32(REG.ACTIVE_MODE, ACTIVE_MODE.NIGHT_ENABLE);
      case 'standby':
        await this.writeUInt32(REG.ACTIVE_MODE, ACTIVE_MODE.MANUAL);
        return this.writeUInt32(REG.FAN_LEVEL, 0);
      case 'manual': {
        await this.writeUInt32(REG.ACTIVE_MODE, ACTIVE_MODE.MANUAL);
        // Manual mode with the fan parked at 0 or 4 is not a useful landing
        // spot, so nudge it to a sane level — matching the reference behaviour.
        const level = await this.readUInt32(REG.FAN_LEVEL);
        if (level === 0) return this.writeUInt32(REG.FAN_LEVEL, 1);
        if (level === 4) return this.writeUInt32(REG.FAN_LEVEL, 3);
        return undefined;
      }
      default:
        throw new Error(`Unknown mode: ${mode}`);
    }
  }

  /** Setting a level implies manual mode — automatic would override it again. */
  async setFanLevel(level) {
    if (!Number.isInteger(level) || level < 0 || level > 4) {
      throw new Error(`Fan level must be 0-4, got ${level}`);
    }
    await this.endTransientMode();
    await this.writeUInt32(REG.ACTIVE_MODE, ACTIVE_MODE.MANUAL);
    await this.writeUInt32(REG.FAN_LEVEL, level);
  }

  async setManualBypass(enabled) {
    await this.writeUInt32(
      REG.ACTIVE_MODE,
      enabled ? ACTIVE_MODE.SELECT_MANUAL_BYPASS : ACTIVE_MODE.DESELECT_MANUAL_BYPASS,
    );
  }

  async resetFilter() {
    await this.writeUInt32(REG.FILTER_RESET, 1);
  }

  async resetAlarm() {
    const alarm = await this.readUInt32(REG.ALARM);
    await this.writeUInt32(REG.ALARM_RESET, alarm);
  }

  async setWeekProgram(program) {
    if (!Number.isInteger(program) || program < 0 || program > 10) {
      throw new Error(`Week program must be 0-10, got ${program}`);
    }
    await this.writeUInt32(REG.WEEK_PROGRAM, program);
  }

  async setAwayMode(enabled) {
    await this.writeUInt32(
      REG.ACTIVE_MODE,
      enabled ? ACTIVE_MODE.START_AWAY : ACTIVE_MODE.END_AWAY,
    );
  }

  async setNightMode(enabled) {
    await this.writeUInt32(
      REG.ACTIVE_MODE,
      enabled ? ACTIVE_MODE.NIGHT_ENABLE : ACTIVE_MODE.NIGHT_DISABLE,
    );
  }

  // --- Configuration ---

  /** True when this unit's firmware is new enough for a given config key. */
  supportsConfig(key) {
    const spec = CONFIG[key];
    if (!spec) return false;
    return !spec.firmware || this.firmware >= spec.firmware;
  }

  /**
   * Reads every config value the firmware supports. Individual failures yield
   * null rather than aborting — an older unit simply has fewer settings.
   */
  async readConfig() {
    const config = {};

    for (const [key, spec] of Object.entries(CONFIG)) {
      if (!this.supportsConfig(key)) {
        config[key] = null;
        continue;
      }
      try {
        const value = spec.type === 'f32'
          ? await this.readFloat32(spec.address)
          : await this.readUInt32(spec.address);
        config[key] = spec.type === 'f32' ? Math.round(value * 10) / 10 : value;
      } catch (err) {
        config[key] = null;
      }
    }

    return config;
  }

  /** Writes one config value, clamped to the range the controller accepts. */
  async writeConfig(key, value) {
    const spec = CONFIG[key];
    if (!spec) throw new Error(`Unknown setting: ${key}`);
    if (!this.supportsConfig(key)) {
      throw new Error(`Setting ${key} requires firmware ${spec.firmware} or newer`);
    }

    const clamped = Math.min(spec.max, Math.max(spec.min, value));
    if (spec.type === 'f32') {
      await this.writeFloat32(spec.address, clamped);
    } else {
      await this.writeUInt32(spec.address, Math.round(clamped));
    }
    return clamped;
  }

  /**
   * Bypass opens for free cooling between these two temperatures, so the pair
   * has to stay ordered — a minimum above the maximum leaves the damper shut.
   */
  async setBypassTemperatures(min, max, { summer = false } = {}) {
    const minKey = summer ? 'bypass_min_temp_summer' : 'bypass_min_temp';
    const maxKey = summer ? 'bypass_max_temp_summer' : 'bypass_max_temp';

    if (min !== null && max !== null && min >= max) {
      throw new Error('Bypass minimum temperature must be below the maximum');
    }

    const written = {};
    if (min !== null) written[minKey] = await this.writeConfig(minKey, min);
    if (max !== null) written[maxKey] = await this.writeConfig(maxKey, max);
    return written;
  }

  async readWorkTime() {
    return this.readUInt32(REG.WORK_TIME);
  }

}

module.exports = {
  DanthermDevice,
  recoveryEfficiency,
  estimateAirflow,
  estimatePower,
  recoveredHeat,
  REG,
  CONFIG,
  CURRENT_MODE,
  ACTIVE_MODE,
  BYPASS_STATE,
  COMPONENT,
  DEVICE_TYPES,
  decodeUInt32,
  decodeFloat32,
  decodeUInt64,
  encodeUInt32,
  encodeFloat32,
};
