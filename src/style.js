// Apogee's art direction, in code: the one place that decides colour and surface. (docs/STYLE.md says why.)
//
// The look: a modern commercial launch company. Monochrome, machined and confident: gloss white, carbon black,
// polished stainless and raw concrete. The hardware looks factory-fresh and is photographed like a product. The
// pad is a clean industrial yard in graphite and grey steel. Colour is a signal, never decoration: hazard
// yellow on the ground where people must not stand, an orange windsock because aviation demands one, red
// beacons on the masts. Everything else is black, white and metal, and it is the contrast between them that
// makes the shapes read: a white tank against a black interstage against a steel stage.
//
// Rules the code below enforces:
// · colours come from PALETTE by name, never as loose hex values in the scene code
// · flight hardware is clean and glossy: clear-coated paint, polished steel; no grime, no wear
// · ground equipment is maintained, not abandoned: rain streaks and dust at the foot of things, a few chips,
//   no rust bleeding down every wall
// · one texel density: surfaces tile in metres (TILE), so a 30 m wall and a 1 m box read at the same scale
// · a wear map multiplies the material's palette colour, so one recipe weathers every paint the same way
import * as THREE from '../vendor/three.module.js';

// ---------- palette (sRGB) ----------
export const PALETTE = {
  // flight hardware: black, white, metal
  enamel: '#f2f2f0',      // gloss white paint under clear coat: tanks, fairings, capsules (a hair warm of pure white)
  enamelShade: '#e6e6e3', // the same white on stringer-ribbed skins, which hold a little more shadow
  carbon: '#1d1e21',      // black composite: interstages, mounts, decouplers. The other half of the look
  black: '#0e0f11',       // anti-glare and insulation black
  aluminium: '#c4c6ca', steel: '#8b9097', darkMetal: '#4a4d52',
  stainless: '#d0d2d5',   // 300-series stainless, polished to a soft mirror: a whole stage can be bare metal
  foilGold: '#d4a64e', foilSilver: '#b9bcc2', bronze: '#9b6a3c',
  tile: '#17181a',        // heat-shield tiles: near black, each one a shade apart
  ablator: '#4b3a2c',     // cork-phenolic heat shield, dark brown
  // the pad: graphite, grey and concrete
  structure: '#3a3d41',   // painted structural steel: the tower, arms, mount. Graphite, not orange
  galvanised: '#a3a6a8',  // hot-dip galvanised rails, ladders, small steel
  cladding: '#dcdedd',    // light grey wall panels on sheds and the tower's core
  mount: '#2a2c2f',       // the launch mount: heavy, dark, sooted by every launch
  concrete: '#b8b7b2',    // cast concrete, cool light grey
  white: '#e8e8e5',       // white-painted ground equipment: tanks, vans, cabins
  grey: '#7d8186',        // mid grey for the odd container or cabinet
  graphite: '#2e3034',    // dark containers, cabinets, drums
  // signals: the only colours on the site, each with a job
  hazard: '#e2b227',      // hazard yellow: kerbs, rails, keep-out stripes
  signal: '#e3561f',      // aviation orange: the windsock
  // natural materials
  canvas: '#3b3e41', burlap: '#c2b28c', timber: '#9a7b58', rubber: '#1b1b1b',
  // weathering: one dust, one rust, one soot, so everything gets dirty the same way
  grime: '#6f665b', rust: '#7c4a2e', soot: '#1f1d1b', primer: '#9a9890',
};
// ---------- the camera's tone curve ----------
// One decision for every view (title, hangar, flight, map, thumbnails). Khronos PBR Neutral keeps colours and
// hues as rendered (grass stays green, the sea blue, white paint white) and only compresses the brightest
// highlights, so sunlit cloud and smoke keep their shading instead of clipping like ACES. (AgX was tried and
// rejected: soft, but it drained the colour out of everything.) A touch of vibrance after the curve
// (post.js) lifts muted colours. `k` scales each view's own exposure.
export const TONE = { mapping: THREE.NeutralToneMapping, k: 1.0, vibrance: 0.22 };
export const applyTone = (renderer, e) => { renderer.toneMapping = TONE.mapping; renderer.toneMappingExposure = e * TONE.k; };

export const col = (name) => new THREE.Color(PALETTE[name]);
// a palette colour as sRGB 0..1 components (what a texture stores)
export const srgb = (name) => { const h = parseInt(PALETTE[name].slice(1), 16); return [(h >> 16) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]; };
export const TILE = 2;                 // metres per texture tile on site surfaces (rocket skin: 1.6 m panels)

// ---------- tileable noise ----------
function hash(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const md = (a, p) => ((a % p) + p) % p;
// periodic value noise: `period` lattice cells across the tile, so it wraps seamlessly
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const x0 = md(xi, period), x1 = md(xi + 1, period), y0 = md(yi, period), y1 = md(yi + 1, period);
  const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// fractal noise over an n×n tile, 0..1. cells: features across the tile at the coarsest octave
export function fbm(n, cells, octaves = 4, seed = 1, gain = 0.5, sx = 1) {
  const out = new Float32Array(n * n);
  let amp = 1, tot = 0;
  for (let o = 0; o < octaves; o++) {
    const p = cells << o, py = Math.max(1, Math.round(p * sx));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] += amp * vnoise((x / n) * p, (y / n) * py, p, seed + o * 17);
    tot += amp; amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// rain run-off: thin stains that start at random points and fade as they run along +row, wandering a little.
// Texture rows run with v. boxUV makes v run down walls, so on site surfaces the stains run down.
export function streaks(n, count, seed, len = 0.5) {
  const out = new Float32Array(n * n), R = rng(seed);
  for (let k = 0; k < count; k++) {
    let x = R() * n; const y0 = R() * n, L = n * len * (0.3 + R()), w = 0.6 + R() * 2.2, I = 0.4 + R() * 0.6, ph = R() * 9;
    for (let s = 0; s < L; s++) {
      const t = s / L, y = Math.floor(y0 + s) % n, f = I * Math.pow(1 - t, 1.6) * (0.7 + 0.3 * Math.sin(s * 0.13 + ph));
      x += Math.sin(s * 0.05 + ph) * 0.12;
      for (let dx = -Math.ceil(w); dx <= Math.ceil(w); dx++) {
        const xi = md(Math.round(x) + dx, n), a = f * Math.max(0, 1 - Math.abs(dx) / (w + 0.5)), i = y * n + xi;
        if (a > out[i]) out[i] = a;
      }
    }
  }
  return out;
}
// chips: small irregular spots where paint has come off (0..1), clustered by a coarse field
export function chips(n, count, seed, rmax = 3) {
  const out = new Float32Array(n * n), R = rng(seed), cl = fbm(64, 3, 2, seed + 5);
  for (let k = 0; k < count; k++) {
    const x = R() * n, y = R() * n;
    if (cl[(Math.floor(y / n * 64) * 64 + Math.floor(x / n * 64))] < 0.45 + R() * 0.2) continue;
    const r = 0.6 + R() * rmax, e = 0.5 + R() * 0.8;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r * e); dx <= Math.ceil(r * e); dx++) {
      if ((dx / e) ** 2 + dy * dy > r * r * (0.6 + 0.4 * R())) continue;
      out[md(Math.round(y) + dy, n) * n + md(Math.round(x) + dx, n)] = 1;
    }
  }
  return out;
}

// ---------- a surface being built: albedo multiplier (rgb), height, roughness offset ----------
export class Surface {
  constructor(n) { this.n = n; const N = n * n; this.r = new Float32Array(N).fill(1); this.g = new Float32Array(N).fill(1); this.b = new Float32Array(N).fill(1); this.h = new Float32Array(N).fill(0.5); this.ro = new Float32Array(N); }
  // blend toward a tint (palette name or [r,g,b] in 0..1 sRGB-ish multiplier) by field × amount
  tint(field, c, amount) {
    const t = typeof c === 'string' ? srgb(c) : c;
    for (let i = 0; i < field.length; i++) { const k = Math.min(1, field[i] * amount); this.r[i] += (t[0] - this.r[i]) * k; this.g[i] += (t[1] - this.g[i]) * k; this.b[i] += (t[2] - this.b[i]) * k; }
    return this;
  }
  // lighten / darken uniformly (tone variation without a colour shift): v in -1..1 around 0
  tone(field, amount) { for (let i = 0; i < field.length; i++) { const k = 1 + (field[i] - 0.5) * 2 * amount; this.r[i] *= k; this.g[i] *= k; this.b[i] *= k; } return this; }
  height(field, k) { for (let i = 0; i < field.length; i++) this.h[i] += field[i] * k; return this; }
  rough(field, k) { for (let i = 0; i < field.length; i++) this.ro[i] += field[i] * k; return this; }
  // paint by function per pixel (x, y in 0..n): returns { h, r, tint } adjustments
  each(fn) { const n = this.n; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) fn(x, y, y * n + x, this); return this; }

  maps(normalStrength = 2, rough0 = 0.6) {
    const n = this.n, N = n * n;
    const alb = new Uint8ClampedArray(N * 4), nor = new Uint8Array(N * 4), rgh = new Uint8Array(N * 4);
    const h = this.h, H = (x, y) => h[md(y, n) * n + md(x, n)];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x, j = i * 4;
      alb[j] = this.r[i] * 255; alb[j + 1] = this.g[i] * 255; alb[j + 2] = this.b[i] * 255; alb[j + 3] = 255;
      const dx = (H(x + 1, y) - H(x - 1, y)) * normalStrength * n / 64, dy = (H(x, y + 1) - H(x, y - 1)) * normalStrength * n / 64, l = Math.hypot(dx, dy, 1);
      // rows run with v (data textures are not flipped): tangent-space normal = (-dh/du, -dh/dv, 1)
      nor[j] = (-dx / l * 0.5 + 0.5) * 255; nor[j + 1] = (-dy / l * 0.5 + 0.5) * 255; nor[j + 2] = (1 / l * 0.5 + 0.5) * 255; nor[j + 3] = 255;
      const r = Math.min(1, Math.max(0.03, rough0 + this.ro[i])) * 255; rgh[j] = r; rgh[j + 1] = r; rgh[j + 2] = r; rgh[j + 3] = 255;
    }
    const mk = (data, srgb) => {
      const t = new THREE.DataTexture(data, n, n); t.flipY = false;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true; t.anisotropy = 8; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true;
      return t;
    };
    return { map: mk(new Uint8Array(alb.buffer), true), normalMap: mk(nor, false), roughnessMap: mk(rgh, false), surface: this };
  }
}

// ---------- recipes ----------
// Each returns { map, normalMap, roughnessMap } for a 1-tile square. They are the vocabulary of the game's
// surfaces: tweak one here and everything made of it changes together. Cached by name.
const cache = new Map();
export function recipe(name) {
  if (!cache.has(name)) { const f = RECIPES[name]; if (!f) throw new Error(`no surface recipe "${name}"`); cache.set(name, f()); }
  return cache.get(name);
}
export const RECIPE_NAMES = () => Object.keys(RECIPES);

const RECIPES = {
  // Flight paint: gloss white under a clear coat, as it leaves the factory. All the life is in the reflections,
  // so the map stays almost blank: a whisper of orange peel in the gloss, and the circumferential joint at each
  // panel edge as a fine line. One 1.6 m panel per tile.
  flightPaint() {
    const n = 512, s = new Surface(n);
    const peel = fbm(n, 110, 2, 6), big = fbm(n, 2, 2, 3);
    s.height(peel, 0.006).rough(peel, 0.05).tone(big, 0.008);
    const joint = new Float32Array(n * n);
    s.each((x, y, i) => { const d = Math.min(y, n - y); joint[i] = Math.exp(-d * d / 0.9); });
    s.height(joint, -0.25).tint(joint, [0.78, 0.78, 0.77], 0.35);
    return s.maps(2.4, 0.16);
  },

  // Ground-equipment paint: industrial, maintained. Even satin paint with a faint roller texture; a few rain
  // streaks under the top edges; small chips to primer where things get knocked. Dust at the foot of things is
  // added by the shader (ground grime). No rust bleeding: someone repaints this every few years.
  fieldPaint() {
    const n = 512, s = new Surface(n);
    const big = fbm(n, 2, 3, 21), fine = fbm(n, 96, 2, 23), roller = fbm(n, 6, 3, 27, 0.6, 8);
    s.tone(big, 0.02).tone(roller, 0.015).tone(fine, 0.012).height(fine, 0.008).height(roller, 0.012);
    const st = streaks(n, 30, 24, 0.4); s.tint(st, 'grime', 0.22).rough(st, 0.08);
    const ch = chips(n, 110, 25, 1.6); s.tint(ch, 'primer', 0.8).height(ch, -0.04).rough(ch, 0.15);
    return s.maps(2, 0.45);
  },
  // Heat-shield tiles: hexagons with narrow gaps, each tile a shade apart (they are replaced one by one), the
  // gaps dark and recessed. Matt with a little sheen. 14 × 12 tiles fill a tile exactly.
  heatTiles() {
    const n = 512, C = 14, RR = 12, cw = n / C, rh = n / RR, s = new Surface(n), grain = fbm(n, 64, 2, 101);
    const id = new Float32Array(n * n), gap = new Float32Array(n * n);
    const wrap = (d) => d - n * Math.round(d / n);
    s.each((x, y, i) => {
      let best = 1e9, second = 1e9, k = 0;
      const c0 = Math.round(x / cw);
      for (let c = c0 - 1; c <= c0 + 1; c++) {
        const off = md(c, 2) ? 0.5 : 0, r0 = Math.round(y / rh - off);
        for (let r = r0 - 1; r <= r0 + 1; r++) {
          const d = Math.hypot(wrap(x - c * cw), wrap(y - (r + off) * rh));
          if (d < best) { second = best; best = d; k = hash(md(c, C), md(r, RR), 102); } else if (d < second) second = d;
        }
      }
      id[i] = k; gap[i] = smooth(2.4, 0.8, second - best);
    });
    s.tone(id, 0.22).tone(grain, 0.06).rough(id, 0.12).tint(gap, [0.25, 0.25, 0.25], 0.9).height(gap, -0.5);
    return s.maps(2.2, 0.62);
  },

  // Cast concrete: aggregate speckle, the faint lines of the formwork, water stains running down,
  // darker damp near the foot. A warm grey that takes the palette colour.
  concrete() {
    const n = 512, s = new Surface(n);
    const big = fbm(n, 3, 4, 31), mid = fbm(n, 16, 3, 32), grit = fbm(n, 160, 2, 33);
    s.tone(big, 0.08).tone(mid, 0.04).tone(grit, 0.06).height(grit, 0.04).rough(grit, 0.1);
    // aggregate: pale and dark stones showing through
    s.each((x, y, i, S) => { const v = hash(x, y, 34); if (v > 0.992) { S.r[i] *= 1.12; S.g[i] *= 1.12; S.b[i] *= 1.1; } else if (v < 0.006) { S.r[i] *= 0.75; S.g[i] *= 0.75; S.b[i] *= 0.75; } });
    // formwork: a lift line across the tile and faint board joints
    const form = new Float32Array(n * n); s.each((x, y, i) => { form[i] = Math.exp(-((y - n * 0.62) ** 2) / 2) * 0.8 + ((x % 128) < 1.5 ? 0.25 : 0); });
    s.tint(form, 'grime', 0.25).height(form, -0.08);
    const st = streaks(n, 40, 35, 0.6); s.tint(st, 'grime', 0.3).rough(st, -0.06);
    const pits = mid.map((v, i) => smooth(0.8, 0.95, v) * smooth(0.75, 0.95, grit[i])); s.height(pits, -0.12).tint(pits, 'soot', 0.12);
    return s.maps(3, 0.88);
  },
  // Corrugated cladding: the profile in the height, dirt caught in the troughs, runs from the top edge.
  cladding() {
    const n = 256, s = new Surface(n);
    const prof = new Float32Array(n * n), trough = new Float32Array(n * n);
    s.each((x, y, i) => { const c = Math.sin((x / n) * Math.PI * 2 * 8); prof[i] = c * 0.5 + 0.5; trough[i] = smooth(0.2, -0.9, c); });
    const big = fbm(n, 3, 3, 41), st = streaks(n, 60, 42, 0.5);
    s.height(prof, 1.2).tone(big, 0.06).tint(trough, 'grime', 0.25).tint(st, 'grime', 0.35).rough(st, 0.1);
    const ox = big.map((v) => smooth(0.65, 0.85, v) * 0.6); s.tint(ox, [0.86, 0.87, 0.86], 0.6).rough(ox, 0.2);   // white rust: galvanising going dull
    return s.maps(1.2, 0.45);
  },
  // Hessian sacking: a coarse plain weave, threads of uneven thickness, dust settled into it.
  burlap() {
    const n = 256, s = new Surface(n), big = fbm(n, 3, 3, 71), slub = fbm(n, 4, 2, 72, 0.5, 16), slub2 = fbm(n, 64, 1, 73);
    const wv = new Float32Array(n * n);
    s.each((x, y, i) => { const p = 4, over = (Math.floor(x / p) + Math.floor(y / p)) % 2, a = Math.sin((x % p) / p * Math.PI), b = Math.sin((y % p) / p * Math.PI); wv[i] = over ? a * (0.6 + 0.4 * b) : b * (0.6 + 0.4 * a); });
    s.height(wv, 0.5).tone(wv, 0.12).tone(slub, 0.1).tone(slub2, 0.06).tone(big, 0.06);
    const dust = big.map((v) => smooth(0.45, 0.8, v)); s.tint(dust, [0.93, 0.9, 0.84], 0.35);
    return s.maps(1.5, 0.95);
  },
  // Sawn timber: boards 25 cm wide with dark joints between them, grain running along, a few knots, greyed by sun.
  timber() {
    const n = 256, s = new Surface(n), grain = fbm(n, 2, 4, 81, 0.55, 24), big = fbm(n, 3, 3, 82), R = rng(83);
    const joint = new Float32Array(n * n), board = new Float32Array(n * n), knot = new Float32Array(n * n);
    const knots = Array.from({ length: 6 }, () => [R() * n, R() * n, 2 + R() * 4]);
    s.each((x, y, i) => {
      const yy = y % 64; joint[i] = yy < 1.5 ? 1 : 0; board[i] = hash(Math.floor(y / 64), 0, 84);
      for (const [kx, ky, kr] of knots) { const d = Math.hypot(((x - kx + n * 1.5) % n) - n / 2, (y - ky) * 2.2); knot[i] = Math.max(knot[i], smooth(kr * 2, 0, d)); }
    });
    s.tone(board, 0.12).tone(grain, 0.16).tone(big, 0.06).tint(knot, [0.45, 0.33, 0.22], 0.7).tint(joint, 'soot', 0.7).height(joint, -0.4).height(grain, 0.06);
    const grey = big.map((v) => smooth(0.4, 0.8, v)); s.tint(grey, [0.78, 0.76, 0.72], 0.35);
    return s.maps(2, 0.85);
  },
  // Composite: a fine weave under clear resin, slightly mottled.
  carbon() {
    const n = 128, s = new Surface(n), m = fbm(n, 4, 3, 51);
    const wv = new Float32Array(n * n); s.each((x, y, i) => { const a = (Math.floor(x / 4) + Math.floor(y / 4)) % 2; wv[i] = a ? Math.sin((x % 4) / 4 * Math.PI) : Math.sin((y % 4) / 4 * Math.PI); });
    s.height(wv, 0.12).tone(m, 0.08).tone(wv, 0.04);
    return s.maps(1.4, 0.5);
  },
  // Heat-shield ablator: a honeycomb of cells filled with dark cork-phenolic; each cell a slightly different
  // brown, the walls proud of the surface.
  ablator() {
    // 14 columns × 12 rows of flat-topped hexes fill the tile exactly, so it repeats without a seam
    const n = 256, C = 14, RR = 12, cw = n / C, rh = n / RR;
    const cells = new Float32Array(n * n), wall = new Float32Array(n * n), grain = fbm(n, 48, 2, 61), big = fbm(n, 3, 3, 62);
    const wrap = (d) => d - n * Math.round(d / n);
    const s = new Surface(n);
    s.each((x, y, i) => {
      let best = 1e9, second = 1e9, id = 0;
      const c0 = Math.round(x / cw);
      for (let c = c0 - 1; c <= c0 + 1; c++) {
        const off = md(c, 2) ? 0.5 : 0, r0 = Math.round(y / rh - off);
        for (let r = r0 - 1; r <= r0 + 1; r++) {
          const d = Math.hypot(wrap(x - c * cw), wrap(y - (r + off) * rh));
          if (d < best) { second = best; best = d; id = hash(md(c, C), md(r, RR), 63); } else if (d < second) second = d;
        }
      }
      cells[i] = id; wall[i] = smooth(2.2, 0.4, second - best);
    });
    s.tone(cells, 0.1).tone(grain, 0.1).tone(big, 0.08).height(wall, 0.18).height(grain, 0.04).rough(wall, -0.1);
    return s.maps(2, 0.88);
  },
};

// ---------- world-space UVs ----------
// Box projection in the object's own frame (y up), `tile` metres per texture repeat: every face picks the plane
// it faces most, and vertical faces always have v running up the wall, so streaks run down the way rain does.
export function boxUV(geo, tile = TILE) {
  const p = geo.attributes.position, nrm = geo.attributes.normal; if (!p || !nrm) return geo;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = x; v = z; } else if (ax >= az) { u = z * Math.sign(nrm.getX(i) || 1); v = -y; } else { u = -x * Math.sign(nrm.getZ(i) || 1); v = -y; }
    uv[i * 2] = u / tile; uv[i * 2 + 1] = v / tile;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

// Prepare a static mesh for a world-mapped surface: box UVs in metres, and its height above the ground (aH),
// which the surface shader uses to dirty the foot of things. `toGround`: the mesh's matrix into the ground frame
// (y up, ground at 0); identity for geometry already in that frame.
export function prepareWorldSurface(mesh, toGround) {
  const m = mesh.material; if (!m || !(m.userData && m.userData.worldUV > 0)) return;
  let g = mesh.geometry; if (g.index) g = g.toNonIndexed(); else g = g.clone();
  boxUV(g, m.userData.worldUV);
  const p = g.attributes.position, h = new Float32Array(p.count), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); if (toGround) v.applyMatrix4(toGround); h[i] = v.y; }
  g.setAttribute('aH', new THREE.BufferAttribute(h, 1));
  mesh.geometry = g;
}

// ---------- materials from the vocabulary ----------
// A standard material painted in a palette colour and weathered by a recipe. opts pass straight through.
export function surfaceMaterial(colour, recipeName, { worldUV = TILE, ...opts } = {}) {
  const r = recipe(recipeName);
  const m = new THREE.MeshStandardMaterial({ color: typeof colour === 'string' ? col(colour) : colour, map: r.map, normalMap: r.normalMap, roughnessMap: r.roughnessMap, roughness: 1, metalness: 0, ...opts });
  m.userData.worldUV = worldUV;
  m.userData.recipe = recipeName;
  if (worldUV > 0) groundGrime(m);
  return m;
}
// Dirt collects at the foot of things: splashed mud and dust in a ragged band up to half a metre, a faint haze
// higher. Driven by aH (height above the ground, from prepareWorldSurface); the edge is broken up by the
// material's own roughness map, so it follows the same texture as the rest of the surface.
function groundGrime(m) {
  const G = col('grime');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGrime = { value: G };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aH; varying float vH;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = aH;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vH; uniform vec3 uGrime;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float gn = clamp((texture2D(roughnessMap, vRoughnessMapUv * 0.37 + 0.21).g - 0.35) * 2.2, 0.0, 1.0);
        float gk = (1.0 - smoothstep(0.02, 0.2 + 0.35 * gn, vH)) * 0.45 + (1.0 - smoothstep(0.2, 1.4, vH)) * 0.06;
        diffuseColor.rgb = mix(diffuseColor.rgb, uGrime * (0.55 + 0.5 * gn), gk);
        roughnessFactor = mix(roughnessFactor, 0.95, gk);`);
  };
  m.customProgramCacheKey = () => 'apogee-ground-grime';
}
