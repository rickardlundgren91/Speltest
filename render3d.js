// ---------- 3D view (three.js) ----------
// Draws each map as its MapDefinition lays it out (MapDefinition.MapVisuals/MapProps: ground tiles, cliffs and edges,
// bushes, props), with the map's own terrain overlay texture and its beach/forest/lava theme, plus the real tower
// model. Data comes from models3d.js. The camera is orthographic and tilted so that a ground point lands on exactly
// the same pixel as wx()/wy(), so units, HP bars, effects and HUD keep being drawn by the 2D code on top.
// Menu "Graphics" switches back to the old 2D drawing; nothing in the game logic depends on this file.
window.R3D = (() => {
  const MD = window.MODELS3D, THREE = window.THREE;
  const api = { ready: false };
  let K = {}; // constants and live values handed over by game.js (it runs in its own closure)
  if (!MD || !THREE) return api;
  let renderer, scene, camera, cv3, fxRenderer = null, fxScene, cv4, world = null, builtFor = null, towers = [], bushes = [], timed = [];
  const TEX = {};
  const SHOW_FLOWERS = false; // flower tiles (tile_*_flower_*) left out on Rickard's call; set true to bring them back
  const tex = (k, repeat) => { if (TEX[k]) return TEX[k]; const t = new THREE.TextureLoader().load(MD.tex[k]); if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping; return TEX[k] = t; };

  function init() {
    cv3 = document.getElementById('c3');
    try { renderer = new THREE.WebGLRenderer({ canvas: cv3, antialias: true }); } catch (e) { return false; }
    // attack and special effects go on their own transparent canvas above the 2D layer, so hero tokens and HP bars don't hide them
    cv4 = document.getElementById('c4'); fxScene = new THREE.Scene();
    try { if (cv4) { fxRenderer = new THREE.WebGLRenderer({ canvas: cv4, antialias: true, alpha: true }); fxRenderer.outputColorSpace = THREE.LinearSRGBColorSpace; fxRenderer.setClearColor(0x000000, 0); } } catch (e) { fxRenderer = null; }
    THREE.ColorManagement.enabled = false; // Unity gamma workflow: textures and colours go through as-is
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.useLegacyLights = true;
    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9a7f8f, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55); sun.position.set(-3, 8, 4); scene.add(sun);
    return true;
  }

  // --- theme look (DansMoba shaders approximated): ground base texture and water colours per theme ---
  const THEMES = {
    village: { base: 'tx_water_terrain_beach', scale: 0.125, tint: [1, 1, 1], water: ['#3f86a3', '#4a97ad', 'tx_water_mask_beach', 0.16], sky: '#4f9fb2' },
    city: { base: 'tx_city_terrain', scale: 0.5, tint: [0.676, 0.925, 0.908], water: ['#2f7f95', '#3c93a6', 'tx_water_mask_beach', 0.14], sky: '#3f8ea2' },
    volcano: { base: 'tx_volcano_terrain_detail01', scale: 0.1, tint: [1, 1, 1], water: ['#5a1424', '#7a1f2c', 'tx_water_mask_lava', 0.22], line: [1.0, 0.5, 0.28], sky: '#4a1220' },
  };
  const worldPos = 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }';
  function groundMat(th, mp) {
    const L = new THREE.TextureLoader(), b = mp.bounds;
    return new THREE.ShaderMaterial({
      uniforms: { base: { value: tex(th.base, true) }, ov: { value: L.load(mp.ovRGB) }, oa: { value: L.load(mp.ovA) }, scale: { value: th.scale }, tint: { value: new THREE.Vector3(...th.tint) },
        off: { value: new THREE.Vector2(mp.offset[0], mp.offset[1]) }, b0: { value: new THREE.Vector2(b[0], b[1]) }, bs: { value: new THREE.Vector2(b[2] - b[0], b[3] - b[1]) } },
      vertexShader: worldPos,
      // vW is three.js space: Unity x = vW.x + off.x, Unity z = -vW.z + off.y. The overlay (moss, shade under bushes) spans the map's visual bounds
      fragmentShader: 'uniform sampler2D base; uniform sampler2D ov; uniform sampler2D oa; uniform float scale; uniform vec3 tint; uniform vec2 off; uniform vec2 b0; uniform vec2 bs; varying vec3 vW;' +
        'void main(){ vec2 p = vec2(vW.x + off.x, -vW.z + off.y); vec3 c = texture2D(base, p * scale).rgb * tint;' +
        ' vec2 uv = (p - b0) / bs; float a = texture2D(oa, uv).r; c = mix(c, texture2D(ov, uv).rgb, a * 0.85); gl_FragColor = vec4(c, 1.0); }',
    });
  }
  function waterMat(th) {
    const w = th.water;
    return new THREE.ShaderMaterial({
      uniforms: { mask: { value: tex(w[2], true) }, t: { value: 0 }, deep: { value: new THREE.Color(w[0]) }, base: { value: new THREE.Color(w[1]) }, k: { value: w[3] }, line: { value: new THREE.Vector3(...(th.line || [1, 1, 1])) } },
      vertexShader: worldPos,
      fragmentShader: 'uniform sampler2D mask; uniform float t; uniform vec3 base; uniform vec3 deep; uniform float k; uniform vec3 line; varying vec3 vW;' +
        'void main(){ vec2 q = vW.xz; float m = texture2D(mask, q / 7.0 + vec2(t * 0.012, t * 0.006)).r;' +
        ' float m2 = texture2D(mask, q / 11.0 - vec2(t * 0.008, 0.0)).r; vec3 c = mix(deep, base, 0.5 + 0.5 * sin(q.x * 0.15 + q.y * 0.1));' +
        ' gl_FragColor = vec4(c + line * (k * m + k * 0.4 * m2), 1.0); }',
    });
  }
  function lavaMat() {
    return new THREE.ShaderMaterial({
      uniforms: { d: { value: tex('tx_volcano_lava_detail', true) }, t: { value: 0 } }, vertexShader: worldPos,
      fragmentShader: 'uniform sampler2D d; uniform float t; varying vec3 vW; void main(){ float m = texture2D(d, vW.xz * 0.25 + vec2(0.0, t * 0.03)).r;' +
        ' gl_FragColor = vec4(mix(vec3(0.82, 0.18, 0.02), vec3(1.0, 0.72, 0.25), m), 1.0); }',
    });
  }
  function material(name, th, mp, team) {
    const s = MD.mats[name]; if (!s || s.t === 'skip') return null;
    if (s.t === 'ground') return groundMat(th, mp);
    if (s.t === 'lava') { const m = lavaMat(); timed.push(m); return m; }
    if (s.t === 'grass') return new THREE.MeshLambertMaterial({ map: tex(s.map), alphaTest: 0.5, emissive: 0x16302a, emissiveIntensity: 0.5, side: THREE.DoubleSide }); // alpha-clipped like mat_village_leaves_alphaClip: flower cards are cut-outs
    if (s.t === 'platform') return new THREE.MeshBasicMaterial({ map: tex('tx_world_lava_rocks', true), color: new THREE.Color(th === THEMES.volcano ? '#8c5a74' : '#d6a3a8'), side: THREE.DoubleSide });
    if (s.t === 'team') return new THREE.MeshLambertMaterial({ map: tex(team === 'enemy' ? 'tx_tower_legacy_enemy' : 'tx_tower_legacy_ally') });
    if (s.t === 'minion') return new THREE.MeshLambertMaterial({ map: tex(team === 'enemy' ? s.enemy : s.ally), emissive: 0x000000 });
    if (s.t === 'basic') return new THREE.MeshBasicMaterial({ map: tex(s.map, true) });
    return new THREE.MeshLambertMaterial({ map: tex(s.map, true), side: THREE.DoubleSide });
  }

  // --- geometry baking: prefab nodes and placements are in Unity space (left-handed); three.js gets z flipped ---
  const decoded = {};
  const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  function meshData(key) {
    if (decoded[key]) return decoded[key];
    const m = MD.meshes[key], f32 = s => new Float32Array(bytes(s).buffer);
    return decoded[key] = { v: f32(m.v), n: m.n ? f32(m.n) : null, uv: m.uv ? f32(m.uv) : null,
      sub: m.sub.map(s => m.big ? new Uint32Array(bytes(s).buffer) : new Uint16Array(bytes(s).buffer)) };
  }
  class Acc { // per-material vertex buffers merged into one mesh
    constructor() { this.p = []; this.n = []; this.uv = []; this.i = []; }
    mesh(mat) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2)); g.setIndex(this.i); return new THREE.Mesh(g, mat);
    }
  }
  const U = new THREE.Matrix4(), NM = new THREE.Matrix3(), V = new THREE.Vector3(), N = new THREE.Vector3();
  function bake(prefab, place, accs, filter, nodeFilter) {
    for (const node of MD.prefabs[prefab] || []) {
      if (nodeFilter && !nodeFilter(node.name)) continue;
      U.fromArray(node.m).premultiply(place); NM.getNormalMatrix(U);
      const d = meshData(node.mesh), flip = U.determinant() > 0; // the z mirror flips winding back unless the node already mirrors
      d.sub.forEach((idx, si) => {
        const mat = node.mats[si] || node.mats[0]; if (!mat || (filter && !filter(mat))) return;
        const a = accs[mat] || (accs[mat] = new Acc()), base = a.p.length / 3, used = new Map();
        const add = vi => {
          if (used.has(vi)) return used.get(vi);
          V.set(d.v[vi * 3], d.v[vi * 3 + 1], d.v[vi * 3 + 2]).applyMatrix4(U); a.p.push(V.x, V.y, -V.z);
          if (d.n) { N.set(d.n[vi * 3], d.n[vi * 3 + 1], d.n[vi * 3 + 2]).applyMatrix3(NM).normalize(); a.n.push(N.x, N.y, -N.z); } else a.n.push(0, 1, 0);
          if (d.uv) a.uv.push(d.uv[vi * 2], d.uv[vi * 2 + 1]); else a.uv.push(0, 0);
          const k = base + used.size; used.set(vi, k); return k;
        };
        for (let t = 0; t < idx.length; t += 3) { const i0 = add(idx[t]), i1 = add(idx[t + 1]), i2 = add(idx[t + 2]); if (flip) a.i.push(i0, i2, i1); else a.i.push(i0, i1, i2); }
      });
    }
  }

  // --- minions: Melee/Range/SiegeMinionPawn meshes in their rest pose (no animation yet), one copy per live minion ---
  const minionGeo = {}, minions = new Map();
  function minionObj(u) {
    const team = u.team === K.PLAYER_TEAM ? 'ally' : 'enemy';
    const geo = minionGeo[u.type] || (minionGeo[u.type] = (() => { const a = {}; bake(u.type, new THREE.Matrix4(), a); return Object.keys(a).map(k => [k, a[k].mesh(null).geometry]); })());
    const grp = new THREE.Group();
    for (const [k, gm] of geo) grp.add(new THREE.Mesh(gm, material(k, null, null, team))); // own material per minion so hit flashes stay on that minion
    scene.add(grp); return grp;
  }
  // --- heroes: Rickard's Meshy figures (heroes3d.js), static like the minions; heroes without a figure keep their 2D portrait ---
  const HERO_FIGURES = { Angler: 'lotusFrog', Frog: 'neonVanguard', Barbarian: 'crystalWingGuardian', Sorcerer: 'nebulon', Brawler: 'minotaur', Marksman: 'cyberBlaze', Thief: 'voidblade', Paladin: 'crystalVanguard', Banshee: 'neonRogue', Kunoichi: 'emberbladeSentinel', Archer: 'neonSentinel', Automaton: 'donus', Witch: 'grannyGroveRide', Joker: 'titanForge' }; // hero code -> figure in heroes3d.js
  const H3 = window.HEROES3D, heroGeo = {}, heroObjs = new Map(), heroTex = {}, wilts = [];
  api.hasHero = code => !!(H3 && HERO_FIGURES[code]);
  const afoot = u => u.code === 'Witch' && u.witchSaved && H3 && H3.figs.grannyGrove; // Ginette has used her passive this life: she jumped off her plant
  const figOf = u => afoot(u) ? 'grannyGrove' : HERO_FIGURES[u.code], animOf = u => afoot(u) ? HERO_ANIM.WitchAfoot : HERO_ANIM[u.code];
  // --- limb rig: the Meshy figures have no skeleton, so legs and arms are found from the rest pose (figure heights, x centred on cx):
  // below the crotch, split left/right = legs; outside the torso half-width between armLo and the shoulder = arms. The vertex shader swings
  // each leg about the hip line and each arm about its shoulder (forward/back), after first lowering T-posed arms by drop (rad).
  // off: 'L'/'R' keeps that arm still (it holds a separate weapon). back: legs only in front of this z (hair/capes stay put). armLo [left, right] per side.
  // legX: legs only within this half-width of cx, or [left, right] (a blade or hammer hanging beside them stays put). stride: hip swing (rad). knee: how far the knee folds
  // on the swing (rad; low for long robes, which would crease). The step length follows from leg length and stride, so feet don't skate.
  // carry: 'L'/'R' that arm doesn't swing while walking (it carries something heavy, like Pearl's hammer).
  // elbow: height of the elbows (hanging arms only); the forearm then folds there (Bronson's boxing guard and punches).
  // armOut: below the crotch only what lies further out than this is arm (Silver's arm cannon hangs beside his leg).
  // head: [neck height, half-width, pivot depth]: everything above the neck within that width nods about the neck (Bronson tucks his chin, drops his horns).
  const HERO_RIG = {
    wolfblade: { cx: 0.05, crotch: 0.15, sh: 0.23, torso: 0.1, armLo: 0, back: -0.03, legX: 0.085, stride: 0.6, knee: 1.1, sword: [-0.06, 0.05] }, // Peter: short legs under the big sword
    // sword: [x, z] of the blade's axis. The whole sword (blade, guard, the hilt hidden inside his head, pommel, his gloves on the grip) goes on the
    // arm channel and swings about the grip (sh = grip height), so he chops with the sword instead of folding his body in half
    crystalWingGuardian: { crotch: 0.16, sh: 0.43, torso: 0.1, armLo: 0.26, legX: 0.15, stride: 0.55, knee: 1 }, // Peter (2026-10-10 model, sword exported beside him): A-posed arms, fists at |x| 0.32, y 0.35
    neonVanguard: { crotch: 0.47, sh: 0.78, torso: 0.1, armRamp: 0.02, armLo: 0.42, armOut: 0.135, stride: 0.45 }, // Valtori: arms hang close to the jacket, fists beside the hips (y 0.45-0.5)
    lotusFrog: { crotch: 0.25, sh: 0.62, torso: 0.33, armLo: 0.1, stride: 0.35 },
    nebulon: { crotch: 0.35, sh: 0.62, torso: 0.115, armRamp: 0.012, armOut: 0.16, armLo: 0.08, stride: 0.3, knee: 0.35 }, // arms are rods with floating hands at |x| 0.13-0.27, robe inside 0.10 (hem out to 0.14 below the hips)
    minotaur: { crotch: 0.38, sh: 0.72, torso: 0.185, armLo: 0, legX: 0.175, elbow: 0.42, head: [0.6, 0.2, 0.04] }, // Bronson: the fists hang beside the knees, so they belong to the arms, not the legs
    cyberBlaze: { cx: -0.04, crotch: 0.4, sh: 0.7, torso: 0.09, armLo: [0.1, 0.28], legX: [0.17, 0.165], armOut: [0.135, 0.105] }, // the arm cannon hangs to the knee: it is arm, not leg
    voidblade: { crotch: 0.35, sh: 0.7, torso: 0.15, armLo: 0.3 },
    crystalVanguard: { crotch: 0.4, sh: 0.72, torso: 0.13, armLo: [0.3, 0.0], legX: [0.15, 0.095], stride: 0.38, knee: 0.75, carry: 'R' }, // the hammer head by her right foot stays out of the leg; she carries it still
    neonRogue: { crotch: 0, sh: 0.75, torso: 0.12, armRamp: 0.02, armLo: 0.43, drop: 0.9 }, // rides the board: arms only; hands hang out at |x| 0.3-0.38, y 0.46-0.5 (armLo was above them, so they stayed put while the arm dropped)
    neonSentinel: { crotch: 0.45, sh: 0.63, torso: 0.08, armRamp: 0.02, armLo: 0.33, armOut: 0.15, elbow: 0.53 }, // Aery: shoulders at 0.63, fists at |x| 0.17-0.24, y 0.40-0.50, beside the hips (|x| < 0.13); the left fist holds the bow, the right one draws the string (poseBow)
    donus: { crotch: 0.42, sh: 0.75, torso: 0.15, armLo: 0.35, back: -0.12, stride: 0.3 },
    grannyGroveRide: { crotch: 0.3, sh: 0, torso: 0.2, armLo: 0.3, stride: 0.4 }, // Ginette on her plant (Rickard's Meshy model The Granny Grove Ride): the root legs walk, she sits on top
    grannyGrove: { crotch: 0.42, sh: 0.72, torso: 0.11, armLo: 0.28, stride: 0.35, knee: 0.5 }, // Ginette on foot after her passive (the same export, cut off beside the ride)
    titanForge: { crotch: 0.4, sh: 0.78, torso: 0.17, armLo: 0.3, off: 'L' },
    emberbladeSentinel: { crotch: 0.45, sh: 0.72, torso: 0.12, armLo: 0.45, stride: 0.45 }, // Momiji: A-posed arms, hands out at |x| 0.2-0.3, y 0.5-0.6; the left hand holds the glaive (held.arm: it rides on that arm)
  };
  function limbWeights(P, R, s) { // per vertex [leg, arm], sign = side (+x = the figure's left), size = weight
    const n = P.length / 3, w = new Float32Array(n * 2), sm = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t), cx = R.cx || 0;
    for (let i = 0; i < n; i++) {
      const x = P[i * 3] / s - cx, y = P[i * 3 + 1] / s, z = P[i * 3 + 2] / s, ax = Math.abs(x), sd = x < 0 ? -1 : 1;
      const lo = Array.isArray(R.armLo) ? R.armLo[sd > 0 ? 0 : 1] : R.armLo, off = R.off === (sd > 0 ? 'L' : 'R');
      const a = R.sh && !R.sword ? sm((ax - R.torso) / (R.armRamp || 0.05)) * sm((y - lo) / 0.06) * sm((R.sh + 0.1 - y) / 0.06) * (R.armOut && y < R.crotch + 0.04 ? sm((ax - (Array.isArray(R.armOut) ? R.armOut[sd > 0 ? 0 : 1] : R.armOut)) / 0.02) : 1) : 0;
      const l = R.crotch ? sm((R.crotch + 0.04 - y) / 0.1) * sm(ax / 0.04) * (1 - a) * (R.back !== undefined ? sm((z - R.back) / 0.06) : 1) * (R.legX ? sm(((Array.isArray(R.legX) ? R.legX[sd > 0 ? 0 : 1] : R.legX) - ax) / 0.02) : 1) : 0;
      w[i * 2] = sd * l; w[i * 2 + 1] = off ? 0 : sd * a;
      if (R.sword) { const X = P[i * 3] / s, d = Math.hypot(X - R.sword[0], z - R.sword[1]);
        const k = Math.max(sm((y - 0.47) / 0.05), // blade and guard above his head
          sm((0.05 - d) / 0.015) * sm((y - R.sh + 0.05) / 0.03), // the hilt (inside his head) and the gloves on the grip
          sm((-0.075 - X) / 0.01) * sm((0.2 - y) / 0.02)); // pommel spike below his hands
        w[i * 2 + 1] = k; w[i * 2] *= 1 - k; }
    }
    let kz = 0, kn = 0; for (let i = 0; i < n; i++) if (Math.abs(w[i * 2]) > 0.5 && Math.abs(P[i * 3 + 1] / s - R.crotch * 0.5) < 0.04) { kz += P[i * 3 + 2]; kn++; }
    R.kz = kn ? kz / kn : 0; // knee pivot depth (world units), so a folding shin stays on its own leg
    let ez = 0, en = 0; if (R.elbow) for (let i = 0; i < n; i++) if (Math.abs(w[i * 2 + 1]) > 0.5 && Math.abs(P[i * 3 + 1] / s - R.elbow) < 0.04) { ez += P[i * 3 + 2]; en++; }
    R.ez = en ? ez / en : 0;
    R.hand = [1, -1].map(sd => { let y0 = 1e9; for (let i = 0; i < n; i++) if (w[i * 2 + 1] * sd > 0.9) y0 = Math.min(y0, P[i * 3 + 1]); // rest fist centre per side (world units), for things held in the hand
      const c = [0, 0, 0]; let k = 0; for (let i = 0; i < n; i++) if (w[i * 2 + 1] * sd > 0.9 && P[i * 3 + 1] < y0 + 0.05 * s) { c[0] += P[i * 3]; c[1] += P[i * 3 + 1]; c[2] += P[i * 3 + 2]; k++; }
      return k ? c.map(v => v / k) : null; });
    return w;
  }
  function heroGeometry(f) {
    if (heroGeo[f]) return heroGeo[f];
    const d = H3.figs[f], g = new THREE.BufferGeometry(), raw = s => bytes(s).buffer;
    const q = new Uint16Array(raw(d.p)), pos = new Float32Array(q.length), s = d.h * 1.8; // d.h * 1.8 tiles tall
    for (let i = 0; i < q.length; i++) { const k = i % 3; pos[i] = (d.lo[k] + q[i] / 65535 * (d.hi[k] - d.lo[k])) * s; }
    const n8 = new Int8Array(raw(d.n)), nor = Float32Array.from(n8, v => v / 127), uq = new Uint16Array(raw(d.uv)), uv = Float32Array.from(uq, v => v / 65535);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aLimb', new THREE.BufferAttribute(HERO_RIG[f] ? limbWeights(pos, HERO_RIG[f], s) : new Float32Array(pos.length / 3 * 2), 2));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(raw(d.t)), 1)); return heroGeo[f] = g;
  }
  // --- procedural hero animation: the Meshy OBJs have no skeleton, so the whole figure is posed (bob, waddle, lean, spin, fall)
  // and a bend deformer in the vertex shader folds everything above the hips forward/back (swings a sword, throws a punch, rears back to cast).
  // hip/soft are fractions of the figure's height. walk = [step rate, bob, rock, lean]. An autoattack is timed on the attack clock:
  // wind up while the next hit charges (windupT), whip through over slashT so it peaks at contact, follow through and recover (recoverT).
  // Contact (lead) is when the shot actually leaves, from the data: spawnDelay after the attack starts, plus the short travel of a melee slash.
  // size scales the figure so the slim ones read as big as the rest of the cast (all figures are normalised to the same height).
  // Pose keys are [bend, twist, pitch, lunge] in rad / tiles. cast = pose held while the hero has 'casting' (their special).
  // arc = colour of the crescent where a blade sweeps (null: none). Add a hero here once it has a figure in HERO_FIGURES.
  const HERO_ANIM = {
    Barbarian: { size: 0.8, hip: 0.2, soft: 0.2, walk: [6.5, 0.08, 0.07, 0.1], windupT: 0.45, slashT: 0.1, recoverT: 0.45, arc: 0xeafff6, spin: 14, spinBend: 0, spinSword: 0.1, spinRoll: 1.4, spinPivot: 0.45, // whirlwind (Rickard's reference GIF): he tips over onto his side in mid-air and spins like a blade, sword straight out
      // Peter: heaves the sword back over his shoulder, then chops it down in front of him (the sword is its own mesh in his right fist, posed by poseHeld)
      keys: { windup: [-0.18, 0.55, -0.06, -0.05], impact: [0.3, -0.25, 0.1, 0.2], follow: [0.36, -0.5, 0.12, 0.24] },
      // hand: the sword rides that fist (at = its rest centre in figure heights) and the arm swings with it, so it never leaves his hand.
      // Hand keys are [arm swing, sword pitch on top of the arm, twist about the blade, tilt out]; spin = the pose in the whirlwind (he spins on his side, the sword sticks straight out in front)
      held: { fig: 'crystalWingGuardianSword', scale: 2.4, grip: 0.15, hand: 'R', at: [-0.319, 0.347, 0.03], order: 'XYZ', rest: [0, -0.3, 0.35, 0.12],
        keys: { windup: [-2.4, 0.2, 1.4, 0], impact: [-0.9, 2.65, 1.4, 0], follow: [-0.6, 2.25, 1.4, 0] }, spin: [-1.57, 3.14, 0, 0] } },
    Brawler: { hip: 0.35, soft: 0.2, walk: [5.5, 0.06, 0.14, 0.1], windupT: 0.18, slashT: 0.05, recoverT: 0.28, arc: null, box: true, // boxer: jab, jab, cross; Bulldoze charges head down
      keys: { windup: [-0.08, 0.35, -0.04, -0.03], impact: [0.18, -0.45, 0.1, 0.22], follow: [0.2, -0.55, 0.1, 0.24] }, cast: [0.6, 0, 0.12, 0.15], charge: [0.3, 0, 0.3, 0] },
    Thief: { hip: 0.45, soft: 0.15, walk: [7.5, 0.06, 0.1, 0.18], windupT: 0.28, slashT: 0.06, recoverT: 0.3, arc: 0xd2a6ff, // quick dagger slash, crouches while invisible
      keys: { windup: [-0.2, 0.95, 0, -0.04], impact: [0.45, -0.6, 0.1, 0.26], follow: [0.5, -1.1, 0.12, 0.28] }, sneak: [0.35, 0, 0.18, 0] },
    Sorcerer: { hip: 0.4, soft: 0.25, walk: [5, 0.03, 0.05, 0.06], windupT: 0.4, slashT: 0.1, recoverT: 0.4, arc: null, bothArms: 1.8, // rears back and thrusts the spell out; arms up for the rift
      keys: { windup: [-0.35, 0.2, -0.1, -0.04], impact: [0.4, -0.1, 0.1, 0.1], follow: [0.3, -0.15, 0.08, 0.08] }, cast: [-0.45, 0, -0.15, 0] },
    Marksman: { size: 1.12, hip: 0.45, soft: 0.2, walk: [7, 0.07, 0.1, 0.1], windupT: 0.4, slashT: 0.06, recoverT: 0.5, arc: null, // brings the cannon up and leans in to aim, then the gun kicks back; braces for the laser
      keys: { windup: [0.16, -0.3, 0.04, 0.06], impact: [-0.06, -0.22, -0.05, -0.06], follow: [0.02, -0.15, 0, -0.03] }, cast: [-0.1, 0.1, -0.04, -0.04], gun: 'L' },
    Angler: { hip: 0.3, soft: 0.25, walk: [4, 0.16, 0.06, 0.08], windupT: 0.32, slashT: 0.07, recoverT: 0.32, arc: null, hop: true, // hops; rears back and lashes the tongue out
      keys: { windup: [-0.3, 0.1, -0.08, -0.04], impact: [0.45, -0.05, 0.12, 0.15], follow: [0.35, 0, 0.1, 0.12] }, cast: [0.55, 0, 0.18, 0.2] },
    Paladin: { size: 1.14, hip: 0.45, soft: 0.2, walk: [6.5, 0.06, 0.1, 0.08], windupT: 0.4, slashT: 0.09, recoverT: 0.4, arc: 0xffe08a, // the hammer hangs below the hips, so the whole body swings it; lifts up for Encore
      keys: { windup: [-0.2, 0.65, -0.14, -0.04], impact: [0.3, -0.3, 0.18, 0.14], follow: [0.34, -0.55, 0.2, 0.16] }, cast: [-0.3, 0, -0.08, 0] }, // softer: a big bend plus pitch toppled her onto the target
    Banshee: { size: 1.12, hip: 0.5, soft: 0.2, walk: [3, 0.01, 0.05, 0.16], board: { fig: 'spiritboard', len: 0.95, lift: 0.14, side: 1.15 }, /* side: he stands across the board like a snowboarder (Rickard's reference), the board still points where he goes */ windupT: 0.25, slashT: 0.06, recoverT: 0.3, arc: null, // Ron: quick sidearm flick that throws the energy bolt; leans into Darkslide
      keys: { windup: [-0.2, 0.7, -0.05, -0.04], impact: [0.35, -0.5, 0.08, 0.16], follow: [0.3, -0.8, 0.08, 0.14] }, cast: [0.4, 0, 0.15, 0.12] },
    Archer: { size: 1.25, hip: 0.5, soft: 0.2, walk: [7, 0.06, 0.1, 0.1], windupT: 0.5, slashT: 0.05, recoverT: 0.55, arc: null, // Aery: turns her bow side to the target, draws, looses (bow animated by poseBow)
      keys: { windup: [-0.04, -1.15, -0.03, -0.02], impact: [-0.04, -1.2, -0.05, -0.03], follow: [0, -1.15, -0.08, -0.05] }, cast: [-0.05, -1.15, -0.05, 0], // stands side-on, left shoulder to the target
      bow: { fig: 'neonSentinelBow', scale: 0.85, string: 0xdffcff, arrow: 0x7ff6ff, magic: 0xfff2b0,
        rest: [0.25, 0.45, 0.1, 0.12, 0, -0.14], aim: [-0.05, 0.66, 0.31, 0, 0, 0.18], nock0: 0.05, draw: 0.2 } }, // rest/aim [x, y, z, rotX, rotY, rotZ] in figure heights, aim in the target's frame (the bow sits in her left fist, so only its rotation is used at rest); nock0 + draw: how far behind the grip her right hand holds the string, undrawn and at full draw
    Automaton: { hip: 0.45, soft: 0.2, walk: [5.5, 0.04, 0.06, 0.07], windupT: 0.38, slashT: 0.08, recoverT: 0.38, arc: null, // Donus: draws the charge in, then flings the bolt forward; rises with arms high for Chain Reaction
      keys: { windup: [-0.3, 0.35, -0.08, -0.03], impact: [0.4, -0.2, 0.1, 0.12], follow: [0.3, -0.3, 0.08, 0.1] }, cast: [-0.4, 0, -0.12, 0] },
    Witch: { size: 1.4, hip: 0.55, soft: 0.2, walk: [5, 0.06, 0.1, 0.06], windupT: 0.38, slashT: 0.08, recoverT: 0.38, arc: null, // Ginette: the rider rears back and flings the spell from her plant mount; arms up to channel Bramble Blossom
      keys: { windup: [-0.25, 0.3, -0.05, -0.03], impact: [0.35, -0.2, 0.08, 0.1], follow: [0.25, -0.3, 0.06, 0.08] }, cast: [-0.35, 0, -0.1, 0] },
    WitchAfoot: { hip: 0.5, soft: 0.2, walk: [6.5, 0.05, 0.08, 0.06], windupT: 0.38, slashT: 0.08, recoverT: 0.38, arc: null, // Ginette after her passive: the plant is gone, she walks and casts on her own feet
      keys: { windup: [-0.2, 0.3, -0.05, -0.03], impact: [0.3, -0.2, 0.08, 0.1], follow: [0.22, -0.3, 0.06, 0.08] }, cast: [-0.3, 0, -0.08, 0] },
    Kunoichi: { size: 1.2, hip: 0.45, soft: 0.2, walk: [7.5, 0.06, 0.1, 0.14], windupT: 0.3, slashT: 0.06, recoverT: 0.35, arc: 0xff9fd0, // Momiji (Rickard's Meshy model, glaive separate): whirls her double glaive and flings the petals off it
      keys: { windup: [-0.15, 0.55, -0.05, -0.03], impact: [0.2, -0.45, 0.06, 0.12], follow: [0.24, -0.55, 0.08, 0.14] },
      strikeArm: 'L', strikeAmp: 1.7, idleSway: 0.035, // the glaive hand (left) draws back and slashes through; at rest she shifts her weight from foot to foot
      held: { fig: 'emberbladeSentinelBlade', scale: 0.9, rest: [0.245, 0.5, 0.02, 0.1, 1.57, 0], spinT: 9, arm: true, idleTwirl: 4.5, // [x, y, z, rotX, rotY, rotZ] of the grip in figure heights; at rest turned edge-on (rotY) so the blades point fore and aft along her side instead of out sideways; spinT: the glaive twirls about its handle through the swing
        // arm: the glaive rides on her left arm (swings with it walking and slashing) instead of following keys; idleTwirl: standing still she spins it in her hand every few seconds
        keys: { windup: [0.22, 0.78, -0.08, -0.7, 0, 0.35], impact: [0.1, 0.62, 0.32, 1.45, 0, 0.1], follow: [0.08, 0.55, 0.32, 1.65, 0, 0.05] } } },
    Frog: { size: 1.12, hip: 0.5, soft: 0.2, walk: [7, 0.06, 0.1, 0.1], windupT: 0.3, slashT: 0.06, recoverT: 0.35, arc: null, leap: 4, // Valtori: sidearm throw; Illustrious Leap takes him up out of the fight (leap = height in tiles)
      keys: { windup: [-0.2, 0.6, -0.05, -0.04], impact: [0.3, -0.45, 0.08, 0.14], follow: [0.25, -0.7, 0.08, 0.12] } },
    Joker: { hip: 0.45, soft: 0.2, walk: [5.5, 0.06, 0.12, 0.08], windupT: 0.45, slashT: 0.1, recoverT: 0.42, arc: null, // ROI17: heaves the hammer over the shoulder and smashes it down in front (hammer animated by poseHeld)
      keys: { windup: [-0.3, 0.25, -0.08, -0.04], impact: [0.4, -0.1, 0.14, 0.2], follow: [0.45, -0.1, 0.16, 0.22] },
      turret: { fig: 'r17GuardianTurret', scale: 1, pods: [[-0.26, 0.4, 0.2], [0.26, 0.4, 0.2]] }, // rocket pods in figure heights (front of each pod)
      held: { fig: 'titanForgeHammer', scale: 0.8, rest: [0.36, 0.487, 0.04, 0, 0, -0.08], // [x, y, z, rotX, rotY, rotZ] of the grip in figure heights
        keys: { windup: [0.2, 0.75, -0.05, -0.5, 0, 0.15], impact: [0.12, 0.5, 0.3, 2.2, 0, 0.05], follow: [0.12, 0.45, 0.32, 2.35, 0, 0.05] } } },
  };
  function bendMaterial(mat, A, h, f) {
    const R = HERO_RIG[f] || {}, U = mat.userData.bend = { uBend: { value: 0 }, uHip: { value: A.hip * h }, uSoft: { value: A.soft * h },
      uLeg: { value: new THREE.Vector2() }, uLift: { value: new THREE.Vector2() }, uKnee: { value: new THREE.Vector4(0, 0, (R.crotch || 0) * 0.5 * h, R.kz || 0) }, uElbow: { value: new THREE.Vector4(0, 0, (R.elbow || 0) * h, R.ez || 0) }, uHead: { value: new THREE.Vector4(0, R.head ? R.head[0] * h : 0, R.head ? R.head[1] * h : 0, R.head ? R.head[2] * h : 0) }, uArm: { value: new THREE.Vector2() }, uSpread: { value: new THREE.Vector2() }, uRig: { value: new THREE.Vector4(((R.crotch || 0) + 0.03) * h, (R.sh || 0) * h, ((R.cx || 0) + (R.torso || 0)) * h, R.drop || 0) }, uCx: { value: (R.cx || 0) * h }, uRim: { value: new THREE.Vector4() }, uDark: { value: 0 } };
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = 'uniform float uBend, uHip, uSoft, uCx;\nuniform vec2 uLeg, uArm, uLift, uSpread;\nuniform vec4 uRig, uKnee, uElbow, uHead;\nattribute vec2 aLimb;\n' +
        'vec3 bendYZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }\n' +
        'vec3 dropZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }\n' +
        // swing a leg about the hip line, an arm about its shoulder (lowered first by drop); pos = 0 rotates a normal only
        'vec3 head(vec3 p, float pos) { if (uHead.x == 0.0) return p; float b = uHead.y * 0.07, w = smoothstep(uHead.y - b, uHead.y + b, position.y) * (1.0 - smoothstep(uHead.z - b, uHead.z + b, abs(position.x - uCx)));\n' +
        '  vec3 hv = vec3(0.0, uHead.y, uHead.w) * pos; return bendYZ(p - hv, uHead.x * w) + hv; }\n' +
        'vec3 limb(vec3 p, float pos) { float l = aLimb.x, a = aLimb.y;\n' +
        '  if (l != 0.0) { vec3 kv = vec3(0.0, uKnee.z, uKnee.w) * pos; p = bendYZ(p - kv, (l > 0.0 ? uKnee.x : uKnee.y) * abs(l) * (1.0 - smoothstep(uKnee.z - 0.03, uKnee.z + 0.03, position.y))) + kv;\n' +
        '    vec3 pv = vec3(0.0, uRig.x, 0.0) * pos; p = bendYZ(p - pv, (l > 0.0 ? uLeg.x : uLeg.y) * abs(l)) + pv; p.y += pos * (l > 0.0 ? uLift.x : uLift.y) * abs(l) * clamp((uRig.x - position.y) / max(uRig.x, 0.001), 0.0, 1.0); }\n' +
        '  if (a != 0.0) { float sd = sign(a); vec3 ev = vec3(0.0, uElbow.z, uElbow.w) * pos; p = bendYZ(p - ev, (a > 0.0 ? uElbow.x : uElbow.y) * abs(a) * (1.0 - smoothstep(uElbow.z - 0.04, uElbow.z + 0.04, position.y))) + ev;\n' +
        '    vec3 pv = vec3(uCx + sd * (uRig.z - uCx), uRig.y, 0.0) * pos; p = bendYZ(dropZ(p - pv, -sd * (uRig.w - (a > 0.0 ? uSpread.x : uSpread.y)) * abs(a)), (a > 0.0 ? uArm.x : uArm.y) * abs(a)) + pv; }\n' +
        '  return p; }\n' + sh.vertexShader
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = limb(head(objectNormal, 0.0), 0.0);\nfloat bendA = uBend * smoothstep(uHip, uHip + uSoft, position.y);\nobjectNormal = bendYZ(objectNormal, bendA);')
      sh.fragmentShader = 'uniform vec4 uRim;\nuniform float uDark;\n' + sh.fragmentShader.replace('#include <dithering_fragment>',
        'gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.04, 0.03, 0.05), uDark);\n' +
        'vec3 rimV = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);\n' +
        'gl_FragColor.rgb += uRim.rgb * uRim.a * pow(1.0 - clamp(abs(dot(normalize(normal), rimV)), 0.0, 1.0), 2.0);\n#include <dithering_fragment>');
      sh.vertexShader = sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = limb(head(transformed, 1.0), 1.0);\ntransformed = bendYZ(transformed - vec3(0.0, uHip, 0.0), bendA) + vec3(0.0, uHip, 0.0);');
    };
    mat.customProgramCacheKey = () => 'heroBendLimbs6';
  }
  function animState(u, o, g) {
    const st = o.userData, now = g.time, dt = Math.min(0.1, Math.max(0, now - (st.t === undefined ? now : st.t))); st.t = now; st.dt = dt;
    if (u.alive && !st.alive) st.spawnT = st.alive === undefined ? -9 : now; // no pop-in on the first frame of a match
    if (!u.alive && st.alive) st.dieT = now;
    st.alive = u.alive; st.dying = !u.alive && now - (st.dieT || -9) < 1.3;
    const step = (u.walkT || 0) - (st.walk === undefined ? u.walkT || 0 : st.walk); st.walk = u.walkT || 0;
    const m0 = st.move || 0; st.move = m0 + ((step > 0.001 ? 1 : 0) - m0) * Math.min(1, dt * 10); // eased 0..1 so stops don't snap
    // momentum: lean into a start, rock back on a stop (low-passed so a guest's choppy updates don't jitter it)
    st.surge = (st.surge || 0) + ((dt > 0 ? (st.move - m0) / dt : 0) - (st.surge || 0)) * Math.min(1, dt * 12);
    const dx = u.x - (st.px === undefined ? u.x : st.px), dy = u.y - (st.py === undefined ? u.y : st.py); st.px = u.x; st.py = u.y;
    if (dx * dx + dy * dy > 1e-6 && dx * dx + dy * dy < 1) st.mdir = Math.atan2(dy, dx); // which way the hero is actually going (a teleport doesn't count)
    return st;
  }
  function swingClock(u, A, st, t, tgt) { // times on the attack clock, measured from contact instead of from the attack's start
    if (A.lead === undefined) { const gd = window.GAMEDATA && GAMEDATA.heroes[u.code], a = (gd && gd.attack) || (u.def && u.def.attack) || {}; A.lead = (a.spawnDelay || 0) + (!a.projSpeed && (a.projTime || 0) <= 0.12 ? a.projTime || 0 : 0); }
    const start = t - (st.hitT || -9), toStart = (u.statCd ? u.statCd() : 1) - u.atkTimer, since = start - A.lead;
    const ci = start < A.lead ? A.lead - start : tgt && toStart > 0 ? toStart + A.lead : 1e9; // until the next contact
    const rec = since >= 0 && since < A.recoverT && !(ci < A.slashT + A.windupT * 0.5) ? since / A.recoverT : -1; // a fast next swing cuts the recovery short
    const ch = rec < 0 && ci < A.windupT + A.slashT ? ci : -1;
    return { start, toStart, since, rec, ch, busy: start < A.lead + A.recoverT };
  }
  function swingTarget(u, g) { // what the next autoattack will hit: the nearest enemy in attack range
    let best = null, bd = 1e9;
    for (const e of g.units) { if (!e.alive || e.team === u.team) continue; const d = Math.hypot(e.x - u.x, e.y - u.y) - (e.r || 0); if (d <= u.range + 0.1 && d < bd) { bd = d; best = e; } }
    return best;
  }
  function trail(o, st, since, A) { // a pale crescent where the blade sweeps, fading right after the hit
    if (!st.arc) {
      const h = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox), r = h.max.y * 0.55;
      st.arc = new THREE.Mesh(new THREE.RingGeometry(r * 0.55, r, 24, 1, Math.PI / 2 - 1.3, 2.6), new THREE.MeshBasicMaterial({ color: A.arc, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      st.arc.rotation.set(Math.PI / 2 - 0.25, 0, 0.35); st.arc.position.set(0, h.max.y * 0.32, h.max.y * 0.12); st.arc.renderOrder = 3; o.add(st.arc);
    }
    const k = since / 0.22; st.arc.visible = k >= 0 && k < 1; if (k < 1) { st.arc.material.opacity = 0.75 * (1 - k); st.arc.rotation.z = 0.35 - 0.9 * k; st.arc.scale.setScalar(0.9 + 0.25 * k); }
  }
  // --- a weapon Rickard exported as its own mesh piece (heroes3d.js figure centred on its grip, with tipT/tipB), held and animated in code ---
  const BOW_STRING = new THREE.CylinderGeometry(1, 1, 1, 4, 1), BOW_SHAFT = new THREE.CylinderGeometry(1, 1, 1, 5, 1).translate(0, 0.5, 0).rotateX(Math.PI / 2), BOW_HEAD = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0).rotateX(Math.PI / 2);
  function heroBow(o, A, tex) {
    const B = A.bow, d = H3.figs[B.fig], s = d.h * 1.8, grp = new THREE.Group(), mats = [];
    const mat = (M, p) => { const m = new M(Object.assign({ transparent: true }, p)); mats.push(m); return m; };
    grp.add(new THREE.Mesh(heroGeometry(B.fig), mat(THREE.MeshLambertMaterial, { map: tex, emissiveMap: tex, emissive: 0x666666 })));
    const sm = mat(THREE.MeshBasicMaterial, { color: B.string }), up = new THREE.Mesh(BOW_STRING, sm), dn = new THREE.Mesh(BOW_STRING, sm);
    const am = mat(THREE.MeshBasicMaterial, { color: B.arrow }), arrow = new THREE.Group(), shaft = new THREE.Mesh(BOW_SHAFT, am), head = new THREE.Mesh(BOW_HEAD, am);
    arrow.add(shaft, head); grp.add(up, dn, arrow); grp.scale.setScalar(B.scale); grp.renderOrder = 2; grp.traverse(c => c.renderOrder = 2); o.add(grp);
    return o.userData.bow = { grp, up, dn, arrow, shaft, head, am, mats, s, tipT: new THREE.Vector3(...d.tipT).multiplyScalar(s), tipB: new THREE.Vector3(...d.tipB).multiplyScalar(s), Y: new THREE.Vector3(0, 1, 0) };
  }
  function stringSeg(m, a, b, r, Y) { const v = b.clone().sub(a), L = v.length(); m.position.copy(a).addScaledVector(v, 0.5); m.quaternion.setFromUnitVectors(Y, v.divideScalar(L)); m.scale.set(r, L, r); }
  // the arm deformer of the vertex shader on the CPU: where a rest point on an arm (weight 1) ends up for the given shoulder swing, spread and elbow fold
  function armAt(R, h, rest, sd, flex, spread, elb) {
    const yz = (p, a) => { const c = Math.cos(a), s = Math.sin(a), y = p.y; p.y = c * y - s * p.z; p.z = s * y + c * p.z; };
    const p = rest.clone(), ev = new THREE.Vector3(0, (R.elbow || 0) * h, R.ez || 0);
    if (R.elbow && rest.y < R.elbow * h) { p.sub(ev); yz(p, elb); p.add(ev); }
    const pv = new THREE.Vector3((R.cx || 0) * h + sd * R.torso * h, R.sh * h, 0); p.sub(pv);
    const a = -sd * ((R.drop || 0) - spread), c = Math.cos(a), s = Math.sin(a), x = p.x; p.x = c * x - s * p.y; p.y = s * x + c * p.y;
    yz(p, flex); return p.add(pv);
  }
  // a few rounds of coordinate descent from last frame's answer: arm angles that put the fist on target, pulled a little toward a natural pose
  function reach(R, h, rest, sd, x, tgt, pref, lo, hi) {
    const cost = q => armAt(R, h, rest, sd, q[0], q[1], q[2] || 0).distanceToSquared(tgt) / (h * h) + 0.002 * q.reduce((s, v, i) => s + (v - pref[i]) ** 2, 0);
    let best = cost(x);
    for (let step = 0.25; step > 0.004; step *= 0.5) for (let i = 0; i < x.length; i++) for (const d of [-step, step]) {
      const q = x.slice(); q[i] = Math.max(lo[i], Math.min(hi[i], q[i] + d)); const c = cost(q); if (c < best) { best = c; x = q; } }
    return x;
  }
  function poseBow(u, o, A, st, g, twist, bend, sinceHit, tgt, toHit, ph) {
    const B = A.bow, W = o.userData.bow, t = g.time, ease = k => k * k * (3 - 2 * k), H = H3.figs[figOf(u)].h * 1.8;
    // draw: ramps up while the next shot charges, reaches full when the arrow leaves (spawnDelay after the attack starts), snaps back with a twang
    const sd = (u.def && u.def.attack && u.def.attack.spawnDelay) || 0.2, rel = sinceHit - sd;
    const casting = u.has && u.has('casting'); if (casting && !st.casting) st.castT = t; st.casting = casting;
    const sc = t - (st.castT || -9), magic = sc < 0.5; // Brilliant Bolt: full draw over 0.35 s, then the bolt of light leaves
    let draw = 0, aim = Math.min(1, Math.abs(twist) / Math.abs(A.keys.windup[1])), twang = 0;
    if (magic) { draw = sc < 0.35 ? ease(Math.min(1, sc / 0.3)) : 0; aim = 1; twang = sc >= 0.35 ? Math.max(0, 1 - (sc - 0.35) / 0.25) : 0; }
    else if (sinceHit >= 0 && rel < 0) { draw = 0.6 + 0.4 * (sinceHit / sd); aim = 1; }
    else if (rel >= 0 && rel < 0.3) { twang = 1 - rel / 0.3; aim = Math.max(aim, 1 - rel / 0.5); }
    else if (tgt && toHit > 0 && toHit < A.windupT) draw = 0.6 * ease(1 - toHit / A.windupT);
    if (st.dying) aim = draw = twang = 0;
    st.aimB = (st.aimB || 0) + (aim - (st.aimB || 0)) * Math.min(1, st.dt * 14); const k = ease(Math.min(1, st.aimB));
    const R = B.rest, P = B.aim, c = Math.cos(-twist), sn = Math.sin(-twist); // aim pose is in the target's frame: undo the body's twist
    const ax = P[0] * c + P[2] * sn, az = -P[0] * sn + P[2] * c, mix = (a, b) => a + (b - a) * k;
    // her arms do the work: the left fist holds the bow out at the target, the right one takes the string and pulls it back to her chin,
    // and stays there a beat after the arrow leaves. The bow and the string's nock are put where the fists actually are.
    const U2 = o.material.userData.bend, RG = HERO_RIG[figOf(u)], hL = W.hL || (W.hL = new THREE.Vector3(...RG.hand[0])), hR = W.hR || (W.hR = new THREE.Vector3(...RG.hand[1]));
    const D = new THREE.Vector3(sn, 0, c), grip = new THREE.Vector3(ax * H, P[1] * H, az * H), pull = Math.max(draw, twang);
    const nockT = grip.clone().addScaledVector(D, -(B.nock0 + pull * B.draw) * H);
    if (k > 0.001) { st.ikL = reach(RG, H, hL, 1, st.ikL || [-1.3, 0.6], grip, [-1.3, 0.6], [-2.4, -0.4], [0.3, 1.6]);
      st.ikR = reach(RG, H, hR, -1, st.ikR || [-1.2, -0.3, -1], nockT, [-1.2, -0.3, -1], [-2.4, -1.2, -2.9], [0.6, 0.8, 0]); }
    else st.ikL = st.ikR = null;
    const L = st.ikL || [0, 0], Rr = st.ikR || [0, 0, 0], wL = U2.uArm.value.x, wR = U2.uArm.value.y;
    U2.uArm.value.set(mix(wL, L[0]), mix(wR, Rr[0])); U2.uSpread.value.set(L[1] * k, Rr[1] * k); U2.uElbow.value.y = Rr[2] * k;
    const fL = armAt(RG, H, hL, 1, U2.uArm.value.x, U2.uSpread.value.x, 0), fR = armAt(RG, H, hR, -1, U2.uArm.value.y, U2.uSpread.value.y, U2.uElbow.value.y);
    W.grp.position.copy(fL); W.grp.rotation.set(mix(R[3] + wL, P[3]), mix(R[4], P[4] - twist), mix(R[5], P[5])); // at rest it hangs from her hand and swings with the arm
    W.grp.updateMatrix(); const inv = W.inv || (W.inv = new THREE.Matrix4()); inv.copy(W.grp.matrix).invert();
    const rest = W.tipT.clone().add(W.tipB).multiplyScalar(0.5); rest.z += Math.sin(Math.max(0, magic ? sc - 0.35 : rel) * 90) * 0.03 * twang * H; // the released string quivers
    const held = draw > 0.01 ? k : 0, nock = rest.lerp(fR.applyMatrix4(inv), held); // the string runs to her fingers while she holds it
    const r = 0.006 * H / B.scale; stringSeg(W.up, W.tipT, nock, r, W.Y); stringSeg(W.dn, nock, W.tipB, r, W.Y);
    W.arrow.visible = draw > 0.02 && k > 0.5; W.arrow.position.copy(nock);
    const big = magic ? 1.6 : 1, dir = nock.clone().negate(), L2 = dir.length() + 0.14 * H / B.scale; W.arrow.quaternion.setFromUnitVectors(W.Z || (W.Z = new THREE.Vector3(0, 0, 1)), dir.normalize()); // nock to the grip and on past the bow
    W.shaft.scale.set(r * 1.3 * big, r * 1.3 * big, L2); W.head.scale.set(r * 4 * big, r * 4 * big, r * 10 * big); W.head.position.z = L2;
    W.am.color.setHex(magic ? B.magic : B.arrow);
    for (const m of W.mats) m.opacity = o.material.opacity; W.mats[0].emissive.copy(o.material.emissive);
  }
  // --- a ride under the hero's feet (heroes3d.js figure lying flat, deck top at y=0, centred on the deck): hovers, banks and tips its nose with the body ---
  function heroBoard(o, A) {
    const B = A.board, d = H3.figs[B.fig], tex = heroTex[B.fig] || (heroTex[B.fig] = new THREE.TextureLoader().load(d.tex));
    const m = new THREE.Mesh(heroGeometry(B.fig), new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: 0x666666, transparent: true }));
    m.scale.setScalar(B.len / (d.deck[0][2] * d.h * 1.8)); m.renderOrder = 2; m.rotation.order = 'YXZ'; o.add(m); o.userData.board = m;
  }
  function spiritSkull(parent) { // Ron's Darkslide form: a glowing pink skull, cyan hexagon eyes, magenta cheeks and jaw (built from primitives, faces +z)
    const g = new THREE.Group(), mat = (c, op) => { const m = new THREE.MeshBasicMaterial({ color: c, transparent: true, depthWrite: false }); return m; }, add = (geo, c, x, y, z, op) => { const m = new THREE.Mesh(geo, mat(c)); m.position.set(x, y, z); m.userData.op = op || 1; m.renderOrder = 3; g.add(m); return m; };
    add(new THREE.SphereGeometry(0.5, 20, 14), 0xffb3ec, 0, 0, 0, 0.92).scale.set(1, 0.82, 1.2);
    add(new THREE.SphereGeometry(0.42, 16, 10), 0xffe3f7, 0, 0.1, 0.12, 0.6).scale.set(1, 0.6, 1.15); // pale crown
    for (const sd of [-1, 1]) { const e = add(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 6), 0x5ff4ff, sd * 0.2, 0.22, 0.45); e.rotation.set(Math.PI / 2 - 0.7, 0, sd * 0.35); // eyes on the upper front, so they read from the top-down camera e.scale.set(1.25, 1, 0.8);
      const r = add(new THREE.CylinderGeometry(0.21, 0.21, 0.04, 6), 0xff3fbf, sd * 0.2, 0.215, 0.44); r.rotation.copy(e.rotation); r.scale.copy(e.scale);
      add(new THREE.SphereGeometry(0.09, 8, 6), 0xff6fd0, sd * 0.4, -0.1, 0.38); }
    const jaw = add(new THREE.BoxGeometry(0.5, 0.1, 0.36), 0xff4fc8, 0, -0.33, 0.26); g.userData.jaw = jaw; jaw.geometry.translate(0, 0, 0.12);
    add(new THREE.BoxGeometry(0.42, 0.06, 0.26), 0xff4fc8, 0, -0.24, 0.44); // upper teeth line
    parent.add(g); return g;
  }
  function poseBoard(u, o, A, st, t) {
    const b = o.userData.board, dash = u.specialActive && A === HERO_ANIM.Banshee;
    b.rotation.y = -(A.board.side || 0); b.rotation.x = -0.1 * st.move - (dash ? 0.15 : 0); b.rotation.z = Math.sin(t * 2.3) * 0.04; // nose up when gliding, harder on Darkslide; idle sway
    b.material.opacity = o.material.opacity; b.material.emissive.copy(o.material.emissive);
  }
  // --- a melee weapon exported as its own piece (figure centred on its grip): swung on the same attack clock as the body keys ---
  function heroHeld(o, A, tex) {
    const m = new THREE.Mesh(heroGeometry(A.held.fig), new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: 0x666666, transparent: true }));
    m.scale.setScalar(A.held.scale); m.renderOrder = 2; m.rotation.order = A.held.order || 'YXZ'; o.add(m); o.userData.held = m;
  }
  function poseHeld(u, o, A, st, g, bend, C, ph) {
    const W = A.held, R = W.rest, K = W.keys, m = o.userData.held, H = H3.figs[figOf(u)].h * 1.8;
    const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k), ease = k => k * k * (3 - 2 * k);
    let p = R;
    if (W.arm) return poseHeldArm(u, o, A, st, bend, C, H);
    if (C.rec >= 0) { const k = C.rec; p = k < 0.15 ? mix(K.impact, K.follow, k / 0.15) : mix(K.follow, R, ease((k - 0.15) / 0.85)); }
    else if (C.ch >= 0) p = C.ch > A.slashT ? mix(R, K.windup, ease(1 - (C.ch - A.slashT) / A.windupT)) : mix(K.windup, K.impact, (1 - C.ch / A.slashT) ** 2);
    const sw = Math.sin(ph) * st.move * (p === R ? 1 : 0); // swings with the arm while walking
    if (W.hand) { // in the fist: swing the arm about its shoulder like the shader's arm deformer does, and put the weapon where the fist lands
      st.hs = (st.hs || 0) + ((u.specialActive && A.spin ? 1 : 0) - (st.hs || 0)) * Math.min(1, st.dt * 10); if (st.hs > 0.001) p = mix(p, W.spin, st.hs);
      const RG = HERO_RIG[figOf(u)], sd = W.hand === 'L' ? 1 : -1, a = st.dying ? 0 : p[0] - sw * 0.5, ca = Math.cos(a), sa = Math.sin(a);
      const px = ((RG.cx || 0) + sd * RG.torso) * H, py = RG.sh * H, hy0 = W.at[1] * H - py, hz0 = W.at[2] * H;
      const y = py + ca * hy0 - sa * hz0, z = sa * hy0 + ca * hz0, hy = A.hip * H;
      const ba = bend * Math.min(1, Math.max(0, (y - hy) / (A.soft * H))), cb = Math.cos(ba), sb = Math.sin(ba);
      m.position.set(W.at[0] * H, cb * (y - hy) - sb * z + hy, sb * (y - hy) + cb * z); m.rotation.set(a + p[1] + ba, p[2], -sd * p[3]); if (W.grip) m.translateY(W.grip * H * W.scale); // the fist holds the hilt this far below the sword's origin (toward the pommel)
      const U = o.material.userData.bend.uArm.value; if (sd > 0) U.x = a; else U.y = a;
      m.material.opacity = o.material.opacity; m.material.emissive.copy(o.material.emissive); return;
    }
    const x = p[0] * H, y = p[1] * H, z = (p[2] + sw * 0.04) * H, hy = A.hip * H;
    const ba = bend * Math.min(1, Math.max(0, (y - hy) / (A.soft * H))), cb = Math.cos(ba), sb = Math.sin(ba); // follow the body's bend deformer
    let tw = 0; if (W.spinT) { if (p !== R) st.tw = (st.tw || 0) + st.dt * W.spinT; else { const e = Math.round((st.tw || 0) / Math.PI) * Math.PI; st.tw = e + ((st.tw || 0) - e) * Math.max(0, 1 - st.dt * 10); } tw = st.tw; } // twirls in its own plane (a double glaive looks the same every half turn)
    m.position.set(x, cb * (y - hy) - sb * z + hy, sb * (y - hy) + cb * z); m.rotation.set(p[3] + ba + sw * 0.25, p[4], p[5] + tw);
    m.material.opacity = o.material.opacity; m.material.emissive.copy(o.material.emissive);
  }
  function poseHeldArm(u, o, A, st, bend, C, H) { // the weapon sits in the left hand: rotate the rest grip about the left shoulder by that arm's swing
    const W = A.held, R = W.rest, m = o.userData.held, RG = HERO_RIG[figOf(u)], a = o.material.userData.bend.uArm.value.x, ca = Math.cos(a), sa = Math.sin(a);
    const shY = RG.sh * H, y0 = R[1] * H - shY, z0 = R[2] * H, x = R[0] * H, y = ca * y0 - sa * z0 + shY, z = sa * y0 + ca * z0, hy = A.hip * H;
    const ba = bend * Math.min(1, Math.max(0, (y - hy) / (A.soft * H))), cb = Math.cos(ba), sb = Math.sin(ba);
    const swing = C.rec >= 0 || C.ch >= 0, idle = !swing && st.move < 0.1 && !st.dying;
    st.itT = idle ? (st.itT || 0) + st.dt : 0; // standing still: a twirl in the hand every idleTwirl seconds (a whole turn, eased)
    if (W.idleTwirl && st.itT > W.idleTwirl) { st.itT = 0; st.twirl = 0; } if (st.twirl !== undefined) { st.twirl += st.dt / 0.8; if (st.twirl >= 1 || !idle) st.twirl = undefined; }
    if (swing) st.tw = (st.tw || 0) + st.dt * W.spinT; else { const e = Math.round((st.tw || 0) / Math.PI) * Math.PI; st.tw = e + ((st.tw || 0) - e) * Math.max(0, 1 - st.dt * 10); }
    const k = st.twirl === undefined ? 0 : st.twirl, tw = st.tw + Math.PI * 2 * k * k * (3 - 2 * k);
    m.position.set(x, cb * (y - hy) - sb * z + hy, sb * (y - hy) + cb * z); m.rotation.order = 'XYZ'; m.rotation.set(R[3] + a + ba, R[4], R[5] + tw); // arm swing outermost, about her shoulder line
    m.material.opacity = o.material.opacity; m.material.emissive.copy(o.material.emissive);
  }
  const shoveA = (st, t) => { const e = t - (st.chgEnd || -9); return e < 0.35 ? Math.sin(Math.min(1, e / 0.35) * Math.PI) : 0; }; // after a charge lands
  function poseHero(u, o, A, st, g) {
    const R0 = HERO_RIG[figOf(u)], rigged = !!(R0 && R0.crotch) && !A.board && !A.hop;
    // heroes with legs take steps as long as their legs sweep (one step = 2 * leg * sin(stride)), so the planted foot holds the ground
    // instead of skating; the old fixed rate scissored the legs about twice too fast for the distance covered
    if (rigged && A.rate === undefined) A.rate = Math.PI / (2 * (R0.crotch + 0.03) * H3.figs[figOf(u)].h * 1.8 * (A.size || 1) * Math.sin(R0.stride || 0.45) * 0.92);
    const chgOn = !!(u.forced && u.forced.onEnd && A.charge); st.chg = (st.chg || 0) + ((chgOn ? 1 : 0) - (st.chg || 0)) * Math.min(1, (st.dt || 0) * 18);
    if (chgOn) st.chgPh = (st.chgPh || 0) + (st.dt || 0) * 30; // Bulldoze: the charge isn't walking (walkT stands still), so the legs sprint on their own clock
    if (!chgOn && st.chgWas) st.chgEnd = g.time; st.chgWas = chgOn;
    const t = g.time, m = Math.max(st.move, st.chg), W = A.walk, ph = (u.walkT || 0) * (rigged ? A.rate : W[0]) + (st.chgPh || 0);
    let bend = 0, pitch = 0, roll = 0, yaw = 0, lift = 0, fwd = 0, sx = 1, sy = 1, fade = 1;
    sy += 0.025 * Math.sin(t * 3) * (1 - m); // breathing when standing
    if (A.idleSway) { roll += Math.sin(t * 1.3) * A.idleSway * (1 - m); yaw += Math.sin(t * 0.65) * A.idleSway * 1.5 * (1 - m); lift += Math.abs(Math.sin(t * 1.3)) * A.idleSway * 0.3 * (1 - m); } // weight from foot to foot
    let lean = 0;
    if (rigged) { // a jog: up off the ground when the legs are spread, down onto the bent stance leg as they pass; the torso
      // leans in from the hips and nods on each landing, the hips turn a little with the step, only a hint of side rock
      const b = Math.abs(Math.sin(ph)); lift += b * W[1] * 0.6 * m; sy += 0.035 * m * (b - 0.6); sx -= 0.02 * m * (b - 0.6);
      roll += Math.sin(ph) * Math.min(W[2], 0.05) * m; yaw += Math.sin(ph) * 0.06 * m; pitch += W[3] * 0.45 * m; lean = (W[3] * 0.9 + 0.05 * (0.6 - b)) * m;
    } else { lift += Math.abs(Math.sin(ph)) * W[1] * m; roll += Math.sin(ph) * W[2] * m; pitch += W[3] * m; } // waddle: bob each step, rock side to side, lean in
    if (A.hop && m > 0.1) { const c = Math.abs(Math.cos(ph)); sy -= 0.12 * Math.pow(c, 6) * m; sx += 0.08 * Math.pow(c, 6) * m; } // squash on each landing
    if (u.attackAnim > (st.aa || 0)) st.hitT = t; st.aa = u.attackAnim; // attackAnim jumps up the frame a hit lands
    const K2 = A.keys, mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k), ease = k => k * k * (3 - 2 * k);
    const tgt = st.dying ? null : swingTarget(u, g), C = swingClock(u, A, st, t, tgt), sinceHit = C.since;
    let sw = null;
    if (C.rec >= 0) { // follow through past the target, then settle back to neutral
      const k = C.rec; sw = k < 0.15 ? mix(K2.impact, K2.follow, k / 0.15) : mix(K2.follow, K2.follow.map(() => 0), ease((k - 0.15) / 0.85));
      if (k < 0.3) { const q = 1 - k / 0.3; sy -= 0.07 * q; sx += 0.05 * q; } // weight lands on the front foot
      if (k > 0.15) { const y = 1 - 0.65 * m * Math.min(1, (k - 0.15) / 0.2); sw = sw.map(v => v * y); } // moving off cuts the recovery short, so the hero is free the moment you steer
    } else if (C.ch >= 0) { // charging the next hit: draw back, then whip through (accelerating) so the blade connects as the hit leaves
      const ci = C.ch; sw = ci > A.slashT ? mix(K2.windup.map(() => 0), K2.windup, ease(1 - (ci - A.slashT) / A.windupT)) : mix(K2.windup, K2.impact, (1 - ci / A.slashT) ** 2);
    }
    if (A.box) { // which fist throws this punch: alternate, every third one is the big cross
      if (st.hitT !== st.boxHit) { st.boxHit = st.hitT; st.combo = (st.combo || 0) + 1; }
      const nxt = (C.busy ? st.combo : (st.combo || 0) + 1) || 1; st.side = nxt % 2 ? 1 : -1; st.cross = nxt % 3 === 0 ? 1.5 : 1;
      if (sw) sw = [sw[0] * (st.cross > 1 ? 1.15 : 1), sw[1] * st.side * st.cross, sw[2], sw[3] * st.cross]; // the cross turns the hips and steps in further, the back stays straight
      st.guard = (st.guard || 0) + (((tgt || sinceHit < 1.2) && !st.dying ? 1 : 0) - (st.guard || 0)) * Math.min(1, st.dt * 8);
      if (m < 0.2) lift += Math.abs(Math.sin(t * 7)) * 0.035 * st.guard; // bounces on his toes between punches
      // punch reach 0 (guard) .. 1 (arm straight out): chamber a little, snap out on the hit, hold, pull back to guard
      let pk = 0;
      if (C.rec >= 0) { const k = C.rec; pk = k < 0.18 ? 1 : 1 - ease(Math.min(1, (k - 0.18) / 0.55)); } // hold the hit a beat, then snap back to the guard
      else if (C.ch >= 0) pk = C.ch > A.slashT ? -0.25 * ease(1 - (C.ch - A.slashT) / A.windupT) : -0.25 + 1.25 * (1 - C.ch / A.slashT);
      st.punch = pk;
    }
    if (sw) { bend = sw[0]; yaw += sw[1]; pitch += sw[2]; fwd = sw[3]; }
    bend += lean * (1 - Math.min(1, Math.abs(bend) * 2)); // running lean from the hips, given up to a swing
    if (tgt) st.aim = Math.atan2(tgt.y - u.y, tgt.x - u.x);
    if ((tgt && (C.ch >= 0 || m < 0.5)) || C.busy) o.rotation.y = turnTo(o, st.aim + Math.PI / 2, 24); // square up to the target for the whole swing (fast, but no snap); between swings a moving hero looks where it runs
    { // bank into a turn; walking backwards or sideways (kiting while squared up): legs and lean follow the real direction of travel
      const fy = o.rotation.y, dyaw = st.fy === undefined || st.dying ? 0 : Math.atan2(Math.sin(fy - st.fy), Math.cos(fy - st.fy)); st.fy = fy;
      st.turn = (st.turn || 0) + ((st.dt > 0 ? dyaw / st.dt : 0) - (st.turn || 0)) * Math.min(1, st.dt * 12);
      roll -= Math.max(-0.16, Math.min(0.16, st.turn * 0.025)) * m;
      const rel = st.mdir === undefined ? 1 : Math.cos(st.mdir - (fy - Math.PI / 2)), f0 = st.dirF === undefined ? 1 : st.dirF;
      st.dirF = f0 + (rel - f0) * Math.min(1, st.dt * 10);
      pitch += W[3] * m * (st.dirF - 1) * 0.8 + (u.forced ? 0 : Math.max(-0.1, Math.min(0.12, (st.surge || 0) * 0.016))); }
    if (A.arc) trail(o, st, sinceHit, A);
    const cast = u.has && u.has('casting') && !u.forced; st.cast = (st.cast || 0) + ((cast ? 1 : 0) - (st.cast || 0)) * Math.min(1, st.dt * 12); // blend in/out of the special pose
    const P2 = (u.forced && u.forced.onEnd && A.charge) || (u.specialActive && u.specialActive.thief && A.sneak) || (A.cast && st.cast > 0.01 && A.cast.map(v => v * st.cast));
    if (P2) { bend += P2[0]; yaw += P2[1]; pitch += P2[2]; fwd += P2[3]; }
    if (A.sneak && u.specialActive && u.specialActive.thief) { sy -= 0.12; sx += 0.04; }
    { // special starts with a punch: a quick crouch, then a stretch up that settles (squash and stretch) and a brief glow
      const on = !!((u.has && u.has('casting')) || u.specialActive || (u.forced && u.forced.onEnd)); if (on && st.spOn === false) st.spT = t; st.spOn = on;
      const e = t - (st.spT || -9); if (e < 0.32 && !st.dying) { const q = e < 0.08 ? -0.13 * Math.sin(e / 0.08 * Math.PI) : e < 0.2 ? 0.15 * Math.sin((e - 0.08) / 0.12 * Math.PI) : -0.04 * Math.sin((e - 0.2) / 0.12 * Math.PI);
        sy += q; sx -= q * 0.6; o.material.emissive.setScalar(Math.max(o.material.emissive.r, 0.4 + 0.45 * Math.max(0, 1 - e / 0.25))); }
      // landing from a dash or a knockback: weight drops onto the legs
      const fz = !!u.forced; if (!fz && st.fz) st.landT = t; st.fz = fz;
      const l = t - (st.landT || -9); if (l < 0.22 && !st.dying) { const q = Math.sin(Math.min(1, l / 0.22) * Math.PI) * (1 - l / 0.22 * 0.4); sy -= 0.13 * q; sx += 0.09 * q; } }
    if ((A === HERO_ANIM.Sorcerer || A === HERO_ANIM.Paladin || A === HERO_ANIM.Automaton) && st.cast > 0.01) { lift += 0.06 * st.cast; roll += Math.sin(t * 5) * 0.05 * st.cast; } // floats a little while channelling
    if (A === HERO_ANIM.Marksman && st.cast > 0.01) roll += Math.sin(t * 40) * 0.015 * st.cast; // laser shakes the arms
    if (u.forced && !u.forced.onEnd) pitch -= 0.3; // knocked back
    if (u.specialActive && A.spin) { st.spin = (st.spin || 0) + st.dt * A.spin; yaw += st.spin; bend = A.spinBend; pitch -= A.spinSword ? 0.02 : 0.1; lift += 0.04 * Math.abs(Math.sin(t * 9)); }
    if (A.spinRoll) { st.spr = (st.spr || 0) + ((u.specialActive ? 1 : 0) - (st.spr || 0)) * Math.min(1, st.dt * 9); if (st.spr > 0.001) { roll += A.spinRoll * st.spr; lift += 0.38 * st.spr; } }
    else st.spin = 0;
    if (u.flash > 0) { const k = Math.min(1, u.flash / 0.12); pitch -= 0.07 * k; sx += 0.02 * k; sy -= 0.02 * k; } // a slight flinch on a hit (a big one read as a hitch, Rickard)
    if (u.has && u.has('stun')) roll += Math.sin(t * 14) * 0.12;
    if (A.leap) { // Illustrious Leap: crouch, spring up out of the fight, drift above the ring where he will land, then crash straight down
      const sa = u.specialActive && u.specialActive.s && u.specialActive.s.PreJumpDuration !== undefined ? u.specialActive : null, S = sa && sa.s; let L = 0;
      if (sa) { const e = sa.t - S.PreJumpDuration;
        if (e < 0) { const k = sa.t / S.PreJumpDuration; sy -= 0.18 * k; sx += 0.1 * k; }
        else if (sa.landing) { const k = Math.max(0, sa.landT / S.LandDuration); L = A.leap * k * k; pitch += 0.35 * k; }
        else { const k = Math.min(1, e / S.JumpDuration); L = A.leap * (1 - (1 - k) ** 2) + (k >= 1 ? Math.sin(t * 3) * 0.12 : 0); sy += 0.12 * (1 - k); pitch -= 0.2 * (1 - k); } }
      lift += L;
      let M = o.userData.mark; if (!M && L > 0.01 && o.parent) { M = o.userData.mark = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 48), new THREE.MeshBasicMaterial({ color: 0x9dff7a, transparent: true, depthWrite: false })); M.rotation.x = -Math.PI / 2; M.renderOrder = 1; o.parent.add(M); }
      if (M) { M.visible = L > 0.01; if (M.visible) { M.position.set(o.position.x, 0.05, o.position.z); M.scale.setScalar(S.DamageRange * (1 + 0.04 * Math.sin(t * 7))); M.material.opacity = 0.3 + 0.4 * Math.min(1, L / A.leap); } }
    }
    if (st.dying) { const d = t - st.dieT; pitch = -1.45 * Math.min(1, d / 0.45); bend = 0.5 * Math.min(1, d / 0.45); lift = -Math.max(0, d - 0.6) * 0.9; fade = Math.max(0, 1 - Math.max(0, d - 0.8) / 0.5); }
    const sp = t - (st.spawnT || -9); if (sp < 0.4) { const e = sp / 0.4, s = 1 + 2.7 * Math.pow(e - 1, 3) + 1.7 * Math.pow(e - 1, 2); sx *= s; sy *= s; } // pop in on respawn (ease-out-back)
    const f = o.rotation.y - Math.PI / 2; // lunge along where the figure is actually facing
    if (A.board) { lift += A.board.lift + Math.sin(t * 3.5) * 0.025; yaw += A.board.side || 0; poseBoard(u, o, A, st, t); } // rides the hoverboard, standing across it
    if (A.gun && st.cast > 0.01 && !st.dying) lift -= 0.1 * st.cast * (1 - m); // Silver's laser stance: hips sink so the spread feet stay on the floor
    if (o.userData.jumpT) { const e = (performance.now() / 1000 - o.userData.jumpT) / 0.55; // Ginette leaps down off her wilting plant
      if (e < 1) { lift += 0.95 * (1 - e) + Math.sin(e * Math.PI) * 0.45; fwd += 0.5 * e; pitch += Math.sin(e * Math.PI) * 0.35; } else o.userData.jumpT = 0; }
    o.position.x += Math.cos(f) * fwd; o.position.z -= Math.sin(f) * fwd; o.position.y += lift;
    o.rotation.y += yaw; o.rotation.x = pitch; o.rotation.z = roll; o.scale.set(sx * (A.size || 1), sy * (A.size || 1), sx * (A.size || 1));
    if (A.spinPivot && st.spr > 0.001) { // tip over about the middle of the body, not the feet, so a tall figure spins on the spot instead of sweeping round it
      const c = A.spinPivot * H3.figs[figOf(u)].h * 1.8 * (A.size || 1), sr = Math.sin(roll) * c, Y = o.rotation.y;
      o.position.x += sr * Math.cos(Y); o.position.z -= sr * Math.sin(Y); o.position.y += c * (1 - Math.cos(roll)); }
    // limbs: legs stride with the walk cycle and arms swing against them; the striking (right) arm draws back on the windup and whips through
    // on the hit (follows the body bend keys); both arms reach forward while casting; everything relaxes while dying
    const U2 = o.material.userData.bend, R = HERO_RIG[figOf(u)];
    if (R) {
      const live = st.dying ? 0 : 1, str = (R.stride || 0.45) * m * live * Math.max(-1, Math.min(1, (st.dirF === undefined ? 1 : st.dirF) * 1.6)), leg = Math.sin(ph) * str;
      const strike = sw ? Math.max(-1.6, Math.min(1.0, -sw[0] * 2.2)) : 0, castA = -1.1 * (st.cast || 0), idle = Math.sin(t * 2) * 0.05 * (1 - m);
      const fl = u.flash > 0 ? Math.min(1, u.flash / 0.12) * 0.4 : 0, up = (R.crotch || 0) * 0.12 * m * live, c = Math.cos(ph);
      // knees: the swinging leg folds (most just after toe-off) and straightens to land; the stance knee gives a little under the weight
      const kn = (R.knee === undefined ? 0.9 : R.knee) * m * live * Math.min(1, Math.abs(st.dirF === undefined ? 1 : st.dirF) * 1.6), kc = Math.cos(ph + 0.3);
      if (A.hop) { const air = Math.abs(Math.sin(ph)) * m * live; U2.uLeg.value.set(air * 0.5, air * 0.5); U2.uKnee.value.x = U2.uKnee.value.y = air * 0.9; } // both legs kick back together on each hop
      else { U2.uLeg.value.set(leg, -leg); U2.uKnee.value.x = kn * (Math.max(0, -kc) + 0.12 * Math.max(0, kc)); U2.uKnee.value.y = kn * (Math.max(0, kc) + 0.12 * Math.max(0, -kc)); } U2.uLift.value.set(Math.max(0, c) * up * H3.figs[figOf(u)].h * 1.8, Math.max(0, -c) * up * H3.figs[figOf(u)].h * 1.8);
      U2.uElbow.value.x = U2.uElbow.value.y = 0;
      if (R.head) { // neck: chin tucked behind the guard, nods with each step, snaps back on a hit, horns dropped for the charge,
        // then the head comes up as he shoves through the target
        const se = t - (st.chgEnd || -9), shove = se < 0.35 ? Math.sin(Math.min(1, se / 0.35) * Math.PI) : 0;
        U2.uHead.value.x = live * ((st.guard || 0) * 0.22 + Math.sin(ph * 2) * 0.05 * m * (1 - st.chg) + Math.sin(t * 0.8) * 0.04 * (1 - m) - fl * 0.7 + st.chg * 0.75 - shove * 0.3) || 1e-4; }
      if (A.box && !st.dying) { // boxer: guard = elbows in, forearms up so the fists sit by the chin; a punch drives the shoulder forward and
        // straightens the elbow so the fist shoots out level at the target, then snaps back; the other fist stays up. Out of a fight: bent running arms.
        const G = st.guard, sw2 = 1 - G * 0.8, pR = st.side > 0 ? st.punch : 0, pL = st.side < 0 ? st.punch : 0, reach = -1.1 - 0.15 * (st.cross - 1);
        const up = -0.5 * G, bentE = -0.55 * m * (1 - G), gE = -1.9 * G, arm = p => p * reach, elb = p => gE * (1 - Math.max(0, p)) + (p < 0 ? 0.6 * p : 0);
        U2.uArm.value.set(-leg * 1.1 * sw2 + idle + castA + up + arm(pL) + fl * 0.5, leg * 1.1 * sw2 - idle + castA + up + arm(pR) + fl * 0.5);
        U2.uElbow.value.x = elb(pL) + bentE; U2.uElbow.value.y = elb(pR) + bentE;
        if (st.chg > 0.01 || shoveA(st, t) > 0) { const c2 = st.chg, sh = shoveA(st, t); // Bulldoze: fists swept back like a charging bull, then both shove forward on impact
          U2.uArm.value.x = U2.uArm.value.x * (1 - c2) + c2 * (0.9 - leg * 0.6) - sh * 1.3; U2.uArm.value.y = U2.uArm.value.y * (1 - c2) + c2 * (0.9 + leg * 0.6) - sh * 1.3;
          U2.uElbow.value.x = U2.uElbow.value.x * (1 - c2) - c2 * 0.6 + sh * 0.6; U2.uElbow.value.y = U2.uElbow.value.y * (1 - c2) - c2 * 0.6 + sh * 0.6; }
      } else if (R.sword) { // Peter's sword: rides a little forward and bounces late on each step, breathes at rest, chops on the swing keys,
        // leans out a little in the whirlwind (eased in and out), tips back on a hit and drops with him when he dies
        st.swd = (st.swd || 0) + ((Math.sin(ph * 2 - 0.9) * 0.07 + 0.12) * m - (st.swd || 0)) * Math.min(1, st.dt * 14);
        st.sws = (st.sws || 0) + ((u.specialActive && A.spinSword ? 1 : 0) - (st.sws || 0)) * Math.min(1, st.dt * 10);
        const key = sw && sw.length > 4 ? sw[4] : 0, rest = key + st.swd * (1 - Math.min(1, Math.abs(key))) + Math.sin(t * 2) * 0.03 * (1 - m);
        U2.uArm.value.set(st.dying ? Math.min(1.3, (t - st.dieT) * 3) : rest + ((A.spinSword || 0) - rest) * st.sws - fl * 0.35, 0);
      } else if (A.gun && !st.dying) { // Silver: in a fight the arm cannon is carried low, pointing ahead; for each shot he brings it up level
        // at the target and leans into it (the free hand comes forward to steady it), the shot kicks the muzzle up, then it drops back
        st.gAim = (st.gAim || 0) + ((tgt || sinceHit < 1.2 || st.cast > 0.05 ? 1 : 0) - (st.gAim || 0)) * Math.min(1, st.dt * 10);
        const aimK = Math.max(st.cast || 0, C.ch >= 0 ? ease(Math.max(0, Math.min(1, 1 - (C.ch - A.slashT) / A.windupT))) : C.rec >= 0 ? (C.rec < 0.45 ? 1 : 1 - ease((C.rec - 0.45) / 0.55)) : 0);
        const G = ease(Math.min(1, st.gAim)), kick = sinceHit >= 0 && sinceHit < 0.3 ? (1 - sinceHit / 0.3) ** 2 : 0, lvl = -1.0 - (bend + pitch) * 0.9, carry = -0.45;
        const gunA = -leg * 0.55 * (1 - G) + idle * (1 - G) + G * (carry + (lvl - carry) * aimK - 0.35 * kick) + fl * 0.5, offA = leg * 1.1 * (1 - G * 0.6) - idle + G * (-0.2 - 0.6 * aimK) + (st.cast || 0) * -0.4 + fl * 0.5;
        if (A.gun === 'L') U2.uArm.value.set(gunA, offA); else U2.uArm.value.set(offA, gunA);
        const bc = (st.cast || 0) * (1 - m), fs = A.gun === 'L' ? 1 : -1; // laser: feet apart, gun side forward, knees soft to take the push
        if (bc > 0.01) { U2.uLeg.value.x -= 0.32 * bc * fs; U2.uLeg.value.y += 0.32 * bc * fs; U2.uKnee.value.x += 0.25 * bc; U2.uKnee.value.y += 0.25 * bc; }
      } else
      if (A.bothArms) { const b = Math.max(-1.6, Math.min(0.8, strike * A.bothArms)); // a caster: both hands draw back on the windup and thrust the spell out together
        U2.uArm.value.set((-leg * 0.6 + idle + castA + b + fl * 0.5) * live, (leg * 0.6 - idle + castA + b + fl * 0.5) * live); } else
      { const sL = A.strikeArm === 'L', sk = strike * (A.strikeAmp || 1); // strikeArm 'L': the left hand holds the weapon, so it strikes and the right one counters
      const cL = R.carry === 'L' ? 0.2 : 1, cR = R.carry === 'R' ? 0.2 : 1; // a carried weapon (Pearl's hammer) is only half inside the arm's weights: swinging that arm tears it, so the body swings it instead
      U2.uArm.value.set((-leg * 1.1 * (R.carry === 'L' ? 0.15 : 1) + idle + (castA + (sL ? sk : -strike * 0.35)) * cL + fl * 0.5) * live, (leg * 1.1 * (R.carry === 'R' ? 0.15 : 1) - idle + (castA + (sL ? -strike * 0.35 : strike)) * cR + fl * 0.5) * live); }
    }
    { const ch = !!(u.forced && u.forced.onEnd && u.code === 'Brawler'), shd = u.statuses && u.statuses.some(x => x.type === 'shield' && x.amount > 0);
      st.dark = ch ? 1 : Math.max(0, (st.dark || 0) - st.dt / 0.35); U2.uDark.value = st.dark * 0.45; // tinted, not a black blob: the charge pose has to read
      if (st.dark > 0.01) U2.uRim.value.set(1, 0.95, 0.5, 2.2 * st.dark + (shd ? 1.6 : 0));
      else if (shd) U2.uRim.value.set(0.55, 1, 0.3, 1.5 + 0.3 * Math.sin(t * 6)); else U2.uRim.value.w = 0; }
    if (A.board) { // Darkslide (Rickard's reference GIF): Ron turns into a big pink spirit skull with cyan eyes; he and the board fade out under it
      st.sk = (st.sk || 0) + ((u.specialActive && u.alive ? 1 : 0) - (st.sk || 0)) * Math.min(1, st.dt * 10);
      let S = o.userData.skull; if (!S && st.sk > 0.01 && o.parent) S = o.userData.skull = spiritSkull(o.parent);
      if (S) { S.visible = st.sk > 0.02; if (S.visible) { const pop = st.sk * (1 + 0.25 * Math.sin(Math.min(1, st.sk) * Math.PI)), f2 = o.rotation.y - (A.board.side || 0);
        S.position.set(o.position.x, o.position.y + 0.55 + Math.sin(t * 6) * 0.05, o.position.z); S.rotation.set(-0.25, f2, Math.sin(t * 4) * 0.08); // face tipped up toward the camera S.scale.setScalar(pop * 1.4);
        S.userData.jaw.rotation.x = 0.35 + 0.25 * Math.sin(t * 9); S.children.forEach(c => { if (c.material) c.material.opacity = Math.min(1, st.sk * 1.2) * (c.userData.op || 1); }); } }
      fade *= 1 - Math.min(1, st.sk * 1.3); if (st.sk > 0.001) o.scale.multiplyScalar(1 - 0.85 * st.sk); // he shrinks away inside it
    }
    if (A.turret) { // Remote Demolition (Rickard's Meshy model R17 Guardian Turret): ROI17 folds into a rocket turret that turns on its target
      const on = !!(u.specialActive && u.specialActive.joker && u.alive); st.tu = (st.tu || 0) + ((on ? 1 : 0) - (st.tu || 0)) * Math.min(1, st.dt * (on ? 9 : 6));
      let T = o.userData.turret; if (!T && st.tu > 0.01 && o.parent) { const f = A.turret.fig, tex = heroTex[f] || (heroTex[f] = new THREE.TextureLoader().load(H3.figs[f].tex));
        T = o.userData.turret = new THREE.Mesh(heroGeometry(f), new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: 0x666666, transparent: true })); T.renderOrder = 2; o.parent.add(T); }
      if (T) { T.visible = st.tu > 0.02; if (T.visible) { const k = Math.min(1, st.tu), pop = A.turret.scale * k * (1 + 0.3 * Math.sin(k * Math.PI)), kick = Math.max(0, 1 - (t - (st.hitT || -9)) / 0.18);
        T.position.set(o.position.x, o.position.y, o.position.z); T.rotation.y = o.rotation.y - yaw; T.scale.set(pop, pop * (1 - 0.06 * kick), pop); // a short squash each time it fires
        T.material.opacity = Math.min(1, st.tu * 1.5) * (o.material.opacity || 1); T.material.emissive.copy(o.material.emissive); } }
      fade *= 1 - Math.min(1, st.tu * 1.5); if (st.tu > 0.001) o.scale.multiplyScalar(1 - 0.9 * st.tu); if (o.userData.held) o.userData.held.visible = st.tu < 0.4;
    }
    o.material.userData.bend.uBend.value = bend; if (fade < 1) o.material.opacity *= fade;
    if (A.bow) poseBow(u, o, A, st, g, sw ? sw[1] : 0, bend, C.start, tgt, C.toStart, ph); // the bow keeps its own clock from the attack's start
    if (A.held) poseHeld(u, o, A, st, g, bend, C, ph);
  }
  // figures turn toward their facing quickly instead of snapping to it: a bot that changes its mind, or swaps between walking
  // and aiming each attack, no longer flicks round and back in one frame (a 180° turn takes about 0.15 s)
  // A second call in the same frame is told apart by turnFrame, not by the clock: performance.now() moves between the two calls on
  // some devices and not on others (coarse timers), so a hero squaring up to a nearby target flickered between its two headings.
  let turnFrame = 0;
  function turnTo(o, want, rate = 16) { // may be called again in the same frame (squaring up for a swing): it then turns from the same start
    const ud = o.userData, now = performance.now() / 1000;
    if (ud.turnF !== turnFrame) { ud.turnDt = Math.min(0.1, now - (ud.turnAt || now)); ud.turnAt = now; ud.turnF = turnFrame; ud.yaw0 = ud.yaw; }
    if (ud.yaw0 === undefined) return ud.yaw = ud.yaw0 = want;
    const d = ((want - ud.yaw0 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return ud.yaw = ud.yaw0 + d * Math.min(1, ud.turnDt * rate);
  }
  function syncHeroes(g) {
    const seen = new Set();
    for (const u of g.units) {
      if (u.kind !== 'hero' || !api.hasHero(u.code)) continue;
      let o = heroObjs.get(u);
      if (!o) { const f = HERO_FIGURES[u.code], tex = heroTex[f] || (heroTex[f] = new THREE.TextureLoader().load(H3.figs[f].tex));
        o = new THREE.Mesh(heroGeometry(f), new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: 0x666666 })); o.renderOrder = 2; o.rotation.order = 'YXZ'; o.userData.fig = f; scene.add(o); heroObjs.set(u, o);
        if (HERO_ANIM[u.code]) bendMaterial(o.material, HERO_ANIM[u.code], H3.figs[f].h * 1.8, f); // (a hero first seen afoot is swapped right below)
        if (HERO_ANIM[u.code] && HERO_ANIM[u.code].bow) heroBow(o, HERO_ANIM[u.code], tex);
        if (HERO_ANIM[u.code] && HERO_ANIM[u.code].board) heroBoard(o, HERO_ANIM[u.code]);
        if (HERO_ANIM[u.code] && HERO_ANIM[u.code].held) heroHeld(o, HERO_ANIM[u.code], tex); }
      if (o.userData.fig !== figOf(u)) { const f = figOf(u), old = o.userData.fig, m = new THREE.MeshLambertMaterial({ map: o.material.map, emissiveMap: o.material.map, emissive: 0x666666 }); // Ginette jumps off her plant (or gets it back on respawn)
        bendMaterial(m, animOf(u), H3.figs[f].h * 1.8, f); o.material.dispose(); o.material = m; o.geometry = heroGeometry(f); o.userData.fig = f; 
        if (f === 'grannyGrove' && u.alive) { const w = new THREE.Mesh(heroGeometry(old), new THREE.MeshLambertMaterial({ map: m.map, emissiveMap: m.map, emissive: 0x666666, transparent: true }));
          w.position.copy(o.position); w.rotation.order = 'YXZ'; w.rotation.y = o.rotation.y; w.scale.copy(o.scale); w.renderOrder = 2; scene.add(w); wilts.push({ m: w, t0: performance.now() / 1000, x: u.x, y: u.y });
          o.userData.jumpT = performance.now() / 1000; } else o.userData.jumpT = 0; }
      seen.add(u); const A = animOf(u), st = A && animState(u, o, g);
      o.visible = (u.alive || st && st.dying) && (K.visible(u) || st && st.dying);
      const half = u.has && (u.has('invisible') || (u.team === K.PLAYER_TEAM && g.map.inGrass && g.map.inGrass(u))); // same see-through rule as the 2D tokens
      o.material.transparent = true; o.material.opacity = half ? 0.5 : 1; // always in the transparent pass so it draws after the range disc (renderOrder 2 > 1)
      o.position.set(u.x, (u.lift3 || 0) + (!A && u.attackAnim > 0 ? 0.05 : 0), -u.y); // animated heroes show the hit with their swing instead of a hop
      o.rotation.y = turnTo(o, (u.facing !== undefined ? u.facing : (u.team === K.PLAYER_TEAM ? -Math.PI / 2 : Math.PI / 2)) + Math.PI / 2); // figures face +z
      o.material.emissive.setScalar(u.flash > 0 ? 1 : 0.4); // Meshy textures have their light baked in, so they take half their colour unlit
      if (A) poseHero(u, o, A, st, g);
    }
    for (let i = wilts.length - 1; i >= 0; i--) { const W = wilts[i], e = (performance.now() / 1000 - W.t0) / 1.1; // the plant Ginette left: it bursts into leaves and petals, keels over and sinks away
      if (e >= 1) { scene.remove(W.m); W.m.material.dispose(); wilts.splice(i, 1); continue; }
      if (!W.puffed) { W.puffed = true; const at = { x: W.x, y: W.y, h: 0.9 };
        burst({ n: 22, at, jit: 0.3, sp: [1, 3], up: [0.5, 2.5], g: 3, drag: 1.5, life: [0.6, 1.1], s: [0.35, 0.15], c: [1, 0.6, 0.8], tex: 'petal', spin: 6, add: false });
        burst({ n: 16, at, jit: 0.3, sp: [0.8, 2.5], up: [0.3, 2], g: 3, drag: 1.5, life: [0.6, 1.1], s: [0.3, 0.12], c: [0.45, 0.8, 0.35], tex: 'petal', spin: 6, add: false });
        burst({ n: 10, at: { x: W.x, y: W.y, h: 0.2 }, ring: 0.4, sp: [0.5, 1.5], up: [0.2, 0.8], drag: 2, life: [0.6, 1], s: [0.5, 1.2], c: [0.75, 0.68, 0.55], a: 0.55, add: false, tex: 'smoke', spin: 1.5 }); }
      const k = e * e; W.m.rotation.x = -1.3 * k; W.m.position.y = -0.6 * k; W.m.scale.setScalar((1 - 0.5 * k) * (W.s0 || (W.s0 = W.m.scale.x))); W.m.material.opacity = Math.min(1, 2.2 * (1 - e)); }
    for (const [u, o] of heroObjs) if (!seen.has(u)) { scene.remove(o); if (o.userData.skull) scene.remove(o.userData.skull); if (o.userData.turret) { scene.remove(o.userData.turret); o.userData.turret.material.dispose(); } o.material.dispose(); if (o.userData.bow) o.userData.bow.mats.forEach(m => m.dispose()); if (o.userData.board) o.userData.board.material.dispose(); if (o.userData.held) o.userData.held.material.dispose(); if (o.userData.mark) { scene.remove(o.userData.mark); o.userData.mark.material.dispose(); } heroObjs.delete(u); }
  }
  function syncMinions(g) {
    const seen = new Set();
    for (const u of g.units) {
      if (u.kind !== 'minion' || !MD.prefabs[u.type]) continue;
      if (!u.alive && !(u.deadT > 0)) continue;
      let o = minions.get(u); if (!o) { o = minionObj(u); minions.set(u, o); }
      seen.add(u); o.visible = K.visible(u);
      const sink = u.alive ? 0 : (1 - Math.min(1, u.deadT / 0.6)) * 0.7; // dying minions sink into the ground while the 2D fade runs
      o.position.set(u.x, Math.abs(Math.sin((u.walkT || 0) * 6)) * 0.05 - sink, -u.y);
      o.rotation.y = turnTo(o, (u.facing !== undefined ? u.facing : (u.team === K.PLAYER_TEAM ? -Math.PI / 2 : Math.PI / 2)) - Math.PI / 2, 12); // pawn models face Unity +z
      for (const m of o.children) m.material.emissive.setScalar(u.flash > 0 ? 0.6 : 0);
    }
    for (const [u, o] of minions) if (!seen.has(u)) { scene.remove(o); o.children.forEach(m => m.material.dispose()); minions.delete(u); }
  }

  // --- attack effects: each auto attack flies as a flat quad with its own projectile texture (fx_<hero>_attack,
  // fx_minion_*Attack, fx_tower_attack), head first, about half a tile above the ground. w/l are world units, tint is the
  // fx's start colour or colour gradient; team: recolour by brightness to the team colour (hue-shift shaders) ---
  const ALLY = [0.35, 0.8, 1.0], ENEMY = [1.0, 0.32, 0.36];
  const FX = {
    MeleeMinion: { t: 'tx_minion_projectileLine', w: 0.16, l: 0.7, team: true , line: true }, SiegeMinion: { t: 'tx_minion_projectileLine', w: 0.4, l: 1.1, team: true , line: true },
    RangeMinion: { t: 'tx_minion_ranged_projectile', w: 0.5, l: 0.5, team: true }, tower: { t: 'tx_tower_projectile_default', w: 0.7, l: 0.7, team: true, y: 1.6 },
    Angler: { t: 'tx_angler_default_projectileLine', w: 0.5, l: 1.0, c: [1.0, 0.56, 0.18] , line: true }, Archer: { t: 'tx_archer_projectileLine', w: 0.3, l: 0.6 , line: true },
    Automaton: { t: 'tx_automaton_projectileBase', w: 0.6, l: 0.6 }, Banshee: { t: 'tx_banshee_projectileBlurr', w: 0.6, l: 0.6, spin: true },
    Barbarian: { t: 'tx_barbarian_specialLine', w: 0.6, l: 1.2 , line: true }, Brawler: { t: 'tx_brawler_projectileLine', w: 0.55, l: 0.6 },
    Frog: { t: 'tx_frog_projectileLine', w: 0.4, l: 0.8 , line: true }, Joker: { t: 'tx_joker_projectile', w: 0.45, l: 0.9 , line: true },
    Marksman: { t: 'tx_marksman_projectile_default', w: 0.6, l: 0.6, y: 1.25 /* leaves the cannon's muzzle at shoulder height */ }, Paladin: { t: 'tx_angler_default_projectileLine', w: 0.45, l: 0.9, c: [0.75, 0.4, 1.0] , line: true },
    Sorcerer: { t: 'tx_sorcerer_projectileBase', w: 0.36, l: 0.36, spin: true }, Thief: { t: 'tx_general_trailSlash', w: 0.4, l: 0.8, c: [0.75, 0.45, 1.0] , line: true },
    Witch: { t: 'tx_witch_projectileLine', w: 0.35, l: 0.7, c: [1.0, 0.55, 0.9] , line: true }, JokerSpecial: { t: 'tx_joker_passiveLine', w: 0.45, l: 1.0 },
    Kunoichi: { t: 'tx_witch_projectileLine', w: 0.4, l: 0.5, c: [1.0, 0.55, 0.78] }, // Momiji's petals (ABC2's own hero, no own fx)
  };
  // Quads are drawn immediate-mode from a pool every frame. mode 0: texture colour × tint; 1: texture alpha, colour = tint;
  // 2: texture red channel as alpha, colour = tint (R-setter masks); team: 3 = recolour by brightness to the tint
  const ghosts = new Map(), AFTERGLOW = 0.35;
  const ronLast = new Map(); // Ron's last position, for the Darkslide flame direction
  const misfires = new Map(); let misFrame = 0; // ROI17's curving green shots, see drawShots
  // glow/trail colour per attacker (the projectiles sit in particle systems with a soft glow and a sparkle trail;
  // a lone flat card read as "drawn in Paint"). Team-coloured attackers use their team colour.
  const GLOW = { Angler: [1, 0.55, 0.2], Archer: [0.3, 0.9, 1], Automaton: [1, 0.75, 0.3], Banshee: [0.75, 0.6, 1], Barbarian: [0.3, 0.9, 1], Brawler: [1, 0.6, 0.25],
    Frog: [0.6, 0.9, 1], Joker: [0.5, 1, 0.35], Marksman: [1, 0.9, 0.6], Paladin: [0.8, 0.5, 1], Sorcerer: [1, 0.55, 0.3], Thief: [0.8, 0.5, 1], Witch: [1, 0.7, 0.9],
    JokerSpecial: [0.5, 1, 0.35], Kunoichi: [1, 0.6, 0.8] };
  const flatGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), upGeo = new THREE.PlaneGeometry(1, 1), pool = []; let used = 0;
  // Teamfight readability: minion and tower shots are background (smaller, dimmer, no trail, drawn underneath); hero abilities
  // draw on top of everything (layer 6). Background fades further next to a hero, and additive glows that pile up on the same
  // tile are thinned out so the middle of a fight doesn't burn white.
  let layer = 5, fighters = [], crowd = new Map();
  const nearHero = (x, y) => fighters.some(u => (u.x - x) ** 2 + (u.y - y) ** 2 < 9);
  const stack = (x, y) => { const c = Math.floor(x) + ',' + Math.floor(y), n = (crowd.get(c) || 0) + 1; crowd.set(c, n); return n <= 2 ? 1 : Math.max(0.35, Math.pow(0.7, n - 2)); };
  const VS = 'varying vec2 vUv; uniform vec4 uvr; void main(){ vUv = uvr.xy + uv * uvr.zw; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
  const FS = 'uniform sampler2D map; uniform vec3 tint; uniform float mode; uniform float fade; varying vec2 vUv;' +
    'void main(){ vec4 t = texture2D(map, vUv); vec4 c;' +
    ' if (mode < 0.5) c = vec4(t.rgb * tint, t.a); else if (mode < 1.5) c = vec4(tint, t.a); else if (mode < 2.5) c = vec4(tint, t.r);' +
    ' else c = vec4(tint * (0.35 + 0.9 * max(t.r, max(t.g, t.b))), t.a); gl_FragColor = vec4(c.rgb, c.a * fade); }';
  const V3 = new THREE.Vector3();
  function quad(o) { // o: t tex, m mode, c tint, a fade, add, bg (background layer), x/y/z (three space), rot (around y), l length, w width, up (camera-facing), uv [ox,oy,sx,sy]
    let q = pool[used];
    if (!q) { q = new THREE.Mesh(flatGeo, new THREE.ShaderMaterial({ uniforms: { map: { value: null }, tint: { value: new THREE.Vector3() }, mode: { value: 0 }, fade: { value: 1 }, uvr: { value: new THREE.Vector4(0, 0, 1, 1) } },
      vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: THREE.DoubleSide })); q.renderOrder = 5; (fxRenderer ? fxScene : scene).add(q); pool.push(q); }
    used++; const u = q.material.uniforms; q.visible = true; q.renderOrder = o.bg ? 4 : layer;
    u.map.value = o.T || tex(o.t); u.tint.value.set(...(o.c || [1, 1, 1])); u.mode.value = o.m || 0; u.fade.value = o.a === undefined ? 1 : Math.max(0, o.a);
    u.uvr.value.set(...(o.uv || [0, 0, 1, 1])); q.material.blending = o.add ? THREE.AdditiveBlending : THREE.NormalBlending;
    q.geometry = o.up ? upGeo : flatGeo; q.position.set(o.x, o.y, o.z); q.scale.set(o.l, o.up ? o.w : 1, o.up ? 1 : o.w);
    if (o.up) { q.quaternion.copy(camera.quaternion); if (o.rot) q.rotateZ(o.rot); } else { q.quaternion.identity(); q.rotation.y = o.rot || 0; }
    return q;
  }
  // a quad stretched from game point a to game point b (head of the texture at b)
  const ribbon = (a, b, h, w, o) => { const dx = b.x - a.x, dy = b.y - a.y; return quad({ ...o, x: (a.x + b.x) / 2, y: h, z: -(a.y + b.y) / 2, rot: Math.atan2(dy, dx), l: Math.max(0.01, Math.hypot(dx, dy)), w }); };
  const teamCol = u => (u.team === K.PLAYER_TEAM ? ALLY : ENEMY);

  // --- particles: sparks, embers, smoke, dust, debris, petals and decals, drawn through the quad pool on top of the textures.
  // Procedural soft textures (canvas) so they blend with any tint; game-space position (x, y) plus height h; sparks stretch along
  // their screen motion; flat ones lie on the ground (shockwave rings, scorch marks).
  const PTEX = {}, parts = [], acc = new WeakMap(), seenFx = new WeakSet(), liveFx = new Map(), rnd = (a, b) => a + Math.random() * (b - a);
  function ptex(kind) {
    if (PTEX[kind]) return PTEX[kind];
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), rg = (r0, stops) => { const gr = x.createRadialGradient(32, 32, 0, 32, 32, r0); stops.forEach(([o, a]) => gr.addColorStop(o, `rgba(255,255,255,${a})`)); return gr; };
    if (kind === 'dot') { x.fillStyle = rg(32, [[0, 1], [0.25, 0.85], [1, 0]]); x.fillRect(0, 0, 64, 64); }
    if (kind === 'spark') { x.translate(32, 32); x.scale(1, 0.22); x.fillStyle = rg(32, [[0, 1], [0.35, 0.9], [1, 0]]); x.fillRect(-32, -150, 64, 300); }
    if (kind === 'smoke') for (let i = 0; i < 7; i++) { const a = i * 0.9, r = 9 + (i % 3) * 4, cx = 32 + Math.cos(a) * 9, cy = 32 + Math.sin(a) * 9, gr = x.createRadialGradient(cx, cy, 0, cx, cy, r + 8);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); }
    if (kind === 'ring') { x.strokeStyle = '#fff'; for (let i = 0; i < 6; i++) { x.globalAlpha = [0.15, 0.35, 0.8, 1, 0.5, 0.2][i]; x.lineWidth = 2; x.beginPath(); x.arc(32, 32, 24 + i * 1.6, 0, 7); x.stroke(); } }
    if (kind === 'shard') { x.fillStyle = '#fff'; x.beginPath(); x.moveTo(20, 14); x.lineTo(46, 22); x.lineTo(50, 44); x.lineTo(26, 52); x.lineTo(14, 34); x.fill(); }
    if (kind === 'star') { x.fillStyle = '#fff'; x.beginPath(); for (let i = 0; i < 20; i++) { const a = i / 20 * 6.283 - 1.57, r = i % 2 ? 11 : [30, 22, 27, 19, 31, 24, 28, 20, 29, 23][i / 2]; x.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); } x.fill(); }
    if (kind === 'thorns') { x.fillStyle = '#fff'; x.beginPath(); for (let i = 0; i <= 48; i++) { const a = i / 48 * 6.283, r = i % 2 ? 31 : 22 + (i % 4) * 1.5; x.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); } x.globalAlpha = 0.9; x.fill(); x.globalCompositeOperation = 'destination-out'; x.globalAlpha = 1;
      const gr = x.createRadialGradient(32, 32, 0, 32, 32, 22); gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.8, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); }
    if (kind === 'comet') { const gr = x.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,1)');
      x.fillStyle = gr; x.beginPath(); x.moveTo(0, 30); x.quadraticCurveTo(40, 8, 60, 14); x.quadraticCurveTo(66, 32, 60, 50); x.quadraticCurveTo(40, 56, 0, 34); x.fill(); }
    if (kind === 'spikes') { x.fillStyle = '#fff'; x.beginPath(); x.moveTo(6, 32); [[-0.9, 20], [-0.75, 34], [-0.5, 24], [-0.3, 40], [-0.1, 28], [0.08, 46], [0.25, 30], [0.45, 42], [0.65, 26], [0.85, 32], [1, 18]].forEach(([a, r]) => x.lineTo(6 + Math.cos(a) * r * 1.2, 32 + Math.sin(a) * r)); x.closePath(); x.fill(); }
    if (kind === 'arc') { x.lineCap = 'round'; for (let i = 0; i < 24; i++) { const f = i / 23; x.strokeStyle = `rgba(255,255,255,${f * f})`; x.lineWidth = 2 + 5 * f; x.beginPath(); x.arc(32, 32, 26, -1.2 + f * 1.8 - 0.09, -1.2 + f * 1.8); x.stroke(); } } // a blade sweep: faint tail to a bright head
    if (kind === 'tri') { x.strokeStyle = '#fff'; x.lineWidth = 6; x.lineJoin = 'round'; x.fillStyle = 'rgba(255,255,255,0.25)'; x.beginPath(); x.moveTo(32, 6); x.lineTo(58, 54); x.lineTo(6, 54); x.closePath(); x.fill(); x.stroke(); }
    if (kind === 'lance') { x.fillStyle = rg(34, [[0, 0.5], [1, 0]]); x.fillRect(0, 0, 64, 64); x.fillStyle = '#fff'; x.beginPath(); x.moveTo(63, 32); x.lineTo(30, 24); x.lineTo(2, 32); x.lineTo(30, 40); x.closePath(); x.fill(); } // Aery's crystal arrowhead, pointing +x
    if (kind === 'lotus') { x.fillStyle = '#fff'; x.beginPath(); x.moveTo(32, 60); // Ginette's passive: a crystal lotus, pointed petals fanning up from the base
      [[-1.45, 26], [-1.15, 30], [-0.85, 24], [-0.55, 31], [-0.25, 27], [0, 32], [0.25, 27], [0.55, 31], [0.85, 24], [1.15, 30], [1.45, 26]].forEach(([a, r], i) => { const b = a + (i ? -0.15 : 0);
        x.lineTo(32 + Math.sin(b) * r * 0.55, 60 - Math.cos(b) * r * 0.55); x.lineTo(32 + Math.sin(a) * r, 60 - Math.cos(a) * r); }); x.closePath(); x.globalAlpha = 0.75; x.fill();
      x.globalAlpha = 1; const gr = x.createRadialGradient(32, 42, 0, 32, 42, 20); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); }
    if (kind === 'note' || kind === 'heart') { x.fillStyle = '#fff'; x.font = 'bold 50px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(kind === 'note' ? '\u266A' : '\u2665', 32, 34); } // Pearl's Encore
    if (kind === 'petal') { x.fillStyle = rg(30, [[0, 1], [0.7, 0.9], [1, 0]]); x.beginPath(); x.ellipse(32, 32, 30, 14, 0.5, 0, 7); x.fill(); }
    const t = new THREE.CanvasTexture(c); return PTEX[kind] = t;
  }
  // o: tex, n, at {x,y,h}, sp [min,max] ground speed, up [min,max] vertical speed, life [min,max], s [start,end] size, c, c2 (end colour),
  // a alpha, add, g gravity, drag, spin, flat, stretch (sparks), dir (radians, with cone) for a directed spray, ring (spawn on a circle of this radius)
  function burst(o) {
    for (let i = 0; i < (o.n || 1); i++) {
      if (parts.length > 700) parts.shift();
      const a = o.dir !== undefined ? o.dir + rnd(-(o.cone || 0.5), o.cone || 0.5) : rnd(0, 6.283), v = rnd(...(o.sp || [0, 0])), r0 = o.ring ? o.ring * rnd(0.85, 1.05) : 0;
      parts.push({ x: o.at.x + Math.cos(a) * r0 + rnd(-(o.jit || 0), o.jit || 0), y: o.at.y + Math.sin(a) * r0 + rnd(-(o.jit || 0), o.jit || 0), h: (o.at.h || 0.5) + rnd(-(o.hj || 0), o.hj || 0),
        vx: Math.cos(a) * v + (o.vx || 0), vy: Math.sin(a) * v + (o.vy || 0), vh: rnd(...(o.up || [0, 0])), t: 0, life: rnd(...(o.life || [0.4, 0.6])), s: o.s || [0.3, 0],
        c: o.c || [1, 1, 1], c2: o.c2, a: o.a === undefined ? 1 : o.a, add: o.add !== false, g: o.g || 0, drag: o.drag || 0, rot: rnd(0, 6.283), vr: o.spin ? rnd(-o.spin, o.spin) : 0,
        T: ptex(o.tex || 'dot'), flat: o.flat, stretch: o.stretch || 0, bounce: o.bounce });
    }
  }
  function every(key, rate, dt, f) { let a = (acc.get(key) || 0) + rate * dt; while (a >= 1) { f(); a--; } acc.set(key, a); } // steady emission
  const once = (key, f) => { if (key && !seenFx.has(key)) { seenFx.add(key); f(); } };
  function drawParticles(dt) {
    const cr = K.VIEW && K.VIEW.y < 0 ? -1 : 1, ys = K.YS;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; p.t += dt; if (p.t >= p.life) { parts.splice(i, 1); continue; }
      const dr = Math.max(0, 1 - p.drag * dt); p.vx *= dr; p.vy *= dr; p.vh = p.vh * dr - p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.h += p.vh * dt; p.rot += p.vr * dt;
      if (p.h < 0.03 && !p.flat) { p.h = 0.03; if (p.bounce) { p.vh = -p.vh * 0.35; p.vx *= 0.6; p.vy *= 0.6; } else p.vh = 0; }
      const k = p.t / p.life, s = (p.s[0] + (p.s[1] - p.s[0]) * k) * (p.T === PTEX.dot ? 1.5 : 1), fa = p.a * Math.min(1, k * 10) * (1 - k * k), c = p.c2 ? p.c.map((v, j) => v + (p.c2[j] - v) * k) : p.c;
      if (p.flat) { quad({ T: p.T, m: 1, c, add: p.add, a: fa, x: p.x, y: p.h, z: -p.y, l: s, w: s, rot: p.rot }); continue; }
      let l = s, w = s, rot = p.rot;
      if (p.stretch) { const sx = p.vx * cr, sy = p.vy * ys * cr + p.vh * 0.85, sp = Math.hypot(sx, sy); rot = Math.atan2(sy, sx); l = s * (1 + Math.min(4, sp * p.stretch)); }
      quad({ T: p.T, m: 1, c, add: p.add, a: fa, x: p.x, y: p.h, z: -p.y, l, w, up: true, rot });
    }
  }
  // jagged lightning between two game points, re-rolled 20 times a second: a wide coloured glow plus a white core per segment
  function zap(a, b, h, w, c, al, seed) {
    const n = Math.max(4, Math.round(Math.hypot(b.x - a.x, b.y - a.y) * 3)), nx = -(b.y - a.y), ny = b.x - a.x, nl = Math.hypot(nx, ny) || 1, fr = Math.floor(performance.now() / 50) + seed * 31;
    const hash = i => { const v = Math.sin((i + fr) * 127.1 + seed * 311.7) * 43758.5453; return v - Math.floor(v) - 0.5; };
    let prev = a;
    for (let i = 1; i <= n; i++) {
      const t = i / n, off = i === n ? 0 : hash(i) * 0.55 * Math.sin(t * Math.PI), pt = { x: a.x + (b.x - a.x) * t + nx / nl * off, y: a.y + (b.y - a.y) * t + ny / nl * off };
      ribbon(prev, pt, h, w * 4, { t: 'tx_lensflare_default', m: 2, c, add: true, a: al * 0.8, uv: [0.3, 0, 0.4, 1] });
      ribbon(prev, pt, h + 0.01, w * 1.3, { t: 'tx_lensflare_default', m: 2, c: [1, 1, 1], add: true, a: al, uv: [0.3, 0, 0.4, 1] });
      prev = pt;
    }
  }
  let lastFx = 0, R3Ddt = 0;
  function beam(a, ha, b, hb, w, o) {
    const cr = K.VIEW && K.VIEW.y < 0 ? -1 : 1, ce = Math.cos(Math.asin(K.YS)), dx = b.x - a.x, sy = (b.y - a.y) * K.YS + (hb - ha) * ce;
    quad({ ...o, x: (a.x + b.x) / 2, y: (ha + hb) / 2, z: -(a.y + b.y) / 2, up: true, rot: Math.atan2(sy * cr, dx * cr), l: Math.max(0.01, Math.hypot(dx, sy)), w });
  }
  // towers (Rickard's video of the original): a thin aiming line onto their target that brightens as the shot loads, then a thick laser
  // beam from the crystal for the shot itself, a flash at the crystal and sparks where it hits
  const bulls = new Map(), towerBeams = new Map(), towerCd = new WeakMap(), TOWER_H = 1.6;
  function drawTowers(g, now, dt) {
    for (const u of g.units) {
      if (u.kind !== 'tower' || !u.alive) continue;
      const c = towerCd.get(u) || { prev: 0, cd: 1 }; if (u.atkTimer < c.prev - 0.05) c.cd = Math.max(0.3, c.prev); c.prev = u.atkTimer; towerCd.set(u, c);
      const t = u.target; if (!t || !t.alive || !K.visible(t)) continue;
      const k = Math.min(1, u.atkTimer / c.cd), hero = t.kind === 'hero', col = teamCol(u), al = (hero ? 1 : 0.45) * (0.3 + 0.6 * k * k);
      beam(u, TOWER_H, t, 0.5, 0.05 + 0.04 * k, { t: 'tx_lensflare_default', m: 2, c: col, add: true, a: al, uv: [0.3, 0, 0.4, 1] });
      quad({ t: 'tx_flash_circleFade', m: 1, c: col, add: true, a: al * 0.8, x: t.x, y: 0.05, z: -t.y, l: 0.7 + 0.15 * Math.sin(now * 12), w: 0.7 + 0.15 * Math.sin(now * 12) }); // target marker
    }
    for (const [p, e] of towerBeams) {
      if (e.seen !== now && !e.dead) e.dead = now;
      const age = e.dead ? now - e.dead : now - e.born, f = e.dead ? 1 - age / 0.25 : 1; if (f <= 0) { towerBeams.delete(p); continue; }
      const sw = e.dead ? 1 : Math.min(1, (now - e.born) / 0.06), tg = { x: e.tx, y: e.ty };
      beam(e.tw, TOWER_H, tg, 0.5, 1.0 * sw * (0.6 + 0.4 * f), { t: 'tx_lensflare_default', m: 2, c: e.c, add: true, a: f, uv: [0.3, 0, 0.4, 1] });
      beam(e.tw, TOWER_H + 0.01, tg, 0.51, 0.3 * sw, { t: 'tx_lensflare_default', m: 2, c: [1, 0.95, 0.95], add: true, a: f, uv: [0.3, 0, 0.4, 1] });
      quad({ t: 'tx_lensflare_default', m: 2, c: e.c, add: true, a: f, x: e.tw.x, y: TOWER_H, z: -e.tw.y, l: 1.4, w: 1.4, up: true }); // muzzle flash on the crystal
      if (e.dead) once(e, () => { burst({ n: 14, at: { x: e.tx, y: e.ty, h: 0.5 }, sp: [1.5, 4], up: [0, 2.5], g: 4, drag: 2, life: [0.15, 0.35], s: [0.14, 0.03], c: [1, 0.9, 0.9], c2: e.c, stretch: 0.3 });
        burst({ at: { x: e.tx, y: e.ty, h: 0.5 }, life: [0.25, 0.25], s: [0.6, 1.8], c: e.c }); });
    }
  }
  let rocketSide = 0;
  function drawShots(g) {
    const now = performance.now() / 1000; layer = 6;
    const dt = Math.min(0.05, Math.max(0, now - (lastFx || now))); lastFx = now; R3Ddt = dt;
    misFrame++;
    for (const [p, m] of misfires) if (m.rocket && m.f < misFrame - 1) { misfires.delete(p); const at = { x: m.x, y: m.y, h: 0.45 }; // rocket hit: orange blast, smoke and sparks
      burst({ at, life: [0.25, 0.25], s: [0.8, 2], c: [1, 0.7, 0.25], tex: 'star' }); burst({ at: { ...at, h: 0.47 }, life: [0.18, 0.18], s: [0.5, 1.2], c: [1, 1, 0.8], tex: 'star' });
      burst({ n: 14, at, sp: [1.5, 4], up: [0.5, 3], g: 6, drag: 1.5, life: [0.2, 0.45], s: [0.15, 0.03], c: [1, 0.95, 0.7], c2: [1, 0.45, 0.1], stretch: 0.25 });
      burst({ n: 6, at, ring: 0.2, sp: [0.4, 1.2], up: [0.3, 1], drag: 2, life: [0.6, 1], s: [0.4, 1.1], c: [0.35, 0.32, 0.3], a: 0.6, add: false, tex: 'smoke', spin: 1.5 }); }
    for (const [p, m] of misfires) if (m.f < misFrame - 1) { misfires.delete(p); // landed: a small white-gold pop on the target
      burst({ n: 12, at: { x: m.x, y: m.y, h: 0.6 }, sp: [1, 3], up: [0, 1.5], drag: 3, life: [0.15, 0.3], s: [0.14, 0.03], c: [1, 1, 0.8], c2: [0.6, 1, 0.4], stretch: 0.3 });
      burst({ at: { x: m.x, y: m.y, h: 0.6 }, life: [0.2, 0.2], s: [0.5, 1.4], c: [1, 0.95, 0.6] }); }
    for (const p of g.projectiles) {
      const s = p.src; if (!s) continue;
      if (!p.joker && s.code === 'Joker' && s.specialActive && p.tgt && p.travel && p.t >= 0) { // Remote Demolition: a rocket from one of the turret's pods, lobbed onto the target on a smoke trail
        let m = misfires.get(p); const T = heroObjs.get(s) && heroObjs.get(s).userData.turret;
        if (!m) { const A = HERO_ANIM.Joker.turret, i = (rocketSide = 1 - rocketSide), pd = A.pods[i], v = new THREE.Vector3(pd[0], pd[1], pd[2]).multiplyScalar(H3.figs[A.fig].h * 1.8);
          if (T && T.visible) T.localToWorld(v); else v.set(s.x, 0.7, -s.y);
          m = { ox: v.x, oy: -v.z, oh: v.y, rocket: true, trail: [] }; misfires.set(p, m);
          burst({ n: 8, at: { x: m.ox, y: m.oy, h: m.oh }, sp: [0.5, 1.5], up: [0, 1], drag: 3, life: [0.15, 0.3], s: [0.3, 0.05], c: [1, 0.95, 0.6], c2: [1, 0.5, 0.15] });
          burst({ n: 5, at: { x: m.ox, y: m.oy, h: m.oh }, sp: [0.2, 0.8], up: [0.2, 0.8], drag: 2, life: [0.5, 0.9], s: [0.35, 0.9], c: [0.8, 0.78, 0.75], a: 0.5, add: false, tex: 'smoke', spin: 2 }); }
        const k = Math.min(1, p.t / p.travel), tx = p.tgt.x, ty = p.tgt.y, e = k, x = m.ox + (tx - m.ox) * e, y = m.oy + (ty - m.oy) * e, h = m.oh * (1 - k) + 0.5 * k + Math.sin(k * Math.PI) * Math.min(1.8, 0.5 + Math.hypot(tx - m.ox, ty - m.oy) * 0.25);
        const pv = m.last || { x: m.ox, y: m.oy, h: m.oh }; m.last = { x, y, h }; m.f = misFrame; m.x = tx; m.y = ty;
        const dx = x - pv.x, dy = y - pv.y, dh = h - pv.h, dl = Math.hypot(dx, dy, dh) || 1, back = { x: x - dx / dl * 0.6, y: y - dy / dl * 0.6 }, bh = h - dh / dl * 0.6;
        beam(back, bh, { x, y }, h, 0.3, { T: ptex('lance'), m: 1, c: [1, 0.85, 0.6], add: false, a: 1 }); // the rocket
        beam(back, bh + 0.01, { x, y }, h + 0.01, 0.14, { T: ptex('lance'), m: 1, c: [1, 1, 1], add: true, a: 0.8 });
        quad({ t: 'tx_flash_circleFade', m: 1, c: [1, 0.55, 0.15], add: true, x: back.x, y: bh, z: -back.y, l: 0.8 + 0.15 * Math.sin(now * 40), w: 0.8, up: true }); // exhaust flame
        quad({ T: ptex('dot'), m: 1, c: [1, 0.95, 0.7], add: true, x: back.x, y: bh, z: -back.y, l: 0.22, w: 0.22, up: true });
        every(m.trail, 70, dt, () => burst({ at: { x: back.x, y: back.y, h: bh }, jit: 0.04, sp: [0, 0.15], up: [0.05, 0.3], drag: 1, life: [0.45, 0.7], s: [0.18, 0.5], c: [0.85, 0.83, 0.8], a: 0.55, add: false, tex: 'smoke', spin: 2 }));
        quad({ T: ptex('tri'), m: 1, c: [1, 0.6, 0.3], add: true, a: 0.75, x: tx, y: 0.05, z: -ty, l: 1.1, w: 1.1, rot: 0 }); // target mark
        continue;
      }
      if ((p.joker || (s.code === 'Joker' && s.specialActive)) && p.tgt && p.travel && p.t >= 0) { // ROI17's shots (Misfire, Remote Demolition): a green comet that
        // bursts out of his back, swings out on a curve and homes in on the target, which is marked with a green triangle (Rickard's reference GIF)
        let m = misfires.get(p); if (!m) { m = { ox: s.x, oy: s.y, side: Math.random() < 0.5 ? -1 : 1, trail: [] }; misfires.set(p, m);
          burst({ n: 14, at: { x: s.x, y: s.y, h: 1.2 }, jit: 0.15, sp: [0.3, 1.2], up: [1, 3], drag: 2, life: [0.25, 0.5], s: [0.35, 0.05], c: [0.85, 1, 0.6], c2: [0.3, 1, 0.3], stretch: 0.2 }); }
        const k = Math.min(1, p.t / p.travel), tx = p.tgt.x, ty = p.tgt.y, dx = tx - m.ox, dy = ty - m.oy, L = Math.hypot(dx, dy) || 1, bend = Math.sin(k * Math.PI) * Math.min(2.2, L * 0.45) * m.side;
        const e = k * k * (3 - 2 * k), x = m.ox + dx * e - dy / L * bend, y = m.oy + dy * e + dx / L * bend, h = 1.2 + Math.sin(k * Math.PI) * 1.2 - k * 0.6;
        m.f = misFrame; m.x = tx; m.y = ty; m.trail.push({ x, y, h }); if (m.trail.length > 12) m.trail.shift();
        m.trail.forEach((q, i) => { const f = (i + 1) / m.trail.length; quad({ T: ptex('dot'), m: 1, c: [0.45, 1, 0.45], add: true, a: f * 0.7, x: q.x, y: q.h, z: -q.y, l: 0.5 * f, w: 0.5 * f, up: true }); });
        quad({ t: 'tx_flash_circleFade', m: 1, c: [0.5, 1, 0.45], add: true, x, y: h, z: -y, l: 0.9, w: 0.9, up: true });
        quad({ T: ptex('dot'), m: 1, c: [0.95, 1, 0.85], add: true, x, y: h, z: -y, l: 0.35, w: 0.35, up: true });
        quad({ T: ptex('tri'), m: 1, c: [0.55, 1, 0.5], add: true, a: 0.85, x: tx, y: 0.05, z: -ty, l: 1.1, w: 1.1, rot: 0 });
        continue;
      }
      if (p.fx === 'hook' && p.t >= 0) { // AnglerProjectile: orange hook head on a teal goo line back to Bufo
        ribbon(s, p, 0.5, 0.35, { t: 'tx_angler_default_projectileLineSecondary', m: 2, c: [0.2, 1, 0.88], a: 0.9 });
        const a = p.ang; quad({ t: 'tx_angler_default_projectileLine', c: [1, 0.5, 0.2], x: p.x - Math.cos(a) * 0.35, y: 0.5, z: -(p.y - Math.sin(a) * 0.35), rot: a, l: 1.2, w: 0.6 });
        liveFx.set(p, { kind: 'hook', x: p.x, y: p.y, seen: now });
        every(p, 30, dt, () => burst({ at: { x: p.x, y: p.y, h: 0.5 }, sp: [0.2, 0.8], up: [0.5, 1.5], g: 6, life: [0.35, 0.6], s: [0.16, 0.06], c: [0.3, 1, 0.85], c2: [0.1, 0.6, 0.5], add: false, bounce: true }));
        continue;
      }
      if (p.fx === 'arrow') { // MagicArrowProjectile (reference GIF): a crystal lance head on long cyan streaks
        if (p.t < 0) { quad({ t: 'tx_hit_rSetter', m: 1, c: [0.4, 1, 1], add: true, a: 0.8, x: s.x, y: 0.6, z: -s.y, l: 0.9 * (1 + p.t * 2), w: 0.9 * (1 + p.t * 2), up: true, uv: [0, 0.5, 0.5, 0.5], rot: now * 6 }); continue; }
        const a = p.ang, ca = Math.cos(a), sa = Math.sin(a), nx = -sa, ny = ca, back = Math.min(3.4, (p.d || 0) + 0.6), hd = { x: p.x + ca * 0.5, y: p.y + sa * 0.5 }, P2 = (b, o) => ({ x: p.x - ca * b + nx * o, y: p.y - sa * b + ny * o });
        beam(P2(back, 0), 0.5, hd, 0.5, 1.1, { T: ptex('comet'), m: 1, c: [0.1, 0.75, 1], add: true, a: 0.75 });
        beam(P2(back * 0.6, 0), 0.51, hd, 0.51, 0.45, { T: ptex('comet'), m: 1, c: [0.8, 1, 1], add: true, a: 0.9 });
        [-0.32, 0.3].forEach((o, i) => beam(P2(back * (0.75 - i * 0.15), o), 0.5, P2(0.3, o * 0.6), 0.5, 0.16, { T: ptex('comet'), m: 1, c: [0.5, 0.95, 1], add: true, a: 0.55 }));
        beam(P2(0.9, 0), 0.53, { x: p.x + ca * 0.75, y: p.y + sa * 0.75 }, 0.53, 0.8, { T: ptex('lance'), m: 1, c: [0.45, 0.95, 1], add: true, a: 1 });
        beam(P2(0.5, 0), 0.54, { x: p.x + ca * 0.65, y: p.y + sa * 0.65 }, 0.54, 0.35, { T: ptex('lance'), m: 1, c: [1, 1, 1], add: true, a: 1 });
        liveFx.set(p, { kind: 'arrow', x: p.x, y: p.y, a, seen: now });
        every(p, 70, dt, () => burst({ at: { x: p.x - ca * 0.5, y: p.y - sa * 0.5, h: 0.5 }, jit: 0.15, hj: 0.1, sp: [0, 0.4], up: [-0.2, 0.6], life: [0.25, 0.5], s: [0.16, 0], c: [0.7, 1, 1], c2: [0.1, 0.6, 1] }));
        continue;
      }
      if (p.fx === 'laser') { // LaserProjectile: orange beam with a white core and a burn mark, a flare while charging
        const P = p.P, L = P.Range, end = { x: s.x + Math.cos(p.ang) * L, y: s.y + Math.sin(p.ang) * L };
        if (!p.fired) { const k = Math.min(1, p.t / P.ChargeDelay); quad({ t: 'tx_lensflare_default', m: 2, c: [1, 0.85, 0.5], add: true, x: s.x + Math.cos(p.ang) * 0.4, y: 0.6, z: -(s.y + Math.sin(p.ang) * 0.4), l: 2.5 * k, w: 2.5 * k, up: true }); continue; }
        const k = Math.min(1, p.showT / 0.5), w = P.FullScaleWidth * k, st = { x: p.x, y: p.y };
        ribbon(st, end, 0.03, P.FullScaleWidth * 1.1, { t: 'tx_general_projectileLine_fade', m: 2, c: [0.05, 0.02, 0.02], a: 0.45 });
        ribbon(st, end, 0.5, w * 7, { t: 'tx_lensflare_default', m: 2, c: [1, 0.55, 0.25], add: true, uv: [0.3, 0, 0.4, 1] });
        ribbon(st, end, 0.52, w * 3.5, { t: 'tx_lensflare_default', m: 2, c: [1, 1, 0.85], add: true, uv: [0.3, 0, 0.4, 1] });
        every(p, 60, dt, () => burst({ at: { x: st.x + Math.cos(p.ang) * 0.5, y: st.y + Math.sin(p.ang) * 0.5, h: 0.5 }, sp: [1.5, 4], up: [0, 2], dir: p.ang, cone: 0.6, g: 5, life: [0.2, 0.4], s: [0.14, 0.04], c: [1, 0.95, 0.7], c2: [1, 0.4, 0.1], stretch: 0.25 }));
        every(p.P, 40, dt, () => { const t = Math.random() * L; burst({ at: { x: st.x + Math.cos(p.ang) * t, y: st.y + Math.sin(p.ang) * t, h: 0.5 }, jit: 0.15, sp: [0, 0.3], up: [0.3, 1], life: [0.4, 0.8], s: [0.16, 0], c: [1, 0.7, 0.3], c2: [1, 0.2, 0.05] }); });
        continue;
      }
      if (p.fx === 'bramble') { // Bramble Blossom (Rickard's reference GIF): a pink blossom opens on the target, a dark teal leaf rosette inside a lime thorn ring,
        // lime spikes flick out of it over a wide translucent pink disc, and at the end the thorn ring shrinks away
        const r = p.P.DamageRange, live = p.t >= 0, tot = p.P.DamageTickCount * p.P.DamageTickDuration, e = live ? Math.min(1, p.t / tot) : 0, LIME = [0.75, 1, 0.3], PINK = [1, 0.4, 0.7];
        if (!live) { const w = Math.min(1, 1 + p.t / (p.P.WarningDuration || 0.4)); quad({ t: 'tx_flash_circleFade', m: 1, c: PINK, add: true, a: 0.35 * w, x: p.x, y: 0.04, z: -p.y, l: r * 2.2 * w, w: r * 2.2 * w }); continue; }
        once(p, () => { const at = { x: p.x, y: p.y, h: 0.06 };
          burst({ at, flat: true, life: [0.45, 0.45], s: [r * 1.2, r * 2.8], c: [1, 0.85, 0.95], c2: PINK, tex: 'ring' }); // the blossom's white-pink rim opening
          burst({ at: { ...at, h: 0.05 }, flat: true, life: [0.5, 0.5], s: [r * 1.8, r * 2.4], c: PINK, a: 0.8, tex: 'thorns', spin: 1 });
          burst({ n: 14, at: { x: p.x, y: p.y, h: 0.4 }, ring: r * 0.4, sp: [1.5, 3.5], up: [0.5, 2], g: 3, drag: 2, life: [0.4, 0.7], s: [0.22, 0.08], c: [1, 0.65, 0.85], tex: 'petal', spin: 6, add: false }); });
        const fade = e < 0.8 ? 1 : (1 - e) / 0.2, ring = e < 0.8 ? 1 : 0.4 + 0.6 * fade, pul = 1 + 0.05 * Math.sin(now * 9);
        quad({ t: 'tx_flash_circleFade', m: 1, c: PINK, add: true, a: 0.3 * fade, x: p.x, y: 0.04, z: -p.y, l: r * 2.6, w: r * 2.6 }); // the wide pink disc
        quad({ T: ptex('star'), m: 1, c: [0.08, 0.35, 0.38], add: false, a: 0.8 * Math.max(0, 1 - e * 2.5), x: p.x, y: 0.05, z: -p.y, l: r * 1.9, w: r * 1.9, rot: 0.3 }); // dark teal leaves, early on
        quad({ T: ptex('thorns'), m: 1, c: LIME, add: true, a: 0.6 * fade, x: p.x, y: 0.06, z: -p.y, l: r * 1.45 * ring * pul, w: r * 1.45 * ring * pul, rot: -now * 0.6 });
        quad({ T: ptex('ring'), m: 1, c: [0.9, 1, 0.6], add: true, a: 0.6 * fade, x: p.x, y: 0.065, z: -p.y, l: r * 1.6 * ring, w: r * 1.6 * ring });
        every(p, 7, dt, () => { const a = rnd(0, 6.283); burst({ n: 3, at: { x: p.x, y: p.y, h: 0.25 }, dir: a, cone: 0.25, sp: [5, 8], up: [0, 0.6], drag: 3, life: [0.15, 0.3], s: [0.22, 0.05], c: [1, 1, 0.6], c2: LIME, stretch: 0.6 }); }); // lime spikes
        every(p.P, 12, dt, () => burst({ at: { x: p.x, y: p.y, h: 0.2 }, ring: r * rnd(0.3, 1.1), up: [0.4, 1], life: [0.5, 0.9], s: [0.12, 0], c: [1, 0.85, 0.9] })); // sparkles over the disc
        continue;
      }
      if (p.fx === 'meteor') { // Explosive Rift (fx_sorcerer_special, Rickard's reference GIF): a pink disc charges up with rings pulling inward,
        // blue/purple/pink wisps swirling round the rim and sparks flicking out, then it collapses to a white ring (the blast is the 'boom' fx)
        const r = p.warn, k = Math.min(1, Math.max(0, 1 + p.t / p.warnMax)), end = Math.max(0, (k - 0.85) / 0.15), z = -p.y, PINK = [1, 0.32, 0.5];
        quad({ t: 'tx_flash_circleFade', m: 1, c: PINK, add: true, a: (0.25 + 0.75 * k) * (1 - end * 0.6), x: p.x, y: 0.04, z, l: r * 2.1, w: r * 2.1 });
        for (let i = 0; i < 3; i++) { const f = ((now * 1.3 + i / 3) % 1), rr = r * (1 - f * 0.75) * (1 - end * 0.5); // rings sliding in toward the centre
          quad({ T: ptex('ring'), m: 1, c: [1, 0.55, 0.7], add: true, a: Math.sin(f * Math.PI) * (0.35 + 0.5 * k), x: p.x, y: 0.05, z, l: rr * 2.3, w: rr * 2.3 }); }
        const cr = end > 0 ? r * (0.55 - 0.45 * end) : r * (0.25 + 0.3 * k); // the bright inner ring grows as it charges, then snaps shut
        quad({ T: ptex('ring'), m: 1, c: end > 0 ? [1, 0.95, 0.95] : [1, 0.6, 0.75], add: true, a: 0.6 + 0.4 * k + end, x: p.x, y: 0.06, z, l: cr * 2.4, w: cr * 2.4 });
        for (let i = 0; i < 6; i++) { const a = now * (2.2 + (i % 2) * 0.6) + i * 1.047, wr = r * (0.92 + 0.1 * Math.sin(now * 3 + i)) * (1 - end * 0.6), col = [[0.45, 0.6, 1], [0.75, 0.45, 1], [1, 0.45, 0.75]][i % 3];
          quad({ T: ptex('comet'), m: 1, c: col, add: true, a: (0.25 + 0.45 * k) * (1 - end), x: p.x + Math.cos(a) * wr, y: 0.12 + 0.05 * (i % 2), z: z - Math.sin(a) * wr, l: r * 0.9, w: r * 0.45, rot: a - Math.PI / 2 }); }
        every(p, 10 + 30 * k, dt, () => { const a = rnd(0, 6.283); burst({ at: { x: p.x + Math.cos(a) * r * 0.6, y: p.y + Math.sin(a) * r * 0.6, h: 0.15 }, dir: a, cone: 0.15, sp: [2, 4], up: [0, 0.4], drag: 3, life: [0.15, 0.3], s: [0.12, 0.03], c: [1, 0.95, 0.85], c2: [1, 0.5, 0.7], stretch: 0.35 }); });
        continue;
      }
      if (p.custom || p.warn || p.t < 0 || !p.tgt) continue;
      if (s.kind === 'tower') { let e = towerBeams.get(p); if (!e) towerBeams.set(p, e = { tw: s, c: teamCol(s), born: now }); Object.assign(e, { tx: p.tgt.x, ty: p.tgt.y, seen: now }); continue; } // laser, see drawTowers
      const key = p.joker ? 'JokerSpecial' : s.kind === 'tower' ? 'tower' : s.kind === 'minion' ? s.type : s.code, spec = FX[key]; if (!spec) continue;
      let dx = p.tgt.x - p.x, dy = p.tgt.y - p.y; if (Math.hypot(dx, dy) < 0.05) { dx = p.tgt.x - s.x; dy = p.tgt.y - s.y; }
      const big = (p.big ? 1.5 : 1) * 1.8, h = spec.y ? spec.y * (1 - Math.min(1, p.t * 2)) + 0.5 * Math.min(1, p.t * 2) : 0.5; // tower shots drop from the crystal
      let gst = ghosts.get(p); if (!gst) ghosts.set(p, gst = { spec, key, c: spec.team ? teamCol(s) : spec.c, big: big * (spec.team ? 0.6 : s === g.player ? 0.75 : 0.6), mine: s === g.player, ox: s.x, oy: s.y });
      Object.assign(gst, { x: p.x, y: p.y, a: Math.atan2(dy, dx), h, seen: now, dead: 0 });
      if (!gst.trail) gst.trail = []; const lt = gst.trail[gst.trail.length - 1];
      if (!lt || Math.hypot(lt.x - p.x, lt.y - p.y) > 0.12) { gst.trail.push({ x: p.x, y: p.y, h, t: now }); if (gst.trail.length > 10) gst.trail.shift(); }
    }
    for (const [p, e] of liveFx) { if (e.seen === now) continue; liveFx.delete(p); // the shot ended this frame: burst where it was
      if (e.kind === 'arrow') { const at = { x: e.x, y: e.y, h: 0.6 }; // reference GIF: a white-cyan spiky starburst inside a thin ring, then a cyan glow on the ground with motes drifting up
        burst({ at, life: [0.3, 0.3], s: [1.4, 3.2], c: [0.45, 0.95, 1], tex: 'star' }); burst({ at: { ...at, h: 0.62 }, life: [0.22, 0.22], s: [1, 2.2], c: [1, 1, 1], tex: 'star' });
        burst({ at: { x: e.x, y: e.y, h: 0.08 }, flat: true, life: [0.35, 0.35], s: [1.2, 3.6], c: [0.9, 1, 1], a: 0.8, tex: 'ring' });
        burst({ at: { x: e.x, y: e.y, h: 0.06 }, flat: true, life: [0.8, 0.8], s: [2.6, 3], c: [0.1, 0.8, 1], a: 0.55 });
        burst({ n: 18, at: { ...at, h: 0.5 }, dir: e.a, cone: 0.9, sp: [2, 5], up: [0, 2], g: 3, drag: 2, life: [0.2, 0.4], s: [0.18, 0.04], c: [0.85, 1, 1], c2: [0.2, 0.6, 1], stretch: 0.3 });
        burst({ n: 14, at: { ...at, h: 0.3 }, ring: 0.7, sp: [0.1, 0.5], up: [0.4, 1.1], drag: 1, life: [0.9, 1.5], s: [0.13, 0], c: [0.6, 1, 1], c2: [0.2, 0.7, 1] }); }
      if (e.kind === 'hook') burst({ n: 10, at: { x: e.x, y: e.y, h: 0.5 }, sp: [0.8, 2], up: [0.5, 2], g: 7, life: [0.3, 0.6], s: [0.2, 0.08], c: [0.3, 1, 0.85], add: false, bounce: true });
    }
    // every auto attack keeps showing for AFTERGLOW s after it lands (most melee hits only fly for 0.1 s); line attacks are
    // drawn as a streak from where the attacker stood to the head, like LineRenderer attacks
    // Cards face the camera (rotated to the flight direction on screen) instead of lying flat, so they keep their full shape;
    // each has a pulsing additive glow, a fading sparkle trail and a ring burst where it lands.
    layer = 5;
    const cr = K.VIEW && K.VIEW.y < 0 ? -1 : 1, ys = K.YS, scr = (dx, dy) => Math.atan2(dy * ys * cr, dx * cr), slen = (dx, dy) => Math.hypot(dx, dy * ys);
    for (const [p, e] of ghosts) {
      if (e.seen !== now && !e.dead) e.dead = now;
      const age = e.dead ? now - e.dead : 0, f = e.dead ? 1 - age / AFTERGLOW : 1; if (f <= 0) { ghosts.delete(p); continue; }
      if (e.key === 'Brawler' && !e.dead) continue; // Bronson punches: nothing flies, only the pow where the fist lands
      const sp = e.spec, l = sp.l * e.big, w = sp.w * e.big, m = sp.team ? 3 : 0, gc = sp.team ? e.c : GLOW[e.key] || e.c || [1, 1, 1], pulse = 1 + 0.12 * Math.sin(now * 30 + e.ox * 7);
      const at = (x, y, h) => ({ x, y: h, z: -y });
      // auto attacks stay small and quiet so specials are what you see (Rickard): minion/tower faintest, other heroes' attacks
      // a bit stronger, the player's own strongest; only the player's own keeps a short sparkle trail
      const bg = !!sp.team, near = nearHero(e.x, e.y), dim = bg ? (near ? 0.45 : 0.7) : e.mine ? 1 : 0.8, ga = (bg ? 0.25 * dim : e.mine ? 0.55 : 0.3) * stack(e.x, e.y); // ga: glow/trail/ring strength
      if (e.mine) e.trail.forEach((q, i) => { const k = (i + 1) / e.trail.length, fa = f * k * Math.max(0, 1 - (now - q.t) / 0.3); if (fa <= 0.02) return; // sparkle trail behind the head
        quad({ t: 'tx_lensflare_default', m: 2, c: gc, add: true, a: fa * 0.9 * ga, ...at(q.x, q.y, q.h), l: w * (0.6 + 0.9 * k), w: w * (0.6 + 0.9 * k), up: true }); });
      if (e.dead) { const k = age / AFTERGLOW, r = (0.5 + 1.1 * k) * Math.max(l, w); // ring burst on impact
        if (e.key === 'Brawler') once(e, () => { const big = e.mine ? 1 : 0.75, at = { x: e.x, y: e.y, h: e.h }, rot = Math.random() * 0.6 - 0.3; // pow: yellow starburst with a white core, a few sparks
          parts.push({ x: e.x, y: e.y, h: e.h + 0.02, vx: 0, vy: 0, vh: 0, t: 0, life: 0.22, s: [0.5 * big, 1.25 * big], c: [1, 0.85, 0.2], c2: [1, 0.6, 0.1], a: 1, add: false, g: 0, drag: 0, rot, vr: 0, T: ptex('star'), stretch: 0 });
          parts.push({ x: e.x, y: e.y, h: e.h + 0.03, vx: 0, vy: 0, vh: 0, t: 0, life: 0.16, s: [0.35 * big, 0.7 * big], c: [1, 1, 0.9], a: 1, add: true, g: 0, drag: 0, rot: rot + 0.3, vr: 0, T: ptex('star'), stretch: 0 });
          burst({ n: Math.round(8 * big), at, dir: e.a, cone: 1.2, sp: [2.5, 5], up: [0, 1.2], drag: 3, life: [0.1, 0.2], s: [0.12, 0.03], c: [1, 1, 0.8], c2: [1, 0.75, 0.2], stretch: 0.4 }); });
        quad({ t: 'tx_flash_circleFade', m: 1, c: gc, add: true, bg, a: (1 - k) * 0.9 * ga, ...at(e.x, e.y, e.h), l: r * 0.6, w: r * 0.6, up: true });
        if (e.key === 'Brawler') continue; }
      if (e.key === 'Marksman') { // Silver's bullet: the old card was a dark cannonball that vanished on the ground (Rickard), so it flies
        // as a hot tracer: orange streak from the muzzle, white-gold core, sparks off the barrel and a spark splash where it lands
        const sf = e.mine ? 1 : 0.8, hd = { x: e.x, y: e.y }, back = Math.min(1.8, Math.hypot(e.x - e.ox, e.y - e.oy)), tl = { x: e.x - Math.cos(e.a) * back, y: e.y - Math.sin(e.a) * back };
        once(e, () => burst({ n: 7, at: { x: e.ox + Math.cos(e.a) * 0.9, y: e.oy + Math.sin(e.a) * 0.9, h: 1.25 }, dir: e.a, cone: 0.5, sp: [2, 4.5], up: [0, 0.8], drag: 4, life: [0.08, 0.16], s: [0.14, 0.03], c: [1, 1, 0.85], c2: [1, 0.6, 0.15], stretch: 0.35 }));
        if (!e.dead && back > 0.05) { ribbon(tl, hd, e.h, 0.55 * sf, { t: 'tx_general_projectileLine_fade', m: 2, c: [1, 0.55, 0.12], add: true, a: 0.95 * sf });
          ribbon(tl, hd, e.h + 0.01, 0.22 * sf, { t: 'tx_general_projectileLine_fade', m: 2, c: [1, 0.95, 0.7], add: true, a: sf }); }
        quad({ t: 'tx_lensflare_default', m: 2, c: [1, 0.9, 0.55], add: true, a: f * sf, ...at(e.x, e.y, e.h), l: 1.3 * sf, w: 1.3 * sf, up: true });
        if (e.dead) once(e.trail, () => burst({ n: 10, at: { x: e.x, y: e.y, h: e.h }, sp: [1.5, 3.5], up: [0.3, 2], g: 4, drag: 2, life: [0.15, 0.3], s: [0.13, 0.03], c: [1, 0.95, 0.7], c2: [1, 0.45, 0.1], stretch: 0.3 }));
      }
      if (e.key === 'Archer') { // Aery's arrow (reference GIF): a long thin cyan streak with a white core and a small star where it lands
        const sf = e.mine ? 1 : 0.8, hd = { x: e.x, y: e.y }, back = Math.min(2.6, Math.hypot(e.x - e.ox, e.y - e.oy)), tl = { x: e.x - Math.cos(e.a) * back, y: e.y - Math.sin(e.a) * back };
        if (!e.dead && back > 0.05) { ribbon(tl, hd, e.h, 0.4 * sf, { t: 'tx_general_projectileLine_fade', m: 2, c: [0.1, 0.8, 1], add: true, a: 0.95 * sf });
          ribbon(tl, hd, e.h + 0.01, 0.13 * sf, { t: 'tx_general_projectileLine_fade', m: 2, c: [0.85, 1, 1], add: true, a: sf });
          beam({ x: e.x - Math.cos(e.a) * 0.45, y: e.y - Math.sin(e.a) * 0.45 }, e.h + 0.02, { x: e.x + Math.cos(e.a) * 0.12, y: e.y + Math.sin(e.a) * 0.12 }, e.h + 0.02, 0.3 * sf, { T: ptex('lance'), m: 1, c: [0.8, 1, 1], add: true, a: sf }); }
        if (e.dead) once(e.trail, () => { burst({ at: { x: e.x, y: e.y, h: e.h }, life: [0.18, 0.18], s: [0.4 * sf, 0.9 * sf], c: [1, 0.95, 0.7], tex: 'star' });
          burst({ n: 6, at: { x: e.x, y: e.y, h: e.h }, dir: e.a, cone: 1, sp: [1.5, 3.5], up: [0, 1], drag: 3, life: [0.12, 0.25], s: [0.1, 0.02], c: [0.85, 1, 1], c2: [0.2, 0.7, 1], stretch: 0.3 }); });
        continue; }
      const gs = Math.max(l, w) * 1.2; quad({ t: 'tx_lensflare_default', m: 2, c: gc, add: true, bg, a: f * 0.8 * ga, ...at(e.x, e.y, e.h), l: gs, w: gs, up: true }); // glow around the head
      if (sp.spin) { quad({ t: sp.t, m, c: e.c, bg, a: f * dim, ...at(e.x, e.y, e.h), rot: now * 17, l, w, up: true }); continue; }
      const head = { x: e.x + Math.cos(e.a) * l * 0.1, y: e.y + Math.sin(e.a) * l * 0.1 }, dx = head.x - e.ox, dy = head.y - e.oy, len = slen(dx, dy);
      const sa = scr(Math.cos(e.a), Math.sin(e.a));
      if (sp.line && len > l) { const kk = Math.min(1, l * 2.5 / len), tx = head.x - dx * kk, ty = head.y - dy * kk; // streak capped at 2.5 lengths behind the head instead of reaching back to the attacker
        quad({ t: sp.t, m, c: e.c, bg, a: f * dim, ...at((head.x + tx) / 2, (head.y + ty) / 2, e.h), rot: scr(dx, dy), l: len * kk, w: w * pulse, up: true }); }
      else quad({ t: sp.t, m, c: e.c, bg, a: f * dim, ...at(e.x - Math.cos(e.a) * l * 0.4, e.y - Math.sin(e.a) * l * 0.4, e.h), rot: sa, l: l * pulse, w: w * pulse, up: true });
    }
  }
  function drawSpecials(g) { // abilities that live on the hero rather than in a projectile
    const now = performance.now() / 1000;
    const dt = R3Ddt;
    for (const u of g.units) {
      if (u.alive && u.kind !== 'tower' && K.visible(u) && u.statuses && u.has('stun')) { const hh = u.kind === 'hero' ? 1.75 : 1.2, rr = u.kind === 'hero' ? 0.42 : 0.3; // stunned: a golden swirl with little stars circling over the head (Donus reference)
        for (let i = 0; i < 2; i++) quad({ T: ptex('arc'), m: 1, c: [1, 0.82, 0.3], add: true, a: 0.95, x: u.x, y: hh + i * 0.04, z: -u.y, l: rr * 2.3, w: rr * 2.3, rot: now * 7 + i * Math.PI });
        for (let i = 0; i < 2; i++) { const a = now * 4 + i * Math.PI; quad({ T: ptex('star'), m: 1, c: [1, 0.95, 0.6], add: true, a: 1, x: u.x + Math.cos(a) * rr, y: hh + 0.05, z: -u.y - Math.sin(a) * rr * 0.6, l: 0.24, w: 0.24, up: true }); } }
      if (u.kind === 'hero' && u.code === 'Witch' && u.alive && u.witchSaved && K.visible(u) && u.statuses) { const iv = u.statuses.find(x => x.type === 'invulnerable'); // Everbloom (reference GIF): she is sealed in a green crystal lotus with a beam and a pink star above it
        if (iv) { const k = Math.min(1, (3 - iv.t) / 0.25, iv.t / 0.3), pul = 1 + 0.04 * Math.sin(now * 6);
          once(iv, () => { burst({ at: { x: u.x, y: u.y, h: 0.8 }, life: [0.35, 0.35], s: [1, 3], c: [0.6, 1, 0.8], tex: 'star' }); burst({ n: 16, at: { x: u.x, y: u.y, h: 0.7 }, sp: [1, 3], up: [0.5, 2.5], g: 2, drag: 2, life: [0.4, 0.8], s: [0.2, 0.05], c: [1, 0.8, 0.9], c2: [0.5, 1, 0.75], stretch: 0.2 }); });
          quad({ T: ptex('lotus'), m: 1, c: [0.1, 0.85, 0.45], add: false, a: 0.85 * k, x: u.x, y: 0.75, z: -u.y, l: 1.9 * pul * k, w: 1.9 * pul * k, up: true });
          quad({ T: ptex('dot'), m: 1, c: [0.6, 1, 0.85], add: true, a: 0.35 * k, x: u.x, y: 0.75, z: -u.y, l: 1.1, w: 1.1, up: true });
          quad({ T: ptex('star'), m: 1, c: [0.2, 0.75, 0.5], add: true, a: 0.7 * k, x: u.x, y: 0.05, z: -u.y, l: 2.2 * k, w: 2.2 * k, rot: now * 0.5 });
          beam({ x: u.x, y: u.y }, 1.3, { x: u.x, y: u.y }, 2.4, 0.28, { T: ptex('comet'), m: 1, c: [0.35, 1, 0.7], add: true, a: 0.7 * k });
          quad({ T: ptex('star'), m: 1, c: [1, 0.6, 0.8], add: true, a: k, x: u.x, y: 2.5, z: -u.y, l: 0.7 * pul, w: 0.7 * pul, up: true, rot: now * 2 });
          every(iv, 6, dt, () => burst({ at: { x: u.x, y: u.y, h: 2.4 }, sp: [0.2, 0.8], up: [-1.2, -0.4], life: [0.4, 0.7], s: [0.16, 0.04], c: [1, 0.75, 0.88], tex: 'petal', spin: 4 })); } }
      if (u.kind === 'hero' && u.code === 'Automaton' && u.alive && K.visible(u) && u.statuses) { const c = u.statuses.find(s => s.type === 'casting'); // Chain Reaction wind-up: golden sweeps around his feet and a flash on Donus himself
        if (c) { const k = Math.min(1, c.t / 0.5);
          once(c, () => { burst({ at: { x: u.x, y: u.y, h: 0.9 }, life: [0.3, 0.3], s: [1.2, 2.6], c: [1, 0.85, 0.3], tex: 'star' }); burst({ at: { x: u.x, y: u.y, h: 0.9 }, life: [0.2, 0.2], s: [0.8, 1.6], c: [1, 1, 0.85], tex: 'star' }); });
          for (let i = 0; i < 3; i++) quad({ T: ptex('arc'), m: 1, c: [1, 0.85, 0.45], add: true, a: 0.85 * k, x: u.x, y: 0.08 + i * 0.01, z: -u.y, l: 1.7 - i * 0.25, w: 1.7 - i * 0.25, rot: now * 9 + i * 2.1 }); } }
      if (u.kind === 'hero' && u.alive && K.visible(u) && u.code === 'Brawler' && u.forced && u.forced.onEnd) // Bulldoze: dust kicked up behind the charge
        every(u.forced, 40, dt, () => burst({ at: { x: u.x, y: u.y, h: 0.15 }, jit: 0.25, sp: [0, 0.5], up: [0.2, 0.7], life: [0.5, 0.9], s: [0.4, 1.1], c: [0.85, 0.75, 0.65], a: 0.55, add: false, tex: 'smoke', spin: 1.5, drag: 1 }));
      if (u.kind === 'hero' && u.code === 'Brawler') {
        const f = u.forced && u.forced.onEnd ? u.forced : null, lc = bulls.get(u);
        if (f && u.alive && K.visible(u)) {
          let e = bulls.get(u); if (!e || e.f !== f) bulls.set(u, e = { f, sx: u.x, sy: u.y }); e.x = u.x; e.y = u.y; e.vx = f.vx; e.vy = f.vy;
          const back = Math.min(2.6, Math.hypot(u.x - e.sx, u.y - e.sy) + 0.6), tail = { x: u.x - f.vx * back, y: u.y - f.vy * back }, head = { x: u.x + f.vx * 0.3, y: u.y + f.vy * 0.3 };
          beam(tail, 0.45, head, 0.55, 1.15, { T: ptex('comet'), m: 1, c: [1, 0.45, 0.2], add: true, a: 0.9 });
          beam(tail, 0.46, head, 0.56, 0.55, { T: ptex('comet'), m: 1, c: [1, 0.9, 0.6], add: true, a: 0.9 });
          const crr = K.VIEW && K.VIEW.y < 0 ? -1 : 1, sa = Math.atan2(f.vy * K.YS * crr, f.vx * crr);
          quad({ T: ptex('spikes'), m: 1, c: [1, 1, 1], add: false, a: 0.95, x: u.x + f.vx * 0.55, y: 0.6, z: -(u.y + f.vy * 0.55), l: 1.5, w: 1.3, up: true, rot: sa });
          quad({ t: 'tx_flash_circleFade', m: 1, c: [1, 1, 1], add: true, a: 0.3, x: u.x, y: 0.05, z: -u.y, l: 2.6, w: 2.6 });
          every(e, 70, dt, () => burst({ at: { x: u.x, y: u.y, h: 0.55 }, jit: 0.35, hj: 0.3, vx: -f.vx * 5, vy: -f.vy * 5, life: [0.12, 0.22], s: [0.13, 0.03], c: [1, 1, 1], stretch: 0.35 }));
        } else if (lc && lc.f) { bulls.set(u, { f: null }); // landed: yellow speed sparks spray on through the target
          burst({ n: 22, at: { x: lc.x, y: lc.y, h: 0.5 }, dir: Math.atan2(lc.vy, lc.vx), cone: 1.1, sp: [3, 7], up: [0, 1.5], drag: 3, life: [0.2, 0.45], s: [0.16, 0.04], c: [1, 1, 0.7], c2: [1, 0.8, 0.2], stretch: 0.4 });
          burst({ n: 10, at: { x: lc.x, y: lc.y, h: 0.5 }, dir: Math.atan2(-lc.vy, -lc.vx), cone: 0.9, sp: [1, 3], up: [0, 0.6], drag: 3, life: [0.3, 0.6], s: [0.12, 0.03], c: [1, 0.95, 0.5], stretch: 0.4 }); }
      }
      if (u.kind !== 'hero' || !u.alive || !u.specialActive || !K.visible(u)) continue;
      const sa = u.specialActive;
      if (sa.thief) once(sa, () => burst({ n: 14, at: { x: u.x, y: u.y, h: 0.3 }, sp: [0.4, 1.4], up: [0.2, 0.8], drag: 2, life: [0.6, 1], s: [0.6, 1.3], c: [0.45, 0.3, 0.6], a: 0.7, add: false, tex: 'smoke', spin: 1.5 })); // vanishes in a puff
      if (sa.joker) once(sa, () => { burst({ n: 16, at: { x: u.x, y: u.y, h: 0.1 }, ring: 0.4, sp: [1, 2], drag: 2.5, up: [0.1, 0.4], life: [0.5, 0.8], s: [0.4, 0.9], c: [0.8, 0.75, 0.65], a: 0.6, add: false, tex: 'smoke' });
        burst({ at: { x: u.x, y: u.y, h: 0.05 }, flat: true, life: [0.45, 0.45], s: [0.6, 3], c: [0.6, 1, 0.4], tex: 'ring' }); }); // locks down into demolition mode
      if (u.code === 'Kunoichi') every(sa, 16, dt, () => burst({ at: { x: u.x, y: u.y, h: 0.6 }, ring: 0.6, sp: [0.3, 0.8], up: [-0.2, 0.6], life: [0.6, 1], s: [0.2, 0.1], c: [1, 0.65, 0.85], tex: 'petal', spin: 6, add: false }));
      if (u.code === 'Barbarian') { // fx_barbarian_special: spinning blur ring and green slashes
        const r = u.def.scripts.SpecialWhirlwindScript.DamageRadius;
        once(u.specialActive, () => burst({ at: { x: u.x, y: u.y, h: 0.06 }, flat: true, life: [0.45, 0.45], s: [r * 0.8, r * 2.5], c: [0.85, 0.85, 0.9], a: 0.8, tex: 'ring' })); // dust ring kicked out as he starts
        quad({ t: 'tx_banshee_projectileBlurr', m: 1, c: [0.85, 0.85, 0.95], a: 0.35, x: u.x, y: 0.35, z: -u.y, l: r * 2, w: r * 2, rot: -now * 14 });
        for (let i = 0; i < 4; i++) { const k = 0.8 + 0.12 * (i % 2); // purple and turquoise blade sweeps round the edge (fx_barbarian_special)
          quad({ T: ptex('arc'), m: 1, c: i % 2 ? [0.3, 1, 0.85] : [0.7, 0.35, 1], add: true, a: 0.9, x: u.x, y: 0.45 + 0.08 * (i % 2), z: -u.y, l: r * 2.2 * k, w: r * 2.2 * k, rot: now * 14 + i * Math.PI / 2 + (i % 2) * 0.4 }); }
        every(u.specialActive, 45, dt, () => burst({ at: { x: u.x, y: u.y, h: 0.1 }, ring: r * 0.9, sp: [1, 2.5], up: [0.2, 0.8], drag: 2, life: [0.4, 0.7], s: [0.3, 0.8], c: [0.85, 0.8, 0.7], a: 0.45, add: false, tex: 'smoke', spin: 2 })); // dust thrown off the spin
        every(u, 30, dt, () => { const a = rnd(0, 6.283); burst({ at: { x: u.x + Math.cos(a) * r * 0.7, y: u.y + Math.sin(a) * r * 0.7, h: 0.45 }, dir: a + Math.PI / 2, cone: 0.2, sp: [3, 5], up: [0, 1], g: 4, life: [0.15, 0.3], s: [0.12, 0.03], c: [0.8, 1, 0.85], stretch: 0.3 }); });
      }
      if (u.code === 'Banshee') { // fx_banshee_special: a cyan and white ghost-flame streams off the back of Ron's spirit skull
        const lp = ronLast.get(u) || { x: u.x, y: u.y, a: 0 }, mv = Math.hypot(u.x - lp.x, u.y - lp.y), a = mv > 0.001 ? Math.atan2(u.y - lp.y, u.x - lp.x) : lp.a; ronLast.set(u, { x: u.x, y: u.y, a });
        quad({ t: 'tx_flash_circleFade', m: 1, c: [1, 0.45, 0.85], add: true, a: 0.22, x: u.x, y: 0.7, z: -u.y, l: 2.6, w: 2.6, up: true });
        for (let i = 0; i < 3; i++) { const bx = u.x - Math.cos(a) * (0.7 + i * 0.35), by = u.y - Math.sin(a) * (0.7 + i * 0.35), w = Math.sin(now * 12 + i * 2) * 0.12;
          ribbon({ x: bx - Math.cos(a + w) * 0.5, y: by - Math.sin(a + w) * 0.5 }, { x: bx + Math.cos(a) * 0.6, y: by + Math.sin(a) * 0.6 }, 0.8 + i * 0.1, 0.55 - i * 0.12, { T: ptex('comet'), m: 1, c: i === 1 ? [1, 1, 1] : [0.45, 1, 0.95], add: true, a: 0.85 - i * 0.2 }); }
        every(u.specialActive, 70, dt, () => burst({ at: { x: u.x - Math.cos(a) * 0.6, y: u.y - Math.sin(a) * 0.6, h: 0.8 }, jit: 0.25, hj: 0.25, sp: [0.3, 1.2], dir: a + Math.PI, cone: 0.5, up: [0.2, 1], drag: 2, life: [0.25, 0.5], s: [0.3, 0.05], c: [0.7, 1, 1], c2: [1, 0.5, 0.9] })); // wisps
      }
    }
  }
  function drawEffects(g) {
    const now = performance.now() / 1000;
    for (const e of g.effects) {
      const k = Math.max(0, e.t / e.max);
      if (e.type === 'hit' && !e.minor && (e.big || !e.auto)) once(e, () => burst({ n: e.big ? 10 : 5, at: { x: e.x, y: e.y, h: 0.55 }, sp: [1.5, 3.5], up: [0, 2], g: 4, drag: 2, life: [0.15, 0.3], s: [0.12, 0.03], c: [1, 1, 0.85], c2: e.color === '#8fd3ff' ? ALLY : ENEMY, stretch: 0.3 })); // sparks on heavy hits
      if (e.type === 'hit') { const s = (e.big ? 1.3 : 0.9) * (1.3 - k * 0.5) * (e.minor ? 0.5 : e.auto ? 0.65 : 1), i = (Math.floor(e.x * 7 + e.y * 13) & 3); // tx_hit_rSetter: one of four impact stars (minion/tower hits small and faint)
        quad({ t: 'tx_hit_rSetter', m: 1, c: e.color === '#8fd3ff' ? ALLY : ENEMY, bg: e.minor, a: k * 2 * (e.minor ? (nearHero(e.x, e.y) ? 0.2 : 0.35) : e.auto ? 0.55 : 1), x: e.x, y: 0.55, z: -e.y, l: s, w: s, up: true, uv: [(i & 1) * 0.5, (i >> 1) * 0.5, 0.5, 0.5] }); }
      if (e.type === 'bolt') { // AutomatonChainLightningProjectile: a jagged flickering bolt, sparks and a flash where it strikes
        ribbon(e, { x: e.x2, y: e.y2 }, 0.6, 0.7, { t: 'tx_automaton_lineSpecial', a: k * 0.8, add: true });
        zap(e, { x: e.x2, y: e.y2 }, 0.62, 0.095, [1, 0.8, 0.2], Math.min(1, k * 2), e.x2 * 7 + e.y2);
        zap(e, { x: e.x2, y: e.y2 }, 0.64, 0.05, [1, 0.9, 0.4], Math.min(1, k * 2) * 0.7, e.x2 * 3 + e.y2 * 5 + 1);
        once(e, () => { // yellow starbursts at both ends (Donus reference), with a dark spiky crack where it lands
          burst({ at: { x: e.x, y: e.y, h: 0.7 }, life: [0.22, 0.22], s: [0.9, 1.7], c: [1, 0.85, 0.3], tex: 'star' });
          burst({ at: { x: e.x2, y: e.y2, h: 0.65 }, life: [0.28, 0.28], s: [1.1, 2.2], c: [1, 0.85, 0.3], tex: 'star' });
          burst({ at: { x: e.x2, y: e.y2, h: 0.66 }, life: [0.18, 0.18], s: [0.6, 1.3], c: [1, 1, 0.85], tex: 'star' });
          burst({ at: { x: e.x2, y: e.y2, h: 0.62 }, life: [0.3, 0.3], s: [0.9, 1.4], c: [0.15, 0.1, 0.05], a: 0.8, add: false, tex: 'spikes' });
          burst({ n: 16, at: { x: e.x2, y: e.y2, h: 0.6 }, sp: [1.5, 4], up: [-1, 2.5], g: 3, drag: 2, life: [0.2, 0.4], s: [0.15, 0.03], c: [1, 1, 0.8], c2: [1, 0.7, 0.2], stretch: 0.3 });
          burst({ at: { x: e.x2, y: e.y2, h: 0.6 }, life: [0.25, 0.25], s: [0.8, 2], c: [1, 0.9, 0.5] }); }); }
      if (e.type === 'boom' && e.rift) { const r = e.r; // Explosive Rift collapse: white-gold flash, a rainbow star burst, then a dark star-shaped scorch that fades
        once(e, () => { const at = { x: e.x, y: e.y, h: 0.3 };
          [[1, 0.95, 0.45], [1, 0.45, 0.75], [0.45, 0.65, 1], [0.7, 0.45, 1]].forEach((c, i) => burst({ at: { x: e.x, y: e.y, h: 0.07 + i * 0.01 }, flat: true, life: [0.35, 0.45], s: [r * (1.4 + i * 0.25), r * (2.6 + i * 0.3)], c, tex: 'star' }));
          burst({ n: 40, at, sp: [2.5, 7], up: [0.5, 3], g: 6, drag: 1.5, life: [0.3, 0.6], s: [0.18, 0.04], c: [1, 1, 0.85], c2: [1, 0.5, 0.75], stretch: 0.3 });
          burst({ n: 10, at, ring: r * 0.5, sp: [0.5, 1.5], up: [0.2, 0.8], drag: 2, life: [0.8, 1.2], s: [0.7, 1.6], c: [0.9, 0.5, 0.65], a: 0.35, add: false, tex: 'smoke', spin: 1 });
          burst({ at: { x: e.x, y: e.y, h: 0.035 }, flat: true, life: [1.8, 1.8], s: [r * 2.4, r * 2.6], c: [0.12, 0.1, 0.12], a: 0.6, add: false, tex: 'star' }); });
        quad({ t: 'tx_flash_circleFade', m: 1, c: [1, 0.95, 0.6], add: true, a: k * 1.4, x: e.x, y: 0.06, z: -e.y, l: r * 2.6, w: r * 2.6 });
        quad({ t: 'tx_lensflare_default', m: 2, c: [1, 0.9, 0.6], add: true, a: k, x: e.x, y: 0.7, z: -e.y, l: 5 * k, w: 5 * k, up: true });
      } else
      if (e.type === 'boom') { const r = e.r * (1.3 - k * 0.5); // meteor impact: fire ring on the ground plus a flare
        once(e, () => { const hex = parseInt((e.color || '#ff8a3d').slice(1), 16), col = [(hex >> 16) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255], at = { x: e.x, y: e.y, h: 0.3 };
          burst({ n: 48, at, sp: [2, 6.5], up: [1.5, 5], g: 9, drag: 1, life: [0.35, 0.8], s: [0.2, 0.05], c: [1, 0.95, 0.7], c2: col, stretch: 0.2 }); // sparks
          burst({ n: 12, at, sp: [1.5, 4], up: [2, 5], g: 12, life: [0.6, 1], s: [0.22, 0.18], c: [0.25, 0.2, 0.2], add: false, tex: 'shard', spin: 10, bounce: true }); // debris
          burst({ n: 14, at, ring: e.r * 0.4, sp: [1, 2.5], up: [0.3, 1.2], drag: 2, life: [0.8, 1.3], s: [0.8, 2], c: [0.4, 0.35, 0.33], a: 0.55, add: false, tex: 'smoke', spin: 1 }); // smoke
          burst({ at: { x: e.x, y: e.y, h: 0.06 }, flat: true, life: [0.5, 0.5], s: [0.5, e.r * 2.8], c: col, tex: 'ring' }); // shockwave
          burst({ at: { x: e.x, y: e.y, h: 0.035 }, flat: true, life: [2.5, 2.5], s: [e.r * 1.6, e.r * 1.7], c: [0.08, 0.05, 0.04], a: 0.55, add: false }); }); // scorch mark
        quad({ t: 'tx_flash_circleFade', m: 1, c: [1, 0.5, 0.15], add: true, a: k * 1.2, x: e.x, y: 0.05, z: -e.y, l: r * 2, w: r * 2 });
        quad({ t: 'tx_lensflare_default', m: 2, c: [1, 0.6, 0.3], add: true, a: k, x: e.x, y: 0.6, z: -e.y, l: 4 * k, w: 4 * k, up: true }); }
      if (e.vis === 'paladin') { // Encore (Rickard's reference GIF): Pearl glows violet with light rays and twinkles, then a white-cyan flash with a green swirl and music notes;
        // every healed ally gets pink hearts and notes in a violet beam
        const me = e.u && e.u.code === 'Paladin', ux = e.u ? e.u.x : e.x, uy = e.u ? e.u.y : e.y, ph = 1 - k; // ph 0 -> 1 over the effect
        if (me) {
          once(e, () => { burst({ n: 26, at: { x: ux, y: uy, h: 1.0 }, sp: [3, 6], up: [-1.5, 3], drag: 3, life: [0.25, 0.45], s: [0.3, 0.05], c: [0.95, 0.85, 1], c2: [0.6, 0.3, 1], stretch: 0.5 }); // violet rays
            burst({ n: 8, at: { x: ux, y: uy, h: 1.1 }, jit: 0.6, hj: 0.4, life: [0.3, 0.6], s: [0.35, 0], c: [1, 0.95, 1], tex: 'star', spin: 3 }); });
          if (ph < 0.5) { quad({ T: ptex('dot'), m: 1, c: [0.65, 0.35, 1], add: true, a: 0.9, x: ux, y: 1.0, z: -uy, l: 1.6, w: 1.6, up: true });
            every(e, 12, R3Ddt, () => { burst({ n: 4, at: { x: ux, y: uy, h: 1.0 }, sp: [4, 7], up: [-1, 2.5], drag: 3, life: [0.2, 0.35], s: [0.32, 0.05], c: [0.95, 0.85, 1], c2: [0.6, 0.3, 1], stretch: 0.6 });
              burst({ at: { x: ux + rnd(-0.6, 0.6), y: uy + rnd(-0.4, 0.4), h: rnd(0.6, 1.6) }, life: [0.25, 0.35], s: [0.4, 0], c: [1, 0.95, 1], tex: 'star' }); });
            quad({ t: 'tx_fadeRay_maskAlpha', m: 1, c: [0.65, 0.35, 1], add: true, a: 1, x: ux, y: 1.3, z: -uy, l: 1.0, w: 2.8, up: true, rot: Math.PI / 2 }); }
          else { const q = (ph - 0.5) / 0.5;
            if (!e.flashed) { e.flashed = true; burst({ at: { x: ux, y: uy, h: 1.0 }, life: [0.35, 0.35], s: [1.5, 3.4], c: [0.75, 1, 1] }); burst({ at: { x: ux, y: uy, h: 1.0 }, life: [0.25, 0.25], s: [1, 2.2], c: [1, 1, 1], tex: 'star' });
              for (let i = 0; i < 6; i++) burst({ at: { x: ux + rnd(-0.9, 0.9), y: uy + rnd(-0.6, 0.6), h: rnd(0.6, 1.4) }, up: [0.3, 0.7], life: [1, 1.4], s: [0.5, 0.4], c: [1, 1, 1], tex: 'note', add: false }); }
            for (let i = 0; i < 2; i++) quad({ T: ptex('arc'), m: 1, c: [0.45, 1, 0.6], add: true, a: 0.8 * (1 - q), x: ux, y: 0.6 + i * 0.3, z: -uy, l: 2.2 + q * 2.4, w: 2.2 + q * 2.4, rot: now * 5 + i * Math.PI });
            quad({ T: ptex('dot'), m: 1, c: [0.55, 0.4, 1], add: true, a: 0.4 * (1 - q), x: ux, y: 0.9, z: -uy, l: 2.6, w: 2.6, up: true }); }
        } else {
          once(e, () => { burst({ n: 3, at: { x: ux, y: uy, h: 1.2 }, jit: 0.35, up: [0.6, 1], life: [0.8, 1.1], s: [0.45, 0.35], c: [1, 0.5, 0.8], tex: 'heart', add: false });
            burst({ n: 2, at: { x: ux, y: uy, h: 1.1 }, jit: 0.35, up: [0.5, 0.9], life: [0.8, 1.1], s: [0.3, 0.25], c: [1, 1, 1], tex: 'note', add: false });
            burst({ at: { x: ux, y: uy, h: 0.05 }, flat: true, life: [0.6, 0.6], s: [0.5, 2.2], c: [0.7, 0.5, 1], tex: 'ring' }); });
          quad({ t: 'tx_fadeRay_maskAlpha', m: 1, c: [0.65, 0.35, 1], add: true, a: k, x: ux, y: 1.3, z: -uy, l: 0.9, w: 2.8, up: true, rot: Math.PI / 2 });
          quad({ T: ptex('dot'), m: 1, c: [1, 0.55, 0.85], add: true, a: 0.6 * k, x: ux, y: 0.9, z: -uy, l: 1.1, w: 1.1, up: true }); }
      }
    }
  }
  // player attack range and auto-attack charge, drawn in the 3D scene before the hero models so they stay solid in front of it
  // (game.js hands over k = charge 0..1 and hit = swing flash 0..1 in player.charge3, the same values its 2D version uses)
  let rangeG = null;
  function syncRange(g) {
    const P = g.player, c = P && P.alive && P.charge3;
    if (!rangeG) { const m = o => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: o, depthWrite: false, depthTest: false }); // over the ground and platforms like the 2D version; hero models draw after it
      rangeG = { base: new THREE.Mesh(new THREE.CircleGeometry(1, 72), m(0.08)), disc: new THREE.Mesh(new THREE.CircleGeometry(1, 72), m(0.2)),
        rim: new THREE.Mesh(new THREE.BufferGeometry(), m(0.5)), edge: new THREE.Mesh(new THREE.BufferGeometry(), m(0.55)), rr: {}, };
      for (const k of ['base', 'disc', 'rim', 'edge']) { const o = rangeG[k]; o.rotation.x = -Math.PI / 2; o.renderOrder = 1; scene.add(o); } }
    const G = rangeG; for (const k of ['base', 'disc', 'rim', 'edge']) G[k].visible = !!c;
    if (!c) return;
    const r = P.range, px = 1 / K.SCALE; // one screen pixel in world units, so line widths match the 2D look
    const ring = (o, rad, w) => { const key = rad.toFixed(3) + '/' + w.toFixed(4); if (G.rr[o.uuid] === key) return; G.rr[o.uuid] = key;
      o.geometry.dispose(); o.geometry = new THREE.RingGeometry(Math.max(0, rad - w / 2), rad + w / 2, 72); };
    for (const k of ['base', 'disc', 'rim', 'edge']) G[k].position.set(P.x, 0.03, -P.y);
    G.base.scale.setScalar(r);
    G.disc.visible = G.rim.visible = c.k > 0;
    if (c.k > 0) { G.disc.scale.setScalar(r * c.k); G.disc.material.opacity = 0.14 + 0.16 * c.k; ring(G.rim, r * c.k, 2.5 * px); G.rim.material.opacity = 0.45 + 0.55 * c.k; }
    ring(G.edge, r, (2 + 2 * c.hit) * px); G.edge.material.opacity = c.hit > 0 ? 0.55 + 0.45 * c.hit : 0.55;
  }
  function syncShots(g) { used = 0; crowd.clear(); fighters = g.units.filter(u => u.kind === 'hero' && u.alive && K.visible(u));
    drawShots(g); drawTowers(g, lastFx, R3Ddt); layer = 6; drawSpecials(g); drawEffects(g); drawParticles(R3Ddt); layer = 5; for (let i = used; i < pool.length; i++) pool[i].visible = false; }
  const Q = new THREE.Quaternion(), P3 = new THREE.Vector3(), S3 = new THREE.Vector3();

  function build(g) {
    for (const [, o] of minions) scene.remove(o); minions.clear(); for (const [, o] of heroObjs) { scene.remove(o); if (o.userData.skull) scene.remove(o.userData.skull); if (o.userData.turret) { scene.remove(o.userData.turret); o.userData.turret.material.dispose(); } } heroObjs.clear();
    if (world) { scene.remove(world); world.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    world = new THREE.Group(); towers = []; bushes = []; timed = [];
    const mp = MD.maps[g.map.name] || MD.maps.FTUE_Map_1, th = THEMES[mp.theme], [ox, oz] = mp.offset;
    scene.background = new THREE.Color(th.sky);
    const shift = new THREE.Matrix4().makeTranslation(-ox, 0, -oz), accs = {}, isGrass = m => MD.mats[m] && MD.mats[m].t === 'grass';
    for (const v of mp.visuals) {
      if (!SHOW_FLOWERS && v[0].includes('flower')) continue;
      const place = shift.clone().multiply(new THREE.Matrix4().compose(P3.set(v[1], v[2], v[3]), Q.set(v[4], v[5], v[6], v[7]), S3.set(v[8], v[9], v[10])));
      bake(v[0], place, accs, m => !isGrass(m));
      const ga = {}; bake(v[0], place, ga, isGrass); // bushes stay separate so they can turn see-through around the player
      for (const k in ga) {
        const mat = material(k, th, mp); if (!mat) continue; const mesh = ga[k].mesh(mat); world.add(mesh);
        const faded = mat.clone(); faded.transparent = true; faded.opacity = 0.4; faded.alphaTest = 0.5 * 0.4; faded.depthWrite = false; // alphaTest compares texture alpha × opacity, so it has to scale with the fade or the whole bush is cut away
        bushes.push({ mesh, x: v[1] - ox, y: v[3] - oz, mat, faded });
      }
    }
    for (const k in accs) { const mat = material(k, th, mp); if (mat) world.add(accs[k].mesh(mat)); }
    for (const u of g.units) if (u.kind === 'tower') { // TowerPawn-Default (the red/blue pillar with spinning rings seen in the videos) on its stone platform
      const team = u.team === K.PLAYER_TEAM ? 'ally' : 'enemy', place = new THREE.Matrix4().makeTranslation(u.x, 0, u.y);
      const pa = {}; bake('towerPlatform', place, pa); for (const k in pa) world.add(pa[k].mesh(material(k, th, mp)));
      const ta = {}, ra = {}, grp = new THREE.Group(), rings = new THREE.Group();
      bake('tower', place, ta, null, n => !n.startsWith('msh_towerRing')); bake('tower', new THREE.Matrix4(), ra, null, n => n.startsWith('msh_towerRing'));
      for (const k in ta) grp.add(ta[k].mesh(material(k, th, mp, team)));
      for (const k in ra) rings.add(ra[k].mesh(material(k, th, mp, team))); rings.position.set(u.x, 0, -u.y); grp.add(rings);
      world.add(grp); towers.push({ u, g: grp, rings });
    }
    const wm = waterMat(th); timed.push(wm);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(g.map.w + 80, g.map.h + 80), wm);
    water.rotation.x = -Math.PI / 2; water.position.set(g.map.w / 2, -0.9, -g.map.h / 2); world.add(water);
    scene.add(world); builtFor = g.map;
  }

  api.render = (g, W, H, DPR, k) => {
    K = k;
    if (!api.ready) { if (!init()) return false; api.ready = true; }
    if (builtFor !== g.map) build(g);
    if (cv3.width !== Math.round(W * DPR) || cv3.height !== Math.round(H * DPR)) { renderer.setPixelRatio(DPR); renderer.setSize(W, H, false); if (fxRenderer) { fxRenderer.setPixelRatio(DPR); fxRenderer.setSize(W, H, false); } }
    const s = K.SCALE, ox = -K.shakeX / s, oy = K.shakeY / s;
    camera.left = -W / 2 / s + ox; camera.right = W / 2 / s + ox; camera.top = 0.52 * H / s + oy; camera.bottom = -0.48 * H / s + oy; camera.updateProjectionMatrix();
    const el = Math.asin(K.YS), tx = g.cam.x, tz = -g.cam.y;
    // a multiplayer guest looks from the other end (camera turned 180°); on maps that mirror top-to-bottom the picture is also
    // mirrored sideways (CSS on both 3D canvases) so the guest sees the same layout as the host (game.js viewOf)
    const V = K.VIEW || { x: 1, y: 1 }, turn = V.y < 0 ? -1 : 1, mt = V.x !== turn ? 'scaleX(-1)' : '';
    camera.position.set(tx, Math.sin(el) * 60, tz + turn * Math.cos(el) * 60); camera.lookAt(tx, 0, tz);
    for (const c of [cv3, cv4]) if (c && c.style.transform !== mt) c.style.transform = mt;
    const now = performance.now() / 1000; for (const m of timed) m.uniforms.t.value = now;
    for (const T of towers) {
      T.g.visible = T.u.alive; T.rings.rotation.y = now * 0.8; const flash = T.u.flash > 0;
      T.g.traverse(o => { if (o.material && o.material.emissive) o.material.emissive.setScalar(flash ? 0.5 : 0); });
    }
    turnFrame++; syncMinions(g); syncHeroes(g); syncRange(g); syncShots(g);
    const P = g.player;
    for (const b of bushes) b.mesh.material = P && P.alive && Math.hypot(P.x - b.x, P.y - b.y) < 1.6 ? b.faded : b.mat;
    renderer.render(scene, camera); if (fxRenderer) fxRenderer.render(fxScene, camera);
    return true;
  };
  api.hide = () => { for (const c of [cv3, cv4]) if (c) c.style.visibility = 'hidden'; };
  api.show = () => { for (const c of [cv3, cv4]) if (c) c.style.visibility = ''; };

  // --- start menu showcase (patch 134): the chosen hero stands on the podium in its idle pose, like the original home view.
  // Own renderer on the menu's canvas; runs only while that canvas is on screen. showcaseSwing() plays one autoattack.
  let SC = null;
  api.showcase = (cv, code) => {
    if (!H3 || !HERO_FIGURES[code] || !HERO_ANIM[code]) { if (SC) SC.code = null; return false; }
    if (!SC) {
      let r; try { r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true }); } catch (e) { return false; }
      THREE.ColorManagement.enabled = false; r.outputColorSpace = THREE.LinearSRGBColorSpace; r.useLegacyLights = true; r.setClearColor(0x000000, 0);
      const s = new THREE.Scene(); s.add(new THREE.HemisphereLight(0xffffff, 0x5a6fa8, 1.0));
      const sun = new THREE.DirectionalLight(0xffffff, 0.55); sun.position.set(-3, 8, 4); s.add(sun);
      const rim = new THREE.DirectionalLight(0x8fc2ff, 0.5); rim.position.set(2, 4, -6); s.add(rim);
      SC = { r, s, cam: new THREE.PerspectiveCamera(26, 1, 0.1, 60), cv, code: null, o: null, raf: 0 };
    }
    if (SC.code !== code) {
      if (SC.o) { SC.s.remove(SC.o); SC.o.material.dispose(); }
      const f = HERO_FIGURES[code], A = HERO_ANIM[code], tex = heroTex[f] || (heroTex[f] = new THREE.TextureLoader().load(H3.figs[f].tex));
      const o = new THREE.Mesh(heroGeometry(f), new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: 0x666666, transparent: true }));
      o.rotation.order = 'YXZ'; bendMaterial(o.material, A, H3.figs[f].h * 1.8, f);
      if (A.bow) heroBow(o, A, tex); if (A.board) heroBoard(o, A); if (A.held) heroHeld(o, A, tex);
      SC.s.add(o); SC.o = o; SC.code = code; SC.A = A; SC.h = H3.figs[f].h * 1.8 * (A.size || 1) + (A.board ? A.board.lift : 0);
      if (A.held && A.held.hand) { const W = A.held, F = H3.figs[W.fig]; SC.h = Math.max(SC.h, (W.at[1] * H3.figs[f].h + (F.hi[1] + (W.grip || 0)) * F.h * W.scale) * 1.8 * (A.size || 1)); } // a sword taller than him stays in the frame
      const gd = window.GAMEDATA && GAMEDATA.heroes[code];
      SC.u = { kind: 'hero', code, x: 0, y: 0, team: 1, alive: true, walkT: 0, attackAnim: 0, atkTimer: 0, range: 2, flash: 0, statuses: [], def: gd, has: () => false, statCd: () => A.windupT + A.slashT };
      SC.g = { time: 0, units: [SC.u] }; SC.swing = -1; SC.t0 = performance.now() / 1000;
    }
    const tick = () => {
      SC.raf = 0; if (!SC.code || !SC.cv.offsetParent) return; // menu hidden or another page open: stop until called again
      const r = SC.r, w = SC.cv.clientWidth, hgt = SC.cv.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (w && hgt && (SC.cv.width !== Math.round(w * dpr) || SC.cv.height !== Math.round(hgt * dpr))) { r.setPixelRatio(dpr); r.setSize(w, hgt, false); }
      const t = performance.now() / 1000 - SC.t0, u = SC.u, A = SC.A, o = SC.o, g = SC.g; g.time = t;
      // a tapped swing: a dummy target in front of the hero for the length of one attack, on the same clock as in a match
      if (SC.swing >= 0) { const k = t - SC.swing, P = u.statCd();
        if (k < P) u.atkTimer = k; else if (!SC.hit) { SC.hit = true; u.atkTimer = 0; u.attackAnim++; }
        if (k > P + (A.lead || 0) + A.recoverT + 0.15) { SC.swing = -1; g.units.length = 1; } }
      u.facing = -Math.PI / 2 + Math.sin(t * 0.6) * 0.35;
      const st = animState(u, o, g); turnFrame++;
      o.position.set(0, 0, 0); o.rotation.y = u.facing + Math.PI / 2; o.material.opacity = 1; o.material.emissive.setScalar(0.4);
      poseHero(u, o, A, st, g);
      const H = SC.h, c = SC.cam; c.aspect = w / Math.max(1, hgt); c.position.set(0, H * 0.7, H * 3.0); c.lookAt(0, H * 0.48, 0); c.updateProjectionMatrix();
      r.render(SC.s, c); SC.raf = requestAnimationFrame(tick);
    };
    if (!SC.raf) SC.raf = requestAnimationFrame(tick);
    return true;
  };
  api.showcaseSwing = () => { if (!SC || !SC.code || SC.swing >= 0) return;
    SC.swing = performance.now() / 1000 - SC.t0; SC.hit = false; SC.u.atkTimer = 0; SC.g.units[1] = { alive: true, team: 2, x: 0.25, y: -1.2, r: 0 }; };
  return api;
})();
