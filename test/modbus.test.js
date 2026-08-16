'use strict';

/**
 * Exercises the Modbus TCP client and the Dantherm layer against an in-process
 * fake controller, so framing, component gating and the error paths are covered
 * without hardware.
 *
 * Every test registers its teardown with t.after() — a fake unit left listening
 * keeps the event loop alive and hangs the whole run, which turns one failed
 * assertion into a stalled CI job rather than a red one.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const ModbusTCP = require('../lib/modbus-tcp');
const {
  DanthermDevice, REG, COMPONENT, encodeFloat32,
} = require('../lib/dantherm');

/** Minimal Modbus TCP server backed by a flat register array. */
function startFakeUnit({ splitFrames = false, exception = null, failAddresses = [] } = {}) {
  const registers = new Array(1024).fill(0);
  const writes = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    socket.on('data', (frame) => {
      const transactionId = frame.readUInt16BE(0);
      const unitId = frame.readUInt8(6);
      const fc = frame.readUInt8(7);
      const address = frame.readUInt16BE(8);

      const reply = (pdu) => {
        const header = Buffer.alloc(7);
        header.writeUInt16BE(transactionId, 0);
        header.writeUInt16BE(0, 2);
        header.writeUInt16BE(pdu.length + 1, 4);
        header.writeUInt8(unitId, 6);
        const adu = Buffer.concat([header, pdu]);

        if (splitFrames) {
          socket.write(adu.subarray(0, 4));
          setTimeout(() => socket.write(adu.subarray(4)), 5);
        } else {
          socket.write(adu);
        }
      };

      if (exception) return reply(Buffer.from([fc | 0x80, exception]));
      // Illegal data address — what a unit without that option really answers.
      if (failAddresses.includes(address)) return reply(Buffer.from([fc | 0x80, 0x02]));

      if (fc === 0x03) {
        const count = frame.readUInt16BE(10);
        const data = Buffer.alloc(1 + count * 2);
        data.writeUInt8(count * 2, 0);
        for (let i = 0; i < count; i++) {
          data.writeUInt16BE(registers[address + i] & 0xFFFF, 1 + i * 2);
        }
        return reply(Buffer.concat([Buffer.from([0x03]), data]));
      }

      if (fc === 0x10) {
        const count = frame.readUInt16BE(10);
        const values = [];
        for (let i = 0; i < count; i++) {
          const value = frame.readUInt16BE(13 + i * 2);
          registers[address + i] = value;
          values.push(value);
        }
        writes.push({ address, values });
        const echo = Buffer.alloc(5);
        echo.writeUInt8(0x10, 0);
        echo.writeUInt16BE(address, 1);
        echo.writeUInt16BE(count, 3);
        return reply(echo);
      }

      return reply(Buffer.from([fc | 0x80, 0x01]));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        registers,
        writes,
        close: () => new Promise((done) => {
          sockets.forEach((s) => s.destroy());
          server.close(done);
        }),
      });
    });
  });
}

function seedFloat(registers, address, value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  registers[address] = buf.readUInt16BE(2);
  registers[address + 1] = buf.readUInt16BE(0);
}

function seedUInt(registers, address, value) {
  registers[address] = value & 0xFFFF;
  registers[address + 1] = (value >>> 16) & 0xFFFF;
}

/** A fully equipped unit: bypass, RH, VOC, HRC2, week program. */
const ALL_COMPONENTS = COMPONENT.BYPASS | COMPONENT.RH_SENSOR | COMPONENT.VOC_SENSOR
  | COMPONENT.HRC2 | COMPONENT.WEEK;

async function connectDevice(t, unit, components = ALL_COMPONENTS) {
  const device = new DanthermDevice({ host: '127.0.0.1', port: unit.port });
  device.components = components;
  t.after(() => device.disconnect());
  await device.connect();
  return device;
}

// --- Transport ---------------------------------------------------------------

test('reads holding registers over a real socket', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  const client = new ModbusTCP({ host: '127.0.0.1', port: unit.port });
  t.after(() => client.disconnect());

  unit.registers[100] = 0xBEEF;
  unit.registers[101] = 0xDEAD;

  await client.connect();
  assert.deepStrictEqual(await client.readHoldingRegisters(100, 2), [0xBEEF, 0xDEAD]);
});

test('reassembles responses split across TCP segments', async (t) => {
  const unit = await startFakeUnit({ splitFrames: true });
  t.after(() => unit.close());

  const client = new ModbusTCP({ host: '127.0.0.1', port: unit.port });
  t.after(() => client.disconnect());

  seedFloat(unit.registers, REG.SUPPLY_TEMP, 19.4);
  await client.connect();
  assert.strictEqual((await client.readHoldingRegisters(REG.SUPPLY_TEMP, 2)).length, 2);
});

test('surfaces Modbus exceptions as errors', async (t) => {
  const unit = await startFakeUnit({ exception: 0x02 });
  t.after(() => unit.close());

  const client = new ModbusTCP({ host: '127.0.0.1', port: unit.port });
  t.after(() => client.disconnect());

  await client.connect();
  await assert.rejects(() => client.readHoldingRegisters(9999, 2), /Illegal data address/);
});

test('serialises concurrent requests', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  const client = new ModbusTCP({ host: '127.0.0.1', port: unit.port });
  t.after(() => client.disconnect());

  unit.registers[10] = 1;
  unit.registers[20] = 2;
  unit.registers[30] = 3;

  await client.connect();
  const [a, b, c] = await Promise.all([
    client.readHoldingRegisters(10, 1),
    client.readHoldingRegisters(20, 1),
    client.readHoldingRegisters(30, 1),
  ]);
  assert.deepStrictEqual([a[0], b[0], c[0]], [1, 2, 3]);
});

// --- State decoding ----------------------------------------------------------

function seedRunningUnit(registers) {
  seedFloat(registers, REG.FAN1_SPEED, 1240.0);
  seedFloat(registers, REG.FAN2_SPEED, 1180.0);
  seedFloat(registers, REG.OUTDOOR_TEMP, -3.5);
  seedFloat(registers, REG.SUPPLY_TEMP, 19.4);
  seedFloat(registers, REG.EXTRACT_TEMP, 21.8);
  seedFloat(registers, REG.EXHAUST_TEMP, 2.1);
  seedFloat(registers, REG.ROOM_TEMP, 22.4);
  seedUInt(registers, REG.ACTIVE_MODE, 0x0002);
  seedUInt(registers, REG.HUMIDITY, 44);
  seedUInt(registers, REG.BYPASS_DAMPER, 0);
  seedUInt(registers, REG.AIR_QUALITY, 780);
  seedUInt(registers, REG.FAN_LEVEL, 2);
  seedUInt(registers, REG.CURRENT_MODE, 2);
  seedUInt(registers, REG.ALARM, 0);
  seedUInt(registers, REG.FILTER_REMAIN, 90);
  seedUInt(registers, REG.FILTER_LIFETIME, 180);
}

test('readState decodes a full unit snapshot', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());
  seedRunningUnit(unit.registers);

  const device = await connectDevice(t, unit);
  const state = await device.readState();

  assert.strictEqual(Math.round(state.fan1Speed), 1240);
  assert.strictEqual(state.outdoorTemp, -3.5);
  assert.strictEqual(Math.round(state.supplyTemp * 10) / 10, 19.4);
  assert.strictEqual(Math.round(state.roomTemp * 10) / 10, 22.4);
  assert.strictEqual(state.humidity, 44);
  assert.strictEqual(state.airQuality, 780);
  assert.strictEqual(state.fanLevel, 2);
  assert.strictEqual(state.mode, 'automatic');
  assert.strictEqual(state.bypassState, 'closed');
  assert.strictEqual(state.filterLevel, 1);
});

test('supply temperature is suppressed while the bypass damper moves', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  seedFloat(unit.registers, REG.SUPPLY_TEMP, 19.4);
  seedUInt(unit.registers, REG.BYPASS_DAMPER, 64); // opening
  seedUInt(unit.registers, REG.FAN_LEVEL, 2);
  seedUInt(unit.registers, REG.ACTIVE_MODE, 0x0002);

  const device = await connectDevice(t, unit);
  const state = await device.readState();

  assert.strictEqual(state.bypassState, 'opening');
  assert.strictEqual(state.supplyTemp, null);
});

// --- Fitting out different units in the range --------------------------------

test('a unit without optional sensors reports them as absent, not zero', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());
  seedRunningUnit(unit.registers);

  // A bare unit: no bypass, no RH, no VOC, no room sensor.
  const device = await connectDevice(t, unit, 0);
  const state = await device.readState();

  assert.strictEqual(state.humidity, null);
  assert.strictEqual(state.airQuality, null);
  assert.strictEqual(state.roomTemp, null);
  assert.strictEqual(state.bypassState, null);
  // Core readings still work.
  assert.strictEqual(state.fanLevel, 2);
  assert.strictEqual(state.mode, 'automatic');
});

test('an optional register that returns an exception does not break the poll', async (t) => {
  const unit = await startFakeUnit({ failAddresses: [REG.AIR_QUALITY, REG.ROOM_TEMP] });
  t.after(() => unit.close());
  seedRunningUnit(unit.registers);

  const device = await connectDevice(t, unit);
  const state = await device.readState();

  assert.strictEqual(state.airQuality, null);
  assert.strictEqual(state.roomTemp, null);
  assert.strictEqual(state.fanLevel, 2);
  assert.strictEqual(state.humidity, 44);
});

test('losing a core register fails the read rather than reporting a half state', async (t) => {
  const unit = await startFakeUnit({ failAddresses: [REG.FAN_LEVEL] });
  t.after(() => unit.close());
  seedRunningUnit(unit.registers);

  const device = await connectDevice(t, unit);
  await assert.rejects(() => device.readState(), /Illegal data address/);
});

test('ServoFlow units take filter condition from the dedicated register', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());
  seedRunningUnit(unit.registers);
  seedUInt(unit.registers, REG.FILTER_DIRTINESS, 2);

  const device = await connectDevice(t, unit);
  device.servoFlow = true;
  const state = await device.readState();

  assert.strictEqual(state.filterLevel, 2);
  assert.strictEqual(state.filterRemain, null); // no day counter on these units
});

test('an unrecognised device type still pairs', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());
  seedUInt(unit.registers, REG.SYSTEM_ID, (99 << 24) | 0x0044);
  seedUInt(unit.registers, REG.FIRMWARE_VERSION, 582);

  const device = await connectDevice(t, unit, 0);
  const info = await device.readInfo();

  assert.strictEqual(info.deviceType, 99);
  assert.match(info.modelName, /Dantherm \(type 99\)/);
  assert.strictEqual(info.firmwareVersion, '2.70');
  assert.strictEqual(info.components & COMPONENT.RH_SENSOR, COMPONENT.RH_SENSOR);
});

// --- Commands ----------------------------------------------------------------

test('setFanLevel forces manual mode before writing the level', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());
  seedUInt(unit.registers, REG.CURRENT_MODE, 2);

  const device = await connectDevice(t, unit);
  await device.setFanLevel(3);

  assert.deepStrictEqual(unit.writes.map((w) => w.address), [REG.ACTIVE_MODE, REG.FAN_LEVEL]);
  assert.deepStrictEqual(unit.writes[0].values, [0x0004, 0]);
  assert.deepStrictEqual(unit.writes[1].values, [3, 0]);
});

test('leaving summer mode ends it before applying the new mode', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());
  seedUInt(unit.registers, REG.CURRENT_MODE, 6); // summer

  const device = await connectDevice(t, unit);
  await device.setMode('automatic');

  assert.deepStrictEqual(unit.writes[0].values, [0x8800, 0]); // END_SUMMER
  assert.deepStrictEqual(unit.writes[1].values, [0x0002, 0]); // AUTOMATIC
});

test('rejects out-of-range fan levels', async () => {
  const device = new DanthermDevice({ host: '127.0.0.1', port: 1 });
  await assert.rejects(() => device.setFanLevel(7), /Fan level must be 0-4/);
});

// --- Configuration -----------------------------------------------------------

test('reads configuration and rounds float setpoints', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  seedFloat(unit.registers, REG.BYPASS_MIN_TEMP, 12.5);
  seedFloat(unit.registers, REG.BYPASS_MAX_TEMP, 24.0);
  seedUInt(unit.registers, REG.HUMIDITY_SETPOINT, 45);
  seedUInt(unit.registers, REG.FILTER_LIFETIME, 180);

  const device = await connectDevice(t, unit);
  device.firmware = 3.14;
  const config = await device.readConfig();

  assert.strictEqual(config.bypass_min_temp, 12.5);
  assert.strictEqual(config.bypass_max_temp, 24);
  assert.strictEqual(config.humidity_setpoint, 45);
  assert.strictEqual(config.filter_lifetime, 180);
});

test('older firmware reports unsupported settings as absent', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  const device = await connectDevice(t, unit);
  device.firmware = 2.70; // predates the summer bypass pair

  assert.strictEqual(device.supportsConfig('bypass_min_temp'), true);
  assert.strictEqual(device.supportsConfig('bypass_min_temp_summer'), false);

  const config = await device.readConfig();
  assert.strictEqual(config.bypass_min_temp_summer, null);
  await assert.rejects(
    () => device.writeConfig('bypass_max_temp_summer', 26),
    /requires firmware 3.08/,
  );
});

test('config writes are clamped to the range the controller accepts', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  const device = await connectDevice(t, unit);
  device.firmware = 3.14;

  assert.strictEqual(await device.writeConfig('humidity_setpoint', 90), 65);
  assert.strictEqual(await device.writeConfig('humidity_setpoint', 10), 35);
  assert.strictEqual(await device.writeConfig('bypass_max_temp', 24.5), 24.5);
});

test('summer bypass writes hit the reversed register pair', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  const device = await connectDevice(t, unit);
  device.firmware = 3.14;
  await device.setBypassTemperatures(13, 26, { summer: true });

  // 766 is the minimum and 764 the maximum — the opposite way round to 444/446.
  const byAddress = Object.fromEntries(unit.writes.map((w) => [w.address, w.values]));
  assert.deepStrictEqual(byAddress[766], encodeFloat32(13));
  assert.deepStrictEqual(byAddress[764], encodeFloat32(26));
});

test('rejects a bypass range that would never open the damper', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  const device = await connectDevice(t, unit);
  device.firmware = 3.14;
  await assert.rejects(
    () => device.setBypassTemperatures(25, 22),
    /minimum temperature must be below the maximum/,
  );
});

test('week program accepts 0-10 and rejects anything else', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  const device = await connectDevice(t, unit);
  await device.setWeekProgram(4);
  assert.deepStrictEqual(unit.writes[0], { address: REG.WEEK_PROGRAM, values: [4, 0] });

  await assert.rejects(() => device.setWeekProgram(11), /must be 0-10/);
});

test('away and night mode write the documented command values', async (t) => {
  const unit = await startFakeUnit();
  t.after(() => unit.close());

  const device = await connectDevice(t, unit);
  await device.setAwayMode(true);
  await device.setAwayMode(false);
  await device.setNightMode(true);
  await device.setNightMode(false);

  assert.deepStrictEqual(unit.writes.map((w) => w.values[0]), [0x0010, 0x8010, 0x0020, 0x8020]);
});
