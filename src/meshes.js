// Procedural 3D models for every part. Local frame: +Y along the part axis, centred; +X outward for radial parts.
//
// House style — one set of materials used with intent, so any rocket looks like it came from one shop.
// Colours and the paint, composite and ablator surfaces come from style.js (the palette and surface recipes,
// shared with the launch site); the specialised maps (foil, tiles, cells, ribs) are drawn here.
//   paint     warm white painted aluminium, panel seams and rivets       (tanks, cones, fins, boosters)
//   carbon    charcoal composite                                          (interstages, rings, mounts, decouplers)
//   alu/steel bare metal                                                  (struts, plumbing, actuators, pumps)
//   gold      crinkled MLI foil — only on hardware that lives in vacuum   (vacuum engines, probes, satellites)
//   nozzle    heat-tinted metal, copper at the throat to blued steel     (engine bells)
//   ablative  honeycomb heat-shield material                              (heat shields, capsule rims)
// Markings are never decoration: a ring is a joint, a strip is a cable raceway, a line is a weld or a seam.
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from '../vendor/jsm/environments/RoomEnvironment.js';
import { PART_LIST } from './parts.js';
import { col, recipe, applyTone } from './style.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;

// ---------- procedural textures ----------
function canvas2d(n) { const c = document.createElement('canvas'); c.width = c.height = n; return [c, c.getContext('2d', { willReadFrequently: true })]; }
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function normalTex(n, strength, draw) {
  const [, g] = canvas2d(n);
  g.fillStyle = '#808080'; g.fillRect(0, 0, n, n); draw(g, n);
  const src = g.getImageData(0, 0, n, n).data, out = new Uint8Array(n * n * 4);
  const h = (x, y) => src[((((y + n) % n) * n) + ((x + n) % n)) * 4] / 255;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength, dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), i = (y * n + x) * 4;
    out[i] = (-dx / l * 0.5 + 0.5) * 255; out[i + 1] = (-dy / l * 0.5 + 0.5) * 255; out[i + 2] = (1 / l * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  const t = new THREE.DataTexture(out, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}
function colorTex(n, draw, srgb = true) {
  const [c, g] = canvas2d(n); draw(g, n);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}
const blot = (g, n, r, count, alpha, light, dark, seed) => {
  const R = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = R() * n, y = R() * n, s = r * (0.3 + R());
    const gr = g.createRadialGradient(x, y, 0, x, y, s), v = R() < 0.5 ? light : dark;
    gr.addColorStop(0, `rgba(${v},${v},${v},${alpha})`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
    g.fillStyle = gr;
    for (const ox of [-n, 0, n]) for (const oy of [-n, 0, n]) { g.save(); g.translate(ox, oy); g.fillRect(x - s, y - s, s * 2, s * 2); g.restore(); }
  }
};
let T = null;
function textures() {
  if (T) return T;
  T = {};
  T.tubeN = normalTex(64, 2.4, (g, n) => { for (let x = 0; x < n; x++) { const v = Math.round(128 + 110 * Math.sin(((x % 4) / 4) * Math.PI)); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, n); } });
  T.ribN = normalTex(128, 2.5, (g, n) => { for (let x = 0; x < n; x += 32) { g.fillStyle = '#c8c8c8'; g.fillRect(x + 1, 0, 5, n); g.fillStyle = '#a4a4a4'; g.fillRect(x, 0, 1, n); g.fillRect(x + 6, 0, 1, n); } g.fillStyle = '#606060'; g.fillRect(0, 0, n, 2); });
  T.foilN = normalTex(256, 4, (g, n) => {
    const R = rng(3);
    for (let i = 0; i < 900; i++) {
      const v = 70 + R() * 120; g.fillStyle = `rgba(${v},${v},${v},0.35)`;
      const x = R() * n, y = R() * n, s = 6 + R() * 26;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (R() - 0.5) * s * 2, y + (R() - 0.5) * s); g.lineTo(x + (R() - 0.5) * s, y + (R() - 0.5) * s * 2); g.closePath(); g.fill();
    }
    g.fillStyle = '#4a4a4a'; for (let x = 0; x < n; x += 64) g.fillRect(x, 0, 1, n);
  });
  T.foilR = colorTex(128, (g, n) => { g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, n, n); blot(g, n, 14, 80, 0.5, 200, 40, 5); }, false);
  T.cells = colorTex(256, (g, n) => {
    g.fillStyle = '#b8bcc2'; g.fillRect(0, 0, n, n);
    const c = n / 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const gr = g.createLinearGradient(x * c, y * c, x * c + c, y * c + c);
      gr.addColorStop(0, '#16213a'); gr.addColorStop(1, '#0c1222');
      g.fillStyle = gr; g.fillRect(x * c + 1.5, y * c + 1.5, c - 3, c - 3);
      g.fillStyle = 'rgba(160,170,190,0.35)'; for (let k = 1; k < 4; k++) g.fillRect(x * c + 1.5, y * c + (c * k) / 4, c - 3, 0.6);
    }
  });
  // the shared surfaces (style.js)
  const fp = recipe('flightPaint'), cb = recipe('carbon'), ab = recipe('ablator');
  T.paint = fp.map; T.rough = fp.roughnessMap; T.panelN = fp.normalMap;
  T.carbonC = cb.map; T.carbonR = cb.roughnessMap; T.weaveN = cb.normalMap;
  T.ablative = ab.map; T.ablativeR = ab.roughnessMap; T.hexN = ab.normalMap;
  T.tiles = recipe('heatTiles');
  // polished stainless keeps its own soft, uneven sheen (the original, and still the favourite)
  T.steelRough = colorTex(256, (g, n) => { g.fillStyle = '#808080'; g.fillRect(0, 0, n, n); blot(g, n, 40, 60, 0.25, 230, 60, 11); }, false);
  return T;
}

// ---------- materials ----------
const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0, ...o });
const gloss = (o) => new THREE.MeshPhysicalMaterial({ roughness: 1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, ...o });
let MB = null;
function base() {
  if (MB) return MB;
  const t = textures();
  MB = {
    // gloss white under a clear coat: the sharp reflection on top, the paint's own soft sheen below
    paint: gloss({ color: col('enamel'), map: t.paint, normalMap: t.panelN, roughnessMap: t.rough }),
    ribbed: gloss({ color: col('enamelShade'), map: t.paint, normalMap: t.ribN, normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: t.rough }),
    carbon: std({ color: col('carbon'), roughness: 1, metalness: 0.15, map: t.carbonC, normalMap: t.weaveN, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: t.carbonR }),
    black: std({ color: col('black'), roughness: 0.82 }),
    alu: std({ color: col('aluminium'), metalness: 0.92, roughness: 0.3 }),
    steel: std({ color: col('steel'), metalness: 0.88, roughness: 0.4 }),
    dark: std({ color: col('darkMetal'), metalness: 0.8, roughness: 0.45 }),
    stainless: std({ color: col('stainless'), metalness: 0.95, roughness: 0.26, roughnessMap: t.steelRough }),
    gold: std({ color: col('foilGold'), metalness: 1, roughness: 0.3, normalMap: t.foilN, normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: t.foilR }),
    silver: std({ color: col('foilSilver'), metalness: 1, roughness: 0.38, normalMap: t.foilN, normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: t.foilR }),
    bronze: std({ color: col('bronze'), metalness: 0.9, roughness: 0.35 }),
    nozzle: std({ vertexColors: true, metalness: 0.85, roughness: 0.38, normalMap: t.tubeN, normalScale: new THREE.Vector2(0.8, 0.8), side: THREE.DoubleSide }),
    nozzleRad: std({ vertexColors: true, metalness: 0.75, roughness: 0.45, side: THREE.DoubleSide }),
    phenolic: std({ color: 0x2a2320, roughness: 0.75, side: THREE.DoubleSide }),
    ablative: std({ color: col('ablator'), map: t.ablative, roughness: 1, roughnessMap: t.ablativeR, normalMap: t.hexN }),
    tiles: std({ color: col('tile'), map: t.tiles.map, roughness: 1, roughnessMap: t.tiles.roughnessMap, normalMap: t.tiles.normalMap }),
    glass: std({ color: 0x070b12, metalness: 0.9, roughness: 0.06 }),
    cells: std({ color: 0xffffff, map: t.cells, metalness: 0.55, roughness: 0.25 }),
    dish: std({ color: 0xeeece6, roughness: 0.5, side: THREE.DoubleSide }),
  };
  return MB;
}
export const MAT = new Proxy({}, { get: (_, k) => base()[k] });
export const materialNames = () => Object.keys(base());
// a material whose textures repeat u × v times over the surface
const repCache = new Map();
function rep(name, u, v) {
  u = Math.max(1, Math.round(u)); v = Math.max(0.25, Math.round(v * 4) / 4);
  const key = `${name}|${u}|${v}`;
  if (!repCache.has(key)) {
    const m = base()[name].clone();
    for (const k of ['map', 'normalMap', 'roughnessMap']) if (m[k]) { m[k] = m[k].clone(); m[k].repeat.set(u, v); m[k].needsUpdate = true; }
    repCache.set(key, m);
  }
  return repCache.get(key);
}
const TILE = 1.6;
const skin = (name, r, h) => rep(name, (TAU * r) / TILE, h / TILE);

// ---------- geometry helpers (all return meshes in part space) ----------
const SEG = 40;
const mesh = (g, m) => new THREE.Mesh(g, m);
function cyl(rt, rb, h, m, y = 0, seg = SEG, open = false) { const c = mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), m); c.position.y = y; return c; }
function ring(r, h, m, y, out = 1.012) { return cyl(r * out, r * out, h, m, y, SEG, true); }
function box(w, h, d, m, x = 0, y = 0, z = 0) { const b = mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); return b; }
function lathe(pts, m, seg = SEG) { return mesh(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y)), seg), m); }
function torus(R, r, m, y = 0) { const t = mesh(new THREE.TorusGeometry(R, r, 8, SEG), m); t.rotation.x = Math.PI / 2; t.position.y = y; return t; }
function strut(a, b, rad, m, seg = 8) {
  const d = new THREE.Vector3().subVectors(b, a), L = d.length();
  const s = mesh(new THREE.CylinderGeometry(rad, rad, L, seg), m);
  s.position.copy(a).addScaledVector(d, 0.5);
  s.quaternion.setFromUnitVectors(V3(0, 1, 0), d.normalize());
  return s;
}
function pipe(pts, rad, m) { return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(8, pts.length * 8), rad, 8), m); }
const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };
const polar = (r, a, y) => V3(Math.cos(a) * r, y, Math.sin(a) * r);
// place an object on the surface of a body of radius r at angle a (local +X of the object faces outward)
function onSurface(o, r, a, y) { o.position.set(Math.cos(a) * r, y, Math.sin(a) * r); o.rotation.y = -a; return o; }
function colorize(geo, stops) {
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < pos.count; i++) { y0 = Math.min(y0, pos.getY(i)); y1 = Math.max(y1, pos.getY(i)); }
  const cs = stops.map(([t, hex]) => [t, new THREE.Color(hex)]), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = (y1 - pos.getY(i)) / (y1 - y0 || 1);
    let k = 0; while (k < cs.length - 2 && t > cs[k + 1][0]) k++;
    const [ta, ca] = cs[k], [tb, cb] = cs[k + 1];
    c.copy(ca).lerp(cb, Math.min(1, Math.max(0, (t - ta) / (tb - ta || 1))));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
const REGEN = [[0, 0x8a5430], [0.22, 0x5e4a42], [0.5, 0x474a63], [0.8, 0x8c8e94], [1, 0xb9babd]];
const RADIATIVE = [[0, 0x3d3550], [0.3, 0x2e3036], [1, 0x5d6068]];
const bellR = (rT, rE, t) => rT + (rE - rT) * (1 - Math.pow(1 - t, 1.9));

// One thrust chamber + nozzle, starting at y0 (injector) and ending at yEnd (nozzle exit).
function chamberUnit(add, o) {
  const { x = 0, z = 0, y0, yEnd, rc, rT, rE, hc, ext = 0, tubes = true, rings = [], manifold = null, lip = true } = o;
  const yT = y0 - hc, hb = yT - yEnd;
  const B = base();
  const ch = lathe([[0, y0], [rc * 0.7, y0], [rc * 0.95, y0 - hc * 0.12], [rc, y0 - hc * 0.3], [rc, y0 - hc * 0.62], [rT * 1.25, y0 - hc * 0.92], [rT, yT]], B.steel);
  ch.position.set(x, 0, z); add(ch);
  add(at(torus(rc * 1.02, rc * 0.06, B.bronze, y0 - hc * 0.2), x, y0 - hc * 0.2, z));
  const split = 1 - ext;
  const mk = (t0, t1, mat, stops, uRep) => {
    const pts = [];
    for (let i = 0; i <= 18; i++) { const t = t0 + ((t1 - t0) * i) / 18; pts.push(new THREE.Vector2(bellR(rT, rE, t), yT - hb * t)); }
    const g = new THREE.LatheGeometry(pts, SEG + 8);
    colorize(g, stops);
    const m = mesh(g, uRep ? rep(mat, uRep, 1) : base()[mat]); m.position.set(x, 0, z); add(m);
  };
  if (split > 0.001) mk(0, split, tubes ? 'nozzle' : 'nozzleRad', ext > 0 ? REGEN.map(([t, c]) => [t, c]) : REGEN, tubes ? Math.round((TAU * rE) / 0.05 / 16) : 0);
  if (ext > 0.001) mk(split, 1, 'nozzleRad', RADIATIVE, 0);
  for (const t of rings) add(at(torus(bellR(rT, rE, t) + rE * 0.012, rE * 0.016, B.alu), x, yT - hb * t, z));
  if (ext > 0.001) add(at(torus(bellR(rT, rE, split) + rE * 0.01, rE * 0.022, B.dark), x, yT - hb * split, z));
  if (manifold != null) {
    const rm = bellR(rT, rE, manifold) + rE * 0.08;
    add(at(torus(rm, rE * 0.07, B.steel), x, yT - hb * manifold, z));
  }
  if (lip) add(at(torus(rE, Math.max(0.006, rE * 0.012), B.alu), x, yEnd, z));
  return { yT, hb };
}
function turbopump(add, p, s, flip = 1) {
  const B = base();
  const body = cyl(s * 0.42, s * 0.42, s * 1.5, B.steel); body.rotation.z = Math.PI / 2; body.position.copy(p); add(body);
  const vol = mesh(new THREE.TorusGeometry(s * 0.46, s * 0.2, 10, 24), B.alu); vol.rotation.y = Math.PI / 2; vol.position.copy(p).add(V3(flip * s * 0.45, 0, 0)); add(vol);
  const tur = cyl(s * 0.5, s * 0.36, s * 0.45, B.bronze); tur.rotation.z = Math.PI / 2; tur.position.copy(p).add(V3(-flip * s * 0.75, 0, 0)); add(tur);
  for (const dx of [-0.3, 0.3]) { const f = cyl(s * 0.47, s * 0.47, s * 0.06, B.dark); f.rotation.z = Math.PI / 2; f.position.copy(p).add(V3(dx * s, 0, 0)); add(f); }
}
function actuator(add, a, b, s) {
  const B = base(), mid = a.clone().lerp(b, 0.55);
  add(strut(a, mid, s * 0.05, B.steel)); add(strut(mid, b, s * 0.03, B.stainless));
  for (const p of [a, b]) { const k = mesh(new THREE.SphereGeometry(s * 0.055, 10, 8), B.dark); k.position.copy(p); add(k); }
}

// ---------- engines ----------
// Each engine has its own architecture; the numbers are fractions of the mount radius (s) or the length.
const ENGINES = {
  e_spark:     { mount: 'plate', mh: 0.14, rc: 0.3, hc: 0.24, rT: 0.15, rE: 0.62, tubes: false, valves: true },
  e_gnat:      { mount: 'foil', mh: 0.3, rc: 0.22, hc: 0.12, rT: 0.1, rE: 0.86, ext: 0.58, rings: [0.75] },
  e_ember:     { mount: 'struts', mh: 0.22, rc: 0.28, hc: 0.17, rT: 0.14, rE: 0.8, pumps: 1, ps: 0.2, duct: true, act: true },
  e_swift:     { mount: 'cone', mh: 0.3, rc: 0.36, hc: 0.18, rT: 0.19, rE: 0.9, gimbal: true, act: true, pumpTop: true },
  e_wisp:      { mount: 'foil', mh: 0.2, rc: 0.22, hc: 0.11, rT: 0.11, rE: 0.96, ext: 0.62, rings: [0.5, 0.82], pumps: 1, ps: 0.13, act: true },
  e_brute:     { mount: 'skirt', mh: 0.2, rc: 0.3, hc: 0.17, rT: 0.15, rE: 0.82, rings: [0.45], pumps: 2, ps: 0.2, duct: true, act: true },
  e_vector:    { mount: 'cone', mh: 0.2, rc: 0.25, hc: 0.22, rT: 0.13, rE: 0.74, preburners: 2, act: true },
  e_halo:      { mount: 'foil', mh: 0.18, rc: 0.19, hc: 0.1, rT: 0.1, rE: 0.98, ext: 0.66, rings: [0.5, 0.7, 0.9], pumps: 1, ps: 0.12, act: true },
  e_colossus:  { mount: 'skirt', mh: 0.14, rc: 0.33, hc: 0.15, rT: 0.17, rE: 0.86, ext: 0.42, manifold: 0.56, pumps: 1, ps: 0.26, act: true },
  e_aurora:    { mount: 'truss', mh: 0.26, rc: 0.17, hc: 0.1, rT: 0.09, rE: 0.98, ext: 0.72, rings: [0.42, 0.62, 0.82], pumps: 1, ps: 0.1, foilChamber: true, act: true },
  e_lantern:   { mount: 'cone', mh: 0.2, rc: 0.24, hc: 0.22, rT: 0.12, rE: 0.7, rings: [0.32], preburners: 2, pumps: 2, ps: 0.15, act: true, stainless: true },
  e_trio:      { mount: 'plate', mh: 0.16, cluster: [[0.5, 0], [0.5, TAU / 3], [0.5, (2 * TAU) / 3]], crc: 0.15, chc: 0.14, crT: 0.075, crE: 0.42, act: false },
  e_leviathan: { mount: 'skirt', mh: 0.22, cluster: [[0, 0], [0.6, 0], [0.6, TAU / 4], [0.6, TAU / 2], [0.6, (3 * TAU) / 4]], crc: 0.13, chc: 0.12, crT: 0.07, crE: 0.34, shrouds: true },
};
function buildEngine(add, def) {
  const B = base(), s = def.r, len = def.len, L = len / 2, p = ENGINES[def.id] || { mount: 'cone', mh: 0.22, rc: 0.28, hc: 0.18, rT: 0.14, rE: 0.8, act: true };
  const y0 = L - p.mh * len;
  // thrust structure
  add(cyl(s * 0.97, s * 0.97, Math.min(0.08, len * 0.04), B.carbon, L - Math.min(0.04, len * 0.02)));
  if (p.mount === 'cone') add(cyl(s * 0.9, (p.rc || 0.25) * s * 1.35, p.mh * len, B.carbon, (L + y0) / 2));
  if (p.mount === 'foil') add(cyl(s * 0.88, (p.rc || 0.2) * s * 1.25, p.mh * len, rep('gold', 3, 1), (L + y0) / 2));
  if (p.mount === 'plate') add(box(s * 0.35, p.mh * len * 0.8, s * 0.35, B.carbon, 0, (L + y0) / 2));
  if (p.mount === 'struts' || p.mount === 'truss') {
    const n = p.mount === 'truss' ? 6 : 4, rt = s * 0.78, rb = (p.rc || 0.2) * s * 1.2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU, a2 = ((i + (p.mount === 'truss' ? 1 : 0.5)) / n) * TAU;
      add(strut(polar(rt, a, L - 0.04), polar(rb, a2, y0 + 0.02), s * 0.03, B.alu));
      if (p.mount === 'truss') add(strut(polar(rt, a, L - 0.04), polar(rb, a - TAU / n, y0 + 0.02), s * 0.03, B.alu));
    }
    add(torus(rb, s * 0.03, B.dark, y0 + 0.02));
  }
  if (p.mount === 'skirt') {
    add(cyl(s * 0.99, s * 0.92, p.mh * len * 0.35, B.carbon, L - p.mh * len * 0.175));
    add(cyl(s * 0.9, s * 0.9, 0.04, rep('silver', 4, 1), L - p.mh * len * 0.37));
    add(cyl(s * 0.42, (p.rc || 0.25) * s * 1.15, p.mh * len * 0.65, B.black, y0 + p.mh * len * 0.32));
  }
  // chambers
  if (p.cluster) {
    for (const [rr, a] of p.cluster) {
      const x = Math.cos(a) * rr * s, z = Math.sin(a) * rr * s;
      chamberUnit(add, { x, z, y0, yEnd: -L, rc: p.crc * s, rT: p.crT * s, rE: p.crE * s, hc: p.chc * len });
      if (p.shrouds && rr > 0) { const sh = cyl(p.crE * s * 0.62, p.crE * s * 0.8, p.mh * len * 0.5, B.carbon, y0 - p.mh * len * 0.05); sh.position.x = x; sh.position.z = z; add(sh); }
      if (p.mount === 'plate') add(strut(V3(x * 0.6, L - 0.05, z * 0.6), V3(x, y0, z), s * 0.04, B.steel));
    }
    return;
  }
  const rc = p.rc * s, rE = p.rE * s, hc = p.hc * len;
  const { yT, hb } = chamberUnit(add, { y0, yEnd: -L, rc, rT: p.rT * s, rE, hc, ext: p.ext || 0, tubes: p.tubes !== false, rings: p.rings || [], manifold: p.manifold ?? null });
  if (p.stainless) add(cyl(rc * 1.05, rc * 1.05, hc * 0.5, B.stainless, y0 - hc * 0.35));
  if (p.foilChamber) add(cyl(rc * 1.15, rc * 1.1, hc * 0.8, rep('gold', 2, 1), y0 - hc * 0.4));
  if (p.valves) { add(box(rc * 0.6, hc * 0.4, rc * 0.5, B.alu, rc * 1.2, y0 - hc * 0.3, 0)); add(box(rc * 0.5, hc * 0.35, rc * 0.5, B.alu, -rc * 1.15, y0 - hc * 0.25, 0)); add(pipe([V3(rc * 1.2, y0 - hc * 0.1, 0), V3(rc * 1.1, y0 + 0.02, 0), V3(rc * 0.5, L - 0.04, 0)], rc * 0.08, B.bronze)); }
  if (p.gimbal) { add(box(rc * 1.3, hc * 0.35, rc * 1.3, B.dark, 0, y0 + hc * 0.1)); add(cyl(rc * 0.5, rc * 0.5, rc * 1.8, B.steel, y0 + hc * 0.1)).rotation; }
  if (p.pumpTop) { add(cyl(rc * 0.55, rc * 0.55, p.mh * len * 0.5, B.steel, y0 + p.mh * len * 0.4)); add(torus(rc * 0.62, rc * 0.12, B.bronze, y0 + p.mh * len * 0.5)); }
  for (let i = 0; i < (p.pumps || 0); i++) {
    const side = i === 0 ? 1 : -1, ps = p.ps * s, pp = V3(side * (rc + ps * 1.1), y0 - hc * 0.15, 0);
    turbopump(add, pp, ps, side);
    add(pipe([pp.clone().add(V3(0, ps * 0.4, 0)), pp.clone().add(V3(-side * ps * 0.3, ps * 1.6, 0)), V3(side * s * 0.45, L - 0.05, s * 0.1)], ps * 0.22, B.alu));
    add(pipe([pp.clone().add(V3(side * ps * 0.2, -ps * 0.3, ps * 0.3)), V3(side * rc * 1.1, yT + hc * 0.1, ps * 0.4), V3(side * p.rT * s * 1.6, yT - hb * 0.04, 0)], ps * 0.16, B.bronze));
    if (p.duct && i === 0) {
      const ex = bellR(p.rT * s, rE, 0.92) + ps * 0.5;
      add(pipe([pp.clone().add(V3(-side * ps * 0.8, -ps * 0.2, 0)), V3(side * (rc + ps * 2.2), yT - hb * 0.3, ps * 0.5), V3(side * ex, -L + hb * 0.06, ps * 0.4)], ps * 0.28, B.dark));
    }
  }
  for (let i = 0; i < (p.preburners || 0); i++) {
    const side = i === 0 ? 1 : -1, r = s * 0.12, px = side * (rc + r * 1.25), py = y0 - hc * 0.05;
    const pb = lathe([[0, py + r * 1.6], [r * 0.7, py + r * 1.5], [r, py + r * 1.1], [r, py - r * 1.4], [r * 0.6, py - r * 1.8], [0, py - r * 1.8]], B.steel); pb.position.x = px; add(pb);
    add(torus(r * 1.03, r * 0.1, B.bronze, py)).position.x = px;
    add(pipe([V3(px, py - r * 1.8, 0), V3(px * 0.8, y0 - hc * 0.45, r), V3(rc * 0.9 * side, y0 - hc * 0.5, 0)], r * 0.35, B.alu));
  }
  if (p.act) {
    const a1 = Math.PI / 4, a2 = (3 * Math.PI) / 4;
    for (const a of [a1, a2]) actuator(add, polar(s * 0.62, a + Math.PI / 2, L - 0.06), polar(rc * 1.05, a + Math.PI / 2, y0 - hc * 0.55), s);
  }
}

function buildAerospike(add, def) {
  const B = base(), s = def.r, len = def.len, L = len / 2, yh = L - len * 0.28;
  add(cyl(s * 0.97, s * 0.92, len * 0.28, B.carbon, (L + yh) / 2));
  add(cyl(s * 0.93, s * 0.93, 0.03, B.alu, yh));
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, c = cyl(s * 0.06, s * 0.045, len * 0.1, B.steel, yh - len * 0.04);
    c.position.x = Math.cos(a) * s * 0.84; c.position.z = Math.sin(a) * s * 0.84; add(c);
  }
  const pts = []; for (let i = 0; i <= 20; i++) { const t = i / 20; pts.push(new THREE.Vector2(s * (0.84 * Math.pow(1 - t, 1.5) + 0.22 * t), yh - (yh + L) * t)); }
  const g = new THREE.LatheGeometry(pts, SEG + 8); colorize(g, [[0, 0x8a5430], [0.35, 0x4c4a5e], [1, 0xa9abb0]]);
  add(mesh(g, rep('nozzle', 24, 1)));
  add(cyl(s * 0.22, s * 0.22, 0.03, B.black, -L + 0.015));
}

// ---------- the parts ----------
function build(def) {
  const B = base(), g = new THREE.Group();
  const { r, rTop, len } = def, L = len / 2;
  const add = (...o) => { g.add(...o); return o[0]; };
  switch (def.shape) {
    case 'tank': {
      add(cyl(rTop, r, len, skin('paint', (r + rTop) / 2, len)));
      const jh = Math.min(0.09, len * 0.05);
      add(ring(r, jh, B.carbon, -L + jh / 2)); add(ring(rTop, jh, B.carbon, L - jh / 2));
      if (rTop === r && len >= 1.9) {
        const w = Math.max(0.07, r * 0.09);
        add(onSurface(box(w * 0.7, len - jh * 2 - 0.08, w, B.paint), r + w * 0.3, Math.PI * 0.5, 0));
        for (let y = -L + 0.6; y < L - 0.4; y += 1.2) add(onSurface(box(w * 0.9, 0.04, w * 1.3, B.carbon), r + w * 0.3, Math.PI * 0.5, y));
      }
      if (rTop === r && r >= 1.8 && len >= 8) {
        const pr = r * 0.07, a = Math.PI * 1.25;
        add(pipe([polar(r + pr * 1.6, a, L - 0.2), polar(r + pr * 1.6, a, -L + 0.2)], pr, B.paint));
        for (let y = -L + 1; y < L - 0.5; y += 2) add(onSurface(box(pr * 2.4, 0.08, pr * 1.2, B.carbon), r + pr * 0.8, a, y));
      }
      break;
    }
    case 'steeltank': {
      add(cyl(r, r, len, B.stainless));
      for (let y = -L + 1.8; y < L - 0.2; y += 1.8) add(ring(r, 0.025, B.steel, y, 1.002));
      add(ring(r, 0.05, B.dark, -L + 0.025, 1.004)); add(ring(r, 0.05, B.dark, L - 0.025, 1.004));
      add(onSurface(box(0.08, len * 0.94, 0.16, B.stainless), r + 0.03, Math.PI * 0.5, 0));
      break;
    }
    case 'spheretank': {
      const rs = r * 0.9;
      const sp = add(mesh(new THREE.SphereGeometry(rs, SEG, 24), skin('paint', rs, rs * 3))); sp.position.y = 0;
      add(torus(rs * 1.005, r * 0.03, B.carbon, 0));
      add(cyl(r, r, 0.06, B.carbon, L - 0.03)); add(cyl(r, r, 0.06, B.carbon, -L + 0.03));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        add(strut(polar(r * 0.94, a, L - 0.06), polar(rs, a + 0.25, 0), r * 0.025, B.alu));
        add(strut(polar(r * 0.94, a, -L + 0.06), polar(rs, a + 0.25, 0), r * 0.025, B.alu));
      }
      break;
    }
    case 'cone': {
      const pts = [];
      for (let i = 0; i <= 18; i++) { const t = i / 18; pts.push([r * (def.blunt ? Math.sqrt(1 - t * t) : Math.pow(1 - Math.pow(t, 1.7), 0.8)), -L + len * t]); }
      add(lathe(pts, rep('paint', (TAU * r) / TILE, len / TILE)));
      add(ring(r, Math.min(0.06, len * 0.04), B.carbon, -L + 0.03, 1.008));
      if (!def.blunt && r >= 0.6) { const tip = lathe([[r * 0.06, L - len * 0.03], [0, L]], B.alu); add(tip); }
      break;
    }
    case 'fairing': {
      const hc = r * 1.6, pts = [[r, -L], [r, -L + hc]];
      for (let i = 1; i <= 18; i++) { const t = i / 18; pts.push([r * Math.pow(1 - Math.pow(t, 1.9), 0.75), -L + hc + (len - hc) * t]); }
      add(lathe(pts, rep('paint', (TAU * r) / TILE, len / TILE)));
      add(ring(r, 0.08, B.carbon, -L + 0.04, 1.008));
      for (const a of [0, Math.PI]) add(onSurface(box(0.03, hc, 0.05, B.carbon), r, a, -L + hc / 2));
      add(lathe([[r * 0.05, L - len * 0.02], [0, L]], B.alu));
      break;
    }
    case 'capsule': {
      const B2 = B, bh = len * 0.07, tunnel = len * 0.14, top = L - tunnel;
      add(cyl(rTop, r, top - (-L + bh), rep('tiles', (TAU * r) / 4, len / 4), (top + (-L + bh)) / 2));
      add(cyl(r * 1.005, r * 1.01, bh, rep('ablative', (TAU * r) / 0.5, 0.3), -L + bh / 2));
      add(cyl(rTop * 0.98, rTop, 0.04, B2.carbon, top - 0.02));
      add(cyl(rTop * 0.58, rTop * 0.62, tunnel, B2.alu, top + tunnel / 2));
      add(torus(rTop * 0.6, rTop * 0.04, B2.dark, L - 0.02));
      const n = def.crew > 3 ? 4 : def.crew > 1 ? 3 : 1, slope = Math.atan2(r - rTop, top + L - bh);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + Math.PI / 2, y = -L + bh + (top + L - bh) * 0.55, rr = r + (rTop - r) * 0.55;
        const fr = box(0.03, len * 0.2, r * 0.3, B2.carbon); onSurface(fr, rr + 0.005, a, y); fr.rotateZ(slope); add(fr);
        const w = box(0.03, len * 0.15, r * 0.23, B2.glass); onSurface(w, rr + 0.02, a, y); w.rotateZ(slope); add(w);
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4, y = top - len * 0.12, rr = rTop + (r - rTop) * 0.15;
        add(onSurface(box(0.06 * r + 0.04, 0.08 * r + 0.04, 0.1 * r + 0.06, B2.paint), rr + 0.02, a, y));
      }
      break;
    }
    case 'dock': {
      add(cyl(r, r, len * 0.45, B.carbon, -L + len * 0.225));
      add(cyl(r * 0.72, r * 0.78, len * 0.55, B.alu, L - len * 0.275));
      add(torus(r * 0.72, r * 0.035, B.dark, L - 0.01));
      for (let i = 0; i < 3; i++) { const p = box(0.03, len * 0.6, r * 0.32, B.alu); onSurface(p, r * 0.62, (i / 3) * TAU, L + len * 0.12); p.rotateZ(-0.35); add(p); }
      break;
    }
    case 'probe': {
      const oct = r < 1;
      add(cyl(r, r, len, B.carbon, 0, oct ? 8 : SEG));
      if (oct) {
        add(cyl(r * 1.006, r * 1.006, len * 0.62, rep('gold', 2, 1), 0, 8));
        add(strut(V3(r * 0.5, L, 0), V3(r * 0.5, L + len * 1.3, 0), 0.008 + r * 0.01, B.steel));
        add(box(r * 0.35, len * 0.35, r * 0.35, B.alu, -r * 0.3, L + len * 0.16, 0));
      } else {
        add(cyl(r * 1.004, r * 1.004, len * 0.18, rep('gold', 6, 1), -len * 0.18));
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU, bx = box(0.06, len * 0.42, r * 0.22, i % 2 ? B.alu : rep('gold', 1, 1));
          add(onSurface(bx, r + 0.03, a, len * 0.15));
        }
      }
      break;
    }
    case 'engine': buildEngine(add, def); break;
    case 'aerospike': buildAerospike(add, def); break;
    case 'rengine': {
      add(lathe([[0, L], [r * 0.7, L], [r * 0.95, L - len * 0.12], [r * 0.95, -L + len * 0.45], [r * 0.6, -L + len * 0.38], [0, -L + len * 0.38]], B.paint));
      chamberUnit(add, { y0: -L + len * 0.42, yEnd: -L, rc: r * 0.3, rT: r * 0.18, rE: r * 0.62, hc: len * 0.08, tubes: false });
      add(box(r * 0.5, len * 0.6, r * 1.2, B.carbon, -r * 0.7, L - len * 0.35, 0));
      break;
    }
    case 'srb': {
      if (def.id === 'srb_sep') {
        add(cyl(r, r, len * 0.8, B.paint, len * 0.1)); add(cyl(r * 1.02, r, len * 0.12, B.carbon, L - len * 0.06));
        const nz = lathe([[r * 0.35, -L + len * 0.2], [r * 0.8, -L]], B.phenolic); nz.rotation.z = 0.35; add(nz);
        break;
      }
      const nz = Math.min(len * 0.08, r * 1.6), body = len - nz, yb = -L + nz;
      add(cyl(r, r, body, skin('paint', r, body), yb + body / 2));
      const segs = Math.max(1, Math.round(body / (r * 5)));
      for (let i = 1; i < segs; i++) add(ring(r, 0.07 * Math.max(1, r), B.carbon, yb + (body * i) / segs, 1.015));
      add(ring(r, 0.1 * Math.max(0.6, r), B.carbon, L - 0.05 * Math.max(0.6, r), 1.012));
      const sk = r * 0.9;
      add(cyl(r * 1.01, r * 1.16, sk, rep('ribbed', (TAU * r) / 0.6, sk / 1.2), yb + sk / 2 - nz * 0.35));
      add(lathe([[r * 0.34, yb + nz * 0.1], [r * 0.5, -L + nz * 0.45], [r * 0.72, -L]], B.phenolic));
      add(torus(r * 0.72, r * 0.025, B.dark, -L));
      add(onSurface(box(r * 0.08, body * 0.9, r * 0.16, B.paint), r + r * 0.04, Math.PI, yb + body / 2));
      for (const y of [L - r * 0.8, yb + r * 1.2]) add(onSurface(box(r * 0.25, r * 0.3, r * 0.4, B.carbon), r + r * 0.08, 0, y));
      break;
    }
    case 'decoupler': {
      add(cyl(r, r, len, B.carbon));
      add(ring(r, 0.012, B.alu, 0, 1.006));
      for (let i = 0; i < 12; i++) add(onSurface(box(0.03, len * 0.5, Math.max(0.05, r * 0.06), B.dark), r + 0.008, (i / 12) * TAU, 0));
      break;
    }
    case 'rdecoupler': {
      const d = Math.max(0.22, r * 1.6);
      add(box(r * 1.6, len, d, def.fixed ? B.alu : B.carbon, -r * 0.2, 0, 0));
      for (const y of [-len * 0.32, len * 0.32]) add(box(r * 2.05, len * 0.08, d * 1.08, def.fixed ? B.carbon : B.alu, 0, y, 0));
      const bolt = cyl(d * 0.18, d * 0.18, r * 2.1, B.steel); bolt.rotation.z = Math.PI / 2; add(bolt);
      break;
    }
    case 'fin': {
      const f = def.fin;
      if (f.grid) {
        const tm = B.dark, w = 0.32;
        for (const y of [-f.chord / 2, f.chord / 2]) add(box(f.span, 0.05, w, tm, f.span / 2, y, 0));
        for (const x of [0, f.span]) add(box(0.05, f.chord, w, tm, x, 0, 0));
        for (let i = 1; i < 6; i++) add(box(f.span, 0.015, w * 0.9, tm, f.span / 2, -f.chord / 2 + (f.chord * i) / 6, 0));
        for (let i = 1; i < 7; i++) add(box(0.015, f.chord, w * 0.9, tm, (f.span * i) / 7, 0, 0));
        const hinge = cyl(0.08, 0.08, 0.2, B.steel); hinge.rotation.z = Math.PI / 2; hinge.position.x = -0.05; add(hinge);
        break;
      }
      const sh = new THREE.Shape();
      sh.moveTo(0, f.chord / 2); sh.lineTo(f.span, f.chord / 2 - f.sweep); sh.lineTo(f.span, f.chord / 2 - f.sweep - f.tip); sh.lineTo(0, -f.chord / 2); sh.closePath();
      const th = Math.max(0.04, f.span * 0.035), bev = th * 0.35;
      const mk = (d, z, m) => { const geo = new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: true, bevelThickness: bev * 0.6, bevelSize: bev, bevelSegments: 2 }); geo.translate(0, 0, z); return add(mesh(geo, m)); };
      const skinM = f.control ? B.carbon : rep('paint', 1 / TILE, 1 / TILE);
      if (def.id === 'wing') { mk(th / 2, 0, rep('paint', 1 / TILE, 1 / TILE)); mk(th / 2, -th / 2, rep('tiles', 1 / 4, 1 / 4)); }
      else mk(th, -th / 2, skinM);
      const le = new THREE.Vector3(f.span, -f.sweep, 0), lel = le.length();
      const strip = box(th * 0.9, lel, th * 1.9, f.control ? B.alu : B.carbon);
      strip.position.set(f.span / 2, f.chord / 2 - f.sweep / 2, 0); strip.rotation.z = Math.atan2(-f.span, -f.sweep); add(strip);
      add(box(0.08, f.chord * 0.9, th * 3, B.carbon, 0.02, -f.sweep * 0, 0));
      if (f.control) { const pod = cyl(th * 2.2, th * 2.2, f.chord * 0.5, B.paint); pod.position.set(0.05, -f.chord * 0.1, 0); add(pod); }
      break;
    }
    case 'wheel': {
      if (def.dark) {
        add(cyl(r, r, len, B.dark));
        for (let i = 0; i < 4; i++) { const e = mesh(new THREE.TorusGeometry(r * 0.08, r * 0.02, 6, 12), B.steel); e.position.copy(polar(r * 0.6, (i / 4) * TAU + 0.4, L + r * 0.04)); e.rotation.y = -(i / 4) * TAU; add(e); }
        add(ring(r, len * 0.12, B.steel, L - len * 0.06, 1.004)); add(ring(r, len * 0.12, B.steel, -L + len * 0.06, 1.004));
        break;
      }
      add(cyl(r, r, len, B.carbon));
      for (let i = 0; i < 6; i++) add(onSurface(box(0.02, len * 0.6, r * 0.5, B.alu), r + 0.006, (i / 6) * TAU, 0));
      add(ring(r, len * 0.1, rep('gold', 6, 1), L - len * 0.05, 1.004));
      break;
    }
    case 'rcs': {
      add(box(0.1, 0.24, 0.24, B.paint, 0.03, 0, 0));
      add(box(0.04, 0.3, 0.3, B.carbon, -0.03, 0, 0));
      for (const [dy, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = mesh(new THREE.ConeGeometry(0.04, 0.09, 12, 1, true), B.bronze);
        n.position.set(0.05, dy * 0.15, dz * 0.15);
        n.quaternion.setFromUnitVectors(V3(0, -1, 0), V3(0, dy, dz));
        add(n);
      }
      break;
    }
    case 'monotank': {
      add(cyl(r, r, 0.05, B.carbon, L - 0.025)); add(cyl(r, r, 0.05, B.carbon, -L + 0.025));
      const rs = Math.min(r * 0.36, L - 0.05);
      for (let i = 0; i < 4; i++) { const s = mesh(new THREE.SphereGeometry(rs, 24, 16), B.paint); s.position.copy(polar(r - rs - 0.03, (i / 4) * TAU + Math.PI / 4, 0)); add(s); }
      add(cyl(r * 0.18, r * 0.18, len - 0.1, B.alu));
      for (let i = 0; i < 4; i++) add(strut(polar(r * 0.95, (i / 4) * TAU, -L + 0.05), polar(r * 0.95, (i / 4) * TAU, L - 0.05), r * 0.03, B.alu));
      break;
    }
    case 'sphere': {
      add(mesh(new THREE.SphereGeometry(r * 0.94, 28, 20), B.paint));
      add(torus(r * 0.95, r * 0.05, B.carbon, 0));
      add(box(r * 0.4, r * 0.6, r * 0.5, B.carbon, -r * 0.85, 0, 0));
      break;
    }
    case 'chute': {
      if (def.id === 'chute_L') {
        add(cyl(r, r, len * 0.25, B.carbon, -L + len * 0.125));
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * TAU, cr = r * 0.4, c = cyl(cr * 0.85, cr, len * 0.75, B.paint, L - len * 0.375); c.position.x = Math.cos(a) * r * 0.48; c.position.z = Math.sin(a) * r * 0.48; add(c);
          const lid = cyl(cr * 0.88, cr * 0.88, 0.05, B.carbon, L - 0.025); lid.position.x = c.position.x; lid.position.z = c.position.z; add(lid);
        }
        break;
      }
      add(cyl(rTop, r, len * 0.8, B.paint, -L + len * 0.4));
      add(cyl(rTop * 0.98, rTop * 1.02, len * 0.2, B.carbon, L - len * 0.1));
      for (let i = 0; i < 3; i++) add(onSurface(box(0.012, len * 0.7, 0.04, B.carbon), (r + rTop) / 2 + 0.004, (i / 3) * TAU, -len * 0.05));
      break;
    }
    case 'rchute': {
      add(cyl(r * 0.95, r, len * 0.82, B.paint, -L + len * 0.41));
      add(cyl(r * 0.98, r * 0.98, len * 0.18, B.carbon, L - len * 0.09));
      add(box(r * 0.5, len * 0.6, r * 1.2, B.carbon, -r * 0.85, 0, 0));
      break;
    }
    case 'shield': {
      const pts = [[0, -L]];
      for (let i = 1; i <= 10; i++) { const t = i / 10; pts.push([r * t, -L + len * 0.7 * t * t]); }
      pts.push([r, L - len * 0.1], [r * 0.96, L]);
      add(lathe(pts, rep('ablative', (TAU * r) / 0.5, r / 0.45)));
      add(cyl(r * 0.96, r * 0.96, 0.02, B.carbon, L - 0.01));
      add(ring(r, len * 0.16, B.carbon, L - len * 0.08, 1.004));
      break;
    }
    case 'leg': {
      const { reach, drop } = def.leg, foot = V3(reach, -drop, 0);
      const top = V3(0, L * 0.8, 0), knee = top.clone().lerp(foot, 0.55);
      add(strut(top, knee, r * 0.6, B.alu)); add(strut(knee, foot, r * 0.42, B.stainless));
      add(strut(V3(0, -L * 0.6, 0), foot.clone().lerp(top, 0.25), r * 0.3, B.alu));
      add(box(r * 1.6, len * 0.95, r * 2.2, B.carbon));
      const pad = cyl(r * 2.1, r * 2.4, r * 0.5, B.carbon); pad.position.copy(foot); pad.position.y += r * 0.25; add(pad);
      const rim = torus(r * 2.4, r * 0.08, B.alu); rim.position.copy(foot); add(rim);
      break;
    }
    case 'truss': {
      const n = 4, rr = r * 0.82;
      const pts = [...Array(n)].map((_, i) => { const a = (i / n) * TAU + Math.PI / 4; return [Math.cos(a) * rr, Math.sin(a) * rr]; });
      const bays = Math.max(1, Math.round(len / (r * 1.6)));
      pts.forEach(([x, z], i) => {
        add(strut(V3(x, -L, z), V3(x, L, z), r * 0.06, B.alu));
        const [x2, z2] = pts[(i + 1) % n];
        for (let b = 0; b < bays; b++) {
          const y0 = -L + (len * b) / bays, y1 = -L + (len * (b + 1)) / bays;
          add(strut(V3(x, y0, z), V3(x2, y1, z2), r * 0.035, B.alu));
          add(strut(V3(x, y1, z), V3(x2, y1, z2), r * 0.035, B.steel));
        }
      });
      add(torus(r * 0.9, r * 0.06, B.carbon, L - r * 0.06)); add(torus(r * 0.9, r * 0.06, B.carbon, -L + r * 0.06));
      break;
    }
    case 'adapter':
      add(cyl(rTop, r, len, rep('ribbed', (TAU * r) / 0.6, len / 1.2)));
      add(ring(r, 0.06, B.carbon, -L + 0.03, 1.006)); add(ring(rTop, 0.06, B.carbon, L - 0.03, 1.006));
      break;
    case 'boom':
      add(strut(V3(-def.boomLen / 2, 0, 0), V3(def.boomLen / 2, 0, 0), r, B.alu, 12));
      add(box(0.06, 0.34, 0.34, B.carbon, def.boomLen / 2 - 0.03, 0, 0));
      add(box(0.08, 0.26, 0.26, B.carbon, -def.boomLen / 2 + 0.04, 0, 0));
      break;
    case 'satbus': {
      const w = r * 1.5;
      add(box(w, len, w, rep('gold', 1, 1)));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(box(0.04, len * 1.01, 0.04, B.carbon, (sx * w) / 2, 0, (sz * w) / 2));
      for (const sy of [-1, 1]) add(box(w * 1.02, 0.04, w * 1.02, B.carbon, 0, (sy * len) / 2, 0));
      const st = cyl(0.06, 0.07, 0.14, B.dark); st.position.set(w * 0.25, len / 2 + 0.07, -w * 0.25); add(st);
      for (const sx of [-1, 1]) { const n = mesh(new THREE.ConeGeometry(0.03, 0.06, 10, 1, true), B.bronze); n.position.set((sx * w) / 2 * 0.8, -len / 2 - 0.03, w * 0.35); add(n); }
      break;
    }
    case 'panel': {
      const segs = 3, gap = 0.04, sw = (def.panelLen - gap * (segs - 1)) / segs;
      for (let i = 0; i < segs; i++) {
        const x0 = 0.14 + i * (sw + gap);
        add(box(sw, len, 0.02, rep('cells', sw / 0.8, len / 0.8), x0 + sw / 2, 0, 0));
        add(box(sw, 0.02, 0.03, B.alu, x0 + sw / 2, len / 2, 0)); add(box(sw, 0.02, 0.03, B.alu, x0 + sw / 2, -len / 2, 0));
      }
      add(strut(V3(0, 0, 0), V3(0.14, 0, 0), 0.025, B.alu));
      const h = cyl(0.04, 0.04, len * 0.4, B.carbon); h.position.x = 0.02; add(h);
      break;
    }
    case 'fanpanel': {
      const R = def.fanR;
      add(strut(V3(0, 0, 0), V3(R * 0.25, 0, 0), 0.03, B.alu));
      const disc = mesh(new THREE.CircleGeometry(R, 40), rep('cells', R * 2.5, R * 2.5)); disc.position.x = R * 1.25; disc.rotation.y = Math.PI / 2; add(disc);
      const back = mesh(new THREE.CircleGeometry(R, 40), B.carbon); back.position.x = R * 1.25 - 0.01; back.rotation.y = -Math.PI / 2; add(back);
      for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; add(strut(V3(R * 1.25 - 0.01, 0, 0), V3(R * 1.25 - 0.01, Math.cos(a) * R, Math.sin(a) * R), 0.008, B.alu, 5)); }
      add(torus(0.06, 0.03, B.dark)).rotation.set(0, Math.PI / 2, 0);
      break;
    }
    case 'floodlight': {
      const dir = V3(...def.light.dir).normalize(), c = V3(0.12, -0.04, 0);
      add(box(0.05, 0.22, 0.16, B.carbon, 0.005, 0, 0));
      for (const z of [-0.085, 0.085]) add(box(0.1, 0.03, 0.02, B.dark, 0.06, -0.02, z));
      const hous = cyl(0.085, 0.07, 0.15, B.dark); hous.position.copy(c); hous.quaternion.setFromUnitVectors(V3(0, 1, 0), dir); add(hous);
      for (let i = 0; i < 4; i++) { const f = cyl(0.078, 0.078, 0.008, B.alu); f.position.copy(c).addScaledVector(dir, -0.055 + i * 0.022); f.quaternion.copy(hous.quaternion); add(f); }
      const rim = cyl(0.092, 0.092, 0.02, B.alu); rim.position.copy(c).addScaledVector(dir, 0.075); rim.quaternion.copy(hous.quaternion); add(rim);
      const lens = cyl(0.08, 0.08, 0.012, lightMats().spot); lens.position.copy(c).addScaledVector(dir, 0.084); lens.quaternion.copy(hous.quaternion); add(lens);
      break;
    }
    case 'navlight': {
      add(box(0.03, 0.09, 0.07, B.carbon, 0.0, 0, 0));
      add(box(0.03, 0.05, 0.05, B.dark, 0.025, 0, 0));
      const dome = mesh(new THREE.SphereGeometry(0.034, 16, 10, 0, Math.PI), lightMats()[def.light.kind]); dome.rotation.y = -Math.PI / 2; dome.position.x = 0.04; add(dome);
      break;
    }
    case 'antenna': {
      add(box(0.06, 0.12, 0.12, B.carbon, -0.02, 0, 0));
      add(strut(V3(0, 0, 0), V3(0, def.mast, 0), 0.012, B.steel, 6));
      const tip = mesh(new THREE.SphereGeometry(0.025, 10, 8), B.dark); tip.position.y = def.mast; add(tip);
      break;
    }
    case 'dish': {
      const pts = [];
      for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push([r * t, -L * 0.4 + len * 0.6 * t * t]); }
      add(lathe(pts, B.dish));
      add(torus(r, 0.012, B.alu, -L * 0.4 + len * 0.6));
      const focus = V3(0, L * 0.9, 0);
      for (let i = 0; i < 3; i++) add(strut(polar(r * 0.95, (i / 3) * TAU, -L * 0.4 + len * 0.6 * 0.9), focus, 0.008, B.alu, 5));
      add(lathe([[0.02, focus.y - 0.06], [0.05, focus.y]], B.dark));
      add(cyl(0.08, 0.1, len * 0.3, B.carbon, -L + len * 0.15));
      break;
    }
    case 'cargo': {
      add(cyl(r, r, len, skin('paint', r, len)));
      add(ring(r, 0.08, B.carbon, L - 0.04, 1.008)); add(ring(r, 0.08, B.carbon, -L + 0.04, 1.008));
      const gf = box(0.06, r * 0.4, r * 0.4, B.carbon); add(onSurface(gf, r + 0.03, Math.PI / 2, 0));
      const pin = cyl(r * 0.05, r * 0.05, r * 0.3, B.alu); pin.rotation.z = Math.PI / 2; add(onSurface(pin, r + 0.12, Math.PI / 2, 0));
      for (let i = 0; i < 4; i++) add(onSurface(box(0.05, 0.12, 0.1, B.alu), r + 0.02, (i / 4) * TAU + Math.PI / 4, L - 0.25));
      break;
    }
    case 'telescope': {
      const aft = len * 0.38;
      add(cyl(r, r, aft, rep('silver', 6, 1), -L + aft / 2));
      add(cyl(r * 0.92, r * 0.92, len - aft, rep('silver', 6, 2), -L + aft + (len - aft) / 2));
      add(ring(r * 0.92, 0.05, B.carbon, L - 0.025, 1.01));
      for (let i = 0; i < 4; i++) add(ring(r, 0.04, B.carbon, -L + (aft * (i + 1)) / 5, 1.004));
      const door = cyl(r * 0.92, r * 0.92, 0.06, B.paint); door.position.set(-r * 0.95, L + r * 0.62, 0); door.rotation.z = -1.2; add(door);
      add(strut(V3(-r * 0.92, L, 0), V3(-r * 0.6, L + r * 0.3, 0), 0.03, B.alu));
      for (let i = 0; i < 6; i++) add(onSurface(box(0.04, 0.06, 0.06, B.paint), r * 0.92 + 0.02, (i / 6) * TAU, L - len * 0.1));
      break;
    }
    case 'habitat': {
      const end = r * 0.4, mid = len - end * 2;
      add(cyl(r, r, mid, rep('ribbed', (TAU * r) / 0.5, mid / 1.1)));
      add(cyl(r * 0.55, r, end, B.carbon, L - end / 2)); add(cyl(r, r * 0.55, end, B.carbon, -L + end / 2));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        const wg = new THREE.CylinderGeometry(r * 0.16, r * 0.16, 0.04, 24); wg.rotateZ(Math.PI / 2);
        add(onSurface(mesh(wg, B.glass), r + 0.01, a, mid * 0.15));
        const fg = new THREE.TorusGeometry(r * 0.17, r * 0.025, 8, 24); fg.rotateY(Math.PI / 2);
        add(onSurface(mesh(fg, B.alu), r + 0.02, a, mid * 0.15));
      }
      for (const a of [0, Math.PI]) add(strut(polar(r + 0.08, a, -mid / 2 + 0.2), polar(r + 0.08, a, mid / 2 - 0.2), 0.02, B.alu));
      break;
    }
    case 'service': {
      add(cyl(r, r, len, skin('paint', r, len)));
      add(ring(r, 0.06, B.carbon, L - 0.03, 1.006)); add(ring(r, 0.06, B.carbon, -L + 0.03, 1.006));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU;
        const rad = box(0.03, len * 0.7, r * 0.9, B.dish); add(onSurface(rad, r + 0.03, a + Math.PI / 4, 0));
        const q = box(0.14, 0.22, 0.22, B.paint); add(onSurface(q, r + 0.08, a, L - 0.35));
        for (const [dy, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = mesh(new THREE.ConeGeometry(0.035, 0.08, 10, 1, true), B.bronze); n.position.copy(polar(r + 0.13, a, L - 0.35)).add(V3(0, dy * 0.13, 0)).add(polar(dz * 0.13, a + Math.PI / 2, 0)); n.quaternion.setFromUnitVectors(V3(0, -1, 0), V3(0, dy, 0).add(polar(dz, a + Math.PI / 2, 0)).normalize()); add(n); }
      }
      break;
    }

    case 'fbase': {
      add(cyl(r, r, len, B.carbon));
      add(ring(r, 0.025, B.alu, L - 0.02, 1.006));
      add(ring(r, 0.02, B.dark, -L + 0.03, 1.006));
      for (let i = 0; i < 16; i++) add(onSurface(box(0.025, len * 0.55, Math.max(0.05, r * 0.05), B.dark), r + 0.006, (i / 16) * TAU, -len * 0.1));
      // payload adapter cone and clamp band inside the ring
      add(cyl(r * 0.55, r * 0.9, len * 0.8, B.alu, 0, SEG, true));
      add(torus(r * 0.55, Math.max(0.012, r * 0.02), B.steel, L - 0.02));
      break;
    }
    case 'ntr': {
      // reactor in a radiation-shielded drum, hydrogen turbopump on top, regeneratively cooled bell
      const s = r, yR = L - len * 0.12;
      add(cyl(s * 0.97, s * 0.97, 0.06, B.carbon, L - 0.03));
      add(cyl(s * 0.5, s * 0.62, len * 0.12, B.dark, L - len * 0.06));
      turbopump(add, V3(s * 0.55, L - len * 0.08, 0), s * 0.16);
      add(cyl(s * 0.62, s * 0.62, len * 0.34, B.stainless, yR - len * 0.17));
      for (let i = 0; i < 5; i++) add(ring(s * 0.62, 0.03, B.dark, yR - len * (0.03 + i * 0.07), 1.01));
      for (let i = 0; i < 12; i++) add(onSurface(box(0.04, len * 0.3, 0.07, B.steel), s * 0.64, (i / 12) * TAU, yR - len * 0.17));
      // the trefoil plate
      add(onSurface(box(0.02, len * 0.1, s * 0.34, B.paint), s * 0.635, 0, yR - len * 0.12));
      add(onSurface(box(0.022, len * 0.05, s * 0.12, B.black), s * 0.64, 0, yR - len * 0.12));
      chamberUnit(add, { y0: yR - len * 0.34, yEnd: -L, rc: s * 0.4, rT: s * 0.16, rE: s * 0.86, hc: len * 0.08, ext: 0.3, rings: [0.5] });
      for (let i = 0; i < 3; i++) add(pipe([polar(s * 0.66, (i / 3) * TAU, L - len * 0.12), polar(s * 0.75, (i / 3) * TAU + 0.2, yR - len * 0.2), polar(s * 0.45, (i / 3) * TAU + 0.4, yR - len * 0.43)], s * 0.04, B.alu));
      break;
    }
    case 'les': {
      // escape motor on a truss: nozzle ring angled outward high up, jettison motor and nose on top
      const tl = len * 0.42, ym = -L + tl;
      const n = 4, rt = r * 1.8, rb = r * 0.8;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + Math.PI / 4, a2 = a + TAU / n;
        add(strut(polar(rt, a, -L + 0.04), polar(rb, a, ym), r * 0.06, B.steel));
        add(strut(polar(rt, a, -L + 0.04), polar(rb, a2, ym), r * 0.04, B.steel));
      }
      add(torus(rt, r * 0.06, B.dark, -L + 0.04));
      add(cyl(r, r, len * 0.36, B.paint, ym + len * 0.18));
      const yn = ym + len * 0.36;
      add(cyl(r * 1.05, r, len * 0.06, B.carbon, yn + len * 0.03));
      for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU, nz = mesh(new THREE.ConeGeometry(r * 0.32, r * 0.7, 14, 1, true), B.phenolic); nz.position.copy(polar(r * 0.95, a, yn + len * 0.02)); nz.quaternion.setFromUnitVectors(V3(0, 1, 0), polar(0.55, a, 1).normalize()); add(nz); }
      add(cyl(r * 0.8, r * 0.95, len * 0.12, B.paint, yn + len * 0.12));
      add(lathe([[r * 0.8, yn + len * 0.18], [r * 0.55, yn + len * 0.3], [r * 0.12, L - len * 0.02], [0, L]], B.paint));
      add(strut(V3(0, L - len * 0.02, 0), V3(0, L + len * 0.06, 0), r * 0.03, B.steel));
      break;
    }
    case 'rdock': {
      // a side hatch with a short tunnel and a docking ring facing outward (+X)
      const tl = len * 0.6;
      const tun = cyl(r * 0.62, r * 0.7, tl, B.carbon); tun.rotation.z = -Math.PI / 2; tun.position.x = tl / 2 - 0.05; add(tun);
      const face = cyl(r * 0.58, r * 0.62, len * 0.2, B.alu); face.rotation.z = -Math.PI / 2; face.position.x = tl + len * 0.08; add(face);
      const rim = torus(r * 0.58, r * 0.03, B.dark); rim.rotation.set(0, 0, Math.PI / 2); rim.position.x = tl + len * 0.18; add(rim);
      for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU, pt = box(0.03, r * 0.5, r * 0.28, B.alu); pt.position.set(tl + len * 0.3, Math.cos(a) * r * 0.48, Math.sin(a) * r * 0.48); pt.rotation.x = -a; pt.rotateZ(0.0); add(pt); }
      add(box(0.06, r * 1.6, r * 1.6, B.carbon, -0.02, 0, 0));
      break;
    }
    case 'node': {
      const end = r * 0.35, mid = len - end * 2;
      add(cyl(r, r, mid, rep('ribbed', (TAU * r) / 0.5, mid / 1.1)));
      add(cyl(r * 0.62, r, end, B.carbon, L - end / 2)); add(cyl(r, r * 0.62, end, B.carbon, -L + end / 2));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU;
        const fg = new THREE.TorusGeometry(r * 0.5, r * 0.04, 8, 28); fg.rotateY(Math.PI / 2);
        add(onSurface(mesh(fg, B.alu), r + 0.01, a, 0));
        const cv = new THREE.CircleGeometry(r * 0.48, 28); cv.rotateY(Math.PI / 2);
        add(onSurface(mesh(cv, B.dish), r + 0.012, a, 0));
      }
      for (const y of [-mid / 2 + 0.06, mid / 2 - 0.06]) add(ring(r, 0.06, B.carbon, y, 1.004));
      break;
    }
    case 'lab': {
      const end = r * 0.3, mid = len - end * 2;
      add(cyl(r, r, mid, rep('ribbed', (TAU * r) / 0.55, mid / 1.2)));
      add(cyl(r * 0.6, r, end, B.carbon, L - end / 2)); add(cyl(r, r * 0.6, end, B.carbon, -L + end / 2));
      add(torus(r * 0.6, r * 0.04, B.alu, L - 0.02)); add(torus(r * 0.6, r * 0.04, B.alu, -L + 0.02));
      for (let i = 0; i < 4; i++) add(ring(r, 0.05, B.carbon, -mid / 2 + (mid * (i + 0.5)) / 4, 1.004));
      for (const a of [0.3, Math.PI + 0.3]) {
        const wg = new THREE.CylinderGeometry(r * 0.12, r * 0.12, 0.04, 24); wg.rotateZ(Math.PI / 2);
        add(onSurface(mesh(wg, B.glass), r + 0.01, a, mid * 0.2));
      }
      for (const a of [Math.PI / 2, -Math.PI / 2]) add(strut(polar(r + 0.1, a, -mid / 2 + 0.3), polar(r + 0.1, a, mid / 2 - 0.3), 0.025, B.alu));
      for (let i = 0; i < 3; i++) add(onSurface(box(0.12, mid * 0.18, r * 0.5, B.carbon), r + 0.06, Math.PI * 0.75 + i * 0.25, -mid * 0.25));
      break;
    }
    case 'cupola': {
      add(cyl(rTop * 1.15, r, len * 0.45, B.alu, -L + len * 0.225));
      const yw = -L + len * 0.45, hw = len * 0.35;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const fr = box(0.05, hw, rTop * 0.95, B.alu); onSurface(fr, rTop * 1.1, a, yw + hw / 2); fr.rotateZ(-0.35); add(fr);
        const gl = box(0.03, hw * 0.8, rTop * 0.75, B.glass); onSurface(gl, rTop * 1.13, a, yw + hw / 2); gl.rotateZ(-0.35); add(gl);
      }
      add(cyl(rTop * 0.95, rTop * 1.15, hw, B.carbon, yw + hw / 2));
      add(cyl(rTop * 0.9, rTop * 0.95, len * 0.2, B.alu, L - len * 0.1));
      const top = mesh(new THREE.CircleGeometry(rTop * 0.6, 28), B.glass); top.rotation.x = -Math.PI / 2; top.position.y = L + 0.002; add(top);
      break;
    }
    case 'sttruss': {
      const h = r * 0.95;
      const C = [[h, h], [-h, h], [-h, -h], [h, -h]];
      const bays = Math.max(2, Math.round(len / (h * 1.4)));
      C.forEach(([x, z], i) => {
        add(box(r * 0.08, len, r * 0.08, B.alu, x, 0, z));
        const [x2, z2] = C[(i + 1) % 4];
        for (let b = 0; b <= bays; b++) {
          const y = -L + (len * b) / bays;
          add(strut(V3(x, y, z), V3(x2, y, z2), r * 0.025, B.steel, 6));
          if (b < bays) add(strut(V3(x, y, z), V3(x2, -L + (len * (b + 1)) / bays, z2), r * 0.02, B.alu, 6));
        }
      });
      add(box(h * 0.9, len * 0.98, h * 0.5, B.carbon, 0, 0, 0));
      for (const z of [-h * 1.05, h * 1.05]) add(box(r * 0.12, len, r * 0.05, B.dark, h * 0.6, 0, z));
      add(box(h * 2.1, 0.12, h * 2.1, B.carbon, 0, L - 0.06, 0)); add(box(h * 2.1, 0.12, h * 2.1, B.carbon, 0, -L + 0.06, 0));
      break;
    }
    case 'radiator': {
      const segs = 4, gap = 0.05, sw = (def.panelLen - gap * (segs - 1)) / segs;
      for (let i = 0; i < segs; i++) {
        const x0 = 0.16 + i * (sw + gap);
        add(box(sw, len, 0.03, B.dish, x0 + sw / 2, 0, 0));
        for (let k = 0; k < 6; k++) add(box(sw, 0.012, 0.04, B.alu, x0 + sw / 2, -len / 2 + (len * (k + 0.5)) / 6, 0));
      }
      add(strut(V3(0, 0, 0), V3(0.16, 0, 0), 0.03, B.alu));
      const h = cyl(0.05, 0.05, len * 0.5, B.carbon); h.position.x = 0.03; add(h);
      break;
    }
    case 'rv': {
      // re-entry vehicle: slender cone in dark carbon-phenolic, blunted nose, a flare and a dark base
      const nr = r * 0.12, pts = [[r, -L], [r * 1.02, -L + len * 0.04]];
      for (let i = 1; i <= 16; i++) { const t = i / 16; pts.push([nr + (r - nr) * Math.pow(1 - t, 1.08), -L + len * 0.04 + (len * 0.94 - nr) * t]); }
      for (let i = 1; i <= 6; i++) { const a = (i / 6) * Math.PI / 2; pts.push([nr * Math.cos(a), L - len * 0.02 - nr + nr * Math.sin(a) + nr]); }
      add(lathe(pts, def.nuke ? rep('ablative', (TAU * r) / 0.5, len / 0.5) : B.carbon));
      add(ring(r, 0.03, B.alu, -L + len * 0.06, 1.02));
      add(cyl(r * 0.98, r * 0.98, 0.02, B.black, -L + 0.01));
      if (def.nuke) for (let i = 0; i < 2; i++) add(onSurface(box(0.01, len * 0.05, r * 0.3, B.paint), r * 0.84, i * Math.PI, -L + len * 0.18));
      if (def.warhead.kind === 'he' || def.warhead.kind === 'fae') {
        add(ring(r * 0.9, len * 0.05, def.warhead.kind === 'he' ? B.bronze : B.gold, -L + len * 0.22, 1.12));
      }
      break;
    }
    case 'bomb': {
      const body = len * 0.6, yb = -L + len * 0.25;
      add(cyl(r, r, body, B.paint, yb + body / 2));
      add(lathe([[r, yb + body], [r * 0.9, yb + body + len * 0.07], [r * 0.6, yb + body + len * 0.13], [0, L]], B.paint));
      add(cyl(r, r * 0.55, len * 0.25, B.paint, -L + len * 0.125));
      for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU, f = box(0.06, len * 0.22, r * 0.9, B.paint); add(onSurface(f, r * 0.9, a, -L + len * 0.11)); }
      for (let i = 0; i < 3; i++) add(ring(r, 0.04, B.dark, yb + body * (0.2 + i * 0.3), 1.004));
      add(onSurface(box(0.01, len * 0.12, r * 0.6, B.black), r * 1.002, Math.PI / 2, yb + body * 0.55));
      break;
    }
    case 'rod': {
      add(cyl(r, r, len * 0.9, B.steel, -len * 0.05));
      add(lathe([[r, L - len * 0.1], [r * 0.5, L - len * 0.03], [0, L]], B.dark));
      for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU, f = box(0.03, len * 0.12, r * 2.2, B.dark); add(onSurface(f, r + r * 1.0, a, -L + len * 0.07)); }
      break;
    }
    case 'bus': {
      add(cyl(r, r, len * 0.7, rep('gold', 4, 1), -len * 0.05));
      add(cyl(r, r, len * 0.12, B.carbon, L - len * 0.06)); add(cyl(r, r, len * 0.1, B.carbon, -L + len * 0.05));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        add(onSurface(box(0.12, 0.18, 0.18, B.dark), r + 0.05, a, 0));
        for (const dy of [-1, 1]) { const n = mesh(new THREE.ConeGeometry(0.03, 0.07, 10, 1, true), B.bronze); n.position.copy(polar(r + 0.12, a, dy * 0.1)); n.quaternion.setFromUnitVectors(V3(0, -1, 0), V3(0, dy, 0)); add(n); }
      }
      break;
    }
    default:
      add(cyl(rTop, r, len, B.paint));
  }
  return mergeByMaterial(g);
}

// ---------- shells that depend on the rocket around them ----------
// Interstage: an open composite shell from the decoupler's top face up round the engine standing on it.
export function interstageMesh(sp) {
  const B = base(), g = new THREE.Group();
  const add = (...o) => { g.add(...o); return o[0]; };
  const { h, r0, r1, y0 } = sp, rm = (r0 + r1) / 2;
  const outer = mesh(new THREE.CylinderGeometry(r1, r0, h, SEG, 1, true), rep('ribbed', (TAU * rm) / 0.7, h / 1.3)); outer.position.y = y0 + h / 2; add(outer);
  const inner = mesh(new THREE.CylinderGeometry(r1 * 0.985, r0 * 0.985, h, SEG, 1, true), B.phenolic); inner.position.y = y0 + h / 2; inner.geometry.scale(-1, 1, 1); add(inner);
  add(ring(r1, Math.min(0.08, h * 0.05), B.carbon, y0 + h - 0.03, 1.008));
  add(ring(r0, Math.min(0.06, h * 0.04), B.carbon, y0 + 0.03, 1.008));
  // vents and the separation-plane markings
  const n = Math.max(4, Math.round(rm * 6));
  for (let i = 0; i < n; i++) add(onSurface(box(0.02, Math.min(0.2, h * 0.12), Math.min(0.14, rm * 0.12), B.black), rm * 1.006, (i / n) * TAU, y0 + h * 0.82));
  for (const a of [0, Math.PI]) add(onSurface(box(0.025, h * 0.85, 0.06, B.carbon), rm + 0.012, a + Math.PI / 2, y0 + h / 2));
  return mergeByMaterial(g);
}
// Payload fairing: two clamshell halves (k = 0, 1) from a profile [[r, y], ...] in the base's frame.
// Each half is centred on the base so it can be placed with the base's transform.
export function fairingHalfMesh(prof, k, ghost) {
  const B = base(), g = new THREE.Group();
  const pts = prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y));
  const ph0 = k * Math.PI + 0.004, ph = Math.PI - 0.008;
  const R = Math.max(...prof.map((p) => p[0])), H = prof[prof.length - 1][1] - prof[0][1];
  const og = new THREE.LatheGeometry(pts, 36, ph0, ph);
  g.add(mesh(og, ghost || rep('paint', (Math.PI * R) / TILE, H / TILE)));
  if (!ghost) {
    const ig = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(Math.max(p.x - 0.03, 0.0004), p.y)), 36, ph0, ph);
    ig.scale(-1, 1, 1); ig.rotateY(Math.PI);
    const im = mesh(ig, B.phenolic); g.add(im);
    // seam rails along both edges of the half and the base band
    for (const a of [ph0, ph0 + ph]) {
      for (let i = 1; i < prof.length; i++) {
        const [ra, ya] = prof[i - 1], [rb, yb] = prof[i]; if (ra < 0.05) continue;
        const A = new THREE.Vector3(Math.sin(a) * ra, ya, Math.cos(a) * ra), Bv = new THREE.Vector3(Math.sin(a) * rb, yb, Math.cos(a) * rb);
        g.add(strut(A, Bv, Math.min(0.03, R * 0.02), B.carbon, 6));
      }
    }
    const band = mesh(new THREE.CylinderGeometry(prof[0][0] * 1.01, prof[0][0] * 1.01, 0.1, 36, 1, true, ph0, ph), B.carbon); band.position.y = prof[0][1] + 0.05; g.add(band);
  }
  return ghost ? g : mergeByMaterial(g);
}

// Lamp lenses, shared by every light part so the flight can switch them all at once (on, off, blinking).
let LM = null;
export function lightMats() {
  if (LM) return LM;
  const m = (r, g, b) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
  LM = { spot: m(2.2, 2.0, 1.7), red: m(2.4, 0.15, 0.1), green: m(0.15, 2.2, 0.5), strobe: m(2.2, 2.2, 2.4) };
  LM.base = Object.fromEntries(Object.entries(LM).map(([k, v]) => [k, v.color.clone()]));
  return LM;
}

// Collapse a part into one mesh per material (fewer draw calls when rockets get big).
export function mergeByMaterial(group) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  group.traverse((o) => {
    if (!o.isMesh) return;
    let geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (geo.index) geo = geo.toNonIndexed();
    const keep = new THREE.BufferGeometry();
    keep.setAttribute('position', geo.attributes.position); keep.setAttribute('normal', geo.attributes.normal);
    keep.setAttribute('uv', geo.attributes.uv || new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (o.material.vertexColors) keep.setAttribute('color', geo.attributes.color || new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
    if (!buckets.has(o.material)) buckets.set(o.material, []);
    buckets.get(o.material).push(keep);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    if (merged) { merged.computeBoundingSphere(); out.add(new THREE.Mesh(merged, mat)); }
  }
  return out;
}

const cache = new Map();
export function partMesh(def) {
  if (!cache.has(def.id)) cache.set(def.id, build(def));
  return cache.get(def.id).clone();
}

export const GHOST_OK = new THREE.MeshBasicMaterial({ color: 0xf3f1ec, transparent: true, opacity: 0.4, depthWrite: false });
export const GHOST_FREE = GHOST_OK;
export function setMaterial(obj, mat) { obj.traverse((o) => { if (o.isMesh) o.material = mat; }); }

// A soft studio environment for reflections (hangar and part pictures).
export function studioEnvironment(renderer) {
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  return tex;
}

// Render a small see-through picture of every part (own throwaway renderer). Returns { id: dataURL }.
export function renderThumbnails() {
  const size = 160;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(size, size, false); renderer.setClearColor(0x000000, 0);
  applyTone(renderer, 1.0);
  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer); scene.environmentIntensity = 0.75;
  const dl = new THREE.DirectionalLight(0xffffff, 2.2); dl.position.set(2, 3, 4); scene.add(dl);
  const cam = new THREE.PerspectiveCamera(22, 1, 0.01, 800);
  const out = {};
  for (const def of PART_LIST) {
    const m = partMesh(def);
    scene.add(m);
    const box3 = new THREE.Box3().setFromObject(m), c = box3.getCenter(V3()), s = box3.getSize(V3()).length();
    cam.position.set(c.x + s * 1.0, c.y + s * 0.45, c.z + s * 2.25); cam.lookAt(c);
    renderer.render(scene, cam);
    out[def.id] = renderer.domElement.toDataURL('image/png');
    scene.remove(m);
  }
  renderer.dispose(); renderer.forceContextLoss();
  return out;
}
