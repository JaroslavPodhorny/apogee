// Terrain: real relief for the whole planet, from the launch pad to orbit.
//
// · Heights come from one function, written twice: GLSL for the GPU and JS for the physics, so a rocket
//   lands exactly on the ground it is drawn on. It places mountains where the relief map says the real
//   ranges are (Himalaya, Alps, Andes, Rockies…), plateaus between them, rolling hills inland, and
//   fractal coastlines with beaches, then shapes everything with ridged noise down to tens of metres.
// · Geometry is a quadtree on a cube-sphere (CDLOD): patches of 32×32 quads chosen by distance, with
//   vertices sliding ("morphing") into the coarser grid before a patch hands over to its parent, so there
//   is no popping and no cracks. Heights and normals are baked once per patch into a texture atlas on
//   the GPU; a frame only bakes the few patches that just came into view.
// · Vertices are built relative to the camera from small numbers only, so there is no float jitter even
//   on the real-size planet.
// · The patches are rendered into a small G-buffer (distance, height, normal) that the sky shader reads:
//   ground shading, haze and clouds stay in one place and match from orbit to the surface.
import * as THREE from '../vendor/three.module.js';

export const LON0 = (-52.77 * Math.PI) / 180;
const N = 32, TS = N + 1;                 // quads per patch side, texels per baked tile
const ATW = 64, ATH = 48;                 // atlas tiles across / down
const LW = 4096, LH = 2048;               // coastline map
const CW = 512, CH = 256;                 // control map (mountains, roughness, inland, plateau)
const MAXN = 3000;                        // patches drawn per frame, at most
const K = 6;                              // a patch is split when the camera is closer than K × its size / 2

// ---------------------------------------------------------------- the height function, GLSL
export const NOISE_GLSL = /* glsl */`
float thash(ivec3 p) {
  uvec3 q = uvec3(p) * uvec3(1597334677u, 3812015801u, 2798796415u);
  uint h = q.x ^ q.y ^ q.z; h = (h ^ (h >> 16)) * 2246822519u; h ^= h >> 13; h *= 3266489917u; h ^= h >> 16;
  return float(h) * (1.0 / 4294967295.0);
}
float tnoise(vec3 x) {
  vec3 fl = floor(x); ivec3 i = ivec3(fl); vec3 f = x - fl; f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec3 j = i + 1;
  return mix(mix(mix(thash(i), thash(ivec3(j.x, i.y, i.z)), f.x), mix(thash(ivec3(i.x, j.y, i.z)), thash(ivec3(j.x, j.y, i.z)), f.x), f.y),
             mix(mix(thash(ivec3(i.x, i.y, j.z)), thash(ivec3(j.x, i.y, j.z)), f.x), mix(thash(ivec3(i.x, j.y, j.z)), thash(j), f.x), f.y), f.z);
}
const mat3 TROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float tfbm(vec3 p, int oct) { float a = 0.5, s = 0.0, n = 0.0; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * tnoise(p); n += a; p = TROT * p * 2.03 + 1.7; a *= 0.5; } return s / n; }
float tridge(vec3 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0, w = 1.0;
  for (int i = 0; i < 7; i++) { if (i >= oct) break; float v = 1.0 - abs(2.0 * tnoise(p) - 1.0); v *= v; s += a * v * w; n += a; w = clamp(v * 1.6, 0.0, 1.0); p = TROT * p * 2.03 + 1.7; a *= 0.5; }
  return s / n;
}
// valley networks: distance (in noise units) from the floor of a big valley (with a river) and a small one
float valleyBig(vec3 p) { return abs(tfbm(p * (1.0 / 7000.0) + 31.0, 2) - 0.5); }
float valleySmall(vec3 p) { return abs(tfbm(p * (1.0 / 2300.0) + 47.0, 2) - 0.5); }
`;
export const TERRAIN_CORE = /* glsl */`
uniform sampler2D tLand, tCtl;
uniform float uTR, uTA, uTLon0;
uniform vec3 uTSite;
vec2 tLonlat(vec3 n) { float lon = atan(-n.z, n.x) + uTLon0; return vec2(lon / 6.28318531 + 0.5, asin(clamp(n.y, -1.0, 1.0)) / 3.14159265 + 0.5); }
// smooth-weighted bilinear lookups, done by hand so the GPU and the CPU get the same numbers
vec2 landAt(vec2 uv) {
  vec2 x = uv * vec2(${LW}.0, ${LH}.0) - 0.5, fl = floor(x), f = x - fl; f = f * f * (3.0 - 2.0 * f);
  ivec2 i = ivec2(fl); int x0 = ((i.x % ${LW}) + ${LW}) % ${LW}, x1 = (x0 + 1) % ${LW}, y0 = clamp(i.y, 0, ${LH - 1}), y1 = clamp(i.y + 1, 0, ${LH - 1});
  return mix(mix(texelFetch(tLand, ivec2(x0, y0), 0).rg, texelFetch(tLand, ivec2(x1, y0), 0).rg, f.x), mix(texelFetch(tLand, ivec2(x0, y1), 0).rg, texelFetch(tLand, ivec2(x1, y1), 0).rg, f.x), f.y);
}
vec4 ctlAt(vec2 uv) {
  vec2 x = uv * vec2(${CW}.0, ${CH}.0) - 0.5, fl = floor(x), f = x - fl; f = f * f * (3.0 - 2.0 * f);
  ivec2 i = ivec2(fl); int x0 = ((i.x % ${CW}) + ${CW}) % ${CW}, x1 = (x0 + 1) % ${CW}, y0 = clamp(i.y, 0, ${CH - 1}), y1 = clamp(i.y + 1, 0, ${CH - 1});
  return mix(mix(texelFetch(tCtl, ivec2(x0, y0), 0), texelFetch(tCtl, ivec2(x1, y0), 0), f.x), mix(texelFetch(tCtl, ivec2(x0, y1), 0), texelFetch(tCtl, ivec2(x1, y1), 0), f.x), f.y);
}
// land/sea field: > 0 land, < 0 sea, the coastline at 0 (also evaluated per pixel by the sky shader)
float coastS(vec3 n, float land) {
  vec3 p = n * uTR;
  return (land - 0.5) * 2.0 + (tfbm(p * (1.0 / 6000.0) + 3.1, 3) - 0.5) * 1.1 + (tnoise(p * (1.0 / 700.0) + 7.7) - 0.5) * 0.3;
}
// Rolling ground round the launch base, where the big terrain is flattened: swells ~1.7 km and ~500 m across,
// up to ~30 m high, the pads kept level. Hollows below LAKE_LV hold lakes: the ground there is exactly flat
// (the water surface) and the shader draws water where reliefShape < LAKE_LV, deeper the further below.
const float LAKE_LV = 0.29, RELIEF_K = 240.0;
float reliefShape(vec3 n) { vec3 p = n * uTR; return tfbm(p * (1.0 / 1700.0) + 71.0, 3) + (tnoise(p * (1.0 / 520.0) + 73.0) - 0.5) * 0.24 + (tnoise(p * (1.0 / 160.0) + 79.0) - 0.5) * 0.04; }
float reliefW(vec3 n, float sd) {
  vec3 sE = normalize(cross(vec3(0.0, 1.0, 0.0), uTSite)), sN = cross(uTSite, sE), q = (n - uTSite) * uTR;
  vec2 p2 = vec2(dot(q, sE), dot(q, sN));
  float w = smoothstep(320.0, 1100.0, sd) * (1.0 - smoothstep(9000.0, 14000.0, sd));
  return w * smoothstep(260.0, 520.0, length(p2 - vec2(-2500.0, -2800.0))) * smoothstep(260.0, 520.0, length(p2 - vec2(-1500.0, -6500.0)));
}
float siteRelief(vec3 n, float sd) {
  float w = reliefW(n, sd);
  if (w <= 0.0) return 0.0;
  return (max(reliefShape(n), LAKE_LV) - LAKE_LV) * RELIEF_K * uTA * w;
}
// Ground roughness below the big shapes: lumps ~55 m, ~17 m and ~6 m across, a few metres to a few tens of cm
// tall. sp = the spacing of whatever samples it (mesh vertices): each octave fades out before it gets finer than
// the mesh can hold, so the far, coarse patches stay smooth and only the patches near you get the bumps. Not on
// the flattened launch area, not under lakes, and land never drops into the sea because of it.
float fineGround(vec3 n, float sp) {
  float sd = length(n - uTSite) * uTR;
  float k = smoothstep(260.0, 420.0, sd);
  if (k <= 0.0) return 0.0;
  if (reliefW(n, sd) > 0.15) k *= smoothstep(0.0, 0.02, reliefShape(n) - LAKE_LV);
  vec3 p = n * uTR;
  return k * ((tnoise(p * (1.0 / 55.0) + 91.0) - 0.5) * 3.6 * (1.0 - smoothstep(22.0, 44.0, sp))
            + (tnoise(p * (1.0 / 17.0) + 93.0) - 0.5) * 1.1 * (1.0 - smoothstep(6.8, 13.6, sp))
            + (tnoise(p * (1.0 / 6.0) + 97.0) - 0.5) * 0.32 * (1.0 - smoothstep(2.4, 4.8, sp)));
}
// height above sea level in metres at the planet-fixed unit direction n (negative = sea floor)
float terrainH(vec3 n) {
  vec2 uv = tLonlat(n);
  vec4 c = ctlAt(uv);                      // x mountains, y roughness, z inland, w plateau
  vec2 ls = landAt(uv);
  float land = ls.x;
  vec3 p = n * uTR;
  float s = coastS(n, land);
  float hills = tfbm(p * (1.0 / 4500.0) + 11.0, 4);
  float hl = 15.0 + 200.0 * c.z + 1500.0 * c.w + (hills - 0.5) * 2.0 * (500.0 + 700.0 * c.z + 900.0 * c.y) + tridge(p * (1.0 / 6500.0) + 9.0, 4) * (60.0 + 320.0 * c.z) + (tfbm(p * (1.0 / 1300.0) + 21.0, 3) - 0.5) * (380.0 + 150.0 * c.y) + (tnoise(p * (1.0 / 420.0) + 3.7) - 0.5) * 40.0;
  float hm = 0.0;
  if (c.x > 0.002) {
    vec3 q = p * (1.0 / 11000.0);
    q += vec3(tnoise(q * 0.37 + 1.3), tnoise(q * 0.37 + 5.1), tnoise(q * 0.37 + 9.7)) * 1.4 - 0.7;
    hm = c.x * tridge(q, 7) * 5200.0;
  }
  float fine = (tfbm(p * (1.0 / 300.0) + 5.0, 3) - 0.5) * (10.0 + 50.0 * c.y + 280.0 * c.x);
  float hp = max((hl + hm + fine) * uTA, 0.0);
  // sand seas: fields of dune ridges, ~600 m apart and tens of metres tall
  if (ls.y > 0.01) {
    vec3 q = p * (1.0 / 520.0);
    q += vec3(tnoise(q * 0.21 + 2.1), tnoise(q * 0.21 + 6.3), 0.0) * 2.4;
    float d1 = 1.0 - abs(2.0 * tnoise(q) - 1.0), d2 = 1.0 - abs(2.0 * tnoise(q * 2.7 + 4.4) - 1.0);
    hp += ls.y * (d1 * d1 * d1 * 70.0 + d2 * d2 * 10.0) * smoothstep(0.3, 0.6, s);
  }
  // carve valleys: wide ones with flat floors (rivers run there), and smaller side valleys
  float k1 = 1.0 - smoothstep(0.0, 0.075, valleyBig(p)), k2 = 1.0 - smoothstep(0.0, 0.05, valleySmall(p));
  k1 = k1 * k1 * (3.0 - 2.0 * k1) * (1.0 - ls.y); k2 *= k2 * (1.0 - ls.y);
  hp -= min(hp * 0.75, (70.0 + 180.0 * c.y + 400.0 * c.x) * uTA) * k1 + min(hp * 0.4, (25.0 + 70.0 * c.y) * uTA) * k2;
  float h = s > 0.0 ? 1.2 * smoothstep(0.0, 0.03, s) + 4.0 * smoothstep(0.1, 0.5, s) + hp * smoothstep(0.02, 0.45, s) : s * 60.0;
  float sd = length(n - uTSite) * uTR;
  return h * smoothstep(1300.0, 3500.0, sd) + siteRelief(n, sd) * smoothstep(0.02, 0.3, s);
}
float terrainHd(vec3 n, float sp) { float h = terrainH(n); return h > 0.0 ? max(h + fineGround(n, sp), 0.0) : h; }
`;

export const TERRAIN_GLSL = NOISE_GLSL + TERRAIN_CORE;


// ---------------------------------------------------------------- the same function, JS
const M1 = 1597334677 | 0, M2 = 3812015801 | 0, M3 = 2798796415 | 0, M4 = 2246822519 | 0, M5 = 3266489917 | 0;
function thash(x, y, z) {
  let h = Math.imul(x, M1) ^ Math.imul(y, M2) ^ Math.imul(z, M3);
  h = Math.imul(h ^ (h >>> 16), M4); h ^= h >>> 13; h = Math.imul(h, M5); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function tnoise(x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const ix = fx | 0, iy = fy | 0, iz = fz | 0, jx = ix + 1, jy = iy + 1, jz = iz + 1;
  let u = x - fx, v = y - fy, w = z - fz;
  u = u * u * u * (u * (u * 6 - 15) + 10); v = v * v * v * (v * (v * 6 - 15) + 10); w = w * w * w * (w * (w * 6 - 15) + 10);
  return mix(mix(mix(thash(ix, iy, iz), thash(jx, iy, iz), u), mix(thash(ix, jy, iz), thash(jx, jy, iz), u), v),
    mix(mix(thash(ix, iy, jz), thash(jx, iy, jz), u), mix(thash(ix, jy, jz), thash(jx, jy, jz), u), v), w);
}
// TROT (column-major in GLSL): columns (0,.8,.6) (-.8,.36,-.48) (-.6,-.48,.64)
const P = [0, 0, 0];
function rot(x, y, z) {
  P[0] = -0.8 * y - 0.6 * z; P[1] = 0.8 * x + 0.36 * y - 0.48 * z; P[2] = 0.6 * x - 0.48 * y + 0.64 * z;
}
function tfbm(x, y, z, oct) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * tnoise(x, y, z); n += a; rot(x, y, z); x = P[0] * 2.03 + 1.7; y = P[1] * 2.03 + 1.7; z = P[2] * 2.03 + 1.7; a *= 0.5; }
  return s / n;
}
function tridge(x, y, z, oct) {
  let a = 0.5, s = 0, n = 0, w = 1;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(2 * tnoise(x, y, z) - 1); v *= v; s += a * v * w; n += a; w = Math.min(1, Math.max(0, v * 1.6));
    rot(x, y, z); x = P[0] * 2.03 + 1.7; y = P[1] * 2.03 + 1.7; z = P[2] * 2.03 + 1.7; a *= 0.5;
  }
  return s / n;
}

// ---------------------------------------------------------------- control maps, built once from the Earth textures
let CTL = null;
function blur(src, w, h, ch, stride, r, passes) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = src[i * stride + ch];
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -r; k <= r; k++) s += out[y * w + ((x + k + w) % w)]; tmp[y * w + x] = s / (2 * r + 1); }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]; out[y * w + x] = s / (2 * r + 1); }
  }
  return out;
}
function buildControl(tex) {
  if (CTL) return CTL;
  const cv = document.createElement('canvas'); cv.width = LW; cv.height = LH;
  const g = cv.getContext('2d', { willReadFrequently: true });
  // coastline: 1 = land (rows from the south pole up, like the texture's v)
  g.drawImage(tex.data.image, 0, 0, LW, LH);
  const d = g.getImageData(0, 0, LW, LH).data;
  const land = new Uint8Array(LW * LH * 2);
  for (let j = 0; j < LH; j++) { const row = (LH - 1 - j) * LW; for (let i = 0; i < LW; i++) land[(j * LW + i) * 2] = 255 - d[(row + i) * 4 + 1]; }
  // sand: bright, red-yellow, not green, in the satellite colours (Sahara, Arabia, Namib, Taklamakan…)
  g.drawImage(tex.day.image, 0, 0, LW, LH);
  const day = g.getImageData(0, 0, LW, LH).data;
  const lin = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
  const sandRaw = new Float32Array(LW * LH);
  for (let j = 0; j < LH; j++) { const row = (LH - 1 - j) * LW; for (let i = 0; i < LW; i++) {
    const k = (row + i) * 4, r = lin[day[k]], gg = lin[day[k + 1]], b = lin[day[k + 2]];
    const lum = (0.2126 * r + 0.7152 * gg + 0.0722 * b) * 0.92, veg = (gg - r) / (gg + r + 0.02);
    sandRaw[j * LW + i] = sstep(0.2, 0.34, lum) * sstep(-0.04, -0.11, veg) * (land[(j * LW + i) * 2] / 255);
  } }
  const sandB = blur(sandRaw, LW, LH, 0, 1, 1, 1);
  for (let i = 0; i < LW * LH; i++) land[i * 2 + 1] = Math.round(sandB[i] * 255);
  // slope of the relief map, averaged into 8×8 blocks
  g.drawImage(tex.relief.image, 0, 0, LW, LH);
  const r = g.getImageData(0, 0, LW, LH).data;
  const slope = new Float32Array(CW * CH), landC = new Float32Array(CW * CH);
  for (let y = 0; y < LH; y++) {
    const j = LH - 1 - y, cj = j >> 3;
    for (let x = 0; x < LW; x++) {
      const k = (y * LW + x) * 4, sx = r[k] / 127.5 - 1, sy = r[k + 1] / 127.5 - 1;
      slope[cj * CW + (x >> 3)] += Math.hypot(sx, sy) / 64;
      landC[cj * CW + (x >> 3)] += land[(j * LW + x) * 2] / (255 * 64);
    }
  }
  const sB = blur(slope, CW, CH, 0, 1, 1, 1);
  const mount = new Float32Array(CW * CH);
  for (let i = 0; i < CW * CH; i++) mount[i] = sstep(0.02, 0.12, sB[i]) * sstep(0.2, 0.6, landC[i]);
  const inl = blur(landC, CW, CH, 0, 1, 4, 2), plat = blur(mount, CW, CH, 0, 1, 4, 2);
  const ctl = new Float32Array(CW * CH * 4);
  for (let i = 0; i < CW * CH; i++) {
    ctl[i * 4] = mount[i];
    ctl[i * 4 + 1] = sstep(0.007, 0.035, slope[i]);
    ctl[i * 4 + 2] = Math.min(1, Math.max(0, (inl[i] - 0.5) * 2));
    ctl[i * 4 + 3] = sstep(0.12, 0.45, plat[i]) * sstep(0.5, 0.9, landC[i]);
  }
  const tLand = new THREE.DataTexture(land, LW, LH, THREE.RGFormat, THREE.UnsignedByteType);
  tLand.unpackAlignment = 1;
  const tCtl = new THREE.DataTexture(ctl, CW, CH, THREE.RGBAFormat, THREE.FloatType);
  for (const t of [tLand, tCtl]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; }
  CTL = { land, ctl, tLand, tCtl };
  return CTL;
}

// ---------------------------------------------------------------- cube-sphere faces
export const FN = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const FA = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0]];
export const FB = [[0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];
const v3 = (a) => `vec3(${a.map((x) => x.toFixed(1)).join(',')})`;
export const FACE_GLSL = /* glsl */`
const vec3 FN[6] = vec3[6](${FN.map(v3).join(',')});
const vec3 FA[6] = vec3[6](${FA.map(v3).join(',')});
const vec3 FB[6] = vec3[6](${FB.map(v3).join(',')});
// tangent-warped cube: grid parameter w maps to cube coordinate tan(πw/4), which keeps patches near
// the cube corners about as big as those at face centres. Offset of tan(π(wc+dw)/4) from tan(πwc/4):
vec2 warpD(vec2 c, vec2 dw) { vec2 tb = tan(0.78539816 * dw); return tb * (1.0 + c * c) / (1.0 - c * tb); }
// offset of cube point (c + d) from cube point c, both projected on the unit sphere, from small numbers only
vec3 sphOffset(vec3 Pc, float Lc, vec2 c, vec2 d, vec3 A, vec3 B) {
  float q = 2.0 * (d.x * c.x + d.y * c.y) + dot(d, d);
  float L = sqrt(Lc * Lc + q);
  return Pc * (-q / (L * Lc * (L + Lc))) + (d.x * A + d.y * B) / L;
}`;

// shared vertex code: position relative to the camera (planet-fixed frame), from the baked tile
const VERT_GLSL = /* glsl */`
${FACE_GLSL}
attribute vec4 aNode;      // face, centre u, centre v, size (cube units)
attribute vec3 aRel;       // node centre on the sphere minus the camera (fixed frame, metres)
attribute vec4 aTile;      // tile texel x, y, morph start, morph end (metres)
uniform sampler2D tAtlas;
uniform float uTRv, uHK;
uniform vec3 uEff;
float tSh, tAo;                       // sun visibility and openness at this vertex (0..1)
vec2 unpackSA(float w) { float a = floor(w / 256.0); return vec2(a, w - a * 256.0) / 255.0; }
void terrainVertex(out vec3 rel, out vec3 dir, out vec3 nrm, out float H) {
  int f = int(aNode.x + 0.5); vec3 A = FA[f], B = FB[f];
  vec2 c = tan(0.78539816 * aNode.yz);
  vec3 Pc = FN[f] + c.x * A + c.y * B; float Lc = length(Pc);
  vec2 g = position.xy;
  vec3 off = sphOffset(Pc, Lc, c, warpD(c, (g / ${N}.0 - 0.5) * aNode.w), A, B);
  float m = clamp((length(aRel + uTRv * off - uEff) - aTile.z) / (aTile.w - aTile.z), 0.0, 1.0);
  g -= fract(g * 0.5) * 2.0 * m;
  vec2 d = warpD(c, (g / ${N}.0 - 0.5) * aNode.w);
  off = sphOffset(Pc, Lc, c, d, A, B);
  dir = normalize(Pc + d.x * A + d.y * B);
  ivec2 i0 = min(ivec2(floor(g)), ivec2(${N - 1})); vec2 fr = g - vec2(i0);
  ivec2 o = ivec2(aTile.xy) + i0;
  vec4 a00 = texelFetch(tAtlas, o, 0), a10 = texelFetch(tAtlas, o + ivec2(1, 0), 0), a01 = texelFetch(tAtlas, o + ivec2(0, 1), 0), a11 = texelFetch(tAtlas, o + ivec2(1, 1), 0);
  vec3 hv = mix(mix(a00.xyz, a10.xyz, fr.x), mix(a01.xyz, a11.xyz, fr.x), fr.y);
  vec2 sa = mix(mix(unpackSA(a00.w), unpackSA(a10.w), fr.x), mix(unpackSA(a01.w), unpackSA(a11.w), fr.x), fr.y);
  tSh = mix(1.0, sa.x, uHK); tAo = mix(0.6, sa.y, uHK);
  H = hv.x;
  vec3 t1 = normalize(A - dir * dot(A, dir)), t2 = cross(dir, t1);
  vec3 nT = t1 * hv.y + t2 * hv.z + dir * sqrt(max(0.0, 1.0 - dot(hv.yz, hv.yz)));
  nrm = normalize(mix(dir, nT, uHK));
  float hd = max(H, 0.0) * uHK;
  if (position.z > 0.5) hd -= aNode.w * uTRv * 0.006 + 1.0;      // skirt: hides any sub-pixel gap between patches
  rel = aRel + uTRv * off + hd * dir;
}`;

export function terrainUniforms(R, A, site, ctl) {
  return {
    tLand: { value: ctl.tLand }, tCtl: { value: ctl.tCtl }, uTR: { value: R }, uTA: { value: A }, uTLon0: { value: LON0 }, uTSite: { value: site.clone() },
  };
}

export class Terrain {
  constructor(renderer, planet, tex, siteFixed) {
    this.renderer = renderer;
    this.R = planet.R; this.A = 1 / Math.sqrt(planet.atmK);
    this.site = siteFixed.clone();
    this.hmax = 7200 * this.A + 300;
    const ctl = (this.ctl = buildControl(tex));
    // finest level: patches of ~80 m, vertices ~2.5 m apart
    const face = (Math.PI / 2) * this.R;            // a cube face spans a quarter of a great circle
    this.maxL = Math.max(4, Math.round(Math.log2(face / 80)));
    this.range = []; for (let L = 0; L <= this.maxL + 1; L++) this.range[L] = K * (face / 2 ** L);

    // --- tile atlas + baking pass ---
    this.atlas = new THREE.WebGLRenderTarget(ATW * TS, ATH * TS, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    this.tiles = new Map(); this.free = []; for (let i = ATW * ATH - 1; i >= 0; i--) this.free.push(i);
    this.frame = 0;
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.bakeNode = new THREE.InstancedBufferAttribute(new Float32Array(256 * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.bakeXY = new THREE.InstancedBufferAttribute(new Float32Array(256 * 2), 2).setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aNode', this.bakeNode); quad.setAttribute('aXY', this.bakeXY);
    this.bakeGeo = quad;
    const bakeMat = new THREE.ShaderMaterial({
      uniforms: { ...terrainUniforms(this.R, this.A, this.site, ctl), uAtlas: { value: new THREE.Vector2(ATW * TS, ATH * TS) }, uSunB: { value: new THREE.Vector3(1, 0, 0) } },
      depthTest: false, depthWrite: false,
      vertexShader: /* glsl */`
        attribute vec4 aNode; attribute vec2 aXY; uniform vec2 uAtlas;
        varying vec4 vNode; varying vec2 vXY;
        void main() { vNode = aNode; vXY = aXY; gl_Position = vec4((aXY + position.xy * ${TS}.0) / uAtlas * 2.0 - 1.0, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; precision highp int;
        ${TERRAIN_GLSL}
        ${FACE_GLSL}
        varying vec4 vNode; varying vec2 vXY;
        uniform vec3 uSunB;
        void main() {
          vec2 g = floor(gl_FragCoord.xy - vXY);
          int f = int(vNode.x + 0.5); vec3 A = FA[f], B = FB[f];
          vec2 c = tan(0.78539816 * vNode.yz), d = warpD(c, (g / ${N}.0 - 0.5) * vNode.w);
          vec3 dir = normalize(FN[f] + (c.x + d.x) * A + (c.y + d.y) * B);
          vec3 t1 = normalize(A - dir * dot(A, dir)), t2 = cross(dir, t1);
          float eps = max(vNode.w * 0.785 * uTR / ${N}.0 * 0.5, 0.5);
          float sp = eps * 2.0;      // vertex spacing of this patch
          float h0 = terrainHd(dir, sp);
          float h1 = max(terrainHd(normalize(dir + t1 * (eps / uTR)), sp), 0.0), h2 = max(terrainHd(normalize(dir + t2 * (eps / uTR)), sp), 0.0);
          float hc = max(h0, 0.0);
          vec3 nrm = normalize(dir - t1 * ((h1 - hc) / eps) - t2 * ((h2 - hc) / eps));
          // sun visibility: march toward the sun; the closest miss gives a soft penumbra
          float sh = 1.0;
          if (dot(dir, uSunB) > -0.05) {
            vec3 P = dir * (uTR + hc + 0.5);
            float dd = max(eps * 1.5, 12.0);
            for (int i = 0; i < 18; i++) {
              vec3 q = P + uSunB * dd; float rq = length(q);
              float clr = (rq - uTR) - max(terrainH(q / rq), 0.0);
              sh = min(sh, clamp(clr / (dd * 0.07) + 0.2, 0.0, 1.0));
              if (sh <= 0.0) break;
              dd *= 1.45;
            }
          }
          // openness: ground lower than its surroundings (valley floors) gets less sky, ridges more
          float r = max(eps * 6.0, 160.0);
          float avg = 0.25 * (max(terrainH(normalize(dir + t1 * (r / uTR))), 0.0) + max(terrainH(normalize(dir - t1 * (r / uTR))), 0.0)
                            + max(terrainH(normalize(dir + t2 * (r / uTR))), 0.0) + max(terrainH(normalize(dir - t2 * (r / uTR))), 0.0));
          float ao = clamp(0.6 + (hc - avg) / (r * 0.5), 0.0, 1.0);
          gl_FragColor = vec4(h0, dot(nrm, t1), dot(nrm, t2), floor(sh * 255.0 + 0.5) * 256.0 + floor(ao * 255.0 + 0.5));
        }`,
    });
    this.bakeMesh = new THREE.Mesh(quad, bakeMat); this.bakeMesh.frustumCulled = false;
    this.bakeScene = new THREE.Scene(); this.bakeScene.add(this.bakeMesh);
    this.bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

    // --- patch grid: (N+1)² vertices + a skirt ring ---
    const pos = [], idx = [], at = (i, j) => j * TS + i;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) pos.push(i, j, 0);
    const ring = [];
    for (let i = 0; i < N; i++) ring.push([i, 0]); for (let j = 0; j < N; j++) ring.push([N, j]);
    for (let i = N; i > 0; i--) ring.push([i, N]); for (let j = N; j > 0; j--) ring.push([0, j]);
    const s0 = TS * TS;
    ring.forEach(([i, j]) => pos.push(i, j, 1));
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), e = at(i, j + 1); idx.push(a, b, c, a, c, e); }
    for (let k = 0; k < ring.length; k++) { const k2 = (k + 1) % ring.length; const a = at(...ring[k]), b = at(...ring[k2]); idx.push(a, s0 + k, b, b, s0 + k, s0 + k2); }
    const posA = new THREE.Float32BufferAttribute(pos, 3), idxA = new THREE.Uint32BufferAttribute(idx, 1);
    const mkGeo = () => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', posA); g.setIndex(idxA);
      const node = new THREE.InstancedBufferAttribute(new Float32Array(MAXN * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const rel = new THREE.InstancedBufferAttribute(new Float32Array(MAXN * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const tile = new THREE.InstancedBufferAttribute(new Float32Array(MAXN * 4), 4).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aNode', node); g.setAttribute('aRel', rel); g.setAttribute('aTile', tile);
      g.instanceCount = 0; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
      return g;
    };
    this.geo = mkGeo(); this.nearGeo = mkGeo();
    this.vU = { tAtlas: { value: this.atlas.texture }, uTRv: { value: this.R }, uHK: { value: 1 }, uEff: { value: new THREE.Vector3() } };

    // --- G-buffer pass: distance, height, normal (east/north components) ---
    this.gMat = new THREE.ShaderMaterial({
      uniforms: { ...this.vU, uRelToClip: { value: new THREE.Matrix4() }, uFC: { value: 1 } },
      side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        precision highp float; precision highp int;
        ${VERT_GLSL}
        uniform mat4 uRelToClip; uniform float uFC;
        varying vec3 vRel, vDir, vN; varying float vH, vSk; varying vec2 vSA;
        void main() {
          vec3 rel, dir, nrm; float H; terrainVertex(rel, dir, nrm, H);
          vRel = rel; vDir = dir; vN = nrm; vH = H; vSA = vec2(tSh, tAo); vSk = position.z;
          gl_Position = uRelToClip * vec4(rel, 1.0);
          gl_Position.z = (log2(max(1e-6, 1.0 + gl_Position.w)) * uFC - 1.0) * gl_Position.w;   // log depth: 1 m to 10 000 km
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        precision highp int;
        varying vec3 vRel, vDir, vN; varying float vH, vSk; varying vec2 vSA;
        void main() {
          vec3 d = normalize(vDir), e = normalize(cross(vec3(0.0, 1.0, 0.0), d)), nn = cross(d, e), n = normalize(vN);
          float pn = uintBitsToFloat(packHalf2x16(1.0 + 0.5 * vec2(dot(n, e), dot(n, nn))));
          float ps = uintBitsToFloat(packHalf2x16(1.0 + 0.5 * clamp(vSA, 0.0, 1.0)));
          // skirts (the strips hanging below patch edges to plug gaps) are marked: the sky shader fills them
          // from neighbouring real ground instead of shading a sliver that dips below sea level
          gl_FragColor = vec4(length(vRel), vSk > 0.01 ? -1e6 : vH, pn, ps);
        }`,
    });
    this.gMesh = new THREE.Mesh(this.geo, this.gMat); this.gMesh.frustumCulled = false;
    this.gScene = new THREE.Scene(); this.gScene.add(this.gMesh);

    // --- near patches in the main scene: a depth pre-pass (so hills hide whatever is behind them) and a
    //     shadow catcher (so the rocket casts its shadow on the ground wherever it lands) ---
    const sceneU = { uCamScene: { value: new THREE.Vector3() }, uRotS: { value: new THREE.Matrix3() } };
    this.sceneU = sceneU;
    const patch = (mat) => {
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, this.vU, sceneU);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>\n${VERT_GLSL}\nuniform vec3 uCamScene; uniform mat3 uRotS;`)
          .replace('void main() {', 'void main() {\n  vec3 tRel, tDir, tNrm; float tH; terrainVertex(tRel, tDir, tNrm, tH);')
          .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = uRotS * tNrm;')
          .replace('#include <begin_vertex>', 'vec3 transformed = uCamScene + uRotS * tRel;');
      };
      mat.polygonOffset = true; mat.polygonOffsetFactor = 2; mat.polygonOffsetUnits = 8;
      return mat;
    };
    const depthMat = patch(new THREE.MeshBasicMaterial({ colorWrite: false }));
    const shadowMat = patch(new THREE.ShadowMaterial({ opacity: 0.55, fog: false, depthWrite: false }));
    shadowMat.depthFunc = THREE.LessEqualDepth;
    this.depthMesh = new THREE.Mesh(this.nearGeo, depthMat); this.depthMesh.renderOrder = -50;
    this.shadowMesh = new THREE.Mesh(this.nearGeo, shadowMat); this.shadowMesh.receiveShadow = true; this.shadowMesh.renderOrder = 2;
    for (const m of [this.depthMesh, this.shadowMesh]) m.frustumCulled = false;
    this.group = new THREE.Group(); this.group.add(this.depthMesh, this.shadowMesh);

    this.tmp = { c: new THREE.Vector3(), q: new THREE.Vector3(), frustum: new THREE.Frustum(), sph: new THREE.Sphere(), proj: new THREE.Matrix4() };
    this.stats = { nodes: 0, baked: 0 };
  }

  // ---- physics: height (m) at a planet-fixed unit direction, and at an inertial position ----
  height(nx, ny, nz) {
    const lon = Math.atan2(-nz, nx) + LON0;
    const u = lon / (2 * Math.PI) + 0.5, v = Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI + 0.5;
    const c = this.ctlAt(u, v), ls = this.landAt(u, v), land = ls[0], R = this.R;
    const px = nx * R, py = ny * R, pz = nz * R;
    const s = (land - 0.5) * 2 + (tfbm(px / 6000 + 3.1, py / 6000 + 3.1, pz / 6000 + 3.1, 3) - 0.5) * 1.1 + (tnoise(px / 700 + 7.7, py / 700 + 7.7, pz / 700 + 7.7) - 0.5) * 0.3;
    const hills = tfbm(px / 4500 + 11, py / 4500 + 11, pz / 4500 + 11, 4);
    const hl = 15 + 200 * c[2] + 1500 * c[3] + (hills - 0.5) * 2 * (500 + 700 * c[2] + 900 * c[1]) + tridge(px / 6500 + 9, py / 6500 + 9, pz / 6500 + 9, 4) * (60 + 320 * c[2]) + (tfbm(px / 1300 + 21, py / 1300 + 21, pz / 1300 + 21, 3) - 0.5) * (380 + 150 * c[1]) + (tnoise(px / 420 + 3.7, py / 420 + 3.7, pz / 420 + 3.7) - 0.5) * 40;
    let hm = 0;
    if (c[0] > 0.002) {
      let qx = px / 11000, qy = py / 11000, qz = pz / 11000;
      const wx = tnoise(qx * 0.37 + 1.3, qy * 0.37 + 1.3, qz * 0.37 + 1.3), wy = tnoise(qx * 0.37 + 5.1, qy * 0.37 + 5.1, qz * 0.37 + 5.1), wz = tnoise(qx * 0.37 + 9.7, qy * 0.37 + 9.7, qz * 0.37 + 9.7);
      qx += wx * 1.4 - 0.7; qy += wy * 1.4 - 0.7; qz += wz * 1.4 - 0.7;
      hm = c[0] * tridge(qx, qy, qz, 7) * 5200;
    }
    const fine = (tfbm(px / 300 + 5, py / 300 + 5, pz / 300 + 5, 3) - 0.5) * (10 + 50 * c[1] + 280 * c[0]);
    let hp = Math.max((hl + hm + fine) * this.A, 0);
    if (ls[1] > 0.01) {
      let qx = px / 520, qy = py / 520, qz = pz / 520;
      const wx = tnoise(qx * 0.21 + 2.1, qy * 0.21 + 2.1, qz * 0.21 + 2.1), wy = tnoise(qx * 0.21 + 6.3, qy * 0.21 + 6.3, qz * 0.21 + 6.3);
      qx += wx * 2.4; qy += wy * 2.4;
      const d1 = 1 - Math.abs(2 * tnoise(qx, qy, qz) - 1), d2 = 1 - Math.abs(2 * tnoise(qx * 2.7 + 4.4, qy * 2.7 + 4.4, qz * 2.7 + 4.4) - 1);
      hp += ls[1] * (d1 * d1 * d1 * 70 + d2 * d2 * 10) * sstep(0.3, 0.6, s);
    }
    let k1 = 1 - sstep(0, 0.075, Math.abs(tfbm(px / 7000 + 31, py / 7000 + 31, pz / 7000 + 31, 2) - 0.5));
    let k2 = 1 - sstep(0, 0.05, Math.abs(tfbm(px / 2300 + 47, py / 2300 + 47, pz / 2300 + 47, 2) - 0.5));
    k1 = k1 * k1 * (3 - 2 * k1) * (1 - ls[1]); k2 = k2 * k2 * (1 - ls[1]);
    hp -= Math.min(hp * 0.75, (70 + 180 * c[1] + 400 * c[0]) * this.A) * k1 + Math.min(hp * 0.4, (25 + 70 * c[1]) * this.A) * k2;
    const h = s > 0 ? 1.2 * sstep(0, 0.03, s) + 4 * sstep(0.1, 0.5, s) + hp * sstep(0.02, 0.45, s) : s * 60;
    const st = this.site, sd = Math.hypot(nx - st.x, ny - st.y, nz - st.z) * R;
    const hb = h * sstep(1300, 3500, sd) + this.siteRelief(nx, ny, nz, sd) * sstep(0.02, 0.3, s);
    return hb > 0 ? Math.max(hb + this.fineGround(nx, ny, nz, sd), 0) : hb;
  }
  // the GLSL fineGround at full detail (sp = 0): what the physics stands on is what the nearest patches draw
  fineGround(nx, ny, nz, sd) {
    let k = sstep(260, 420, sd);
    if (k <= 0) return 0;
    if (this.reliefWJS(nx, ny, nz, sd) > 0.15) k *= sstep(0, 0.02, this.reliefShapeJS(nx, ny, nz) - 0.29);
    const X = nx * this.R, Y = ny * this.R, Z = nz * this.R;
    return k * ((tnoise(X / 55 + 91, Y / 55 + 91, Z / 55 + 91) - 0.5) * 3.6 + (tnoise(X / 17 + 93, Y / 17 + 93, Z / 17 + 93) - 0.5) * 1.1 + (tnoise(X / 6 + 97, Y / 6 + 97, Z / 6 + 97) - 0.5) * 0.32);
  }
  reliefShapeJS(nx, ny, nz) {
    const X = nx * this.R, Y = ny * this.R, Z = nz * this.R;
    return tfbm(X / 1700 + 71, Y / 1700 + 71, Z / 1700 + 71, 3) + (tnoise(X / 520 + 73, Y / 520 + 73, Z / 520 + 73) - 0.5) * 0.24 + (tnoise(X / 160 + 79, Y / 160 + 79, Z / 160 + 79) - 0.5) * 0.04;
  }
  reliefWJS(nx, ny, nz, sd) {
    let w = sstep(320, 1100, sd) * (1 - sstep(9000, 14000, sd));
    if (w <= 0) return 0;
    const st = this.site, R = this.R;
    let ex = st.z, ez = -st.x; const el = Math.hypot(ex, ez) || 1; ex /= el; ez /= el;
    const sNx = st.y * ez, sNy = st.z * ex - st.x * ez, sNz = -st.y * ex;
    const qx = (nx - st.x) * R, qy = (ny - st.y) * R, qz = (nz - st.z) * R;
    const px = qx * ex + qz * ez, py = qx * sNx + qy * sNy + qz * sNz;
    return w * sstep(260, 520, Math.hypot(px + 2500, py + 2800)) * sstep(260, 520, Math.hypot(px + 1500, py + 6500));
  }
  // the same rolling ground and lake hollows as the GLSL siteRelief
  siteRelief(nx, ny, nz, sd) {
    const w = this.reliefWJS(nx, ny, nz, sd);
    if (w <= 0) return 0;
    return (Math.max(this.reliefShapeJS(nx, ny, nz), 0.29) - 0.29) * 240 * this.A * w;
  }
  // ground height (water surface counts as ground) under an inertial position, planet rotated by theta
  groundAt(x, theta) {
    const c = Math.cos(theta), s = Math.sin(theta), m = Math.hypot(x.x, x.y, x.z);
    return Math.max(0, this.height((c * x.x - s * x.z) / m, x.y / m, (s * x.x + c * x.z) / m));
  }
  landAt(u, v) {
    const L = this.ctl.land, out = [0, 0];
    const x = u * LW - 0.5, y = v * LH - 0.5, fx = Math.floor(x), fy = Math.floor(y);
    let a = x - fx, b = y - fy; a = a * a * (3 - 2 * a); b = b * b * (3 - 2 * b);
    const x0 = ((fx % LW) + LW) % LW, x1 = (x0 + 1) % LW, y0 = Math.min(LH - 1, Math.max(0, fy)), y1 = Math.min(LH - 1, Math.max(0, fy + 1));
    for (let k = 0; k < 2; k++) out[k] = mix(mix(L[(y0 * LW + x0) * 2 + k], L[(y0 * LW + x1) * 2 + k], a), mix(L[(y1 * LW + x0) * 2 + k], L[(y1 * LW + x1) * 2 + k], a), b) / 255;
    return out;
  }
  ctlAt(u, v) {
    const C = this.ctl.ctl, out = [0, 0, 0, 0];
    const x = u * CW - 0.5, y = v * CH - 0.5, fx = Math.floor(x), fy = Math.floor(y);
    let a = x - fx, b = y - fy; a = a * a * (3 - 2 * a); b = b * b * (3 - 2 * b);
    const x0 = ((fx % CW) + CW) % CW, x1 = (x0 + 1) % CW, y0 = Math.min(CH - 1, Math.max(0, fy)), y1 = Math.min(CH - 1, Math.max(0, fy + 1));
    for (let k = 0; k < 4; k++) out[k] = mix(mix(C[(y0 * CW + x0) * 4 + k], C[(y0 * CW + x1) * 4 + k], a), mix(C[(y1 * CW + x0) * 4 + k], C[(y1 * CW + x1) * 4 + k], a), b);
    return out;
  }

  // ---- per frame: choose patches, bake missing tiles, fill instance buffers ----
  // camF: camera position in the planet-fixed frame (metres); relToClip: fixed-frame camera-relative → clip
  update(camF, relToClip, fade, sunF) {
    this.frame++;
    if (sunF) {
      const bs = this.bakeMesh.material.uniforms.uSunB.value;
      if (this.epoch == null || bs.angleTo(sunF) > 0.02) { bs.copy(sunF); this.epoch = (this.epoch || 0) + 1; }
    }
    const R = this.R, t = this.tmp;
    const rc = camF.length(), up = t.q.copy(camF).multiplyScalar(1 / rc);
    const hc = Math.max(0, this.height(up.x, up.y, up.z));
    this.camH = hc;
    const eff = new THREE.Vector3().copy(up).multiplyScalar(-Math.min(hc, Math.max(0, rc - R)));
    const camE = camF.clone().add(eff);
    this.vU.uEff.value.copy(eff); this.vU.uHK.value = fade;
    t.frustum.setFromProjectionMatrix(relToClip);
    const horizonCam = rc > R ? Math.acos(R / rc) : 0, horizonPk = Math.acos(R / (R + this.hmax));
    const out = [], near = [], want = [];
    let budget = this.frame < 3 ? 2048 : 256;
    const nearR = this.nearRange || 6000;
    const pend = new Set();
    const has = (key) => this.tiles.has(key) || pend.has(key);
    const self = this;
    const dirOf = (f, wu, wv, o) => { const n = FN[f], a = FA[f], b = FB[f], u = Math.tan((Math.PI / 4) * wu), v = Math.tan((Math.PI / 4) * wv); return o.set(n[0] + u * a[0] + v * b[0], n[1] + u * a[1] + v * b[1], n[2] + u * a[2] + v * b[2]).normalize(); };
    const cc = new THREE.Vector3(), cr = new THREE.Vector3();
    function visit(f, L, ix, iy) {
      const size = 2 / 2 ** L, uc = -1 + (ix + 0.5) * size, vc = -1 + (iy + 0.5) * size;
      dirOf(f, uc, vc, cc);
      let rad = 0;
      for (const [sx, sy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) { dirOf(f, uc + sx * size, vc + sy * size, cr); rad = Math.max(rad, cr.distanceTo(cc)); }
      const radM = rad * R;
      // below the horizon, or outside the view?
      const gam = Math.acos(Math.max(-1, Math.min(1, cc.dot(up))));
      if (gam - rad * 1.05 > horizonCam + horizonPk) return;
      t.sph.center.set(cc.x * R - camF.x, cc.y * R - camF.y, cc.z * R - camF.z); t.sph.radius = radM + self.hmax;
      if (!t.frustum.intersectsSphere(t.sph)) return;
      const dist = Math.max(0, Math.hypot(cc.x * R - camE.x, cc.y * R - camE.y, cc.z * R - camE.z) - radM);
      const own = self.tiles.get(`${f}/${L}/${ix}/${iy}`); if (own) own.used = self.frame;   // parents stay baked too
      if (L < self.maxL && dist < self.range[L + 1]) {
        // split, if all four children are baked or can be baked this frame
        const kids = [[2 * ix, 2 * iy], [2 * ix + 1, 2 * iy], [2 * ix, 2 * iy + 1], [2 * ix + 1, 2 * iy + 1]];
        const miss = kids.filter(([a, b]) => !has(`${f}/${L + 1}/${a}/${b}`)).length;
        if (miss <= budget) {
          budget -= miss;
          for (const [a, b] of kids) { const k = `${f}/${L + 1}/${a}/${b}`; if (!has(k)) { want.push([k, f, L + 1, a, b]); pend.add(k); } }
          for (const [a, b] of kids) visit(f, L + 1, a, b);
          return;
        }
      }
      const key = `${f}/${L}/${ix}/${iy}`;
      if (!has(key)) { budget--; want.push([key, f, L, ix, iy]); pend.add(key); }
      else if (self.tiles.has(key)) self.tiles.get(key).used = self.frame;   // keep it from being evicted below
      const node = { key, f, L, ix, iy, uc, vc, size, cx: cc.x, cy: cc.y, cz: cc.z };
      out.push(node);
      if (dist < nearR) near.push(node);
    }
    for (let f = 0; f < 6; f++) visit(f, 0, 0, 0);
    // refresh tiles baked with an older sun, nearest first, a few per frame
    const stale = out.filter((n) => { const e = this.tiles.get(n.key); return e && e.epoch !== this.epoch && !pend.has(n.key); }).sort((x, y) => y.L - x.L);
    for (const n of stale.slice(0, 40)) { want.push([n.key, n.f, n.L, n.ix, n.iy]); pend.add(n.key); }
    this.bake(want);
    for (const n of out) this.tiles.get(n.key).used = this.frame;
    const fill = (geo, list) => {
      const nA = geo.attributes.aNode.array, rA = geo.attributes.aRel.array, tA = geo.attributes.aTile.array;
      const n = Math.min(list.length, MAXN);
      for (let i = 0; i < n; i++) {
        const o = list[i], slot = this.tiles.get(o.key).slot;
        nA.set([o.f, o.uc, o.vc, o.size], i * 4);
        rA.set([o.cx * R - camF.x, o.cy * R - camF.y, o.cz * R - camF.z], i * 3);
        const end = this.range[o.L] * 0.97;
        tA.set([(slot % ATW) * TS, Math.floor(slot / ATW) * TS, end * 0.78, end], i * 4);
      }
      geo.attributes.aNode.needsUpdate = geo.attributes.aRel.needsUpdate = geo.attributes.aTile.needsUpdate = true;
      geo.instanceCount = n;
    };
    fill(this.geo, out); fill(this.nearGeo, near);
    this.stats.nodes = out.length; this.stats.near = near.length;
    this.stats.perL = out.reduce((a, n) => { a[n.L] = (a[n.L] || 0) + 1; return a; }, {});
  }
  bake(want) {
    if (!want.length) return;
    this.stats.baked += want.length;
    for (let s = 0; s < want.length; s += 256) {
      const batch = want.slice(s, s + 256);
      batch.forEach(([key, f, L, ix, iy], i) => {
        let slot;
        const had = this.tiles.get(key);
        if (had) slot = had.slot;                 // re-bake in place (the sun moved)
        else if (this.free.length) slot = this.free.pop();
        else { // evict the least recently used tile
          let best = null; for (const [k, e] of this.tiles) if (e.used < this.frame && (!best || e.used < best[1].used)) best = [k, e];
          slot = best[1].slot; this.tiles.delete(best[0]);
        }
        this.tiles.set(key, { slot, used: this.frame, epoch: this.epoch });
        const size = 2 / 2 ** L;
        this.bakeNode.array.set([f, -1 + (ix + 0.5) * size, -1 + (iy + 0.5) * size, size], i * 4);
        this.bakeXY.array.set([(slot % ATW) * TS, Math.floor(slot / ATW) * TS], i * 2);
      });
      this.bakeNode.needsUpdate = this.bakeXY.needsUpdate = true;
      this.bakeGeo.instanceCount = batch.length;
      const r = this.renderer, prevT = r.getRenderTarget(), prevC = r.autoClear;
      r.setRenderTarget(this.atlas); r.autoClear = false;
      r.render(this.bakeScene, this.bakeCam);
      r.autoClear = prevC; r.setRenderTarget(prevT);
    }
  }
}
