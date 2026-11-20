// Real 3D bushes near the camera, standing exactly where the ground shader paints them from afar.
//
// · Placement is the shared function in bushes.js, on a 7 m grid in the launch site's tangent frame, so the
//   lit disc you see from 1 km and the shrub you fly past at 50 m are the same bush.
// · A window of G×G cells follows the camera; a small pass works out, per cell, whether a bush grows there,
//   its size, and where it stands on the terrain (relative to the window, so float precision holds).
// · The window is read back (asynchronously, so the GPU never stalls) and only the cells that hold a bush
//   within reach become instances: one instanced draw of a few hundred bushes instead of 6400 mostly empty
//   slots. Beyond ~240 m they shrink away and the ground's painted bushes take over at the same spots.
// · Each bush is a cluster of lumpy lobes with soft normals, leaf-clump shading, darker inside and below,
//   and it casts a real shadow.
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries, mergeVertices } from '../vendor/jsm/utils/BufferGeometryUtils.js';
import { TERRAIN_GLSL, terrainUniforms } from './terrain.js';
import { BUSH_GLSL, BUSH_HASH, BUSH_CELL } from './bushes.js';

const G = 128;                // cells across the window (128 × 7 m ≈ 900 m)
const FAR = 240;              // the 3D bushes are gone by here; the ground's painted ones are in

function bushGeometry() {
  // unit bush: about 1 m in radius, base at y = 0; a few overlapping lobes, flattened underneath
  const lobes = [[0, 0.5, 0, 0.62], [0.42, 0.38, 0.18, 0.46], [-0.36, 0.4, 0.28, 0.44], [0.08, 0.36, -0.44, 0.45], [-0.2, 0.78, -0.1, 0.38]];
  const parts = lobes.map(([x, y, z, r], k) => {
    const g = new THREE.IcosahedronGeometry(r, 2).toNonIndexed();
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      let px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
      const l = 1 + 0.14 * Math.sin(px * 17 + k * 3 + py * 11) * Math.cos(pz * 15 - py * 7 + k);
      px *= l; py *= l; pz *= l;
      let wy = y + py; if (wy < 0.02) wy = 0.02 + (wy - 0.02) * 0.15;       // squashed against the ground
      p.setXYZ(i, x + px, wy, z + pz);
      // soft normals: half the lobe's own, half from the bush's centre, so it shades as one mass of leaves
      const cx = x + px, cy = wy - 0.45, cz = z + pz, cl = Math.hypot(cx, cy, cz) || 1, ol = Math.hypot(px, py, pz) || 1;
      n.setXYZ(i, px / ol * 0.5 + cx / cl * 0.5, py / ol * 0.5 + cy / cl * 0.5, pz / ol * 0.5 + cz / cl * 0.5);
    }
    g.deleteAttribute('uv');
    return g;
  });
  const g = mergeVertices(mergeGeometries(parts), 1e-4);
  g.computeBoundingSphere();
  return g;
}

export class Scatter {
  constructor(renderer, terrain) {
    this.renderer = renderer; this.terrain = terrain;
    // The placement is read back to the CPU. In 8-bit pixels (each cell four of them, one 32-bit number in each): a
    // float target's read-back blocked the main thread 40-90 ms every time (on WebGL over Metal), and the camera
    // orbiting the rocket re-centres the window several times a second (the stutter when dragging the view).
    this.rt = new THREE.WebGLRenderTarget(G * 4, G, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    this.centre = null;
    const site = terrain.site.clone().normalize();
    this.sE = new THREE.Vector3(0, 1, 0).cross(site).normalize(); this.sN = new THREE.Vector3().crossVectors(site, this.sE); this.site = site;
    // --- placement pass ---
    this.pU = { ...terrainUniforms(terrain.R, terrain.A, terrain.site, terrain.ctl), uCell: { value: new THREE.Vector2() }, uXc: { value: new THREE.Vector2() }, uSE: { value: this.sE }, uSN: { value: this.sN } };
    const pass = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.pU, depthTest: false, depthWrite: false,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        precision highp float; precision highp int;
        ${TERRAIN_GLSL}
        ${BUSH_GLSL}
        uniform vec2 uCell, uXc; uniform vec3 uSE, uSN;
        void main() {
          int comp = int(gl_FragCoord.x) % 4;   // which of the cell's four numbers this pixel holds
          ivec2 c = ivec2(uCell) + ivec2(int(gl_FragCoord.x) / 4, int(gl_FragCoord.y)) - ${G / 2};
          float dens = bushDensity((vec2(c) + 0.5) * ${BUSH_CELL.toFixed(1)});
          vec2 bp; float id;
          float r = dens > 0.0 ? bushAt(c, dens, bp, id) : 0.0;
          if (r <= 0.0) { gl_FragColor = vec4(0.0); return; }
          float R = uTR, x = bp.x, y = bp.y, q = x * x + y * y, qc = dot(uXc, uXc);
          float zs = sqrt(R * R - q), zc = sqrt(R * R - qc);
          vec3 dir = normalize(uTSite * zs + uSE * x + uSN * y);
          float H = terrainHd(dir, 1.0);
          if (H < -0.25) { gl_FragColor = vec4(0.0); return; }     // sea (the flattened launch area is exactly 0: land)
          float dz = -(q - qc) / (zs + zc);                       // sphere drop, without cancellation
          vec3 rel = uSE * (x - uXc.x) + uSN * (y - uXc.y) + uTSite * dz + dir * H;
          vec4 o = vec4(rel, floor(r * 100.0) + id * 0.99);
          // packed as 32-bit fixed point over four bytes: position ±512 m to 1/65536 m, size and id to 1/16384
          float v = comp == 0 ? o.x : comp == 1 ? o.y : comp == 2 ? o.z : o.w;
          uint u = comp < 3 ? uint((v + 512.0) * 65536.0) : uint(v * 16384.0);
          gl_FragColor = vec4(float(u >> 24u), float((u >> 16u) & 255u), float((u >> 8u) & 255u), float(u & 255u)) / 255.0;
        }`,
    }));
    pass.frustumCulled = false;
    this.passScene = new THREE.Scene(); this.passScene.add(pass);
    this.passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

    // --- the bushes ---
    const geo = new THREE.InstancedBufferGeometry().copy(bushGeometry());
    this.aBush = new THREE.InstancedBufferAttribute(new Float32Array(G * G * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aCell = new THREE.InstancedBufferAttribute(new Float32Array(G * G * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBush', this.aBush); geo.setAttribute('aCell', this.aCell);
    geo.instanceCount = 0; geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geo = geo; this.buf = new Uint8Array(G * G * 16); this.pending = false;
    this.U = {
      uRelW: { value: new THREE.Vector3() }, uFrame: { value: new THREE.Matrix3() },
      uCamScene: terrain.sceneU.uCamScene, uRotS: terrain.sceneU.uRotS,
    };
    const vert = (sh) => {
      Object.assign(sh.uniforms, this.U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', /* glsl */`#include <common>
          ${BUSH_HASH}
          uniform vec3 uRelW, uCamScene; uniform mat3 uFrame, uRotS;
          attribute vec4 aBush; attribute vec2 aCell;
          varying vec3 vBush; varying vec4 vLeaf;`)
        .replace('void main() {', /* glsl */`void main() {
          vec4 sc = aBush;
          float r = floor(sc.w) / 100.0, id = fract(sc.w) / 0.99;
          ivec2 cell = ivec2(aCell);
          float dist = length(uRelW + sc.xyz);
          float sz = r * (1.0 - smoothstep(${FAR - 25}.0, ${FAR}.0, dist));
          vec3 lp = position * vec3(sz, sz * (0.75 + 0.4 * bHash(cell, 101)), sz), ln = normal;
          float an = id * 6.2832 * 7.0, ca = cos(an), sa = sin(an);
          lp.xz = mat2(ca, sa, -sa, ca) * lp.xz; ln.xz = mat2(ca, sa, -sa, ca) * ln.xz;
          // the same colour the ground shader gives this bush from afar
          vBush = mix(vec3(0.045, 0.085, 0.024), vec3(0.075, 0.095, 0.03), id) * (0.85 + 0.3 * bHash(cell, 99));
          vBush *= mix(0.45, 1.1, smoothstep(0.0, 0.9, position.y));            // darker inside and underneath
          vLeaf = vec4(position * 2.2 + id * 40.0, 1.0);
          vec3 relT = uRelW + sc.xyz + uFrame * lp;`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = uRotS * (uFrame * normalize(ln));')
        .replace('#include <begin_vertex>', 'vec3 transformed = uCamScene + uRotS * relT;');
    };
    // no specular: foliage seen edge-on would otherwise mirror the bright sky and turn grey
    const mat = new THREE.MeshPhysicalMaterial({ roughness: 0.95, metalness: 0, specularIntensity: 0 });
    mat.onBeforeCompile = (sh) => {
      vert(sh);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vBush; varying vec4 vLeaf;
          float lh(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
          float ln3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(lh(i), lh(i + vec3(1, 0, 0)), f.x), mix(lh(i + vec3(0, 1, 0)), lh(i + vec3(1, 1, 0)), f.x), f.y),
                       mix(mix(lh(i + vec3(0, 0, 1)), lh(i + vec3(1, 0, 1)), f.x), mix(lh(i + vec3(0, 1, 1)), lh(i + 1.0), f.x), f.y), f.z); }`)
        .replace('#include <color_fragment>', `diffuseColor.rgb = vBush;
          // leaf clumps at two sizes: the surface reads as foliage, not as a smooth blob
          diffuseColor.rgb *= 0.5 + 0.8 * ln3(vLeaf.xyz * 3.0) * (0.55 + 0.45 * ln3(vLeaf.xyz * 9.0));`);
    };
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = vert;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.customDepthMaterial = depth;
    this.mesh.frustumCulled = false; this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.group = new THREE.Group(); this.group.add(this.mesh);
  }

  // camF: camera in the planet-fixed frame; agl: camera height above the ground. Returns whether it is shown.
  // tgtF: what the camera looks at and orbits (the rocket), planet-fixed frame
  update(camF, agl, tgtF = camF) {
    const R = this.terrain.R, site = this.site;
    const off = camF.clone().addScaledVector(site, -R), toff = tgtF.clone().addScaledVector(site, -R);
    const x = off.dot(this.sE), y = off.dot(this.sN), tx = toff.dot(this.sE), ty = toff.dot(this.sN);
    // (every bush is gone by FAR from the camera, height included: above that there is nothing left to draw)
    const show = agl < FAR && Math.hypot(x, y) < 85000;
    this.group.visible = show;
    if (!show) return false;
    // Each re-centre is a pass and a read-back, and on some GPUs (WebGL over Metal) a read-back holds up the frame
    // ~0.1 s whatever the format. So the window is centred on the rocket, not the camera: orbiting the view round it
    // (dragging) then moves nothing. It holds the camera's whole reach round the rocket plus the bushes' range out
    // to ~190 m away; farther out it follows the camera as before. Re-centred once the rocket or the camera has
    // moved a few cells (or the camera is zoomed out past what the last window held)
    const H = G / 2 * BUSH_CELL, onT = Math.hypot(x - tx, y - ty) < H - FAR - 3 * BUSH_CELL;
    const mx = onT ? tx : x, my = onT ? ty : y;
    const ic = Math.floor(mx / BUSH_CELL), jc = Math.floor(my / BUSH_CELL);
    const xc = (ic + 0.5) * BUSH_CELL, yc = (jc + 0.5) * BUSH_CELL;
    const c = this.centre, reach = this.snap ? Math.hypot(x - this.snap.xc, y - this.snap.yc) : 0;
    if ((!c || Math.abs(ic - c[0]) > 2 || Math.abs(jc - c[1]) > 2 || (this.snap && reach > this.snap.reach)) && !this.pending) {
      this.centre = [ic, jc];
      this.pU.uCell.value.set(ic, jc); this.pU.uXc.value.set(xc, yc);
      const r = this.renderer, prev = r.getRenderTarget();
      r.setRenderTarget(this.rt); r.render(this.passScene, this.passCam); r.setRenderTarget(prev);
      // read the window back without stalling; until it arrives the previous set stays, placed exactly
      // (each set keeps the centre it was computed about)
      this.pending = true;
      const snap = { ic, jc, xc, yc, reach: Math.min(H - FAR - 3 * BUSH_CELL, Math.hypot(x - xc, y - yc) + 30) };   // (how far the camera may stray from the centre)
      r.readRenderTargetPixelsAsync(this.rt, 0, 0, G * 4, G, this.buf).then(() => this.compact(snap)).catch(() => {}).finally(() => { this.pending = false; });
    }
    if (!this.snap) return true;
    const { xc: sx, yc: sy } = this.snap;
    const zc = Math.sqrt(R * R - sx * sx - sy * sy);
    const wref = site.clone().multiplyScalar(zc).addScaledVector(this.sE, sx).addScaledVector(this.sN, sy);
    this.U.uRelW.value.copy(wref).sub(camF);
    const up = wref.clone().normalize(), east = new THREE.Vector3(0, 1, 0).cross(up).normalize(), north = new THREE.Vector3().crossVectors(up, east);
    this.U.uFrame.value.set(east.x, up.x, north.x, east.y, up.y, north.y, east.z, up.z, north.z);
    return true;
  }

  // keep only the cells that hold a bush the camera can get near before the next read-back: within its reach of
  // the centre plus the bushes' range
  compact(snap) {
    const b = this.buf, A = this.aBush.array, C = this.aCell.array, lim = (snap.reach + FAR + 3 * BUSH_CELL) ** 2;
    let n = 0;
    const u32 = (o) => b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3];   // the pass's packed numbers
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const k = (j * G + i) * 16, w = u32(k + 12) / 16384;
      if (!(w > 0)) continue;
      const dx = (i - G / 2 + 0.5) * BUSH_CELL, dy = (j - G / 2 + 0.5) * BUSH_CELL;   // from the window centre
      if (dx * dx + dy * dy > lim) continue;
      A[n * 4] = u32(k) / 65536 - 512; A[n * 4 + 1] = u32(k + 4) / 65536 - 512; A[n * 4 + 2] = u32(k + 8) / 65536 - 512; A[n * 4 + 3] = w;
      C[n * 2] = snap.ic + i - G / 2; C[n * 2 + 1] = snap.jc + j - G / 2;
      n++;
    }
    this.aBush.clearUpdateRanges(); this.aBush.addUpdateRange(0, n * 4); this.aBush.needsUpdate = true;
    this.aCell.clearUpdateRanges(); this.aCell.addUpdateRange(0, n * 2); this.aCell.needsUpdate = true;
    this.geo.instanceCount = n; this.snap = snap;
  }
}
