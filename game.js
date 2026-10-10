// Arena Battle prototype. All gameplay numbers come from window.GAMEDATA,
// the game's base data.
(() => {
'use strict';
const GD = window.GAMEDATA;
const HEROES = GD.heroes, UNITS = GD.units, MATCH = GD.match;
// Balance changes on top of the base values (Rickard, 2026-10-08)
HEROES.Paladin.scripts.SpecialHealAlliesScript.HealPercentAmount = 0.55; // Pearl: heal 50 % -> 55 % of max HP
HEROES.Sorcerer.hpGrowth = 26; // Sollux: 30 -> 26 HP per level, his strength vs minions stays (Rickard: 79 % is too much)
HEROES.Marksman.hp = 182; // Silver: 165 -> 182 HP (+10 %), he died the most for his damage (Rickard 2026-10-10: +5 % showed nothing in 900 matches)
HEROES.Joker.hp = 237; // ROI17: 210 -> 237 HP (+13 %), most deaths per match of all heroes (Rickard 2026-10-10: +10 % gave 35 -> 41 %, then 3 % more)
HEROES.Marksman.speed = 1.85; // Silver: 1.7 -> 1.85 before the 15 % hero speed bonus below, he was the slowest hero and got caught (Rickard 2026-10-10)
const RON_CHARGE_TILES = 10; // Ron: tiles walked per special charge, the base DistancePerCharge (6 charges = 60 tiles fill Darkslide); was 1.7, Rickard: he got too strong
const RON_FINISH = { below: 0.25, reach: 6 }; // Ron is the chaser/finisher: his bot slides after enemy heroes under 25 % HP within 6 tiles
const BULLDOZE_SHIELD = { pct: 0.2, dur: 2 }; // Bronson: shield of 20 % max HP for 2 s when Bulldoze lands
const HERO_SPEED = 1.15; // every hero moves 15 % faster than the base value (Rickard 2026-10-09: crossing the map felt slow); minions keep their pace
for (const k in HEROES) HEROES[k].speed = Math.round(HEROES[k].speed * HERO_SPEED * 100) / 100;
const HERO_ORDER = ['Barbarian','Archer','Angler','Automaton','Banshee','Brawler','Frog','Joker','Marksman','Paladin','Sorcerer','Thief','Witch','Kunoichi'];
// ABC2 display names (internal codes stay the same)
const HERO_NAMES = { Barbarian:'Peter & The Wolfblade', Angler:'Bufo', Banshee:'Ron', Brawler:'Bronson', Marksman:'Silver', Sorcerer:'Sollux', Thief:'Omega', Joker:'ROI17', Paladin:'Pearl', Archer:'Aery', Witch:'Ginette', Automaton:'Donus', Kunoichi:'Momiji', Frog:'Valtori' };
const heroName = c => HERO_NAMES[c] || c;
const MAP_NAMES = { FTUE_Map_1:'Training Plateau (FTUE)', AncientRuins:'Ancient Ruins', CrystalCoast:'Crystal Coast', FallsOfTranquility:'Falls of Tranquility', LavaCradle:'Lava Cradle', ThePlateau:'The Plateau', TwoRivers:'Two Rivers', ShinyForest:'Shiny Forest', ScorchingGardens:'Scorching Gardens', ShatteredIslands:'Shattered Islands', WoodyTrack:'Woody Track', Fortress:'Fortress', MaxSizeVolcano:'Volcano' };
let PLAYER_TEAM = 2, ENEMY_TEAM = 1;            // team 2 spawns at the bottom of every layout; a multiplayer guest plays team 1 (net.js)
const T_VOID = 0, T_GROUND = 1, T_GRASS = 2, T_WALL = 3, T_JUMP = 4;
const UT_HERO = 0, UT_MINION = 1, UT_TOWER = 2;
const VIEW_TILES_W = 11.5;

// ---------- assets ----------
const IMG = {};
function img(name) {
  if (!IMG[name]) { const i = new Image(); i.src = 'img/' + name + '.png'; IMG[name] = i; }
  return IMG[name];
}
HERO_ORDER.forEach(h => { img('profile_' + h.toLowerCase()); img('ui_abilities_' + h.toLowerCase() + '_special'); });
['ui_ingameView_joystick','ui_ingameView_joystick_base'].forEach(img);
['common', 'rare', 'epic', 'legendary'].forEach(r => { img('item_base_' + r + '_small'); img('item_base_' + r + '_large'); });

// ---------- helpers ----------
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => a + (b - a) * t;
const pick = arr => arr[(Math.random() * arr.length) | 0];

// ---------- menu ----------
let use3D = true; try { use3D = localStorage.getItem('abc2-gfx') !== '2d'; } catch (e) {} // menu "Graphics": 3D world (render3d.js) or the original 2D drawing
let effectsOn = true; try { effectsOn = localStorage.getItem('abc2-effects') !== 'off'; } catch (e) {} // menu "Effects": hit feedback (see updateJuice)
let itemLevel = 1; // gear level of items (1-5), menu "Item level"
let selectedHero = 'Barbarian', selectedMap = 'FTUE_Map_1', selectedTier = 'Platinum', selectedOnb = -1;
let heroTap = { h: null, t: 0 }; // double-click/tap a hero in the menu = play it right away on the chosen map and mode (Rickard)
const menu = document.getElementById('menu');
function buildMenu() {
  const g = document.getElementById('heroes'); g.innerHTML = '';
  HERO_ORDER.forEach(h => {
    const d = document.createElement('div'); d.className = 'hero' + (h === selectedHero ? ' sel' : '');
    d.innerHTML = `<img src="img/profile_${h.toLowerCase()}.png" alt=""><span>${heroName(h)}</span>`;
    d.onclick = () => { const now = performance.now(), dbl = heroTap.h === h && now - heroTap.t < 450; heroTap = { h, t: now };
      selectedHero = h; if (dbl && !window.__mpLobby) { heroTap.h = null; menu.style.display = 'none'; startMatch(selectedHero, selectedMap); } else buildMenu(); };
    g.appendChild(d);
  });
  const H = HEROES[selectedHero];
  document.getElementById('info').innerHTML =
    `<div><b>${heroName(selectedHero)}</b> – ${H.title}</div>
     <div style="margin-top:6px"><b>Special: ${H.special}</b><br>${H.specialDesc}</div>
     <div style="margin-top:6px"><b>Passive: ${H.passive}</b><br>${H.passiveDesc}</div>
     <div class="stats"><span>Health</span><span>${H.hp} (+${H.hpGrowth}/level)</span>
     <span>Damage</span><span>${H.dmg} (+${H.dmgGrowth}/level)</span>
     <span>Attack interval</span><span>${H.cd}s</span><span>Range</span><span>${H.range}</span>
     <span>Speed</span><span>${H.speed}</span><span>Special</span><span>${H.maxSpecialCharges} hits</span></div>`;
  const sel = document.getElementById('map');
  if (!sel.options.length) {
    Object.keys(GD.maps).filter(m => m !== 'Tutorial').forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = MAP_NAMES[m] || m; sel.appendChild(o); });
    sel.onchange = () => selectedMap = sel.value;
    const ts = document.getElementById('tier');
    [['Bronze', 'Bronze'], ['Silver', 'Silver'], ['Gold', 'Gold'], ['Platinum', 'Platinum']].forEach(([v, n]) => { const o = document.createElement('option'); o.value = v; o.textContent = n; ts.appendChild(o); });
    ts.value = selectedTier; ts.onchange = () => selectedTier = ts.value;
    const os = document.getElementById('onb'); const ON = { FirstBotMatch: '1st bot match', StarAdvantageMatch: 'Star Advantage match', FourthBotMatch: '4th bot match', ItemsBotMatch: 'Items match' };
    [[-1, 'Off']].concat(GD.onboarding.map((o, i) => [i, o])).filter(([i, o]) => i < 0 || ON[o.seq]).forEach(([i, o]) => { const e = document.createElement('option'); e.value = i;
      e.textContent = i < 0 ? o : `${ON[o.seq]} (+${Math.round(o.dmg * 100)}% damage, ${Math.round(o.taken * 100)}% damage taken)`; os.appendChild(e); });
    os.onchange = () => selectedOnb = +os.value;
    const il = document.getElementById('ilvl'); [1, 2, 3, 4, 5].forEach(n => { const e = document.createElement('option'); e.value = n; e.textContent = 'Level ' + n; il.appendChild(e); });
    il.value = itemLevel; il.onchange = () => itemLevel = +il.value;
    const gx = document.getElementById('gfx'); [['3d', '3D'], ['2d', '2D']].forEach(([v, n]) => { const e = document.createElement('option'); e.value = v; e.textContent = n; gx.appendChild(e); });
    gx.value = use3D ? '3d' : '2d'; gx.onchange = () => { use3D = gx.value === '3d'; try { localStorage.setItem('abc2-gfx', gx.value); } catch (e) {} };
    const ef = document.getElementById('effects'); [['on', 'On'], ['off', 'Off']].forEach(([v, n]) => { const e = document.createElement('option'); e.value = v; e.textContent = n; ef.appendChild(e); });
    ef.value = effectsOn ? 'on' : 'off'; ef.onchange = () => { effectsOn = ef.value === 'on'; try { localStorage.setItem('abc2-effects', ef.value); } catch (e) {} }; // screen shake, zoom, hit flash, stagger
  }
  sel.value = selectedMap;
}
document.getElementById('play').onclick = () => { menu.style.display = 'none'; startMatch(selectedHero, selectedMap); };
document.getElementById('tut').onclick = () => { menu.style.display = 'none'; startTutorial(); };
buildMenu();
// menu "ITEMS": every item with icon, rarity, active/passive and effect at the menu's item level; also the items ABC2 does not use yet
const UNUSED_ITEMS = [ // defined in ItemDefinitions but not implemented in ABC2 yet
  ['Mechano Greaves', 'placeholder_greaves', 1, 'Hop forward a short distance and instantly auto attack (50s cooldown)'],
  ['Champion\'s Statue', 'placeholder_statue', 1, 'Transform into a statue and shatter after a short duration, dealing damage to nearby enemies (100s cooldown)'],
  ['Portable Arbalest', 'placeholder_crossbow', 1, 'Fires a damaging arrow at the last target you damaged (60s cooldown)'],
];
function openItemsView() {
  const view = document.getElementById('itemsView'), list = document.getElementById('itemsList'); list.textContent = '';
  document.getElementById('itemsSub').textContent = `Effects shown at item level ${itemLevel} (change "Item level" in the menu). ${Object.keys(ITEM_INFO).length - ITEM_OFF.size} items can drop in a match.`;
  const row = (name, icon, rarity, active, desc, tag) => { const r = document.createElement('div'); r.className = 'itm' + (tag ? ' off' : '');
    const ic = document.createElement('div'); ic.className = 'ic';
    ic.style.background = rarity != null ? `linear-gradient(${shade(RARITY_BG[rarity], 0.35)}, ${shade(RARITY_BG[rarity], -0.15)})` : '#2a3168';
    if (icon) { const i = document.createElement('img'); i.src = 'img/item_' + icon + '.png'; i.alt = ''; i.style.inset = '12%'; i.style.width = i.style.height = '76%'; ic.appendChild(i); }
    else { const g = document.createElement('div'); g.className = 'glyph'; g.textContent = 'no icon'; ic.appendChild(g); }
    const t = document.createElement('div'); t.style.minWidth = '0';
    const n = document.createElement('div'); n.className = 'nm'; n.textContent = name; n.style.color = rarity != null ? RARITY_COL[rarity] : '#fff'; t.appendChild(n);
    const tg = document.createElement('div'); tg.className = 'tags'; const add = (txt, c) => { const e = document.createElement('span'); e.className = 'tag' + (c ? ' ' + c : ''); e.textContent = txt; tg.appendChild(e); };
    if (rarity != null) add(RARITY_NAME[rarity]); add(active ? 'active' : 'passive', active ? 'act' : ''); if (tag) add(tag, 'offt'); t.appendChild(tg);
    const d = document.createElement('div'); d.className = 'ds'; d.textContent = desc; t.appendChild(d);
    r.append(ic, t); list.appendChild(r); };
  const head = t => { const h = document.createElement('h3'); h.textContent = t; list.appendChild(h); };
  const keys = Object.keys(ITEM_INFO).filter(k => ID[k]), on = keys.filter(k => !ITEM_OFF.has(k)), sortK = (a, b) => ID[a].Rarity - ID[b].Rarity || itemName(a).localeCompare(itemName(b));
  head('Active items (use with Q/E or the buttons)'); on.filter(k => ID[k].HasUseEffect).sort(sortK).forEach(k => row(itemName(k), ITEM_INFO[k][3], ID[k].Rarity, 1, ITEM_INFO[k][2](ID[k])));
  head('Passive items'); on.filter(k => !ID[k].HasUseEffect).sort(sortK).forEach(k => row(itemName(k), ITEM_INFO[k][3], ID[k].Rarity, 0, ITEM_INFO[k][2](ID[k])));
  head('Turned off in the original'); keys.filter(k => ITEM_OFF.has(k)).sort(sortK).forEach(k => row(itemName(k), ITEM_INFO[k][3], ID[k].Rarity, ID[k].HasUseEffect, ITEM_INFO[k][2](ID[k]), 'not in game'));
  head('Not in ABC2 yet'); UNUSED_ITEMS.forEach(([n, ic, act, d]) => row(n, ic, null, act, d, 'not added'));
  view.hidden = false; view.scrollTop = 0; document.getElementById('itemsClose').focus(); }
document.getElementById('itemsBtn').onclick = openItemsView;
document.getElementById('itemsClose').onclick = () => { document.getElementById('itemsView').hidden = true; document.getElementById('itemsBtn').focus(); };

// ---------- canvas ----------
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1, SCALE = 40;
function resize() {
  const r = cv.getBoundingClientRect(); DPR = Math.min(3, Math.max(2, window.devicePixelRatio || 1)); // HUD canvas at full pixel density, at least 2x so small text stays crisp on 1x desktop screens too
  W = r.width; H = r.height; cv.width = W * DPR; cv.height = H * DPR; SCALE = W / VIEW_TILES_W;
}
window.addEventListener('resize', resize); resize();

// ---------- input ----------
const input = { jx: 0, jy: 0, keys: {}, joy: null, special: false, specialBuf: 0 };
const SPECIAL_BUFFER = 0.25; // s a special press is kept when it can't fire yet (stunned, mid-cast, no target in reach): it fires the moment it can
const SPECIAL_BTN = () => ({ x: W - 0.22 * W, y: H - 0.13 * H, r: 0.12 * W });
const EMOTE_BTN = () => { const b = SPECIAL_BTN(); return { x: b.x + 0.02 * W, y: b.y - b.r - 0.15 * W, r: 0.06 * W }; }; // heart emote, above special like the original
const ITEM_BTN = i => ({ x: W * (0.54 + 0.05 * i), y: H - 0.13 * H + 0.12 * W - i * 0.16 * W - 0.03 * W, r: 0.065 * W });
// item choices, top right like the original: slim pills running off the right edge, laid out when drawn (rows grow for long descriptions)
const OFFER_ROWS = () => (game && game.itemOffer && game.itemOffer.rows) || [0, 1, 2].map(i => ({ x: W * 0.52, y: H * 0.17 + i * H * 0.075, w: W * 0.5, h: H * 0.062 }));
const REROLL_BTN = () => { const r = OFFER_ROWS(), l = r[r.length - 1]; return { x: W * 0.9, y: l.y + l.h + W * 0.1, r: W * 0.065 }; };
const PASSIVE_SLOT = i => ({ x: W * (0.07 + i * 0.09), y: H * 0.03, r: W * 0.037 }); // passive items, top left above the tower bar like the original, with their proc timer
const SCORE_BTN = () => ({ x: W * 0.93, y: H * 0.03, r: W * 0.037 }); // bookmark button, top right: opens the score tab
const activeItems = h => h.items.filter(it => ID[it.key].HasUseEffect), passiveItems = h => h.items.filter(it => !ID[it.key].HasUseEffect);
function joyBase() { return { x: 0.22 * W, y: H - 0.13 * H }; } // fixed on screen (Rickard): the base never moves, only the stick follows the finger
const JOY_R = () => 0.11 * W;
function joyStick() { const b = joyBase(), R = JOY_R(); if (!input.joy) return { x: b.x, y: b.y, dx: 0, dy: 0 }; let dx = input.joy.x - b.x, dy = input.joy.y - b.y; const m = Math.hypot(dx, dy); if (m > R) { dx *= R / m; dy *= R / m; } return { x: b.x + dx, y: b.y + dy, dx, dy }; }
function ptr(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
cv.addEventListener('pointerdown', e => {
  const p = ptr(e); cv.setPointerCapture(e.pointerId);
  if (game && game.state === 'over') { if (game.net && window.__mpOverTap) { window.__mpOverTap(game.net, p); return; } if (game.overT > OVER_TAP) backToMenu(); return; } // multiplayer: rematch button / back to the lobby (net.js)
  if (game && game.scoreOpen) { const x = SCORE_EXIT(); if (p.x >= x.x && p.x <= x.x + x.w && p.y >= x.y && p.y <= x.y + x.h) backToMenu(); else game.scoreOpen = false; return; } // any other tap closes it
  if (game && (game.state === 'play' || game.state === 'countdown') && !game.tut) { const b = SCORE_BTN(); if (Math.hypot(p.x - b.x, p.y - b.y) < b.r * 1.4) { game.scoreOpen = true; return; } }
  if (game && game.itemOffer) { const i = OFFER_ROWS().findIndex(c => p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h); if (i >= 0) { pickOffered(i); return; }
    const r = REROLL_BTN(); if (canReroll() && Math.hypot(p.x - r.x, p.y - r.y) < r.r * 1.2) { rerollOffer(); return; } }
  if (game && game.player) { const act = activeItems(game.player), i = act.findIndex((it, k) => { const q = ITEM_BTN(k); return Math.hypot(p.x - q.x, p.y - q.y) < q.r * 1.2; }); if (i >= 0) { useItem(game.player, act[i]); return; } }
  if (game && game.state === 'play' && !game.tut) { const e = EMOTE_BTN(); if (Math.hypot(p.x - e.x, p.y - e.y) < e.r * 1.3) { playerEmote(); return; } }
  const b = SPECIAL_BTN();
  if (Math.hypot(p.x - b.x, p.y - b.y) < b.r * 1.25) { input.special = true; return; }
  const jb = joyBase(); if (!input.joy && Math.hypot(p.x - jb.x, p.y - jb.y) < JOY_R() * 2) input.joy = { id: e.pointerId, x: p.x, y: p.y };
});
cv.addEventListener('pointermove', e => { if (input.joy && input.joy.id === e.pointerId) { const p = ptr(e); input.joy.x = p.x; input.joy.y = p.y; } });
const endJoy = e => { if (input.joy && input.joy.id === e.pointerId) input.joy = null; };
cv.addEventListener('pointerup', endJoy); cv.addEventListener('pointercancel', endJoy);
window.addEventListener('keydown', e => { input.keys[e.key.toLowerCase()] = true;
  if (e.key === 'Tab' && game && (game.state === 'play' || game.state === 'countdown') && !game.tut) { game.scoreOpen = !game.scoreOpen; e.preventDefault(); } if (e.key === ' ') { input.special = true; e.preventDefault(); }
  if (game && game.itemOffer && '123'.includes(e.key)) pickOffered(+e.key - 1);
  if (game && game.itemOffer && e.key === 'r' && canReroll()) rerollOffer();
  if (game && game.player && (e.key === 'q' || e.key === 'e')) useItem(game.player, activeItems(game.player)[e.key === 'q' ? 0 : 1]); });
window.addEventListener('keyup', e => { input.keys[e.key.toLowerCase()] = false; });
function readMove() {
  let x = 0, y = 0;
  const k = input.keys;
  if (k['a'] || k['arrowleft']) x -= 1; if (k['d'] || k['arrowright']) x += 1;
  if (k['w'] || k['arrowup']) y += 1; if (k['s'] || k['arrowdown']) y -= 1;
  if (input.joy) {
    const j = joyStick();
    const jd = Math.hypot(j.dx, j.dy); if (jd > 6) { x = j.dx / jd; y = -j.dy / jd; } // past the dead zone the stick only steers: always full speed (Rickard 2026-10-08)
  }
  const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
  if (game) { const V = viewOf(game); x *= V.x; y *= V.y; } // screen direction -> map direction (turned view for a guest)
  return { x, y };
}

// ---------- map ----------
class GameMap {
  constructor(name) {
    const m = GD.maps[name]; this.name = name; this.w = m.w; this.h = m.h; this.tiles = m.tiles.slice(); this.src = m;
    // spawner tiles are stored as Void in the layouts (portal/tower sockets); treat them as ground
    for (const s of m.spawners) this.tiles[s.y * m.w + s.x] = T_GROUND;
    this.jumpPads = m.jumpPads;
  }
  tile(tx, ty) { if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return T_VOID; return this.tiles[ty * this.w + tx]; }
  tileAt(x, y) { return this.tile(Math.floor(x), Math.floor(y)); }
  walkable(tx, ty) { const t = this.tile(tx, ty); return t === T_GROUND || t === T_GRASS || t === T_JUMP; }
  free(x, y, r) { // circle vs blocked tiles
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      if (this.walkable(tx, ty)) continue;
      const cx = clamp(x, tx, tx + 1), cy = clamp(y, ty, ty + 1);
      if ((cx - x) ** 2 + (cy - y) ** 2 < r * r) return false;
    }
    return true;
  }
  inGrass(u) { return this.tileAt(u.x, u.y) === T_GRASS; }
  // BFS path on the tile grid; returns list of tile centers
  path(from, to) {
    const W = this.w, Hh = this.h, sx = Math.floor(from.x), sy = Math.floor(from.y);
    let tx = Math.floor(to.x), ty = Math.floor(to.y);
    if (!this.walkable(tx, ty)) { // nearest walkable tile to target
      let best = null, bd = 1e9;
      for (let y = Math.max(0, ty - 3); y <= Math.min(Hh - 1, ty + 3); y++) for (let x = Math.max(0, tx - 3); x <= Math.min(W - 1, tx + 3); x++)
        if (this.walkable(x, y)) { const d = (x - tx) ** 2 + (y - ty) ** 2; if (d < bd) { bd = d; best = [x, y]; } }
      if (!best) return null; [tx, ty] = best;
    }
    if (sx === tx && sy === ty) return [{ x: to.x, y: to.y }];
    const prev = new Int32Array(W * Hh).fill(-1), q = [sy * W + sx]; prev[sy * W + sx] = sy * W + sx;
    const goal = ty * W + tx; let head = 0;
    while (head < q.length) {
      const c = q[head++]; if (c === goal) break;
      const cx = c % W, cy = (c / W) | 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= Hh) continue;
        const n = ny * W + nx; if (prev[n] !== -1 || !this.walkable(nx, ny)) continue;
        if (n !== goal && game && game.units.some(t => t.kind === 'tower' && t.alive && Math.floor(t.x) === nx && Math.floor(t.y) === ny)) continue; // towers are solid
        if (dx && dy && (!this.walkable(cx + dx, cy) || !this.walkable(cx, cy + dy))) continue;
        prev[n] = c; q.push(n);
      }
    }
    if (prev[goal] === -1) return null;
    const out = []; let c = goal;
    while (c !== sy * W + sx) { out.push({ x: c % W + 0.5, y: ((c / W) | 0) + 0.5 }); c = prev[c]; }
    out.reverse(); if (out.length) out[out.length - 1] = { x: to.x, y: to.y };
    return out;
  }
}

// ---------- entities ----------
let nextId = 1;
class Unit {
  constructor(kind, team, x, y) {
    this.id = nextId++; this.kind = kind; this.team = team; this.x = x; this.y = y;
    this.alive = true; this.hp = 1; this.maxHp = 1; this.r = 0.25;
    this.statuses = []; this.atkTimer = 0; this.lastCombat = -99; this.lastHitBy = new Map();
    this.facing = team === PLAYER_TEAM ? Math.PI / 2 : -Math.PI / 2; this.flash = 0; this.revealT = 0;
    this.vx = 0; this.vy = 0; this.forced = null;
  }
  get unitType() { return this.kind === 'tower' ? UT_TOWER : this.kind === 'minion' ? UT_MINION : UT_HERO; }
  has(type) { return this.statuses.some(s => s.type === type); }
  add(type, dur, extra = {}) { if (CC_TYPES.has(type) && ccImmune(this)) return { type, t: 0, ...extra }; const s = { type, t: dur, ...extra }; this.statuses.push(s); return s; }
  inCombat(now) { return now - this.lastCombat < (this.kind === 'tower' ? UNITS.Tower.sharedOutOfCombat : MATCH.heroOutOfCombat); }
}

class Hero extends Unit {
  constructor(code, team, x, y, isPlayer, name) {
    super('hero', team, x, y);
    this.code = code; this.def = HEROES[code]; this.isPlayer = isPlayer; this.name = name;
    this.r = this.def.radius; this.level = 1; this.charge = 0; this.stocks = 0;
    this.maxHp = this.statHp(); this.hp = this.maxHp; this.deaths = 0; this.kills = 0; this.respawnT = 0;
    this.spawn = { x, y }; this.specialActive = null; this.passive = {}; this.ai = { t: 0, path: null, goal: null };
    this.icon = img('profile_' + code.toLowerCase()); this.spIcon = img('ui_abilities_' + code.toLowerCase() + '_special');
    this.items = []; this.distMoved = 0; this.witchSaved = false; this.marks = { target: null, stacks: 0 }; this.overload = 0;
    this.jokerT = rand(...Object.values(this.def.scripts.JokerCastProjectileRandomlyScript?.RandomDelay || { X: 7.5, Y: 15 }));
  }
  // Star Advantage (DefaultMatchTeamAdvantageScript): tier = team's stars, 1..3
  adv() { const st = game && game.stars && !game.noStars ? game.stars[this.team] : 0; return st ? GD.starAdvantage[st - 1] : null; }
  statHp() { const a = this.adv(), it = hasItem(this, 'Health') ? iv('Health', 'ValuePerLevel') : 0; return (this.def.hp + this.def.hpGrowth * (this.level - 1)) * (1 + (a ? a.HealthBoost : 0)) * (1 + it); }
  statDmg() { const a = this.adv(); return (this.def.dmg + this.def.dmgGrowth * (this.level - 1)) * (this.dmgMult || 1) * (1 + (a ? a.DamageBoost : 0)) * (1 + (this.onb ? this.onb.dmg : 0)); }
  statCd() { const a = this.adv(); return Math.max(0.35, this.def.cd + this.def.cdGrowth * (this.level - 1)) * (1 + (a ? a.AttackCooldownReduction : 0)) / (equinoxOn(this) ? 1 + this.def.scripts.KunoichiSpecial.AttackSpeed : 1); }
  get range() { return this.def.range + (this.specialActive && this.specialActive.rangeBonus || 0); }
  get specialReady() { return this.def.maxSpecialStocks > 1 ? this.stocks > 0 : this.charge >= this.def.maxSpecialCharges; }
  setLevel(l) { const old = this.statHp(); this.level = l; const nw = this.statHp(); this.maxHp = nw; if (this.alive) this.hp += nw - old; }
}

class Minion extends Unit {
  constructor(type, team, x, y, lane) {
    super('minion', team, x, y);
    this.type = type; this.def = UNITS[type]; this.r = this.def.radius; this.maxHp = this.def.hp; this.hp = this.maxHp;
    this.lane = lane; this.wp = 0; this.target = null; this.ai = { t: rand(0, 0.3), path: null };
  }
}

class Tower extends Unit {
  constructor(team, x, y) {
    super('tower', team, x, y);
    this.def = UNITS.Tower; this.r = 0.55; this.maxHp = this.def.hp; this.hp = this.maxHp; this.target = null; this.regenT = 0;
  }
}

// ---------- game ----------
let game = null;
function backToMenu() { if (game && game.net) game.net.close(); game = null; PLAYER_TEAM = 2; ENEMY_TEAM = 1; menu.style.display = ''; buildMenu(); }

const BOT_NAMES = ['Bot1','Bot2','Bot3','Bot4','Bot5'];
let BOT = GD.botTiers.Bronze;
function startMatch(heroCode, mapName, tut, net) { // net: multiplayer 1v1 as host, { enemy: guest's hero code, link } (net.js)
  BOT = net ? GD.botTiers.Platinum : GD.botTiers[selectedTier] || GD.botTiers.Bronze; // multiplayer: a dropped player's hero is played by the best bot
  const map = new GameMap(mapName);
  const g = game = { map, units: [], projectiles: [], effects: [], texts: [], feed: [], time: -MATCH.startCountdown, state: 'countdown', level: 1,
    waveT: MATCH.waves.InitialDelay, waveN: 0, kills: { 1: 0, 2: 0 }, stars: { 1: 0, 2: 0 }, starTip: 0, starTipShown: false, player: null, overT: 0, winner: 0, cam: { x: 0, y: 0 }, lastKill: new Map() };
  const spawns = { 1: [], 2: [] };
  map.src.spawners.forEach(s => {
    const x = s.x + 0.5, y = s.y + 0.5;
    if (s.type === 0) spawns[s.team].push({ x, y });
    if (s.type === 1) g.units.push(new Tower(s.team, x, y));
    if (s.type === 2) (g.minionSpawn = g.minionSpawn || {})[s.team] = { x, y };
  });
  [1, 2].forEach(t => spawns[t].sort((a, b) => a.x - b.x));
  const pool = HERO_ORDER.filter(h => h !== heroCode);
  // bot matches: all six heroes are different (Rickard 2026-10-09: never meet two of the same hero)
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const allyCodes = tut || net ? [heroCode] : [heroCode, pool[0], pool[1]], enemyCodes = tut ? [] : net ? [net.enemy] : [pool[2], pool[3], pool[4]];
  g.spawns = spawns; g.bannerT = 0;
  let bn = 0;
  allyCodes.forEach((c, i) => { const s = spawns[PLAYER_TEAM][[1, 0, 2][i] % spawns[PLAYER_TEAM].length]; const h = new Hero(c, PLAYER_TEAM, s.x, s.y, i === 0, i === 0 ? 'You' : BOT_NAMES[bn++]); h.spawn = s; g.units.push(h); if (i === 0) g.player = h; });
  enemyCodes.forEach((c, i) => { const s = spawns[ENEMY_TEAM][(net ? 1 : i) % spawns[ENEMY_TEAM].length]; const h = new Hero(c, ENEMY_TEAM, s.x, s.y, false, BOT_NAMES[bn++ % 5]); h.spawn = s; g.units.push(h);
    if (net) { h.remote = true; h.name = net.enemyName || 'Enemy'; g.net = net.link; } });
  g.cam.x = g.player.x; g.cam.y = g.player.y + 2;
  if (!tut && selectedOnb >= 0) g.player.onb = GD.onboarding[selectedOnb];
  const seq = g.player.onb ? g.player.onb.seq : '';
  g.tips = seq === 'FirstBotMatch' || seq === 'StarAdvantageMatch'; // TutorialMarksmanTipsScriptAsset only in these modes
  g.noStars = !!tut || seq === 'FirstBotMatch'; // TutorialBotMatchMode has no DefaultMatchTeamAdvantageScript
  if (mapName === 'FTUE_Map_1' && !tut && !net) { g.time = 0; g.state = 'play'; g.bannerT = 2.5; } // Training Plateau: no countdown, faster bot testing (Rickard)
}

const heroes = () => game.units.filter(u => u.kind === 'hero');
const towerOf = team => game.units.find(u => u.kind === 'tower' && u.team === team);
function isVisibleTo(u, team) {
  if (!u.alive) return false;
  if (u.team === team) return true;
  if (u.has('invisible')) return false;
  if (u.revealT > 0) return true;
  // DefaultAttackRangeRevealerScript (RangeCoeff 1.0): a tower sees everything inside its attack range, bushes included
  const tw = towerOf(team); if (tw && tw.alive && dist(tw, u) <= tw.def.range) return true;
  if (game.map.inGrass(u)) return game.units.some(o => o.alive && o.team === team && dist(o, u) <= MATCH.grassVisibilityRange);
  return true;
}
function enemiesInRange(src, range, filter) {
  return game.units.filter(u => u.alive && u.team !== src.team && u.kind !== 'illusionDead' && !u.has('untargetable') && isVisibleTo(u, src.team)
    && dist(src, u) <= range + u.r && (!filter || filter(u)));
}

// Momiji (Kunoichi): any shield on her blocks new crowd control; it does not remove CC already on her
const CC_TYPES = new Set(['stun', 'slowFlat', 'slowPct', 'root']);
const ccImmune = u => u.kind === 'hero' && u.code === 'Kunoichi' && u.statuses.some(s => s.type === 'shield' && s.amount > 0);
const equinoxOn = u => u.code === 'Kunoichi' && u.statuses.some(s => s.type === 'shield' && s.equinox && s.amount > 0);

// ---------- damage ----------
const REVEAL_TIME = 1.5; // s; not in the configs, chosen default
function dealDamage(src, tgt, amount, opts = {}) {
  if (!tgt.alive || amount <= 0) return 0;
  if (tgt.has('invulnerable') || tgt.has('untargetable')) return 0;
  // hitting or being hit reveals you in a bush for a moment: you are only hidden while undiscovered (Rickard)
  const att = src && (src.owner || src); if (att && att.revealT !== undefined) att.revealT = REVEAL_TIME; tgt.revealT = REVEAL_TIME;
  if (tgt.onb) amount *= 1 + tgt.onb.taken;
  amount *= itemDamageMult(src, tgt) * itemDamageTakenMult(tgt);
  if (tgt.tutUnkillable && amount >= tgt.hp) amount = Math.max(0, tgt.hp - 1);
  if (tgt.isIllusion) amount *= 2; // IllusionIncomingDamageScript BuffValue 1.0 (+100%)
  const now = game.time;
  tgt.lastCombat = now; if (src) { src.lastCombat = now; if (src.kind === 'hero' || src.isIllusion) tgt.lastHitBy.set(src.owner || src, now); }
  // tower aggro: an enemy hero hurting an allied hero near the tower becomes its target
  if (src && src.kind === 'hero' && tgt.kind === 'hero') {
    const t = towerOf(tgt.team); if (t && t.alive && dist(t, src) <= t.def.range + src.r) t.target = src;
  }
  // shields
  for (const s of tgt.statuses) if (s.type === 'shield' && s.amount > 0) { const a = Math.min(s.amount, amount); s.amount -= a; amount -= a; }
  if (amount <= 0) return 0;
  // SurviveAfterFatalDamageItemScript: a fatal hit leaves 1 HP, then Duration seconds where HP cannot drop below 1
  if (tgt.has('survive')) amount = Math.min(amount, Math.max(0, tgt.hp - 1));
  else if (tgt.kind === 'hero' && tgt.hp - amount <= 0) { const it = itemOf(tgt, 'SurviveAfterFatalDamage');
    if (it && it.cd <= 0) { const v = ID.SurviveAfterFatalDamage; it.cd = itemCd('SurviveAfterFatalDamage'); amount = Math.max(0, tgt.hp - 1);
      tgt.add('survive', v.Duration); tgt.add(v.MoveSpeedBuffType === 1 ? 'speedFlat' : 'speedPct', v.Duration, { v: v.MoveSpeedBuffValue, item: true });
      fx('ring', tgt.x, tgt.y, { r: 0.8, color: '#ffe27a', t: 0.6 }); floatText(tgt, 'Second Wind', '#ffe27a'); } }
  if (amount <= 0) return 0;
  // Witch passive: prevent fatal damage once per life
  if (tgt.kind === 'hero' && tgt.code === 'Witch' && !tgt.witchSaved && tgt.hp - amount <= 0) {
    tgt.witchSaved = true; tgt.hp = 1; tgt.add('invulnerable', tgt.def.scripts.WitchPassiveScript.Duration);
    fx('ring', tgt.x, tgt.y, { r: 0.8, color: '#b98cff', t: 0.6 }); floatText(tgt, 'Persistent', '#d8b8ff'); return 0;
  }
  tgt.hp -= amount; tgt.flash = 0.12;
  // Equinox: part of Momiji's damage refills her shield, up to ShieldCap of her max HP
  if (src && src.kind === 'hero' && src.code === 'Kunoichi' && !src.isIllusion) { const sh = src.statuses.find(s => s.type === 'shield' && s.equinox && s.amount > 0);
    if (sh) { const K = src.def.scripts.KunoichiSpecial; sh.amount = Math.min(src.maxHp * K.ShieldCap, sh.amount + amount * (tgt.kind === 'hero' ? K.HeroConvert : K.OtherConvert)); } }
  if (src && src.kind === 'hero' && !src.isIllusion && hasItem(src, 'LifestealDisableRegen')) heal(src, amount * iv('LifestealDisableRegen', 'LifestealPercentPerLevel'), true, true);
  // DamageOnHitItemScript (active): return DamagePercentReturned of the damage taken to heroes and minions
  if (tgt.has('thorns') && src && src.alive && !opts.reflected && ID.DamageOnHit.UnitTypes.includes(src.unitType) && src.kind !== 'tower')
    dealDamage(tgt, src, amount * ID.DamageOnHit.DamagePercentReturned, { reflected: true });
  if (src && src.kind === 'hero' && src.code === 'Barbarian') heal(src, amount * src.def.scripts.BarbarianPassiveLifestealScript.HealPercentage, true);
  if ((src && (src.isPlayer || (src.owner && src.owner.isPlayer))) || tgt.isPlayer || game.net && (tgt.remote || src && (src.remote || src.owner && src.owner.remote))) dmgText(src, tgt, amount);
  if (tgt.hp <= 0) kill(tgt, src);
  return amount;
}
// Every heal is shown, whatever its source (regen, potions, items, specials, passives): Rickard checked the original.
// Shown only to the healed hero's own player and to the player who healed them (Rickard: you don't see others heal unless you heal them).
// by = who healed (defaults to the unit itself); the number and the ring carry it and are filtered when drawn, so a multiplayer guest gets the same rule.
function heal(u, amt, quiet, glow, by) {
  by = by || u;
  if (!u.alive || amt <= 0) return;
  const before = u.hp; u.hp = Math.min(u.maxHp, u.hp + amt);
  if (u.hp - before > 1 && (u.isPlayer || u.team === PLAYER_TEAM || game.net)) { // drawn for the viewer's own team only; heals close together count up in one number
    const prev = game.texts.find(t => t.hv === u && t.hb === by && t.max - t.t < 0.45 && game.time - t.h0 < 1.2), sum = u.hp - before + (prev ? prev.hsum : 0);
    if (prev) game.texts.splice(game.texts.indexOf(prev), 1);
    floatText(u, '+' + Math.round(sum), '#6bff8f', { team: u.team, hv: u, hb: by, hsum: sum, h0: prev ? prev.h0 : game.time, rep: prev ? prev.k : 0, ...(prev ? { x: prev.x, vx: prev.vx } : {}) }); }
  if (u.hp - before > 0.5 && !(u.healFxAt > game.time - 0.35)) { u.healFxAt = game.time; fx('heal', u.x, u.y, { u, hb: by, t: 0.75 }); }
}
function kill(u, src) {
  u.alive = false; u.hp = 0; const now = game.time;
  const killer = src ? (src.owner || src) : null;
  if (u.kind === 'tower') { endMatch(u.team === PLAYER_TEAM ? ENEMY_TEAM : PLAYER_TEAM); return; }
  if (u.isIllusion) { u.dead = true; return; }
  // Paladin passive: heal when an enemy dies in range
  for (const h of heroes()) if (h.alive && h.code === 'Paladin' && h.team !== u.team && dist(h, u) <= h.def.scripts.PaladinPassiveHealOnPawnDeathScript.Range)
    heal(h, h.maxHp * h.def.scripts.PaladinPassiveHealOnPawnDeathScript.HealPercentAmount);
  if (u.kind === 'minion') { u.deadT = 0.6; if (u.tutKillAllies) game.tut.minions.forEach(m => { if (m.alive && m !== u) kill(m, src); }); return; }
  // hero death
  u.deaths++; u.respawnT = MATCH.respawn.base + MATCH.respawn.increment * (u.deaths - 1);
  u.statuses = []; u.specialActive = null; u.forced = null; u.charge = u.code === 'Frog' ? u.charge : u.charge;
  if (u.code === 'Sorcerer') castMeteor(u, { x: u.x, y: u.y }, u.def.scripts.SorcererPassiveCastProjectileOnDeathScript.DamageCoeff);
  game.kills[u.team === 1 ? 2 : 1]++;
  // Star Advantage: a hero kill gives the killing team a star (max 3); dying resets your team's stars
  const kt = u.team === 1 ? 2 : 1; game.stars[u.team] = 0; game.stars[kt] = Math.min(GD.starAdvantage.length, game.stars[kt] + 1);
  for (const h of heroes()) { const old = h.maxHp; h.maxHp = h.statHp(); if (h.alive) h.hp = Math.min(h.maxHp, h.hp * h.maxHp / old); }
  if (kt === PLAYER_TEAM && !game.starTipShown && game.tips && !game.noStars) { game.starTipShown = true; game.starTip = 5; }
  u.streak = 0;
  const assists = [...u.lastHitBy.entries()].filter(([h, t]) => now - t < 5 && h !== killer).map(([h]) => h);
  // item effects "on hero kill or assist"; Soul Sabre loses half its stacks on death
  for (const h of new Set([killer, ...assists])) if (h && h.kind === 'hero' && h.team !== u.team) itemsOnHeroKill(h);
  for (const h of assists) if (h && h.kind === 'hero' && h.team !== u.team && h !== killer) h.assists = (h.assists || 0) + 1; // for the score tab
  { const it = itemOf(u, 'StackingDamageOnKill'); if (it) it.stacks = Math.floor(it.stacks / 2); }
  if (killer && killer.kind === 'hero') {
    killer.kills++;
    const prev = game.lastKill.get(killer); let tag = '';
    if (prev && now - prev.t < 8) { prev.n++; tag = ['', '', 'Double Kill!', 'Triple Kill!'][Math.min(prev.n, 3)]; } else game.lastKill.set(killer, { t: now, n: 1 });
    killer.streak = (killer.streak || 0) + 1;
    if (killer.streak === 3) tag = tag ? tag + '\nKilling Spree!' : 'Killing Spree!';
    pushFeed(killer, u, tag);
  } else pushFeed(null, u, '');
  for (const h of [killer, ...assists]) if (h && h.kind === 'hero' && h.code === 'Frog' && h.alive) { h.charge = h.def.maxSpecialCharges; floatText(h, 'Windfall', '#9dff7a'); }
  const enemyTeam = u.team; if (heroes().filter(h => h.team === enemyTeam).every(h => !h.alive)) pushFeed(killer, null, 'Ace!');
  u.lastHitBy.clear();
}
function pushFeed(killer, victim, tag) {
  game.feed.unshift({ k: killer ? killer.name : (victim ? 'Tower/minion' : ''), kt: killer ? killer.team : 0, v: victim ? victim.name : '', vt: victim ? victim.team : 0, tag, t: 4 });
  if (game.feed.length > 4) game.feed.pop();
}
function endMatch(winner) { if (game.state === 'over') return; game.state = 'over'; game.winner = winner; game.overT = 0;
  const t = game.units.find(u => u.kind === 'tower' && u.team !== winner && !u.alive); game.endAt = t ? { x: t.x, y: t.y } : null; } // the camera goes there before the banner
const OVER_BANNER = 1.0, OVER_TAP = 2.2; // s after the tower falls: the banner fades in, then a tap continues (net.js uses the same 2.2)

// ---------- items (DB/Items/Scripts/*ItemScript, FullInventoryConfig, TowerMatchModeConfig.ItemBuyPhaseLevels) ----------
// Every number is read from GD.itemData (the item scripts). Per-level arrays are indexed by the gear level chosen
// in the menu (1-5); "PerIngameLevel" values do not occur among the included items. Left out because their behaviour
// depends on data the extraction does not resolve: ShatteringStatue, CastProjectileOnLastDamagedUnit, HopForward.
const ID = GD.itemData ? GD.itemData.items : {};
// Titanic Cleaver (DamageHealthThresholdItemScript, Q16.16 values): +damage while own HP is within HealthThreshold [X, Y]
if (GD.itemData && !ID.DamageHealthThreshold) ID.DamageHealthThreshold = { Rarity: 2, Stackable: 0, HasUseEffect: 0, BuffValuePerLevel: [7208, 7864, 8519, 9175, 9830].map(v => v / 65536), BuffType: 0, HealthThreshold: [0.75, 1] };
// ABC2 item balance (not base values; Items: Balancing thread, 2026-10-09). Each item was tested by letting all three heroes of one team take it at
// their first item offer, 160 bot matches per item (rapporter/itembalans/2026-10-09-items.md). 50 % = as good as the item a bot would have picked.
// The weak ones (tower, speed and minion items, 35-43 %) did not move with bigger numbers: bots gain little from them, so they are left at the base values.
const ITEM_TUNING = {
  SpecialChargeOverTime:   { TickDurationPerLevel: x => x * 1.5 },                // Battle Turbine: 1 charge every 6 s -> 9 s (72 % -> 54 %)
  SurviveAfterFatalDamage: { Duration: () => 3, CooldownPerLevel: x => x * 1.2 }, // Links of Sealed Fate: 4 s -> 3 s, cd 100 -> 120 s (63 % -> 59 %)
  LifestealDisableRegen:   { RegenFactor: () => 0.5 },                            // Parascythe: regen at half speed instead of none (8 % -> 54 %)
};
for (const [k, t] of Object.entries(ITEM_TUNING)) if (ID[k]) for (const [f, fn] of Object.entries(t)) { const v = ID[k][f]; ID[k][f] = Array.isArray(v) ? v.map(x => +fn(x).toFixed(4)) : +fn(v).toFixed(4); }
// Only scripts that an ItemDefinition points to are offered: Refracting Shroud uses InvisibilityPotionItemScript, so InvisibilityOnSpecialItemScript is unused.
const ITEM_INFO = { // in-game name, fallback glyph, short description from the item values, icon (img/item_<icon>.png)
  Health:                        ['Mythrite Bangle', '❤', v => `+${pc(v.ValuePerLevel)} max HP`, 'band'],
  MoveSpeed:                     ['Nimbus Kicks', '👟', v => `+${pc(v.ValuePerLevel)} move speed`, 'shoes'],
  DamageHero:                    ['Heroes Bane', '⚔', v => `+${pc(v.ValuePerLevel)} damage to heroes`, 'dagger'],
  DamageMinion:                  ['Minion Skewer', '🗡', v => `+${pc(v.ValuePerLevel)} damage to minions`, 'spear'],
  DamageTower:                   ['Crushing Spanner', '🏰', v => `+${pc(v.ValuePerLevel)} damage to towers`, 'hammer'],
  DamageUnderAllyTower:          ['Defender\'s Crown', '🔥', v => `+${pc(v.ValuePerLevel)} damage near your tower`, ''],
  DamageReductionUnderAllyTower: ['Defender\'s Cuirass', '🛡', v => `−${pc(v.ValuePerLevel)} damage taken near your tower`, ''],
  DamageReductionUnderEnemyTower:['Raider\'s Cuirass', '🛡', v => `−${pc(v.ValuePerLevel)} damage taken near the enemy tower`, ''],
  DamageSpecialFull:             ['Staff of Ancients', '⚡', v => `+${pc(v.ValuePerLevel)} damage while special is charged`, 'rune'],
  DamageHealthThreshold:         ['Titanic Cleaver', '🪓', v => `+${pc(v.BuffValuePerLevel)} damage when you are above ${pc(v.HealthThreshold[0])} health`, 'axe'],
  StackingDamageOnKill:          ['Soul Sabre', '🏆', v => `+${pc(v.DamagePerStackPerLevel)} damage per hero kill or assist (max ${v.MaxStacks}, lose half on death)`, 'scythe'],
  HealOnHeroKill:                ['Coiled Fang', '🍖', v => `Heals ${pc(v.HealPercentPerLevel)} on hero kill or assist`, 'claws'],
  MoveSpeedOnKill:               ['Royal Runners', '💨', v => `+${pc(v.ValuePerLevel)} move speed for ${lv(v.DurationPerLevel)}s after a hero kill or assist`, 'wingedBoots'],
  MoveSpeedOnSpecialDeactivated: ['Momentum Pumps', '💨', v => `+${pc(v.ValuePerLevel)} move speed for ${lv(v.DurationPerLevel)}s after special`, 'boots'],
  FillSpecialChargesOnSpawn:     ['Arena Life Magazine', '🔋', v => `Full special and +${pc(v.MoveSpeedPerLevel)} move speed for ${v.Duration}s on respawn`, 'book'],
  SpecialChargeOverTime:         ['Battle Turbine', '🔋', v => `+${v.ChargesPerTick} special charge every ${lv(v.TickDurationPerLevel)}s`, 'lightning'],
  LifestealDisableRegen:         ['Parascythe', '🩸', v => `${pc(v.LifestealPercentPerLevel)} lifesteal, but regen at ${pc(v.RegenFactor)} speed`, 'bloodBlade'],
  RegenTickTime:                 ['Fidget Stone', '➕', v => `Regen ticks ${pc(v.ValuePerLevel.map(Math.abs))} faster`, 'necklace'],
  GrassRegenOverTime:            ['Enchanted Bark', '🌿', v => `Heals ${pc(v.HealPercentPerTickPerLevel)} per second in grass`, 'necklace'],
  SurviveAfterFatalDamage:       ['Links of Sealed Fate', '💫', v => `Survives fatal damage for ${v.Duration}s (cd ${lv(v.CooldownPerLevel)}s)`, 'chains'],
  BlockAutoAttack:               ['Promotional Pavise', '🤺', v => `Blocks one auto attack every ${lv(v.CooldownPerLevel)}s`, 'placeholder_shield'],
  HealthPotion:                  ['Healoraid', '🧪', v => `Heals ${pc(v.HealPercent)} (cd ${lv(v.CooldownPerLevel)}s)`, 'potion'],
  HealthOverTimePotion:          ['Battlefield Bandage', '🧪', v => `Heals ${pc(v.HealPercentPerTick)}/s for ${v.NumTicks}s (cd ${lv(v.CooldownPerLevel)}s)`, 'placeholder_scroll'],
  InvincibilityPotion:           ['Auric Ale', '⭐', v => `Invincible for ${v.Duration}s but slowed (cd ${lv(v.CooldownPerLevel)}s)`, 'potion2'],
  InvisibilityPotion:            ['Refracting Shroud', '👻', v => `Invisible for ${v.Duration}s (cd ${lv(v.CooldownPerLevel)}s)`, 'cloak'],
  SpecialChargePotion:           ['Power Pop', '⚡', v => `Charges your special instantly (cd ${lv(v.CooldownPerLevel)}s)`, 'potion3'],
  RessurectionPotion:            ['Phoenix Fizz', '✝', v => `Revive instantly where you died with ${pc(v.HealthPercentWhenRessurected)} HP (cd ${lv(v.CooldownPerLevel)}s)`, 'feather'],
  DamageOnHit:                   ['Pin of Thorns', '🌵', v => `Returns ${pc(v.DamagePercentReturned)} damage for ${v.Duration}s (cd ${lv(v.CooldownPerLevel)}s)`, 'thorns'],
  TowerAdditionalAttackTargets:  ['Garrison Bell', '🎯', v => `Your tower shoots ${v.AdditionalAttackTargets} extra targets for ${v.Duration}s (cd ${lv(v.CooldownPerLevel)}s)`, 'placeholder_bell'],
};
const LV = arr => Array.isArray(arr) ? (arr.length ? arr[Math.min(itemLevel, arr.length) - 1] : 0) : arr;
function pc(x) { return Math.round(LV(x) * 100) + '%'; }
function lv(x) { return +LV(x).toFixed(2); }
const RARITY_BG = ['#4c7a98', '#00d98f', '#f500ff', '#ffc004']; // fill colours of the item_base_<rarity> sprites
const RARITY_COL = ['#b9d6ea', '#5cf0b8', '#f08cff', '#ffd75a']; // the same hues, light enough for text and rings
function rarityFill(r, y0, y1) { const g = ctx.createLinearGradient(0, y0, 0, y1), c = RARITY_BG[r]; g.addColorStop(0, shade(c, 0.35)); g.addColorStop(1, shade(c, -0.15)); return g; } // soft top light like the original tiles
function shade(hex, k) { const n = parseInt(hex.slice(1), 16), f = c => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k)); return `rgb(${f(n >> 16)},${f(n >> 8 & 255)},${f(n & 255)})`; }
const itemName = k => ITEM_INFO[k] ? ITEM_INFO[k][0] : k;
const RARITY_NAME = ['common', 'rare', 'epic', 'legendary'];
const itemIcon = k => ITEM_INFO[k] && ITEM_INFO[k][3] ? img('item_' + ITEM_INFO[k][3]) : null;
const imgOk = i => i && i.complete && i.naturalWidth;
Object.keys(ITEM_INFO).forEach(itemIcon); // preload every item icon so nothing else shows while one is still loading
const iconBoxes = new WeakMap();
function iconBox(im) { // bounding box of the non-transparent pixels (falls back to the whole image if the canvas can't be read)
  let b = iconBoxes.get(im); if (b) return b; b = { x: 0, y: 0, w: im.naturalWidth, h: im.naturalHeight };
  try { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let i = 0; i < c.width; i++) if (d[(y * c.width + i) * 4 + 3] > 24) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 >= x0) b = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; } catch (e) {}
  iconBoxes.set(im, b); return b; }
function drawFitTrim(im, cx, cy, size) { const b = iconBox(im), s = size / Math.max(b.w, b.h); ctx.drawImage(im, b.x, b.y, b.w, b.h, cx - b.w * s / 2, cy - b.h * s / 2, b.w * s, b.h * s); }
function drawFit(im, cx, cy, size) { const s = size / Math.max(im.naturalWidth, im.naturalHeight); ctx.drawImage(im, cx - im.naturalWidth * s / 2, cy - im.naturalHeight * s / 2, im.naturalWidth * s, im.naturalHeight * s); }
const hasItem = (h, k) => !!(h && h.items && h.items.some(it => it.key === k));
const itemOf = (h, k) => h && h.items ? h.items.find(it => it.key === k) : null;
const iv = (k, field) => LV(ID[k][field]);
function itemCd(k) { return ID[k].CooldownPerLevel ? LV(ID[k].CooldownPerLevel) : 0; }
function nearOwnTower(u, extra = 0) { const t = towerOf(u.team); return t && t.alive && dist(t, u) <= t.def.range + extra; }
function nearEnemyTower(u, extra = 0) { const t = towerOf(u.team === 1 ? 2 : 1); return t && t.alive && dist(t, u) <= t.def.range + extra; }

// InventoryCpnt: offer items rolled by FullInventoryConfig.OddsPerRarity, without items the hero already owns
// ItemDefinitions set _availableForPlay = 0 on the three tower-zone items (and their icons are not in the build), so they never drop
const ITEM_OFF = new Set(['DamageUnderAllyTower', 'DamageReductionUnderAllyTower', 'DamageReductionUnderEnemyTower']);
function rollItems(h, n = 3) {
  const owned = new Set(h.items.map(i => i.key)), pool = Object.keys(ID).filter(k => !owned.has(k) && ITEM_INFO[k] && !ITEM_OFF.has(k)), out = [];
  const odds = GD.itemData.rarityOdds;
  while (out.length < n && pool.length) {
    const w = pool.map(k => odds[ID[k].Rarity] || 1), tot = w.reduce((a, b) => a + b, 0); let r = Math.random() * tot, i = 0;
    while (r > w[i]) { r -= w[i]; i++; }
    out.push(pool.splice(Math.min(i, pool.length - 1), 1)[0]);
  }
  return out;
}
function offerItems() {
  for (const h of heroes()) if (!h.isIllusion) {
    const choices = rollItems(h);
    if (!choices.length) continue;
    if (h.isPlayer) { if (game.itemOffer) h.offerPending = (h.offerPending || 0) + 1; else game.itemOffer = { choices, t: 0 }; } // an unpicked offer queues the next one
    else if (h.remote) { if (h.netOffer) h.offerPending = (h.offerPending || 0) + 1; else h.netOffer = choices; } // multiplayer guest picks on its own screen (net.js)
    else setTimeout0(rand(1, 4), () => { // bots: highest rarity, ties at random; skip anything picked meanwhile (two offers close together could hold the same item)
      if (!game || !game.units.includes(h)) return; let c = choices.filter(k => !hasItem(h, k)); if (!c.length) c = rollItems(h); if (!c.length) return; const nl = c.filter(k => k !== 'LifestealDisableRegen'); if (nl.length) c = nl; /* Parascythe needs a human plan (no regen): bots take something else when they can */
      const best = Math.max(...c.map(k => ID[k].Rarity)); equipItem(h, pick(c.filter(k => ID[k].Rarity === best))); });
  }
}
function equipItem(h, k) {
  if (!k || hasItem(h, k)) return;
  h.items.push({ key: k, cd: 0, stacks: 0, t: 0 });
  h.pickedFx = { key: k, t: game.time }; // the item's icon pops up over the hero for everyone to see
  if (k === 'Health') { const old = h.maxHp; h.maxHp = h.statHp(); if (h.alive) h.hp += h.maxHp - old; }
  const next = () => { if (!h.offerPending) return null; h.offerPending--; const c = rollItems(h); return c.length ? c : null; }; // queued offer: rolled fresh so it skips what was just picked
  if (h.isPlayer) { floatText(h, itemName(k), RARITY_COL[ID[k].Rarity]); const c = next(); game.itemOffer = c ? { choices: c, t: 0 } : null; }
  if (h.remote) { floatText(h, itemName(k), RARITY_COL[ID[k].Rarity]); h.netOffer = next(); }
}
// one reroll per offer: three new items, none of the ones just shown (falls back to any if the pool runs dry)
function canReroll() { const o = game && game.itemOffer; return !!(o && !o.rerolled && !game.net); }
function rerollOffer() { const o = game.itemOffer, p = game.player; if (!canReroll()) return;
  const tmp = { items: p.items.concat(o.choices.map(k => ({ key: k }))) }; let c = rollItems(tmp); if (c.length < 3) c = rollItems(p);
  o.choices = c; o.rerolled = true; o.shown = 0; }
function pickOffered(i) { if (game && game.net && game.net.guest) return game.net.action({ a: 'pick', i });
  const o = game && game.itemOffer; if (o && o.choices[i]) equipItem(game.player, o.choices[i]); }
function addCharge(h, n) {
  if (h.def.maxSpecialStocks > 1) { h.stockCharge = (h.stockCharge || 0) + n; while (h.stockCharge >= h.def.maxSpecialCharges && h.stocks < h.def.maxSpecialStocks) { h.stocks++; h.stockCharge -= h.def.maxSpecialCharges; } }
  else h.charge = Math.min(h.def.maxSpecialCharges, h.charge + n);
}
function fillSpecial(h) { if (h.def.maxSpecialStocks > 1) { h.stocks = h.def.maxSpecialStocks; h.stockCharge = 0; } else h.charge = h.def.maxSpecialCharges; }

// outgoing damage multiplier from the attacker's items (BaseFPBuffsItemScript triggers 0/7/8, StackingBuffOnHeroKill)
function itemDamageMult(src, tgt) {
  const h = src && (src.isIllusion ? null : src); if (!h || h.kind !== 'hero' || !h.items || !h.items.length) return 1;
  let m = 0;
  for (const it of h.items) switch (it.key) {
    case 'DamageHero': if (tgt.unitType === UT_HERO) m += iv('DamageHero', 'ValuePerLevel'); break;
    case 'DamageMinion': if (tgt.unitType === UT_MINION) m += iv('DamageMinion', 'ValuePerLevel'); break;
    case 'DamageTower': if (tgt.unitType === UT_TOWER) m += iv('DamageTower', 'ValuePerLevel'); break;
    case 'DamageUnderAllyTower': if (nearOwnTower(h)) m += iv('DamageUnderAllyTower', 'ValuePerLevel'); break;
    case 'DamageSpecialFull': if (h.specialReady) m += iv('DamageSpecialFull', 'ValuePerLevel'); break;
    case 'DamageHealthThreshold': { const t = ID.DamageHealthThreshold.HealthThreshold, k = h.hp / h.maxHp; if (k >= t[0] && k <= t[1]) m += iv('DamageHealthThreshold', 'BuffValuePerLevel'); break; }
    case 'StackingDamageOnKill': m += it.stacks * iv('StackingDamageOnKill', 'DamagePerStackPerLevel'); break;
  }
  return 1 + m;
}
function itemDamageTakenMult(tgt) {
  if (tgt.kind !== 'hero' || !tgt.items || !tgt.items.length) return 1;
  let m = 0;
  if (hasItem(tgt, 'DamageReductionUnderAllyTower') && nearOwnTower(tgt)) m += iv('DamageReductionUnderAllyTower', 'ValuePerLevel');
  if (hasItem(tgt, 'DamageReductionUnderEnemyTower') && nearEnemyTower(tgt)) m += iv('DamageReductionUnderEnemyTower', 'ValuePerLevel');
  return Math.max(0, 1 - m);
}
// called from kill(): on-hero-kill items of the killer
function itemsOnHeroKill(k) {
  if (!k || k.kind !== 'hero' || !k.items) return;
  for (const it of k.items) {
    if (it.key === 'HealOnHeroKill') heal(k, k.maxHp * iv('HealOnHeroKill', 'HealPercentPerLevel'), false, true);
    if (it.key === 'StackingDamageOnKill' && it.stacks < ID.StackingDamageOnKill.MaxStacks) it.stacks++;
    if (it.key === 'MoveSpeedOnKill') k.add('speedPct', iv('MoveSpeedOnKill', 'DurationPerLevel'), { v: iv('MoveSpeedOnKill', 'ValuePerLevel'), item: true });
  }
}
function itemsOnSpecialCast(h) {
  if (hasItem(h, 'InvisibilityOnSpecial')) h.add('invisible', iv('InvisibilityOnSpecial', 'DurationPerLevel'), { item: true });
  if (hasItem(h, 'MoveSpeedOnSpecialDeactivated') && !h.specialActive) itemsOnSpecialEnd(h);
}
function itemsOnSpecialEnd(h) {
  if (hasItem(h, 'MoveSpeedOnSpecialDeactivated')) h.add('speedPct', iv('MoveSpeedOnSpecialDeactivated', 'DurationPerLevel'), { v: iv('MoveSpeedOnSpecialDeactivated', 'ValuePerLevel'), item: true });
}
function itemsOnRespawn(h) {
  if (hasItem(h, 'FillSpecialChargesOnSpawn')) { fillSpecial(h); h.add('speedPct', ID.FillSpecialChargesOnSpawn.Duration, { v: iv('FillSpecialChargesOnSpawn', 'MoveSpeedPerLevel'), item: true }); }
}
// per-frame item upkeep for a living hero
function updateItems(h, dt) {
  if (!h.items || !h.items.length) return;
  for (const it of h.items) {
    if (it.cd > 0) it.cd -= dt;
    if (it.key === 'SpecialChargeOverTime') { it.t += dt; const per = iv('SpecialChargeOverTime', 'TickDurationPerLevel'); if (it.t >= per) { it.t -= per; if (!h.specialActive) addCharge(h, ID.SpecialChargeOverTime.ChargesPerTick); } }
    if (it.key === 'GrassRegenOverTime') { if (game.map.inGrass(h)) { it.t += dt; if (it.t >= ID.GrassRegenOverTime.TickDuration) { it.t = 0; heal(h, h.maxHp * iv('GrassRegenOverTime', 'HealPercentPerTickPerLevel'), true, true); } } else it.t = 0; }
  }
  if (h._spWas && !h.specialActive) itemsOnSpecialEnd(h);
  h._spWas = !!h.specialActive;
}
// active items (HasUseEffect). Returns true when used.
function useItem(h, it) {
  if (game.net && game.net.guest) return game.net.action({ a: 'use', i: h.items.indexOf(it) });
  if (!it || it.cd > 0 || !ID[it.key].HasUseEffect || game.state !== 'play') return false;
  const k = it.key, v = ID[k];
  if (k === 'RessurectionPotion') { if (h.alive) return false; reviveHero(h, v.HealthPercentWhenRessurected, true); } // "Respawn instantly at your death location"
  else {
    if (!h.alive || h.has('stun') && !v.CanUseWhileUncontrollable) return false;
    switch (k) {
      case 'HealthPotion': if (h.hp >= h.maxHp) return false; heal(h, h.maxHp * v.HealPercent, false, true); break;
      case 'HealthOverTimePotion': for (let i = 1; i <= v.NumTicks; i++) setTimeout0(i * v.TickDuration, () => heal(h, h.maxHp * v.HealPercentPerTick, true, true)); break;
      case 'InvincibilityPotion': h.add('invulnerable', v.Duration, { item: true }); h.add(v.MoveSpeedChangeType === 1 ? 'slowFlat' : 'slowPct', v.Duration, { v: v.MoveSpeedChangeValue }); break;
      case 'InvisibilityPotion': h.add('invisible', v.Duration, { item: true }); if (v.ExitCombatOnUse) h.lastCombat = -99; break;
      case 'SpecialChargePotion': if (h.specialReady) return false; fillSpecial(h); break;
      case 'DamageOnHit': h.add('thorns', v.Duration); break;
      case 'TowerAdditionalAttackTargets': { const t = towerOf(h.team); if (!t || !t.alive) return false; t.add('volley', v.Duration); break; }
      default: return false;
    }
  }
  it.cd = itemCd(k);
  fx('ring', h.x, h.y, { r: 0.9, color: RARITY_COL[v.Rarity], t: 0.4 });
  return true;
}
function reviveHero(u, hpPct, atDeathSpot) {
  u.alive = true; u.hp = u.maxHp * (hpPct === undefined ? 1 : hpPct); if (!atDeathSpot) { u.x = u.spawn.x; u.y = u.spawn.y; } u.witchSaved = false;
  u.add('invulnerable', MATCH.respawn.invincible); u.atkTimer = 0; u.respawnT = 0; itemsOnRespawn(u);
}
// bot use of active items, checked on each AI decision
function aiUseItems(h) {
  if (!h.items) return;
  const hpR = h.hp / h.maxHp, ai = h.ai, inFight = h.inCombat(game.time);
  const foeHeroNear = r => game.units.some(u => u.alive && u.kind === 'hero' && u.team !== h.team && !u.isIllusion && dist(u, h) <= r);
  for (const it of h.items) {
    if (it.cd > 0 || !ID[it.key].HasUseEffect) continue;
    let want = false;
    switch (it.key) {
      case 'HealthPotion': want = hpR < 0.4 && inFight; break;
      case 'HealthOverTimePotion': want = hpR < 0.55 && inFight; break;
      case 'InvincibilityPotion': want = inFight && (ai.ttk < 1.5 || hpR < 0.15); break;
      case 'InvisibilityPotion': want = ai.retreat && inFight && hpR < 0.3; break;
      case 'SpecialChargePotion': want = !h.specialReady && foeHeroNear(5); break;
      case 'DamageOnHit': want = inFight && foeHeroNear(2.5); break;
      case 'TowerAdditionalAttackTargets': { const t = towerOf(h.team); want = t && t.alive && game.units.filter(u => u.alive && u.team !== h.team && dist(u, t) <= t.def.range + u.r).length >= 4; break; }
    }
    if (want) useItem(h, it);
  }
}

// ---------- effects ----------
function fx(type, x, y, o = {}) { game.effects.push({ type, x, y, t: o.t || 0.4, max: o.t || 0.4, ...o }); }
let textK = 0;
function floatText(u, text, color, o) { const t = { x: u.x + rand(-0.15, 0.15), y: u.y + 1.0, text: String(text), color, t: 0.9, max: 0.9, k: ++textK, vx: rand(-0.3, 0.3), ...o }; game.texts.push(t); return t; }
// damage numbers: hits from one attacker on one target that land close together (0.3 s apart, up to 0.8 s) count up in one number
// instead of a pile; rep tells a multiplayer guest which number this one replaces. Who sees it and its colour are decided when drawing.
function dmgText(src, tgt, amount) {
  const a = src ? (src.owner || src) : null, now = game.time;
  const prev = game.texts.find(t => t.v === tgt && t.a === a && t.max - t.t < 0.3 && now - t.t0 < 0.8);
  if (prev) game.texts.splice(game.texts.indexOf(prev), 1);
  floatText(tgt, Math.round(amount + (prev ? prev.dmg : 0)), '#ffffff', { v: tgt, a, dmg: amount + (prev ? prev.dmg : 0), t0: prev ? prev.t0 : now, rep: prev ? prev.k : 0, ...(prev ? { x: prev.x, vx: prev.vx } : {}) });
}

// ---------- projectiles / attacks ----------
function autoAttack(u, tgt) {
  const def = u.kind === 'hero' ? u.def.attack : { spawnDelay: u.def.spawnDelay, projSpeed: u.def.projSpeed, projTime: u.def.projTime, coeff: 1 };
  let dmg = u.kind === 'hero' ? u.statDmg() : u.def.dmg;
  let coeff = def.coeff || 1, extra = {};
  if (u.kind === 'hero') {
    if (u.isIllusion) dmg *= 1;
    if (u.code === 'Automaton' && u.overload > 0) { coeff = [1, 1.5, 2, 2.5, 3][u.overload]; u.overload = 0; extra.big = true; }
    if (u.code === 'Marksman') {
      const P = u.def.scripts.MarksmanPassiveConsecutiveAttacksDamageBuffScript;
      if (u.marks.target === tgt) u.marks.stacks = Math.min(P.MaxStacks, u.marks.stacks + 1); else { u.marks.target = tgt; u.marks.stacks = 0; }
      coeff *= 1 + P.DamagePercentPerStack * u.marks.stacks;
    }
    if (u.code === 'Joker' && u.specialActive) coeff = 0.9; // JokerSpecialProjectileScript OverrideDamageCoefficient
    if (u.code === 'Thief' && u.thiefBonus) { coeff *= 1 + u.thiefBonus; extra.slow = true; u.thiefBonus = 0; extra.big = true; }
  }
  if (u.kind === 'tower') { coeff = 1; }
  u.facing = Math.atan2(tgt.y - u.y, tgt.x - u.x); u.aimT = game.time + (def.spawnDelay || 0) + 0.1; // walking doesn't turn it away before the shot leaves
  u.attackAnim = 0.25;
  const p = { src: u, tgt, dmg: dmg * coeff, t: -(def.spawnDelay || 0), speed: def.projSpeed, travel: def.projTime || 0.1, x: u.x, y: u.y, kind: u.kind, ...extra, onHit: (u.kind === 'hero') };
  game.projectiles.push(p);
}
function updateProjectiles(dt) {
  for (const p of game.projectiles) {
    p.t += dt;
    if (p.t < 0) { // wind-up: shots wait in the caster's hand; ground markers (meteor, bramble) stay on their target spot
      if (p.follow) { if (p.follow.alive) { p.x = p.follow.x; p.y = p.follow.y; } } else if (!p.warn) { p.x = p.src.x; p.y = p.src.y; }
      continue;
    }
    if (p.custom) { p.custom(p, dt); continue; }
    const tgt = p.tgt;
    if (p.speed) {
      const d = dist(p, tgt), step = p.speed * dt;
      if (d <= step || d < 0.05) { p.done = true; hitWith(p); }
      else { p.x += (tgt.x - p.x) / d * step; p.y += (tgt.y - p.y) / d * step; }
    } else {
      const k = clamp(p.t / p.travel, 0, 1); p.x = lerp(p.src.x, tgt.x, k); p.y = lerp(p.src.y, tgt.y, k);
      if (p.t >= p.travel) { p.done = true; hitWith(p); }
    }
    if (!tgt.alive && !p.done) p.done = true;
  }
  game.projectiles = game.projectiles.filter(p => !p.done);
}
function hitWith(p) {
  const s = p.src, t = p.tgt; if (!t.alive) return;
  if (t.kind === 'hero' && !p.joker) { const it = itemOf(t, 'BlockAutoAttack'); // BlockAutoAttackItemScript
    if (it && it.cd <= 0) { it.cd = itemCd('BlockAutoAttack'); fx('ring', t.x, t.y, { r: 0.5, color: '#ffffff', t: 0.25 }); if (t.isPlayer || s.isPlayer) floatText(t, 'Block', '#ffffff'); return; } }
  const dealt = dealDamage(s, t, p.dmg);
  fx('hit', t.x, t.y, { color: s.team === PLAYER_TEAM ? '#8fd3ff' : '#ff8f8f', t: 0.2, big: p.big, minor: s.kind !== 'hero', auto: true }); // auto-attack hits are drawn small (minion/tower ones also faint) so specials stand out
  if (s.kind === 'hero' && s.code === 'Kunoichi' && !s.isIllusion && (p.onHit || p.petal)) petalBounce(s, t, p);
  if (!p.onHit || !s.alive && !s.isIllusion) return;
  if (s.kind === 'hero' && !s.isIllusion) onHeroHit(s, t, dealt, p);
}
function onHeroHit(h, t, dealt, p) {
  // DefaultSpecialChargeScript: ChargeAmountPerHit = 1 per auto attack hit
  if (h.def.maxSpecialStocks > 1) { h.stockCharge = (h.stockCharge || 0) + 1; if (h.stockCharge >= h.def.maxSpecialCharges && h.stocks < h.def.maxSpecialStocks && !h.specialActive) { h.stocks++; h.stockCharge = 0; } }
  else if (!h.specialActive && !equinoxOn(h)) h.charge = Math.min(h.def.maxSpecialCharges, h.charge + 1);
  for (const oh of h.def.attack.onHit) { const sc = oh.Settings || {}; if (sc.Duration && (t.kind === 'hero' || t.kind === 'minion')) t.add('slowFlat', sc.Duration, { v: sc.SpeedBuff }); }
  if (p.slow) t.add('slowFlat', 2.0, { v: -1.0 });
  if (h.code === 'Thief') {
    const P = h.def.scripts.ThiefPassiveIllusionsScript;
    if (Math.random() < P.ChancePerHit && game.units.filter(u => u.isIllusion && u.owner === h && u.alive).length < P.MaximumConcurrentIllusions) spawnIllusion(h, P.IllusionDuration);
  }
}

// Petal Barrage: an auto attack (or a bounce) flies on to the nearest enemy hero or minion not yet hit; never towers
function petalBounce(h, from, p) {
  const P = h.def.scripts.KunoichiPassive, k = p.bounce || 0; if (k >= P.Bounces.length) return;
  const hit = p.petals || new Set(); hit.add(from); const base = p.base || p.dmg;
  const nx = game.units.filter(u => u.alive && u.team !== h.team && (u.kind === 'hero' || u.kind === 'minion') && !hit.has(u) && !u.has('untargetable') && isVisibleTo(u, h.team)
    && dist(u, from) <= P.BounceRange + u.r).sort((a, b) => dist(a, from) - dist(b, from))[0];
  if (!nx) return;
  game.projectiles.push({ src: h, tgt: nx, dmg: base * P.Bounces[k] * (nx.kind === 'minion' ? P.MinionFactor : 1), t: 0, speed: P.BounceSpeed, travel: 0.1,
    x: from.x, y: from.y, kind: 'hero', onHit: false, petal: true, bounce: k + 1, petals: hit, base });
}

// ---------- specials ----------
function tryCastSpecial(h) {
  if (h.alive && h.code === 'Frog' && h.specialActive && h.specialActive.inAir) { h.specialActive.landNow = true; return true; }
  if (!h.alive || !h.specialReady || h.has('stun') || game.state !== 'play') return false;
  if (h.specialActive && h.code !== 'Joker') return false;
  const S = h.def.scripts, c = h.code, dmg = h.statDmg();
  const nearestEnemyHero = range => enemiesInRange(h, range, u => u.kind === 'hero').sort((a, b) => dist(h, a) - dist(h, b))[0];
  const randomEnemy = (range, types) => { const l = enemiesInRange(h, range, u => types.includes(u.unitType)); return l.length ? pick(l) : null; };
  let used = false;
  switch (c) {
    case 'Barbarian': {
      const s = S.SpecialWhirlwindScript;
      h.specialActive = { t: s.Duration, tick: 0 }; h.add('slowPct', s.Duration, { v: s.MoveSpeedSlow }); used = true; break;
    }
    case 'Angler': {
      const s = S.SpecialHookScript; const t = nearestEnemyHero(s.HookDistance) || randomEnemy(s.HookDistance, [0, 1]); if (!t) return false;
      const reachMax = 11.25, at = leadAim(h, t, d => 0.9 * (1 - Math.sqrt(Math.max(0, 1 - Math.min(d, reachMax) / reachMax)))); // hook slows from 25 to 0 over 0.9 s
      const ang = Math.atan2(at.y - h.y, at.x - h.x);
      game.projectiles.push({ src: h, x: h.x, y: h.y, t: 0, custom: hookUpdate, fx: 'hook', ang, out: true, d: 0, s, dmg: dmg * s.DamageCoefficient });
      h.add('casting', 0.9); h.facing = ang; used = true; break;
    }
    case 'Archer': {
      const s = S.SpecialMagicArrowScript, P = s.ProjectileConfig.Settings.BaseProjectileScript.Settings;
      const t = nearestEnemyHero(P.MaximumDistance) || randomEnemy(P.MaximumDistance, [0, 1, 2]); if (!t) return false;
      const at = leadAim(h, t, d => 0.35 + d / 13); // wind-up, then 13 tiles/s
      const ang = Math.atan2(at.y - h.y, at.x - h.x); h.facing = ang;
      game.projectiles.push({ src: h, x: h.x, y: h.y, t: -0.35, custom: arrowUpdate, fx: 'arrow', ang, d: 0, P, dmg, speed: 13, hit: new Set() });
      h.add('casting', s.Duration); h.add('disarm', s.Duration);
      recoil(h, ang + Math.PI, s.RecoilDistance, 0.5); used = true; break;
    }
    case 'Automaton': {
      const s = S.AutomatonSpecialChainLightningScript, P = s.ProjectileConfig.Settings.BaseProjectileScript.Settings;
      const t = randomEnemy(h.range + 1, [0, 1]); if (!t) return false;
      h.add('casting', s.Duration); h.add('disarm', s.Duration);
      chainLightning(h, t, P, dmg * s.DamageCoeff); used = true; break;
    }
    case 'Banshee': {
      const s = S.SpecialBallLightningScript;
      h.specialActive = { t: s.Duration, hit: new Set() }; h.add('speedPct', s.Duration, { v: s.SpeedBuff }); h.add('untargetable', s.Duration); h.add('ghost', s.Duration); h.add('disarm', s.Duration); used = true; break;
    }
    case 'Brawler': {
      const s = S.SpecialPunchScript; const t = nearestEnemyHero(h.range) || randomEnemy(h.range, [0, 1]); if (!t) return false; // reach = his attack range (Rickard)
      const ang = Math.atan2(t.y - h.y, t.x - h.x), d = Math.max(0, dist(h, t) - h.r - t.r - 0.1);
      h.forced = { vx: Math.cos(ang), vy: Math.sin(ang), left: d + 1.5, speed: 14, home: t, onEnd: () => {
        if (!t.alive || dist(h, t) > h.r + t.r + 0.5) return; // missed: it got away or a wall was in the way
        dealDamage(h, t, dmg * s.DamageCoeff); t.add('stun', s.StunDuration);
        if (h.alive) { h.add('shield', BULLDOZE_SHIELD.dur, { amount: h.maxHp * BULLDOZE_SHIELD.pct }); fx('ring', h.x, h.y, { r: 0.7, color: '#9fd8ff', t: 0.4 }); }
        if (t.kind !== 'tower' && !ccImmune(t)) t.forced = { vx: Math.cos(ang), vy: Math.sin(ang), left: s.PushDistance, speed: 9, wall: true };
        fx('ring', t.x, t.y, { r: 0.9, color: '#ffd36b', t: 0.3 }); } };
      h.add('casting', 0.35); used = true; break;
    }
    case 'Frog': {
      const s = S.FrogSpecialLeapScript;
      h.specialActive = { t: 0, s, inAir: false, landNow: false }; used = true; break;
    }
    case 'Joker': {
      if (h.specialActive) return false;
      const s = S.SpecialJackInTheBoxScript;
      h.specialActive = { rangeBonus: s.AttackRangeBuff, joker: true }; h.add('casting', 0.6); used = true; break;
    }
    case 'Marksman': {
      const s = S.SpecialLaserScript, P = s.ProjectileConfig.Settings.BaseProjectileScript.Settings;
      const t = nearestEnemyHero(P.Range) || randomEnemy(P.Range, [0, 1, 2]); if (!t) return false;
      const at = leadAim(h, t, () => P.ChargeDelay); // the beam fires along this line after the charge
      const ang = Math.atan2(at.y - h.y, at.x - h.x); h.facing = ang;
      h.add('casting', s.Duration); h.add('disarm', s.Duration);
      game.projectiles.push({ src: h, x: h.x, y: h.y, t: 0, custom: laserUpdate, fx: 'laser', ang, P, dmg: dmg * s.DamageCoeff, fired: false }); used = true; break;
    }
    case 'Paladin': {
      const s = S.SpecialHealAlliesScript;
      for (const a of heroes()) if (a.alive && a.team === h.team) { heal(a, a.maxHp * s.HealPercentAmount, false, true, h); fx('ring', a.x, a.y, { r: 0.8, color: '#7dffb0', t: 1.4, vis: 'paladin', u: a }); }
      h.add('casting', s.Duration); used = true; break;
    }
    case 'Sorcerer': {
      const s = S.SpecialMeteorScript; const t = nearestEnemyHero(h.range + 2) || randomEnemy(h.range + 2, [0, 1, 2]); if (!t) return false;
      h.add('casting', s.Duration); h.add('disarm', s.Duration); castMeteor(h, leadAim(h, t, () => { const M = HEROES.Sorcerer.scripts.SpecialMeteorScript.ProjectileConfig.Settings.BaseProjectileScript.Settings; return (M.WarningDuration + M.FallDuration) * 0.5; /* half lead: the target sees the marker and reacts */ }), s.DamageCoeff); used = true; break;
    }
    case 'Thief': {
      const s = S.SpecialCloneScript;
      spawnIllusion(h, s.IllusionDuration); h.add('invisible', s.Duration); h.add('speedFlat', s.Duration, { v: s.SpeedBoostValue });
      h.specialActive = { t: s.Duration, thief: true, start: game.time }; used = true; break;
    }
    case 'Kunoichi': {
      const s = S.KunoichiSpecial; h.statuses = h.statuses.filter(x => !(x.type === 'shield' && x.equinox));
      h.add('shield', s.Duration, { amount: h.maxHp * s.ShieldPercent, equinox: true });
      fx('ring', h.x, h.y, { r: 0.9, color: '#ff8fc8', t: 0.5 }); floatText(h, 'Equinox', '#ffb3da'); used = true; break;
    }
    case 'Witch': {
      const s = S.WitchSpecialScript, P = s.ProjectileConfig.Settings.BaseProjectileScript.Settings;
      const t = nearestEnemyHero(h.range + 1) || randomEnemy(h.range + 1, [0, 1]); if (!t) return false;
      h.add('casting', s.Duration); h.add('disarm', s.Duration);
      game.projectiles.push({ src: h, x: t.x, y: t.y, follow: t, t: -P.WarningDuration, custom: brambleUpdate, fx: 'bramble', P, ticks: 0, tickT: 0, dmg: dmg * s.DamageCoeff / P.DamageTickCount }); used = true; break;
    }
  }
  if (used) {
    if (h.def.maxSpecialStocks > 1) { if (c !== 'Joker') h.stocks--; } else h.charge = 0;
    if (h.isPlayer) fx('ring', h.x, h.y, { r: 1.1, color: '#ffd36b', t: 0.35 });
    const cs = h.castSeen || (h.castSeen = {}); for (const tm of [1, 2]) if (tm !== h.team && isVisibleTo(h, tm)) cs[tm] = game.time;
    itemsOnSpecialCast(h);
  }
  return used;
}
function recoil(u, ang, d, dur) { u.forced = { vx: Math.cos(ang), vy: Math.sin(ang), left: d, speed: d / dur }; }
function hookUpdate(p, dt) {
  const h = p.src, s = p.s;
  if (!h.alive) { p.done = true; return; }
  if (p.out) {
    const k = clamp(p.t / 0.9, 0, 1); const sp = lerp(25, 0, k);
    p.d += sp * dt; p.x = h.x + Math.cos(p.ang) * p.d; p.y = h.y + Math.sin(p.ang) * p.d;
    const hit = game.units.find(u => u.alive && u.team !== h.team && u.kind === 'hero' && !u.has('untargetable') && Math.hypot(u.x - p.x, u.y - p.y) <= s.HookRadius + u.r);
    if (hit) { p.out = false; const free = ccImmune(hit); if (!free) p.caught = hit; dealDamage(h, hit, p.dmg); if (!free) hit.add('stun', 0.6 + s.PostHookStunDuration); }
    else if (p.d >= s.HookDistance || k >= 1 || !game.map.walkable(Math.floor(p.x), Math.floor(p.y)) && game.map.tileAt(p.x, p.y) === T_WALL) { p.out = false; }
  } else {
    p.d -= 15 * dt;
    if (p.caught && p.caught.alive) { const cd = Math.max(s.ReleaseDistanceFromCaster + h.r, p.d); p.caught.x = h.x + Math.cos(p.ang) * cd; p.caught.y = h.y + Math.sin(p.ang) * cd; }
    p.x = h.x + Math.cos(p.ang) * Math.max(0, p.d); p.y = h.y + Math.sin(p.ang) * Math.max(0, p.d);
    if (p.d <= s.ReleaseDistanceFromCaster + h.r) p.done = true;
  }
}
function arrowUpdate(p, dt) {
  const step = p.speed * dt; p.x += Math.cos(p.ang) * step; p.y += Math.sin(p.ang) * step; p.d += step;
  const P = p.P;
  for (const u of game.units) if (u.alive && u.team !== p.src.team && u.kind === 'hero' && !u.has('untargetable') && !p.hit.has(u) && Math.hypot(u.x - p.x, u.y - p.y) <= P.HitboxRadius + u.r) {
    // DamageCoefficientByDistance (0 -> 6) and StunDurationByDistance (1 -> 8) scale over MaximumDistance; read as a linear ramp
    const k = clamp(p.d / P.MaximumDistance, 0, 1), coeff = Math.max(1, lerp(P.DamageCoefficientByDistance.X, P.DamageCoefficientByDistance.Y, k)), stun = lerp(0.5, 2.5, k);
    dealDamage(p.src, u, p.dmg * coeff); u.add('stun', stun); fx('ring', u.x, u.y, { r: 0.7, color: '#fff6a8', t: 0.4 }); p.done = true; return;
  }
  if (p.d >= P.MaximumDistance || game.map.tileAt(p.x, p.y) === T_WALL) p.done = true;
}
function chainLightning(h, first, P, dmg) {
  const hitList = [first]; let cur = first;
  for (let i = 1; i < P.NumTargets; i++) {
    const nx = game.units.filter(u => u.alive && u.team !== h.team && P.UnitTypes.includes(u.unitType) && !hitList.includes(u) && dist(u, cur) <= P.BounceRange).sort((a, b) => dist(a, cur) - dist(b, cur))[0];
    if (!nx) break; hitList.push(nx); cur = nx;
  }
  let prev = h;
  hitList.forEach((u, i) => {
    const from = prev; prev = u;
    setTimeout0(i * P.TimePerBounce, () => { if (!u.alive) return; dealDamage(h, u, dmg); u.add('stun', P.StunDuration); fx('bolt', from.x, from.y, { x2: u.x, y2: u.y, t: 0.3, color: '#7fe8ff' }); });
  });
}
function castMeteor(h, pos, coeff) {
  const P = HEROES.Sorcerer.scripts.SpecialMeteorScript.ProjectileConfig.Settings.BaseProjectileScript.Settings;
  const dmg = (h.kind === 'hero' ? h.statDmg() : 30) * coeff;
  game.projectiles.push({ src: h, x: pos.x, y: pos.y, t: -(P.WarningDuration + P.FallDuration), custom: (p) => {
    p.done = true; for (const u of game.units) if (u.alive && u.team !== h.team && dist(u, p) <= P.Range + u.r) dealDamage(h, u, dmg);
    fx('boom', p.x, p.y, { r: P.Range, color: '#ff5a8a', t: 0.5, rift: true }); shake(0.25);
  }, warn: P.Range, warnMax: P.WarningDuration + P.FallDuration, fx: 'meteor', fall: P.FallDuration });
}
function laserUpdate(p, dt) {
  const P = p.P; const h = p.src;
  if (!p.fired && p.t >= P.ChargeDelay) {
    p.fired = true; p.showT = P.IdleDuration + P.ShrinkDuration;
    const cx = Math.cos(p.ang), cy = Math.sin(p.ang);
    for (const u of game.units) if (u.alive && u.team !== h.team && P.AffectsUnitTypes.includes(u.unitType)) {
      const dx = u.x - h.x, dy = u.y - h.y, along = dx * cx + dy * cy, perp = Math.abs(-dx * cy + dy * cx);
      if (along > 0 && along < P.Range && perp < P.FullScaleWidth / 2 + u.r) dealDamage(h, u, p.dmg);
    }
    p.x = h.x; p.y = h.y; shake(0.15);
  }
  if (p.fired) { p.showT -= dt; if (p.showT <= 0) p.done = true; }
}
function brambleUpdate(p, dt) {
  const P = p.P; if (p.follow && p.follow.alive && p.ticks === 0) { p.x = p.follow.x; p.y = p.follow.y; }
  p.tickT -= dt;
  if (p.tickT <= 0) {
    p.tickT = P.DamageTickDuration; p.ticks++;
    for (const u of game.units) if (u.alive && u.team !== p.src.team && u.unitType !== UT_TOWER && dist(u, p) <= P.DamageRange + u.r) { dealDamage(p.src, u, p.dmg); u.add('slowPct', 1.0, { v: P.SlowAmount }); }
    if (p.ticks >= P.DamageTickCount) p.done = true;
  }
}
const timers = [];
function setTimeout0(delay, fn) { timers.push({ t: delay, fn }); }
function spawnIllusion(h, dur) {
  const il = new Hero(h.code, h.team, h.x + rand(-0.3, 0.3), h.y + rand(-0.3, 0.3), false, h.name);
  il.isIllusion = true; il.owner = h; il.level = h.level; il.maxHp = h.maxHp; il.hp = h.hp; il.lifeT = dur; il.charge = 0;
  game.units.push(il); fx('ring', il.x, il.y, { r: 0.6, color: '#c49bff', t: 0.4 });
}
let shakeT = 0; function shake(t) { shakeT = Math.max(shakeT, t); addTrauma(t * 2.2); }

// ---------- per-frame special updates ----------
function updateSpecial(h, dt) {
  const sa = h.specialActive; if (!sa) return;
  const S = h.def.scripts;
  if (h.code === 'Barbarian') {
    const s = S.SpecialWhirlwindScript; sa.t -= dt; sa.tick -= dt;
    if (sa.tick <= 0) { sa.tick = s.DamageTickRate; let any = false;
      for (const u of game.units) if (u.alive && u.team !== h.team && s.DamageUnitTypes.includes(u.unitType) && !u.has('untargetable') && dist(u, h) <= s.DamageRadius + u.r) { dealDamage(h, u, h.statDmg() * s.DamageCoefficient); any = true; }
      if (any) heal(h, h.maxHp * s.HealPercent, true); }
    if (sa.t <= 0) h.specialActive = null;
  } else if (h.code === 'Banshee') {
    const s = S.SpecialBallLightningScript; sa.t -= dt;
    for (const u of game.units) if (u.alive && u.team !== h.team && s.DamageUnitTypes.includes(u.unitType) && !sa.hit.has(u) && dist(u, h) <= s.Radius + u.r) { sa.hit.add(u); dealDamage(h, u, h.statDmg() * s.DamageCoefficient); fx('hit', u.x, u.y, { color: '#b77bff', t: 0.25, big: true }); }
    if (sa.t <= 0) { h.specialActive = null; if (!game.map.free(h.x, h.y, h.r)) unstick(h); }
  } else if (h.code === 'Frog') {
    const s = sa.s; sa.t += dt;
    const air0 = s.PreJumpDuration + s.JumpDuration, airEnd = air0 + s.InAirDuration;
    if (!sa.inAir && sa.t >= s.PreJumpDuration) { sa.inAir = true; h.add('untargetable', 99, { frog: true }); }
    if (sa.inAir && !sa.landing && (sa.t >= airEnd || (sa.landNow && sa.t > air0))) { sa.landing = true; sa.landT = s.LandDuration; }
    if (sa.landing) { sa.landT -= dt; if (sa.landT <= 0) {
      h.statuses = h.statuses.filter(x => !(x.type === 'untargetable' && x.frog));
      if (!game.map.free(h.x, h.y, h.r)) unstick(h);
      for (const u of game.units) if (u.alive && u.team !== h.team && s.DamageUnitTypes.includes(u.unitType) && dist(u, h) <= s.DamageRange + u.r) dealDamage(h, u, h.statDmg() * s.DamageCoefficient);
      fx('boom', h.x, h.y, { r: s.DamageRange, color: '#9dff7a', t: 0.45 }); shake(0.2); h.add('casting', s.PostLandDuration); h.specialActive = null; } }
  } else if (h.code === 'Thief') {
    sa.t -= dt;
    if (!h.has('invisible') || sa.t <= 0) { // reappear: instant special auto attack with bonus based on time spent invisible
      const s = S.SpecialCloneScript; h.statuses = h.statuses.filter(x => x.type !== 'invisible');
      h.thiefBonus = s.MaximumBonusDamageOnNextAttack * clamp((game.time - sa.start) / s.Duration, 0, 1); h.specialActive = null;
      const t = enemiesInRange(h, h.range)[0]; if (t) { autoAttack(h, t); h.atkTimer = 0; }
    }
  } else if (h.code === 'Joker') {
    if (h.stocks <= 0 && !sa.ending) { sa.ending = true; sa.endT = S.SpecialJackInTheBoxScript.PostSpecialDuration; }
    if (sa.ending) { sa.endT -= dt; if (sa.endT <= 0) h.specialActive = null; }
  }
}
function unstick(u) {
  for (let r = 0.5; r < 6; r += 0.5) for (let a = 0; a < 16; a++) {
    const x = u.x + Math.cos(a / 16 * Math.PI * 2) * r, y = u.y + Math.sin(a / 16 * Math.PI * 2) * r;
    if (game.map.free(x, y, u.r)) { u.x = x; u.y = y; return; }
  }
}

// ---------- movement ----------
function speedOf(u) {
  if (u.kind === 'tower') return 0;
  let base = u.kind === 'hero' ? u.def.speed : u.def.speed, flat = 0, pct = 0;
  for (const s of u.statuses) { if (s.type === 'slowFlat' || s.type === 'speedFlat') flat += s.v; if (s.type === 'slowPct' || s.type === 'speedPct') pct += s.v; }
  if (u.kind === 'hero' && hasItem(u.isIllusion ? u.owner : u, 'MoveSpeed')) pct += iv('MoveSpeed', 'ValuePerLevel');
  if (u.kind === 'hero' && u.code === 'Brawler' && !u.inCombat(game.time)) flat += u.def.scripts.BrawlerPassiveOutOfCombatSpeedBuffScript.SpeedBuff;
  if (u.kind === 'hero' && equinoxOn(u)) pct += u.def.scripts.KunoichiSpecial.MoveSpeed;
  if (u.kind === 'hero' && u.specialActive && u.specialActive.inAir) return u.def.scripts.FrogSpecialLeapScript.InAirMoveSpeed;
  return clamp((base + flat) * (1 + pct), 0.5, 6);
}
function canAct(u) { return !u.has('stun') && !u.forced; }
function moveUnit(u, dx, dy, dt) {
  if (!dx && !dy) return;
  const sp = speedOf(u), m = Math.hypot(dx, dy); dx /= Math.max(1, m); dy /= Math.max(1, m);
  const nx = u.x + dx * sp * dt, ny = u.y + dy * sp * dt;
  const ghost = u.has('ghost') || (u.specialActive && u.specialActive.inAir);
  const ok = (x, y) => ghost ? (x > 0.3 && y > 0.3 && x < game.map.w - 0.3 && y < game.map.h - 0.3) : game.map.free(x, y, u.r);
  const ox = u.x, oy = u.y;
  if (ok(nx, ny)) { u.x = nx; u.y = ny; } else if (ok(nx, u.y)) u.x = nx; else if (ok(u.x, ny)) u.y = ny;
  const moved = Math.hypot(u.x - ox, u.y - oy);
  if (moved > 0) { if (!(u.aimT > game.time)) u.facing = Math.atan2(dy, dx); u.walkT = (u.walkT || 0) + moved; }
  if (u.kind === 'hero') { u.distMoved += moved; if (u.code === 'Banshee' && !u.specialActive) {
    u.bansheeAcc = (u.bansheeAcc || 0) + moved;
    // Restless: one charge per RON_CHARGE_TILES walked (was DistancePerCharge / 6 = 1.7 tiles, so a human walking around got Darkslide every few seconds)
    while (u.bansheeAcc >= RON_CHARGE_TILES) { u.bansheeAcc -= RON_CHARGE_TILES; u.charge = Math.min(u.def.maxSpecialCharges, u.charge + 1); } } }
}
function updateForced(u, dt) {
  const f = u.forced; if (!f) return;
  if (f.home) { const t = f.home, d = dist(u, t); // a charge steers after its target and stops on contact
    if (!t.alive || d <= u.r + t.r + 0.1) f.left = 0; else { f.vx = (t.x - u.x) / d; f.vy = (t.y - u.y) / d; } }
  const step = Math.min(f.left, f.speed * dt); const nx = u.x + f.vx * step, ny = u.y + f.vy * step;
  if (f.ghost || game.map.free(nx, ny, u.r)) { u.x = nx; u.y = ny; f.left -= step; }
  else if (f.home && game.map.free(nx, u.y, u.r)) { u.x = nx; f.left -= step; } else if (f.home && game.map.free(u.x, ny, u.r)) { u.y = ny; f.left -= step; } // slide along a wall
  else f.left = 0;
  if (f.left <= 1e-3) { u.forced = null; if (f.ghost && !game.map.free(u.x, u.y, u.r)) unstick(u); f.onEnd && f.onEnd(); }
}
function separate() {
  // towers are solid: push units out, with a sideways bias so walking straight into one slides around it
  for (const t of game.units) if (t.kind === 'tower' && t.alive) for (const u of game.units) {
    if (!u.alive || u.kind === 'tower' || u.has('ghost')) continue;
    const d = dist(t, u), min = t.r + u.r; if (d >= min) continue;
    let nx = (u.x - t.x) / (d || 1), ny = (u.y - t.y) / (d || 1); const side = (u.x >= t.x ? 1 : -1);
    nx += -ny * side * 0.6; ny += nx * side * 0.0; const m = Math.hypot(nx, ny) || 1; const px = u.x + nx / m * (min - d + 0.01), py = u.y + ny / m * (min - d + 0.01);
    if (game.map.free(px, py, u.r)) { u.x = px; u.y = py; }
  }
  const mob = game.units.filter(u => u.alive && u.kind !== 'tower' && !u.has('ghost') && !(u.specialActive && u.specialActive.inAir));
  for (let i = 0; i < mob.length; i++) for (let j = i + 1; j < mob.length; j++) {
    const a = mob[i], b = mob[j], d = dist(a, b), min = (a.r + b.r) * 0.9;
    if (d < min && d > 1e-4) { const push = (min - d) / 2, nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;
      if (game.map.free(a.x - nx * push, a.y - ny * push, a.r)) { a.x -= nx * push; a.y -= ny * push; }
      if (game.map.free(b.x + nx * push, b.y + ny * push, b.r)) { b.x += nx * push; b.y += ny * push; } }
  }
}
function checkJumpPad(u) {
  if (u.forced || u.kind === 'tower') return;
  const tx = Math.floor(u.x), ty = Math.floor(u.y);
  if (game.map.tile(tx, ty) !== T_JUMP) return;
  const jp = game.map.jumpPads.find(j => j.x === tx && j.y === ty); if (!jp) return;
  const len = Math.hypot(jp.vx, jp.vy);
  u.forced = { vx: jp.vx / len, vy: jp.vy / len, left: len + 0.8, speed: jp.speed / 2, jump: true, ghost: true };
  u.add('ghost', (len + 0.8) / (jp.speed / 2)); u.add('jumping', (len + 0.8) / (jp.speed / 2));
}

// ---------- attacking ----------
// AttackSpeedBuff -0.3 is read as 30 % less time between shots in the box (Rickard's choice, 2026-10-07)
function attackCd(u) { return u.kind === 'hero' ? u.statCd() * (u.specialActive && u.specialActive.joker ? 1 + HEROES.Joker.scripts.SpecialJackInTheBoxScript.AttackSpeedBuff : 1) : u.def.cd; }
function updateAttack(u, dt) {
  if (!u.alive || u.kind === 'tower' && game.state !== 'play') return;
  if (u.attackAnim > 0) u.attackAnim -= dt;
  if (u.has('stun') || u.has('disarm') || u.has('invisible') && !u.isIllusion) return;
  if (u.kind === 'hero' && u.specialActive && (u.specialActive.inAir || u.code === 'Barbarian' || u.code === 'Banshee')) return;
  const cd = attackCd(u);
  u.atkTimer += dt;
  if (u.atkTimer < cd) return;
  const range = u.kind === 'hero' ? u.range : u.def.range;
  let targets = enemiesInRange(u, range);
  let tgt = null;
  if (u.kind === 'tower') {
    if (u.target && (!u.target.alive || dist(u, u.target) > range + u.target.r || !isVisibleTo(u.target, u.team))) u.target = null;
    if (!u.target) { const pref = targets.filter(t => t.unitType === UT_MINION); const l = pref.length ? pref : targets; u.target = l.sort((a, b) => dist(u, a) - dist(u, b))[0] || null; }
    tgt = u.target;
  } else if (u.kind === 'minion') {
    tgt = targets.sort((a, b) => dist(u, a) - dist(u, b))[0];
  } else {
    tgt = targets.length ? pick(targets) : null; // "Targets are chosen randomly!"
  }
  if (tgt) {
    autoAttack(u, tgt); u.atkTimer = 0;
    if (u.kind === 'tower' && u.has('volley')) targets.filter(o => o !== tgt).sort((a, b) => dist(u, a) - dist(u, b)).slice(0, ID.TowerAdditionalAttackTargets.AdditionalAttackTargets).forEach(o => autoAttack(u, o));
    if (u.kind === 'hero' && u.code === 'Joker' && u.specialActive) { u.stocks = Math.max(0, u.stocks - 1); }
  } else if (u.kind === 'hero' && u.code === 'Joker' && u.specialActive && u.specialActive.joker && !u.isIllusion) {
    u.atkTimer = 0; u.stocks = Math.max(0, u.stocks - 1); u.expireFx = 0.25; // a shot with no target is still spent, so the box closes (Rickard's choice)
  } else if (u.kind === 'hero' && !u.def.holdAttack) {
    u.atkTimer = 0; // the attack expires
    if (u.code === 'Automaton' && !u.isIllusion) u.overload = Math.min(4, u.overload + 1);
    u.expireFx = 0.25;
  } else u.atkTimer = cd;
}

// ---------- AI ----------
// Bot brain modelled on BehaviorTreeBrainScriptAsset and its leaf nodes:
// EscapeDanger (IsEntityInDanger / GetTimeToKillEntity / GetLeastDangerousPositionOnSquare), PlaySafe (IsLowHealth,
// FindRetreatPath), TargetEnemyPawn (ChaseableHeroes, LeafTargetClosestSaveableAllyInDanger, NeedsToRetreatFromTarget),
// TargetEnemyTower (CheckOwnerShouldTargetEnemyTower), TargetFrontline (IsOwnerOnSafeSideOfFrontline) and
// GetAvoidanceVectorForEnemyProjectiles. Every number comes from the tier's BehaviorTreeSharedVariablesConfig.
// Per-special AI values from the hero configs (not carried in gamedata.js):
const AI_SPECIAL = {
  Barbarian: { targetRange: 4, minEnemies: 3, heroWeight: 1 },          // AiTargetRange, AiMinEnemyCountRequired, AiEnemyHeroWeight
  Frog: { heroScore: 3, defaultScore: 1, defensiveTtk: 1.0, reactivationRadiusRatio: 0.5 },
  // ROI17 bots ult into fights the way Rickard does (his recorded match, 2026-10-07)
  Joker: { minPawnsAtMaxCharges: 4, minHp: 0.6, fightRange: 7, minStocks: 4 },
  Thief: { distanceToReactivate: 1.0 },
  Witch: { minHeroRatio: 0.5, minHeroRatioDefending: 0 },
};
// a 65 % HP disengage rule from Rickard's recorded matches was tested 2026-10-07 and dropped: bots went 0/10 instead of 3/10
const PLAYSTYLE = { soakMinHp: 0.7, soakAllyHp: 0.45 };
// heroes built to go in alone (Rickard: Bronson and Omega are clear divers): accept worse trades and reach further
const DIVERS = { Brawler: { fightRatio: 0.35, reach: 1.5 }, Thief: { fightRatio: 0.35, reach: 1.5 } };
const CAREFUL = { Joker: { line: 0.06, back: 0.6, keep: 0.95, boxKeep: 5.5 } }; // ROI17 plays further back (Rickard 2026-10-10): as a turret he can't move and died 6.4 times a match, now 5.0 (38 -> 48 %); the same for Silver lost 41 -> 35 %, so he is left out
function jokerBoxReady(h) { // ROI17 only opens the box with HP and shots to spare and when his side is not outnumbered: as a turret he can't run
  const A = AI_SPECIAL.Joker; if (h.specialActive || h.stocks < A.minStocks || h.hp / h.maxHp < A.minHp) return false;
  const foes = heroes().filter(u => u.alive && u.team !== h.team && !u.isIllusion && isVisibleTo(u, h.team) && dist(u, h) < 9).length;
  return foes <= heroes().filter(a => a.alive && a.team === h.team && !a.isIllusion && dist(a, h) < 9).length;
}
// bushes hide a hero from enemies further than grassVisibilityRange: bots regen, wait and ambush in them like Rickard (39 % of his match in bushes)
function bushTiles() {
  const m = game.map; if (m._bushes) return m._bushes; m._bushes = [];
  for (let ty = 0; ty < m.h; ty++) for (let tx = 0; tx < m.w; tx++) if (m.tile(tx, ty) === T_GRASS) m._bushes.push({ x: tx + 0.5, y: ty + 0.5 });
  return m._bushes;
}
// best hidden bush tile within maxD of `near`: no enemy close enough to see into it, out of the enemy tower, cheap to reach
function bushSpot(h, near, maxD, enemyTower, clear = 0) {
  let best = null, bs = 1e9;
  for (const b of bushTiles()) {
    const dn = dist(b, near); if (dn > maxD || !game.map.free(b.x, b.y, h.r)) continue;
    if (enemyTower && enemyTower.alive && dist(b, enemyTower) < enemyTower.def.range + 0.5) continue;
    if (game.units.some(u => u.alive && u.team !== h.team && u.kind !== 'tower' && dist(u, b) < Math.max(MATCH.grassVisibilityRange + 0.5, clear))) continue;
    const s = dist(h, b) + dn * 0.5 + incomingDps(h, b) * 3;
    if (s < bs) { bs = s; best = b; }
  }
  return best;
}
// star advantage for h's team minus the enemy's (-3..3): press when ahead, hold when behind (Rickard)
const starDiff = h => game.stars && !game.noStars ? (game.stars[h.team] || 0) - (game.stars[h.team === 1 ? 2 : 1] || 0) : 0;
// roles: tanks stand at the front, Pearl looks after the teammate taking hits
const TANKS = { Barbarian: 1, Paladin: 1, Angler: 1 };
// harass: a hero that outranges its target stands where it can hit but cannot be hit back (Rickard)
const outranges = (h, e) => h.range > e.range + 0.8;
const harassKeep = (h, e) => Math.max(h.range * 0.6, Math.min(h.range + e.r - 0.15, e.range + e.r + h.r + 0.6));
// worth following a hero that just vanished into a bush: it was low, we are healthy, and we would not walk into its friends or tower
function wantsBushChase(h, seen, enemyTower) {
  const e = seen.u, low = e.hp / e.maxHp < 0.35 || (e.hp + shieldOf(e)) / Math.max(1, dpsOf(h)) < 2.5;
  if (!low || h.hp / h.maxHp < 0.5 || game.time - seen.t > 3 || dist(h, seen) > 7) return false;
  if (h.range >= 3.4 && !DIVERS[h.code] && e.hp / e.maxHp > 0.2) return false; // ranged heroes only dive a bush for an almost-dead target
  if (enemyTower && enemyTower.alive && dist(seen, enemyTower) < enemyTower.def.range + 1) return false;
  const foes = heroes().filter(u => u.alive && u !== e && u.team !== h.team && (isVisibleTo(u, h.team) ? dist(u, seen) < 6 : (m => m && dist(m, seen) < 6)(remembered(u, h.team)))).length; // two waiting in the bush stop the chase
  const mates = heroes().filter(a => a.alive && a !== h && a.team === h.team && dist(a, h) < 6).length;
  const missing = unaccounted(h, e); if (missing >= 2 || missing && SUSPICION[botTier(h)] > 0.5 && foes + 1 > mates) return false; // the whole team gone quiet: likely a trap
  return foes <= mates && bushTiles().some(b => dist(b, seen) < 2);
}
// human touches (Riot's LoL bot blog, UT^2 BotPrize bot, "intelligent mistakes"): bots dodge only some skillshots, each has a temperament,
// reacts faster under pressure, and every tier now and then makes a plausible mistake instead of the best move (Platinum only misreads fights)
// (grudges against the last hero that hit us were tried 2026-10-08 and dropped: they pulled bots off the target the team should kill)
const DODGE_CHANCE = { Bronze: 0.25, Silver: 0.45, Gold: 0.6, Platinum: 0.75 };
const MISTAKE_CHANCE = { Bronze: 0.3, Silver: 0.15, Gold: 0.06, Platinum: 0.02 }; // Platinum's rare mistake is a misread fight, never a silly walk (Rickard 2026-10-08)
const PANIC_SPECIAL = { Bronze: 0.35, Silver: 0.2 }; // under 15 % HP in a fight, low tiers sometimes fire their special in panic
// bait suspicion (colleagues' review): how much of a trap's warning signs each tier picks up; the top stays under 0.8 so Platinum can still be fooled
const SUSPICION = { Bronze: 0.1, Silver: 0.45, Gold: 0.65, Platinum: 0.75 };
// soaking hits for a teammate takes game sense: how much of the soak value each tier sees (Bronze never soaks)
const SOAK = { Silver: 0.5, Gold: 0.8, Platinum: 1 };
// a skillshot is only dodged once the bot has noticed it (reaction delay), so shots fired from close up land more often
// lower tiers step aside for too short a time instead of stepping the wrong way (stepping into a shot looked buggy, friends' review)
const DODGE_REACT = { Bronze: 0.4, Silver: 0.3, Gold: 0.22, Platinum: 0.16 }, DODGE_STEP = { Bronze: 0.15, Silver: 0.25, Gold: 0.4, Platinum: 9 };
// how far ahead bots aim their skillshots at a moving hero (0 = where it stands now, 1 = exactly where it will be), plus aim noise in tiles
const AIM_LEAD = { Bronze: 0.2, Silver: 0.5, Gold: 0.75, Platinum: 0.9 }, AIM_NOISE = { Bronze: 0.7, Silver: 0.5, Gold: 0.35, Platinum: 0.25 };
const MEMORY_T = 4; // seconds a team keeps an enemy hero in mind after losing sight of it
const botTier = h => tierName((h.team === PLAYER_TEAM && game.allyBot) || BOT);
// enemy heroes of e's team that h's team can neither see nor remember: they could be anywhere, a bush included
const unaccounted = (h, e) => heroes().filter(u => u.alive && u !== e && u.team === e.team && !u.isIllusion && !isVisibleTo(u, h.team) && !remembered(u, h.team)).length;
// how much a low enemy running away from us smells like bait, 0..1 (colleagues' review): built from where and when its teammates
// were last seen and whether they could be waiting where it runs, not from knowing; under 0.3 chase as normal, 0.3-0.55 chase shorter,
// 0.55-0.75 keep more distance, above 0.75 let it go
function baitCheck(h, e) {
  if (!e.mo || e.hp / e.maxHp > 0.35 || Math.hypot(e.mo.vx, e.mo.vy) < 1 || (e.x - h.x) * e.mo.vx + (e.y - h.y) * e.mo.vy <= 0) return 0;
  const sp = Math.hypot(e.mo.vx, e.mo.vy), ahead = { x: e.x + e.mo.vx / sp * 3, y: e.y + e.mo.vy / sp * 3 }; // where it is heading
  let s = 0;
  for (const u of heroes()) {
    if (!u.alive || u === e || u.team !== e.team || u.isIllusion || isVisibleTo(u, h.team)) continue; // visible helpers are the safety check's job
    const m = u.lastSeen && u.lastSeen[h.team];
    if (!m) { s += 0.2; continue; } // never seen: could be anywhere
    const age = game.time - m.t, could = dist(m, ahead) - speedOf(u) * age; // how far it would still be from where our target runs
    s += could < 2 ? (age < 1.5 ? 0.35 : 0.25) : could < 6 ? 0.12 : 0.03; // vanished right next to its path: very fishy; far away on the other side: hardly
  }
  if (bushTiles().some(b => dist(b, ahead) < 2)) s += 0.15; // running for a bush
  if (heroes().filter(u => u.alive && u.team === e.team && !u.isIllusion && isVisibleTo(u, h.team) && dist(u, h) < 8).length > heroes().filter(a => a.alive && a.team === h.team && !a.isIllusion && dist(a, h) < 8).length) s += 0.15;
  if (h.hp / h.maxHp < 0.4) s += 0.15;
  const ai = h.ai; if (!(ai.sus && ai.sus.u === e && game.time < ai.sus.t)) ai.sus = { u: e, t: game.time + 5, j: rand(-0.12, 0.12) }; // a personal read of the same picture, kept for a while
  return clamp(s * (SUSPICION[botTier(h)] || 0) + ai.sus.j, 0, 1);
}
// three stars (the most a team can hold): protect the lead instead of risking it
// one roll per teammate every 4 s: does this bot have the presence of mind to stand in for them?
// worth standing in for teammate a? how close a is to dying, whether we can take the hits, what we leave behind; each tier sees part of it
const soakValue = (h, a) => clamp(1 - ttkAt(a, a) / 4, 0, 1) + (h.hp / h.maxHp - 0.5) - dist(a, h) / 6 + (TANKS[h.code] ? 0.2 : 0) - (h.ai.focus && h.ai.focus.alive && h.ai.focus.hp / h.ai.focus.maxHp < 0.25 ? 0.3 : 0);
const soakWilling = (h, a) => { const m = h.ai.soakR || (h.ai.soakR = new Map()); let r = m.get(a); if (!r || game.time > r.t) m.set(a, r = { t: game.time + 4, j: rand(-0.2, 0.2) }); return soakValue(h, a) * (SOAK[botTier(h)] || 0) + r.j > 0.45; };
const protectLead = h => !!(game.stars && !game.noStars && GD.starAdvantage && (game.stars[h.team] || 0) >= GD.starAdvantage.length);
// smoothed velocity of every hero, and where each team last saw it (prediction and memory, friends' review 2026-10-08)
function trackMotion(u, dt) {
  const m = u.mo || (u.mo = { x: u.x, y: u.y, vx: 0, vy: 0 });
  if (dt > 0) { const k = Math.min(1, dt / 0.25); let vx = (u.x - m.x) / dt, vy = (u.y - m.y) / dt; const sp = Math.hypot(vx, vy);
    if (sp > 9) { vx = 0; vy = 0; } // a teleport or respawn, not a walk
    m.vx += (vx - m.vx) * k; m.vy += (vy - m.vy) * k; }
  m.x = u.x; m.y = u.y;
  const ls = u.lastSeen || (u.lastSeen = {});
  for (const tm of [1, 2]) if (tm !== u.team && isVisibleTo(u, tm)) ls[tm] = { x: u.x, y: u.y, t: game.time };
}
// where a team remembers an unseen enemy hero, if it lost sight of it recently
const remembered = (e, team) => { const m = e.lastSeen && e.lastSeen[team]; return m && game.time - m.t < MEMORY_T ? m : null; };
// does h's team know e's special is down? only if they saw it used (a cast seen within 8 s); otherwise assume it is ready
// how sure h's team is that e's special is down, from what they saw: sure for 3 s, then less and less, assumed ready after 8 s
const spentCert = (h, e) => { const t = e.castSeen && e.castSeen[h.team]; if (t === undefined) return 0; const age = game.time - t; return age < 3 ? 1 : age < 8 ? 1 - (age - 3) / 5 : 0; };
// bots lead a moving hero: aim where it will be after flight seconds, scaled by tier, with a little human error
function leadAim(h, t, flight) {
  if (h.isPlayer || h.remote || !h.ai || t.kind !== 'hero' || !t.mo) return { x: t.x, y: t.y };
  const tn = botTier(h), k = (AIM_LEAD[tn] || 0.5) * rand(0.8, 1.15), n = AIM_NOISE[tn] || 0.5;
  let ft = flight(dist(h, t));
  for (let i = 0; i < 2; i++) ft = flight(Math.hypot(t.x + t.mo.vx * ft * k - h.x, t.y + t.mo.vy * ft * k - h.y));
  return { x: t.x + t.mo.vx * ft * k + rand(-n, n) * 0.5, y: t.y + t.mo.vy * ft * k + rand(-n, n) * 0.5 };
}
const tierName = B => Object.keys(GD.botTiers).find(k => GD.botTiers[k] === B) || 'Bronze';
function temperament(h) { const ai = h.ai; if (ai.bold === undefined) { ai.bold = rand(-1, 1); ai.dodge = new WeakMap(); } return clamp(ai.bold + clamp(((h.kills || 0) - (h.deaths || 0)) * 0.1, -0.5, 0.5), -1, 1); } // who it is, nudged by how its match is going
// where Bronson wants to knock a target: his heroes near it, else his own tower
function bronsonHome(h, t) {
  const near = heroes().filter(a => a.alive && a !== h && a.team === h.team && dist(a, t) < 8);
  if (near.length) return { x: near.reduce((a, o) => a + o.x, 0) / near.length, y: near.reduce((a, o) => a + o.y, 0) / near.length };
  const ot = towerOf(h.team); return ot || h;
}
const AFK_MAX = 3, AFK_EXP = 5, REACTION_OFFSET = 0.1; // MaxStartAfkTime, AfkTimeExponant, ReactionTimeRandomOffset
const dpsOf = u => u.kind === 'hero' ? u.statDmg() / u.statCd() : u.def.dmg / u.def.cd;
const shieldOf = u => u.statuses.reduce((a, s) => a + (s.type === 'shield' ? s.amount : 0), 0);
function laneTarget(team) {
  // front-most allied minion (the team's frontline), else enemy tower
  const ms = game.units.filter(u => u.alive && u.kind === 'minion' && u.team === team);
  const dir = team === PLAYER_TEAM ? 1 : -1;
  if (ms.length) return ms.reduce((a, b) => (b.y * dir > a.y * dir ? b : a));
  return towerOf(team === 1 ? 2 : 1);
}
// allied minions standing inside the enemy tower's range soak its shots (the tower prefers minions and keeps its target)
function towerTank(tower, team) {
  if (!tower || !tower.alive) return 0;
  return game.units.reduce((a, u) => a + (u.alive && u.kind === 'minion' && u.team === team && dist(u, tower) < tower.def.range + u.r - 0.15 ? u.hp : 0), 0);
}
// damage per second h would take standing at pos (GetTimeToKillEntityAtPosition)
const shieldsNear = (h, e) => game.units.reduce((n, u) => n + (u !== h && u.alive && u.team === h.team && u.kind !== 'tower' && !u.has('untargetable') && dist(u, e) <= e.range + u.r ? 1 : 0), 0);
// specials that reach far past the hero's attack range (Rickard: plan for Silver's laser and Bufo's hook)
function specialReach(e) {
  const S = e.def.scripts;
  if (e.code === 'Marksman') return S.SpecialLaserScript.ProjectileConfig.Settings.BaseProjectileScript.Settings.Range;
  if (e.code === 'Angler') return S.SpecialHookScript.HookDistance;
  if (e.code === 'Archer') return S.SpecialMagicArrowScript.ProjectileConfig.Settings.BaseProjectileScript.Settings.MaximumDistance;
  return 0;
}
function incomingDps(h, pos) {
  let dps = 0;
  for (const e of game.units) {
    if (!e.alive || e.team === h.team || e.kind === 'illusionDead') continue;
    const d = Math.hypot(e.x - pos.x, e.y - pos.y);
    if (e.kind === 'hero') {
      if (e.has('stun')) continue;
      let w = 1, d2 = d;
      if (!isVisibleTo(e, h.team) && !e.isIllusion) { const m = remembered(e, h.team); if (!m) continue; w = 0.7; d2 = Math.hypot(m.x - pos.x, m.y - pos.y) - 1; } // it went into a bush near here a moment ago
      if (w < 1) { if (d2 <= e.range + h.r + 1.5) dps += dpsOf(e) * w; continue; }
      // heroes pick targets at random among everything in range, so allies and minions around us soak a share (Rickard's shield idea)
      if (d <= e.range + h.r + Math.min(1.5, speedOf(e) * 0.6)) dps += dpsOf(e) / (1 + shieldsNear(h, e));
      else if (d <= specialReach(e) + h.r) dps += dpsOf(e) * 0.75 * (1 - spentCert(h, e)); // a long-range special still reaches us unless we saw it used
      if (e.code === 'Witch' && d <= e.range + 1 + h.r) dps += dpsOf(e) * 0.75 * (1 - spentCert(h, e)); // Ginette's bramble slows 75 % and keeps hurting: walking into her range with it ready is a trap
    } else if (e.kind === 'tower') {
      if (d <= e.def.range + h.r + 0.3 && (e.target === h || towerTank(e, h.team) < 30)) dps += dpsOf(e);
    } else if (d <= e.def.range + h.r + 0.3) dps += dpsOf(e) * 0.5; // minions spread their hits
  }
  return dps;
}
const ttkAt = (h, pos) => { const d = incomingDps(h, pos); return d > 0 ? (h.hp + shieldOf(h)) / d : 99; };
function safestSpot(h) {
  const own = towerOf(h.team); let best = null, bs = 1e9;
  for (const r of [1.5, 3]) for (let a = 0; a < 12; a++) {
    const p = { x: h.x + Math.cos(a * Math.PI / 6) * r, y: h.y + Math.sin(a * Math.PI / 6) * r };
    if (!game.map.free(p.x, p.y, h.r)) continue;
    const s = incomingDps(h, p) * 3 + (own ? dist(p, own) * 0.25 : 0);
    if (s < bs) { bs = s; best = p; }
  }
  return best;
}
// sidestep skillshots and ground warnings within ProjectilesAvoidanceRange
function dodgeVector(h, B) {
  const R = B.ProjectilesAvoidanceRange; let vx = 0, vy = 0;
  const ai = h.ai, tn = tierName(B), chance = DODGE_CHANCE[tn] || 0.5; temperament(h);
  for (const p of game.projectiles) {
    if (!p.src || p.src.team === h.team) continue;
    // read the shot or miss it, once per projectile; a read shot is acted on only after a reaction delay, so close-range shots tend to land
    if (!ai.dodge.has(p)) ai.dodge.set(p, Math.random() < chance ? { at: game.time + (DODGE_REACT[tn] || 0.3) * rand(0.8, 1.25), len: (DODGE_STEP[tn] || 0.3) * rand(0.8, 1.25) } : null);
    const dg = ai.dodge.get(p); if (!dg || game.time < dg.at) continue;
    if (p.custom === brambleUpdate) { // a bramble patch: once noticed, keep walking out of it (it slows, so this takes a while)
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (p.t >= 0 && d < p.P.DamageRange + h.r + 0.2) { vx += (h.x - p.x) / (d || 1); vy += (h.y - p.y) / (d || 1); }
      continue;
    }
    if (game.time > dg.at + dg.len) continue;
    const line = (p.custom === hookUpdate && p.out) || p.custom === arrowUpdate || (p.custom === laserUpdate && !p.fired);
    if (line) {
      const o = p.custom === laserUpdate ? p.src : p, cx = Math.cos(p.ang), cy = Math.sin(p.ang), dx = h.x - o.x, dy = h.y - o.y;
      const along = dx * cx + dy * cy, perp = -dx * cy + dy * cx;
      const w = p.custom === laserUpdate ? p.P.FullScaleWidth / 2 : p.custom === hookUpdate ? p.s.HookRadius : p.P.HitboxRadius;
      const len = p.custom === laserUpdate ? p.P.Range : R;
      if (along > -0.3 && along < Math.min(R, len) && Math.abs(perp) < w + h.r + 0.35) { let side = perp >= 0 ? 1 : -1; if (!game.map.free(h.x - cy * side * 0.6, h.y + cx * side * 0.6, h.r)) side = -side; vx += -cy * side; vy += cx * side; } // a wall on that side: go the other way
    } else if (p.warn) { // meteor marker on the ground
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d < p.warn + h.r + 0.3 && d < R) { vx += (h.x - p.x) / (d || 1); vy += (h.y - p.y) / (d || 1); }
    }
  }
  return vx || vy ? { x: vx, y: vy } : null;
}
// choose the enemy hero worth fighting (ChaseableHeroes + saveable allies), or null
function pickHeroTarget(h, B, enemyTower, myDps) {
  const now = game.time, allies = heroes().filter(a => a.alive && a.team === h.team && a !== h);
  const tank = towerTank(enemyTower, h.team);
  let best = null, bs = -1e9; h.ai.urgent = false; const sd = starDiff(h), bold = temperament(h);
  for (const e of game.units) {
    if (!e.alive || e.team === h.team || e.kind !== 'hero' || e.has('untargetable') || !isVisibleTo(e, h.team)) continue;
    const d = dist(h, e), low = e.hp / e.maxHp < 0.35;
    const teamDps = myDps + allies.reduce((a, o) => a + (dist(o, e) < o.range + 2 ? dpsOf(o) : 0), 0), ttk = (e.hp + shieldOf(e)) / teamDps;
    const hitMe = h.lastHitBy.has(e) && now - h.lastHitBy.get(e) < 1.5 || game.time - h.lastCombat < 1 && d < e.range + 0.5;
    const saving = allies.some(a => dist(a, e) < e.range + 1 && now - a.lastCombat < 1.5 && a.hp / a.maxHp < 0.6);
    // a teammate has the enemy low: come help finish it, the kill buffs the whole team through the star meter (Rickard)
    const assist = low && [...e.lastHitBy.entries()].some(([a, t]) => a.team === h.team && a !== h && now - t < 2.5);
    // a teammate has gone in on this hero (the player too): follow the engage instead of watching from behind
    // ...but only when we get there in time; whether the fight is winnable is still checked below, just with a softer bar (colleagues: don't follow blindly)
    const eng = !assist && d < 9 ? [...e.lastHitBy.entries()].find(([a, t]) => a.team === h.team && a !== h && a.kind === 'hero' && a.alive && now - t < 1.5 && a.hp / a.maxHp > 0.35 && dist(a, e) < e.range + 2) : null;
    const eta = Math.max(0, d - h.range) / Math.max(1, speedOf(h)); // seconds until we can hit it
    const engaged = !!eng && (eta < 0.9 || eta < 3.5 && (eta < ttkAt(eng[0], eng[0]) || e.hp / e.maxHp < 0.2)); // worth going: we arrive before our teammate drops, or the target is nearly dead
    const sus = B.SafetyMargin && low && !hitMe && !saving ? baitCheck(h, e) : 0, bait = sus > 0.3, wary = sus > 0.55;
    if (sus > 0.75) continue; // too obvious: let it go
    const guard = protectLead(h) && !hitMe && !saving; // 3 stars: no deep chases, no tower dives, pickier fights
    const committed = e === h.ai.focus && h.ai.commitT > now; // we went in on it a moment ago: see it through before thinking again
    const behind = Math.max(0, -sd - 1) * 0.5; // a team behind on stars goes looking for picks, a little more per star
    const dive = DIVERS[h.code], reach = behind + h.range + B.RoamingRadius + (dive ? dive.reach : 0) + (B.CanChaseLowHealthTargets && low && !bait && !guard ? 3 : 0) + (assist ? (wary ? 2 : 5) : 0) + (engaged ? 4 : 0) + (B.SafetyMargin && outranges(h, e) ? 1.5 : 0) + bold * 0.8 + (low && h.ai.overchase && !bait ? 2.5 : 0) + (hitMe ? 1 : 0) + (saving ? 2 : 0) - (guard ? 1.5 : 0);
    if (d > reach) continue;
    const underTower = enemyTower && enemyTower.alive && dist(e, enemyTower) < enemyTower.def.range + 0.5;
    if (underTower && (B.SafetyMargin || h.hp / h.maxHp < 0.5) && tank < 60 && ttk > B.TimeToKillTowerDiveThreshold) continue;
    if (underTower && guard && tank < 25) continue;
    // don't walk into a fight we lose: compare how fast we die where we'd stand with how fast the target dies
    const harass = B.SafetyMargin && outranges(h, e), sk = harass ? harassKeep(h, e) : h.range * 0.85;
    if (B.SafetyMargin) { const spot = { x: e.x + (h.x - e.x) / (d || 1) * sk, y: e.y + (h.y - e.y) / (d || 1) * sk };
      const spent = 1 - 0.2 * Math.max(spentCert(h, e), h.ai.misjudge ? 1 : 0); // we saw their special go: the window to go in (a misjudging bot forgets it may be back)
      if (ttkAt(h, spot) < ttk * (dive ? dive.fightRatio : 0.6) * (sd <= -3 ? 0.85 : sd <= -2 ? 0.92 : sd >= 2 ? 0.75 : 1) * (1 - bold * 0.2) * spent * (h.ai.misjudge ? 0.85 : 1) * (engaged ? 0.6 : 1) * (guard ? 1.25 : 1) * (wary ? 1.3 : 1) && !hitMe && !saving && !(assist && !wary) && !committed) continue; }
    let s = -ttk - d * 0.5;
    if (low) s += B.CanChaseLowHealthTargets ? 4 : 1.5;
    if (saving) s += 3;
    if (assist) s += 5;
    if (engaged) s += 3;
    if (harass) s += 2; // free damage on someone who cannot answer
    s += spentCert(h, e);
    if (hitMe) s += 1.5;
    if ([...e.lastHitBy.entries()].some(([a, t]) => a.team === h.team && a !== h && now - t < 2)) s += 1.5; // focus fire
    if (e === h.ai.focus) s += committed ? 3 : 1;
    if (s > bs) { bs = s; best = e; h.ai.urgent = low || saving || hitMe; }
  }
  return best;
}
// tiles Ron still has to slide to be out of reach of their tower, from position p
const ronTowerOut = (h, p) => { const tw = towerOf(h.team === 1 ? 2 : 1); return tw && tw.alive ? Math.max(0, tw.def.range + h.r + 0.6 - dist(tw, p)) : 0; };
// can Ron slide to u and, if u stands under their tower, back out of it within t seconds of Darkslide?
const ronCanSlide = (h, u, t) => { const sp = speedOf(h) * (h.specialActive ? 1 : 1 + h.def.scripts.SpecialBallLightningScript.SpeedBuff); return (dist(h, u) + ronTowerOut(h, u)) / Math.max(1, sp) < t - 0.4; };
function aiSpecialWanted(h, B, danger) {
  const S = h.def.scripts, ai = h.ai;
  const foes = r => game.units.filter(u => u.alive && u.team !== h.team && u.kind !== 'tower' && !u.has('untargetable') && isVisibleTo(u, h.team) && dist(u, h) <= r + u.r);
  const heroesIn = r => foes(r).filter(u => u.kind === 'hero');
  switch (h.code) {
    case 'Barbarian': { const A = AI_SPECIAL.Barbarian, f = foes(Math.min(A.targetRange, S.SpecialWhirlwindScript.DamageRadius + 0.6));
      return f.length + f.filter(u => u.kind === 'hero').length * A.heroWeight >= A.minEnemies || danger && f.length > 0; }
    case 'Angler': return heroesIn(S.SpecialHookScript.HookDistance * 0.85).length > 0;
    case 'Archer': return heroesIn(S.SpecialMagicArrowScript.ProjectileConfig.Settings.BaseProjectileScript.Settings.MaximumDistance * 0.8).length > 0;
    case 'Automaton': return heroesIn(h.range + 1).length > 0 || foes(h.range + 1).length >= 3;
    case 'Banshee': // Ron is the chaser: Darkslide makes him untargetable, so it is a safe window to go in, under their tower too, as long as he can slide back out
      // before it ends (Rickard's way of playing him); he doesn't hold it for a perfect finish, a fight in reach is enough
      return heroesIn(RON_FINISH.reach).some(u => u.hp / u.maxHp < RON_FINISH.below && ronCanSlide(h, u, S.SpecialBallLightningScript.Duration))
        || heroesIn(S.SpecialBallLightningScript.Radius + 2.5).length > 0 || h.inCombat(game.time) && heroesIn(RON_FINISH.reach - 1).length > 0 || danger;
    case 'Brawler': { // Bulldoze charges the nearest enemy hero and knocks it the same way: Bronson flanks, so he charges when the push sends the target into his team or tower (Rickard)
      const t = heroesIn(h.range).sort((a, b) => dist(h, a) - dist(h, b))[0]; if (!t) return false;
      const low = t.hp / t.maxHp < 0.35, home = bronsonHome(h, t), d = dist(h, t) || 1, hd = dist(t, home) || 1;
      const intoTeam = ((t.x - h.x) * (home.x - t.x) + (t.y - h.y) * (home.y - t.y)) / (d * hd) > 0.4;
      if (nearEnemyTower(t, 0.5) && !low && !intoTeam) return false;
      return low || intoTeam || danger; }
    case 'Frog': { const A = AI_SPECIAL.Frog, f = foes(4);
      return f.reduce((a, u) => a + (u.kind === 'hero' ? A.heroScore : A.defaultScore), 0) >= A.heroScore + 1 || ai.ttk < A.defensiveTtk * 2; }
    case 'Joker': { const A = AI_SPECIAL.Joker, J = S.SpecialJackInTheBoxScript;
      // like Rickard plays ROI17: open the box in the middle of a fight, with 1-3 enemy heroes close, at least half HP and most shots stored
      if (h.stocks < A.minStocks || h.hp / h.maxHp < A.minHp || nearEnemyTower(h, 0.5)) return false;
      const close = heroesIn(A.fightRange).length;
      if (close >= 1 && close <= 3 && jokerBoxReady(h)) return true; // from range: the box shoots 8 tiles, so he opens it before they reach him
      return h.stocks >= h.def.maxSpecialStocks && foes(h.def.range + J.AttackRangeBuff).length >= A.minPawnsAtMaxCharges; }
    case 'Marksman': { const P = S.SpecialLaserScript.ProjectileConfig.Settings.BaseProjectileScript.Settings; return heroesIn(P.Range * 0.9).length > 0 || foes(P.Range * 0.7).length >= 3; }
    case 'Paladin': return heroes().some(a => a.alive && a.team === h.team && a.hp / a.maxHp < 0.5 && a.inCombat(game.time)) || danger;
    case 'Sorcerer': return heroesIn(h.range + 2).length > 0 || foes(h.range + 2).length >= 3;
    case 'Thief': return heroesIn(h.range + 1).length > 0 || danger;
    case 'Kunoichi': return heroesIn(h.range + 1).length > 0 || danger; // shield up as soon as a hero fight starts, or to escape CC when in danger
    case 'Witch': { const A = AI_SPECIAL.Witch, f = foes(h.range + 1), hs = f.filter(u => u.kind === 'hero').length;
      return hs > 0 && hs / f.length >= (danger ? A.minHeroRatioDefending : A.minHeroRatio); }
  }
  return false;
}
function aiHero(h, dt) {
  const ai = h.ai, B = (h.team === PLAYER_TEAM && game.allyBot) || BOT; ai.t -= dt;
  if (ai.afk === undefined) ai.afk = AFK_MAX * Math.random() ** AFK_EXP;
  if (game.time < ai.afk) return;
  const myTower = towerOf(h.team), enemyTower = towerOf(h.team === 1 ? 2 : 1);
  const fwd = h.team === PLAYER_TEAM ? 1 : -1;
  // Frog in the air: land on heroes, or once safe after a defensive leap
  if (h.code === 'Frog' && h.specialActive && h.specialActive.inAir) {
    const onHero = game.units.some(u => u.alive && u.team !== h.team && u.kind === 'hero' && dist(u, h) < h.def.scripts.FrogSpecialLeapScript.DamageRange * AI_SPECIAL.Frog.reactivationRadiusRatio + u.r);
    if (ai.frogEscape ? incomingDps(h, h) === 0 && h.specialActive.t > 1 : onHero) tryCastSpecial(h);
  }
  // Ron in Darkslide: chase the weakest enemy hero not yet hit, under their tower too, and be out of the tower's reach when it ends (he ignores terrain while sliding)
  if (h.code === 'Banshee' && h.specialActive) {
    const sa = h.specialActive, out = ronTowerOut(h, h);
    if (out > 0 && sa.t < out / Math.max(1, speedOf(h)) + 0.35 || out > 0 && !game.units.some(u => u.alive && u.team !== h.team && u.kind === 'hero' && !sa.hit.has(u) && isVisibleTo(u, h.team) && ronCanSlide(h, u, sa.t))) {
      moveUnit(h, h.x - enemyTower.x, h.y - enemyTower.y, dt); return; } // time to get out
    const foes = game.units.filter(u => u.alive && u.team !== h.team && u.kind === 'hero' && isVisibleTo(u, h.team) && dist(u, h) < RON_FINISH.reach + 2);
    const hit = h.statDmg() * h.def.scripts.SpecialBallLightningScript.DamageCoefficient, weak = ai.retreat || h.hp / h.maxHp < 0.4; // low on health: only slide through what the slide kills, then get away
    const t = foes.filter(u => !sa.hit.has(u) && ronCanSlide(h, u, sa.t) && (!weak || u.hp + shieldOf(u) < hit * 1.2)).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]
      || !weak && foes.filter(u => !ronTowerOut(h, u) && dist(u, h) > h.range * 0.6).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]; // all hit: end next to the weakest one outside their tower to finish it
    if (!t && weak && myTower) { moveUnit(h, myTower.x - h.x, myTower.y - h.y, dt); return; }
    if (t) { moveUnit(h, t.x - h.x, t.y - h.y, dt); return; }
  }
  if (ai.t <= 0) {
    const calm = !h.inCombat(game.time) && !heroes().some(u => u.alive && u.team !== h.team && isVisibleTo(u, h.team) && dist(u, h) < 8);
    ai.t = Math.max(0.1, (pick(B.PossibleReactionTimes) + rand(-REACTION_OFFSET, REACTION_OFFSET)) * (calm ? 1.4 : h.inCombat(game.time) ? 0.75 : 1)); // slower when nothing happens, sharper in a fight
    temperament(h);
    if (!(ai.mistakeT > game.time)) { const mc = MISTAKE_CHANCE[tierName(B)] || 0; ai.mistakeT = game.time + rand(6, 14); const plat = tierName(B) === 'Platinum'; ai.misjudge = plat && Math.random() < mc; ai.overchase = !plat && B.SafetyMargin && Math.random() < mc * (1 + ai.bold * 0.5); ai.lateRetreat = !plat && Math.random() < mc * (1 + ai.bold * 0.5) ? 0.06 : 0; }
    const hpR = h.hp / h.maxHp, myDps = dpsOf(h);
    if (hpR > 0.4) ai.panicked = false;
    else if (hpR < 0.15 && !ai.panicked && h.specialReady && h.inCombat(game.time)) { ai.panicked = true; if (h.code !== 'Joker' && Math.random() < (PANIC_SPECIAL[tierName(B)] || 0)) tryCastSpecial(h); }
    ai.ttk = ttkAt(h, h);
    const allyMinionsNear = game.units.some(u => u.alive && u.kind === 'minion' && u.team === h.team && dist(u, h) < 4);
    const towerOnMe = enemyTower && enemyTower.alive && enemyTower.target === h && dist(h, enemyTower) < enemyTower.def.range + h.r + 0.5;
    const tank = towerTank(enemyTower, h.team);
    // PlaySafe: low health -> walk home and regenerate, with hysteresis up to HighHealthThreshold
    // retreat on the whole situation, not a fixed HP line (colleagues' review): the line drops when the fight goes our way and rises when it doesn't
    const matesNear = heroes().filter(a => a.alive && a !== h && a.team === h.team && !a.isIllusion && dist(a, h) < 8);
    const foesNear = heroes().filter(u => u.alive && u.team !== h.team && !u.isIllusion && (isVisibleTo(u, h.team) ? dist(u, h) < 8 : (m => m && dist(m, h) < 8)(remembered(u, h.team)))).length;
    const fightNear = matesNear.some(a => game.time - a.lastCombat < 1 && dist(a, h) < 6);
    const fo = ai.focus && ai.focus.alive && ai.focus.kind === 'hero' && isVisibleTo(ai.focus, h.team) ? ai.focus : null;
    const winning = !!fo && (fo.hp + shieldOf(fo)) / Math.max(1, myDps + matesNear.reduce((a, o) => a + (dist(o, fo) < o.range + 2 ? dpsOf(o) : 0), 0)) < ai.ttk * 0.8;
    let line = B.LowHealthThreshold - (ai.lateRetreat || 0) - temperament(h) * 0.04 + (CAREFUL[h.code] && B.SafetyMargin ? CAREFUL[h.code].line : 0);
    if (B.LowHealthThreshold > 0 && B.SafetyMargin) line = clamp(line - (fightNear ? 0.12 : 0) - (winning ? 0.15 : 0) - (h.specialReady ? 0.05 : 0) + (foesNear > matesNear.length + 1 ? 0.1 : 0) + (ai.ttk < 2.5 ? 0.1 : 0) + (h.has('slowPct') && h.inCombat(game.time) ? 0.12 : 0), 0.12, 0.6); // slowed: running home takes longer
    const wasRetreat = ai.retreat, leech = hasItem(h, 'LifestealDisableRegen'), pressed = foesNear > matesNear.length || ai.ttk < 4;
    if (B.LowHealthThreshold > 0 && hpR < line && (!leech || pressed) || (!allyMinionsNear && hpR < B.NoMinionLowHealthThreshold && fo && !winning && foesNear >= matesNear.length + 1) || (towerOnMe && hpR < B.TargetedByTowerLowHealthThreshold && !(ai.chip && hpR > 0.3))) ai.retreat = true;
    if (ai.retreat && !wasRetreat) ai.retreatT = game.time;
    const locked = ai.retreat && game.time - (ai.retreatT || -99) < 2; // once a bot decides to run it keeps running a moment, like a player would
    if (ai.retreat && !locked && hpR >= Math.min(B.HighHealthThreshold, Math.max(line + 0.25, B.LowHealthThreshold + 0.05))) ai.retreat = false;
    if (ai.retreat && !locked && leech && !foesNear && ai.ttk > 5) ai.retreat = false; // got away: with Parascythe, standing still heals nothing
    ai.leechFarm = leech && hpR < Math.min(B.HighHealthThreshold, line + 0.25); // heal on minions before taking fights again
    // ...unless a sure kill is right there
    // ...the kill has to be safe afterwards too: low ourselves, a helper of theirs close by or unaccounted for makes it a trade we don't take (colleagues' review)
    if (ai.retreat && B.SafetyMargin && ai.ttk > 2 && heroes().some(u => { if (!u.alive || u.team === h.team || u.isIllusion || !isVisibleTo(u, h.team) || dist(u, h) > h.range + u.r + 0.5) return false;
      const killT = (u.hp + shieldOf(u)) / Math.max(1, myDps + matesNear.reduce((a, o) => a + (dist(o, u) < o.range + 2 ? dpsOf(o) : 0), 0));
      const helpers = heroes().filter(o => o.alive && o !== u && o.team === u.team && !o.isIllusion && (isVisibleTo(o, h.team) ? dist(o, u) < 7 : (m => m && dist(m, u) < 7)(remembered(o, h.team)))).length;
      return killT < 1.2 && ai.ttk > killT * 2 && (hpR > 0.35 ? helpers <= 1 : !helpers && !unaccounted(h, u)); })) ai.retreat = false;
    // re-read the game while regenerating: a teammate fighting close by pulls us back in once we are fit enough
    if (ai.retreat && !locked && B.SafetyMargin && hpR > 0.6 && !h.inCombat(game.time) && heroes().some(a => a.alive && a !== h && a.team === h.team && game.time - a.lastCombat < 1 && dist(a, h) < 8)) ai.retreat = false;
    // EscapeDanger: we would die within TimeToKillDangerThreshold where we stand
    ai.danger = !ai.retreat && ai.ttk < B.TimeToKillDangerThreshold && !(ai.commitT > game.time && ai.ttk > 1.2); // committed to a fight: only bail if death is right there
    aiUseItems(h);
    let target = ai.retreat ? null : pickHeroTarget(h, B, enemyTower, myDps);
    if (target && ai.leechFarm && !ai.urgent) target = null;
    // CheckOwnerShouldTargetEnemyTower: hit the tower while minions tank it, or when we outlast it alone
    const towerUp = enemyTower && enemyTower.alive;
    // the tower shoots one unit at a time: our heroes at the tower together outlast it if their pooled health lasts longer than it does
    const pushers = towerUp ? heroes().filter(a => a.alive && a.team === h.team && (a === h || dist(a, enemyTower) < enemyTower.def.range + 2.5) && a.hp / a.maxHp > 0.4) : [];
    // without minions, only go for the tower when we kill it before it (and the minions guarding it) kill any one of us (Rickard)
    const guardDps = towerUp ? dpsOf(enemyTower) + game.units.reduce((a, u) => a + (u.alive && u.kind === 'minion' && u.team !== h.team && dist(u, enemyTower) < enemyTower.def.range + 3 ? dpsOf(u) * 0.5 : 0), 0) : 0;
    const towerTtk = towerUp ? enemyTower.hp / pushers.reduce((a, o) => a + dpsOf(o), 0) : 99;
    const soloTower = towerUp && Math.min(...pushers.map(o => o.hp + shieldOf(o))) / guardDps > towerTtk * 1.15;
    const towerOnMinion = towerUp && enemyTower.target && enemyTower.target.kind === 'minion' && enemyTower.target.alive && enemyTower.target.hp > 25;
    const defenders = towerUp ? game.units.filter(u => u.alive && u.kind === 'hero' && u.team !== h.team && dist(u, enemyTower) < enemyTower.def.range + 3).length : 0;
    // chip the tower alone (Rickard): only when no enemy hero is seen or remembered near it and no minion guards it, while the damage sticks
    // (out of combat a tower only regrows up to 25 %), and walk off at half health so it never costs a death
    const lurking = towerUp && heroes().some(u => u.alive && u.team !== h.team && !u.isIllusion && (isVisibleTo(u, h.team) ? dist(u, enemyTower) < 12 || dist(u, h) < 8 : (m => !m || dist(m, enemyTower) < 14)(remembered(u, h.team))));
    const guards = towerUp && game.units.some(u => u.alive && u.kind === 'minion' && u.team !== h.team && dist(u, enemyTower) < enemyTower.def.range + 6); // also minions on their way
    ai.chip = !!(towerUp && B.SafetyMargin && tank === 0 && !defenders && !lurking && !guards && enemyTower.hp > enemyTower.maxHp * 0.3 && hpR > (ai.chip ? 0.3 : 0.6) && !ai.retreat); // stays while nothing threatens it, leaves when a threat shows up (friends' review: a fixed 50 % line can be baited)
    const shouldTower = towerUp && (tank >= 25 || towerOnMinion || soloTower || ai.chip || !B.SafetyMargin && hpR > 0.5 && !towerOnMe || !defenders && hpR > 0.6 && !towerOnMe && tank > 0
      || hpR > 0.5 && tank > 0 && heroes().filter(u => u.alive && u.team !== h.team).length < pushers.length // numbers advantage after kills
      || hpR > 0.5 && tank > 0 && heroes().some(u => !u.alive && u.team !== h.team) // an enemy hero is dead: use the window to hit the tower
      || hpR > 0.6 && tank >= 10 && starDiff(h) >= 2); // star lead: press it
    // with the tower open, only fight heroes that are low, hitting us or hurting an ally
    if (target && shouldTower && !ai.urgent && dist(h, enemyTower) < dist(h, target) + 4) target = null;
    let goal = null; ai.kite = null;
    if (ai.retreat) { // regen starts once out of combat, so only back off until nothing can reach us, not all the way home (Rickard)
      ai.mode = 'retreat'; ai.focus = null;
      const threat = game.units.some(u => u.alive && u.team !== h.team && !u.isIllusion && isVisibleTo(u, h.team)
        && dist(u, h) < (u.kind === 'hero' ? u.range + speedOf(u) * 1.5 + 2 : u.kind === 'tower' ? u.def.range + 1 : u.range + 2.5));
      const fightAt = heroes().filter(a => a.alive && a !== h && a.team === h.team && !a.isIllusion).sort((a, b) => dist(a, h) - dist(b, h))[0];
      const clear = Math.max(h.range, 3.5) + 1; // out of reach both ways: our own autoattacks would keep us in combat and block regen
      const bush = (fightAt && dist(fightAt, h) < 9 && bushSpot(h, fightAt, 6, enemyTower, clear)) || bushSpot(h, h, 7, enemyTower, clear);
      if (bush && game.time - h.lastCombat > 0.8 && (game.map.inGrass(h) && dist(h, bush) < 1.2 || !threat || dist(h, bush) < 3)) goal = { x: bush.x, y: bush.y, stopAt: 0.3 }; // hide and regen in a bush, even with enemies near
      else if (threat || game.time - h.lastCombat < 0.5) {
        const d = dist(h, myTower) || 1, back = { x: myTower.x, y: myTower.y - fwd * (myTower.r + h.r + 0.6) }; // the spot right behind our tower
        if (d > 5.5) goal = { x: h.x + (myTower.x - h.x) / d * 4, y: h.y + (myTower.y - h.y) / d * 4 };
        else goal = walkable(h, back.x, back.y) && dist(h, back) > 0.4 ? back : null; // close: step behind it, or hold under it, never walk into it
        if (goal && !walkable(h, goal.x, goal.y)) goal = walkable(h, back.x, back.y) ? back : null;
      } else goal = null; // safe: stand still and let regen tick
    }
    else if (ai.danger) { ai.mode = 'danger'; ai.focus = null; goal = safestSpot(h) || { x: myTower.x, y: myTower.y - fwd }; }
    else if (towerOnMe && tank < 25 && !soloTower && !ai.chip && !(target && (target.hp + shieldOf(target)) / myDps < 1.5)) {
      // the tower is shooting us with no minion to take the hits: step out of its range
      ai.mode = 'leaveTower'; ai.focus = null; const a = Math.atan2(h.y - enemyTower.y, h.x - enemyTower.x), r = enemyTower.def.range + h.r + 0.8;
      goal = { x: enemyTower.x + Math.cos(a) * r, y: enemyTower.y + Math.sin(a) * r };
      if (!game.map.free(goal.x, goal.y, h.r)) goal = { x: h.x, y: enemyTower.y - fwd * r };
    } else if ((ai.soak = B.SafetyMargin && !CAREFUL[h.code] && hpR > PLAYSTYLE.soakMinHp && SOAK[tierName(B)] ? heroes().filter(a => a.alive && a !== h && a.team === h.team && !a.isIllusion && a.hp / a.maxHp < PLAYSTYLE.soakAllyHp
        && !(a.ai && (a.ai.retreat || a.ai.mode === 'soak')) // a teammate running home or soaking itself: don't chain into a bodyguard huddle
        && dist(a, h) < 7 && soakWilling(h, a)
        && game.time - a.lastCombat < 1 && game.units.some(e => e.alive && e.team !== h.team && e.kind === 'hero' && dist(e, a) <= e.range + a.r + 0.5)).sort((a, b) => ttkAt(a, a) - ttkAt(b, b))[0] : null)) { // the one closest to dying
      // stand on a hurt teammate who is being hit, so the random targeting spreads the hits onto us
      ai.mode = 'soak'; const a = ai.soak, e = game.units.filter(u => u.alive && u.team !== h.team && u.kind === 'hero').sort((p, q) => dist(p, a) - dist(q, a))[0];
      ai.focus = e; goal = { x: a.x + (e.x - a.x) * 0.25, y: a.y + (e.y - a.y) * 0.25 };
    } else if (target) {
      if (ai.focus !== target) { ai.commitT = game.time + (DIVERS[h.code] ? 2 : ai.ttk < 3 ? 0.7 : starDiff(h) >= 2 ? 1.8 : 1.2) * rand(0.85, 1.15); ai.commitHp = h.hp; }
      else if (ai.commitT > game.time && ai.commitHp - h.hp > h.maxHp * 0.25 && [...h.lastHitBy.entries()].some(([u, t]) => u !== target && game.time - t < 1)) ai.commitT = 0; // someone else is hurting us badly: rethink now
      ai.mode = outranges(h, target) && B.SafetyMargin ? 'harass' : 'hero'; ai.focus = target; ai.seen = { u: target, x: target.x, y: target.y, t: game.time };
      const d = dist(h, target) || 1, keep = ai.mode === 'harass' ? harassKeep(h, target) : h.code === 'Joker' && B.SafetyMargin && jokerBoxReady(h) ? CAREFUL.Joker.boxKeep : h.range * (CAREFUL[h.code] && B.SafetyMargin ? CAREFUL[h.code].keep : 0.85) + target.r;
      goal = { x: target.x + (h.x - target.x) / d * keep, y: target.y + (h.y - target.y) / d * keep, stopAt: keep + 0.1, follow: target };
      if (h.code === 'Brawler' && h.specialReady && target.hp / target.maxHp >= 0.35) { // flank: circle to the far side so Bulldoze knocks the target into our team
        const home = bronsonHome(h, target), hd = dist(target, home) || 1, side = { x: target.x + (target.x - home.x) / hd * 2.2, y: target.y + (target.y - home.y) / hd * 2.2 };
        if (game.map.free(side.x, side.y, h.r) && !(enemyTower && enemyTower.alive && dist(side, enemyTower) < enemyTower.def.range)) { goal = side; goal.stopAt = 0.3; }
      }
      // NeedsToRetreatFromTarget: ranged heroes back off melee heroes that get close
      if (B.SafetyMargin && (h.range >= 3.4 && target.range < 2.6 || outranges(h, target)) && d < target.range + target.r + h.r + 0.4) ai.kite = target;
      // approach through a bush when one lies on the way: the target loses sight of us and gets surprised (Rickard)
      else if (B.SafetyMargin && d > h.range + 1.5 && d < 9 && !game.map.inGrass(h) && goal.stopAt !== 0.3) {
        const b = bushSpot(h, target, h.range + 1, enemyTower); if (b && dist(b, target) < d - 1 && dist(h, b) < d) goal = { x: b.x, y: b.y, stopAt: 0.3 };
      }
    } else if (ai.seen && ai.seen.u.alive && !isVisibleTo(ai.seen.u, h.team) && !ai.retreat && B.SafetyMargin && wantsBushChase(h, ai.seen, enemyTower)) {
      // it slipped into a bush low on health: it did not leave the game, go look where it was last seen (Rickard)
      ai.mode = 'bushChase'; ai.focus = null; goal = { x: ai.seen.x, y: ai.seen.y };
      if (dist(h, ai.seen) < 1.2) ai.seen = null; // looked and found nothing: give up
    } else {
      ai.focus = null;
      const fl = laneTarget(h.team), slot = (heroes().filter(a => a.team === h.team).indexOf(h) - 1) * 0.9;
      ai.mode = shouldTower ? 'tower' : 'lane';
      if (shouldTower) goal = { x: enemyTower.x + slot * 0.6, y: enemyTower.y - fwd * (h.range * 0.85 + enemyTower.r), stopAt: h.range * 0.85 + enemyTower.r, follow: enemyTower };
      else if (fl && fl.kind === 'minion') {
        // TargetFrontline: stay on the safe side of our front minion, never past it into tower range
        let y = fl.y - fwd * ((h.range >= 3.4 ? 1.6 : 0.8) + (CAREFUL[h.code] ? CAREFUL[h.code].back : 0));
        if (towerUp && Math.abs(y - enemyTower.y) < enemyTower.def.range + 0.6 && tank < 25) y = enemyTower.y - fwd * (enemyTower.def.range + 0.8);
        goal = { x: fl.x + slot, y };
      } else if (towerUp) goal = { x: enemyTower.x + slot, y: enemyTower.y - fwd * (enemyTower.def.range + 1.2) };
      if (!shouldTower && goal && B.SafetyMargin) {
        const mates = heroes().filter(a => a.alive && a !== h && a.team === h.team && !a.isIllusion);
        if (TANKS[h.code] && fl && fl.kind === 'minion') goal.y += fwd * 0.5; // tanks stand up front next to the minions
        // (holding our own half when 2+ stars behind was tested 2026-10-08 and dropped: matches stalled, 45 % -> 38 % ending in 6 min;
        // being behind on stars now only makes bots pickier about which fights they take)
        // never walk alone into two or more enemy heroes (fresh respawns going in one by one): join the nearest teammate first
        const foesAhead = heroes().filter(u => u.alive && u.team !== h.team && isVisibleTo(u, h.team) && dist(u, goal) < 8).length;
        const mate = mates.sort((a, b) => dist(a, h) - dist(b, h))[0];
        if (mate && !DIVERS[h.code] && foesAhead >= 2 && dist(mate, h) > 6) { ai.mode = 'group'; goal = { x: mate.x, y: mate.y - fwd * 1.5 }; }
        // Pearl stays with the teammate who is taking the hits
        if (h.code === 'Paladin') { const hurt = mates.filter(a => game.time - a.lastCombat < 2 && dist(a, h) < 10).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
          if (hurt) { ai.mode = 'support'; goal = { x: hurt.x, y: hurt.y - fwd * 0.6 }; } }
      }
      // wait in a bush beside the lane instead of the open road: hidden, and ready to jump an enemy who walks past (Silver and up)
      if (!shouldTower && goal && B.SafetyMargin && ai.mode === 'lane') { const amb = bushSpot(h, goal, Math.max(1.5, h.range - 0.5), enemyTower); if (amb) goal = { x: amb.x, y: amb.y, stopAt: 0.3 }; }
    }
    if (goal && ai.blocked && game.time < ai.blocked.t && Math.hypot(goal.x - ai.blocked.x, goal.y - ai.blocked.y) < 1.5) goal = null;
    ai.goal = goal; ai.path = goal ? game.map.path(h, goal) : null;
    // specials, delayed by a reaction time once the condition holds (CurrentSpecialReactionTimer)
    if (h.specialReady && !(h.code === 'Frog' && h.specialActive)) {
      if (aiSpecialWanted(h, B, ai.danger || ai.retreat && ai.ttk < 3)) { if (ai.spT === undefined) ai.spT = pick(B.PossibleReactionTimes) * 0.5; }
      else ai.spT = undefined;
    }
  }
  if (ai.spT !== undefined) { ai.spT -= dt; if (ai.spT <= 0) { ai.spT = undefined;
    if (h.specialReady && aiSpecialWanted(h, B, ai.danger || ai.retreat && ai.ttk < 3)) { ai.frogEscape = h.code === 'Frog' && ai.ttk < AI_SPECIAL.Frog.defensiveTtk * 2; tryCastSpecial(h); } } }
  if (h.has('casting')) return;
  // dodge incoming skillshots first
  const dv = dodgeVector(h, B);
  if (dv) { moveUnit(h, dv.x, dv.y, dt); ai.path = null; ai.t = Math.min(ai.t, 0.15); return; }
  if (ai.kite && ai.kite.alive && dist(h, ai.kite) < ai.kite.range + ai.kite.r + 0.9) {
    const k = ai.kite, ax = h.x - k.x, ay = h.y - k.y - fwd * 0.5;
    if (game.map.free(h.x + ax * 0.2, h.y + ay * 0.2, h.r)) { moveUnit(h, ax, ay, dt); return; }
  }
  const g = ai.goal;
  if (g && g.stopAt) {
    const f = g.follow && g.follow.alive ? g.follow : null;
    if (f && dist(h, f) <= g.stopAt) {
      // in range of a hero: keep shuffling sideways like a player does instead of standing still (attacks still fire while moving)
      if (f.kind === 'hero' && B.SafetyMargin) {
        if (!(ai.strafeT > 0)) { ai.strafeT = rand(0.6, 1.4); ai.strafe = ai.strafe === 1 ? -1 : 1; } ai.strafeT -= dt;
        const d = dist(h, f) || 1, ux = (h.x - f.x) / d, uy = (h.y - f.y) / d, pull = (g.stopAt - 0.35 - d) * 1.5;
        const vx = -uy * ai.strafe + ux * pull, vy = ux * ai.strafe + uy * pull;
        if (walkable(h, h.x + vx * 0.3, h.y + vy * 0.3) && !nearEnemyTower({ x: h.x + vx * 0.5, y: h.y + vy * 0.5, team: h.team }, 0)) { moveUnit(h, vx, vy, dt); h.facing = Math.atan2(f.y - h.y, f.x - h.x); } else ai.strafe = -ai.strafe; // shuffles facing the enemy, not spinning with each side step
      }
      return;
    }
    if (f && f.kind === 'hero' && (!ai.path || !ai.path.length || Math.hypot(g.fx - f.x, g.fy - f.y) > 1.0)) {
      const d = dist(h, f) || 1, keep = g.stopAt - 0.1; g.x = f.x + (h.x - f.x) / d * keep; g.y = f.y + (h.y - f.y) / d * keep; g.fx = f.x; g.fy = f.y;
      ai.path = game.map.path(h, g);
    }
  }
  const st = ai.stuck || (ai.stuck = { x: h.x, y: h.y, t: game.time });
  if (!(ai.path && ai.path.length) || Math.hypot(h.x - st.x, h.y - st.y) > Math.max(0.1, speedOf(h) * 0.2)) { st.x = h.x; st.y = h.y; st.t = game.time; }
  else if (game.time - st.t > 0.6) {
    const gl = ai.goal || ai.path[ai.path.length - 1]; ai.blocked = { x: gl.x, y: gl.y, t: game.time + 1.5 };
    ai.path = null; ai.goal = null; ai.t = Math.min(ai.t, 0.2); st.t = game.time; return;
  }
  if (ai.path && ai.path.length) {
    // walk at full speed like a thumb on the joystick: steering toward each tile centre used to scale the speed with the distance left,
    // so bots slowed to ~30 % before every tile and then rushed on (Rickard 2026-10-08); cut corners to the furthest node in a straight line
    for (let k = 0; k < 4 && ai.path.length > 1 && clearWalk(h, ai.path[1]); k++) ai.path.shift();
    const n = ai.path[0], dx = n.x - h.x, dy = n.y - h.y, d = Math.hypot(dx, dy), last = ai.path.length === 1;
    if (d < (last ? 0.05 : 0.25)) ai.path.shift();
    else { const step = speedOf(h) * dt, k = last && d < step ? d / step : 1; moveUnit(h, dx / d * k, dy / d * k, dt); } // only the final goal is approached exactly
  }
}
// can h stand at x, y? walls and towers (a tower is a unit, not a wall tile, so map.free alone lets a bot walk into it)
const walkable = (h, x, y) => game.map.free(x, y, h.r) && !game.units.some(t => t.kind === 'tower' && t.alive && Math.hypot(t.x - x, t.y - y) < t.r + h.r + 0.1);
// can h walk straight to p? (walls, and towers, which the tile path routes around)
function clearWalk(h, p) {
  const d = Math.hypot(p.x - h.x, p.y - h.y), n = Math.ceil(d / 0.3);
  for (let i = 1; i <= n; i++) { const x = h.x + (p.x - h.x) * i / n, y = h.y + (p.y - h.y) * i / n;
    if (!game.map.free(x, y, h.r) || game.units.some(t => t.kind === 'tower' && t.alive && Math.hypot(t.x - x, t.y - y) < t.r + h.r + 0.1)) return false; }
  return true;
}
function aiMinion(m, dt) {
  const ai = m.ai; ai.t -= dt;
  if (m.tutStatic) { const w = m.lane.waypoints[0], gx = w[0] + 0.5, gy = w[1] + 0.5; if (Math.hypot(gx - m.x, gy - m.y) > 0.1) moveUnit(m, gx - m.x, gy - m.y, dt); return; }
  const lane = m.lane, wps = m.team === ENEMY_TEAM ? lane.waypoints : [...lane.waypoints].reverse();
  const enemyTower = towerOf(m.team === 1 ? 2 : 1);
  const vis = enemiesInRange(m, UNITS.MeleeMinion && MATCH.minionAI.VisionRange).sort((a, b) => dist(m, a) - dist(m, b));
  let goal = null;
  if (vis.length) { const t = vis[0]; if (dist(m, t) > m.def.range + t.r) goal = t; }
  else {
    const wp = wps[m.wp] ? { x: wps[m.wp][0] + 0.5, y: wps[m.wp][1] + 0.5 } : enemyTower;
    if (wps[m.wp] && Math.hypot(wp.x - m.x, wp.y - m.y) < 0.8) m.wp++;
    goal = wps[m.wp] ? { x: wps[m.wp][0] + 0.5, y: wps[m.wp][1] + 0.5 } : enemyTower;
  }
  if (!goal) return;
  if (ai.t <= 0 || !ai.path) { ai.t = 0.5; ai.path = game.map.path(m, goal); }
  if (ai.path && ai.path.length) { const n = ai.path[0]; if (Math.hypot(n.x - m.x, n.y - m.y) < 0.25) ai.path.shift(); else moveUnit(m, n.x - m.x, n.y - m.y, dt); }
}

// ---------- waves / level ----------
function spawnWave() {
  game.waveN++;
  const lane = game.map.src.lanes[0];
  [1, 2].forEach(team => {
    const sp = game.minionSpawn[team]; let k = 0;
    lane.waves.forEach(w => {
      if ((game.waveN - 1) % w.every !== 0) return;
      for (let i = 0; i < w.n; i++) { const idx = k++; setTimeout0(idx * MATCH.waves.SpawnStaggeringPeriod, () => {
        if (game.state !== 'play') return; const m = new Minion(w.unit, team, sp.x + rand(-0.2, 0.2), sp.y + rand(-0.2, 0.2), lane); m.wp = 0; game.units.push(m); }); }
    });
  });
}

// ---------- update ----------
let last = performance.now();
function update(dt) {
  const g = game; if (!g) return;
  if (g.state === 'countdown') { g.time += dt; if (g.time >= 0) { g.time = 0; g.state = 'play'; g.bannerT = 2.5; } updateCamera(dt); return; }
  if (g.state === 'over') { g.overT += dt; updateCamera(dt); updateFx(dt); return; }
  g.time += dt;
  if (input.special) { input.special = false; input.specialBuf = SPECIAL_BUFFER; }
  for (const t of timers) { t.t -= dt; if (t.t <= 0 && !t.done) { t.done = true; t.fn(); } }
  for (let i = timers.length - 1; i >= 0; i--) if (timers[i].done) timers.splice(i, 1);
  // timed team level: +1 every SecondsPerLevel, max MaxLevel (the hero test arena picks a fixed level instead: g.fixedLevel)
  if (g.tut) updateTutorial(dt);
  if (g.bannerT > 0) g.bannerT -= dt;
  const lvl = g.tut ? 1 : g.fixedLevel || Math.min(MATCH.leveling.MaxLevel, 1 + Math.floor(g.time / MATCH.leveling.SecondsPerLevel));
  if (lvl !== g.level) { const old = g.level; g.level = lvl; heroes().forEach(h => h.setLevel(lvl)); g.toastT = 3;
    // one offer per item level crossed, even when the level jumps several steps at once, and never twice for the same level (dev -/+ buttons)
    if (!g.tut && GD.itemData) for (const bl of GD.itemData.buyLevels) if (bl > old && bl <= lvl && !(g.offeredLvls || (g.offeredLvls = new Set())).has(bl)) { g.offeredLvls.add(bl); offerItems(); } }
  if (g.toastT > 0) g.toastT -= dt;
  if (g.starTip > 0) g.starTip -= dt;
  if (!g.tut || g.tut.match) g.waveT -= dt; if (g.waveT <= 0) { g.waveT += MATCH.waves.WavePeriod; spawnWave(); }

  for (const u of g.units) {
    if (u.kind === 'hero' && !u.alive && !u.isIllusion) {
      u.respawnT -= dt;
      for (const it of u.items) if (it.cd > 0) it.cd -= dt;
      if (!u.isPlayer && !u.remote && u.respawnT > 3) { const it = itemOf(u, 'RessurectionPotion'); if (it && it.cd <= 0) { useItem(u, it); continue; } }
      if (u.respawnT <= 0) reviveHero(u);
      continue;
    }
    if (!u.alive) { if (u.deadT !== undefined) u.deadT -= dt; continue; }
    u.flash = Math.max(0, u.flash - dt); u.revealT = Math.max(0, u.revealT - dt);
    for (const s of u.statuses) s.t -= dt; u.statuses = u.statuses.filter(s => s.t > 0 && !(s.type === 'shield' && s.amount <= 0));
    if (u.isIllusion) { u.lifeT -= dt; if (u.lifeT <= 0 || !u.owner.alive) { u.alive = false; u.dead = true; continue; } }
    updateForced(u, dt);
    if (u.kind === 'hero') {
      updateSpecial(u, dt);
      // DefaultRegenScript: out of combat, heal HealAmount * max HP every HealTickTime
      updateItems(u, dt);
      if (!u.inCombat(g.time) && !u.isIllusion) { u.regenT = (u.regenT || 0) + dt; if (u.regenT >= MATCH.heroRegen.HealTickTime * (1 + (hasItem(u, 'RegenTickTime') ? iv('RegenTickTime', 'ValuePerLevel') : 0)) / (hasItem(u, 'LifestealDisableRegen') ? ID.LifestealDisableRegen.RegenFactor : 1)) { u.regenT = 0; heal(u, u.maxHp * MATCH.heroRegen.HealAmount, false, true); } } else u.regenT = 0;
      if (u.code === 'Joker' && !u.isIllusion) { u.jokerT -= dt; if (u.jokerT <= 0) { const P = u.def.scripts.JokerCastProjectileRandomlyScript; u.jokerT = rand(P.RandomDelay.X, P.RandomDelay.Y);
        const t = enemiesInRange(u, P.Range); if (t.length) { const tg = pick(t); game.projectiles.push({ src: u, tgt: tg, dmg: u.statDmg() * P.DamageCoeff, t: 0, travel: 0.49, x: u.x, y: u.y, onHit: false, joker: true }); } } }
      if (canAct(u) && !u.has('casting')) {
        if (u.isPlayer) { const mv = readMove(); if (!(u.specialActive && u.specialActive.joker)) moveUnit(u, mv.x, mv.y, dt); if (input.specialBuf > 0 && tryCastSpecial(u)) input.specialBuf = 0; }
        else if (u.remote && game.net && !game.net.down) game.net.control(u, dt); // multiplayer guest's hero: its inputs arrive over the network (while it reconnects, the bot below plays it)
        else if (u.isIllusion) aiIllusion(u, dt);
        else if (u.dummy) {} /* hero test arena (herotest.js): a training dummy stands still and only auto-attacks what comes in range */
        else if (!(u.specialActive && u.specialActive.joker)) aiHero(u, dt); else aiJokerMode(u, dt);
      }
      checkJumpPad(u); if (!u.isIllusion) trackMotion(u, dt);
    } else if (u.kind === 'minion') { if (canAct(u)) aiMinion(u, dt); }
    else if (u.kind === 'tower') {
      if (!u.inCombat(g.time) && u.hp < u.maxHp * u.def.scripts.TowerRegenScript.MaximumHealth) { u.regenT += dt; if (u.regenT >= 1) { u.regenT = 0; u.hp = Math.min(u.maxHp * 0.25, u.hp + u.maxHp * 0.01); } }
    }
    updateAttack(u, dt);
  }
  input.specialBuf = Math.max(0, (input.specialBuf || 0) - dt);
  g.units = g.units.filter(u => !(u.kind === 'minion' && !u.alive && u.deadT <= 0) && !u.dead);
  separate();
  updateProjectiles(dt);
  updateFx(dt);
  updateCamera(dt);
}
function aiIllusion(u, dt) {
  const t = enemiesInRange(u, 5).sort((a, b) => dist(u, a) - dist(u, b))[0];
  if (t && dist(u, t) > u.range * 0.8) moveUnit(u, t.x - u.x, t.y - u.y, dt);
  else if (!t) { const o = u.owner; if (dist(u, o) > 1) moveUnit(u, o.x - u.x, o.y - u.y, dt); }
}
function aiJokerMode(u, dt) { if (u.ai) { u.ai.t -= dt; } }
function updateFx(dt) {
  for (const e of game.effects) e.t -= dt; game.effects = game.effects.filter(e => e.t > 0);
  for (const t of game.texts) { t.t -= dt; if (!t.max) t.y += dt * 0.9; } game.texts = game.texts.filter(t => t.t > 0); // texts with max rise by their age when drawn
  for (const f of game.feed) f.t -= dt; game.feed = game.feed.filter(f => f.t > 0);
  shakeT = Math.max(0, shakeT - dt);
}
function updateCamera(dt) {
  const p = game.player, m = game.map; const viewH = H / SCALE / 0.82, fin = game.state === 'over' && game.endAt; // match over: look at the fallen tower
  const tx = fin ? fin.x : p.alive ? p.x : p.spawn.x, ty = (fin ? fin.y : p.alive ? p.y : p.spawn.y) + 1.2 * viewOf(game).y, k = Math.min(1, dt * (fin ? 3.5 : 6));
  game.cam.x += (tx - game.cam.x) * k; game.cam.y += (ty - game.cam.y) * k;
  const halfW = VIEW_TILES_W / 2;
  game.cam.x = m.w <= VIEW_TILES_W ? m.w / 2 : clamp(game.cam.x, halfW, m.w - halfW);
  game.cam.y = m.h <= viewH * 0.84 ? m.h / 2 : clamp(game.cam.y, viewH * 0.42, m.h - viewH * 0.42);
}

// ---------- hit feedback / juice (menu "Effects", saved as abc2-effects) ----------
// Screen shake, a short zoom on your own special, a stronger white flash and a stagger on whoever is hit, all scaled by the damage.
// Read from what changes between frames (HP drops, your special emptying), so a multiplayer guest gets the same feedback as the host.
// Drawing only: the simulation, the bots and the netcode never see it. Effects off turns all of it off, the old hit flash and flinch too.
const ZOOM_SPECIAL = { Banshee: 0.13, Paladin: 0.12, Brawler: 0.12, Sorcerer: 0.11, Joker: 0.11, Barbarian: 0.09 }; // the big specials zoom more; others 0.07
const juice = { trauma: 0, sx: 0, sy: 0, t: 0, zoomT: 9, zoomA: 0, seen: new WeakMap(), sp: null, stopT: 0 }; // stopT: hit stop, the game runs at 10 % speed (not in multiplayer)
function addTrauma(v) { if (effectsOn) juice.trauma = Math.min(1, Math.max(juice.trauma, v)); }
function updateJuice(dt) {
  const g = game, P = g.player; juice.t += dt; juice.zoomT += dt;
  for (const u of g.units) {
    const prev = juice.seen.get(u); juice.seen.set(u, { hp: u.hp, max: u.maxHp, alive: u.alive });
    if (u.hitT > 0) u.hitT -= dt;
    if (!prev || !effectsOn) continue;
    if (prev.alive && !u.alive && u.kind === 'hero' && P && dist(u, P) < 7) { addTrauma(u === P ? 0.55 : 0.4); juice.stopT = Math.max(juice.stopT, u === P ? 0.12 : 0.08); continue; } // a hero going down near you: shake and a short freeze
    if (prev.alive && !u.alive && u.kind === 'tower') { addTrauma(0.75); juice.zoomT = 0; juice.zoomA = 0.1; continue; } // the match-winning tower falls
    if (!u.alive || !prev.alive || u.maxHp !== prev.max) continue; // max HP changing (stars, levels) rescales HP: not a hit
    const d = prev.hp - u.hp; if (d < 1) continue;
    const f = Math.min(1, d / u.maxHp);
    u.flash = Math.max(u.flash || 0, 0.12 + Math.min(0.08, f * 0.5)); // longer and brighter for bigger hits (3D flinch grows with it)
    if (u.kind === 'minion' && f >= 0.02) { // stagger away from the nearest enemy, the likely attacker (minions only: on a hero it read as a hitch, Rickard)
      let a = null, ad = 1e9; for (const e of g.units) if (e.alive && e.team !== u.team && e !== u) { const q = dist(e, u); if (q < ad) { ad = q; a = e; } }
      const ang = a ? Math.atan2(u.y - a.y, u.x - a.x) : Math.random() * 6.28, k = Math.min(0.24, 0.05 + f * 0.8);
      if (!(u.hitT > 0 && u.hitK > k)) { u.hitK = k; u.hitMax = u.hitT = 0.12 + Math.min(0.14, f * 0.6); u.hitDx = Math.cos(ang) * k; u.hitDy = Math.sin(ang) * k; }
    }
    if (u === P) addTrauma(0.15 + f * 1.8); // you got hit
    else if (u.kind === 'hero' && P && dist(u, P) < 6 && f >= 0.06) addTrauma(f * 1.4); // a big hit on a hero near you
    else if (u.kind === 'tower' && P && dist(u, P) < 6 && f >= 0.04) addTrauma(f * 2);
  }
  // your own special: a quick zoom in that settles back
  if (P) { const s = P.def.maxSpecialStocks > 1 ? P.stocks : P.charge;
    if (juice.sp && juice.sp.u === P && juice.sp.ready && s < juice.sp.s && P.alive && effectsOn) { juice.zoomT = 0; juice.zoomA = ZOOM_SPECIAL[P.code] || 0.07; addTrauma(0.3); }
    juice.sp = { u: P, s, ready: P.specialReady }; }
  juice.trauma = Math.max(0, juice.trauma - dt * 1.7);
  const amp = effectsOn ? juice.trauma * juice.trauma * W * 0.03 : 0, t = juice.t; // smooth noise, not a fresh random jump every frame
  juice.sx = amp * (Math.sin(t * 53) + 0.6 * Math.sin(t * 31.7 + 1)) / 1.6; juice.sy = amp * (Math.sin(t * 47.3 + 2) + 0.6 * Math.sin(t * 27.1)) / 1.6;
}
function juiceZoom() {
  if (!effectsOn) return 1; const t = juice.zoomT, e = x => x * x * (3 - 2 * x);
  return 1 + juice.zoomA * (t < 0.09 ? e(t / 0.09) : t < 0.22 ? 1 : t < 0.65 ? 1 - e((t - 0.22) / 0.43) : 0);
}
window.__juice = { state: juice, zoom: juiceZoom, get on() { return effectsOn; } }; // for tests in the browser

// ---------- render ----------
const YS = 0.82; // vertical squash to mimic the tilted camera
// one shake offset per frame: a fresh random offset per call pulled tiles apart and flashed the water through as a blue grid
let shakeX = 0, shakeY = 0;
// a multiplayer guest (team 1) sees the map turned so its own base is at the bottom, like the host and like a match against bots (Rickard).
// Point-symmetric maps are turned 180°, maps that mirror top-to-bottom are mirrored, so both players get the same picture of the map.
// The game itself keeps the host's coordinates; only drawing, camera and joystick go through this.
function viewOf(g) {
  if (g.view) return g.view;
  if (PLAYER_TEAM !== 1) return g.view = { x: 1, y: 1 };
  const m = g.map, t = m.src.tiles; let rot = 0, mir = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) { const v = t[y * m.w + x]; if (v !== t[(m.h - 1 - y) * m.w + m.w - 1 - x]) rot++; if (v !== t[(m.h - 1 - y) * m.w + x]) mir++; }
  return g.view = { x: rot <= mir ? -1 : 1, y: -1 };
}
function wx(x) { return (x - game.cam.x) * viewOf(game).x * SCALE + W / 2 + shakeX; }
function wy(y) { return (game.cam.y - y) * viewOf(game).y * SCALE * YS + H * 0.52 + shakeY; }
function tileSX(tx) { return wx(viewOf(game).x > 0 ? tx : tx + 1); } // screen left edge of a tile column
function tileSY(ty) { return wy(viewOf(game).y > 0 ? ty + 1 : ty); } // screen top edge of a tile row
const COL = { ground: '#efc3c8', ground2: '#e8b6bd', grass: '#3fae7e', grassDark: '#2a8a62', grassLight: '#62c99a', wall: '#8a5a6e', wallTop: '#b07a8d', void: '#4f9fb2', void2: '#468ea0' };
// menu "Graphics": 3D draws the world with the 3D models (render3d.js) under this canvas; 2D is the original drawing
let in3D = false; // true while the current frame's world comes from the 3D view
// the frame is drawn zoomed (SCALE) with staggered units nudged off their spot; both are put back right after, so nothing else sees them
function render() {
  if (!game) return renderFrame();
  const base = SCALE, moved = [], flashes = [];
  SCALE = base * juiceZoom();
  for (const u of game.units) {
    if (!effectsOn) { if (u.flash > 0) { flashes.push([u, u.flash]); u.flash = 0; } continue; }
    if (u.hitT > 0 && u.alive) { const q = u.hitT / u.hitMax, dx = u.hitDx * q * q, dy = u.hitDy * q * q; u.x += dx; u.y += dy; moved.push([u, dx, dy]); }
  }
  try { renderFrame(); } finally { SCALE = base; for (const [u, dx, dy] of moved) { u.x -= dx; u.y -= dy; } for (const [u, f] of flashes) u.flash = f; }
  if (!(game.introAt > 0)) game.introAt = performance.now(); // a new match fades in from dark instead of cutting in from the menu
  const ia = 1 - (performance.now() - game.introAt) / 350; if (ia > 0) { ctx.fillStyle = `rgba(8,12,30,${ia.toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
}
function renderFrame() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (!game) { ctx.fillStyle = COL.void; ctx.fillRect(0, 0, W, H); return; }
  shakeX = juice.sx; shakeY = juice.sy;
  const R3D = window.R3D;
  in3D = !!(use3D && R3D && R3D.render && R3D.render(game, W, H, Math.min(2, DPR), { SCALE, YS, shakeX, shakeY, T_VOID, T_GRASS, T_WALL, PLAYER_TEAM, VIEW: viewOf(game), visible: u => u.team === PLAYER_TEAM || isVisibleTo(u, PLAYER_TEAM) }));
  if (R3D && R3D.ready) in3D ? R3D.show() : R3D.hide();
  const m = game.map, V = viewOf(game);
  if (in3D) ctx.clearRect(0, 0, W, H);
  else {
    ctx.fillStyle = COL.void; ctx.fillRect(0, 0, W, H);
    // water pattern
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2;
    for (let i = -2; i < H / 40 + 2; i++) { const y = ((i * 40 + game.cam.y * V.y * SCALE * YS * 0.5) % (H + 80)); ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(W * 0.3, y - 10, W * 0.6, y + 10, W, y); ctx.stroke(); }
  }
  const ts = SCALE, th = SCALE * YS;
  const x0 = Math.max(0, Math.floor(game.cam.x - VIEW_TILES_W / 2 - 1)), x1 = Math.min(m.w - 1, Math.ceil(game.cam.x + VIEW_TILES_W / 2 + 1));
  const vh = H / th; const y0 = Math.max(0, Math.floor(game.cam.y - vh * 0.55 - 2)), y1 = Math.min(m.h - 1, Math.ceil(game.cam.y + vh * 0.55 + 2));
  // ground layer
  for (let ty = y1; ty >= y0; ty--) for (let tx = x0; tx <= x1; tx++) {
    const t = m.tile(tx, ty); if (t === T_VOID) continue;
    const sx = tileSX(tx), sy = tileSY(ty);
    if (in3D && t !== T_JUMP) continue; // 3D view already has the ground; only the launch pad is drawn here
    if (!in3D) {
    ctx.fillStyle = COL.ground; ctx.fillRect(sx - 0.5, sy - 0.5, ts + 1, th + 1);
    // soft diagonal sand streaks like the original ground texture
    ctx.fillStyle = COL.ground2; const ph = ((tx * 7 + ty * 13) % 5) / 5;
    ctx.beginPath(); ctx.moveTo(sx, sy + th * (0.2 + ph * 0.5)); ctx.quadraticCurveTo(sx + ts * 0.5, sy + th * (0.05 + ph * 0.5), sx + ts, sy + th * (0.25 + ph * 0.5)); ctx.lineTo(sx + ts, sy + th * (0.45 + ph * 0.5)); ctx.quadraticCurveTo(sx + ts * 0.5, sy + th * (0.3 + ph * 0.5), sx, sy + th * (0.4 + ph * 0.5)); ctx.fill();
    // cliff edges toward void on the sides
    if (m.tile(tx - V.x, ty) === T_VOID) { ctx.fillStyle = '#9b6676'; ctx.fillRect(sx - ts * 0.12, sy, ts * 0.12, th + 1); }
    if (m.tile(tx + V.x, ty) === T_VOID) { ctx.fillStyle = '#9b6676'; ctx.fillRect(sx + ts, sy, ts * 0.12, th + 1); }
    // cliff edge where the tile below is void
    if (m.tile(tx, ty - V.y) === T_VOID) { ctx.fillStyle = '#9b6676'; ctx.fillRect(sx - 0.5, sy + th, ts + 1, th * 0.45); ctx.fillStyle = '#7d4f60'; ctx.fillRect(sx - 0.5, sy + th + th * 0.3, ts + 1, th * 0.15); }
    }
    if (t === T_JUMP) { // launch pad: dark plate with a glowing arrow, pulsing so it reads as interactive
      const cx = sx + ts / 2, cy = sy + th / 2, pl = 0.5 + 0.5 * Math.sin(performance.now() / 250);
      ctx.fillStyle = 'rgba(255,90,90,' + (0.25 + 0.25 * pl) + ')'; ctx.beginPath(); ctx.ellipse(cx, cy, ts * 0.62, th * 0.62, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#2f5e57'; ctx.strokeStyle = '#e8f5ee'; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(cx - ts * 0.42, cy - th * 0.42, ts * 0.84, th * 0.84, ts * 0.12); ctx.fill(); ctx.stroke();
      const jp = m.jumpPads.find(j => j.x === tx && j.y === ty); // the arrow points where the pad throws you, on screen (also in a guest's turned view)
      ctx.save(); ctx.translate(cx, cy); if (jp) ctx.rotate(Math.atan2(-jp.vy * V.y * YS, jp.vx * V.x) + Math.PI / 2); ctx.translate(-cx, -cy);
      ctx.fillStyle = '#ff4d5e'; ctx.beginPath(); ctx.moveTo(cx, cy - th * 0.3); ctx.lineTo(cx - ts * 0.26, cy + th * 0.02); ctx.lineTo(cx - ts * 0.1, cy + th * 0.02); ctx.lineTo(cx - ts * 0.1, cy + th * 0.26); ctx.lineTo(cx + ts * 0.1, cy + th * 0.26); ctx.lineTo(cx + ts * 0.1, cy + th * 0.02); ctx.lineTo(cx + ts * 0.26, cy + th * 0.02); ctx.closePath(); ctx.fill(); ctx.restore(); }
  }
  // range rings of towers on the ground
  for (const u of game.units) if (u.kind === 'tower' && u.alive) {
    if (u.team !== PLAYER_TEAM && game.player.alive && dist(u, game.player) < u.def.range + 2) {
      ctx.strokeStyle = 'rgba(255,60,80,0.75)'; ctx.fillStyle = 'rgba(255,60,80,0.13)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(wx(u.x), wy(u.y), u.def.range * ts, u.def.range * th, 0, 0, 7); ctx.fill(); ctx.stroke(); }
    // stone platform rings around the tower
    if (in3D) continue;
    ctx.strokeStyle = 'rgba(150,100,95,0.55)'; ctx.lineWidth = ts * 0.35; ctx.beginPath(); ctx.ellipse(wx(u.x), wy(u.y), 2.6 * ts, 2.6 * th, 0, 0, 7); ctx.stroke();
    ctx.lineWidth = ts * 0.22; ctx.beginPath(); ctx.ellipse(wx(u.x), wy(u.y), 1.3 * ts, 1.3 * th, 0, 0, 7); ctx.stroke();
    ctx.fillStyle = 'rgba(160,110,100,0.25)'; ctx.beginPath(); ctx.ellipse(wx(u.x), wy(u.y), 0.9 * ts, 0.9 * th, 0, 0, 7); ctx.fill();
  }
  // player attack range ring
  const P = game.player;
  if (P.alive) {
    const px = wx(P.x), py = wy(P.y), rx = P.range * ts, ry = P.range * th;
    // auto-attack charge: a disc grows from the hero to the range edge while the attack loads; the swing lands when it touches the edge
    const blocked = P.has('stun') || P.has('disarm'), k = blocked ? 0 : clamp(P.atkTimer / attackCd(P), 0, 1), hit = P.attackAnim > 0 ? P.attackAnim / 0.25 : 0;
    P.charge3 = { k, hit }; // the 3D view draws this on its ground, under the hero models
    if (!in3D) { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.ellipse(px, py, rx, ry, 0, 0, 7); ctx.fill();
    if (k > 0) { ctx.fillStyle = `rgba(255,255,255,${0.14 + 0.16 * k})`; ctx.beginPath(); ctx.ellipse(px, py, rx * k, ry * k, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${0.45 + 0.55 * k})`; ctx.lineWidth = 2.5; ctx.stroke(); }
    ctx.strokeStyle = hit > 0 ? `rgba(255,255,255,${0.55 + 0.45 * hit})` : 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2 + 2 * hit;
    ctx.beginPath(); ctx.ellipse(px, py, rx, ry, 0, 0, 7); ctx.stroke(); } }
  if (game.tut) drawTutWorld(ts, th);
  // ground effects
  for (const p of game.projectiles) {
    if (p.warn) { /* Explosive Rift marker (Rickard's reference, patch 166): crimson disc with a thick crimson rim, a thin pale ring closes in as it collapses */
      const k = clamp(1 + p.t / p.warnMax, 0, 1); ctx.fillStyle = `rgba(225,60,90,${0.34 + 0.16 * k})`; ctx.beginPath(); ctx.ellipse(wx(p.x), wy(p.y), p.warn * ts, p.warn * th, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = '#e8456a'; ctx.lineWidth = Math.max(4, ts * 0.12); ctx.beginPath(); ctx.ellipse(wx(p.x), wy(p.y), p.warn * ts, p.warn * th, 0, 0, 7); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,225,230,0.55)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(wx(p.x), wy(p.y), p.warn * ts * k, p.warn * th * k, 0, 0, 7); ctx.stroke(); ctx.lineWidth = 2; }
    if (p.custom === brambleUpdate && !in3D) { const r = p.P.DamageRange; ctx.fillStyle = p.t < 0 ? 'rgba(150,80,200,0.2)' : 'rgba(120,200,90,0.35)'; ctx.beginPath(); ctx.ellipse(wx(p.x), wy(p.y), r * ts, r * th, 0, 0, 7); ctx.fill(); ctx.strokeStyle = '#5c9b3a'; ctx.stroke(); }
    if (p.custom === laserUpdate && !p.fired) { const L = p.P.Range; ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(wx(p.src.x), wy(p.src.y)); ctx.lineTo(wx(p.src.x + Math.cos(p.ang) * L), wy(p.src.y + Math.sin(p.ang) * L)); ctx.stroke(); }
  }
  // tall objects sorted by y: walls, grass, units
  const items = [];
  if (!in3D) for (let ty = y1; ty >= y0; ty--) for (let tx = x0; tx <= x1; tx++) { const t = m.tile(tx, ty); if (t === T_WALL || t === T_GRASS) items.push({ y: ty + 0.5, t, tx, ty }); }
  for (const u of game.units) if (u.alive || (u.kind === 'minion' && u.deadT > 0)) items.push({ y: u.y, u });
  items.sort((a, b) => (b.y - a.y) * V.y);
  for (const it of items) {
    if (it.u) drawUnit(it.u);
    else if (it.t === T_WALL) drawWall(it.tx, it.ty);
    else drawGrass(it.tx, it.ty);
  }
  // projectiles
  for (const p of game.projectiles) drawProjectile(p);
  for (const e of game.effects) drawFx(e);
  ctx.textAlign = 'center'; ctx.font = `bold ${Math.round(SCALE * 0.38)}px "Trebuchet MS", system-ui, sans-serif`;
  for (const t of game.texts) drawFloatText(t);
  ctx.globalAlpha = 1;
  drawHUD();
  drawScoreTab();
}
function drawWall(tx, ty) {
  const sx = tileSX(tx), sy = tileSY(ty), ts = SCALE, th = SCALE * YS, hgt = th * 0.9;
  ctx.fillStyle = COL.wall; ctx.fillRect(sx, sy - hgt + th, ts, hgt);
  ctx.fillStyle = COL.wallTop; ctx.fillRect(sx, sy - hgt, ts, th);
  ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.strokeRect(sx + 0.5, sy - hgt + 0.5, ts - 1, th - 1);
}
function drawGrass(tx, ty) {
  const sx = tileSX(tx), sy = tileSY(ty), ts = SCALE, th = SCALE * YS;
  const playerIn = game.player.alive && Math.floor(game.player.x) === tx && Math.floor(game.player.y) === ty;
  ctx.globalAlpha = playerIn ? 0.55 : 1;
  // leafy bush clumps
  const blobs = [[0.25, 0.75, 0.32], [0.75, 0.75, 0.32], [0.5, 0.45, 0.36], [0.2, 0.3, 0.26], [0.8, 0.3, 0.26]];
  ctx.fillStyle = COL.grassDark; for (const [bx, by, br] of blobs) { ctx.beginPath(); ctx.arc(sx + ts * bx, sy + th * by - th * 0.1, ts * br, 0, 7); ctx.fill(); }
  ctx.fillStyle = COL.grass; for (const [bx, by, br] of blobs) { ctx.beginPath(); ctx.arc(sx + ts * bx, sy + th * by - th * 0.22, ts * br * 0.85, 0, 7); ctx.fill(); }
  ctx.fillStyle = COL.grassLight; for (const [bx, by, br] of blobs) { ctx.beginPath(); ctx.arc(sx + ts * (bx - 0.06), sy + th * by - th * 0.32, ts * br * 0.35, 0, 7); ctx.fill(); }
  if ((tx * 31 + ty * 17) % 4 === 0) { ctx.fillStyle = '#f7a1c4'; ctx.beginPath(); ctx.arc(sx + ts * 0.6, sy + th * 0.35, 2.5, 0, 7); ctx.fill(); }
  ctx.globalAlpha = 1;
}
function teamColor(u) { if (u.isPlayer) return '#3be37a'; return u.team === PLAYER_TEAM ? '#3aa0ff' : '#ff3b4e'; }
// floating numbers and words: pop out big and settle, rise fast then slow, drift a little sideways and fade at the end.
// Damage numbers belong to the viewer: your hits white (bigger for a big hit), hits on you red, others' hidden.
function drawFloatText(t) {
  const P = game.player; let col = t.color, size = 1;
  if (t.v) { const f = t.dmg / Math.max(1, t.v.maxHp || 1);
    if (P && t.v === P) col = '#ff6b6b'; else if (!P || t.a === P) col = '#ffffff'; // no gold big-hit numbers (Rickard) else return;
    size = 0.8 + Math.min(0.45, f * 2.5);
  } else if (t.hv && P && t.hv !== P && t.hb !== P) return; // heal numbers: only on you, or on someone you healed
  else if (t.team !== undefined && t.team !== PLAYER_TEAM) return;
  const max = t.max || 0.9, age = max - t.t, e = x => 1 - (1 - Math.min(1, x)) ** 3;
  const pop = age < 0.13 ? 1 + 0.55 * (1 - e(age / 0.13)) : 1;
  const x = t.x + (t.vx || 0) * e(age / max) * 0.6, y = t.y + (t.max ? 0.75 * e(age / max) : 0);
  ctx.globalAlpha = clamp(t.t / 0.3, 0, 1); ctx.font = `bold ${Math.round(SCALE * 0.38 * size * pop)}px "Trebuchet MS", system-ui, sans-serif`;
  ctx.lineWidth = Math.max(3, SCALE * 0.08 * size); ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(t.text, wx(x), wy(y)); ctx.fillStyle = col; ctx.fillText(t.text, wx(x), wy(y));
}
function drawUnit(u) {
  const vis = isVisibleTo(u, PLAYER_TEAM); if (!vis && u.team !== PLAYER_TEAM) return;
  const sx = wx(u.x), sy = wy(u.y), ts = SCALE;
  const alpha = (u.has('invisible') || (game.map.inGrass(u) && u.team === PLAYER_TEAM)) ? 0.5 : 1;
  ctx.globalAlpha = alpha * (u.alive ? 1 : clamp(u.deadT / 0.6, 0, 1));
  // shadow
  ctx.fillStyle = 'rgba(60,20,40,0.25)'; ctx.beginPath(); ctx.ellipse(sx, sy, u.r * ts * 1.4 + 3, u.r * ts * 0.7 + 2, 0, 0, 7); ctx.fill();
  if (u.kind === 'tower') drawTower(u, sx, sy);
  else if (u.kind === 'minion') drawMinion(u, sx, sy);
  else drawHero(u, sx, sy);
  ctx.globalAlpha = 1;
}
function drawTower(u, sx, sy) {
  const ts = SCALE, c = u.team === PLAYER_TEAM ? '#3a8cff' : '#ff3b4e', h = ts * 2.4;
  if (in3D) { hpBar(u, sx, sy - ts * 2.0, ts * 1.4, 7, u.team === PLAYER_TEAM ? '#3aa0ff' : '#ff3b4e', 0); return; } // tower model is in the 3D view
  ctx.fillStyle = '#7e6a8e'; ctx.beginPath(); ctx.ellipse(sx, sy, ts * 0.55, ts * 0.3, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#e9e3f2'; ctx.beginPath(); ctx.moveTo(sx - ts * 0.32, sy); ctx.lineTo(sx - ts * 0.18, sy - h); ctx.lineTo(sx + ts * 0.18, sy - h); ctx.lineTo(sx + ts * 0.32, sy); ctx.fill();
  ctx.fillStyle = c; ctx.fillRect(sx - ts * 0.2, sy - h * 0.75, ts * 0.4, h * 0.45);
  ctx.fillStyle = u.flash > 0 ? '#fff' : c; ctx.beginPath(); ctx.moveTo(sx, sy - h - ts * 0.6); ctx.lineTo(sx + ts * 0.25, sy - h - ts * 0.15); ctx.lineTo(sx, sy - h + ts * 0.15); ctx.lineTo(sx - ts * 0.25, sy - h - ts * 0.15); ctx.fill();
  hpBar(u, sx, sy - h - ts * 0.85, ts * 1.4, 7, u.team === PLAYER_TEAM ? '#3aa0ff' : '#ff3b4e', 0);
}
function drawMinion(u, sx, sy) {
  const ts = SCALE, r = u.r * ts * 1.5, c = u.team === PLAYER_TEAM ? '#5fb6ff' : '#ff5a6a';
  const hurt = u.hp < u.maxHp - 0.5; // a full-health minion shows no bar: a wave of them read as a smear of bars (testers)
  if (in3D) { if (hurt) hpBar(u, sx, sy - ts * 1.1, ts * 0.55, 4, c, 0); return; } // minion model is in the 3D view
  const bob = Math.sin((u.walkT || 0) * 12) * 2;
  ctx.fillStyle = u.flash > 0 ? '#fff' : c; ctx.beginPath(); ctx.ellipse(sx, sy - r + bob, r, r * 0.85, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx - r * 0.35, sy - r * 1.1 + bob, r * 0.25, 0, 7); ctx.arc(sx + r * 0.35, sy - r * 1.1 + bob, r * 0.25, 0, 7); ctx.fill();
  ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(sx - r * 0.35, sy - r * 1.1 + bob, r * 0.11, 0, 7); ctx.arc(sx + r * 0.35, sy - r * 1.1 + bob, r * 0.11, 0, 7); ctx.fill();
  if (u.type === 'SiegeMinion') { ctx.strokeStyle = '#333'; ctx.lineWidth = 3; ctx.strokeRect(sx - r * 0.6, sy - r * 1.9 + bob, r * 1.2, r * 0.4); }
  if (hurt) hpBar(u, sx, sy - r * 2.3, ts * 0.55, 4, c, 0);
}
function drawHero(u, sx, sy) {
  const ts = SCALE, c = teamColor(u);
  let lift = 0;
  if (u.specialActive && u.specialActive.inAir !== undefined) { const s = u.specialActive.s, t = u.specialActive.t; lift = u.specialActive.inAir ? (u.specialActive.landing ? ts * 2.5 * clamp(u.specialActive.landT / s.LandDuration, 0, 1) : ts * 2.5 * clamp((t - s.PreJumpDuration) / s.JumpDuration, 0, 1)) : 0; }
  if (u.has('jumping')) lift = ts * 0.9;
  // base ring (not under 3D hero models)
  if (!(in3D && window.R3D.hasHero && window.R3D.hasHero(u.code))) { ctx.strokeStyle = c; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(sx, sy, ts * 0.42, ts * 0.22, 0, 0, 7); ctx.stroke(); }
  if (!in3D && u.specialActive && u.code === 'Barbarian') { const r = u.def.scripts.SpecialWhirlwindScript.DamageRadius; ctx.strokeStyle = 'rgba(170,90,255,0.8)'; ctx.lineWidth = 6; const a = game.time * 14; ctx.beginPath(); ctx.ellipse(sx, sy, r * ts, r * ts * YS, 0, a, a + 4); ctx.stroke(); ctx.strokeStyle = 'rgba(80,230,170,0.7)'; ctx.beginPath(); ctx.ellipse(sx, sy, r * ts * 0.8, r * ts * YS * 0.8, 0, a + 3, a + 5.5); ctx.stroke(); }
  if (!in3D && u.specialActive && u.code === 'Banshee') { ctx.fillStyle = 'rgba(160,90,255,0.45)'; ctx.beginPath(); ctx.arc(sx, sy - ts * 0.4, ts * 0.9, 0, 7); ctx.fill(); }
  if (ccImmune(u)) { ctx.strokeStyle = 'rgba(255,140,200,0.85)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(sx, sy - ts * 0.5, ts * 0.62, ts * 0.72, 0, 0, 7); ctx.stroke(); }
  if (u.specialActive && u.specialActive.joker) { ctx.strokeStyle = 'rgba(255,200,80,0.6)'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.ellipse(sx, sy, u.range * ts, u.range * ts * YS, 0, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
  // body
  const size = ts * 1.05, im = u.icon;
  const hy = sy - size * 0.55 - lift + (u.attackAnim > 0 ? -3 : 0);
  u.lift3 = lift / ts; // read by the 3D view, which draws the hero model when there is one
  if (!(in3D && window.R3D.hasHero && window.R3D.hasHero(u.code))) {
  ctx.save();
  if (u.flash > 0) ctx.filter = 'brightness(2.2)';
  if (u.has('stun')) ctx.filter = 'grayscale(0.6)';
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(sx, hy, size * 0.48, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(sx, hy, size * 0.44, 0, 7); ctx.clip();
  ctx.fillStyle = '#2b2350'; ctx.fillRect(sx - size / 2, hy - size / 2, size, size);
  if (im.complete && im.naturalWidth) { const ar = im.naturalWidth / im.naturalHeight; ctx.drawImage(im, sx - size * 0.5 * ar, hy - size * 0.5, size * ar, size); }
  ctx.restore();
  }
  if (u.has('stun')) { ctx.fillStyle = '#ffe66b'; for (let i = 0; i < 3; i++) { const a = game.time * 5 + i * 2.1; ctx.beginPath(); ctx.arc(sx + Math.cos(a) * size * 0.4, hy - size * 0.55 + Math.sin(a) * 4, 3, 0, 7); ctx.fill(); } }
  if (u.expireFx > 0) { u.expireFx -= 1 / 60; }
  if (u.code === 'Automaton' && u.overload) { ctx.fillStyle = '#7fe8ff'; for (let i = 0; i < u.overload; i++) ctx.fillRect(sx - 12 + i * 7, hy + size * 0.5, 5, 5); }
  if (u.has('invulnerable')) { ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, hy, size * 0.62, 0, 7); ctx.stroke(); }
  // name + hp
  const bw = ts * 1.1;
  { ctx.font = `bold ${Math.round(ts * 0.27)}px "Trebuchet MS", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.lineJoin = 'round'; // dark outline keeps the name readable on any ground
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,24,0.9)'; ctx.strokeText(u.name, sx, hy - size * 0.95); ctx.fillStyle = '#fff'; ctx.fillText(u.name, sx, hy - size * 0.95); }
  hpBar(u, sx, hy - size * 0.78, bw, 6, c, 4);
  if (u.emote) { const a = game.time - u.emote.at; if (a >= 0 && a < EMOTE_T) drawEmoteBubble(sx, hy - size * 1.55, ts * 0.42 * Math.min(1, a * 6) * (a > EMOTE_T - 0.25 ? (EMOTE_T - a) / 0.25 : 1)); }
  if (u.pickedFx) { const a = game.time - u.pickedFx.t, D = 2.5; if (a < 0 || a > D) u.pickedFx = null; else drawPickedItem(u.pickedFx.key, sx, hy - size * 1.35, ts * 0.42, a, D); }
}
// icon of a just-picked item over a hero: pops in, floats a little, fades out
function drawPickedItem(k, x, y, r, a, D) {
  const v = ID[k], pop = a < 0.2 ? 0.6 + 2 * a : a < 0.35 ? 1.2 - (a - 0.2) * 1.33 : 1, fade = a > D - 0.5 ? (D - a) / 0.5 : 1;
  ctx.save(); ctx.globalAlpha = fade; const rr = r * pop, yy = y - a * r * 0.25;
  ctx.fillStyle = rarityFill(v.Rarity, yy - rr, yy + rr); ctx.beginPath(); ctx.arc(x, yy, rr, 0, 7); ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(10,16,48,0.85)'; ctx.stroke();
  const ic = itemIcon(k); if (imgOk(ic)) drawFit(ic, x, yy, rr * 1.5);
  ctx.restore();
}
function hpBar(u, x, y, w, h, color, segments) {
  ctx.fillStyle = 'rgba(20,10,30,0.75)'; ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = color; ctx.fillRect(x - w / 2, y, w * clamp(u.hp / u.maxHp, 0, 1), h);
  const sh = u.statuses.find(s => s.type === 'shield'); if (sh) { ctx.fillStyle = '#fff'; ctx.fillRect(x - w / 2 + w * clamp(u.hp / u.maxHp, 0, 1), y, w * clamp(sh.amount / u.maxHp, 0, 1), h); }
  if (segments) { ctx.fillStyle = 'rgba(20,10,30,0.8)'; const seg = Math.max(2, Math.round(u.maxHp / 100)); for (let i = 1; i < seg; i++) ctx.fillRect(x - w / 2 + w * i / seg - 0.5, y, 1, h); }
}
function drawProjectile(p) {
  if (in3D && p.fx && p.fx !== 'bramble') return; // hook, magic arrow, laser and meteor are drawn by the 3D view
  if (p.t < 0 && !p.warn && p.custom !== brambleUpdate) return;
  const sx = wx(p.x), sy = wy(p.y) - SCALE * 0.5;
  if (p.custom === hookUpdate) { ctx.strokeStyle = '#ff7fae'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(wx(p.src.x), wy(p.src.y) - SCALE * 0.5); ctx.lineTo(sx, sy); ctx.stroke(); ctx.fillStyle = '#ff4f8f'; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fill(); return; }
  if (p.custom === arrowUpdate) { ctx.save(); ctx.translate(sx, sy); ctx.rotate(-p.ang); ctx.fillStyle = '#fff6a8'; ctx.shadowColor = '#fff6a8'; ctx.shadowBlur = 15; ctx.fillRect(-18, -3, 36, 6); ctx.restore(); return; }
  if (p.custom === laserUpdate) { if (!p.fired) return; const L = p.P.Range, w = p.P.FullScaleWidth * SCALE * clamp(p.showT / 0.5, 0, 1); ctx.strokeStyle = 'rgba(180,240,255,0.85)'; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(wx(p.x), wy(p.y) - SCALE * 0.5); ctx.lineTo(wx(p.x + Math.cos(p.ang) * L), wy(p.y + Math.sin(p.ang) * L) - SCALE * 0.5); ctx.stroke(); ctx.lineCap = 'butt'; return; }
  if (p.warn) { if (p.t > -0.5) { const k = clamp((p.t + 0.5) / 0.5, 0, 1); ctx.fillStyle = '#ff8a3d'; ctx.beginPath(); ctx.arc(sx, sy - (1 - k) * SCALE * 6, SCALE * 0.4, 0, 7); ctx.fill(); } return; }
  if (p.custom) return;
  if (in3D) return; // auto-attack projectiles are drawn by the 3D view with the fx textures
  if (p.src && p.src.code === 'Brawler' && !p.joker) return; // Bronson punches: nothing flies
  const c = p.kind === 'tower' ? (p.src.team === PLAYER_TEAM ? '#8fd3ff' : '#ff7f8f') : p.joker ? '#ffd36b' : p.src.code === 'Kunoichi' ? '#ff9fd0' : p.src.team === PLAYER_TEAM ? '#d8f0ff' : '#ffd0d6';
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(sx, sy - (p.kind === 'tower' ? SCALE * 1.2 * (1 - clamp(p.t * 2, 0, 1)) : 0), p.big ? 7 : p.kind === 'tower' ? 6 : 4, 0, 7); ctx.fill();
}
function drawFx(e) {
  if (e.u) { e.x = e.u.x; e.y = e.u.y; }
  if (in3D && (e.type === 'hit' || e.type === 'bolt' || e.type === 'boom')) return; // drawn by the 3D view
  const k = e.t / e.max, sx = wx(e.x), sy = wy(e.y);
  if (e.type === 'heal') { // green ground ring and rising pluses around the healed unit
    if (game.player && e.u !== game.player && e.hb !== game.player) return; // only your own heals and the ones you gave
    if (e.u && !isVisibleTo(e.u, PLAYER_TEAM)) return; // a hero hidden in a bush or invisible must not give itself away (Rickard)
    const a = Math.min(1, k * 2.5); ctx.globalAlpha = a * 0.8; ctx.strokeStyle = '#6bff8f'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(sx, sy, SCALE * (0.45 + 0.35 * (1 - k)), SCALE * YS * (0.45 + 0.35 * (1 - k)), 0, 0, 7); ctx.stroke();
    const s = Math.max(4, SCALE * 0.13); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,40,15,0.7)'; ctx.fillStyle = '#6bff8f';
    for (let i = 0; i < 2; i++) { const px = sx + (i ? 1 : -1) * SCALE * 0.5, py = sy - SCALE * (0.7 + (1 - k) * 0.9 + i * 0.35);
      ctx.beginPath(); ctx.moveTo(px - s / 3, py - s); ctx.lineTo(px + s / 3, py - s); ctx.lineTo(px + s / 3, py - s / 3); ctx.lineTo(px + s, py - s / 3); ctx.lineTo(px + s, py + s / 3); ctx.lineTo(px + s / 3, py + s / 3);
      ctx.lineTo(px + s / 3, py + s); ctx.lineTo(px - s / 3, py + s); ctx.lineTo(px - s / 3, py + s / 3); ctx.lineTo(px - s, py + s / 3); ctx.lineTo(px - s, py - s / 3); ctx.lineTo(px - s / 3, py - s / 3); ctx.closePath(); ctx.stroke(); ctx.fill(); }
    ctx.globalAlpha = 1; return; }
  if (e.type === 'hit') { ctx.strokeStyle = e.color; ctx.globalAlpha = k * (e.minor ? 0.4 : e.auto ? 0.6 : 1); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sx, sy - SCALE * 0.5, (1 - k) * SCALE * (e.big ? 0.7 : 0.4) + 4, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
  if (e.type === 'ring') { ctx.strokeStyle = e.color; ctx.globalAlpha = k; ctx.lineWidth = 4; ctx.beginPath(); ctx.ellipse(sx, sy, e.r * SCALE * (1.3 - k * 0.3), e.r * SCALE * YS * (1.3 - k * 0.3), 0, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
  if (e.type === 'boom') { ctx.fillStyle = e.color; ctx.globalAlpha = k * 0.6; ctx.beginPath(); ctx.ellipse(sx, sy, e.r * SCALE * (1.2 - k * 0.4), e.r * SCALE * YS * (1.2 - k * 0.4), 0, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
  if (e.type === 'bolt') { ctx.strokeStyle = e.color; ctx.globalAlpha = k; ctx.lineWidth = 3; ctx.beginPath(); const x2 = wx(e.x2), y2 = wy(e.y2) - SCALE * 0.5; let x = sx, y = sy - SCALE * 0.5; ctx.moveTo(x, y); for (let i = 1; i <= 5; i++) { ctx.lineTo(lerp(sx, x2, i / 5) + (i < 5 ? rand(-6, 6) : 0), lerp(sy - SCALE * 0.5, y2, i / 5) + (i < 5 ? rand(-6, 6) : 0)); } ctx.stroke(); ctx.globalAlpha = 1; }
}
function drawStar(x, y, r) { ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.closePath();
  ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, r * 0.3); ctx.strokeStyle = '#120c18'; ctx.stroke(); ctx.fillStyle = '#ffc531'; ctx.fill(); ctx.lineJoin = 'miter'; } // gold star with a black outline, as in the original
// score tab (bookmark button, top right): both teams with K/D/A and items; EXIT GAME at the bottom goes back to the menu. The match keeps running.
const SCORE_EXIT = () => ({ x: W * 0.25, y: H * 0.86, w: W * 0.5, h: H * 0.06 });
function drawScoreTab() {
  const g = game; if (!g || g.tut || !(g.state === 'play' || g.state === 'countdown')) { if (g) g.scoreOpen = false; return; }
  const b = SCORE_BTN(); // bookmark button
  ctx.fillStyle = 'rgba(20,28,62,0.9)'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.stroke();
  const bw = b.r * 0.62, bh = b.r * 0.9; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(b.x - bw / 2, b.y - bh / 2); ctx.lineTo(b.x + bw / 2, b.y - bh / 2); ctx.lineTo(b.x + bw / 2, b.y + bh / 2);
  ctx.lineTo(b.x, b.y + bh * 0.18); ctx.lineTo(b.x - bw / 2, b.y + bh / 2); ctx.closePath(); ctx.fill();
  if (!g.scoreOpen) return;
  ctx.save(); ctx.fillStyle = 'rgba(6,9,26,0.86)'; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(W * 0.06)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillText('SCORE', W / 2, H * 0.08);
  const rowH = H * 0.075, x0 = W * 0.05, w = W * 0.9;
  [[PLAYER_TEAM, '#3aa0ff', H * 0.14], [ENEMY_TEAM, '#ff3b4e', H * 0.48]].forEach(([team, col, y0]) => {
    ctx.font = `bold ${Math.round(W * 0.038)}px "Trebuchet MS", system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = col;
    ctx.fillText(team === PLAYER_TEAM ? 'YOUR TEAM' : 'ENEMY TEAM', x0, y0 + H * 0.02); ctx.textAlign = 'right'; ctx.fillStyle = '#a9b4e8'; ctx.fillText('K / D / A', x0 + w * 0.62, y0 + H * 0.02);
    g.units.filter(u => u.kind === 'hero' && !u.isIllusion && u.team === team).forEach((u, i) => {
      const y = y0 + H * 0.045 + i * (rowH + H * 0.01), cy = y + rowH / 2, r = rowH * 0.36;
      ctx.fillStyle = u.isPlayer ? 'rgba(58,160,255,0.28)' : 'rgba(30,40,88,0.85)'; ctx.beginPath(); ctx.roundRect(x0, y, w, rowH, rowH * 0.2); ctx.fill();
      ctx.fillStyle = col; ctx.fillRect(x0, y + rowH * 0.15, 4, rowH * 0.7);
      ctx.save(); ctx.beginPath(); ctx.arc(x0 + r + W * 0.025, cy, r, 0, 7); ctx.fillStyle = '#2b2350'; ctx.fill(); ctx.clip();
      if (imgOk(u.icon)) { const ar = u.icon.naturalWidth / u.icon.naturalHeight; ctx.drawImage(u.icon, x0 + W * 0.025 + r - r * ar, cy - r, r * 2 * ar, r * 2); } ctx.restore();
      if (!u.alive) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.arc(x0 + r + W * 0.025, cy, r, 0, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = `bold ${Math.round(r * 0.8)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillText(Math.ceil(Math.max(0, u.respawnT || 0)), x0 + r + W * 0.025, cy); }
      const tx = x0 + r * 2 + W * 0.05; ctx.textAlign = 'left';
      ctx.font = `bold ${Math.round(rowH * 0.27)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#fff'; ctx.fillText(u.name, tx, cy - rowH * 0.15);
      ctx.font = `${Math.round(rowH * 0.22)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#a9b4e8'; ctx.fillText(heroName(u.code), tx, cy + rowH * 0.18);
      ctx.textAlign = 'right'; ctx.font = `bold ${Math.round(rowH * 0.3)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#fff';
      ctx.fillText(`${u.kills || 0} / ${u.deaths || 0} / ${u.assists || 0}`, x0 + w * 0.62, cy);
      (u.items || []).forEach((it, k) => { const ir = rowH * 0.24, ix = x0 + w * 0.7 + k * ir * 2.3, ic = itemIcon(it.key);
        ctx.fillStyle = rarityFill(ID[it.key].Rarity, cy - ir, cy + ir); ctx.beginPath(); ctx.arc(ix, cy, ir, 0, 7); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(10,16,48,0.85)'; ctx.stroke();
        if (imgOk(ic)) drawFitTrim(ic, ix, cy, ir * 1.4); });
    });
  });
  const x = SCORE_EXIT(); ctx.fillStyle = '#e8434f'; ctx.beginPath(); ctx.roundRect(x.x, x.y, x.w, x.h, x.h * 0.3); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#ffb3b9'; ctx.stroke();
  ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(x.h * 0.42)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillText('EXIT GAME', x.x + x.w / 2, x.y + x.h / 2);
  ctx.font = `${Math.round(W * 0.03)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#a9b4e8'; ctx.fillText('Tap anywhere else to close', W / 2, x.y + x.h + H * 0.025);
  ctx.restore();
}
const HUD_FONT = '"Lilita One", "Trebuchet MS", system-ui, sans-serif';
try { if (document.fonts) document.fonts.load('20px "Lilita One"'); } catch (e) {} // canvas text doesn't trigger webfont loading by itself
function hudText(t, x, y, font, col = '#fff') { ctx.font = font; ctx.fillStyle = 'rgba(5,12,40,0.55)'; ctx.fillText(t, x, y + Math.max(1.5, H * 0.002)); ctx.fillStyle = col; ctx.fillText(t, x, y); } // drop shadow under HUD text
// emote: a white disc with a red heart (button above special; a bubble over the hero for EMOTE_T seconds).
// Multiplayer sends it to the other player (net.js); against bots, one of them sometimes hearts back.
const EMOTE_T = 2;
let emoteLast = -1e9;
function emoteReady() { return game && game.net ? !game.net.emoteReady || game.net.emoteReady() : performance.now() / 1000 - emoteLast >= EMOTE_T; }
function playerEmote() {
  if (game.net) { if (game.net.emote) game.net.emote(); return; }
  if (!emoteReady() || !game.player) return; emoteLast = performance.now() / 1000; game.player.emote = { at: game.time };
  const bots = heroes().filter(h => h !== game.player && h.alive && !h.isIllusion && !(h.emote && game.time - h.emote.at < EMOTE_T));
  if (bots.length && Math.random() < 0.6) pick(bots).emote = { at: game.time + rand(0.6, 1.6) }; // drawn once its time comes
}
function drawHeart(x, y, r) { ctx.fillStyle = '#e8243c'; ctx.beginPath(); ctx.moveTo(x, y + r * 0.75); ctx.bezierCurveTo(x - r * 1.25, y - r * 0.05, x - r * 0.6, y - r * 0.95, x, y - r * 0.35); ctx.bezierCurveTo(x + r * 0.6, y - r * 0.95, x + r * 1.25, y - r * 0.05, x, y + r * 0.75); ctx.fill(); }
function drawEmoteBubble(x, y, r) { if (r <= 0) return; ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(x, y + r * 0.08, r, 0, 7); ctx.fill(); ctx.fillStyle = '#f4f4f7'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); drawHeart(x, y + r * 0.05, r * 0.55); }
function drawHUD() {
  const g = game, p = g.player;
  // top bar: tower health of both teams and the shared level
  const bt = towerOf(PLAYER_TEAM), rt = towerOf(ENEMY_TEAM);
  const barY = H * 0.062, barH = Math.max(18, H * 0.028), cx = W / 2, bw = W * 0.36, lr = barH * 1.35;
  if (!g.tut || g.tut.match) {
  // tower bars as in the original: dark navy frame, both bars anchored at the level badge and emptying toward the outer edge,
  // with a light trail showing recent damage (it catches up after a short delay); rounded heavy font (Lilita One, see index.html)
  const bk = clamp(bt.hp / bt.maxHp, 0, 1), rk = clamp(rt.hp / rt.maxHp, 0, 1), tr = g.hudTrail || (g.hudTrail = { b: bk, r: rk, bt: 0, rt: 0 });
  for (const [k, v, t] of [['b', bk, 'bt'], ['r', rk, 'rt']]) { if (v > tr[k]) tr[k] = v; else if (v < tr[k]) { if (!tr[t]) tr[t] = g.time + 0.6; if (g.time > tr[t]) tr[k] = Math.max(v, tr[k] - 0.6 / 60); if (tr[k] === v) tr[t] = 0; } }
  ctx.fillStyle = '#0b1a52'; ctx.beginPath(); ctx.roundRect(cx - bw - 4, barY - 3, bw * 2 + 8, barH + 6, 3); ctx.fill();
  ctx.fillStyle = '#7fd2ff'; ctx.fillRect(cx - bw * tr.b, barY, bw * tr.b, barH); ctx.fillStyle = '#1f8fff'; ctx.fillRect(cx - bw * bk, barY, bw * bk, barH);
  ctx.fillStyle = '#ffae2e'; ctx.fillRect(cx, barY, bw * tr.r, barH); ctx.fillStyle = '#ff2f3f'; ctx.fillRect(cx, barY, bw * rk, barH);
  ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(cx - bw, barY, bw * 2, barH * 0.38); // soft top sheen
  const pct = (v, x, al) => { const n = String(Math.ceil(v * 100)), big = `${Math.round(barH * 0.92)}px ${HUD_FONT}`, sm = `${Math.round(barH * 0.5)}px ${HUD_FONT}`;
    ctx.font = big; const wn = ctx.measureText(n).width; ctx.font = sm; const wp = ctx.measureText('%').width, x0 = al < 0 ? x - wn - wp : x, y = barY + barH * 0.84;
    hudText(n, x0, y, big); hudText('%', x0 + wn + 1, y, sm); };
  ctx.textAlign = 'left'; pct(bk, cx - lr * 1.25, -1); pct(rk, cx + lr * 1.25, 1);
  ctx.fillStyle = '#0b1a52'; ctx.beginPath(); ctx.arc(cx, barY + barH / 2, lr, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, barY + barH / 2, lr - 4, 0, 7); ctx.stroke();
  const prog = g.level < MATCH.leveling.MaxLevel ? (Math.max(0, g.time) % MATCH.leveling.SecondsPerLevel) / MATCH.leveling.SecondsPerLevel : 1;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(cx, barY + barH / 2, lr - 4, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke(); ctx.lineCap = 'butt';
  ctx.textAlign = 'center';
  if (g.level >= MATCH.leveling.MaxLevel) { hudText('MAX', cx, barY + barH / 2 - 1, `${Math.round(lr * 0.42)}px ${HUD_FONT}`); hudText('LEVEL', cx, barY + barH / 2 + lr * 0.45, `${Math.round(lr * 0.36)}px ${HUD_FONT}`, '#f6e2b8'); }
  else { hudText('LVL', cx, barY + barH / 2 - lr * 0.22, `${Math.round(lr * 0.4)}px ${HUD_FONT}`); hudText(g.level, cx, barY + barH / 2 + lr * 0.55, `${Math.round(lr * 0.82)}px ${HUD_FONT}`, '#f6e2b8'); }
  // star advantage bars: three star pips under each team's bar
  if (!g.noStars) for (const [team, x0, dir] of [[PLAYER_TEAM, cx - lr * 1.1, -1], [ENEMY_TEAM, cx + lr * 1.1, 1]]) {
    const sw = bw * 0.62, sy = barY + barH + 5, sh = Math.max(4, barH * 0.28), xs = dir < 0 ? x0 - sw : x0, st = g.stars[team], N = GD.starAdvantage.length;
    const gap = Math.max(2, sw * 0.012), segW = (sw - gap * (N - 1)) / N;
    ctx.fillStyle = '#0b1a52'; ctx.fillRect(xs - 2, sy - 2, sw + 4, sh + 4);
    for (let i = 0; i < N; i++) { const sx0 = dir < 0 ? x0 - (i + 1) * segW - i * gap : x0 + i * (segW + gap), on = i < st; // stars fill outward from the level badge
      ctx.fillStyle = on ? '#f4f6ff' : '#1a3488'; ctx.fillRect(sx0, sy, segW, sh);
      if (on) drawStar(sx0 + segW / 2, sy + sh / 2, sh * 1.05); }
  }
  // (no kill counters under the bars: the original has none; kills are in the score tab)
  }
  // kill feed
  ctx.textAlign = 'left'; let fy = barY + barH + lr * 1.9;
  for (const f of g.feed) {
    ctx.globalAlpha = clamp(f.t, 0, 1); ctx.font = `bold ${Math.round(W * 0.033)}px "Trebuchet MS", system-ui, sans-serif`;
    if (f.v) { ctx.fillStyle = 'rgba(20,30,70,0.7)'; ctx.fillRect(8, fy - W * 0.035, W * 0.5, W * 0.048); ctx.fillStyle = f.kt === PLAYER_TEAM ? '#7fc4ff' : f.kt ? '#ff8a96' : '#ddd'; ctx.fillText(f.k, 14, fy); const kw = ctx.measureText(f.k + ' ⚔ ').width; ctx.fillStyle = '#fff'; ctx.fillText('⚔', 14 + ctx.measureText(f.k + ' ').width, fy); ctx.fillStyle = f.vt === PLAYER_TEAM ? '#7fc4ff' : '#ff8a96'; ctx.fillText(f.v, 14 + kw, fy); fy += W * 0.055; }
    if (f.tag) { ctx.font = `italic bold ${Math.round(W * 0.045)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1a3a8a'; ctx.lineWidth = 3; for (const line of f.tag.split('\n')) { ctx.strokeText(line, 20, fy); ctx.fillText(line, 20, fy); fy += W * 0.06; } }
  }
  ctx.globalAlpha = 1;
  // joystick
  const jb = joyBase(), R = JOY_R();
  const ib = IMG.ui_ingameView_joystick_base, ik = IMG.ui_ingameView_joystick;
  ctx.globalAlpha = 0.85;
  if (ib.complete && ib.naturalWidth) ctx.drawImage(ib, jb.x - R * 1.25, jb.y - R * 1.25, R * 2.5, R * 2.5); else { ctx.fillStyle = 'rgba(30,40,80,0.5)'; ctx.beginPath(); ctx.arc(jb.x, jb.y, R * 1.2, 0, 7); ctx.fill(); }
  const { x: kx, y: ky } = joyStick();
  if (ik.complete && ik.naturalWidth) ctx.drawImage(ik, kx - R * 0.6, ky - R * 0.6, R * 1.2, R * 1.2); else { ctx.fillStyle = '#2e3a6b'; ctx.beginPath(); ctx.arc(kx, ky, R * 0.55, 0, 7); ctx.fill(); }
  ctx.globalAlpha = 1;
  // special button with charge ring
  if (g.tut) drawTutHUD();
  if (!g.tut && g.state !== 'over') { const e = EMOTE_BTN(); ctx.globalAlpha = emoteReady() ? 1 : 0.5; drawEmoteBubble(e.x, e.y, e.r); ctx.globalAlpha = 1; }
  const b = SPECIAL_BTN(); const ready = p.alive && p.specialReady;
  if (!g.tut || g.tut.special) {
  const frac = p.def.maxSpecialStocks > 1 ? (p.stocks / p.def.maxSpecialStocks) : p.charge / p.def.maxSpecialCharges;
  ctx.fillStyle = ready ? '#1d4fb8' : '#1d2a55'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
  ctx.lineWidth = b.r * 0.14; ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.93, 0, 7); ctx.stroke();
  ctx.strokeStyle = ready ? '#ffc94a' : '#f0b640'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.93, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(frac, 0, 1)); ctx.stroke();
  if (ready) { ctx.strokeStyle = `rgba(255,220,120,${0.5 + 0.4 * Math.sin(g.time * 6)})`; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 1.08, 0, 7); ctx.stroke(); }
  const si = p.spIcon; ctx.globalAlpha = ready ? 1 : 0.45;
  if (si.complete && si.naturalWidth) ctx.drawImage(si, b.x - b.r * 0.62, b.y - b.r * 0.62, b.r * 1.24, b.r * 1.24);
  ctx.globalAlpha = 1;
  if (p.def.maxSpecialStocks > 1) { ctx.font = `bold ${Math.round(b.r * 0.4)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(p.stocks, b.x + b.r * 0.7, b.y - b.r * 0.6); }
  }
  drawItemHUD();
  // countdown / respawn / result
  ctx.textAlign = 'center';
  if (g.state === 'countdown') { const py = H * 0.3; ctx.fillStyle = 'rgba(30,36,60,0.85)'; ctx.fillRect(W * 0.15, py - H * 0.04, W * 0.7, H * 0.085);
    ctx.font = `bold ${Math.round(W * 0.04)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#fff'; ctx.fillText('Match starts in', W / 2, py); ctx.font = `bold ${Math.round(W * 0.06)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillText(String(Math.max(1, Math.ceil(-g.time))), W / 2, py + H * 0.035); }
  if (g.state === 'play' && g.bannerT > 0) drawStartBanner(clamp(g.bannerT, 0, 1));
  if (g.state === 'play' && g.starTip > 0) { const ty = H * 0.47; ctx.globalAlpha = clamp(g.starTip, 0, 1); ctx.fillStyle = 'rgba(30,36,60,0.88)'; ctx.fillRect(W * 0.06, ty - H * 0.03, W * 0.76, H * 0.065);
    ctx.textAlign = 'left'; ctx.font = `${Math.round(W * 0.031)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#fff'; ctx.fillText('An enemy hero was killed, your team gains a', W * 0.09, ty - H * 0.002);
    ctx.fillStyle = '#ffc94a'; ctx.fillText('star advantage', W * 0.09, ty + H * 0.024); const w1 = ctx.measureText('star advantage ').width; ctx.fillStyle = '#fff'; ctx.fillText('that makes you stronger!', W * 0.09 + w1, ty + H * 0.024); ctx.textAlign = 'center'; ctx.globalAlpha = 1; }
  if (g.state === 'play' && g.tips && g.toastT > 0 && g.level > 1) { const ty = H * 0.62; ctx.globalAlpha = clamp(g.toastT, 0, 1); ctx.fillStyle = 'rgba(30,36,60,0.85)'; ctx.fillRect(W * 0.08, ty - H * 0.03, W * 0.7, H * 0.06);
    ctx.textAlign = 'left'; ctx.font = `bold ${Math.round(W * 0.034)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#ffc94a'; ctx.fillText('💡 Power up!', W * 0.11, ty - H * 0.005); ctx.fillStyle = '#fff'; ctx.font = `${Math.round(W * 0.032)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillText('Every hero just got more powerful!', W * 0.11, ty + H * 0.02); ctx.textAlign = 'center'; ctx.globalAlpha = 1; }
  if (!p.alive && g.state === 'play') { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, W, H); big(Math.ceil(p.respawnT), H * 0.42); small('Respawning…', H * 0.47); }
  if (g.state === 'over' && g.overT > OVER_BANNER) { const win = g.winner === PLAYER_TEAM; ctx.globalAlpha = clamp((g.overT - OVER_BANNER) / 0.35, 0, 1); drawOverBanner(win);
    const top = heroes().filter(h => h.team === g.winner).sort((a, b) => (b.kills * 2 - b.deaths) - (a.kills * 2 - a.deaths))[0];
    if (top && g.overT > OVER_BANNER + 0.5) { small('• TOP HERO •', H * 0.33); const s = W * 0.4; if (top.icon.complete && top.icon.naturalWidth) ctx.drawImage(top.icon, W / 2 - s / 2, H * 0.36, s, s);
      small(top.name + '  ' + top.kills + ' / ' + top.deaths, H * 0.36 + s + H * 0.04); ctx.fillStyle = '#ffc94a'; ctx.font = `bold ${Math.round(W * 0.06)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillText('MVP', W / 2, H * 0.36 + s + H * 0.09); }
    small(g.overT > OVER_TAP ? 'Tap to continue' : '', H * 0.86); ctx.globalAlpha = 1; }
}
function diamond(x, y, r, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill(); }
// match start: navy panel with a light rim and diamonds at the sides, like the original
function drawStartBanner(alpha) { const cy = H * 0.27, pw = W * 0.86, ph = H * 0.1, x0 = (W - pw) / 2, y0 = cy - ph / 2;
  ctx.save(); ctx.globalAlpha = alpha; const fade = (c, a) => { const gr = ctx.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, `rgba(${c},0)`); gr.addColorStop(0.2, `rgba(${c},${a})`); gr.addColorStop(0.8, `rgba(${c},${a})`); gr.addColorStop(1, `rgba(${c},0)`); return gr; };
  ctx.fillStyle = fade('16,24,66', 0.92); ctx.fillRect(0, y0, W, ph); // edges fade out to the sides as in the original
  const lw = Math.max(1.5, W * 0.004); ctx.fillStyle = fade('120,150,230', 0.6); ctx.fillRect(0, y0 + W * 0.008, W, lw); ctx.fillRect(0, y0 + ph - W * 0.008 - lw, W, lw);
  diamond(x0 + W * 0.05, cy, W * 0.016, '#fff'); diamond(x0 + pw - W * 0.05, cy, W * 0.016, '#fff');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; const f = `${Math.round(W * 0.07)}px ${HUD_FONT}`;
  hudText('DESTROY THE', W / 2, cy - ph * 0.22, f); ctx.font = f; const a = 'ENEMY', b = ' TOWER!', wa = ctx.measureText(a).width, wb = ctx.measureText(b).width;
  ctx.textAlign = 'left'; hudText(a, W / 2 - (wa + wb) / 2, cy + ph * 0.24, f, '#ff3b4e'); hudText(b, W / 2 - (wa + wb) / 2 + wa, cy + ph * 0.24, f);
  ctx.textAlign = 'center'; ctx.restore(); }
// faint laurel wreath with a sword through it, drawn behind the result text
function drawWreathEmblem(cx, cy, R, col) { ctx.save(); ctx.fillStyle = col; ctx.strokeStyle = col;
  for (const side of [-1, 1]) for (let i = 0; i < 9; i++) { const t = 0.55 + i * 0.27, x = cx + side * Math.sin(t) * R, y = cy + Math.cos(t) * R * 0.95;
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(-Math.sin(t), side * Math.cos(t)) + Math.PI / 2 + side * 0.35); ctx.beginPath(); ctx.ellipse(0, 0, R * 0.07, R * 0.17, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
  ctx.lineWidth = R * 0.05; ctx.beginPath(); ctx.arc(cx, cy, R * 0.95, Math.PI * 0.18, Math.PI * 0.82); ctx.stroke();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.12); const bw = R * 0.09;
  ctx.beginPath(); ctx.moveTo(0, -R * 1.25); ctx.lineTo(bw, -R * 1.05); ctx.lineTo(bw, R * 0.55); ctx.lineTo(-bw, R * 0.55); ctx.lineTo(-bw, -R * 1.05); ctx.closePath(); ctx.fill();
  ctx.fillRect(-R * 0.36, R * 0.55, R * 0.72, R * 0.09); ctx.fillRect(-bw * 0.7, R * 0.64, bw * 1.4, R * 0.36); ctx.beginPath(); ctx.arc(0, R * 1.07, bw * 1.1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.restore(); }
// end of match: navy (or red) screen, emblem, a slanted band with a huge outlined word, and the title in the middle
function drawOverBanner(win) { const word = win ? 'VICTORY' : 'DEFEAT', cy = H * 0.22;
  const pal = win ? { bg: '#1a2358', em: 'rgba(60,78,150,0.55)', band: 'rgba(38,70,170,0.55)', out: 'rgba(120,165,255,0.5)' } : { bg: '#3a1424', em: 'rgba(130,52,72,0.5)', band: 'rgba(150,36,60,0.5)', out: 'rgba(255,130,150,0.45)' };
  ctx.save(); ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
  drawWreathEmblem(W / 2, cy - H * 0.01, W * 0.27, pal.em);
  ctx.save(); ctx.translate(W / 2, cy); ctx.rotate(-0.16); ctx.fillStyle = pal.band; ctx.fillRect(-W, -H * 0.045, W * 2, H * 0.09);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `${Math.round(W * 0.26)}px ${HUD_FONT}`; ctx.lineWidth = Math.max(2, W * 0.005); ctx.strokeStyle = pal.out; ctx.strokeText(word, 0, 0); ctx.restore();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; const f = `${Math.round(W * 0.115)}px ${HUD_FONT}`; ctx.font = f; const hw = ctx.measureText(word).width / 2;
  ctx.lineWidth = W * 0.012; ctx.strokeStyle = 'rgba(8,12,40,0.6)'; ctx.strokeText(word, W / 2, cy); hudText(word, W / 2, cy, f);
  diamond(W / 2 - hw - W * 0.06, cy, W * 0.018, '#fff'); diamond(W / 2 + hw + W * 0.06, cy, W * 0.018, '#fff');
  ctx.textBaseline = 'alphabetic'; ctx.restore(); }
function wrapLines(t, maxW, font) { if (font) ctx.font = font; const out = []; let line = '';
  for (const w of t.split(' ')) { const tr = line ? line + ' ' + w : w; if (ctx.measureText(tr).width > maxW && line) { out.push(line); line = w; } else line = tr; }
  if (line) out.push(line); return out; }
function wrapText(t, x, y, maxW, lh) {
  const words = t.split(' '); let line = '';
  for (const w of words) { const tr = line ? line + ' ' + w : w; if (ctx.measureText(tr).width > maxW && line) { ctx.fillText(line, x, y); y += lh; line = w; } else line = tr; }
  if (line) ctx.fillText(line, x, y);
}
// passive item in its top-left slot: icon on its rarity base, a sweep while it recharges and a flash when it procs
function drawPassive(it, q) {
  const v = ID[it.key], cd = itemCd(it.key), now = game.time;
  if (cd && it.cd > (it.lastCd || 0) + 0.01) it.procT = now; it.lastCd = it.cd; // cooldown just restarted: the passive fired
  ctx.globalAlpha = cd && it.cd > 0 ? 0.45 : 1; // recharging: the whole slot goes see-through
  ctx.fillStyle = rarityFill(v.Rarity, q.y - q.r, q.y + q.r); ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 7); ctx.fill();
  const ic = itemIcon(it.key); if (imgOk(ic)) drawFit(ic, q.x, q.y - q.r * 0.05, q.r * 1.45);
  ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(10,16,48,0.8)'; ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 7); ctx.stroke();
  ctx.globalAlpha = 1;
  if (cd) {
    if (it.cd > 0) { ctx.font = `bold ${Math.round(q.r * 0.7)}px "Trebuchet MS", system-ui, sans-serif`; ctx.lineWidth = 3; ctx.strokeStyle = '#1a1f4a'; ctx.strokeText(Math.ceil(it.cd), q.x, q.y); ctx.fillStyle = '#fff'; ctx.fillText(Math.ceil(it.cd), q.x, q.y); } }
  if (it.procT !== undefined && now - it.procT < 0.5) { const f = (now - it.procT) / 0.5; ctx.strokeStyle = `rgba(255,230,140,${1 - f})`; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(q.x, q.y, q.r * (1 + f * 0.6), 0, 7); ctx.stroke(); }
  if (it.key === 'StackingDamageOnKill' && it.stacks) { ctx.font = `bold ${Math.round(q.r * 0.5)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#ffc94a'; ctx.fillText(it.stacks, q.x + q.r * 0.8, q.y - q.r * 0.75); }
}
function drawItemHUD() {
  const g = game, p = g.player; if (!p || g.tut) return;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  passiveItems(p).forEach((it, i) => drawPassive(it, PASSIVE_SLOT(i)));
  activeItems(p).forEach((it, i) => { const q = ITEM_BTN(i), v = ID[it.key], active = !!v.HasUseEffect, usable = active && it.cd <= 0 && (p.alive || it.key === 'RessurectionPotion');
    if (active && it.cd > 0) { const k = 1 - it.cd / itemCd(it.key); // used: grey, a dark blue wedge sweeps round like a clock hand until it is ready
      ctx.fillStyle = '#6d7180'; ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 7); ctx.fill();
      ctx.fillStyle = '#1c2a6b'; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.arc(q.x, q.y, q.r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + Math.cos(-Math.PI / 2 + Math.PI * 2 * k) * q.r, q.y + Math.sin(-Math.PI / 2 + Math.PI * 2 * k) * q.r); ctx.stroke(); }
    else { ctx.fillStyle = rarityFill(v.Rarity, q.y - q.r, q.y + q.r); ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 7); ctx.fill(); }
    ctx.globalAlpha = active && !usable && !(it.cd > 0) ? 0.45 : 1; // e.g. dead: dimmed
    const ic = itemIcon(it.key); if (imgOk(ic)) drawFit(ic, q.x, q.y - q.r * 0.05, q.r * 1.45);
    ctx.globalAlpha = 1; ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(10,16,48,0.85)'; ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, 7); ctx.stroke();
    if (it.key === 'StackingDamageOnKill' && it.stacks) { ctx.font = `bold ${Math.round(q.r * 0.45)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = '#ffc94a'; ctx.fillText(it.stacks, q.x + q.r * 0.75, q.y - q.r * 0.7); }
  });
  const o = g.itemOffer;
  if (o && g.state === 'play') {
    const now = performance.now() / 1000; if (!o.shown) o.shown = now;
    const slide = i => { const k = clamp((now - o.shown - i * 0.08) / 0.3, 0, 1); return (1 - k) * (1 - k) * (1 - k) * W * 0.6; }; // rows ease in from the right edge, one after another
    // rows as in the original: compact navy pill, small round rarity disc inset on the left, rarity-tinted name and white text in the HUD font;
    // corner radius stays the same when a long text makes the row taller
    const h0 = H * 0.058, nf = Math.round(h0 * 0.25), df = Math.round(h0 * 0.215), lh = df * 1.15, pad = h0 * 0.15, m = h0 * 0.08, ir = h0 / 2 - m, x0 = W * 0.5, tx0 = m + ir * 2 + h0 * 0.18, tw = W - x0 - tx0 - W * 0.04;
    const nameF = `${nf}px ${HUD_FONT}`, descF = `${df}px ${HUD_FONT}`, desc = k => ITEM_INFO[k][2](ID[k]).replace(/\(cd /g, '(cd\u00a0'); // keep "(cd 100s)" on one line
    let y = H * 0.17; const rows = [];
    o.choices.forEach(k => { const n = wrapLines(desc(k), tw, descF).length, h = Math.max(h0, pad * 2 + nf * 1.1 + n * lh);
      rows.push({ x: x0, y, w: W - x0, h, n }); y += h + H * 0.01; });
    o.rows = rows; const tb0 = ctx.textBaseline;
    o.choices.forEach((k, i) => { const c = rows[i], v = ID[k], x = c.x + slide(i), ix = x + m + ir, iy = c.y + c.h / 2, rad = Math.min(c.h / 2, h0 * 0.5);
      ctx.fillStyle = 'rgba(14,26,58,0.94)'; ctx.beginPath(); ctx.roundRect(x, c.y, c.w + c.h, c.h, [rad, 0, 0, rad]); ctx.fill(); // runs off the right edge
      ctx.fillStyle = rarityFill(v.Rarity, iy - ir, iy + ir); ctx.beginPath(); ctx.arc(ix, iy, ir, 0, 7); ctx.fill(); // round rarity disc as in the original
      const ic = itemIcon(k); if (imgOk(ic)) drawFitTrim(ic, ix, iy, ir * 1.45);
      const tx = x + tx0, top = iy - (nf * 1.1 + c.n * lh) / 2; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const nm = itemName(k); let f = nameF; ctx.font = f; const nw = ctx.measureText(nm).width; if (nw > tw) { f = `${Math.floor(nf * tw / nw)}px ${HUD_FONT}`; }
      ctx.font = f; ctx.fillStyle = RARITY_COL[v.Rarity]; ctx.fillText(nm, tx, top); // plain fill: the drop shadow made small text look blurry
      ctx.font = descF; ctx.fillStyle = '#fff'; wrapLines(desc(k), tw, descF).forEach((ln, j) => ctx.fillText(ln, tx, top + nf * 1.1 + j * lh));
      ctx.textBaseline = tb0; });
    if (canReroll()) { const r = REROLL_BTN(), x = r.x + slide(3); // reroll: purple button with two circling arrows
      ctx.fillStyle = '#c04ff0'; ctx.beginPath(); ctx.arc(x, r.y, r.r, 0, 7); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#f6dcff'; ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = r.r * 0.16; const a = r.r * 0.45;
      for (const s0 of [0, Math.PI]) { ctx.beginPath(); ctx.arc(x, r.y, a, s0 + 0.35, s0 + 2.6); ctx.stroke();
        const e = s0 + 2.6, hx = x + Math.cos(e) * a, hy = r.y + Math.sin(e) * a, tx = -Math.sin(e), ty = Math.cos(e), h = r.r * 0.28;
        ctx.beginPath(); ctx.moveTo(hx + tx * h, hy + ty * h); ctx.lineTo(hx - ty * h * 0.75, hy + tx * h * 0.75); ctx.lineTo(hx + ty * h * 0.75, hy - tx * h * 0.75); ctx.closePath(); ctx.fill(); } }
    ctx.textAlign = 'center';
  }
  ctx.textBaseline = 'alphabetic';
}
function big(t, y) { ctx.font = `bold ${Math.round(W * 0.14)}px "Trebuchet MS", system-ui, sans-serif`; ctx.lineWidth = 6; ctx.strokeStyle = '#1a1f4a'; ctx.strokeText(t, W / 2, y); ctx.fillStyle = '#fff'; ctx.fillText(t, W / 2, y); }
function small(t, y) { ctx.font = `bold ${Math.round(W * 0.045)}px "Trebuchet MS", system-ui, sans-serif`; ctx.lineWidth = 4; ctx.strokeStyle = '#1a1f4a'; ctx.strokeText(t, W / 2, y); ctx.fillStyle = '#fff'; ctx.fillText(t, W / 2, y); }

// ---------- tutorial (TutorialBarbarianMatchMainScript on "Layout - Tutorial") ----------
// Steps follow TutorialSteps; |text| marks the highlighted words.
const TUT_STEPS = [
  { text: 'Use the joystick to move here!', target: [6.5, 9.5] },
  { text: 'This is your attack range!', time: 6 },
  { text: 'You attack automatically!', time: 6, spawn: [0] },
  { text: 'Take down this |Minion|!', kill: true, point: 'minion' },
  { text: 'Targets are chosen randomly!', time: 8, spawn: [1, 2, 3] },
  { text: 'Attack |specific enemies| by making them\nthe |only target| in your range', kill: true, point: 'leader', target: [4.5, 12.5] },
  { text: 'Fill up your |SPECIAL| meter\nby attacking enemies!', spawn: [8, 9, 10], fill: true },
  { text: 'Tap on the |SPECIAL| button\nto take down these minions!', kill: true, cast: true },
  { text: "The battle is calling, let's move!", target: [6.5, 19.5], last: true, pad: true },
];
const TUT_SPAWN_RULES = { 0: { inv: 6 }, 1: { inv: 8, killAllies: true }, 2: { inv: 8 }, 3: { inv: 8 }, 8: { weak: true }, 9: { weak: true }, 10: { weak: true } };

function startTutorial() {
  startMatch('Barbarian', 'Tutorial', true);
  const g = game, T = GD.tutorial, p = g.player;
  g.state = 'play'; g.time = 0;
  g.tut = { step: 0, t: 0, pause: 0.6, minions: [], special: false, match: false };
  p.x = T.playerStart[0] + 0.5; p.y = T.playerStart[1] + 0.5; p.charge = 0;
  for (const j of g.map.jumpPads) g.map.tiles[j.y * g.map.w + j.x] = T_GROUND;
  towerOf(ENEMY_TEAM).maxHp = towerOf(ENEMY_TEAM).hp = T.enemyTowerHp;
  towerOf(PLAYER_TEAM).maxHp = towerOf(PLAYER_TEAM).hp = T.allyTowerHp;
  towerOf(PLAYER_TEAM).def = Object.assign({}, UNITS.Tower, { dmg: T.allyTowerDmg });
  p.onb = GD.onboarding.find(o => o.seq === 'FirstOnboardingMatch');
  g.cam.x = p.x; g.cam.y = p.y + 2;
}

function tutSpawn(id) {
  const s = GD.tutorial.spawners[id], r = TUT_SPAWN_RULES[id] || {};
  const m = new Minion('MeleeMinion', ENEMY_TEAM, s.x + 0.5, s.y + 0.5, { waypoints: [s.wp] });
  m.def = Object.assign({}, UNITS.MeleeMinion, { dmg: 0 }); // TutorialMinionAttackConfig: no damage
  m.tutStatic = true;
  m.maxHp = m.hp = GD.tutorial.minionHp * (r.weak ? 1 + GD.tutorial.weakHpMod : 1);
  if (r.inv) m.add('invulnerable', r.inv);
  if (r.killAllies) { m.tutKillAllies = true; game.tut.leader = m; }
  if (r.weak) m.tutUnkillable = true;
  game.units.push(m); game.tut.minions.push(m);
}

function updateTutorial(dt) {
  const g = game, tu = g.tut, p = g.player;
  if (tu.match) return;
  if (!tu.special) p.charge = 0;
  if (tu.pause > 0) { tu.pause -= dt; if (tu.pause <= 0) enterStep(); return; }
  const st = TUT_STEPS[tu.step]; tu.t += dt;
  if (st.cast && p.specialActive && !tu.castT) tu.castT = 0.5;
  if (tu.castT > 0) { tu.castT -= dt; if (tu.castT <= 0) tu.minions.forEach(m => { if (m.alive) { m.tutUnkillable = false; kill(m, p); } }); }
  let done = false;
  if (st.time) done = tu.t >= st.time;
  else if (st.fill) done = p.specialReady;
  else if (st.kill) done = tu.minions.every(m => !m.alive);
  else if (st.pad) done = p.y > 22 && !p.forced;
  else if (st.target) done = Math.hypot(p.x - st.target[0], p.y - st.target[1]) < 0.9;
  if (!done) return;
  if (st.last) { startTutorialBattle(); return; }
  tu.step++; tu.t = 0; tu.pause = 1; // TimeBetweenSteps
}
function enterStep() {
  const tu = game.tut, st = TUT_STEPS[tu.step];
  tu.t = 0; tu.castT = 0;
  if (st.spawn) { tu.minions = tu.minions.filter(m => m.alive); st.spawn.forEach(tutSpawn); }
  if (st.fill) { tu.special = true; game.player.charge = 0; }
  if (st.pad) { const j = game.map.jumpPads[0]; game.map.tiles[j.y * game.map.w + j.x] = T_JUMP; }
}
function startTutorialBattle() {
  const g = game, tu = g.tut, p = g.player, s = g.spawns[PLAYER_TEAM][0];
  tu.match = true; tu.minions.forEach(m => { m.alive = false; m.deadT = 0; });
  p.spawn = s;
  const es = g.spawns[ENEMY_TEAM][0], e = new Hero('Barbarian', ENEMY_TEAM, es.x, es.y, false, BOT_NAMES[0]); e.spawn = es; g.units.push(e);
  g.waveT = 2; g.bannerT = 2.5;
}

function drawTutWorld(ts, th) {
  const tu = game.tut; if (tu.match || tu.pause > 0) return;
  const st = TUT_STEPS[tu.step], bounce = Math.sin(performance.now() / 180) * 0.25;
  const chevron = (x, y) => { const sx = wx(x), sy = wy(y) - (1.1 + bounce) * th; ctx.fillStyle = '#e8ecff'; ctx.strokeStyle = '#2a3570'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx - ts * 0.35, sy - ts * 0.25); ctx.lineTo(sx, sy + ts * 0.12); ctx.lineTo(sx + ts * 0.35, sy - ts * 0.25); ctx.lineTo(sx, sy - ts * 0.05); ctx.closePath(); ctx.stroke(); ctx.fill(); };
  if (st.target) {
    const [x, y] = st.target, k = (performance.now() / 900) % 1;
    for (const f of [0, 0.5]) { const r = ((k + f) % 1) * 0.9 + 0.2; ctx.strokeStyle = `rgba(255,255,255,${0.9 - r * 0.8})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(wx(x), wy(y), r * ts, r * th, 0, 0, 7); ctx.stroke(); }
    if (st.point !== 'leader') chevron(x, y);
  }
  if (st.point === 'minion') { const m = tu.minions.find(m => m.alive); if (m) chevron(m.x, m.y); }
  if (st.point === 'leader' && tu.leader && tu.leader.alive) chevron(tu.leader.x, tu.leader.y);
}

function drawTutHUD() {
  const tu = game.tut; if (tu.match || tu.pause > 0) return;
  const st = TUT_STEPS[tu.step], lines = st.text.split('\n'), fs = Math.round(W * 0.045);
  ctx.font = `bold ${fs}px "Trebuchet MS", system-ui, sans-serif`; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeStyle = '#1a1f4a'; ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    const parts = line.split('|'), y = H * 0.3 + i * fs * 1.3;
    let x = W / 2 - parts.reduce((a, t) => a + ctx.measureText(t).width, 0) / 2;
    parts.forEach((t, j) => { ctx.fillStyle = j % 2 ? (t === 'SPECIAL' ? '#ffa12b' : '#ff3b4e') : '#fff'; ctx.strokeText(t, x, y); ctx.fillText(t, x, y); x += ctx.measureText(t).width; });
  });
  ctx.textAlign = 'center';
  if (st.fill || st.cast) { const b = SPECIAL_BTN(), k = Math.sin(performance.now() / 180) * b.r * 0.15, y = b.y - b.r * 1.45 + k;
    ctx.fillStyle = '#e8ecff'; ctx.strokeStyle = '#2a3570'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(b.x - b.r * 0.35, y - b.r * 0.3); ctx.lineTo(b.x, y + b.r * 0.15); ctx.lineTo(b.x + b.r * 0.35, y - b.r * 0.3); ctx.lineTo(b.x, y - b.r * 0.08); ctx.closePath(); ctx.stroke(); ctx.fill(); }
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const sdt = game && !game.net && effectsOn && juice.stopT > 0 ? dt * 0.1 : dt; juice.stopT = Math.max(0, juice.stopT - dt);
  if (game) { if (cv.width !== Math.round(cv.getBoundingClientRect().width * DPR)) resize(); if (game.net && game.net.guest) game.net.tick(dt); else { update(sdt); if (game && game.net) game.net.tick(dt); } if (game) updateJuice(dt); }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__arena = { get game() { return game; }, set game(g) { game = g; }, setTeams(p) { PLAYER_TEAM = p; ENEMY_TEAM = 3 - p; }, get selectedHero() { return selectedHero; }, get selectedMap() { return selectedMap; },
  Hero, Minion, Tower, GameMap, img, readMove, input, updateFx, updateCamera, endMatch, tryCastSpecial, backToMenu, menu, HEROES, UNITS, MATCH, heroName,
  FNS: { hookUpdate, arrowUpdate, laserUpdate, brambleUpdate }, HERO_ORDER, startMatch, startTutorial, update, moveUnit, speedOf, canAct, aiMinion, useItem, equipItem, pickOffered, dealDamage };
})();
