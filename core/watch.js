// Shariah Watch core: AAOIFI-style financial screens from SEC XBRL, Monte Carlo
// forecast of the next quarterly review, and inductive Venn-Abers calibration.
// Pure ES module (browser + node --test).

export const LIMITS = { debt: 0.30, cash: 0.30 };   // AAOIFI Standard 21: < 30% of market capitalisation
const DAY = 86400;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export const clip = (v, c) => Math.max(-c, Math.min(c, v));
export const ts = iso => Date.parse(iso + 'T00:00:00Z') / 1000;
export const iso = t => new Date(t * 1000).toISOString().slice(0, 10);

// ---------- prices ----------
// Yahoo closes are split-adjusted; XBRL share counts are not. Undo later splits.
export function unadjust(px, splits) {
  const out = new Array(px.c.length);
  for (let i = 0; i < px.c.length; i++) {
    if (px.c[i] == null) { out[i] = null; continue; }
    let f = 1;
    for (const [d, num, den] of splits) if (d > px.t[i]) f *= num / den;
    out[i] = px.c[i] * f;
  }
  return out;
}
export function lastIndexAtOrBefore(arr, t) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

// ---------- balance sheet as known on a date ----------
// facts[tag] = [[periodEnd, filed, value], ...]. Only filings made on or before
// `t` are visible; we use the most recent balance-sheet period among them.
function visible(rows, t) {
  const m = new Map();
  for (const [end, filed, v] of rows || []) {
    if (ts(filed) > t) continue;
    const prev = m.get(end);
    if (!prev || prev[0] < filed) m.set(end, [filed, v]);
  }
  return m;   // end -> [filed, value] (latest restatement visible at t)
}
const DEBT_PLANS = [
  { base: ['LongTermDebt'], add: ['ShortTermBorrowings', 'CommercialPaper', 'OtherShortTermBorrowings'] },
  { base: ['LongTermDebtNoncurrent'], add: ['LongTermDebtCurrent|DebtCurrent', 'ShortTermBorrowings', 'CommercialPaper', 'OtherShortTermBorrowings'] },
  { base: ['LongTermDebtAndCapitalLeaseObligations'], add: ['LongTermDebtAndCapitalLeaseObligationsCurrent|DebtCurrent', 'ShortTermBorrowings', 'CommercialPaper'] },
  { base: ['DebtLongtermAndShorttermCombinedAmount'], add: [] },
  { base: ['DebtCurrent'], add: [] },
];
const CASH_PLANS = [
  { base: ['CashAndCashEquivalentsAtCarryingValue|Cash'], add: ['ShortTermInvestments|MarketableSecuritiesCurrent|AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'MarketableSecuritiesNoncurrent|AvailableForSaleSecuritiesDebtSecuritiesNoncurrent'] },
  { base: ['CashCashEquivalentsAndShortTermInvestments'], add: ['MarketableSecuritiesNoncurrent|AvailableForSaleSecuritiesDebtSecuritiesNoncurrent'] },
];
function evalPlans(vis, plans, end) {
  const pick = alt => { for (const tag of alt.split('|')) { const r = vis[tag]?.get(end); if (r) return r[1]; } return null; };
  for (const p of plans) {
    const b = pick(p.base[0]);
    if (b == null) continue;
    if (b < 0) continue;
    let s = b;
    for (const a of p.add) { const v = pick(a); if (v != null && v > 0) s += v; }
    return s;
  }
  return null;
}
export function balanceSheetAt(facts, t) {
  const vis = {};
  let end = null;
  for (const tag of Object.keys(facts)) {
    vis[tag] = visible(facts[tag], t);
    for (const e of vis[tag].keys()) if (!end || e > end) end = e;
  }
  if (!end) return null;
  let debt = evalPlans(vis, DEBT_PLANS, end);
  const cash = evalPlans(vis, CASH_PLANS, end);
  if (cash == null) return null;
  if (debt == null) {
    // a company that has never tagged any debt is debt-free; otherwise the value is missing
    const everDebt = DEBT_PLANS.some(p => [...p.base, ...p.add].some(a => a.split('|').some(tag => (facts[tag] || []).length)));
    if (everDebt) return null;
    debt = 0;
  }
  return { end, debt, cash };
}
// series of distinct balance-sheet periods visible at t (for q/q changes)
export function balanceHistory(facts, t, n = 13) {
  const ends = new Set();
  for (const tag of Object.keys(facts)) for (const [end, filed] of facts[tag]) if (ts(filed) <= t) ends.add(end);
  const sorted = [...ends].sort().slice(-n * 2);
  const vis = {};
  for (const tag of Object.keys(facts)) vis[tag] = visible(facts[tag], t);
  const out = [];
  for (const e of sorted) {
    const debt = evalPlans(vis, DEBT_PLANS, e), cash = evalPlans(vis, CASH_PLANS, e);
    if (cash != null && debt != null) out.push({ end: e, debt, cash });
  }
  // keep roughly quarterly spacing (>= 60 days apart)
  const q = [];
  for (const r of out) if (!q.length || ts(r.end) - ts(q[q.length - 1].end) > 60 * DAY) q.push(r);
  return q.slice(-n);
}
export function sharesAt(shares, t) {
  let best = null;
  for (const [end, filed, v] of shares) if (ts(filed) <= t && (!best || end > best[0] || (end === best[0] && filed > best[1]))) best = [end, filed, v];
  return best ? best[2] : null;
}
export function status(debt, cash, mcap) {
  const debtRatio = debt / mcap, cashRatio = cash / mcap;
  return { debtRatio, cashRatio, compliant: debtRatio < LIMITS.debt && cashRatio < LIMITS.cash };
}

// ---------- Monte Carlo forecast of the next review ----------
// rets: trailing daily log returns (oldest..newest). dDebt/dCash: past q/q log changes.
// H: trading days to the review. Block bootstrap (3-day blocks) keeps short-term clustering.
export function simulate(snap, H, nSims, seed, opts = {}) {
  const rng = mulberry32(seed);
  const { rets, dDebt, dCash } = snap;
  const B = 3, nb = Math.ceil(H / B);
  const shock = opts.priceShock;                    // fixed log price move (what-if), else bootstrap
  let fail = 0;
  const debtR = new Float64Array(nSims), cashR = new Float64Array(nSims);
  const pickChange = arr => (arr.length ? arr[Math.floor(rng() * arr.length)] : 0) + 0.03 * gauss(rng);
  for (let s = 0; s < nSims; s++) {
    let r = 0;
    if (shock != null) r = shock;
    else if (rets.length > B) {
      for (let b = 0; b < nb; b++) {
        const st = Math.floor(rng() * (rets.length - B));
        const len = Math.min(B, H - b * B);
        for (let k = 0; k < len; k++) r += rets[st + k];
      }
    }
    const mc = snap.mcap * Math.exp(r);
    const debt = snap.debt * Math.exp(snap.debt > 0 ? pickChange(dDebt) : 0);
    const cash = snap.cash * Math.exp(pickChange(dCash));
    debtR[s] = debt / mc; cashR[s] = cash / mc;
    if (debtR[s] >= LIMITS.debt || cashR[s] >= LIMITS.cash) fail++;
  }
  return { p: fail / nSims, debtR, cashR };
}
export function quantile(arr, q) {
  const s = Float64Array.from(arr).sort();
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
// smallest price fall (as a fraction) that alone puts a ratio over its limit
export function breakingDrop(snap) {
  const worst = Math.max(snap.debt, snap.cash) / snap.mcap;
  return Math.max(0, 1 - worst / LIMITS.debt);
}

// ---------- calibration: isotonic (PAVA) + inductive Venn-Abers ----------
// Fit isotonic regression of labels on scores; returns {xs, ys} step function.
export function isotonic(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  const blocks = [];  // [sumY, n, maxX]
  for (const i of idx) {
    blocks.push([labels[i], 1, scores[i], scores[i]]);
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a[0] / a[1] >= b[0] / b[1] || a[3] === b[2]) {
        blocks.splice(blocks.length - 2, 2, [a[0] + b[0], a[1] + b[1], a[2], b[3]]);
      } else break;
    }
  }
  return blocks.map(b => ({ lo: b[2], hi: b[3], y: b[0] / b[1] }));
}
export function isoPredict(fit, s) {
  if (!fit.length) return 0.5;
  if (s <= fit[0].hi) return fit[0].y;
  for (let i = 1; i < fit.length; i++) {
    if (s < fit[i].lo) return fit[i - 1].y;       // between blocks: step from the left
    if (s <= fit[i].hi) return fit[i].y;
  }
  return fit[fit.length - 1].y;
}
// IVAP (Vovk & Petej 2014): add the test score with label 0 and with label 1,
// refit isotonic, read the two predictions. [p0, p1] is the multiprobability
// prediction; p = p1 / (1 - p0 + p1) is the log-loss-minimising merge.
export function venAbers(calScores, calLabels, s) {
  const S = calScores.concat([s]);
  const p0 = isoPredict(isotonic(S, calLabels.concat([0])), s);
  const p1 = isoPredict(isotonic(S, calLabels.concat([1])), s);
  return { p0, p1, p: p1 / (1 - p0 + p1) };
}

// ---------- metrics ----------
export function brier(p, y) { let s = 0; for (let i = 0; i < p.length; i++) s += (p[i] - y[i]) ** 2; return s / p.length; }
export function auc(p, y) {
  const pos = [], neg = [];
  p.forEach((v, i) => (y[i] ? pos : neg).push(v));
  if (!pos.length || !neg.length) return NaN;
  const all = p.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0]);
  let rank = 1, sumPos = 0;
  for (let i = 0; i < all.length;) {
    let j = i; while (j < all.length && all[j][0] === all[i][0]) j++;
    const avg = (rank + rank + (j - i) - 1) / 2;
    for (let k = i; k < j; k++) if (all[k][1]) sumPos += avg;
    rank += j - i; i = j;
  }
  return (sumPos - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
export function reliability(p, y, edges = [0, 0.02, 0.05, 0.1, 0.2, 0.4, 0.7, 1.0001]) {
  const bins = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, sumP: 0, sumY: 0 }));
  p.forEach((v, i) => { const b = bins.find(b => v >= b.lo && v < b.hi); b.n++; b.sumP += v; b.sumY += y[i]; });
  return bins.map(b => ({ lo: b.lo, hi: Math.min(1, b.hi), n: b.n, meanP: b.n ? b.sumP / b.n : null, rate: b.n ? b.sumY / b.n : null }));
}
