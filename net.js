// ABC2 multiplayer, phase 1: P2P 1v1. The host runs the match (game.js update) and sends its state
// ~30 times a second (changes on a reliable channel, positions on a lossy fast one); the guest sends the
// movement steps it simulated, draws others slightly in the past, and predicts its own hero.
// Signaling: both pages meet in the artifact's live room under a match code (claude.use('room')),
// trade a WebRTC offer/answer there, then talk over a DataChannel. If WebRTC cannot connect,
// the same messages go through the room instead (slower, chunked to its 4 KB limit).
(() => {
'use strict';
const A = window.__arena;
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const SNAP_DT = 1 / 30, SNAP_DT_RELAY = 1 / 8, POS_DT_RELAY = 1 / 20, KEYFRAME_EVERY = 8, INPUT_DT = 1 / 30, INPUT_DT_RELAY = 1 / 15;
// the room (used when WebRTC is unavailable, as inside claude.ai) shares ~40 messages/s per page between emits and presence:
// positions go as presence (latest wins, ~20/s), changes as emits (~8/s), plus a full state every second in case one was lost
const CHUNK = 3500;
const RECONNECT_S = 20; // a dropped player has this long to come back before the match is given up

// ---------- room access (artifact capability; tests can inject window.__roomMock) ----------
let roomP = null;
function getRoom() {
  if (!roomP) roomP = window.__roomMock ? Promise.resolve(window.__roomMock)
    : (window.claude && window.claude.use ? window.claude.use('room').catch(() => null) : Promise.resolve(null));
  return roomP;
}
async function joinRoom(code) {
  const room = await getRoom(); if (!room) return null;
  try { return await room.join('abc2-mp-' + code.toLowerCase()); } catch (e) { return room; } // named rooms refused: share the lobby, messages carry the code
}

// ---------- link: signaling + transport ----------
class Link {
  constructor(role, code) {
    this.role = role; this.code = code; this.guest = role === 'guest'; this.handlers = []; this.open = false; this.mode = '';
    this.rtt = 0; this.lastRecv = performance.now(); this.parts = new Map(); this.unsubs = []; this.closed = false; this.status = 'Connecting…';
    this.tok = Math.random().toString(36).slice(2, 10); // identifies the guest when it reconnects
  }
  async start() {
    this.room = await joinRoom(this.code);
    if (!this.room) { if (await loadPeerJS()) return this.startPeerJS(); this.fail('Multiplayer needs the claude.ai live room or PeerJS (peerjs.min.js) next to the game.'); return; }
    this.unsubs.push(this.room.on('sig', m => { if (!m.sameTab && m.data && m.data.code === this.code) this.onSigPart(m.data, m); }));
    this.unsubs.push(this.room.on('relay', m => { if (!m.sameTab && m.data && m.data.code === this.code && this.mode === 'relay') this.onRelay(m.data); }));
    if (this.room.onPeers) this.unsubs.push(this.room.onPeers(ch => { if (this.mode !== 'relay') return;
      for (const p of ch.updated.concat(ch.joined)) if (!p.isMe && p.peer === this.peer && p.presence && p.presence.mp && p.presence.mp.code === this.code) { this.lastRecv = performance.now(); this.dispatch(p.presence.mp); } }));
    if (this.guest) { this.hello(); this.helloT = setInterval(() => { if (!this.open) this.hello(); }, 2500); }
    this.status = this.guest ? 'Looking for host…' : 'Waiting for enemy…';
  }
  // outside claude.ai (e.g. GitHub Pages) WebRTC works: PeerJS's free broker finds the host by its code, then the match is P2P
  startPeerJS() {
    const id = this.pjId = 'abc2mp-' + this.code.toLowerCase(), opts = window.__peerOpts || {};
    const err = e => { if (this.down || this.closed || this.gone) return; const t = e && e.type;
      this.fail(t === 'unavailable-id' ? 'Code already in use, create a new match.' : t === 'peer-unavailable' ? 'No match with that code. Has the host created it?' : 'Connection failed (' + (t || 'unknown error') + ').'); };
    // the first main connection opens the link; a later one with the same guest token resumes it after a drop
    const main = this.pjMain = c => c.on('open', () => { if (this.closed || this.gone) return;
      const was = this.open; this.attach(pjChan(c)); this.mode = 'webrtc'; if (was) { if (this.onReconnect) this.onReconnect(); } else this.ready(); });
    const fast = this.pjFast = c => c.on('open', () => { if (!this.closed) this.attachFast(pjChan(c)); });
    if (this.role === 'host') {
      const peer = this.pj = new Peer(id, opts); peer.on('error', err);
      peer.on('open', () => { if (!this.open && !this.down) this.emitState('Waiting for enemy…'); });
      peer.on('disconnected', () => setTimeout(() => { try { if (!this.closed && !peer.destroyed) peer.reconnect(); } catch (e) {} }, 1000)); // off the broker, a returning guest could not find us
      peer.on('connection', c => {
        const tok = c.metadata && c.metadata.tok;
        if (this.gone || (this.guestTok && tok !== this.guestTok)) { c.on('open', () => c.close()); return; } // one opponent per match
        if (c.label === 'fast') { const old = this.fastConn; this.fastConn = c; fast(c); if (old && old !== c) setTimeout(() => { try { old.close(); } catch (e) {} }, 500); return; }
        const old = this.mainConn; this.mainConn = c;
        if (!this.guestTok) { this.guestTok = tok || 'x'; this.guestHero = c.metadata && c.metadata.hero; this.emitState('Enemy found, connecting…'); }
        main(c); if (old) setTimeout(() => { try { old.close(); } catch (e) {} }, 500);
      });
    } else {
      const peer = this.pj = new Peer(opts); peer.on('error', err);
      peer.on('open', () => { if (!this.down) this.emitState('Looking for host…'); if (!this.open) this.connectPJ(); });
    }
  }
  connectPJ() {
    const md = { hero: A.selectedHero, tok: this.tok };
    for (const c of [this.mainConn, this.fastConn]) if (c) try { c.close(); } catch (e) {}
    this.mainConn = this.pj.connect(this.pjId, { label: 'main', reliable: true, serialization: 'raw', metadata: md }); this.pjMain(this.mainConn);
    this.fastConn = this.pj.connect(this.pjId, { label: 'fast', reliable: false, serialization: 'raw', metadata: md }); this.pjFast(this.fastConn);
  }
  rejoin() { // guest, while down: find the host again through the broker
    if (!this.down || this.closed) return; const p = this.pj; if (!p || p.destroyed) return;
    if (p.disconnected) { try { p.reconnect(); } catch (e) {} } else this.connectPJ();
  }
  hello() { this.sig({ k: 'hello', hero: A.selectedHero }); }
  sig(d) { // offers and answers can pass the room's 4 KB limit: send them in parts
    const txt = JSON.stringify(d), id = Math.random().toString(36).slice(2, 8), n = Math.ceil(txt.length / 2500);
    for (let i = 0; i < n; i++) this.room.emit('sig', { code: this.code, k: 'part', id, i, n, s: txt.slice(i * 2500, (i + 1) * 2500) }).catch(e => {
      if (e && e.code === 'not_permitted') this.fail('No permission to use the game\'s live room (ask the owner for at least Contributor access).');
      else this.note('signal ' + d.k + ': ' + (e && e.code || 'error')); });
  }
  onSigPart(d, m) {
    if (d.k !== 'part') return;
    const key = m.peer + d.id; let p = this.parts.get(key); if (!p) { p = []; this.parts.set(key, p); }
    p[d.i] = d.s; if (p.filter(x => x !== undefined).length < d.n) return; this.parts.delete(key);
    let o; try { o = JSON.parse(p.join('')); } catch (e) { return; } this.onSig(o, m);
  }
  note(s) { this.why = s; } // why P2P did not come up, shown next to "Rum"
  async onSig(d, m) {
    if (this.role === 'host') {
      if (d.k === 'hello' && !this.peer) { this.peer = m.peer; this.guestHero = d.hero; this.emitState('Enemy found, connecting…'); this.startRTC(); }
      else if (d.k === 'answer' && m.peer === this.peer && this.pc) { this.gotAnswer = true; try { await this.pc.setRemoteDescription(d.sdp); } catch (e) { this.note('could not read answer'); this.goRelay(); } }
      else if (d.k === 'relay-ok' && m.peer === this.peer) this.useRelay();
    } else {
      if (d.k === 'offer' && !this.pc && !this.open) { this.peer = m.peer; this.hostInfo = d; this.answerRTC(d.sdp); }
      else if (d.k === 'relay' && (!this.peer || m.peer === this.peer) && !this.open) { this.peer = m.peer; this.why = d.why || this.why; this.useRelay(); this.sig({ k: 'relay-ok' }); }
      else if (d.k === 'busy') this.fail('Match is already full.');
    }
  }
  async startRTC() {
    const pc = this.pc = this.newPC(); if (!pc) { this.note('WebRTC not available in browser'); return this.goRelay(); }
    this.attach(pc.createDataChannel('abc2', { ordered: true }));
    this.attachFast(pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 })); // positions: a late one is useless, never wait for it
    try { await pc.setLocalDescription(await pc.createOffer()); await this.gathered(pc);
      this.sig({ k: 'offer', sdp: { type: 'offer', sdp: pc.localDescription.sdp }, map: A.selectedMap, hero: A.selectedHero }); }
    catch (e) { this.note('could not create offer'); return this.goRelay(); }
    this.rtcTimer = setTimeout(() => { if (this.open) return;
      const c = this.cands || {}; this.note(this.gotAnswer ? `ICE ${pc.iceConnectionState}, candidates ${Object.keys(c).join('/') || 'none'}` : 'no answer from guest');
      this.goRelay(); }, 9000);
  }
  async answerRTC(sdp) {
    const pc = this.pc = this.newPC(); if (!pc) return;
    pc.ondatachannel = e => e.channel.label === 'fast' ? this.attachFast(e.channel) : this.attach(e.channel);
    try { await pc.setRemoteDescription(sdp); await pc.setLocalDescription(await pc.createAnswer()); await this.gathered(pc);
      this.sig({ k: 'answer', sdp: { type: 'answer', sdp: pc.localDescription.sdp } }); } catch (e) {}
  }
  newPC() { try { const pc = new RTCPeerConnection({ iceServers: STUN }); this.cands = {}; pc.onicecandidate = e => { const m = e.candidate && / typ (\w+)/.exec(e.candidate.candidate); if (m) this.cands[m[1]] = 1; }; return pc; } catch (e) { return null; } }
  gathered(pc) { return new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); const t = setTimeout(res, 2500);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }); }); }
  attach(ch) {
    this.ch = ch;
    ch.onopen = () => { if (this.mode === 'relay') return; this.mode = 'webrtc'; this.ready(); };
    ch.onmessage = e => this.recv(e.data);
    ch.onclose = () => { if (this.ch === ch && this.mode === 'webrtc') this.lost(); };
  }
  attachFast(ch) { this.fast = ch; ch.onmessage = e => this.recv(e.data); }
  backlogged() { return this.mode === 'webrtc' && this.ch && this.ch.bufferedAmount > 64 * 1024; }
  goRelay() { if (this.open || this.closed) return; this.sig({ k: 'relay', why: this.why || '' }); } // host: ask the guest to switch; it answers relay-ok
  useRelay() { if (this.open) return; this.mode = 'relay'; try { this.pc && this.pc.close(); } catch (e) {} this.pc = null; this.ready(); }
  ready() {
    if (this.down) return this.recover();
    if (this.open) return; this.open = true; this.everOpen = true; clearInterval(this.helloT); clearTimeout(this.rtcTimer); this.lastRecv = performance.now();
    this.pingT = setInterval(() => { this.send({ t: 'ping', at: performance.now() }, true); if (performance.now() - this.lastRecv > 6000) this.lost(); }, 1000);
    this.emitState(this.mode === 'webrtc' ? 'Connected (P2P)' : 'Connected (room)');
    if (this.onReady) this.onReady();
  }
  canSend() { return !this.closed && (this.open || (this.down && this.mode === 'relay')); } // the room stays up while the other page is away
  send(o, fast) {
    if (!this.canSend()) return;
    const s = JSON.stringify(o); this.bytesOut = (this.bytesOut || 0) + s.length;
    if (this.mode === 'webrtc') { const ch = fast && this.fast && this.fast.readyState === 'open' ? this.fast : this.ch; if (ch && ch.readyState === 'open') try { ch.send(s); } catch (e) {} return; }
    const id = Math.random().toString(36).slice(2, 8), n = Math.ceil(s.length / CHUNK) || 1;
    for (let i = 0; i < n; i++) this.room.emit('relay', { code: this.code, id, i, n, s: s.slice(i * CHUNK, (i + 1) * CHUNK) }).catch(() => {});
  }
  onRelay(d) {
    if (d.n === 1) return this.recv(d.s);
    let p = this.parts.get(d.id); if (!p) { p = []; this.parts.set(d.id, p); if (this.parts.size > 20) this.parts.delete(this.parts.keys().next().value); }
    p[d.i] = d.s; if (p.filter(x => x !== undefined).length === d.n) { this.parts.delete(d.id); this.recv(p.join('')); }
  }
  sendPos(o) { // relay mode: positions as this page's presence in the room, latest wins
    if (!this.canSend()) return; o.code = this.code; this.bytesOut = (this.bytesOut || 0) + JSON.stringify(o).length;
    this.room.presence({ mp: o }).catch(() => {});
  }
  recv(s) {
    let o; try { o = JSON.parse(s); } catch (e) { return; }
    this.dispatch(o);
  }
  dispatch(o) {
    this.lastRecv = performance.now();
    if (this.down && this.mode === 'relay') this.recover();
    if (o.t === 'bye') return this.lost(true); // the other player left on purpose: no waiting
    if (o.t === 'ping') return this.send({ t: 'pong', at: o.at }, true);
    if (o.t === 'pong') { this.rtt = performance.now() - o.at; return; }
    for (const h of this.handlers) h(o);
  }
  on(h) { this.handlers.push(h); }
  emitState(s) { this.status = s; if (this.onStatus) this.onStatus(s); }
  fail(s) { this.emitState(s); this.failed = true; }
  // a drop first waits RECONNECT_S for the other page to come back (the guest keeps looking for the host); only then is the match given up
  lost(final) {
    if (this.closed || this.gone) return;
    if (!final && this.open) {
      this.open = false; this.down = true; this.downAt = performance.now(); this.emitState('Reconnecting…');
      this.giveUpT = setTimeout(() => this.lost(true), RECONNECT_S * 1000);
      if (this.guest && this.pj) { this.rejoinT = setInterval(() => this.rejoin(), 2500); setTimeout(() => this.rejoin(), 300); }
      return;
    }
    if (!final && this.down) return;
    this.gone = true; this.down = false; this.open = false; clearTimeout(this.giveUpT); clearInterval(this.rejoinT); clearInterval(this.pingT);
    this.emitState('Connection lost'); if (this.onLost) this.onLost();
  }
  recover() {
    this.down = false; this.open = true; clearTimeout(this.giveUpT); clearInterval(this.rejoinT); this.lastRecv = performance.now();
    this.emitState(this.mode === 'webrtc' ? 'Connected (P2P)' : 'Connected (room)'); if (this.onReconnect) this.onReconnect();
  }
  close() {
    if (this.closed) return;
    if (this.open) this.send({ t: 'bye' });
    this.closed = true; this.open = false; this.down = false;
    clearInterval(this.helloT); clearInterval(this.pingT); clearTimeout(this.rtcTimer); clearTimeout(this.giveUpT); clearInterval(this.rejoinT);
    this.unsubs.forEach(u => { try { u(); } catch (e) {} });
    setTimeout(() => { // let the bye go out first
      try { this.ch && this.ch.close(); this.fast && this.fast.close(); } catch (e) {} try { this.pc && this.pc.close(); } catch (e) {}
      const leave = () => { if (this.room && this.room.leave) this.room.leave().catch(() => {}); };
      if (this.room && this.room.presence) this.room.presence({ mp: null }).catch(() => {}).then(() => setTimeout(leave, 300)); else leave();
      try { this.pj && this.pj.destroy(); } catch (e) {}
    }, 250);
  }
}
// a PeerJS connection dressed as an RTCDataChannel, so Link treats both the same
function pjChan(c) {
  return { send: s => c.send(s), close: () => c.close(), get readyState() { return c.open ? 'open' : 'closed'; },
    get bufferedAmount() { return c.dataChannel ? c.dataChannel.bufferedAmount : 0; },
    set onmessage(f) { c.on('data', d => f({ data: d })); }, set onclose(f) { c.on('close', f); }, set onopen(f) {} };
}
let pjP = null;
function loadPeerJS() { // peerjs.min.js ships next to the game when it is hosted outside claude.ai
  if (window.Peer) return Promise.resolve(true);
  if (!pjP) pjP = new Promise(res => { const sc = document.createElement('script'); sc.src = 'peerjs.min.js'; sc.onload = () => res(!!window.Peer); sc.onerror = () => res(false); document.head.appendChild(sc); });
  return pjP;
}

// ---------- state serialization ----------
// x/y travel separately on the fast channel ('pos'); everything else as reliable deltas ('st')
const UNIT_SKIP = new Set(['def', 'icon', 'spIcon', 'lastHitBy', 'ai', 'isPlayer', 'remote', 'netNext', 'charge3', 'netOffer', 'x', 'y', 'regenT', 'distMoved', 'jokerT', 'vx', 'vy']);
const FN_NAME = new Map(Object.entries(A.FNS).map(([k, f]) => [f, k]));
const isUnit = v => v instanceof A.Hero || v instanceof A.Minion || v instanceof A.Tower || (v && v.kind && v.id && typeof v.has === 'function');
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
function enc(v, d) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'function') return { __f: FN_NAME.get(v) || 'anon' };
    if (typeof v === 'number') return isFinite(v) ? r2(v) : null;
    return v;
  }
  if (isUnit(v)) return { __u: v.id };
  if (v instanceof Set || v instanceof Map || (typeof Node !== 'undefined' && v instanceof Node) || v instanceof Image) return undefined;
  if (d > 4) return undefined;
  if (Array.isArray(v)) return v.map(x => { const e = enc(x, d + 1); return e === undefined ? null : e; });
  const o = {}; for (const k in v) { if (k[0] === '_') continue; const e = enc(v[k], d + 1); if (e !== undefined) o[k] = e; } return o;
}
function encFields(obj, skip) { const o = {}; for (const k of Object.keys(obj)) { if ((skip && skip.has(k)) || k[0] === '_') continue; const e = enc(obj[k], 1); if (e !== undefined) o[k] = e; } return o; }

// ---------- host ----------
const PROJ_SKIP = new Set(['hit', 'petals', 'nid', 'x', 'y']);
let nidN = 1;
function hostSetup(link) {
  let snapT = 0, posT = 0, seq = 0, posSeq = 0, kfN = 0; const sentU = new Map(), sentP = new Map(), seenFx = new WeakSet(); let lastG = {};
  // the guest's movement arrives as the exact steps it simulated ([mx, my, dt]); replaying them here
  // puts its hero where its own prediction already has it, so it rarely needs correcting
  const steps = []; let budget = 0; const seenAct = new Set(); let forceKf = false;
  link.input = { seq: 0, ack: 0, special: false }; emoteSetup(link);
  const guestHero = () => { const g = A.game; return g && g.units.find(u => u.remote); };
  link.on(o => {
    const g = A.game; if (!g || g.net !== link) return;
    const h = guestHero();
    if (o.t === 'in') { for (const s of o.st || []) steps.push(s); steps.push({ seq: o.seq }); link.input.seq = o.seq; }
    else if (o.t === 'act' && h) {
      if (o.aid) { if (seenAct.has(o.aid)) return; seenAct.add(o.aid); }
      if (o.a === 'special') link.input.special = true;
      else if (o.a === 'use' && h.items[o.i]) A.useItem(h, h.items[o.i]);
      else if (o.a === 'pick' && h.netOffer && h.netOffer[o.i]) A.equipItem(h, h.netOffer[o.i]);
      else if (o.a === 'emote') h.emote = { at: g.time }; // reaches the guest with the next delta
    }
  });
  link.resetHost = () => { sentU.clear(); sentP.clear(); steps.length = 0; budget = 0; kfN = 0; ackPos = null; seenAct.clear(); }; // a new match on the same link
  link.onReconnect = () => { sentU.clear(); sentP.clear(); steps.length = 0; budget = 0; forceKf = true; }; // the guest is back: send everything again
  let ackPos = null; // where the guest's hero stood right after the acked packet: what its prediction is checked against
  const ackMarks = u => { while (steps.length && steps[0].seq !== undefined) { link.input.ack = steps.shift().seq; ackPos = [r3(u.x), r3(u.y)]; } };
  link.control = (u, dt) => { // called by game.js update() for the guest's hero when it can act
    if (!(u.specialActive && u.specialActive.joker)) {
      let queued = 0; for (const s of steps) if (Array.isArray(s)) queued += s[2];
      budget += dt * (queued > 0.2 ? 1.6 : 1); // catch up when packets bunch up
      ackMarks(u);
      while (steps.length && Array.isArray(steps[0]) && steps[0][2] <= budget + 1e-4) { const s = steps.shift(); budget -= s[2]; A.moveUnit(u, s[0], s[1], s[2]); ackMarks(u); }
      if (!steps.length) budget = Math.min(budget, 0.02);
    }
    if (link.input.special) { link.input.special = false; A.tryCastSpecial(u); }
    u._ctl = true;
  };
  link.tick = dt => {
    const g = A.game; if (!g) return;
    const h = guestHero();
    if (h && !h._ctl) { steps.length = 0; budget = 0; link.input.ack = link.input.seq; ackPos = [r3(h.x), r3(h.y)]; } // stunned, dead, casting: the host decides where it is
    if (h) { h._ctl = false; if (!steps.length) ackPos = [r3(h.x), r3(h.y)]; } // nothing of the guest's pending: anything since (knockback, hook) shows up as a correction
    const relay = link.mode === 'relay';
    posT -= dt; if (posT <= 0) { posT = relay ? POS_DT_RELAY : SNAP_DT;
      const pos = [], ppos = []; for (const un of g.units) pos.push(un.id, r3(un.x), r3(un.y));
      for (const pr of g.projectiles) { if (!pr.nid) pr.nid = nidN++; ppos.push(pr.nid, r3(pr.x), r3(pr.y)); }
      const P = { t: 'pos', m: link.matchN, s: ++posSeq, ht: r3(performance.now() / 1000), ack: link.input.ack, ap: ackPos, u: pos, p: ppos };
      if (relay) link.sendPos(P); else link.send(P, true); }
    snapT -= dt; if (snapT > 0) return;
    if (link.backlogged()) return; // the channel is still sending the last one: skip, the next delta carries it
    snapT = relay ? SNAP_DT_RELAY : SNAP_DT;
    const msg = { t: 'st', m: link.matchN, seq: ++seq };
    if ((relay && ++kfN % KEYFRAME_EVERY === 1) || forceKf) { forceKf = false; sentU.clear(); sentP.clear(); msg.kf = 1; msg.all = g.units.map(u => u.id); msg.allp = g.projectiles.map(p => p.nid || (p.nid = nidN++)); } // room messages can drop
    const G = { time: g.time, state: g.state, level: g.level, kills: g.kills, stars: g.stars, winner: g.winner, overT: g.overT, endAt: g.endAt || null, waveT: g.waveT, toastT: g.toastT, bannerT: g.bannerT, starTip: g.starTip, noStars: g.noStars };
    msg.g = enc(G, 1); // small: always whole, so a lost message never hides the match ending
    const u = {}, alive = new Set();
    for (const un of g.units) {
      alive.add(un.id);
      const f = encFields(un, UNIT_SKIP); if (un.remote) f.netOffer = un.netOffer || null;
      let prev = sentU.get(un.id), d = {}, any = false; if (!prev) { prev = {}; sentU.set(un.id, prev); d.kind = un.kind; d.cls = un.constructor.name; d.x = r3(un.x); d.y = r3(un.y); }
      for (const k in f) { const s = JSON.stringify(f[k]); if (prev[k] !== s) { d[k] = f[k]; prev[k] = s; any = true; } }
      if (any || d.cls) u[un.id] = d;
    }
    const ur = []; for (const id of sentU.keys()) if (!alive.has(id)) { ur.push(id); sentU.delete(id); }
    msg.u = u; if (ur.length) msg.ur = ur;
    const p = {}, live = new Set();
    for (const pr of g.projectiles) {
      if (!pr.nid) pr.nid = nidN++; live.add(pr.nid);
      const f = encFields(pr, PROJ_SKIP); let prev = sentP.get(pr.nid), d = {}, any = false; if (!prev) { prev = {}; sentP.set(pr.nid, prev); d.x = r3(pr.x); d.y = r3(pr.y); any = true; }
      for (const k in f) { const s = JSON.stringify(f[k]); if (prev[k] !== s) { d[k] = f[k]; prev[k] = s; any = true; } }
      if (any) p[pr.nid] = d;
    }
    const pr = []; for (const id of sentP.keys()) if (!live.has(id)) { pr.push(id); sentP.delete(id); }
    msg.p = p; if (pr.length) msg.pr = pr;
    // short-lived things are sent once when they appear; the guest ages them itself
    const nw = list => list.filter(e => !seenFx.has(e) && seenFx.add(e)).map(e => enc(e, 1));
    msg.fx = nw(g.effects); msg.tx = nw(g.texts); msg.fd = nw(g.feed);
    link.send(msg);
  };
  link.onLost = () => { const g = A.game; if (g && g.net === link && g.state !== 'over') { A.endMatch(2); g.netNote = 'Enemy left the match'; } };
}

// emotes (heart): both sides set it on their own hero; the host's copy travels in the unit deltas
const EMOTE_CD = 2;
function emoteSetup(link) {
  let last = -1e9;
  link.emoteReady = () => performance.now() / 1000 - last >= EMOTE_CD;
  link.emote = () => {
    const g = A.game; if (!g || g.net !== link || !g.player || !link.emoteReady()) return;
    last = performance.now() / 1000; g.player.emote = { at: g.time };
    if (link.role === 'guest') link.action({ a: 'emote' });
  };
}

// ---------- guest ----------
const CLS = () => ({ Hero: A.Hero, Minion: A.Minion, Tower: A.Tower });
function guestSetup(link, myHero) {
  const units = new Map(), projs = new Map(); let me = null, inSeq = 0, inT = 0, stepBuf = []; const hist = [];
  const posBuf = []; let lastPosSeq = 0, rt = null, lastArr = 0, ivl = 0.033, jit = 0.005; // positions over time, drawn ~1.5 snapshots in the past so others move smoothly
  const resolve = (v, d = 0) => {
    if (v === null || typeof v !== 'object' || d > 5) return v;
    if (Array.isArray(v)) return v.map(x => resolve(x, d + 1));
    if (v.__u !== undefined) return units.get(v.__u) || null;
    if (v.__f !== undefined) return A.FNS[v.__f] || NOOP;
    const o = {}; for (const k in v) o[k] = resolve(v[k], d + 1); return o;
  };
  const pending = []; let curM = 0, joinedM = 0, pred = null; emoteSetup(link);
  link.resetGuest = () => { units.clear(); projs.clear(); me = null; posBuf.length = 0; rt = null; hist.length = 0; stepBuf = []; pending.length = 0; pred = null; };
  link.onReconnect = () => { posBuf.length = 0; rt = null; hist.length = 0; stepBuf = []; };
  link.matchM = () => curM; link.joinedM = () => joinedM;
  link.on(o => {
    // every match on this link has a number m; anything from an older one is ignored
    if (o.t === 'start') { if (o.m > curM) { curM = o.m; link.mapName = o.map; link.enemyName = o.name; if (link.onStart) link.onStart(o); } return; }
    if (o.t === 'pos') { if (o.m === curM && joinedM === curM) onPos(o); return; }
    if (o.t !== 'st' || o.m !== curM) return;
    if (joinedM === curM) { if (A.game && A.game.net === link) pending.push(o); }
    else if (link.mapName && !link.closed) { joinedM = curM; link.resetGuest(); startGuestMatch(link, link.mapName); apply(o); } // the match appears with the host's first full state
  });
  function onPos(o) {
    if (o.s <= lastPosSeq) return; lastPosSeq = o.s; // the fast channel may drop or reorder
    const um = new Map(); for (let i = 0; i < o.u.length; i += 3) um.set(o.u[i], [o.u[i + 1], o.u[i + 2]]);
    const pm = new Map(); for (let i = 0; i < o.p.length; i += 3) pm.set(o.p[i], [o.p[i + 1], o.p[i + 2]]);
    posBuf.push({ ht: o.ht, um, pm }); while (posBuf.length > 40) posBuf.shift();
    const now = performance.now() / 1000; if (lastArr) { const iv = now - lastArr; ivl += (iv - ivl) * 0.1; jit += (Math.abs(iv - ivl) - jit) * 0.1; } lastArr = now;
    if (me && o.ap) reconcile(o.ack, o.ap[0], o.ap[1], um.get(me.id));
  }
  function apply(o) {
    const g = A.game; if (!g || g.net !== link) return;
    Object.assign(g, o.g);
    // create first so references between units resolve
    for (const id in o.u) if (!units.has(+id)) {
      if (!o.u[id].cls) { delete o.u[id]; continue; } // its first (full) message was lost: wait for the next keyframe
      const d = o.u[id], C = CLS()[d.cls] || (d.kind === 'hero' ? A.Hero : d.kind === 'tower' ? A.Tower : A.Minion);
      const un = Object.create(C.prototype); un.id = +id; un.statuses = []; un.lastHitBy = new Map(); un.ai = { t: 0 }; un.items = []; un.passive = {}; units.set(+id, un); g.units.push(un); un._new = true;
    }
    for (const id in o.u) {
      const un = units.get(+id), d = o.u[id];
      for (const k in d) { if (k === 'cls' || (k === 'name' && un.kind === 'hero')) continue; un[k] = resolve(d[k]); }
      if (pred && un === me && (d.charge !== undefined || d.stocks !== undefined)) pred = null; // the host's own value is in: drop the guess
      if (un._new) {
        un._new = false;
        if (un.kind === 'hero') { un.def = A.HEROES[un.code]; un.icon = A.img('profile_' + un.code.toLowerCase()); un.spIcon = A.img('ui_abilities_' + un.code.toLowerCase() + '_special'); }
        else if (un.kind === 'tower') un.def = A.UNITS.Tower; else un.def = A.UNITS[un.type];
        if (un.kind === 'hero') un.name = un.team === A_TEAM ? 'You' : link.enemyName || 'Enemy'; // host names are from its own view
        if (un.kind === 'hero' && !un.isIllusion && un.team === A_TEAM && !me) { me = un; un.isPlayer = true; g.player = un; un.name = 'You'; g.cam.x = un.x; g.cam.y = un.y - 2; }
      }
    }
    if (o.kf) { const keep = new Set(o.all); for (const id of [...units.keys()]) if (!keep.has(id)) (o.ur = o.ur || []).push(id);
      const keepP = new Set(o.allp); for (const id of [...projs.keys()]) if (!keepP.has(id)) (o.pr = o.pr || []).push(id); }
    if (o.ur) for (const id of o.ur) { const un = units.get(id); units.delete(id); if (un) { const i = g.units.indexOf(un); if (i >= 0) g.units.splice(i, 1); } }
    for (const id in o.p) { let p = projs.get(+id); const d = o.p[id];
      if (!p) { p = { nid: +id }; projs.set(+id, p); }
      for (const k in d) p[k] = resolve(d[k]);
      if (!p._in && p.src) { p._in = true; g.projectiles.push(p); } } // drawn only once it is complete (a lost first message leaves it partial)
    if (o.pr) for (const id of o.pr) { const p = projs.get(id); projs.delete(id); if (p) { const i = g.projectiles.indexOf(p); if (i >= 0) g.projectiles.splice(i, 1); } }
    for (const e of o.fx || []) g.effects.push(resolve(e));
    for (const t of o.tx || []) { const r = resolve(t); if (r.rep) g.texts = g.texts.filter(x => x.k !== r.rep); g.texts.push(r); } // a damage number that counted up replaces the one it grew from
    const hostNames = new Set(['You', link.myName || 'Enemy']), label = (n, t) => hostNames.has(n) && t ? (t === A_TEAM ? 'You' : link.enemyName || 'Enemy') : n;
    for (const f of o.fd || []) { const e = resolve(f); e.k = label(e.k, e.kt); e.v = label(e.v, e.vt); g.feed.push(e); }
    g.itemOffer = me && me.netOffer ? { choices: me.netOffer, t: 0 } : null;
  }
  // own hero: the host replays our steps, so where it has us after step `ack` should match where we were then
  function reconcile(ack, ax, ay, cur) {
    while (hist.length && hist[0].seq < ack) hist.shift();
    const h = hist.length && hist[0].seq === ack ? hist[0] : null;
    const sx = h ? ax : cur ? cur[0] : ax, sy = h ? ay : cur ? cur[1] : ay;
    link.corr = link.corr || { n: 0, sum: 0, max: 0 };
    if (!h && hist.length && hist[0].seq > ack) { // our latest steps haven't reached the host yet: only a big jump (hook, knockback, respawn) overrides the prediction
      if (cur && (Math.hypot(cur[0] - me.x, cur[1] - me.y) > 2.5 || !me.alive)) { me.x = cur[0]; me.y = cur[1]; me._cx = me._cy = 0; hist.length = 0; }
      return;
    }
    if (!h) { // the host moved us itself (stun, hook, knockback, jump, death): follow it
      const ex = sx - me.x, ey = sy - me.y;
      if (Math.hypot(ex, ey) > 2.5 || !me.alive) { me.x = sx; me.y = sy; me._cx = me._cy = 0; } else { me._cx = ex; me._cy = ey; }
      return;
    }
    const ex = sx - h.x, ey = sy - h.y, e = Math.hypot(ex, ey); link.corr.n++; link.corr.sum += e; link.corr.max = Math.max(link.corr.max, e);
    if (e < 0.02) return;
    if (e > 2.5) { me.x = sx; me.y = sy; me._cx = me._cy = 0; hist.length = 0; return; }
    me._cx = (me._cx || 0) + ex; me._cy = (me._cy || 0) + ey; for (const q of hist) { q.x += ex; q.y += ey; }
  }
  function interp(dt) {
    if (!posBuf.length) return;
    const delay = Math.min(0.35, Math.max(0.05, ivl * 1.3 + jit * 2.5)), target = posBuf[posBuf.length - 1].ht - delay;
    if (rt === null || Math.abs(rt - target) > 0.3) rt = target; else rt += dt + (target - rt) * 0.05;
    let a = posBuf[0], b = null;
    for (let i = 0; i < posBuf.length; i++) { if (posBuf[i].ht <= rt) a = posBuf[i]; else { b = posBuf[i]; break; } }
    const k = b && b.ht > a.ht ? clamp01((rt - a.ht) / (b.ht - a.ht)) : 0;
    const place = (o, A0, B0) => { if (!A0 && !B0) return; if (!A0 || !B0) { const q = A0 || B0; o.x = q[0]; o.y = q[1]; return; }
      if (Math.hypot(B0[0] - A0[0], B0[1] - A0[1]) > 3) { const q = k < 0.5 ? A0 : B0; o.x = q[0]; o.y = q[1]; return; } // teleport (respawn, jump)
      o.x = A0[0] + (B0[0] - A0[0]) * k; o.y = A0[1] + (B0[1] - A0[1]) * k; };
    for (const un of A.game.units) if (un !== me) place(un, a.um.get(un.id), b && b.um.get(un.id));
    for (const p of A.game.projectiles) place(p, a.pm.get(p.nid), b && b.pm.get(p.nid));
  }
  function separateMe(g) { // the host's separate() for our hero only, so bumping into towers and units is predicted too
    if (me.has('ghost') || (me.specialActive && me.specialActive.inAir)) return;
    for (const t of g.units) if (t.kind === 'tower' && t.alive) {
      const d = Math.hypot(me.x - t.x, me.y - t.y), min = t.r + me.r; if (d >= min) continue;
      let nx = (me.x - t.x) / (d || 1), ny = (me.y - t.y) / (d || 1); const side = me.x >= t.x ? 1 : -1; nx += -ny * side * 0.6;
      const m = Math.hypot(nx, ny) || 1, px = me.x + nx / m * (min - d + 0.01), py = me.y + ny / m * (min - d + 0.01); if (g.map.free(px, py, me.r)) { me.x = px; me.y = py; }
    }
    for (const b of g.units) if (b !== me && b.alive && b.kind !== 'tower' && !b.has('ghost')) {
      const d = Math.hypot(b.x - me.x, b.y - me.y), min = (me.r + b.r) * 0.9; if (d >= min || d < 1e-4) continue;
      const push = (min - d) / 2, px = me.x - (b.x - me.x) / d * push, py = me.y - (b.y - me.y) / d * push; if (g.map.free(px, py, me.r)) { me.x = px; me.y = py; }
    }
  }
  link.tick = dt => {
    const g = A.game; if (!g) return;
    while (pending.length) apply(pending.shift());
    interp(dt);
    if (me) {
      const mv = A.readMove();
      if (g.state === 'play' && me.alive && A.canAct(me) && !me.has('casting') && !(me.specialActive && me.specialActive.joker)) {
        if (mv.x || mv.y) { A.moveUnit(me, mv.x, mv.y, dt); stepBuf.push([r3(mv.x), r3(mv.y), r3(dt)]); }
      }
      if (me.alive) separateMe(g);
      if (me._cx || me._cy) { const c = Math.min(1, dt * 12); me.x += me._cx * c; me.y += me._cy * c; me._cx *= 1 - c; me._cy *= 1 - c; if (Math.hypot(me._cx, me._cy) < 1e-3) me._cx = me._cy = 0; }
      if (A.input.special) { A.input.special = false; link.action({ a: 'special' }); predictSpecial(g); }
      if (pred && performance.now() > pred.until) { me.charge = pred.charge; me.stocks = pred.stocks; pred = null; } // the host did not cast it (no target): undo
      inT -= dt; if (inT <= 0 && stepBuf.length) { inT = link.mode === 'relay' ? INPUT_DT_RELAY : INPUT_DT; inSeq++;
        link.send({ t: 'in', seq: inSeq, st: stepBuf }); stepBuf = []; hist.push({ seq: inSeq, x: me.x + (me._cx || 0), y: me.y + (me._cy || 0) }); if (hist.length > 120) hist.shift(); }
    }
    for (const un of g.units) { un.flash = Math.max(0, (un.flash || 0) - dt); if (un.attackAnim > 0) un.attackAnim -= dt; }
    A.updateFx(dt); A.updateCamera(dt);
    if (g.state === 'over') g.overT += dt;
  };
  // the special shows at once: the button empties and the hero flashes; the host's cast follows half a ping later
  function predictSpecial(g) {
    if (pred || g.state !== 'play' || !me.alive || !me.specialReady || me.specialActive || me.has('stun')) return;
    pred = { charge: me.charge, stocks: me.stocks, until: performance.now() + Math.max(400, link.rtt * 2 + 300) };
    if (me.def.maxSpecialStocks > 1) me.stocks--; else me.charge = 0;
    g.effects.push({ type: 'ring', x: me.x, y: me.y, t: 0.35, max: 0.35, r: 1.1, color: '#ffd36b', u: me });
    me.attackAnim = 0.25;
  }
  let aid = 0;
  link.action = o => { const m = Object.assign({ t: 'act', aid: ++aid }, o); link.send(m); if (link.mode === 'relay') setTimeout(() => link.send(m), 80); return true; }; // room messages can drop: send twice, the host ignores the copy
  link.onLost = () => { const g = A.game; if (g && g.net === link && g.state !== 'over') { g.state = 'over'; g.winner = A_TEAM; g.overT = 0; g.netNote = 'Host left the match'; } };
}
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const NOOP = () => {};
const A_TEAM = 1; // the guest always plays team 1 (top of the map)

function startGuestMatch(link, mapName) {
  A.setTeams(A_TEAM);
  const map = new A.GameMap(mapName);
  A.game = { map, units: [], projectiles: [], effects: [], texts: [], feed: [], time: -A.MATCH.startCountdown, state: 'countdown', level: 1, waveT: 0, waveN: 0,
    kills: { 1: 0, 2: 0 }, stars: { 1: 0, 2: 0 }, starTip: 0, starTipShown: true, player: null, overT: 0, winner: 0, cam: { x: map.w / 2, y: map.h / 2 }, lastKill: new Map(), spawns: { 1: [], 2: [] }, bannerT: 0, net: link };
  // a placeholder player until the host's first state arrives (render() expects one)
  const ph = new A.Hero(myHeroOf(link), A_TEAM, map.w / 2, map.h - 3, true, 'You'); ph.alive = false; ph.respawnT = 99; ph._placeholder = true;
  A.game.player = ph;
  A.menu.style.display = 'none';
}
const myHeroOf = link => link.myHero || A.selectedHero;

// ---------- lobby UI ----------
// After connecting, both players wait in a lobby: each picks a hero in the menu and presses READY; the host starts when both are.
// The end screen offers REMATCH (same heroes, at once when both press it); tapping elsewhere goes back to the lobby, still connected.
let link = null;
const S = { ready: false, rematch: false, peer: {} }; // this page's lobby state, and the other player's last one
function code4() { const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += L[(Math.random() * L.length) | 0]; return s; }
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 12);
let nameIn = null;
const myName = () => cleanName(nameIn && nameIn.value);
const enemyLabel = () => cleanName(S.peer.name) || 'Enemy';
const inClaude = () => !!(window.claude && window.claude.use);
const curMatch = l => l.role === 'host' ? (l.matchN || 0) : l.matchM ? l.matchM() : 0;
function where(l) { // 'lobby', 'match' or 'over', as the other player should see it
  const g = A.game;
  if (l.role === 'guest' && l.matchM && l.matchM() > l.joinedM()) return 'match'; // a start arrived, the match is on its way
  if (g && g.net === l) return g.state === 'over' ? 'over' : 'match';
  return 'lobby';
}
function ui() {
  const box = document.createElement('div'); box.id = 'mp';
  box.innerHTML = `<div class="mph">Multiplayer 1v1</div>
    <div class="mprow"><input id="mpName" maxlength="12" placeholder="YOUR NAME" autocomplete="off" spellcheck="false"></div>
    <div class="mprow" id="mpStartRow"><button id="mpHost">CREATE MATCH</button><input id="mpCode" maxlength="4" placeholder="CODE" autocomplete="off" spellcheck="false"><button id="mpJoin">JOIN</button></div>
    <div id="mpStatus" aria-live="polite"></div>
    <div class="mprow" id="mpShareRow" hidden><button id="mpShare">${inClaude() ? 'COPY CODE' : 'SHARE INVITE LINK'}</button><button id="mpCancel" class="sec">CANCEL</button></div>
    <div id="mpLobby" hidden>
      <div class="mpl"><span>You</span><b id="mplMe"></b><i id="mplMeR"></i></div>
      <div class="mpl"><span id="mplEnN">Enemy</span><b id="mplEn"></b><i id="mplEnR"></i></div>
      <div class="mpmap" id="mplMap"></div>
      <div class="mprow"><button id="mpReady">READY</button><button id="mpLeave" class="sec">LEAVE</button></div>
    </div>`;
  const css = document.createElement('style');
  css.textContent = `#mp{background:var(--panel);border-radius:12px;padding:10px 12px;margin-top:12px}#mp [hidden]{display:none!important}
    #mp .mph{font-weight:bold;color:var(--gold);font-size:14px;margin-bottom:6px}#mp .mph span{color:var(--muted);font-weight:normal;font-size:11px}
    #mp .mprow{display:flex;gap:6px;margin-top:6px}#mp button{flex:1;padding:10px 6px;border:0;border-radius:10px;background:#3a6cff;color:#fff;font-weight:bold;cursor:pointer;font-size:13px}
    #mp button.sec{flex:0 0 auto;background:#39407a}#mp button.on{background:#2fae5b}
    #mp button:disabled{opacity:.5}#mp input{width:64px;text-align:center;text-transform:uppercase;font:bold 16px monospace;letter-spacing:2px;background:#0d1020;color:var(--text);border:1px solid #39407a;border-radius:10px}
    #mp #mpName{flex:1;width:auto;text-transform:none;letter-spacing:0;font:bold 14px "Trebuchet MS",system-ui,sans-serif;padding:8px;text-align:left}
    #mp button:focus-visible,#mp input:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
    #mpStatus{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.4;min-height:1em;overflow-wrap:anywhere}#mpStatus b{color:var(--text);font:bold 22px monospace;letter-spacing:4px}
    #mp .mpl{display:grid;grid-template-columns:64px 1fr auto;gap:6px;align-items:center;font-size:13px;padding:6px 8px;margin-top:6px;background:#0d1020;border-radius:8px}
    #mp .mpl span{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#mp .mpl i{font-style:normal;font-size:12px;color:var(--muted)}#mp .mpl i.ok{color:#8fffb0}
    #mp .mpmap{font-size:12px;color:var(--muted);margin-top:6px}`;
  document.head.appendChild(css);
  const tut = document.getElementById('tut'); tut.parentNode.insertBefore(box, tut.nextSibling);
  const $ = id => document.getElementById(id);
  const st = $('mpStatus'), codeIn = $('mpCode'), lobby = $('mpLobby'), startRow = $('mpStartRow'), shareRow = $('mpShareRow');
  nameIn = $('mpName');
  try { nameIn.value = localStorage.getItem('abc2-name') || ''; } catch (e) {}
  nameIn.addEventListener('input', () => { try { localStorage.setItem('abc2-name', myName()); } catch (e) {} });
  nameIn.addEventListener('keydown', e => e.stopPropagation());
  const setSt = h => { st.innerHTML = h; };
  const mapLabel = m => { const o = document.querySelector(`#map option[value="${m}"]`); return o ? o.textContent : m; };
  // while a link exists the single-player buttons are out of the way (and a double-tap on a hero doesn't start a bot match)
  const busy = on => { window.__mpLobby = on; $('play').style.display = $('tut').style.display = on ? 'none' : ''; startRow.hidden = on; };
  const reset = () => { if (link) link.close(); link = null; S.ready = S.rematch = false; S.peer = {}; lobby.hidden = true; shareRow.hidden = true; busy(false); };
  let lastSent = '', lastSentT = 0;
  const push = (force) => { // our lobby state to the other player: on change, and every second in case one was lost
    const l = link; if (!l || !l.open) return;
    l.myHero = A.selectedHero; l.myName = myName();
    const o = { t: 'lobby', hero: A.selectedHero, name: myName(), ready: S.ready, rematch: S.rematch, where: where(l), m: curMatch(l), map: l.role === 'host' ? A.selectedMap : undefined };
    const js = JSON.stringify(o), now = performance.now();
    if (force || js !== lastSent || now - lastSentT > 1000) { l.send(o); lastSent = js; lastSentT = now; }
  };
  const hostStart = l => { // host: both ready in the lobby, or both asked for a rematch
    l.matchN = (l.matchN || 0) + 1; S.ready = S.rematch = false; S.peer.ready = S.peer.rematch = false;
    const enemy = A.HEROES[S.peer.hero] ? S.peer.hero : 'Barbarian';
    const m = { t: 'start', m: l.matchN, map: A.selectedMap, hero: A.selectedHero, name: myName() };
    l.send(m); if (l.mode === 'relay') setTimeout(() => l.send(m), 120);
    if (A.game) A.game.net = null; // leave the end screen without closing the link
    l.resetHost(); A.menu.style.display = 'none';
    A.startMatch(A.selectedHero, A.selectedMap, false, { enemy, enemyName: enemyLabel(), link: l });
    push(true);
  };
  const lobbyText = l => l.down ? 'Connection dropped, reconnecting…' : `Connected (${l.mode === 'webrtc' ? 'P2P' : 'room'}). Pick your hero above, then press READY.`;
  const render = () => {
    const l = link; if (!l || lobby.hidden) return;
    if (!A.game) setSt(lobbyText(l));
    if (!l.open) return;
    $('mplMe').textContent = A.heroName(A.selectedHero); $('mplMeR').textContent = S.ready ? 'READY' : '…'; $('mplMeR').className = S.ready ? 'ok' : '';
    const p = S.peer, there = p.where === 'lobby';
    $('mplEnN').textContent = enemyLabel(); $('mplEn').textContent = p.hero ? A.heroName(p.hero) : '…';
    $('mplEnR').textContent = !p.hero ? '' : !there ? 'still in match' : p.ready ? 'READY' : 'picking…'; $('mplEnR').className = there && p.ready ? 'ok' : '';
    const map = l.role === 'host' ? A.selectedMap : p.map;
    $('mplMap').textContent = map ? 'Map: ' + mapLabel(map) + (l.role === 'host' ? ' (you pick it above)' : ' (host picks)') : '';
    const rb = $('mpReady'); rb.textContent = S.ready ? 'NOT READY' : 'READY'; rb.className = S.ready ? 'on' : '';
  };
  const showLobby = () => { lobby.hidden = false; shareRow.hidden = true; render(); };
  const onLobbyMsg = (l, o) => {
    if (o.t !== 'lobby') return;
    S.peer = o; if (l.role === 'guest') l.enemyName = enemyLabel();
    if (A.game && A.game.net === l) { const e = A.game.units.find(u => u.kind === 'hero' && !u.isIllusion && u !== A.game.player && u.team !== A.game.player.team); if (e) e.name = enemyLabel(); }
    render();
  };
  // the lobby loop: send state, start when both agree (host), redraw
  setInterval(() => {
    const l = link; if (!l) return;
    if (l.closed) { reset(); setSt(''); return; } // closed from the game (e.g. the score tab's exit)
    if (!l.open) { render(); return; }
    push(false);
    if (l.role === 'host') {
      const p = S.peer, m = l.matchN || 0, w = where(l);
      if (p.m === m && ((w === 'lobby' && S.ready && p.where === 'lobby' && p.ready) || (w === 'over' && S.rematch && p.where === 'over' && p.rematch))) hostStart(l);
    }
    render();
  }, 200);
  const wire = l => {
    l.on(o => onLobbyMsg(l, o));
    l.onReady = () => { if (link !== l) return; l.myHero = A.selectedHero; showLobby(); push(true); };
    if (l.role === 'guest') l.onStart = o => { S.ready = S.rematch = false; l.enemyName = enemyLabel(); push(true); };
    const hostLost = l.onLost; // the match's own handling (ends a running match) first, then the lobby
    l.onLost = () => { if (hostLost) hostLost(); if (link !== l) return;
      const inMatch = A.game && A.game.net === l; if (!inMatch) { reset(); setSt('The enemy left.'); } };
  };
  const share = code => {
    const url = location.href.split('#')[0] + '#join=' + code, txt = inClaude() ? code : url;
    const done = () => { $('mpShare').textContent = 'COPIED!'; setTimeout(() => { if ($('mpShare')) $('mpShare').textContent = inClaude() ? 'COPY CODE' : 'SHARE INVITE LINK'; }, 1500); };
    const fallback = () => setSt(`Your match code: <b>${code}</b><br>Copy this: ${txt}`);
    if (!inClaude() && navigator.share) navigator.share({ title: 'ABC2', text: 'Join my ABC2 match', url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, fallback); else fallback();
  };
  $('mpHost').onclick = () => {
    reset(); const code = code4(); const l = link = new Link('host', code); busy(true);
    setSt(`Your match code: <b>${code}</b><br>Send the ${inClaude() ? 'code' : 'invite link'} to your enemy. You play ${A.heroName(A.selectedHero)} on the map selected above.`);
    shareRow.hidden = false; $('mpShare').hidden = false; $('mpShare').onclick = () => share(code);
    l.onStatus = s => { if (link === l && !l.open && !l.everOpen) setSt(`Your match code: <b>${code}</b><br>${s}`); };
    hostSetup(l); wire(l); l.start();
  };
  $('mpJoin').onclick = () => {
    const code = codeIn.value.trim().toUpperCase(); if (!/^[A-Z]{4}$/.test(code)) { setSt('Enter the enemy\'s four-letter code.'); codeIn.focus(); return; }
    reset(); const l = link = new Link('guest', code); l.myHero = A.selectedHero; busy(true);
    setSt(`Joining <b>${code}</b>…`); shareRow.hidden = false; $('mpShare').hidden = true; // only CANCEL while looking for the host
    l.onStatus = s => { if (link === l && !l.open && !l.everOpen) setSt(`Match <b>${code}</b>: ${s}`); };
    guestSetup(l, A.selectedHero); wire(l);
    l.start();
  };
  $('mpLeave').onclick = $('mpCancel').onclick = () => { reset(); setSt(''); }; // waiting with nobody coming: back to the menu
  $('mpReady').onclick = () => { S.ready = !S.ready; push(true); render(); };
  codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') $('mpJoin').click(); e.stopPropagation(); });
  // an invite link (…#join=ABCD) joins straight away
  const inv = /join=([A-Za-z]{4})/.exec(location.hash);
  if (inv) { codeIn.value = inv[1].toUpperCase(); setTimeout(() => $('mpJoin').click(), 300); }
  // end screen: REMATCH button, anything else back to the lobby
  window.__mpOverTap = (l, p) => {
    const g = A.game; if (g.overT < 2.2) return; // game.js OVER_TAP
    if (l.gone || l.closed || (!l.open && !l.down)) { g.net = null; A.backToMenu(); reset(); setSt('The enemy left.'); return; }
    const b = rematchBtn(); if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) { S.rematch = !S.rematch; push(true); return; }
    S.rematch = false; S.ready = false; g.net = null; A.backToMenu(); A.menu.scrollTop = A.menu.scrollHeight; showLobby(); push(true);
  };
}
ui();
function rematchBtn() { const r = cv.getBoundingClientRect(), W = r.width, H = r.height; return { x: W * 0.22, y: H * 0.72, w: W * 0.56, h: H * 0.065 }; }

// HUD: connection line during multiplayer matches (ping coloured green/yellow/red), reconnect countdown, rematch button
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const pingCol = ms => ms < 90 ? '#8fffb0' : ms < 180 ? '#ffe06b' : '#ff7a7a';
function hud() {
  const g = A.game;
  if (g && g.net) {
    const l = g.net, W = cv.width, H = cv.height, f = Math.round(W * 0.03);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.font = `bold ${f}px "Trebuchet MS", system-ui, sans-serif`; ctx.textAlign = 'left';
    let parts;
    if (l.open) parts = [[`${l.mode === 'webrtc' ? 'P2P' : 'Room'} · `, '#e8e8f4'], [`${Math.round(l.rtt)} ms`, pingCol(l.rtt)]].concat(l.mode === 'relay' && l.why ? [[' · ' + l.why, '#e8e8f4']] : []);
    else if (l.down) { const left = Math.max(0, Math.ceil(RECONNECT_S - (performance.now() - l.downAt) / 1000));
      parts = [[l.role === 'host' ? `Enemy offline, bot playing · ${left}s` : `Reconnecting… ${left}s`, '#ffb0b0']]; }
    else parts = [[l.status, '#ffb0b0']];
    const tw = parts.reduce((a, [t]) => a + ctx.measureText(t).width, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(W * 0.02, H * 0.165, tw + f, f * 1.5);
    let x = W * 0.02 + f / 2; for (const [t, c] of parts) { ctx.fillStyle = c; ctx.fillText(t, x, H * 0.165 + f * 1.1); x += ctx.measureText(t).width; }
    if (g.netNote && g.state === 'over') { ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText(g.netNote, W / 2, H * 0.68); }
    if (g.state === 'over' && g.overT > 2.2) {
      const k = W / cv.getBoundingClientRect().width, b = rematchBtn(), p = S.peer, peerWants = p.rematch && p.where === 'over';
      const gone = l.gone || l.closed || (!l.open && !l.down);
      const label = gone ? 'ENEMY LEFT' : S.rematch ? (peerWants ? 'STARTING…' : 'WAITING FOR ENEMY…') : peerWants ? 'REMATCH (ENEMY WANTS ONE)' : 'REMATCH';
      ctx.globalAlpha = gone ? 0.5 : 1; ctx.fillStyle = S.rematch ? '#2fae5b' : '#3a6cff';
      const bx = b.x * k, by = b.y * k, bw = b.w * k, bh = b.h * k, r = bh * 0.3;
      ctx.beginPath(); ctx.moveTo(bx + r, by); ctx.arcTo(bx + bw, by, bx + bw, by + bh, r); ctx.arcTo(bx + bw, by + bh, bx, by + bh, r); ctx.arcTo(bx, by + bh, bx, by, r); ctx.arcTo(bx, by, bx + bw, by, r); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = `bold ${Math.round(bh * 0.36)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillText(label, bx + bw / 2, by + bh * 0.63);
      ctx.font = `${Math.round(f * 0.9)}px "Trebuchet MS", system-ui, sans-serif`; ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillText(gone ? 'Tap to go to the menu' : 'Tap anywhere else for the lobby', W / 2, by + bh + f * 1.6);
    }
    ctx.restore();
  }
  requestAnimationFrame(hud);
}
requestAnimationFrame(hud);
window.ABC2Net = { Link, S, get link() { return link; } };
})();
