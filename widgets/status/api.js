'use strict';

/**
 * Widget API. Reads straight from the paired device's capability values rather
 * than hitting the unit over Modbus, so a dashboard refreshing every few
 * seconds cannot outpace the controller — it accepts only three concurrent
 * sockets and one poll loop is already using one.
 */

const { recoveryEfficiency, recoveredHeat } = require('../../lib/dantherm');

const DRIVER_ID = 'hcv';

/**
 * Resolves the device the widget was pointed at.
 *
 * The SDK does not document a public accessor for Homey's own device UUID, so
 * the id the widget hands us cannot be matched with certainty. The undocumented
 * internal fields are tried first, and a single paired unit — which is what
 * nearly every installation has — resolves unambiguously without them.
 */
function resolveDevice(homey, deviceId) {
  const devices = homey.drivers.getDriver(DRIVER_ID).getDevices();
  if (!devices.length) return null;

  if (deviceId) {
    const match = devices.find((device) => {
      const candidates = [device.__id, device.id, device.getData?.().id];
      return candidates.some((value) => value && String(value) === String(deviceId));
    });
    if (match) return match;
  }

  return devices.length === 1 ? devices[0] : null;
}

function read(device, capability) {
  if (!device.hasCapability(capability)) return null;
  const value = device.getCapabilityValue(capability);
  return value === undefined ? null : value;
}

module.exports = {

  async getState({ homey, query }) {
    const device = resolveDevice(homey, query?.deviceId);
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
      // The exchanger is out of the loop while the damper is open, so any
      // efficiency figure calculated then would be meaningless.
      efficiency: bypassOpen ? null : recoveryEfficiency(temperatures),
      filterDays: read(device, 'measure_filter_remain'),
      airflow: {
        supply: read(device, 'measure_airflow.supply'),
        extract: read(device, 'measure_airflow.extract'),
      },
      power: read(device, 'measure_power'),
      // The heat the exchanger hands back — what the unit is actually worth,
      // as opposed to how well it works. Meaningless with the bypass open.
      recovered: bypassOpen
        ? null
        : recoveredHeat(read(device, 'measure_airflow.supply'), temperatures.supply, temperatures.outdoor),
      alarm: read(device, 'alarm_generic'),
      fanSpeeds: {
        fan1: read(device, 'measure_rpm.fan1'),
        fan2: read(device, 'measure_rpm.fan2'),
      },
    };
  },

  async setMode({ homey, body }) {
    const device = resolveDevice(homey, body?.deviceId);
    if (!device) throw new Error('Device not found');
    await device.setMode(String(body?.mode));
    return { ok: true, mode: body.mode };
  },

  async setFanLevel({ homey, body }) {
    const device = resolveDevice(homey, body?.deviceId);
    if (!device) throw new Error('Device not found');

    const level = Number(body?.level);
    if (!Number.isInteger(level) || level < 0 || level > 4) {
      throw new Error('Fan level must be 0-4');
    }

    await device.setFanLevel(level);
    return { ok: true, level };
  },

};
