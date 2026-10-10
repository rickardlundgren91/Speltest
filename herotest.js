// Hero test arena (Rickard 2026-10-10): a match on Training Plateau with no waves, for trying out heroes and new changes in
// the game's own files. Opened with HERO TEST on the Training page (or #herotest in the URL); while it is on, the game opens
// straight into it, until Exit in its bar goes back to the menu. Around the middle: minions that stand still, minions that patrol, and Peter as a
// training dummy that stands still and hits back when you come in range. Every hero and minion that dies is back after 3 s.
// A small bar at the top left switches hero, level and resets the arena. Uses window.__arena only (plus g.fixedLevel and
// u.dummy, which game.js honours). Off, it only adds the HERO TEST button.
(() => {
  'use strict';
  const A = window.__arena; if (!A) return;
  const MAP = 'FTUE_Map_1', RESPAWN = 3, TEAM = 2, FOE = 1; // the player is team 2 (top), as in a bot match
  const PLAYER_AT = { x: 6.5, y: 11.5 }, PETER_AT = { x: 6.5, y: 15.5 };
  const MINIONS = [ // standing still: a; patrolling: back and forth between a and b
    { type: 'MeleeMinion', a: { x: 4, y: 15 } },
    { type: 'RangeMinion', a: { x: 9, y: 15 } },
    { type: 'SiegeMinion', a: { x: 6.5, y: 18 } },
    { type: 'MeleeMinion', a: { x: 3, y: 17 }, b: { x: 10, y: 17 } },
    { type: 'RangeMinion', a: { x: 10.5, y: 12.5 }, b: { x: 10.5, y: 19.5 } },
  ];
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
  const order = A.HERO_ORDER || Object.keys(A.HEROES);
  let hero = order.includes(store('abc2-herotest-hero')) ? store('abc2-herotest-hero') : 'Barbarian';
  let level = Math.max(1, Math.min(A.MATCH.leveling.MaxLevel, +store('abc2-herotest-level') || 1));
  let slots = [], lastT = 0;
  let on = store('abc2-herotest-on') === '1' || /herotest/.test(location.hash);

  const wp = p => ({ waypoints: [[p.x - 0.5, p.y - 0.5]] }); // tutStatic minions walk to waypoints[0] (+0.5) and hold there
  function spawnMinion(s) {
    const g = A.game, m = new A.Minion(s.type, FOE, s.a.x, s.a.y, wp(s.b || s.a));
    m.tutStatic = true; m.def = Object.assign({}, A.UNITS[s.type], { dmg: 0 }); // harmless, like the tutorial's dummies
    s.m = m; s.goB = !!s.b; s.deadT = 0; g.units.push(m);
  }

  function start() {
    on = true; store('abc2-herotest-on', '1');
    A.menu.style.display = 'none';
    A.setTeams(TEAM); A.startMatch(hero, MAP);
    const g = A.game; g.herotest = true; g.waveT = 1e9; g.noStars = true; g.tips = false; g.fixedLevel = level; g.bannerT = 0;
    g.units = g.units.filter(u => u.kind !== 'hero' || u === g.player);
    for (const u of g.units) if (u.kind === 'tower') u.add('invulnerable', 1e9); // the match never ends
    const p = g.player; p.x = PLAYER_AT.x; p.y = PLAYER_AT.y; p.spawn = { ...PLAYER_AT }; p.charge = p.def.maxSpecialCharges; p.stocks = p.def.maxSpecialStocks > 1 ? p.def.maxSpecialStocks : p.stocks;
    const peter = new A.Hero('Barbarian', FOE, PETER_AT.x, PETER_AT.y, false, 'Peter'); peter.spawn = { ...PETER_AT }; peter.dummy = true; g.units.push(peter);
    slots = MINIONS.map(s => ({ ...s })); slots.forEach(spawnMinion);
    g.cam.x = p.x; g.cam.y = p.y + 2; lastT = g.time;
    ui();
  }

  function tick() {
    requestAnimationFrame(tick);
    const g = A.game;
    if (bar) bar.hidden = !(g && g.herotest);
    if (!on) return;
    if (!g) { if (A.menu.style.display !== 'none') start(); return; } // leaving via the score tab: back into the arena
    if (!g.herotest) return;
    const dt = Math.max(0, g.time - lastT); lastT = g.time;
    for (const u of g.units) if (u.kind === 'hero') {
      if (!u.alive && !u.htDead) { u.htDead = true; u.respawnT = Math.min(u.respawnT, RESPAWN); }
      else if (u.alive && u.htDead) { u.htDead = false; u.statuses = u.statuses.filter(s => s.type !== 'invulnerable'); } // ready to test again at once
    }
    for (const s of slots) {
      if (!s.m.alive) { s.deadT += dt; if (s.deadT >= RESPAWN) spawnMinion(s); continue; }
      if (s.b) { const t = s.goB ? s.b : s.a; if (Math.hypot(t.x - s.m.x, t.y - s.m.y) < 0.2) { s.goB = !s.goB; s.m.lane = wp(s.goB ? s.b : s.a); } }
    }
  }

  // the bar: ‹ hero ›  Lv N  Reset  Exit, just under the tower bars and level badge (drawHUD: about 11.5 % of the height)
  let bar = null;
  function ui() {
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'htBar';
      bar.innerHTML = '<button data-k="prev">‹</button><button data-k="list" id="htName"></button><button data-k="next">›</button><button data-k="lvl" id="htLvl"></button><button data-k="reset">Reset</button><button data-k="exit">Exit</button>';
      const css = document.createElement('style');
      css.textContent = '#htBar{position:fixed;left:calc(8px + env(safe-area-inset-left));top:calc(12.5vh + 8px);z-index:50;display:flex;align-items:center;gap:4px;padding:4px;border-radius:12px;background:rgba(12,16,40,.72);color:#fff;font:bold 14px "Trebuchet MS",system-ui,sans-serif;user-select:none;-webkit-user-select:none}'
        + '#htBar button{font:inherit;color:#fff;background:rgba(255,255,255,.14);border:0;border-radius:8px;min-width:32px;height:32px;padding:0 8px;cursor:pointer}'
        + '#htBar button:active{background:rgba(255,255,255,.3)}#htName{min-width:7.5em;text-align:center;padding:0 6px}#htName::after{content:" ▾";opacity:.7}'
        + '#htList{position:absolute;left:0;top:44px;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:6px;border-radius:12px;background:rgba(12,16,40,.94);max-height:60vh;overflow-y:auto;min-width:16em}#htList[hidden]{display:none}#htList button.on{background:#3a5bd8}';
      document.head.appendChild(css); document.body.appendChild(bar);
      const list = document.createElement('div'); list.id = 'htList'; list.hidden = true; bar.appendChild(list); // tap the name: every hero in a list (Rickard 2026-10-10)
      order.forEach(h => { const b = document.createElement('button'); b.dataset.k = 'pick'; b.dataset.h = h; b.textContent = (A.heroName ? A.heroName(h) : h).split(' & ')[0]; list.appendChild(b); });
      bar.addEventListener('pointerdown', e => e.stopPropagation());
      bar.addEventListener('click', e => {
        const k = e.target.dataset && e.target.dataset.k; if (!k) return;
        if (k === 'list') { const l = bar.querySelector('#htList'); l.hidden = !l.hidden; l.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.h === hero)); return; }
        bar.querySelector('#htList').hidden = true;
        if (k === 'pick') { hero = e.target.dataset.h; store('abc2-herotest-hero', hero); start(); }
        else if (k === 'prev' || k === 'next') { const i = order.indexOf(hero); hero = order[(i + (k === 'next' ? 1 : order.length - 1)) % order.length]; store('abc2-herotest-hero', hero); start(); }
        else if (k === 'lvl') { level = level % A.MATCH.leveling.MaxLevel + 1; store('abc2-herotest-level', String(level)); if (A.game) A.game.fixedLevel = level; ui(); }
        else if (k === 'reset') start();
        else if (k === 'exit') { on = false; store('abc2-herotest-on', '0'); bar.hidden = true; A.backToMenu(); }
      });
    }
    bar.querySelector('#htName').textContent = (A.heroName ? A.heroName(hero) : hero).split(' & ')[0];
    bar.querySelector('#htLvl').textContent = 'Lv ' + level;
  }

  const btn = document.getElementById('herotest');
  if (btn) btn.onclick = () => start();
  if (on) start();
  requestAnimationFrame(tick);
})();
