// Developer aid: a simple ascent autopilot used for automated play-testing (window.apogee.autopilot()).
import * as THREE from '../vendor/three.module.js';
import { orbitElements } from './sim.js';

export function startAutopilot(flight, warp = 4) {
  const w = flight.world, pl = w.planet, v = w.active, Y = new THREE.Vector3(0, 1, 0);
  const real = pl.kind === 'real', hT = real ? 185000 : 60000, turnH = real ? 65000 : 22000;
    v.sas = true; v.sasMode = 'target'; v.throttle = 1;
  if (v.nextStage === 0) v.activateNextStage(w);
  w.warp = warp; flight.warpIdx = [1, 2, 4].indexOf(warp);
  const state = { done: false };
  const tick = () => {
    if (state.done) return;
    if (flight.world !== w || !w.vessels.includes(v)) { clearInterval(id); return; }
    const up = v.r.clone().normalize(), east = new THREE.Vector3().crossVectors(Y, up).normalize();
    const vr = v.v.dot(up), vh = v.v.clone().addScaledVector(up, -vr);
    const o = orbitElements(v.r, v.v, pl.mu, pl.R);
    const out = !v.parts.some((p) => p.def.engine && p.ignited && !p.flameout);
    const srbOut = v.parts.some((p) => p.def.engine && p.ignited && p.flameout && p.def.engine.fuelType === 'solid');
    const nx = v.parts.filter((p) => p.stage === v.stages[v.nextStage]);
    if ((out || srbOut) && nx.some((p) => p.def.engine || p.def.decoupler === 'radial')) { v.activateNextStage(w); for (const p of v.parts) if (p.flameout && p.def.engine.fuelType === 'solid') p.ignited = false; }
    const horiz = vh.lengthSq() > 1 && v.alt > turnH * 0.6 ? vh.clone().normalize() : east;
    let sinP;
    if (v.alt < turnH) {
      const vs = v.v.clone(); vs.x -= pl.omega * v.r.z; vs.z += pl.omega * v.r.x;
      sinP = Math.cos(vs.length() < 60 ? 0 : (80 * Math.PI / 180) * Math.pow(Math.min(1, Math.max(0, (v.alt - 600) / turnH)), 0.5));
    } else {
      const a = Math.max(0.5, v.thrust / v.mass), g = pl.mu / v.r.lengthSq() - vh.lengthSq() / v.r.length();
      sinP = Math.max(-0.25, Math.min(0.85, (g + (Math.max(-50, Math.min(400, (hT - v.alt) / 60)) - vr) / 12) / a));
    }
    v.sasDir.copy(horiz).multiplyScalar(Math.sqrt(1 - sinP * sinP)).addScaledVector(up, sinP);
    if (o.pe > pl.atmTop + 15000 && o.e < 1) { v.throttle = 0; v.sasMode = 'prograde'; state.done = true; clearInterval(id); }
  };
  const id = setInterval(tick, 40);
  state.tick = tick;
  // fast-forward helper for tests: simulate `sec` seconds immediately
  state.ff = (sec) => { for (let i = 0; i < sec * 100; i++) { if (i % 4 === 0) tick(); w.stepPhysics(0.01); } w.checkMilestones(); return { t: w.t, alt: v.alt, done: state.done }; };
  return state;
}
