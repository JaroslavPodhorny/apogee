// Headless check: fly the stock two-stage rocket to orbit with a simple autopilot, then re-enter and land.
import * as THREE from '../vendor/three.module.js';
import { World, orbitElements } from '../src/sim.js';
import { stockRockets } from '../src/stock.js';
import { analyze } from '../src/rocket.js';
import { ascentGuide } from '../src/guide.js';
let lastPhase = '';

const kind = process.argv[2] || 'real';
const idx = +(process.argv[3] || 1);
const design = stockRockets()[idx];
const st = analyze(design);
console.log(design.name, 'mass', (st.mass / 1000).toFixed(1), 't  dv', st.totalDv.toFixed(0), st.stages.map((s) => `[S${s.stage} dv ${s.dv.toFixed(0)} twr ${s.twr?.toFixed(2)} burn ${s.burn.toFixed(0)}s]`).join(' '));
const world = new World(kind);
const pl = world.planet;
const v = world.launch(design);
const Y = new THREE.Vector3(0, 1, 0);
v.sas = true; v.sasMode = 'target'; v.throttle = 1;
v.activateNextStage(world);
const engineStages = v.stages.filter((n) => v.parts.some((p) => p.stage === n && p.def.engine)).length;
let phase = 'ascent', lastLog = -99, maxQ = 0, maxG = 0, maxT = 0;
const hT = pl.kind === 'real' ? 185000 : 60000;
const turnH = pl.kind === 'real' ? 65000 : 22000;
let orbitT = null;
for (let i = 0; i < 4e6 && world.vessels.includes(v); i++) {
  const up = v.r.clone().normalize();
  const east = new THREE.Vector3().crossVectors(Y, up).normalize();
  const vr = v.v.dot(up);
  const vh = v.v.clone().addScaledVector(up, -vr);
  const o = orbitElements(v.r, v.v, pl.mu, pl.R);
  maxQ = Math.max(maxQ, v.dynP); maxG = Math.max(maxG, v.gForce); maxT = Math.max(maxT, v.maxTempFrac);
  if (phase === 'ascent') {
    const g = ascentGuide(v, pl);
    if (g.needStage) v.activateNextStage(world);
    v.sasDir.copy(g.dir);
    v.throttle = g.phase === 'coast' || g.phase === 'orbit' ? 0 : 1;
    if (g.phase !== lastPhase) { lastPhase = g.phase; console.log(`  [${world.t.toFixed(0)}] guide: ${g.phase} alt ${(v.alt/1000).toFixed(1)} ap ${(o.ap/1000).toFixed(0)} pe ${(o.pe/1000).toFixed(0)} v ${v.v.length().toFixed(0)}`); }
    if (g.phase === 'orbit') { phase = 'orbit'; orbitT = world.t; console.log(`ORBIT at t=${world.t.toFixed(0)}s ap ${(o.ap / 1000).toFixed(0)} km pe ${(o.pe / 1000).toFixed(0)} km fuel left ${(v.totals().liquid).toFixed(0)} kg`); }
    if (g.outOfFuel && world.t > 5) { console.log('OUT OF FUEL before orbit', (o.ap / 1000).toFixed(0), (o.pe / 1000).toFixed(0)); break; }
  } else if (phase === 'orbit') {
    if (world.t - orbitT > o.tAp - 30 && world.t - orbitT > 100) { phase = 'deorbit'; v.sasMode = 'retrograde'; }
  } else if (phase === 'deorbit') {
    if (!v._db) v._db = world.t; if (world.t - v._db > 40) v.throttle = 1;
    if (o.pe < 30000 / pl.atmK || (v.thrust === 0 && world.t - v._db > 60)) {
      v.throttle = 0; phase = 'reentry';
      while (v.nextStage < v.stages.length) v.activateNextStage(world);
      console.log(`deorbit burn done t=${world.t.toFixed(0)} pe ${(o.pe / 1000).toFixed(0)} km, capsule mass ${v.mass.toFixed(0)}`);
      maxT = 0; maxG = 0;
    }
  } else if (phase === 'reentry') {
    v.sasMode = 'retrograde';
    if (v.landed) { console.log(`LANDED t=${world.t.toFixed(0)} parts ${v.parts.map((p) => p.def.id).join(',')}`); break; }
  }
  if ((phase === 'orbit' || phase === 'reentry') && v.alt > pl.atmTop + 2000 && v.thrust === 0) { world.t += 1; for (const x of world.vessels) x.gravityStep(1, pl.mu); v.alt = v.r.length() - pl.R; } else world.stepPhysics(0.01);
  world.checkMilestones();
  for (const e of world.events.splice(0)) console.log(`  [${world.t.toFixed(1)}] ${e.type}: ${e.text}`);
  if (world.t - lastLog >= (phase === 'reentry' ? 20 : 60) && (phase === 'ascent' || (phase === 'reentry' && v.alt < pl.atmTop))) {
    lastLog = world.t;
    const vs = v.v.clone(); vs.x -= pl.omega * v.r.z; vs.z += pl.omega * v.r.x;
    console.log(`t=${world.t.toFixed(0)} ${phase} alt ${(v.alt / 1000).toFixed(1)}km v ${v.v.length().toFixed(0)} vsurf ${vs.length().toFixed(0)} vr ${vr.toFixed(0)} ap ${(o.ap / 1000).toFixed(0)} pe ${(o.pe / 1000).toFixed(0)} m ${(v.mass / 1000).toFixed(1)}t q ${(v.dynP / 1000).toFixed(1)}kPa g ${v.gForce.toFixed(1)} T ${(v.maxTempFrac * 100).toFixed(0)}% nose·dir ${new THREE.Vector3(0, 1, 0).applyQuaternion(v.q).dot(v.sasDir).toFixed(3)}`);
  }
}
console.log(`maxQ ${(maxQ / 1000).toFixed(1)} kPa  maxG ${maxG.toFixed(1)}  maxTemp ${(maxT * 100).toFixed(0)}%  vessels ${world.vessels.length} activeLost ${!!world.activeLost}`);
