'use strict';

/**
 * Free-cooling boost.
 *
 * The scenario throughout is the reference installation on a warm August
 * afternoon: 25,7 °C indoors, 15,0 °C outdoors, setpoint 21. Ten degrees of
 * cooling standing outside the wall.
 */

const test = require('node:test');
const assert = require('node:assert');

const { coolingDecision } = require('../lib/dantherm');

const WARM_HOUSE = {
  indoor: 25.7,
  outdoor: 15.0,
  setpoint: 21,
  bypassOpen: true,
  mode: 'automatic',
  boosting: false,
};

const decide = (overrides) => coolingDecision({ ...WARM_HOUSE, ...overrides });

test('leans on the fans when the house is warm and the air outside is not', () => {
  assert.strictEqual(decide({}), 'boost');
});

test('stops asking once it is already boosting', () => {
  // Otherwise every poll would rewrite the same level to the unit.
  assert.strictEqual(decide({ boosting: true }), 'hold');
});

test('lets go on arrival, and not a moment before', () => {
  assert.strictEqual(decide({ indoor: 21.0, boosting: true }), 'release');
  assert.strictEqual(decide({ indoor: 21.1, boosting: true }), 'hold');
});

test('the gap between starting and stopping keeps the fans from hunting', () => {
  // Engaging needs setpoint + 0,3; releasing waits for the setpoint itself. A
  // house sitting between the two must settle rather than oscillate.
  const between = { indoor: 21.2 };
  assert.strictEqual(decide({ ...between, boosting: false }), 'hold');
  assert.strictEqual(decide({ ...between, boosting: true }), 'hold');
});

test('a degree of difference is not worth the noise', () => {
  assert.strictEqual(decide({ outdoor: 24.9 }), 'hold'); // 0,8 K — too little to start
  assert.strictEqual(decide({ outdoor: 24.5 }), 'boost'); // 1,2 K — worth it
});

test('gives up once the outside air has caught up', () => {
  assert.strictEqual(decide({ outdoor: 25.5, boosting: true }), 'release');
});

test('does nothing while the bypass is shut', () => {
  // With the damper closed the exchanger tempers the incoming air back towards
  // room temperature, so running harder moves more air and cools nothing.
  assert.strictEqual(decide({ bypassOpen: false }), 'hold');
  assert.strictEqual(decide({ bypassOpen: false, boosting: true }), 'release');
});

test('stays out of the modes that were chosen for a reason', () => {
  for (const mode of ['away', 'night', 'fireplace', 'standby']) {
    assert.strictEqual(decide({ mode }), 'hold', `${mode} should not boost`);
    assert.strictEqual(decide({ mode, boosting: true }), 'release', `${mode} should release`);
  }
});

test("Dantherm's own summer mode is left alone", () => {
  // It stops the supply fan outright, so there is no incoming air to speed up.
  assert.strictEqual(decide({ mode: 'summer' }), 'hold');
});

test('runs in the ordinary ventilation modes', () => {
  for (const mode of ['automatic', 'manual', 'week_program']) {
    assert.strictEqual(decide({ mode }), 'boost', `${mode} should boost`);
  }
});

test('losing a reading hands the fans back rather than holding them', () => {
  for (const missing of ['indoor', 'outdoor', 'setpoint']) {
    assert.strictEqual(decide({ [missing]: null, boosting: true }), 'release',
      `missing ${missing} should release`);
    assert.strictEqual(decide({ [missing]: null }), 'hold',
      `missing ${missing} should not start`);
  }
});

test('a house already at the setpoint is left where it is', () => {
  assert.strictEqual(decide({ indoor: 20.0 }), 'hold');
});
