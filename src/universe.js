// Universes: separate saved worlds. Each keeps its own clock, sun, every craft still in orbit or landed
// with a command part (stations, satellites, landers), and the scars of whatever was set off in it.
// One per planet size inside each universe. Stored in this browser.
const LIST = 'apogee.universes', PRE = 'apogee.u.';

function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }

export function universes() {
  const o = read(LIST);
  if (o && Array.isArray(o.list) && o.list.length) { if (!o.list.some((u) => u.id === o.current)) o.current = o.list[0].id; return o; }
  const n = { current: 'u1', list: [{ id: 'u1', name: 'Universe 1', created: Date.now() }] };
  write(LIST, n); return n;
}
export function currentUniverse() { const o = universes(); return o.list.find((u) => u.id === o.current); }
export function setCurrentUniverse(id) { const o = universes(); if (o.list.some((u) => u.id === id)) { o.current = id; write(LIST, o); } }
export function createUniverse(name) {
  const o = universes(), id = `u${Date.now().toString(36)}`;
  let n = 1; while (o.list.some((u) => u.name === `Universe ${n}`)) n++;
  o.list.push({ id, name: name || `Universe ${n}`, created: Date.now() }); o.current = id; write(LIST, o);
  return id;
}
export function deleteUniverse(id) {
  const o = universes();
  o.list = o.list.filter((u) => u.id !== id);
  for (const k of ['compact', 'real']) try { localStorage.removeItem(`${PRE}${id}.${k}`); } catch { /* ignore */ }
  if (!o.list.length) { o.list.push({ id: `u${Date.now().toString(36)}`, name: 'Universe 1', created: Date.now() }); }
  if (o.current === id) o.current = o.list[0].id;
  write(LIST, o);
}
export function loadWorld(id, kind) { return read(`${PRE}${id}.${kind}`); }
export function saveWorld(id, kind, state) { return write(`${PRE}${id}.${kind}`, state); }
// a one-line summary for menus
export function worldSummary(id, kind) {
  const s = loadWorld(id, kind);
  if (!s || !s.vessels) return { craft: 0, t: 0 };
  return { craft: s.vessels.filter((v) => !v.isDebris).length, debris: s.vessels.filter((v) => v.isDebris).length, t: s.t || 0, names: s.vessels.filter((v) => !v.isDebris).map((v) => v.name) };
}
