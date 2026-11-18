// Ascent guidance shared by the on-screen coach, the auto-steer and the tests.
// Given the rocket's state it says where the nose should point and what to do with the engines:
//   ascent → burn while turning over, coast → engines off until the top of the arc,
//   burn → circularise, orbit → engines off, you made it.
import * as THREE from '../vendor/three.module.js';
import { orbitElements } from './sim.js';

const Y = new THREE.Vector3(0, 1, 0);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function ascentGuide(v, pl) {
  const hT = pl.atmTop * 1.32, turnH = pl.atmTop * 0.46;
  const up = v.r.clone().normalize();
  const east = new THREE.Vector3().crossVectors(Y, up).normalize();
  const vr = v.v.dot(up), vh = v.v.clone().addScaledVector(up, -vr);
  const o = orbitElements(v.r, v.v, pl.mu, pl.R);

  // engines and staging
  const live = v.parts.filter((p) => p.def.engine && p.ignited && !p.flameout);
  const rest = v.stages.slice(v.nextStage);
  const later = v.parts.filter((p) => p.def.engine && !p.ignited && rest.includes(p.stage));
  const boostersOut = v.parts.some((p) => p.def.engine && p.ignited && p.flameout && p.def.engine.fuelType === 'solid');
  const nextParts = v.parts.filter((p) => p.stage === v.stages[v.nextStage]);
  const needStage = !!v.launched && ((live.length === 0 && later.length > 0) || (boostersOut && nextParts.some((p) => p.def.decoupler === 'radial')));
  const outOfFuel = !!v.launched && live.length === 0 && later.length === 0;
  const pool = live.length ? live : later.filter((p) => p.stage === later[0].stage);
  const aMax = Math.max(0.5, pool.reduce((s, p) => s + p.def.engine.thrust, 0) / v.mass);

  // where to point
  const horiz = vh.lengthSq() > 1 && v.alt > turnH * 0.6 ? vh.clone().normalize() : east;
  let sinP;
  if (v.alt < turnH) {
    const th = v.v.length() < 60 ? 0 : ((80 * Math.PI) / 180) * Math.sqrt(clamp((v.alt - 600 / pl.atmK) / turnH, 0, 1));
    sinP = Math.cos(th);
  } else {
    const a = v.thrust > 0 ? Math.max(0.5, v.thrust / v.mass) : aMax;
    const g = pl.mu / v.r.lengthSq() - vh.lengthSq() / v.r.length();
    const vrDes = clamp((hT - v.alt) / (60 / Math.sqrt(pl.atmK)), -50, 400);
    sinP = clamp((g + (vrDes - vr) / 12) / a, -0.25, 0.85);
  }
  const dir = horiz.multiplyScalar(Math.sqrt(1 - sinP * sinP)).addScaledVector(up, sinP).normalize();

  // what to do with the engines
  let phase = 'ascent', tBurn = 0;
  if (o.e < 1 && o.pe > pl.atmTop * 1.05) phase = 'orbit';
  else if (o.e >= 1 && v.alt > pl.atmTop) phase = 'coast';
  else if (o.e < 1 && o.ap >= hT * (v._gCoast ? 0.9 : 0.97)) {
    v._gCoast = true;
    const rAp = pl.R + o.ap;
    const dv = Math.max(0, Math.sqrt(pl.mu / rAp) - o.hVec.length() / rAp);
    const tb = dv / aMax;
    if (v._gBurn || vr <= 0 || o.tAp <= tb * 0.5 + 2) { v._gBurn = true; phase = 'burn'; } else { phase = 'coast'; tBurn = o.tAp - tb * 0.5; }
  }
  return { phase, dir, tBurn, needStage, outOfFuel, o, hT };
}
