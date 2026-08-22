'use strict';

const widget = require('../../lib/widget-state');

module.exports = {
  async getState({ homey, query }) {
    return widget.buildState(homey, query?.deviceId);
  },

  async setFanLevel({ homey, body }) {
    return widget.setFanLevel(homey, body);
  },

  async log({ homey, body }) {
    return widget.logError(homey, { ...body, widget: 'compact' });
  },
};
