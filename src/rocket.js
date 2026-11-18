// Rocket design model: part tree, layout, symmetry, staging and delta-v analysis.
import * as THREE from '../vendor/three.module.js';
import { PARTS } from './parts.js';

export const G0 = 9.80665;
let uidCounter = 1;
export const uid = () => `p${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

export function newDesign(name = 'Untitled Rocket') {
  return { name, parts: [], manualStaging: false };
}
export const cloneDesign = (d) => JSON.parse(JSON.stringify(d));
export const defOf = (p) => PARTS[p.type];

export function radiusAt(def, y) {
  const t = Math.min(1, Math.max(0, y / def.len + 0.5));
  return def.r + (def.rTop - def.r) * t;
}
const faceX = (def) => (def.boomLen ? def.boomLen / 2 : def.r);
const isDecoupler = (def) => !!def.decoupler && !def.fixed;
export const isDecouplerDef = isDecoupler;

// ---------- enclosures: interstages and payload fairings ----------
// Works on any list of nodes { id, parent, attach, def, pos, quat } (design layout or flight parts).
export function stackNeighbors(nodes) {
  const nb = new Map(nodes.map((n) => [n.id, { top: null, bottom: null }]));
  for (const n of nodes) {
    if (!n.parent || n.attach?.kind !== 'stack' || !nb.has(n.parent)) continue;
    if (n.attach.node === 'top') { nb.get(n.parent).top = n.id; nb.get(n.id).bottom = n.parent; } else { nb.get(n.parent).bottom = n.id; nb.get(n.id).top = n.parent; }
  }
  return nb;
}
// how far a part reaches out from its own centre (for wrapping a fairing round it)
function partReach(def) {
  return Math.max(def.len / 2, def.r, def.rTop, def.fin?.span || 0, def.deploy ? 0.3 : (def.panelLen || 0), def.deploy ? 0 : (def.fanR || 0) * 2,
    def.mast || 0, def.leg ? def.leg.reach + 0.3 : 0, def.boomLen || 0);
}
export const INTERSTAGE_KG_M2 = 15, FAIRING_KG_M2 = 9;
// Interstage: a stack decoupler with an engine standing on it grows a shell up round that engine to the
// stage above (like every real upper stage). The shell stays with the lower stage when it separates.
// Fairing: a fairing base wraps a two-piece shell round everything stacked on top of it.
export function enclosures(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nb = stackNeighbors(nodes);
  const inter = new Map(), fair = new Map();
  for (const n of nodes) {
    const d = n.def;
    if (d.decoupler === 'stack' && !d.fixed && !d.noShroud) {
      const T = byId.get(nb.get(n.id).top);
      if (!T || !T.def.engine || T.def.shape === 'srb' || T.def.radialOnly || T.def.les) continue;
      const U = byId.get(nb.get(T.id).top);
      const rMin = Math.max(T.def.r, T.def.rTop);
      const r0 = Math.max(d.rTop, rMin), r1 = Math.max(U ? U.def.r : r0, rMin * 0.9), h = T.def.len;
      const area = Math.PI * (r0 + r1) * Math.hypot(h, r1 - r0);
      inter.set(n.id, { h, r0, r1, y0: d.len / 2, mass: Math.round(area * INTERSTAGE_KG_M2), engine: T.id });
    }
    if (d.fairingBase) fair.set(n.id, fairingShape(n, nodes, byId, nb));
  }
  return { inter, fair };
}
function fairingShape(B, nodes, byId, nb) {
  const d = B.def, y0 = d.len / 2;
  const inside = [];
  const T = nb.get(B.id).top;
  if (T) {
    const adj = adjacency(nodes);
    const seen = bfs(T, adj, (id) => id === B.id);
    for (const id of seen.keys()) inside.push(id);
  }
  // the payload's outline in the base's frame: widest reach in 10 cm slices
  const qi = B.quat.clone().invert(), STEP = 0.1;
  const env = [];
  const _c = new THREE.Vector3(), _a = new THREE.Vector3();
  for (const id of inside) {
    const P = byId.get(id), pd = P.def;
    _c.copy(P.pos).sub(B.pos).applyQuaternion(qi);
    _a.set(0, 1, 0).applyQuaternion(P.quat).applyQuaternion(qi);
    const vertical = Math.abs(_a.y) > 0.95 && !pd.radialOnly;
    const e = vertical ? Math.max(pd.r, pd.rTop) : partReach(pd), hy = vertical ? pd.len / 2 : partReach(pd);
    const rad = Math.hypot(_c.x, _c.z) + e;
    const i0 = Math.max(0, Math.floor((_c.y - hy - y0) / STEP)), i1 = Math.max(0, Math.ceil((_c.y + hy - y0) / STEP));
    if (vertical && pd.envTop) { // things that stick out above a part (a telescope's open door)
      const j0 = Math.max(0, Math.floor((_c.y + hy - y0) / STEP)), j1 = Math.ceil((_c.y + hy + pd.envTop - y0) / STEP);
      for (let i = j0; i <= j1; i++) env[i] = Math.max(env[i] || 0, Math.hypot(_c.x, _c.z) + pd.envR);
    }
    for (let i = i0; i <= i1; i++) env[i] = Math.max(env[i] || 0, rad);
  }
  const margin = 0.1 + d.r * 0.03;
  const req = (i) => (env[i] ? env[i] + margin : 0);
  let maxReq = 0, topI = -1;
  for (let i = 0; i < env.length; i++) if (env[i]) { maxReq = Math.max(maxReq, req(i)); topI = i; }
  const R = Math.max(d.r, maxReq), K = 0.85;                 // boat-tail slope where the payload is wider than the base
  const cylMin = (R - d.r) / K;                               // height needed to flare out to full width
  const Ln = Math.max(1.0, R * 1.7);                          // ogive nose length
  const nose = (t) => Math.pow(Math.max(0, 1 - Math.pow(t, 1.9)), 0.75);
  // lowest nose start that still clears every slice of the payload
  let yn = Math.max(cylMin, 0);
  for (let guard = 0; guard < 4000; guard++) {
    let ok = (topI + 1) * STEP < yn + Ln * 0.94;
    for (let i = Math.floor(yn / STEP); ok && i <= topI; i++) { const t = (i * STEP - yn) / Ln; if (t > 0 && req(i) > R * nose(t)) ok = false; }
    if (ok) break;
    yn += STEP;
  }
  // profile, bottom to tip, in the base's own frame
  const prof = [[d.r, y0]];
  let pref = 0;
  const nC = Math.max(1, Math.round(yn / 0.25));
  for (let k = 1; k <= nC; k++) {
    const y = (yn * k) / nC;
    for (let i = Math.floor(((yn * (k - 1)) / nC) / STEP); i <= Math.floor(y / STEP); i++) pref = Math.max(pref, req(i));
    prof.push([Math.min(R, Math.max(d.r + y * K, pref)), y0 + y]);
  }
  for (let k = 1; k <= 22; k++) { const t = k / 22; prof.push([R * nose(t), y0 + yn + Ln * t]); }
  let area = 0;
  for (let k = 1; k < prof.length; k++) { const [ra, ya] = prof[k - 1], [rb, yb] = prof[k]; area += Math.PI * (ra + rb) * Math.hypot(rb - ra, yb - ya); }
  const H = yn + Ln;
  return { prof, R, H, y0, yn, area, mass: Math.round(area * FAIRING_KG_M2), inside, comY: y0 + H * 0.42 };
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

// Compute rocket-frame transforms for a list of parts (parents must precede children).
// Parts whose parent is null (or missing) are placed at rootPos/rootQuat.
export function computeLayout(parts, rootPos = new THREE.Vector3(), rootQuat = new THREE.Quaternion()) {
  const map = new Map();
  for (const p of parts) {
    const def = PARTS[p.type];
    const par = p.parent ? map.get(p.parent) : null;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
    if (!par) {
      pos.copy(rootPos); quat.copy(rootQuat);
    } else if (p.attach.kind === 'stack') {
      const s = p.attach.node === 'top' ? 1 : -1;
      _v.set(0, s * (par.def.len / 2 + def.len / 2), 0).applyQuaternion(par.quat);
      pos.copy(par.pos).add(_v); quat.copy(par.quat);
    } else {
      const a = p.attach;
      const off = def.radialOff ?? def.r;
      if (par.def.outerFace) {
        _v.set(faceX(par.def) + off, a.y || 0, 0);
        quat.copy(par.quat);
      } else {
        const rr = radiusAt(par.def, a.y || 0) + off;
        _v.set(Math.cos(a.ang) * rr, a.y || 0, Math.sin(a.ang) * rr);
        _q.setFromEuler(_e.set(0, -a.ang, 0));
        quat.copy(par.quat).multiply(_q);
      }
      pos.copy(par.pos).add(_v.applyQuaternion(par.quat));
      if (a.tx) quat.multiply(_q.setFromEuler(_e.set(a.tx, 0, 0)));
      if (a.tz) quat.multiply(_q.setFromEuler(_e.set(0, 0, a.tz)));
    }
    map.set(p.id, { pos, quat, def, part: p });
  }
  return map;
}

export function nodeUsed(parts, part, node) {
  if (part.parent && part.attach.kind === 'stack' && part.attach.node !== node) return true;
  return parts.some((c) => c.parent === part.id && c.attach.kind === 'stack' && c.attach.node === node);
}

export function subtreeIds(parts, rootId) {
  const ids = new Set([rootId]);
  for (const p of parts) if (p.parent && ids.has(p.parent)) ids.add(p.id);
  return ids;
}
export function counterparts(parts, part) {
  return part.symId ? parts.filter((p) => p.symId === part.symId) : [part];
}

// Attach a subtree (array, root first, root.parent == null) onto parentId. Returns ids of new root copies.
export function attachSubtree(design, sub, parentId, attach, sym = 1) {
  const parent = design.parts.find((p) => p.id === parentId);
  const targets = counterparts(design.parts, parent);
  const n = attach.kind === 'radial' && !PARTS[parent.type].outerFace ? sym : 1;
  const copies = targets.length * n;
  const symMap = new Map();
  const rootSym = copies > 1 ? uid() : null;
  const roots = [];
  for (const tgt of targets) {
    for (let j = 0; j < n; j++) {
      const idMap = new Map();
      sub.forEach((sp, k) => {
        const np = JSON.parse(JSON.stringify(sp));
        np.id = uid(); idMap.set(sp.id, np.id);
        if (k === 0) {
          np.parent = tgt.id;
          np.attach = { ...attach };
          if (attach.kind === 'radial') np.attach.ang = (attach.ang || 0) + (j * 2 * Math.PI) / n;
          np.symId = rootSym;
          roots.push(np.id);
        } else {
          np.parent = idMap.get(sp.parent);
          if (copies > 1) {
            const key = sp.symId || `i${k}`;
            if (!symMap.has(key)) symMap.set(key, uid());
            np.symId = symMap.get(key);
          }
        }
        design.parts.push(np);
      });
    }
  }
  return roots;
}

// Remove a part (with its symmetric counterparts and all their children). Returns the picked subtree.
export function detachSubtree(design, partId) {
  const part = design.parts.find((p) => p.id === partId);
  if (!part) return null;
  const keepIds = subtreeIds(design.parts, partId);
  const sub = design.parts.filter((p) => keepIds.has(p.id)).map((p) => JSON.parse(JSON.stringify(p)));
  const kill = new Set();
  for (const c of counterparts(design.parts, part)) for (const id of subtreeIds(design.parts, c.id)) kill.add(id);
  design.parts = design.parts.filter((p) => !kill.has(p.id));
  sub[0].parent = null; sub[0].attach = null; sub[0].symId = null;
  // internal symmetry groups that no longer have >1 member are cleared
  const count = {};
  for (const p of sub) if (p.symId) count[p.symId] = (count[p.symId] || 0) + 1;
  for (const p of sub) if (p.symId && count[p.symId] < 2) p.symId = null;
  return sub;
}
export function copySubtree(design, partId) {
  const ids = subtreeIds(design.parts, partId);
  const sub = design.parts.filter((p) => ids.has(p.id)).map((p) => JSON.parse(JSON.stringify(p)));
  sub[0].parent = null; sub[0].attach = null; sub[0].symId = null;
  return sub;
}

// ---------- graph helpers (work on any nodes with {id,parent}) ----------
export function adjacency(nodes) {
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, []);
  for (const n of nodes) if (n.parent && adj.has(n.parent)) { adj.get(n.id).push(n.parent); adj.get(n.parent).push(n.id); }
  return adj;
}
// BFS from start; returns Map id -> previous id (start maps to null). block(id) nodes are not entered.
export function bfs(start, adj, block) {
  const prev = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of adj.get(cur) || []) {
      if (prev.has(nb) || (block && block(nb))) continue;
      prev.set(nb, cur); queue.push(nb);
    }
  }
  return prev;
}
export function controlPart(nodes, getDef) {
  return nodes.find((n) => getDef(n).command) || nodes[0];
}
// Assign fuel group index to each node: connected regions bounded by decouplers.
export function fuelGroups(nodes, getDef) {
  const adj = adjacency(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const group = new Map();
  let g = 0;
  for (const n of nodes) {
    if (group.has(n.id) || isDecoupler(getDef(n))) continue;
    const comp = bfs(n.id, adj, (id) => isDecoupler(getDef(byId.get(id))));
    for (const id of comp.keys()) group.set(id, g);
    g++;
  }
  return group;
}

// ---------- staging ----------
export function isStageable(def) { return !!def.engine || isDecoupler(def) || !!def.chute || !!def.fairingBase || !!def.warhead; }

export function autoStage(design) {
  const parts = design.parts;
  for (const p of parts) delete p.stage;
  if (!parts.length) return;
  const byId = new Map(parts.map((p) => [p.id, p]));
  const ctl = controlPart(parts, defOf);
  const prev = bfs(ctl.id, adjacency(parts));
  const depth = new Map();
  for (const id of prev.keys()) {
    const pv = prev.get(id);
    depth.set(id, (pv ? depth.get(pv) : 0) + (isDecoupler(defOf(byId.get(id))) ? 1 : 0));
  }
  let maxD = 0;
  for (const d of depth.values()) maxD = Math.max(maxD, d);
  const isLes = (p) => !!defOf(p).les;
  const eng = (d) => parts.filter((p) => defOf(p).engine && !isLes(p) && depth.get(p.id) === d);
  const dec = (d) => parts.filter((p) => isDecoupler(defOf(p)) && !isLes(p) && depth.get(p.id) === d);
  const groups = [];
  let engGroup = eng(maxD);
  groups.push(engGroup);
  for (let k = maxD; k >= 1; k--) {
    const decs = dec(k), lower = eng(k - 1);
    if (decs.length && decs.every((p) => defOf(p).decoupler === 'radial')) {
      engGroup.push(...lower);
      groups.push(decs);
    } else {
      engGroup = [...decs, ...lower];
      groups.push(engGroup);
    }
  }
  // payload fairings open once their stage is burning (above the thick air); the escape tower leaves
  // right after the first stage is gone; warheads arm last
  const fairs = parts.filter((p) => defOf(p).fairingBase);
  for (const f of fairs) {
    const d = depth.get(f.id);
    let at = groups.findIndex((g) => g.some((p) => defOf(p).engine && !isLes(p) && depth.get(p.id) === d));
    if (at < 0) at = Math.max(0, groups.findIndex((g) => g.some((p) => isDecoupler(defOf(p)) && depth.get(p.id) === d)) - 1);
    if (at < 0) at = groups.length - 1;
    const ex = groups[at + 1];
    if (ex && ex.every((p) => defOf(p).fairingBase)) ex.push(f); else groups.splice(at + 1, 0, [f]);
  }
  const les = parts.filter(isLes);
  if (les.length) groups.splice(Math.min(groups.length, 2), 0, les);
  const chutes = parts.filter((p) => defOf(p).chute);
  if (chutes.length) groups.push(chutes);
  const wh = parts.filter((p) => defOf(p).warhead);
  if (wh.length) groups.push(wh);
  let i = 0;
  for (const g of groups) { if (!g.length) continue; for (const p of g) p.stage = i; i++; }
}

export function stageNumbers(parts) {
  return [...new Set(parts.filter((p) => p.stage != null).map((p) => p.stage))].sort((a, b) => a - b);
}
export function normalizeStages(design) {
  const nums = stageNumbers(design.parts);
  for (const p of design.parts) {
    if (isStageable(defOf(p))) { if (p.stage == null) p.stage = nums.length ? nums[nums.length - 1] : 0; } else delete p.stage;
  }
  const n2 = stageNumbers(design.parts);
  for (const p of design.parts) if (p.stage != null) p.stage = n2.indexOf(p.stage);
}

// ---------- analysis ----------
export function analyze(design, g = G0) {
  const out = { mass: 0, dry: 0, count: design.parts.length, height: 0, stages: [], totalDv: 0, warnings: [], comY: 0, minY: 0, maxY: 0 };
  if (!design.parts.length) return out;
  const layout = computeLayout(design.parts);
  const encl = enclosures(design.parts.map((p) => { const L = layout.get(p.id); return { id: p.id, parent: p.parent, attach: p.attach, def: L.def, pos: L.pos, quat: L.quat }; }));
  let minY = Infinity, maxY = -Infinity, my = 0;
  const st = design.parts.map((p) => {
    const def = defOf(p);
    const L = layout.get(p.id);
    const ext = Math.max(def.len / 2, def.r);
    minY = Math.min(minY, L.pos.y - ext); maxY = Math.max(maxY, L.pos.y + ext);
    const fuel = (def.fuel?.liquid || 0) + (def.fuel?.solid || 0);
    const shell = (encl.inter.get(p.id)?.mass || 0) + (encl.fair.get(p.id)?.mass || 0);
    const fs = encl.fair.get(p.id);
    if (fs) maxY = Math.max(maxY, L.pos.y + fs.y0 + fs.H);
    const m = def.mass + fuel + (def.fuel?.mono || 0) + shell;
    out.mass += m; out.dry += def.mass + shell; my += m * L.pos.y;
    return { id: p.id, def, parent: p.parent, stage: p.stage, fuel, mono: def.fuel?.mono || 0, shell, alive: true, ignited: false, out: false };
  });
  out.height = maxY - minY; out.minY = minY; out.maxY = maxY; out.comY = my / out.mass;
  const getDef = (n) => n.def;
  const byId = new Map(st.map((n) => [n.id, n]));
  const ctl = controlPart(st, getDef);
  if (!ctl.def.command) out.warnings.push('No command module or probe core: the rocket cannot be steered.');
  if (!st.some((n) => n.def.engine)) out.warnings.push('No engines.');
  const alive = () => st.filter((n) => n.alive);
  const mass = () => alive().reduce((s, n) => s + n.def.mass + n.fuel + n.mono + n.shell, 0);
  let groups = fuelGroups(st, getDef);
  const stages = stageNumbers(st);
  const fire = (num) => {
    for (const n of alive()) {
      if (n.stage !== num) continue;
      if (n.def.engine && !n.def.les) n.ignited = true;
      if (n.def.fairingBase) n.shell = 0;
      if (isDecoupler(n.def)) {
        const prev = bfs(ctl.id, adjacency(alive()));
        const nb = prev.get(n.id);
        if (nb === undefined) continue;
        if (n.parent === nb) n.parent = null; else if (nb && byId.get(nb).parent === n.id) byId.get(nb).parent = null;
        const keep = bfs(ctl.id, adjacency(alive()));
        for (const m of st) if (!keep.has(m.id)) m.alive = false;
      }
    }
    groups = fuelGroups(alive(), getDef);
  };
  stages.forEach((num, si) => {
    fire(num);
    const entry = { stage: num, dv: 0, burn: 0, twr: null, mass0: mass(), thrust: 0 };
    for (let guard = 0; guard < 200; guard++) {
      const act = alive().filter((n) => n.def.engine && n.ignited && !n.out);
      if (!act.length) break;
      const pools = new Map();
      for (const e of act) {
        const E = e.def.engine;
        const key = E.fuelType === 'solid' ? `s${e.id}` : `g${groups.get(e.id)}`;
        if (!pools.has(key)) {
          const tanks = E.fuelType === 'solid' ? [e] : alive().filter((n) => groups.get(n.id) === groups.get(e.id) && n.def.fuel?.liquid);
          pools.set(key, { tanks, mdot: 0, engines: [] });
        }
        const pool = pools.get(key);
        pool.mdot += E.thrust / (E.ispVac * G0); pool.engines.push(e);
      }
      let removed = false;
      for (const pool of pools.values()) {
        pool.fuel = pool.tanks.reduce((s, n) => s + n.fuel, 0);
        if (pool.fuel <= 1e-6) { pool.engines.forEach((e) => (e.out = true)); removed = true; }
      }
      if (removed) continue;
      let F = 0, Fsl = 0, md = 0, dt = Infinity;
      for (const pool of pools.values()) {
        md += pool.mdot; dt = Math.min(dt, pool.fuel / pool.mdot);
        for (const e of pool.engines) { F += e.def.engine.thrust; Fsl += e.def.engine.thrust * e.def.engine.ispSl / e.def.engine.ispVac; }
      }
      const m0 = mass();
      if (entry.twr == null) { entry.thrust = si === 0 ? Fsl : F; entry.twr = entry.thrust / (m0 * g); entry.mass0 = m0; }
      const m1 = m0 - md * dt;
      entry.dv += (F / md) * Math.log(m0 / m1); entry.burn += dt;
      let depleted = false;
      for (const pool of pools.values()) {
        const use = pool.mdot * dt, f = Math.max(0, 1 - use / pool.fuel);
        for (const t of pool.tanks) t.fuel *= f;
        if (f < 1e-9) { pool.engines.forEach((e) => (e.out = true)); depleted = true; }
      }
      if (depleted && si < stages.length - 1) break;
    }
    out.stages.push(entry); out.totalDv += entry.dv;
  });
  const first = out.stages.find((s) => s.twr != null);
  if (first && first.twr < 1) out.warnings.push('Liftoff thrust-to-weight is below 1: it will not leave the pad.');
  return out;
}
