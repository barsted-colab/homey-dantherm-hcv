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

const { estimateAirflow, estimatePower, fitPowerCurve } = require('../lib/dantherm');

// Fan speeds measured at level 3 on the same unit.
const RPM_EXTRACT_REF = 1922;
const RPM_SUPPLY_REF = 1651;
const EXTRACT_NOMINAL = 216;
const SUPPLY_NOMINAL = 201;

// The BR2018 table exactly as it is printed on the report, which is what the
// user is asked to copy into the settings screen.
const REPORT = [
  { flow: 189, watts: 33 }, // Minimum
  { flow: 216, watts: 40 }, // Standard
  { flow: 250, watts: 56 }, // Forceret
];
const CURVE = fitPowerCurve(REPORT);

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

test('the fitted curve reproduces every row of the report within 5 percent', () => {
  for (const { flow, watts } of REPORT) {
    const estimate = estimatePower(flow, CURVE);
    const error = Math.abs(estimate - watts) / watts;
    assert.ok(
      error < 0.05,
      `${flow} m³/h: estimated ${estimate} W against ${watts} W measured (${(error * 100).toFixed(1)} % off)`,
    );
  }
});

test('the standing draw is derived from the report, not asked for', () => {
  // No commissioning report states idle draw, so it is the intercept of the
  // fit. Three rows spanning 189-250 m³/h put it in the mid-teens; the exact
  // figure matters less than it landing somewhere a controller plausibly sits.
  assert.ok(CURVE.idle > 5 && CURVE.idle < 25, `implausible standing draw: ${CURVE.idle} W`);
  assert.strictEqual(estimatePower(0, CURVE), Math.round(CURVE.idle * 10) / 10);
});

test('two rows are enough, one row is not', () => {
  // Airflow needs a single figure; power needs two, because one point cannot
  // separate the standing draw from the fan power. They must degrade apart,
  // so a user with a sparse report still gets the flow reading.
  assert.ok(fitPowerCurve([REPORT[0], REPORT[2]]), 'minimum plus forced should fit');
  assert.strictEqual(fitPowerCurve([REPORT[1]]), null);
  assert.strictEqual(fitPowerCurve([]), null);
});

test('blank and nonsense rows are ignored rather than fitted', () => {
  // Every field defaults to 0 — an untouched row must not drag the curve.
  const withBlanks = fitPowerCurve([
    { flow: 0, watts: 0 },
    ...REPORT,
    { flow: 250, watts: 0 },
  ]);
  assert.ok(Math.abs(withBlanks.idle - CURVE.idle) < 0.01, 'blank rows changed the fit');

  assert.strictEqual(fitPowerCurve([{ flow: 216, watts: 40 }, { flow: 0, watts: 0 }]), null);
  assert.strictEqual(fitPowerCurve(null), null);
});

test('no curve means no power reading, never a guessed one', () => {
  assert.strictEqual(estimatePower(216, null), null);
  assert.strictEqual(estimatePower(null, CURVE), null);
});

test('doubling the flow roughly eightfolds the fan contribution', () => {
  // The cube law, which is why boost mode is disproportionately expensive.
  // Both readings come back rounded to 0,1 W, and at half flow the fans account
  // for only ~3 W, so that rounding alone shifts the ratio by about a percent.
  // The tolerance covers it and still rules out a square law, which would be 4x.
  const fanLow = estimatePower(108, CURVE) - CURVE.idle;
  const fanHigh = estimatePower(216, CURVE) - CURVE.idle;
  assert.ok(Math.abs(fanHigh / fanLow - 8) < 0.2, `expected ~8x, got ${(fanHigh / fanLow).toFixed(2)}x`);
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
  const at = (flow) => estimatePower(flow, CURVE);

  const curve = [0, 50, 108, 189, 216, 250, 300, 400].map(at);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i] > curve[i - 1], `not monotonic at index ${i}: ${curve}`);
  }
  assert.ok(curve.every((w) => w >= CURVE.idle - 0.05), 'never below the standing draw');
  // Far above nominal it must still be a number a person would recognise as
  // power rather than an overflow.
  assert.ok(at(400) < 500, `implausible at 400 m³/h: ${at(400)} W`);
});
