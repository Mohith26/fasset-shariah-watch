import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as W from '../core/watch.js';

const read = f => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url)));
const U = read('universe.json'), CAL = read('calibration.json'), R = read('results.json'), BT = read('backtest.json');

test('data integrity: universe, calibration set and backtest are consistent', () => {
  assert.ok(U.length >= 100);
  assert.equal(CAL.scores.length, CAL.labels.length);
  assert.equal(CAL.scores.length, R.calibrationReviews);
  assert.equal(BT.length, R.testReviews);
  for (const u of U) {
    assert.ok(u.mcap > 0 && u.debt >= 0 && u.cash >= 0);
    assert.ok(Math.abs(u.debtRatio - u.debt / u.mcap) < 1e-3 && Math.abs(u.cashRatio - u.cash / u.mcap) < 1e-3);
    assert.equal(u.compliant, u.debtRatio < 0.3 && u.cashRatio < 0.3);
  }
});

test('status: AAOIFI 30% limits are strict upper bounds', () => {
  assert.equal(W.status(29, 0, 100).compliant, true);
  assert.equal(W.status(30, 0, 100).compliant, false);
  assert.equal(W.status(0, 30, 100).compliant, false);
});

test('unadjust: undoes later splits only', () => {
  const px = { t: [100, 200, 300], c: [10, 10, 10] };
  assert.deepEqual(W.unadjust(px, [[250, 4, 1]]), [40, 40, 10]);
  assert.deepEqual(W.unadjust(px, []), [10, 10, 10]);
});

test('balance sheet uses only filings made by the review date, latest period, latest restatement', () => {
  const facts = {
    LongTermDebt: [['2024-03-31', '2024-05-01', 100], ['2024-06-30', '2024-08-01', 120], ['2024-06-30', '2024-11-01', 130]],
    CashAndCashEquivalentsAtCarryingValue: [['2024-03-31', '2024-05-01', 50], ['2024-06-30', '2024-08-01', 55], ['2024-06-30', '2024-11-01', 56]],
    ShortTermBorrowings: [['2024-06-30', '2024-08-01', 5]],
  };
  assert.deepEqual(W.balanceSheetAt(facts, W.ts('2024-07-01')), { end: '2024-03-31', debt: 100, cash: 50 });
  assert.deepEqual(W.balanceSheetAt(facts, W.ts('2024-09-01')), { end: '2024-06-30', debt: 125, cash: 55 });
  assert.deepEqual(W.balanceSheetAt(facts, W.ts('2024-12-01')), { end: '2024-06-30', debt: 135, cash: 56 });
  assert.equal(W.balanceSheetAt(facts, W.ts('2024-01-01')), null);
});

test('isotonic regression is monotone and reproduces sorted 0/1 data exactly', () => {
  const fit = W.isotonic([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]);
  assert.deepEqual([0.05, 0.2, 0.35, 0.9].map(s => W.isoPredict(fit, s)), [0, 0, 1, 1]);
  const rng = W.mulberry32(3);
  const s = Array.from({ length: 300 }, () => rng()), y = s.map(v => (rng() < v ? 1 : 0));
  const f2 = W.isotonic(s, y);
  let prev = -1;
  for (let x = 0; x <= 1; x += 0.01) { const v = W.isoPredict(f2, x); assert.ok(v >= prev - 1e-12); prev = v; }
});

test('property: Venn-Abers p0 <= p <= p1, both in [0,1], and p1 - p0 shrinks as calibration grows', () => {
  const rng = W.mulberry32(11);
  const mk = n => { const s = Array.from({ length: n }, () => rng()); return { s, y: s.map(v => (rng() < v ? 1 : 0)) }; };
  const small = mk(40), big = mk(2000);
  let wSmall = 0, wBig = 0;
  for (let i = 0; i < 50; i++) {
    const x = rng();
    const a = W.venAbers(small.s, small.y, x), b = W.venAbers(big.s, big.y, x);
    for (const r of [a, b]) { assert.ok(r.p0 <= r.p + 1e-12 && r.p <= r.p1 + 1e-12 && r.p0 >= 0 && r.p1 <= 1); }
    wSmall += a.p1 - a.p0; wBig += b.p1 - b.p0;
  }
  assert.ok(wBig < wSmall);
});

test('property: Venn-Abers is calibrated on a synthetic well-specified problem', () => {
  const rng = W.mulberry32(21);
  const gen = n => { const s = Array.from({ length: n }, () => rng()), y = s.map(v => (rng() < v * v ? 1 : 0)); return { s, y }; };
  const cal = gen(3000), te = gen(1500);
  const p = te.s.map(x => W.venAbers(cal.s, cal.y, x).p);
  const bins = W.reliability(p, te.y, [0, 0.25, 0.5, 0.75, 1.0001]);
  for (const b of bins) if (b.n > 100) assert.ok(Math.abs(b.meanP - b.rate) < 0.06, JSON.stringify(b));
});

test('simulate: deterministic for a seed; a stock far from the limits never fails; one over the limit always fails', () => {
  const base = { rets: Array(500).fill(0.0003), dDebt: [0.01, -0.01], dCash: [0.02, -0.02] };
  const safe = { ...base, mcap: 1000, debt: 50, cash: 50 }, bad = { ...base, mcap: 1000, debt: 500, cash: 50 };
  assert.equal(W.simulate(safe, 40, 500, 1).p, 0);
  assert.equal(W.simulate(bad, 40, 500, 1).p, 1);
  const u = U[0];
  assert.equal(W.simulate(u, u.H, 400, 9).p, W.simulate(u, u.H, 400, 9).p);
});

test('property: failure probability rises as the price shock gets worse (same seed)', () => {
  for (const u of U.filter(x => x.compliant).slice(0, 25)) {
    let prev = -1;
    for (const shock of [0.4, 0.2, 0, -0.2, -0.4]) {
      const p = W.simulate(u, u.H, 400, 5, { priceShock: Math.log(1 + shock) }).p;
      assert.ok(p >= prev - 1e-12, `${u.t} shock ${shock}`); prev = p;
    }
  }
});

test('breakingDrop: the price fall that puts the worse ratio exactly at 30%', () => {
  const s = { mcap: 1000, debt: 240, cash: 30 };
  const d = W.breakingDrop(s);
  assert.ok(Math.abs(s.debt / (s.mcap * (1 - d)) - 0.3) < 1e-12);
});

test('AUC and Brier sanity', () => {
  assert.equal(W.auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(W.auc([0.5, 0.5], [0, 1]), 0.5);
  assert.equal(W.brier([1, 0], [1, 0]), 0);
});

test('app pipeline reproduces every stored probability: IVAP(calibration.json, raw) == universe p, p0, p1', () => {
  for (const u of U) {
    const v = W.venAbers(CAL.scores, CAL.labels, u.raw);
    assert.ok(Math.abs(v.p - u.p) < 1e-4 && Math.abs(v.p0 - u.p0) < 1e-4 && Math.abs(v.p1 - u.p1) < 1e-4, u.t);
  }
});

test('headline: recomputing the held-out loss metrics from backtest.json matches results.json', () => {
  const th = R.losses.alertThreshold;
  const comp = BT.filter(r => r[4] === 0);
  const losses = comp.filter(r => r[5] === 1);
  const caught = losses.filter(r => r[3] >= th).length;
  const alerts = comp.filter(r => r[3] >= th).length;
  assert.equal(comp.length, R.losses.compliantReviews);
  assert.equal(losses.length, R.losses.losses);
  assert.equal(caught, R.losses.caught);
  assert.equal(+(alerts / comp.length).toFixed(4), R.losses.alertRate);
  assert.ok(R.headline.sentence.includes(`${R.losses.caught} of ${R.losses.losses}`));
  assert.ok(R.losses.precision > 5 * R.losses.baseLossRate, 'alerts are far more likely to lose compliance than average');
  assert.ok(R.brier.venAbers < R.brier.persistence);
  assert.ok(BT.every(r => r[1] > '2020-12-31'), 'no calibration-period review leaks into the test set');
});

test('current watchlist: at-risk list equals compliant holdings at or above the calibration-chosen alert line', () => {
  const th = R.losses.alertThreshold;
  const list = U.filter(u => u.compliant && u.p >= th).map(u => u.t).sort();
  assert.deepEqual(list, [...R.current.atRiskTickers].sort());
  assert.equal(R.losses.thresholdChosenOn, 'calibration years (max F1)');
});
