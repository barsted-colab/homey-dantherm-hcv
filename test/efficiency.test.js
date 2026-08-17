'use strict';

/**
 * Heat recovery efficiency shown by the dashboard widget. The unit does not
 * report this figure, so it is derived — and a derived number that looks
 * authoritative while being wrong is worse than no number, hence the tests
 * lean on the cases where it should refuse to answer.
 */

const test = require('node:test');
const assert = require('node:assert');

const { recoveryEfficiency } = require('../lib/dantherm');

test('computes the temperature ratio on a cold day', () => {
  // -5 outdoor, 21 extract, 18 supply: 23 of the 26 available degrees kept.
  assert.strictEqual(recoveryEfficiency({ outdoor: -5, extract: 21, supply: 18 }), 88);
});

test('a perfect exchanger reads 100 percent', () => {
  assert.strictEqual(recoveryEfficiency({ outdoor: 0, extract: 20, supply: 20 }), 100);
});

test('no recovery at all reads zero, not null', () => {
  assert.strictEqual(recoveryEfficiency({ outdoor: 0, extract: 20, supply: 0 }), 0);
});

test('slightly over 100 is kept — fan motor heat lands in the supply air', () => {
  assert.strictEqual(recoveryEfficiency({ outdoor: 0, extract: 20, supply: 21 }), 105);
});

test('refuses when a sensor is missing', () => {
  assert.strictEqual(recoveryEfficiency({ outdoor: null, extract: 21, supply: 18 }), null);
  assert.strictEqual(recoveryEfficiency({ outdoor: -5, extract: undefined, supply: 18 }), null);
  assert.strictEqual(recoveryEfficiency({ outdoor: -5, extract: 21, supply: NaN }), null);
});

test('refuses when indoor and outdoor are too close to measure against', () => {
  // A summer day: 1.5 degrees of difference is inside sensor tolerance, and
  // the ratio would swing between polls rather than mean anything.
  assert.strictEqual(recoveryEfficiency({ outdoor: 21, extract: 22.5, supply: 22 }), null);
  assert.strictEqual(recoveryEfficiency({ outdoor: 20, extract: 20, supply: 20 }), null);
});

test('refuses results a physical exchanger cannot produce', () => {
  // Supply colder than outdoor while the house is warmer — not recovery.
  assert.strictEqual(recoveryEfficiency({ outdoor: 0, extract: 20, supply: -5 }), null);
  // Supply far above extract.
  assert.strictEqual(recoveryEfficiency({ outdoor: 0, extract: 20, supply: 40 }), null);
});

test('works when the house is colder than outside', () => {
  // Summer cooling: the ratio is still meaningful with the sign reversed.
  assert.strictEqual(recoveryEfficiency({ outdoor: 30, extract: 22, supply: 24 }), 75);
});
