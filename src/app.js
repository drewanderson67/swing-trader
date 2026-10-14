'use strict';
const VERSION = '1.0.0';
const KEY = 'swingtrader.v1';
const SEEDS = {AAPL:230,MSFT:420,NVDA:130,TSLA:250,AMZN:190,GOOGL:165,META:560,SPY:570,QQQ:490,AMD:160,NFLX:700,JPM:210};
const HIST_MAX = 600;
const DEMO_PATH = [121,126,118,95,91,97,85,84,90,110,112,106,128,131,124];
const PHASE = {LONG:'LONG',SHORT:'SHORT',WATCH_PEAK:'WATCH TOP',WATCH_TROUGH:'WATCH LOW',STOPPED:'STOPPED'};
const RT = {err:'', last:0};
let S, view = 'portfolio', detailId = null, dirty = true, structDirty = true;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
const sMoney = n => (n > 0.004 ? '+' : '') + money(n);
const px = n => n == null || !isFinite(n) ? '—' : n >= 1 ? n.toFixed(2) : n.toFixed(4);
const pct = (n, d = 2) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d) + '%';
const cls = n => n > 0.004 ? 'pos' : n < -0.004 ? 'neg' : '';
const tstr = t => new Date(t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
const dstr = t => new Date(t).toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' + tstr(t);
const uid = () => S.nextId++;

/* ---------- state ---------- */
function defProfile() {
  return {id:'p1', name:'Standard swing', longTP:20, longSL:10, swing:5, shortTP:20, shortSL:10, afterProfit:'swing', afterLoss:'swing', maxCycles:0};
}
function defSettings() {
  return {source:'sim', apiKey:'', pollSec:15, speed:2, vol:1, startCash:100000, commission:0, notify:false, sound:true, running:true};
}
function defState() {
  return {version:VERSION, settings:defSettings(), cash:100000, profiles:[defProfile()], bots:[], trades:[], quotes:{}, nextId:2};
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.bots)) {
      S = Object.assign(defState(), s);
      S.settings = Object.assign(defSettings(), s.settings);
      S.version = VERSION;
      return;
    }
  } catch (e) {}
  S = defState();
}
let lastSave = 0;
function save(now) {
  if (!now && Date.now() - lastSave < 3000) return;
  lastSave = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
}
const prof = b => S.profiles.find(p => p.id === b.profileId) || S.profiles[0];
const bot = id => S.bots.find(b => b.id === id);

/* ---------- trading engine ---------- */
function levels(b) {
  const pr = prof(b), e = b.entry;
  switch (b.phase) {
    case 'LONG': return {tp:e * (1 + pr.longTP / 100), sl:e * (1 - pr.longSL / 100)};
    case 'SHORT': return {tp:e * (1 - pr.shortTP / 100), sl:e * (1 + pr.shortSL / 100)};
    case 'WATCH_PEAK': return {trig:b.extreme * (1 - pr.swing / 100)};
    case 'WATCH_TROUGH': return {trig:b.extreme * (1 + pr.swing / 100)};
  }
  return {};
}
function unreal(b, p) {
  if (b.phase === 'LONG') return (p - b.entry) * b.qty;
  if (b.phase === 'SHORT') return (b.entry - p) * b.qty;
  return 0;
}
function evalBot(b, p, t) {
  if (b.paused || b.phase === 'STOPPED') return;
  const pr = prof(b), L = levels(b);
  if (b.phase === 'LONG') {
    if (p >= L.tp) closePos(b, p, t, 'TP', `Take profit: +${pr.longTP}% target ${px(L.tp)} reached`);
    else if (p <= L.sl) closePos(b, p, t, 'SL', `Stop loss: −${pr.longSL}% limit ${px(L.sl)} reached`);
  } else if (b.phase === 'SHORT') {
    if (p <= L.tp) closePos(b, p, t, 'TP', `Short profit: −${pr.shortTP}% target ${px(L.tp)} reached`);
    else if (p >= L.sl) closePos(b, p, t, 'SL', `Short risk: +${pr.shortSL}% limit ${px(L.sl)} reached`);
  } else if (b.phase === 'WATCH_PEAK') {
    if (p > b.extreme) b.extreme = p;
    else if (p <= L.trig) openPos(b, 'SHORT', p, t, `Swing: −${pr.swing}% off high ${px(b.extreme)}`);
  } else if (b.phase === 'WATCH_TROUGH') {
    if (p < b.extreme) b.extreme = p;
    else if (p >= L.trig) openPos(b, 'LONG', p, t, `Swing: +${pr.swing}% off low ${px(b.extreme)}`);
  }
}
function openPos(b, side, p, t, reason) {
  const fee = +S.settings.commission || 0;
  let qty = b.sizing === 'compound' ? Math.floor((b.capital + b.realized) / p) : b.baseQty;
  if (side === 'LONG' && qty * p + fee > S.cash) qty = Math.floor((S.cash - fee) / p);
  if (qty <= 0) {
    b.phase = 'STOPPED';
    toast(`${b.sym}: not enough cash to ${side === 'LONG' ? 'buy' : 'short'} — monitoring stopped`, 'dn');
    structDirty = true;
    return;
  }
  S.cash += side === 'LONG' ? -(qty * p) - fee : qty * p - fee;
  Object.assign(b, {phase:side, entry:p, qty, entryT:t, openFee:fee, extreme:p});
  logTrade(b, side === 'LONG' ? 'BUY' : 'SHORT', qty, p, reason, null, null, t);
}
function closePos(b, p, t, kind, reason) {
  const pr = prof(b), wasLong = b.phase === 'LONG', fee = +S.settings.commission || 0;
  const gross = wasLong ? (p - b.entry) * b.qty : (b.entry - p) * b.qty;
  const pl = gross - fee - (b.openFee || 0);
  const plPct = pl / (b.entry * b.qty) * 100;
  S.cash += wasLong ? b.qty * p - fee : -(b.qty * p) - fee;
  b.realized += pl;
  b.cycles++;
  logTrade(b, wasLong ? 'SELL' : 'COVER', b.qty, p, reason, pl, plPct, t);
  b.qty = 0; b.entry = 0;
  const priceRose = (wasLong && kind === 'TP') || (!wasLong && kind === 'SL');
  const rule = kind === 'TP' ? pr.afterProfit : kind === 'SL' ? pr.afterLoss : 'stop';
  if (rule === 'stop' || (pr.maxCycles > 0 && b.cycles >= pr.maxCycles)) { b.phase = 'STOPPED'; return; }
  if (rule === 'reverse') { openPos(b, wasLong ? 'SHORT' : 'LONG', p, t, 'Reverse after stop loss'); return; }
  b.phase = priceRose ? 'WATCH_PEAK' : 'WATCH_TROUGH';
  b.extreme = p;
}
function logTrade(b, action, qty, price, reason, pl, plPct, t) {
  const tr = {id:uid(), t, sym:b.sym, bot:b.id, action, qty, price:+price.toFixed(4), reason,
    pl:pl == null ? null : +pl.toFixed(2), plPct:plPct == null ? null : +plPct.toFixed(2)};
  S.trades.push(tr);
  if (S.trades.length > 5000) S.trades.splice(0, S.trades.length - 5000);
  structDirty = true;
  save(true);
  announce(tr);
}
function startBot(b, mode, p, t) {
  if (mode === 'buy') openPos(b, 'LONG', p, t, 'Initial buy');
  else if (mode === 'short') openPos(b, 'SHORT', p, t, 'Initial short');
  else { b.phase = mode === 'top' ? 'WATCH_PEAK' : 'WATCH_TROUGH'; b.extreme = p; }
}
function newBot(sym, qty, profileId, sizing, mode) {
  const q = S.quotes[sym], t = Date.now();
  const b = {id:uid(), sym, profileId, baseQty:qty, sizing, capital:qty * q.p, phase:'STOPPED', qty:0, entry:0, entryT:0,
    openFee:0, extreme:q.p, cycles:0, realized:0, paused:false, created:t, startMode:mode};
  S.bots.push(b);
  startBot(b, mode, q.p, t);
  structDirty = true;
  save(true);
  return b;
}
function manualClose(b, reason) {
  const q = S.quotes[b.sym];
  if (!q || (b.phase !== 'LONG' && b.phase !== 'SHORT')) return;
  closePos(b, q.p, Date.now(), 'MANUAL', reason);
}
function equity() {
  let e = S.cash;
  for (const b of S.bots) {
    const q = S.quotes[b.sym]; if (!q) continue;
    if (b.phase === 'LONG') e += b.qty * q.p;
    if (b.phase === 'SHORT') e -= b.qty * q.p;
  }
  return e;
}

/* ---------- price feeds ---------- */
function ensureQuote(sym, p, ref) {
  if (!S.quotes[sym]) S.quotes[sym] = {p, ref:ref || p, t:Date.now(), hist:[[Date.now(), p]]};
  return S.quotes[sym];
}
function pushPrice(sym, p, t) {
  const q = S.quotes[sym]; if (!q) return;
  p = +p.toFixed(4);
  q.p = p; q.t = t;
  q.hist.push([t, p]);
  if (q.hist.length > HIST_MAX) q.hist.splice(0, q.hist.length - HIST_MAX);
  for (const b of S.bots.slice()) if (b.sym === sym) evalBot(b, p, t);
  dirty = true;
}
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function simStep(q) {
  if (q.script && q.script.length) {
    const tgt = q.script[0], step = q.p * 0.008, d = tgt - q.p;
    if (Math.abs(d) <= step) { q.script.shift(); return tgt; }
    return q.p + Math.sign(d) * step;
  }
  const vol = +S.settings.vol || 1, sig = 0.004 * vol;
  if (!q.sim || q.sim.left <= 0) q.sim = {bias:(Math.random() - 0.5) * 0.003 * vol, left:40 + Math.floor(Math.random() * 260)};
  q.sim.left--;
  return Math.max(0.5, q.p * Math.exp(q.sim.bias + sig * gauss() - 0.5 * sig * sig));
}
let simTimer = null, liveTimer = null, liveGen = 0;
function restartLoops() {
  clearInterval(simTimer); clearTimeout(liveTimer); simTimer = null; liveGen++;
  RT.err = '';
  if (S.settings.source === 'sim') simTimer = setInterval(simTick, 1000 / (+S.settings.speed || 1));
  else pollLive();
  dirty = true;
}
function simTick() {
  if (!S.settings.running) return;
  const t = Date.now();
  for (const sym of Object.keys(S.quotes)) pushPrice(sym, simStep(S.quotes[sym]), t);
  save();
}
async function fetchQuote(sym) {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(S.settings.apiKey.trim())}`, {cache:'no-store'});
  if (r.status === 429) throw new Error('rate limited — raise the poll interval');
  if (r.status === 401 || r.status === 403) throw new Error('API key rejected');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!j || !j.c) throw new Error('no quote for ' + sym);
  return j;
}
async function pollLive() {
  const gen = liveGen;
  if (S.settings.source !== 'live') return;
  if (!S.settings.apiKey.trim()) RT.err = 'Add your Finnhub API key in Settings';
  else if (S.settings.running) {
    for (const sym of Object.keys(S.quotes)) {
      if (S.quotes[sym].demo) continue;
      try {
        const j = await fetchQuote(sym);
        if (gen !== liveGen) return;
        const q = S.quotes[sym]; if (!q) continue;
        if (j.pc) q.ref = j.pc;
        if (j.c !== q.p || q.hist.length < 2) pushPrice(sym, j.c, Date.now());
        RT.last = Date.now(); RT.err = '';
      } catch (e) {
        if (gen !== liveGen) return;
        RT.err = sym + ': ' + (e.message === 'Failed to fetch' ? 'network error' : e.message);
      }
    }
    save();
  }
  dirty = true;
  if (gen === liveGen) liveTimer = setTimeout(pollLive, Math.max(5, +S.settings.pollSec || 15) * 1000);
}

/* ---------- alerts ---------- */
function toast(msg, kind) {
  const d = document.createElement('div');
  d.className = 'toast ' + (kind || '');
  d.textContent = msg;
  const box = $('#toasts');
  box.appendChild(d);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => d.remove(), 3500);
}
let actx = null;
function beep(up) {
  if (!S.settings.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = up ? 880 : 330; o.type = 'sine';
    g.gain.setValueAtTime(0.08, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.35);
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.36);
  } catch (e) {}
}
function announce(tr) {
  const verb = {BUY:'Bought', SELL:'Sold', SHORT:'Sold short', COVER:'Bought to cover'}[tr.action];
  const msg = `${tr.sym}: ${verb} ${tr.qty} @ ${px(tr.price)}${tr.pl != null ? ' · ' + sMoney(tr.pl) : ''}`;
  const kind = tr.pl == null ? '' : tr.pl >= 0 ? 'up' : 'dn';
  toast(msg + ' — ' + tr.reason, kind);
  beep(tr.pl == null ? tr.action === 'BUY' : tr.pl >= 0);
  if (S.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller)
        navigator.serviceWorker.ready.then(r => r.showNotification('SwingTrader', {body:msg + '\n' + tr.reason, tag:'t' + tr.id}));
      else new Notification('SwingTrader', {body:msg + '\n' + tr.reason});
    } catch (e) {}
  }
  const card = $(`.bot[data-open="${tr.bot}"]`);
  if (card) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1500); }
}

/* ---------- charts ---------- */
function chartLevels(b) {
  if (!b) return [];
  const L = levels(b), out = [];
  if (b.phase === 'LONG' || b.phase === 'SHORT') {
    out.push({p:b.entry, label:'Entry', c:'#94a3b8'}, {p:L.tp, label:'Profit', c:'#22c55e'}, {p:L.sl, label:b.phase === 'LONG' ? 'Stop' : 'Risk', c:'#ef4444'});
  } else if (b.phase === 'WATCH_PEAK') {
    out.push({p:b.extreme, label:'High', c:'#94a3b8'}, {p:L.trig, label:'Short', c:'#f59e0b'});
  } else if (b.phase === 'WATCH_TROUGH') {
    out.push({p:b.extreme, label:'Low', c:'#94a3b8'}, {p:L.trig, label:'Buy', c:'#f59e0b'});
  }
  return out;
}
function drawChart(cv, q, b, big) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h || !q) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const H = q.hist; if (H.length < 2) return;
  const lv = big ? chartLevels(b) : [];
  let lo = Infinity, hi = -Infinity;
  for (const [, p] of H) { if (p < lo) lo = p; if (p > hi) hi = p; }
  for (const l of lv) { if (l.p < lo) lo = l.p; if (l.p > hi) hi = l.p; }
  if (hi - lo < hi * 0.002) { hi += hi * 0.001; lo -= lo * 0.001; }
  const pl = big ? 8 : 1, pr = big ? 62 : 1, pt = big ? 12 : 3, pb = big ? 12 : 3;
  const X = i => pl + i / (H.length - 1) * (w - pl - pr), Y = p => pt + (hi - p) / (hi - lo) * (h - pt - pb);
  c.font = '11px -apple-system,Segoe UI,Roboto,sans-serif';
  if (big) {
    c.strokeStyle = '#1c2742'; c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const yy = pt + i / 4 * (h - pt - pb); c.beginPath(); c.moveTo(pl, yy); c.lineTo(w - pr, yy); c.stroke(); }
    for (const l of lv) {
      const yy = Y(l.p);
      c.strokeStyle = l.c; c.setLineDash([5, 4]); c.beginPath(); c.moveTo(pl, yy); c.lineTo(w - pr, yy); c.stroke(); c.setLineDash([]);
      c.fillStyle = l.c; c.fillText(l.label, w - pr + 4, yy - 2); c.fillText(px(l.p), w - pr + 4, yy + 10);
    }
  }
  const up = H[H.length - 1][1] >= H[0][1];
  const col = up ? '#22c55e' : '#ef4444';
  c.beginPath();
  H.forEach(([, p], i) => i ? c.lineTo(X(i), Y(p)) : c.moveTo(X(i), Y(p)));
  c.strokeStyle = col; c.lineWidth = big ? 2 : 1.5; c.lineJoin = 'round'; c.stroke();
  if (big) {
    c.lineTo(X(H.length - 1), h - pb); c.lineTo(X(0), h - pb); c.closePath();
    const g = c.createLinearGradient(0, pt, 0, h); g.addColorStop(0, up ? 'rgba(34,197,94,.18)' : 'rgba(239,68,68,.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fill();
  }
  // trade markers
  const t0 = H[0][0];
  for (const tr of S.trades) {
    if (tr.sym !== q.sym && tr.sym !== (b && b.sym)) continue;
    if (b && tr.bot !== b.id) continue;
    if (tr.t < t0) continue;
    let i = H.findIndex(e => e[0] >= tr.t); if (i < 0) i = H.length - 1;
    const xx = X(i), yy = Y(tr.price), buy = tr.action === 'BUY' || tr.action === 'COVER', s = big ? 6 : 4;
    c.fillStyle = buy ? '#4ade80' : '#f87171';
    c.beginPath();
    if (buy) { c.moveTo(xx, yy + 2); c.lineTo(xx - s, yy + 2 + s * 1.5); c.lineTo(xx + s, yy + 2 + s * 1.5); }
    else { c.moveTo(xx, yy - 2); c.lineTo(xx - s, yy - 2 - s * 1.5); c.lineTo(xx + s, yy - 2 - s * 1.5); }
    c.fill();
    if (big) { c.fillStyle = '#e6edf7'; const tw = c.measureText(tr.action).width; c.fillText(tr.action, Math.min(Math.max(2, xx - tw / 2), w - pr - tw), buy ? yy + 26 : yy - 18); }
  }
}

/* ---------- describe ---------- */
function describe(b) {
  const q = S.quotes[b.sym], p = q ? q.p : 0, pr = prof(b), L = levels(b);
  const away = x => pct((x - p) / p * 100, 1) + ' away';
  switch (b.phase) {
    case 'LONG': {
      const u = unreal(b, p);
      return {pos:`Long ${b.qty} @ ${px(b.entry)} · <span class="${cls(u)}">${sMoney(u)} (${pct(u / (b.entry * b.qty) * 100)})</span>`,
        next:`Sell for profit ≥ ${px(L.tp)} (${away(L.tp)}) · loss ≤ ${px(L.sl)}`, L};
    }
    case 'SHORT': {
      const u = unreal(b, p);
      return {pos:`Short ${b.qty} @ ${px(b.entry)} · <span class="${cls(u)}">${sMoney(u)} (${pct(u / (b.entry * b.qty) * 100)})</span>`,
        next:`Cover for profit ≤ ${px(L.tp)} (${away(L.tp)}) · loss ≥ ${px(L.sl)}`, L};
    }
    case 'WATCH_PEAK':
      return {pos:`Flat · tracking high ${px(b.extreme)}`, next:`Sell short if price falls ${pr.swing}% to ${px(L.trig)} (${away(L.trig)})`, L};
    case 'WATCH_TROUGH':
      return {pos:`Flat · tracking low ${px(b.extreme)}`, next:`Buy if price rises ${pr.swing}% to ${px(L.trig)} (${away(L.trig)})`, L};
  }
  return {pos:'Flat · not monitoring', next:'Stopped — use Buy now / Short now to restart', L};
}
function badge(b) { return b.paused ? ['PAUSED', 'PAUSED'] : [PHASE[b.phase], b.phase]; }
function tradeRow(tr, showDate) {
  return `<div class="tr"><span class="act ${tr.action}">${tr.action}</span><div class="mid"><b>${esc(tr.sym)}</b> ${tr.qty} @ ${px(tr.price)}<div class="rsn">${esc(tr.reason)} · ${showDate ? dstr(tr.t) : tstr(tr.t)}</div></div>` +
    (tr.pl != null ? `<div class="pl ${cls(tr.pl)}">${sMoney(tr.pl)}<small>${pct(tr.plPct)}</small></div>` : '<div class="pl muted">open</div>') + '</div>';
}

/* ---------- portfolio view ---------- */
function stats(list) {
  const closed = list.filter(t => t.pl != null);
  const wins = closed.filter(t => t.pl > 0).length;
  return {closed:closed.length, wins, losses:closed.length - wins, realized:closed.reduce((a, t) => a + t.pl, 0)};
}
function renderPortfolioStruct() {
  const el = $('#bots');
  if (!S.bots.length) {
    el.innerHTML = `<div class="card empty" style="grid-column:1/-1">No stocks monitored yet.<br><button class="btn primary" data-go="new">Add a stock</button><button class="btn" data-act="demo">Run demo scenario</button><div class="small" style="margin-top:8px">The demo drives a scripted DEMO price through every rule: profit sell, swing short, short cover, stop loss, re-entry.</div></div>`;
  } else {
    el.innerHTML = S.bots.map(b => `<div class="card bot" data-open="${b.id}"><div class="row"><div><b class="sym">${esc(b.sym)}</b> <span class="badge" data-f="badge"></span><div class="small muted" data-f="prof"></div></div><div class="r"><div class="price" data-f="price"></div><div class="chg" data-f="chg"></div></div></div><canvas class="spark" data-f="spark"></canvas><div class="ln" data-f="pos"></div><div class="nx" data-f="next"></div></div>`).join('') +
      `<div class="card empty" style="margin:0"><button class="btn" data-go="new">+ Add stock</button>${S.quotes.DEMO ? '' : '<button class="btn" data-act="demo">Run demo</button>'}</div>`;
  }
  const rec = S.trades.slice(-8).reverse();
  $('#recent').innerHTML = rec.length ? rec.map(t => tradeRow(t)).join('') : '<div class="empty small">Trades will appear here as rules fire.</div>';
}
function updatePortfolio() {
  const eq = equity(), st = stats(S.trades), start = S.startCash || S.settings.startCash;
  let ur = 0, open = 0;
  for (const b of S.bots) { const q = S.quotes[b.sym]; if (q) ur += unreal(b, q.p); if (b.phase === 'LONG' || b.phase === 'SHORT') open++; }
  const tot = eq - start;
  $('#summary').innerHTML = `<div class="big"><div class="k">Account equity</div><div class="v">${money(eq)} <span class="${cls(tot)}" style="font-size:15px">${sMoney(tot)} (${pct(tot / start * 100)})</span></div></div>
    <div><div class="k">Cash</div><div class="v">${money(S.cash)}</div></div>
    <div><div class="k">Realized P/L</div><div class="v ${cls(st.realized)}">${sMoney(st.realized)}</div></div>
    <div><div class="k">Unrealized P/L</div><div class="v ${cls(ur)}">${sMoney(ur)}</div></div>
    <div><div class="k">Open · Win rate</div><div class="v">${open} · ${st.closed ? Math.round(st.wins / st.closed * 100) + '%' : '—'} <span class="small muted">(${st.wins}W/${st.losses}L)</span></div></div>`;
  for (const card of $$('.bot')) {
    const b = bot(+card.dataset.open); if (!b) continue;
    const q = S.quotes[b.sym]; if (!q) continue;
    const f = k => $(`[data-f="${k}"]`, card), [bl, bc] = badge(b), d = describe(b), ch = (q.p - q.ref) / q.ref * 100;
    f('badge').textContent = bl; f('badge').className = 'badge ' + bc;
    f('prof').textContent = prof(b).name;
    f('price').textContent = px(q.p);
    f('chg').textContent = pct(ch); f('chg').className = 'chg ' + cls(ch);
    f('pos').innerHTML = d.pos; f('next').textContent = d.next;
    drawChart(f('spark'), q, b, false);
  }
}

/* ---------- add view ---------- */
let lastSym = '';
function renderNew() {
  const syms = [...new Set([...Object.keys(SEEDS), ...Object.keys(S.quotes)])].filter(s => s !== 'DEMO');
  $('#v-new').innerHTML = `<div class="card"><h2>Monitor a stock</h2>
    <label>Symbol<input id="nSym" list="symList" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. AAPL" value="${esc(lastSym)}"></label>
    <datalist id="symList">${syms.map(s => `<option value="${s}">`).join('')}</datalist>
    <div class="grid2"><label>Shares<input id="nQty" type="number" min="1" step="1" inputmode="numeric" value="100"></label>
    <label>Re-entry size<select id="nSizing"><option value="fixed">Same share count</option><option value="compound">Reinvest P/L</option></select></label></div>
    <label>Profile<select id="nProf">${S.profiles.map(p => `<option value="${p.id}">${esc(p.name)} (+${p.longTP}% / −${p.longSL}%)</option>`).join('')}</select></label>
    <label>Start<select id="nStart"><option value="buy">Buy now (go long)</option><option value="short">Sell short now</option><option value="dip">Wait for a dip, then buy</option><option value="top">Wait for a top, then short</option></select></label>
    <div class="preview" id="nPrev"></div>
    <div class="err" id="nErr"></div>
    <button class="btn primary big" data-act="create">Start monitoring</button>
    <p class="small muted">Paper trading only — no real orders are placed. Source: ${S.settings.source === 'sim' ? 'simulated market (change in Settings)' : 'live Finnhub quotes'}.</p></div>`;
  updateNew();
}
function updateNew() {
  const el = $('#nPrev'); if (!el) return;
  const sym = ($('#nSym').value || '').trim().toUpperCase(), qty = Math.max(0, Math.floor(+$('#nQty').value || 0));
  const pr = S.profiles.find(p => p.id === $('#nProf').value) || S.profiles[0], mode = $('#nStart').value;
  const p = S.quotes[sym] ? S.quotes[sym].p : SEEDS[sym];
  if (!sym) { el.innerHTML = 'Enter a symbol to see the plan.'; return; }
  if (!p) { el.innerHTML = `<b>${esc(sym)}</b> — price will be fetched when you start.` + planList(pr, null, qty, mode); return; }
  el.innerHTML = `<b>${esc(sym)}</b> ≈ ${px(p)}${S.quotes[sym] ? '' : ' (est.)'} · ${qty} shares ≈ ${money(qty * p)} · cash ${money(S.cash)}` + planList(pr, p, qty, mode);
}
function planList(pr, p, qty, mode) {
  const f = x => p ? px(x) : '';
  const v = (k, x) => p ? ` <b>${f(x)}</b>` : '';
  const first = mode === 'buy' ? `Buy ${qty} now${p ? ' @ ' + px(p) : ''}.`
    : mode === 'short' ? `Sell short ${qty} now${p ? ' @ ' + px(p) : ''}.`
    : mode === 'dip' ? `Track the low; buy when price rises ${pr.swing}% off it.` : `Track the high; short when price falls ${pr.swing}% off it.`;
  const long = mode !== 'short' && mode !== 'top';
  const e = p || 0;
  const a = long
    ? `Long: sell for profit at +${pr.longTP}%${v(0, e * (1 + pr.longTP / 100))}, or for a loss at −${pr.longSL}%${v(0, e * (1 - pr.longSL / 100))}.`
    : `Short: cover for profit at −${pr.shortTP}%${v(0, e * (1 - pr.shortTP / 100))}, or for a loss at +${pr.shortSL}%${v(0, e * (1 + pr.shortSL / 100))}.`;
  return `<ol><li>${first}</li><li>${a}${mode === 'dip' || mode === 'top' ? ' (levels set from the entry price)' : ''}</li><li>Then keep swinging: after an exit, wait for a ${pr.swing}% reversal and take the opposite side (see profile).</li></ol>`;
}
async function createFromForm(btn) {
  const err = $('#nErr'); err.textContent = '';
  const sym = ($('#nSym').value || '').trim().toUpperCase(), qty = Math.floor(+$('#nQty').value || 0);
  const mode = $('#nStart').value, sizing = $('#nSizing').value, pid = $('#nProf').value;
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) { err.textContent = 'Enter a valid ticker symbol.'; return; }
  if (qty < 1) { err.textContent = 'Shares must be at least 1.'; return; }
  if (!S.quotes[sym]) {
    if (S.settings.source === 'live') {
      if (!S.settings.apiKey.trim()) { err.textContent = 'Live mode needs a Finnhub API key (Settings).'; return; }
      btn.disabled = true; btn.textContent = 'Fetching quote…';
      try { const j = await fetchQuote(sym); ensureQuote(sym, j.c, j.pc); }
      catch (e) { err.textContent = 'Could not get a quote: ' + (e.message === 'Failed to fetch' ? 'network error' : e.message); return; }
      finally { btn.disabled = false; btn.textContent = 'Start monitoring'; }
    } else ensureQuote(sym, SEEDS[sym] || +(20 + Math.random() * 280).toFixed(2));
  }
  const p = S.quotes[sym].p;
  if (mode === 'buy' && qty * p > S.cash) {
    if (!S.bots.some(b => b.sym === sym)) delete S.quotes[sym];
    err.textContent = `Not enough cash: ${qty} × ${px(p)} = ${money(qty * p)} > ${money(S.cash)}.`; return;
  }
  lastSym = '';
  const b = newBot(sym, qty, pid, sizing, mode);
  if (mode === 'dip' || mode === 'top') toast(`${sym}: watching for a ${prof(b).swing}% ${mode === 'dip' ? 'rebound off the low' : 'drop off the high'}`);
  go('portfolio');
}
function runDemo() {
  if (S.settings.source !== 'sim') { toast('Switch Settings → Price source to Simulated to run the demo'); return; }
  if (S.quotes.DEMO) { toast('Demo is already running'); return; }
  const q = ensureQuote('DEMO', 100);
  q.demo = true; q.script = DEMO_PATH.slice();
  if (100 * 100 > S.cash) { delete S.quotes.DEMO; toast('Not enough cash for the demo'); return; }
  newBot('DEMO', 100, S.profiles[0].id, 'fixed', 'buy');
  toast('Demo: watch DEMO swing through every rule. Raise speed in Settings to go faster.');
}

/* ---------- detail sheet ---------- */
function openSheet(id) {
  const b = bot(id); if (!b) return;
  detailId = id;
  $('#sheetPanel').innerHTML = `<div class="sh-head"><div><b class="sym">${esc(b.sym)}</b> <span class="badge" data-s="badge"></span><div class="small muted" data-s="sub"></div></div><div class="r"><div class="price" data-s="price"></div><div class="chg" data-s="chg"></div></div><button class="x" data-close aria-label="Close">×</button></div>
    <canvas class="chart" data-s="chart"></canvas>
    <div class="state"><div data-s="pos"></div><div class="small muted" data-s="next" style="margin-top:4px"></div></div>
    <div class="kv" data-s="stats"></div>
    <div class="simctl ${S.settings.source === 'sim' ? '' : 'hidden'}"><div class="lbl">Test the rules: move the simulated price</div>
      <div class="nudges">${[-10, -5, -1, 1, 5, 10].map(v => `<button data-act="nudge" data-v="${v}" class="${v < 0 ? 'dn' : 'up'}">${v > 0 ? '+' : '−'}${Math.abs(v)}%</button>`).join('')}</div>
      <div class="inl"><input id="setPx" type="number" step="0.01" inputmode="decimal" placeholder="Set price"><button class="btn" data-act="setpx">Set</button></div></div>
    <label>Profile<select id="shProf">${S.profiles.map(p => `<option value="${p.id}" ${p.id === b.profileId ? 'selected' : ''}>${esc(p.name)} (+${p.longTP}% / −${p.longSL}%, swing ${p.swing}%)</option>`).join('')}</select></label>
    <div class="acts"><button class="btn" data-act="pause"></button><button class="btn" data-act="closepos">Close position now</button><button class="btn" data-act="buynow">Buy now</button><button class="btn" data-act="shortnow">Short now</button><button class="btn danger" data-act="remove" data-confirm="Tap again to remove">Remove</button></div>
    <h3 class="sec">Trades for this stock</h3><div class="list card" data-s="trades"></div>`;
  $('#sheet').classList.remove('hidden');
  document.body.classList.add('noscroll');
  structDirty = dirty = true;
}
function closeSheet() { detailId = null; $('#sheet').classList.add('hidden'); document.body.classList.remove('noscroll'); }
function updateSheet(struct) {
  const b = bot(detailId); if (!b) { closeSheet(); return; }
  const q = S.quotes[b.sym]; if (!q) return;
  const P = $('#sheetPanel'), f = k => $(`[data-s="${k}"]`, P), [bl, bc] = badge(b), d = describe(b), ch = (q.p - q.ref) / q.ref * 100;
  f('badge').textContent = bl; f('badge').className = 'badge ' + bc;
  f('sub').textContent = `${prof(b).name} · ${b.sizing === 'compound' ? 'reinvest P/L' : b.baseQty + ' shares'}`;
  f('price').textContent = px(q.p);
  f('chg').textContent = pct(ch) + (S.settings.source === 'live' && !q.demo ? ' today' : ''); f('chg').className = 'chg ' + cls(ch);
  f('pos').innerHTML = d.pos; f('next').textContent = d.next;
  const mine = S.trades.filter(t => t.bot === b.id), st = stats(mine), u = unreal(b, q.p);
  f('stats').innerHTML = `<div><span>Realized</span><b class="${cls(st.realized)}">${sMoney(st.realized)}</b></div><div><span>Unrealized</span><b class="${cls(u)}">${sMoney(u)}</b></div><div><span>Round trips</span><b>${b.cycles}</b></div><div><span>Wins / losses</span><b>${st.wins} / ${st.losses}</b></div>`;
  drawChart(f('chart'), q, b, true);
  const inPos = b.phase === 'LONG' || b.phase === 'SHORT';
  $('[data-act="pause"]', P).textContent = b.paused ? 'Resume' : 'Pause';
  $('[data-act="closepos"]', P).classList.toggle('hidden', !inPos);
  $('[data-act="buynow"]', P).classList.toggle('hidden', inPos);
  $('[data-act="shortnow"]', P).classList.toggle('hidden', inPos);
  if (struct) f('trades').innerHTML = mine.length ? mine.slice().reverse().map(t => tradeRow(t, true)).join('') : '<div class="empty small">No trades yet.</div>';
}

/* ---------- log view ---------- */
let logSym = '';
function csv(list) {
  const q = s => /[",\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s;
  return 'time,symbol,action,qty,price,reason,pl,pl_pct\n' + list.map(t => [new Date(t.t).toISOString(), t.sym, t.action, t.qty, t.price, q(t.reason), t.pl ?? '', t.plPct ?? ''].join(',')).join('\n');
}
function renderLog() {
  const syms = [...new Set(S.trades.map(t => t.sym))].sort();
  $('#v-log').innerHTML = `<div class="card"><h2>Trade log</h2><div class="toolbar">
    <label>Symbol<select id="logSym"><option value="">All symbols</option>${syms.map(s => `<option ${s === logSym ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
    <a class="btn" id="csvLink" download="swingtrader-log.csv" href="#">Download CSV</a><button class="btn" data-act="copycsv">Copy CSV</button><button class="btn danger" data-act="clearlog" data-confirm="Tap again to clear">Clear</button></div>
    <div class="kv" id="logStats"></div><textarea id="csvBox" class="hidden" readonly></textarea></div>
    <div class="card list" id="logTable"></div>`;
  updateLog();
}
function updateLog() {
  const t = $('#logTable'); if (!t) return;
  const list = S.trades.filter(x => !logSym || x.sym === logSym), st = stats(list);
  $('#logStats').innerHTML = `<div><span>Trades</span><b>${list.length}</b></div><div><span>Realized P/L</span><b class="${cls(st.realized)}">${sMoney(st.realized)}</b></div><div><span>Profitable exits</span><b class="pos">${st.wins}</b></div><div><span>Loss exits</span><b class="neg">${st.losses}</b></div>`;
  t.innerHTML = list.length ? list.slice().reverse().slice(0, 500).map(x => tradeRow(x, true)).join('') : '<div class="empty small">No trades logged yet.</div>';
  $('#csvLink').href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv(list));
}

/* ---------- profiles view ---------- */
const PF = [
  ['longTP', 'Gain % — sell long for profit'], ['longSL', 'Loss % — sell long for loss'],
  ['shortTP', 'Gain % — cover short for profit'], ['shortSL', 'Risk % — cover short for loss'],
];
function explain(p) {
  const e = 100, tp = e * (1 + p.longTP / 100), hi = tp * 1.05, sh = hi * (1 - p.swing / 100), cv = sh * (1 - p.shortTP / 100);
  const lossAfter = {swing:`a long stop-loss tracks the low and buys on a ${p.swing}% rebound; a short stop-loss tracks the high and shorts on a ${p.swing}% drop (mirror image)`,
    reverse:'immediately take the opposite side (long stop → short, short stop → long)', stop:'stop trading the stock'}[p.afterLoss];
  return `<b>Example, buy at $100.00:</b><ol>
    <li>Up ${p.longTP}% → <b>sell for profit</b> at $${px(tp)}; down ${p.longSL}% → <b>sell for loss</b> at $${px(e * (1 - p.longSL / 100))}.</li>
    ${p.afterProfit === 'swing' ? `<li>After the profit sale, track the high (say it peaks at $${px(hi)}). A ${p.swing}% drop off the high → <b>sell short</b> at $${px(sh)}.</li>
    <li>Short: drops another ${p.shortTP}% → <b>buy to cover for profit</b> at $${px(cv)}; rises ${p.shortSL}% → <b>buy to cover for loss</b> at $${px(sh * (1 + p.shortSL / 100))}.</li>
    <li>After the short profit, track the low. A ${p.swing}% rise off the low → <b>buy</b> again, and the cycle repeats.</li>` : '<li>After a profit: stop trading the stock.</li>'}
    <li>After a loss: ${lossAfter}.</li>${p.maxCycles > 0 ? `<li>Stop after ${p.maxCycles} round trips.</li>` : ''}</ol>`;
}
function renderProfiles() {
  $('#v-profiles').innerHTML = `<div class="card"><h2>Trading profiles</h2><p class="muted small" style="margin:0">Each monitored stock follows one profile. Changes apply right away, including to open positions. Rules are symmetric: a short position works like a long one, mirrored.</p></div>` +
    S.profiles.map(p => {
      const used = S.bots.filter(b => b.profileId === p.id).length;
      return `<div class="card" data-pf="${p.id}"><label>Profile name<input data-k="name" value="${esc(p.name)}"></label>
      <h4>Long position</h4><div class="grid2">${PF.slice(0, 2).map(([k, l]) => `<label>${l}<input type="number" min="0.1" max="${k === 'longSL' ? 99 : 1000}" step="0.1" inputmode="decimal" data-k="${k}" value="${p[k]}"></label>`).join('')}</div>
      <h4>Swing reversal</h4><label>Reversal % off the high/low that triggers the next entry<input type="number" min="0.1" max="99" step="0.1" inputmode="decimal" data-k="swing" value="${p.swing}"></label>
      <h4>Short position</h4><div class="grid2">${PF.slice(2).map(([k, l]) => `<label>${l}<input type="number" min="0.1" max="${k === 'shortTP' ? 99 : 1000}" step="0.1" inputmode="decimal" data-k="${k}" value="${p[k]}"></label>`).join('')}</div>
      <h4>After an exit</h4><div class="grid2"><label>After a profit<select data-k="afterProfit"><option value="swing">Watch swing → reverse</option><option value="stop">Stop trading</option></select></label>
      <label>After a loss<select data-k="afterLoss"><option value="swing">Watch swing (mirror)</option><option value="reverse">Reverse immediately</option><option value="stop">Stop trading</option></select></label></div>
      <label>Max round trips (0 = unlimited)<input type="number" min="0" step="1" inputmode="numeric" data-k="maxCycles" value="${p.maxCycles}"></label>
      <div class="rules" data-rules>${explain(p)}</div>
      <div class="acts"><span class="small muted" style="flex:1;align-self:center">Used by ${used} stock${used === 1 ? '' : 's'}</span><button class="btn" data-act="dupprof" data-id="${p.id}">Duplicate</button>${S.profiles.length > 1 ? `<button class="btn danger" data-act="delprof" data-id="${p.id}" data-confirm="Tap again to delete">Delete</button>` : ''}</div></div>`;
    }).join('') + `<button class="btn primary big" data-act="addprof">+ New profile</button>`;
  for (const p of S.profiles) {
    const c = $(`[data-pf="${p.id}"]`);
    $('[data-k="afterProfit"]', c).value = p.afterProfit;
    $('[data-k="afterLoss"]', c).value = p.afterLoss;
  }
}
function onProfileInput(e) {
  const card = e.target.closest('[data-pf]'), k = e.target.dataset.k; if (!card || !k) return;
  const p = S.profiles.find(x => x.id === card.dataset.pf); if (!p) return;
  if (k === 'name' || k === 'afterProfit' || k === 'afterLoss') p[k] = e.target.value || p[k];
  else {
    let v = +e.target.value;
    if (!isFinite(v) || e.target.value === '') return;
    if (k === 'maxCycles') v = Math.max(0, Math.floor(v));
    else v = Math.min(['longSL', 'shortTP', 'swing'].includes(k) ? 99 : 1000, Math.max(0.1, v));
    p[k] = v;
  }
  $('[data-rules]', card).innerHTML = explain(p);
  save(true); dirty = true;
}

/* ---------- settings view ---------- */
function renderSettings() {
  const s = S.settings;
  $('#v-settings').innerHTML = `<div class="card"><h2>Price source</h2>
    <div class="seg"><label class="${s.source === 'sim' ? 'on' : ''}"><input type="radio" name="src" value="sim" ${s.source === 'sim' ? 'checked' : ''}> Simulated market</label><label class="${s.source === 'live' ? 'on' : ''}"><input type="radio" name="src" value="live" ${s.source === 'live' ? 'checked' : ''}> Live quotes (Finnhub)</label></div>
    <div class="${s.source === 'sim' ? '' : 'hidden'}"><div class="grid2"><label>Speed<select data-set="speed">${[1, 2, 5, 10, 20].map(v => `<option value="${v}" ${+s.speed === v ? 'selected' : ''}>${v} tick${v > 1 ? 's' : ''}/sec</option>`).join('')}</select></label>
      <label>Volatility<select data-set="vol">${[[0.5, 'Calm'], [1, 'Normal'], [2, 'Wild']].map(([v, l]) => `<option value="${v}" ${+s.vol === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <p class="small muted" style="margin:0">Random-walk prices with trending regimes, so swings happen in minutes. Starting prices are approximate.</p></div>
    <div class="${s.source === 'live' ? '' : 'hidden'}"><label>Finnhub API key<input type="password" data-set="apiKey" value="${esc(s.apiKey)}" autocomplete="off" spellcheck="false" placeholder="paste your key"></label>
      <div class="grid2"><label>Poll every (seconds)<input type="number" min="5" step="1" data-set="pollSec" value="${s.pollSec}"></label><div style="align-self:end;margin-bottom:10px"><button class="btn" data-act="testkey" style="width:100%">Test key</button></div></div>
      <div class="small" id="keyMsg"></div>
      <p class="small muted" style="margin:6px 0 0">Get a free key at <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io</a> (60 calls/min: keep stocks × 60 ÷ poll seconds under 60). Prices only move during market hours. The key is stored only on this device. Monitoring runs while the app is open; phones pause background tabs.</p></div></div>
    <div class="card"><h2>Account</h2><div class="grid2"><label>Starting cash<input type="number" min="100" step="100" data-set="startCash" value="${s.startCash}"></label><label>Commission per trade ($)<input type="number" min="0" step="0.01" data-set="commission" value="${s.commission}"></label></div>
      <p class="small muted" style="margin:0 0 10px">Starting cash applies when you reset. Current cash: ${money(S.cash)}.</p>
      <button class="btn danger" data-act="reset" data-confirm="Tap again: clears stocks + log">Reset account</button></div>
    <div class="card"><h2>Alerts</h2><label class="chk"><input type="checkbox" data-set="sound" ${s.sound ? 'checked' : ''}> Sound on each trade</label><label class="chk"><input type="checkbox" data-set="notify" ${s.notify ? 'checked' : ''}> System notifications</label><div class="small muted" id="notifMsg"></div></div>
    <div class="card"><h2>Install as an app</h2><p class="small" style="margin:0">iPhone: open this page in <b>Safari</b> → Share → <b>Add to Home Screen</b>. Android/Chrome: menu → <b>Install app</b>. It works offline in simulated mode.</p></div>
    <p class="small muted" style="text-align:center">SwingTrader v${VERSION} · paper trading only, no real orders · data stays on this device</p>`;
}
async function onSetting(e) {
  const el = e.target, s = S.settings;
  if (el.name === 'src') {
    if (el.value === s.source) return;
    s.source = el.value;
    let paused = 0;
    for (const b of S.bots) if (!b.paused && b.phase !== 'STOPPED' && b.sym !== 'DEMO') { b.paused = true; paused++; }
    if (paused) toast(`Switched source: ${paused} stock${paused > 1 ? 's' : ''} paused so new prices don't trigger trades unexpectedly. Resume from each stock.`);
    if (s.source === 'live') for (const sym in S.quotes) if (!S.quotes[sym].demo) S.quotes[sym].hist = S.quotes[sym].hist.slice(-1);
    save(true); restartLoops(); renderSettings(); structDirty = true; return;
  }
  const k = el.dataset.set; if (!k) return;
  if (el.type === 'checkbox') s[k] = el.checked;
  else if (k === 'apiKey') s[k] = el.value.trim();
  else { const v = +el.value; if (!isFinite(v) || el.value === '') return; s[k] = v; }
  if (k === 'notify' && s.notify) {
    const m = $('#notifMsg');
    if (!('Notification' in window)) { m.textContent = 'Notifications are not supported here (on iPhone, install to Home Screen first).'; }
    else { try { const r = await Notification.requestPermission(); m.textContent = r === 'granted' ? 'Notifications enabled.' : 'Permission ' + r + ' — enable it in browser settings.'; } catch (x) { m.textContent = 'Notification permission blocked in this view.'; } }
  }
  if (k === 'speed' || k === 'pollSec' || k === 'apiKey') restartLoops();
  if (k === 'vol') for (const q of Object.values(S.quotes)) q.sim = null;
  save(true); dirty = true;
}

/* ---------- actions ---------- */
function armed(btn) {
  if (btn.dataset.armed === '1') return true;
  const o = btn.textContent;
  btn.dataset.armed = '1'; btn.textContent = btn.dataset.confirm || 'Tap again'; btn.classList.add('warn');
  setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = o; btn.classList.remove('warn'); } }, 3000);
  return false;
}
function removeBot(b) {
  manualClose(b, 'Removed — closed at market');
  S.bots = S.bots.filter(x => x !== b);
  if (!S.bots.some(x => x.sym === b.sym)) delete S.quotes[b.sym];
  save(true); structDirty = true;
}
const ACTIONS = {
  run() { S.settings.running = !S.settings.running; save(true); if (S.settings.running && S.settings.source === 'live') restartLoops(); dirty = true; },
  demo: runDemo,
  create: btn => createFromForm(btn),
  nudge(btn) { const b = bot(detailId); if (!b) return; const q = S.quotes[b.sym]; pushPrice(b.sym, q.p * (1 + +btn.dataset.v / 100), Date.now()); },
  setpx() { const b = bot(detailId), v = +$('#setPx').value; if (!b || !(v > 0)) return; pushPrice(b.sym, v, Date.now()); $('#setPx').value = ''; },
  pause() { const b = bot(detailId); if (!b) return; b.paused = !b.paused; if (!b.paused && b.phase.startsWith('WATCH')) b.extreme = S.quotes[b.sym].p; save(true); structDirty = true; },
  closepos() { const b = bot(detailId); if (!b) return; manualClose(b, 'Manual close'); b.phase = 'STOPPED'; save(true); structDirty = true; },
  buynow() { const b = bot(detailId); if (!b) return; b.paused = false; openPos(b, 'LONG', S.quotes[b.sym].p, Date.now(), 'Manual buy'); structDirty = true; },
  shortnow() { const b = bot(detailId); if (!b) return; b.paused = false; openPos(b, 'SHORT', S.quotes[b.sym].p, Date.now(), 'Manual short'); structDirty = true; },
  remove(btn) { if (!armed(btn)) return; const b = bot(detailId); closeSheet(); if (b) removeBot(b); },
  copycsv() {
    const text = csv(S.trades.filter(x => !logSym || x.sym === logSym)), box = $('#csvBox');
    box.value = text; box.classList.remove('hidden');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('CSV copied'), () => { box.select(); toast('Select the text below and copy'); });
  },
  clearlog(btn) { if (!armed(btn)) return; S.trades = []; save(true); renderLog(); structDirty = true; },
  reset(btn) {
    if (!armed(btn)) return;
    Object.assign(S, {bots:[], trades:[], quotes:{}, cash:S.settings.startCash, startCash:S.settings.startCash});
    save(true); closeSheet(); restartLoops(); renderSettings(); structDirty = true; toast('Account reset');
  },
  addprof() { S.profiles.push(Object.assign(defProfile(), {id:'p' + uid(), name:'Profile ' + (S.profiles.length + 1)})); save(true); renderProfiles(); },
  dupprof(btn) { const p = S.profiles.find(x => x.id === btn.dataset.id); if (!p) return; S.profiles.push(Object.assign({}, p, {id:'p' + uid(), name:p.name + ' copy'})); save(true); renderProfiles(); },
  delprof(btn) {
    const id = btn.dataset.id;
    if (S.bots.some(b => b.profileId === id)) { toast('Profile is in use — move those stocks to another profile first'); return; }
    if (!armed(btn)) return;
    S.profiles = S.profiles.filter(p => p.id !== id); save(true); renderProfiles();
  },
  async testkey(btn) {
    const m = $('#keyMsg'); btn.disabled = true; m.textContent = 'Testing…';
    try { const j = await fetchQuote('AAPL'); m.innerHTML = `<span class="pos">Key works — AAPL ${px(j.c)}</span>`; }
    catch (e) { m.innerHTML = `<span class="neg">${esc(e.message === 'Failed to fetch' ? 'Network error (blocked or offline)' : e.message)}</span>`; }
    btn.disabled = false;
  },
};

/* ---------- render loop ---------- */
function go(v) {
  view = v;
  $$('.view').forEach(e => e.classList.toggle('on', e.id === 'v-' + v));
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.go === v));
  if (v === 'new') renderNew();
  if (v === 'log') renderLog();
  if (v === 'profiles') renderProfiles();
  if (v === 'settings') renderSettings();
  structDirty = dirty = true;
  window.scrollTo(0, 0);
}
function updateHeader() {
  const s = S.settings, dot = $('#mktDot');
  let txt;
  if (s.source === 'sim') txt = `SIM · ${s.speed}/s`;
  else txt = RT.err ? 'LIVE · ' + RT.err : RT.last ? 'LIVE · ' + tstr(RT.last) : 'LIVE · connecting…';
  $('#mktTxt').textContent = txt; $('#mktTxt').title = txt;
  dot.className = 'dot ' + (RT.err && s.source === 'live' ? 'err' : s.running ? 'on' : '');
  $('#runBtn').textContent = s.running ? 'Pause' : 'Run';
}
let lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (ts - lastFrame < 200 || (!dirty && !structDirty)) return;
  lastFrame = ts;
  const st = structDirty;
  dirty = structDirty = false;
  updateHeader();
  if (view === 'portfolio') { if (st) renderPortfolioStruct(); updatePortfolio(); }
  if (view === 'log' && st) updateLog();
  if (view === 'new') updateNew();
  if (detailId != null) updateSheet(st);
}

function init() {
  load();
  if (!S.startCash) S.startCash = S.settings.startCash;
  $('#ver').textContent = 'v' + VERSION;
  document.addEventListener('click', e => {
    const g = e.target.closest('[data-go]'); if (g) { closeSheet(); go(g.dataset.go); return; }
    const a = e.target.closest('[data-act]'); if (a && ACTIONS[a.dataset.act]) { ACTIONS[a.dataset.act](a); dirty = true; return; }
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    const o = e.target.closest('[data-open]'); if (o) openSheet(+o.dataset.open);
  });
  $('#v-profiles').addEventListener('input', onProfileInput);
  $('#v-profiles').addEventListener('change', onProfileInput);
  $('#v-settings').addEventListener('change', onSetting);
  $('#v-new').addEventListener('input', () => { const s = $('#nSym'); if (s) lastSym = s.value; updateNew(); });
  $('#v-log').addEventListener('change', e => { if (e.target.id === 'logSym') { logSym = e.target.value; updateLog(); } });
  $('#sheetPanel').addEventListener('change', e => { if (e.target.id === 'shProf') { const b = bot(detailId); if (b) { b.profileId = e.target.value; save(true); structDirty = true; } } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
  window.addEventListener('resize', () => { dirty = true; });
  window.addEventListener('pagehide', () => save(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
  restartLoops();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
