// Exhaust smoke, launch clouds and explosion puffs.
// · Trails are laid down by distance travelled through the air, evenly spaced along the nozzle's path,
//   so the column is continuous and steady at any speed or frame rate.
// · Puffs are depth-sorted every frame (no popping), rotate slowly, grow smoothly and fade softly
//   where they meet the ground.
// · Shading: each puff is lit by sampling its own density toward the sun (cheap self-shadowing),
//   shadowed sides take the sky colour, fresh exhaust glows from the flame.
// Positions live in the planet-centred frame (doubles) and are drawn relative to the floating origin.
import * as THREE from '../vendor/three.module.js';

const MAX = 2400;

// 2×2 atlas of cauliflower puffs: big lobes, a ring of billows and a fringe of small bumps, so the
// outline is lumpy and crisp. R = density (the painted coverage), G = the same blurred: a smooth dome
// used as height, so each puff is lit like a lumpy ball.
function puffAtlas() {
  const n = 512, h = n / 2, c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d');
  let s = 11; const R = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const blob = (x, y, rr, a) => { const gr = g.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.55, `rgba(255,255,255,${a * 0.55})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2); };
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * h, oy = Math.floor(q / 2) * h, cx = ox + h / 2, cy = oy + h / 2;
    g.save(); g.beginPath(); g.rect(ox, oy, h, h); g.clip();
    for (let i = 0; i < 30; i++) { const a = R() * 6.283, d = Math.pow(R(), 0.7) * h * 0.2; blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, h * (0.12 + R() * 0.15), 0.5); }
    for (let i = 0; i < 70; i++) { const a = R() * 6.283, d = h * (0.2 + R() * 0.1); blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.95, h * (0.05 + R() * 0.06), 0.55); }
    for (let i = 0; i < 160; i++) { const a = R() * 6.283, d = h * (0.27 + R() * 0.08); blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.95, h * (0.018 + R() * 0.03), 0.6); }
    g.restore();
  }
  const den = g.getImageData(0, 0, n, n).data;
  const [, bg] = (() => { const b = document.createElement('canvas'); b.width = b.height = n; return [b, b.getContext('2d', { willReadFrequently: true })]; })();
  bg.filter = 'blur(9px)'; bg.drawImage(c, 0, 0); const dome = bg.getImageData(0, 0, n, n).data;
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n * 4; i += 4) { data[i] = den[i + 3]; data[i + 1] = dome[i + 3]; data[i + 3] = 255; }
  const t = new THREE.DataTexture(data, n, n); t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

export class Smoke {
  constructor() {
    const base = new THREE.PlaneGeometry(1, 1);
    const g = (this.geo = new THREE.InstancedBufferGeometry());
    g.index = base.index; g.attributes.position = base.attributes.position;
    const attr = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('iPos', (this.aPos = attr(3)));
    g.setAttribute('iData', (this.aData = attr(4))); // size, alpha, heat, rotation
    g.setAttribute('iVar', (this.aVar = attr(1)));  // atlas cell
    g.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        tPuff: { value: puffAtlas() }, uSunCol: { value: new THREE.Vector3(1, 1, 1) }, uAmb: { value: new THREE.Vector3(0.2, 0.2, 0.25) },
        uSunV: { value: new THREE.Vector3(0, 1, 0) }, uUpV: { value: new THREE.Vector3(0, 1, 0) }, uGroundD: { value: -1e9 }, uFlameV: { value: new THREE.Vector3() }, uFlameI: { value: 0 }, uFlameCol: { value: new THREE.Color(1, 0.55, 0.2) }, uTint: { value: new THREE.Color(1, 1, 1) }, uHeatCol: { value: new THREE.Color(1, 0.32, 0.06) },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec4 iData; attribute float iVar;
        uniform vec3 uSunV, uUpV, uFlameV; uniform float uGroundD, uFlameI;
        varying vec2 vUv; varying vec2 vCell; varying vec2 vLight; varying float vA, vH, vGround; varying vec2 vRot0; varying float vFl; varying vec3 vFd;
        void main() {
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          vec3 dF = uFlameV - mv.xyz; vFl = uFlameI / (dot(dF, dF) * 0.6 + iData.x * iData.x * 0.1 + 1.0); vFd = normalize(dF + vec3(0.0, 0.0, 1e-3));
          float c = cos(iData.w), s = sin(iData.w);
          mv.xy += position.xy * iData.x;
          vUv = mat2(c, -s, s, c) * position.xy + 0.5;
          vCell = vec2(mod(iVar, 2.0), floor(iVar / 2.0)) * 0.5;
          vec2 l = uSunV.xy; float ll = length(l); l = ll > 1e-4 ? l / ll : vec2(0.0, 1.0);
          vLight = mat2(c, -s, s, c) * l; vRot0 = vec2(c, s);
          vA = iData.y; vH = iData.z;
          vGround = (dot(mv.xyz, uUpV) - uGroundD) / max(iData.x * 0.28, 0.5);   // linear across the quad: clamp per pixel, not per corner
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tPuff; uniform vec3 uSunCol, uAmb, uSunV;
        varying vec2 vUv; varying vec2 vCell; varying vec2 vLight; varying float vA, vH, vGround;
        uniform vec3 uUpV, uFlameCol, uTint, uHeatCol;
        varying vec2 vRot0; varying float vFl; varying vec3 vFd;
        vec2 tx(vec2 uv) { return vCell + clamp(uv, 0.002, 0.998) * 0.5; }
        float dens(vec2 uv) { return texture2D(tPuff, tx(uv)).r; }
        void main() {
          vec4 s0 = texture2D(tPuff, tx(vUv));
          float d = s0.r;
          float a = smoothstep(0.06, 0.5, d) * vA * smoothstep(0.0, 1.0, clamp(vGround, 0.0, 1.0));
          if (a < 0.003) discard;
          // light it like a lumpy ball: a normal from the height channel, then soft wrap lighting
          float e = 0.012;
          float hx = texture2D(tPuff, tx(vUv + vec2(e, 0.0))).g - texture2D(tPuff, tx(vUv - vec2(e, 0.0))).g;
          float hy = texture2D(tPuff, tx(vUv + vec2(0.0, e))).g - texture2D(tPuff, tx(vUv - vec2(0.0, e))).g;
          vec2 g2 = mat2(vRot0.x, vRot0.y, -vRot0.y, vRot0.x) * vec2(hx, hy);
          vec3 n = normalize(vec3(-g2 * 11.0, max(s0.g, 0.12)));
          float occl = dens(vUv + vLight * 0.08) + 0.6 * dens(vUv + vLight * 0.18);
          float self = clamp(1.15 - occl * 1.25, 0.07, 1.0);
          float wrap = clamp(dot(n, uSunV) * 0.8 + 0.2, 0.0, 1.0);
          // light through thin edges when looking toward the sun
          float back = pow(max(-uSunV.z, 0.0), 3.0) * (1.0 - d) * 1.6;
          float sky = 0.55 + 0.45 * dot(n, uUpV);
          vec3 col = 0.9 / 3.14159 * (uSunCol * (wrap * self + back) + uAmb * (0.3 + 0.75 * sky)) * uTint;
          // glowing exhaust: yellow-white where it is hottest, deep orange as it cools
          col += mix(uHeatCol, vec3(1.0, 0.72, 0.35), vH) * vH * vH * (0.6 + 0.4 * d) * 6.0;
          // underlit by the flame: warm on the side that faces it, golden close in, deep orange farther out
          float fl = vFl * (0.3 + 0.7 * clamp(dot(n, vFd) * 0.7 + 0.3, 0.0, 1.0)) * (0.55 + 0.45 * d);
          col += mix(uFlameCol * uFlameCol, uFlameCol, smoothstep(0.5, 6.0, vFl)) * fl;
          gl_FragColor = vec4(col, min(1.0, a));
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
    this.n = 0;
    this.p = new Float64Array(MAX * 3); this.v = new Float64Array(MAX * 3); this.e = new Float64Array(MAX * 3);
    this.f = new Float32Array(MAX * 10); // age, life, size0, size1, heat0, seed, opacity, spin, hit the ground, carried by the jet
    this.depth = new Float32Array(MAX);
    this.trails = new Map();
  }
  clear() { this.n = 0; this.geo.instanceCount = 0; this.trails.clear(); }
  emit(pos, vel, size0, size1, life, heat, emitter, opacity = 1) {
    let i = this.n;
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
    f[j + 6] = opacity; f[j + 7] = (Math.random() - 0.5) * 0.5; f[j + 8] = 0; f[j + 9] = 0;
    return i;
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
    const n = Math.min(MAX, items.length);
    const cx = camera.position.x + origin.x, cy = camera.position.y + origin.y, cz = camera.position.z + origin.z;
    for (const it of items) it.dd = (it.x - cx) ** 2 + (it.y - cy) ** 2 + (it.z - cz) ** 2;
    items.sort((a, b) => b.dd - a.dd);
    const P = this.aPos.array, D = this.aData.array, Vv = this.aVar.array;
    for (let s = 0; s < n; s++) {
      const it = items[s];
      P[s * 3] = it.x - origin.x; P[s * 3 + 1] = it.y - origin.y; P[s * 3 + 2] = it.z - origin.z;
      D[s * 4] = it.size; D[s * 4 + 1] = it.alpha; D[s * 4 + 2] = it.heat; D[s * 4 + 3] = it.rot; Vv[s] = it.cell;
    }
    this.geo.instanceCount = n;
    for (const a of [this.aPos, this.aData, this.aVar]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * a.itemSize); }
    const u = this.mat.uniforms, vm = camera.matrixWorldInverse;
    u.uFlameI.value = 0;
    if (groundUp) { u.uUpV.value.copy(groundUp).transformDirection(vm); const gp = groundUp.clone().multiplyScalar(groundDist).applyMatrix4(vm); u.uGroundD.value = gp.dot(u.uUpV.value); } else u.uGroundD.value = -1e9;
  }
  endTrails(keep) { for (const k of [...this.trails.keys()]) if (!keep.has(k)) this.trails.delete(k); }

  update(dt, planet, origin, camera, groundUp, groundDist) {
    const R = planet.R, om = planet.omega, p = this.p, v = this.v, f = this.f, e = this.e;
    let n = this.n;
    const damp = 1 - Math.exp(-dt * 0.9);
    for (let i = 0; i < n; i++) {
      const k = i * 3, j = i * 10;
      f[j] += dt;
      if (f[j] > f[j + 1]) { // retire: move the last particle into this slot
        n--; const m = n * 3, mj = n * 10;
        for (let c = 0; c < 3; c++) { p[k + c] = p[m + c]; v[k + c] = v[m + c]; e[k + c] = e[m + c]; }
        for (let c = 0; c < 10; c++) f[j + c] = f[mj + c];
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
      const tb = 1.6 * Math.min(1, tt * 0.5);
      const we = ws * Math.cos(wa) + tb * Math.sin(tt * 0.9 + se), wn = ws * Math.sin(wa) + tb * Math.sin(tt * 0.7 + se * 1.7), wu = tb * 0.5 * Math.sin(tt * 1.1 + se * 2.3);
      const ax = om * z + ex * we + nx * wn + ux * wu, ay = ny * wn + uy * wu, az = -om * x + ez * we + nz * wn + uz * wu;
      const dk = f[j + 9] > 0 ? 1 - Math.exp(-dt * (0.9 + 6 * Math.exp(-f[j] * 3))) : damp;   // jet-carried exhaust brakes hard at first
      v[k] += (ax - v[k]) * dk; v[k + 1] += (ay - v[k + 1]) * dk; v[k + 2] += (az - v[k + 2]) * dk;
      const lift = (0.8 + 3.2 * f[j + 8]) * dt * Math.exp(-f[j] * (f[j + 8] > 0 ? 0.12 : 0.08));
      v[k] += ux * lift; v[k + 1] += uy * lift; v[k + 2] += uz * lift;
      // reaching the ground: turn downward motion into a spread outward from where it was emitted
      const size = f[j + 2] + (f[j + 3] - f[j + 2]) * (1 - Math.exp(-f[j] * 1.6)) + f[j] * 0.35;
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
          let hn = Math.hypot(hx, hy, hz) || 1, s = -vr * 0.8;
          if (f[j + 8] === 0) f[j + 4] = Math.max(f[j + 4], 1);   // fresh exhaust slamming into the pad: the fireball at the base
          f[j + 8] = 1;                                   // steam off the pad: it boils upward from now on
          const D = this.deflect;
          if (D && Math.hypot(x - D.pos.x, y - D.pos.y, z - D.pos.z) < D.R) {     // the flame channel sends it one way
            hx = hx / hn * 0.65 + D.dir.x; hy = hy / hn * 0.65 + D.dir.y; hz = hz / hn * 0.65 + D.dir.z; hn = Math.hypot(hx, hy, hz) || 1; s *= 1.3;
          }
          v[k] += -ux * vr + (hx / hn) * s; v[k + 1] += -uy * vr + (hy / hn) * s; v[k + 2] += -uz * vr + (hz / hn) * s;
        }
      }
      p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
      e[k] += om * e[k + 2] * dt; e[k + 2] += -om * e[k] * dt;
    }
    this.n = n;
    // draw back to front so overlapping puffs never swap
    const cx = camera.position.x + origin.x, cy = camera.position.y + origin.y, cz = camera.position.z + origin.z, depth = this.depth;
    const ord = new Array(n);
    for (let i = 0; i < n; i++) { const k = i * 3, dx = p[k] - cx, dy = p[k + 1] - cy, dz = p[k + 2] - cz; depth[i] = dx * dx + dy * dy + dz * dz; ord[i] = i; }
    ord.sort((a, b) => depth[b] - depth[a]);
    const P = this.aPos.array, D = this.aData.array, Vv = this.aVar.array;
    for (let s = 0; s < n; s++) {
      const i = ord[s], k = i * 3, j = i * 10, age = f[j], t = age / f[j + 1];
      P[s * 3] = p[k] - origin.x; P[s * 3 + 1] = p[k + 1] - origin.y; P[s * 3 + 2] = p[k + 2] - origin.z;
      const fi = Math.min(1, age / (f[j + 9] > 0 ? 0.35 : 0.18)), fo = 1 - Math.max(0, (t - 0.45) / 0.55);
      D[s * 4] = f[j + 2] + (f[j + 3] - f[j + 2]) * (1 - Math.exp(-age * 1.6)) + age * 0.35;
      D[s * 4 + 1] = fi * fi * (3 - 2 * fi) * fo * fo * 0.7 * f[j + 6];
      D[s * 4 + 2] = f[j + 4] * Math.exp(-age * (f[j + 8] > 0 ? 1.4 : 4));
      D[s * 4 + 3] = f[j + 5] * 6.2832 + age * f[j + 7];
      Vv[s] = Math.floor(f[j + 5] * 4) % 4;
    }
    this.geo.instanceCount = n;
    for (const a of [this.aPos, this.aData, this.aVar]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * a.itemSize); }
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
