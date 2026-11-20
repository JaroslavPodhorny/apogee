// Graphics settings: a quality preset plus the few options that really change the look or the cost of a frame.
// Stored in localStorage (apogee.gfx); the flight view reads `gfx` every frame, so changes apply at once.
const KEY = 'apogee.gfx';

// res: share of the screen's pixels the 3D view renders at ('auto' adapts to the frame time, up to resMax device
// pixels per screen point: a high-density screen at full density is four times the pixels, for the high end).
// sky: detail level of the sky / ground / cloud pass, the frame's most expensive pixels (flight.js SKY_DENSITY turns
// it into samples per screen point).
// shadows: shadow map size (0 = none). msaa: samples on the HDR frame. fx: particle effects budget.
export const PRESETS = {
  low: { res: 'auto', resMax: 1, sky: 0.45, shadows: 1024, clouds: false, bushes: false, bloom: true, msaa: 0, fx: 'low' },
  medium: { res: 'auto', resMax: 1.25, sky: 0.5, shadows: 2048, clouds: true, bushes: true, bloom: true, msaa: 4, fx: 'high' },
  high: { res: 'auto', resMax: 1.5, sky: 0.6, shadows: 2048, clouds: true, bushes: true, bloom: true, msaa: 4, fx: 'high' },
  ultra: { res: 1, resMax: 2, sky: 0.8, shadows: 4096, clouds: true, bushes: true, bloom: true, msaa: 4, fx: 'high' },
};
const DEFAULT = { preset: 'high', ...PRESETS.high, fps: false, smokeStyle: 0 };   // (smoke style is a look, not a quality: no preset sets it)

function load() {
  let s = null; try { s = JSON.parse(localStorage.getItem(KEY)); } catch { /* ignore */ }
  // settings saved before a preset gained an option take that option from their preset
  if (s && typeof s === 'object' && PRESETS[s.preset]) for (const k in PRESETS[s.preset]) if (!(k in s)) s[k] = PRESETS[s.preset][k];
  return { ...DEFAULT, ...(s && typeof s === 'object' ? s : {}) };
}
export const gfx = load();
const listeners = new Set();
export function onGfx(fn) { listeners.add(fn); }
export function setGfx(patch) {
  if (patch.preset && PRESETS[patch.preset]) Object.assign(gfx, PRESETS[patch.preset]);
  Object.assign(gfx, patch);
  // a hand-picked option no longer matches the preset: call it custom
  if (!patch.preset) { const p = PRESETS[gfx.preset]; if (!p || Object.keys(p).some((k) => p[k] !== gfx[k])) gfx.preset = 'custom'; }
  try { localStorage.setItem(KEY, JSON.stringify(gfx)); } catch { /* ignore */ }
  for (const fn of listeners) fn(gfx);
}

// ---------- the panel ----------
const ROWS = [
  ['preset', 'Quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']]],
  ['res', 'Rocket & effects', [['auto', 'Auto'], [0.5, '50%'], [0.75, '75%'], [1, '100%']], 'Sharpness of the rocket, the pad, smoke and flames. The sky and ground have their own setting, so this costs little. Auto lowers it when the frame rate drops'],
  ['sky', 'Sky & ground', [[0.45, 'Low'], [0.5, 'Medium'], [0.6, 'High'], [0.8, 'Ultra']], 'Detail of the atmosphere, clouds and terrain: the most expensive part of the frame'],
  ['shadows', 'Shadows', [[0, 'Off'], [1024, 'Low'], [2048, 'High'], [4096, 'Ultra']]],
  ['msaa', 'Anti-aliasing', [[0, 'Off'], [4, 'On']]],
  ['clouds', 'Volumetric clouds', [[false, 'Off'], [true, 'On']], 'Real 3D cumulus you can fly through'],
  ['bushes', '3D vegetation', [[false, 'Off'], [true, 'On']], 'Bushes near the camera'],
  ['fx', 'Effects', [['low', 'Low'], ['high', 'High']], 'Sparks, embers and glints: how many particles'],
  ['smokeStyle', 'Smoke style', [[0, 'Realistic'], [1, 'Toon'], [2, 'Soft toon']], 'Toon: flat tones and crisp outlines, sharp at any resolution'],
  ['bloom', 'Bloom', [[false, 'Off'], [true, 'On']], 'Glow round the sun, flames and lights'],
  ['fps', 'Frame rate', [[false, 'Hide'], [true, 'Show']]],
];
let panel = null;
function render() {
  // the light sky (planet.js skyLite): set after the GPU stopped the full one
  let lite = false, why = ''; try { lite = localStorage.getItem('apogee.skyLite') === '1'; why = (localStorage.getItem('apogee.skyLiteWhy') || '').replace(/[<>&"]/g, ''); } catch { /* ignore */ }
  panel.innerHTML = `<h2>Graphics</h2><div class="gl">${ROWS.map(([k, name, opts, tip]) => `<div class="gr"${tip ? ` title="${tip}"` : ''}><span>${name}</span><div class="seg">${opts.map(([v, l]) => `<button data-k="${k}" data-v='${JSON.stringify(v)}' class="${gfx[k] === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>`).join('')}</div>
    ${lite ? `<div class="row"><small>Light sky: the graphics driver stopped the full one${why ? ` (${why})` : ''}</small><button id="gfx-full">Try full sky</button></div>` : ''}
    <div class="row"><small>${gfx.preset === 'custom' ? 'Custom settings' : 'Lower the quality if the frame rate is low'}</small><button class="solid" id="gfx-done">Done</button></div>`;
  panel.querySelector('#gfx-full')?.addEventListener('click', () => { try { localStorage.removeItem('apogee.skyLite'); } catch { /* ignore */ } location.reload(); });
  for (const b of panel.querySelectorAll('.seg button')) b.onclick = () => { setGfx({ [b.dataset.k]: JSON.parse(b.dataset.v) }); render(); };
  panel.querySelector('#gfx-done').onclick = () => { panel.hidden = true; };
}
export function toggleGfxPanel() {
  if (!panel) {
    panel = document.createElement('div'); panel.id = 'gfx'; panel.className = 'card'; panel.hidden = true;
    document.body.appendChild(panel);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; e.stopPropagation(); } }, true);
  }
  panel.hidden = !panel.hidden;
  if (!panel.hidden) render();
}

// ---------- frame-rate readout ----------
let fpsEl = null, acc = 0, n = 0, worst = 0;
export function tickFps(dt) {
  if (!gfx.fps) { if (fpsEl) fpsEl.hidden = true; return; }
  if (!fpsEl) { fpsEl = document.createElement('div'); fpsEl.id = 'fps'; document.body.appendChild(fpsEl); }
  fpsEl.hidden = false;
  acc += dt; n++; worst = Math.max(worst, dt);
  if (acc >= 0.5) { fpsEl.textContent = `${Math.round(n / acc)} fps · ${(acc / n * 1000).toFixed(1)} ms · worst ${(worst * 1000).toFixed(0)} ms`; acc = 0; n = 0; worst = 0; }
}
