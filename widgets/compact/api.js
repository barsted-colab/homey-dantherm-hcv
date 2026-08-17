'use strict';

const widget = require('../../lib/widget-state');

module.exports = {
  async getState({ homey, query }) {
    return widget.buildState(homey, query?.deviceId);
  },

  async setFanLevel({ homey, body }) {
    return widget.setFanLevel(homey, body);
  },
};
