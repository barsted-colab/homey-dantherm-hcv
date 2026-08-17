'use strict';

/**
 * Shared backend for the dashboard widgets.
 *
 * Both widgets show the same unit from different distances, so the state they
 * read has to be the same state. Keeping it here rather than in each widget's
 * api.js means a field cannot quietly mean one thing in the compact view and
 * something else in the detailed one.
 *
 * Values come from the paired device's capabilities, never from Modbus: the
 * controller accepts only three concurrent sockets and the poll loop already
 * holds one, so a dashboard refreshing every few seconds must not open more.
 */

const { recoveryEfficiency, recoveredHeat } = require('./dantherm');

const DRIVER_ID = 'hcv';

/**
 * Resolves the device a widget was pointed at.
 *
 * The SDK documents no public accessor for Homey's own device UUID, so the id
 * the widget passes cannot be matched with certainty. The undocumented internal
 * fields are tried first, and a single paired unit — which is what nearly every
 * installation has — resolves without them.
 */
function resolveDevice(homey, deviceId) {
  const devices = homey.drivers.getDriver(DRIVER_ID).getDevices();
  if (!devices.length) return null;

  if (deviceId) {
    const match = devices.find((device) => [device.__id, device.id, device.getData?.().id]
      .some((value) => value && String(value) === String(deviceId)));
    if (match) return match;
  }

  return devices.length === 1 ? devices[0] : null;
}

function read(device, capability) {
  if (!device.hasCapability(capability)) return null;
  const value = device.getCapabilityValue(capability);
  return value === undefined ? null : value;
}

function buildState(homey, deviceId) {
  const device = resolveDevice(homey, deviceId);
  if (!device) return { available: false, reason: 'no_device' };

  if (!device.getAvailable()) {
    return {
      available: false,
      reason: 'unavailable',
      name: device.getName(),
      message: device.getUnavailableMessage?.() || null,
    };
  }

  const temperatures = {
    outdoor: read(device, 'measure_temperature.outdoor'),
    supply: read(device, 'measure_temperature.supply'),
    extract: read(device, 'measure_temperature.extract'),
    exhaust: read(device, 'measure_temperature.exhaust'),
    room: read(device, 'measure_temperature.room'),
  };

  const bypass = read(device, 'dantherm_bypass');
  const bypassOpen = bypass === 'opened' || bypass === 'opening';
  const airflow = {
    supply: read(device, 'measure_airflow.supply'),
    extract: read(device, 'measure_airflow.extract'),
  };

  return {
    available: true,
    name: device.getName(),
    model: device.getStoreValue('modelName') || null,
    mode: read(device, 'dantherm_mode'),
    fanLevel: Number(read(device, 'dantherm_fan_level') ?? 0),
    onoff: read(device, 'onoff'),
    temperatures,
    humidity: read(device, 'measure_humidity'),
    airQuality: read(device, 'measure_air_quality'),
    bypass,
    bypassOpen,
    // The exchanger is out of the loop while the damper is open, so both of
    // these would be measuring something that is not happening.
    efficiency: bypassOpen ? null : recoveryEfficiency(temperatures),
    recovered: bypassOpen
      ? null
      : recoveredHeat(airflow.supply, temperatures.supply, temperatures.outdoor),
    airflow,
    // What the commissioning report says this unit should move at its nominal
    // level, so a gauge can show the current flow as a share of it.
    airflowNominal: device.getSetting('airflow_enabled')
      ? device.getSetting('airflow_extract_nominal') || null
      : null,
    power: read(device, 'measure_power'),
    filterDays: read(device, 'measure_filter_remain'),
    alarm: read(device, 'alarm_generic'),
    fanSpeeds: {
      extract: read(device, 'measure_rpm.fan1'),
      supply: read(device, 'measure_rpm.fan2'),
    },
  };
}

async function setFanLevel(homey, body) {
  const device = resolveDevice(homey, body?.deviceId);
  if (!device) throw new Error('Device not found');

  const level = Number(body?.level);
  if (!Number.isInteger(level) || level < 0 || level > 4) {
    throw new Error('Fan level must be 0-4');
  }

  await device.setFanLevel(level);
  return { ok: true, level };
}

async function setMode(homey, body) {
  const device = resolveDevice(homey, body?.deviceId);
  if (!device) throw new Error('Device not found');

  await device.setMode(String(body?.mode));
  return { ok: true, mode: body.mode };
}

module.exports = {
  buildState, setFanLevel, setMode, resolveDevice,
};
