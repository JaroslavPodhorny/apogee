// Explosions you can see from the ground, from a chase camera or from orbit.
//
// Nuclear (numbers from Glasstone & Dolan, scaled by yield):
// · the fireball reaches ≈ 66 m · kt^0.4 in a fraction of a second, white-hot (≈ 8000 K), then cools through
//   yellow and orange to dull red over tens of seconds, rising as a hot bubble
// · the shock front runs out ahead of it; in damp air a white condensation shell flashes along with it
// · near the ground the shock kicks up a ring of dust (the base surge)
// · the bubble rolls into a toroidal vortex: the mushroom cap, climbing to ≈ 12 km for 20 kt, 25 km for 1 Mt,
//   60+ km for 50 Mt, while afterwinds suck a stem of dust up under it
// · in vacuum there is no air to make a fireball, shock or cloud: a blinding flash, an expanding shell of
//   vaporised bomb, and a faint glow in the thin upper air
// Chemical blasts: a short orange fireball, a thump of shock, and a column of black smoke.
// Every blast mesh is cut off below the ground (the terrain is drawn by the sky pass, not depth-tested).
import * as THREE from '../vendor/three.module.js';
import { Smoke } from './fx.js';
import { cloudTop } from './sim.js';

const NOISE = /* glsl */`
  float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float n3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + 1.0), f.x), f.y), f.z); }
  float fbm(vec3 p) { float a = 0.5, t = 0.0; for (int i = 0; i < 5; i++) { t += a * n3(p); p = p * 2.03 + 7.1; a *= 0.5; } return t; }
`;
// blackbody colour (linear RGB, roughly unit brightness), after Tanner Helland's fit
const BB = /* glsl */`
  vec3 bb(float T) {
    float t = T / 100.0; vec3 c;
    c.r = t <= 66.0 ? 1.0 : clamp(1.293 * pow(t - 60.0, -0.1332), 0.0, 1.0);
    c.g = t <= 66.0 ? clamp(0.39 * log(t) - 0.6318, 0.0, 1.0) : clamp(1.13 * pow(t - 60.0, -0.0755), 0.0, 1.0);
    c.b = t >= 66.0 ? 1.0 : t <= 19.0 ? 0.0 : clamp(0.5432 * log(t - 10.0) - 1.1963, 0.0, 1.0);
    return pow(c, vec3(2.2));
  }
`;
const CLIP = /* glsl */`
  uniform vec3 uCenter; uniform float uRg;
  varying vec3 vWorld;
`;

function fireballMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uTime: { value: 0 }, uT: { value: 8000 }, uI: { value: 1 }, uSmoke: { value: 0 }, uAlpha: { value: 1 }, uRough: { value: 0.25 },
      uSunCol: { value: new THREE.Vector3(1, 1, 1) }, uAmb: { value: new THREE.Vector3(0.1, 0.1, 0.1) }, uSunV: { value: new THREE.Vector3(0, 1, 0) },
      uCenter: { value: new THREE.Vector3() }, uRg: { value: 0 }, uSoot: { value: new THREE.Vector3(0.5, 0.42, 0.36) },
    },
    vertexShader: /* glsl */`
      uniform float uTime, uRough; varying vec3 vN, vP, vV; ${CLIP}
      ${NOISE}
      void main() {
        vec3 p = position;
        float n = fbm(p * 2.4 + vec3(0.0, -uTime * 0.25, uTime * 0.1));
        p *= 1.0 + uRough * (n - 0.5) * 2.0;
        vP = position;
        vec4 w = modelMatrix * vec4(p, 1.0); vWorld = w.xyz;
        vec4 mv = viewMatrix * w; vV = -mv.xyz;
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uT, uI, uSmoke, uAlpha; uniform vec3 uSunCol, uAmb, uSunV, uSoot; varying vec3 vN, vP, vV; ${CLIP}
      ${NOISE} ${BB}
      void main() {
        if (length(vWorld - uCenter) < uRg) discard;
        vec3 n = normalize(vN), v = normalize(vV);
        float facing = clamp(dot(n, v), 0.0, 1.0);
        float f = fbm(vP * 3.1 + vec3(0.0, -uTime * 0.35, 0.0)), f2 = fbm(vP * 9.0 - uTime * 0.6);
        // hotter in the thick middle, cooler in turbulent cells at the edge
        float T = uT * (0.72 + 0.42 * f + 0.1 * f2) * (0.82 + 0.18 * facing);
        vec3 hot = bb(T) * uI * pow(T / 6000.0, 4.0);
        // as it cools, soot and dust take over: lit by the sun, still glowing through the gaps
        float sm = smoothstep(0.0, 1.0, uSmoke * (0.75 + 0.6 * (f - 0.5)));
        vec3 soot = (uSunCol * clamp(dot(n, uSunV) * 0.6 + 0.4, 0.0, 1.0) * 0.28 + uAmb * 0.9) * uSoot * (0.7 + 0.6 * f);
        vec3 col = mix(hot, soot + hot * 0.25 * (1.0 - f), sm);
        float a = uAlpha * smoothstep(0.0, 0.25, facing + 0.05 * f);
        gl_FragColor = vec4(col, a);
      }`,
  });
}
function shellMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uA: { value: 0 }, uCol: { value: new THREE.Vector3(1, 1, 1) }, uCenter: { value: new THREE.Vector3() }, uRg: { value: 0 }, uTime: { value: 0 }, uAdd: { value: 0 } },
    vertexShader: /* glsl */`varying vec3 vN, vV, vP; ${CLIP}
      void main() { vP = position; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; vec4 mv = viewMatrix * w; vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`uniform float uA, uTime, uAdd; uniform vec3 uCol; varying vec3 vN, vV, vP; ${CLIP}
      ${NOISE}
      void main() {
        if (length(vWorld - uCenter) < uRg) discard;
        float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float f = fbm(vP * 4.0 + uTime * 0.2);
        float a = uA * (pow(rim, 3.0) * 0.9 + 0.08) * (0.55 + 0.9 * f);
        gl_FragColor = vec4(uCol * (uAdd > 0.5 ? a : 1.0), uAdd > 0.5 ? 1.0 : a);
      }`,
  });
}

const SPH = new THREE.SphereGeometry(1, 72, 48);

export class Booms {
  constructor(scene, smoke) {
    this.scene = scene; this.smoke = smoke; this.list = [];
    this.cloud = new Smoke();
    this.cloud.mat.uniforms.uTint.value.setRGB(0.93, 0.86, 0.79);
    this.cloud.mat.uniforms.uHeatCol.value.setRGB(1.0, 0.22, 0.04);
    this.cloud.mesh.renderOrder = 4;
    scene.add(this.cloud.mesh);
    this.flash = 0;
  }
  clear() { for (const b of this.list) this.disposeOne(b); this.list = []; this.cloud.geo.instanceCount = 0; }
  disposeOne(b) { for (const m of b.meshes) { this.scene.remove(m); m.material.dispose(); } }

  // fx: { pos (world, inertial), fixed (planet-fixed), kt, kind, hob, Rfb, vacuum, rho, t }
  add(fx, planet) {
    const nuke = fx.kind === 'fission' || fx.kind === 'fusion';
    const kt = fx.kt;
    const b = { ...fx, t0: fx.t, nuke, meshes: [], parts: [], age: 0 };
    // time scales
    b.tau = nuke ? Math.max(0.06, 0.03 * Math.pow(kt, 0.44)) : fx.kind === 'fae' ? 0.35 : fx.kind === 'kinetic' ? 0.05 : 0.07;
    b.T0 = nuke ? 8000 : fx.kind === 'kinetic' ? 6000 : fx.kind === 'fae' ? 2600 : 3000;
    b.tCool = nuke ? 44 * b.tau : fx.kind === 'fae' ? 3.5 : fx.kind === 'kinetic' ? 1.2 : 0.9;
    b.Htop = nuke ? cloudTop(kt) / (planet.atmK > 1 ? 2 : 1) : 0;
    b.Tr = 40 * Math.pow(Math.max(kt, 0.001), 0.1);
    b.life = nuke ? (fx.vacuum ? 40 : b.Tr * 9) : 30;
    // fireball
    const fb = new THREE.Mesh(SPH, fireballMaterial()); fb.frustumCulled = false; fb.renderOrder = 3;
    fb.material.uniforms.uRough.value = nuke ? 0.18 : 0.38;
    if (fx.kind === 'kinetic') fb.material.uniforms.uSoot.value.set(0.42, 0.33, 0.25);
    if (!nuke) fb.material.uniforms.uSoot.value.set(0.12, 0.1, 0.09);
    b.fb = fb; b.meshes.push(fb); this.scene.add(fb);
    // shock / condensation shell (air), or the expanding debris shell (vacuum)
    const sh = new THREE.Mesh(SPH, shellMaterial()); sh.frustumCulled = false; sh.renderOrder = 4;
    b.sh = sh; b.meshes.push(sh); this.scene.add(sh);
    if (fx.vacuum && nuke) {
      const glow = new THREE.Mesh(SPH, shellMaterial()); glow.frustumCulled = false; glow.renderOrder = 2;
      glow.material.uniforms.uAdd.value = 1; glow.material.blending = THREE.AdditiveBlending;
      b.glow = glow; b.meshes.push(glow); this.scene.add(glow);
    }
    // the mushroom cloud's particles: cap (rolling torus), stem, base surge
    if (nuke && !fx.vacuum) {
      const R = Math.random;
      for (let i = 0; i < 230; i++) b.parts.push({ role: 0, phi: R() * 6.2832, psi: R() * 6.2832, k: 0.55 + 0.6 * R(), s: 0.85 + 0.5 * R(), rot: R() * 6.28, cell: (R() * 4) | 0 });
      if (fx.hob < fx.Rfb * 3) for (let i = 0; i < 110; i++) b.parts.push({ role: 1, phi: R() * 6.2832, u: R(), k: R(), s: 0.7 + 0.6 * R(), rot: R() * 6.28, cell: (R() * 4) | 0 });
      if (fx.hob < fx.Rfb * 4) for (let i = 0; i < 90; i++) b.parts.push({ role: 2, phi: R() * 6.2832, k: 0.75 + 0.35 * R(), s: 0.7 + 0.6 * R(), rot: R() * 6.28, cell: (R() * 4) | 0 });
    }
    // chemical and kinetic: smoke and dust into the ordinary smoke system
    if (!nuke && !fx.vacuum && this.smoke) {
      const up = fx.pos.clone().normalize(), n = fx.kind === 'kinetic' ? 46 : fx.kind === 'fae' ? 40 : 28, S = fx.Rfb;
      for (let i = 0; i < n; i++) {
        const d = new THREE.Vector3().randomDirection(); if (d.dot(up) < 0) d.addScaledVector(up, -2 * d.dot(up));
        const sp = S * (0.6 + Math.random() * 1.6) * (fx.kind === 'kinetic' ? 2.2 : 1);
        const vel = d.multiplyScalar(sp).addScaledVector(up, S * (fx.kind === 'kinetic' ? 1.5 : 0.6));
        this.smoke.emit(fx.pos.clone().addScaledVector(d.normalize(), S * 0.3), vel, S * 0.7, S * (2.2 + Math.random() * 1.8), 18 + Math.random() * 16, i < n * 0.4 ? 1 : 0.1, fx.pos, 1);
      }
    }
    this.list.push(b);
    return b;
  }

  // dt: sim time step; t: world time; theta: planet rotation; groundAt(world pos) → terrain height
  update(dt, world, origin, camera, sunDir, sunCol, amb, groundAt) {
    const pl = world.planet, th = world.theta();
    const items = [];
    let flash = 0, lit = null;
    const camW = camera.position.clone().add(origin);
    for (const b of this.list) {
      const t = world.t - b.t0;
      b.age = t;
      const pos = b.fixed.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), th);
      const up = pos.clone().normalize();
      const gH = groundAt ? groundAt(pos) : 0;
      const g0 = up.clone().multiplyScalar(pl.R + gH);        // ground point under the burst
      const center = new THREE.Vector3().sub(origin);           // planet centre in render space
      for (const m of b.meshes) { m.material.uniforms.uCenter.value.copy(center); m.material.uniforms.uRg.value = b.vacuum ? 0 : pl.R + gH - 0.5; }
      // rise of the hot bubble, and the cap that grows out of it
      const hob = b.hob, top = b.Htop * 0.82;
      const Hc = b.nuke && !b.vacuum ? hob + Math.max(0, top - hob) * (1 - Math.exp(-t / b.Tr)) : hob + (b.nuke ? 0 : Math.min(b.Rfb * 2, t * b.Rfb * 0.3));
      const Rcap = b.Rfb * 0.9 + Math.max(0, 0.36 * b.Htop - b.Rfb * 0.9) * (1 - Math.exp(-t / (1.4 * b.Tr)));
      const C = g0.clone().addScaledVector(up, Hc);
      // --- fireball ---
      const u = b.fb.material.uniforms;
      const grow = 1 - Math.exp(-Math.max(t, 0) / b.tau);
      const rf = b.vacuum ? b.Rfb * (0.3 + 2.5 * Math.min(1, t / (b.tau * 30))) : Math.max(b.Rfb * grow, b.nuke ? Rcap * 0.6 * Math.min(1, t / b.tCool) : 0);
      const T = t < 3 * b.tau ? b.T0 : Math.max(500, b.T0 * Math.pow(t / (3 * b.tau), b.nuke ? -0.6 : -0.9));
      const smokeK = THREE.MathUtils.smoothstep(t, b.tCool * 0.5, b.tCool * 1.6);
      const fade = b.nuke ? 1 - THREE.MathUtils.smoothstep(t, b.tCool * 1.4, b.tCool * 3.2) : 1 - THREE.MathUtils.smoothstep(t, b.tCool, b.tCool * 2.5);
      b.fb.visible = fade > 0.002;
      b.fb.position.copy(C).sub(origin); b.fb.scale.set(rf, rf * (b.nuke ? 0.92 : 0.85), rf);
      if (b.vacuum) b.fb.scale.setScalar(rf);
      u.uTime.value = t; u.uT.value = T; u.uI.value = b.vacuum ? 260 * Math.exp(-t / (b.tau * 8)) : 400; u.uSmoke.value = b.vacuum ? 0 : smokeK;
      u.uAlpha.value = fade * (b.vacuum ? Math.exp(-t / (b.tau * 25)) : 1);
      u.uSunCol.value.copy(sunCol); u.uAmb.value.copy(amb); u.uSunV.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
      // --- shock / condensation shell ---
      const E = Math.max(b.kt, 1e-6) * 4.184e12;
      const Rs = b.vacuum ? rf * 1.6 : Math.max(1.03 * Math.pow((E * t * t) / Math.max(b.rho, 1e-6), 0.2), 340 * t);
      const shA = b.vacuum ? 0.5 * Math.exp(-t / (b.tau * 20)) : (1 - THREE.MathUtils.smoothstep(Rs, b.Rfb * 2, b.Rfb * (b.nuke ? 9 : 14))) * THREE.MathUtils.smoothstep(Rs, b.Rfb * 0.8, b.Rfb * 1.6) * (b.nuke ? 0.5 : 0.35);
      b.sh.visible = shA > 0.003 && t > 0;
      b.sh.position.copy(g0).addScaledVector(up, hob).sub(origin); b.sh.scale.setScalar(Rs);
      const su = b.sh.material.uniforms; su.uA.value = shA; su.uTime.value = t;
      su.uCol.value.set(sunCol.x, sunCol.y, sunCol.z).multiplyScalar(0.22).add(amb).multiplyScalar(b.vacuum ? 0 : 1);
      if (b.vacuum) su.uCol.value.set(30, 22, 18).multiplyScalar(Math.exp(-t / (b.tau * 12)));
      // --- vacuum: the thin air far above glows red for a while (like the Starfish Prime test) ---
      if (b.glow) {
        const ga = Math.exp(-t / 14) * Math.min(1, t * 2);
        b.glow.visible = ga > 0.003; b.glow.position.copy(C).sub(origin); b.glow.scale.setScalar(b.Rfb * (12 + t * 0.6));
        const gu = b.glow.material.uniforms; gu.uA.value = ga * 0.6; gu.uCol.value.set(2.2, 0.35, 0.25); gu.uRg.value = 0;
      }
      // --- mushroom cloud particles ---
      if (b.parts.length) {
        const e1 = new THREE.Vector3().crossVectors(up, Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
        const e2 = new THREE.Vector3().crossVectors(up, e1);
        const appear = THREE.MathUtils.smoothstep(t, b.tCool * 0.3, b.tCool * 1.3), gone = 1 - THREE.MathUtils.smoothstep(t, b.life * 0.6, b.life);
        const heat = Math.exp(-t / (b.tCool * 1.6));
        const Rmaj = Rcap * 0.62, rmin = Rcap * 0.44, om = (2 * Math.PI) / (b.Tr * 2.2);
        const p = new THREE.Vector3(), rad = new THREE.Vector3();
        for (const q of b.parts) {
          let size, alpha, h = 0;
          if (q.role === 0) {
            const psi = q.psi - om * t;
            rad.copy(e1).multiplyScalar(Math.cos(q.phi)).addScaledVector(e2, Math.sin(q.phi));
            p.copy(C).addScaledVector(rad, Rmaj + Math.cos(psi) * rmin * q.k).addScaledVector(up, Math.sin(psi) * rmin * q.k * 0.72);
            size = rmin * 1.25 * q.s; alpha = 0.95 * appear * gone; h = heat * (0.6 + 0.4 * Math.sin(psi + 1));
          } else if (q.role === 1) {
            // afterwinds: dust drawn up the stem, wider at the foot
            const uu = (q.u + t / (b.Tr * 1.8)) % 1, sr = Rcap * 0.17 * (1 + 2.2 * Math.pow(1 - uu, 6));
            const hgt = (Hc - rmin * 0.6) * uu;
            rad.copy(e1).multiplyScalar(Math.cos(q.phi)).addScaledVector(e2, Math.sin(q.phi));
            p.copy(g0).addScaledVector(up, hgt).addScaledVector(rad, sr * q.k);
            const grow2 = THREE.MathUtils.smoothstep(t, b.tCool * 0.6, b.tCool * 3) * Math.min(1, Hc / Math.max(1, hob + b.Rfb * 2));
            size = sr * 1.6 * q.s; alpha = 0.75 * grow2 * gone * Math.min(1, uu * 6) * (uu < 0.92 ? 1 : (1 - uu) / 0.08);
            if (uu > grow2) alpha = 0;
          } else {
            // base surge: a ring of dust rolling out along the ground behind the shock
            const Rg = Math.min(Rs, b.Rfb * 5.5) * q.k;
            rad.copy(e1).multiplyScalar(Math.cos(q.phi)).addScaledVector(e2, Math.sin(q.phi));
            p.copy(g0).addScaledVector(rad, Rg).addScaledVector(up, b.Rfb * 0.25);
            size = b.Rfb * 0.9 * q.s * (0.6 + 0.4 * Math.min(1, t / (b.tCool * 2)));
            alpha = 0.7 * THREE.MathUtils.smoothstep(Rs, b.Rfb * 0.8, b.Rfb * 1.6) * (1 - THREE.MathUtils.smoothstep(t, b.tCool * 4, b.life * 0.5));
          }
          if (alpha > 0.004) items.push({ x: p.x, y: p.y, z: p.z, size, alpha, heat: h, rot: q.rot + t * 0.02, cell: q.cell });
        }
      }
      // how bright it is from here: a flash that saturates the view, fading as the fireball cools
      const d = Math.max(1, camW.distanceTo(C));
      // the flash is the first instant only: it fades within about a second, then the fireball itself is what you see
      const pulse = Math.exp(-Math.max(t, 0) / (b.nuke ? 0.35 : 0.1));
      flash = Math.max(flash, 0.9 * pulse * Math.min(1, Math.pow((b.Rfb * 25) / d, 0.8)) * (b.nuke ? 1 : 0.35));
      // light thrown on the ground (strongest burst wins)
      const I = 400 * Math.pow(T / 6000, 4) * fade * 0.25;
      if (!b.vacuum && (!lit || I * rf * rf > lit.I * lit.R * lit.R)) lit = { C, I, R: rf, T };
      b.done = t > b.life;
    }
    for (const b of this.list) if (b.done) this.disposeOne(b);
    this.list = this.list.filter((b) => !b.done);
    this.flash = flash; this.lit = lit;
    if (items.length) {
      const near = this.list.find((b) => b.parts.length);
      const up = near ? near.fixed.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), th).normalize() : null;
      this.cloud.mat.uniforms.uSunCol.value.copy(sunCol); this.cloud.mat.uniforms.uAmb.value.copy(amb);
      this.cloud.mat.uniforms.uSunV.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
      const gd = up ? up.clone().multiplyScalar(pl.R).sub(origin).dot(up) : 0;
      this.cloud.drawRaw(items, origin, camera, up, gd);
    } else this.cloud.geo.instanceCount = 0;
    return this.list.length > 0;
  }
  // farthest a blast's cloud reaches from its centre (for the camera's far plane)
  reach() { let r = 0; for (const b of this.list) r = Math.max(r, b.Htop * 1.4, b.Rfb * 12); return r; }
}
