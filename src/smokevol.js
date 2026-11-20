// Volumetric launch cloud. The puffs the particle system simulates near the pad are turned into a real volume and
// ray-marched, so the cloud has depth, self-shadowing and billows down to a few metres, like the sky's clouds.
//
// Each frame, on the GPU:
//  1. splat: every puff inside the box is drawn as a soft sphere into a 3D density grid (128 × 64 × 128 voxels of
//     5 m, stored as 64 horizontal slices tiled in one 2D texture). Channels: extinction (1/m), and heat, soot and
//     age weighted by it.
//  2. light: a half-resolution grid of how much light reaches each voxel through the rest of the cloud, from the
//     sun, from the open sky above and from the engines' flame.
//  3. march: at the sky pass's resolution, each pixel's ray crosses the box up to the nearest solid surface (a
//     depth pre-pass of the scene), sampling the grid eroded by the clouds' billow noise, lit from the light grid.
//  4. the result is drawn over the scene (before bloom, so the flame-lit steam glows).
// Puffs are handed between the particle sprites and the volume with a soft weight across the box's margin, so
// nothing pops when one drifts out. The box is anchored to the ground under the pad and turns with the planet.
import * as THREE from '../vendor/three.module.js';

const NX = 128, NY = 64, NZ = 128, VOX = 5;           // density grid and voxel size (m)
const TX = 8, TY = NY / TX;                          // slices tiled 8 across
const LX = 64, LY = 32, LZ = 64, LTX = 8, LTY = LY / LTX;   // light grid (half resolution)
const SPAN = 15;                                      // slices a puff may cover (radius up to 7 voxels)
const W = NX * VOX, H = NY * VOX, D = NZ * VOX;      // box size (m): 640 × 320 × 640
const MAXP = 6000;

// trilinear lookup in a slice atlas: q in voxel units
const ATLAS_GLSL = (name, nx, ny, nz, tx) => /* glsl */`
  vec4 ${name}At(vec3 q) {
    float fy = clamp(q.y - 0.5, 0.0, ${(ny - 1).toFixed(1)} - 0.001); float k = floor(fy), w = fy - k;
    vec2 xz = clamp(q.xz, vec2(0.5), vec2(${(nx - 0.5).toFixed(1)}, ${(nz - 0.5).toFixed(1)}));
    vec2 sz = vec2(${(nx * tx).toFixed(1)}, ${(nz * (ny / tx)).toFixed(1)});
    vec2 t0 = vec2(mod(k, ${tx.toFixed(1)}), floor(k / ${tx.toFixed(1)})), t1 = vec2(mod(k + 1.0, ${tx.toFixed(1)}), floor((k + 1.0) / ${tx.toFixed(1)}));
    return mix(texture(${name}, (t0 * vec2(${nx.toFixed(1)}, ${nz.toFixed(1)}) + xz) / sz), texture(${name}, (t1 * vec2(${nx.toFixed(1)}, ${nz.toFixed(1)}) + xz) / sz), w);
  }`;

const quadVert = /* glsl */`
  out vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class SmokeVolume {
  constructor(renderer, noise) {
    this.r = renderer; this.active = false; this.anchorF = null; this.n = 0;
    const rt = (w, h) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.denRT = rt(NX * TX, NZ * TY);
    this.litRT = rt(LX * LTX, LZ * LTY);
    this.volRT = rt(16, 16);
    this.depthRT = new THREE.WebGLRenderTarget(16, 16, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.PlaneGeometry(2, 2);

    // ---- particle data: two texels per puff ----
    this.pdata = new Float32Array(1024 * Math.ceil((MAXP * 2) / 1024) * 4);
    this.ptex = new THREE.DataTexture(this.pdata, 1024, Math.ceil((MAXP * 2) / 1024), THREE.RGBAFormat, THREE.FloatType);
    this.ptex.minFilter = this.ptex.magFilter = THREE.NearestFilter;

    // ---- 1. splat ----
    const sg = new THREE.InstancedBufferGeometry(); sg.index = quad.index; sg.setAttribute('position', quad.attributes.position); sg.instanceCount = 0;
    this.splatMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { tP: { value: this.ptex } },
      vertexShader: /* glsl */`
        uniform highp sampler2D tP;
        out vec2 vXZ; out vec3 vC; out vec4 vB; out float vR;
        void main() {
          int id = gl_InstanceID / ${SPAN}, s = gl_InstanceID - id * ${SPAN};
          vec4 a = texelFetch(tP, ivec2((id * 2) % 1024, (id * 2) / 1024), 0);
          vec4 b = texelFetch(tP, ivec2((id * 2 + 1) % 1024, (id * 2 + 1) / 1024), 0);
          float k = floor(a.y) + float(s - ${(SPAN - 1) / 2});
          float dy = k + 0.5 - a.y, rr2 = a.w * a.w - dy * dy;
          if (k < 0.0 || k > ${(NY - 1).toFixed(1)} || rr2 <= 0.0 || b.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float rr = sqrt(rr2) + 1.0;
          vec2 px = clamp(a.xz + position.xy * rr, vec2(0.0), vec2(${NX.toFixed(1)}, ${NZ.toFixed(1)}));
          vec2 tile = vec2(mod(k, ${TX.toFixed(1)}), floor(k / ${TX.toFixed(1)})) * vec2(${NX.toFixed(1)}, ${NZ.toFixed(1)});
          gl_Position = vec4((tile + px) / vec2(${(NX * TX).toFixed(1)}, ${(NZ * TY).toFixed(1)}) * 2.0 - 1.0, 0.0, 1.0);
          vXZ = px; vC = vec3(a.x, dy, a.z); vB = b; vR = a.w;
        }`,
      fragmentShader: /* glsl */`
        in vec2 vXZ; in vec3 vC; in vec4 vB; in float vR; out vec4 oCol;
        void main() {
          vec2 d = vXZ - vC.xz; float q2 = (dot(d, d) + vC.y * vC.y) / (vR * vR);
          if (q2 >= 1.0) discard;
          float f = (1.0 - q2) * (1.0 - q2) * vB.x;
          oCol = vec4(f, f * vB.y, f * vB.z, f * vB.w);
        }`,
    });
    this.splatScene = new THREE.Scene(); const sm = new THREE.Mesh(sg, this.splatMat); sm.frustumCulled = false; this.splatScene.add(sm); this.splatGeo = sg;

    // ---- 2. light ----
    this.litMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
      uniforms: { tDen: { value: this.denRT.texture }, uSunB: { value: new THREE.Vector3(0, 1, 0) }, uFlameB: { value: new THREE.Vector3() }, uFlameOn: { value: 0 }, uCovK: { value: 9.0 }, uExt: { value: 0.25 } },
      vertexShader: quadVert,
      fragmentShader: /* glsl */`
        uniform sampler2D tDen; uniform vec3 uSunB, uFlameB; uniform float uFlameOn, uCovK, uExt; in vec2 vUv; out vec4 oCol;
        ${ATLAS_GLSL('tDen', NX, NY, NZ, TX)}
        // the smoke the march draws, without its billows: what actually stands between a voxel and the light
        float ext(vec3 q) { float cov = 1.0 - exp(-tDenAt(q).r * uCovK); return smoothstep(0.3, 0.7, cov) * uExt * (0.35 + 0.65 * cov); }
        bool inside(vec3 q) { return all(greaterThanEqual(q, vec3(0.0))) && all(lessThan(q, vec3(${NX.toFixed(1)}, ${NY.toFixed(1)}, ${NZ.toFixed(1)}))); }
        void main() {
          vec2 px = vUv * vec2(${(LX * LTX).toFixed(1)}, ${(LZ * LTY).toFixed(1)});
          vec2 tile = floor(px / vec2(${LX.toFixed(1)}, ${LZ.toFixed(1)}));
          vec2 xz = px - tile * vec2(${LX.toFixed(1)}, ${LZ.toFixed(1)});
          float k = tile.y * ${LTX.toFixed(1)} + tile.x;
          vec3 q = vec3(xz.x, k + 0.5, xz.y) * vec3(${(NX / LX).toFixed(1)}, ${(NY / LY).toFixed(1)}, ${(NZ / LZ).toFixed(1)});   // in density voxels
          // sun: steps growing outward, in metres
          float tau = 0.0, prev = 0.0;
          for (int i = 0; i < 10; i++) {
            float d = 3.0 * pow(1.55, float(i)) + 2.0;
            vec3 p = q + uSunB * (d / ${VOX.toFixed(1)});
            if (!inside(p)) break;
            tau += ext(p) * (d - prev); prev = d;
          }
          float tauU = 0.0; prev = 0.0;
          for (int i = 0; i < 6; i++) {
            float d = 4.0 * pow(1.7, float(i)) + 2.0;
            vec3 p = q + vec3(0.0, d / ${VOX.toFixed(1)}, 0.0);
            if (p.y >= ${NY.toFixed(1)}) break;
            tauU += ext(p) * (d - prev); prev = d;
          }
          float tauF = 0.0;
          if (uFlameOn > 0.5) {
            vec3 dv = uFlameB - q; float L = length(dv) * ${VOX.toFixed(1)}, span = max(0.0, L - 6.0);
            vec3 dir = dv / max(length(dv), 1e-3);
            for (int i = 0; i < 8; i++) { float t = (float(i) + 0.5) / 8.0 * span; vec3 p = q + dir * (t / ${VOX.toFixed(1)}); if (inside(p)) tauF += ext(p) * span / 8.0; }
          }
          // light scatters forward through steam: the extinction that matters for lighting is well below the visible one
          oCol = vec4(exp(-0.35 * tau), exp(-0.3 * tauU), exp(-0.3 * tauF), 1.0);
        }`,
    });
    this.litScene = new THREE.Scene(); this.litScene.add(new THREE.Mesh(quad, this.litMat));

    // ---- 3. march ----
    this.marchMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
      uniforms: {
        tDen: { value: this.denRT.texture }, tLit: { value: this.litRT.texture }, tDepth: { value: this.depthRT.texture }, tNoise: { value: noise },
        uCamB: { value: new THREE.Vector3() }, uViewToBox: { value: new THREE.Matrix3() }, uTan: { value: 1 }, uAspect: { value: 1 },
        uSunB: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Vector3(1, 1, 1) }, uAmb: { value: new THREE.Vector3(0.2, 0.25, 0.3) }, uGnd: { value: new THREE.Vector3(0.05, 0.04, 0.03) },
        uFlameB: { value: new THREE.Vector3() }, uFlameI: { value: 0 }, uFlameCol: { value: new THREE.Color(1, 0.6, 0.3) }, uHeatCol: { value: new THREE.Color(1, 0.32, 0.06) },
        uTime: { value: 0 }, uFrame: { value: 0 }, uCovK: { value: 9.0 }, uExt: { value: 0.5 }, uFog: { value: 0 }, uFogCol: { value: new THREE.Vector3() }, uQ: { value: 1 },
      },
      vertexShader: quadVert,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tDen, tLit; uniform highp sampler2D tDepth; uniform highp sampler3D tNoise;
        uniform vec3 uCamB, uSunB, uSunCol, uAmb, uGnd, uFlameB, uFogCol; uniform mat3 uViewToBox;
        uniform float uTan, uAspect, uFlameI, uTime, uFrame, uFog, uQ; uniform vec3 uFlameCol, uHeatCol;
        in vec2 vUv; out vec4 oCol;
        ${ATLAS_GLSL('tDen', NX, NY, NZ, TX)}
        ${ATLAS_GLSL('tLit', LX, LY, LZ, LTX)}
        uniform float uCovK, uExt;
        vec3 gRise;
        // the carved smoke at p (box metres): returns visible extinction (1/m); out: coverage and the billow noise
        float smokeAt(vec3 p, out vec4 dn, out float cov, out float nb, bool fine, float t) {
          dn = tDenAt(p / ${VOX.toFixed(1)});
          if (dn.r < 2e-4) { cov = 0.0; nb = 0.5; return 0.0; }
          cov = 1.0 - exp(-dn.r * uCovK);
          nb = texture(tNoise, (p + gRise) * (1.0 / 240.0)).r;   // billows of 60, 30 and 15 m
          float nd = texture(tNoise, (p + gRise * 1.6) * (1.0 / 120.0) + 0.37).g;   // lumps of 15, 7 and 4 m
          // (no lumps out of thin air: the noise needs some smoke to work on)
          float c = cov + ((nb - 0.5) * 1.15 + (nd - 0.5) * 0.4) * smoothstep(0.03, 0.3, cov) - 0.12 * (1.0 - cov);
          if (fine && abs(c - 0.52) < 0.2 && t < 900.0) c += (texture(tNoise, (p + gRise * 2.2) * (1.0 / 60.0) + 0.71).g - 0.5) * 0.14 * (1.0 - smoothstep(300.0, 900.0, t));
          return smoothstep(0.46, 0.58, c) * uExt * (0.35 + 0.65 * cov);
        }
        float hg(float g, float c) { float k = 1.0 + g * g - 2.0 * g * c; return (1.0 - g * g) / (k * sqrt(k)); }
        void main() {
          vec3 dv = normalize(vec3((vUv.x * 2.0 - 1.0) * uTan * uAspect, (vUv.y * 2.0 - 1.0) * uTan, -1.0));
          vec3 rd = normalize(uViewToBox * dv), ro = uCamB;
          // the box: [0,W] × [0,H] × [0,D] metres
          vec3 inv = 1.0 / rd, t0s = (vec3(0.0) - ro) * inv, t1s = (vec3(${W.toFixed(1)}, ${H.toFixed(1)}, ${D.toFixed(1)}) - ro) * inv;
          vec3 tmn = min(t0s, t1s), tmx = max(t0s, t1s);
          float tIn = max(max(tmn.x, tmn.y), max(tmn.z, 0.0)), tOut = min(min(tmx.x, tmx.y), tmx.z);
          float dep = texture(tDepth, vUv).r;
          if (dep > 0.0) tOut = min(tOut, dep / max(-dv.z, 1e-3) * length(dv));   // stored: distance along the view axis
          if (tOut <= tIn) { oCol = vec4(0.0); return; }
          float cs = dot(rd, uSunB);
          float phase = 0.7 * hg(0.1, cs) + 0.3 * hg(0.7, cs);
          // jitter the start: interleaved gradient noise, moved every frame
          float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * 5.588238, vec2(0.06711056, 0.00583715))));
          float T = 1.0, t = tIn, dt = 1.8 * uQ, tw = 0.0, ww = 0.0; bool fineS = false;
          t += dt * jit;
          vec3 L = vec3(0.0);
          gRise = vec3(0.6, -2.2, 0.3) * uTime;   // the billows boil upward (the pattern sinks through the field)
          for (int i = 0; i < 160; i++) {
            if (t >= tOut || T < 0.01) break;
            vec3 p = ro + rd * t, q = p / ${VOX.toFixed(1)};
            vec4 dn; float cov, nb;
            float ext = smokeAt(p, dn, cov, nb, true, t);
            if (dn.r < 2e-4) { t += dt * 3.0; fineS = false; continue; }   // empty: stride
            // the surface is a metre or two thick: on first touching smoke, step back and cross it in fine steps
            if (!fineS && ext > 1e-4) { fineS = true; t -= dt * 0.9; continue; }
            if (ext > 1e-4) {
              vec3 lt = tLitAt(q * vec3(${(LX / NX).toFixed(2)}, ${(LY / NY).toFixed(2)}, ${(LZ / NZ).toFixed(2)})).rgb;
              float iw = 1.0 / dn.r, heat = dn.g * iw, soot = dn.b * iw, age = dn.a * iw;
              // the billow's own height in the noise darkens its creases: detail that reads even in flat light
              float crease = 0.5 + 0.5 * smoothstep(0.2, 0.75, nb);

              // each billow's own light: two short steps toward the sun and one up through the carved smoke (the
              // grid above only knows the smooth field), so every lump has a lit side and a shaded crease
              vec4 d2; float c2, n2;
              float tl = 0.0;
              if (T > 0.08) tl = smokeAt(p + uSunB * 5.0, d2, c2, n2, false, t) * 5.0 + smokeAt(p + uSunB * 16.0, d2, c2, n2, false, t) * 12.0;
              float tu = T > 0.08 ? smokeAt(p + vec3(0.0, 7.0, 0.0), d2, c2, n2, false, t) * 7.0 : 0.0;
              float Ts = lt.r * exp(-tl * 0.5), Tk = lt.g * exp(-tu * 0.3), Tf = lt.b;
              crease = mix(crease, 1.0, 0.25);
              vec3 alb = mix(vec3(0.86, 0.85, 0.84), vec3(0.12, 0.11, 0.1), soot);
              alb *= mix(vec3(0.85, 0.77, 0.66), vec3(1.0), smoothstep(4.0, 22.0, p.y));   // dust the cloud scours off the ground
              vec3 sun = uSunCol * (Ts * min(phase, 5.0) + 0.12 * pow(Ts, 0.3));
              vec3 sky = uAmb * (0.15 + 0.85 * Tk) * (0.5 + 0.5 * smoothstep(0.0, 1.0, nb));
              vec3 gnd = uGnd * (1.0 - Tk * 0.5);
              // the flame: inverse square, through the steam between; golden near, deep orange farther out
              vec3 fd = uFlameB * ${VOX.toFixed(1)} - p; float fd2 = dot(fd, fd);
              float fl = uFlameI * 0.8 / (fd2 * 0.5 + 30.0); fl /= 1.0 + fl * 0.05;
              vec3 warm = mix(uFlameCol, vec3(1.0, 0.56, 0.22), 0.6);
              vec3 flc = mix(warm * vec3(1.0, 0.62, 0.32), warm, smoothstep(0.5, 6.0, fl)) * fl * (0.03 + 0.75 * Tf * Tf + 0.22 * Tf);   // direct, plus the glow diffusing out through the steam
              vec3 c = (0.75 / 3.14159) * (sun + sky + gnd) * alb * crease + flc * alb;
              c += mix(uHeatCol, vec3(1.0, 0.72, 0.35), heat) * heat * heat * 5.0;   // fresh exhaust still glowing
              float a = 1.0 - exp(-ext * (fineS ? max(0.5, t * 0.002) * uQ : dt));
              L += T * a * c; tw += T * a * t; ww += T * a;
              T *= 1.0 - a;
            }
            float st = fineS ? max(0.5, t * 0.002) * uQ : dt * (1.0 + t * 0.002);
            if (fineS && ext <= 1e-4 && T > 0.98) fineS = false;
            t += st;
          }
          if (ww > 1e-4) {   // aerial haze in front of the smoke, as on the rest of the scene
            float f = 1.0 - exp(-uFog * tw / ww);
            L = mix(L, uFogCol * (1.0 - T), f);
          }
          oCol = vec4(L, 1.0 - T);
        }`,
    });
    this.marchScene = new THREE.Scene(); this.marchScene.add(new THREE.Mesh(quad, this.marchMat));

    // ---- depth pre-pass material: distance along the view axis ----
    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        #include <common>
        #include <batching_pars_vertex>
        varying float vZ;
        void main() {
          #include <batching_vertex>
          #include <begin_vertex>
          #include <project_vertex>
          vZ = -mvPosition.z;
        }`,
      fragmentShader: /* glsl */`varying float vZ; void main() { gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }`,
    });

    // ---- 4. composite: a full-screen quad in the main scene ----
    this.compMat = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: { tVol: { value: this.volRT.texture }, uTexel: { value: new THREE.Vector2(1, 1) } },
      vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      // upsampled with a small tent filter: takes the edge off the march's per-pixel noise without blurring billows
      fragmentShader: /* glsl */`uniform sampler2D tVol; uniform vec2 uTexel; varying vec2 vUv;
        void main() {
          vec4 v = texture2D(tVol, vUv) * 0.4;
          v += (texture2D(tVol, vUv + vec2(uTexel.x, 0.0)) + texture2D(tVol, vUv - vec2(uTexel.x, 0.0)) + texture2D(tVol, vUv + vec2(0.0, uTexel.y)) + texture2D(tVol, vUv - vec2(0.0, uTexel.y))) * 0.15;
          if (v.a < 0.002) discard;
          gl_FragColor = v;
        }`,
    });
    this.comp = new THREE.Mesh(quad, this.compMat);
    this.comp.frustumCulled = false; this.comp.renderOrder = 6; this.comp.visible = false;

    this.ex = new THREE.Vector3(); this.ey = new THREE.Vector3(); this.ez = new THREE.Vector3(); this.c0 = new THREE.Vector3();
  }

  // the box sits on the ground point gF (fixed planet frame), centred on it horizontally
  anchor(gF) { this.anchorF = gF.clone(); this.idle = 0; }
  clear() { this.anchorF = null; this.active = false; this.comp.visible = false; }

  // frame: where the box is now (the planet turns), and the weight of every puff (1 = in the volume)
  place(theta) {
    if (!this.anchorF) return false;
    const up = this.ey.copy(this.anchorF).applyAxisAngle(new THREE.Vector3(0, 1, 0), theta);
    const R = up.length(); up.divideScalar(R);
    this.ex.crossVectors(new THREE.Vector3(0, 1, 0), up).normalize();   // east
    this.ez.crossVectors(this.ex, up);                                 // south (keeps the axes right-handed)
    // corner of the box (x = 0, y = 0, z = 0): a little below the ground
    this.c0.copy(up).multiplyScalar(R - 6).addScaledVector(this.ex, -W / 2).addScaledVector(this.ez, -D / 2);
    return true;
  }
  toBox(x, y, z, out) {
    const dx = x - this.c0.x, dy = y - this.c0.y, dz = z - this.c0.z;
    return out.set(dx * this.ex.x + dy * this.ex.y + dz * this.ex.z, dx * this.ey.x + dy * this.ey.y + dz * this.ey.z, dx * this.ez.x + dy * this.ez.y + dz * this.ez.z);
  }

  // Take the puffs that are inside the box out of the sprite system: fill the particle texture and smoke.vw.
  collect(smoke, n) {
    const p = smoke.p, sz = smoke.sz, al = smoke.al, f = smoke.f, vw = smoke.vw, P = this.pdata, q = new THREE.Vector3();
    let m = 0;
    const M = 40;   // the margin (m) over which a puff fades from the volume into a sprite
    for (let i = 0; i < n; i++) {
      vw[i] = 0;
      if (al[i] < 0.004 || m >= MAXP) continue;
      this.toBox(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], q);
      const r = 0.42 * sz[i];
      const edge = Math.min(q.x, W - q.x, q.z, D - q.z, H - q.y) - r * 0.5;
      if (edge <= 0 || q.y < -r) continue;
      const w = Math.min(1, edge / M) * (r / VOX < 7 ? 1 : Math.max(0, 1 - (r / VOX - 7) / 2));   // too big for the grid: stays a sprite
      if (w <= 0) continue;
      vw[i] = w;
      const j = i * 10, rv = Math.min(7, r / VOX);
      // extinction at the centre from the puff's opacity over its diameter (profile (1-q²)² integrates to ~1.07 r)
      const ext = -Math.log(1 - Math.min(0.97, al[i])) / (1.07 * r) * w;
      const heat = f[j + 4] * Math.exp(-f[j] * (f[j + 8] > 0 ? 1.4 : 4));
      const o = m * 8;
      P[o] = q.x / VOX; P[o + 1] = q.y / VOX; P[o + 2] = q.z / VOX; P[o + 3] = rv;
      P[o + 4] = ext; P[o + 5] = heat; P[o + 6] = smoke.soot[i] / 7; P[o + 7] = f[j];
      m++;
    }
    this.n = m;
    return m;
  }

  // run passes 1–3; the composite quad draws with the scene
  render(scene, cam, origin, w, h, u) {
    const r = this.r, prevRT = r.getRenderTarget(), prevAuto = r.autoClear, cc = new THREE.Color(), ca = r.getClearAlpha();
    r.getClearColor(cc);
    this.comp.visible = false;
    if (!this.n) { return; }
    this.ptex.needsUpdate = true;
    this.splatGeo.instanceCount = this.n * SPAN;
    r.autoClear = true; r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.denRT); r.render(this.splatScene, this.quadCam);
    // light
    const lu = this.litMat.uniforms;
    lu.uSunB.value.copy(u.sunB); lu.uFlameOn.value = u.flameI > 0 ? 1 : 0; lu.uFlameB.value.copy(u.flameB);
    r.setRenderTarget(this.litRT); r.render(this.litScene, this.quadCam);
    // depth of everything solid
    if (this.depthRT.width !== w || this.depthRT.height !== h) { this.depthRT.setSize(w, h); this.volRT.setSize(w, h); this.compMat.uniforms.uTexel.value.set(0.75 / w, 0.75 / h); }
    const bg = scene.background, ov = scene.overrideMaterial, hidden = [];
    for (const o of u.hide) if (o && o.visible) { o.visible = false; hidden.push(o); }
    // (no shadow maps for this pass: they were drawn for the frame already, and redrawing them doubled its cost)
    const sAuto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    scene.background = null; scene.overrideMaterial = this.depthMat;
    r.setRenderTarget(this.depthRT); r.clear(); r.render(scene, cam);
    scene.background = bg; scene.overrideMaterial = ov; for (const o of hidden) o.visible = true;
    r.shadowMap.autoUpdate = sAuto;
    // march
    const mu = this.marchMat.uniforms;
    const camW = cam.position.clone().add(origin);
    this.toBox(camW.x, camW.y, camW.z, mu.uCamB.value);
    const B = new THREE.Matrix3().set(this.ex.x, this.ex.y, this.ex.z, this.ey.x, this.ey.y, this.ey.z, this.ez.x, this.ez.y, this.ez.z);
    mu.uViewToBox.value.copy(B).multiply(new THREE.Matrix3().setFromMatrix4(cam.matrixWorld));
    mu.uTan.value = Math.tan((cam.fov * Math.PI) / 360); mu.uAspect.value = cam.aspect;
    for (const k of ['sunB', 'flameB']) mu['u' + k[0].toUpperCase() + k.slice(1)].value.copy(u[k]);
    mu.uSunCol.value.copy(u.sunCol); mu.uAmb.value.copy(u.amb); mu.uGnd.value.copy(u.gnd);
    mu.uFlameI.value = u.flameI; mu.uFlameCol.value.copy(u.flameCol);
    mu.uTime.value = u.time; mu.uFrame.value = u.frame; mu.uFog.value = u.fog; mu.uFogCol.value.copy(u.fogCol); mu.uQ.value = u.q ?? 1;
    r.setRenderTarget(this.volRT); r.render(this.marchScene, this.quadCam);
    r.setRenderTarget(prevRT); r.autoClear = prevAuto; r.setClearColor(cc, ca);
    this.comp.visible = true;
  }
  // a point in the planet frame to the box's voxel coordinates
  toVoxels(v, out) { this.toBox(v.x, v.y, v.z, out); return out.divideScalar(VOX); }
  dirToBox(v, out) { return out.set(v.dot(this.ex), v.dot(this.ey), v.dot(this.ez)); }
}
