// The hangar: drag parts off the shelf onto the rocket. Parts follow the cursor and jump into
// place when they get close to where they fit.
import * as THREE from '../vendor/three.module.js';
import { gfx } from './gfx.js';
import { applyTone } from './style.js';
import { PARTS, PART_LIST, CATEGORIES } from './parts.js';
import { partMesh, setMaterial, studioEnvironment, interstageMesh, fairingHalfMesh } from './meshes.js';
import {
  newDesign, cloneDesign, computeLayout, nodeUsed, attachSubtree, detachSubtree, copySubtree, autoStage, normalizeStages,
  stageNumbers, analyze, defOf, isStageable, uid, radiusAt, enclosures,
} from './rocket.js';
import { stockRockets } from './stock.js';
import { sfx } from './audio.js';

const WORLD = 'apogee.world';
export const worldKind = () => { try { return localStorage.getItem(WORLD) === 'real' ? 'real' : 'compact'; } catch { return 'compact'; } };

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 0) => x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtMass = (kg) => (kg >= 1000 ? `${fmt(kg / 1000, kg >= 100000 ? 0 : 1)} t` : `${fmt(kg)} kg`);
const SYMS = [1, 2, 3, 4, 6, 8];
const STORE = 'apogee.rockets', CURRENT = 'apogee.current';
const CAT_SHORT = { command: 'Command', tanks: 'Tanks', engines: 'Engines', boosters: 'Boosters', coupling: 'Decouplers', aero: 'Aero', control: 'Control', recovery: 'Recovery', structure: 'Structure', payload: 'Payload', station: 'Station', warheads: 'Warheads', lights: 'Lights' };
const BG = 0x16181b;

function attachPreview(d, held, cand, sym) {
  const pd = { parts: d.parts.map((p) => ({ ...p })) };
  attachSubtree(pd, held.parts, cand.parentId, cand.attach, sym);
  return pd.parts;
}
function spriteTex(draw) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  draw(g); return new THREE.CanvasTexture(c);
}
const RING = new THREE.SpriteMaterial({ depthTest: false, sizeAttenuation: false, transparent: true,
  map: spriteTex((g) => { g.strokeStyle = '#fff'; g.lineWidth = 7; g.beginPath(); g.arc(32, 32, 20, 0, 7); g.stroke(); }) });
const DOT = new THREE.SpriteMaterial({ depthTest: false, sizeAttenuation: false, transparent: true,
  map: spriteTex((g) => { g.fillStyle = '#f3f1ec'; g.beginPath(); g.arc(32, 32, 20, 0, 7); g.fill(); g.strokeStyle = '#16181b'; g.lineWidth = 6; g.stroke(); }) });
const HOVER = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false });
// see-through shells: you can see (and build) what is inside a fairing or an interstage
const SHELL_GHOST = new THREE.MeshStandardMaterial({ color: 0xe8e5de, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6 });
const SHELL_EDGE = new THREE.LineBasicMaterial({ color: 0xf3f1ec, transparent: true, opacity: 0.35 });

export class Builder {
  constructor(renderer, canvas, thumbs, onLaunch, onMenu) {
    this.renderer = renderer; this.cv = canvas; this.thumbs = thumbs; this.onLaunch = onLaunch; this.onMenu = onMenu;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG);
    this.scene.fog = new THREE.Fog(BG, 70, 300);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    this.scene.environment = studioEnvironment(renderer); this.scene.environmentIntensity = 0.55;
    this.scene.add(new THREE.HemisphereLight(0xf2f0ea, 0x3a3d44, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.3); sun.position.set(42, 60, 16); this.scene.add(sun, sun.target);
    // the key light casts a soft shadow onto the floor (and the boosters onto the core), fitted to the rocket
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
    this.sun = sun;
    const fill = new THREE.DirectionalLight(0x9fc0ff, 0.5); fill.position.set(-40, 10, -30); this.scene.add(fill);
    this.floor = new THREE.Group();
    this.floor.add(new THREE.GridHelper(400, 200, 0x3a3e45, 0x24272c));
    // polished studio floor: the rocket reflected in it, softly, strongest at grazing angles, fading out away
    // from the pad. A virtual camera mirrored below the floor renders the rocket into a half-size target each
    // frame; the floor looks it up projectively. (The pad is a slightly lighter disc in the same floor.)
    this.reflRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    this.reflCam = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    this.reflU = { tRefl: { value: this.reflRT.texture }, uTexM: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() }, uOn: { value: 1 } };
    // the reflection adds light on top of the floor (additive), so it never hides the pad, the pool or the shadow
    const floorMat = new THREE.ShaderMaterial({
      uniforms: this.reflU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vW; varying vec2 vC;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vC = modelMatrix[3].xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform sampler2D tRefl; uniform mat4 uTexM; uniform vec2 uTexel; uniform float uOn; varying vec3 vW; varying vec2 vC;
        void main() {
          float d = length(vW.xz - vC);
          vec4 p = uTexM * vec4(vW, 1.0); vec2 uv = p.xy / p.w;
          vec3 r = texture2D(tRefl, uv).rgb * 0.4 + (texture2D(tRefl, uv + vec2(uTexel.x, 0.0) * 1.5).rgb + texture2D(tRefl, uv - vec2(uTexel.x, 0.0) * 1.5).rgb
                 + texture2D(tRefl, uv + vec2(0.0, uTexel.y) * 1.5).rgb + texture2D(tRefl, uv - vec2(0.0, uTexel.y) * 1.5).rgb) * 0.15;
          vec3 V = normalize(cameraPosition - vW);
          float F = 0.04 + 0.96 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
          float fade = 1.0 - smoothstep(4.0, 40.0, d);
          gl_FragColor = vec4(r * mix(0.1, 0.5, F) * fade * uOn, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const pad0 = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 0.1, 64), new THREE.MeshBasicMaterial({ color: 0x1f2226 }));
    pad0.position.y = -0.06; this.floor.add(pad0);
    const pad = new THREE.Mesh(new THREE.CircleGeometry(80, 128), floorMat);
    pad.rotation.x = -Math.PI / 2; pad.position.y = 0.004; pad.renderOrder = 2; this.floor.add(pad);
    this.clipFloor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    // a soft pool of light on the floor round the pad, so the rocket stands somewhere rather than in a void
    const pool = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshBasicMaterial({ map: spriteTex((g) => {
      const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      r.addColorStop(0, 'rgba(255,255,255,0.075)'); r.addColorStop(0.35, 'rgba(255,255,255,0.03)'); r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    }), transparent: true, depthWrite: false, fog: false }));
    pool.rotation.x = -Math.PI / 2; pool.position.y = -0.11; pool.renderOrder = -1; this.floor.add(pool);
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.ShadowMaterial({ opacity: 0.42 }));
    catcher.rotation.x = -Math.PI / 2; catcher.position.y = -0.005; catcher.receiveShadow = true; this.floor.add(catcher);
    this.scene.add(this.floor);
    this.rocketGroup = new THREE.Group(); this.ghostGroup = new THREE.Group(); this.markGroup = new THREE.Group(); this.hoverGroup = new THREE.Group();
    this.scene.add(this.rocketGroup, this.ghostGroup, this.hoverGroup, this.markGroup);
    this.cam = { target: new THREE.Vector3(0, 3, 0), az: 0.45, el: 0.1, dist: 22 };
    this.design = newDesign(); this.layout = new Map();
    this.seeThrough = false; this.shellGroup = new THREE.Group(); this.scene.add(this.shellGroup);
    this.sym = 1; this.snap = true; this.held = null; this.cand = null; this.undo = [];
    this.mouse = new THREE.Vector2(); this.ray = new THREE.Raycaster(); this.drag = null; this.active = false; this.overShelf = false;
    this.cat = 'command';
    this.bindUI();
    let d = null;
    try { d = JSON.parse(localStorage.getItem(CURRENT)); } catch { /* ignore */ }
    if (d && d.parts && d.parts.every((p) => PARTS[p.type])) this.setDesign(d); else this.setDesign(cloneDesign(stockRockets()[worldKind() === 'real' ? 2 : 0]));
  }

  // ---------- UI wiring ----------
  bindUI() {
    const cats = $('cats');
    for (const c of CATEGORIES) {
      const b = document.createElement('button'); b.dataset.cat = c.id; b.textContent = CAT_SHORT[c.id] || c.name; b.title = c.name;
      b.onclick = () => { this.cat = c.id; this.renderPalette(); $('partlist').scrollTop = 0; };
      cats.appendChild(b);
    }
    this.renderPalette();
    $('btn-menu').onclick = () => this.onMenu();
    $('btn-new').onclick = () => { this.pushUndo(); this.setDesign(newDesign(), true); };
    $('btn-save').onclick = () => this.save();
    $('btn-load').onclick = () => this.toggleLoadMenu();
    $('btn-undo').onclick = () => this.doUndo();
    $('btn-sym').onclick = () => this.cycleSym(1);
    $('btn-snap').onclick = () => this.toggleSnap();
    $('btn-see').onclick = () => this.toggleSeeThrough();
    $('btn-autostage').onclick = () => { this.pushUndo(); this.design.manualStaging = false; this.changed(); };
    $('btn-launch').onclick = () => this.launch();
    { const t = $('launch-time'); let h = null; try { h = localStorage.getItem('apogee.hour'); } catch { /* ignore */ }
      if (h && [...t.options].some((o) => o.value === h)) t.value = h; else t.value = '7.75';
      t.onchange = () => { try { localStorage.setItem('apogee.hour', t.value); } catch { /* ignore */ } }; }
    $('rocket-name').oninput = (e) => { this.design.name = e.target.value; this.persist(); };
    $('planet').value = worldKind();
    $('planet').onchange = (e) => { localStorage.setItem(WORLD, e.target.value); this.renderStats(); };
    this.cvHandlers = { pointerdown: (e) => this.onDown(e), wheel: (e) => this.onWheel(e), contextmenu: (e) => e.preventDefault() };
    this.winHandlers = { pointermove: (e) => this.onMove(e), pointerup: (e) => this.onUp(e), pointercancel: (e) => this.onUp(e), keydown: (e) => this.onKey(e) };
  }
  activate() {
    if (this.active) return; this.active = true;
    for (const [k, h] of Object.entries(this.cvHandlers)) this.cv.addEventListener(k, h, { passive: false });
    for (const [k, h] of Object.entries(this.winHandlers)) window.addEventListener(k, h);
    $('build-ui').hidden = false; $('planet').value = worldKind();
    this.renderStats(); this.setHint();
  }
  deactivate() {
    if (!this.active) return; this.active = false;
    for (const [k, h] of Object.entries(this.cvHandlers)) this.cv.removeEventListener(k, h);
    for (const [k, h] of Object.entries(this.winHandlers)) window.removeEventListener(k, h);
    $('build-ui').hidden = true; this.cancelHeld(); this.cv.style.cursor = 'default';
  }

  renderPalette() {
    for (const b of $('cats').children) b.classList.toggle('on', b.dataset.cat === this.cat);
    const list = $('partlist'); list.innerHTML = '';
    for (const def of PART_LIST.filter((p) => p.cat === this.cat && !p.hidden)) {
      const el = document.createElement('div'); el.className = 'part';
      el.innerHTML = `<img src="${this.thumbs[def.id] || ''}" alt="" draggable="false"><div>${def.name}</div>`;
      el.onpointerdown = (e) => { if (e.button !== 0) return; e.preventDefault(); this.pickNew(def, e); };
      el.onmouseenter = () => { if (!this.held) this.showTip(def, el); };
      el.onmouseleave = () => { $('part-tip').hidden = true; };
      list.appendChild(el);
    }
  }
  showTip(def, el) {
    const rows = [['Mass', fmtMass(def.mass)]];
    if (def.fuel?.liquid) rows.push(['Liquid propellant', fmtMass(def.fuel.liquid)]);
    if (def.fuel?.solid) rows.push(['Solid propellant', fmtMass(def.fuel.solid)]);
    if (def.fuel?.mono) rows.push(['Monopropellant', fmtMass(def.fuel.mono)]);
    if (def.engine) {
      const E = def.engine;
      rows.push(['Thrust (vac / sea level)', `${fmt(E.thrust / 1000)} / ${fmt((E.thrust * E.ispSl) / E.ispVac / 1000)} kN`]);
      rows.push(['Isp (vac / sea level)', `${E.ispVac} / ${E.ispSl} s`]);
      rows.push(['Gimbal', E.gimbal ? `±${E.gimbal}°` : 'none'], ['Throttle', E.throttle ? 'yes' : 'no (solid)']);
    }
    if (def.wheel) rows.push(['Reaction torque', `${fmt(def.wheel / 1000, 1)} kN·m`]);
    if (def.rcs) rows.push(['RCS thrust', `${fmt(def.rcs / 1000, 1)} kN`]);
    if (def.chute) rows.push(['Parachute drag area', `${def.chute.cda} m²`]);
    if (def.dock) rows.push(['Docks with', `${def.dock.size} ports`]);
    if (def.warhead) {
      const W = def.warhead, kt = W.kt;
      rows.push(['Yield', W.kind === 'kinetic' ? '½·m·v² at impact' : kt >= 1000 ? `${fmt(kt / 1000)} Mt` : kt >= 1 ? `${fmt(kt)} kt` : `${fmt(kt * 1e6)} kg TNT`]);
      rows.push(['Fuse', def.nuke ? `air burst, ${fmt(220 * Math.cbrt(kt))} m` : 'impact']);
    }
    if (def.fairingBase) rows.push(['Shell', 'grows to fit the payload, ~9 kg/m²']);
    if (def.decoupler === 'stack' && !def.les) rows.push(['Interstage', 'automatic over an engine, ~15 kg/m²']);
    if (def.fin) rows.push(['Fin area', `${fmt(((def.fin.chord + def.fin.tip) / 2) * def.fin.span, 1)} m²`], ['Steerable', def.fin.control ? `±${def.fin.control}°` : 'no']);
    rows.push(['Size', `${fmt(Math.max(def.r, def.rTop) * 2, 2)} × ${fmt(def.len, 2)} m`], ['Max temperature', `${def.maxTemp} K`], ['Impact tolerance', `${def.crashTol} m/s`]);
    const tip = $('part-tip');
    tip.innerHTML = `<h4>${def.name}</h4><p>${def.desc || ''}</p>${rows.map(([a, b]) => `<div class="stat"><span>${a}</span><b>${b}</b></div>`).join('')}`;
    tip.hidden = false;
    tip.style.left = `${$('shelf').getBoundingClientRect().right + 8}px`;
    tip.style.top = `${Math.min(window.innerHeight - tip.offsetHeight - 14, Math.max(58, el.getBoundingClientRect().top - 10))}px`;
  }

  setHint(text) {
    if (text == null) {
      const h = this.held;
      if (h) {
        const radialOnly = PARTS[h.parts[0].type].radialOnly;
        if (this.cand || !this.design.parts.length) text = `<b>${h.drag ? 'Release' : 'Click'}</b> to attach${this.sym > 1 && this.cand?.attach.kind === 'radial' ? ` ×${this.sym}` : ''}`;
        else text = radialOnly ? 'Bring it to the side of a part' : 'Bring it to a ring on the rocket';
      } else if (!this.design.parts.length) text = 'Drag a part from the shelf to start your rocket';
      else text = '';
    }
    $('hint').innerHTML = text;
  }
  flash(text) { this.setHint(text); clearTimeout(this.flashT); this.flashT = setTimeout(() => this.setHint(), 2600); }

  // ---------- design state ----------
  setDesign(d, keepUndo) {
    this.design = d;
    if (!keepUndo) this.undo = [];
    $('rocket-name').value = d.name;
    this.held = null; this.clearPreview();
    this.changed(true);
    this.frameCamera();
  }
  pushUndo() { this.undo.push(JSON.stringify(this.design)); if (this.undo.length > 60) this.undo.shift(); }
  doUndo() { const s = this.undo.pop(); if (!s) return; this.design = JSON.parse(s); $('rocket-name').value = this.design.name; this.held = null; this.clearPreview(); this.changed(true); this.setHint(); }
  persist() { try { localStorage.setItem(CURRENT, JSON.stringify(this.design)); } catch { /* ignore */ } }
  changed(noStage) {
    const d = this.design;
    if (!noStage || d.parts.some((p) => isStageable(defOf(p)) && p.stage == null)) { if (d.manualStaging) normalizeStages(d); else autoStage(d); }
    this.layout = computeLayout(d.parts);
    this.rebuildMeshes();
    this.renderStats(); this.renderStaging(); this.persist();
  }
  rebuildMeshes() {
    this.rocketGroup.clear(); this.hoverGroup.clear(); this.hoverId = null;
    for (const p of this.design.parts) {
      const L = this.layout.get(p.id);
      const m = partMesh(L.def); m.position.copy(L.pos); m.quaternion.copy(L.quat); m.userData.partId = p.id;
      if (L.def.deploy) m.scale.x = 0.07;      // folding arrays are built folded, as they launch
      this.rocketGroup.add(m);
    }
    this.shellGroup.clear();
    this.drawShells(this.design.parts, this.layout, this.shellGroup, false);
    this.showShells();
    this.fitShadow();
  }
  // shadows from the rocket and its solid shells, with the light's frustum wrapped tightly round them
  fitShadow() {
    const on = gfx.shadows > 0, sun = this.sun;
    sun.castShadow = on;
    if (!on) return;
    const box = new THREE.Box3();
    for (const g of [this.rocketGroup, this.shellGroup]) g.traverse((m) => { if (m.isMesh && !m.material.transparent) { m.castShadow = m.receiveShadow = true; } });
    box.setFromObject(this.rocketGroup);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    box.min.y = Math.min(box.min.y, 0);
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() * 0.5 + 1;
    const dir = this.sun.userData.dir ||= this.sun.position.clone().normalize();
    sun.target.position.copy(c); sun.position.copy(c).addScaledVector(dir, r * 3);
    const sc = sun.shadow.camera; sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = r; sc.far = r * 5; sc.updateProjectionMatrix();
  }
  // interstages and fairings round the rocket: solid, and a see-through copy shown while you build inside
  drawShells(parts, layout, group, ghostOnly) {
    const nodes = parts.map((p) => { const L = layout.get(p.id); return { id: p.id, parent: p.parent, attach: p.attach, def: L.def, pos: L.pos, quat: L.quat }; });
    const enc = enclosures(nodes);
    const place = (m, id) => { const L = layout.get(id); m.position.copy(L.pos); m.quaternion.copy(L.quat); m.userData.partId = id; m.userData.shell = true; group.add(m); return m; };
    for (const [id, sp] of enc.inter) {
      if (!ghostOnly) place(interstageMesh(sp), id).userData.solid = true;
      const g = new THREE.Mesh(new THREE.CylinderGeometry(sp.r1, sp.r0, sp.h, 40, 1, true), SHELL_GHOST); g.position.y = sp.y0 + sp.h / 2;
      const gg = new THREE.Group(); gg.add(g); place(gg, id).userData.ghost = true;
    }
    for (const [id, F] of enc.fair) {
      if (!ghostOnly) { const sg = new THREE.Group(); sg.add(fairingHalfMesh(F.prof, 0), fairingHalfMesh(F.prof, 1)); place(sg, id).userData.solid = true; }
      const gg = new THREE.Group(); gg.add(fairingHalfMesh(F.prof, 0, SHELL_GHOST), fairingHalfMesh(F.prof, 1, SHELL_GHOST));
      const pts = F.prof.map(([r, y]) => [r, y]);
      for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const g = new THREE.BufferGeometry().setFromPoints(pts.map(([r, y]) => new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r)));
        gg.add(new THREE.Line(g, SHELL_EDGE));
      }
      place(gg, id).userData.ghost = true;
    }
    return enc;
  }
  showShells() {
    const ghost = this.seeThrough || !!this.held;
    for (const m of this.shellGroup.children) m.visible = m.userData.ghost ? ghost && !this.held : !ghost;
  }
  toggleSeeThrough() { this.seeThrough = !this.seeThrough; $('btn-see').classList.toggle('on', this.seeThrough); this.showShells(); }
  frameCamera() {
    const st = analyze(this.design);
    if (!this.design.parts.length) { this.cam.target.set(0, 2, 0); this.cam.dist = 16; return; }
    this.cam.target.set(0, (st.minY + st.maxY) / 2, 0);
    this.cam.dist = Math.max(10, st.height * 1.95);
  }

  renderStats() {
    const st = (this.stats = analyze(this.design));
    this.floor.position.y = this.design.parts.length ? st.minY : 0;
    const need = $('planet').value === 'real' ? 9400 : 3400;
    const first = st.stages.find((s) => s.twr != null);
    const cell = (a, b, cls = '') => `<div class="${cls}"><small>${a}</small><b>${b}</b></div>`;
    const split = (s) => { const i = s.lastIndexOf(' '); return i < 0 ? s : `${s.slice(0, i)}<i>${s.slice(i + 1)}</i>`; };
    const ok = st.totalDv >= need, top = Math.max(need * 1.3, st.totalDv);
    let h = cell('Mass', split(fmtMass(st.mass)));
    h += cell('Thrust / weight', first ? fmt(first.twr, 2) : '—');
    h += cell('Height', split(`${fmt(st.height, 1)} m`), 'hide-s') + cell('Parts', st.count, 'hide-s');
    h += `<div class="dv ${ok || !st.count ? '' : 'short'}" title="Total change in speed this rocket can make. The tick is roughly what reaching orbit takes on this world."><small>Delta-v</small><b>${fmt(st.totalDv)}<i>m/s</i></b>`
      + `<div class="bar"><u style="width:${(Math.min(st.totalDv, top) / top) * 100}%"></u><s style="left:${(need / top) * 100}%" data-l="orbit ${fmt(need)}"></s></div></div>`;
    $('stats').innerHTML = h;
    $('warns').innerHTML = st.warnings.slice(0, 2).map((w) => `<span>${w}</span>`).join('');
    if (st.count && st.totalDv < need && st.stages.length) $('warns').insertAdjacentHTML('beforeend', `<span>Not enough delta-v for orbit yet</span>`);
  }
  renderStaging() {
    const d = this.design, box = $('staging'); box.innerHTML = '';
    const nums = stageNumbers(d.parts);
    if (!nums.length) { box.innerHTML = '<div class="stage-empty">Engines, decouplers and parachutes line up here in the order they fire.</div>'; return; }
    nums.forEach((n, i) => {
      const s = this.stats.stages.find((x) => x.stage === n);
      const el = document.createElement('div'); el.className = 'stage';
      el.innerHTML = `<div class="stage-h"><b>${i + 1}</b><span>${s && s.dv > 1 ? `${fmt(s.dv)} m/s` : i === nums.length - 1 ? '' : ''}</span></div>`;
      const groups = new Map();
      for (const p of d.parts) if (p.stage === n) { if (!groups.has(p.type)) groups.set(p.type, []); groups.get(p.type).push(p); }
      for (const [type, ps] of groups) {
        const def = PARTS[type];
        const row = document.createElement('div'); row.className = 'stage-row'; row.title = def.name;
        row.innerHTML = `<img src="${this.thumbs[type] || ''}" alt=""><span class="n">${ps.length > 1 ? `×${ps.length}` : ''}</span>`;
        for (const [label, delta, title] of [['▲', -1, 'Fire earlier'], ['▼', 1, 'Fire later'], ['＋', 0.5, 'Give it a stage of its own']]) {
          const b = document.createElement('button'); b.textContent = label; b.title = title;
          b.onclick = () => { this.pushUndo(); for (const p of ps) p.stage += delta; d.manualStaging = true; normalizeStages(d); this.changed(true); };
          row.appendChild(b);
        }
        el.appendChild(row);
      }
      box.appendChild(el);
    });
  }

  // ---------- save / load ----------
  saved() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }
  save() {
    const all = this.saved(); all[this.design.name] = this.design;
    localStorage.setItem(STORE, JSON.stringify(all));
    this.flash(`Saved “${this.design.name}”`);
  }
  toggleLoadMenu() {
    const m = $('load-menu');
    if (!m.hidden) { m.hidden = true; return; }
    m.innerHTML = '<h3>Example rockets</h3>';
    const item = (name, load, del) => {
      const el = document.createElement('div'); el.className = 'item';
      el.innerHTML = `<span>${name}</span>`;
      el.onclick = () => { this.pushUndo(); load(); m.hidden = true; };
      if (del) { const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Delete'; x.onclick = (e) => { e.stopPropagation(); del(); m.hidden = true; this.toggleLoadMenu(); }; el.appendChild(x); }
      m.appendChild(el);
    };
    for (const s of stockRockets()) item(s.name, () => this.setDesign(s, true));
    const all = this.saved();
    m.insertAdjacentHTML('beforeend', '<h3>Your saved rockets</h3>');
    const names = Object.keys(all);
    if (!names.length) m.insertAdjacentHTML('beforeend', '<div class="none">Nothing saved yet.</div>');
    for (const n of names) item(n, () => this.setDesign(cloneDesign(all[n]), true), () => { delete all[n]; localStorage.setItem(STORE, JSON.stringify(all)); });
    m.hidden = false;
  }
  launch() {
    if (!this.design.parts.length) { this.flash('Build something first'); return; }
    this.cancelHeld();
    this.onLaunch(cloneDesign(this.design), $('planet').value);
  }

  // ---------- holding parts ----------
  // held.drag: the pointer is down and releasing places the part. Otherwise the part sticks to
  // the cursor until the next click (what you get from a plain click on the shelf).
  pickNew(def, e) {
    this.cancelHeld();
    this.held = { parts: [{ id: uid(), type: def.id, parent: null, attach: null }], tx: 0, tz: 0, isNew: true, drag: true, moved: false, sx: e.clientX, sy: e.clientY };
    this.overShelf = true; $('part-tip').hidden = true; this.hoverGroup.clear(); sfx.play('pick');
    this.cv.style.cursor = 'grabbing';
  }
  pickExisting(id, copy) {
    const d = this.design, part = d.parts.find((p) => p.id === id);
    if (!part) return false;
    if (!part.parent && d.parts.length > 1 && !copy) { this.flash('Everything hangs off this part, so it stays put. Drag the other parts instead.'); return false; }
    const a = part.attach;
    if (!copy) this.pushUndo();
    let sub;
    if (copy) sub = copySubtree(d, id);
    else if (!part.parent) { sub = d.parts.map((p) => ({ ...p })); d.parts = []; }
    else sub = detachSubtree(d, id);
    this.held = { parts: sub, tx: a?.tx || 0, tz: a?.tz || 0, drag: true, moved: true, fromRocket: !copy };
    if (!copy) this.changed();
    this.hoverGroup.clear(); this.cv.style.cursor = 'grabbing'; sfx.play('pick');
    this.updatePlacement(); this.setHint();
    return true;
  }
  clearPreview() { this.cand = null; this.ghostGroup.clear(); this.markGroup.clear(); $('shelf').classList.remove('trash'); if (this.shellGroup) this.showShells(); }
  // Put a held part back where it came from (or throw a new one away).
  cancelHeld() {
    const h = this.held; if (!h) return;
    this.held = null; this.clearPreview(); this.cv.style.cursor = 'default';
    if (h.fromRocket) this.doUndo();
    if (this.active) this.setHint();
  }
  cycleSym(dir) { this.sym = SYMS[(SYMS.indexOf(this.sym) + dir + SYMS.length) % SYMS.length]; $('btn-sym').textContent = `Symmetry ×${this.sym}`; $('btn-sym').classList.toggle('on', this.sym > 1); this.updatePlacement(); }
  toggleSnap() { this.snap = !this.snap; $('btn-snap').classList.toggle('on', this.snap); }

  setMouse(e) {
    const r = this.cv.getBoundingClientRect();
    this.px = e.clientX - r.left; this.py = e.clientY - r.top; this.vw = r.width; this.vh = r.height;
    this.mouse.set((this.px / r.width) * 2 - 1, -(this.py / r.height) * 2 + 1);
  }
  partUnderMouse() {
    this.ray.setFromCamera(this.mouse, this.camera);
    const solidShells = !this.held && !this.seeThrough;
    const hits = this.ray.intersectObjects(solidShells ? [...this.rocketGroup.children, ...this.shellGroup.children.filter((m) => m.userData.solid)] : this.rocketGroup.children, true);
    for (const h of hits) {
      let o = h.object; while (o && !o.userData.partId) o = o.parent;
      if (o) return { id: o.userData.partId, point: h.point };
    }
    return null;
  }

  // Work out where the held part would go and draw it there.
  updatePlacement() {
    const held = this.held; if (!held || this.px == null) return;
    const d = this.design, root = held.parts[0], rdef = PARTS[root.type];
    this.cand = null; this.ghostGroup.clear(); this.markGroup.clear();
    if (held.drag && (!held.moved || this.overShelf)) return;
    const cam = this.camera, V = THREE.Vector3;
    const ppm = this.vh / (2 * Math.tan((cam.fov * Math.PI) / 360) * this.cam.dist);
    const rings = []; let snapAt = null;
    const hit = d.parts.length ? this.partUnderMouse() : null;
    if (d.parts.length) {
      // 1 — end-to-end: snap when the part is near the spot it would occupy
      if (!rdef.radialOnly) {
        const heldUsed = (node) => held.parts.some((c) => c.parent === root.id && c.attach.kind === 'stack' && c.attach.node === node);
        const thr = THREE.MathUtils.clamp(ppm * (rdef.len * 0.5 + Math.max(rdef.r, rdef.rTop) * 0.6), 36, 150);
        let best = null, bestD = thr, hov = null, hovD = 1e9;
        const c = new V();
        for (const p of d.parts) {
          const L = this.layout.get(p.id), def = L.def;
          for (const node of ['top', 'bottom']) {
            const need = node === 'top' ? 'bottom' : 'top';
            if (!def.nodes[node] || !rdef.nodes[need] || heldUsed(need) || nodeUsed(d.parts, p, node)) continue;
            const s = node === 'top' ? 1 : -1;
            const joint = new V(0, (s * def.len) / 2, 0).applyQuaternion(L.quat).add(L.pos);
            rings.push(joint);
            c.set(0, s * (def.len / 2 + rdef.len / 2), 0).applyQuaternion(L.quat).add(L.pos).project(cam);
            if (c.z > 1) continue;
            const dist = Math.hypot((c.x * 0.5 + 0.5) * this.vw - this.px, (-c.y * 0.5 + 0.5) * this.vh - this.py);
            const cnd = { parentId: p.id, attach: { kind: 'stack', node }, joint };
            if (dist < bestD) { bestD = dist; best = cnd; }
            if (hit && hit.id === p.id && dist < hovD) { hovD = dist; hov = cnd; }
          }
        }
        if (!best && hov && rdef.radial === false) best = hov;
        if (best) { this.cand = { parentId: best.parentId, attach: best.attach }; snapAt = best.joint; }
      }
      // 2 — onto the side of a part: directly under the cursor, or just beside its outline
      if (!this.cand && rdef.radial !== false) {
        const snapY = (y) => { if (!this.snap) return y; y = Math.round(y * 10) / 10; return Math.abs(y) < 0.15 ? 0 : y; };
        const snapA = (a) => (this.snap ? Math.round(a / (Math.PI / 12)) * (Math.PI / 12) : a);
        const hl = hit && this.layout.get(hit.id);
        if (hl && hl.def.surface !== false) {
          const def = hl.def;
          const loc = hit.point.clone().sub(hl.pos).applyQuaternion(hl.quat.clone().invert());
          const y = snapY(THREE.MathUtils.clamp(loc.y, -def.len / 2, def.len / 2));
          const ang = def.outerFace ? 0 : snapA(Math.atan2(loc.z, loc.x));
          if (!def.outerFace || loc.x > -0.01) { this.cand = { parentId: hit.id, attach: { kind: 'radial', ang, y, tx: held.tx, tz: held.tz } }; snapAt = hit.point.clone(); }
        }
        if (!this.cand) {
          this.ray.setFromCamera(this.mouse, cam);
          const ax = new V(), A = new V(), B = new V(), pr = new V(), ps = new V(), qi = new THREE.Quaternion();
          const reach = (rdef.radialOff ?? rdef.r) + 0.35 + 28 / ppm;
          let bestGap = reach;
          for (const p of d.parts) {
            const L = this.layout.get(p.id), def = L.def;
            if (def.surface === false || def.outerFace) continue;
            ax.set(0, def.len / 2, 0).applyQuaternion(L.quat); A.copy(L.pos).sub(ax); B.copy(L.pos).add(ax);
            const dist = Math.sqrt(this.ray.ray.distanceSqToSegment(A, B, pr, ps));
            qi.copy(L.quat).invert();
            const loc = ps.clone().sub(L.pos).applyQuaternion(qi);
            if (Math.abs(loc.y) > def.len / 2 - 0.02) continue;
            const rad = radiusAt(def, loc.y), gap = dist - rad;
            if (gap >= bestGap) continue;
            const dir = pr.clone().sub(ps).applyQuaternion(qi);
            const ang = snapA(Math.atan2(dir.z, dir.x)), y = snapY(loc.y);
            bestGap = gap;
            this.cand = { parentId: p.id, attach: { kind: 'radial', ang, y, tx: held.tx, tz: held.tz } };
            snapAt = new V(Math.cos(ang) * rad, y, Math.sin(ang) * rad).applyQuaternion(L.quat).add(L.pos);
          }
        }
      }
    }
    // draw the part: in place when snapped, under the cursor otherwise
    let newParts, layout;
    if (this.cand) {
      const pd = { parts: d.parts.map((p) => ({ ...p })) };
      const before = new Set(pd.parts.map((p) => p.id));
      attachSubtree(pd, held.parts, this.cand.parentId, this.cand.attach, this.sym);
      layout = computeLayout(pd.parts);
      newParts = pd.parts.filter((p) => !before.has(p.id));
    } else {
      this.ray.setFromCamera(this.mouse, cam);
      const n = new V(Math.sin(this.cam.az), 0, Math.cos(this.cam.az));
      const pt = this.ray.ray.intersectPlane(new THREE.Plane(n, 0), new V()) || this.cam.target.clone();
      layout = computeLayout(held.parts, pt);
      newParts = held.parts;
    }
    for (const p of newParts) {
      const L = layout.get(p.id);
      const m = partMesh(L.def); m.position.copy(L.pos); m.quaternion.copy(L.quat);
      if (L.def.deploy) m.scale.x = 0.07;
      this.ghostGroup.add(m);
    }
    // the shells as they would be with the part in place: a fairing grows round the payload as you build it
    if (this.cand) this.drawShells(this.lastPreview = attachPreview(d, held, this.cand, this.sym), computeLayout(this.lastPreview), this.ghostGroup, true);
    else if (d.parts.length) this.drawShells(d.parts, this.layout, this.ghostGroup, true);
    this.showShells();
    const mark = (pos, mat, size) => { const s = new THREE.Sprite(mat); s.position.copy(pos); s.scale.setScalar(size); s.renderOrder = 20; this.markGroup.add(s); };
    for (const r of rings) if (r !== snapAt) mark(r, RING, 0.03);
    if (snapAt) mark(snapAt, DOT, 0.034);
    const ck = this.cand ? `${this.cand.parentId}/${this.cand.attach.kind}/${this.cand.attach.node || ''}` : '';
    if (ck !== this.candKey) { this.candKey = ck; if (ck) sfx.play('tick'); }
    this.setHint();
  }

  commitPlacement(keep) {
    const held = this.held, d = this.design;
    if (!held) return false;
    if (!d.parts.length) {
      if (PARTS[held.parts[0].type].radialOnly) { this.flash('Start with a pod, a probe or a tank. This part goes on the side of one.'); this.held = null; this.clearPreview(); return false; }
      if (!held.fromRocket) this.pushUndo();
      held.parts[0].parent = null; held.parts[0].attach = null;
      d.parts = held.parts.map((p) => ({ ...p }));
    } else if (this.cand) {
      if (!held.fromRocket) this.pushUndo();
      attachSubtree(d, held.parts, this.cand.parentId, this.cand.attach, this.sym);
    } else return false;
    sfx.play('snap');
    const again = keep ? { parts: JSON.parse(JSON.stringify(held.parts)), tx: held.tx, tz: held.tz, isNew: true } : null;
    this.held = null; this.clearPreview();
    this.changed();
    const st = this.stats, c = this.cam;
    c.dist = Math.max(c.dist, st.height * 1.25);
    if (again) { this.held = again; this.updatePlacement(); } else this.cv.style.cursor = 'default';
    this.setHint();
    return true;
  }
  deletePart(id) {
    const d = this.design, part = d.parts.find((p) => p.id === id);
    if (!part) return;
    this.pushUndo();
    if (!part.parent) d.parts = []; else detachSubtree(d, id);
    sfx.play('del'); this.changed(); this.setHint();
  }

  // ---------- input ----------
  isOverShelf(e) { const el = document.elementFromPoint(e.clientX, e.clientY); return !!(el && el.closest && el.closest('#shelf')); }
  onDown(e) {
    this.setMouse(e); $('load-menu').hidden = true; $('part-tip').hidden = true;
    const hit = !this.held && e.button === 0 ? this.partUnderMouse() : null;
    this.drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false, shift: e.shiftKey, hitId: hit?.id };
    this.cv.setPointerCapture(e.pointerId);
  }
  onMove(e) {
    this.setMouse(e);
    const h = this.held;
    if (h && h.drag) {
      if (!h.moved && Math.hypot(e.clientX - h.sx, e.clientY - h.sy) > 6) h.moved = true;
      this.overShelf = this.isOverShelf(e);
      $('shelf').classList.toggle('trash', this.overShelf && !h.isNew);
      this.updatePlacement();
      return;
    }
    const dg = this.drag;
    if (dg) {
      if (!dg.moved && Math.hypot(e.clientX - dg.x, e.clientY - dg.y) > 5) dg.moved = true;
      if (!dg.moved) return;
      if (dg.hitId && !h) { const id = dg.hitId; dg.hitId = null; if (this.pickExisting(id, e.altKey)) { this.drag = null; return; } }
      if (dg.button !== 0 || !h || dg.orbit !== false) {
        if (dg.button === 1 || dg.button === 2 || dg.shift) this.cam.target.y += e.movementY * this.cam.dist * 0.0016;
        else { this.cam.az -= e.movementX * 0.006; this.cam.el = THREE.MathUtils.clamp(this.cam.el + e.movementY * 0.005, -0.35, 1.45); }
        if (h) this.updatePlacement();
      }
      return;
    }
    if (h) { this.updatePlacement(); return; }
    // hover
    const hit = e.target === this.cv ? this.partUnderMouse() : null;
    this.cv.style.cursor = hit ? 'grab' : 'default';
    if (hit?.id !== this.hoverId) {
      this.hoverId = hit?.id; this.hoverGroup.clear();
      const L = hit && this.layout.get(hit.id);
      if (L) {
        const m = partMesh(L.def); setMaterial(m, HOVER); m.position.copy(L.pos); m.quaternion.copy(L.quat); m.scale.setScalar(1.025); this.hoverGroup.add(m);
        this.setHint(`<b>${L.def.name}</b> · drag to move · right-click to remove`);
      } else this.setHint();
    }
  }
  onUp(e) {
    const h = this.held;
    if (h && h.drag) {
      this.drag = null;
      if (!h.moved) { h.drag = false; this.overShelf = false; this.setHint(); return; } // plain click on the shelf: part sticks to the cursor
      if (this.overShelf) {
        this.held = null; this.clearPreview(); this.cv.style.cursor = 'default';
        if (h.fromRocket) { this.flash('Removed. <b>Undo</b> brings it back.'); sfx.play('del'); } else this.setHint();
        if (h.fromRocket) this.changed();
      } else if (!this.commitPlacement(false) && this.held) {
        const back = h.fromRocket; this.cancelHeld(); sfx.play('drop');
        this.flash(back ? 'Put back. Drop parts on a ring or on the side of the rocket.' : 'Not attached. Drop parts on a ring or on the side of the rocket.');
      }
      return;
    }
    const dg = this.drag; this.drag = null;
    if (!dg || dg.moved) return;
    this.setMouse(e);
    if (dg.button === 0) {
      if (h && !this.commitPlacement(e.shiftKey) && this.held) this.flash(PARTS[h.parts[0].type].radialOnly ? 'Bring it to the side of a part first' : 'Bring it to a ring on the rocket first');
    } else if (dg.button === 2) {
      if (h) this.cancelHeld();
      else { const hit = this.partUnderMouse(); if (hit) this.deletePart(hit.id); }
    }
  }
  onWheel(e) {
    e.preventDefault();
    if (e.shiftKey) this.cam.target.y -= (e.deltaY || e.deltaX) * 0.002 * this.cam.dist;
    else this.cam.dist = THREE.MathUtils.clamp(this.cam.dist * Math.exp(e.deltaY * 0.0012), 2.5, 400);
    this.needPlace = true;
  }
  onKey(e) {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (this.held) this.cancelHeld(); else this.doUndo(); return; }
    if (e.ctrlKey || e.metaKey) return;
    if (k === 'x') this.cycleSym(e.shiftKey ? -1 : 1);
    else if (k === 'c') this.toggleSnap();
    else if (k === 'v') this.toggleSeeThrough();
    else if (k === 'escape') this.cancelHeld();
    else if (k === 'delete' || k === 'backspace') { if (this.held) { const h = this.held; this.held = null; this.clearPreview(); if (h.fromRocket) this.changed(); this.setHint(); } else if (this.hoverId) this.deletePart(this.hoverId); }
    else if (k === 'arrowup') this.cam.target.y += this.cam.dist * 0.08;
    else if (k === 'arrowdown') this.cam.target.y -= this.cam.dist * 0.08;
    else if (this.held && 'qerf'.includes(k)) {
      const st = Math.PI / 12;
      if (k === 'q') this.held.tx -= st; if (k === 'e') this.held.tx += st;
      if (k === 'r') this.held.tz -= st; if (k === 'f') this.held.tz += st;
      this.updatePlacement();
    }
  }

  render(w, h) {
    const c = this.cam, held = this.held;
    // carrying a part to the top or bottom edge scrolls the view
    if (held && held.drag && held.moved && !this.overShelf && this.py != null) {
      const edge = 54, sp = c.dist * 0.012;
      if (this.py < edge) { c.target.y += sp * (1 - this.py / edge); this.needPlace = true; }
      else if (this.py > h - edge) { c.target.y -= sp * (1 - (h - this.py) / edge); this.needPlace = true; }
    }
    this.camera.aspect = w / h;
    const shift = w > 860 ? 120 : 90; this.camera.setViewOffset(w + shift * 2, h, 0, 0, w, h);
    this.camera.updateProjectionMatrix();
    const ce = Math.cos(c.el);
    this.camera.position.set(c.target.x + c.dist * ce * Math.sin(c.az), c.target.y + c.dist * Math.sin(c.el), c.target.z + c.dist * ce * Math.cos(c.az));
    this.camera.lookAt(c.target);
    this.camera.updateMatrixWorld();
    if (this.needPlace) { this.needPlace = false; if (held) this.updatePlacement(); }
    if (this.sun.castShadow !== gfx.shadows > 0) this.fitShadow();
    applyTone(this.renderer, 1.1);
    this.renderReflection(w, h);
    this.renderer.render(this.scene, this.camera);
  }
  // the rocket mirrored in the floor: render it from a camera reflected below the floor plane, clipped to what is
  // above the floor, into a half-size target the floor shader samples projectively
  renderReflection(w, h) {
    const on = gfx.preset !== 'low';
    this.reflU.uOn.value = on ? 1 : 0;
    if (!on) return;
    const r = this.renderer, y0 = this.floor.position.y, cam = this.camera, rc = this.reflCam;
    const pr = r.getPixelRatio(), rw = Math.max(64, Math.round(w * pr * 0.5)), rh = Math.max(64, Math.round(h * pr * 0.5));
    if (this.reflRT.width !== rw || this.reflRT.height !== rh) this.reflRT.setSize(rw, rh);
    this.reflU.uTexel.value.set(1 / rw, 1 / rh);
    rc.fov = cam.fov * 1.35; rc.aspect = w / h; rc.near = cam.near; rc.far = cam.far; rc.updateProjectionMatrix();
    const tgt = this.cam.target;
    rc.position.set(cam.position.x, 2 * y0 - cam.position.y, cam.position.z);
    rc.up.set(0, 1, 0); rc.lookAt(tgt.x, 2 * y0 - tgt.y, tgt.z); rc.updateMatrixWorld();
    this.reflU.uTexM.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
    const bg = this.scene.background, fog = this.scene.fog;
    this.scene.background = null; this.scene.fog = null;
    const hide = [this.floor, this.markGroup, this.hoverGroup]; const vis = hide.map((o) => o.visible); hide.forEach((o) => { o.visible = false; });
    this.clipFloor.constant = -y0 + 0.01;
    const clip = r.clippingPlanes; r.clippingPlanes = [this.clipFloor];
    r.setRenderTarget(this.reflRT); r.setClearColor(0x000000, 0); r.clear(); r.render(this.scene, rc); r.setRenderTarget(null);
    r.clippingPlanes = clip; r.setClearColor(0x000000, 1);
    hide.forEach((o, i) => { o.visible = vis[i]; });
    this.scene.background = bg; this.scene.fog = fog;
  }
}
