// ABC2 sound: Web Audio manager + game-event hooks. Reads the game state each frame (window.__arena.game) and plays a sound for
// what changed: shots, hits, heals, explosions, specials, deaths, level ups, countdown, victory/defeat, emotes, kill streaks, menu clicks.
// Driving it from state (not from calls inside game.js) means a multiplayer guest hears the same as the host: effects, projectiles,
// specials and the feed all reach the guest through net.js.
// Until they are converted, every sound is synthesized here. To use a real file: put it in sfx/ and add it to SAMPLES (name -> path);
// a loaded sample replaces the synth sound of the same name.
(() => {
  const SAMPLES = {}; // e.g. hit: 'sfx/hit.mp3'
  let on = true; try { on = localStorage.getItem('abc2-sound') !== 'off'; } catch (e) {}
  let ac = null, master = null, noise = null; const buf = {};
  function ctx() {
    if (ac) return ac;
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return null;
    ac = new C(); master = ac.createGain(); master.gain.value = 0.45;
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6; master.connect(comp); comp.connect(ac.destination);
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    for (const [n, url] of Object.entries(SAMPLES)) fetch(url).then(r => r.arrayBuffer()).then(b => ac.decodeAudioData(b)).then(b => buf[n] = b).catch(() => {});
    return ac;
  }
  const unlock = () => { if (!on) return; const a = ctx(); if (a && a.state === 'suspended') a.resume(); };
  addEventListener('pointerdown', unlock, true); addEventListener('keydown', unlock, true); addEventListener('touchend', unlock, true);

  // ---------- synth building blocks ----------
  function env(g, t, a, peak, dur) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); }
  function tone(f0, f1, dur, type, vol, delay = 0, a = 0.005) {
    const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, a, vol, dur); o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.02);
  }
  function hiss(dur, ftype, f0, f1, q, vol, delay = 0, a = 0.003) {
    const t = ac.currentTime + delay, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noise; s.loop = true; f.type = ftype; f.Q.value = q; f.frequency.setValueAtTime(f0, t); if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, a, vol, dur); s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }
  // wet sounds: a bubble pop is a short sine whose pitch jumps up; a squish is filtered noise wobbling fast in volume and tone
  function bubbles(n, span, f0, f1, vol, delay = 0) {
    for (let i = 0; i < n; i++) { const t = ac.currentTime + delay + Math.random() * span, f = f0 + Math.random() * (f1 - f0), d = 0.018 + Math.random() * 0.025;
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 2.6, t + d);
      env(g, t, 0.003, vol * (0.5 + Math.random() * 0.5), d); o.connect(g); g.connect(out); o.start(t); o.stop(t + d + 0.02); }
  }
  function squish(dur, f0, f1, vol, delay = 0, wob = 22) {
    const t = ac.currentTime + delay, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), am = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain(), fm = ac.createGain();
    s.buffer = noise; s.loop = true; f.type = 'lowpass'; f.Q.value = 7; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    lfo.type = 'sine'; lfo.frequency.setValueAtTime(wob, t); lfo.frequency.linearRampToValueAtTime(wob * 0.6, t + dur);
    am.gain.value = 0.5; lg.gain.value = 0.5; lfo.connect(lg); lg.connect(am.gain); fm.gain.value = Math.min(f0, f1) * 0.5; lfo.connect(fm); fm.connect(f.frequency);
    env(g, t, 0.03, vol, dur); s.connect(f); f.connect(am); am.connect(g); g.connect(out); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02); lfo.start(t); lfo.stop(t + dur + 0.02);
  }
  const notes = (fs, step, dur, type, vol, delay = 0) => fs.forEach((f, i) => tone(f, f, dur, type, vol, delay + i * step, 0.01));
  let out = null; // the gain node of the sound being built (volume = distance falloff)

  const SYNTH = {
    swing: v => { hiss(0.13, 'bandpass', 500, 2400, 1.2, 0.6 * v); tone(160, 90, 0.07, 'sine', 0.25 * v); },
    bow: v => { tone(330, 160, 0.09, 'triangle', 0.35 * v); hiss(0.12, 'bandpass', 3200, 1500, 2, 0.25 * v, 0.01); },
    gun: v => { hiss(0.09, 'lowpass', 3500, 400, 0.7, 0.8 * v); tone(170, 60, 0.08, 'square', 0.18 * v); },
    magic: v => { tone(1100, 380, 0.16, 'sine', 0.3 * v); tone(1650, 570, 0.12, 'triangle', 0.1 * v, 0.01); },
    tower: v => { tone(140, 55, 0.22, 'sawtooth', 0.22 * v); hiss(0.18, 'lowpass', 1600, 200, 0.7, 0.5 * v); },
    minionShot: v => { tone(700, 420, 0.04, 'square', 0.06 * v); },
    // Bufo's Gooey Grab (Rickard: a wet licking tongue): a slimy, wobbling slurp full of little bubble pops out, a soft wet smack, a squishy slurp back
    tongue: v => { squish(0.28, 500, 1600, 0.75 * v, 0, 24); bubbles(9, 0.28, 500, 1300, 0.22 * v, 0);
      bubbles(3, 0.05, 250, 450, 0.45 * v, 0.27); hiss(0.07, 'lowpass', 900, 250, 2, 0.5 * v, 0.27);
      squish(0.35, 1400, 380, 0.7 * v, 0.33, 19); bubbles(10, 0.35, 400, 1100, 0.2 * v, 0.33); },
    hit: v => { hiss(0.07, 'lowpass', 2400, 300, 0.8, 0.55 * v); tone(190, 80, 0.07, 'sine', 0.4 * v); },
    hitBig: v => { hiss(0.14, 'lowpass', 3000, 200, 0.8, 0.85 * v); tone(140, 45, 0.16, 'sine', 0.6 * v); },
    hitMinor: v => { hiss(0.04, 'lowpass', 1800, 400, 0.8, 0.18 * v); },
    heal: v => { notes([660, 880, 1320], 0.06, 0.18, 'sine', 0.12 * v); },
    boom: v => { hiss(0.55, 'lowpass', 2200, 90, 0.7, 0.9 * v, 0, 0.005); tone(110, 35, 0.5, 'sine', 0.7 * v); },
    ring: v => { tone(1400, 2100, 0.25, 'sine', 0.1 * v, 0, 0.02); },
    special: (v, p = 1) => { hiss(0.35, 'bandpass', 300 * p, 3000 * p, 1.5, 0.45 * v, 0, 0.06); tone(220 * p, 660 * p, 0.3, 'sawtooth', 0.12 * v, 0, 0.04); tone(330 * p, 990 * p, 0.3, 'triangle', 0.12 * v, 0.03, 0.04); },
    heroDeath: v => { tone(520, 130, 0.5, 'triangle', 0.3 * v); tone(390, 98, 0.5, 'sine', 0.2 * v, 0.05); },
    minionDeath: v => { tone(500, 160, 0.09, 'square', 0.08 * v); },
    towerDown: v => { hiss(1.2, 'lowpass', 1800, 60, 0.7, 1 * v, 0, 0.01); tone(80, 30, 1.0, 'sine', 0.8 * v); },
    levelUp: v => { notes([523, 659, 784, 1047], 0.08, 0.25, 'triangle', 0.2 * v); },
    tick: v => { tone(880, 880, 0.08, 'sine', 0.2 * v); },
    go: v => { notes([523, 784], 0, 0.6, 'sawtooth', 0.09 * v); notes([1047], 0, 0.6, 'triangle', 0.15 * v); },
    victory: v => { notes([523, 659, 784], 0.13, 0.3, 'triangle', 0.22 * v); notes([1047, 1047], 0, 0.9, 'triangle', 0.18 * v, 0.42); notes([659, 784], 0, 0.9, 'sine', 0.12 * v, 0.42); },
    defeat: v => { notes([392, 370, 349], 0.22, 0.35, 'triangle', 0.2 * v); tone(262, 196, 1.0, 'sine', 0.2 * v, 0.66); },
    emote: v => { tone(900, 1300, 0.07, 'sine', 0.25 * v); tone(1100, 1600, 0.08, 'sine', 0.25 * v, 0.1); },
    kill: v => { notes([988, 1319], 0.07, 0.18, 'square', 0.07 * v); },
    streak: v => { notes([784, 988, 1175, 1568], 0.07, 0.22, 'sawtooth', 0.08 * v); },
    click: v => { tone(1250, 1250, 0.035, 'sine', 0.12 * v); },
  };
  // shortest gap between two plays of the same sound (s): a fight should not be a wall of noise (Rickard: "man hör varenda slag")
  const GAP = { swing: 0.3, bow: 0.3, gun: 0.3, magic: 0.3, hit: 0.3, hitBig: 0.25, heal: 3, special: 0.4, heroDeath: 0.3, tower: 0.6, emote: 0.5 };
  const last = {}, stats = {}; let burst = 0, burstT = 0;
  function play(name, vol = 1, arg) {
    if (!on || vol <= 0.02 || !ctx() || ac.state !== 'running') return;
    const now = ac.currentTime; if (now - (last[name] || 0) < (GAP[name] || 0.05)) return; last[name] = now; // the same sound twice in one frame adds nothing
    if (now - burstT > 0.1) { burstT = now; burst = 0; } if (++burst > 4) return; // a big team fight stays readable
    stats[name] = (stats[name] || 0) + 1; out = ac.createGain(); out.connect(master);
    if (buf[name]) { const s = ac.createBufferSource(); s.buffer = buf[name]; out.gain.value = vol; s.connect(out); s.start(); return; }
    SYNTH[name] && SYNTH[name](vol, arg);
  }

  // ---------- game events ----------
  const SHOT = { Archer: 'bow', Marksman: 'gun', Sorcerer: 'magic', Witch: 'magic', Automaton: 'magic', Joker: 'magic', Frog: 'magic' };
  const PITCH = { Barbarian: 0.7, Archer: 1.2, Angler: 0.8, Automaton: 1.0, Banshee: 1.3, Brawler: 0.75, Frog: 1.1, Joker: 1.15, Marksman: 1.05, Paladin: 0.85, Sorcerer: 0.95, Thief: 1.25, Witch: 1.1, Kunoichi: 1.35 };
  let cur = null, seen = new WeakSet(), st = new WeakMap(), lastState = '', lastLevel = 1, lastCount = 0;
  function vol(x, y) { // louder near you, silent far away
    const g = cur, me = g.player && g.player.alive ? g.player : g.cam; if (!me || x === undefined) return 1;
    return Math.max(0, Math.min(1, 1 - (Math.hypot(x - me.x, y - me.y) - 5) / 9));
  }
  function mine(u) { return u && (u.isPlayer || (u.owner && u.owner.isPlayer) || (cur.player && u === cur.player)); }
  function track(g) {
    if (g !== cur) { cur = g; seen = new WeakSet(); st = new WeakMap(); lastState = g ? g.state : ''; lastLevel = g ? g.level : 1; lastCount = 0;
      if (g) [g.effects, g.projectiles, g.feed].forEach(l => l.forEach(o => seen.add(o))); }
    if (!g) return;
    const PT = typeof PLAYER_TEAM !== 'undefined' ? PLAYER_TEAM : 2;
    if (g.state === 'countdown' && g.time < 0) { const n = Math.ceil(-g.time); if (n !== lastCount && n <= 3) play('tick'); lastCount = n; }
    if (g.state !== lastState) { if (g.state === 'play' && lastState === 'countdown') play('go'); if (g.state === 'over') play(g.winner === PT ? 'victory' : 'defeat'); lastState = g.state; }
    // shots: only your own auto attacks (quiet), and a tower shooting at you; everyone else's attacks are silent
    for (const p of g.projectiles) if (!seen.has(p)) { seen.add(p); const s = p.src; if (!s || p.custom || p.warn || p.petal) continue;
      if (s.kind === 'tower') { if (p.tgt && mine(p.tgt)) play('tower', 0.6); }
      else if (s.kind === 'hero' && mine(s)) play(SHOT[s.code] || ((s.range || (s.def && s.def.range) || 0) < 2.6 ? 'swing' : 'magic'), 0.9); }
    // hits: only hero hits on you, heavy ones sound like any other hit; explosions. Heals and level ups are silent (Rickard 2026-10-09)
    for (const e of g.effects) if (!seen.has(e)) { seen.add(e); const v = vol(e.x, e.y);
      if (e.type === 'hit') { if (!e.minor && cur.player && cur.player.alive && Math.hypot(e.x - cur.player.x, e.y - cur.player.y) < 0.3) play('hit', 0.4); }
      else if (e.type === 'boom') play('boom', v * 0.8); }
    for (const f of g.feed) if (!seen.has(f)) { seen.add(f);
      if (f.tag && f.kt === PT) play('streak'); else if (f.kt === PT && f.v) play('kill', 0.8); }
    for (const u of g.units) {
      let s = st.get(u); if (!s) { st.set(u, s = { alive: u.alive, sp: u.specialActive, ch: u.charge || 0, sk: u.stocks || 0, em: u.emote && u.emote.at, cast: -9 }); continue; }
      if (s.alive && !u.alive && (u.kind === 'tower' || (u.kind === 'hero' && !u.isIllusion))) play(u.kind === 'tower' ? 'towerDown' : 'heroDeath', u.kind === 'tower' ? 1.2 : vol(u.x, u.y) * 0.8);
      if (u.kind === 'hero' && !u.isIllusion && u.alive) {
        const cast = (u.specialActive && u.specialActive !== s.sp && !s.sp) || (u.charge || 0) < s.ch - 1 || (u.stocks || 0) < s.sk;
        if (cast && g.time - s.cast > 0.3) { s.cast = g.time; play(u.code === 'Angler' ? 'tongue' : 'special', mine(u) ? 0.8 : vol(u.x, u.y) * 0.5, PITCH[u.code] || 1); }
        const em = u.emote && u.emote.at; if (em !== undefined && em !== s.em && em <= g.time + 0.05) { s.em = em; play('emote', vol(u.x, u.y)); }
      }
      s.alive = u.alive; s.sp = u.specialActive; s.ch = u.charge || 0; s.sk = u.stocks || 0;
    }
  }
  (function loop() { try { const A = window.__arena; track(A ? A.game : null); } catch (e) {} requestAnimationFrame(loop); })();

  // menu clicks and the Sound setting (menu row "Sound", saved as abc2-sound)
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('button, .hero')) play('click'); }, true);
  const sel = document.getElementById('sound');
  if (sel) { [['on', 'On'], ['off', 'Off']].forEach(([v, n]) => { const o = document.createElement('option'); o.value = v; o.textContent = n; sel.appendChild(o); });
    sel.value = on ? 'on' : 'off';
    sel.onchange = () => { on = sel.value === 'on'; try { localStorage.setItem('abc2-sound', sel.value); } catch (e) {} if (on) { unlock(); play('click'); } else if (ac) ac.suspend(); }; }
  window.__abc2Sound = { play, stats, get on() { return on; } };
})();
