// ABC2 music: Rickard's track ("langsamspelmusik", 2026-10-09), its repeating 9.6 s phrase cut to a seamless loop in
// music/menu.mp3. Plays while the start menu or the item list is open and the Sound setting is on, and quieter during a match
// (countdown and play) so the effects stay on top; it fades out on the result screen.
// Browsers only allow audio after the first tap or key press, so it starts then. Web Audio loops the buffer without the gap an
// <audio loop> leaves at the mp3 seam.
(() => {
  const LOOP = 9.6, VOL = 0.45, MATCH_VOL = 0.2;
  let ac = null, gain = null, src = null, buf = null, loading = false;
  const soundOn = () => { const s = window.__abc2Sound; if (s) return s.on; try { return localStorage.getItem('abc2-sound') !== 'off'; } catch (e) { return true; } };
  const inMenu = () => ['menu', 'itemsView'].some(id => { const el = document.getElementById(id); return el && !el.hidden && getComputedStyle(el).display !== 'none'; });
  function start() {
    if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; ac = new AC(); gain = ac.createGain(); gain.gain.value = 0; gain.connect(ac.destination); }
    if (ac.state === 'suspended') ac.resume();
    if (!buf && !loading) { loading = true; fetch('music/menu.mp3').then(r => r.arrayBuffer()).then(b => ac.decodeAudioData(b)).then(b => { buf = b; }).catch(() => {}); }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => addEventListener(ev, start, { capture: true, passive: true }));
  setInterval(() => {
    if (!ac || !buf) return;
    const A = window.__arena, g = A && A.game, match = !!g && (g.state === 'countdown' || g.state === 'play') && !inMenu();
    const want = soundOn() && (inMenu() || match) && document.visibilityState === 'visible';
    if (want && !src) { src = ac.createBufferSource(); src.buffer = buf; src.loop = true; src.loopStart = 0; src.loopEnd = Math.min(LOOP, buf.duration); src.connect(gain); src.start(); }
    if (want && ac.state === 'suspended') ac.resume();
    const t = ac.currentTime; gain.gain.cancelScheduledValues(t); gain.gain.setTargetAtTime(want ? (match ? MATCH_VOL : VOL) : 0, t, want ? 0.6 : 0.25);
    if (!want && src && gain.gain.value < 0.005) { try { src.stop(); } catch (e) {} src.disconnect(); src = null; } // restarts from the top next time the menu opens
  }, 200);
  window.__abc2Music = { get playing() { return !!src; }, get volume() { return gain ? gain.gain.value : 0; } };
})();
