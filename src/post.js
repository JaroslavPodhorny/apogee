// Physically based bloom: the way a real lens and eye scatter a little of all light, not a glow added
// above a threshold. The HDR frame is filtered down a chain of half-size buffers (a 13-tap filter that
// does not alias), then added back up with a tent filter, and a few percent of that wide, round blur is
// mixed into the image. Everything bright gets a halo in proportion to how bright it is: the sun a wide
// glare, a lamp a soft round glow, a white wall nothing you would notice. No squares, no thresholds.
import * as THREE from '../vendor/three.module.js';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { TONE } from './style.js';

const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const DOWN = /* glsl */`
  uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst; varying vec2 vUv;
  // a NaN or infinite pixel (from any shader) would smear across the whole frame through the blur: drop it here
  vec3 s(vec2 o) { vec3 c = texture2D(tSrc, vUv + o * uTexel).rgb; return all(equal(c, c)) ? min(c, vec3(60000.0)) : vec3(0.0); }
  // on the first level, weight each group by 1/(1+luma) so a single blazing pixel cannot flicker
  float kw(vec3 c) { return uFirst > 0.5 ? 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))) : 1.0; }
  void main() {
    vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2)), d = s(vec2(-2, 0)), e = s(vec2(0)), f = s(vec2(2, 0));
    vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2)), j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
    vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25, g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
    float w0 = kw(g0) * 0.5, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.125;
    gl_FragColor = vec4((g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4), 1.0);
  }`;
const UP = /* glsl */`
  uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uW; varying vec2 vUv;
  vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
  void main() {
    vec3 c = s(vec2(0)) * 4.0 + (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.0
           + s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1));
    gl_FragColor = vec4(c / 16.0 * uW, 1.0);
  }`;
const MIX = /* glsl */`
  uniform sampler2D tScene, tBloom; uniform float uK; varying vec2 vUv;
  void main() { vec3 c = texture2D(tScene, vUv).rgb, b = texture2D(tBloom, vUv).rgb; gl_FragColor = vec4(mix(c, b, uK), 1.0); }`;

export class PhysicalBloomPass extends Pass {
  constructor(strength = 0.05, levels = 7) {
    super();
    this.strength = strength; this.levels = levels; this.mips = [];
    const mat = (frag, u) => new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
    this.down = mat(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
    this.up = mat(UP, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uW: { value: 1 } });
    this.up.blending = THREE.AdditiveBlending; this.up.transparent = true;
    this.mix = mat(MIX, { tScene: { value: null }, tBloom: { value: null }, uK: { value: strength } });
    this.quad = new FullScreenQuad(this.down);
  }
  setSize(w, h) {
    for (const m of this.mips) m.dispose();
    this.mips = [];
    for (let i = 0; i < this.levels; i++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      this.mips.push(new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
      if (w <= 4 || h <= 4) break;
    }
  }
  render(renderer, writeBuffer, readBuffer) {
    if (!this.mips.length) this.setSize(readBuffer.width, readBuffer.height);
    const q = this.quad, M = this.mips, ac = renderer.autoClear;
    renderer.autoClear = false;
    // down
    q.material = this.down;
    let src = readBuffer.texture, sw = readBuffer.width, sh = readBuffer.height;
    for (let i = 0; i < M.length; i++) {
      const u = this.down.uniforms; u.tSrc.value = src; u.uTexel.value.set(1 / sw, 1 / sh); u.uFirst.value = i === 0 ? 1 : 0;
      renderer.setRenderTarget(M[i]); renderer.clear(); q.render(renderer);
      src = M[i].texture; sw = M[i].width; sh = M[i].height;
    }
    // up: each level adds the blurred level below it (the wide halo is the sum of all of them)
    q.material = this.up;
    for (let i = M.length - 2; i >= 0; i--) {
      const u = this.up.uniforms; u.tSrc.value = M[i + 1].texture; u.uTexel.value.set(1 / M[i + 1].width, 1 / M[i + 1].height); u.uW.value = 1;
      renderer.setRenderTarget(M[i]); q.render(renderer);
    }
    // mix a few percent of the normalised blur into the frame
    q.material = this.mix;
    const u = this.mix.uniforms; u.tScene.value = readBuffer.texture; u.tBloom.value = M[0].texture; u.uK.value = this.strength / M.length;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); q.render(renderer);
    renderer.autoClear = ac;
  }
  dispose() { for (const m of this.mips) m.dispose(); this.quad.dispose(); }
}

// The final pass (tone mapping, sRGB) with two touches of a real camera:
// · a gentle vignette, the light falloff of a lens towards the corners of the frame (in linear light, before the
//   tone curve, so bright corners stay bright and it never reads as a grey frame laid on top);
// · dither: the frame is HDR until here, then quantised to 8 bits; dark sky gradients and the haze over the limb
//   would band into steps. Half a step of triangular noise breaks them up and is invisible itself.
// · vibrance: after the tone curve, muted colours get a little more saturation and already strong ones
//   almost none, so grass and sea look alive without anything turning neon (TONE.vibrance in style.js).
export function outputPass() {
  const p = new OutputPass();
  p.material.uniforms.uVib = { value: TONE.vibrance };
  const render = p.render.bind(p);
  p.render = (...a) => { p.material.uniforms.uVib.value = TONE.vibrance; render(...a); };
  p.material.fragmentShader = p.material.fragmentShader
    .replace('gl_FragColor = texture2D( tDiffuse, vUv );', `gl_FragColor = texture2D( tDiffuse, vUv );
      vec2 vq = (vUv - 0.5) * 1.4142;
      gl_FragColor.rgb *= 1.0 - 0.13 * pow(dot(vq, vq), 1.5);`)
    .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse; uniform float uVib;')
    .replace(/(#ifdef SRGB_TRANSFER)/, `{ vec3 c = gl_FragColor.rgb; float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
        // bright near-whites (cloud, smoke, white paint) are left alone: boosting their faint tint turns them cream
        float vk = uVib * (1.0 - clamp(sat * 1.5, 0.0, 1.0)) * (1.0 - smoothstep(0.45, 0.85, l));
        gl_FragColor.rgb = max(mix(vec3(l), c, 1.0 + vk), 0.0); }
      $1`)
    .replace(/(#ifdef SRGB_TRANSFER[\s\S]*?#endif)/, `$1
      vec2 dq = gl_FragCoord.xy;
      float n1 = fract(52.9829189 * fract(dot(dq, vec2(0.06711056, 0.00583715))));
      float n2 = fract(sin(dot(dq, vec2(12.9898, 78.233))) * 43758.5453);
      gl_FragColor.rgb += (n1 - n2) / 255.0;`);
  return p;
}
