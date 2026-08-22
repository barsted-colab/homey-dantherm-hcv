'use strict';

/**
 * Airflow and power estimation, anchored to a commissioning report.
 *
 * The reference figures below are from a real HCV 400 P2 installation
 * (Boligvex, 08.11.2022): 216 m³/h extract and 201 m³/h supply at level 3,
 * with 33 / 40 / 56 W measured at 189 / 216 / 250 m³/h.
 */

const test = require('node:test');
const assert = require('node:assert');

const { estimateAirflow, estimatePower } = require('../lib/dantherm');

// Fan speeds measured at level 3 on the same unit.
const RPM_EXTRACT_REF = 1922;
const RPM_SUPPLY_REF = 1651;
const EXTRACT_NOMINAL = 216;
const SUPPLY_NOMINAL = 201;

test('the reference point returns exactly the commissioned figure', () => {
  assert.strictEqual(estimateAirflow(RPM_EXTRACT_REF, RPM_EXTRACT_REF, EXTRACT_NOMINAL), 216);
  assert.strictEqual(estimateAirflow(RPM_SUPPLY_REF, RPM_SUPPLY_REF, SUPPLY_NOMINAL), 201);
});

test('flow scales linearly with fan speed', () => {
  // Half the speed moves half the air, for an unchanged duct system.
  assert.strictEqual(estimateAirflow(961, RPM_EXTRACT_REF, EXTRACT_NOMINAL), 108);
  // Measured at level 2 on the real unit.
  assert.strictEqual(estimateAirflow(1312, RPM_EXTRACT_REF, EXTRACT_NOMINAL), 147);
});

test('a stopped fan moves no air', () => {
  assert.strictEqual(estimateAirflow(0, RPM_EXTRACT_REF, EXTRACT_NOMINAL), 0);
});

test('no estimate without a reference', () => {
  assert.strictEqual(estimateAirflow(1500, 0, EXTRACT_NOMINAL), null);
  assert.strictEqual(estimateAirflow(1500, RPM_EXTRACT_REF, 0), null);
  assert.strictEqual(estimateAirflow(null, RPM_EXTRACT_REF, EXTRACT_NOMINAL), null);
});

test('power matches all three commissioned operating points within 5 percent', () => {
  const measured = [[189, 33], [216, 40], [250, 56]];

  for (const [flow, watts] of measured) {
    const estimate = estimatePower(flow, EXTRACT_NOMINAL, 40, 15);
    const error = Math.abs(estimate - watts) / watts;
    assert.ok(
      error < 0.05,
      `${flow} m³/h: estimated ${estimate} W against ${watts} W measured (${(error * 100).toFixed(1)} % off)`,
    );
  }
});

test('power falls to the standing draw when the fans stop', () => {
  assert.strictEqual(estimatePower(0, EXTRACT_NOMINAL, 40, 15), 15);
});

test('power refuses nonsense configuration rather than returning it', () => {
  // Nominal below standing draw would make the cubic term negative.
  assert.strictEqual(estimatePower(216, EXTRACT_NOMINAL, 10, 15), null);
  assert.strictEqual(estimatePower(null, EXTRACT_NOMINAL, 40, 15), null);
  assert.strictEqual(estimatePower(216, 0, 40, 15), null);
});

test('doubling the flow roughly eightfolds the fan contribution', () => {
  // The cube law, which is why boost mode is disproportionately expensive.
  const low = estimatePower(108, EXTRACT_NOMINAL, 40, 15);
  const high = estimatePower(216, EXTRACT_NOMINAL, 40, 15);
  const fanLow = low - 15;
  const fanHigh = high - 15;
  assert.ok(Math.abs(fanHigh / fanLow - 8) < 0.1, `expected ~8x, got ${(fanHigh / fanLow).toFixed(2)}x`);
});

// --- Recovered heat ----------------------------------------------------------

const { recoveredHeat } = require('../lib/dantherm');

test('recovered heat matches the hand calculation on a cold day', () => {
  // 216 m³/h at 1,2 kg/m³ is 0,072 kg/s; lifting it 22,9 K at 1,006 kJ/kgK
  // is 1,66 kW.
  assert.strictEqual(recoveredHeat(216, 19.4, -3.5), 1.66);
});

test('recovered heat scales with both flow and temperature lift', () => {
  const base = recoveredHeat(216, 19.4, -3.5);
  assert.ok(Math.abs(recoveredHeat(108, 19.4, -3.5) - base / 2) < 0.02, 'half the flow, half the heat');
  assert.ok(recoveredHeat(216, 17.8, 15.2) < base / 5, 'a mild evening recovers far less');
});

test('cooling is not counted as recovery', () => {
  // Bypass open on a summer day: supply arrives colder than outdoor. That is
  // the point of free cooling, but it is not heat handed back.
  assert.strictEqual(recoveredHeat(216, 15.0, 20.0), 0);
});

test('a stopped unit recovers nothing', () => {
  assert.strictEqual(recoveredHeat(0, 19.4, -3.5), 0);
});

test('no estimate without airflow', () => {
  assert.strictEqual(recoveredHeat(null, 19.4, -3.5), null);
  assert.strictEqual(recoveredHeat(216, null, -3.5), null);
});

test('power stays sane outside the range a report covers', () => {
  // Extrapolation is allowed — blanking the tile at boost would be worse than
  // an estimate that reads a little low — but it must not misbehave.
  const at = (flow) => estimatePower(flow, EXTRACT_NOMINAL, 40, 15);

  const curve = [0, 50, 108, 189, 216, 250, 300, 400].map(at);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i] > curve[i - 1], `not monotonic at index ${i}: ${curve}`);
  }
  assert.ok(curve.every((w) => w >= 15), 'never below the standing draw');
  // Far above nominal it must still be a number a person would recognise as
  // power rather than an overflow.
  assert.ok(at(400) < 500, `implausible at 400 m³/h: ${at(400)} W`);
});
