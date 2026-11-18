// Ready-made example rockets.
import { newDesign, attachSubtree, autoStage } from './rocket.js';

function builder(name) {
  const d = newDesign(name);
  let n = 0;
  const api = {
    d,
    root(type) { const id = `s${n++}`; d.parts.push({ id, type, parent: null, attach: null }); return id; },
    below(parent, type) { return attachSubtree(d, [{ id: 'x', type, parent: null }], parent, { kind: 'stack', node: 'bottom' })[0]; },
    above(parent, type) { return attachSubtree(d, [{ id: 'x', type, parent: null }], parent, { kind: 'stack', node: 'top' })[0]; },
    radial(parent, type, y = 0, sym = 1, ang = 0, extra = {}) { return attachSubtree(d, [{ id: 'x', type, parent: null }], parent, { kind: 'radial', ang, y, ...extra }, sym)[0]; },
    done() { autoStage(d); return d; },
  };
  return api;
}

export function stockRockets() {
  const out = [];
  { // small two-stage rocket sized for the small planet
    const b = builder('Pip');
    const pod = b.root('pod1');
    b.above(pod, 'chute_S');
    const sh = b.below(pod, 'shield_S');
    const dec = b.below(sh, 'dec_S');
    const t2 = b.below(dec, 'tank_S_2');
    const e2 = b.below(t2, 'e_wisp');
    const d1 = b.below(e2, 'dec_S');
    const t1 = b.below(d1, 'tank_S_6');
    b.below(t1, 'e_ember');
    b.radial(t1, 'fin_s', -2.2, 4, Math.PI / 4);
    out.push(b.done());
  }
  { // suborbital hopper
    const b = builder('Sparrow');
    const pod = b.root('pod1');
    b.above(pod, 'chute_S');
    const dec = b.below(pod, 'dec_S');
    const tank = b.below(dec, 'tank_S_4');
    b.below(tank, 'e_ember');
    b.radial(tank, 'fin_s', -1.5, 3);
    out.push(b.done());
  }
  { // two-stage orbital rocket
    const b = builder('Meridian');
    const pod = b.root('pod1');
    b.above(pod, 'chute_S');
    const sh = b.below(pod, 'shield_S');
    const dec = b.below(sh, 'dec_S');
    const ad = b.below(dec, 'adapt_M_S');
    const t2 = b.below(ad, 'tank_M_4');
    const e2 = b.below(t2, 'e_halo');
    const d1 = b.below(e2, 'dec_M');
    const t1a = b.below(d1, 'tank_M_4');
    const t1b = b.below(t1a, 'tank_M_12');
    b.below(t1b, 'e_brute');
    b.radial(t1b, 'fin_m', -4.8, 4, Math.PI / 4);
    out.push(b.done());
  }
  { // heavy lifter with solid boosters
    const b = builder('Castor Heavy');
    const core = b.root('probe2');
    const fb = b.above(core, 'fbase_M');
    b.above(fb, 'cargo_M');
    const t2 = b.below(core, 'tank_M_8');
    const e2 = b.below(t2, 'e_halo');
    const d1 = b.below(e2, 'dec_M');
    const ad = b.below(d1, 'adapt_L_M');
    const t1 = b.below(ad, 'tank_L_14');
    const t1b = b.below(t1, 'tank_L_8');
    b.below(t1b, 'e_colossus');
    const rd = b.radial(t1b, 'rdec_big', 0, 2, 0);
    const srb = b.radial(rd, 'srb_goliath', 3.2, 1);
    b.above(srb, 'nose_M');
    b.radial(t1b, 'fin_m', -3.0, 2, Math.PI / 2);
    out.push(b.done());
  }
  { // telescope launcher: stainless first stage with a Lantern, Halo upper stage
    const b = builder('Halcyon');
    const core = b.root('probe2');
    const fb = b.above(core, 'fbase_M');
    const tel = b.above(fb, 'telescope');
    b.radial(tel, 'panel_d', -1.6, 2, 0);
    const t2 = b.below(core, 'tank_M_8');
    const e2 = b.below(t2, 'e_halo');
    const d1 = b.below(e2, 'dec_M');
    const ad = b.below(d1, 'adapt_L_M');
    const t1 = b.below(ad, 'steel_L_10');
    b.below(t1, 'e_lantern');
    b.radial(t1, 'fin_grid', 4, 4, Math.PI / 4);
    out.push(b.done());
  }
  return out;
}
