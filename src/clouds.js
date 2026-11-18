// Tileable 3D noise for the volumetric clouds, made once on the CPU (≈0.2 s):
//   R: "Perlin-Worley" billows — the big cauliflower shapes of cumulus
//   G: Worley fbm — the small wisps that erode the edges
// The sky shader samples it with hardware trilinear filtering, so a ray-march step costs two lookups.
import * as THREE from '../vendor/three.module.js';

let NOISE = null;

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function cloudNoise(S = 64) {
  if (NOISE) return NOISE;
  const rnd = rng(1234);
  const cells = (f) => { const p = new Float32Array(f * f * f * 3); for (let i = 0; i < p.length; i++) p[i] = rnd(); return p; };
  const lattice = (f) => { const p = new Float32Array(f * f * f); for (let i = 0; i < p.length; i++) p[i] = rnd(); return p; };
  const W = { 4: cells(4), 8: cells(8), 16: cells(16), 32: cells(32) }, W2 = { 8: cells(8), 16: cells(16), 32: cells(32) };
  const V = { 4: lattice(4), 8: lattice(8), 16: lattice(16) };
  const wrap = (i, f) => ((i % f) + f) % f;
  function worley(x, y, z, f, pts) {
    const X = x * f, Y = y * f, Z = z * f, ix = Math.floor(X), iy = Math.floor(Y), iz = Math.floor(Z);
    let md = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz, k = ((wrap(cz, f) * f + wrap(cy, f)) * f + wrap(cx, f)) * 3;
      const ddx = cx + pts[k] - X, ddy = cy + pts[k + 1] - Y, ddz = cz + pts[k + 2] - Z, d = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d < md) md = d;
    }
    return 1 - Math.min(1, Math.sqrt(md));
  }
  function value(x, y, z, f, lat) {
    const X = x * f, Y = y * f, Z = z * f, ix = Math.floor(X), iy = Math.floor(Y), iz = Math.floor(Z);
    let u = X - ix, v = Y - iy, w = Z - iz;
    u = u * u * u * (u * (u * 6 - 15) + 10); v = v * v * v * (v * (v * 6 - 15) + 10); w = w * w * w * (w * (w * 6 - 15) + 10);
    const g = (a, b, c) => lat[(wrap(c, f) * f + wrap(b, f)) * f + wrap(a, f)];
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(g(ix, iy, iz), g(ix + 1, iy, iz), u), l(g(ix, iy + 1, iz), g(ix + 1, iy + 1, iz), u), v),
      l(l(g(ix, iy, iz + 1), g(ix + 1, iy, iz + 1), u), l(g(ix, iy + 1, iz + 1), g(ix + 1, iy + 1, iz + 1), u), v), w);
  }
  const n = S * S * S, A = new Float32Array(n), B = new Float32Array(n);
  for (let k = 0; k < S; k++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = (i + 0.5) / S, y = (j + 0.5) / S, z = (k + 0.5) / S, o = (k * S + j) * S + i;
    const pf = (value(x, y, z, 4, V[4]) * 0.5 + value(x, y, z, 8, V[8]) * 0.25 + value(x, y, z, 16, V[16]) * 0.125) / 0.875;
    const wf = worley(x, y, z, 4, W[4]) * 0.625 + worley(x, y, z, 8, W[8]) * 0.25 + worley(x, y, z, 16, W[16]) * 0.125;
    A[o] = (pf - wf + 1) / (2 - wf);                               // Perlin remapped by Worley: billows
    B[o] = worley(x, y, z, 8, W2[8]) * 0.625 + worley(x, y, z, 16, W2[16]) * 0.25 + worley(x, y, z, 32, W[32]) * 0.125;
  }
  // normalise both to mean 0.5, spread ±0.5 at about 2σ
  const norm = (a) => { let m = 0, s = 0; for (const v of a) m += v; m /= a.length; for (const v of a) s += (v - m) ** 2; s = Math.sqrt(s / a.length); return (v) => Math.min(1, Math.max(0, 0.5 + (v - m) / (4 * s))); };
  const na = norm(A), nb = norm(B);
  const data = new Uint8Array(n * 4);
  for (let o = 0; o < n; o++) { data[o * 4] = na(A[o]) * 255; data[o * 4 + 1] = nb(B[o]) * 255; data[o * 4 + 3] = 255; }
  const t = new THREE.Data3DTexture(data, S, S, S);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.unpackAlignment = 1;   // mips: the ground's crown texture averages out with distance
  t.anisotropy = 16;                // sharp ground detail at shallow viewing angles
  t.needsUpdate = true;
  NOISE = t;
  return t;
}

// Tileable 2D ground detail (512², mipmapped, anisotropic — stays sharp at shallow viewing angles):
//   R: tree crowns — domes on a cellular pattern at three sizes, dark gaps between them
//   G: smooth fbm — soil, grass and water-surface undulation
//   B: small clumps — cellular at a finer size
let GROUND = null;
export function groundDetail(renderer) {
  if (GROUND) return GROUND;
  const S = 512, rnd = rng(77);
  const cells = (f) => { const p = new Float32Array(f * f * 2); for (let i = 0; i < p.length; i++) p[i] = rnd(); return p; };
  const lat = (f) => { const p = new Float32Array(f * f); for (let i = 0; i < p.length; i++) p[i] = rnd(); return p; };
  const wrap = (i, f) => ((i % f) + f) % f;
  function worley(x, y, f, pts) {
    const X = x * f, Y = y * f, ix = Math.floor(X), iy = Math.floor(Y);
    let m = 9;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, k = (wrap(cy, f) * f + wrap(cx, f)) * 2;
      const ddx = cx + pts[k] - X, ddy = cy + pts[k + 1] - Y, d = ddx * ddx + ddy * ddy;
      if (d < m) m = d;
    }
    return Math.sqrt(m);
  }
  function worleyId(x, y, f, pts) {
    const X = x * f, Y = y * f, ix = Math.floor(X), iy = Math.floor(Y);
    let m = 9, id = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, k = (wrap(cy, f) * f + wrap(cx, f)) * 2;
      const ddx = cx + pts[k] - X, ddy = cy + pts[k + 1] - Y, d = ddx * ddx + ddy * ddy;
      if (d < m) { m = d; id = (Math.sin(k * 12.9898 + 78.233) * 43758.5453) % 1; }
    }
    return Math.abs(id);
  }
  function value(x, y, f, L) {
    const X = x * f, Y = y * f, ix = Math.floor(X), iy = Math.floor(Y);
    let u = X - ix, v = Y - iy; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
    const g = (a, b) => L[wrap(b, f) * f + wrap(a, f)];
    return (g(ix, iy) * (1 - u) + g(ix + 1, iy) * u) * (1 - v) + (g(ix, iy + 1) * (1 - u) + g(ix + 1, iy + 1) * u) * v;
  }
  const W = [cells(8), cells(16), cells(32), cells(64)], V = [lat(8), lat(16), lat(32), lat(64), lat(128)];
  const dome = (d) => Math.sqrt(Math.max(0, 1 - Math.min(1, d * 1.15) ** 2));
  const data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = (i + 0.5) / S, y = (j + 0.5) / S, o = (j * S + i) * 4;
    const cr = dome(worley(x, y, 8, W[0])) * 0.45 + dome(worley(x, y, 16, W[1])) * 0.35 + dome(worley(x, y, 32, W[2])) * 0.2;
    let fb = 0, a = 0.5, n = 0; for (let k = 0; k < 5; k++) { fb += value(x, y, 8 << k, V[k]) * a; n += a; a *= 0.5; }
    data[o] = Math.min(255, cr * 255); data[o + 1] = (fb / n) * 255; data[o + 2] = dome(worley(x, y, 64, W[3])) * 255; data[o + 3] = worleyId(x, y, 16, W[1]) * 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 8; t.needsUpdate = true;
  GROUND = t;
  return t;
}
