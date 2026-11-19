// Flight physics: rigid-body vessels around a rotating planet with atmosphere.
// Inertial, planet-centred frame. Planet spins about +Y. No rendering code here.
import * as THREE from '../vendor/three.module.js';
import { PARTS } from './parts.js';
import { computeLayout, adjacency, bfs, fuelGroups, controlPart, stageNumbers, G0, enclosures, stackNeighbors } from './rocket.js';

const V = () => new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

const RHO = [[0, 1.225], [5, 0.7364], [10, 0.4135], [15, 0.1948], [20, 0.0889], [25, 0.0401], [30, 0.0184], [40, 0.003996],
  [50, 0.001027], [60, 3.097e-4], [70, 8.283e-5], [80, 1.846e-5], [90, 3.416e-6], [100, 5.604e-7], [110, 9.7e-8], [120, 2.22e-8], [130, 8.2e-9], [140, 3.8e-9]];
const PRES = [[0, 1], [5, 0.5331], [10, 0.2615], [15, 0.1195], [20, 0.0546], [25, 0.0252], [30, 0.0118], [40, 0.00283],
  [50, 7.87e-4], [60, 2.17e-4], [70, 5.15e-5], [80, 1.04e-5], [90, 1.8e-6], [100, 3.2e-7]];
function logInterp(tab, x) {
  if (x <= 0) return tab[0][1];
  if (x >= tab[tab.length - 1][0]) return 0;
  let i = 1;
  while (tab[i][0] < x) i++;
  const [x0, y0] = tab[i - 1], [x1, y1] = tab[i];
  return y0 * Math.pow(y1 / y0, (x - x0) / (x1 - x0));
}

export function makePlanet(kind = 'real') {
  const p = kind === 'compact'
    ? { kind, name: 'Compact Earth (1:10)', R: 637100, atmK: 3, day: 21600 }
    : { kind: 'real', name: 'Earth (real scale)', R: 6371000, atmK: 1, day: 86164.1 };
  p.mu = 9.8203 * p.R * p.R;
  p.omega = (2 * Math.PI) / p.day;
  p.atmTop = 140000 / p.atmK;
  p.spaceLine = 100000 / p.atmK;
  p.density = (h) => logInterp(RHO, (h * p.atmK) / 1000);
  p.pressure = (h) => logInterp(PRES, (h * p.atmK) / 1000);
  p.sound = (h) => { const k = (h * p.atmK) / 1000; return k < 11 ? 340 - 4.1 * k : 295; };
  p.vCirc = (h) => Math.sqrt(p.mu / (p.R + h));
  return p;
}

export function orbitElements(r, v, mu, R) {
  const rm = r.length(), v2 = v.lengthSq();
  const energy = v2 / 2 - mu / rm;
  const hVec = V().crossVectors(r, v);
  const eVec = V().crossVectors(v, hVec).multiplyScalar(1 / mu).addScaledVector(r, -1 / rm);
  const e = eVec.length();
  const a = -mu / (2 * energy);
  const o = { a, e, energy, hVec, eVec, rm };
  o.pe = a * (1 - e) - R;
  o.ap = e < 1 ? a * (1 + e) - R : Infinity;
  o.period = e < 1 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;
  o.inc = Math.acos(clamp(hVec.y / (hVec.length() || 1), -1, 1));
  if (e < 1 && e > 1e-6) {
    const cosE = clamp((1 - rm / a) / e, -1, 1);
    let E = Math.acos(cosE);
    if (r.dot(v) < 0) E = 2 * Math.PI - E;
    const M = E - e * Math.sin(E), n = (2 * Math.PI) / o.period;
    o.tPe = (2 * Math.PI - M) / n;
    o.tAp = (((Math.PI - M) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / n;
  } else { o.tPe = 0; o.tAp = 0; }
  return o;
}

const SIGMA = 5.670374e-8;
const t1 = V(), t2 = V(), t3 = V(), t4 = V(), t5 = V(), t6 = V();
const qi = new THREE.Quaternion(), dq = new THREE.Quaternion();
const m3 = new THREE.Matrix3();

export class Vessel {
  constructor(parts) {
    this.parts = parts;
    this.r = V(); this.v = V(); this.q = new THREE.Quaternion(); this.w = V();
    this.com = V(); this.mass = 1; this.I = new THREE.Matrix3(); this.Iinv = new THREE.Matrix3();
    this.throttle = 0; this.input = { pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0 };
    this.name = 'Vessel'; this.qSin = 0; this.breakT = 0;
    this.sas = true; this.sasMode = 'hold'; this.sasQ = null; this.sasDir = V().set(0, 1, 0);
    this.rcs = false; this.cmd = V(); this.auth = V().set(1, 1, 1);
    this.landed = false; this.fix = null; this.restTime = 0;
    this.stages = []; this.nextStage = 0;
    this.thrust = 0; this.gForce = 0; this.dynP = 0; this.mach = 0; this.maxTempFrac = 0; this.heatFlux = 0;
    this.destroy = []; this.pending = []; this.jettison = []; this.isDebris = false; this.alt = 0; this.contacts = 0;
    this.rebuild();
  }

  rebuild() {
    const ps = this.parts;
    this.byId = new Map(ps.map((p) => [p.id, p]));
    for (const p of ps) if (p.parent && !this.byId.has(p.parent)) p.parent = null;
    const getDef = (n) => n.def;
    this.ctl = this.ctlId && this.byId.has(this.ctlId) ? this.byId.get(this.ctlId) : controlPart(ps, getDef);
    this.ctlId = this.ctl?.id;
    this.hasControl = !!this.ctl?.def.command && !this.isDebris;
    const groups = fuelGroups(ps, getDef);
    this.groupTanks = new Map();
    for (const p of ps) {
      p.group = groups.get(p.id);
      if (p.def.fuel?.liquid && p.group != null) {
        if (!this.groupTanks.has(p.group)) this.groupTanks.set(p.group, []);
        this.groupTanks.get(p.group).push(p);
      }
    }
    // what sits inside an interstage or a fairing is out of the airflow
    const nbs = stackNeighbors(ps);
    for (const p of ps) {
      const sh = p.shieldedBy && this.byId.get(p.shieldedBy);
      p.shielded = !!sh && (sh.inter ? true : !!sh.fair && !sh.fairGone);
      p.shellMass = (p.inter ? p.inter.mass : 0) + (p.fair && !p.fairGone ? p.fair.mass : 0);
      p.shellY = p.fair && !p.fairGone ? p.fair.comY : p.inter ? p.inter.y0 + p.inter.h / 2 : 0;
    }
    // docking ports: which face is free, where it is and which way it looks (body frame)
    this.ports = [];
    for (const p of ps) {
      const dk = p.def.dock; if (!dk) continue;
      p.portFree = false;
      if (p.docked && this.byId.has(p.docked)) continue;
      p.docked = null;
      let n = null, at = null;
      if (dk.radial) { n = p.ax.clone(); at = p.pos.clone().addScaledVector(p.ax, p.def.len * 0.78); } else {
        const nb = nbs.get(p.id);
        if (!nb.top) n = p.axis.clone(); else if (!nb.bottom) n = p.axis.clone().negate();
        if (n) at = p.pos.clone().addScaledVector(n, p.def.len / 2);
      }
      if (!n || p.shielded) continue;
      p.portFree = true; p.portN = n; p.portP = at; this.ports.push(p);
    }
    // aerodynamic exposure of end faces
    let bound = 0;
    for (const p of ps) {
      const d = p.def, maxR = Math.max(d.r, d.rTop);
      let topNb = null, botNb = null;
      if (p.parent && p.attach?.kind === 'stack') {
        const par = this.byId.get(p.parent);
        if (p.attach.node === 'top') botNb = par.def.rTop; else topNb = par.def.r;
      }
      for (const c of ps) {
        if (c.parent !== p.id || c.attach?.kind !== 'stack') continue;
        if (c.attach.node === 'top') topNb = c.def.r; else botNb = c.def.rTop;
      }
      const hol = d.hollow ?? 1;
      const full = Math.PI * maxR * maxR;
      p.expTop = Math.max(0, full - (topNb != null ? Math.PI * Math.min(d.rTop, topNb) ** 2 : 0)) * hol;
      p.expBot = Math.max(0, full - (botNb != null ? Math.PI * Math.min(d.r, botNb) ** 2 : 0)) * hol;
      p.sideA = (d.r + d.rTop) * d.len * hol;
      p.wetA = Math.PI * (d.r + d.rTop) * d.len;
      if (d.fin) { p.sideA = 0; p.finA = ((d.fin.chord + d.fin.tip) / 2) * d.fin.span; p.wetA = p.finA * 2; }
      if (d.panelLen) { p.sideA = 0; p.finA0 = d.panelLen * d.len; p.finA = p.finA0 * (d.deploy ? 0.08 + 0.92 * p.deployK : 1); p.wetA = p.finA * 2; }
      // shells: a fairing is a smooth ogive in front of its payload, an interstage a smooth cylinder
      if (p.fair && !p.fairGone) {
        const F = p.fair; p.expTop = Math.PI * F.R * F.R; p.cdTopNow = 0.16; p.sideA += 2 * F.R * F.H * 0.85; p.wetA += F.area;
      } else p.cdTopNow = null;
      if (p.inter) {
        const I = p.inter; p.sideA += (I.r0 + I.r1) * I.h; p.wetA += Math.PI * (I.r0 + I.r1) * I.h;
        p.expTop = nbs.get(p.id).top ? 0 : Math.PI * I.r1 * I.r1 * 1.1;     // once the stage above has left: an open cup
      }
      if (p.shielded) { p.expTop = 0; p.expBot = 0; p.sideA = 0; p.finA = 0; }
      bound = Math.max(bound, p.pos.length() + Math.max(d.len, maxR * 2, d.fin?.span || 0, d.leg?.reach || 0, p.fair ? p.fair.y0 + p.fair.H : 0) + 2);
    }
    this.boundR = bound * 2;
    this.updateMass();
  }

  partMass(p) { return p.def.mass - (p.ablated || 0) + p.liquid + p.solid + p.mono + (p.shellMass || 0); }

  updateMass() {
    let M = 0; const c = t1.set(0, 0, 0);
    for (const p of this.parts) {
      const m = this.partMass(p); M += m; c.addScaledVector(p.pos, m);
      if (p.shellMass) c.addScaledVector(p.axis, p.shellMass * p.shellY);   // the shell's weight sits up the shell, not at the ring
    }
    if (M <= 0) { this.mass = 1; return; }
    c.multiplyScalar(1 / M);
    this.com.copy(c); this.mass = M;
    let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;
    for (const p of this.parts) {
      const m = this.partMass(p), d = p.def;
      const x = p.pos.x - c.x, y = p.pos.y - c.y, z = p.pos.z - c.z;
      const rr = Math.max(d.r, d.rTop);
      const ia = 0.5 * m * rr * rr, it = (m * (3 * rr * rr + d.len * d.len)) / 12;
      const a = p.axis, k = ia - it;
      ixx += m * (y * y + z * z) + it + k * a.x * a.x;
      iyy += m * (x * x + z * z) + it + k * a.y * a.y;
      izz += m * (x * x + y * y) + it + k * a.z * a.z;
      ixy += -m * x * y + k * a.x * a.y;
      ixz += -m * x * z + k * a.x * a.z;
      iyz += -m * y * z + k * a.y * a.z;
    }
    this.I.set(ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz);
    this.Iinv.copy(this.I).invert();
    this.Idiag = [ixx, iyy, izz];
  }

  liquidInGroupsOfActiveEngines() {
    const gs = new Set(); let cur = 0, max = 0;
    for (const p of this.parts) {
      const E = p.def.engine; if (!E || !p.ignited || p.flameout) continue;
      if (E.fuelType === 'solid') { cur += p.solid; max += p.def.fuel.solid; } else gs.add(p.group);
    }
    for (const g of gs) for (const t of this.groupTanks.get(g) || []) { cur += t.liquid; max += t.def.fuel.liquid; }
    return { cur, max };
  }
  totals() {
    const o = { liquid: 0, liquidMax: 0, solid: 0, solidMax: 0, mono: 0, monoMax: 0 };
    for (const p of this.parts) {
      const f = p.def.fuel; if (!f) continue;
      o.liquid += p.liquid; o.liquidMax += f.liquid || 0; o.solid += p.solid; o.solidMax += f.solid || 0; o.mono += p.mono; o.monoMax += f.mono || 0;
    }
    return o;
  }

  activateNextStage(world) {
    if (!this.hasControl) return false;
    while (this.nextStage < this.stages.length) {
      const num = this.stages[this.nextStage++];
      const ps = this.parts.filter((p) => p.stage === num);
      if (!ps.length) continue;
      let ign = 0, dec = 0, ch = 0, fa = 0, wa = 0, les = 0;
      for (const p of ps) {
        if (p.def.les) { if (!p.ignited) p.ignited = true; this.pending.push(p.id); les++; continue; }
        if (p.def.engine && !p.ignited) { p.ignited = true; ign++; }
        if (p.def.chute && !p.armed) { p.armed = true; ch++; }
        if (p.def.decoupler && !p.def.fixed) { this.pending.push(p.id); dec++; }
        if (p.fair && !p.fairGone) { this.jettison.push(p.id); fa++; }
        if (p.def.warhead && !p.whArmed) { p.whArmed = true; wa++; }
      }
      const bits = [];
      if (ign) bits.push(`${ign} engine${ign > 1 ? 's' : ''} ignited`);
      if (dec) bits.push(`${dec} decoupler${dec > 1 ? 's' : ''} fired`);
      if (les) bits.push('escape tower jettisoned');
      if (fa) bits.push(`fairing${fa > 1 ? 's' : ''} open`);
      if (ch) bits.push(`parachute${ch > 1 ? 's' : ''} armed`);
      if (wa) bits.push(`${wa} warhead${wa > 1 ? 's' : ''} ARMED`);
      world.emit('stage', `Stage ${this.nextStage}: ${bits.join(', ')}`);
      return true;
    }
    return false;
  }

  // Attitude control: produces this.cmd (desired torque direction, body frame, each axis -1..1)
  computeControl(world) {
    const cmd = this.cmd.set(0, 0, 0);
    if (!this.hasControl) return;
    const u = this.input;
    const user = t6.set(u.pitch, u.roll, u.yaw);
    const userActive = user.lengthSq() > 0;
    if (this.sas) {
      const err = t5.set(0, 0, 0);
      let rollFree = true;
      if (this.sasMode === 'hold') {
        if (!this.sasQ || userActive) this.sasQ = this.q.clone();
        dq.copy(this.q).invert().multiply(this.sasQ);
        if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
        const s = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w)), ang = 2 * Math.acos(clamp(dq.w, -1, 1));
        if (s > 1e-6) err.set(dq.x, dq.y, dq.z).multiplyScalar(ang / s);
        rollFree = false;
      } else {
        const dir = world.sasDirection(this, this.sasMode, t4);
        if (dir) {
          dir.applyQuaternion(qi.copy(this.q).invert());
          err.crossVectors(Y_AXIS, dir);
          const sl = err.length(), ang = Math.atan2(sl, dir.y);
          if (sl > 1e-6) err.multiplyScalar(ang / sl); else if (dir.y < 0) err.set(Math.PI, 0, 0);
        }
      }
      const comp = ['x', 'y', 'z'];
      for (let i = 0; i < 3; i++) {
        const k = comp[i];
        const au = this.auth[k], I = this.Idiag[i];
        if (au < 1e-9 * I + 1e-6) continue;
        const amax = au / I;
        let e = err[k];
        if (i === 1 && rollFree) e = 0;
        const wdes = Math.sign(e) * Math.min(1.2 * Math.abs(e), 0.7 * Math.sqrt(2 * amax * Math.abs(e)), 0.6);
        cmd[k] = clamp(((wdes - this.w[k]) * 5 * I) / au, -1, 1);
      }
    }
    if (userActive && this.sas) {
      // With SAS on, a held key asks for a steady turn rate (and letting go stops the turn),
      // instead of pushing harder and harder.
      const comp = ['x', 'y', 'z'], RATE = 0.2;
      for (let i = 0; i < 3; i++) {
        const k = comp[i], au = this.auth[k], I = this.Idiag[i];
        if (au < 1e-9 * I + 1e-6) continue;
        cmd[k] = clamp(((user[k] * RATE - this.w[k]) * 5 * I) / au, -1, 1);
      }
      this.sasQ = null;
    } else {
      if (u.pitch) cmd.x = u.pitch;
      if (u.roll) cmd.y = u.roll;
      if (u.yaw) cmd.z = u.yaw;
    }
  }

  step(dt, world) {
    const pl = world.planet;
    if (this.landed) {
      const live = this.parts.some((p) => p.def.engine && p.ignited && !p.flameout && (p.def.engine.fuelType === 'solid' || this.throttle > 0));
      if (!live) { this.followGround(world); this.thrust = 0; this.gForce = 1; this.dynP = 0; this.cmd.set(0, 0, 0); return; }
      this.landed = false; this.restTime = 0;
      if (!this.launched) { this.launched = true; world.emit('info', 'Liftoff!'); }
    }
    this.updateMass();
    const rmag = this.r.length(), h = rmag - pl.R;
    this.alt = h;
    qi.copy(this.q).invert();
    const rho = h < pl.atmTop ? pl.density(h) : 0;
    const pr = pl.pressure(h);
    // air-relative velocity in body frame
    const vAir = t1.set(-pl.omega * -this.r.z, 0, -pl.omega * this.r.x); // omega x r, omega=(0,w,0): (w*z, 0, -w*x)
    vAir.set(pl.omega * this.r.z, 0, -pl.omega * this.r.x);
    const vb = t2.copy(this.v).sub(vAir).applyQuaternion(qi);
    const sAir = vb.length();
    const mach = sAir / pl.sound(h);
    this.mach = mach; this.dynP = 0.5 * rho * sAir * sAir;
    // aerodynamic bending: dynamic pressure times how sideways the air hits the stack
    this.qSin = sAir > 1 ? this.dynP * Math.hypot(vb.x, vb.z) / sAir : 0;
    const mult = 1 + 0.8 * Math.exp(-(((mach - 1.05) / 0.28) ** 2)) + 0.12 * clamp(mach - 1, 0, 1);
    const qd = 0.5 * rho;
    this.computeControl(world);
    const cmd = this.cmd;
    const Fb = V(), Tb = V();
    const auth = V();
    const d = V(), wp = V(), f = V(), tq = V(), wl = V();
    let wheel = 0, maxFrac = 0, maxFlux = 0;
    const mdotRcs = [];

    // --- engines: fuel demand by pool ---
    const need = new Map();
    for (const p of this.parts) {
      const E = p.def.engine; p.thrustNow = 0;
      if (!E || !p.ignited || p.flameout) { if (E) p.spool = 0; continue; }
      // engines spool up and down: turbopumps take about a second, solids light in a quarter of one
      const want = E.throttle ? this.throttle : 1, tau = E.fuelType === 'solid' ? 0.12 : 0.25 + 0.35 * Math.sqrt(E.thrust / 1e6);
      p.spool = (p.spool || 0) + (want - (p.spool || 0)) * (1 - Math.exp(-dt / tau));
      if (want === 0 && p.spool < 0.01) p.spool = 0;
      // a solid motor's thrust tails off as the last of its grain burns away
      p.tail = E.fuelType === 'solid' ? clamp(p.solid / (0.04 * (p.def.fuel?.solid || 1)), 0.12, 1) : 1;
      p._md = (p.spool * p.tail * E.thrust) / (E.ispVac * G0) * dt;
      if (E.fuelType === 'liquid') need.set(p.group, (need.get(p.group) || 0) + p._md);
    }
    const ratio = new Map();
    for (const [g, n] of need) {
      const tanks = this.groupTanks.get(g) || [];
      let av = 0; for (const t of tanks) av += t.liquid;
      const rt = n <= 0 ? 1 : Math.min(1, av / n);
      ratio.set(g, av <= 1e-9 ? 0 : rt);
      if (av > 0 && n > 0) { const k = Math.max(0, 1 - (n * rt) / av); for (const t of tanks) t.liquid *= k; }
    }
    let thrustTot = 0;
    for (const p of this.parts) {
      const E = p.def.engine;
      if (!E || !p.ignited || p.flameout) continue;
      let k = 1;
      if (E.fuelType === 'liquid') { k = ratio.get(p.group) ?? 0; if (k === 0 && p._md > 0) { p.flameout = true; world.emit('warn', `${p.def.name} flameout: out of propellant`, this); continue; } if (!this.groupTanks.get(p.group)?.some((t) => t.liquid > 1e-6)) { p.flameout = true; world.emit('warn', `${p.def.name} flameout: out of propellant`, this); } }
      else { if (p.solid <= p._md) { k = p.solid / p._md; p.solid = 0; p.flameout = true; world.emit('info', `${p.def.name} burned out`, this); } else p.solid -= p._md; }
      const isp = E.ispVac + (E.ispSl - E.ispVac) * Math.min(1, pr);
      const F = p.spool * p.tail * E.thrust * (isp / E.ispVac) * k;
      p.thrustNow = F; thrustTot += F;
      d.copy(p.pos).sub(this.com);
      f.copy(p.axis);
      const gmax = (E.gimbal * Math.PI) / 180;
      if (gmax > 0) {
        tq.crossVectors(d, p.ax); let l = tq.length();
        const gxc = l > 1e-6 ? clamp((tq.dot(cmd) / l) * 1.5, -1, 1) : 0;
        tq.crossVectors(d, p.az); l = tq.length();
        const gzc = l > 1e-6 ? clamp((tq.dot(cmd) / l) * 1.5, -1, 1) : 0;
        // the actuators move the nozzle at a finite rate (full travel in about a fifth of a second)
        const sl = dt * 5;
        p.gx += clamp(gxc - p.gx, -sl, sl); p.gz += clamp(gzc - p.gz, -sl, sl);
        const gx = p.gx, gz = p.gz;
        f.addScaledVector(p.ax, gx * gmax).addScaledVector(p.az, gz * gmax).normalize();
        const sg = Math.sin(gmax) * F;
        auth.x += sg * Math.hypot(d.y, d.z); auth.y += sg * Math.hypot(d.x, d.z) * 0.7; auth.z += sg * Math.hypot(d.x, d.y);
      }
      f.multiplyScalar(F);
      Fb.add(f); Tb.add(tq.crossVectors(d, f));
    }
    this.thrust = thrustTot;

    // --- per-part aero, heat, control surfaces, wheels, rcs ---
    let monoTot = 0, rcsF = 0;
    for (const p of this.parts) monoTot += p.mono;
    for (const p of this.parts) {
      const def = p.def;
      if (def.wheel) wheel += def.wheel;
      if (def.rcs) rcsF += def.rcs;
      if (def.deploy) {
        const tgt = p.deployT || 0;
        if (p.deployK !== tgt) { p.deployK = tgt > p.deployK ? Math.min(tgt, p.deployK + dt / 4) : Math.max(tgt, p.deployK - dt / 4); p.finA = p.finA0 * (0.08 + 0.92 * p.deployK); }
        if (p.deployK > 0.15 && this.dynP > 350) this.destroy.push({ id: p.id, why: 'ripped' });
      }
      // escape tower: once burned out it throws itself off after a moment
      if (def.les && p.ignited && p.flameout && !p.lesGone) { p.lesT = (p.lesT || 0) + dt; if (p.lesT > 0.8) { p.lesGone = true; this.pending.push(p.id); } }
      d.copy(p.pos).sub(this.com);
      if (def.rcs && this.rcs && monoTot > 0 && this.hasControl) {
        const lx = Math.hypot(d.y, d.z), ly = Math.hypot(d.x, d.z), lz = Math.hypot(d.x, d.y);
        Tb.x += cmd.x * def.rcs * lx; Tb.y += cmd.y * def.rcs * ly; Tb.z += cmd.z * def.rcs * lz;
        auth.x += def.rcs * lx; auth.y += def.rcs * ly; auth.z += def.rcs * lz;
        mdotRcs.push(((Math.abs(cmd.x) + Math.abs(cmd.y) + Math.abs(cmd.z)) * def.rcs) / (240 * G0) * dt);
      }
      if (rho <= 0 || p.shielded) { p.temp += (280 - p.temp) * Math.min(1, dt * 0.02); p.flux = 0; continue; }
      wp.crossVectors(this.w, d).add(vb);
      const s = wp.length();
      if (s < 1e-3) continue;
      const a = p.axis;
      const wax = wp.dot(a);
      wl.copy(wp).addScaledVector(a, -wax);
      const slat = wl.length();
      const lead = wax > 0 ? p.expTop * (p.cdTopNow ?? def.cdTop) : p.expBot * def.cdBottom;
      const trail = (wax > 0 ? p.expBot : p.expTop) * 0.18;
      f.copy(a).multiplyScalar(-qd * wax * Math.abs(wax) * (lead + trail + 0.004 * p.wetA) * mult);
      f.addScaledVector(wl, -qd * (0.16 * s + 0.9 * slat) * p.sideA * mult);
      if (p.finA) {
        let n = p.az;
        const ctl = def.fin?.control;
        if (ctl && this.hasControl) {
          tq.crossVectors(d, p.az); const l = tq.length();
          const dl = l > 1e-6 ? clamp((tq.dot(cmd) / l) * 1.5 * Math.sign(wax || 1), -1, 1) * (ctl * Math.PI) / 180 : 0;
          p.defl = dl;
          n = t3.copy(p.az).multiplyScalar(Math.cos(dl)).addScaledVector(a, -Math.sin(dl));
          const A = qd * p.finA * 3.2 * s * s * Math.sin((ctl * Math.PI) / 180);
          auth.x += A * Math.hypot(d.y, d.z) * Math.abs(p.az.z); auth.z += A * Math.hypot(d.x, d.y) * Math.abs(p.az.x); auth.y += A * Math.hypot(d.x, d.z) * 0.5;
        }
        const wn = wp.dot(n);
        const Fm = qd * p.finA * Math.min(3.2 * s * Math.abs(wn), 1.3 * s * s) * mult;
        f.addScaledVector(n, -Math.sign(wn) * Fm);
        if (def.fin) d.addScaledVector(p.ax, def.fin.span * 0.4);
      }
      if (p.chuteOpen > 0) {
        f.addScaledVector(wp, -qd * def.chute.cda * p.chuteOpen ** 3 * s);
        if (qd * s * s > 30000 && p.chuteOpen > 0.5) { p.chuteOpen = 0; p.armed = false; p.chuteGone = true; world.emit('warn', 'Parachute ripped off by aerodynamic forces!', this); }
      }
      if (p.armed && !p.chuteGone && p.chuteOpen < 1) {
        if (p.chuteOpen > 0 || (rho > 0.85 && qd * s * s < 14000 && wp.dot(a) < 0.3 * s)) {
          if (p.chuteOpen === 0) world.emit('info', 'Parachute deployed', this);
          p.chuteOpen = Math.min(1, (p.chuteOpen || 0) + dt / 5);
        }
      }
      Fb.add(f); Tb.add(tq.crossVectors(d, f));
      // heating
      const rn = Math.max(def.r, def.rTop, 0.25);
      const flux = 1.7415e-4 * Math.sqrt(rho / rn) * s * s * s;
      const aLead = (wax > 0 ? p.expTop : p.expBot) * (Math.abs(wax) / s);
      const aEff = aLead + 0.08 * (p.sideA + (p.finA || 0)) * (0.25 + slat / s);
      const C = def.mass * (def.heatMass || 1) * 900 * 0.08 + 3000;
      const aTot = p.wetA + 2 * Math.PI * rn * rn;
      const T = p.temp, T2 = T * T;
      const pin = flux * aEff;
      const prad = 0.85 * SIGMA * (aEff * 1.3 + 0.08 * aTot) * (T2 * T2 - 6.1e9);
      p.temp = Math.max(200, T + clamp(((pin - prad) * dt) / C, -50, 50));
      p.flux = flux * (aEff / (aTot * 0.3 + 0.1));
      // ablative shields char and erode: they carry heat away by losing material
      if (def.shield && p.temp > def.maxTemp * 0.45 && pin > 0) {
        const left = def.mass * 0.4 - (p.ablated || 0);
        if (left > 0) { const use = Math.min(left, (pin * dt) / 4e7); p.ablated = (p.ablated || 0) + use; } else if (!p.burnThrough) { p.burnThrough = true; world.emit('bad', 'Heat shield ablator used up: it will burn through', this); }
      }
      if (flux * Math.min(1, aEff) > maxFlux) maxFlux = flux * Math.min(1, aEff);
      const frac = p.temp / (p.burnThrough ? Math.min(def.maxTemp, 1700) : def.maxTemp);
      if (frac > maxFrac) maxFrac = frac;
      if (frac >= 1) this.destroy.push({ id: p.id, why: 'overheated' });
    }
    this.maxTempFrac = maxFrac; this.heatFlux = maxFlux;
    if (this.hasControl) {
      Tb.addScaledVector(cmd, wheel);
      auth.x += wheel; auth.y += wheel; auth.z += wheel;
      // RCS translation: the thruster quads push the whole craft sideways, forward or back
      const u = this.input, tr = Math.abs(u.tx) + Math.abs(u.ty) + Math.abs(u.tz);
      if (tr > 0 && this.rcs && monoTot > 0 && rcsF > 0) {
        Fb.x += u.tx * rcsF * 0.5; Fb.y += u.ty * rcsF * 0.5; Fb.z += u.tz * rcsF * 0.5;
        mdotRcs.push((tr * rcsF * 0.5) / (240 * G0) * dt);
      }
    }
    if (mdotRcs.length && monoTot > 0) {
      let use = 0; for (const m of mdotRcs) use += m;
      const k = Math.max(0, 1 - use / monoTot);
      for (const p of this.parts) p.mono *= k;
    }
    this.auth.copy(auth);

    // --- ground contact ---
    this.contacts = 0;
    // terrain under the vessel (0 on the flat sphere, e.g. in the headless test)
    const th = world.theta(), terr = pl.terrain;
    const gH = terr ? terr.groundAt(this.r, th) : 0;
    this.ground = gH;
    if (h - gH - this.boundR < 5) {
      const hits = [];
      for (const p of this.parts) {
        for (const c of p.cpts) {
          const arm = V().copy(c).sub(this.com);
          const x = V().copy(arm).applyQuaternion(this.q).add(this.r);
          const xm = x.length();
          const gr = pl.R + (terr ? terr.groundAt(x, th) : 0);
          if (xm < gr) hits.push({ p, arm, x, depth: gr - xm, n: x.clone().multiplyScalar(1 / xm) });
        }
      }
      this.contacts = hits.length;
      const kS = (this.mass * 1400) / Math.max(1, hits.length), cS = (this.mass * 70) / Math.max(1, hits.length);
      for (const ht of hits) {
        const vp = t3.crossVectors(this.w, ht.arm).applyQuaternion(this.q).add(this.v);
        vp.x -= pl.omega * ht.x.z; vp.z -= -pl.omega * ht.x.x;
        const vn = vp.dot(ht.n);
        const sp = vp.length();
        const tol = ht.p.def.crashTol;
        const W = ht.p.def.warhead;
        if (W && (ht.p.whArmed || (W.kind === 'kinetic' && sp > 250)) && !ht.p.boom) { ht.p.boom = true; world.detonate(this, ht.p, sp); continue; }
        if (-vn > tol || sp > tol * 2.5) { this.destroy.push({ id: ht.p.id, why: 'crashed' }); continue; }
        const Fn = Math.max(0, kS * ht.depth - cS * vn);
        f.copy(ht.n).multiplyScalar(Fn);
        const vt = t4.copy(vp).addScaledVector(ht.n, -vn), vtl = vt.length();
        if (vtl > 1e-4) f.addScaledVector(vt, -Math.min((0.9 * Fn) / vtl, cS * 0.6));
        f.applyQuaternion(qi);
        Fb.add(f); Tb.add(tq.crossVectors(ht.arm, f));
      }
      if (hits.length) {
        for (const p of this.parts) if (p.chuteOpen > 0 && this.restTime > 0.5) { p.chuteOpen = 0; p.armed = false; p.chuteGone = true; }
        const vg = t3.copy(this.v); vg.x -= pl.omega * this.r.z; vg.z += pl.omega * this.r.x;
        if (vg.length() < 0.25 && this.w.length() < 0.05 && thrustTot === 0) this.restTime += dt; else this.restTime = 0;
        if (this.restTime > 1.5) { this.land(world); return; }
      } else this.restTime = 0;
    }

    // --- air-burst fuses: a nuclear device goes off at the height that spreads its blast widest ---
    for (const p of this.parts) {
      const W = p.def.warhead;
      if (!W || !p.whArmed || p.boom || !p.def.nuke) continue;
      const hob = 220 * Math.cbrt(W.kt), vUp = this.v.dot(t3.copy(this.r).normalize());
      if (vUp < -5 && h - gH < hob) { p.boom = true; world.detonate(this, p, 0); }
    }
    // --- structural failure under aerodynamic load (long stacks flown sideways through thick air) ---
    if (this.launched && !this.landed && this.qSin > 9000) {
      let lo = Infinity, hi = -Infinity;
      for (const p of this.parts) { const y = p.pos.dot(Y_AXIS); lo = Math.min(lo, y - p.def.len / 2); hi = Math.max(hi, y + p.def.len / 2); }
      this.breakT += dt;
      if (hi - lo > 10 && this.breakT > 0.25) {
        let best = null, bd = Infinity;
        for (const p of this.parts) {
          if (!p.parent || p.attach?.kind !== 'stack' || p.shielded) continue;
          const par = this.byId.get(p.parent); if (!par) continue;
          const jy = (p.pos.y + par.pos.y) / 2, dd = Math.abs(jy - this.com.y);
          if (dd < bd) { bd = dd; best = p; }
        }
        if (best) { best.parent = null; this.needSplit = true; this.breakT = -2; this.structural = true; world.emit('bad', 'Structural failure: the stack snapped under aerodynamic load. Fly closer to prograde through thick air.', this); }
      }
    } else this.breakT = Math.max(0, this.breakT - dt);

    // --- integrate ---
    this.gForce = Fb.length() / this.mass / G0;
    const acc = Fb.applyQuaternion(this.q).multiplyScalar(1 / this.mass);
    acc.addScaledVector(this.r, -pl.mu / (rmag * rmag * rmag));
    this.v.addScaledVector(acc, dt);
    this.r.addScaledVector(this.v, dt);
    // Euler's equations in body frame
    const Iw = t3.copy(this.w).applyMatrix3(this.I);
    tq.crossVectors(this.w, Iw);
    Tb.sub(tq).applyMatrix3(this.Iinv);
    this.w.addScaledVector(Tb, dt);
    const wm = this.w.length();
    if (wm > 1e-9) { dq.setFromAxisAngle(t3.copy(this.w).multiplyScalar(1 / wm), wm * dt); this.q.multiply(dq).normalize(); }
    if (this.r.length() < pl.R + gH - 30) { for (const p of this.parts) this.destroy.push({ id: p.id, why: 'crashed' }); }
  }

  land(world) {
    const th = world.theta();
    dq.setFromAxisAngle(Y_AXIS, -th);
    this.fix = { r: this.r.clone().applyQuaternion(dq), q: dq.clone().multiply(this.q) };
    this.landed = true; this.w.set(0, 0, 0);
    if (this.launched && !this.isDebris) world.emit('good', 'Touchdown! Landed safely.', this);
    this.followGround(world);
  }
  followGround(world) {
    const th = world.theta(), om = world.planet.omega;
    dq.setFromAxisAngle(Y_AXIS, th);
    this.r.copy(this.fix.r).applyQuaternion(dq);
    this.q.copy(dq).multiply(this.fix.q);
    this.v.set(om * this.r.z, 0, -om * this.r.x);
    this.w.set(0, om, 0).applyQuaternion(qi.copy(this.q).invert());
    this.alt = this.r.length() - world.planet.R;
  }
  gravityStep(dt, mu) { // RK4, gravity only
    const acc = (r, out) => { const m = r.length(); return out.copy(r).multiplyScalar(-mu / (m * m * m)); };
    const r0 = this.r, v0 = this.v;
    const k1v = acc(r0, V()), k1r = v0.clone();
    const k2r = v0.clone().addScaledVector(k1v, dt / 2), k2v = acc(r0.clone().addScaledVector(k1r, dt / 2), V());
    const k3r = v0.clone().addScaledVector(k2v, dt / 2), k3v = acc(r0.clone().addScaledVector(k2r, dt / 2), V());
    const k4r = v0.clone().addScaledVector(k3v, dt), k4v = acc(r0.clone().addScaledVector(k3r, dt), V());
    r0.addScaledVector(k1r, dt / 6).addScaledVector(k2r, dt / 3).addScaledVector(k3r, dt / 3).addScaledVector(k4r, dt / 6);
    v0.addScaledVector(k1v, dt / 6).addScaledVector(k2v, dt / 3).addScaledVector(k3v, dt / 3).addScaledVector(k4v, dt / 6);
  }
}

function contactPoints(def) {
  const pts = [], L = def.len / 2;
  if (def.leg) { pts.push(V().set(def.leg.reach, -def.leg.drop, 0)); return pts; }
  if (def.fin) { pts.push(V().set(def.fin.span, -def.fin.sweep - def.fin.tip / 2 + def.fin.chord / 2, 0), V().set(def.fin.span * 0.5, -def.fin.chord / 2, 0)); return pts; }
  if (def.panelLen) { pts.push(V().set(def.panelLen, 0, 0)); return pts; }
  for (const [y, r] of [[-L, def.r], [L, def.rTop]]) {
    if (r < 0.06) pts.push(V().set(0, y, 0));
    else pts.push(V().set(r, y, 0), V().set(-r, y, 0), V().set(0, y, r), V().set(0, y, -r));
  }
  return pts;
}

function makeSimPart(src, def, pos, quat) {
  const p = {
    id: src.id, def, pos: pos.clone(), quat: quat.clone(), parent: src.parent, attach: src.attach, stage: src.stage,
    liquid: def.fuel?.liquid || 0, solid: def.fuel?.solid || 0, mono: def.fuel?.mono || 0,
    temp: 290, ignited: false, flameout: false, armed: false, chuteOpen: 0, thrustNow: 0, gx: 0, gz: 0, defl: 0, flux: 0,
    spool: 0, tail: 1, docked: null, deployK: 0, deployT: 0, whArmed: false,
  };
  placePart(p, pos, quat);
  return p;
}
// (re)place a part in its vessel's body frame and refresh everything derived from that
function placePart(p, pos, quat) {
  p.pos.copy(pos); p.quat.copy(quat);
  p.axis = Y_AXIS.clone().applyQuaternion(quat); p.ax = X_AXIS.clone().applyQuaternion(quat); p.az = Z_AXIS.clone().applyQuaternion(quat);
  p.cpts = contactPoints(p.def).map((c) => c.applyQuaternion(quat).add(pos));
}
// What the shells round a rocket are, worked out once at launch and kept on the parts that carry them.
function assignShells(parts) {
  const enc = enclosures(parts);
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const [id, I] of enc.inter) { const d = byId.get(id); d.inter = I; const e = byId.get(I.engine); if (e) e.shieldedBy = id; }
  for (const [id, F] of enc.fair) { const b = byId.get(id); b.fair = F; for (const q of F.inside) { const x = byId.get(q); if (x && !x.shieldedBy) x.shieldedBy = id; } }
}

// ---------- persistence: a vessel to plain data and back ----------
const KEEP = ['id', 'parent', 'attach', 'stage', 'liquid', 'solid', 'mono', 'temp', 'ignited', 'flameout', 'armed', 'chuteOpen', 'chuteGone', 'docked',
  'deployK', 'deployT', 'whArmed', 'inter', 'fair', 'fairGone', 'shieldedBy', 'ablated', 'burnThrough', 'lesGone'];
const arr = (v) => [v.x, v.y, v.z];
const arrQ = (q) => [q.x, q.y, q.z, q.w];
export function serializeVessel(v) {
  return {
    name: v.name, isDebris: v.isDebris, launched: v.launched, landed: v.landed, ctlId: v.ctlId,
    r: arr(v.r), v: arr(v.v), q: arrQ(v.q), w: arr(v.w), fix: v.fix ? { r: arr(v.fix.r), q: arrQ(v.fix.q) } : null,
    stages: v.stages, nextStage: v.nextStage, sas: v.sas, sasMode: v.sasMode === 'target' ? 'hold' : v.sasMode, rcs: v.rcs, uid: v.uid,
    parts: v.parts.map((p) => {
      const o = { type: p.def.synthetic ? null : p.def.id, def: p.def.synthetic ? p.def : undefined, pos: arr(p.pos), quat: arrQ(p.quat) };
      for (const k of KEEP) if (p[k] !== undefined && p[k] !== null && p[k] !== false && p[k] !== 0) o[k] = p[k];
      return o;
    }),
  };
}
export function restoreVessel(o) {
  const parts = [];
  for (const s of o.parts) {
    const def = s.type ? PARTS[s.type] : s.def;
    if (!def) continue;
    const p = makeSimPart({ id: s.id, parent: s.parent ?? null, attach: s.attach ?? null, stage: s.stage }, def, V().fromArray(s.pos), new THREE.Quaternion().fromArray(s.quat));
    for (const k of KEEP) if (s[k] !== undefined && k !== 'id') p[k] = s[k];
    parts.push(p);
  }
  if (!parts.length) return null;
  const v = new Vessel(parts);
  v.name = o.name; v.isDebris = o.isDebris; v.launched = o.launched; v.uid = o.uid || uidV();
  v.r.fromArray(o.r); v.v.fromArray(o.v); v.q.fromArray(o.q); v.w.fromArray(o.w);
  v.stages = o.stages || stageNumbers(parts); v.nextStage = o.nextStage || 0;
  v.sas = o.sas ?? true; v.sasMode = o.sasMode || 'hold'; v.rcs = !!o.rcs;
  if (o.ctlId && v.byId.has(o.ctlId)) { v.ctlId = o.ctlId; v.rebuild(); }
  v.hasControl = !!v.ctl?.def.command && !v.isDebris;
  if (o.landed && o.fix) { v.fix = { r: V().fromArray(o.fix.r), q: new THREE.Quaternion().fromArray(o.fix.q) }; v.landed = true; }
  return v;
}
let vCounter = 1;
const uidV = () => `v${Date.now().toString(36)}${(vCounter++).toString(36)}`;
// Kepler's equation for an ellipse: where a coasting craft is after dt (exact, any length of time)
export function keplerStep(r, v, mu, dt) {
  const rm = r.length(), v2 = v.lengthSq(), a = 1 / (2 / rm - v2 / mu);
  if (!(a > 0)) return false;
  const h = V().crossVectors(r, v), eVec = V().crossVectors(v, h).multiplyScalar(1 / mu).addScaledVector(r, -1 / rm), e = eVec.length();
  if (e >= 0.999) return false;
  const n = Math.sqrt(mu / (a * a * a));
  const P = e > 1e-8 ? eVec.clone().multiplyScalar(1 / e) : r.clone().normalize();
  const Q = V().crossVectors(h, P).normalize();
  const x = r.dot(P), y = r.dot(Q);
  const nu0 = Math.atan2(y, x);
  let E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu0 / 2), Math.sqrt(1 + e) * Math.cos(nu0 / 2));
  const M = E0 - e * Math.sin(E0) + n * dt;
  let E = M;
  for (let i = 0; i < 30; i++) { const f = E - e * Math.sin(E) - M; E -= f / (1 - e * Math.cos(E)); if (Math.abs(f) < 1e-12) break; }
  const cE = Math.cos(E), sE = Math.sin(E), b = a * Math.sqrt(1 - e * e);
  const px = a * (cE - e), py = b * sE, rr = a * (1 - e * cE);
  const vx = (-a * n * sE) / (1 - e * cE), vy = (b * n * cE) / (1 - e * cE);
  r.copy(P).multiplyScalar(px).addScaledVector(Q, py);
  v.copy(P).multiplyScalar(vx).addScaledVector(Q, vy);
  return rr > 0;
}

// Blast physics. Peak overpressure from the Kinney–Graham fit to measured explosions, scaled by the cube
// root of yield and for the thinner air aloft (Sachs scaling). Returns the pressure ratio above ambient.
export function overpressureRatio(dist, kgTNT, pAmb) {
  const Z = Math.max(0.05, dist / Math.cbrt(kgTNT) * Math.cbrt(Math.max(1e-4, pAmb)));
  return (808 * (1 + (Z / 4.5) ** 2)) / Math.sqrt((1 + (Z / 0.048) ** 2) * (1 + (Z / 0.32) ** 2) * (1 + (Z / 1.35) ** 2));
}
// Largest fireball radius: nuclear from Glasstone & Dolan (≈ 66 m · kt^0.4); chemical ≈ 1.75 m · kg^⅓
export function fireballRadius(kt, kind) {
  if (kind === 'fission' || kind === 'fusion') return 66 * Math.pow(Math.max(kt, 1e-6), 0.4);
  return 1.75 * Math.cbrt(Math.max(kt, 1e-9) * 1e6) * (kind === 'fae' ? 1.9 : 1);
}
// height the mushroom cloud's top climbs to (fit to test data: 20 kt ≈ 12 km, 1 Mt ≈ 25 km, 50 Mt ≈ 64 km)
export function cloudTop(kt) { return 12000 * Math.pow(Math.max(kt, 1e-3) / 20, 0.214); }

export class World {
  constructor(planetKind = 'real') {
    this.planet = makePlanet(planetKind);
    this.t = 0; this.theta0 = 0; this.vessels = []; this.active = null; this.events = [];
    this.warp = 1; this.acc = 0; this.h = 0.01;
    const lat = (5 * Math.PI) / 180;
    this.siteFixed = V().set(Math.cos(lat), Math.sin(lat), 0);
    this.flags = {}; this.fx = []; this.blasts = []; this.craters = [];
    this.loadR = 2500;          // craft closer than this to the active one get full physics; the rest coast on rails
  }
  theta() { return this.theta0 + this.planet.omega * this.t; }
  siteDir(out = V()) { return out.copy(this.siteFixed).applyAxisAngle(Y_AXIS, this.theta()); }
  emit(type, text, vessel) { if (!vessel || vessel === this.active) this.events.push({ type, text, t: this.t }); }

  launch(design) {
    const layout = computeLayout(design.parts);
    // fresh ids: the same design can fly many times in one universe, and its copies can dock together
    const tag = uidV(), nid = (id) => (id ? `${id}.${tag}` : id);
    const parts = design.parts.map((p) => { const L = layout.get(p.id); return makeSimPart({ ...p, id: nid(p.id), parent: nid(p.parent) }, PARTS[p.type], L.pos, L.quat); });
    assignShells(parts);
    const v = new Vessel(parts);
    v.name = design.name || 'Rocket'; v.uid = uidV();
    v.stages = stageNumbers(parts);
    let minY = Infinity;
    for (const p of parts) for (const c of p.cpts) minY = Math.min(minY, c.y);
    const up = this.siteFixed.clone();
    const east = V().crossVectors(Y_AXIS, up).normalize();
    const south = V().crossVectors(east, up);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, south));
    const origin = up.clone().multiplyScalar(this.planet.R - minY + 0.02);
    v.fix = { r: origin.add(v.com.clone().applyQuaternion(q)), q };
    v.landed = true; v.launched = false;
    v.followGround(this);
    v.sasQ = null;
    // anything still standing on the pad is taken away first
    const pad = this.siteDir();
    const before = this.vessels.length;
    this.vessels = this.vessels.filter((x) => !(x.landed && x.r.clone().normalize().angleTo(pad) * this.planet.R < 80));
    if (this.vessels.length < before) this.events.push({ type: 'info', text: 'The pad was cleared for launch', t: this.t });
    this.vessels.push(v); this.active = v; this.events = this.events.filter((e) => e.text.startsWith('The pad')); this.flags = {};
    return v;
  }
  setActive(v) {
    if (!this.vessels.includes(v)) return;
    this.active = v; this.flags = { space: true, orbit: true };
    v.sasQ = null;
  }

  // ---------- persistence ----------
  serialize() {
    const pl = this.planet, keep = [];
    let debris = 0;
    for (const v of this.vessels) {
      if (!v.parts.length) continue;
      const o = orbitElements(v.r, v.v, pl.mu, pl.R);
      const orbiting = !v.landed && o.e < 1 && o.pe > pl.atmTop;
      const ctl = v.parts.some((p) => p.def.command);
      if (!(orbiting || (v.landed && ctl))) continue;
      if (!ctl && ++debris > 40) continue;
      keep.push(serializeVessel(v));
    }
    return { t: this.t, vessels: keep, craters: this.craters, active: this.active?.uid || null };
  }
  restore(st) {
    if (!st) return;
    this.t = st.t || 0;
    this.vessels = (st.vessels || []).map(restoreVessel).filter(Boolean);
    for (const v of this.vessels) if (v.landed) v.followGround(this);
    this.craters = st.craters || [];
  }
  // jump the clock forward (waiting for the launch hour): every craft coasts along exactly
  advance(dt) {
    if (dt <= 0) return;
    const pl = this.planet;
    this.t += dt;
    for (const v of this.vessels) {
      if (v.landed) { v.followGround(this); continue; }
      if (!keplerStep(v.r, v.v, pl.mu, dt) || v.r.length() - pl.R < pl.atmTop) v.gone = true;
      v.alt = v.r.length() - pl.R;
    }
    this.vessels = this.vessels.filter((v) => !v.gone);
  }
  // local solar hour at the launch site for a sun fixed in space
  hourAt(sunDir) {
    const s = this.siteDir(), ang = (x) => Math.atan2(-x.z, x.x);
    let h = 12 + ((ang(s) - ang(sunDir)) / (2 * Math.PI)) * 24;
    return ((h % 24) + 24) % 24;
  }

  sasDirection(ves, mode, out) {
    const pl = this.planet;
    if (mode === 'target') return out.copy(ves.sasDir).normalize();
    if (mode === 'totarget') return ves.target && this.vessels.includes(ves.target) ? out.copy(ves.target.r).sub(ves.r).normalize() : null;
    if (mode === 'relretro') { if (!ves.target || !this.vessels.includes(ves.target)) return null; out.copy(ves.target.v).sub(ves.v); return out.length() < 0.03 ? null : out.normalize(); }
    const vel = out.copy(ves.v);
    const surface = ves.alt < pl.atmTop * 0.35;
    if (surface) { vel.x -= pl.omega * ves.r.z; vel.z += pl.omega * ves.r.x; }
    if (mode === 'prograde' || mode === 'retrograde') {
      if (vel.length() < 1) return null;
      vel.normalize(); return mode === 'prograde' ? vel : vel.negate();
    }
    if (mode === 'radial' || mode === 'antiradial') { out.copy(ves.r).normalize(); return mode === 'radial' ? out : out.negate(); }
    if (mode === 'normal' || mode === 'antinormal') { out.crossVectors(ves.r, ves.v).normalize(); return mode === 'normal' ? out : out.negate(); }
    return null;
  }

  canRails() {
    const a = this.active;
    if (!a) return true;
    if (a.landed) return true;
    return a.alt > this.planet.atmTop && a.thrust === 0;
  }

  update(dtReal) {
    const a = this.active;
    if (this.warp > 4 && !this.canRails()) { this.warp = a && a.alt < this.planet.atmTop ? Math.min(this.warp, 4) : 1; this.emit('warn', 'Time warp limited: engines firing or inside atmosphere'); }
    // Fixed 10 ms physics steps, as many as the real time since the last frame calls for: the flight runs at the
    // same speed and follows the same path at 20 fps as at 120. Only a long stall (a hidden tab, a hitch) is cut
    // short, and if the computer cannot keep up with the steps at all, the game slows down instead of freezing.
    const dtr = Math.min(dtReal, 0.25);
    if (this.warp <= 4) {
      this.acc += dtr * this.warp;
      const t0 = performance.now();
      let n = 0;
      while (this.acc >= this.h) {
        this.stepPhysics(this.h); this.acc -= this.h; n++;
        if ((n & 7) === 0 && performance.now() - t0 > 40) { this.acc = 0; break; }
      }
    } else {
      let total = dtr * this.warp;
      const hmax = this.warp > 1000 ? 8 : 2;
      while (total > 1e-9) {
        const dt = Math.min(hmax, total); total -= dt;
        this.t += dt;
        for (const v of this.vessels) {
          if (v.landed) { v.followGround(this); continue; }
          v.gravityStep(dt, this.planet.mu);
          v.alt = v.r.length() - this.planet.R;
          if (v.alt < this.planet.atmTop) {
            if (v === this.active) { this.warp = 1; total = 0; this.emit('warn', 'Entering atmosphere: time warp stopped'); } else v.gone = true;
          }
        }
        this.vessels = this.vessels.filter((v) => !v.gone);
      }
    }
    this.checkMilestones();
  }

  stepPhysics(dt) {
    this.t += dt;
    const a = this.active, pl = this.planet;
    for (const v of [...this.vessels]) {
      // far from the active craft: coast on rails (or ride the ground), stepped coarsely
      v.loaded = v === a || !a || v.r.distanceTo(a.r) < this.loadR;
      if (!v.loaded) {
        if (v.landed) { v.followGround(this); continue; }
        v.railAcc = (v.railAcc || 0) + dt;
        if (v.railAcc >= 0.5) { v.gravityStep(v.railAcc, pl.mu); v.railAcc = 0; v.alt = v.r.length() - pl.R; if (v.alt < pl.atmTop && (v.isDebris || v.alt < pl.atmTop * 0.6)) v.gone = true; }
        continue;
      }
      v.railAcc = 0;
      v.step(dt, this);
      if (v.needSplit) { v.needSplit = false; this.split(v, []); }
      if (v.pending.length) this.fireDecouplers(v);
      if (v.jettison.length) this.jettisonFairings(v);
      if (v.destroy.length) this.processDestroyed(v);
    }
    if (this.blasts.length) this.stepBlasts();
    if (a && a.ports?.length) this.checkDocking(a, dt);
    if (this.vessels.length > 1) {
      this.vessels = this.vessels.filter((v) => v === a || (!v.gone && v.parts.length && (!a || !v.isDebris || v.alt > pl.atmTop || v.r.distanceTo(a.r) < 150000)));
      const debris = this.vessels.filter((v) => v !== a && v.isDebris && v.alt < pl.atmTop);
      if (debris.length > 24) { const drop = debris[0]; this.vessels = this.vessels.filter((v) => v !== drop); }
    }
  }

  // ---------- fairings ----------
  // The two halves spring apart on their hinges at the base and fall away as separate pieces.
  jettisonFairings(v) {
    const ids = v.jettison; v.jettison = [];
    for (const id of ids) {
      const b = v.byId.get(id); if (!b || !b.fair || b.fairGone) continue;
      const F = b.fair; b.fairGone = true;
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? 1 : -1;
        // centre of mass of a half shell: up the shell and off to its own side
        const local = V().set(0, F.comY, side * F.R * 0.55);
        const def = { id: `fhalf_${b.id}_${k}`, synthetic: true, shape: 'fhalf', name: 'Fairing half', r: F.R, rTop: F.R * 0.3, len: F.H, mass: Math.max(5, F.mass / 2),
          maxTemp: 2400, crashTol: 10, cdTop: 0.6, cdBottom: 0.9, nodes: { top: false, bottom: false }, radial: false, surface: false, fhalf: { prof: F.prof, k, local: arr(local) } };
        const pos = V(), quat = new THREE.Quaternion();
        const part = makeSimPart({ id: def.id, parent: null, attach: null }, def, pos, quat);
        part.temp = b.temp;
        const nv = new Vessel([part]);
        nv.isDebris = true; nv.hasControl = false; nv.launched = true; nv.name = 'Fairing half'; nv.sas = false; nv.uid = uidV();
        // the half's frame = the base's frame, offset so its centre of mass is the vessel's
        const qB = v.q.clone().multiply(b.quat);
        nv.q.copy(qB);
        const comW = local.clone().applyQuaternion(qB).add(b.pos.clone().sub(v.com).applyQuaternion(v.q)).add(v.r);
        nv.r.copy(comW);
        nv.born = this.t;
        const outW = V().set(0, 0, side).applyQuaternion(qB);
        nv.v.copy(v.v).add(V().crossVectors(V().copy(v.w).applyQuaternion(v.q), comW.clone().sub(v.r))).addScaledVector(outW, 2.2);
        // tip outward about the hinge at the base
        nv.w.set(side * 0.45, 0, 0);
        this.vessels.push(nv);
      }
      this.emit('info', 'Fairing separated', v);
      this.fx.push({ type: 'puff', pos: b.pos.clone().sub(v.com).applyQuaternion(v.q).add(v.r), vel: v.v.clone(), size: b.fair.R, t: this.t });
    }
    v.rebuild();
  }

  // ---------- docking ----------
  checkDocking(a, dt) {
    if ((a.noDockUntil || 0) > this.t) return;
    for (const o of this.vessels) {
      if (o === a || !o.ports?.length || o.r.distanceTo(a.r) > 300 || (o.noDockUntil || 0) > this.t) continue;
      for (const P of a.ports) for (const Q of o.ports) {
        if (P.def.dock.size !== Q.def.dock.size) continue;
        const pW = P.portP.clone().sub(a.com).applyQuaternion(a.q).add(a.r), qW = Q.portP.clone().sub(o.com).applyQuaternion(o.q).add(o.r);
        const nP = P.portN.clone().applyQuaternion(a.q), nQ = Q.portN.clone().applyQuaternion(o.q);
        const sep = qW.clone().sub(pW), dist = sep.length();
        if (dist > 2.5) continue;
        const facing = -nP.dot(nQ);
        // the closing speed of the two faces, including their spin
        const vP = V().crossVectors(V().copy(a.w).applyQuaternion(a.q), pW.clone().sub(a.r)).add(a.v);
        const vQ = V().crossVectors(V().copy(o.w).applyQuaternion(o.q), qW.clone().sub(o.r)).add(o.v);
        const rel = vQ.sub(vP), close = dist > 1e-4 ? -rel.dot(sep) / dist : rel.length();
        // magnetic capture: within a metre and roughly lined up the ports pull gently together
        if (dist < 1.2 && facing > 0.9 && dist > 0.05) {
          const k = 0.12 * dt / Math.max(0.3, dist);
          a.v.addScaledVector(sep, k * o.mass / (a.mass + o.mass)); o.v.addScaledVector(sep, -k * a.mass / (a.mass + o.mass));
        }
        if (dist < 0.32 && facing > Math.cos(0.18) && Math.abs(close) < 0.6) { this.dock(a, P, o, Q); return; }
      }
    }
  }
  dock(A, P, B, Q) {
    // line B up perfectly: turn it so the faces meet head on (keeping its roll), then slide it into place
    const nP = P.portN.clone().applyQuaternion(A.q), nQ = Q.portN.clone().applyQuaternion(B.q);
    const fix = new THREE.Quaternion().setFromUnitVectors(nQ, nP.clone().negate());
    const pW = P.portP.clone().sub(A.com).applyQuaternion(A.q).add(A.r);
    B.q.premultiply(fix);
    const qW = Q.portP.clone().sub(B.com).applyQuaternion(B.q).add(B.r);
    B.r.add(pW.sub(qW));
    // stage numbers of B that have not fired yet come after A's
    const off = Math.max(-1, ...A.stages) + 1, bLeft = new Set(B.stages.slice(B.nextStage));
    for (const p of B.parts) p.stage = p.stage != null && bLeft.has(p.stage) ? p.stage + off : p.stage != null ? -1 : p.stage;
    A.stages = [...A.stages, ...[...bLeft].map((n) => n + off)];
    // B's parts into A's body frame; B's tree re-rooted at its port, which hangs off A's port
    const qAi = A.q.clone().invert(), M = A.mass + B.mass;
    const comW = A.r.clone().multiplyScalar(A.mass).addScaledVector(B.r, B.mass).multiplyScalar(1 / M);
    const vel = A.v.clone().multiplyScalar(A.mass).addScaledVector(B.v, B.mass).multiplyScalar(1 / M);
    for (const p of B.parts) {
      const w = p.pos.clone().sub(B.com).applyQuaternion(B.q).add(B.r);
      const pos = w.sub(A.r).applyQuaternion(qAi).add(A.com);
      const quat = qAi.clone().multiply(B.q).multiply(p.quat);
      placePart(p, pos, quat);
    }
    const byB = new Map(B.parts.map((p) => [p.id, p]));
    let cur = Q, prevId = P.id, prevAttach = { kind: 'dock' };
    while (cur) {
      const nextId = cur.parent, nextAttach = cur.attach;
      cur.parent = prevId; cur.attach = prevAttach;
      if (!nextId) break;
      prevId = cur.id;
      prevAttach = nextAttach?.kind === 'stack' ? { kind: 'stack', node: nextAttach.node === 'top' ? 'bottom' : 'top' } : { kind: 'rev' };
      cur = byB.get(nextId);
    }
    P.docked = Q.id; Q.docked = P.id;
    A.parts = [...A.parts, ...B.parts];
    A.rebuild();
    A.r.copy(comW); A.v.copy(vel);
    A.isDebris = false; A.hasControl = !!A.ctl?.def.command;
    this.vessels = this.vessels.filter((x) => x !== B);
    if (this.active === B) this.active = A;
    A.dockLog = [...(A.dockLog || []), [P.id, Q.id, B.name]];
    this.emit('good', `Docked with ${B.name}`, A);
    this.fx.push({ type: 'dock', t: this.t });
  }
  undock(v) {
    const log = v.dockLog || [];
    let pair = null;
    while (log.length && !pair) { const [a, b, nm] = log.pop(); const P = v.byId.get(a), Q = v.byId.get(b); if (P && Q && P.docked === Q.id) pair = [P, Q, nm]; }
    if (!pair) { const P = v.parts.find((p) => p.docked && v.byId.has(p.docked)); if (P) pair = [P, v.byId.get(P.docked), 'craft']; }
    if (!pair) return false;
    const [P, Q, otherName] = pair;
    if (Q.parent === P.id) Q.parent = null; else if (P.parent === Q.id) P.parent = null; else return false;
    P.docked = null; Q.docked = null;
    // which side leaves: the one without this craft's command part
    const keep = bfs(v.ctlId, adjacency(v.parts));
    const leaver = keep.has(Q.id) ? P : Q;
    const n = leaver.def.dock.radial ? leaver.ax.clone() : leaver.pos.clone().sub((leaver === P ? Q : P).pos).normalize();
    const before = new Set(this.vessels);
    this.split(v, [{ id: leaver.id, dir: n, J: 0.12 * v.mass * 0.5 }], true);
    for (const x of this.vessels) if (!before.has(x)) { x.name = otherName && otherName !== 'craft' ? otherName : x.name; x.noDockUntil = this.t + 5; }
    v.noDockUntil = this.t + 5;
    this.emit('info', 'Undocked', v);
    return true;
  }

  // ---------- launch escape ----------
  abort(v) {
    const les = v.parts.filter((p) => p.def.les && !p.ignited);
    if (!les.length || !v.hasControl) return false;
    for (const p of les) p.ignited = true;
    // fire the first decoupler below the crew
    const prev = bfs(v.ctlId, adjacency(v.parts));
    for (const id of prev.keys()) { const p = v.byId.get(id); if (p.def.decoupler && !p.def.fixed && !p.def.les) { v.pending.push(id); break; } }
    for (const p of v.parts) if (p.def.chute) p.armed = true;
    v.throttle = 0;
    this.emit('bad', 'ABORT: escape motor fired', v);
    return true;
  }
  toggleDeploy(v) {
    const ps = v.parts.filter((p) => p.def.deploy);
    if (!ps.length) return null;
    const out = !ps.some((p) => p.deployT > 0);
    for (const p of ps) p.deployT = out ? 1 : 0;
    return out;
  }

  // ---------- warheads and blasts ----------
  detonate(v, p, impactSpeed) {
    const pl = this.planet, W = p.def.warhead;
    const pos = p.pos.clone().sub(v.com).applyQuaternion(v.q).add(v.r);
    const alt = pos.length() - pl.R, rho = alt < pl.atmTop ? pl.density(alt) : 0, pAmb = pl.pressure(alt);
    let kt = W.kt;
    if (W.kind === 'kinetic') kt = (0.5 * v.mass * impactSpeed * impactSpeed) / 4.184e12;
    kt = Math.max(kt, 1e-6);
    const th = this.theta(), qi2 = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, -th);
    const fixed = pos.clone().applyQuaternion(qi2);
    const gH = pl.terrain ? pl.terrain.groundAt(pos, th) : 0;
    const hob = Math.max(0, alt - gH);
    const Rfb = fireballRadius(kt, W.kind) * (rho > 1e-5 ? 1 : 2.5);
    const b = { fixed, kt, kind: W.kind, t0: this.t, rho: Math.max(rho, 1e-9), pAmb, hob, Rfb, hit: new Set(), vacuum: rho < 1e-5, src: v };
    this.blasts.push(b);
    this.fx.push({ type: 'blast', pos, kt, kind: W.kind, hob, Rfb, vacuum: b.vacuum, rho, t: this.t, fixed });
    const yieldTxt = kt >= 1000 ? `${(kt / 1000).toFixed(kt >= 10000 ? 0 : 1)} Mt` : kt >= 1 ? `${kt.toFixed(kt >= 10 ? 0 : 1)} kt` : `${Math.round(kt * 1e6)} kg TNT`;
    this.emit('bad', `Detonation: ${yieldTxt}${b.vacuum ? ' in vacuum' : hob < Rfb ? ', surface burst' : `, air burst at ${Math.round(hob)} m`}`, null);
    this.lastBlast = { kt, pos, t: this.t };
    // the ground: a crater where the fireball touches it, charring out much farther
    if (!b.vacuum && hob < Rfb * 1.2) {
      const nuke = W.kind === 'fission' || W.kind === 'fusion';
      const rc = (W.kind === 'kinetic' ? 45 : 30) * Math.cbrt(kt) * Math.max(0.15, 1 - hob / (Rfb * 1.2));
      const rs = nuke ? Math.max(rc * 4, Rfb * 2.6) : rc * 5;
      const g = fixed.clone().normalize();
      this.craters.push({ d: [g.x, g.y, g.z], rc, rs, t: this.t });
      if (this.craters.length > 8) this.craters.shift();
    } else if (!b.vacuum && hob < Rfb * 6 && (W.kind === 'fission' || W.kind === 'fusion')) {
      const g = fixed.clone().normalize();
      this.craters.push({ d: [g.x, g.y, g.z], rc: 0, rs: Rfb * 2.2 * (1 - hob / (Rfb * 6)), t: this.t });
      if (this.craters.length > 8) this.craters.shift();
    }
    // the warhead itself and whatever its fireball swallows are gone at once
    p.boom = true;
    v.destroy.push({ id: p.id, why: 'detonated' });
  }
  blastPos(b, out = V()) { return out.copy(b.fixed).applyAxisAngle(Y_AXIS, this.theta()); }
  // Each blast's shock front sweeps outward (Sedov–Taylor early, at least the speed of sound later);
  // a craft is hit once, when the front reaches it: parts whose crush strength is below the overpressure
  // break, and the whole craft gets shoved. In vacuum there is no air to carry a shock: X-rays and neutrons
  // kill out to a fixed range, and the surface layer they flash off kicks the craft.
  stepBlasts() {
    const c = V();
    for (const b of this.blasts) {
      const t = this.t - b.t0, E = b.kt * 4.184e12;
      const R = b.vacuum ? 300 * Math.sqrt(b.kt) * Math.min(1, t * 40) : Math.max(1.03 * Math.pow((E * t * t) / b.rho, 0.2), 340 * t);
      this.blastPos(b, c);
      for (const v of this.vessels) {
        if (b.hit.has(v) || v.born > b.t0) continue;
        const d0 = v.r.distanceTo(c);
        if (d0 - v.boundR > R) continue;
        b.hit.add(v);
        const kg = b.kt * 1e6;
        let worst = 0;
        for (const p of v.parts) {
          const w = p.pos.clone().sub(v.com).applyQuaternion(v.q).add(v.r), d = w.distanceTo(c);
          let dmg;
          if (b.vacuum) dmg = d < R ? 2 : 0;
          else {
            const P = overpressureRatio(d, kg, b.pAmb) * b.pAmb * 101325;
            dmg = d < b.Rfb ? 2 : P / (8000 * p.def.crashTol);
            worst = Math.max(worst, P);
          }
          if (dmg > 1 && !p.boom) {
            if (p.def.warhead && p.whArmed && p.def.warhead.kind !== 'kinetic' && !p.def.nuke) { p.boom = true; this.detonate(v, p, 0); } // sympathetic detonation
            else v.destroy.push({ id: p.id, why: 'blast' });
          }
        }
        const dir = v.r.clone().sub(c); const dl = dir.length() || 1; dir.multiplyScalar(1 / dl);
        let dv;
        if (b.vacuum) dv = Math.min(150, 40 * (R / Math.max(dl, 1)) ** 2);
        else {
          // positive-phase impulse ≈ ½ · peak overpressure · its duration (≈ 0.25 s · kt^⅓), on the craft's side area
          let A = 0; for (const p of v.parts) A += p.sideA + (p.finA || 0) * 0.5 + Math.max(p.expTop, p.expBot) * 0.5;
          dv = Math.min(400, (0.5 * worst * 0.25 * Math.cbrt(b.kt) * A) / v.mass);
        }
        if (dv > 0.05) {
          if (v.landed && dv > 1) { v.landed = false; v.restTime = 0; }
          v.v.addScaledVector(dir, dv);
          v.w.add(V().randomDirection().multiplyScalar(Math.min(2, dv * 0.02)));
        }
        if (v === this.active && worst > 1000) this.emit('bad', `Shock wave: ${(worst / 1000).toFixed(worst > 1e5 ? 0 : 1)} kPa`, v);
        if (v.destroy.length) this.processDestroyed(v);
      }
    }
    this.blasts = this.blasts.filter((b) => this.t - b.t0 < 120);
  }
  detonateArmed(v) {
    let n = 0;
    for (const p of [...v.parts]) if (p.def.warhead && p.whArmed && !p.boom && p.def.warhead.kind !== 'kinetic') { p.boom = true; this.detonate(v, p, 0); n++; }
    if (n) this.processDestroyed(v);
    return n;
  }

  fireDecouplers(v) {
    const impulses = [];
    const prev = bfs(v.ctlId, adjacency(v.parts));
    for (const id of v.pending) {
      const dec = v.byId.get(id); if (!dec) continue;
      const nbId = prev.get(id); if (!nbId) continue;
      const nb = v.byId.get(nbId);
      if (dec.parent === nbId) dec.parent = null; else if (nb.parent === id) nb.parent = null; else continue;
      const dir = dec.def.decoupler === 'radial' ? dec.ax.clone() : dec.pos.clone().sub(nb.pos).normalize();
      impulses.push({ id, dir, J: dec.def.eject || 1000 });
    }
    v.pending = [];
    this.split(v, impulses);
  }

  processDestroyed(v) {
    const seen = new Set();
    for (const d of v.destroy) {
      if (seen.has(d.id)) continue; seen.add(d.id);
      const p = v.byId.get(d.id); if (!p) continue;
      const pos = p.pos.clone().sub(v.com).applyQuaternion(v.q).add(v.r);
      // an armed conventional warhead that breaks up goes off
      if (p.def.warhead && p.whArmed && !p.boom && d.why !== 'detonated') { p.boom = true; this.detonate(v, p, v.v.length()); }
      if (d.why === 'detonated') continue;
      if (d.why === 'ripped') { this.emit('bad', `${p.def.name} ripped off by the airflow`, v); continue; }
      this.fx.push({ type: 'explosion', pos, vel: v.v.clone(), size: Math.max(2, Math.max(p.def.r, 0.4) * 4 + p.def.len), t: this.t });
      const why = { overheated: 'overheated and was destroyed', blast: 'was torn apart by the blast' }[d.why] || 'was destroyed on impact';
      if (d.why !== 'blast' || v === this.active) this.emit('bad', `${p.def.name} ${why}`, v);
    }
    v.destroy = [];
    v.parts = v.parts.filter((p) => !seen.has(p.id));
    if (!v.parts.length) {
      this.vessels = this.vessels.filter((x) => x !== v);
      if (v === this.active) { this.activeLost = true; this.emit('bad', 'Vehicle destroyed.'); }
      v.gone = true;
      return;
    }
    v.landed = false;
    this.split(v, []);
  }

  split(v, impulses, keepCtl) {
    const oldCom = v.com.clone();
    for (const p of v.parts) if (p.parent && !v.parts.some((x) => x.id === p.parent)) p.parent = null;
    const adj = adjacency(v.parts);
    const left = new Set(v.parts.map((p) => p.id));
    const comps = [];
    while (left.size) {
      const start = left.values().next().value;
      const comp = bfs(start, adj);
      const ids = new Set(comp.keys());
      for (const id of ids) left.delete(id);
      comps.push(ids);
    }
    if (comps.length === 1) { v.rebuild(); return; }
    let main = comps.find((c) => c.has(v.ctlId));
    if (!main) main = comps.reduce((a, b) => (a.size >= b.size ? a : b));
    const all = v.parts;
    const pieces = [];
    for (const ids of comps) {
      const ps = all.filter((p) => ids.has(p.id));
      let ves;
      if (ids === main) { ves = v; v.parts = ps; v.rebuild(); }
      else {
        ves = new Vessel(ps);
        const cmd = ps.some((p) => p.def.command);
        ves.isDebris = !cmd; ves.hasControl = cmd; ves.launched = true; ves.uid = uidV();
        ves.name = cmd ? (keepCtl ? `${v.name} (undocked)` : `${v.name} probe`) : `${v.name} debris`;
        ves.q.copy(v.q); ves.w.copy(v.w); ves.throttle = cmd ? 0 : v.throttle; ves.sas = cmd;
        const cur = v.stages[v.nextStage];
        ves.stages = stageNumbers(ps); ves.nextStage = cur == null ? ves.stages.length : Math.max(0, ves.stages.findIndex((n) => n >= cur)); if (ves.nextStage < 0) ves.nextStage = ves.stages.length;
        ves.dockLog = (v.dockLog || []).filter(([a, b]) => ves.byId.has(a) && ves.byId.has(b));
        ves.born = this.t;
        this.vessels.push(ves);
      }
      pieces.push({ ves, ids });
    }
    for (const { ves } of pieces) {
      const off = ves.com.clone().sub(oldCom);
      const dv = V().crossVectors(v.w, off).applyQuaternion(v.q);
      const newR = off.applyQuaternion(v.q).add(v.r);
      if (ves !== v) { ves.v.copy(v.v).add(dv); ves.r.copy(newR); } else { ves._nr = newR; ves._dv = dv; }
    }
    v.r.copy(v._nr); v.v.add(v._dv);
    for (const im of impulses) {
      const piece = pieces.find((x) => x.ids.has(im.id));
      if (!piece || piece.ves === v) continue;
      const dW = im.dir.clone().applyQuaternion(v.q);
      piece.ves.v.addScaledVector(dW, im.J / piece.ves.mass);
      v.v.addScaledVector(dW, -im.J / v.mass);
    }
    if (!v.byId.has(v.ctlId) || !v.ctl?.def.command) { if (v === this.active && !this.flags.noctl) { this.flags.noctl = true; this.emit('bad', 'Command module lost: no control.'); } }
  }

  checkMilestones() {
    const a = this.active; if (!a || a.landed) return;
    const pl = this.planet, f = this.flags;
    if (!f.space && a.alt > pl.spaceLine) { f.space = true; this.emit('good', `You are in space! (above ${Math.round(pl.spaceLine / 1000)} km)`); }
    if (a.alt > pl.atmTop * 0.5) {
      const o = orbitElements(a.r, a.v, pl.mu, pl.R);
      if (!f.orbit && o.e < 1 && o.pe > pl.atmTop) { f.orbit = true; this.emit('great', 'ORBIT ACHIEVED! Periapsis is above the atmosphere.'); }
      if (f.orbit && o.pe < pl.atmTop * 0.6) f.orbit = false;
    }
  }
}
