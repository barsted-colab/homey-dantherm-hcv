'use strict';

const Homey = require('homey');
const { discover } = require('../../lib/discovery');
const { DanthermDevice } = require('../../lib/dantherm');

class DanthermDriver extends Homey.Driver {

  async onInit() {
    this.log('Dantherm HCV driver initialised');
  }

  /**
   * Broadcast-discovers units, then queries each one over Modbus so the pairing
   * list shows the real model and serial rather than just an IP.
   */
  async onPairListDevices() {
    const results = await discover({ logger: (msg) => this.log(msg) });
    this.log(`Discovery found ${results.length} candidate(s)`);

    const devices = [];

    for (const { host, name } of results) {
      const unit = new DanthermDevice({ host });

      try {
        await unit.connect();
        const info = await unit.readInfo();

        devices.push({
          name: `${info.modelName} (${host})`,
          data: { id: info.serialNumber !== '0' ? info.serialNumber : host },
          settings: { host, port: 502, polling_interval: 30 },
          store: {
            modelName: info.modelName,
            deviceType: info.deviceType,
            firmwareVersion: info.firmwareVersion,
            components: info.components,
          },
        });
      } catch (err) {
        // Something answered the probe but is not a Modbus unit we can read —
        // list it anyway so the user can still add and repair it manually.
        this.log(`Could not read ${host}: ${err.message}`);
        devices.push({
          name: `${name} (${host})`,
          data: { id: host },
          settings: { host, port: 502, polling_interval: 30 },
        });
      } finally {
        unit.disconnect();
      }
    }

    return devices;
  }

}

module.exports = DanthermDriver;
