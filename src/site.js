// The launch complex. Still a proving ground at heart (containers, a quonset shed, oil drums, a windsock,
// sandbags at the blockhouse), but the pad itself is the real thing: a concrete hardstand with painted
// markings, a steel launch mount, a flame channel, a lattice service tower whose arms swing away at liftoff,
// lightning masts, a propellant farm piped to the pad, and four floodlight masts that light the rocket after dark.
// One continuous ground mesh carries every surface (grass, worn grass, laterite roads, gravel, concrete,
// scorch, contact shadows) and fades into the planet shader at its edge, where the main road carries on.
// Frame: x = east, y = up, z = south; the rocket stands at the origin.
import * as THREE from '../vendor/three.module.js';
import { RoundedBoxGeometry } from '../vendor/jsm/geometries/RoundedBoxGeometry.js';
import { mergeByMaterial } from './meshes.js';

const GROUND_R = 1100, FADE0 = 560, FADE1 = 700, LAYOUT = 1000;
export const GRASS_LINEAR = [0.068, 0.088, 0.03];
// the main road leaves the pad towards the planet shader's laterite road (east, north) = (-1200, -500)
const ROAD = [-1200 / 1300, 500 / 1300];

function canvas(n, m = n) { const c = document.createElement('canvas'); c.width = n; c.height = m; return [c, c.getContext('2d', { willReadFrequently: true })]; }
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function tex(c, srgb, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
function blots(g, n, R, count, rmin, rmax, colorFn) {
  for (let i = 0; i < count; i++) {
    const x = R() * n, y = R() * n, s = rmin + R() * (rmax - rmin), col = colorFn(R);
    for (const ox of [-n, 0, n]) for (const oy of [-n, 0, n]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, s);
      gr.addColorStop(0, col); gr.addColorStop(1, col.replace(/[\d.]+\)$/, '0)'));
      g.fillStyle = gr; g.fillRect(x + ox - s, y + oy - s, s * 2, s * 2);
    }
  }
}
function normalFromHeight(c, strength) {
  const n = c.width, m = c.height, src = c.getContext('2d').getImageData(0, 0, n, m).data, out = new Uint8Array(n * m * 4);
  const h = (x, y) => src[(((y + m) % m) * n + ((x + n) % n)) * 4] / 255;
  for (let y = 0; y < m; y++) for (let x = 0; x < n; x++) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength, dy = (h(x, y + 1) - h(x, y - 1)) * strength, l = Math.hypot(dx, dy, 1), i = (y * n + x) * 4;
    out[i] = (-dx / l * 0.5 + 0.5) * 255; out[i + 1] = (-dy / l * 0.5 + 0.5) * 255; out[i + 2] = (1 / l * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  const t = new THREE.DataTexture(out, n, m); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

// ---------- surface textures ----------
let TEX = null;
function textures() {
  if (TEX) return TEX;
  const R = rng(4);
  // dry grass, ~5 m tile, mean mid-grey so it multiplies the base colour
  const [gc, g] = canvas(512);
  g.fillStyle = 'rgb(128,128,128)'; g.fillRect(0, 0, 512, 512);
  blots(g, 512, R, 140, 10, 60, (r) => { const v = 95 + r() * 70; return `rgba(${v},${v - 2},${v - 14},0.4)`; });
  for (let i = 0; i < 11000; i++) {
    const x = R() * 512, y = R() * 512, l = 3 + R() * 8, a = -Math.PI / 2 + (R() - 0.5) * 1.4, v = 90 + R() * 120;
    g.strokeStyle = `rgba(${v + 10},${v + 4},${v - 30},0.5)`; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  // dirt and gravel, 4 m tile: pebbles with little shadows, hairline cracks
  const [dc, d] = canvas(512), Q = rng(9);
  d.fillStyle = 'rgb(128,128,128)'; d.fillRect(0, 0, 512, 512);
  blots(d, 512, Q, 60, 20, 90, (r) => { const v = 100 + r() * 60; return `rgba(${v},${v},${v},0.3)`; });
  for (let i = 0; i < 2600; i++) {
    const x = Q() * 512, y = Q() * 512, s = 1 + Q() * 3.5, v = 70 + Q() * 140;
    d.fillStyle = 'rgba(40,36,30,0.35)'; d.beginPath(); d.ellipse(x + 0.9, y + 0.9, s, s * 0.7, 0, 0, 7); d.fill();
    d.fillStyle = `rgba(${v},${v - 4},${v - 10},0.85)`; d.beginPath(); d.ellipse(x, y, s, s * (0.6 + Q() * 0.4), Q() * 3, 0, 7); d.fill();
  }
  d.strokeStyle = 'rgba(55,50,44,0.45)'; d.lineWidth = 1;
  for (let i = 0; i < 26; i++) { let x = Q() * 512, y = Q() * 512; d.beginPath(); d.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (Q() - 0.5) * 40; y += (Q() - 0.5) * 40; d.lineTo(x, y); } d.stroke(); }
  // concrete surface, 6 m tile: speckle, stains, fine cracks (the slab joints are drawn by the shader)
  const [cc, c] = canvas(512), P = rng(12);
  c.fillStyle = 'rgb(132,132,132)'; c.fillRect(0, 0, 512, 512);
  blots(c, 512, P, 40, 20, 90, (r) => { const v = 100 + r() * 55; return `rgba(${v},${v},${v},0.28)`; });
  for (let i = 0; i < 26000; i++) { const v = 90 + P() * 90; c.fillStyle = `rgba(${v},${v},${v},0.5)`; c.fillRect(P() * 512, P() * 512, 1.2, 1.2); }
  c.strokeStyle = 'rgba(70,70,70,0.35)'; c.lineWidth = 1;
  for (let i = 0; i < 10; i++) { let x = P() * 512, y = P() * 512; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 5; k++) { x += (P() - 0.5) * 60; y += (P() - 0.5) * 60; c.lineTo(x, y); } c.stroke(); }
  // large-scale variation
  const [nc, nn] = canvas(256), N = rng(15);
  nn.fillStyle = 'rgb(128,128,128)'; nn.fillRect(0, 0, 256, 256);
  blots(nn, 256, N, 160, 8, 40, (r) => { const v = r() < 0.5 ? 40 : 220; return `rgba(${v},${v},${v},0.25)`; });
  // props: corrugated steel, weathered paint, burlap, planks, cast concrete, hazard stripes
  const [rc, rg] = canvas(64, 64);
  for (let x = 0; x < 64; x++) { const v = 128 + 120 * Math.sin((x / 64) * Math.PI * 2 * 4); rg.fillStyle = `rgb(${v},${v},${v})`; rg.fillRect(x, 0, 1, 64); }
  const [wc, w] = canvas(256), W = rng(21);
  w.fillStyle = '#ffffff'; w.fillRect(0, 0, 256, 256);
  blots(w, 256, W, 40, 6, 40, (r) => (r() < 0.6 ? 'rgba(150,110,80,0.25)' : 'rgba(120,120,110,0.2)'));
  for (let i = 0; i < 50; i++) { const x = W() * 256, y0 = W() * 200; const gr = w.createLinearGradient(0, y0, 0, y0 + 60 + W() * 80); gr.addColorStop(0, 'rgba(130,85,55,0.3)'); gr.addColorStop(1, 'rgba(130,85,55,0)'); w.fillStyle = gr; w.fillRect(x, y0, 1 + W() * 2.5, 140); }
  const [bc, b] = canvas(128), B = rng(31);
  b.fillStyle = '#c8b68e'; b.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 2) for (let x = 0; x < 128; x += 2) { const v = 150 + B() * 60; b.fillStyle = `rgba(${v},${v - 18},${v - 50},0.6)`; b.fillRect(x + ((y / 2) % 2), y, 1, 1); }
  blots(b, 128, B, 20, 6, 24, () => 'rgba(90,70,40,0.25)');
  const [pc, p] = canvas(256), PW = rng(41);
  for (let y = 0; y < 256; y += 32) {
    const v = 120 + PW() * 40; p.fillStyle = `rgb(${v + 20},${v - 5},${v - 40})`; p.fillRect(0, y, 256, 31); p.fillStyle = 'rgba(40,30,20,0.6)'; p.fillRect(0, y + 31, 256, 1);
    for (let k = 0; k < 40; k++) { p.fillStyle = `rgba(70,50,30,${0.15 + PW() * 0.2})`; p.fillRect(PW() * 256, y + PW() * 31, 20 + PW() * 60, 1); }
  }
  const [kc, k] = canvas(256), K = rng(51);
  k.fillStyle = '#bdb7aa'; k.fillRect(0, 0, 256, 256);
  blots(k, 256, K, 50, 10, 50, (r) => { const v = 140 + r() * 70; return `rgba(${v},${v - 4},${v - 10},0.35)`; });
  for (let i = 0; i < 9000; i++) { const v = 120 + K() * 100; k.fillStyle = `rgba(${v},${v},${v},0.4)`; k.fillRect(K() * 256, K() * 256, 1, 1); }
  for (let i = 0; i < 30; i++) { const x = K() * 256, y0 = K() * 256; const gr = k.createLinearGradient(0, y0, 0, y0 + 50); gr.addColorStop(0, 'rgba(70,65,55,0.35)'); gr.addColorStop(1, 'rgba(70,65,55,0)'); k.fillStyle = gr; k.fillRect(x, y0, 2 + K() * 3, 50); }
  k.fillStyle = 'rgba(80,76,70,0.5)'; k.fillRect(0, 0, 256, 2); k.fillRect(0, 128, 256, 1);        // form-work lines
  const [hc, hz] = canvas(128, 32);
  hz.fillStyle = '#d9a62a'; hz.fillRect(0, 0, 128, 32); hz.fillStyle = '#1d1d1d';
  for (let x = -32; x < 160; x += 32) { hz.beginPath(); hz.moveTo(x, 32); hz.lineTo(x + 16, 32); hz.lineTo(x + 32, 0); hz.lineTo(x + 16, 0); hz.fill(); }
  TEX = { grass: tex(gc, false), dirt: tex(dc, false), conc: tex(cc, false), noise: tex(nc, false),
    corrN: normalFromHeight(rc, 6), weather: tex(wc, true), burlap: tex(bc, true), planks: tex(pc, true), concrete: tex(kc, true), hazard: tex(hc, true) };
  return TEX;
}

// ---------- layout (1 km square) ----------
// tSurf: R = concrete, G = gravel, B = laterite (roads, bare earth), A = worn, thin grass
// tShade: R = darkening (contact shadows, old scorch)
function layoutTextures(L) {
  const N = 2048, S = N / LAYOUT, C = N / 2, X = (m) => C + m * S;
  const layer = () => { const [cv, x] = canvas(N); x.fillStyle = '#000'; x.fillRect(0, 0, N, N); x.fillStyle = x.strokeStyle = '#fff'; x.lineCap = x.lineJoin = 'round'; return [cv, x]; };
  const R = rng(77);
  const blob = (x, cx, cz, rx, rz, jag = 0.12, rot = 0) => {
    x.beginPath();
    const ph = R() * 9;
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * 6.283, k = 1 + jag * (Math.sin(a * 3 + ph) * 0.6 + Math.sin(a * 7 + ph * 2) * 0.4);
      const lx = Math.cos(a) * rx * k, lz = Math.sin(a) * rz * k, c = Math.cos(rot), s = Math.sin(rot);
      const px = X(cx + lx * c - lz * s), pz = X(cz + lx * s + lz * c); i ? x.lineTo(px, pz) : x.moveTo(px, pz);
    }
    x.closePath(); x.fill();
  };
  const line = (x, pts, w) => { x.lineWidth = w * S; x.beginPath(); pts.forEach(([a, b], k) => (k ? x.lineTo(X(a), X(b)) : x.moveTo(X(a), X(b)))); x.stroke(); };
  const rect = (x, cx, cz, w, d, rot = 0) => { x.save(); x.translate(X(cx), X(cz)); x.rotate(rot); x.fillRect((-w / 2) * S, (-d / 2) * S, w * S, d * S); x.restore(); };

  const roadEnd = [ROAD[0] * 720, ROAD[1] * 720];
  const roads = [
    [[0, 0], roadEnd],                                         // main road, joins the planet's laterite road
    [[-60, 25], [-95, -20], [-118, -62]],                      // to the workshop and container yard
    [[24, -24], [60, -38], [86, -44]],                         // to the propellant farm
    [[24, 24], [80, 70], [122, 102]],                          // to the blockhouse
    [[122, 102], [160, 86]],                                   // and the viewing stand
  ];
  // --- laterite: roads and their shoulders, bare earth at the yards ---
  const [lc, l] = layer();
  l.globalAlpha = 0.45; for (const r of roads) line(l, r, 13);
  l.globalAlpha = 1; for (const r of roads) line(l, r, 8);
  l.globalAlpha = 0.6; blob(l, -118, -66, 34, 26, 0.18); blob(l, 92, -40, 34, 30, 0.15);
  l.globalAlpha = 1;
  for (const [cx, cz, r] of [[-230, 150, 13], [190, -190, 9]]) blob(l, cx, cz, r * 2.2, r * 2.2, 0.25);   // old test craters
  // --- gravel: apron around the hardstand, yards, the farm and blockhouse pads ---
  const [gc, g] = layer();
  blob(g, 0, -6, 50, 54, 0.08);
  g.globalAlpha = 0.9; blob(g, -118, -66, 28, 21, 0.12, 0.3); blob(g, 92, -40, 27, 24, 0.1); blob(g, 128, 104, 17, 13, 0.1, 0.7);
  g.globalAlpha = 1;
  // --- concrete beyond the shader's hardstand: blockhouse and farm slabs, tank saddles ---
  const [cc, c] = layer();
  rect(c, 92, -46, 19, 19); rect(c, 104, -26, 20, 9);
  rect(c, 128, 104, 22, 15, 0.82);
  // --- worn grass: soft halo around everything people drive and walk on ---
  const [wc, w] = layer();
  w.filter = 'blur(14px)'; w.drawImage(lc, 0, 0); w.drawImage(gc, 0, 0); w.drawImage(cc, 0, 0);
  w.filter = 'blur(40px)'; w.globalAlpha = 0.7; blob(w, 0, 0, 95, 95, 0.2); w.globalAlpha = 1; w.filter = 'none';
  // --- shade: contact shadows under every prop, old scorch where the exhaust leaves the channel ---
  const [sc, s] = layer();
  s.fillStyle = '#000'; s.fillRect(0, 0, N, N);
  for (const p of L.props) {
    const pw = (p.w / 2 + 0.6) * S, pd = (p.d / 2 + 0.6) * S;
    s.save(); s.translate(X(p.x), X(p.z)); s.rotate(p.rot || 0); s.scale(1, pd / pw);
    const gr = s.createRadialGradient(0, 0, pw * 0.4, 0, 0, pw * 1.15);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    s.fillStyle = gr; s.fillRect(-pw * 1.2, -pw * 1.2, pw * 2.4, pw * 2.4);
    s.restore();
  }
  { const gx = X(0), gz = X(-L.S1 - 4), r = 34 * S, gr = s.createRadialGradient(gx, gz, 0, gx, gz, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); s.fillStyle = gr;
    s.save(); s.translate(gx, gz); s.scale(1, 1.4); s.translate(-gx, -gz); s.fillRect(gx - r, gz - r, 2 * r, 2 * r); s.restore();
    for (let i = 0; i < 40; i++) {
      const a = -Math.PI / 2 + (R() - 0.5) * 1.3, len = 12 + R() * 34, x0 = (R() - 0.5) * 2 * L.W1, z0 = -L.S1;
      const gl = s.createLinearGradient(X(x0), X(z0), X(x0 + Math.cos(a) * len), X(z0 + Math.sin(a) * len));
      gl.addColorStop(0, 'rgba(255,255,255,0.35)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
      s.strokeStyle = gl; s.lineWidth = (1 + R() * 3) * S; s.beginPath(); s.moveTo(X(x0), X(z0)); s.lineTo(X(x0 + Math.cos(a) * len), X(z0 + Math.sin(a) * len)); s.stroke();
    }
  }
  for (const [cx, cz, r] of [[-230, 150, 13], [190, -190, 9]]) {
    const gx = X(cx), gz = X(cz), pit = s.createRadialGradient(gx, gz, 0, gx, gz, r * S);
    pit.addColorStop(0, 'rgba(255,255,255,0.6)'); pit.addColorStop(1, 'rgba(255,255,255,0.15)'); s.fillStyle = pit; s.beginPath(); s.arc(gx, gz, r * S, 0, 7); s.fill();
  }
  // pack: channels from the red of each layer
  const px = (cv) => cv.getContext('2d').getImageData(0, 0, N, N).data;
  const dl = px(lc), dg = px(gc), dcn = px(cc), dw = px(wc), ds = px(sc);
  const surf = new Uint8Array(N * N * 4), shade = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N * 4; i += 4) { surf[i] = dcn[i]; surf[i + 1] = dg[i]; surf[i + 2] = dl[i]; surf[i + 3] = dw[i]; shade[i] = ds[i]; shade[i + 3] = 255; }
  const mk = (data) => { const t = new THREE.DataTexture(data, N, N); t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true; return t; };
  return { surf: mk(surf), shade: mk(shade) };
}

function groundGeometry(Rp) {
  const nr = 72, nt = 180, pos = [], idx = [];
  for (let i = 0; i <= nr; i++) {
    const r = GROUND_R * Math.pow(i / nr, 2.3);
    for (let j = 0; j <= nt; j++) { const a = (j / nt) * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r; pos.push(x, -(r * r) / (2 * Rp), z); }
  }
  for (let i = 0; i < nr; i++) for (let j = 0; j < nt; j++) { const a = i * (nt + 1) + j, b = a + nt + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

const f1 = (v) => v.toFixed(2);
function groundMaterial(L) {
  const T = textures(), lay = layoutTextures(L);
  // no specular: a rough field seen at a grazing angle must not mirror the bright sky
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, specularIntensity: 0, transparent: true, depthWrite: true });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { tSurf: { value: lay.surf }, tShade: { value: lay.shade }, tGrass: { value: T.grass }, tDirt: { value: T.dirt }, tConc: { value: T.conc }, tNoise: { value: T.noise } });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vSite;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSite = position.xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vSite; uniform sampler2D tSurf, tShade, tGrass, tDirt, tConc, tNoise;
      float sdRBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <map_fragment>', `
      float rr = length(vSite), dist = length(vViewPosition);
      vec2 luv = vSite / ${LAYOUT.toFixed(1)} + 0.5;
      bool inL = luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0;
      vec4 sf = inL ? texture2D(tSurf, luv) : vec4(0.0);
      float shd = inL ? texture2D(tShade, luv).r : 0.0;
      float n1 = texture2D(tNoise, vSite / 520.0).r, n2 = texture2D(tNoise, vSite / 73.0 + 0.37).r, n3 = texture2D(tNoise, vSite / 17.0 + 0.71).r;
      float near = 1.0 - smoothstep(50.0, 320.0, dist);
      // grass, worn grass
      vec3 grass = mix(vec3(${GRASS_LINEAR.join(', ')}), vec3(0.12, 0.118, 0.05), smoothstep(0.3, 0.7, n1)) * (0.8 + 0.4 * n2);
      vec3 gd = texture2D(tGrass, vSite / 5.0).rgb * 2.0, gd2 = texture2D(tGrass, vSite / 23.0 + 0.5).rgb * 2.0;
      grass *= mix(vec3(1.0), gd * gd2, near * 0.9);
      float nb = texture2D(tNoise, vSite / 151.0 + 0.13).r * 0.55 + n2 * 0.3 + texture2D(tNoise, vSite / 37.0 + 0.61).r * 0.15;
      grass = mix(grass, vec3(0.025, 0.045, 0.015) * (0.8 + 0.4 * n3), smoothstep(0.6, 0.66, nb) * smoothstep(110.0, 200.0, rr) * 0.85);
      vec3 worn = vec3(0.13, 0.115, 0.06) * (0.75 + 0.5 * n3) * mix(vec3(1.0), gd, near * 0.7);
      vec3 col = mix(grass, worn, sf.a * (0.55 + 0.45 * smoothstep(0.3, 0.6, n2)));
      // laterite and gravel
      vec3 dd = texture2D(tDirt, vSite / 4.0).rgb * 2.0, dd2 = texture2D(tDirt, vSite / 19.0 + 0.3).rgb * 2.0;
      vec3 det = mix(vec3(1.0), dd * mix(vec3(1.0), dd2, 0.5), 0.35 + 0.65 * near);
      vec3 lat = vec3(0.16, 0.095, 0.06) * (0.85 + 0.3 * n3) * det;
      vec3 grav = vec3(0.155, 0.14, 0.12) * (0.9 + 0.2 * n2) * det;
      col = mix(col, lat, sf.b);
      col = mix(col, grav, sf.g);
      // concrete: the hardstand and the flame channel floor are drawn here, sharp at any distance
      float s = -vSite.y;
      float hw = mix(${f1(L.W0)}, ${f1(L.W1)}, clamp((s - ${f1(L.S0)}) / ${f1(L.S1 - L.S0)}, 0.0, 1.0)) + 2.2;
      float dH = sdRBox(vSite + vec2(0.0, 2.0), vec2(34.0, 36.0), 9.0);
      float dCh = max(abs(vSite.x) - hw, max(${f1(L.S0)} - 1.0 - s, s - ${f1(L.S1)} - 1.5));
      float dC = min(dH, dCh), aaC = fwidth(dC) + 0.03;
      float conc = max(sf.r, 1.0 - smoothstep(-aaC, aaC, dC));
      vec2 sid = floor(vSite / 7.5), sj = abs(fract(vSite / 7.5) - 0.5) * 7.5;
      float jd = min(sj.x, sj.y), jw = fwidth(jd) * 1.5;
      float joint = (1.0 - smoothstep(0.03, 0.03 + jw, jd)) * step(dC, 0.0);
      vec3 cdt = texture2D(tConc, vSite / 6.0).rgb * 2.0;
      vec3 cc = vec3(0.215, 0.207, 0.192) * (0.88 + 0.2 * h21(sid)) * (0.85 + 0.3 * n2) * mix(vec3(1.0), cdt, 0.4 + 0.6 * near) * (1.0 - 0.5 * joint);
      // painted markings: a yellow ring around the mount, a white border inset from the edge, a centre line up the channel
      float aaM = fwidth(rr) + 0.02;
      float ring = 1.0 - smoothstep(0.17 - aaM, 0.17 + aaM, abs(rr - ${f1(L.RM)}));
      float dB = fwidth(dH) + 0.02, border = (1.0 - smoothstep(0.13 - dB, 0.13 + dB, abs(dH + 2.2))) * (1.0 - step(abs(vSite.x), hw + 1.0) * step(0.0, s));
      float dash = step(0.5, fract(s / 4.0)) * step(${f1(L.S0 + 2)}, s) * (1.0 - smoothstep(0.1 - aaM, 0.1 + aaM, abs(vSite.x)));
      float wearM = 0.55 + 0.45 * smoothstep(0.25, 0.65, n3);
      cc = mix(cc, vec3(0.55, 0.38, 0.06), ring * wearM * step(dH, 0.0));
      cc = mix(cc, vec3(0.45, 0.44, 0.42), clamp(border + dash, 0.0, 1.0) * wearM);
      // soot: heavy around the mount, along the channel floor, streaks fanning out
      float ang = atan(vSite.y, vSite.x);
      float streak = 0.6 + 0.4 * sin(ang * 23.0 + n2 * 6.0) * sin(ang * 9.0 + 1.3);
      float soot = exp(-max(rr - ${f1(L.R2)}, 0.0) / 7.0) * 0.8 * streak + step(${f1(L.S0)}, s) * step(abs(vSite.x), hw - 1.0) * (0.35 + 0.35 * n3) * smoothstep(${f1(L.S1 + 2)}, ${f1(L.S0)}, s);
      soot = max(soot, 1.0 - smoothstep(${f1(L.R1 - 0.3)}, ${f1(L.R1 + 0.3)}, rr));
      cc *= 1.0 - clamp(soot, 0.0, 0.92) * 0.85;
      col = mix(col, cc, conc);
      col *= 1.0 - shd * 0.85;
      diffuseColor.rgb = col;
      // only what people built (concrete, gravel, roads, worn ground, contact shadows) is drawn here; the grass
      // is the planet's own terrain, so there is one ground and nothing to clash where they meet
      float made = clamp(max(max(conc, sf.g), sf.b), 0.0, 1.0);
      diffuseColor.a = max(made, shd * 0.75) * (1.0 - smoothstep(${FADE0.toFixed(1)}, ${FADE1.toFixed(1)}, rr + (n1 - 0.5) * 520.0 + (n2 - 0.5) * 160.0));
      if (diffuseColor.a < 0.02) discard;`);
  };
  return m;
}

// ---------- props ----------
const V = (x, y, z) => new THREE.Vector3(x, y, z);
function strut(a, b, r, m, seg = 8, r2 = r) {
  const d = new THREE.Vector3().subVectors(b, a), L = d.length();
  const s = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, L, seg), m);
  s.position.copy(a).addScaledVector(d, 0.5); s.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
  return s;
}
function rbox(w, h, d, r, m) { return new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.01, h / 2.01, d / 2.01)), m); }
function flat(geo) { const g = geo.toNonIndexed(); g.computeVertexNormals(); return g; }
// square lattice column: legs, a ring of beams every bay and an X on every face; optional taper
function lattice(grp, { x = 0, z = 0, w, wt = w, h, bay = 3, leg = 0.16, br = 0.05, m, mb = m, ry = 0, from = 0 }) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; grp.add(g);
  const c = (k, y) => { const s = (w + (wt - w) * (y / h)) / 2, q = [[-1, -1], [1, -1], [1, 1], [-1, 1]][k % 4]; return V(q[0] * s, y, q[1] * s); };
  for (let k = 0; k < 4; k++) g.add(strut(c(k, from), c(k, h), leg, m, 6, leg * (0.4 + 0.6 * (wt / w))));
  const n = Math.max(1, Math.round((h - from) / bay)), dy = (h - from) / n;
  for (let i = 0; i <= n; i++) { const y = from + i * dy; for (let k = 0; k < 4; k++) g.add(strut(c(k, y), c(k + 1, y), br * 1.3, mb, 6)); }
  for (let i = 0; i < n; i++) {
    const y0 = from + i * dy, y1 = y0 + dy;
    for (let k = 0; k < 4; k++) { g.add(strut(c(k, y0), c(k + 1, y1), br, mb, 5)); g.add(strut(c(k + 1, y0), c(k, y1), br, mb, 5)); }
  }
  return g;
}
function catenary(a, b, sag, r, m, n = 24) {
  const pts = []; for (let i = 0; i <= n; i++) { const t = i / n; pts.push(new THREE.Vector3().lerpVectors(a, b, t).add(V(0, -sag * 4 * t * (1 - t), 0))); }
  return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 2, r, 5), m);
}
// A lamp face: a floodlight is a reflector, blinding when you look down its beam and dim from the side.
// The face has a bright centre and a darker rim, so up close it reads as a lamp, not a white rectangle.
// dirPow 0 = shines every way (obstruction beacons).
function lampMaterial(col, dirPow) {
  return new THREE.ShaderMaterial({
    uniforms: { uCol: { value: col }, uI: { value: 0 } },
    vertexShader: /* glsl */`varying vec3 vN, vV; varying vec2 vUv;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`uniform vec3 uCol; uniform float uI; varying vec3 vN, vV; varying vec2 vUv;
      void main() {
        float f = max(dot(normalize(vN), normalize(vV)), 0.0);
        float dirK = ${dirPow > 0 ? `0.04 + 0.96 * pow(f, ${dirPow.toFixed(1)})` : '1.0'};
        vec2 q = abs(vUv - 0.5) * 2.0; float face = ${dirPow > 0 ? '1.0 - smoothstep(0.55, 0.95, max(q.x, q.y))' : '1.0'};
        vec3 off = vec3(0.035, 0.036, 0.04);                   // dark glass when the lamp is off
        gl_FragColor = vec4(off + uCol * uI * dirK * (0.25 + 0.75 * face), 1.0);
      }`,
  });
}

function beamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 }, uCol: { value: new THREE.Color(1, 0.84, 0.62) } },
    vertexShader: /* glsl */`varying float vT, vZ; varying vec3 vN, vV;
      void main() { vT = uv.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    // brightest along the axis (seen face-on), gone at the silhouette and wherever the camera is close to the cone
    fragmentShader: /* glsl */`uniform float uI; uniform vec3 uCol; varying float vT, vZ; varying vec3 vN, vV;
      void main() { float e = abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(uCol * uI * pow(e, 4.0) * vT * vT * smoothstep(8.0, 45.0, vZ), 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
}

export function buildSite(planetR, rocket) {
  const T = textures();
  const RH = rocket.height, br = rocket.baseR, radiusAt = rocket.radiusAt || (() => br);
  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, ...o });
  const rep = (t, u, v) => { const c = t.clone(); c.repeat.set(u, v); c.needsUpdate = true; return c; };
  const M = {
    concrete: std({ map: T.concrete, roughness: 0.95 }),
    steel: std({ color: 0x8a8d90, roughness: 0.45, metalness: 0.75 }),
    galv: std({ color: 0xa8abad, roughness: 0.4, metalness: 0.85 }),
    clad: std({ color: 0xb9bcbd, normalMap: rep(T.corrN, 3, 1), roughness: 0.5, metalness: 0.7, map: T.weather }),
    dark: std({ color: 0x2c2d2e, roughness: 0.55, metalness: 0.5 }),
    mount: std({ color: 0x3a3b3c, roughness: 0.6, metalness: 0.55, map: T.weather }),
    orange: std({ color: 0xb4482a, roughness: 0.55, metalness: 0.35, map: T.weather }),
    white: std({ color: 0xe9e6df, roughness: 0.55, map: T.weather }),
    whiteDS: std({ color: 0xe9e6df, roughness: 0.6, side: THREE.DoubleSide }),
    grating: std({ color: 0x55585b, roughness: 0.55, metalness: 0.6 }),
    rail: std({ color: 0xd8a32a, roughness: 0.55 }),
    hazard: std({ map: rep(T.hazard, 24, 1), roughness: 0.6 }),
    rust: std({ color: 0x7a4a30, roughness: 0.85, metalness: 0.3, map: T.weather }),
    burlap: std({ map: T.burlap, roughness: 1 }),
    wood: std({ map: T.planks, roughness: 0.9 }),
    tyre: std({ color: 0x1a1a1a, roughness: 0.9 }),
    cable: std({ color: 0x1c1c1c, roughness: 0.7, metalness: 0.3 }),
    hose: std({ color: 0x202020, roughness: 0.75 }),
    glass: std({ color: 0x0f141a, roughness: 0.1, metalness: 0.7, emissive: new THREE.Color(0, 0, 0) }),
    sock: std({ color: 0xe0612a, roughness: 0.8, side: THREE.DoubleSide }),
    lamp: lampMaterial(new THREE.Color(1, 0.88, 0.7), 8),
    red: lampMaterial(new THREE.Color(1, 0.1, 0.04), 0),
    canvasGreen: std({ color: 0x3d5a3a, roughness: 0.9, side: THREE.DoubleSide }),
  };
  const box = (grp, w, h, d, m, x, y, z, ry = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.rotation.y = ry; grp.add(b); return b; };
  const props = [];
  const foot = (x, z, w, d, rot = 0) => props.push({ x, z, w, d, rot });
  const near = new THREE.Group(), far = new THREE.Group();

  // --- launch mount: an octagonal steel ring around the engines, hazard band, four hold-down clamps ---
  const R1 = br + 0.45, R2 = br + 3.2, MH = 1.05;
  {
    const ring = new THREE.Mesh(flat(new THREE.LatheGeometry([V(R1, 0, 0), V(R2, 0, 0), V(R2, MH, 0), V(R1, MH, 0), V(R1, 0, 0)].map((v) => new THREE.Vector2(v.x, v.y)), 8, Math.PI / 8)), M.mount);
    near.add(ring);
    const band = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(R2 + 0.012, MH - 0.32), new THREE.Vector2(R2 + 0.012, MH - 0.08)], 8, Math.PI / 8), M.hazard);
    near.add(band);
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; box(near, 0.5, MH + 0.02, 0.18, M.dark, Math.cos(a) * (R2 - 0.2), MH / 2, Math.sin(a) * (R2 - 0.2), -a + Math.PI / 2); }   // gussets
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a);
      const base = rbox(1.1, 0.7, 1.0, 0.08, M.dark); base.position.set(ca * (R1 + 0.7), MH + 0.35, sa * (R1 + 0.7)); base.rotation.y = -a; near.add(base);
      const arm = rbox(1.1, 0.22, 0.34, 0.05, M.steel); arm.position.set(ca * (R1 + 0.05), MH + 0.55, sa * (R1 + 0.05)); arm.rotation.y = -a; near.add(arm);
      box(near, 0.16, 0.5, 0.4, M.steel, ca * (br + 0.08), MH + 0.4, sa * (br + 0.08), -a);
    }
    foot(0, 0, R2 * 2, R2 * 2);
  }
  // --- flame channel: two cast-concrete walls leading the exhaust north ---
  const S0 = R2 + 0.6, S1 = 58, W0 = Math.max(2.4, br + 1.4), W1 = W0 + 7;
  for (const sg of [-1, 1]) {
    const a = W1 - W0, b = S1 - S0, Lw = Math.hypot(a, b), wH = 2.4;
    const nx = (sg * b) / Lw, nz = a / Lw, cx = sg * (W0 + W1) / 2 + nx * 0.8, cz = -(S0 + S1) / 2 + nz * 0.8;
    const wall = rbox(1.6, wH, Lw, 0.12, M.concrete); wall.position.set(cx, wH / 2, cz); wall.rotation.y = Math.atan2(sg * a, -b); far.add(wall);
    box(far, 0.5, 0.06, Lw - 0.4, M.rail, cx - nx * 0.55, wH + 0.02, cz - nz * 0.55, Math.atan2(sg * a, -b));
    foot(cx, cz, 2.2, Lw, -Math.atan2(sg * a, -b));
  }

  // --- service tower: orange lattice, grated decks, an elevator shaft, lightning rod and beacon ---
  const tw = 6, H = Math.max(18, Math.ceil((RH + 7) / 3) * 3), tx = -(R2 + 4 + tw / 2);
  const tower = new THREE.Group(); tower.position.set(tx, 0, 0); near.add(tower);
  lattice(tower, { w: tw, h: H, bay: 3, leg: 0.22, br: 0.07, m: M.orange });
  for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) box(tower, 1.1, 0.5, 1.1, M.concrete, (cx * tw) / 2, 0.25, (cz * tw) / 2);
  for (let y = 6; y <= H; y += 6) {
    box(tower, tw + 1.8, 0.14, tw + 1.8, M.grating, 0, y, 0);
    const e = (tw + 1.8) / 2;
    for (const [ax, az, bx, bz] of [[-e, -e, e, -e], [e, -e, e, e], [e, e, -e, e]]) {
      tower.add(strut(V(ax, y + 1.05, az), V(bx, y + 1.05, bz), 0.035, M.rail, 6));
      tower.add(strut(V(ax, y + 0.55, az), V(bx, y + 0.55, bz), 0.025, M.rail, 6));
    }
    for (const [px, pz] of [[-e, -e], [e, -e], [e, e], [-e, e]]) tower.add(strut(V(px, y, pz), V(px, y + 1.05, pz), 0.03, M.rail, 6));
  }
  { const ex = -tw / 2 - 1.5;
    box(tower, 2.6, H + 2, 2.6, M.clad, ex, (H + 2) / 2, 0);
    box(tower, 3.0, 0.2, 3.0, M.dark, ex, H + 2.1, 0);
    box(tower, tw + 1, 0.25, tw + 1, M.dark, 0, H + 0.13, 0);
    tower.add(strut(V(0, H, 0), V(0, H + 9, 0), 0.16, M.galv, 8, 0.04));
    const bcn = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), M.red); bcn.position.set(0, H + 9.2, 0); tower.add(bcn);
    for (const sx of [-1, 1]) { const b2 = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), M.red); b2.position.set(ex, H + 2.4, sx * 1.2); tower.add(b2); }
  }
  foot(tx - 0.8, 0, tw + 4, tw + 2);

  // --- swing arms: crew access arm with a white room, an umbilical arm with hoses. They swing away at liftoff ---
  const arms = [];
  const armTo = (y) => -tx - tw / 2 - radiusAt(y) - 0.2;           // tower face to the rocket skin
  const mkArm = (y, crew) => {
    const len = armTo(y), g = new THREE.Group();
    if (len < 0.8) return;
    const hz = crew ? 1.8 : 1.2;
    box(g, len, 0.16, hz * 2, M.grating, len / 2, 0, 0);
    for (const sz of [-hz, hz]) {
      g.add(strut(V(0, -0.1, sz), V(len, -0.1, sz), 0.07, M.orange, 6));
      g.add(strut(V(0, crew ? 2.2 : 1.1, sz), V(len, crew ? 2.2 : 1.1, sz), 0.06, M.orange, 6));
      const n = Math.max(2, Math.round(len / 1.6));
      for (let i = 0; i <= n; i++) { const x = (i / n) * len; g.add(strut(V(x, -0.1, sz), V(x, crew ? 2.2 : 1.1, sz), 0.04, M.orange, 5)); if (i < n) g.add(strut(V(x, -0.1, sz), V(x + len / n, crew ? 2.2 : 1.1, sz), 0.035, M.orange, 5)); }
    }
    if (crew) {
      box(g, len - 0.4, 0.08, hz * 2 + 0.3, M.white, len / 2, 2.35, 0);
      const wr = Math.min(2.4, len * 0.5);
      const room = rbox(wr, 2.7, hz * 2 + 0.6, 0.08, M.white); room.position.set(len - wr / 2, 1.25, 0); g.add(room);
      box(g, 0.05, 0.5, 0.9, M.glass, len - wr - 0.01, 1.7, 0);
    } else {
      for (const [sz, dy] of [[-0.5, 1.6], [0.45, 2.3]]) {
        const a = V(len - 0.2, -0.15, sz), b = V(len + 0.18, -dy, sz * 0.6);
        g.add(catenary(a, b, -0.35, 0.09, M.hose, 12));
        box(g, 0.35, 0.3, 0.3, M.dark, len + 0.12, -dy, sz * 0.6);
      }
    }
    const merged = mergeByMaterial(g);
    const pivot = new THREE.Group(); pivot.position.set(tx + tw / 2, y, -tw / 2 + 0.3); merged.position.z = tw / 2 - 0.3; pivot.add(merged);
    pivot.userData.speed = crew ? 0.9 : 1.4;
    arms.push(pivot);
  };
  mkArm(Math.min(H - 3, Math.max(4, RH * 0.84 - 1)), true);
  if (RH > 9) mkArm(Math.max(3, Math.round(RH * 0.42)), false);

  // --- lightning masts and the catenary wires between them ---
  const mastH = H + 14, masts = [[0, -48], [42, 26], [-42, 26]].map(([x, z]) => V(x, mastH, z));
  for (const m of masts) {
    box(far, 2.4, 0.6, 2.4, M.concrete, m.x, 0.3, m.z);
    lattice(far, { x: m.x, z: m.z, w: 1.4, wt: 0.5, h: mastH - 4, bay: 2.8, leg: 0.1, br: 0.035, m: M.galv, from: 0.6 });
    far.add(strut(V(m.x, mastH - 4, m.z), V(m.x, mastH + 2, m.z), 0.09, M.galv, 6, 0.03));
    const bc = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), M.red); bc.position.set(m.x, mastH - 3.6, m.z); far.add(bc);
    foot(m.x, m.z, 3, 3);
  }
  for (let i = 0; i < 3; i++) { const a = masts[i], b = masts[(i + 1) % 3]; far.add(catenary(a.clone().setY(mastH + 1.5), b.clone().setY(mastH + 1.5), 4, 0.03, M.cable)); }
  for (const m of masts) { const anchor = V(m.x * 1.7, 0.3, m.z * 1.7); far.add(catenary(V(m.x, mastH - 0.5, m.z), anchor, 0.6, 0.025, M.cable, 16)); box(far, 0.8, 0.5, 0.8, M.concrete, anchor.x, 0.25, anchor.z); }

  // --- floodlight masts: banks of lamps aimed at the rocket, real spotlights and soft beams after dark ---
  const lights = [], beams = [], aim = V(0, Math.min(RH * 0.5, 24), 0), FH = 26;
  const beamMat = beamMaterial();
  [[58, 52], [-62, 48], [-56, -58], [60, -54]].forEach(([x, z], i) => {
    box(far, 2.2, 0.5, 2.2, M.concrete, x, 0.25, z);
    lattice(far, { x, z, w: 1.6, wt: 0.8, h: FH, bay: 2.6, leg: 0.1, br: 0.035, m: M.galv, from: 0.5 });
    const head = new THREE.Group(); head.position.set(x, FH + 0.6, z); head.lookAt(aim.x, aim.y, aim.z); far.add(head);
    box(head, 4.2, 0.14, 0.14, M.dark, 0, -0.75, -0.2); box(head, 4.2, 0.14, 0.14, M.dark, 0, 0.75, -0.2);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
      const lx = -1.5 + c, ly = -0.38 + r * 0.76;
      const h = rbox(0.8, 0.62, 0.42, 0.06, M.dark); h.position.set(lx, ly, -0.05); head.add(h);
      box(head, 0.66, 0.5, 0.02, M.lamp, lx, ly, 0.17);
    }
    box(head, 4.6, 0.12, 1.4, M.grating, 0, -1.2, -0.4);
    head.updateMatrixWorld(true);
    const p = V(x, FH + 0.6, z), dist = p.distanceTo(aim);
    const sp = new THREE.SpotLight(0xffd9a8, 0, 0, THREE.MathUtils.clamp(Math.atan2(RH * 0.6 + 10, dist), 0.22, 0.55), 0.55, 2);
    sp.userData.p = p.clone(); sp.userData.I = dist * dist * 0.55;
    if (i === 0) { sp.castShadow = true; sp.shadow.mapSize.set(1024, 1024); sp.shadow.camera.near = 20; sp.shadow.camera.far = 220; sp.shadow.bias = -0.0006; sp.shadow.normalBias = 0.05; sp.shadow.autoUpdate = false; }
    lights.push(sp);
    const len = dist * 0.95, rad = Math.tan(sp.angle) * len * 0.45;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(rad, len, 32, 1, true), beamMat);
    const dir = new THREE.Vector3().subVectors(aim, p).normalize();
    cone.position.copy(p).addScaledVector(dir, len / 2); cone.quaternion.setFromUnitVectors(V(0, 1, 0), dir.clone().negate());
    cone.renderOrder = 10; cone.frustumCulled = false; beams.push(cone);
    foot(x, z, 3, 3);
  });

  // --- propellant farm: a LOX sphere on legs, two kerosene tanks on saddles, pipes to the pad ---
  { const x = 92, z = -46, r = 5.5, cy = 8.6;
    const sph = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 24), M.white); sph.position.set(x, cy, z); far.add(sph);
    const eq = new THREE.Mesh(new THREE.TorusGeometry(r + 0.05, 0.12, 8, 48), M.steel); eq.rotation.x = Math.PI / 2; eq.position.set(x, cy, z); far.add(eq);
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; far.add(strut(V(x + Math.cos(a) * (r + 0.05), cy, z + Math.sin(a) * (r + 0.05)), V(x + Math.cos(a) * (r + 0.6), 0, z + Math.sin(a) * (r + 0.6)), 0.2, M.steel, 8)); box(far, 0.9, 0.4, 0.9, M.concrete, x + Math.cos(a) * (r + 0.6), 0.2, z + Math.sin(a) * (r + 0.6)); }
    for (let y = 0.6; y < cy + r; y += 0.4) box(far, 0.5, 0.04, 0.04, M.galv, x - r - 0.9, y, z);
    far.add(strut(V(x - r - 1.15, 0, z + 0.25), V(x - r - 1.15, cy + r, z + 0.25), 0.03, M.galv, 6)); far.add(strut(V(x - r - 1.15, 0, z - 0.25), V(x - r - 1.15, cy + r, z - 0.25), 0.03, M.galv, 6));
    foot(x, z, 13, 13);
    for (const dz of [-2.4, 2.4]) {
      const t = new THREE.Mesh(new THREE.CapsuleGeometry(1.7, 12, 8, 24), M.white); t.rotation.z = Math.PI / 2; t.position.set(104, 2.6, -26 + dz); far.add(t);
      for (const dx of [-4.5, 0, 4.5]) box(far, 0.7, 1.4, 3.2, M.concrete, 104 + dx, 0.7, -26 + dz);
      foot(104, -26 + dz, 16, 3.6);
    }
    // pipe run on low supports: farm → hardstand → mount
    const run = [V(84, 0.8, -40), V(60, 0.8, -26), V(30, 0.8, -12), V(R2 + 3, 0.8, -3)];
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i], b = run[i + 1], d = b.clone().sub(a), Lr = d.length(), side = V(-d.z, 0, d.x).normalize();
      for (const [o, pr, m] of [[-0.35, 0.16, M.white], [0, 0.12, M.steel], [0.35, 0.16, M.white]]) far.add(strut(a.clone().addScaledVector(side, o), b.clone().addScaledVector(side, o), pr, m, 10));
      const n = Math.max(1, Math.round(Lr / 6));
      for (let k = 0; k <= n; k++) {
        const q = a.clone().lerp(b, k / n);
        for (const o of [-0.55, 0.55]) far.add(strut(q.clone().addScaledVector(side, o).setY(0), q.clone().addScaledVector(side, o).setY(0.68), 0.05, M.dark, 6));
        far.add(strut(q.clone().addScaledVector(side, -0.6).setY(0.6), q.clone().addScaledVector(side, 0.6).setY(0.6), 0.05, M.dark, 6));
      }
      foot((a.x + b.x) / 2, (a.z + b.z) / 2, 1.6, Lr, -Math.atan2(d.x, d.z));
    }
    far.add(strut(V(R2 + 3, 0.8, -3), V(R2 + 0.2, MH * 0.6, -1), 0.14, M.steel, 10));
    // the propellant bowser that tops it all up
    const g = new THREE.Group(); g.position.set(70, 0, -64); g.rotation.y = 0.6; far.add(g);
    const tank = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 5, 6, 20), M.white); tank.rotation.z = Math.PI / 2; tank.position.y = 2.1; g.add(tank);
    box(g, 7, 0.3, 1.6, M.dark, 0, 0.95, 0);
    for (const wx of [-2.2, -1.2]) for (const wz of [-0.95, 0.95]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.35, 16), M.tyre); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.5, wz); g.add(w); }
    g.add(strut(V(3.5, 0.95, 0), V(4.6, 0.6, 0), 0.06, M.dark));
    box(g, 0.4, 0.12, 2.3, M.rail, 0, 3.25, 0);
    foot(70, -64, 8, 3, -0.6);
  }

  // --- blockhouse: concrete, slit windows facing the pad (lit at night), sandbagged front, mast and beacon ---
  const bagG = new RoundedBoxGeometry(0.9, 0.32, 0.5, 2, 0.14), jitter = rng(5);
  const bags = (grp, cx, cz, rad, a0, a1, rows) => {
    for (let row = 0; row < rows; row++) {
      const n = Math.max(1, Math.floor(((a1 - a0) * rad) / 0.86));
      for (let i = 0; i < n; i++) {
        const a = a0 + ((i + (row % 2) * 0.5) / n) * (a1 - a0), r = rad - row * 0.06;
        const b = new THREE.Mesh(bagG, M.burlap); b.position.set(cx + Math.cos(a) * r, 0.16 + row * 0.29, cz + Math.sin(a) * r);
        b.rotation.y = -a + Math.PI / 2 + (jitter() - 0.5) * 0.14; b.rotation.z = (jitter() - 0.5) * 0.07; grp.add(b);
      }
    }
  };
  { const bx = 128, bz = 104, ry = Math.atan2(bx, bz);
    const g = new THREE.Group(); g.position.set(bx, 0, bz); g.rotation.y = ry; far.add(g);
    const body = rbox(15, 4.2, 9, 0.3, M.concrete); body.position.y = 2.1; g.add(body);
    const roof = rbox(16, 0.6, 10, 0.2, M.concrete); roof.position.y = 4.5; g.add(roof);
    for (const x of [-4.5, -1.5, 1.5, 4.5]) box(g, 2.2, 0.4, 0.1, M.glass, x, 3.1, -4.52);
    box(g, 1.3, 2.3, 0.12, M.rust, 5.6, 1.15, 4.52);
    bags(g, 0, 26, 31, Math.PI * 1.5 - 0.2, Math.PI * 1.5 + 0.2, 3);
    g.add(strut(V(-6, 4.8, 3), V(-6, 13, 3), 0.06, M.galv));
    const bl = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), M.red); bl.position.set(-6, 13.1, 3); g.add(bl);
    box(g, 2.2, 0.9, 1.4, M.galv, 4.5, 5.25, 1.5);
    foot(bx, bz, 16, 14, -ry);
  }

  // --- workshop yard: shipping containers, drums, a cable spool, the quonset shed ---
  const cGeo = new THREE.BoxGeometry(12.2, 2.6, 2.44);
  const containerMat = (hex) => std({ color: hex, map: T.weather, normalMap: rep(T.corrN, 20, 1), normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.7, metalness: 0.35 });
  const cm = [containerMat(0x3f6d8e), containerMat(0x9c4632), containerMat(0x6c7449), containerMat(0xd8d2c6)];
  const container = (x, y, z, ry, m) => {
    const c = new THREE.Mesh(cGeo, m); c.position.set(x, y + 1.3, z); c.rotation.y = ry; far.add(c);
    box(far, 0.06, 2.4, 2.3, M.dark, x + Math.cos(ry) * 6.12, y + 1.3, z - Math.sin(ry) * 6.12, ry);
    if (y === 0) foot(x, z, 12.2, 2.44, -ry);
  };
  container(-104, 0, -50, 0.3, cm[0]); container(-103, 0, -46.6, 0.3, cm[1]); container(-103.5, 2.6, -48.3, 0.3, cm[2]);
  container(-128, 0, -46, 1.6, cm[3]); container(-112, 0, -82, 0.45, cm[1]);
  const drumG = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 16);
  const drumM = [std({ color: 0x2f5a8a, roughness: 0.5, metalness: 0.4, map: T.weather }), std({ color: 0x8c2f22, roughness: 0.5, metalness: 0.4, map: T.weather }), std({ color: 0xb08a2a, roughness: 0.5, metalness: 0.4, map: T.weather })];
  for (let i = 0; i < 9; i++) { const d = new THREE.Mesh(drumG, drumM[i % 3]); d.position.set(-96 + (i % 3) * 0.65, 0.45, -60 + Math.floor(i / 3) * 0.65); far.add(d); }
  foot(-95.3, -59.4, 2.4, 2.4);
  for (let i = 0; i < 3; i++) box(far, 1.2, 0.14, 1.0, M.wood, -92 + i * 0.1, 0.07 + i * 0.15, -66);
  foot(-92, -66, 1.4, 1.2);
  { const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.1, 20), M.wood); sp.rotation.x = Math.PI / 2; sp.position.set(-98, 0.9, -72); far.add(sp); foot(-98, -72, 2, 1.2); }
  { const g = new THREE.Group(); g.position.set(-140, 0, -80); g.rotation.y = 0.3; far.add(g);
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 24, 28, 1, true, -Math.PI / 2, Math.PI),
      std({ color: 0xb3b5b5, normalMap: rep(T.corrN, 30, 1), roughness: 0.55, metalness: 0.7, side: THREE.DoubleSide, map: T.weather }));
    shell.rotation.x = -Math.PI / 2; g.add(shell);
    const back = new THREE.Mesh(new THREE.CircleGeometry(6, 28, 0, Math.PI), M.whiteDS); back.position.z = -12; g.add(back);
    const front = new THREE.Mesh(new THREE.RingGeometry(3.2, 6, 28, 1, 0, Math.PI), M.whiteDS); front.position.z = 12; g.add(front);
    foot(-140, -80, 13, 25, -0.3);
  }

  // --- windsock ---
  { const x = -48, z = 66, sockY = 6.75;
    far.add(strut(V(x, 0, z), V(x, 7.2, z), 0.06, M.galv));
    for (let i = 0; i < 5; i++) {
      const r0 = 0.36 - i * 0.034, r1 = 0.36 - (i + 1) * 0.034, s = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, 0.48, 16, 1, true), i % 2 ? M.whiteDS : M.sock);
      s.rotation.z = Math.PI / 2 - 0.2; s.position.set(x + 0.28 + i * 0.47, sockY + 0.2 - i * 0.1, z); far.add(s);
    }
    foot(x, z, 0.6, 0.6);
  }
  // --- viewing stand with a canopy ---
  { const x = 162, z = 86, s = 3;
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) far.add(strut(V(x + (dx * s) / 2, 0, z + (dz * s) / 2), V(x + (dx * s) / 2, 6, z + (dz * s) / 2), 0.05, M.galv));
    box(far, s + 0.4, 0.1, s + 0.4, M.wood, x, 4, z); box(far, s + 1, 0.06, s + 1, M.canvasGreen, x, 6.05, z);
    for (let y = 0.3; y < 4; y += 0.3) box(far, 0.5, 0.03, 0.03, M.galv, x - s / 2 - 0.25, y, z);
    foot(x, z, s + 1, s + 1);
  }

  const L = { R1, R2, RM: R2 + 2.4, S0, S1, W0, W1, props };
  const site = new THREE.Group();
  const ground = new THREE.Mesh(groundGeometry(planetR), groundMaterial(L));
  ground.receiveShadow = true; ground.renderOrder = -5;
  site.add(ground);
  for (const grp of [near, far]) {
    const merged = mergeByMaterial(grp);
    merged.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    site.add(merged);
  }
  for (const a of arms) { a.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); site.add(a); }
  site.userData.lights = lights;        // the flight adds these to the scene itself, so hiding the site never changes the light count
  for (const b of beams) site.add(b);

  // per frame: arms swing clear once the rocket lifts off; lamps, windows and beacons follow the night
  let armA = 0;
  site.userData.update = (dt, { launched, night, time }) => {
    armA = launched ? Math.min(1.6, armA + dt * 0.9) : 0;
    for (const a of arms) a.rotation.y = Math.min(1.35, armA * a.userData.speed);
    const on = site.visible ? THREE.MathUtils.smoothstep(night, 0.05, 0.6) : 0;
    site.updateMatrixWorld();
    for (const sp of lights) { sp.position.copy(sp.userData.p).applyMatrix4(site.matrixWorld); sp.target.position.copy(aim).applyMatrix4(site.matrixWorld); sp.target.updateMatrixWorld(); }
    M.lamp.uniforms.uI.value = 60 * on;
    M.glass.emissive.setRGB(1.6 * on, 1.1 * on, 0.55 * on);
    const blink = 0.5 + 0.5 * Math.cos(time * Math.PI * 2 * 0.75);
    M.red.uniforms.uI.value = (0.3 + 1.5 * blink * blink) * (1 + 9 * on);
    beamMat.uniforms.uI.value = 0.05 * on;
    for (const b of beams) b.visible = on > 0.01;
    for (const sp of lights) {
      sp.intensity = sp.userData.I * on;
      if (sp.castShadow) { sp.shadow.autoUpdate = on > 0.01; sp.shadow.needsUpdate = on > 0.01; }
    }
  };
  return site;
}
