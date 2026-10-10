// Records how the human player plays a match, so the bots can be tuned to that style.
// Reads game state through window.__arena only (never changes the game). At match end the
// recording is saved to the artifact's database collection "matches" (one document per match).
(() => {
'use strict';
const A = window.__arena; if (!A) return;
let PLAYER_TEAM = 2; const SAMPLE_DT = 0.5; // the player's team: 2, or 1 for a multiplayer guest
const r2 = v => Math.round(v * 100) / 100;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
let rec = null, lastGame = null, lastT = -1, db = null, started = false;
if (window.claude && window.claude.use) window.claude.use('db').then(d => { db = d; if (db) loadUsage(); }, () => {});

// Storage limit (Rickard 2026-10-08: old matches are already analysed and need not be kept forever). Matches are kept until
// they add up to LIMIT_BYTES, then the oldest are deleted. Each match's size sits in one index document (meta/matchIndex),
// so pruning and the menu meter never load the matches themselves.
const LIMIT_BYTES = 50 * 1024 * 1024;
// Rickard wants to judge whether 50 MB is the right size, so nearing it is announced everywhere: menu banner, after each save, at match start
const WARN_AT = [0.99, 0.9, 0.75];
let usage = null; // { count, bytes } from the index
const warnLevel = bytes => WARN_AT.find(f => bytes >= f * LIMIT_BYTES) || 0;
const mb = v => (v / 1048576).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
function warnText() {
  if (!usage || !warnLevel(usage.bytes)) return '';
  return `⚠ Match data is ${mb(usage.bytes)} MB of ${mb(LIMIT_BYTES)} MB (${Math.floor(usage.bytes / LIMIT_BYTES * 100)}%, ${usage.count} matches). At the limit the oldest matches are deleted automatically.`;
}
const indexRef = () => db.collection('meta').doc('matchIndex');
async function readIndex() {
  const s = await indexRef().get();
  if (s.exists && Array.isArray(s.data().entries)) return s.data().entries.slice();
  // first run: index the matches saved before the limit existed (one full read, only once)
  const all = await db.collection('matches').limit(1000).get();
  return all.docs.map(d => { const x = d.data(); return { id: d.id, at: x.endedAt || x.startedAt || '', bytes: JSON.stringify(x).length }; });
}
// adds the new match to the index (id null: just build/check it), deletes the oldest matches while over the limit
async function indexAndPrune(id, at, bytes) {
  const entries = await readIndex();
  if (id && !entries.some(e => e.id === id)) entries.push({ id, at, bytes });
  entries.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  let total = entries.reduce((n, e) => n + e.bytes, 0), removed = 0;
  while (total > LIMIT_BYTES && entries.length > 1) {
    const e = entries.shift(); total -= e.bytes; removed++;
    await db.collection('matches').doc(e.id).delete();
  }
  await indexRef().set({ limitBytes: LIMIT_BYTES, totalBytes: total, entries });
  showUsage(entries.length, total);
  return removed;
}
async function loadUsage() {
  try {
    const s = await indexRef().get();
    if (s.exists && Array.isArray(s.data().entries)) { const d = s.data(); showUsage(d.entries.length, d.totalBytes || 0); }
    else await indexAndPrune(null);
  } catch (e) { /* the meter is optional */ }
}
function showUsage(count, bytes) {
  usage = { count, bytes };
  const menu = document.getElementById('menu'); if (!menu) return;
  let el = document.getElementById('dbUsage');
  if (!el) { el = document.createElement('div'); el.id = 'dbUsage'; el.className = 'note'; menu.appendChild(el); }
  el.textContent = `Saved match data: ${count} ${count === 1 ? 'match' : 'matches'}, ${mb(bytes)} MB of ${mb(LIMIT_BYTES)} MB. The oldest are deleted automatically at the limit.`;
  // banner at the top of the menu from 75 %, gold, red from 90 %
  let w = document.getElementById('dbWarn'); const lvl = warnLevel(bytes);
  if (!lvl) { if (w) w.remove(); return; }
  if (!w) { w = document.createElement('div'); w.id = 'dbWarn'; const sub = menu.querySelector('.sub'); menu.insertBefore(w, sub ? sub.nextSibling : menu.firstChild); }
  const red = lvl >= 0.9;
  w.style.cssText = `margin:0 0 12px;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.35;font-weight:bold;background:${red ? '#4a1420' : '#3d2c08'};color:${red ? '#ffb3bd' : '#ffd88a'};border:2px solid ${red ? 'var(--red)' : 'var(--gold)'}`;
  w.textContent = warnText();
}

// sample columns, kept in the saved document so the data explains itself
const COLS = ['t', 'x', 'y', 'hp', 'alive', 'level', 'progress', 'dHero', 'dTower', 'towerOnMe', 'tankMinions',
  'enemyHeroes5', 'allyHeroes5', 'allyMinions4', 'enemyMinions4', 'inCombat', 'fwdSpeed', 'specialReady', 'starsDiff'];

function snapshot(g, p) {
  const et = g.units.find(u => u.kind === 'tower' && u.team !== PLAYER_TEAM), ot = g.units.find(u => u.kind === 'tower' && u.team === PLAYER_TEAM);
  const foes = g.units.filter(u => u.alive && u.team !== PLAYER_TEAM && !u.isIllusion);
  const heroesE = foes.filter(u => u.kind === 'hero'), allies = g.units.filter(u => u.alive && u.team === PLAYER_TEAM && u !== p && !u.isIllusion);
  const near = (list, r) => list.filter(u => dist(u, p) <= r).length;
  const dHero = heroesE.length ? Math.min(...heroesE.map(u => dist(u, p))) : 99;
  const span = et && ot ? et.y - ot.y : 1;
  const tank = et && et.alive ? allies.filter(u => u.kind === 'minion' && dist(u, et) < et.def.range).length : 0;
  return { et, heroesE, allies, near, dHero, span, tank };
}

// the other five heroes once a second, so the bots' choices around the player can be read back (what each bot was doing: its AI mode)
const OTHER_COLS = ['code', 'team', 'x', 'y', 'hp', 'alive', 'mode'];
function sampleOthers(g, p) {
  rec.others.push(r2(g.time) + ';' + g.units.filter(u => u.kind === 'hero' && u !== p && !u.isIllusion)
    .map(u => [u.code, u.team, Math.round(u.x * 10) / 10, Math.round(u.y * 10) / 10, r2(u.hp / u.maxHp), u.alive ? 1 : 0, u.ai && u.ai.mode || ''].join(',')).join('|'));
}
function sample(g, p) {
  const s = snapshot(g, p), et = s.et, ot = g.units.find(u => u.kind === 'tower' && u.team === PLAYER_TEAM);
  const vy = rec.prevY == null ? 0 : (p.y - rec.prevY) / SAMPLE_DT; rec.prevY = p.y;
  rec.samples.push([r2(g.time), r2(p.x), r2(p.y), r2(p.hp / p.maxHp), p.alive ? 1 : 0, p.level,
    ot ? r2((p.y - ot.y) / s.span) : 0, r2(s.dHero), et && et.alive ? r2(dist(p, et)) : 99, et && et.target === p ? 1 : 0, s.tank,
    s.near(s.heroesE, 5), s.near(s.allies.filter(u => u.kind === 'hero'), 5), s.near(s.allies.filter(u => u.kind === 'minion'), 4),
    s.near(g.units.filter(u => u.alive && u.kind === 'minion' && u.team !== PLAYER_TEAM), 4), p.inCombat(g.time) ? 1 : 0, r2(vy),
    p.specialReady ? 1 : 0, (g.stars ? (g.stars[PLAYER_TEAM] || 0) - (g.stars[3 - PLAYER_TEAM] || 0) : 0)]);
}

function event(g, p, type, extra) {
  const s = snapshot(g, p);
  rec.events.push(Object.assign({ t: r2(g.time), type, hp: r2(p.hp / p.maxHp), dHero: r2(s.dHero), enemyHeroes5: s.near(s.heroesE, 5),
    allyHeroes5: s.near(s.allies.filter(u => u.kind === 'hero'), 5), dTower: s.et && s.et.alive ? r2(dist(p, s.et)) : 99, towerOnMe: s.et && s.et.target === p ? 1 : 0 }, extra || {}));
}

function start(g) {
  const p = g.player, tier = document.getElementById('tier'); PLAYER_TEAM = p.team;
  if (warnText()) toast(warnText(), 6000); // also seen by someone who starts straight from a double-click
  rec = { hero: p.code, map: g.map.name, tier: tier ? tier.value : '', startedAt: new Date().toISOString(), cols: COLS, samples: [], events: [], others: [], lastOther: -1,
    prevY: null, prev: { alive: true, kills: 0, special: false, items: {} }, saved: false };
  const l = g.net; // multiplayer: who against whom, and how the connection was
  if (l) { const foe = g.units.find(u => u.kind === 'hero' && !u.isIllusion && u.team !== p.team);
    rec.tier = 'multiplayer'; rec.net = { role: l.role, code: l.code, match: l.role === 'host' ? l.matchN : l.matchM && l.matchM(), you: l.myName || '', opponent: foe ? foe.name : '', opponentHero: foe ? foe.code : '' };
    rec.link = l; rec.rtt = []; }
}

async function save(g) {
  if (!rec || rec.saved) return; rec.saved = true;
  const p = g.player;
  const doc = { hero: rec.hero, map: rec.map, tier: rec.tier, startedAt: rec.startedAt, endedAt: new Date().toISOString(),
    duration: r2(Math.max(0, g.time)), result: g.state === 'over' ? (g.winner === PLAYER_TEAM ? 'win' : 'loss') : 'quit',
    kills: p.kills, deaths: p.deaths, teamKills: g.kills ? g.kills[PLAYER_TEAM] : 0, enemyKills: g.kills ? g.kills[3 - PLAYER_TEAM] : 0,
    items: (p.items || []).map(i => i.key), sampleEvery: SAMPLE_DT, cols: rec.cols, samples: rec.samples.map(r => r.join(',')), events: rec.events,
    othersEvery: 1, othersCols: OTHER_COLS, others: rec.others, mode: rec.net ? 'multiplayer' : 'bots' };
  if (rec.net) { const rt = rec.rtt; doc.net = Object.assign({}, rec.net, { connection: rec.link.mode === 'webrtc' ? 'p2p' : 'room',
    rttAvg: rt.length ? Math.round(rt.reduce((a, b) => a + b, 0) / rt.length) : null, rttMax: rt.length ? Math.round(Math.max(...rt)) : null,
    disconnected: !!(rec.link.gone || rec.link.closed) && doc.result !== 'win' && doc.result !== 'loss' }); }
  if (doc.duration < 20) return; // menu clicks and instant quits teach nothing
  if (!db) { saveLocal(doc); return; } // outside claude.ai (e.g. GitHub Pages): kept on this device, downloadable from the menu
  let ref;
  try { ref = await db.collection('matches').add(doc); toast('Match saved for bot training'); }
  catch (e) { toast('The match could not be saved: ' + (e && (e.code || e.message) || 'unknown error')); return; }
  try { const n = await indexAndPrune(ref.id, doc.endedAt, JSON.stringify(doc).length); const later = [];
    if (n) later.push(`${n} old ${n === 1 ? 'match was' : 'matches were'} deleted (limit ${LIMIT_BYTES / 1048576} MB)`);
    if (warnText()) later.push(warnText());
    later.forEach((t, i) => setTimeout(() => toast(t, 6000), 4200 + 6200 * i)); }
  catch (e) { /* the match is saved; pruning retries after the next match */ }
}

// no database outside claude.ai: matches go to this device's storage (oldest dropped past ~3 MB) and the menu offers them as a file
const LOCAL_KEY = 'abc2-matches', LOCAL_MAX = 3 * 1024 * 1024;
function readLocal() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { return []; } }
function saveLocal(doc) {
  const list = readLocal(); list.push(doc);
  while (list.length > 1 && JSON.stringify(list).length > LOCAL_MAX) list.shift();
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); toast(`Match saved on this device (${list.length} in total). Download them from the menu.`, 5000); }
  catch (e) { toast('The match could not be saved on this device'); }
  showLocal();
}
function showLocal() {
  if (db) return; const menu = document.getElementById('menu'); if (!menu) return;
  const n = readLocal().length; let b = document.getElementById('dlMatches');
  if (!n) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('button'); b.id = 'dlMatches'; b.style.cssText = 'width:100%;padding:10px;border:2px solid #39407a;border-radius:14px;background:var(--panel);color:var(--text);font-size:15px;font-weight:bold;cursor:pointer;margin-top:8px';
    const mp = document.getElementById('mp'); menu.insertBefore(b, mp ? mp.nextSibling : null);
    b.onclick = () => { const data = JSON.stringify({ exportedAt: new Date().toISOString(), matches: readLocal() });
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      a.download = 'abc2-matches-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json'; document.body.appendChild(a); a.click(); a.remove(); }; }
  b.textContent = `DOWNLOAD MATCH DATA (${n})`;
}
setTimeout(showLocal, 1500); // after net.js has added its box, and once it is known whether a database is reachable

function toast(text, ms) {
  const host = document.getElementById('frame') || document.body, el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'position:absolute;left:50%;top:14%;transform:translateX(-50%);z-index:9;background:rgba(13,16,32,.9);color:#f4f1ff;padding:8px 12px;border-radius:10px;font:13px "Trebuchet MS",system-ui,sans-serif;pointer-events:none;max-width:85%;text-align:center';
  host.appendChild(el); setTimeout(() => el.remove(), ms || 4000);
}

function tick() {
  requestAnimationFrame(tick);
  const g = A.game;
  if (g !== lastGame) { if (lastGame && rec) save(lastGame); lastGame = g; rec = null; lastT = -1; started = false; }
  if (g && !started && !g.tut && g.player && !g.player._placeholder) { started = true; start(g); } // a multiplayer guest's hero appears with the host's first state
  if (!g || !rec || g.state === 'countdown') return;
  const p = g.player;
  if (g.state === 'over') { save(g); return; }
  // events, checked every frame
  const pv = rec.prev;
  if (pv.alive && !p.alive) event(g, p, 'death');
  if (!pv.alive && p.alive) event(g, p, 'respawn');
  if (p.kills > pv.kills) event(g, p, 'kill');
  const sp = !!(p.specialActive || p.has('casting') || p.statuses.some(s => s.equinox)); // Momiji's Equinox is only a shield status
  if (sp && !pv.special) event(g, p, 'special', { stocks: p.stocks || 0 });
  for (const it of p.items || []) { const was = pv.items[it.key];
    if (was === undefined) event(g, p, 'itemEquip', { item: it.key });
    else if (it.cd > was + 0.5) event(g, p, 'itemUse', { item: it.key });
    pv.items[it.key] = it.cd; }
  pv.alive = p.alive; pv.kills = p.kills; pv.special = sp;
  if (g.time - lastT >= SAMPLE_DT) { lastT = g.time; sample(g, p); if (rec.link && rec.link.open && rec.link.rtt) rec.rtt.push(rec.link.rtt); }
  if (g.time - rec.lastOther >= 1) { rec.lastOther = g.time; sampleOthers(g, p); }
}
requestAnimationFrame(tick);
window.addEventListener('pagehide', () => { if (lastGame && rec) save(lastGame); });
})();
