// Baked smoke puffs with 6-way lighting.
// Each puff is a real little volume: a cauliflower of nested spheres (a few cores, lobes on them, smaller lobes on
// those, and so on down to a couple of voxels), so its outline and its shading are those of actual billows. At
// start-up it is ray-marched once from the front, and for every pixel we store how much light it sends to the camera
// when lit from each of six directions (±x, ±y, ±z in the sprite's own frame), with the light's own path through the
// puff taken into account. A sprite then mixes the six by where the sun, the sky and the flame are: proper lit
// flanks, shadowed creases and bright rims when back-lit, from any angle, at the cost of two texture reads.
// Output: two RGBA atlases of 2×2 puffs. A = light from (+x, −x, +y) and alpha, B = light from (−y, +z, −z);
// +z faces the camera. Light values are stored as √ (more precision in the shadows) and un-premultiplied.
import * as THREE from '../vendor/three.module.js';

export function bakePuffs(N = 160) {
  const W = N * 2, A = new Uint8Array(W * W * 4), B = new Uint8Array(W * W * 4);
  const V = N * N * N, rho = new Float32Array(V), px = new Float32Array(V), py = new Float32Array(V);
  let s = 23; const R = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const dir = () => { let x, y, z, l; do { x = R() * 2 - 1; y = R() * 2 - 1; z = R() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 0.01); l = Math.sqrt(l); return [x / l, y / l, z / l]; };
  const SIG = 80, SIGL = 40, dx = 1 / N;   // extinction per sprite width: the body is opaque, the lobes' rims are not
  for (let v = 0; v < 4; v++) {
    // ---- shape: spheres in sprite units (the quad spans −0.5…0.5) ----
    const cores = [];
    for (let i = 0; i < 2; i++) cores.push([(R() - 0.5) * 0.1, (R() - 0.5) * 0.06 - 0.05, (R() - 0.5) * 0.1, 0.15 + R() * 0.04]);
    // no big ball in the middle: a cluster of lobes, each sitting well out of its parent, favouring the top and the
    // sides (a puff boils up and out, its belly is smoother); each generation about 2× smaller and 3–4× as many
    const grow = (par, n, r0, r1) => {
      const out = [];
      for (let k = 0; k < n; k++) {
        const p = par[Math.floor(R() * par.length)], d = dir(); d[1] = d[1] * 0.8 + 0.15;
        const l = Math.hypot(d[0], d[1], d[2]), r = r0 + R() * (r1 - r0), t = p[3] * 0.9 - r * 0.1;
        let c = [p[0] + d[0] / l * t, p[1] + d[1] / l * t, p[2] + d[2] / l * t];
        const m = Math.hypot(c[0], c[1], c[2]) + r; if (m > 0.48) c = c.map((q) => q * (0.48 - r) / (m - r));   // stay inside the sprite
        out.push([c[0], c[1], c[2], r]);
      }
      return out;
    };
    const L1 = grow(cores, 10, 0.1, 0.16), L2 = grow(L1, 40, 0.045, 0.075), L3 = grow(L2, 130, 0.02, 0.033);
    // union of the lobes (sharp creases between them, as in real billows); the lookup point is warped a little so
    // no lobe is a perfect ball
    rho.fill(0);
    const ph = [R() * 6, R() * 6, R() * 6];
    for (const [cx, cy, cz, r] of [...cores, ...L1, ...L2, ...L3]) {
      const rr = r + 0.015, lo = (q) => Math.max(0, Math.floor((q - rr + 0.5) * N)), hi = (q) => Math.min(N - 1, Math.ceil((q + rr + 0.5) * N));
      for (let z = lo(cz); z <= hi(cz); z++) for (let y = lo(cy); y <= hi(cy); y++) for (let x = lo(cx); x <= hi(cx); x++) {
        const X = (x + 0.5) / N - 0.5, Y = (y + 0.5) / N - 0.5, Z = (z + 0.5) / N - 0.5;
        const qx = X + 0.01 * Math.sin(Y * 31 + ph[0]) - cx, qy = Y + 0.01 * Math.sin(Z * 29 + ph[1]) - cy, qz = Z + 0.01 * Math.sin(X * 27 + ph[2]) - cz;
        const f = 1 - Math.sqrt(qx * qx + qy * qy + qz * qz) / r, i = (z * N + y) * N + x;
        if (f > rho[i]) rho[i] = f;
      }
    }
    // a solid inside with a soft skin: crisp at a distance, a fluffy translucent rim close up
    for (let i = 0; i < V; i++) { const f = rho[i]; rho[i] = f <= 0 ? 0 : f >= 0.3 ? 1 : (f / 0.3) * (f / 0.3) * (3 - 2 * f / 0.3); }
    // ---- prefix sums along x and y: optical depth to the puff's sides, for the light ----
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) { let a = 0; const b = (z * N + y) * N; for (let x = 0; x < N; x++) { px[b + x] = a; a += rho[b + x]; } }
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) { let a = 0; for (let y = 0; y < N; y++) { const i = (z * N + y) * N + x; py[i] = a; a += rho[i]; } }
    // ---- march every pixel from the camera (+z) into the puff ----
    const ox = (v % 2) * N, oy = (v >> 1) * N;
    // light scattered many times inside goes deeper than one bounce says: a softer second term keeps shadows from going black
    const T = (od) => 0.72 * Math.exp(-SIGL * dx * od) + 0.28 * Math.exp(-SIGL * 0.2 * dx * od);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let tot = 0; for (let z = 0; z < N; z++) tot += rho[(z * N + y) * N + x];
      const o = ((oy + y) * W + ox + x) * 4;
      if (tot === 0) { A[o] = A[o + 1] = A[o + 2] = A[o + 3] = 0; B[o] = B[o + 1] = B[o + 2] = 0; B[o + 3] = 255; continue; }
      const rowY = (z) => z * N + y;
      let Tv = 1, front = 0, c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0;
      for (let z = N - 1; z >= 0 && Tv > 0.002; z--) {
        const i = (z * N + y) * N + x, r = rho[i];
        if (r > 0) {
          const h = r * 0.5, rx = px[(rowY(z)) * N + N - 1] + rho[(rowY(z)) * N + N - 1];   // the whole row
          const ry = py[(z * N + N - 1) * N + x] + rho[(z * N + N - 1) * N + x];               // the whole column
          const a = 1 - Math.exp(-SIG * dx * r), w = Tv * a;
          c0 += w * T(rx - px[i] - r + h); c1 += w * T(px[i] + h);
          c2 += w * T(ry - py[i] - r + h); c3 += w * T(py[i] + h);
          c4 += w * T(front + h); c5 += w * T(tot - front - r + h);
          Tv *= 1 - a;
        }
        front += r;
      }
      const al = 1 - Tv, k = 1 / Math.max(al, 1e-3), e = (q) => Math.round(255 * Math.sqrt(Math.min(1, q * k)));
      A[o] = e(c0); A[o + 1] = e(c1); A[o + 2] = e(c2); A[o + 3] = Math.round(255 * al);
      B[o] = e(c3); B[o + 1] = e(c4); B[o + 2] = e(c5); B[o + 3] = 255;
    }
  }
  // empty texels take their neighbours' light, a few texels deep, so filtering and mipmaps never pull a dark fringe in
  for (let pass = 0; pass < 6; pass++) {
    const src = [A.slice(), B.slice()];
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4; if (src[0][o + 3] > 0 || src[0][o] > 0) continue;
      let n = 0; const acc = [0, 0, 0, 0, 0, 0];
      for (const [qx, qy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (qx < 0 || qy < 0 || qx >= W || qy >= W || (qx / N | 0) !== (x / N | 0) || (qy / N | 0) !== (y / N | 0)) continue;
        const q = (qy * W + qx) * 4; if (src[0][q + 3] === 0 && src[0][q] === 0) continue;
        n++; acc[0] += src[0][q]; acc[1] += src[0][q + 1]; acc[2] += src[0][q + 2]; acc[3] += src[1][q]; acc[4] += src[1][q + 1]; acc[5] += src[1][q + 2];
      }
      if (n) { A[o] = acc[0] / n; A[o + 1] = acc[1] / n; A[o + 2] = acc[2] / n; B[o] = acc[3] / n; B[o + 1] = acc[4] / n; B[o + 2] = acc[5] / n; }
    }
  }
  const tex = (d) => { const t = new THREE.DataTexture(d, W, W); t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true; return t; };
  return { A: tex(A), B: tex(B) };
}
