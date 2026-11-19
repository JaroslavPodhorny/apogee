// Flight view: renders the world, handles piloting input, HUD, navball and the orbit map.
import * as THREE from '../vendor/three.module.js';
import { World, orbitElements, cloudTop } from './sim.js';
import { Booms } from './boom.js';
import { currentUniverse, loadWorld, saveWorld } from './universe.js';
import { partMesh, lightMats, interstageMesh, fairingHalfMesh } from './meshes.js';
import { makeSkyPlanet, makeMapPlanet, updateSky, sunTransmittance, SUN_E } from './planet.js';
import { Terrain } from './terrain.js';
import { cloudNoise, groundDetail } from './clouds.js';
import { Smoke, plumeMaterial, plumeGeo } from './fx.js';
import { Scatter } from './scatter.js';
import { PhysicalBloomPass } from './post.js';
import { Sun } from './sun.js';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { PARTS } from './parts.js';
import { G0, analyze, computeLayout } from './rocket.js';
import { buildSite } from './site.js';
import { ascentGuide } from './guide.js';
import { sfx } from './audio.js';

const $ = (id) => document.getElementById(id);
const WARPS = [1, 2, 4, 10, 50, 100, 1000, 10000];
const SAS_MODES = [['hold', 'Hold'], ['prograde', 'Prograde'], ['retrograde', 'Retrograde'], ['radial', 'Radial out'], ['antiradial', 'Radial in'], ['normal', 'Normal'], ['antinormal', 'Anti-normal']];
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '∞');
const fmtDist = (m) => (!Number.isFinite(m) ? '∞' : Math.abs(m) < 10000 ? `${fmt(m)} m` : Math.abs(m) < 1e7 ? `${fmt(m / 1000, 1)} km` : `${fmt(m / 1000)} km`);
const distHTML = (m) => { const s = fmtDist(Math.max(0, m)), i = s.lastIndexOf(' '); return `${s.slice(0, i)}<i>${s.slice(i + 1)}</i>`; };
const fmtTime = (s) => { if (!Number.isFinite(s)) return '—'; s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; };

// colour of the light each propellant's flame throws on its surroundings
const FLAME_COL = [new THREE.Color(1, 0.62, 0.32), new THREE.Color(1, 0.8, 0.94), new THREE.Color(0.78, 0.86, 1)];
function glowMaterial(core, tail) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uSpread: { value: 1.5 }, uLen: { value: 5 }, uTime: { value: 0 }, uPower: { value: 0 }, uBright: { value: 6 }, uCore: { value: new THREE.Color(core) }, uTail: { value: new THREE.Color(tail) } },
    vertexShader: /* glsl */`uniform float uSpread, uLen, uTime; varying float vT; varying float vF;
      void main(){ vec3 p = position; float t = -p.y; vT = t;
        p.xz *= mix(1.0, uSpread, pow(max(t, 0.0), 0.75)) * (1.0 + 0.02*sin(uTime*21.0 + t*7.0));
        p.y *= uLen * (1.0 + 0.015*sin(uTime*13.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 n = normalize(normalMatrix * vec3(position.x, 0.0, position.z));
        vF = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`uniform float uPower, uBright; uniform vec3 uCore, uTail; varying float vT; varying float vF;
      void main(){ float t = clamp(vT, 0.0, 1.0), u = 1.0 - t; float a = pow(u, 1.8) * smoothstep(0.0, 0.07, t) * uPower * mix(0.12, 1.0, vF*vF);
        vec3 c = mix(uTail, uCore, pow(u, 4.0)); gl_FragColor = vec4(c*uBright*(1.0 + 3.0*pow(u, 8.0)), clamp(a, 0.0, 1.0)); }`,
  });
}
const glowGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 12, true); glowGeo.translate(0, -0.5, 0);

function dotTexture(color, ring) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.strokeStyle = g.fillStyle = color; g.lineWidth = 6;
  g.beginPath(); g.arc(32, 32, ring ? 20 : 14, 0, 7); if (ring) g.stroke(); else g.fill();
  if (ring) { g.beginPath(); g.arc(32, 32, 6, 0, 7); g.fill(); }
  return new THREE.CanvasTexture(c);
}

// launch hour picked in the hangar (local solar time at the pad)
export function launchHour() {
  let h = NaN; try { h = parseFloat(localStorage.getItem('apogee.hour')); } catch { /* ignore */ }
  return Number.isFinite(h) ? h : 7.75;
}

export class Flight {
  constructor(renderer, canvas, thumbs, tex, onExit) {
    this.tex = tex;
    // HDR pipeline: scene → half-float MSAA target → bloom → ACES tone mapping
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }));
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.bloom = new PhysicalBloomPass(0.045);
    this.composer.addPass(this.renderPass); this.composer.addPass(this.bloom); this.composer.addPass(new OutputPass());
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sizeKey = '';
    this.renderer = renderer; this.cv = canvas; this.thumbs = thumbs; this.onExit = onExit; this.active = false;
    this.keys = new Set();
    this.h = {
      keydown: (e) => this.onKey(e, true), keyup: (e) => this.onKey(e, false),
      pointerdown: (e) => { this.drag = { b: e.button }; this.cv.setPointerCapture(e.pointerId); this.cv.style.cursor = 'grabbing'; },
      pointerup: () => { this.drag = null; this.cv.style.cursor = 'grab'; },
      pointermove: (e) => this.onDrag(e), wheel: (e) => this.onWheel(e), contextmenu: (e) => e.preventDefault(),
      blur: () => this.keys.clear(),
    };
    $('f-revert').onclick = () => { this.persist(); this.onExit(); };
    $('f-restart').onclick = () => this.restart();
    $('f-vessels-btn').onclick = () => this.toggleVessels();
    const save = () => { if (this.active) this.persist(); };
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    $('f-map').onclick = () => this.toggleMap();
    $('f-warp-up').onclick = () => this.setWarp(1);
    $('f-warp-down').onclick = () => this.setWarp(-1);
    $('f-help-btn').onclick = () => { $('f-help').hidden = !$('f-help').hidden; };
    $('f-data-btn').onclick = () => this.toggleData();
    $('f-stage-btn').onclick = () => this.stage();
    const tr = $('f-throttle');
    const setT = (e) => {
      const r = tr.getBoundingClientRect(), a = this.world?.active; if (!a) return;
      let t = 1 - (e.clientY - r.top) / r.height;
      t = t > 0.97 ? 1 : t < 0.03 ? 0 : t; a.throttle = t; this.showThrottle(a);
    };
    tr.onpointerdown = (e) => { tr.setPointerCapture(e.pointerId); this.thrDrag = true; setT(e); };
    tr.onpointermove = (e) => { if (this.thrDrag) setT(e); };
    tr.onpointerup = tr.onpointercancel = () => { this.thrDrag = false; };
    $('f-help').innerHTML = `<h2>Controls</h2><table>
      <tr><td><kbd>Space</kbd></td><td>Launch, then drop / fire the next stage</td></tr>
      <tr><td><kbd>A</kbd> <kbd>D</kbd></td><td>Lean the rocket left / right on screen</td></tr>
      <tr><td><kbd>W</kbd> <kbd>S</kbd></td><td>Lean it away from / toward you</td></tr>
      <tr><td><kbd>Q</kbd> <kbd>E</kbd></td><td>Roll</td></tr>
      <tr><td><kbd>Shift</kbd> <kbd>Ctrl</kbd></td><td>Throttle up / down (or drag the slider)</td></tr>
      <tr><td><kbd>Z</kbd> <kbd>X</kbd></td><td>Full throttle / engines off</td></tr>
      <tr><td><kbd>T</kbd></td><td>Hold attitude on / off</td></tr>
      <tr><td><kbd>G</kbd></td><td>Auto-steer to orbit on / off</td></tr>
      <tr><td><kbd>.</kbd> <kbd>,</kbd></td><td>Speed time up / slow it down</td></tr>
      <tr><td><kbd>M</kbd></td><td>Orbit map</td></tr>
      <tr><td><kbd>L</kbd></td><td>Lights on / off</td></tr>
      <tr><td><kbd>O</kbd></td><td>Unfold / fold solar arrays and radiators</td></tr>
      <tr><td><kbd>Backspace</kbd></td><td>Abort: the escape tower pulls the capsule away</td></tr>
      <tr><td><kbd>I</kbd> <kbd>K</kbd> · <kbd>J</kbd> <kbd>L</kbd> · <kbd>H</kbd> <kbd>N</kbd></td><td>With RCS on: move forward / back · left / right · up / down</td></tr>
      <tr><td><kbd>V</kbd> · <kbd>Y</kbd></td><td>Craft list · target the nearest craft</td></tr>
      <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>Switch to the previous / next craft nearby</td></tr>
      <tr><td><kbd>U</kbd></td><td>Undock</td></tr>
      <tr><td><kbd>B</kbd></td><td>Set off armed warheads now</td></tr>
      <tr><td><kbd>?</kbd></td><td>This help</td></tr>
      <tr><td>Drag · scroll</td><td>Look around · zoom</td></tr></table>
      <p>The ball shows where the nose points: the light half is sky, the dark half is ground. Keep the wings in the centre inside the <b>square marker</b> to reach orbit. The circle with three ticks is the way you are actually moving.</p>`;
    $('f-help').onclick = () => { $('f-help').hidden = true; };
    const sas = $('f-sas');
    sas.innerHTML = '';
    const mk = (label, title, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = fn; sas.appendChild(b); return b; };
    this.sasBtns = {
      off: mk('Manual', 'Fly by hand (T)', () => { const a = this.world.active; this.autoSteer = false; if (a) a.sas = false; this.showSas(); }),
      hold: mk('Hold', 'Keep pointing where you are pointing (T)', () => this.setSasMode('hold')),
      prograde: mk('Prograde', 'Point the way you are moving: use this to speed up', () => this.setSasMode('prograde')),
      retrograde: mk('Retrograde', 'Point backwards: use this to slow down', () => this.setSasMode('retrograde')),
    };
    this.autoBtn = mk('Auto-steer', 'Fly to the square marker by itself. You still stage with Space. (G)', () => this.setAuto(!this.autoSteer));
    this.rcsBtn = mk('RCS', 'Small steering thrusters (R)', () => this.toggleRCS());
    this.tgtBtn = mk('Target', 'Point at the target', () => this.setSasMode('totarget'));
    this.killBtn = mk('Match', 'Point against your motion relative to the target: burn to match its speed', () => this.setSasMode('relretro'));
    this.nav = $('navball').getContext('2d');
    this.navImg = this.nav.createImageData($('navball').width, $('navball').height);
  }

  // ---------- lifecycle ----------
  // design: launch it into the current universe. Without one, take control of a craft already out there.
  start(design, kind, opts = {}) {
    this.design = design; this.kind = kind;
    this.uni = currentUniverse();
    const saved = opts.state !== undefined ? opts.state : loadWorld(this.uni.id, kind);
    this.preLaunch = saved ? JSON.parse(JSON.stringify(saved)) : null;
    const world = (this.world = new World(kind));
    const pl = world.planet;
    world.restore(saved);
    if (saved?.sun) {
      this.sunDir = new THREE.Vector3().fromArray(saved.sun);
      // the sun stays put in space: wait for the chosen hour to come round at the pad
      if (design && !opts.state) {
        const wait = ((((launchHour() - world.hourAt(this.sunDir)) % 24) + 24) % 24) / 24 * pl.day;
        if (wait > 30) world.advance(wait);
      }
    } else { // the sun for the chosen launch hour: a November sun (declination -8.6°) seen from the site's latitude
      const up = world.siteDir(), east = new THREE.Vector3().crossVectors(Y_AXIS, up).normalize(), north = new THREE.Vector3().crossVectors(up, east);
      const hour = launchHour(), H = ((hour - 12) / 24) * Math.PI * 2, dec = -0.15, lat = Math.asin(THREE.MathUtils.clamp(up.y, -1, 1));
      const cd = Math.cos(dec), sd = Math.sin(dec), cl = Math.cos(lat), sl = Math.sin(lat), cH = Math.cos(H);
      this.sunDir = up.clone().multiplyScalar(sl * sd + cl * cd * cH).addScaledVector(east, -cd * Math.sin(H)).addScaledVector(north, cl * sd - sl * cd * cH).normalize();
    }
    if (design) { world.launch(design); this.stats = analyze(design); this.launchedV = world.active; } else {
      const pick = world.vessels.find((v) => v.uid === opts.uid) || world.vessels.find((v) => v.uid === saved?.active && v.hasControl) || world.vessels.find((v) => v.hasControl) || world.vessels[0];
      if (!pick) return false;
      world.setActive(pick); this.launchedV = null;
      this.stats = { height: 30 };
    }
    this.target = null;
    this.refreshStageInfo();
    // --- main scene ---
    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.3, 90000);
    this.sky = makeSkyPlanet(this.tex); this.skyScene = new THREE.Scene(); this.skyScene.add(this.sky);
    this.sunLight = new THREE.DirectionalLight(0xffffff, SUN_E);
    this.sunLight.castShadow = true; this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0004; this.sunLight.shadow.normalBias = 0.04;
    scene.add(this.sunLight, this.sunLight.target);
    this.envT = 1e9; this.envRT = null; this.exposure = 1;
    this.smoke = new Smoke(); scene.add(this.smoke.mesh);
    this.engineLight = new THREE.PointLight(0xffaa66, 0, 0, 2); scene.add(this.engineLight); this.smoke.flameLight = this.engineLight;   // always present: switching a light on never recompiles shaders
    this.sun = new Sun(); scene.add(this.sun.mesh, this.sun.flare);
    this.sky.material.uniforms.uSunDisc.value = 0;
    this.sky.material.uniforms.tNoise.value = cloudNoise();
    this.sunCol = new THREE.Color();
    if (design) {
      const lay = computeLayout(design.parts);
      let minY = Infinity; for (const L of lay.values()) minY = Math.min(minY, L.pos.y - L.def.len / 2);
      let baseR = 0.6;
      for (const L of lay.values()) {
        if (L.pos.y - L.def.len / 2 > minY + 4) continue;
        const d = L.def, ext = d.fin ? d.fin.span : d.leg ? d.leg.reach + d.r * 2 : Math.max(d.r, d.rTop);
        baseR = Math.max(baseR, Math.hypot(L.pos.x, L.pos.z) + ext);
      }
      // how wide the rocket is at each height above the pad (the tower's arms reach exactly to its skin)
      const radiusAt = (y) => {
        let r = 0;
        for (const L of lay.values()) {
          const y0 = L.pos.y - L.def.len / 2 - minY, y1 = y0 + L.def.len;
          if (y < y0 - 0.3 || y > y1 + 0.3) continue;
          const d = L.def, ext = d.fin ? d.fin.span : d.leg ? d.leg.reach + d.r * 2 : Math.max(d.r, d.rTop);
          r = Math.max(r, Math.hypot(L.pos.x, L.pos.z) + ext);
        }
        return r || baseR;
      };
      this.site = buildSite(pl.R, { height: this.stats.height, baseR, radiusAt });
    } else this.site = buildSite(pl.R, { height: 30, baseR: 2.2, radiusAt: () => 2.2 });
    scene.add(this.site);
    for (const l of this.site.userData.lights) scene.add(l, l.target);
    this.booms = new Booms(scene, this.smoke); this.shake = 0;
    // terrain (one per planet size; the baked tiles survive between flights)
    this.terrains = this.terrains || {};
    if (!this.terrains[pl.kind]) this.terrains[pl.kind] = new Terrain(this.renderer, pl, this.tex, world.siteFixed);
    this.terrain = this.terrains[pl.kind]; pl.terrain = this.terrain;
    scene.add(this.terrain.group);
    this.terrain.bushes ||= new Scatter(this.renderer, this.terrain);
    scene.add(this.terrain.bushes.group);
    { const su = this.sky.material.uniforms; su.tLand.value = this.terrain.ctl.tLand; su.tCtl.value = this.terrain.ctl.tCtl; su.tGround.value = groundDetail(this.renderer); }
    this.views = new Map(); this.partMeshes = new Map(); this.fxMeshes = []; this.partLights = []; this.partLightN = {}; this.lightsOn = true;
    if (this.taa) this.taa.valid = false;
    this.origin = world.active.r.clone(); this.alt0 = design ? world.active.alt : 0;
    const size = Math.max(this.stats.height, 6);
    this.cam = { az: Math.PI - 0.3, el: 0.1, dist: size * 2.1 + 8 }; // looking north, so east is to the right
    // --- map scene ---
    const ms = (this.mapScene = new THREE.Scene());
    this.mapCam = new THREE.PerspectiveCamera(45, 1, 5, 5e7);
    this.mapPlanet = makeMapPlanet(pl.R / 1000, (pl.atmTop * 0.6) / 1000, this.tex); ms.add(this.mapPlanet);
    const mu = this.mapPlanet.userData; mu.mat.uniforms.uSun.value.copy(this.sunDir); mu.halo.material.uniforms.uSun.value.copy(this.sunDir);
    const sg = new THREE.BufferGeometry(); const sp = new Float32Array(3000 * 3);
    for (let i = 0; i < 3000; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(2e7); sp.set([v.x, v.y, v.z], i * 3); }
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    ms.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: new THREE.Color(1.5, 1.5, 1.5), size: 1.6, sizeAttenuation: false })));
    this.orbitGeo = new THREE.BufferGeometry(); this.orbitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(361 * 3), 3));
    this.orbitLine = new THREE.Line(this.orbitGeo, new THREE.LineBasicMaterial({ color: 0xf3f1ec, transparent: true, opacity: 0.8 })); this.orbitLine.frustumCulled = false; ms.add(this.orbitLine);
    const sprite = (tex, s) => { const sp2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false })); sp2.scale.setScalar(s); sp2.renderOrder = 5; ms.add(sp2); return sp2; };
    this.mkVessel = sprite(dotTexture('#ffffff', true), 0.045);
    this.mkAp = sprite(dotTexture('#f3f1ec'), 0.018); this.mkPe = sprite(dotTexture('#f3f1ec'), 0.018);
    this.mkDebris = [];
    this.mapOrb = { az: 0.6, el: 0.5, dist: (pl.R / 1000) * 3.6 };
    this.map = false; this.paused = false; this.warpIdx = 0; this.hudT = 0; this.navT = 0; this.time = 0; this.drag = null;
    this.labels = {};
    $('f-labels').innerHTML = ''; $('f-msgs').innerHTML = ''; $('f-big').innerHTML = ''; $('f-end').hidden = true; $('f-help').hidden = true;
    this.keys.clear(); this.stageKey = null; this.maxAlt = 0; this.ended = false; this.spectate = null;
    const km = (m) => fmtDist(m);
    this.goals = [
      { id: 'liftoff', title: 'Lift off', done: (a) => a.launched && a.alt - this.alt0 > 5, prog: () => 0 },
      { id: 'climb', title: `Climb to ${km(pl.spaceLine * 0.1)}`, done: (a) => a.alt > pl.spaceLine * 0.1, prog: (a) => a.alt / (pl.spaceLine * 0.1) },
      { id: 'space', title: `Reach space · ${km(pl.spaceLine)}`, done: (a) => a.alt > pl.spaceLine, prog: (a) => a.alt / pl.spaceLine },
      { id: 'orbit', title: 'Reach orbit', done: (a, o) => o.e < 1 && o.pe > pl.atmTop && a.alt > pl.atmTop, prog: (a) => a.v.length() / pl.vCirc(pl.atmTop) },
      { id: 'home', title: 'Come home safely', done: (a) => a.landed && a.launched, prog: (a) => 1 - a.alt / pl.atmTop },
    ];
    this.goalIdx = design ? 0 : this.goals.length; this.goalKey = null; this.coachTxt = null; this.olTxt = null; this.autoSteer = false; this.guide = null; this.lastBad = ''; this.heatBeep = 0;
    this.syncViews();
    if (design) world.active.throttle = 1;
    this.rcsBtn.hidden = world.active.totals().monoMax <= 0;
    this.persistT = 0;
    const n = world.vessels.filter((v) => v !== world.active && !v.isDebris).length;
    if (design && n) this.toast('info', `${n} other craft in ${this.uni.name}. Press V to see them.`);
    if (!design) this.toast('info', `Flying ${world.active.name}`);
    this.updateHUD();
    return true;
  }
  restart() {
    if (this.design) this.start(this.design, this.kind, { state: this.preLaunch });
    else this.start(null, this.kind, { state: this.preLaunch, uid: this.world.active?.uid });
  }
  persist() {
    const w = this.world; if (!w || !this.uni) return;
    const st = w.serialize(); st.sun = this.sunDir.toArray();
    saveWorld(this.uni.id, this.kind, st);
  }
  refreshStageInfo() {
    const a = this.world.active;
    this.stageInfo = a.stages.map((n) => {
      const types = new Map();
      for (const p of a.parts) if (p.stage === n && !p.def.synthetic) types.set(p.def.id, (types.get(p.def.id) || 0) + 1);
      return [...types];
    });
    this.stageKey = null;
  }
  // take control of another craft
  switchTo(v) {
    const w = this.world; if (!v || v === w.active || !w.vessels.includes(v)) return;
    const old = w.active;
    if (old) { old.input.pitch = old.input.yaw = old.input.roll = old.input.tx = old.input.ty = old.input.tz = 0; if (this.autoSteer) this.autoSteer = false; }
    w.setActive(v);
    if (this.target === v) this.target = null;
    v.target = this.target;
    this.origin.copy(v.r); this.goalIdx = this.goals.length; this.guide = null;
    this.cam.dist = Math.max(12, (this.views.get(v)?.ext || 8) * 3);
    this.refreshStageInfo(); this.rcsBtn.hidden = v.totals().monoMax <= 0;
    if (this.taa) this.taa.valid = false;
    this.toast('info', `Switched to ${v.name}`);
    this.updateHUD();
  }
  setTarget(v) {
    this.target = v && v !== this.world.active ? v : null;
    if (this.world.active) this.world.active.target = this.target;
    this.toast('info', this.target ? `Target: ${this.target.name}` : 'Target cleared');
    if (!this.target && ['totarget', 'relretro'].includes(this.world.active?.sasMode)) this.setSasMode('hold');
    this.renderVessels();
  }
  nearby(maxD) {
    const a = this.world.active;
    return this.world.vessels.filter((v) => v !== a && v.parts.length && !(v.parts.length === 1 && v.parts[0].def.synthetic) && v.r.distanceTo(a.r) < maxD).sort((x, y) => x.r.distanceTo(a.r) - y.r.distanceTo(a.r));
  }
  toggleVessels() { const p = $('f-vessels'); p.hidden = !p.hidden; $('f-vessels-btn').classList.toggle('on', !p.hidden); this.renderVessels(); }
  renderVessels() {
    const box = $('f-vessels'); if (!box || box.hidden) return;
    const w = this.world, a = w.active, pl = w.planet;
    const list = w.vessels.filter((v) => v.parts.length && !(v.parts.length === 1 && v.parts[0].def.synthetic));
    list.sort((x, y) => (x === a ? -1 : y === a ? 1 : (x.isDebris - y.isDebris) || x.r.distanceTo(a.r) - y.r.distanceTo(a.r)));
    const row = (v) => {
      const d = v === a ? '' : fmtDist(v.r.distanceTo(a.r));
      const o = orbitElements(v.r, v.v, pl.mu, pl.R);
      const where = v.landed ? 'landed' : o.e < 1 && o.pe > pl.atmTop ? `orbit ${fmtDist(o.pe)} × ${fmtDist(o.ap)}` : `${fmtDist(v.alt)} up`;
      return `<div class="vrow ${v === a ? 'cur' : ''} ${v.isDebris ? 'deb' : ''}" data-uid="${v.uid}"><div><b>${v.name}</b><small>${where}${d ? ` · ${d} away` : ''}</small></div>`
        + (v === a ? '<span class="you">flying</span>' : `<button class="link tg ${this.target === v ? 'on' : ''}">${this.target === v ? 'Targeted' : 'Target'}</button>${v.hasControl ? '<button class="link sw">Fly</button>' : ''}`) + '</div>';
    };
    box.innerHTML = `<h3>Craft in ${this.uni?.name || 'this universe'}</h3>${list.slice(0, 40).map(row).join('')}`;
    for (const el of box.querySelectorAll('.vrow')) {
      const v = list.find((x) => x.uid === el.dataset.uid); if (!v) continue;
      el.querySelector('.tg')?.addEventListener('click', () => this.setTarget(this.target === v ? null : v));
      el.querySelector('.sw')?.addEventListener('click', () => { this.switchTo(v); this.renderVessels(); });
    }
  }
  activate() {
    if (this.active) return; this.active = true;
    window.addEventListener('keydown', this.h.keydown); window.addEventListener('keyup', this.h.keyup); window.addEventListener('blur', this.h.blur);
    for (const k of ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'contextmenu']) this.cv.addEventListener(k, this.h[k], { passive: false });
    $('flight-ui').hidden = false; this.cv.style.cursor = 'grab';
  }
  deactivate() {
    if (!this.active) return; this.active = false;
    window.removeEventListener('keydown', this.h.keydown); window.removeEventListener('keyup', this.h.keyup); window.removeEventListener('blur', this.h.blur);
    for (const k of ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'contextmenu']) this.cv.removeEventListener(k, this.h[k]);
    $('flight-ui').hidden = true; this.cv.style.cursor = 'default'; sfx.quiet();
  }

  // ---------- vessel visuals ----------
  syncViews() {
    const world = this.world;
    const alive = new Set();
    for (const v of world.vessels) {
      let view = this.views.get(v);
      if (!view) {
        view = { group: new THREE.Group(), body: new THREE.Group(), sig: -1, chutes: new Map() };
        view.group.add(view.body); this.scene.add(view.group);
        view.glow = new THREE.Mesh(glowGeo, glowMaterial(0xffc27a, 0xff3b12)); view.glow.visible = false; view.group.add(view.glow);
        this.views.set(v, view);
      }
      const sig = v.parts.length * 1000003 + (v.parts[0] ? v.parts[0].id.length : 0) + v.parts.reduce((s2, p) => s2 + (p.fairGone ? 7 : 0), 0);
      if (view.sig !== sig || view.parts0 !== v.parts[0]) {
        view.sig = sig; view.parts0 = v.parts[0];
        let ext = 1, wid = 0.5;
        for (const p of v.parts) {
          let m = this.partMeshes.get(p.id);
          if (!m) {
            if (p.def.fhalf) { m = new THREE.Group(); const h = fairingHalfMesh(p.def.fhalf.prof, p.def.fhalf.k); h.position.fromArray(p.def.fhalf.local).negate(); m.add(h); } else m = partMesh(p.def);
            m.position.copy(p.pos); m.quaternion.copy(p.quat);
            if (p.inter) m.add(interstageMesh(p.inter));
            if (p.fair && !p.fairGone) { const f = new THREE.Group(); f.add(fairingHalfMesh(p.fair.prof, 0), fairingHalfMesh(p.fair.prof, 1)); m.add(f); m.userData.fairMesh = f; }
            m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
            if (p.def.engine) {
              const E = p.def.engine, solid = E.fuelType === 'solid';
              const mats = plumeMaterial(solid, E.chem ?? 0), pm = new THREE.Mesh(plumeGeo, mats.flame);
              const er = p.def.r * (p.def.shape === 'engine' ? (E.ispSl < 200 ? 0.95 : 0.8) : 0.8);
              pm.scale.set(er, 1, er); pm.position.y = -p.def.len / 2; pm.visible = false; pm.userData.er = er; pm.frustumCulled = false; pm.renderOrder = 6;
              const shell = new THREE.Mesh(plumeGeo, mats.shell); shell.scale.set(1.75, 1.05, 1.75); shell.frustumCulled = false; shell.renderOrder = 6; pm.add(shell);
              const core = new THREE.Mesh(plumeGeo, mats.core); core.frustumCulled = false; core.renderOrder = 7; pm.add(core);
              m.add(pm); m.userData.plume = pm;
              if (p.def.les) {
                // four nozzles high on the tower, canted outward so the exhaust misses the capsule
                const L = p.def.len, yN = -L / 2 + L * 0.79, r = p.def.r;
                pm.userData.er = er * 0.35; pm.scale.set(er * 0.35, 0.45, er * 0.35); pm.userData.extra = [];
                for (let i = 0; i < 4; i++) {
                  const a = (i / 4) * Math.PI * 2, q = i === 0 ? pm : pm.clone();
                  q.position.set(Math.cos(a) * r * 0.95, yN, Math.sin(a) * r * 0.95);
                  q.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(Math.cos(a) * 0.55, -1, Math.sin(a) * 0.55).normalize());
                  if (i) { m.add(q); pm.userData.extra.push(q); }
                }
              }
            }
            if (p.def.light) this.addPartLight(m, p.def.light);
            this.partMeshes.set(p.id, m);
          }
          view.body.add(m);
          if (m.userData.fairMesh && p.fairGone) { m.remove(m.userData.fairMesh); m.userData.fairMesh = null; }
          ext = Math.max(ext, p.pos.distanceTo(v.com) + p.def.len / 2); wid = Math.max(wid, Math.hypot(p.pos.x, p.pos.z) + Math.max(p.def.r, p.def.rTop));
        }
        view.ext = ext; view.wid = wid;
      }
      for (const p of v.parts) alive.add(p.id);
    }
    for (const [v, view] of this.views) if (!world.vessels.includes(v)) { this.scene.remove(view.group); this.views.delete(v); }
    for (const [id, m] of this.partMeshes) if (!alive.has(id)) { m.parent?.remove(m); this.partMeshes.delete(id); }
  }

  updateViews() {
    const world = this.world, pl = world.planet;
    const qi = new THREE.Quaternion(), va = new THREE.Vector3();
    this.trailKeys = new Set();
    const gv = new THREE.Vector3(), gn = new THREE.Vector3(), gq2 = new THREE.Quaternion();
    let thrustSum = 0; const litPos = new THREE.Vector3(), litDown = new THREE.Vector3(), litCol = new THREE.Color(0, 0, 0);
    for (const [v, view] of this.views) {
      view.group.position.copy(v.r).sub(this.origin);
      view.group.quaternion.copy(v.q);
      view.body.position.copy(v.com).negate();
      view.group.updateMatrixWorld(true);
            const pr = pl.pressure(v.alt), vf = 1 - Math.min(1, pr);
      va.copy(v.v); va.x -= pl.omega * v.r.z; va.z += pl.omega * v.r.x;
      const sAir = va.length();
      const vb = va.applyQuaternion(qi.copy(v.q).invert()).normalize();
      for (const p of v.parts) {
        const m = this.partMeshes.get(p.id); if (!m) continue;
        const pm = m.userData.plume;
        if (pm) {
          const pw = p.thrustNow / p.def.engine.thrust;
          pm.visible = pw > 0.005 && !v.landed || (pw > 0.005);
          if (pm.userData.extra) for (const q of pm.userData.extra) q.visible = pm.visible;
          if (pm.visible) {
            const un = pm.material.uniforms, er = pm.userData.er, solid = un.uSolid.value > 0.5;
            const flick = 1 + 0.05 * Math.sin(this.time * 37 + p.id.length) * Math.sin(this.time * 23.3);
            un.uVac.value = vf; un.uTime.value = this.time; un.uR0.value = er;
            un.uPower.value = (0.35 + 0.65 * pw) * flick;
            un.uSpread.value = 1.55 + 0.35 * pw + 6 * vf * vf;
            // a real exhaust is long: it grows with the engine's thrust, not just its nozzle
            un.uLen.value = (er * 15 + 5 * Math.sqrt(p.def.engine.thrust / 1e5)) * (solid ? 1.25 : 1) * (0.45 + 0.55 * pw) * (1 + 1.2 * vf);
            un.uDia.value = un.uLen.value / (er * 2.6);
            if (v === world.active) { litCol.add(FLAME_COL[un.uChem.value | 0].clone().multiplyScalar(p.thrustNow)); thrustSum += p.thrustNow; litPos.addScaledVector(pm.getWorldPosition(gv), p.thrustNow); litDown.add(gn.set(0, -1, 0).applyQuaternion(pm.getWorldQuaternion(gq2)).multiplyScalar(p.thrustNow * er * 3)); }
            if (pr > 0.015 && this.simDt > 0) { { const hag = Math.max(0, v.alt - (v.ground || 0)); this.emitSmoke(v, p, pw, pr, er, sAir, un.uLen.value * 0.85, hag); } this.trailKeys.add(p.id); }
          }
        }
        if (p.def.deploy) m.scale.x = 0.07 + 0.93 * THREE.MathUtils.smoothstep(p.deployK, 0, 1);
        if (p.chuteOpen > 0) {
          let c = view.chutes.get(p.id);
          if (!c) {
            c = new THREE.Group();
            const rc = Math.sqrt(p.def.chute.cda / (Math.PI * 1.4)) * 0.48;
            const dome = new THREE.Mesh(new THREE.SphereGeometry(rc, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xff7a2a, side: THREE.DoubleSide, roughness: 0.9 }));
            dome.position.y = rc * 2.2; c.add(dome);
            const lines = new THREE.Mesh(new THREE.ConeGeometry(rc, rc * 2.2, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xdddddd, wireframe: true }));
            lines.rotation.x = Math.PI; lines.position.y = rc * 1.1; c.add(lines);
            view.group.add(c); view.chutes.set(p.id, c);
          }
          c.visible = true; c.position.copy(p.pos).sub(v.com);
          c.quaternion.setFromUnitVectors(Y_AXIS, sAir > 0.5 ? va.copy(vb).negate() : va.copy(v.r).normalize().applyQuaternion(qi));
          const o = p.chuteOpen; c.scale.set(0.15 + 0.85 * o * o, 0.4 + 0.6 * o, 0.15 + 0.85 * o * o);
        } else if (view.chutes.has(p.id)) view.chutes.get(p.id).visible = false;
      }
      const heat = THREE.MathUtils.clamp((v.heatFlux - 7e4) / 4e5, 0, 1);
      view.glow.visible = heat > 0.04 && !v.landed;
      if (view.glow.visible) {
        const un = view.glow.material.uniforms;
        view.glow.quaternion.setFromUnitVectors(Y_AXIS, vb);
        view.glow.position.copy(vb).multiplyScalar(view.ext * 0.9);
        view.glow.scale.set(view.wid * 1.25, 1, view.wid * 1.25);
        un.uPower.value = 0.25 + heat * 0.75; un.uLen.value = view.ext * 3 + 6; un.uSpread.value = 1.5; un.uTime.value = this.time;
      }
    }
    this.smoke.endTrails(this.trailKeys);
    // the flame lights everything around it: the pad, the tower, the smoke, the rocket's own skirt
    const L = this.engineLight;
    if (L) {
      if (thrustSum > 0) {
        litPos.divideScalar(thrustSum); litDown.divideScalar(thrustSum);
        L.position.copy(litPos).add(litDown);
        L.color.copy(litCol.multiplyScalar(1 / thrustSum));
        const fl = 0.86 + 0.14 * Math.sin(this.time * 41) * Math.sin(this.time * 17.7 + 1.3);
        L.intensity = 55 * Math.sqrt(thrustSum / 1000) * fl;
      } else L.intensity = 0;
    }
    // explosions
    for (const fx of world.fx.splice(0)) {
      if (fx.type === 'blast') { this.onBlast(fx); continue; }
      if (fx.type === 'dock') { sfx.play('snap'); sfx.play('land'); continue; }
      if (fx.type === 'puff') {
        if (pl.pressure(fx.pos.length() - pl.R) > 0.002) for (let i = 0; i < 10; i++) { const dv = new THREE.Vector3().randomDirection().multiplyScalar(fx.size * 1.5); this.smoke.emit(fx.pos.clone().add(dv.clone().multiplyScalar(0.3)), dv.add(fx.vel), fx.size * 0.4, fx.size * 1.6, 3 + Math.random() * 3, 0, null, 0.5); }
        sfx.play('stage'); continue;
      }
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 2.4, 0.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      if (pl.pressure(fx.pos.length() - pl.R) > 0.005) for (let i = 0; i < 26; i++) {
        const dv = new THREE.Vector3().randomDirection().multiplyScalar(fx.size * (2 + Math.random() * 6));
        this.smoke.emit(fx.pos.clone().addScaledVector(dv, 0.15), dv.add(fx.vel), fx.size * 0.8, fx.size * (3 + Math.random() * 3), 5 + Math.random() * 6, i < 14 ? 1 : 0.2);
      }
      m.userData = fx; this.scene.add(m); this.fxMeshes.push(m);
    }
    this.fxMeshes = this.fxMeshes.filter((m) => {
      const fx = m.userData, age = (world.t - fx.t) / 1.1;
      if (age > 1 || age < 0) { this.scene.remove(m); return false; }
      m.position.copy(fx.pos).addScaledVector(fx.vel, world.t - fx.t).sub(this.origin);
      m.scale.setScalar(fx.size * (0.4 + 1.8 * Math.sqrt(age))); m.material.opacity = 1 - age;
      return true;
    });
  }

  onBlast(fx) {
    const pl = this.world.planet;
    this.booms.add(fx, pl);
    const camW = this.camera.position.clone().add(this.origin), d = camW.distanceTo(fx.pos);
    const nuke = fx.kind === 'fission' || fx.kind === 'fusion';
    // the sound arrives at the speed of sound (none at all through vacuum)
    if (!fx.vacuum && pl.pressure(camW.length() - pl.R) > 0.01) setTimeout(() => sfx.play(nuke ? 'nuke' : 'boom'), Math.min(25, d / 340) * 1000 / Math.max(1, this.world.warp));
    else if (d < fx.Rfb * 6) sfx.play('boom');
    if (nuke && this.world.warp > 4) this.setWarp(-99);
  }
  blastDist() { let d = 0; const c = this.camera.position.clone().add(this.origin); for (const b of this.booms.list) d = Math.max(d, c.distanceTo(b.pos)); return d; }
  // craters and charring painted on the ground, and the fireball's light on it
  updateBlastMarks(theta) {
    const w = this.world, pl = w.planet, su = this.sky.material.uniforms, site = w.siteFixed;
    const sE = new THREE.Vector3().crossVectors(Y_AXIS, site).normalize(), sN = new THREE.Vector3().crossVectors(site, sE);
    let n = 0;
    for (const c of w.craters) {
      if (n >= 8) break;
      const off = new THREE.Vector3().fromArray(c.d).sub(site).multiplyScalar(pl.R);
      if (off.length() > 1.6e5) continue;
      su.uCrater.value[n++].set(off.dot(sE), off.dot(sN), c.rc, c.rs);
    }
    su.uCraterN.value = n;
    const L = this.booms.lit;
    if (L && L.I > 0.01) {
      const f = L.C.clone().applyAxisAngle(Y_AXIS, -theta), off = f.clone().normalize().sub(site).multiplyScalar(pl.R);
      su.uFlashP.value.set(off.dot(sE), off.dot(sN), Math.max(L.R * 0.5, f.length() - pl.R - (this.terrain ? this.terrain.groundAt(L.C, theta) : 0)), 0);
      const T = L.T, col = T > 5000 ? [1, 0.95, 0.9] : T > 2500 ? [1, 0.7, 0.4] : [1, 0.38, 0.12];
      const k = L.I * L.R * L.R * 0.6;
      su.uFlashC.value.set(col[0] * k, col[1] * k, col[2] * k);
    } else su.uFlashC.value.set(0, 0, 0);
  }

  emitSmoke(v, p, pw, pr, er, sAir, offset = 0, hag = 1e9) {
    const solid = p.def.engine.fuelType === 'solid', thin = 1 / Math.sqrt(Math.max(0.2, pr));
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(p.quat).applyQuaternion(v.q);
    const noz = p.pos.clone().sub(v.com).addScaledVector(new THREE.Vector3(0, -1, 0).applyQuaternion(p.quat), p.def.les ? -p.def.len * 0.29 : p.def.len / 2).applyQuaternion(v.q).add(v.r);
    // height of this nozzle (not the rocket's centre) above the ground: puffs must start above the pad
    const hn = Math.max(0, noz.length() - this.world.planet.R - (v.ground || 0));
    offset = Math.min(offset, hn * 0.7);
    // close to the ground the exhaust hits the pad and boils up into a towering cloud
    const gk = Math.max(0, 1 - hn / 35);
    const size0 = er * (solid ? 3.2 : 2.6), size1 = (er * (solid ? 14 : 10) + (solid ? 10 : 6)) * thin * (1 + 1.3 * gk);
    const om = this.world.planet.omega, air = new THREE.Vector3(om * noz.z, 0, -om * noz.x);
    this.smoke.trail(p.id, noz, air, down, {
      size0, size1, life: (solid ? 16 : 10) * (0.5 + 0.5 * pw) * (1 + 1.2 * gk), opacity: Math.min(1, pr * 3 * (solid ? 1 : 0.7) * (0.5 + 0.5 * pw) * (1 + 0.8 * gk)),
      push: 40 + 20 * gk, spacing: Math.max(size0 * 0.35, sAir / 140), minRate: (solid ? 36 : 26) * (1 + gk), offset,
      // smoke leaves the end of the flame still moving with the rocket, then brakes: the trail continues the flame's line
      carry: gk > 0 ? null : v.v.clone().sub(air).multiplyScalar(0.9),   // near the pad the exhaust slams into the ground instead
    }, this.simDt);
  }


  // Light parts: a real light for the first few of each kind (each one costs shading everywhere), the rest glow only.
  addPartLight(m, L) {
    const n = (this.partLightN ||= {});
    n[L.kind] = (n[L.kind] || 0) + 1;
    if (n[L.kind] > (L.kind === 'spot' ? 4 : 2)) return;
    const at = new THREE.Vector3(...L.at);
    let l;
    if (L.kind === 'spot') {
      l = new THREE.SpotLight(0xfff0dc, 0, 0, 0.42, 0.6, 2);
      l.target.position.copy(at).addScaledVector(new THREE.Vector3(...L.dir).normalize(), 10); m.add(l.target);
      l.userData.I = 1400;
    } else {
      l = new THREE.PointLight(L.kind === 'red' ? 0xff2a1a : L.kind === 'green' ? 0x30ff70 : 0xeef2ff, 0, 0, 2);
      l.userData.I = L.kind === 'strobe' ? 90 : 6;
    }
    l.position.copy(at); l.userData.kind = L.kind; m.add(l);
    (this.partLights ||= []).push(l);
  }
  updatePartLights() {
    const on = this.lightsOn !== false, t = this.time, LM = lightMats();
    const strobe = on && (t % 1.3) < 0.07 ? 1 : 0;
    for (const k of ['spot', 'red', 'green']) LM[k].color.copy(LM.base[k]).multiplyScalar(on ? 1 : 0.04);
    LM.strobe.color.copy(LM.base.strobe).multiplyScalar(strobe ? 3 : 0.04);
    for (const l of this.partLights || []) l.intensity = l.userData.I * (l.userData.kind === 'strobe' ? strobe : on ? 1 : 0);
  }

  // The cloud march uses a different random offset every frame; this pass blends each frame with the last
  // one (re-projected for the camera's turn, clamped to the current neighbourhood so nothing smears), only
  // where the pixel shows volumetric cloud. Ground and clear sky pass straight through, as sharp as rendered.
  // The sky and ground are shaded at reduced resolution (they are the frame's most expensive pixels). This pass
  // brings them up to the frame's own size with a Catmull-Rom bicubic filter (much sharper than bilinear), clamped
  // to the source pixels around it so edges get no halos, plus a light sharpen; and steadies the volumetric
  // clouds over time.
  resolveSky(cam, sw, sh, w, h) {
    let T = this.taa;
    if (!T) {
      const mk = () => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      const mat = new THREE.ShaderMaterial({
        uniforms: { tCur: { value: null }, tHist: { value: null }, uRot: { value: new THREE.Matrix3() }, uPrevInv: { value: new THREE.Matrix3() }, uTan: { value: 1 }, uAspect: { value: 1 }, uValid: { value: 0 }, uTexel: { value: new THREE.Vector2() }, uSrc: { value: new THREE.Vector2(1, 1) }, uSharp: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: /* glsl */`
          uniform sampler2D tCur, tHist; uniform mat3 uRot, uPrevInv; uniform float uTan, uAspect, uValid, uSharp; uniform vec2 uTexel, uSrc;
          varying vec2 vUv;
          // Catmull-Rom in 9 bilinear taps (the weights of the middle pair folded into one fetch)
          vec3 cubic(vec2 uv) {
            vec2 sp = uv * uSrc, tp = floor(sp - 0.5) + 0.5, f = sp - tp;
            vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f), w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
            vec2 w12 = w1 + w2, t0 = (tp - 1.0) / uSrc, t3 = (tp + 2.0) / uSrc, t12 = (tp + w2 / w12) / uSrc;
            vec3 r = texture2D(tCur, vec2(t0.x, t0.y)).rgb * w0.x * w0.y + texture2D(tCur, vec2(t12.x, t0.y)).rgb * w12.x * w0.y + texture2D(tCur, vec2(t3.x, t0.y)).rgb * w3.x * w0.y
                   + texture2D(tCur, vec2(t0.x, t12.y)).rgb * w0.x * w12.y + texture2D(tCur, vec2(t12.x, t12.y)).rgb * w12.x * w12.y + texture2D(tCur, vec2(t3.x, t12.y)).rgb * w3.x * w12.y
                   + texture2D(tCur, vec2(t0.x, t3.y)).rgb * w0.x * w3.y + texture2D(tCur, vec2(t12.x, t3.y)).rgb * w12.x * w3.y + texture2D(tCur, vec2(t3.x, t3.y)).rgb * w3.x * w3.y;
            return r;
          }
          void main() {
            vec4 c = texture2D(tCur, vUv);
            // the four source pixels round this one: their range bounds the sharp result (no ringing, no halos)
            vec2 st = (floor(vUv * uSrc - 0.5) + 0.5) / uSrc;
            vec3 a0 = texture2D(tCur, st).rgb, a1 = texture2D(tCur, st + vec2(uTexel.x, 0.0)).rgb, a2 = texture2D(tCur, st + vec2(0.0, uTexel.y)).rgb, a3 = texture2D(tCur, st + uTexel).rgb;
            vec3 lo = min(min(a0, a1), min(a2, a3)), hi = max(max(a0, a1), max(a2, a3));
            vec3 cs = cubic(vUv);
            // a light unsharp mask against the bilinear value, kept inside the local range
            cs = clamp(cs + (cs - c.rgb) * uSharp, lo, hi);
            c.rgb = cs;
            float cloud = 1.0 - c.a;
            vec3 mn = c.rgb, mx = c.rgb, m2 = vec3(0.0);
            for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
              vec3 v = texture2D(tCur, vUv + vec2(i, j) * uTexel).rgb; mn = min(mn, v); mx = max(mx, v); m2 += v;
              cloud = max(cloud, 1.0 - texture2D(tCur, vUv + vec2(i, j) * uTexel).a);
            }
            vec3 outc = c.rgb;
            if (uValid > 0.5 && cloud > 0.002) {
              vec2 ndc = vUv * 2.0 - 1.0;
              vec3 p = uPrevInv * (uRot * vec3(ndc.x * uTan * uAspect, ndc.y * uTan, -1.0));
              vec2 pu = vec2(p.x / (-p.z) / (uTan * uAspect), p.y / (-p.z) / uTan) * 0.5 + 0.5;
              if (p.z < 0.0 && pu.x > 0.0 && pu.x < 1.0 && pu.y > 0.0 && pu.y < 1.0) {
                vec3 hc = clamp(texture2D(tHist, pu).rgb, mn, mx);
                outc = mix(c.rgb, hc, 0.9 * smoothstep(0.0, 0.25, cloud));
              }
            }
            gl_FragColor = vec4(outc, 1.0);
          }`,
        depthTest: false, depthWrite: false,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); quad.frustumCulled = false;
      const scene = new THREE.Scene(); scene.add(quad);
      T = this.taa = { a: mk(), b: mk(), mat, scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), prev: new THREE.Matrix3(), valid: false };
    }
    if (T.a.width !== w || T.a.height !== h) { T.a.setSize(w, h); T.b.setSize(w, h); T.valid = false; }
    T.mat.uniforms.uSrc.value.set(sw, sh); T.mat.uniforms.uSharp.value = sw < w * 0.98 ? 0.35 : 0.12;
    const u = T.mat.uniforms, rot = new THREE.Matrix3().setFromMatrix4(cam.matrixWorld);
    u.tCur.value = this.skyRT.texture; u.tHist.value = T.b.texture;
    u.uRot.value.copy(rot); u.uPrevInv.value.copy(T.prev).transpose();
    u.uTan.value = Math.tan((cam.fov * Math.PI) / 360); u.uAspect.value = cam.aspect; u.uValid.value = T.valid ? 1 : 0; u.uTexel.value.set(1 / sw, 1 / sh);
    const r = this.renderer; r.setRenderTarget(T.a); r.render(T.scene, T.cam); r.setRenderTarget(null);
    T.prev.copy(rot); T.valid = true;
    [T.a, T.b] = [T.b, T.a];
    return T.b.texture;
  }

  // ---------- input ----------
  onKey(e, down) {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (down) this.keys.add(k); else this.keys.delete(k);
    if (!down) return;
    if ([' ', 'ArrowUp', 'ArrowDown', '/', "'", 'Backspace', 'F1'].includes(k)) e.preventDefault();
    if (e.repeat) return;
    const a = this.world.active;
    if (k === ' ') this.stage();
    else if (k === 'z') { if (a) a.throttle = 1; }
    else if (k === 'x') { if (a) a.throttle = 0; }
    else if (k === 't') this.toggleSAS();
    else if (k === 'r') this.toggleRCS();
    else if (k === 'm') this.toggleMap();
    else if (k === '.') this.setWarp(1);
    else if (k === ',') this.setWarp(-1);
    else if (k === '/') this.setWarp(-99);
    else if (k === 'g') this.setAuto(!this.autoSteer);
    else if (k === 'p') { this.paused = !this.paused; this.toast('info', this.paused ? 'Paused' : 'Resumed'); }
    else if (k === '?' || k === 'F1') $('f-help').hidden = !$('f-help').hidden;
    else if (k === 'u') { if (a && !this.world.undock(a)) this.toast('warn', 'Nothing docked'); }
    else if (k === 'o') { const r = a && this.world.toggleDeploy(a); if (r == null) this.toast('warn', 'No folding arrays on this craft'); else this.toast('info', r ? 'Unfolding arrays' : 'Folding arrays'); }
    else if (k === 'b') { if (a && !this.world.detonateArmed(a)) this.toast('warn', 'No armed warheads. Stage them first to arm them.'); }
    else if (k === 'Backspace') { e.preventDefault(); if (a && !this.world.abort(a)) this.toast('warn', 'No escape tower to fire'); else sfx.play('ignite'); }
    else if (k === 'v') this.toggleVessels();
    else if (k === 'y') { const n = this.nearby(1e9).find((v) => !v.isDebris) || this.nearby(1e9)[0]; this.setTarget(this.target ? null : n); }
    else if (k === ']' || k === '[') { const list = this.nearby(this.world.loadR).filter((v) => v.hasControl); if (list.length) this.switchTo(k === ']' ? list[0] : list[list.length - 1]); else this.toast('warn', 'No other craft you can fly within 2.5 km. Use the craft list (V).'); }
    else if (k === 'i') this.toggleData();
    else if (k === 'l') { this.lightsOn = this.lightsOn === false; if (Object.keys(this.partLightN || {}).length) this.toast('info', this.lightsOn ? 'Lights on' : 'Lights off'); }
    else if (k === 'Escape') $('f-help').hidden = true;
  }
  onDrag(e) {
    if (!this.drag) return;
    const o = this.map ? this.mapOrb : this.cam;
    o.az -= e.movementX * 0.006;
    o.el = THREE.MathUtils.clamp(o.el + e.movementY * 0.005, -1.5, 1.5);
  }
  onWheel(e) {
    e.preventDefault();
    const f = Math.exp(e.deltaY * 0.0012);
    if (this.map) this.mapOrb.dist = THREE.MathUtils.clamp(this.mapOrb.dist * f, (this.world.planet.R / 1000) * 1.15, 2e6);
    else this.cam.dist = THREE.MathUtils.clamp(this.cam.dist * f, 4, this.spectate ? 160000 : 20000);
  }
  stage() {
    const a = this.world.active; if (!a || this.paused) return;
    const first = a.nextStage === 0;
    if (!a.activateNextStage(this.world)) this.toast('warn', a.hasControl ? 'Nothing left to stage' : 'No control: the command part is gone');
    else sfx.play(first ? 'ignite' : 'stage');
    this.updateHUD();
  }
  toggleData() { const p = $('f-left'); p.hidden = !p.hidden; $('f-data-btn').classList.toggle('on', !p.hidden); this.updateHUD(); }
  setAuto(on) {
    const a = this.world.active; if (!a) return;
    this.autoSteer = on && !!this.guide;
    if (!this.autoSteer && a.sasMode === 'target') { a.sasMode = 'hold'; a.sasQ = null; }
    this.updateHUD();
  }
  toggleSAS() { const a = this.world.active; if (!a) return; this.autoSteer = false; a.sas = !a.sas; a.sasMode = a.sasMode === 'target' ? 'hold' : a.sasMode; a.sasQ = null; this.showSas(); }
  toggleRCS() { const a = this.world.active; if (!a) return; a.rcs = !a.rcs; this.showSas(); }
  setSasMode(m) { const a = this.world.active; if (!a) return; this.autoSteer = false; a.sas = true; a.sasMode = m; a.sasQ = null; this.showSas(); }
  showSas() {
    const a = this.world.active; if (!a) return;
    const cur = this.autoSteer ? 'auto' : !a.sas ? 'off' : a.sasMode;
    this.autoBtn.classList.toggle('on', this.autoSteer); this.autoBtn.hidden = !this.guide;
    for (const [m, b] of Object.entries(this.sasBtns)) b.classList.toggle('on', m === cur);
    this.rcsBtn.classList.toggle('on', a.rcs);
    this.tgtBtn.hidden = this.killBtn.hidden = !this.target;
    this.tgtBtn.classList.toggle('on', cur === 'totarget'); this.killBtn.classList.toggle('on', cur === 'relretro');
  }
  showThrottle(a) {
    const t = a.throttle;
    $('f-thr-txt').textContent = Math.round(t * 100);
    $('f-throttle-fill').style.height = `${t * 100}%`; $('f-throttle-knob').style.bottom = `${t * 100}%`;
  }
  toggleMap() { this.map = !this.map; if (this.taa) this.taa.valid = false; $('f-map').classList.toggle('on', this.map); $('f-labels').innerHTML = ''; this.labels = {}; }
  setWarp(d) {
    const w = this.world;
    let i = THREE.MathUtils.clamp(d === -99 ? 0 : this.warpIdx + d, 0, WARPS.length - 1);
    if (WARPS[i] > 4 && !w.canRails()) { i = 2; this.toast('warn', 'Faster than 4× only works in space with engines off'); }
    this.warpIdx = i; w.warp = WARPS[i];
  }
  toast(type, text) {
    const el = document.createElement('div'); el.className = `msg ${type}`; el.textContent = text;
    const box = $('f-msgs'); box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), type === 'great' ? 9000 : 5000);
  }

  // ---------- frame ----------
  frame(dt, w, h) {
    this.lastDt = dt;
    const world = this.world, pl = world.planet;
    this.time += dt;
    const a = world.active;
    if (a && !this.paused) {
      const K = this.keys;
      // Steering follows the screen: A/D lean the rocket left/right as you see it, W/S away/toward you.
      const hx = (K.has('d') ? 1 : 0) - (K.has('a') ? 1 : 0), vy = (K.has('w') ? 1 : 0) - (K.has('s') ? 1 : 0);
      if (hx || vy) {
        if (this.autoSteer) this.setAuto(false);
        const m = this.camera.matrixWorld.elements;
        const w = new THREE.Vector3(m[8], m[9], m[10]).multiplyScalar(-hx).add(new THREE.Vector3(m[0], m[1], m[2]).multiplyScalar(-vy));
        w.applyQuaternion(a.q.clone().invert());
        a.input.pitch = THREE.MathUtils.clamp(w.x * 1.2, -1, 1); a.input.yaw = THREE.MathUtils.clamp(w.z * 1.2, -1, 1);
      } else { a.input.pitch = 0; a.input.yaw = 0; }
      a.input.roll = (K.has('e') ? 1 : 0) - (K.has('q') ? 1 : 0);
      // RCS translation, relative to the nose and to the screen
      const tI = (K.has('i') ? 1 : 0) - (K.has('k') ? 1 : 0), tJ = (K.has('l') ? 1 : 0) - (K.has('j') ? 1 : 0), tH = (K.has('h') ? 1 : 0) - (K.has('n') ? 1 : 0);
      if (tI || tJ || tH) {
        const m = this.camera.matrixWorld.elements, qi = a.q.clone().invert(), nose = new THREE.Vector3(0, 1, 0);
        const rt = new THREE.Vector3(m[0], m[1], m[2]).applyQuaternion(qi), upS = new THREE.Vector3(m[4], m[5], m[6]).applyQuaternion(qi);
        rt.addScaledVector(nose, -rt.dot(nose)).normalize(); upS.addScaledVector(nose, -upS.dot(nose)).addScaledVector(rt, -upS.dot(rt)).normalize();
        const t = nose.multiplyScalar(tI).addScaledVector(rt, tJ).addScaledVector(upS, tH);
        a.input.tx = t.x; a.input.ty = t.y; a.input.tz = t.z;
        if (!a.rcs && !this.rcsHint) { this.rcsHint = true; this.toast('info', 'Switch RCS on (R) to move sideways'); }
      } else { a.input.tx = 0; a.input.ty = 0; a.input.tz = 0; }
      const th = (K.has('Shift') || K.has('ArrowUp') ? 1 : 0) - (K.has('Control') || K.has('ArrowDown') ? 1 : 0);
      if (th) a.throttle = THREE.MathUtils.clamp(a.throttle + th * dt * 0.7, 0, 1);
    }
    const t0 = world.t;
    if (!this.paused) {
      world.update(dt);
      if (WARPS[this.warpIdx] !== world.warp) this.warpIdx = Math.max(0, WARPS.indexOf(world.warp));
    }
    for (const e of world.events.splice(0)) {
      if (e.text.startsWith('You are in space') || e.text.startsWith('ORBIT') || e.text.startsWith('Liftoff')) continue; // goals announce these
      if (e.type === 'bad') { this.lastBad = e.text; if (/destroyed/.test(e.text)) sfx.play('boom'); }
      else if (/Parachute deployed/.test(e.text)) sfx.play('chute');
      else if (e.type === 'warn') sfx.play('warn');
      if (e.text.startsWith('Touchdown')) { sfx.play('land'); this.endCard('Touchdown', `Safe landing. Highest point ${fmtDist(this.maxAlt)}, flight time ${fmtTime(world.t)}.`, true); continue; }
      if (e.text === 'Vehicle destroyed.') continue;
      this.toast(e.type === 'stage' ? 'info' : e.type, e.text);
    }
    // your own warhead went off: no end card, a camera that stays on the blast and backs off to take in the cloud
    const lb = world.lastBlast;
    if (world.activeLost && !this.ended && lb && world.t - lb.t < 3) {
      this.ended = true;
      const up = lb.pos.clone().normalize(), ground = this.terrain ? this.terrain.groundAt(lb.pos, world.theta()) : 0;
      this.spectate = { fixed: up.multiplyScalar(pl.R + ground).applyAxisAngle(Y_AXIS, -world.theta()) };
      const nuke = lb.kt >= 0.1, Rfb = 66 * Math.pow(lb.kt, 0.4);
      this.cam.dist = nuke ? THREE.MathUtils.clamp(Math.max(Rfb * 16, cloudTop(lb.kt) * (pl.atmK > 1 ? 1.3 : 2.4)), 2500, 150000) : 400;
      this.cam.el = 0.1;
      const y = lb.kt >= 1000 ? `${(lb.kt / 1000).toFixed(lb.kt >= 10000 ? 0 : 1)} megatons` : lb.kt >= 1 ? `${Math.round(lb.kt)} kilotons` : `${Math.round(lb.kt * 1e6)} kg of TNT`;
      this.bigMoment(y, 'Scroll to zoom · drag to look around · ‹ Hangar or Restart when you are done');
    }
    if (world.activeLost && !this.ended) { this.ended = true; sfx.play('fail');
      const why = /overheated/.test(this.lastBad) ? 'It burned up in the air. Come back with a heat shield under the capsule and choose Retrograde so the shield faces forward.'
        : this.goalIdx >= 4 || this.maxAlt > pl.spaceLine * 0.3 ? 'It hit the ground too fast. Press Space until the parachute is armed before you come down.'
          : 'It came down hard. Keep the nose inside the square marker, or switch on Auto-steer and watch how it flies.';
      this.endCard('Lost the rocket', `It got to ${fmtDist(this.maxAlt)}. ${why}`, false); }
    this.simDt = world.t - t0;
    if (world.active && world.active !== a && world.vessels.includes(world.active)) { this.refreshStageInfo(); }
    if (this.target && !world.vessels.includes(this.target)) this.setTarget(null);
    this.persistT += dt; if (this.persistT > 20) { this.persistT = 0; this.persist(); }
    this.syncViews();
    if (world.vessels.includes(a)) this.origin.copy(a.r);
    else if (this.spectate) this.origin.copy(this.spectate.fixed).applyAxisAngle(Y_AXIS, world.theta());
    this.resizePipeline(w, h);
    const theta = world.theta();

    if (this.map) this.renderMap(w, h, theta);
    else {
      const up = this.origin.clone().normalize();
      let east = new THREE.Vector3().crossVectors(Y_AXIS, up);
      if (east.lengthSq() < 1e-8) east.set(1, 0, 0); east.normalize();
      const north = new THREE.Vector3().crossVectors(up, east);
      const c = this.cam, ce = Math.cos(c.el);
      const off = north.multiplyScalar(Math.cos(c.az) * ce * c.dist).addScaledVector(east, Math.sin(c.az) * ce * c.dist).addScaledVector(up, Math.sin(c.el) * c.dist);
      const cp = this.origin.clone().add(off);
      let camAlt = cp.length() - pl.R;
      const camG = this.terrain ? this.terrain.groundAt(cp, theta) : 0;      // keep the camera above hills too
      if (camAlt - camG < 1.5) { off.addScaledVector(up, 1.5 + camG - camAlt); cp.copy(this.origin).add(off); camAlt = cp.length() - pl.R; }
      const cam = this.camera;
      cam.aspect = w / h; cam.near = Math.max(0.5, c.dist * 0.025); cam.far = Math.max(25000, c.dist * 60, this.booms.list.length ? Math.min(400000, this.booms.reach() * 3 + this.blastDist()) : 0); cam.updateProjectionMatrix();
      cam.position.copy(off);
      if (this.shake > 0.001) { const k = this.shake * c.dist * 0.02, t = this.time; cam.position.x += Math.sin(t * 43.1) * k; cam.position.y += Math.sin(t * 37.7 + 1) * k; cam.position.z += Math.sin(t * 29.3 + 2) * k * 0.6; this.shake *= Math.exp(-dt * 2.2); }
      if (a && a.thrust > 0 && !this.paused) { const k = Math.min(1, a.thrust / (a.mass * 18)) * (0.25 + 0.75 * Math.min(1, pl.pressure(a.alt))) * c.dist * 0.0022; const t = this.time; cam.position.x += Math.sin(t * 31.7) * Math.sin(t * 7.3) * k * 0.5; cam.position.y += Math.sin(t * 27.1 + 1.3) * Math.sin(t * 5.9) * k * 0.5; cam.position.z += Math.sin(t * 23.3 + 2.1) * k * 0.3; }
      cam.up.copy(up); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
      this.sky.userData.viewH = Math.max(16, Math.round((this.ph || h) * (cp.length() - pl.R < 15000 / Math.sqrt(pl.atmK) ? (this.resScale >= 0.9 ? 1 : Math.min(1, (this.skyScale || 0.6) + 0.25)) : (this.skyScale || 0.6))));
      updateSky(this.sky, { camera: cam, camPos: cp, theta, planet: pl, sunDir: this.sunDir, siteFixed: world.siteFixed, time: world.t, volumetric: true });
      // site
      const sUp = world.siteDir();
      const sPos = sUp.clone().multiplyScalar(pl.R).sub(this.origin);
      this.site.visible = sPos.length() < 60000;
      if (this.site.visible) {
        const sE = new THREE.Vector3().crossVectors(Y_AXIS, sUp).normalize(), sS = new THREE.Vector3().crossVectors(sE, sUp);
        this.site.position.copy(sPos); this.site.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(sE, sUp, sS));
      }
      this.site.userData.update(this.paused ? 0 : dt, { launched: !a || a.launched, night: 1 - THREE.MathUtils.smoothstep(sUp.dot(this.sunDir), -0.04, 0.1), time: this.time });
      // sunlight reddened by the air it passes through (and cut off by the planet)
      const vAlt = this.origin.length() - pl.R;
      const T = sunTransmittance(pl, vAlt, up.dot(this.sunDir), this.sunLight.color);
      this.sunLight.intensity = SUN_E;
      this.sunLight.position.copy(this.sunDir).multiplyScalar(600); this.sunLight.target.position.set(0, 0, 0);
      const view = a && this.views.get(a), S = vAlt - this.alt0 < 600 ? Math.max(110, (view?.ext || 10) * 1.6) : Math.max(25, (view?.ext || 10) * 1.6);
      const sc = this.sunLight.shadow.camera;
      if (Math.abs(sc.right - S) > 0.5) { sc.left = -S; sc.right = S; sc.top = S; sc.bottom = -S; sc.near = 1; sc.far = 1400; sc.updateProjectionMatrix(); }
      // reflections and ambient light come from the sky itself, re-rendered twice a second
      this.envT += dt;
      if (this.envT > (this.time < 3 ? 0.4 : 3)) {
        this.envT = 0;
        const rt = this.pmrem.fromScene(this.sky.userData.envScene, 0, 0.1, 10);
        this.scene.environment = rt.texture;
        if (this.envRT) this.envRT.dispose();
        this.envRT = rt;
      }
      // eye adaptation: open up at night, close down in sunlight
      // aerial perspective for meshes (the range, buildings, smoke): the same haze the sky shader puts on the ground
      {
        const k = pl.atmK, camAlt = cp.length() - pl.R, dens = (k > 1 ? 1 / 6000 : 1 / 18000) * Math.exp(-Math.max(0, camAlt) / (8000 / k));
        if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(0xffffff, dens);
        const day = THREE.MathUtils.smoothstep(up.dot(this.sunDir), -0.12, 0.25);
        this.scene.fog.density = dens;
        this.scene.fog.color.setRGB(0.05 + 0.6 * T.r, 0.08 + 0.75 * T.g, 0.14 + 0.9 * T.b).multiplyScalar(SUN_E * 0.16 * day + 0.002);
      }
      const lum = 0.2126 * T.r + 0.7152 * T.g + 0.0722 * T.b;
      let target = THREE.MathUtils.lerp(3.2, 1.0, THREE.MathUtils.smoothstep(lum, 0.0, 0.35));
      // a camera filming a launch at night stops down for the flame, so its colours do not burn out to white
      const flameK = this.engineLight && this.engineLight.intensity > 0 ? THREE.MathUtils.clamp(1 - this.cam.dist / 500, 0, 1) : 0;
      target = THREE.MathUtils.lerp(target, Math.min(target, 1.35), flameK);
      this.exposure += (target - this.exposure) * (1 - Math.exp(-dt * 2.5));
      const sm = this.smoke.mat.uniforms;
      sm.uSunCol.value.set(T.r, T.g, T.b).multiplyScalar(SUN_E);
      const day = THREE.MathUtils.smoothstep(up.dot(this.sunDir), -0.15, 0.3) * Math.max(0.05, 1 - vAlt / pl.atmTop);
      sm.uAmb.value.set(0.06, 0.09, 0.14).multiplyScalar(SUN_E * day + 0.01);
      sm.uSunV.value.copy(this.sunDir).transformDirection(cam.matrixWorldInverse);
      {
        const camAlt = cp.length() - pl.R;
        sunTransmittance(pl, camAlt, cp.clone().normalize().dot(this.sunDir), this.sunCol);
        const occ = [this.site.children[1]]; for (const vw of this.views.values()) occ.push(vw.body);
        this.sun.update(cam, cp, this.sunDir, pl.R, this.sunCol, occ, THREE.MathUtils.clamp(1 - camAlt / pl.atmTop, 0, 1), this.terVis ?? 1);
      }
      this.smoke.update(this.paused ? 0 : this.simDt, pl, this.origin, cam, up, sPos.dot(up));
      {
        const tr = this.terrain, th2 = theta;
        const sc = new THREE.Vector3(this.sunCol.r, this.sunCol.g, this.sunCol.b).multiplyScalar(SUN_E), am = sm.uAmb.value.clone();
        this.booms.update(this.simDt, world, this.origin, cam, this.sunDir, sc, am, tr ? (x) => tr.groundAt(x, th2) : null);
        this.updateBlastMarks(theta);
        // shock arriving at the camera: a jolt, and the flash in the eye
        for (const b of this.booms.list) {
          if (b.shook || b.vacuum) continue;
          const d = cp.distanceTo(b.fixed.clone().applyAxisAngle(Y_AXIS, theta));
          const E = Math.max(b.kt, 1e-6) * 4.184e12, Rs = Math.max(1.03 * Math.pow((E * b.age * b.age) / Math.max(b.rho, 1e-6), 0.2), 340 * b.age);
          if (Rs >= d) { b.shook = true; this.shake = Math.min(1.5, this.shake + Math.min(1.2, 40 * Math.pow(b.Rfb / d, 1.2))); }
        }
        const fl = $('f-flash'); const f = this.booms.flash; fl.style.opacity = f > 0.004 ? Math.min(1, f).toFixed(3) : '0';
      }
      this.updateViews();
      this.updatePartLights();
      {
        // near the ground the planet fills the view and its fine detail needs full resolution (a reduced
        // buffer turns forest texture into staircases); higher up, sky and limb are soft and half-res is fine
        const lowCam = cp.length() - pl.R < 15000 / Math.sqrt(pl.atmK);
        const ss = lowCam ? (this.resScale >= 0.9 ? 1 : Math.min(1, this.skyScale + 0.3)) : this.skyScale;
        const sw = Math.max(16, Math.round(this.pw * ss)), sh = Math.max(16, Math.round(this.ph * ss));
        this.renderTerrain(cam, cp, theta, sw, sh);
        if (!this.skyRT) this.skyRT = new THREE.WebGLRenderTarget(sw, sh, { type: THREE.HalfFloatType, depthBuffer: false });
        else if (this.skyRT.width !== sw || this.skyRT.height !== sh) this.skyRT.setSize(sw, sh);
        this.frameN = ((this.frameN || 0) + 1) % 64; this.sky.material.uniforms.uFrame.value = this.frameN;
        const r = this.renderer; r.setRenderTarget(this.skyRT); r.render(this.skyScene, cam); r.setRenderTarget(null);
        this.scene.background = this.resolveSky(cam, sw, sh, this.pw, this.ph);
      }
      this.renderPass.scene = this.scene; this.renderPass.camera = cam;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = this.exposure;
      this.bloom.enabled = true;
      this.composer.render(dt);
    }
    if (a && !this.paused && world.warp <= 4 && world.vessels.includes(a)) {
      const maxT = a.parts.reduce((s, p) => s + (p.def.engine && p.ignited && !p.flameout ? p.def.engine.thrust : 0), 0);
      sfx.flight(maxT > 0 ? Math.min(1, a.thrust / maxT) : 0, Math.min(1, pl.pressure(a.alt)), a.landed ? 0 : Math.min(1, a.dynP / 30000), THREE.MathUtils.clamp((a.heatFlux - 7e4) / 4e5, 0, 1));
    } else sfx.quiet();
    this.hudT -= dt; this.navT -= dt;
    if (this.hudT <= 0) { this.hudT = 0.1; this.updateHUD(); this.vesT = (this.vesT || 0) + 1; if (this.vesT % 5 === 0) this.renderVessels(); }
    if (this.navT <= 0) { this.navT = 0.033; this.drawNavball(); }
  }

  // Terrain: choose patches around the camera and draw their distance, height and normal into a small
  // G-buffer the sky shader shades (same resolution as the sky). Fades out high above the planet.
  renderTerrain(cam, cp, theta, sw, sh) {
    const ter = this.terrain, pl = this.world.planet, su = this.sky.material.uniforms;
    const camAlt = cp.length() - pl.R;
    const fade = ter ? 1 - THREE.MathUtils.smoothstep(camAlt, 0.12 * pl.R, 0.22 * pl.R) : 0;
    if (fade <= 0) { su.uTerOn.value = 0; su.uBush3D.value = 0; if (ter) { ter.group.visible = false; if (ter.bushes) ter.bushes.group.visible = false; } this.terVis = 1; return; }
    const c = Math.cos(theta), s = Math.sin(theta);
    const camF = new THREE.Vector3(c * cp.x - s * cp.z, cp.y, s * cp.x + c * cp.z);
    const rotY = (this._rotY ||= new THREE.Matrix4()).makeRotationY(theta);
    const gc = (this._gCam ||= new THREE.PerspectiveCamera());
    gc.fov = cam.fov; gc.aspect = cam.aspect; gc.near = 1; gc.far = 1e9; gc.updateProjectionMatrix();
    const rel = (this._rel ||= new THREE.Matrix4()).extractRotation(cam.matrixWorldInverse);
    rel.premultiply(gc.projectionMatrix).multiply(rotY);
    ter.nearRange = Math.min(cam.far * 0.8, 20000);
    const sd = this.sunDir, sunF = new THREE.Vector3(c * sd.x - s * sd.z, sd.y, s * sd.x + c * sd.z);
    ter.update(camF, rel, fade, sunF);
    const agl = camAlt - ter.groundAt(cp, theta);
    su.uBush3D.value = ter.bushes && ter.bushes.update(camF, agl) ? 1 : 0;
    ter.gMat.uniforms.uRelToClip.value.copy(rel); ter.gMat.uniforms.uFC.value = 2 / Math.log2(1e9 + 1);
    ter.sceneU.uCamScene.value.copy(cam.position); ter.sceneU.uRotS.value.setFromMatrix4(rotY);
    if (!this.gRT) this.gRT = new THREE.WebGLRenderTarget(sw, sh, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    else if (this.gRT.width !== sw || this.gRT.height !== sh) this.gRT.setSize(sw, sh);
    const r = this.renderer;
    r.setRenderTarget(this.gRT); r.setClearColor(0x000000, 0); r.clear(); r.render(ter.gScene, cam);
    r.setClearColor(0x000000, 1); r.setRenderTarget(null);
    su.tTer.value = this.gRT.texture; su.uTerOn.value = 1; su.uTerK.value = fade;
    ter.group.visible = fade > 0.5;
    // is the sun behind a mountain? march along the sunbeam every few frames
    this.terT = (this.terT || 0) + 1;
    if (this.terT % 4 === 0) {
      let vis = 1;
      const sun = this.sunDir, p = new THREE.Vector3();
      if (cp.clone().normalize().dot(sun) < 0.5) {
        for (let d = 40; d < 160000; d *= 1.2) {
          p.copy(cp).addScaledVector(sun, d);
          const a = p.length() - pl.R; if (a > ter.hmax) break;
          if (a < ter.groundAt(p, theta)) { vis = 0; break; }
        }
      }
      this.terVisT = vis;
    }
    this.terVis = (this.terVis ?? 1) + ((this.terVisT ?? 1) - (this.terVis ?? 1)) * 0.3;
  }

  // Keep the frame rate up on smaller GPUs: scale the render resolution with the measured frame time.
  resizePipeline(w, h) {
    if (this.resScale == null) { this.resScale = 1; this.skyScale = 0.6; this.ftAcc = 0; this.ftN = 0; }
    const dt = this.lastDt || 0.016;
    this.ftAcc += Math.min(dt, 0.25); this.ftN++;
    if (this.ftN >= 45 || (this.ftN >= 4 && this.ftAcc > 1)) {
      const avg = this.ftAcc / this.ftN; this.ftAcc = 0; this.ftN = 0;
      if (avg > 1 / 45 && this.resScale > 0.6) this.resScale = Math.max(0.6, this.resScale - 0.1);
      else if (avg < 1 / 58 && this.resScale < 1) this.resScale = Math.min(1, this.resScale + 0.05);
      this.skyScale = this.resScale < 0.8 ? 0.5 : 0.6;
    }
    const pr = Math.min(window.devicePixelRatio || 1, 1.5) * this.resScale, key = `${w}x${h}@${pr.toFixed(2)}`;
    this.pw = Math.round(w * pr); this.ph = Math.round(h * pr);
    if (key === this.sizeKey) return;
    this.sizeKey = key;
    this.composer.setPixelRatio(pr); this.composer.setSize(w, h);
  }

  orbitPoint(o, nu, out) {
    const P = o.e > 1e-6 ? o.eVec.clone().normalize() : this.origin.clone().normalize();
    const Q = new THREE.Vector3().crossVectors(o.hVec, P).normalize();
    const p = o.hVec.lengthSq() / this.world.planet.mu;
    const r = p / (1 + o.e * Math.cos(nu));
    return out.copy(P).multiplyScalar(Math.cos(nu) * r).addScaledVector(Q, Math.sin(nu) * r).multiplyScalar(0.001);
  }
  label(key, text, v3, color, w, h) {
    let el = this.labels[key];
    if (!el) { el = this.labels[key] = document.createElement('div'); el.className = 'lbl'; $('f-labels').appendChild(el); }
    const p = v3.clone().project(this.mapCam);
    const vis = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    el.style.display = vis ? '' : 'none';
    if (!vis) return;
    el.textContent = text;
    el.style.left = `${(p.x * 0.5 + 0.5) * w}px`; el.style.top = `${(-p.y * 0.5 + 0.5) * h}px`;
  }
  renderMap(w, h, theta) {
    const world = this.world, pl = world.planet, a = world.active;
    const o = this.mapOrb, ce = Math.cos(o.el);
    const cam = this.mapCam;
    cam.aspect = w / h; cam.updateProjectionMatrix();
    cam.position.set(o.dist * ce * Math.sin(o.az), o.dist * Math.sin(o.el), o.dist * ce * Math.cos(o.az));
    cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    this.mapPlanet.userData.planet.rotation.y = theta;
    this.mapPlanet.userData.mat.uniforms.uTime.value = world.t;
    const vp = this.origin.clone().multiplyScalar(0.001);
    this.mkVessel.position.copy(vp);
    const el = orbitElements(this.origin, a ? a.v : new THREE.Vector3(1, 0, 0), pl.mu, pl.R);
    const arr = this.orbitGeo.attributes.position.array, tmp = new THREE.Vector3();
    const numax = el.e < 1 ? Math.PI : Math.acos(-1 / el.e) * 0.97;
    for (let i = 0; i <= 360; i++) { this.orbitPoint(el, -numax + (2 * numax * i) / 360, tmp); arr[i * 3] = tmp.x; arr[i * 3 + 1] = tmp.y; arr[i * 3 + 2] = tmp.z; }
    this.orbitGeo.attributes.position.needsUpdate = true;
    this.orbitLine.visible = !a?.landed;
    this.mkPe.visible = this.mkAp.visible = this.orbitLine.visible;
    this.orbitPoint(el, 0, this.mkPe.position);
    if (el.e < 1) this.orbitPoint(el, Math.PI, this.mkAp.position); else this.mkAp.visible = false;
    this.label('v', a?.name || 'Rocket', vp, '#ffffff', w, h);
    if (this.mkAp.visible) this.label('ap', `Ap ${fmtDist(el.ap)}`, this.mkAp.position, '#4de1ff', w, h); else if (this.labels.ap) this.labels.ap.style.display = 'none';
    if (this.mkPe.visible && el.pe > -pl.R * 0.5) this.label('pe', `Pe ${fmtDist(el.pe)}`, this.mkPe.position, el.pe > pl.atmTop ? '#56e39f' : '#ffb347', w, h); else if (this.labels.pe) this.labels.pe.style.display = 'none';
    const debris = world.vessels.filter((v) => v !== a);
    while (this.mkDebris.length < debris.length) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.mkPe.material.map, color: 0x999999, depthTest: false, sizeAttenuation: false })); s.scale.setScalar(0.012); this.mapScene.add(s); this.mkDebris.push(s); }
    this.mkDebris.forEach((s, i) => {
      s.visible = i < debris.length; if (!s.visible) return;
      const v = debris[i]; s.position.copy(v.r).multiplyScalar(0.001);
      s.material.color.set(v === this.target ? 0xffffff : v.isDebris ? 0x777777 : 0xc8c4bb); s.scale.setScalar(v.isDebris ? 0.01 : 0.02);
    });
    // names of the craft that matter
    const named = debris.filter((v) => !v.isDebris || v === this.target).slice(0, 12);
    for (let i = 0; i < 12; i++) {
      const key = `n${i}`, v = named[i];
      if (v) this.label(key, `${v === this.target ? '◇ ' : ''}${v.name}`, v.r.clone().multiplyScalar(0.001), '#ffffff', w, h); else if (this.labels[key]) this.labels[key].style.display = 'none';
    }
    this.renderPass.scene = this.mapScene; this.renderPass.camera = cam;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.1;
    this.composer.render();
  }

  bigMoment(title, sub) {
    const el = $('f-big'); $('f-msgs').innerHTML = '';
    el.innerHTML = `<div><div class="t">${title}</div><div class="s">${sub}</div><div class="ln"></div></div>`;
    clearTimeout(this.bigT); this.bigT = setTimeout(() => { el.innerHTML = ''; }, 7200);
  }
  endCard(title, text, canContinue) {
    const end = $('f-end'); end.hidden = false;
    end.innerHTML = `<h2>${title}</h2><p>${text}</p><div class="row"></div>`;
    const row = end.querySelector('.row');
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn; row.appendChild(b); };
    if (canContinue) btn('Stay here', 'link', () => { end.hidden = true; });
    btn('Fly again', 'link', () => this.restart());
    btn('Back to hangar', 'solid', () => { this.persist(); this.onExit(); });
  }

  // ---------- HUD ----------
  coach(a, o, pl, goal) {
    const k = (s) => `<kbd>${s}</kbd>`;
    if (!a.hasControl) return '';
    if (!a.launched) return `Press ${k('Space')} to launch`;
    if (a.landed) return '';
    const up = a.r.clone().normalize(), vv = a.v.dot(up);
    const inAtm = a.alt < pl.atmTop;
    if (!goal) return 'Mission complete. The sky is yours.';
    if (goal.id === 'home') {
      if (a.thrust > 0 && o.pe > pl.atmTop) return `You are in orbit! Engines off with ${k('X')}`;
      if (o.pe > pl.atmTop * 0.6) return `You are in orbit. Look around, open the map with ${k('M')}. To come home: choose <b>Retrograde</b>, then burn (${k('Z')}) until the periapsis drops below ${fmtDist(pl.atmTop * 0.3)}`;
      if (!inAtm) return `You will fall back into the air. Speed time up with ${k('.')}`;
      const chute = a.parts.some((p) => p.def.chute && !p.armed && !p.chuteGone && p.chuteOpen === 0);
      if (chute && a.nextStage < a.stages.length) return `Press ${k('Space')} until the parachute is armed. It opens by itself low down`;
      return 'Hold on. The air is slowing you down';
    }
    const g = this.guide; if (!g) return '';
    if (g.needStage) return `This stage is empty. Press ${k('Space')} for the next one`;
    if (g.outOfFuel) return inAtm && vv < 0 ? 'Out of fuel and falling. Arm the parachute with Space if you have one' : 'Out of fuel. Not enough speed for orbit this time';
    if (g.phase === 'coast') {
      if (a.thrust > 0) return `High enough. Engines off with ${k('X')}`;
      return `Coasting up to the top of the arc. Burn in <b>${fmtTime(g.tBurn)}</b> · speed time up with ${k('.')}`;
    }
    const pre = g.phase === 'burn' ? '<b>Final burn.</b> ' : '';
    if (a.throttle < 0.5) return `${pre}Full throttle with ${k('Z')}`;
    if (this.autoSteer) return `${pre}Auto-steer is flying. You press ${k('Space')} when a stage runs dry`;
    const nose = new THREE.Vector3(0, 1, 0).applyQuaternion(a.q);
    const ang = nose.angleTo(g.dir) * 57.3;
    if (a.alt - this.alt0 < 150 / pl.atmK && ang < 8) return 'Straight up for now';
    this.onMark = ang < (this.onMark ? 10 : 5);
    if (this.onMark) return `${pre}In the square. Hold it there`;
    const w = new THREE.Vector3().crossVectors(nose, g.dir), m = this.camera.matrixWorld.elements;
    const hx = -(w.x * m[8] + w.y * m[9] + w.z * m[10]), vy = -(w.x * m[0] + w.y * m[1] + w.z * m[2]);
    const key = Math.abs(hx) >= Math.abs(vy) ? (hx > 0 ? 'D' : 'A') : (vy > 0 ? 'W' : 'S');
    return `${pre}Lean with ${k(key)} until the nose is in the square${ang > 25 ? ' · or press <b>Auto-steer</b>' : ''}`;
  }

  updateHUD() {
    const world = this.world, pl = world.planet, a = world.active;
    $('f-time').textContent = `T+ ${fmtTime(world.t)}`;
    $('f-warp').textContent = this.paused ? 'paused' : `${world.warp}×`;
    if (!a) return;
    const up = a.r.clone().normalize();
    const vs = a.v.clone(); vs.x -= pl.omega * a.r.z; vs.z += pl.omega * a.r.x;
    const o = orbitElements(a.r, a.v, pl.mu, pl.R);
    const surf = a.alt < pl.atmTop * 0.35;
    const gnd = (a.ground || 0) * THREE.MathUtils.smoothstep(a.alt, pl.spaceLine * 0.3, pl.spaceLine * 0.1);
    const alt = Math.max(0, a.alt - this.alt0 - gnd);
    this.maxAlt = Math.max(this.maxAlt, alt);
    const vtxt = `${fmt(surf ? vs.length() : a.v.length())}<i>m/s</i>`, atxt = distHTML(alt);
    if (vtxt !== this.vTxt) { this.vTxt = vtxt; $('f-vel').innerHTML = vtxt; }
    if (atxt !== this.aTxt) { this.aTxt = atxt; $('f-alt').innerHTML = atxt; }
    if (!this.thrDrag) this.showThrottle(a);
    this.showSas();

    // goal + coaching
    let goal = this.goals[this.goalIdx];
    const wasAscent = !!this.guide;
    while (goal && goal.done(a, o)) {
      if (goal.id === 'orbit') this.bigMoment('Orbit', `${fmtDist(o.pe)} × ${fmtDist(o.ap)} · ${fmt(a.v.length())} m/s`);
      if (goal.id !== 'liftoff') { if (goal.id !== 'orbit') this.toast('good', goal.title); sfx.play(goal.id === 'orbit' ? 'orbit' : goal.id === 'home' ? 'tick' : 'goal'); }
      try { const k = 'apogee.progress', p = JSON.parse(localStorage.getItem(k) || '{}'); p[goal.id] = true; localStorage.setItem(k, JSON.stringify(p)); } catch { /* ignore */ }
      goal = this.goals[++this.goalIdx];
    }
    this.guide = goal && goal.id !== 'home' && a.hasControl ? ascentGuide(a, pl) : null;
    if (this.guide && this.guide.phase === 'orbit') this.guide = null;
    if (this.autoSteer) {
      if (this.guide) {
        a.sas = true; a.sasMode = 'target'; a.sasDir.copy(this.guide.dir);
        if (a.launched) a.throttle = this.guide.phase === 'coast' ? 0 : 1;
      } else { this.autoSteer = false; a.sasMode = 'prograde'; if (wasAscent) a.throttle = 0; }
    }
    if (this.guide && this.guide.phase === 'coast' && a.thrust === 0 && world.warp > 1 && this.guide.tBurn < Math.max(10, world.warp * 2)) { this.setWarp(-99); this.toast('info', 'Time back to normal: the burn is coming up'); sfx.play('goal'); }
    if (a.maxTempFrac > 0.8 && world.t - this.heatBeep > 1.2 * world.warp) { this.heatBeep = world.t; sfx.play('warn'); }
    const gk = goal ? goal.id : 'done';
    if (gk !== this.goalKey) { this.goalKey = gk; $('f-goal-t').innerHTML = goal ? `<small>${this.goalIdx + 1} / ${this.goals.length}</small>${goal.title}` : 'Free flight'; }
    $('f-goal-bar').firstElementChild.style.width = `${THREE.MathUtils.clamp(goal ? goal.prog(a, o) : 1, 0, 1) * 100}%`;
    const coach = this.coach(a, o, pl, goal);
    if (coach !== this.coachTxt) { this.coachTxt = coach; $('f-coach').innerHTML = coach; }

    // orbit line: only once it means something
    let ol = '';
    if (!a.landed && o.e < 1 && o.ap > pl.spaceLine * 0.5) {
      const it = (l, v, dim) => `<div><small>${l}</small><b class="${dim ? 'dim' : ''}">${v}</b></div>`;
      ol = it('Apoapsis', fmtDist(o.ap), o.ap < pl.atmTop);
      if (o.pe > -pl.R * 0.9) ol += it('Periapsis', fmtDist(o.pe), o.pe < pl.atmTop);
      if (a.v.dot(up) > 0 || o.pe > 0) ol += it('Top of arc in', fmtTime(o.tAp));
    }
    const T = this.target;
    if (T) {
      const it = (l, v, dim) => `<div><small>${l}</small><b class="${dim ? 'dim' : ''}">${v}</b></div>`;
      const rel = T.r.clone().sub(a.r), dist = rel.length(), rv = a.v.clone().sub(T.v), close = dist > 0 ? rv.dot(rel) / dist : 0;
      ol = it(T.name, fmtDist(dist)) + it('Closing', `${fmt(close, Math.abs(close) < 10 ? 2 : 0)} m/s`) + it('Rel. speed', `${fmt(rv.length(), rv.length() < 10 ? 2 : 0)} m/s`);
      // lined up for docking? the nearest pair of matching free ports
      if (dist < 300 && a.ports?.length && T.ports?.length) {
        let best = null;
        for (const P of a.ports) for (const Q of T.ports) {
          if (P.def.dock.size !== Q.def.dock.size) continue;
          const pW = P.portP.clone().sub(a.com).applyQuaternion(a.q).add(a.r), qW = Q.portP.clone().sub(T.com).applyQuaternion(T.q).add(T.r);
          const d = pW.distanceTo(qW); if (!best || d < best.d) best = { d, P, Q, pW, qW };
        }
        if (best) {
          const nP = best.P.portN.clone().applyQuaternion(a.q), nQ = best.Q.portN.clone().applyQuaternion(T.q);
          const ang = Math.acos(THREE.MathUtils.clamp(-nP.dot(nQ), -1, 1)) * 57.3;
          const sep = best.qW.clone().sub(best.pW), along = sep.dot(nP), lat = sep.clone().addScaledVector(nP, -along).length();
          ol += it('Port gap', `${fmt(best.d, 2)} m`) + it('Off-axis', `${fmt(lat, 2)} m`, lat > 0.3) + it('Angle', `${fmt(ang, 1)}°`, ang > 10);
        }
      }
    }
    if (ol !== this.olTxt) { this.olTxt = ol; $('f-orbit').innerHTML = ol; }

    // fuel
    const sf = a.liquidInGroupsOfActiveEngines(), tot = a.totals();
    const bar = (label, cur, max, cls = '') => (max > 0 ? `<div class="bar ${cls}"><small>${label}<span>${fmt((cur / max) * 100)}%</span></small><i><u style="width:${(cur / max) * 100}%"></u></i></div>` : '');
    let r = '';
    if (a.maxTempFrac > 0.45) r += bar('Heat', Math.min(1, a.maxTempFrac), 1, 'heat');
    if (a.qSin > 3500 && a.launched && !a.landed) r += bar('Aero stress', Math.min(1, a.qSin / 9000), 1, 'heat');
    { const sh = a.parts.find((p) => p.def.shield && p.ablated > 0); if (sh) r += bar('Heat shield', sh.def.mass * 0.4 - sh.ablated, sh.def.mass * 0.4); }
    { const wa = a.parts.filter((p) => p.def.warhead && p.whArmed).length; if (wa) r += `<div class="bar heat"><small>ARMED<span>${wa}</span></small><i><u style="width:100%"></u></i></div>`; }
    r += bar('Boosters', tot.solid, tot.solidMax) + bar('Steering gas', tot.mono, tot.monoMax);
    r += sf.max > 0 ? bar('Stage fuel', sf.cur, sf.max) : bar('Fuel', tot.liquid, tot.liquidMax);
    $('f-fuel').innerHTML = r;

    // stages
    const sk = `${a.nextStage}/${a.launched}`;
    if (sk !== this.stageKey) {
      this.stageKey = sk;
      const left = this.stageInfo.map((types, i) => ({ types, i })).filter((x) => x.i >= a.nextStage).reverse();
      $('f-stages').innerHTML = left.map(({ types, i }) => `<div class="fstage ${i === a.nextStage ? 'next' : ''}">${types.map(([t, c]) => `<img src="${this.thumbs[t] || ''}" title="${PARTS[t].name}" alt="">${c > 1 ? `<em>×${c}</em>` : ''}`).join('')}</div>`).join('');
      const b = $('f-stage-btn'); b.classList.toggle('spent', !left.length);
      b.firstElementChild.textContent = a.nextStage === 0 ? 'Launch' : left.length ? 'Stage' : 'Empty';
    }

    // optional full telemetry
    if (!$('f-left').hidden) {
      const g = pl.mu / a.r.lengthSq(), inSpace = a.alt > pl.atmTop;
      const ro = (label, val, cls = '') => `<div class="ro"><small>${label}</small><b class="${cls}">${val}</b></div>`;
      let h = ro('Vertical speed', `${fmt(a.v.dot(up), 1)} m/s`) + ro('Orbit speed here', `${fmt(pl.vCirc(Math.max(a.alt, 0)))} m/s`);
      if (!a.landed && o.e < 1 && o.pe > 0) h += ro('Orbit period', fmtTime(o.period));
      h += '<div class="hr"></div>';
      h += ro('Mach', inSpace ? '—' : fmt(a.mach, 2)) + ro('Air pressure on hull', `${fmt(a.dynP / 1000, 1)} kPa`, a.dynP > 45000 ? 'warn' : '');
      h += ro('G-force', fmt(a.gForce, 1), a.gForce > 6 ? 'warn' : '') + ro('Thrust / weight', fmt(a.thrust / (a.mass * g), 2)) + ro('Mass', `${fmt(a.mass / 1000, 2)} t`);
      h += ro('Air', inSpace ? 'vacuum' : `${fmt(pl.pressure(a.alt) * 101.3, pl.pressure(a.alt) > 0.01 ? 1 : 3)} kPa`) + ro('Hottest part', `${fmt(Math.min(1, a.maxTempFrac) * 100)}%`, a.maxTempFrac > 0.8 ? 'warn' : '');
      $('f-left').innerHTML = h;
    }
  }

  drawNavball() {
    const a = this.world.active; if (!a) return;
    const N = this.navImg.width, C = N / 2, R = C - 1, img = this.navImg, data = img.data, S = N / 170;
    const up = a.r.clone().normalize();
    let east = new THREE.Vector3().crossVectors(Y_AXIS, up); if (east.lengthSq() < 1e-8) east.set(1, 0, 0); east.normalize();
    const north = new THREE.Vector3().crossVectors(up, east);
    // screen (x right, y up, z toward viewer) -> body (x, z, y) -> world -> local (east, north, up)
    const bx = new THREE.Vector3(1, 0, 0).applyQuaternion(a.q), by = new THREE.Vector3(0, 1, 0).applyQuaternion(a.q), bz = new THREE.Vector3(0, 0, 1).applyQuaternion(a.q);
    const m = [bx.dot(east), bz.dot(east), by.dot(east), bx.dot(north), bz.dot(north), by.dot(north), bx.dot(up), bz.dot(up), by.dot(up)];
    const lw = 0.55 / S;
    for (let py = 0; py < N; py++) {
      const y = (C - py - 0.5) / R;
      for (let px = 0; px < N; px++) {
        const x = (px + 0.5 - C) / R, i = (py * N + px) * 4, rr = x * x + y * y;
        if (rr > 1) { data[i + 3] = 0; continue; }
        const z = Math.sqrt(1 - rr);
        const e = m[0] * x + m[1] * y + m[2] * z, n = m[3] * x + m[4] * y + m[5] * z, u = m[6] * x + m[7] * y + m[8] * z;
        const elev = Math.asin(u < -1 ? -1 : u > 1 ? 1 : u) * 57.2958;
        let r, g, b;
        if (u >= 0) { r = 150 - 50 * u; g = 153 - 50 * u; b = 158 - 46 * u; } else { r = 40 + 10 * u; g = 41 + 10 * u; b = 44 + 10 * u; }
        let line = 0;
        const ae = Math.abs(elev);
        if (ae < 0.75 / S + 0.3) line = 1;
        else {
          const k = ae % 30; if ((k < lw || k > 30 - lw) && ae < 89) line = 0.45;
          const k10 = ae % 10; if (!line && (k10 < lw * 0.7 || k10 > 10 - lw * 0.7) && ae < 85) line = 0.16;
          const hd = (Math.atan2(e, n) * 57.2958 + 360) % 45, ch = Math.sqrt(1 - u * u);
          if ((hd < lw / ch || hd > 45 - lw / ch) && ae < 84) line = Math.max(line, 0.28);
        }
        const sh = 0.55 + 0.45 * z;
        data[i] = (r + (243 - r) * line) * sh; data[i + 1] = (g + (241 - g) * line) * sh; data[i + 2] = (b + (236 - b) * line) * sh; data[i + 3] = 255;
      }
    }
    const ctx = this.nav; ctx.putImageData(img, 0, 0);
    const INK = '#f3f1ec', DARK = 'rgba(8,9,11,0.85)';
    const qi = a.q.clone().invert();
    const toScreen = (dir) => { const d = dir.clone().applyQuaternion(qi); return { x: C + d.x * R, y: C - d.z * R, z: d.y }; };
    const stroke2 = (path, w) => { ctx.lineCap = 'square'; ctx.strokeStyle = DARK; ctx.lineWidth = (w + 2.5) * S; ctx.beginPath(); path(); ctx.stroke(); ctx.strokeStyle = INK; ctx.lineWidth = w * S; ctx.beginPath(); path(); ctx.stroke(); };
    ctx.font = `500 ${12 * S}px "Barlow Condensed", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [lab, d] of [['N', north], ['E', east], ['S', north.clone().negate()], ['W', east.clone().negate()]]) {
      const s = toScreen(d); if (s.z > 0.25) { ctx.fillStyle = lab === 'N' ? INK : 'rgba(243,241,236,0.6)'; ctx.fillText(lab, s.x, s.y - 9 * S); }
    }
    const pl = this.world.planet;
    const vel = a.v.clone(); if (a.alt < pl.atmTop * 0.35) { vel.x -= pl.omega * a.r.z; vel.z += pl.omega * a.r.x; }
    if (vel.length() > 1) {
      vel.normalize();
      const r = 6.5 * S;
      const pro = (s) => stroke2(() => { ctx.moveTo(s.x + r, s.y); ctx.arc(s.x, s.y, r, 0, 7); ctx.moveTo(s.x - r, s.y); ctx.lineTo(s.x - r * 1.9, s.y); ctx.moveTo(s.x + r, s.y); ctx.lineTo(s.x + r * 1.9, s.y); ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x, s.y - r * 1.9); }, 1.6);
      const retro = (s) => stroke2(() => { ctx.moveTo(s.x + r, s.y); ctx.arc(s.x, s.y, r, 0, 7); const q = r * 0.7; ctx.moveTo(s.x - q, s.y - q); ctx.lineTo(s.x + q, s.y + q); ctx.moveTo(s.x + q, s.y - q); ctx.lineTo(s.x - q, s.y + q); }, 1.6);
      const p = toScreen(vel); if (p.z > 0) pro(p);
      const q = toScreen(vel.negate()); if (q.z > 0) retro(q);
    }
    if (this.target && this.world.vessels.includes(this.target)) {
      const T = this.target, r = 7 * S;
      const tg = (s) => stroke2(() => { ctx.moveTo(s.x, s.y - r * 1.3); ctx.lineTo(s.x + r * 1.3, s.y); ctx.lineTo(s.x, s.y + r * 1.3); ctx.lineTo(s.x - r * 1.3, s.y); ctx.closePath(); ctx.moveTo(s.x + 1.5 * S, s.y); ctx.arc(s.x, s.y, 1.5 * S, 0, 7); }, 1.6);
      const at = (s) => stroke2(() => { ctx.moveTo(s.x, s.y - r * 1.3); ctx.lineTo(s.x + r * 1.3, s.y); ctx.lineTo(s.x, s.y + r * 1.3); ctx.lineTo(s.x - r * 1.3, s.y); ctx.closePath(); const q = r * 0.6; ctx.moveTo(s.x - q, s.y - q); ctx.lineTo(s.x + q, s.y + q); ctx.moveTo(s.x + q, s.y - q); ctx.lineTo(s.x - q, s.y + q); }, 1.6);
      const dirT = T.r.clone().sub(a.r).normalize();
      const s1 = toScreen(dirT); if (s1.z > 0) tg(s1);
      const s2 = toScreen(dirT.clone().negate()); if (s2.z > 0) at(s2);
      const rv = a.v.clone().sub(T.v);
      if (rv.length() > 0.02) {
        rv.normalize(); const rr = 5 * S;
        const p1 = toScreen(rv); if (p1.z > 0) stroke2(() => { ctx.moveTo(p1.x + rr, p1.y); ctx.arc(p1.x, p1.y, rr, 0, 7); ctx.moveTo(p1.x, p1.y - rr); ctx.lineTo(p1.x, p1.y - rr * 2); ctx.font = `600 ${8 * S}px sans-serif`; }, 1.3);
        const p2 = toScreen(rv.negate()); if (p2.z > 0) stroke2(() => { ctx.moveTo(p2.x + rr, p2.y); ctx.arc(p2.x, p2.y, rr, 0, 7); ctx.moveTo(p2.x - rr * 0.7, p2.y - rr * 0.7); ctx.lineTo(p2.x + rr * 0.7, p2.y + rr * 0.7); }, 1.3);
      }
    }
    if (this.guide) {
      const d = this.guide.dir.clone().applyQuaternion(qi);
      if (d.y > 0.05) {
        const x = C + d.x * R, y = C - d.z * R, h = 13 * S, c = 5 * S;
        stroke2(() => { for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.moveTo(x + sx * h, y + sy * (h - c)); ctx.lineTo(x + sx * h, y + sy * h); ctx.lineTo(x + sx * (h - c), y + sy * h); } }, 2);
      } else {
        const l = Math.hypot(d.x, d.z) || 1, ux = d.x / l, uy = -d.z / l, x = C + ux * (R - 14 * S), y = C + uy * (R - 14 * S), s = 7 * S;
        ctx.fillStyle = INK; ctx.strokeStyle = DARK; ctx.lineWidth = 2 * S;
        ctx.beginPath(); ctx.moveTo(x + ux * s * 1.3, y + uy * s * 1.3); ctx.lineTo(x - uy * s, y + ux * s); ctx.lineTo(x + uy * s, y - ux * s); ctx.closePath(); ctx.stroke(); ctx.fill();
      }
    }
    // the rocket's nose: fixed wings in the centre
    stroke2(() => { ctx.moveTo(C - 24 * S, C); ctx.lineTo(C - 9 * S, C); ctx.lineTo(C, C + 7 * S); ctx.lineTo(C + 9 * S, C); ctx.lineTo(C + 24 * S, C); ctx.moveTo(C, C - 1.5 * S); ctx.lineTo(C, C - 2 * S); }, 2.2);
  }
}
export const _g0 = G0;
