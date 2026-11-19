// Where the bushes grow around the launch base — one GLSL function shared by the ground shader (which paints
// distant bushes as lit discs with shadows) and the 3D scatter (which stands real bushes near the camera).
// Because both call the same code, the bush you see as a dot from 1 km is the same bush that becomes a
// lumpy 3D shrub as you come down: nothing pops, nothing moves.
// Coordinates: metres in the launch site's tangent frame (x east, y north), the planet shader's sP.
// Also shared: the land-use and lake fields and the road network, so bushes never stand in a field,
// a lake or on a road, in either renderer.

export const BUSH_CELL = 7.0;

export const BUSH_HASH = /* glsl */`
uint bH(uvec3 q) { q = q * uvec3(1597334677u, 3812015801u, 2798796415u); uint h = q.x ^ q.y ^ q.z; h = (h ^ (h >> 16)) * 2246822519u; h ^= h >> 13; h *= 3266489917u; h ^= h >> 16; return h; }
float bHash(ivec2 c, int s) { return float(bH(uvec3(ivec3(c, s)))) * (1.0 / 4294967295.0); }
`;
export const BUSH_GLSL = BUSH_HASH + /* glsl */`
float bNoise(vec2 p, int s) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); ivec2 c = ivec2(i);
  return mix(mix(bHash(c, s), bHash(c + ivec2(1, 0), s), f.x), mix(bHash(c + ivec2(0, 1), s), bHash(c + ivec2(1, 1), s), f.x), f.y);
}
float bFbm(vec2 p, int s, int oct) {
  float a = 0.5, t = 0.0, n = 0.0;
  for (int i = 0; i < 4; i++) { if (i >= oct) break; t += a * bNoise(p, s + i * 13); n += a; p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return t / n;
}
float landUse(vec2 p) { return bFbm(p / 9000.0, 3, 3); }
float farmMask(vec2 p, float sD) { return smoothstep(0.3, 0.42, landUse(p)) * smoothstep(330.0, 560.0, sD); }
float lakeField(vec2 p) { return bFbm(p / 3200.0, 21, 2); }
// the road network round the base (bent a little, straight where it leaves the site), pads and the town
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
const vec2 RA[6] = vec2[6](vec2(0.0), vec2(-1200.0, -500.0), vec2(-3000.0, -900.0), vec2(-6000.0, -400.0), vec2(-9500.0, 600.0), vec2(-12000.0, 1500.0));
const vec2 RB[5] = vec2[5](vec2(-1200.0, -500.0), vec2(-2000.0, -1800.0), vec2(-2500.0, -2800.0), vec2(-2200.0, -4600.0), vec2(-1500.0, -6500.0));
const vec2 PADS[2] = vec2[2](vec2(-2500.0, -2800.0), vec2(-1500.0, -6500.0));
const vec2 TOWN = vec2(-12300.0, 1700.0);
vec2 roadWarp(vec2 p) { return p + (vec2(bNoise(p / 900.0, 1), bNoise(p / 900.0, 7)) - 0.5) * 140.0 * smoothstep(500.0, 1600.0, length(p)); }
float roadDist(vec2 p) {
  vec2 q = roadWarp(p); float d = 1e9;
  for (int i = 0; i < 5; i++) d = min(d, segD(q, RA[i], RA[i + 1]));
  for (int i = 0; i < 4; i++) d = min(d, segD(q, RB[i], RB[i + 1]));
  return d;
}
// copses: small woods in the meadows. Value noise identical to the planet shader's vnoise/fbm, so the
// painted woods and the 3D trees standing in them agree exactly.
float cNoise(vec3 x) {
  ivec3 i = ivec3(floor(x)); vec3 f = fract(x); f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); ivec3 j = i + 1;
  #define CH(a) (float(bH(uvec3(a))) * (1.0 / 4294967295.0))
  float r = mix(mix(mix(CH(i), CH(ivec3(j.x, i.y, i.z)), f.x), mix(CH(ivec3(i.x, j.y, i.z)), CH(ivec3(j.x, j.y, i.z)), f.x), f.y),
               mix(mix(CH(ivec3(i.x, i.y, j.z)), CH(ivec3(j.x, i.y, j.z)), f.x), mix(CH(ivec3(i.x, j.y, j.z)), CH(j), f.x), f.y), f.z);
  #undef CH
  return r;
}
float copseField(vec2 p) {
  vec3 q = vec3(p / 800.0, 41.0); float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * cNoise(q); q = q * 2.03 + 17.1; a *= 0.5; }
  return s + (cNoise(vec3(p / 120.0, 43.0)) - 0.5) * 0.08;
}
// how thick the scrub grows here, 0..1 (slow: hundreds of metres)
float bushDensity(vec2 p) {
  float sD = length(p);
  if (sD > 85000.0) return 0.0;
  // a sprinkling everywhere in the meadows, thick scrub in patches; kept clear round the base
  float d = (0.06 + 0.94 * smoothstep(0.42, 0.78, bFbm(p / 500.0, 61, 2))) * smoothstep(150.0, 400.0, sD) * (1.0 - smoothstep(55000.0, 85000.0, sD));
  d *= 1.0 - farmMask(p, sD);
  d *= smoothstep(0.62, 0.58, lakeField(p) - (1.0 - smoothstep(600.0, 1100.0, sD)) * 0.6);
  // the lakes in the hollows of the rolling ground (terrain.js siteRelief)
  if (d > 0.0) {
    vec3 sE = normalize(cross(vec3(0.0, 1.0, 0.0), uTSite)), sN = cross(uTSite, sE);
    vec3 nn = normalize(uTSite * uTR + sE * p.x + sN * p.y);
    if (reliefW(nn, sD) > 0.15) d *= smoothstep(0.0, 0.025, reliefShape(nn) - LAKE_LV);
  }
  d *= smoothstep(14.0, 22.0, roadDist(p));
  for (int i = 0; i < 2; i++) d *= smoothstep(250.0, 290.0, length(p - PADS[i]));
  d *= smoothstep(950.0, 1100.0, length((p - TOWN) * vec2(1.0, 1.5)));
  d *= smoothstep(42.0, 55.0, length(p - vec2(-230.0, -150.0))) * smoothstep(32.0, 44.0, length(p - vec2(190.0, 190.0)));   // the old test craters on the range
  return d;
}
// the bush in cell c (or none): returns its radius in metres (0 = no bush), its centre in pos and a 0..1 id.
// dens = bushDensity near the cell (callers that already know it pass it in: it changes slowly)
float bushAt(ivec2 c, float dens, out vec2 pos, out float id) {
  pos = (vec2(c) + 0.5 + (vec2(bHash(c, 91), bHash(c, 93)) - 0.5) * 0.75) * ${BUSH_CELL.toFixed(1)};
  id = bHash(c, 97);
  float h = bHash(c, 95);
  return h < 0.5 * dens ? 0.9 + 2.3 * id * id : 0.0;
}
`;
