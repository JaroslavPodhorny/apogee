// Exhaust smoke, launch clouds and explosion puffs.
// · Trails are laid down by distance travelled through the air, evenly spaced along the nozzle's path,
//   so the column is continuous and steady at any speed or frame rate.
// · Puffs are depth-sorted every frame (no popping), rotate slowly, grow smoothly and fade softly
//   where they meet the ground.
// · Shading: each puff is lit by sampling its own density toward the sun (cheap self-shadowing),
//   shadowed sides take the sky colour, fresh exhaust glows from the flame.
// Positions live in the planet-centred frame (doubles) and are drawn relative to the floating origin.
import * as THREE from '../vendor/three.module.js';
import { bakePuffs, detailTex } from './puffbake.js';

const MAX_DEFAULT = 2400;
let puffs = null; const PUFFS = () => (puffs ||= { ...bakePuffs(), det: detailTex() });   // baked once, shared by every smoke system

// A sparse 3D grid of smoke density (open-addressed hash on integer cells), rebuilt every frame from the puffs.
// Puffs are splatted trilinearly into the lattice; lookups take the nearest lattice point.
class DensityGrid {
  constructor(cell, bits = 16) {
    this.C = cell; this.size = 1 << bits; this.mask = this.size - 1;
    this.kx = new Int32Array(this.size); this.ky = new Int32Array(this.size); this.kz = new Int32Array(this.size);
    this.val = new Float32Array(this.size); this.stamp = new Uint32Array(this.size); this.gen = 1; this.used = 0;
  }
  clear() { this.gen++; this.used = 0; }
  slot(ix, iy, iz, make) {
    let h = ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & this.mask;
    for (let p = 0; p < 64; p++, h = (h + 1) & this.mask) {
      if (this.stamp[h] !== this.gen) {
        if (!make || this.used > this.size * 0.7) return -1;
        this.stamp[h] = this.gen; this.kx[h] = ix; this.ky[h] = iy; this.kz[h] = iz; this.val[h] = 0; this.used++; return h;
      }
      if (this.kx[h] === ix && this.ky[h] === iy && this.kz[h] === iz) return h;
    }
    return -1;
  }
  splat(x, y, z, v) {
    const C = this.C, fx = x / C - 0.5, fy = y / C - 0.5, fz = z / C - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const wx = fx - ix, wy = fy - iy, wz = fz - iz;
    for (let c = 0; c < 8; c++) {
      const ox = c & 1, oy = (c >> 1) & 1, oz = c >> 2;
      const w = (ox ? wx : 1 - wx) * (oy ? wy : 1 - wy) * (oz ? wz : 1 - wz);
      const h = this.slot(ix + ox, iy + oy, iz + oz, true); if (h >= 0) this.val[h] += v * w;
    }
  }
  at(x, y, z) { const C = this.C, h = this.slot(Math.round(x / C - 0.5), Math.round(y / C - 0.5), Math.round(z / C - 0.5), false); return h >= 0 ? this.val[h] : 0; }
}
// where the light is sampled on its way to a puff: distances (m) along the ray past the puff's own edge
const SUN_STEPS = [3, 8, 15, 25, 40, 60, 90, 130, 185, 260], SKY_STEPS = [5, 14, 30, 55, 100], LIGHT_K = 0.3;

// Turbulence round the pad: a sum of travelling plane waves u = Σ aᵢ cos(kᵢ·x − ωᵢt + φᵢ) with every aᵢ ⟂ kᵢ, so the
// flow has no divergence: it swirls and folds the cloud without squeezing it into clumps or pulling holes.
// Eddies from 150 m down to 12 m, their speed ∝ size^⅓ (Kolmogorov) and each turning over in about its own
// crossing time. Fixed in the planet's turning frame (the pad's air), normalised to about unit rms speed.
const TURB = (() => {
  let s = 91; const R = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const m = [];
  for (const L of [170, 110, 70, 45, 30]) for (let q = 0; q < 2; q++) {
    const k = new THREE.Vector3(), a = new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5);
    k.set(R() - 0.5, (R() - 0.5) * 0.6, R() - 0.5).normalize();
    a.addScaledVector(k, -a.dot(k)).normalize().multiplyScalar(Math.cbrt(L / 150) * 0.42);
    const kk = 6.2832 / L;
    m.push(k.x * kk, k.y * kk, k.z * kk, a.x, a.y, a.z, kk * 7 * (0.7 + 0.6 * R()), R() * 6.2832);
  }
  return new Float64Array(m);
})();
export class Smoke {
  // max: how many puffs at once (the launch cloud and trail share them; full, the most faded are recycled)
  constructor(max = MAX_DEFAULT) {
    const MAX = (this.max = max);
    const base = new THREE.PlaneGeometry(1, 1);
    const g = (this.geo = new THREE.InstancedBufferGeometry());
    g.index = base.index; g.attributes.position = base.attributes.position;
    const attr = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('iPos', (this.aPos = attr(3)));
    g.setAttribute('iData', (this.aData = attr(4))); // size, alpha, heat, rotation
    g.setAttribute('iVar', (this.aVar = attr(1)));  // atlas cell (0-3) + 4 × soot (0-7) + 32 × detail seed (0-63)
    g.setAttribute('iLit', (this.aLit = attr(3)));
    g.setAttribute('iVel', (this.aVel = attr(3)));  // velocity through the air (m/s, planet frame): fast puffs stretch along it  // light reaching the puff through the rest of the smoke: sun, sky, flame
    g.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        tA: { value: PUFFS().A }, tB: { value: PUFFS().B }, tDet: { value: PUFFS().det }, uStyle: { value: 0 }, uGndCol: { value: new THREE.Vector3(0.05, 0.045, 0.035) }, uSunCol: { value: new THREE.Vector3(1, 1, 1) }, uAmb: { value: new THREE.Vector3(0.2, 0.2, 0.25) },
        uSunV: { value: new THREE.Vector3(0, 1, 0) }, uUpV: { value: new THREE.Vector3(0, 1, 0) }, uGroundD: { value: -1e9 }, uFlameV: { value: new THREE.Vector3() }, uFlameI: { value: 0 }, uFlameCol: { value: new THREE.Color(1, 0.55, 0.2) }, uTint: { value: new THREE.Color(1, 1, 1) }, uHeatCol: { value: new THREE.Color(1, 0.32, 0.06) },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec4 iData; attribute float iVar; attribute vec3 iLit, iVel;
        uniform vec3 uSunV, uUpV, uFlameV; uniform float uGroundD, uFlameI;
        varying vec2 vUv, vCell, vOff; varying float vA, vH, vGround, vSoot, vDet; varying vec3 vLit, vSunS, vUpS, vFdS; varying float vFl;
        void main() {
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          // the flame lights the smoke round the pad: the 1/d² of a point light, softened by the puff's own size
          vec3 dF = uFlameV - mv.xyz; float d2 = dot(dF, dF);
          vFl = uFlameI / (d2 * 0.7 + iData.x * iData.x * 0.08 + 1.0) * exp(-sqrt(d2) / 45.0);   // the steam itself scatters the glow away: it stays round the base
          vFl /= 1.0 + vFl * 0.05;   // soft cap: right by the flame it would burn out to flat white
          float c = cos(iData.w), s = sin(iData.w); mat2 m = mat2(c, -s, s, c);
          // a puff racing along stretches out along its path on screen, so a jet reads as one flowing stream
          vec2 sv = (modelViewMatrix * vec4(iVel, 0.0)).xy; float sl = length(sv);
          vec2 q = position.xy;
          if (sl > 0.5) { vec2 sd = sv / sl; q += sd * dot(q, sd) * min(1.3, sl * 0.014); }
          mv.xy += q * iData.x;
          vUv = m * position.xy + 0.5;
          float seed = floor(iVar / 32.0 + 0.01); vOff = vec2(fract(seed * 0.618), fract(seed * 0.382 + 0.25));
          vDet = clamp(iData.x / 18.0, 0.5, 12.0);   // fine bumps about 3–4 m across, whatever the puff's size
          float cell = mod(iVar, 4.0); vCell = vec2(mod(cell, 2.0), floor(cell / 2.0)) * 0.5;
          vSoot = mod(floor(iVar / 4.0 + 0.01), 8.0) / 7.0;
          // the sun, the sky's zenith and the flame, in the puff's own (rotated) frame: +z toward the camera
          vSunS = vec3(m * uSunV.xy, uSunV.z); vUpS = vec3(m * uUpV.xy, uUpV.z);
          vec3 fd = normalize(dF + vec3(0.0, 0.0, 1e-3)); vFdS = vec3(m * fd.xy, fd.z);
          vA = iData.y; vH = iData.z; vLit = iLit;
          vGround = (dot(mv.xyz, uUpV) - uGroundD) / max(iData.x * 0.28, 0.5);   // linear across the quad: clamp per pixel, not per corner
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tA, tB, tDet; uniform vec3 uSunCol, uAmb, uSunV, uGndCol, uFlameCol, uTint, uHeatCol; uniform float uStyle;
        varying vec2 vUv, vCell, vOff; varying float vA, vH, vGround, vSoot, vDet; varying vec3 vLit, vSunS, vUpS, vFdS; varying float vFl;
        vec3 lA, lB;
        // the baked puff lit from direction L (toward the light): the six lightings, weighted by L's components squared
        float six(vec3 L) { vec3 p = max(L, 0.0), n = max(-L, 0.0); p *= p; n *= n; return dot(lA, vec3(p.x, n.x, p.y)) + dot(lB, vec3(n.y, p.z, n.z)); }
        float hg(float g, float c) { float k = 1.0 + g * g - 2.0 * g * c; return (1.0 - g * g) / (k * sqrt(k)); }
        void main() {
          vec2 uv = vCell + clamp(vUv, 0.002, 0.998) * 0.5;
          vec4 A = texture2D(tA, uv);
          if (A.a < 0.01 || vA < 0.004) discard;
          // stylised fine detail: two octaves of small cauliflower bumps in metres. They nibble the soft rim into crisp
          // little lobes (the solid body keeps its baked outline) and bump the light below
          vec2 du = (vUv - 0.5) * vDet + vOff;
          vec4 q1 = texture2D(tDet, du), q2 = texture2D(tDet, du * 2.37 + 0.31);
          float hd = q1.r * 0.65 + q2.r * 0.35;
          float rim = 1.0 - smoothstep(0.45, 0.95, A.a);
          float al = clamp((A.a + (hd - 0.42) * 0.9 * rim - 0.06) * 1.25, 0.0, 1.0);
          float a = al * vA * smoothstep(0.0, 1.0, clamp(vGround, 0.0, 1.0));
          // toon styles (uStyle 1 toon, 2 soft toon): a crisp silhouette cut from the soft baked shape (sharp at any size,
          // like a distance field), and a puff fades by shrinking into itself rather than turning see-through
          float th = 0.5 + (1.0 - vA) * 0.42;
          if (uStyle > 0.5) a = smoothstep(th - 0.025, th + 0.025, al) * smoothstep(0.0, 1.0, clamp(vGround * 3.0, 0.0, 1.0));
          if (a < 0.003) discard;
          vec2 gd = (q1.gb - 0.5) * 0.65 + (q2.gb - 0.5) * 0.35 * 2.37;   // the bumps' slope, in the puff's own frame
          vec4 B = texture2D(tB, uv);
          lA = A.rgb * A.rgb; lB = B.rgb * B.rgb;
          // large scale: the light that got here through the rest of the cloud (CPU-marched, per puff); a softer copy
          // stands in for light scattered many times inside, so the shadows are blue-grey, not black
          float Ts = vLit.x, Tk = vLit.y;
          float sunT = Ts * 0.75 + 0.25 * pow(Ts, 0.3) * 0.5;
          // forward scattering: thin rims blaze when the sun is behind the smoke
          float cs = -uSunV.z, phase = 0.8 * hg(0.05, cs) + 0.2 * hg(0.6, cs);
          float bump = clamp(1.0 - dot(gd, vSunS.xy) * 2.6, 0.3, 1.8);          // each bump lit on its sunward side
          float crease = 0.5 + 0.5 * smoothstep(0.12, 0.7, hd);                // and dark in the creases between them
          vec3 sun = uSunCol * sunT * six(vSunS) * min(phase, 4.0) * 1.9 * bump * crease;   // (the baked puffs average darker than a matte ball: match the sky's clouds)
          float side = (lA.r + lA.g + lB.g + lB.b) * 0.25;
          vec3 sky = uAmb * (0.2 + 0.8 * Tk) * (0.6 * six(vUpS) + 0.4 * side) * crease;
          vec3 gnd = uGndCol * six(-vUpS) * (0.4 + 0.6 * Tk);
          // sooty smoke (burning propellant) is dark grey-brown, exhaust and steam white
          vec3 alb = uTint * mix(vec3(0.96, 0.95, 0.94), vec3(0.11, 0.1, 0.09), vSoot);
          // dust: where the cloud scours the ground it carries sand up into its lowest parts
          alb *= mix(vec3(0.9, 0.84, 0.76), vec3(1.0), smoothstep(0.2, 1.2, vGround));
          vec3 col = 0.95 / 3.14159 * (sun + sky + gnd) * alb;
          // glowing exhaust: yellow-white where it is hottest, deep orange as it cools
          col += mix(uHeatCol, vec3(1.0, 0.72, 0.35), vH) * vH * vH * 3.0;
          // lit by the flame, most on the side and the parts of the cloud it can reach, but glowing through the rest
          // too (light scattered inside the steam): golden close in, deep orange farther out
          vec3 warm = mix(uFlameCol, vec3(1.0, 0.56, 0.22), 0.6);
          col += mix(vec3(1.0, 0.42, 0.1), warm, smoothstep(1.0, 9.0, vFl)) * vFl * (0.15 + 0.85 * vLit.z) * (0.3 + six(vFdS)) * 2.6 * alb;
          if (uStyle > 0.5) {
            // flat tones by how much sun reaches each part: the cloud's own shadow and the lobes turned away (the fine
            // bumps only nudge the bands, or the lit faces break up into speckle)
            // (the cloud's own shadow deepened for the bands: as with light that goes about twice as deep a shade per metre)
            float sS = pow(vLit.x, 1.8) * six(vSunS) * min(phase, 4.0) * mix(1.0, bump * crease, 0.25);
            float bnd = uStyle > 1.5
              ? smoothstep(0.25, 0.55, sS) * 0.45 + smoothstep(0.75, 1.1, sS) * 0.55          // soft toon: short gradients
              : smoothstep(0.3, 0.34, sS) * 0.5 + smoothstep(0.7, 0.76, sS) * 0.5;            // toon: three crisp tones
            // warm white tops, light grey between, cool blue-grey shadow: the colours keep the shapes apart
            float K = 0.95 / 3.14159;
            vec3 litC = K * (uSunCol * 1.15 + uAmb * 0.9) * alb, midC = K * (uSunCol * 0.62 + uAmb * 1.0) * alb * vec3(0.97, 0.98, 1.0);
            vec3 shC = K * (uSunCol * 0.2 + uAmb * (0.6 + 0.3 * Tk) + uGndCol * 0.3) * alb * vec3(0.95, 0.96, 1.03);
            vec3 tc = bnd < 0.5 ? mix(shC, midC, bnd * 2.0) : mix(midC, litC, bnd * 2.0 - 1.0);
            // the fire's light in two flat steps, orange then gold, on the lobes that face it, in place of the white
            float fg = vFl * (0.15 + 0.85 * vLit.z) * six(vFdS) * mix(1.0, crease, 0.3) * 3.4 + smoothstep(0.2, 0.3, vH) * 2.0;
            float fq = 0.5 * smoothstep(0.25, 0.32, fg) + 0.5 * smoothstep(1.1, 1.25, fg);
            vec3 fireC = dot(litC, vec3(0.2126, 0.7152, 0.0722)) * mix(vec3(1.25, 0.5, 0.14), vec3(1.6, 1.05, 0.5), step(0.75, fq));
            col = mix(tc, fireC, min(1.0, fq * 2.0) * 0.9);
          }
          gl_FragColor = vec4(col, min(1.0, a));
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
    this.n = 0;
    this.p = new Float64Array(MAX * 3); this.v = new Float64Array(MAX * 3); this.e = new Float64Array(MAX * 3);
    this.f = new Float32Array(MAX * 10); // age, life, size0, size1, heat0, seed, opacity, turn rate, hit the ground, carried by the jet
    this.soot = new Uint8Array(MAX);
    // launch-cloud puffs (pad()): how hard the air brakes them (1/s) and how strongly they rise (m/s²); 0 = other smoke
    this.q = new Float32Array(MAX * 2);
    this.th = 0; this.tt = 0;   // the planet's turn and the clock, for the turbulence that lives in the pad's air
    this.towers = [];           // where the launch cloud climbs: [x, y, z (ground frame, see toGround), radius, strength] each
    // volumetric light: every puff's transmittance toward the sun and the open sky, through all the other smoke
    this.lit = new Float32Array(MAX * 3); this.sz = new Float32Array(MAX); this.al = new Float32Array(MAX);
    this.fine = new DensityGrid(6); this.coarse = new DensityGrid(24, 15); this.litPhase = 0;
    this.sunW = new THREE.Vector3(0, 1, 0);   // set by the owner: the sun's direction in the planet frame
    this.flameW = new THREE.Vector3(); this.flameOn = false;   // and where the engines' light comes from
    this.trails = new Map();
  }
  clear() { this.n = 0; this.geo.instanceCount = 0; this.trails.clear(); this.towers = []; }
  emit(pos, vel, size0, size1, life, heat, emitter, opacity = 1, soot = 0) {
    let i = this.n;
    const MAX = this.max;
    if (i >= MAX) { // full: reuse the most faded of a few random slots
      let best = 0, ba = -1;
      for (let k = 0; k < 48; k++) { const j = Math.floor(Math.random() * MAX), r = this.f[j * 10] / this.f[j * 10 + 1]; if (r > ba) { ba = r; best = j; } }
      i = best;
    } else this.n++;
    this.p[i * 3] = pos.x; this.p[i * 3 + 1] = pos.y; this.p[i * 3 + 2] = pos.z;
    this.v[i * 3] = vel.x; this.v[i * 3 + 1] = vel.y; this.v[i * 3 + 2] = vel.z;
    const e = emitter || pos; this.e[i * 3] = e.x; this.e[i * 3 + 1] = e.y; this.e[i * 3 + 2] = e.z;
    const f = this.f, j = i * 10;
    f[j] = 0; f[j + 1] = life; f[j + 2] = size0; f[j + 3] = size1; f[j + 4] = heat; f[j + 5] = Math.random();
    f[j + 6] = opacity; f[j + 7] = (Math.random() - 0.5) * 0.5; f[j + 8] = 0; f[j + 9] = 0; this.soot[i] = Math.round(Math.min(1, soot) * 7);
    this.lit[i * 3] = -1;   // not lit yet: light it in the next update, whatever its turn
    this.q[i * 2] = 0; this.q[i * 2 + 1] = 0;
    return i;
  }
  // make puff i part of the launch cloud: it rides the turbulence, brakes at `drag` (1/s), rises at up to `lift` (m/s²)
  pad(i, drag, lift) { this.q[i * 2] = drag; this.q[i * 2 + 1] = lift; this.f[i * 10 + 8] = 1; }
  // a point in the planet frame → the frame fixed to the ground that the pad's air and towers live in
  toGround(v) { const c = Math.cos(this.th), s = Math.sin(this.th); return [c * v.x - s * v.z, v.y, s * v.x + c * v.z]; }
  // a puff swells fast as it mixes with the air, then slowly. Launch-cloud puffs keep swelling as they climb and
  // spread (entraining air): their lobes are carved in metres by the shared billow field, so a bigger puff only
  // fills out the cloud, it never turns into a smooth ball
  sizeOf(i, age) {
    const f = this.f, j = i * 10;
    if (this.q[i * 2] > 0) {
      // a ground jet widens as it goes (it pulls in the air round it): the farther from the pad, the bigger
      const k = i * 3, dx = this.p[k] - this.e[k], dy = this.p[k + 1] - this.e[k + 1], dz = this.p[k + 2] - this.e[k + 2];
      return f[j + 2] + (f[j + 3] - f[j + 2]) * (1 - Math.exp(-age * 0.45)) + age * 0.35 + Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.13;
    }
    return f[j + 2] + (f[j + 3] - f[j + 2]) * (1 - Math.exp(-age * 1.6)) + age * 0.35;
  }
  // Lay puffs evenly along the path the nozzle took through the air since last frame.
  // o: { size0, size1, life, opacity, push (m/s out of the nozzle), spacing (m), minRate (/s) }
  trail(key, nozzle, air, down, o, dt) {
    let t = this.trails.get(key);
    if (!t) { t = { last: nozzle.clone(), acc: 0 }; this.trails.set(key, t); }
    t.last.addScaledVector(air, dt); // the air that was at the nozzle has drifted with the planet
    const seg = new THREE.Vector3().subVectors(nozzle, t.last), dist = seg.length();
    t.acc += dist / o.spacing + o.minRate * dt;
    const n = Math.min(40, Math.floor(t.acc));
    t.acc -= n;
    const pos = new THREE.Vector3(), vel = new THREE.Vector3(), j = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const k = (i + 1) / n;
      pos.copy(t.last).addScaledVector(seg, k).addScaledVector(down, o.size0 * 0.3 + (o.offset || 0));
      pos.add(j.randomDirection().multiplyScalar(o.size0 * (0.25 + 0.35 * Math.random())));   // a ragged column, not a stack of discs
      vel.copy(air).addScaledVector(down, o.push * (0.75 + Math.random() * 0.5)).add(j.randomDirection().multiplyScalar(o.push * 0.12));
      if (o.carry) { pos.addScaledVector(o.carry, (1 - k) * dt); vel.add(o.carry); }   // leaves the flame still moving with the rocket
      const id = this.emit(pos, vel, o.size0 * (0.8 + Math.random() * 0.4), o.size1 * (0.75 + Math.random() * 0.5), o.life * (0.75 + Math.random() * 0.5), o.heat ?? 0.5, nozzle, o.opacity * (0.75 + Math.random() * 0.25));
      if (o.carry) this.f[id * 10 + 9] = 1;
    }
    t.last.copy(nozzle);
  }
  // Draw particles simulated elsewhere: items = [{ x, y, z (planet-centred), size, alpha, heat, rot, cell }]
  drawRaw(items, origin, camera, groundUp, groundDist) {
    const n = Math.min(this.max, items.length);
    const cx = camera.position.x + origin.x, cy = camera.position.y + origin.y, cz = camera.position.z + origin.z;
    for (const it of items) it.dd = (it.x - cx) ** 2 + (it.y - cy) ** 2 + (it.z - cz) ** 2;
    items.sort((a, b) => b.dd - a.dd);
    const P = this.aPos.array, D = this.aData.array, Vv = this.aVar.array, Lr = this.aLit.array;
    // light them as one cloud too, with the grid stretched to the size of its puffs
    if (n && this.sunW) {
      const rp = (this.rawP ||= new Float64Array(this.max * 3)), rs = (this.rawS ||= new Float32Array(this.max)), ra = (this.rawA ||= new Float32Array(this.max)), rl = (this.rawL ||= new Float32Array(this.max * 3));
      let mean = 0;
      for (let s = 0; s < n; s++) { const it = items[s]; rp[s * 3] = it.x; rp[s * 3 + 1] = it.y; rp[s * 3 + 2] = it.z; rs[s] = it.size; ra[s] = it.alpha; rl[s * 3] = -1; mean += it.size; }
      this.light(n, rp, rs, ra, rl, Math.max(1, mean / n / 40), 1, false);
      for (let s = 0; s < n; s++) { items[s].sun = rl[s * 3]; items[s].sky = rl[s * 3 + 1]; }
    }
    for (let s = 0; s < n; s++) {
      const it = items[s];
      P[s * 3] = it.x - origin.x; P[s * 3 + 1] = it.y - origin.y; P[s * 3 + 2] = it.z - origin.z;
      D[s * 4] = it.size; D[s * 4 + 1] = it.alpha; D[s * 4 + 2] = it.heat; D[s * 4 + 3] = it.rot; Vv[s] = it.cell;
      Lr[s * 3] = it.sun ?? 1; Lr[s * 3 + 1] = it.sky ?? 1; Lr[s * 3 + 2] = 1;
    }
    this.geo.instanceCount = n;
    for (const a of [this.aPos, this.aData, this.aVar, this.aLit]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * a.itemSize); }
    const u = this.mat.uniforms, vm = camera.matrixWorldInverse;
    u.uFlameI.value = 0;
    if (groundUp) { u.uUpV.value.copy(groundUp).transformDirection(vm); const gp = groundUp.clone().multiplyScalar(groundDist).applyMatrix4(vm); u.uGroundD.value = gp.dot(u.uUpV.value); } else u.uGroundD.value = -1e9;
  }
  endTrails(keep) { for (const k of [...this.trails.keys()]) if (!keep.has(k)) this.trails.delete(k); }

  // Volumetric light. Every puff is splatted into a density grid (small ones into a fine grid, big ones into a coarse
  // one, as extinction σ = -ln(1 - opacity) / diameter spread over its volume); then each puff marches toward the sun
  // and straight up through it. So the cloud shades itself as a whole: sunlit tops and flanks, dark bellies and
  // cores, the far side of a trail in shadow. A third of the puffs are re-lit each frame (new ones at once), and
  // each eases toward its new value, so nothing flickers as puffs cross grid cells.
  // p: positions (planet frame), sz/al: size and opacity, lit: out (3 per puff; < 0 = light now). scale stretches the
  // grid and the rays for clouds far bigger than a launch's (a mushroom cloud), every: re-light 1 in `every` per call.
  light(n, p, sz, al, lit, scale = 1, every = 3, flameOn = this.flameOn) {
    const F = this.fine, Cg = this.coarse;
    F.C = 6 * scale; Cg.C = 24 * scale; F.clear(); Cg.clear();
    for (let i = 0; i < n; i++) {
      const a = al[i]; if (a < 0.01) continue;
      const r = 0.34 * sz[i], sig = -Math.log(1 - Math.min(0.95, a)) / (2 * r), V = 4.18879 * r * r * r;
      if (r < F.C * 1.5) F.splat(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], sig * V / (F.C * F.C * F.C));
      else Cg.splat(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], sig * V / (Cg.C * Cg.C * Cg.C));
    }
    const S = this.sunW, sx = S.x, sy = S.y, sz2 = S.z, ph = (this.litPhase = (this.litPhase + 1) % every);
    const ext = (x, y, z) => F.at(x, y, z) + Cg.at(x, y, z);
    const Fx = this.flameW.x, Fy = this.flameW.y, Fz = this.flameW.z, fon = flameOn;
    for (let i = 0; i < n; i++) {
      const fresh = lit[i * 3] < 0;
      if (!fresh && i % every !== ph) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2], r0 = 0.34 * sz[i] * 0.6;
      const rl = Math.sqrt(x * x + y * y + z * z), ux = x / rl, uy = y / rl, uz = z / rl;
      let tau = 0, prev = 0;
      for (let q = 0; q < SUN_STEPS.length; q++) { const d = SUN_STEPS[q] * scale, t = r0 + d; tau += ext(x + sx * t, y + sy * t, z + sz2 * t) * (d - prev); prev = d; }
      let tauU = 0; prev = 0;
      for (let q = 0; q < SKY_STEPS.length; q++) { const d = SKY_STEPS[q] * scale, t = r0 + d; tauU += ext(x + ux * t, y + uy * t, z + uz * t) * (d - prev); prev = d; }
      // toward the flame: the glow lights the smoke it can reach, not the far side of the cloud
      let tauF = 0;
      // (past ~400 m the flame's glow has died away in the steam, see the sprite shader: no need to march to it)
      const dFx = Fx - x, dFy = Fy - y, dFz = Fz - z, dF2 = dFx * dFx + dFy * dFy + dFz * dFz;
      if (fon && dF2 < 160000) {
        const dx = dFx, dy = dFy, dz = dFz, D = Math.sqrt(dF2) || 1, span = Math.max(0, D - r0 - 4);
        for (let k = 0; k < 5; k++) { const t = r0 + span * (k + 0.5) / 5; tauF += ext(x + dx / D * t, y + dy / D * t, z + dz / D * t) * span / 5; }
      }
      // light scattered forward keeps going: the effective extinction for light is well below the visible one
      const ts = Math.exp(-LIGHT_K * tau), tk = Math.exp(-LIGHT_K * tauU), tf = Math.exp(-LIGHT_K * tauF);
      if (fresh) { lit[i * 3] = ts; lit[i * 3 + 1] = tk; lit[i * 3 + 2] = tf; }
      else { lit[i * 3] += (ts - lit[i * 3]) * 0.5; lit[i * 3 + 1] += (tk - lit[i * 3 + 1]) * 0.5; lit[i * 3 + 2] += (tf - lit[i * 3 + 2]) * 0.5; }
    }
  }

  update(dt, planet, origin, camera, groundUp, groundDist) {
    const R = planet.R, om = planet.omega, p = this.p, v = this.v, f = this.f, e = this.e, q = this.q;
    let n = this.n;
    const damp = 1 - Math.exp(-dt * 0.9);
    this.th += om * dt; this.tt += dt;
    const ct = Math.cos(this.th), st = Math.sin(this.th), tt0 = this.tt, NM = TURB.length;
    for (let i = 0; i < n; i++) {
      const k = i * 3, j = i * 10;
      f[j] += dt;
      if (f[j] > f[j + 1]) { // retire: move the last particle into this slot
        n--; const m = n * 3, mj = n * 10;
        for (let c = 0; c < 3; c++) { p[k + c] = p[m + c]; v[k + c] = v[m + c]; e[k + c] = e[m + c]; }
        for (let c = 0; c < 10; c++) f[j + c] = f[mj + c];
        this.soot[i] = this.soot[n]; for (let c = 0; c < 3; c++) this.lit[i * 3 + c] = this.lit[n * 3 + c];
        q[i * 2] = q[n * 2]; q[i * 2 + 1] = q[n * 2 + 1];
        i--; continue;
      }
      const x = p[k], y = p[k + 1], z = p[k + 2];
      const r = Math.sqrt(x * x + y * y + z * z), ux = x / r, uy = y / r, uz = z / r;
      // the air turns with the planet, and blows: a breeze that strengthens and veers with height (wind shear),
      // so a climbing rocket's trail bends and drifts; plus slow turbulent eddies so the column is never straight
      const alt = r - R, ex0 = uz, ez0 = -ux, el = Math.hypot(ex0, ez0) || 1, ex = ex0 / el, ez = ez0 / el;      // east = Y × up
      const nx = uy * ez, ny = uz * ex - ux * ez, nz = -uy * ex;                                                   // north = up × east
      const ws = 3 + 9 * (1 - Math.exp(-Math.max(0, alt) / 2500)), wa = 0.6 + alt / 4000;
      const se = f[j + 5] * 40, tt = f[j];
      const kd = q[i * 2];
      const tb = kd > 0 ? 0 : 1.6 * Math.min(1, tt * 0.5);
      const we = ws * Math.cos(wa) + tb * Math.sin(tt * 0.9 + se), wn = ws * Math.sin(wa) + tb * Math.sin(tt * 0.7 + se * 1.7), wu = tb * 0.5 * Math.sin(tt * 1.1 + se * 2.3);
      const ax = om * z + ex * we + nx * wn + ux * wu, ay = ny * wn + uy * wu, az = -om * x + ez * we + nz * wn + uz * wu;
      let tx = 0, ty = 0, tz = 0;
      if (kd > 0) {
        // launch cloud: the jet off the pad brakes in the still air (its own rate), rises where the steam is hottest,
        // and is churned by eddies in proportion to how fast it is still going (a racing jet tears itself into
        // lobes, the settled cloud just slowly boils). A rising tower is a plume, not a jet: the air brakes its
        // climb far less than its spread
        const dk = 1 - Math.exp(-dt * kd), dv = 1 - Math.exp(-dt * kd * 0.3);
        let wx = ax - v[k], wy = ay - v[k + 1], wz = az - v[k + 2];
        const wr = wx * ux + wy * uy + wz * uz, wk = wr * (dv - dk);
        v[k] += wx * dk + ux * wk; v[k + 1] += wy * dk + uy * wk; v[k + 2] += wz * dk + uz * wk;
        const X = ct * x - st * z, Z = st * x + ct * z;   // in the pad's own (turning) frame
        for (let c = 0; c < NM; c += 8) {
          const w = Math.cos(TURB[c] * X + TURB[c + 1] * y + TURB[c + 2] * Z - TURB[c + 6] * tt0 + TURB[c + 7]);
          tx += TURB[c + 3] * w; ty += TURB[c + 4] * w; tz += TURB[c + 5] * w;
        }
        const rvx = v[k] - ax, rvy = v[k + 1] - ay, rvz = v[k + 2] - az, rv = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
        const amp = 1.5 + 0.15 * rv;
        const Tx = (ct * tx + st * tz) * amp, Tz = (-st * tx + ct * tz) * amp; tx = Tx; ty *= amp; tz = Tz;
        // heat: towers stand where the jets stall (tower sites from the owner, fixed to the ground); elsewhere the
        // steam only creeps up. The lift builds as the jet stalls and dies away as the steam cools
        let hot = 0.3;
        const T = this.towers, Ux = ct * ux - st * uz, Uz = st * ux + ct * uz;
        for (let c = 0; tt < 60 && c < T.length; c += 5) {   // (after a minute the lift has died away anyway)
          let dx = X - T[c], dy = y - T[c + 1], dz = Z - T[c + 2];
          const dh = dx * Ux + dy * uy + dz * Uz;   // across the ground only
          dx -= Ux * dh; dy -= uy * dh; dz -= Uz * dh;
          hot += T[c + 4] * Math.exp(-(dx * dx + dy * dy + dz * dz) / (T[c + 3] * T[c + 3]));
        }
        const lift = q[i * 2 + 1] * hot * dt * Math.min(1, tt * 0.6) * Math.exp(-tt * 0.05) / (1 + rv * 0.04);
        v[k] += ux * lift; v[k + 1] += uy * lift; v[k + 2] += uz * lift;
      } else {
        const dk = f[j + 9] > 0 ? 1 - Math.exp(-dt * (0.9 + 6 * Math.exp(-f[j] * 3))) : damp;   // jet-carried exhaust brakes hard at first
        v[k] += (ax - v[k]) * dk; v[k + 1] += (ay - v[k + 1]) * dk; v[k + 2] += (az - v[k + 2]) * dk;
        // buoyancy: warm exhaust drifts up
        const hot = f[j + 8] > 0 ? 2.5 : 0.8;
        const lift = hot * dt * Math.exp(-f[j] * (f[j + 8] > 0 ? 0.1 : 0.08));
        v[k] += ux * lift; v[k + 1] += uy * lift; v[k + 2] += uz * lift;
      }
      // reaching the ground: turn downward motion into a spread outward from where it was emitted
      const size = this.sizeOf(i, tt);
      if (r - R < size * 0.3) {
        const rx = v[k] - ax, ry = v[k + 1] - ay, rz = v[k + 2] - az, vr = rx * ux + ry * uy + rz * uz;
        if (vr < 0) {
          let hx = x - e[k], hy = y - e[k + 1], hz = z - e[k + 2];
          const hr = hx * ux + hy * uy + hz * uz; hx -= ux * hr; hy -= uy * hr; hz -= uz * hr; // keep it horizontal
          // right under the nozzle the offset says nothing about direction: each puff takes its own (fixed,
          // from its seed), so the cloud spreads evenly all round; farther out it keeps going the way it was
          {
            const L = Math.hypot(hx, hy, hz), w = Math.min(1, Math.max(0, (L - 2) / 6));
            let t1x = -uz, t1z = ux, t1n = Math.hypot(t1x, t1z) || 1; t1x /= t1n; t1z /= t1n;      // a horizontal axis
            const t2x = uy * t1z, t2y = uz * t1x - ux * t1z, t2z = -uy * t1x;                      // u × t1
            const a = f[j + 5] * 6.2832, ca = Math.cos(a), sa = Math.sin(a);
            const rx = ca * t1x + sa * t2x, ry = sa * t2y, rz = ca * t1z + sa * t2z, Ln = L || 1;
            hx = rx * (1 - w) + (hx / Ln) * w; hy = ry * (1 - w) + (hy / Ln) * w; hz = rz * (1 - w) + (hz / Ln) * w;
          }
          const hn = Math.hypot(hx, hy, hz) || 1, s = -vr * 0.8;
          if (f[j + 8] === 0) f[j + 4] = Math.max(f[j + 4], 1);   // fresh exhaust slamming into the pad: the fireball at the base
          f[j + 8] = 1;                                   // steam off the pad: it boils upward from now on
          v[k] += -ux * vr + (hx / hn) * s; v[k + 1] += -uy * vr + (hy / hn) * s; v[k + 2] += -uz * vr + (hz / hn) * s;
        }
        // eddies cannot push smoke into the ground
        const tr = tx * ux + ty * uy + tz * uz; if (tr < 0) { tx -= ux * tr; ty -= uy * tr; tz -= uz * tr; }
      }
      p[k] += (v[k] + tx) * dt; p[k + 1] += (v[k + 1] + ty) * dt; p[k + 2] += (v[k + 2] + tz) * dt;
      e[k] += om * e[k + 2] * dt; e[k + 2] += -om * e[k] * dt;
    }
    this.n = n;
    // size and opacity now, shared by the light and the draw
    const sz = this.sz, al = this.al;
    for (let i = 0; i < n; i++) {
      const j = i * 10, age = f[j], t = age / f[j + 1];
      const fi = Math.min(1, age / (f[j + 9] > 0 ? 0.35 : 0.18)), fo = 1 - Math.max(0, (t - 0.45) / 0.55);
      sz[i] = this.sizeOf(i, age);
      al[i] = fi * fi * (3 - 2 * fi) * fo * fo * 0.7 * f[j + 6];
    }
    // light changes slowly and each puff eases toward its new value: a big cloud re-lights a smaller share a frame
    this.light(n, this.p, sz, al, this.lit, 1, n > 6000 ? 6 : n > 3000 ? 4 : 3);
    // draw back to front so overlapping puffs never swap
    const cx = camera.position.x + origin.x, cy = camera.position.y + origin.y, cz = camera.position.z + origin.z;
    // (sorted as packed numbers, distance in centimetres above the index, by the native numeric sort: no
    // comparator calls and nothing allocated, where an array of indices made ~200 KB of garbage a frame)
    const keys = (this.sortKeys ||= new Float64Array(this.max)).subarray(0, n);
    for (let i = 0; i < n; i++) { const k = i * 3, dx = p[k] - cx, dy = p[k + 1] - cy, dz = p[k + 2] - cz; keys[i] = Math.floor(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) * 16384 + i; }
    keys.sort();
    const nd = n;
    const P = this.aPos.array, D = this.aData.array, Vv = this.aVar.array, L = this.aLit.array, Ve = this.aVel.array;
    for (let s = 0; s < nd; s++) {
      const i = keys[nd - 1 - s] % 16384, k = i * 3, j = i * 10, age = f[j];
      P[s * 3] = p[k] - origin.x; P[s * 3 + 1] = p[k + 1] - origin.y; P[s * 3 + 2] = p[k + 2] - origin.z;
      D[s * 4] = sz[i];
      D[s * 4 + 1] = al[i];
      L[s * 3] = this.lit[i * 3]; L[s * 3 + 1] = this.lit[i * 3 + 1]; L[s * 3 + 2] = this.lit[i * 3 + 2];
      Ve[s * 3] = v[k] - om * p[k + 2]; Ve[s * 3 + 1] = v[k + 1]; Ve[s * 3 + 2] = v[k + 2] + om * p[k];   // less the planet's turning air
      D[s * 4 + 2] = f[j + 4] * Math.exp(-age * (this.q[i * 2] > 0 ? 5 : f[j + 8] > 0 ? 1.4 : 4));   // launch-cloud steam glows only as it leaves the fire
      D[s * 4 + 3] = f[j + 5] * 6.2832 + age * f[j + 7];
      Vv[s] = Math.floor(f[j + 5] * 4) % 4 + 4 * this.soot[i] + 32 * (Math.floor(f[j + 5] * 256) % 64);
    }
    this.geo.instanceCount = nd;
    for (const a of [this.aPos, this.aData, this.aVar, this.aLit, this.aVel]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, nd) * a.itemSize); }
    // ground plane in view space, for the soft fade where puffs meet it
    const u = this.mat.uniforms, vm = camera.matrixWorldInverse;
    const FL = this.flameLight;
    if (FL && FL.intensity > 0) { u.uFlameV.value.copy(FL.position).applyMatrix4(vm); u.uFlameI.value = FL.intensity * 0.9; u.uFlameCol.value.copy(FL.color); } else u.uFlameI.value = 0;
    if (groundUp) {
      u.uUpV.value.copy(groundUp).transformDirection(vm);
      const gp = groundUp.clone().multiplyScalar(groundDist).applyMatrix4(vm);
      u.uGroundD.value = gp.dot(u.uUpV.value);
    } else u.uGroundD.value = -1e9;
  }
}

// ---------- engine plume ----------
// Modelled on what real sea-level engine plumes show up close:
// · the nozzle exit: a blazing ring right at the lip
// · the potential core: a crisp white-hot cone of unmixed exhaust, a few nozzle diameters long
// · shock diamonds: the over-expanded jet pinches and swells in cells; each cell holds a sharp diamond
//   and ends in a bright Mach disk, and the plume's own outline narrows and bulges with them
// · the shear layer: hot exhaust burning into the air, turbulent, streaked along the flow, with fine
//   eddies that grow downstream and a ragged but crisp edge
// · the tail breaks into separate lobes and cools to red
// Every detail is per-pixel fractal noise cut with sharp, anti-aliased thresholds, so it stays crisp up
// close. Colour is blackbody from a temperature field, brightness ∝ T⁴. Sooty exhaust is optically thick,
// so the flame both glows and hides what is behind it (premultiplied blending). A faint additive shell
// around it is the hot air glowing.
// value noise, fractal noise and blackbody colour, shared by the flame, the fireball and the re-entry plasma
const FX_GLSL = /* glsl */`
  float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vn3(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn3(p); p = p * 2.07 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s / 0.96875; }
  vec3 bb(float T) {
    float t = T / 100.0;
    float g = t <= 66.0 ? 0.39008 * log(max(t, 1.0)) - 0.63184 : 1.12989 * pow(max(t - 60.0, 1.0), -0.07551);
    float b = t <= 19.0 ? 0.0 : 0.54321 * log(max(t - 10.0, 1.0)) - 1.19625;
    return clamp(vec3(1.0, g, b), 0.0, 1.0);
  }
`;
export const plumeGeo = new THREE.CylinderGeometry(1, 1, 1, 48, 160, true).translate(0, -0.5, 0);
const PLUME_VERT = /* glsl */`
  uniform float uSpread, uLen, uTime, uDia, uVac, uSolid; varying float vT, vF, vRad; varying vec2 vQ;
  float coreFrac() { return mix(0.5, 0.62, uSolid) * (1.0 - 0.5 * uVac); }
  void main() {
    vec3 p = position; float t = -p.y; vT = t;
    float ang = atan(position.z, position.x);
    float wob = 1.0 + 0.025 * sin(uTime * 29.0 + t * 11.0 + ang * 3.0) + 0.015 * sin(uTime * 47.0 - t * 23.0);
  #ifdef CORE
    // the potential core: a narrow white-hot jet that pinches hard at every shock and tapers to nothing
    float ph = t * uDia * coreFrac();
    float rf = 0.52 * (1.0 + 0.3 * (1.0 - uVac) * cos(6.2832 * ph) * smoothstep(0.0, 0.7, ph)) * (1.0 - 0.75 * t * t) * wob;
    p.xz *= rf; vRad = rf;
    p.y *= uLen * coreFrac();
  #else
  #ifndef SHELL
    // shock cells: the jet pinches and swells, strongest near the nozzle, gone in vacuum
    float ph = t * uDia;
    wob *= 1.0 + 0.11 * (1.0 - uVac) * (1.0 - 0.6 * uSolid) * cos(6.2832 * ph) * exp(-ph * 0.22) * smoothstep(0.0, 0.6, ph);
  #endif
    float rf = mix(1.0, uSpread, pow(max(t, 0.0), 0.75)) * wob;
    p.xz *= rf; vRad = rf;
    p.y *= uLen;
  #endif
    vQ = vec2(ang, t);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 n = normalize(normalMatrix * vec3(position.x, 0.0, position.z));
    vF = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }`;
const PLUME_FRAG = /* glsl */`
  uniform float uPower, uTime, uVac, uSolid, uDia, uLen, uR0, uChem; varying float vT, vF, vRad; varying vec2 vQ;
  ${FX_GLSL}
  void main() {
    float t = clamp(vT, 0.0, 1.0), u = 1.0 - t, f = clamp(vF, 0.0, 1.0);
    float q = sqrt(max(0.0, 1.0 - f * f));          // projected distance from the axis: 0 centre, 1 silhouette
    float sea = 1.0 - uVac, ax = t * uLen;
    // flow coordinates: round the plume, and along it stretched (streaks) and racing downstream
    vec3 P = vec3(cos(vQ.x) * vRad, sin(vQ.x) * vRad, (ax - uTime * 38.0) * 0.32 / max(uR0, 0.05));
    float n1 = fbm(P * vec3(1.6, 1.6, 1.0));
    float n2 = fbm(P * vec3(4.5, 4.5, 2.2) + 11.0);
    float turb = n1 * 0.62 + n2 * 0.38;
  #ifdef SHELL
    float a = f * f * f * u * u * smoothstep(0.0, 0.05, t) * uPower * 0.14 * (0.6 + 0.8 * n1) * mix(1.0, 0.25, uVac);
    vec3 sc = uChem < 0.5 ? bb(1550.0 - 250.0 * t) * 2.2 : mix(vec3(0.3, 0.4, 1.0), vec3(0.8, 0.45, 0.7), t) * 2.0;
    gl_FragColor = vec4(sc, clamp(a, 0.0, 1.0));
  #elif defined(CORE)
    float ph = t * uDia * mix(0.5, 0.62, uSolid) * (1.0 - 0.5 * uVac);
    float e = 1.0 - q - (n2 - 0.5) * 0.12;
    float aa = fwidth(e) * 1.2 + 0.004;
    float mask = smoothstep(-aa, aa, e) * smoothstep(1.0, 0.75, t) * smoothstep(0.0, 0.01, t);
    // a Mach disk at every pinch: the brightest knots in the whole plume
    float knot = pow(0.5 + 0.5 * cos(6.2832 * ph), 6.0) * sea * smoothstep(0.4, 1.0, ph) * (1.0 - 0.6 * uSolid);
    float I = (2.4 + 7.0 * knot + 5.0 * exp(-t * 7.0)) * (1.0 - 0.55 * t) * (0.85 + 0.3 * n1) * mix(1.0, 0.4, uVac);
    vec3 col = uChem < 0.5 ? bb(2850.0 + 450.0 * knot) : uChem < 1.5 ? mix(vec3(0.8, 0.78, 1.0), vec3(1.0, 0.9, 0.8), knot) : mix(vec3(0.65, 0.8, 1.0), vec3(0.95, 0.97, 1.0), knot);
    I *= uChem < 0.5 ? 1.0 : 0.75;
    gl_FragColor = vec4(col * I, clamp(mask * uPower, 0.0, 1.0));
  #else
    // ragged, crisp outline: eddies bite into the edge, more and more downstream
    float e = 1.0 - (turb - 0.42) * (0.35 + 1.0 * t) - q;
    float aa = fwidth(e) * 1.2 + 0.004;
    float mask = smoothstep(-aa, aa, e);
    // the tail tears into separate lobes
    float thr = smoothstep(0.5, 1.0, t) * 0.75;
    mask *= smoothstep(thr - 0.04, thr + 0.04, turb + 0.12 * (1.0 - t));
    // potential core: a crisp cone; shock cells inside it
    float ph = t * uDia, cf = fract(ph);
    float coreLen = mix(0.38, 0.55, uSolid) * (1.0 - 0.5 * uVac);
    float coneR = 0.5 * (1.0 - t / coreLen) * (1.0 + 0.22 * sea * cos(6.2832 * ph));
    float ac = fwidth(q) * 1.5 + 0.01;
    float core = coneR > 0.0 ? 1.0 - smoothstep(coneR - ac, coneR + ac, q) : 0.0;
    float dsh = q / max(coneR * 1.15, 1e-3) + abs(cf - 0.55) * 1.6;            // diamond in (radius, axis)
    float shockK = sea * (1.0 - 0.6 * uSolid) * exp(-ph * 0.18) * smoothstep(0.3, 0.9, ph);
    float diamond = (1.0 - smoothstep(0.9 - ac, 0.9 + ac, dsh)) * shockK * step(t, coreLen);
    float disk = coneR > 0.0 ? exp(-pow((cf - 0.96) / 0.035, 2.0)) * (1.0 - smoothstep(coneR * 0.6, coneR * 1.2 + ac, q)) * shockK : 0.0;
    float exitRing = exp(-t * uLen / max(uR0 * 0.35, 0.02));
    // temperature
    float T = mix(1450.0, 2250.0, smoothstep(1.0, 0.15, q));
    T += mix(650.0, 900.0, uSolid) * core + 650.0 * diamond + 900.0 * disk;
    T *= 1.0 - t * mix(0.38, 0.28, uSolid);
    T += (turb - 0.5) * 900.0 * (0.35 + q) + (n2 - 0.5) * 350.0;                                   // hot and cool eddies
    T += 700.0 * exitRing;
    T *= 1.0 - 0.33 * uVac;
    float I = pow(T / 2600.0, 4.0) * mix(5.5, 7.0, uSolid);
    vec3 c = bb(T) * I;
    if (uChem > 0.5) {
      // methane / hydrogen: little soot, so the light is gas band emission (CH, C2, OH): a blue-violet sheath
      // near the nozzle; methane warms to pink-orange downstream where it afterburns in the air.
      // The hot structures (exit, core, diamonds) stay white.
      float w = smoothstep(0.12, 0.8, t + (turb - 0.5) * 0.35);
      vec3 sheath = uChem > 1.5 ? mix(vec3(0.18, 0.38, 1.0), vec3(0.45, 0.45, 1.0), w)
                                : mix(mix(vec3(0.2, 0.25, 1.0), vec3(0.5, 0.22, 1.0), q), vec3(1.0, 0.42, 0.28), w);
      float Ig = mix(1.35, 1.15, step(1.5, uChem)) * (0.5 + 1.0 * turb) * (1.0 - 0.45 * t);
      c = sheath * Ig + bb(T) * I * clamp(core + diamond + disk + exitRing, 0.0, 1.0);
    }
    c = mix(c, vec3(0.75, 0.55, 1.0) * I * 0.6, uVac * 0.55);
    float cov = mask * smoothstep(0.0, 0.01, t) * uPower * mix(1.0, 0.45, uVac);
    float opac = cov * mix(0.95, 0.25, uVac) * (0.55 + 0.45 * smoothstep(1.0, 0.4, q));
    gl_FragColor = vec4(c * cov, opac);
  #endif
  }`;
// chem: 0 kerosene (sooty gold-orange), 1 methane (Raptor: blue-violet sheath, white core, pink-orange tail), 2 hydrogen (blue-white)
export function plumeMaterial(solid, chem = 0) {
  const uniforms = { uSpread: { value: 1.2 }, uLen: { value: 5 }, uTime: { value: 0 }, uPower: { value: 0 }, uVac: { value: 0 }, uSolid: { value: solid ? 1 : 0 }, uDia: { value: 4 }, uR0: { value: 1 }, uChem: { value: solid ? 0 : chem } };
  const mk = (kind) => new THREE.ShaderMaterial({
    uniforms, vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG, defines: kind === 'shell' ? { SHELL: 1 } : kind === 'core' ? { CORE: 1 } : {},
    transparent: true, depthWrite: false,
    ...(kind !== 'flame' ? { blending: THREE.AdditiveBlending, side: kind === 'shell' ? THREE.DoubleSide : THREE.FrontSide }
      : { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, side: THREE.FrontSide }),
  });
  return { flame: mk('flame'), shell: mk('shell'), core: mk('core'), uniforms };
}

// ---------- sparks: embers, flashes, glints, gas puffs ----------
// A light particle system for everything that glows or glints: ablation embers off a heat shield, burning debris
// from an explosion, the flash of a pyro bolt, ice crystals catching the sun as a stage separates, RCS gas.
// · simulated on the CPU in doubles (planet-centred frame), drawn relative to the floating origin
// · gravity, and air drag that grows with the air's density, so embers in thin air streak far behind
// · additive, so no sorting: one instanced draw for all of them
// · each one is a streak stretched along its motion as seen by the camera (which rides with the active craft):
//   real motion blur, so fast embers read as lines and slow glints as points
// · embers cool as they fade: white-yellow, orange, deep red (their colour is heat, not paint)
export class Sparks {
  constructor(max = 4000) {
    this.max = max; this.n = 0; this.budget = 1;
    const base = new THREE.PlaneGeometry(1, 1);
    const g = (this.geo = new THREE.InstancedBufferGeometry());
    g.index = base.index; g.attributes.position = base.attributes.position;
    const attr = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('iPos', (this.aPos = attr(3)));
    g.setAttribute('iVel', (this.aVel = attr(3)));   // motion relative to the camera, m/s
    g.setAttribute('iCol', (this.aCol = attr(4)));   // HDR colour, size
    g.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uBlur: { value: 1 / 60 }, uPixW: { value: 0.002 } },
      vertexShader: /* glsl */`
        attribute vec3 iPos, iVel; attribute vec4 iCol;
        uniform float uBlur, uPixW;
        varying vec2 vQ; varying vec3 vC; varying float vLen;
        void main() {
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          vec3 vv = mat3(modelViewMatrix) * iVel;
          // smear over the exposure time, in the screen plane
          float w = max(iCol.w, -mv.z * uPixW);           // never thinner than about a pixel: they shimmer instead
          vec2 s = vv.xy * uBlur; float sl = min(length(s), w * 40.0);
          float L = w + sl;
          vec2 ax = length(s) > 1e-4 ? normalize(s) : vec2(0.0, 1.0), px = vec2(-ax.y, ax.x);
          mv.xy += px * position.x * w + ax * position.y * L;
          vQ = vec2(position.x, position.y * L / w); vLen = L / w;
          // a long streak spreads its light (fainter); a spark smaller than a pixel is dimmer, but only linearly:
          // hot sparks are so bright they read even when tiny
          vC = iCol.rgb * (iCol.w / w) * (1.0 / (1.0 + 0.5 * (vLen - 1.0)));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vQ; varying vec3 vC; varying float vLen;
        void main() {
          // a round head and a soft tail: distance to a segment, capsule falloff
          float y = clamp(vQ.y, -0.5 * (vLen - 1.0), 0.5 * (vLen - 1.0));
          vec2 d = vec2(vQ.x, vQ.y - y) * 2.0;
          float f = exp(-dot(d, d) * 3.5);
          if (f < 0.01) discard;
          gl_FragColor = vec4(vC * f, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 6;
    this.p = new Float64Array(max * 3); this.v = new Float32Array(max * 3);
    this.f = new Float32Array(max * 10);   // age, life, size, r, g, b, drag, cool, grow, flicker seed
  }
  clear() { this.n = 0; this.geo.instanceCount = 0; }
  // pos, vel: planet-centred (Vector3). col: HDR [r,g,b]. drag: 1/s at sea-level density. cool: 0 neutral fade, 1 an ember, -1 a tumbling glint
  emit(pos, vel, life, size, col, drag = 0, cool = 0, grow = 0) {
    if (this.n >= this.max) return -1;
    const i = this.n++, k = i * 3, j = i * 10;
    this.p[k] = pos.x; this.p[k + 1] = pos.y; this.p[k + 2] = pos.z;
    this.v[k] = vel.x; this.v[k + 1] = vel.y; this.v[k + 2] = vel.z;
    const f = this.f;
    f[j] = 0; f[j + 1] = life; f[j + 2] = size; f[j + 3] = col[0]; f[j + 4] = col[1]; f[j + 5] = col[2]; f[j + 6] = drag; f[j + 7] = cool; f[j + 8] = grow; f[j + 9] = Math.random() * 100;
    return i;
  }
  // how many of `n` to really make at the current effects quality
  count(n) { const x = n * this.budget; return Math.floor(x) + (Math.random() < x % 1 ? 1 : 0); }

  update(dt, planet, origin, camera, camVel, blur) {
    const p = this.p, v = this.v, f = this.f, mu = planet.mu, om = planet.omega, R = planet.R;
    let n = this.n;
    const P = this.aPos.array, V = this.aVel.array, C = this.aCol.array;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const k = i * 3, j = i * 10;
      f[j] += dt;
      if (f[j] >= f[j + 1]) {
        n--; const m = n * 3, mj = n * 10;
        p[k] = p[m]; p[k + 1] = p[m + 1]; p[k + 2] = p[m + 2]; v[k] = v[m]; v[k + 1] = v[m + 1]; v[k + 2] = v[m + 2];
        for (let c = 0; c < 10; c++) f[j + c] = f[mj + c];
        i--; continue;
      }
      const x = p[k], y = p[k + 1], z = p[k + 2], r2 = x * x + y * y + z * z, r = Math.sqrt(r2), gk = -mu / (r2 * r);
      // drag toward the air (which turns with the planet), stronger in denser air
      const dr = f[j + 6];
      if (dr > 0) {
        const rho = planet.pressure(r - R);
        if (rho > 0) { const a = 1 - Math.exp(-dt * dr * rho); v[k] += (om * z - v[k]) * a; v[k + 1] += (0 - v[k + 1]) * a; v[k + 2] += (-om * x - v[k + 2]) * a; }
      }
      v[k] += x * gk * dt; v[k + 1] += y * gk * dt; v[k + 2] += z * gk * dt;
      p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
      if (r < R - 50) { f[j] = f[j + 1]; continue; }
      const t = f[j] / f[j + 1], fo = (1 - t), cool = f[j + 7];
      // embers: brightness and colour fall together (cooling); others just fade, with a quick fade-in
      const fl = 0.75 + 0.25 * Math.sin(f[j + 9] + f[j] * 31);
      let b = (cool > 0 ? fo * fo * fl : fo * Math.min(1, f[j] * 20));
      if (cool < 0) { const g = 0.5 + 0.5 * Math.sin(f[j + 9] + f[j] * (6 + f[j + 9] % 7)); b *= 0.25 + 1.6 * g * g * g * g; }   // tumbling glints flash
      C[s * 4] = f[j + 3] * b; C[s * 4 + 1] = f[j + 4] * b * (cool > 0 ? Math.pow(fo, 0.8 * cool) : 1); C[s * 4 + 2] = f[j + 5] * b * (cool > 0 ? Math.pow(fo, 2.2 * cool) : 1);
      C[s * 4 + 3] = f[j + 2] * (1 + f[j + 8] * f[j]);
      P[s * 3] = x - origin.x; P[s * 3 + 1] = y - origin.y; P[s * 3 + 2] = z - origin.z;
      V[s * 3] = v[k] - camVel.x; V[s * 3 + 1] = v[k + 1] - camVel.y; V[s * 3 + 2] = v[k + 2] - camVel.z;
      s++;
    }
    this.n = n;
    this.geo.instanceCount = s;
    for (const a of [this.aPos, this.aVel, this.aCol]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, s) * a.itemSize); }
    const u = this.mat.uniforms;
    u.uBlur.value = blur;
    u.uPixW.value = 1.6 * 2 * Math.tan((camera.fov * Math.PI) / 360) / Math.max(1, this.viewH || 800);
  }
}

// ---------- fireball: a crashing stage's propellant going up ----------
// A lumpy ball of burning gas (noise-displaced, churning), white-yellow at first and cooling through orange to
// a dark sooty red. Its edge is soot: it glows and also hides what is behind it (premultiplied blending).
export const fireballGeo = new THREE.IcosahedronGeometry(1, 4);
export function fireballMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    uniforms: { uAge: { value: 0 }, uTime: { value: 0 }, uSeed: { value: Math.random() * 50 } },
    vertexShader: /* glsl */`
      uniform float uAge, uTime, uSeed; varying vec3 vP; varying float vF, vD;
      ${FX_GLSL}
      void main() {
        vec3 n = normalize(position);
        // billows: big lobes and smaller ones, rolling outward as it grows
        float d = fbm(n * 2.2 + vec3(uSeed, uSeed * 0.7, uTime * 0.35 - uAge * 1.5));
        vD = d;
        vec3 p = n * (0.55 + 0.9 * d);
        vP = n * 2.2 + uSeed;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vF = abs(dot(normalize(normalMatrix * n), normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uAge, uTime; varying vec3 vP; varying float vF, vD;
      ${FX_GLSL}
      void main() {
        float a = clamp(uAge, 0.0, 1.0);
        float n = fbm(vP * 2.4 + vec3(0.0, 0.0, uTime * 0.8 - a * 2.0));
        // hottest in the core of each billow (seen face-on), coolest in the folds and at the rim
        float core = vF * (0.5 + 0.8 * vD) + (n - 0.5) * 1.1;
        float T = mix(2900.0, 800.0, pow(a, 0.6)) * (0.4 + 0.85 * clamp(core, 0.0, 1.0));
        float I = pow(T / 3000.0, 3.0) * 2.4;
        // the burning gas burns out from the outside in; soot is left
        float burn = smoothstep(a * 1.25 - 0.15, a * 1.25 + 0.15, core);
        float soot = (1.0 - burn) * smoothstep(0.0, 0.25, a);
        vec3 col = bb(T) * I * burn + vec3(0.02, 0.018, 0.016) * soot;
        float alpha = clamp((burn * 0.95 + soot * 0.9) * (1.0 - smoothstep(0.55, 1.0, a)) * smoothstep(0.05, 0.35, vF + 0.15), 0.0, 1.0);
        gl_FragColor = vec4(col * (1.0 - smoothstep(0.7, 1.0, a)), alpha);
      }`,
  });
}

// ---------- re-entry plasma ----------
// Air hitting the heat shield at several km/s is compressed and heated to thousands of kelvin: a glowing shock
// cap stands just ahead of the shield, and the hot gas streams back round the craft as a sheath of filaments,
// brightest at the edges (you look through more of it there), torn into wisps behind. Weak heating glows deep
// orange-red; strong heating goes pink-white. The cap and the sheath share one material set.
export const plasmaCapGeo = new THREE.SphereGeometry(1, 36, 12, 0, Math.PI * 2, 0, Math.PI / 2);
export const plasmaGeo = new THREE.CylinderGeometry(1, 1, 1, 36, 24, true).translate(0, -0.5, 0);
export function plasmaMaterials() {
  const uniforms = { uHeat: { value: 0 }, uTime: { value: 0 }, uLen: { value: 10 }, uWid: { value: 2 }, uSpread: { value: 1.6 } };
  const vert = /* glsl */`
    uniform float uLen, uSpread, uTime; varying float vT, vF; varying vec2 vQ;
    void main() {
      vec3 p = position;
      float ang = atan(position.z, position.x);
    #ifdef CAP
      vT = 0.0; vQ = vec2(ang, position.y);
    #else
      float t = -p.y; vT = t;
      p.xz *= mix(1.0, uSpread, pow(max(t, 0.0), 0.7)) * (1.0 + 0.04 * sin(uTime * 23.0 + t * 9.0 + ang * 2.0));
      p.y *= uLen;
      vQ = vec2(ang, t);
    #endif
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
    #ifdef CAP
      vec3 n = normalize(normalMatrix * normalize(position));
    #else
      vec3 n = normalize(normalMatrix * normalize(vec3(position.x, 0.0, position.z)));
    #endif
      vF = abs(dot(n, normalize(-mv.xyz)));
      gl_Position = projectionMatrix * mv;
    }`;
  const frag = /* glsl */`
    uniform float uHeat, uTime, uLen, uWid; varying float vT, vF; varying vec2 vQ;
    ${FX_GLSL}
    void main() {
      float h = clamp(uHeat, 0.0, 1.0), fl = 0.85 + 0.15 * sin(uTime * 41.0) * sin(uTime * 17.3);
    #ifdef CAP
      // the shock layer: brightest straight ahead, a hot rim where it wraps round the shield's edge
      float n = fbm(vec3(cos(vQ.x) * 3.0, sin(vQ.x) * 3.0, vQ.y * 2.0 - uTime * 3.0));
      float a = (0.35 + 0.65 * vF * vF) * (0.7 + 0.6 * n) * smoothstep(0.0, 0.25, h);
      vec3 c = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.8, 0.62), h * (0.7 + 0.4 * n)) * mix(1.2, 4.5, h);
      gl_FragColor = vec4(c * a * fl, 1.0);
    #else
      float t = clamp(vT, 0.0, 1.0), u = 1.0 - t;
      // filaments: noise stretched along the flow, racing downstream
      vec3 P = vec3(cos(vQ.x) * 1.6, sin(vQ.x) * 1.6, t * uLen / max(uWid, 0.5) * 0.35 - uTime * 9.0);
      float n1 = fbm(P * vec3(1.0, 1.0, 0.45)), n2 = fbm(P * vec3(3.0, 3.0, 0.9) + 7.3);
      float fil = smoothstep(0.46 + 0.2 * t, 0.7, n1 * 0.6 + n2 * 0.4 + 0.15 * u);
      fil *= 0.6 + 0.8 * n2;
      float sheath = 0.15 + 0.85 * pow(max(1.0 - vF, 0.0), 1.6);                 // seen edge-on, the sheath is thick
      float a = pow(u, 1.5) * sheath * fil * smoothstep(0.0, 0.04, t);
      // colour by how hot the gas still is: near the shield yellow-white, then orange; downstream the air's own
      // glow (nitrogen, oxygen) shows as it cools: pink to violet
      float tc = clamp(t * 1.4 + (1.0 - h) * 0.25 + (n2 - 0.5) * 0.35, 0.0, 1.0);
      vec3 col = tc < 0.45 ? mix(vec3(1.0, 0.78, 0.5), vec3(1.0, 0.4, 0.1), tc / 0.45) : mix(vec3(1.0, 0.4, 0.1), vec3(0.85, 0.22, 0.5), (tc - 0.45) / 0.55);
      vec3 c = col * mix(0.9, 3.2, h) * (0.6 + 0.8 * u);
      gl_FragColor = vec4(c * a * fl * smoothstep(0.0, 0.2, h), 1.0);
    #endif
    }`;
  const mk = (cap) => new THREE.ShaderMaterial({
    uniforms, defines: cap ? { CAP: 1 } : {}, vertexShader: vert, fragmentShader: frag,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: cap ? THREE.FrontSide : THREE.DoubleSide,
  });
  return { sheath: mk(false), cap: mk(true), uniforms };
}

// ---------- vapour cone ----------
// Near Mach 1 in humid air the pressure drops where the flow speeds round the rocket's shoulder, the air cools
// below its dew point and a shroud of cloud flashes into being, with a sharp front edge (the shock) and a
// ragged trailing edge. It is cloud, not light: lit by the sun and the sky like the smoke.
export const vaporGeo = new THREE.CylinderGeometry(1, 1.9, 1, 48, 10, true).translate(0, -0.5, 0);
export function vaporMaterial(sunCol, amb) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uK: { value: 0 }, uTime: { value: 0 }, uSunCol: { value: sunCol }, uAmb: { value: amb } },
    vertexShader: /* glsl */`
      uniform float uTime; varying float vT, vF; varying vec2 vQ;
      void main() {
        float ang = atan(position.z, position.x); vT = -position.y; vQ = vec2(ang, vT);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vF = abs(dot(normalize(normalMatrix * vec3(position.x, 0.25, position.z)), normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uK, uTime; uniform vec3 uSunCol, uAmb; varying float vT, vF; varying vec2 vQ;
      ${FX_GLSL}
      void main() {
        float t = clamp(vT, 0.0, 1.0);
        // wisps streaked along the flow, at two sizes
        float n = fbm(vec3(cos(vQ.x) * 3.0, sin(vQ.x) * 3.0, t * 2.5 - uTime * 5.0)) * 0.6
                + fbm(vec3(cos(vQ.x) * 9.0, sin(vQ.x) * 9.0, t * 4.0 - uTime * 9.0) + 5.0) * 0.4;
        float front = smoothstep(0.0, 0.06, t);
        float back = 1.0 - smoothstep(0.15, 0.8, t + (n - 0.5) * 0.9);
        float a = front * back * (0.3 + 0.7 * pow(max(1.0 - vF, 0.0), 1.5)) * smoothstep(0.25, 0.75, n + 0.25 * (1.0 - t)) * uK;
        vec3 c = 0.9 / 3.14159 * (uSunCol * (0.55 + 0.35 * n) + uAmb * 1.2);
        gl_FragColor = vec4(c, clamp(a, 0.0, 0.85));
      }`,
  });
}
