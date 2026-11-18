// The sun, drawn at full resolution on top of the (lower-resolution) sky:
// · a crisp disc with limb darkening, an inner corona and a wide soft glow
// · faint diffraction spikes, like a camera lens sees it
// · coloured by the air the light passes through (white in space, gold low in the sky, red at sunset)
// · hidden by the planet's limb, and by the rocket or tower passing in front of it
// · a restrained lens flare along the line from the sun through the screen centre
import * as THREE from '../vendor/three.module.js';

const QUAD_HALF = 0.11;     // radians covered by half the sun quad (room for the glow)
const R_SUN = 0.0085;       // drawn angular radius (the real one is 0.0047; a touch larger reads better)

export class Sun {
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
      uniforms: { uCol: { value: new THREE.Color(1, 1, 1) }, uVis: { value: 1 }, uSpace: { value: 1 } },
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = position.xy * 2.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uCol; uniform float uVis, uSpace; varying vec2 vUv;
        void main(){
          float r = length(vUv) * ${QUAD_HALF.toFixed(4)}, R = ${R_SUN.toFixed(5)};
          float x = clamp(r / R, 0.0, 1.0);
          float limb = 1.0 - 0.55 * (1.0 - sqrt(1.0 - x * x));                // darker toward the edge
          float disc = smoothstep(R * 1.03, R * 0.97, r) * limb;
          float corona = exp(-max(r - R, 0.0) / 0.0045);
          // only the near aureole is drawn here: the wide glare comes from the bloom pass, which scatters
          // the disc's own (very high) brightness the way a lens does, so it is round and never doubled
          float glow = exp(-r / 0.012) * 0.5 + exp(-r / 0.035) * 0.08 * (1.0 - uSpace);
          float edge = 1.0 - smoothstep(0.75, 1.0, length(vUv));
          vec3 c = uCol * (disc * 160.0 + corona * 3.0 + glow) * edge;
          gl_FragColor = vec4(c * uVis, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 8;

    // lens flare: ghosts strung along the sun → screen-centre axis, drawn in screen space
    const ghosts = [ // t along the axis (0 = sun, 1 = centre, 2 = mirrored), size, strength, warm/cool tint
      [0.0, 0.32, 0.05, 0.5], [0.45, 0.05, 0.10, 0.2], [0.72, 0.09, 0.06, 0.9], [1.12, 0.035, 0.12, 0.1],
      [1.35, 0.16, 0.035, 0.8], [1.6, 0.06, 0.07, 0.3], [1.95, 0.24, 0.025, 0.6],
    ];
    const pos = [], gd = [], idx = [];
    ghosts.forEach((g, i) => {
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pos.push(x, y, 0); gd.push(...g); }
      const o = i * 4; idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aG', new THREE.Float32BufferAttribute(gd, 4));
    geo.setIndex(idx);
    this.flareMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      uniforms: { uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 }, uVis: { value: 0 }, uCol: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */`
        attribute vec4 aG; uniform vec2 uSun; uniform float uAspect; varying vec2 vQ; varying vec4 vG;
        void main(){
          vec2 c = mix(uSun, -uSun, aG.x * 0.5);
          vQ = position.xy; vG = aG;
          gl_Position = vec4(c + position.xy * aG.y * vec2(1.0 / uAspect, 1.0), 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uVis; uniform vec3 uCol; varying vec2 vQ; varying vec4 vG;
        void main(){
          float r = length(vQ);
          float a = atan(vQ.y, vQ.x), hex = cos(3.14159 / 6.0) / cos(mod(a, 1.0472) - 0.5236);
          float rr = vG.x == 0.0 ? r : r / hex;                    // the big glare is round, the ghosts are aperture-shaped
          float disk = vG.x == 0.0 ? exp(-r * r * 6.0) : smoothstep(1.0, 0.8, rr) * (0.55 + 0.45 * smoothstep(0.55, 0.95, rr));
          vec3 tint = mix(vec3(0.75, 0.9, 1.0), vec3(1.0, 0.85, 0.6), vG.w);
          gl_FragColor = vec4(uCol * tint * disk * vG.z * uVis * 0.9, 1.0);
        }`,
    });
    this.flare = new THREE.Mesh(geo, this.flareMat);
    this.flare.frustumCulled = false; this.flare.renderOrder = 999;
    this.ray = new THREE.Raycaster(); this.block = 1; this.frame = 0;
  }

  // camAbs: camera position in the planet frame; color: sunlight transmittance at the camera (THREE.Color)
  update(camera, camAbs, sunDir, planetR, color, occluders, atmosphere, terVis = 1) {
    const D = camera.far * 0.7;
    this.mesh.position.copy(camera.position).addScaledVector(sunDir, D);
    this.mesh.quaternion.copy(camera.quaternion);
    this.mesh.scale.setScalar(2 * D * Math.tan(QUAD_HALF));
    // behind the planet's limb?
    const r = camAbs.length(), rho = Math.asin(Math.min(1, planetR / r));
    const psi = Math.acos(THREE.MathUtils.clamp(-camAbs.dot(sunDir) / r, -1, 1));
    const limb = THREE.MathUtils.smoothstep(psi, rho - R_SUN, rho + R_SUN);
    // something in front of it? (cheap ray test against the rocket and the pad hardware, every few frames)
    if (this.frame++ % 3 === 0 && occluders.length) {
      this.ray.set(camera.position, sunDir); this.ray.far = 5000;
      const hit = this.ray.intersectObjects(occluders, true).length > 0;
      this.blockTarget = hit ? 0 : 1;
    }
    this.block += ((this.blockTarget ?? 1) - this.block) * 0.35;
    const vis = limb * terVis;            // terVis: hidden behind a mountain
    const u = this.mat.uniforms;
    u.uCol.value.copy(color); u.uVis.value = vis; u.uSpace.value = 1 - atmosphere;
    // flare: only while the sun is on screen and unobstructed
    const ndc = this.mesh.position.clone().project(camera);
    const onScreen = ndc.z < 1 && Math.abs(ndc.x) < 1.15 && Math.abs(ndc.y) < 1.15 && sunDir.dot(camera.getWorldDirection(new THREE.Vector3())) > 0;
    const edgeFade = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(ndc.x), Math.abs(ndc.y)), 0.8, 1.15);
    const f = this.flareMat.uniforms;
    f.uSun.value.set(ndc.x, ndc.y); f.uAspect.value = camera.aspect;
    f.uVis.value = onScreen ? vis * this.block * edgeFade : 0;
    f.uCol.value.copy(color);
    this.flare.visible = f.uVis.value > 0.002;
  }
}
