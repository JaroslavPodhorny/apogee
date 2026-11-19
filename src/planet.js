// Earth + atmosphere. The flight view draws the planet analytically in a full-screen shader
// (ray/sphere), which stays exact from the launch pad to orbit:
//   · 8K day map, night lights, water mask, relief normals, cloud cover (Solar System Scope, CC BY 4.0)
//   · physically based single scattering (Rayleigh + Mie + ozone) with the sun's light reddened
//     through the air (Chapman approximation), so sunsets, the blue limb and the night side all emerge
//   · a cloud shell with its own lighting, self-shadowing and shadows on the ground
//   · ocean sun glint and waves, city lights on the night side, stars and the Milky Way
//   · fine procedural ground detail near the camera, computed in camera-relative coordinates
// Everything is output as linear HDR radiance; tone mapping happens afterwards.
import * as THREE from '../vendor/three.module.js';
import { NOISE_GLSL, TERRAIN_CORE, LON0 as TLON0 } from './terrain.js';
import { BUSH_GLSL, BUSH_CELL } from './bushes.js';

export const SUN_E = 9.5;                     // sun irradiance in scene units
const LON0 = (-52.77 * Math.PI) / 180;        // launch site sits on the Guiana coast (5°N 52.8°W)
const DETAIL_PERIOD = 2048;                   // metres; the fine-detail noise repeats on this grid

export async function loadEarth(renderer) {
  const loader = new THREE.TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const load = (url, srgb) => new Promise((res, rej) => loader.load(url, (t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = aniso; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    res(t);
  }, undefined, rej));
  const [day, data, relief] = await Promise.all([load('assets/earth/day.jpg', true), load('assets/earth/data.jpg', false), load('assets/earth/relief.jpg', false)]);
  for (const t of [day, data, relief]) renderer.initTexture(t);
  return { day, data, relief };
}

// ---------- shared GLSL ----------
const COMMON = /* glsl */`
precision highp float; precision highp int;
#define PI 3.14159265
const vec3 BR = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const vec3 BO = vec3(0.650e-6, 1.881e-6, 0.085e-6);
const float BM = 3.996e-6, BMX = 4.40e-6;
uniform float uR, uHr, uHm, uK, uE, uLon0, uTime;
uniform sampler2D tDay, tData, tRelief;

float hash3(ivec3 p) {
  uvec3 q = uvec3(p) * uvec3(1597334677u, 3812015801u, 2798796415u);
  uint h = q.x ^ q.y ^ q.z; h = (h ^ (h >> 16)) * 2246822519u; h ^= h >> 13; h *= 3266489917u; h ^= h >> 16;
  return float(h) * (1.0 / 4294967295.0);
}
// value noise; with per > 0 the lattice repeats every per cells
float vnoise(vec3 x, int per) {
  ivec3 i = ivec3(floor(x)); vec3 f = fract(x); f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic: no creases where cells meet
  ivec3 j = i + 1;
  if (per > 0) { i = ((i % per) + per) % per; j = ((j % per) + per) % per; }
  return mix(mix(mix(hash3(i), hash3(ivec3(j.x, i.y, i.z)), f.x), mix(hash3(ivec3(i.x, j.y, i.z)), hash3(ivec3(j.x, j.y, i.z)), f.x), f.y),
             mix(mix(hash3(ivec3(i.x, i.y, j.z)), hash3(ivec3(j.x, i.y, j.z)), f.x), mix(hash3(ivec3(i.x, j.y, j.z)), hash3(j), f.x), f.y), f.z);
}
const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
// value noise summed over rotated octaves: no visible lattice
float fbmR(vec3 p, int oct) { float a = 0.5, s = 0.0, n = 0.0; for (int i = 0; i < 5; i++) { if (i >= oct) break; s += a * vnoise(p, 0); n += a; p = ROT * p * 2.03 + 1.7; a *= 0.5; } return s / n; }
float fbm(vec3 p, int oct) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vnoise(p, 0); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
// slope (rise per metre) of a noise relief of amplitude amp metres and feature size sc metres, at p (metres)
vec2 reliefSlope(vec2 p, float sc, float seed, float amp) {
  float e = sc * 0.08, b0 = vnoise(vec3(p / sc, seed), 0);
  return vec2(vnoise(vec3((p + vec2(e, 0.0)) / sc, seed), 0) - b0, vnoise(vec3((p + vec2(0.0, e)) / sc, seed), 0) - b0) * (amp / e);
}

vec2 lonlat(vec3 n) {
  float lon = atan(-n.z, n.x) + uLon0;
  return vec2(lon / (2.0 * PI) + 0.5, asin(clamp(n.y, -1.0, 1.0)) / PI + 0.5);
}
// Chapman function (Schüler): column density along a ray from altitude h (in scale heights).
float chap(float X, float h, float mu) {
  float c = 1.2533 * sqrt(X + h);
  if (mu >= 0.0) return c / (c * mu + 1.0) * exp(-h);
  float x0 = sqrt(1.0 - mu * mu) * (X + h), c0 = 1.2533 * sqrt(x0);
  return 2.0 * c0 * exp(min(X - x0, 60.0)) - c / (1.0 - c * mu) * exp(-h);
}
// transmittance of sunlight reaching altitude h when the sun is at cos(zenith) = mu
vec3 sunT(float h, float mu) {
  float r = uR + h, muH = -sqrt(max(0.0, 1.0 - uR * uR / (r * r)));
  float vis = smoothstep(muH - 0.012, muH + 0.004, mu);
  if (vis <= 0.0) return vec3(0.0);
  float m = max(mu, muH + 0.004);
  vec2 od = vec2(uHr * chap(uR / uHr, h / uHr, m), uHm * chap(uR / uHm, h / uHm, m));
  return vis * exp(-((BR + BO) * uK * od.x + BMX * uK * od.y));
}
float cloudAlpha(float cov, vec3 nF, float siteClear, float foot) {
  float n = fbm(nF * (uR / (9000.0 / sqrt(uK))), 4);
  float c = cov * 1.15 + (n - 0.5) * 0.55;
  // close up: billowy edges at 1.5 km and 300 m, and a crisper boundary
  float wd = smoothstep(900.0, 150.0, foot);
  if (wd > 0.0) {
    float d1 = fbm(nF * (uR / 1500.0) + 2.7, 3), d2 = vnoise(nF * (uR / 300.0) + 8.1, 0);
    c += ((d1 - 0.5) * 0.45 + (d2 - 0.5) * 0.18) * wd;
  }
  c *= siteClear;
  float edge = mix(0.23, 0.09, wd);
  return smoothstep(0.55 - edge, 0.55 + edge, c);
}
`;

const SKY_FRAG = /* glsl */`
${COMMON}
${NOISE_GLSL}
${TERRAIN_CORE}
${BUSH_GLSL}
varying vec3 vDir;
uniform vec3 uCamPos, uSun, uSunF, uCamRel, uSite, uCamF, uCamSite;
uniform float uCG, uCA, uCC, uRa, uRc, uRot, uPix, uEnv, uCamAlt, uSunDisc, uStarK;
uniform sampler2D tTer;          // terrain G-buffer: distance, height, normal (east, north)
uniform float uTerOn, uTerK;
uniform float uBush3D;
uniform vec4 uCrater[8]; uniform int uCraterN;   // blast marks in the site frame: x, y, crater radius, scorch radius
uniform vec4 uFlashP; uniform vec3 uFlashC;        // a fireball lighting the ground: site-frame x, y, height; colour × power
uniform sampler2D tGround;        // 2D ground detail (crowns, soil, clumps), mipmapped + anisotropic
uniform vec2 uGBig, uGSmall; uniform vec3 uGE, uGN;   // camera in a fixed tangent frame (wrapped), and that frame's axes

vec3 toFixed(vec3 v) { float c = cos(uRot), s = sin(uRot); return vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec2 wrapGrad(vec2 g) { g.x -= floor(g.x + 0.5); return g; }

vec3 stars(vec3 d) {
  vec3 col = vec3(0.0);
  for (int L = 0; L < 2; L++) {
    float sc = L == 0 ? 90.0 : 260.0;
    vec3 g = d * sc; ivec3 i = ivec3(floor(g));
    float h = hash3(i + L * 911);
    if (h > (L == 0 ? 0.955 : 0.975)) {
      vec3 c = (vec3(i) + 0.5 + (vec3(hash3(i + 3), hash3(i + 5), hash3(i + 9)) - 0.5) * 0.7) / sc;
      float w = max(uPix * 0.9, 1e-4), dd = length(normalize(c) - d) / w;
      // a power law like the real sky: a handful of bright stars, thousands only just above the dark
      float b = 0.006 / (1.0 - 0.998 * hash3(i + 13));
      float tmp = hash3(i + 21);
      vec3 sc2 = tmp < 0.2 ? vec3(0.65, 0.78, 1.0) : tmp > 0.85 ? vec3(1.0, 0.8, 0.6) : vec3(1.0, 0.97, 0.92);
      col += sc2 * b * exp(-dd * dd);
    }
  }
  vec3 mwN = normalize(vec3(0.32, 0.86, -0.4));
  float band = exp(-pow(dot(d, mwN) / 0.16, 2.0));
  float m = fbm(d * 7.0, 5), dust = smoothstep(0.45, 0.7, fbm(d * 13.0 + 4.0, 4));
  col += vec3(0.75, 0.8, 1.0) * band * (0.012 + 0.05 * m * m) * (1.0 - 0.7 * dust * band);
  // the eye (or camera) adapted to sunlight sees only the brightest; dark-adapted, all of them
  return col * uStarK;
}

// ---------- volumetric clouds: a real layer of cumulus near the camera ----------
uniform highp sampler3D tNoise;
uniform vec3 uCloudRel;          // camera position in the fixed frame (plus wind drift), wrapped to 36 km
uniform float uVolK, uVolMax, uCB, uCT, uRb, uRt, uFrame, uNoiseOn;
// over the launch site the weather is always fair: scattered cumulus, never overcast, never empty
float siteCov(float cov, vec3 nF) {
  float s = 1.0 - smoothstep(9000.0 / uK, 30000.0 / uK, length(nF - uSite) * uR);
  return mix(cov, clamp(cov, 0.4, 0.5), s);
}
float cloudCov(vec3 pF) {
  vec3 n = normalize(pF);
  return siteCov(textureLod(tData, lonlat(n), 1.5).r, n);
}
// metres covered by one pixel at the current sample: picks the noise mip, so distant cloud texture
// averages out instead of aliasing into grain
float gFoot = 1.0;
float nLod(float scale) { return max(0.0, log2(gFoot * 64.0 / scale)); }
// The billow noise is a small tileable texture (9 km period). Seen from high up a single sample repeats in rows,
// so each scale is sampled twice: at scales whose ratio is irrational, the second turned about a tilted axis.
// The sum never repeats within sight; the shapes stay cumulus.
const mat3 CR1 = mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60);
const mat3 CR2 = mat3(0.36, -0.48, 0.80, 0.48, -0.64, -0.60, 0.80, 0.60, 0.0);
float cloudShape(vec3 loc) {
  float a = textureLod(tNoise, loc * (1.0 / 9000.0), nLod(9000.0)).r;
  float b = textureLod(tNoise, CR1 * loc * (1.0 / 14130.0) + 0.37, nLod(14130.0)).r;
  float c = textureLod(tNoise, loc * (1.0 / 2250.0) + 0.53, nLod(2250.0)).r;
  float d = textureLod(tNoise, CR2 * loc * (1.0 / 3530.0) + 0.71, nLod(3530.0)).r;
  // averaging two samples flattens the contrast: scale the deviation back up
  return (a * 0.55 + b * 0.45 - 0.5) * 0.7 * 1.3 + (c * 0.5 + d * 0.5 - 0.5) * 0.35 * 1.35;
}
// the large scales alone: for the light samples toward the sun, which only shade the cloud
float cloudShapeLo(vec3 loc) {
  float a = textureLod(tNoise, loc * (1.0 / 9000.0), nLod(9000.0)).r;
  float b = textureLod(tNoise, CR1 * loc * (1.0 / 14130.0) + 0.37, nLod(14130.0)).r;
  return (a * 0.55 + b * 0.45 - 0.5) * 0.7 * 1.3;
}
float cloudDens(vec3 loc, float hf, float cov, bool detail) {
  float c = cov * 1.15 + (detail ? cloudShape(loc) : cloudShapeLo(loc));
  // flat base, domed top; denser cover grows taller towers
  float top = 0.4 + 0.6 * smoothstep(0.45, 0.9, c);
  float prof = smoothstep(0.0, 0.06, hf) * (1.0 - smoothstep(top * 0.45, top, hf));
  float dd = smoothstep(0.4, 0.62, c) * prof;
  if (dd <= 0.0 || !detail) return dd;
  float det = textureLod(tNoise, loc * (1.0 / 1125.0) + 0.37, nLod(1125.0)).g;
  return clamp((dd - (1.0 - det) * 0.45 * (1.0 - 0.6 * dd)) * 1.8, 0.0, 1.0);
}
float hg(float g, float m) { return (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * m, 1.5)); }
// returns scattered light (rgb) and transmittance (a); tW = density-weighted distance (for haze)
vec4 marchClouds(vec3 d, vec3 dF, vec3 cF, float b, float tEnd, float muV, out float tW) {
  tW = -1.0;
  float dB = b * b - uCB, dT = b * b - uCT, rc = length(uCamPos), t0, t1;
  if (rc < uRb) { if (dB < 0.0) return vec4(0.0, 0.0, 0.0, 1.0); t0 = -b + sqrt(dB); t1 = -b + sqrt(max(dT, 0.0)); }
  else if (rc < uRt) { t0 = 0.0; t1 = -b + sqrt(max(dT, 0.0)); if (dB > 0.0 && b < 0.0) t1 = min(t1, uCB / (-b + sqrt(dB))); }
  else { if (dT < 0.0 || b > 0.0) return vec4(0.0, 0.0, 0.0, 1.0); t0 = uCT / (-b + sqrt(dT)); t1 = dB > 0.0 ? uCB / (-b + sqrt(dB)) : -b + sqrt(dT); }
  t1 = min(t1, min(tEnd, uVolMax));
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  float thick = uRt - uRb, sig = 0.028 * sqrt(uK);           // extinction per metre at full density
  vec3 up0 = normalize(cF + dF * t0);
  float muC = dot(up0, uSunF);
  vec3 sunC = uE * sunT(0.5 * (uRb + uRt) - uR, muC);
  vec3 ambC = 0.17 * (uE * vec3(0.06, 0.09, 0.15) * smoothstep(-0.15, 0.3, muC) + uE * 0.0004);
  float ph = mix(hg(0.7, muV), hg(-0.2, muV), 0.35) * 3.0;
  float T = 1.0, ws = 0.0, ts = 0.0, base = thick * 0.035;
  vec3 L = vec3(0.0);
  // steps grow 5% each (fine near the camera, coarse far away); the jitter is a fixed fraction of a step,
  // so the sampling slices dissolve into fine grain instead of showing as bands
  // the offset changes every frame (the sky is accumulated over frames afterwards), so the grain averages away
  float s = hash3(ivec3(ivec2(gl_FragCoord.xy), int(uFrame) * 7 + 3)), base0 = max(base, t0 * 0.025);
  for (int i = 0; i < 96; i++) {
    float t = t0 + base0 * (pow(1.035, s) - 1.0) / 0.035;
    if (t >= t1 || T < 0.015) break;
    float dt = base0 * pow(1.035, s) * 1.0175;
    vec3 pF = cF + dF * t;
    float r = length(pF), hf = (r - uRb) / thick;
    float cov = cloudCov(pF);
    if (cov < 0.12) { s += 2.0; continue; }
    vec3 loc = uCloudRel + dF * t;
    gFoot = max(1.0, t * uPix * 1.5);
    float den = cloudDens(loc, hf, cov, true) * smoothstep(uVolMax, uVolMax * 0.7, t);
    if (den > 0.004) {
      float su = dot(uSunF, pF / r), od = 0.0, ls = 0.0;
      for (int j = 0; j < 3; j++) {
        float seg = thick * (j == 0 ? 0.06 : j == 1 ? 0.16 : 0.4);
        ls += seg;
        od += cloudDens(loc + uSunF * (ls - seg * 0.5), hf + su * (ls - seg * 0.5) / thick, cov, j == 0) * seg;
      }
      float Tl = exp(-sig * od), Tms = exp(-sig * od * 0.2);
      vec3 Ls = sunC * (Tl * ph + Tms * 0.07) * (1.0 - 0.6 * exp(-sig * den * thick * 0.25)) + ambC * (0.25 + 0.75 * hf);
      float Ts = exp(-sig * den * dt);
      L += T * (1.0 - Ts) * Ls;
      ws += T * (1.0 - Ts); ts += T * (1.0 - Ts) * t;
      T *= Ts;
    }
    s += 1.0;
  }
  if (ws > 1e-3) tW = ts / ws;
  return vec4(L, T);
}
// The cloud layer drawn as a sheet, but with the volume's own shapes: the same coverage and the same noise at the
// same place, so clouds keep their outlines when the camera climbs out of the volumetric range or looks past it.
// Returns cover (x) and how much of the cloud lies toward the sun (y, shades the far sides for some relief).
// Returns cover (x, soft-edged), how much cloud lies toward the sun (y: the far sides go into shade) and the
// thickness (z: cores are deep and bright on top, the thin margins let the ground show through and look grey).
vec3 shellVol(vec3 loc, float cov, float foot) {
  gFoot = max(1.0, foot * 1.5);
  float c = cov * 1.15 + cloudShape(loc);
  float dd = smoothstep(0.34, 0.7, c);
  float det = textureLod(tNoise, loc * (1.0 / 1125.0) + 0.37, nLod(1125.0)).g;
  dd = clamp((dd - (1.0 - det) * 0.4 * (1.0 - 0.6 * dd)) * 1.4, 0.0, 1.0);
  vec3 ls = loc + normalize(uSunF - normalize(uCamF) * dot(uSunF, normalize(uCamF))) * 700.0;
  float cs = cov * 1.15 + cloudShapeLo(ls);
  return vec3(smoothstep(0.0, 0.8, dd), smoothstep(0.4, 0.62, cs), dd);
}

// fields: a jittered grid of cells (Voronoi). Returns the distance to the nearest cell border (in cell
// units, exact, so field edges are straight) and the cell's id.
vec3 vorE(vec2 x, int seed) {
  vec2 n = floor(x), f = fract(x), mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(i, j); ivec2 c = ivec2(n + g);
    vec2 o = vec2(hash3(ivec3(c, seed)), hash3(ivec3(c, seed + 7))) * 0.8 + 0.1;
    vec2 r = g + o - f; float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(i, j); ivec2 c = ivec2(n + g);
    vec2 o = vec2(hash3(ivec3(c, seed)), hash3(ivec3(c, seed + 7))) * 0.8 + 0.1;
    vec2 r = g + o - f;
    if (dot(mr - r, mr - r) > 1e-5) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec3(md, n + mg);
}
// Fields inside a farm: the patchwork seen from the air. Long rectangles in rows that follow the farm's own
// direction; each row has its own depth and each field its own length, and the boundaries are jittered so no
// two fields match. Returns (distance to the field's edge in units of FS, row id, field id).
float fH(int a, int b, int s) { return hash3(ivec3(a, b, s)); }
vec3 fieldCell(vec2 p, float ang, float FS) {
  vec2 d = vec2(cos(ang), sin(ang));
  vec2 q = vec2(dot(p, d), dot(p, vec2(-d.y, d.x)));          // along the rows, across them
  float rowH = FS * 0.75;
  int r0 = int(floor(q.y / rowH)), r = r0;
  float y0 = 0.0, y1 = 0.0;
  for (int k = -1; k <= 1; k++) {
    int rr = r0 + k;
    float a = (float(rr) + 0.7 * (fH(rr, 0, 81) - 0.5)) * rowH, b = (float(rr + 1) + 0.7 * (fH(rr + 1, 0, 81) - 0.5)) * rowH;
    if (q.y >= a && q.y < b) { r = rr; y0 = a; y1 = b; }
  }
  float colW = FS * mix(1.1, 2.8, fH(r, 0, 83));
  float x = q.x + fH(r, 0, 85) * colW * 9.0;
  int c0 = int(floor(x / colW)), c = c0;
  float x0 = 0.0, x1 = 0.0;
  for (int k = -1; k <= 1; k++) {
    int cc = c0 + k;
    float a = (float(cc) + 0.8 * (fH(r, cc, 87) - 0.5)) * colW, b = (float(cc + 1) + 0.8 * (fH(r, cc + 1, 87) - 0.5)) * colW;
    if (x >= a && x < b) { c = cc; x0 = a; x1 = b; }
  }
  float dist = min(min(q.y - y0, y1 - q.y), min(x - x0, x1 - x));
  return vec3(dist / FS, float(r), float(c));
}
// a stylised but plausible crop palette (linear albedo)
vec3 cropCol(float h) {
  return h < 0.17 ? vec3(0.28, 0.19, 0.06)   // ripe wheat
       : h < 0.31 ? vec3(0.07, 0.15, 0.03)    // young cereal
       : h < 0.45 ? vec3(0.055, 0.1, 0.028)   // pasture
       : h < 0.57 ? vec3(0.1, 0.066, 0.042)   // ploughed earth
       : h < 0.67 ? vec3(0.24, 0.19, 0.08)    // stubble and hay
       : h < 0.75 ? vec3(0.45, 0.37, 0.035)   // rapeseed in flower
       : h < 0.9 ? vec3(0.11, 0.16, 0.04)     // maize, beet
       : h < 0.92 ? vec3(0.15, 0.11, 0.17)    // clover in bloom
       : vec3(0.16, 0.13, 0.065);             // fallow
}
vec2 gRel;
// ground-detail coordinates for a tile of T metres, seamless however far the camera travels
vec2 gUV(float T) { return (mod(uGBig, T) + uGSmall + gRel) / T; }
// ---------- around the launch base: laterite roads, two more launch pads, a small coastal town ----------
vec4 facilities(vec2 p, float foot) {
  float aa = max(foot, 0.6);
  // roads bend a little, but run dead straight where they leave the launch site's own ground (they line up with it)
  float d = roadDist(p);              // shared with the bush placement, so no bush stands on a road
  float road = 1.0 - smoothstep(4.0 - aa, 4.0 + aa, d);
  float verge = 1.0 - smoothstep(12.0, 20.0 + aa, d + (vnoise(vec3(p / 40.0, 3.0), 0) - 0.5) * 8.0);
  vec3 col = vec3(0.09, 0.1, 0.04) * (0.85 + 0.3 * vnoise(vec3(p / 12.0, 5.0), 0));
  float a = verge;
  // a dirt road: compacted brown earth, paler in the wheel tracks, darker at the crown and edges
  vec3 rc = mix(vec3(0.12, 0.094, 0.068), vec3(0.148, 0.102, 0.07), vnoise(vec3(p / 60.0, 7.0), 0)) * (0.85 + 0.3 * vnoise(vec3(p / 5.0, 9.0), 0));
  float trk = smoothstep(0.6, 1.3, d) * (1.0 - smoothstep(1.5, 2.4, d)) * smoothstep(3.0, 0.8, foot);
  rc *= 1.0 + 0.18 * trk - 0.12 * (1.0 - smoothstep(0.0, 0.5, d)) * smoothstep(3.0, 0.8, foot);
  col = mix(col, rc, road); a = max(a, road);
  for (int i = 0; i < 2; i++) {
    vec2 o = p - PADS[i];
    float r = length(o) + (vnoise(vec3(p / 120.0, float(i) * 9.0), 0) - 0.5) * 90.0;
    float clr = 1.0 - smoothstep(250.0, 256.0 + aa, r);
    if (clr > 0.0) {
      vec3 g = mix(vec3(0.1, 0.105, 0.045), vec3(0.15, 0.105, 0.072), smoothstep(150.0, 60.0, r)) * mix(0.6, 1.0, smoothstep(252.0, 225.0, r));   // grass outside, bare laterite inside, shade under the tree line
      float pad = 1.0 - smoothstep(32.0 - aa, 32.0 + aa, max(abs(o.x), abs(o.y)));
      g = mix(g, vec3(0.3, 0.29, 0.27), pad);
      vec2 bo = o - vec2(95.0, -40.0), bo2 = o - vec2(-70.0, 85.0);
      float bld = (1.0 - smoothstep(0.0, aa, max(abs(bo.x) - 22.0, abs(bo.y) - 11.0))) + (1.0 - smoothstep(0.0, aa, max(abs(bo2.x) - 9.0, abs(bo2.y) - 16.0)));
      g = mix(g, vec3(0.5, 0.5, 0.48), clamp(bld, 0.0, 1.0));
      col = mix(col, g, clr); a = max(a, clr);
    }
  }
  vec2 t = p - TOWN;
  float tr = length(t * vec2(1.0, 1.5)) + (vnoise(vec3(p / 500.0, 2.0), 0) - 0.5) * 450.0;
  float town = 1.0 - smoothstep(780.0, 900.0, tr);
  if (town > 0.0) {
    // a grid turned off north, bent a little, with main streets every ~150 m and side streets in some blocks
    float cr = cos(0.35), sr = sin(0.35);
    vec2 tp = mat2(cr, sr, -sr, cr) * t;
    tp += (vec2(vnoise(vec3(tp / 300.0, 4.0), 0), vnoise(vec3(tp / 300.0, 8.0), 0)) - 0.5) * 40.0;
    vec2 mb = floor(tp / 150.0), mf = fract(tp / 150.0);
    float dMain = min(0.5 - abs(mf.x - 0.5), 0.5 - abs(mf.y - 0.5)) * 150.0;
    float bh = hash3(ivec3(ivec2(mb), 11));
    float dSide = bh > 0.4 ? abs((bh > 0.7 ? mf.x : mf.y) - 0.5) * 150.0 : 1e3;
    float street = 1.0 - smoothstep(4.5, 4.5 + aa, min(dMain, dSide));
    // lots of ~17 m: a house on most, yard or a tree on the rest
    vec2 li = floor(tp / 17.0), lf = tp - (li + 0.5) * 17.0;
    float h1 = hash3(ivec3(ivec2(li), 3)), h2 = hash3(ivec3(ivec2(li), 4)), h3 = hash3(ivec3(ivec2(li), 5));
    vec2 hs = vec2(3.5 + 3.5 * h2, 3.0 + 3.0 * h3);
    vec2 hc = (vec2(h2, h3) - 0.5) * 4.0;
    float near = smoothstep(8.0, 10.0, min(dMain, dSide));
    float house = (1.0 - smoothstep(0.0, aa, max(abs(lf.x - hc.x) - hs.x, abs(lf.y - hc.y) - hs.y))) * step(0.3, h1) * near;
    float shade = (1.0 - smoothstep(0.0, aa, max(abs(lf.x - hc.x + 2.5) - hs.x, abs(lf.y - hc.y + 2.5) - hs.y))) * step(0.3, h1) * near * (1.0 - house);
    vec3 roofC = h1 < 0.5 ? vec3(0.42, 0.42, 0.4) : h1 < 0.75 ? vec3(0.26, 0.11, 0.07) : h1 < 0.9 ? vec3(0.55, 0.55, 0.52) : vec3(0.2, 0.24, 0.26);
    float treeN = vnoise(vec3(tp / 9.0, 6.0), 0);
    vec3 yard = mix(vec3(0.09, 0.1, 0.045), vec3(0.03, 0.055, 0.02) * (0.7 + 0.6 * treeN), smoothstep(0.5, 0.62, treeN));
    vec3 tc = mix(yard, vec3(0.13, 0.12, 0.11), street);
    tc = mix(tc, tc * 0.45, shade);
    tc = mix(tc, roofC * (0.85 + 0.3 * h3), house);
    tc = mix(tc, vec3(0.12, 0.11, 0.09), smoothstep(5.0, 20.0, foot));      // far away: the town's average colour
    col = mix(col, tc, town); a = max(a, town);
  }
  return vec4(col, a);
}

void main() {
  vec3 d = normalize(vDir);
  float b = dot(uCamPos, d);
  float discG = b * b - uCG;
  bool hitG = discG > 0.0 && b < 0.0;
  float tG = hitG ? uCG / (-b + sqrt(discG)) : 1e12;
  // with terrain on, the ground is wherever the terrain mesh was drawn (mountains rise above the sphere)
  vec4 tg = vec4(0.0);
  // (a hairline crack between terrain patches leaves no G-buffer sample: there the planet's surface stands in,
  // instead of the sky showing through as bright specks)
  if (uTerOn > 0.5) {
    ivec2 px = ivec2(gl_FragCoord.xy);
    tg = texelFetch(tTer, px, 0);
    // a crack or a patch skirt (marked by its height): borrow a neighbour's real ground sample
    if ((tg.x <= 0.0 && hitG) || tg.y < -1e5) {
      vec4 best = vec4(0.0);
      for (int k = 1; k <= 3 && best.x <= 0.0; k++) {
        vec4 n0 = texelFetch(tTer, px + ivec2(k, 0), 0), n1 = texelFetch(tTer, px - ivec2(k, 0), 0), n2 = texelFetch(tTer, px + ivec2(0, k), 0), n3 = texelFetch(tTer, px - ivec2(0, k), 0);
        if (n0.x > 0.0 && n0.y > -1e5) best = n0; else if (n1.x > 0.0 && n1.y > -1e5) best = n1; else if (n2.x > 0.0 && n2.y > -1e5) best = n2; else if (n3.x > 0.0 && n3.y > -1e5) best = n3;
      }
      if (best.x > 0.0) tg = vec4(tg.x > 0.0 ? tg.x : best.x, best.yzw);
      else if (tg.y < -1e5) tg.y = 0.0;
    }
    if (tg.x > 0.0) { hitG = true; tG = tg.x; } else if (!hitG) tG = 1e12;
  }
  // cloud shell: entry from above, exit from below
  float tC = -1.0, discC = b * b - uCC;
  if (uCC > 0.0) { if (discC > 0.0 && b < 0.0) tC = uCC / (-b + sqrt(discC)); }
  else tC = -b + sqrt(max(discC, 0.0));
  bool hitC = tC > 0.0 && tC < tG;

  // surface coordinates for every pixel (keeps texture derivatives valid)
  // the camera in the planet-fixed frame, and relative to the launch site, both worked out on the CPU in double
  // precision: rotating a 600 km vector here, and subtracting two of them, leaves centimetre-to-decimetre
  // rounding that changes every frame as the planet turns, and the ground would jitter under the rocket
  vec3 dF = toFixed(d), cF = uCamF;
  float tHit = hitG ? tG : max(-b, 0.0);
  vec3 sOff = uCamSite + dF * tHit;
  bool nearSite = dot(uCamSite, uCamSite) < 4e10;
  vec3 nF = nearSite ? normalize(uSite * uR + sOff) : normalize(cF + dF * tHit);
  vec2 uvG = lonlat(nF), gx = wrapGrad(dFdx(uvG)), gy = wrapGrad(dFdy(uvG));
  vec3 cnF = normalize(cF + dF * max(tC, 0.0));
  vec2 uvC = lonlat(cnF), cx = wrapGrad(dFdx(uvC)), cy = wrapGrad(dFdy(uvC));
  // position in a flat frame at the launch site, from the world-space offset: acos(dot()) of two nearly equal
  // unit vectors in 32-bit floats jumps in steps of hundreds of metres, which striped everything near the base
  vec3 sE0 = normalize(cross(vec3(0.0, 1.0, 0.0), uSite)), sN0 = cross(uSite, sE0);
  vec2 sP = vec2(dot(sOff, sE0), dot(sOff, sN0));
  float siteD = length(sP) < 2e5 ? length(sP) : acos(clamp(dot(nF, uSite), -1.0, 1.0)) * uR;
  vec3 locA = uCamRel + dF * min(tG, 2e6), dlx = dFdx(locA), dly = dFdy(locA);   // for mip selection of ground detail
  vec3 relG = dF * min(tG, 2e6);
  gRel = vec2(dot(relG, uGE), dot(relG, uGN));
  vec2 gdx = dFdx(gRel), gdy = dFdy(gRel);
  float vB = 1.0, vBw = 1.0;
  if (uTerOn > 0.5) { vB = valleyBig(nF * uR); vBw = max(fwidth(vB), 1e-6); }     // the big valleys' floors carry rivers

  vec3 col = vec3(0.0);
  float muV = dot(d, uSun);
  if (!hitG) {
    if (uEnv < 0.5) {
      col = stars(d);
      float sunR = 0.0075;
      float a = acos(clamp(muV, -1.0, 1.0));
      if (uSunDisc > 0.5 && a < sunR * 1.05) { float r = a / sunR; col += vec3(1.0, 0.97, 0.92) * 900.0 * (1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - r * r)))) * smoothstep(1.05, 0.95, r); }
      col += vec3(1.0, 0.95, 0.85) * (pow(max(muV, 0.0), 2500.0) * 25.0 * uSunDisc + pow(max(muV, 0.0), 200.0) * 0.6);
    }
  } else {
    // ---------- ground ----------
    float foot = tG * uPix;                         // metres covered by one pixel here
    bool ter = tg.x > 0.0;
    float H = ter ? tg.y : 0.0;                     // terrain height above sea level
    // The 8K maps are ~5 km (real) / 0.5 km (small planet) per texel. Up close, warp the lookups by
    // about a texel with noise so the bilinear grid never shows, then synthesize the detail below it.
    vec3 wp = nF * 1304.0;                          // ≈ texel units
    vec2 warp = vec2(vnoise(wp * 0.6, 0), vnoise(wp * 0.6 + 31.7, 0)) - 0.5;
    warp += 0.5 * (vec2(vnoise(wp * 2.1 + 5.1, 0), vnoise(wp * 2.1 + 9.4, 0)) - 0.5);
    vec2 uvW = uvG + warp * (1.9 / 8192.0);
    // never magnify the maps below ~2.5 texels per footprint: bilinear texels read as squares, a softer mip doesn't
    float tpx = max(length(gx), length(gy)) * 8192.0;
    vec2 bgx = gx * max(1.0, 2.5 / max(tpx, 1e-4)), bgy = gy * max(1.0, 2.5 / max(tpx, 1e-4));
    vec4 alb4 = textureGrad(tDay, uvW, bgx, bgy);
    vec4 dat = textureGrad(tData, uvW, gx, gy);
    vec3 alb = alb4.rgb * 0.92;
    // biome cues from the satellite colour: forest is dark and green, desert bright and red-yellow
    float lum0 = dot(alb, vec3(0.2126, 0.7152, 0.0722));
    float vegI = (alb.g - alb.r) / (alb.g + alb.r + 0.02);
    float forest = smoothstep(0.08, 0.18, vegI) * smoothstep(0.1, 0.06, lum0);
    float arid = smoothstep(0.1, 0.22, lum0) * smoothstep(-0.02, -0.09, vegI);
    float iceCap = smoothstep(0.42, 0.58, lum0) * smoothstep(0.08, 0.03, abs(vegI));
    alb *= 1.0 / (1.0 + 1.3 * lum0 * (1.0 - iceCap));   // satellite colours are contrast-stretched: bright desert read as snow
    float cn = vnoise(nF * 2200.0, 0) * 0.65 + vnoise(nF * 7100.0, 0) * 0.35;
    float wraw = dat.g + (cn - 0.5) * 0.45;
    float waterT = smoothstep(0.42, 0.58, wraw);
    float water = ter ? mix(waterT, smoothstep(-0.25, -1.0, H), uTerK) : waterT;   // H = 0 exactly is the flattened launch area: land
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), nF)), north = cross(nF, east);
    vec3 rl = textureGrad(tRelief, uvW, bgx * 0.5, bgy * 0.5).rgb * 2.0 - 1.0;
    // the relief map is coarse (1 km per pixel on the small planet): close up its bilinear facets would show, so soften it
    float rs = mix(1.2, 5.0, smoothstep(40.0, 800.0, foot));
    vec3 nrm = normalize(east * rl.x * rs + north * rl.y * rs + nF * max(rl.z, 0.2));
    float slope = 0.0, tSun = 1.0, tOpen = 0.6, coastSP0 = 9.0;
    vec3 nGeo = nF;
    if (ter) {
      vec2 en = (unpackHalf2x16(floatBitsToUint(tg.z)) - 1.0) * 2.0, sa = (unpackHalf2x16(floatBitsToUint(tg.w)) - 1.0) * 2.0;
      tSun = mix(1.0, sa.x, uTerK); tOpen = mix(0.6, sa.y, uTerK);
      vec3 nT = normalize(east * en.x + north * en.y + nF * sqrt(max(0.0, 1.0 - dot(en, en))));
      nGeo = nT;
      if (H < 120.0) coastSP0 = coastS(nF, landAt(tLonlat(nF)).x);
      nrm = normalize(mix(nrm, nT, uTerK));
      slope = (1.0 - dot(nT, nF)) * uTerK;          // 0 flat · 0.13 at 30° · 0.29 at 45°
      // where the satellite map still shows sea but the terrain rose above it, paint coastal plain
      alb = mix(alb, vec3(0.06, 0.07, 0.03), waterT * (1.0 - water) * uTerK);
    }
    float mu = dot(nF, uSunF);
    vec3 Tg = sunT(max(H, 0.0), mu);
    vec3 sp = normalize(nF * uRc + uSunF * ((uRc - uR) / max(mu, 0.15)));
    float shadowCov = siteCov(textureLod(tData, lonlat(sp), 3.0).r, sp);
    float cs = 1.0 - 0.75 * cloudAlpha(shadowCov, sp, 1.0, 1e9);
    // within the near layer's reach the shadow is cast by the same cloud shapes the camera sees overhead: the sun
    // ray from this ground point meets the layer, and what is there darkens the ground
    float nearG = uNoiseOn > 0.5 ? 1.0 - smoothstep(uVolMax * 1.5, uVolMax * 3.5, tG) : 0.0;
    if (nearG > 0.0) {
      vec3 pG0 = cF + dF * tG, pS0 = pG0 + uSunF * ((uRc - length(pG0)) / max(mu, 0.12));
      gFoot = 400.0;
      float sc = smoothstep(0.42, 0.62, cloudCov(pS0) * 1.15 + cloudShapeLo(uCloudRel + (pS0 - cF)));
      cs = mix(cs, 1.0 - 0.7 * sc, nearG);
    }
    // near the camera the shadows come from the volumetric clouds themselves (where the sun ray from this
    // ground point crosses the lower part of the layer), so every cumulus overhead drops its own shadow
    if (uVolK > 0.0 && tG < uVolMax) {
      vec3 pG = cF + dF * tG, pS = pG + uSunF * ((mix(uRb, uRt, 0.22) - length(pG)) / max(mu, 0.12));
      gFoot = 600.0;
      float dv = cloudDens(uCloudRel + (pS - cF), 0.22, cloudCov(pS), false);
      float csV = 1.0 - 0.55 * smoothstep(0.12, 0.3, dv);
      cs = mix(cs, csV, uVolK * smoothstep(uVolMax, uVolMax * 0.6, tG));
    }
    vec3 Eamb = uE * vec3(0.05, 0.085, 0.15) * smoothstep(-0.12, 0.35, mu) + uE * 0.0004;
    vec3 view = -dF;
    float landW = 1.0 - water;
    vec3 loc = uCamRel + dF * tG;
    // footprint stretched by the viewing angle: fine detail on slopes seen edge-on would only shimmer
    // A pixel seen at a shallow angle covers a long, thin strip of ground: sharp across, stretched along the
    // view. Fading detail by the long side throws away detail that is perfectly visible across; by the short
    // side it would shimmer along. The geometric mean of the two keeps the ground crisp without shimmering.
    float cosV = max(dot(nGeo, view), 0.015);
    float footA = foot * inversesqrt(cosV);
    float footL = foot / max(cosV, 0.04);              // the long side: for regular patterns (rows, stripes), which alias along it
    float graz = smoothstep(0.0, 0.05, cosV);          // only right at the horizon line, where it is all one smear

    // --- mountains: bare rock on steep ground, alpine meadow above the tree line, snow above the snow line ---
    float rock = 0.0, snow = 0.0, alpine = 0.0;
    float sandK = arid * smoothstep(0.22, 0.38, lum0);            // sand sea: its steep faces are dunes, not rock
    if (ter && H > 0.0) {
      float lat = abs(nF.y);
      float snowLine = (5300.0 - 3700.0 * pow(lat, 1.5)) * uTA;
      float sn = fbm(nF * (uR / 1100.0) + 4.0, 3), sn2 = vnoise(nF * (uR / 140.0) + 9.0, 0);
      float hs = H - snowLine + (sn - 0.45) * 900.0 * uTA + (sn2 - 0.5) * 160.0 * uTA;
      rock = smoothstep(0.1, 0.2, slope + (sn - 0.45) * 0.12) * landW * (1.0 - sandK);
      // snow clings to gentler ground; ridges and faces stay dark rock, broken up by drifts
      float drift = vnoise(nF * (uR / 260.0) + 3.0, 0);
      snow = smoothstep(-100.0, 150.0, hs) * (1.0 - smoothstep(0.14 + 0.12 * drift, 0.3 + 0.1 * drift, slope)) * landW;
      alpine = smoothstep(-1300.0 * uTA, -500.0 * uTA, hs) * landW;
      // layered rock: bands that follow height, bent by noise, with lighter and darker beds
      float strata = vnoise(vec3(H * 0.025 + sn * 6.0, nF.x * 900.0, nF.z * 900.0), 0);
      vec3 rockC = mix(vec3(0.05, 0.045, 0.04), vec3(0.15, 0.13, 0.11), strata) * mix(vec3(1.0), alb / max(lum0, 0.02) * 0.33 + 0.67, 0.5);
      vec3 meadow = mix(vec3(0.07, 0.08, 0.035), vec3(0.11, 0.1, 0.055), sn);
      alb = mix(alb, meadow, alpine * (1.0 - iceCap) * 0.75);
      alb = mix(alb, rockC, rock);
      alb = mix(alb, vec3(0.78, 0.8, 0.84) * (0.9 + 0.1 * sn), snow);
      forest *= (1.0 - alpine) * (1.0 - rock);
      arid *= 1.0 - rock;
    }

    // --- land: synthesized structure from 10 km down to a metre, each scale faded by pixel size ---
    float w10k = smoothstep(4000.0, 900.0, foot), w1k = smoothstep(600.0, 120.0, footA), w100 = smoothstep(40.0, 8.0, footA);
    float wPatch = smoothstep(1500.0, 300.0, foot);
    float awaySite = smoothstep(2500.0, 6000.0, siteD);
    float bare = max(rock, snow);
    if (w10k > 0.0) {
      float m1 = fbm(nF * (uR / 7000.0), 4), m2 = fbm(nF * (uR / 1800.0) + 3.1, 3);
      vec3 tint = mix(vec3(0.9, 1.03, 0.95), vec3(1.1, 1.03, 0.84), smoothstep(0.32, 0.68, m1));
      alb = mix(alb, alb * tint * (0.85 + 0.3 * m2), w10k * landW * (1.0 - snow));
    }
    // forest stands: crisp-edged patches of darker swamp forest and paler, drier woodland,
    // with open savanna glades here and there
    if (wPatch > 0.0) {
      float stand = fbmR(ROT * nF * (uR / 2600.0) + 11.0, 2);
      float glade = fbmR(ROT * nF * (uR / 1100.0) + 21.0, 2);
      float pa = smoothstep(0.44, 0.52, stand), pb = smoothstep(0.6, 0.66, stand);
      vec3 st = mix(vec3(0.78, 0.95, 0.9), vec3(1.0), pa);
      st = mix(st, vec3(1.18, 1.08, 0.78), pb);
      alb = mix(alb, alb * st, wPatch * landW * forest);
      float sav = smoothstep(0.66, 0.7, glade) * smoothstep(0.5, 0.56, stand) * awaySite * forest;
      vec3 savCol = mix(vec3(0.07, 0.085, 0.03), vec3(0.1, 0.1, 0.04), vnoise(nF * (uR / 220.0), 0));
      alb = mix(alb, savCol, sav * wPatch * landW * 0.6);
      forest *= 1.0 - sav * wPatch;
    }
    float tuft = 0.5, trees = 1.0;
    vec3 scrub = vec3(0.1, 0.12, 0.04);
    // relief at ~300 m and ~36 m: rolling crowns of forest, tussocks and hummocks elsewhere
    vec3 bump = vec3(0.0);
    float canopy = landW * trees * forest;
    float soft = landW * (1.0 - bare);
    if (w1k > 0.0) {
      vec3 q = ROT * nF * (uR / 300.0); float e = 0.3;
      float h0 = fbmR(q, 2), hx = fbmR(q + ROT * east * e, 2), hy = fbmR(q + ROT * north * e, 2);
      float r0 = 1.0 - abs(2.0 * vnoise(q * 2.7 + 7.0, 0) - 1.0);
      bump += (east * (h0 - hx) + north * (h0 - hy)) * 0.3 * w1k * soft * trees;
      alb = mix(alb, alb * (0.88 + 0.24 * h0) * (0.94 + 0.12 * r0), w1k * soft * graz);
    }
    if (w100 > 0.0) {
      float e = 0.25;
      vec3 q = ROT * nF * (uR / 36.0);
      float h0 = vnoise(q, 0), hx = vnoise(q + ROT * east * e, 0), hy = vnoise(q + ROT * north * e, 0);
      float c2 = vnoise(loc / 8.0, ${DETAIL_PERIOD / 8});
      // individual crowns, ~16 m: the texture that makes it read as trees rather than a carpet
      float cr = vnoise(loc / 16.0, ${DETAIL_PERIOD / 16}), crx = vnoise((loc + east * 4.0) / 16.0, ${DETAIL_PERIOD / 16}), cry = vnoise((loc + north * 4.0) / 16.0, ${DETAIL_PERIOD / 16});
      float wc = smoothstep(5.0, 1.5, footA);
      bump += (east * (h0 - hx) + north * (h0 - hy)) * 0.35 * w100 * soft * trees * (1.0 - forest);
      alb = mix(alb, alb * (0.86 + 0.28 * h0) * (0.92 + 0.16 * c2), w100 * soft * (1.0 - forest) * graz);
      // open ground: tussocks and bare patches
      float tus = vnoise(loc / 2.0, ${DETAIL_PERIOD / 2});
      alb = mix(alb, alb * (0.75 + 0.5 * tus), wc * soft * (1.0 - forest) * (1.0 - arid));
      scrub *= 0.85 + 0.3 * c2;
    }
    // open, non-forest ground: tussocks, bare soil and shrubs at metre scales (mipmapped, so it calms with distance)
    float openK = soft * (1.0 - forest) * (1.0 - sandK);
    if (openK > 0.0 && footA < 60.0) {
      float g1 = textureGrad(tGround, gUV(40.0) + 0.29, gdx / 40.0, gdy / 40.0).b, g2 = textureGrad(tGround, gUV(12.0) + 0.83, gdx / 12.0, gdy / 12.0).g;
      float g3 = textureGrad(tGround, gUV(300.0) + 0.47, gdx / 300.0, gdy / 300.0).g;
      alb = mix(alb, alb * (0.78 + 0.44 * g1) * (0.82 + 0.36 * g2) * mix(vec3(1.08, 1.0, 0.85), vec3(0.9, 1.04, 1.0), g3), openK * smoothstep(60.0, 12.0, footA));
    }
    // open lowland: a patchwork of fields with hedgerows and crop rows
    float farm = soft * trees * (1.0 - forest) * (1.0 - arid) * (1.0 - alpine) * (1.0 - iceCap) * awaySite
               * smoothstep(0.42, 0.56, fbm(nF * (uR / 30000.0) + 7.0, 2)) * (1.0 - smoothstep(900.0, 1400.0, H / uTA));
    if (farm > 0.0 && footA < 90.0) {
      vec3 pF0 = nF * (uR / 230.0);
      vec3 pF = pF0 + (vec3(vnoise(pF0 * 0.23, 0), vnoise(pF0 * 0.23 + 3.3, 0), vnoise(pF0 * 0.23 + 7.1, 0)) - 0.5) * 0.8;   // bent boundaries
      vec3 fl = floor(pF), fr = fract(pF);
      vec3 ax = abs(nF), use = 1.0 - smoothstep(0.55, 0.75, ax);         // ignore the grid axis that runs into the ground
      // split many fields into two strips along one of the grid axes, at a random place
      float fs = hash3(ivec3(fl) + 9), cut = 0.3 + 0.4 * hash3(ivec3(fl) + 13);
      int sa = fs < 0.33 ? 0 : fs < 0.66 ? 1 : 2;
      float frs = sa == 0 ? fr.x : sa == 1 ? fr.y : fr.z, side = step(cut, frs) * step(0.25, fs * use[sa]);
      ivec3 fid = ivec3(fl) + ivec3(int(side) * 17);
      float fh = hash3(fid), fh2 = hash3(fid + 5);
      vec3 crop = fh < 0.25 ? vec3(1.17, 1.08, 0.74) : fh < 0.5 ? vec3(0.86, 1.0, 0.83) : fh < 0.68 ? vec3(1.08, 0.94, 0.8) : vec3(0.98, 1.08, 0.9);
      crop *= 0.9 + 0.2 * fh2;
      vec3 fw = (abs(dlx) + abs(dly)) / 230.0, ed = min(fr, 1.0 - fr);
      vec3 e3 = (1.0 - smoothstep(vec3(0.008) + fw, vec3(0.018) + fw * 2.0, ed)) * use * step(0.45, hash3(ivec3(fl) + 21));
      float ec = (1.0 - smoothstep(0.004 + fw[sa], 0.01 + fw[sa] * 2.0, abs(frs - cut))) * step(0.25, fs * use[sa]) * 0.6;
      float hedge = max(max(max(e3.x, e3.y), e3.z), ec);
      float rows = 0.92 + 0.08 * sin(dot(loc, fh2 < 0.5 ? east : north) * 2.4);
      float k = farm * smoothstep(90.0, 25.0, footA) * mix(0.5, 1.0, graz);
      alb = mix(alb, alb * mix(crop * mix(1.0, rows, smoothstep(2.0, 0.7, footA)), vec3(0.6, 0.75, 0.5), hedge * 0.7), k);
    }
    // desert: dune fields with sharp crests where it is sand, gravel plains where it is darker
    float sand = sandK * landW * (1.0 - bare);
    alb = mix(alb, alb * vec3(1.0, 0.84, 0.66) * 0.82, sand);      // warmer, deeper sand tone
    if (sand > 0.0 && footA < 500.0) {
      float wd = smoothstep(500.0, 60.0, footA);
      vec3 q = ROT * nF * (uR / 420.0); float e = 0.08;
      vec3 qw = q + (vec3(vnoise(q * 0.23, 0), vnoise(q * 0.23 + 4.0, 0), 0.0) - 0.5) * 2.0;
      float d0 = 1.0 - abs(2.0 * vnoise(qw, 0) - 1.0), dx = 1.0 - abs(2.0 * vnoise(qw + ROT * east * e, 0) - 1.0), dy = 1.0 - abs(2.0 * vnoise(qw + ROT * north * e, 0) - 1.0);
      d0 *= d0; dx *= dx; dy *= dy;
      bump += (east * (d0 - dx) + north * (d0 - dy)) * 3.0 * wd * sand;
      alb = mix(alb, alb * (0.86 + 0.24 * d0), wd * sand);
      float rip = vnoise(loc / 2.0, ${DETAIL_PERIOD / 2});
      alb = mix(alb, alb * (0.92 + 0.16 * rip), smoothstep(4.0, 1.0, footA) * sand);
    }
    float grit = arid * (1.0 - sand) * landW;
    if (grit > 0.0 && footA < 30.0) {
      float pb = vnoise(loc, ${DETAIL_PERIOD}), pb2 = vnoise(loc / 8.0 + 3.0, ${DETAIL_PERIOD / 8});
      alb = mix(alb, alb * (0.7 + 0.45 * pb) * (0.85 + 0.3 * pb2), smoothstep(30.0, 4.0, footA) * grit);
    }
    // wind-packed snow: soft sastrugi ripples and drifts, close up
    if (snow > 0.0 && footA < 120.0) {
      vec3 q = loc / 8.0; float e = 0.3;
      float h0 = vnoise(q, ${DETAIL_PERIOD / 8}), hx = vnoise(q + east * e, ${DETAIL_PERIOD / 8}), hy = vnoise(q + north * e, ${DETAIL_PERIOD / 8});
      bump += (east * (h0 - hx) + north * (h0 - hy)) * 0.35 * smoothstep(120.0, 15.0, footA) * snow;
    }
    // crags and scree on bare rock, close up
    if (rock > 0.0 && footA < 200.0) {
      vec3 q = loc / 8.0; float e = 0.25;
      float h0 = vnoise(q, ${DETAIL_PERIOD / 8}), hx = vnoise(q + east * e, ${DETAIL_PERIOD / 8}), hy = vnoise(q + north * e, ${DETAIL_PERIOD / 8});
      float wr = smoothstep(200.0, 20.0, footA);
      bump += (east * (h0 - hx) + north * (h0 - hy)) * 3.0 * wr * rock;
      alb = mix(alb, alb * (0.65 + 0.7 * h0), wr * rock);
    }
    // ---------- countryside around the base: meadows, a patchwork of fields and hedgerows, copses, lakes ----------
    // Every scale fades in only once a pixel can resolve it (footA = metres per pixel), so the land gains
    // detail continuously on the way down: land-use regions from orbit, farms from 20 km, fields from 10 km,
    // mottling, hedgerow trees and copses from 3 km, tramlines below 100 m, crop rows and grass at the bottom.
    float lakeK = 0.0, lakeDep = 0.0, shoreK = 0.0;
    vec3 furrowN = vec3(0.0);
    float cty = (1.0 - smoothstep(55000.0, 85000.0, siteD)) * landW * (1.0 - bare) * (1.0 - sandK) * (1.0 - iceCap) * (1.0 - alpine);
    if (cty > 0.001) {
      vec2 p = sP;
      vec2 sun2 = normalize(vec2(dot(uSunF, sE0), dot(uSunF, sN0)) + 1e-5);
      float sunUp = max(dot(nF, uSunF), 0.12), shLen = clamp(sqrt(max(0.0, 1.0 - sunUp * sunUp)) / sunUp, 0.3, 4.0);   // shadow length per metre of height
      // boundaries wander at two scales, like real field edges following old lanes and streams
      vec2 pw = p + (vec2(vnoise(vec3(p / 900.0, 1.0), 0), vnoise(vec3(p / 900.0, 5.0), 0)) - 0.5) * 150.0
                  + (vec2(vnoise(vec3(p / 420.0, 13.0), 0), vnoise(vec3(p / 420.0, 15.0), 0)) - 0.5) * 70.0
                  + (vec2(vnoise(vec3(p / 230.0, 3.0), 0), vnoise(vec3(p / 230.0, 9.0), 0)) - 0.5) * 30.0 * smoothstep(60.0, 8.0, footA);
      float lu = landUse(p), m1 = fbm(vec3(p / 2400.0, 8.0), 3), m2 = vnoise(vec3(p / 420.0, 2.0), 0);
      float m3 = fbm(vec3(p / 650.0, 17.0), 3);
      // meadow: greens varying by hillside, swathe and patch, gold on drier high ground, russet heath
      float dry = clamp(smoothstep(0.38, 0.75, m1) * 0.7 + smoothstep(80.0, 700.0, H / uTA) * 0.6, 0.0, 1.0);
      vec3 cc = mix(vec3(0.036, 0.06, 0.022), vec3(0.066, 0.074, 0.03), smoothstep(0.3, 0.7, m3));
      cc *= 0.85 + 0.3 * m2;
      cc = mix(cc, vec3(0.075, 0.066, 0.035), dry * 0.5);
      float heath = smoothstep(0.63, 0.7, fbm(vec3(p / 3600.0, 12.0), 3)) * (1.0 - smoothstep(0.38, 0.5, lu));
      cc = mix(cc, vec3(0.12, 0.08, 0.055), heath * 0.7);
      cc = mix(cc, vec3(0.03, 0.065, 0.022), (1.0 - smoothstep(0.0, 0.08, vB)) * 0.5);      // lush valley floors
      // meadow texture at 150 m and 40 m: damp and dry patches, worn ground, scrub clumps
      float kM = smoothstep(40.0, 6.0, footA);
      if (kM > 0.0) {
        float mt = fbm(vec3(p / 150.0, 31.0), 3), mt2 = vnoise(vec3(p / 40.0, 33.0), 0);
        cc *= mix(1.0, (0.78 + 0.44 * mt) * (0.88 + 0.24 * mt2), kM);
        cc = mix(cc, cc * vec3(1.35, 1.2, 0.8), smoothstep(0.62, 0.72, mt) * kM * 0.6);   // sun-bleached patches
      }
      // scattered shrubs and bushes (3–8 m), each with a shadow: the meadow's texture between 100 m and 1 km
      // bushes: the same ones the 3D scatter stands near the camera (shared placement), drawn here as lit,
      // lumpy discs with shadows wherever the 3D ones are not shown
      float bDens = (footA < 10.0) ? bushDensity(p) : 0.0;
      // kS: painted bushes (where the 3D ones are not drawn); kSh: their shadows, always (the sun's shadow map
      // only covers the ground round the rocket, so the 3D bushes' shadows are painted here too)
      float kSh = smoothstep(6.0, 1.5, footA);
      float kS = kSh * (uBush3D > 0.5 ? smoothstep(190.0, 250.0, tG) : 1.0);
      if (kSh > 0.0) {
        float dens = bDens;
        if (dens > 0.0) {
          ivec2 c0 = ivec2(floor(p / ${BUSH_CELL.toFixed(1)}));
          float cov = 0.0, shd = 0.0; vec3 bcol = vec3(0.0);
          for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
            vec2 bp; float bid; ivec2 cc2 = c0 + ivec2(i, j);
            float br = bushAt(cc2, dens, bp, bid);
            if (br <= 0.0) continue;
            vec2 o = p - bp; float dl = length(o), an = atan(o.y, o.x);
            float lump = 1.0 + 0.16 * sin(an * 5.0 + bid * 31.0) * sin(an * 3.0 + bid * 17.0);
            float aa = max(footA, 0.05) * 1.2;
            float cv = 1.0 - smoothstep(br * lump - aa, br * lump + aa, dl);
            // shadow: the same lump thrown away from the sun
            float ds = length(p - (bp - sun2 * br * shLen));
            shd = max(shd, (1.0 - smoothstep(br * 0.95 - aa, br * 0.95 + aa, ds)));
            if (cv > cov) {
              vec2 nn = o / max(br, 0.1);
              float lit = clamp(0.72 + 0.5 * dot(nn, sun2) + 0.25 * sqrt(max(0.0, 1.0 - dot(nn, nn))), 0.35, 1.3);
              bcol = mix(vec3(0.022, 0.04, 0.014), vec3(0.034, 0.044, 0.016), bid) * lit * (0.85 + 0.3 * bHash(cc2, 99));
              cov = cv;
            }
          }
          cc *= 1.0 - 0.5 * shd * (1.0 - cov * kS) * kSh;
          cc = mix(cc, bcol * 1.15, cov * kS);
        }
      }
      // too small to draw one by one: scrub just darkens the meadow by how much of it the bushes cover
      cc *= 1.0 - 0.32 * (footA < 10.0 ? bDens : bushDensity(p)) * smoothstep(2.0, 10.0, footA);
      vec3 grassBase = cc;
      // farmland: farms (~1.5 km) share a field size and a few crops; fields inside them; hedges and lanes between
      float farmK = farmMask(p, siteD) * (1.0 - smoothstep(0.08, 0.14, slope)) * smoothstep(0.1, 0.24, coastSP0 + (m2 - 0.5) * 0.08);   // the coast is dunes and scrub, not fields
      float hedgeT = 0.0, hedgeSh = 0.0;
      if (farmK > 0.0) {
        // farms: big irregular blocks (a strongly warped cellular pattern, so they never read as a honeycomb)
        vec2 pf = pw + (vec2(vnoise(vec3(p / 3200.0, 21.0), 0), vnoise(vec3(p / 3200.0, 23.0), 0)) - 0.5) * 900.0;
        vec3 vp = vorE(pf / 1500.0, 61);
        float ph = hash3(ivec3(ivec2(vp.yz), 63)), ph2 = hash3(ivec3(ivec2(vp.yz), 67));
        vec3 parcel = mix(cropCol(fract(ph * 1.7)), cropCol(fract(ph * 3.1 + 0.3)), 0.5);
        vec3 fc = mix(vec3(0.1, 0.095, 0.042), parcel, smoothstep(3500.0, 900.0, footA));     // far: the farm's average tone
        float wF = smoothstep(160.0, 35.0, footA);
        if (wF > 0.0) {
          float FS = mix(170.0, 380.0, ph2);                      // each farm its own field size
          float angF = ph * 3.1416;                               // the farm's layout direction
          vec3 v = fieldCell(pw, angF, FS);
          ivec2 id = ivec2(v.yz) + ivec2(vp.yz) * 977;
          float h1 = hash3(ivec3(id, 41)), h2 = hash3(ivec3(id, 43)), h3 = hash3(ivec3(id, 47)), h4 = hash3(ivec3(id, 53));
          float ang = angF + (h2 > 0.72 ? 1.5708 : 0.0);           // crop rows along the field, now and then across it
          vec2 dir = vec2(cos(ang), sin(ang));
          float sdir = dot(p, dir), across = dot(p, vec2(-dir.y, dir.x));
          // many fields are split into long strips (different crop or growth in each)
          float strip = h3 > 0.5 ? floor(across / mix(35.0, 80.0, h1)) : 0.0;
          float hs = hash3(ivec3(id * 7 + ivec2(int(strip), 0), 59));
          // strips: mostly the same crop at another stage of growth, now and then a different one
          float cpick = fract(h1 * 0.55 + ph * 0.6 + (h3 > 0.5 && hs > 0.78 ? 0.31 : 0.0));
          vec3 crop = cropCol(cpick) * (0.86 + 0.28 * h3) * (0.9 + 0.2 * m2) * (h3 > 0.5 ? 0.88 + 0.24 * hs : 1.0);
          crop = mix(crop, grassBase * (0.9 + 0.25 * h2), step(0.6, h4));                 // many fields left as meadow and pasture
          crop = mix(crop, mix(crop, vec3(dot(crop, vec3(0.3, 0.55, 0.15))), 0.25), 1.0);  // a touch less saturated: real fields are muted
          // inside a field: soil and moisture mottling at 90 m and 25 m, darker headland round the edge
          float bd = v.x * FS;
          float kD = smoothstep(45.0, 6.0, footA);
          if (kD > 0.0) {
            float mo = fbm(vec3(p / 90.0, h1 * 7.0), 3), mo2 = vnoise(vec3(p / 25.0, h2 * 5.0), 0);
            crop *= mix(1.0, (0.68 + 0.64 * mo) * (0.86 + 0.28 * mo2), kD);
            crop *= mix(1.0, 0.86, (1.0 - smoothstep(6.0, 12.0, bd)) * kD);
          }
          // machinery passes: alternate swaths ~9 m wide a shade lighter and darker, the classic look of fields from the air
          {
            float sw = across / mix(7.0, 12.0, h2), sa = fwidth(sw) + 1e-4;
            float pass = smoothstep(0.5 - sa, 0.5 + sa, abs(fract(sw) - 0.5) * 2.0);
            crop *= mix(1.0, 0.92 + 0.16 * pass, smoothstep(5.0, 1.5, footL) * (1.0 - step(0.6, h4)) * step(0.25, h2));
          }
          float tw = fwidth(sdir);
          float tram = 1.0 - smoothstep(0.35 - tw, 0.35 + tw, abs(fract(sdir / 21.0) - 0.5) * 21.0);
          float rows = 0.5 + 0.5 * sin(across * 7.85);
          float plough = step(0.45, h1) * step(h1, 0.57);
          crop *= mix(1.0, 0.88, tram * smoothstep(4.0, 1.2, footL) * (1.0 - step(0.6, h4)));
          crop *= mix(1.0, 0.82 + 0.3 * rows * (1.0 + plough), smoothstep(0.32, 0.12, footL) * (1.0 - step(0.6, h4)));
          // the rows and furrows themselves: ridges 0.8 m apart that a low sun picks out
          {
            vec3 acrossV = sE0 * (-dir.y) + sN0 * dir.x;
            float rk = smoothstep(0.3, 0.1, footL) * (1.0 - step(0.6, h4)) * graz;
            furrowN += acrossV * cos(across * 7.85) * (plough > 0.5 ? 0.5 : 0.16) * rk;
          }
          // borders: hedgerows (with trees along them) or pale grass margins; lanes between farms
          float bw = fwidth(bd) + 0.3;
          bool hedge = h3 < 0.3;                                  // hedges on some borders; most fields just meet
          float hedgeW = hedge ? 3.0 : 1.2;
          float border = 1.0 - smoothstep(hedgeW - bw, hedgeW + bw, bd);
          vec3 bc = hedge ? vec3(0.016, 0.032, 0.011) : vec3(0.07, 0.085, 0.034);
          // a hedge thinner than a pixel is mostly field colour: seen from high up, fields meet softly
          crop = mix(crop, bc, border * (hedge ? 1.0 : 0.5) * mix(1.0, 0.35, smoothstep(1.5, 6.0, footA)));
          float lane = 1.0 - smoothstep(2.5 - fwidth(vp.x * 1500.0), 2.5 + fwidth(vp.x * 1500.0), vp.x * 1500.0);
          crop = mix(crop, vec3(0.12, 0.1, 0.075), lane * smoothstep(12.0, 3.0, footA));
          // hedgerow trees: crowns from the cellular detail texture, only along hedges, each with its shadow
          float kT = smoothstep(6.0, 1.5, footA);
          if (hedge && kT > 0.0) {
            float crown = textureGrad(tGround, gUV(26.0), gdx / 26.0, gdy / 26.0).r;
            float along = (1.0 - smoothstep(4.0, 7.5, bd)) * step(0.35, hash3(ivec3(id, 71)));
            hedgeT = smoothstep(0.35, 0.6, crown) * along * kT;
            vec3 vs = fieldCell(pw - sun2 * 9.0 * shLen, angF, FS);
            hedgeSh = (1.0 - smoothstep(4.0, 9.0, vs.x * FS)) * step(0.35, hash3(ivec3(ivec2(vs.yz) + ivec2(vp.yz) * 977, 71))) * kT * (1.0 - hedgeT);
          }
          fc = mix(fc, crop, wF);
        }
        cc = mix(cc, fc, farmK);
      }
      // copses: small woods scattered in the meadows and between fields (crown texture, lit from the sun)
      float cop = copseField(p);
      float ca = fwidth(cop) + 1e-4;
      float copK = smoothstep(0.63 - ca, 0.63 + ca, cop) * smoothstep(420.0, 700.0, siteD) * (1.0 - smoothstep(0.1, 0.18, slope));
      if (copK > 0.0) {
        vec3 wood = vec3(0.018, 0.034, 0.012);
        float kW = smoothstep(12.0, 2.0, footA);
        if (kW > 0.0) {
          float c1 = textureGrad(tGround, gUV(48.0) + 0.3, gdx / 48.0, gdy / 48.0).r;
          float c1s = textureGrad(tGround, gUV(48.0) + 0.3 + sun2 * 3.0 / 48.0, gdx / 48.0, gdy / 48.0).r;
          wood *= mix(1.0, (0.55 + 0.9 * c1) * clamp(1.0 + (c1s - c1) * 2.2, 0.55, 1.6), kW);
        }
        cc = mix(cc, wood, copK);
      }
      // the shadow a wood throws on the field beside it
      float copS = smoothstep(0.63 - ca, 0.63 + ca, fbm(vec3((p - sun2 * 14.0 * shLen) / 800.0, 41.0), 3) + (vnoise(vec3((p - sun2 * 14.0 * shLen) / 120.0, 43.0), 0) - 0.5) * 0.08) * smoothstep(420.0, 700.0, siteD);
      cc *= 1.0 - 0.45 * copS * (1.0 - copK) * smoothstep(30.0, 6.0, footA);
      // hedgerow trees and their shadows
      cc = mix(cc, vec3(0.02, 0.04, 0.014) * (0.7 + 0.6 * smoothstep(0.35, 0.8, textureGrad(tGround, gUV(26.0) + sun2 * 1.5 / 26.0, gdx / 26.0, gdy / 26.0).r)), hedgeT * farmK);
      cc *= 1.0 - 0.45 * hedgeSh * farmK;
      // lakes: in the flat ground, ringed by reeds and a thin pale shore
      float lk = lakeField(p) + (vnoise(vec3(p / 500.0, 2.0), 0) - 0.5) * 0.03 + (vnoise(vec3(p / 90.0, 4.0), 0) - 0.5) * 0.012 * smoothstep(20.0, 4.0, footA);
      float rW = reliefW(nF, siteD);
      float thr = 0.64 + smoothstep(0.015, 0.06, slope) * 0.6 + (1.0 - smoothstep(600.0, 1100.0, siteD)) * 0.6 + smoothstep(0.0, 0.3, rW);
      float la = fwidth(lk) + 1e-4;
      lakeK = smoothstep(thr - la, thr + la, lk) * cty;
      lakeDep = max(lakeDep, (lk - thr) * 900.0);           // a depth in metres, roughly, for the colour: shelves off quickly
      float reed = smoothstep(thr - 0.04, thr - 0.012, lk) * (1.0 - lakeK);
      cc = mix(cc, vec3(0.04, 0.08, 0.028), reed * 0.8);
      cc = mix(cc, vec3(0.06, 0.052, 0.036), smoothstep(thr - 0.006 - la, thr - 0.001, lk) * (1.0 - lakeK) * 0.6);
      // lakes in the hollows of the rolling ground round the base: the water lies level, the shore follows the land
      if (rW > 0.15) {
        float rs = reliefShape(nF);
        float d = (LAKE_LV - rs) * RELIEF_K * uTA * rW;                  // metres below the water line (negative: above it)
        float aw = fwidth(d) + 0.02;
        float lk2 = smoothstep(-aw, aw, d) * smoothstep(0.15, 0.35, rW) * smoothstep(18.0, 40.0, roadDist(p));
        lakeK = max(lakeK, lk2 * cty); lakeDep = max(d, 0.0);
        // the shore: wet mud and sand a metre or so up, reed beds in patches along it
        float nz = vnoise(vec3(p / 35.0, 21.0), 0), nz2 = vnoise(vec3(p / 9.0, 23.0), 0);
        shoreK = (1.0 - smoothstep(0.0, 1.4 + 1.2 * nz, -d)) * (1.0 - lk2) * smoothstep(0.15, 0.35, rW);
        vec3 mud = mix(vec3(0.06, 0.05, 0.035), vec3(0.14, 0.12, 0.085), smoothstep(-0.2, -1.2, d));
        cc = mix(cc, mud * (0.8 + 0.4 * nz2), shoreK * 0.85);
        float reeds = smoothstep(0.55, 0.7, nz) * (1.0 - smoothstep(0.0, 0.9, abs(d + 0.1))) * smoothstep(0.15, 0.35, rW);
        cc = mix(cc, vec3(0.05, 0.07, 0.025) * (0.7 + 0.6 * nz2), reeds);
        lakeK *= 1.0 - reeds * 0.9;
      }
      // close up: grass, clover and bare patches from the mipmapped detail texture, finer the closer you get
      float g1 = textureGrad(tGround, gUV(40.0) + 0.29, gdx / 40.0, gdy / 40.0).b, g2 = textureGrad(tGround, gUV(12.0) + 0.83, gdx / 12.0, gdy / 12.0).g;
      float g3 = textureGrad(tGround, gUV(3.0) + 0.61, gdx / 3.0, gdy / 3.0).g;
      cc *= mix(1.0, (0.7 + 0.6 * g1) * (0.78 + 0.44 * g2), smoothstep(80.0, 12.0, footA) * graz);
      cc *= mix(1.0, 0.7 + 0.6 * g3, smoothstep(2.0, 0.4, footA) * graz);
      // a real meadow is patchy: straw-dry swathes, lush dark clumps, clover, worn and bare spots
      {
        float kP = smoothstep(14.0, 2.0, footA) * graz * (1.0 - farmK) * (1.0 - shoreK);
        if (kP > 0.0) {
          float q1 = fbm(vec3(p / 22.0, 81.0), 3), q2 = vnoise(vec3(p / 6.0, 83.0), 0), q3 = vnoise(vec3(p / 2.2, 85.0), 0);
          float dryP = smoothstep(0.55, 0.68, q1 + (q2 - 0.5) * 0.25);
          float lushP = smoothstep(0.42, 0.3, q1 + (q2 - 0.5) * 0.2);
          float bareP = smoothstep(0.8, 0.88, q2 * 0.6 + q3 * 0.5) * smoothstep(3.0, 0.8, footA);
          vec3 mc = cc;
          mc = mix(mc, vec3(0.12, 0.105, 0.05) * (0.85 + 0.3 * q3), dryP * 0.8);
          mc = mix(mc, vec3(0.03, 0.058, 0.02), lushP * 0.7);
          mc = mix(mc, vec3(0.085, 0.068, 0.048), bareP);
          cc = mix(cc, mc, kP);
        }
      }
      // close to the ground: tufts lighter and yellower on their sunny tops, darker blue-green in between
      cc = mix(cc, cc * mix(vec3(0.75, 0.85, 0.95), vec3(1.25, 1.18, 0.85), g3), smoothstep(1.5, 0.3, footA) * graz * (1.0 - farmK * 0.6));
      alb = mix(alb, cc, cty);
      forest *= 1.0 - cty;
      // gentle relief below the terrain mesh's resolution: swells and hollows at 300 m and 70 m
      bump *= 1.0 - cty;
      // relief finer than the terrain mesh, each scale only once a pixel can show it: swells (300 m), hummocks
      // (70 m, 18 m), lumps (5 m), tussocks (1 m). A low sun picks them all out.
      if (cty > 0.0 && footA < 60.0) {
        vec2 g = reliefSlope(p, 300.0, 51.0, 7.0) * smoothstep(60.0, 12.0, footA)
               + reliefSlope(p, 70.0, 53.0, 2.0) * smoothstep(20.0, 4.0, footA)
               + reliefSlope(p, 18.0, 55.0, 0.9) * smoothstep(6.0, 1.2, footA)
               + reliefSlope(p, 5.0, 57.0, 0.3) * smoothstep(1.6, 0.35, footA)
               + reliefSlope(p, 1.1, 59.0, 0.09) * smoothstep(0.35, 0.08, footA) * (1.0 - farmK * 0.7);
        g *= (1.0 - lakeK) * graz;
        bump -= (sE0 * g.x + sN0 * g.y) * cty;
      }
      bump += furrowN * cty * (1.0 - lakeK) * (1.0 - copK);
    }
    nrm = normalize(nrm + bump * landW);
    // rivers: meandering channels through the forest (anti-aliased lines on a noise contour)
    float poolK = 0.0;
    // the coastal lowland: dark mangrove right at the shore, then open savanna with tree clumps and marsh pools
    if (ter && coastSP0 < 4.0 && H > 0.0) {
      float sv = coastSP0;
      float mang = (1.0 - smoothstep(0.25, 0.6, sv)) * landW * (1.0 - bare);
      float region = smoothstep(0.42, 0.56, fbm(nF * (uR / 6000.0) + 2.0, 3)) * smoothstep(0.35, 0.7, sv) * (1.0 - smoothstep(2.5, 4.0, sv));
      float openSat = (1.0 - forest) * (1.0 - sandK) * smoothstep(0.35, 0.7, sv) * (1.0 - smoothstep(2.5, 4.0, sv));   // pale open ground in the satellite map
      float sav = max(region, openSat) * landW * (1.0 - bare) * smoothstep(1300.0, 2000.0, siteD);
      if (sav > 0.0) {
        float t1 = textureGrad(tGround, gUV(220.0) + 0.6, gdx / 220.0, gdy / 220.0).b, t2 = textureGrad(tGround, gUV(900.0) + 0.2, gdx / 900.0, gdy / 900.0).g;
        vec3 grass = mix(vec3(0.075, 0.095, 0.032), vec3(0.11, 0.112, 0.045), t2) * (0.9 + 0.2 * textureGrad(tGround, gUV(30.0), gdx / 30.0, gdy / 30.0).g);
        float clump = smoothstep(0.55, 0.75, t1 + (t2 - 0.5) * 0.6);
        vec3 sc = mix(grass, alb * 0.75, clump);
        float pool = smoothstep(0.7, 0.74, textureGrad(tGround, gUV(1600.0) + 0.4, gdx / 1600.0, gdy / 1600.0).g) * (1.0 - clump);
        alb = mix(alb, sc, sav);
        poolK = pool * sav;
      }
      alb = mix(alb, alb * vec3(0.62, 0.82, 0.78), mang);
    }
    // roads, launch pads and a town around the base
    if (ter && siteD < 16000.0) {
      vec4 fac = facilities(sP, foot);
      alb = mix(alb, fac.rgb, fac.a * landW);
    }
    // blast marks: charred ground out to the scorch radius, a dark bowl with a raised rim of thrown-out earth
    for (int i = 0; i < 8; i++) {
      if (i >= uCraterN) break;
      vec4 cr = uCrater[i];
      vec2 dd = sP - cr.xy; float r = length(dd);
      if (r > cr.w * 1.3 && r > cr.z * 2.5) continue;
      float nz = fbm(vec3(sP / max(cr.z, 20.0) * 1.7, 5.0 + float(i)), 3), nz2 = vnoise(vec3(sP / 6.0, 9.0), 0);
      float ch = 1.0 - smoothstep(cr.w * (0.35 + 0.3 * nz), cr.w * (0.9 + 0.3 * nz), r);
      vec3 ash = vec3(0.035, 0.03, 0.026) * (0.8 + 0.4 * nz2);
      alb = mix(alb, mix(alb * 0.55, ash, 0.7), ch * landW);
      if (cr.z > 0.0) {
        float q = r / cr.z;
        float bowl = 1.0 - smoothstep(0.9, 1.02, q);
        float rim = smoothstep(0.85, 1.0, q) * (1.0 - smoothstep(1.0, 1.9 + 0.4 * nz, q));
        alb = mix(alb, vec3(0.05, 0.042, 0.035) * (0.75 + 0.5 * nz2), bowl * landW);
        alb = mix(alb, vec3(0.11, 0.085, 0.06) * (0.8 + 0.4 * nz), rim * 0.8 * landW);
        // shape: a parabolic bowl about a third as deep as it is wide, and the lip sloping away outside
        float g = q < 1.0 ? 0.7 * q : -0.9 * exp(-(q - 1.0) * 3.0);
        vec3 radial = (sE0 * dd.x + sN0 * dd.y) / max(r, 0.01);
        nrm = normalize(nrm - radial * g * (1.0 - smoothstep(2.6, 3.0, q)) * landW);
      }
    }
    float river = 0.0, coastSP = 1.0, coastFl = 0.0, inDep = 1.0;
    if (ter) {
      // the coastline per pixel from the same land/sea field as the terrain, so it never shows the mesh's steps
      if (abs(H) < 40.0) {
        float sp = coastSP0;
        float fl = smoothstep(1300.0, 3500.0, length(nF - uSite) * uR) * uTerK;     // the flattened launch area stays land
        coastSP = sp; coastFl = fl;
        float wpx = 1.0 - smoothstep(-0.0015 * max(foot, 1.0) - 0.002, 0.0015 * max(foot, 1.0) + 0.002, sp);
        water = mix(water, wpx, fl);
        landW = 1.0 - water;
      }
      // rivers on the big valleys' floors, in stretches, wider toward the sea; anti-aliased by the field's own
      // screen derivative so distant rivers thin out instead of flickering
      float rwid = (0.0007 + 0.0014 * (1.0 - smoothstep(5.0, 80.0, H))) * (0.55 + 0.9 * tfbm(nF * (uR / 900.0) + 17.0, 2));   // narrows and widens along its course
      float seg = smoothstep(0.42, 0.55, tfbm(nF * (uR / 16000.0) + 5.0, 2));
      float rOn = seg * landW * smoothstep(0.4, 2.5, H) * (1.0 - sandK) * (1.0 - bare) * smoothstep(0.1, 0.04, slope) * uTerK;
      river = clamp((rwid - vB) / vBw + 0.5, 0.0, 1.0) * rOn;
      inDep = clamp((rwid - vB) / rwid, 0.0, 1.0);                     // 0 at the bank, 1 mid-channel
      // banks: a strip of mud right at the water, then a band of lush scrub and reeds along the river
      if (rOn > 0.0 && river < 1.0) {
        float bn = vnoise(vec3(sP / 25.0, 63.0), 0), bn2 = vnoise(vec3(sP / 7.0, 65.0), 0);
        float mud = (1.0 - smoothstep(rwid, rwid * 1.35 + vBw, vB)) * rOn;
        float lush = (1.0 - smoothstep(rwid * (1.6 + 1.6 * bn), rwid * (2.6 + 2.0 * bn) + vBw, vB)) * rOn;
        alb = mix(alb, vec3(0.03, 0.05, 0.018) * (0.7 + 0.6 * bn2), lush * 0.75 * (1.0 - river));
        alb = mix(alb, vec3(0.04, 0.038, 0.026) * (0.8 + 0.4 * bn2), mud * 0.7 * (1.0 - river));
      }
      float vk = 1.0 - smoothstep(0.0, 0.06, vB);
      alb = mix(alb, alb * vec3(0.82, 1.05, 0.8), vk * 0.45 * soft);                    // lusher, darker valley floors
    } else if (foot < 3000.0 && landW > 0.0 && awaySite > 0.0 && forest > 0.05) {
      float region = smoothstep(0.52, 0.6, fbm(nF * (uR / 60000.0) + 9.0, 2));
      if (region > 0.0) {
        float rv = fbmR(ROT * nF * (uR / 9000.0) + 3.3, 3);
        float rw = abs(rv - 0.5), fw = max(fwidth(rv), 1e-6);
        river = clamp((0.0045 - rw) / fw + 0.5, 0.0, 1.0) * region * awaySite * landW * smoothstep(0.3, 0.1, length(rl.xy)) * smoothstep(0.06, 0.02, slope);
      }
    }
    if (lakeK > river) inDep = smoothstep(0.0, 4.0, lakeDep);
    river = max(max(river, poolK), lakeK);      // marsh pools, rivers and lakes: inland water
    water = max(water, river);
    // shore: a narrow band of sand where land meets sea, turquoise shallows just offshore
    float beach = (ter ? mix(smoothstep(0.36, 0.43, wraw), smoothstep(0.02, 0.3, H) * smoothstep(2.8, 1.2, H) * smoothstep(0.18, 0.36, wraw), uTerK) : smoothstep(0.36, 0.43, wraw)) * (1.0 - water);
    if (ter) beach = mix(beach, (1.0 - smoothstep(0.02, 0.055, coastSP0 + (vnoise(vec3(sP / 260.0, 95.0), 0) - 0.5) * 0.02)) * (1.0 - water), uTerK);   // a strand along the coastline, wider here and there
    beach *= smoothstep(1300.0, 3500.0, siteD);      // the flattened launch area is all land: no strand flickering across it
    // pale dry sand up the beach, darker wet sand at the water's edge
    vec3 sandC = mix(vec3(0.27, 0.23, 0.17), vec3(0.46, 0.41, 0.31), smoothstep(0.004, 0.018, coastSP0)) * (0.92 + 0.16 * tuft);
    alb = mix(alb, sandC, beach * 0.9);
    float shallow = ter ? mix(1.0 - smoothstep(0.58, 0.9, wraw), smoothstep(-28.0, -1.0, H), uTerK) : 1.0 - smoothstep(0.58, 0.9, wraw);
    vec3 seaBase = ter ? mix(alb * 0.55, vec3(0.012, 0.03, 0.05), uTerK) : alb * 0.55;
    vec3 seaAlb = mix(seaBase, vec3(0.03, 0.11, 0.11), shallow * water * 0.85);
    // Near the shore the sea is shallow enough to see the sandy bottom. Light going down to it and back is
    // absorbed red-first (Beer–Lambert): a metre of water reads pale green-turquoise, five metres teal, twenty
    // the open sea's blue. Sandbars run along the shore (isolines of the coast field), lifting the bottom in
    // pale streaks, as from the air over any sandy coast.
    float depthM = ter && river < 0.5 ? max(-H, 0.0) : 99.0, foam = 0.0;
    if (depthM < 30.0 && siteD < 2e5) {
      float wob = vnoise(vec3(sP / 380.0, 91.0), 0) - 0.5, wob2 = vnoise(vec3(sP / 95.0, 97.0), 0) - 0.5;
      float bar = smoothstep(0.35, 0.95, 0.5 + 0.5 * sin(coastSP0 * 170.0 + wob * 7.0)) * smoothstep(0.6, 2.5, depthM) * (1.0 - smoothstep(6.0, 12.0, depthM));
      float dEff = depthM * (1.0 - 0.55 * bar) * (1.0 + 0.25 * wob2);
      vec3 Tw = exp(-2.0 * dEff * vec3(0.32, 0.07, 0.05) * 0.4);      // clear coastal water
      vec3 bottom = vec3(0.4, 0.36, 0.27) * (0.85 + 0.3 * vnoise(vec3(sP / 30.0, 99.0), 0));
      vec3 shallowAlb = bottom * Tw + vec3(0.006, 0.04, 0.05) * (1.0 - Tw.g);
      seaAlb = mix(seaAlb, shallowAlb, water * uTerK * (1.0 - smoothstep(16.0, 30.0, depthM)));
      // surf: breaking lines travelling shoreward along the isolines, broken up, and the swash at the edge
      float ph = coastSP0 * 700.0 - uTime * 1.1 + wob * 9.0 + wob2 * 3.0;
      float brk = smoothstep(0.82, 0.97, 0.5 + 0.5 * sin(ph)) * smoothstep(0.45, 0.75, vnoise(vec3(sP / 45.0 + vec2(uTime * 0.2, 0.0), 101.0), 0) + 0.25);
      foam = brk * (1.0 - smoothstep(0.6, 3.0, depthM)) * smoothstep(0.05, 0.3, depthM) + (1.0 - smoothstep(0.0, 0.25, depthM)) * 0.7;
      foam *= water * uTerK * smoothstep(3.0, 1.0, footA / 10.0 + 0.5) * smoothstep(1300.0, 3500.0, siteD);
    }
    seaAlb = mix(seaAlb, vec3(0.06, 0.045, 0.028), river * (1.0 - step(0.5, dat.g)) * step(55000.0, siteD));      // tropical rivers carry silt
    // inland water: you see the murky, weedy bottom in the shallows at the margin, dark peaty water further in
    if (river > 0.0) {
      float lz = vnoise(vec3(sP / 40.0, 61.0), 0), lz2 = vnoise(vec3(sP / 9.0, 67.0), 0);
      vec3 shallowC = mix(vec3(0.05, 0.048, 0.03), vec3(0.03, 0.045, 0.024), lz) * (0.85 + 0.3 * lz2);
      vec3 deepC = vec3(0.007, 0.018, 0.02);
      float dk = lakeK > 0.0 && lakeDep > 0.0 ? smoothstep(0.1, 2.0 + 1.5 * lz, lakeDep) : smoothstep(0.0, 0.5, inDep);
      seaAlb = mix(seaAlb, mix(shallowC, deepC, dk), river * (siteD < 55000.0 ? 1.0 : 0.4));      // far from the base the satellite map's own water tint stays
    }

    // --- sea: wind waves from swell to ripples, so the sun leaves a glittering path ---
    // sea surface: swell, waves and chop from the mipmapped noise volume. Each band is sampled with this
    // pixel's footprint, so detail too fine to see is averaged away instead of sparkling; what is lost
    // goes into the roughness, which widens the sun's glitter path the way real distant water does.
    vec3 wn = vec3(0.0);
    float lost = 0.0;
    if (water > 0.01) {
      float wt = uTime;
      float swellK = 0.55 + 0.9 * fbm(nF * (uR / 25000.0) + 3.0, 2);      // wind varies over the sea: no uniform repeat
      // inland water: no swell, just the ripples a breeze raises, rougher in gusts (cat's paws) and less in the lee
      float gust = smoothstep(0.4, 0.75, vnoise(vec3(sP / 170.0 + vec2(wt * 0.015, wt * 0.006), 7.0), 0) * 0.7 + vnoise(vec3(sP / 55.0 + vec2(wt * 0.03, 0.0), 9.0), 0) * 0.3);
      float inl = river, rip = 0.35 + 0.9 * gust;
      for (int i = 0; i < 4; i++) {
        float tile = i == 0 ? 1100.0 : i == 1 ? 310.0 : i == 2 ? 83.0 : 19.0;
        vec2 dir2 = i == 0 ? vec2(1.0, 0.35) : i == 1 ? vec2(0.6, -0.8) : i == 2 ? vec2(-0.3, 1.0) : vec2(0.8, 0.55);
        vec2 q = gUV(tile) + dir2 * wt * (i == 0 ? 3.0 : i == 1 ? 1.7 : i == 2 ? 0.9 : 0.45) / tile + float(i) * 0.37;
        vec2 ax = gdx / tile, ay = gdy / tile;
        float e = 0.004;
        float h0 = textureGrad(tGround, q, ax, ay).g, hx = textureGrad(tGround, q + vec2(e, 0.0), ax, ay).g, hy = textureGrad(tGround, q + vec2(0.0, e), ax, ay).g;
        float amp = i == 0 ? 0.06 : i == 1 ? 0.07 : i == 2 ? 0.07 : 0.06;
        float wSea = i == 3 ? 0.0 : 1.0, wIn = (i == 0 ? 0.0 : i == 1 ? 0.12 : i == 2 ? 0.45 : 1.0) * rip;
        amp *= mix(wSea, wIn, inl);
        float vis = smoothstep(tile * 0.05, tile * 0.01, footA);
        vec3 gE = normalize(uGE - nF * dot(uGE, nF)), gN = normalize(uGN - nF * dot(uGN, nF));
        wn += (gE * (h0 - hx) + gN * (h0 - hy)) / e * amp * vis * mix(swellK, 1.0, inl);   // unresolved bands go to roughness, not pattern
        lost += (1.0 - vis) * amp * amp * 4.0;
      }
    }
    vec3 snrm = normalize(nF + wn);
    float nl = max(dot(nrm, uSunF), 0.0);
    float occ = clamp(tOpen / 0.6, 0.45, 1.35);
    vec3 direct = uE * Tg * nl * cs * tSun * mix(1.0, occ, 0.2);
    // sky light reaches a valley floor less than a ridge top
    vec3 land = alb / PI * (direct + Eamb * (0.75 + 0.25 * dot(nrm, nF)) * occ);
    if (uFlashC.r + uFlashC.g + uFlashC.b > 0.0 && siteD < 2e5) {
      vec3 fd = vec3(uFlashP.xy - sP, uFlashP.z);
      float d2 = dot(fd, fd);
      land += alb / PI * uFlashC * max(fd.z, 0.0) * inversesqrt(d2) / d2;
    }
    // snow sparkles a little
    land += snow * uE * Tg * cs * pow(max(dot(reflect(-uSunF, nrm), view), 0.0), 40.0) * 0.06;
    float nv = max(dot(snrm, view), 0.02);
    float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    vec3 skyRef = uE * vec3(0.035, 0.07, 0.15) * smoothstep(-0.15, 0.3, mu);
    // inland water mirrors the sky it faces: pale near the horizon, deeper blue overhead, warm toward the sun
    if (river > 0.0) {
      vec3 rd = reflect(-view, snrm);
      float el = clamp(dot(rd, nF), 0.0, 1.0), toSun = max(dot(rd, uSunF), 0.0);
      float day = smoothstep(-0.15, 0.3, mu);
      vec3 zen = vec3(0.028, 0.06, 0.14), hor = vec3(0.05, 0.08, 0.13) + Tg * 0.025;     // no brighter than the sea's reflection
      vec3 sk = mix(hor, zen, pow(el, 0.45)) + Tg * (0.05 * pow(toSun, 6.0) + 0.25 * pow(toSun, 60.0));
      skyRef = mix(skyRef, uE * sk * day + uE * 0.0004, river);
    }
    vec3 hv = normalize(uSunF + view);
    float rough = clamp(sqrt(0.004 + lost * 0.9), 0.06, 0.32);
    float sh = 2.0 / (rough * rough) - 2.0;
    float spec = (sh + 8.0) / (8.0 * PI) * pow(max(dot(snrm, hv), 0.0), sh) * (0.02 + 0.98 * pow(1.0 - max(dot(hv, view), 0.0), 5.0));
    vec3 sea = seaAlb / PI * (uE * Tg * max(mu, 0.0) * cs * tSun + Eamb) + F * skyRef + uE * Tg * max(dot(snrm, uSunF), 0.0) * spec * cs * tSun;
    sea = mix(sea, vec3(0.62, 0.64, 0.64) / PI * (uE * Tg * max(mu, 0.0) * cs * tSun + Eamb), clamp(foam, 0.0, 1.0));   // foam is white and matte
    col = mix(land, sea, water);
    // city lights on the night side
    float night = 1.0 - smoothstep(-0.08, 0.12, mu);
    col += vec3(1.0, 0.72, 0.4) * pow(dat.b, 2.2) * 0.9 * night * (1.0 - 0.7 * dat.r);
  }

  // ---------- volumetric clouds near the layer (the flat shell below takes over farther out / higher up) ----------
  vec4 vc = vec4(0.0, 0.0, 0.0, 1.0);
  float tV = -1.0;
  if (uVolK > 0.0 && uEnv < 0.5) vc = marchClouds(d, dF, cF, b, tG, muV, tV);
  bool hitV = tV > 0.0;

  // ---------- atmosphere along the view ray ----------
  vec3 S = vec3(0.0), S1 = vec3(0.0), T1 = vec3(1.0), SV = vec3(0.0), TV = vec3(1.0);
  vec2 od = vec2(0.0);
  float discA = b * b - uCA;
  bool snap = false, snapV = false;
  if (discA > 0.0) {
    float sq = sqrt(discA), t0, t1;
    if (uCA < 0.0) { t0 = 0.0; t1 = -b + sq; } else { t0 = b < 0.0 ? uCA / (-b + sq) : 1e30; t1 = -b + sq; }
    t1 = min(t1, tG);
    if (t1 > t0) {
      int N = uEnv > 0.5 ? 8 : 16;
      float dt = (t1 - t0) / float(N), jit = uEnv > 0.5 ? 0.5 : hitV ? fract(ign(gl_FragCoord.xy) + 0.6180340 * uFrame) : ign(gl_FragCoord.xy);   // varies per frame only where the temporal pass averages it
      float phR = 3.0 / (16.0 * PI) * (1.0 + muV * muV);
      float g = 0.8, phM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + muV * muV)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * muV, 1.5));
      vec3 kR = BR * uK * phR, kM = vec3(BM * uK * phM);
      for (int i = 0; i < 22; i++) {
        if (i >= N) break;
        float t = t0 + (float(i) + jit) * dt;
        if (hitC && !snap && t > tC) { snap = true; S1 = S; T1 = exp(-((BR + BO) * uK * od.x + BMX * uK * od.y)); }
        if (hitV && !snapV && t > tV) { snapV = true; SV = S; TV = exp(-((BR + BO) * uK * od.x + BMX * uK * od.y)); }
        float s = uCG + t * (2.0 * b + t);
        float h = max(0.0, s / (sqrt(s + uR * uR) + uR));
        vec2 rho = exp(-h / vec2(uHr, uHm));
        vec2 odm = od + rho * dt * 0.5;
        od += rho * dt;
        vec3 pn = (uCamPos + d * t) / (uR + h);
        vec3 T = exp(-((BR + BO) * uK * odm.x + BMX * uK * odm.y)) * sunT(h, dot(pn, uSun));
        S += (kR * rho.x + kM * rho.y) * T * dt;
      }
    }
  }
  S *= uE;
  if (hitC && !snap) { snap = true; S1 = S; T1 = exp(-((BR + BO) * uK * od.x + BMX * uK * od.y)); } else S1 *= uE;
  if (hitV && !snapV) { snapV = true; SV = S; TV = exp(-((BR + BO) * uK * od.x + BMX * uK * od.y)); } else SV *= uE;
  vec3 Tall = exp(-((BR + BO) * uK * od.x + BMX * uK * od.y));
  if (!hitG) col *= mix(1.0, clamp(1.0 - dot(S, vec3(0.3, 0.5, 0.2)) * 22.0, 0.0, 1.0), step(dot(col, col), 1e4));
  vec3 result = S + Tall * col;

  // ---------- flat cloud shell (from afar and from orbit) ----------
  if (hitC) {
    vec2 cw = vec2(vnoise(cnF * 780.0, 0), vnoise(cnF * 780.0 + 17.3, 0)) - 0.5;
    vec4 cd = textureGrad(tData, uvC + cw * (2.2 / 8192.0), cx, cy);
    float a = cloudAlpha(siteCov(cd.r, cnF), cnF, 1.0, tC * uPix);
    // near: the volume's shapes (the noise repeats every few tens of km, so far off the map's own clouds take over)
    float nearK = uNoiseOn > 0.5 ? 1.0 - smoothstep(uVolMax * 1.5, uVolMax * 3.5, tC) : 0.0;
    vec3 sv = vec3(0.0);
    if (nearK > 0.0) { sv = shellVol(uCloudRel + dF * tC, cloudCov(cnF), tC * uPix); a = mix(a, sv.x, nearK); }
    a *= smoothstep(0.0, 0.02, abs(dot(d, normalize(uCamPos + d * tC))));    // fade at grazing angles through the shell
    a *= mix(1.0, smoothstep(uVolMax * 0.7, uVolMax, tC), uVolK);              // the volume draws the near part
    if (a > 0.003) {
      vec3 cn = normalize(uCamPos + d * tC);
      float muC = dot(cn, uSun);
      vec3 Tc = sunT(uRc - uR, muC);
      float self = cloudAlpha(textureLod(tData, lonlat(normalize(cnF + uSunF * 0.004)), 2.0).r, cnF + uSunF * 0.004, 1.0, 1e9);
      // near: shade the sides turned from the sun, and let thin edges show less bright top
      self = mix(self, sv.y * 0.9, nearK);
      float thick = mix(1.0, 0.84 + 0.2 * sv.z, nearK);
      float below = uCC < 0.0 ? 1.0 : 0.0;
      // cloud tops: multiple scattering inside the cloud sends most of the sunlight back up, so a sunlit top is
      // nearly as bright at mid-morning as at noon; the shaded sides stay darker
      float lit = (0.6 + 0.5 * max(muC, 0.0)) * (1.0 - 0.38 * self) * mix(1.0, 0.32 + 0.3 * (1.0 - a), below) * thick;
      float silver = pow(max(muV, 0.0), 12.0) * (1.0 - a) * 2.5;
      vec3 Eamb = uE * vec3(0.06, 0.09, 0.15) * smoothstep(-0.15, 0.3, muC) + uE * 0.0004;
      vec3 cc = 0.92 / PI * (uE * Tc * (lit + silver) + Eamb);
      vec3 far = (S - S1) + Tall * col;
      result = S1 + T1 * cc * a + (1.0 - a) * far;
    }
  }
  // volumetric clouds in front of all that
  if (hitV) {
    float k = uVolK;
    result = SV + TV * vc.rgb * k + mix(1.0, vc.a, k) * (result - SV);
  }
  // alpha: 1 minus how much volumetric cloud covers this pixel (the temporal pass smooths only those)
  gl_FragColor = vec4(result, hitV ? 1.0 - clamp((1.0 - vc.a) * uVolK * 4.0, 0.0, 1.0) : 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function skyUniforms(tex) {
  return {
    tDay: { value: tex.day }, tData: { value: tex.data }, tRelief: { value: tex.relief },
    uCamPos: { value: new THREE.Vector3() }, uCamF: { value: new THREE.Vector3() }, uCamSite: { value: new THREE.Vector3() }, uCamRot: { value: new THREE.Matrix3() }, uTan: { value: 1 }, uAspect: { value: 1 },
    uSun: { value: new THREE.Vector3(1, 0, 0) }, uSunF: { value: new THREE.Vector3(1, 0, 0) }, uCamRel: { value: new THREE.Vector3() }, uSite: { value: new THREE.Vector3(1, 0, 0) },
    uCG: { value: 1 }, uCA: { value: 1 }, uCC: { value: 1 }, uR: { value: 1 }, uRa: { value: 1 }, uRc: { value: 1 }, uHr: { value: 8000 }, uHm: { value: 1200 }, uK: { value: 1 },
    uE: { value: SUN_E }, uLon0: { value: LON0 }, uRot: { value: 0 }, uTime: { value: 0 }, uPix: { value: 0.001 }, uEnv: { value: 0 }, uCamAlt: { value: 0 }, uSunDisc: { value: 1 }, uStarK: { value: 1 },
    tTer: { value: null }, uBush3D: { value: 0 }, uCrater: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uCraterN: { value: 0 }, uFlashP: { value: new THREE.Vector4() }, uFlashC: { value: new THREE.Vector3() }, uTerOn: { value: 0 }, uTerK: { value: 0 }, uTA: { value: 1 },
    tLand: { value: null }, tCtl: { value: null }, uTR: { value: 1 }, uTLon0: { value: TLON0 }, uTSite: { value: new THREE.Vector3(1, 0, 0) },
    tGround: { value: null }, uGBig: { value: new THREE.Vector2() }, uGSmall: { value: new THREE.Vector2() }, uGE: { value: new THREE.Vector3(0, 0, -1) }, uGN: { value: new THREE.Vector3(0, 1, 0) },
    tNoise: { value: null }, uNoiseOn: { value: 0 }, uCloudRel: { value: new THREE.Vector3() }, uFrame: { value: 0 }, uVolK: { value: 0 }, uVolMax: { value: 30000 }, uCB: { value: 1 }, uCT: { value: 1 }, uRb: { value: 1 }, uRt: { value: 1 },
  };
}

// Full-screen sky/planet quad + a matching sphere used to render the environment map for reflections.
export function makeSkyPlanet(tex) {
  const uniforms = skyUniforms(tex);
  const mat = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, uniforms,
    vertexShader: /* glsl */`uniform mat3 uCamRot; uniform float uTan, uAspect; varying vec3 vDir;
      void main(){ vDir = uCamRot * vec3(position.x*uTan*uAspect, position.y*uTan, -1.0); gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: SKY_FRAG,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false; mesh.renderOrder = -1000;
  const envU = { ...uniforms, uEnv: { value: 1 }, uPix: { value: 0.02 }, uTerOn: { value: 0 }, uVolK: { value: 0 } };
  const envMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms: envU,
    vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: SKY_FRAG,
  });
  mesh.userData.envScene = new THREE.Scene();
  mesh.userData.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), envMat));
  return mesh;
}

// Fill in the sky uniforms. camPos: camera position in the planet-centred inertial frame (metres).
export function updateSky(sky, { camera, camPos, theta, planet, sunDir, siteFixed, time, volumetric = false }) {
  const u = sky.material.uniforms, R = planet.R, k = planet.atmK;
  const Ra = R + 100000 / k, Rc = R + 5500 / k;
  u.uCamPos.value.copy(camPos);
  u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
  u.uTan.value = Math.tan((camera.fov * Math.PI) / 360); u.uAspect.value = camera.aspect;
  const c2 = camPos.lengthSq();
  u.uCG.value = c2 - R * R; u.uCA.value = c2 - Ra * Ra; u.uCC.value = c2 - Rc * Rc;
  // volumetric cloud layer: base and top, and how much of it to draw (fades out on the way up)
  const Rb = R + 4600 / k, Rt = R + 7000 / k;
  u.uRb.value = Rb; u.uRt.value = Rt; u.uCB.value = c2 - Rb * Rb; u.uCT.value = c2 - Rt * Rt;
  u.uVolMax.value = 45000 / Math.sqrt(k);
  // the volume hands over to the sheet over a long climb; the sheet near the camera keeps the volume's shapes
  u.uVolK.value = volumetric && u.tNoise.value ? 1 - THREE.MathUtils.smoothstep(Math.sqrt(c2) - Rt, 12000 / Math.sqrt(k), 26000 / Math.sqrt(k)) : 0;
  u.uNoiseOn.value = u.tNoise.value ? 1 : 0;
  u.uR.value = R; u.uTR.value = R; u.uTA.value = 1 / Math.sqrt(k); u.uRa.value = Ra; u.uRc.value = Rc; u.uHr.value = 8000 / k; u.uHm.value = 1200 / k; u.uK.value = k;
  u.uRot.value = theta; u.uTime.value = time; u.uCamAlt.value = Math.sqrt(c2) - R;
  u.uSun.value.copy(sunDir);
  const toF = (v, out) => { const c = Math.cos(theta), s = Math.sin(theta); return out.set(c * v.x - s * v.z, v.y, s * v.x + c * v.z); };
  toF(sunDir, u.uSunF.value);
  const cf = toF(camPos, new THREE.Vector3());
  u.uCamF.value.copy(cf);
  if (siteFixed) u.uCamSite.value.copy(cf).addScaledVector(siteFixed, -R); else u.uCamSite.value.set(1e9, 0, 0);
  const P = DETAIL_PERIOD;
  u.uCamRel.value.set(cf.x - Math.round(cf.x / P) * P, cf.y - Math.round(cf.y / P) * P, cf.z - Math.round(cf.z / P) * P);
  // cloud noise coordinates: camera minus the wind's drift (12 m/s westward, slight north), wrapped to the noise tiles
  const CP = 36000, wx = cf.x + 9 * time, wy = cf.y - 3 * time, wz = cf.z + 7 * time;
  u.uCloudRel.value.set(wx - Math.round(wx / CP) * CP, wy - Math.round(wy / CP) * CP, wz - Math.round(wz / CP) * CP);
  if (siteFixed) { u.uSite.value.copy(siteFixed); u.uTSite.value.copy(siteFixed); }
  // ground-detail mapping: a tangent frame anchored near the camera (re-anchored when far away), camera
  // coordinates in it wrapped to the detail tiles, so the per-pixel lookups stay small and seamless
  const ud = sky.userData;
  if (!ud.gAnchor || ud.gAnchor.angleTo(cf) > 150000 / R) {
    ud.gAnchor = cf.clone().normalize();
    u.uGE.value.crossVectors(new THREE.Vector3(0, 1, 0), ud.gAnchor).normalize();
    u.uGN.value.crossVectors(ud.gAnchor, u.uGE.value);
  }
  const G = 4096, gu = cf.dot(u.uGE.value), gv = cf.dot(u.uGN.value), bu = Math.floor(gu / G) * G, bv = Math.floor(gv / G) * G;
  u.uGBig.value.set(bu, bv); u.uGSmall.value.set(gu - bu, gv - bv);
  const h = sky.userData.viewH || window.innerHeight;
  u.uPix.value = (2 * u.uTan.value) / h;
}

// ---------- same atmosphere model on the CPU (to colour the sunlight that lights the rocket) ----------
function chapJS(X, h, mu) {
  const c = 1.2533 * Math.sqrt(X + h);
  if (mu >= 0) return (c / (c * mu + 1)) * Math.exp(-h);
  const x0 = Math.sqrt(1 - mu * mu) * (X + h), c0 = 1.2533 * Math.sqrt(x0);
  return 2 * c0 * Math.exp(Math.min(X - x0, 60)) - (c / (1 - c * mu)) * Math.exp(-h);
}
const BRJ = [5.802e-6 + 0.65e-6, 13.558e-6 + 1.881e-6, 33.1e-6 + 0.085e-6];
export function sunTransmittance(planet, h, mu, out = new THREE.Color()) {
  const R = planet.R, k = planet.atmK, Hr = 8000 / k, Hm = 1200 / k;
  const r = R + Math.max(0, h), muH = -Math.sqrt(Math.max(0, 1 - (R * R) / (r * r)));
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const vis = sm(muH - 0.012, muH + 0.004, mu);
  if (vis <= 0) return out.setRGB(0, 0, 0);
  const m = Math.max(mu, muH + 0.004), hh = Math.max(0, h);
  const odR = Hr * chapJS(R / Hr, hh / Hr, m), odM = Hm * chapJS(R / Hm, hh / Hm, m);
  const f = (i) => vis * Math.exp(-(BRJ[i] * k * odR + 4.4e-6 * k * odM));
  return out.setRGB(f(0), f(1), f(2));
}

// ---------- textured sphere for the orbit map (units: km) ----------
export function makeMapPlanet(radiusKm, atmKm, tex) {
  const g = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    uniforms: { tDay: { value: tex.day }, tData: { value: tex.data }, tRelief: { value: tex.relief }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uLon0: { value: LON0 }, uE: { value: SUN_E }, uR: { value: 1 }, uHr: { value: 1 }, uHm: { value: 1 }, uK: { value: 1 }, uTime: { value: 0 } },
    vertexShader: /* glsl */`varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(position); vW = normalize(mat3(modelMatrix)*position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */`${COMMON}
      varying vec3 vN; varying vec3 vW; uniform vec3 uSun;
      void main(){
        vec3 n = normalize(vN), w = normalize(vW);
        vec2 uv = lonlat(n);
        vec3 alb = texture(tDay, uv).rgb; vec4 dat = texture(tData, uv);
        float cl = smoothstep(0.25, 0.85, dat.r * 1.1);
        float nl = dot(w, uSun);
        vec3 V = normalize(cameraPosition - vW * ${radiusKm.toFixed(1)});
        // the water mask is 8K: break up its stair-stepped coastline with sub-texel noise
    float cn = vnoise(n * 2200.0, 0) * 0.65 + vnoise(n * 7100.0, 0) * 0.35;
        float water = smoothstep(0.4, 0.6, dat.g + (cn - 0.5) * 0.55);
        vec3 hv = normalize(uSun + V);
        // the sun's glint off the sea: a small, intense, energy-conserving highlight (narrow lobe, normalised,
        // water's Fresnel reflectance of a few per cent), not a broad blown-out disc
        float sh = 900.0, Fr = 0.02 + 0.98 * pow(1.0 - max(dot(hv, V), 0.0), 5.0);
        float spec = (sh + 8.0) / (8.0 * PI) * pow(max(dot(w, hv), 0.0), sh) * Fr * water * (1.0 - cl);
        float day = smoothstep(-0.1, 0.15, nl);
        vec3 lit = uE / PI * max(nl, 0.0) * mix(vec3(1.0), vec3(1.0, 0.55, 0.3), pow(1.0 - max(nl, 0.0), 6.0));
        vec3 col = mix(alb * mix(1.0, 0.5, water), vec3(0.9), cl) * (lit + uE * 0.004) + uE * spec * max(nl, 0.0);
        col += vec3(1.0, 0.72, 0.4) * pow(dat.b, 2.2) * 0.9 * (1.0 - day) * (1.0 - 0.7 * cl);
        float rim = pow(1.0 - max(dot(w, V), 0.0), 3.0);
        col += vec3(0.25, 0.45, 1.0) * rim * uE * 0.05 * smoothstep(-0.25, 0.3, nl);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const planet = new THREE.Mesh(new THREE.SphereGeometry(radiusKm, 192, 96), mat);
  g.add(planet);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(radiusKm + atmKm, 128, 64), new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uE: { value: SUN_E } },
    vertexShader: /* glsl */`varying vec3 vW; varying vec3 vP; void main(){ vW = normalize(mat3(modelMatrix)*normal); vec4 wp = modelMatrix*vec4(position,1.0); vP = wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: /* glsl */`varying vec3 vW; varying vec3 vP; uniform vec3 uSun; uniform float uE;
      void main(){ vec3 v = normalize(cameraPosition - vP); float f = pow(1.0 - abs(dot(v, vW)), 4.0);
        float s = dot(normalize(vP), uSun); float day = smoothstep(-0.3, 0.25, s);
        // blue over the day side; the warm band only along the terminator, where sunlight crosses the most air
        vec3 c = mix(vec3(1.0, 0.45, 0.2), vec3(0.3, 0.55, 1.0), smoothstep(-0.2, 0.05, s));
        gl_FragColor = vec4(c * f * day * uE * 0.06, 1.0); }`,
  }));
  g.add(halo);
  g.userData = { planet, mat, halo };
  return g;
}
