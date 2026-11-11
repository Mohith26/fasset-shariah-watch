import * as W from './core/watch.js';

const $ = s => document.querySelector(s);
const LS = 'fasset.shariahWatch.v1';
let U, CAL, R;
const saved = JSON.parse(localStorage.getItem(LS) || '{}');
const state = { t: null, f: 'risk', q: '', shock: 0, notify: new Set(saved.notify || []) };

const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const riskPct = p => p >= 0.995 ? '>99%' : p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`;
const usd = v => v >= 1e12 ? `${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : `${(v / 1e6).toFixed(0)}M`;
const fmtDate = s => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const cls = p => p >= R.losses.alertThreshold * 2 ? 'hi' : p >= R.losses.alertThreshold ? 'mid' : 'lo';
const SMALL = new Set(['and', 'of', 'the', '&']);
function prettyName(n) {
  let s = n.replace(/[,.]? (Inc|Corp|Corporation|Ltd|plc|N\.V|Incorporated)\.?$/i, '').replace(/[,.]? (Inc|Corp)\.?$/i, '');
  if (s === s.toUpperCase()) s = s.toLowerCase().split(' ').map((w, i) => i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return s;
}
function logoColor(t) { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 42%)`; }
const logo = u => `<span class="logo" style="background:${logoColor(u.t)}">${u.t.length > 3 ? u.t.slice(0, 2) + '<br>' + u.t.slice(2) : u.t}</span>`;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 2000); }
function persist() {
  localStorage.setItem(LS, JSON.stringify({ notify: [...state.notify] }));
  const h = new URLSearchParams({ t: state.t, f: state.f });
  if (state.shock) h.set('shock', state.shock);
  history.replaceState(null, '', '#' + h);
}
const sel = () => U.find(u => u.t === state.t);
const atRisk = u => u.compliant && u.p >= R.losses.alertThreshold;

function filtered() {
  let L = U;
  if (state.f === 'risk') L = U.filter(atRisk);
  else if (state.f === 'ok') L = U.filter(u => u.compliant);
  else if (state.f === 'no') L = U.filter(u => !u.compliant);
  if (state.q) { const q = state.q.toLowerCase(); L = L.filter(u => u.t.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)); }
  return L;
}

function renderHero() {
  const comp = U.filter(u => u.compliant), risk = comp.filter(atRisk);
  const pb = W.pbSummary(comp.map(u => u.p));   // strategy view: how many compliant names drop out
  $('#hero').innerHTML = `
    <div class="lbl">Next quarterly review · ${fmtDate(R.nextReview)} <i class="ph-fill ph-info"></i></div>
    <div class="big">${risk.length}<small> of ${comp.length} at risk</small></div>
    <div class="sub"><span><i class="ph ph-shield-check"></i> ${comp.length} compliant today</span><span class="dim">· data as of ${fmtDate(R.asOf)}</span></div>
    <div class="row">
      <div class="tile"><span>Expected exits at review</span><b>${pb.mean.toFixed(1)} names</b><em>90%: at most ${pb.hi} · alert line ${riskPct(R.losses.alertThreshold)}</em></div>
      <div class="tile"><span>Back-tested recall</span><b>${R.losses.caught} of ${R.losses.losses}</b><em>losses flagged early</em></div>
    </div>`;
}
function renderList() {
  document.querySelectorAll('.chips button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.f === state.f)));
  const L = filtered();
  $('#list').innerHTML = L.length ? L.map(u => {
    const dW = Math.min(100, u.debtRatio / 0.6 * 100), cW = Math.min(100, u.cashRatio / 0.6 * 100);
    const bc = r => r >= 0.3 ? 'bad' : r >= 0.25 ? 'warn' : '';
    return `<div class="hold${u.t === state.t ? ' sel' : ''}" role="option" aria-selected="${u.t === state.t}" data-t="${u.t}" tabindex="-1">
      ${logo(u)}
      <div><div class="nm">${prettyName(u.name)}</div><div class="tk">${u.t}${state.notify.has(u.t) ? ' · <i class="ph-fill ph-bell" style="color:var(--green)"></i>' : ''}</div></div>
      <div class="rk ${u.compliant ? cls(u.p) : 'hi'}">${u.compliant ? riskPct(u.p) : 'Fails'}<small>${u.compliant ? 'risk at review' : 'debt ' + pct(u.debtRatio, 0)}</small></div>
      <div class="meter"><div>Debt ${pct(u.debtRatio)}<div class="bar"><i class="${bc(u.debtRatio)}" style="width:${dW}%"></i><b style="left:50%"></b></div></div>
      <div>Cash + securities ${pct(u.cashRatio)}<div class="bar"><i class="${bc(u.cashRatio)}" style="width:${cW}%"></i><b style="left:50%"></b></div></div></div>
    </div>`;
  }).join('') : `<div class="empty"><i class="ph ph-check-circle"></i>No holdings ${state.q ? 'match your search' : 'in this view'}.</div>`;
  $('#countNote').textContent = `${L.length} of ${U.length} stocks`;
  $('#list').querySelectorAll('.hold').forEach(el => el.onclick = () => select(el.dataset.t));
  const s = $('#list .hold.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
}

// history chart: debt and cash ratios per quarter + forecast fan at the review
function chartSvg(u) {
  const Wd = 330, H = 150, padL = 26, padB = 18, padT = 8;
  const pts = u.history;
  const n = pts.length + 1;   // + review
  const ymax = Math.max(0.45, ...pts.map(p => Math.max(p[1], p[2])), u.debtQ[2], u.cashQ[2]) * 1.05;
  const x = i => padL + (i / (n - 1)) * (Wd - padL - 6);
  const y = v => padT + (1 - Math.min(v, ymax) / ymax) * (H - padT - padB);
  const line = (k, color) => `<polyline fill="none" stroke="${color}" stroke-width="1.8" points="${pts.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ')}"/>`;
  const last = pts.length - 1, xr = x(n - 1);
  const fan = (q, color) => `<polygon fill="${color}" opacity=".22" points="${x(last)},${y(pts[last][q === 'd' ? 1 : 2])} ${xr},${y((q === 'd' ? u.debtQ : u.cashQ)[2])} ${xr},${y((q === 'd' ? u.debtQ : u.cashQ)[0])}"/>
    <line x1="${x(last)}" y1="${y(pts[last][q === 'd' ? 1 : 2])}" x2="${xr}" y2="${y((q === 'd' ? u.debtQ : u.cashQ)[1])}" stroke="${color}" stroke-dasharray="3 3" stroke-width="1.5"/>`;
  let grid = '';
  for (const v of [0, 0.15, 0.3, 0.45]) if (v <= ymax) grid += `<line x1="${padL}" x2="${Wd - 6}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0.3 ? '#e5596a' : '#2f312b'}" ${v === 0.3 ? 'stroke-dasharray="4 3"' : ''}/><text x="0" y="${y(v) + 3}">${Math.round(v * 100)}%</text>`;
  const years = [];
  pts.forEach((p, i) => { if (p[0].endsWith('12-31')) years.push(`<text x="${x(i) - 8}" y="${H - 4}">${p[0].slice(0, 4)}</text>`); });
  return `<svg class="chart" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Debt and cash ratios by quarter with forecast">${grid}${years.join('')}
    ${fan('c', '#7fb2ff')}${fan('d', '#1fcc7c')}${line(2, '#7fb2ff')}${line(1, '#1fcc7c')}
    <text x="${xr - 22}" y="${padT + 8}" style="fill:#c6c8c3">review</text></svg>`;
}

function renderDetail() {
  const u = sel();
  if (!u) { $('#detail').innerHTML = '<div class="empty">Select a holding</div>'; return; }
  $('#dTitle').textContent = u.t;
  $('#btnBell').classList.toggle('on', state.notify.has(u.t));
  $('#btnBell').innerHTML = `<i class="${state.notify.has(u.t) ? 'ph-fill' : 'ph'} ph-bell"></i>`;
  const sc = scenario(u);
  const k = cls(u.p);
  const dd = u.breakDrop;
  $('#detail').innerHTML = `
    <div class="d-top">${logo(u)}<div><div class="nm">${prettyName(u.name)}</div><div class="tk">${u.t} · mkt cap ${usd(u.mcap)} USD</div></div>
      <div class="px"><b>${u.price.toFixed(2)} USD</b><span>${fmtDate(R.asOf)}</span></div></div>
    <span class="status-pill ${u.compliant ? '' : 'no'}"><i class="ph-fill ${u.compliant ? 'ph-seal-check' : 'ph-x-circle'}"></i>${u.compliant ? 'Passes financial screens today' : 'Fails financial screens today'}</span>
    <div class="card" style="margin-top:10px">
      <h3>Chance of failing the ${fmtDate(R.nextReview)} review <i class="ph ph-info" id="infoRisk" style="cursor:pointer"></i></h3>
      <div class="risk-big ${u.compliant ? k : 'hi'}">${riskPct(u.p)}</div>
      <div class="risk-sub">Calibrated range <b>${riskPct(u.p0)} – ${riskPct(u.p1)}</b> (Venn-Abers) · ${u.H} trading days left</div>
      <div class="ratio"><div class="rh"><span>Debt / market cap</span><b>${pct(u.debtRatio)}</b></div>
        <div class="bar"><i class="${u.debtRatio >= .3 ? 'bad' : u.debtRatio >= .25 ? 'warn' : ''}" style="width:${Math.min(100, u.debtRatio / .6 * 100)}%"></i><b style="left:50%"></b></div>
        <div class="rq">At review: ${pct(u.debtQ[0])} to ${pct(u.debtQ[2])} (10th–90th pct) · limit 30%</div></div>
      <div class="ratio"><div class="rh"><span>Cash + interest-bearing securities / market cap</span><b>${pct(u.cashRatio)}</b></div>
        <div class="bar"><i class="${u.cashRatio >= .3 ? 'bad' : u.cashRatio >= .25 ? 'warn' : ''}" style="width:${Math.min(100, u.cashRatio / .6 * 100)}%"></i><b style="left:50%"></b></div>
        <div class="rq">At review: ${pct(u.cashQ[0])} to ${pct(u.cashQ[2])} · limit 30%</div></div>
      ${u.compliant ? `<div class="note">A price fall of <b style="color:#fff">${pct(dd)}</b> alone would put it over a limit, before any change in debt or cash.</div>` : ''}
    </div>
    <div class="card"><h3>Screen history <span style="font-size:11px">${u.history[0][0].slice(0, 4)}–today</span></h3>${chartSvg(u)}
      <div class="legend"><span><i style="background:#1fcc7c"></i>Debt</span><span><i style="background:#7fb2ff"></i>Cash + securities</span><span><i style="background:#e5596a"></i>30% limit</span></div></div>
    <div class="card whatif"><h3>What if the price moves before the review?</h3>
      <div class="wv">${state.shock > 0 ? '+' : ''}${state.shock}%</div>
      <input type="range" id="shock" min="-40" max="40" step="5" value="${state.shock}" aria-label="Price move before review, percent">
      <div class="wf"><span>-40%</span><span>0</span><span>+40%</span></div>
      <div class="estimate">Model chance of failing in this scenario<b class="${sc >= R.losses.alertThreshold ? 'hi' : ''}">${riskPct(sc)}</b>Balance-sheet changes still simulated from its last 12 quarters. Scenario odds are model estimates, not calibrated.</div>
    </div>
    <div class="cta-row"><button class="cta ${state.notify.has(u.t) ? 'off' : ''}" id="btnNotify"><i class="ph${state.notify.has(u.t) ? '-fill' : ''} ph-bell"></i>${state.notify.has(u.t) ? 'Alert on · tap to turn off' : 'Alert me before the review'}</button>
      <button class="pill-btn" id="btnJson" aria-label="Export JSON"><i class="ph ph-export"></i></button></div>
    <p class="note">Financial screens follow AAOIFI Standard 21 (interest-bearing debt and interest-bearing cash/securities each below 30% of market cap) from SEC filings. Business-activity and impure-income screens come from Fasset's Shariah screening partner and are not modelled here.</p>`;
  $('#shock').oninput = e => { state.shock = +e.target.value; renderDetail(); persist(); };
  $('#btnNotify').onclick = toggleNotify;
  $('#btnJson').onclick = exportJson;
  $('#infoRisk').onclick = openHow;
}
const scCache = new Map();
function scenario(u) {
  const key = u.t + ':' + state.shock;
  if (!scCache.has(key)) {
    const r = W.simulate({ ...u, mcap: u.mcap }, u.H, 3000, 77, { priceShock: Math.log(1 + state.shock / 100) });
    scCache.set(key, r.p);
  }
  return scCache.get(key);
}

function select(t) { state.t = t; renderList(); renderDetail(); persist(); }
function toggleNotify() {
  const u = sel(); if (!u) return;
  if (state.notify.has(u.t)) { state.notify.delete(u.t); toast(`Alert off for ${u.t}`); }
  else { state.notify.add(u.t); toast(`We'll alert you if ${u.t} crosses ${riskPct(R.losses.alertThreshold)} before the review`); }
  renderList(); renderDetail(); persist();
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportCsv() {
  const cols = ['ticker', 'name', 'compliant_today', 'debt_ratio', 'cash_ratio', 'p_fail_next_review', 'p_low', 'p_high', 'price_fall_to_breach', 'alert_on'];
  const rows = filtered().map(u => [u.t, JSON.stringify(u.name), u.compliant, u.debtRatio, u.cashRatio, u.p, u.p0, u.p1, u.breakDrop, state.notify.has(u.t)].join(','));
  download(`shariah-watch-${R.nextReview}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
  toast('Watchlist exported (CSV)');
}
function exportJson() {
  const u = sel();
  const { rets, dDebt, dCash, ...rest } = u;
  download(`shariah-watch-${u.t}.json`, JSON.stringify({ ...rest, nextReview: R.nextReview, asOf: R.asOf, alertThreshold: R.losses.alertThreshold, scenario: { priceMovePct: state.shock, pFail: scenario(u) } }, null, 2), 'application/json');
  toast(`${u.t} report exported (JSON)`);
}

function openHow() {
  const L = R.losses, B = R.brier;
  const rel = R.reliability.filter(b => b.n).map(b => `<tr><td>${riskPct(b.lo)}–${riskPct(b.hi)}</td><td>${b.n}</td><td>${riskPct(b.meanP)}</td><td>${riskPct(b.rate)}</td></tr>`).join('');
  $('#sheet').innerHTML = `<div class="sheet"><h3>How the odds are calibrated</h3>
    <p>For every quarter-end review from 2013 to mid-2026, ${R.stocks} large US stocks were screened from their SEC filings and prices, and the next quarter was simulated 600 times: the price path by block-bootstrapping the last two years of daily returns, debt and cash by resampling the company's own last 12 quarterly changes. Reviews up to 2020 calibrate the raw simulation with inductive Venn-Abers prediction; ${L.compliantReviews} compliant reviews from 2021 to 2026 are held out.</p>
    <table><tr><th>Held-out, ${R.testPeriod.replace('..', ' to ')}</th><th></th></tr>
      <tr><td>Compliance losses at the next review</td><td>${L.losses} of ${L.compliantReviews} (${pct(L.baseLossRate)})</td></tr>
      <tr><td>Flagged a quarter early (≥ ${riskPct(L.alertThreshold)})</td><td class="good">${L.caught} of ${L.losses}</td></tr>
      <tr><td>Share of compliant holdings alerted</td><td>${pct(L.alertRate)}</td></tr>
      <tr><td>Alerts that did lose compliance</td><td>${pct(L.precision)} (vs ${pct(L.baseLossRate)} base rate)</td></tr>
      <tr><td>Ranking quality (AUC, compliant holdings)</td><td>${L.aucAmongCompliant.toFixed(3)}</td></tr>
      <tr><td>Brier score: Venn-Abers / raw simulation / "status stays the same"</td><td>${B.venAbers} / ${B.rawMonteCarlo} / ${B.persistence}</td></tr></table>
    <p style="margin-bottom:2px">Reliability on held-out reviews (all stocks)</p>
    <table><tr><th>Predicted</th><th>Reviews</th><th>Mean predicted</th><th>Actually failed</th></tr>${rel}</table>
    <p>The alert line (${riskPct(L.alertThreshold)}) was chosen on 2013-2020 data only. Venn-Abers gives each probability as a range [p0, p1]; its guarantee assumes past and future reviews are exchangeable, which a market regime change can break.</p>
    <div style="display:flex;justify-content:flex-end"><button class="pill-btn" id="closeSheet">Close</button></div></div>`;
  $('#sheet').classList.remove('hidden');
  $('#closeSheet').onclick = () => $('#sheet').classList.add('hidden');
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') $('#sheet').classList.add('hidden'); };
}
function openKeys() {
  const keys = [['↑ / ↓', 'Move through holdings'], ['1 2 3 4', 'At risk / Compliant / Not compliant / All'], ['/', 'Search'], ['N', 'Toggle alert for the selected stock'], ['← / →', 'Scenario price move −/+5%'], ['E', 'Export watchlist CSV'], ['J', 'Export selected stock JSON'], ['H', 'How the odds are calibrated'], ['Esc', 'Close']];
  $('#sheet').innerHTML = `<div class="sheet" style="width:420px"><h3>Keyboard shortcuts</h3><div class="kbd-list" style="margin-top:12px">${keys.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div><div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="pill-btn" id="closeSheet">Close</button></div></div>`;
  $('#sheet').classList.remove('hidden');
  $('#closeSheet').onclick = () => $('#sheet').classList.add('hidden');
}

function bind() {
  document.querySelectorAll('.chips button').forEach(b => b.onclick = () => { state.f = b.dataset.f; renderList(); persist(); });
  $('#btnCsv').onclick = exportCsv;
  $('#btnHow').onclick = openHow;
  $('#btnBell').onclick = toggleNotify;
  $('#btnSearch').onclick = () => { $('#searchBox').classList.toggle('hidden'); $('#q').focus(); };
  $('#q').oninput = e => { state.q = e.target.value; renderList(); };
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.key !== 'Escape') return;
    const L = filtered(), i = L.findIndex(u => u.t === state.t);
    const k = e.key;
    if (k === 'ArrowDown') { if (L.length) select(L[Math.min(L.length - 1, i + 1)].t); e.preventDefault(); }
    else if (k === 'ArrowUp') { if (L.length) select(L[Math.max(0, i - 1)].t); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'ArrowRight') { state.shock = Math.max(-40, Math.min(40, state.shock + (k === 'ArrowLeft' ? -5 : 5))); renderDetail(); persist(); }
    else if ('1234'.includes(k) && k.length === 1) { state.f = ['risk', 'ok', 'no', 'all'][+k - 1]; renderList(); persist(); }
    else if (k === '/') { $('#searchBox').classList.remove('hidden'); $('#q').focus(); e.preventDefault(); }
    else if (k === 'n' || k === 'N') toggleNotify();
    else if (k === 'e' || k === 'E') exportCsv();
    else if (k === 'j' || k === 'J') exportJson();
    else if (k === 'h' || k === 'H') openHow();
    else if (k === '?') openKeys();
    else if (k === 'Escape') { $('#sheet').classList.add('hidden'); $('#searchBox').classList.add('hidden'); state.q = ''; $('#q').value = ''; renderList(); }
  });
}

async function boot() {
  try {
    const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };
    [U, CAL, R] = await Promise.all([get('data/universe.json'), get('data/calibration.json'), get('data/results.json')]);
    const h = new URLSearchParams(location.hash.slice(1));
    state.f = ['risk', 'ok', 'no', 'all'].includes(h.get('f')) ? h.get('f') : 'risk';
    state.t = U.some(u => u.t === h.get('t')) ? h.get('t') : (U.find(atRisk) || U[0]).t;
    state.shock = Math.max(-40, Math.min(40, +h.get('shock') || 0));
    $('#capStats').innerHTML = `<div><b>${R.losses.caught}/${R.losses.losses}</b><span>compliance losses flagged a quarter early (2021-26, held out)</span></div><div><b>${pct(R.losses.alertRate)}</b><span>of compliant holdings alerted to catch them</span></div>`;
    bind(); renderHero(); renderList(); renderDetail(); persist();
    $('#loading').classList.add('hidden');
  } catch (err) {
    console.error(err);
    $('#loading').classList.add('hidden');
    $('#errorText').textContent = `Could not load data (${err.message}).`;
    $('#error').classList.remove('hidden');
  }
}
boot();
