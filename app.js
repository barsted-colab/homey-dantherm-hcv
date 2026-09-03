'use strict';

const Homey = require('homey');

class DanthermApp extends Homey.App {

  async onInit() {
    this.registerFlowCards();
    this.log('Dantherm HCV app initialised');
  }

  registerFlowCards() {
    const { flow } = this.homey;

    flow.getConditionCard('mode_is')
      .registerRunListener(async ({ device, mode }) => device.getCapabilityValue('dantherm_mode') === mode);

    flow.getConditionCard('bypass_is_open')
      .registerRunListener(async ({ device }) => {
        const state = device.getCapabilityValue('dantherm_bypass');
        return state === 'opened' || state === 'opening';
      });

    flow.getConditionCard('fan_level_is')
      .registerRunListener(async ({ device, level }) => device.getCapabilityValue('dantherm_fan_level') === level);

    flow.getConditionCard('filter_days_below')
      .registerRunListener(async ({ device, days }) => {
        const remaining = device.getCapabilityValue('measure_filter_remain');
        // ServoFlow units have no day counter — never claim the filter is fine
        // based on a value that does not exist.
        if (remaining === null || remaining === undefined) return false;
        return remaining < days;
      });

    flow.getConditionCard('is_cooling')
      .registerRunListener(async ({ device }) => device.isCooling());

    flow.getActionCard('set_free_cooling')
      .registerRunListener(async ({ device, state }) => device.setFreeCooling(state === 'on'));

    flow.getActionCard('close_bypass')
      .registerRunListener(async ({ device }) => device.closeBypass());

    flow.getActionCard('set_control_mode')
      .registerRunListener(async ({ device, mode }) => device.setControlMode(mode));

    flow.getActionCard('set_cool_setpoint')
      .registerRunListener(async ({ device, temperature }) => device.setCoolSetpoint(temperature));

    flow.getActionCard('set_mode')
      .registerRunListener(async ({ device, mode }) => device.setMode(mode));

    flow.getActionCard('set_fan_level')
      .registerRunListener(async ({ device, level }) => device.setFanLevel(Number(level)));

    flow.getActionCard('set_bypass')
      .registerRunListener(async ({ device, state }) => device.setManualBypass(state === 'on'));

    flow.getActionCard('reset_filter')
      .registerRunListener(async ({ device }) => device.resetFilter());

    flow.getActionCard('reset_alarm')
      .registerRunListener(async ({ device }) => device.resetAlarm());

    flow.getActionCard('set_away_mode')
      .registerRunListener(async ({ device, state }) => device.setAwayMode(state === 'on'));

    flow.getActionCard('set_night_mode')
      .registerRunListener(async ({ device, state }) => device.setNightMode(state === 'on'));

    flow.getActionCard('set_week_program')
      .registerRunListener(async ({ device, program }) => device.setWeekProgram(Math.round(program)));

    flow.getActionCard('set_bypass_temperatures')
      .registerRunListener(async ({
        device, min, max, season,
      }) => device.setBypassTemperatures(min, max, season === 'summer'));
  }

}

module.exports = DanthermApp;
