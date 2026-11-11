// Seeded build: raw/fundamentals_prices.json -> data/*.json for the app and tests.
// Backtest: every quarter-end review 2013Q1..2026Q2, forecast the status at the next
// quarter-end. Calibration (IVAP) uses reviews up to 2020-12-31; test = 2021Q1..2026Q2.
import fs from 'node:fs';
import * as W from '../core/watch.js';

const SEED = 1447;
const NSIM = 600;
const raw = JSON.parse(fs.readFileSync('raw/fundamentals_prices.json', 'utf8'));
const AS_OF = W.ts('2026-11-10');
const NEXT_REVIEW = W.ts('2026-12-31');
const quarterEnds = [];
for (let y = 2013; y <= 2026; y++) for (const md of ['03-31', '06-30', '09-30', '12-31']) quarterEnds.push(W.ts(`${y}-${md}`));

function prepare(t) {
  const r = raw[t];
  const px = W.unadjust(r.px, r.splits);
  const T = r.px.t.map(x => x - (x % 86400));   // day start
  const logret = new Array(px.length).fill(null);
  for (let i = 1; i < px.length; i++) if (px[i] != null && px[i - 1] != null) logret[i] = Math.log(px[i] / px[i - 1]);
  return { r, px, T, logret };
}
// everything the forecaster may know at time t
function snapshot(P, t) {
  const i = W.lastIndexAtOrBefore(P.T, t);
  if (i < 260 || P.px[i] == null) return null;
  const bs = W.balanceSheetAt(P.r.facts, t);
  const sh = W.sharesAt(P.r.shares, t);
  if (!bs || !sh) return null;
  if (t - W.ts(bs.end) > 200 * 86400) return null;           // stale filing
  const mcap = P.px[i] * sh;
  const rets = [];
  for (let k = Math.max(1, i - 503); k <= i; k++) if (P.logret[k] != null) rets.push(P.logret[k]);
  const hist = W.balanceHistory(P.r.facts, t, 13);
  if (bs.debt === 0 && hist.some(h => h.debt > 0)) return null;   // debt tag missing this period, not debt-free
  const dDebt = [], dCash = [];
  for (let k = 1; k < hist.length; k++) {
    // winsorised at +/-1 (x2.7): larger quarter-on-quarter jumps are almost always tag changes in XBRL
    if (hist[k - 1].debt > 0 && hist[k].debt > 0) dDebt.push(W.clip(Math.log(hist[k].debt / hist[k - 1].debt), 1));
    if (hist[k - 1].cash > 0 && hist[k].cash > 0) dCash.push(W.clip(Math.log(hist[k].cash / hist[k - 1].cash), 1));
  }
  return { t, price: P.px[i], shares: sh, mcap, debt: bs.debt, cash: bs.cash, bsEnd: bs.end, rets, dDebt, dCash, ...W.status(bs.debt, bs.cash, mcap) };
}
// weekdays strictly after t0 up to t1 (US holidays ignored: at most 2 in this window)
function tradingDays(t0, t1) { let n = 0; for (let t = t0 + 86400; t <= t1; t += 86400) { const d = new Date(t * 1000).getUTCDay(); if (d !== 0 && d !== 6) n++; } return n; }

const tickers = Object.keys(raw).sort();
const rows = [];   // backtest rows
const prepared = {};
let seed = SEED;
for (const t of tickers) {
  const P = prepare(t); prepared[t] = P;
  for (let q = 0; q + 1 < quarterEnds.length; q++) {
    const d = quarterEnds[q], d1 = quarterEnds[q + 1];
    if (d1 > W.ts('2026-09-30')) break;
    const s0 = snapshot(P, d), s1 = snapshot(P, d1);
    if (!s0 || !s1) continue;
    const H = 63;
    const sim = W.simulate(s0, H, NSIM, seed++);
    rows.push({ t, d: W.iso(d), raw: sim.p, now: s0.compliant ? 0 : 1, y: s1.compliant ? 0 : 1,
      debtR: +s0.debtRatio.toFixed(4), cashR: +s0.cashRatio.toFixed(4) });
  }
}
const CAL_END = '2020-12-31';
const cal = rows.filter(r => r.d <= CAL_END), test = rows.filter(r => r.d > CAL_END);
const calScores = cal.map(r => +r.raw.toFixed(5)), calLabels = cal.map(r => r.y);
for (const r of test) Object.assign(r, (({ p0, p1, p }) => ({ p0, p1, p }))(W.venAbers(calScores, calLabels, +r.raw.toFixed(4))));

// ---------- metrics on held-out reviews ----------
const yT = test.map(r => r.y);
const persist = test.map(r => r.now);
const metrics = {
  calibrationReviews: cal.length, testReviews: test.length, stocks: tickers.length,
  testPeriod: `${test[0]?.d}..${test[test.length - 1]?.d}`,
  baseRateNonCompliant: +(yT.reduce((a, b) => a + b, 0) / yT.length).toFixed(4),
  brier: { venAbers: +W.brier(test.map(r => r.p), yT).toFixed(5), rawMonteCarlo: +W.brier(test.map(r => r.raw), yT).toFixed(5), persistence: +W.brier(persist, yT).toFixed(5) },
  reliability: W.reliability(test.map(r => r.p), yT),
};
// status changes: compliant now -> non-compliant at next review
const comp = test.filter(r => r.now === 0);
const flips = comp.filter(r => r.y === 1);
// Alert threshold chosen on the calibration years only: maximise F1 for "loses
// compliance at the next review" using in-sample isotonic probabilities.
const isoCal = W.isotonic(calScores, calLabels);
const calComp = cal.filter(r => r.now === 0);
let ALERT = 0.2, bestF1 = -1;
for (const th of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4]) {
  const pr = calComp.map(r => W.isoPredict(isoCal, +r.raw.toFixed(5)));
  const tp = calComp.filter((r, i) => pr[i] >= th && r.y === 1).length, fp = calComp.filter((r, i) => pr[i] >= th && r.y === 0).length;
  const fn = calComp.filter((r, i) => pr[i] < th && r.y === 1).length;
  const f1 = 2 * tp / Math.max(1, 2 * tp + fp + fn);
  if (f1 > bestF1) { bestF1 = f1; ALERT = th; }
}
const flagged = comp.filter(r => r.p >= ALERT);
metrics.losses = {
  compliantReviews: comp.length, losses: flips.length, baseLossRate: +(flips.length / comp.length).toFixed(4), thresholdChosenOn: 'calibration years (max F1)', calF1: +bestF1.toFixed(4),
  caught: flips.filter(r => r.p >= ALERT).length, alertThreshold: ALERT,
  alerts: flagged.length, alertRate: +(flagged.length / comp.length).toFixed(4),
  precision: +(flagged.filter(r => r.y === 1).length / Math.max(1, flagged.length)).toFixed(4),
  aucAmongCompliant: +W.auc(comp.map(r => r.p), comp.map(r => r.y)).toFixed(4),
  examples: flips.filter(r => r.p >= ALERT).slice(0, 40).map(r => ({ t: r.t, d: r.d, p: +r.p.toFixed(3), debtR: r.debtR, cashR: r.cashR })),
  missed: flips.filter(r => r.p < ALERT).map(r => ({ t: r.t, d: r.d, p: +r.p.toFixed(3), debtR: r.debtR, cashR: r.cashR })),
};
const regain = test.filter(r => r.now === 1);
metrics.regains = { nonCompliantReviews: regain.length, regained: regain.filter(r => r.y === 0).length };

// ---------- current watchlist (as of AS_OF, next review 31 Dec 2026) ----------
const universe = [];
for (const t of tickers) {
  const P = prepared[t];
  const s = snapshot(P, AS_OF);
  if (!s) continue;
  const H = tradingDays(AS_OF, NEXT_REVIEW);
  const sim = W.simulate(s, H, 4000, 9000 + universe.length);
  const va = W.venAbers(calScores, calLabels, +sim.p.toFixed(4));
  const history = [];
  for (const d of quarterEnds) {
    if (d > AS_OF) break;
    if (d < W.ts('2019-01-01')) continue;
    const h = snapshot(P, d);
    if (h) history.push([W.iso(d), +h.debtRatio.toFixed(4), +h.cashRatio.toFixed(4)]);
  }
  universe.push({
    t, name: P.r.name, price: +s.price.toFixed(2), shares: s.shares, mcap: Math.round(s.mcap), debt: s.debt, cash: s.cash, bsEnd: s.bsEnd,
    debtRatio: +s.debtRatio.toFixed(4), cashRatio: +s.cashRatio.toFixed(4), compliant: s.compliant,
    H, raw: +sim.p.toFixed(4), p0: +va.p0.toFixed(4), p1: +va.p1.toFixed(4), p: +va.p.toFixed(4),
    debtQ: [0.1, 0.5, 0.9].map(q => +W.quantile(sim.debtR, q).toFixed(4)), cashQ: [0.1, 0.5, 0.9].map(q => +W.quantile(sim.cashR, q).toFixed(4)),
    breakDrop: +W.breakingDrop(s).toFixed(4),
    rets: s.rets.map(v => +v.toFixed(5)), dDebt: s.dDebt.map(v => +v.toFixed(4)), dCash: s.dCash.map(v => +v.toFixed(4)),
    history,
  });
}
universe.sort((a, b) => b.p - a.p);
const atRisk = universe.filter(u => u.compliant && u.p >= ALERT);
const results = {
  generated: 'node scripts/build_data.mjs', seed: SEED, asOf: W.iso(AS_OF), nextReview: W.iso(NEXT_REVIEW), limits: W.LIMITS,
  sources: { fundamentals: 'SEC XBRL companyfacts (data.sec.gov)', prices: 'Yahoo Finance chart API (split-adjusted closes, unadjusted with split events)' },
  ...metrics,
  current: { stocks: universe.length, compliant: universe.filter(u => u.compliant).length, atRisk: atRisk.length, atRiskTickers: atRisk.map(u => u.t) },
};
results.headline = {
  sentence: `In ${metrics.testPeriod.slice(0, 4)}-${metrics.testPeriod.slice(-10, -6)} held-out reviews, Shariah Watch flagged ${metrics.losses.caught} of ${metrics.losses.losses} compliance losses a quarter ahead while alerting on ${(metrics.losses.alertRate * 100).toFixed(1)}% of compliant holdings.`,
  caught: metrics.losses.caught, losses: metrics.losses.losses, alertRate: metrics.losses.alertRate,
};
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/universe.json', JSON.stringify(universe));
fs.writeFileSync('data/calibration.json', JSON.stringify({ scores: calScores.map(v => +v.toFixed(5)), labels: calLabels }));
fs.writeFileSync('data/backtest.json', JSON.stringify(test.map(r => [r.t, r.d, +r.raw.toFixed(4), +r.p.toFixed(4), r.now, r.y])));
fs.writeFileSync('data/results.json', JSON.stringify(results, null, 1));
console.log(JSON.stringify({ ...results, reliability: undefined, losses: { ...results.losses, examples: results.losses.examples.slice(0, 8), missed: results.losses.missed.slice(0, 12) } }, null, 1));
