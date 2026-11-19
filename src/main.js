// Entry point: one WebGL renderer shared by the title screen, the hangar and the flight view.
import * as THREE from '../vendor/three.module.js';
import { renderThumbnails } from './meshes.js';
import { makeSkyPlanet, loadEarth, updateSky } from './planet.js';
import { Builder, worldKind } from './builder.js';
import { sfx } from './audio.js';
import { Flight } from './flight.js';
import { stockRockets } from './stock.js';
import { cloneDesign } from './rocket.js';
import { startAutopilot } from './autopilot.js';
import { gfx, toggleGfxPanel, tickFps } from './gfx.js';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { outputPass } from './post.js';
import { applyTone } from './style.js';
import { universes, currentUniverse, setCurrentUniverse, createUniverse, deleteUniverse, worldSummary } from './universe.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const thumbs = renderThumbnails();
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 1);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const tex = await loadEarth(renderer);

let mode = 'title';
const flight = new Flight(renderer, canvas, thumbs, tex, () => setMode('build'));
const builder = new Builder(renderer, canvas, thumbs, (design, kind) => { flight.start(design, kind); setMode('flight'); }, () => setMode('title'));

// ---------- title screen: the planet drifting by from low orbit ----------
const WORLDS = { compact: 'Planet: small, best to start', real: 'Planet: real-size Earth, hard' };
const menuScene = new THREE.Scene(), menuSky = makeSkyPlanet(tex), menuCam = new THREE.PerspectiveCamera(50, 1, 1, 10);
menuScene.add(menuSky);
// The title view is one full-screen pass of the atmosphere shader. At device resolution on a retina screen that is
// millions of heavy pixels for a soft view from orbit: render it in HDR at a capped resolution, then tone map.
const titleComp = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }));
titleComp.addPass(new RenderPass(menuScene, menuCam)); titleComp.addPass(outputPass());
let titleKey = '';
const titlePlanet = { R: 6371000, atmK: 1 };
function renderTitle(t, w, h) {
  const R = titlePlanet.R, alt = 420000, ang = 2.1 + t * 0.004;
  const up = new THREE.Vector3(Math.cos(ang), 0.28, Math.sin(ang)).normalize();
  const cp = up.clone().multiplyScalar(R + alt);
  const fwd = new THREE.Vector3(-Math.sin(ang), 0, Math.cos(ang));
  menuCam.aspect = w / h; menuCam.updateProjectionMatrix();
  menuCam.position.set(0, 0, 0); menuCam.up.copy(up); menuCam.lookAt(fwd.clone().addScaledVector(up, -0.42)); menuCam.updateMatrixWorld();
  const right = new THREE.Vector3().crossVectors(fwd, up);
  const sun = right.multiplyScalar(0.75).addScaledVector(fwd, 0.55).addScaledVector(up, 0.12).normalize();
  const dpr = window.devicePixelRatio || 1, pr = gfx.preset === 'ultra' ? Math.min(dpr, 2) : gfx.preset === 'low' ? 1 : Math.min(dpr, 1.25);
  if (titleKey !== `${w}x${h}@${pr}`) { titleKey = `${w}x${h}@${pr}`; titleComp.setPixelRatio(pr); titleComp.setSize(w, h); }
  menuSky.userData.viewH = h; menuSky.material.uniforms.uStarK.value = 1.4;
  updateSky(menuSky, { camera: menuCam, camPos: cp, theta: 0, planet: titlePlanet, sunDir: sun, time: t * 30 });
  applyTone(renderer, 1.15);
  titleComp.render();
}
function showTitle() {
  $('t-world').textContent = WORLDS[worldKind()];
  const u = currentUniverse(), sum = worldSummary(u.id, worldKind());
  $('t-uni').textContent = `Universe: ${u.name}`;
  const c = $('t-continue'); c.hidden = !sum.craft;
  if (sum.craft) c.textContent = `Fly a craft in orbit (${sum.craft})`;
  let p = {}; try { p = JSON.parse(localStorage.getItem('apogee.progress') || '{}'); } catch { /* ignore */ }
  $('t-badges').innerHTML = [['space', 'Reached space'], ['orbit', 'Reached orbit'], ['home', 'Came home']].map(([k, n]) => `<span class="${p[k] ? 'got' : ''}">${p[k] ? '✓ ' : ''}${n}</span>`).join('');
}
$('t-build').onclick = () => setMode('build');
$('t-continue').onclick = () => { if (flight.start(null, worldKind())) setMode('flight'); };
$('t-uni').onclick = () => { const c = $('t-unis'); c.hidden = !c.hidden; if (!c.hidden) renderUniverses(); };
const fmtT = (t) => { const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600); return d ? `day ${d + 1}, ${h} h` : `${h} h ${Math.floor((t % 3600) / 60)} min`; };
function renderUniverses() {
  const box = $('t-unis'), o = universes(), kind = worldKind();
  box.innerHTML = `<h2>Universes</h2><p>Each universe keeps its own clock and everything you leave in orbit or landed: satellites, stations, landers. And its craters.</p><div class="ulist"></div><div class="row"><button class="link" id="u-new">New universe</button><button class="solid" id="u-close">Done</button></div>`;
  const list = box.querySelector('.ulist');
  for (const u of o.list) {
    const s2 = worldSummary(u.id, kind);
    const el = document.createElement('div'); el.className = `urow ${u.id === o.current ? 'cur' : ''}`;
    el.innerHTML = `<div><b>${u.name}</b><small>${s2.craft ? `${s2.craft} craft${s2.names ? `: ${s2.names.slice(0, 3).join(', ')}${s2.names.length > 3 ? '…' : ''}` : ''}` : 'empty'} · ${fmtT(s2.t)}</small></div><button class="link del" title="Delete this universe">Delete</button>`;
    el.onclick = () => { setCurrentUniverse(u.id); renderUniverses(); showTitle(); };
    const del = el.querySelector('.del');
    del.onclick = (e) => { e.stopPropagation(); if (del.dataset.sure) { deleteUniverse(u.id); renderUniverses(); showTitle(); } else { del.dataset.sure = '1'; del.textContent = 'Really delete?'; } };
    list.appendChild(el);
  }
  box.querySelector('#u-new').onclick = () => { createUniverse(); renderUniverses(); showTitle(); };
  box.querySelector('#u-close').onclick = () => { box.hidden = true; };
}
$('t-fly').onclick = () => { flight.start(cloneDesign(stockRockets()[worldKind() === 'real' ? 2 : 0]), worldKind()); setMode('flight'); };
$('t-world').onclick = () => { localStorage.setItem('apogee.world', worldKind() === 'real' ? 'compact' : 'real'); showTitle(); };
const sndBtns = [...document.querySelectorAll('.snd')];
const showSnd = () => sndBtns.forEach((b) => { b.textContent = b.id === 't-sound' ? `Sound: ${sfx.muted ? 'off' : 'on'}` : sfx.muted ? 'Sound off' : 'Sound'; });
sndBtns.forEach((b) => { b.onclick = () => { sfx.setMuted(!sfx.muted); showSnd(); }; }); showSnd();
for (const b of document.querySelectorAll('.gfx-btn')) b.onclick = () => toggleGfxPanel();
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => sfx.init(), true);

function setMode(m) {
  mode = m;
  $('title-ui').hidden = m !== 'title';
  if (m !== 'build') builder.deactivate();
  if (m !== 'flight') flight.deactivate();
  sfx.quiet();
  if (m === 'build') builder.activate(); else if (m === 'flight') flight.activate(); else showTitle();
}
function resize() { renderer.setSize(window.innerWidth, window.innerHeight, false); }
window.addEventListener('resize', resize); resize();
setMode('title');
$('boot').remove();
window.apogee = { builder, flight, setMode, menuSky, tex, get mode() { return mode; }, autopilot: (warp) => (window.apogee.ap = startAutopilot(flight, warp)) };

document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button, .item'); if (b) { if (b.blur) b.blur(); if (b.id !== 'f-stage-btn') sfx.play('click'); } });
let last = performance.now(), clock = 0;
function loop(now) {
  const dt = Math.min(0.25, (now - last) / 1000); last = now; clock += dt;
  const w = window.innerWidth, h = window.innerHeight;
  tickFps(dt);
  try {
    if (mode === 'build') builder.render(w, h); else if (mode === 'flight') flight.frame(dt, w, h); else renderTitle(clock, w, h);
  } catch (err) { console.error(err); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
