// Part catalog. All units SI (m, kg, N, s, K). Pure data, no rendering.
// Every part's local frame: +Y is "up" along the rocket axis, centred on the part.
// Radially attached parts additionally use +X as "outward from the parent".

export const SIZES = [
  { key: 'XS', r: 0.3125, label: '0.6 m' },
  { key: 'S', r: 0.625, label: '1.25 m' },
  { key: 'M', r: 1.25, label: '2.5 m' },
  { key: 'L', r: 1.875, label: '3.75 m' },
  { key: 'XL', r: 2.5, label: '5 m' },
];

export const CATEGORIES = [
  { id: 'command', name: 'Command' },
  { id: 'tanks', name: 'Fuel Tanks' },
  { id: 'engines', name: 'Engines' },
  { id: 'boosters', name: 'Solid Boosters' },
  { id: 'coupling', name: 'Decouplers' },
  { id: 'aero', name: 'Aerodynamics' },
  { id: 'control', name: 'Control' },
  { id: 'recovery', name: 'Recovery' },
  { id: 'structure', name: 'Structure' },
  { id: 'payload', name: 'Payload' },
  { id: 'station', name: 'Docking & Station' },
  { id: 'warheads', name: 'Warheads' },
  { id: 'lights', name: 'Lights' },
];

const P = [];
const add = (d) => {
  P.push({
    rTop: d.r, maxTemp: 1500, crashTol: 7, cdTop: 0.85, cdBottom: 0.85,
    nodes: { top: true, bottom: true }, radial: true, surface: true, ...d,
  });
};

// ---------- Command ----------
add({ id: 'pod1', name: 'Pioneer Capsule', cat: 'command', shape: 'capsule', r: 0.625, rTop: 0.3, len: 1.15,
  mass: 840, command: true, crew: 1, wheel: 5000, maxTemp: 1800, crashTol: 14, cdTop: 0.35,
  desc: 'One-seat crew capsule with built-in reaction wheels.' });
add({ id: 'pod3', name: 'Trident Capsule', cat: 'command', shape: 'capsule', r: 1.25, rTop: 0.625, len: 1.9,
  mass: 2700, command: true, crew: 3, wheel: 15000, maxTemp: 1800, crashTol: 14, cdTop: 0.35,
  desc: 'Three-seat capsule for 2.5 m stacks.' });
add({ id: 'pod5', name: 'Atlas Crew Module', cat: 'command', shape: 'capsule', r: 1.875, rTop: 1.25, len: 2.4,
  mass: 5200, command: true, crew: 6, wheel: 30000, maxTemp: 1800, crashTol: 12, cdTop: 0.4,
  desc: 'Six-seat crew module for 3.75 m stacks.' });
add({ id: 'probe0', name: 'Mote Probe Core', cat: 'command', shape: 'probe', r: 0.3125, len: 0.25,
  mass: 45, command: true, wheel: 300, maxTemp: 1400, crashTol: 9,
  desc: 'Tiny unmanned guidance core.' });
add({ id: 'probe1', name: 'Sentinel Probe Core', cat: 'command', shape: 'probe', r: 0.625, len: 0.35,
  mass: 110, command: true, wheel: 1500, maxTemp: 1400, crashTol: 9,
  desc: 'Unmanned guidance core for 1.25 m stacks.' });
add({ id: 'probe2', name: 'Guidance Ring M', cat: 'command', shape: 'probe', r: 1.25, len: 0.4,
  mass: 380, command: true, wheel: 8000, maxTemp: 1400, crashTol: 9,
  desc: 'Avionics ring for 2.5 m rockets.' });
add({ id: 'probe3', name: 'Guidance Ring L', cat: 'command', shape: 'probe', r: 1.875, len: 0.45,
  mass: 700, command: true, wheel: 20000, maxTemp: 1400, crashTol: 9,
  desc: 'Avionics ring for 3.75 m rockets.' });

// ---------- Fuel tanks ----------
const tankLens = { XS: [0.5, 1, 2], S: [1, 2, 4, 6], M: [2, 4, 8, 12], L: [4, 8, 14], XL: [5, 10, 18] };
for (const s of SIZES) {
  for (const L of tankLens[s.key]) {
    const prop = Math.round(Math.PI * s.r * s.r * L * 0.92 * 1000 / 10) * 10;
    add({ id: `tank_${s.key}_${L}`, name: `${s.key}-${L} Tank`, cat: 'tanks', shape: 'tank', r: s.r, len: L,
      mass: Math.round(prop * 0.068), fuel: { liquid: prop }, size: s.key,
      desc: `${s.label} liquid propellant tank, ${L} m long.` });
  }
}
// Stainless tanks: heavier, but shrug off heat
for (const [k, L] of [['L', 10], ['XL', 12]]) {
  const s = SIZES.find((x) => x.key === k), prop = Math.round(Math.PI * s.r * s.r * L * 0.92 * 1000 / 10) * 10;
  add({ id: `steel_${k}_${L}`, name: `Steel Tank ${k}-${L}`, cat: 'tanks', shape: 'steeltank', r: s.r, len: L, mass: Math.round(prop * 0.11),
    fuel: { liquid: prop }, size: k, maxTemp: 2000, crashTol: 10, desc: `${s.label} stainless-steel tank. Heavier than aluminium, much tougher in heat.` });
}
// Spherical tanks in a frame
for (const [k, L] of [['S', 1.25], ['M', 2.5]]) {
  const s = SIZES.find((x) => x.key === k), rs = s.r * 0.9, prop = Math.round((4 / 3) * Math.PI * rs ** 3 * 0.92 * 1000 / 10) * 10;
  add({ id: `sphtank_${k}`, name: `Sphere Tank ${k}`, cat: 'tanks', shape: 'spheretank', r: s.r, len: L, mass: Math.round(prop * 0.075),
    fuel: { liquid: prop }, cdTop: 0.6, cdBottom: 0.6, desc: `Light spherical tank in an open ${s.label} frame. Great for landers.` });
}
// Tapered adapter tanks
const adapters = [['S', 'XS', 0.8], ['M', 'S', 1.6], ['L', 'M', 2.0], ['XL', 'L', 2.2]];
for (const [a, b, L] of adapters) {
  const ra = SIZES.find((s) => s.key === a).r, rb = SIZES.find((s) => s.key === b).r;
  const vol = Math.PI * L / 3 * (ra * ra + ra * rb + rb * rb);
  const prop = Math.round(vol * 0.85 * 1000 / 10) * 10;
  add({ id: `adtank_${a}_${b}`, name: `${a}→${b} Adapter Tank`, cat: 'tanks', shape: 'tank', r: ra, rTop: rb, len: L,
    mass: Math.round(prop * 0.08), fuel: { liquid: prop }, cdTop: 0.3,
    desc: `Tapered tank joining ${a} and ${b} stacks.` });
}

// ---------- Liquid engines ----------
// engine.chem: 0 kerosene (gold-orange flame), 1 methane (blue-violet, like Raptor), 2 hydrogen (blue-white)
const eng = (d) => add({ cat: 'engines', shape: 'engine', maxTemp: 2200, crashTol: 7, cdBottom: 0.6, ...d,
  engine: { fuelType: 'liquid', throttle: true, gimbal: 3, ...d.engine } });
eng({ id: 'e_spark', name: 'Spark', r: 0.3125, len: 0.6, mass: 90, engine: { thrust: 22e3, ispVac: 305, ispSl: 265, gimbal: 5 },
  desc: 'Small 0.6 m engine for sounding rockets and probes.' });
eng({ id: 'e_gnat', name: 'Gnat Vacuum', r: 0.3125, len: 0.7, mass: 60, engine: { chem: 2, thrust: 8e3, ispVac: 335, ispSl: 90, gimbal: 4 },
  desc: 'Tiny efficient vacuum engine.' });
eng({ id: 'e_ember', name: 'Ember', r: 0.625, len: 1.3, mass: 520, engine: { thrust: 260e3, ispVac: 310, ispSl: 278, gimbal: 4 },
  desc: 'Workhorse 1.25 m first-stage engine.' });
eng({ id: 'e_swift', name: 'Swift', r: 0.625, len: 1.1, mass: 320, engine: { thrust: 110e3, ispVac: 330, ispSl: 260, gimbal: 6 },
  desc: 'Agile 1.25 m sustainer with wide gimbal.' });
eng({ id: 'e_wisp', name: 'Wisp Vacuum', r: 0.625, len: 1.5, mass: 190, engine: { chem: 2, thrust: 62e3, ispVac: 352, ispSl: 95, gimbal: 3 },
  desc: '1.25 m upper-stage engine. Very weak at sea level.' });
eng({ id: 'e_brute', name: 'Brute', r: 1.25, len: 2.4, mass: 2300, engine: { thrust: 1650e3, ispVac: 308, ispSl: 282, gimbal: 3 },
  desc: 'Heavy 2.5 m booster engine.' });
eng({ id: 'e_vector', name: 'Vector', r: 1.25, len: 2.1, mass: 1450, engine: { thrust: 940e3, ispVac: 322, ispSl: 286, gimbal: 7 },
  desc: '2.5 m sustainer with strong gimbal authority.' });
eng({ id: 'e_halo', name: 'Halo Vacuum', r: 1.25, len: 2.6, mass: 640, engine: { chem: 2, thrust: 260e3, ispVac: 385, ispSl: 120, gimbal: 4 },
  desc: 'High-efficiency 2.5 m upper-stage engine.' });
eng({ id: 'e_colossus', name: 'Colossus', r: 1.875, len: 3.2, mass: 5600, engine: { chem: 1, thrust: 4200e3, ispVac: 310, ispSl: 285, gimbal: 3 },
  desc: 'Monster 3.75 m first-stage engine.' });
eng({ id: 'e_aurora', name: 'Aurora Vacuum', r: 1.875, len: 3.4, mass: 1900, engine: { chem: 2, thrust: 850e3, ispVac: 392, ispSl: 130, gimbal: 3 },
  desc: '3.75 m vacuum engine for heavy upper stages.' });
eng({ id: 'e_leviathan', name: 'Leviathan Cluster', r: 2.5, len: 3.6, mass: 12500, engine: { chem: 1, thrust: 9800e3, ispVac: 306, ispSl: 283, gimbal: 3 },
  desc: 'Five-chamber 5 m engine cluster. Lifts almost anything.' });
eng({ id: 'e_spire', name: 'Spire Aerospike', shape: 'aerospike', r: 0.625, len: 1.0, mass: 650, engine: { chem: 1, thrust: 180e3, ispVac: 345, ispSl: 318, gimbal: 2 },
  desc: 'Ring of small chambers firing along a central spike. Efficient at every altitude.' });
eng({ id: 'e_trio', name: 'Trio Cluster', r: 1.25, len: 2.0, mass: 1900, engine: { thrust: 1100e3, ispVac: 312, ispSl: 284, gimbal: 5 },
  desc: 'Three 1.25 m chambers on one thrust plate. Robust 2.5 m first stage.' });
eng({ id: 'e_lantern', name: 'Lantern', r: 1.875, len: 3.0, mass: 3800, engine: { chem: 1, thrust: 2600e3, ispVac: 334, ispSl: 305, gimbal: 5 },
  desc: 'Modern full-flow methane engine: efficient and powerful for 3.75 m stages.' });
eng({ id: 'e_atom', name: 'Atom Nuclear-Thermal', shape: 'ntr', r: 1.25, len: 4.6, mass: 9000, maxTemp: 2600,
  engine: { chem: 2, thrust: 250e3, ispVac: 841, ispSl: 380, gimbal: 2 },
  desc: 'A reactor heats hydrogen to 2,500 K and blows it out of a nozzle: twice the efficiency of any chemical engine, but heavy and weak. For long burns in space.' });
eng({ id: 'e_tick', name: 'Tick Radial Engine', shape: 'rengine', r: 0.22, len: 0.7, mass: 70, radialOnly: true, radialOff: 0.22,
  nodes: { top: false, bottom: false }, engine: { thrust: 28e3, ispVac: 300, ispSl: 255, gimbal: 0 },
  desc: 'Small surface-mounted engine. Mount in symmetry.' });

// ---------- Solid boosters ----------
const srb = (d) => add({ cat: 'boosters', shape: 'srb', maxTemp: 2000, crashTol: 8, cdBottom: 0.6, ...d,
  engine: { fuelType: 'solid', throttle: false, gimbal: 0, ispVac: 262, ispSl: 235, ...d.engine } });
srb({ id: 'srb_fire', name: 'Firecracker', r: 0.3125, len: 2, mass: 110, fuel: { solid: 480 }, engine: { thrust: 34e3 },
  desc: 'Tiny solid motor. Cannot be throttled or shut down.' });
srb({ id: 'srb_hammer', name: 'Hammer', r: 0.625, len: 5, mass: 950, fuel: { solid: 5600 }, engine: { thrust: 340e3 },
  desc: '1.25 m solid booster. Burns ~42 s.' });
srb({ id: 'srb_mauler', name: 'Mauler', r: 0.625, len: 10, mass: 1800, fuel: { solid: 11400 }, engine: { thrust: 560e3 },
  desc: 'Long 1.25 m solid booster. Burns ~52 s.' });
srb({ id: 'srb_goliath', name: 'Goliath', r: 1.25, len: 15, mass: 8200, fuel: { solid: 62000 }, engine: { thrust: 2600e3, ispVac: 270, ispSl: 242 },
  desc: 'Huge 2.5 m segmented booster. Burns ~63 s.' });
srb({ id: 'srb_sep', name: 'Sepratron', r: 0.11, len: 0.6, mass: 12, fuel: { solid: 9 }, engine: { thrust: 18e3, ispVac: 200, ispSl: 180 },
  radialOnly: true, radialOff: 0.11, nodes: { top: false, bottom: false }, desc: 'Tiny separation motor (1 s burn).' });

// Launch escape towers: a solid motor on a truss above the capsule. Backspace (abort) fires it and the
// decoupler under the capsule together, pulling the crew clear of a failing rocket. Staged normally,
// it fires and leaves on its own once the first stage is gone.
for (const [id, nm, r, len, mass, F, prop] of [['les_S', 'Escape Tower S', 0.3, 3.2, 210, 70e3, 70], ['les_M', 'Escape Tower M', 0.6, 5.2, 900, 260e3, 260]]) {
  add({ id, name: nm, cat: 'recovery', shape: 'les', r, rTop: r * 0.3, len, mass, les: true, decoupler: 'stack', eject: 400, noShroud: true,
    nodes: { top: false, bottom: true }, radial: false, cdTop: 0.2, maxTemp: 2400, crashTol: 9, fuel: { solid: prop },
    engine: { fuelType: 'solid', throttle: false, gimbal: 0, thrust: F, ispVac: 225, ispSl: 205, nozzleY: 0.18 },
    desc: 'Launch escape tower. Backspace aborts: it fires and pulls the capsule away from the rocket. Otherwise it drops off after the first stage.' });
}

// ---------- Decouplers ----------
for (const s of SIZES) {
  add({ id: `dec_${s.key}`, name: `Stack Decoupler ${s.key}`, cat: 'coupling', shape: 'decoupler', r: s.r, len: 0.22,
    mass: Math.round(60 * s.r * s.r * 4), decoupler: 'stack', eject: 900 * s.r * s.r * 4, radial: false,
    desc: `${s.label} stack decoupler. Splits the rocket when staged. With an engine standing on it, it grows an interstage shell up round that engine, which drops away with the spent stage.` });
}
add({ id: 'rdec', name: 'Radial Decoupler', cat: 'coupling', shape: 'rdecoupler', r: 0.12, len: 0.9, mass: 45,
  decoupler: 'radial', eject: 2500, radialOnly: true, radialOff: 0.12, outerFace: true, nodes: { top: false, bottom: false },
  desc: 'Mounts boosters to the side of a stack and jettisons them when staged.' });
add({ id: 'rdec_big', name: 'Heavy Radial Decoupler', cat: 'coupling', shape: 'rdecoupler', r: 0.2, len: 2.2, mass: 180,
  decoupler: 'radial', eject: 12000, radialOnly: true, radialOff: 0.2, outerFace: true, nodes: { top: false, bottom: false },
  desc: 'Radial decoupler for heavy boosters.' });
add({ id: 'pylon', name: 'Radial Pylon', cat: 'coupling', shape: 'rdecoupler', r: 0.15, len: 1.2, mass: 60, fixed: true,
  radialOnly: true, radialOff: 0.15, outerFace: true, nodes: { top: false, bottom: false },
  desc: 'Permanent side mount (does not decouple).' });

// ---------- Aerodynamics ----------
for (const s of SIZES) {
  add({ id: `nose_${s.key}`, name: `Nose Cone ${s.key}`, cat: 'aero', shape: 'cone', r: s.r, rTop: 0, len: s.r * 2.6,
    mass: Math.round(110 * s.r * s.r * 2.2), nodes: { top: false, bottom: true }, cdTop: 0.14, maxTemp: 2400,
    desc: `${s.label} aerodynamic nose cone. Slashes drag.` });
}
add({ id: 'nose_blunt_S', name: 'Blunt Cap S', cat: 'aero', shape: 'cone', blunt: true, r: 0.625, rTop: 0, len: 0.5, mass: 40,
  nodes: { top: false, bottom: true }, cdTop: 0.3, maxTemp: 2600, desc: 'Short rounded cap for boosters.' });
add({ id: 'nose_blunt_M', name: 'Blunt Cap M', cat: 'aero', shape: 'cone', blunt: true, r: 1.25, rTop: 0, len: 1.0, mass: 150,
  nodes: { top: false, bottom: true }, cdTop: 0.3, maxTemp: 2600, desc: 'Short rounded cap for 2.5 m boosters.' });
for (const k of ['M', 'L']) {
  const s = SIZES.find((x) => x.key === k);
  add({ id: `fairing_${k}`, name: `Ogive Nose ${k}`, cat: 'aero', shape: 'fairing', r: s.r, rTop: 0, len: s.r * 4.4, hidden: true,
    mass: Math.round(200 * s.r * s.r * 1.8), nodes: { top: false, bottom: true }, cdTop: 0.13, maxTemp: 2400,
    desc: `${s.label} long ogive nose.` });
}
// Payload fairings: a base ring with a separation joint. Stack anything on it and a two-piece composite shell
// wraps round it (wider than the rocket if the payload is). Staged, the halves spring apart and fall away.
for (const s of SIZES.slice(0, 5)) {
  add({ id: `fbase_${s.key}`, name: `Payload Fairing ${s.key}`, cat: 'aero', shape: 'fbase', r: s.r, len: 0.18 + s.r * 0.06,
    mass: Math.round(45 * s.r * s.r * 4), fairingBase: true, radial: false, maxTemp: 2400, crashTol: 9,
    desc: `${s.label} payload fairing. Stack the payload on its ring and the shell grows round it. Stage it once you are above the thick air: until then it keeps air and heat off whatever is inside.` });
}
const fin = (d) => add({ cat: 'aero', shape: 'fin', r: 0.03, len: d.fin.chord, radialOnly: true, radialOff: 0,
  nodes: { top: false, bottom: false }, surface: false, maxTemp: 1900, crashTol: 9, ...d });
fin({ id: 'fin_s', name: 'Basic Fin', mass: 18, fin: { span: 0.6, chord: 0.8, tip: 0.4, sweep: 0.35 },
  desc: 'Small fixed fin. Moves the centre of pressure aft.' });
fin({ id: 'fin_m', name: 'Swept Fin', mass: 70, fin: { span: 1.3, chord: 1.8, tip: 0.8, sweep: 0.9 },
  desc: 'Medium fixed stabilizer.' });
fin({ id: 'fin_l', name: 'Delta Fin', mass: 260, fin: { span: 2.6, chord: 3.6, tip: 1.2, sweep: 2.2 },
  desc: 'Large stabilizer for heavy boosters.' });
fin({ id: 'fin_ctl_s', name: 'Steerable Fin S', mass: 30, fin: { span: 0.7, chord: 0.8, tip: 0.5, sweep: 0.25, control: 18 },
  desc: 'Small actuated fin. Steers the rocket in atmosphere.' });
fin({ id: 'fin_ctl_m', name: 'Steerable Fin M', mass: 110, fin: { span: 1.4, chord: 1.6, tip: 0.9, sweep: 0.6, control: 18 },
  desc: 'Medium actuated fin.' });
fin({ id: 'fin_grid', name: 'Grid Fin', mass: 90, fin: { span: 1.1, chord: 0.9, tip: 0.9, sweep: 0, control: 20, grid: true },
  desc: 'Lattice control fin, tough and heat resistant.', maxTemp: 2400 });
fin({ id: 'wing', name: 'Delta Wing', mass: 420, fin: { span: 3.6, chord: 5.0, tip: 1.0, sweep: 3.6 },
  desc: 'Big lifting surface for spaceplane experiments.' });

// ---------- Control ----------
add({ id: 'wheel_S', name: 'Reaction Wheel S', cat: 'control', shape: 'wheel', r: 0.625, len: 0.3, mass: 120, wheel: 12000,
  desc: 'Electric reaction wheel: torque without propellant.' });
add({ id: 'wheel_M', name: 'Reaction Wheel M', cat: 'control', shape: 'wheel', r: 1.25, len: 0.4, mass: 420, wheel: 45000,
  desc: 'Large reaction wheel for 2.5 m stacks.' });
add({ id: 'rcs', name: 'RCS Thruster Block', cat: 'control', shape: 'rcs', r: 0.1, len: 0.25, mass: 22, rcs: 1100,
  radialOnly: true, radialOff: 0.1, nodes: { top: false, bottom: false }, surface: false,
  desc: 'Four-way attitude thruster. Needs monopropellant. Toggle with R.' });
add({ id: 'mono_S', name: 'Monoprop Tank S', cat: 'control', shape: 'monotank', r: 0.625, len: 0.45, mass: 60, fuel: { mono: 240 },
  desc: 'Inline monopropellant tank for RCS.' });
add({ id: 'mono_M', name: 'Monoprop Tank M', cat: 'control', shape: 'monotank', r: 1.25, len: 0.6, mass: 220, fuel: { mono: 1200 },
  desc: 'Large inline monopropellant tank.' });
add({ id: 'mono_r', name: 'Monoprop Sphere', cat: 'control', shape: 'sphere', r: 0.28, len: 0.56, mass: 14, fuel: { mono: 60 },
  radialOnly: true, radialOff: 0.28, nodes: { top: false, bottom: false },
  desc: 'Surface-mounted monopropellant sphere.' });

// ---------- Recovery ----------
add({ id: 'chute_S', name: 'Parachute S', cat: 'recovery', shape: 'chute', r: 0.3, rTop: 0.18, len: 0.3, mass: 60,
  chute: { cda: 420 }, nodes: { top: true, bottom: true }, cdTop: 0.3, maxTemp: 2400,
  desc: 'Nose parachute for capsules up to ~2 t.' });
add({ id: 'chute_M', name: 'Parachute M', cat: 'recovery', shape: 'chute', r: 0.625, rTop: 0.35, len: 0.45, mass: 220,
  chute: { cda: 1600 }, nodes: { top: true, bottom: true }, cdTop: 0.3, maxTemp: 2400,
  desc: 'Large nose parachute for capsules up to ~7 t.' });
add({ id: 'chute_L', name: 'Parachute Cluster L', cat: 'recovery', shape: 'chute', r: 1.25, rTop: 0.8, len: 0.6, mass: 600,
  chute: { cda: 4500 }, nodes: { top: true, bottom: true }, cdTop: 0.4, maxTemp: 2400,
  desc: 'Triple-canopy cluster for heavy capsules and boosters.' });
add({ id: 'chute_r', name: 'Radial Parachute', cat: 'recovery', shape: 'rchute', r: 0.16, len: 0.5, mass: 45, chute: { cda: 330 },
  radialOnly: true, radialOff: 0.16, nodes: { top: false, bottom: false }, surface: false,
  desc: 'Side-mounted parachute. Use in symmetry.' });
for (const [k, m] of [['S', 180], ['M', 700], ['L', 1500], ['XL', 2600]]) {
  const s = SIZES.find((x) => x.key === k);
  add({ id: `shield_${k}`, name: `Heat Shield ${k}`, cat: 'recovery', shape: 'shield', r: s.r, len: 0.25 + s.r * 0.12, mass: m,
    maxTemp: 3600, crashTol: 12, cdBottom: 1.25, heatMass: 6, shield: true,
    desc: `${s.label} ablative heat shield. Put it under the capsule and re-enter bottom first.` });
}
add({ id: 'leg', name: 'Landing Leg', cat: 'recovery', shape: 'leg', r: 0.12, len: 1.6, mass: 60, crashTol: 14,
  radialOnly: true, radialOff: 0.12, nodes: { top: false, bottom: false }, surface: false, leg: { reach: 1.1, drop: 1.3 },
  desc: 'Sturdy fixed landing leg. Mount 3 or 4 in symmetry.' });
add({ id: 'leg_big', name: 'Heavy Landing Leg', cat: 'recovery', shape: 'leg', r: 0.2, len: 3.2, mass: 260, crashTol: 14,
  radialOnly: true, radialOff: 0.2, nodes: { top: false, bottom: false }, surface: false, leg: { reach: 2.4, drop: 2.8 },
  desc: 'Large leg for booster landings.' });

// ---------- Structure ----------
for (const [k, L] of [['XS', 1], ['S', 1], ['S', 3], ['M', 2]]) {
  const s = SIZES.find((x) => x.key === k);
  add({ id: `truss_${k}_${L}`, name: `Truss ${k}-${L}`, cat: 'structure', shape: 'truss', r: s.r, len: L,
    mass: Math.round(70 * s.r * L * 2), cdTop: 0.5, cdBottom: 0.5, hollow: 0.35,
    desc: `Open lattice segment, ${s.label} × ${L} m.` });
}
for (const [a, b, L] of adapters) {
  const ra = SIZES.find((s) => s.key === a).r, rb = SIZES.find((s) => s.key === b).r;
  add({ id: `adapt_${a}_${b}`, name: `${a}→${b} Adapter`, cat: 'structure', shape: 'adapter', r: ra, rTop: rb, len: L * 0.6,
    mass: Math.round(120 * ra * ra * L), cdTop: 0.3, desc: `Hollow structural adapter from ${a} to ${b}.` });
}
add({ id: 'boom', name: 'Radial Boom', cat: 'structure', shape: 'boom', r: 0.08, len: 0.3, mass: 25, radialOnly: true, radialOff: 0.6,
  boomLen: 1.2, outerFace: true, nodes: { top: false, bottom: false }, desc: 'Stand-off strut: attach parts to its end.' });
add({ id: 'ballast', name: 'Ballast Block', cat: 'structure', shape: 'wheel', r: 0.625, len: 0.4, mass: 1500, dark: true,
  desc: 'Dead weight for tuning the centre of mass.' });

// ---------- Payload ----------
add({ id: 'sat_bus', name: 'Satellite Bus', cat: 'payload', shape: 'satbus', r: 0.45, len: 0.9, mass: 320,
  desc: 'Boxy satellite body. Give it a probe core, panels and a dish.' });
add({ id: 'panel', name: 'Solar Panel', cat: 'payload', shape: 'panel', r: 0.03, len: 0.8, mass: 18, radialOnly: true, radialOff: 0,
  nodes: { top: false, bottom: false }, surface: false, panelLen: 2.6, maxTemp: 1200, crashTol: 3,
  desc: 'Fixed solar array (decorative in this version).' });
add({ id: 'panel_d', name: 'Folding Solar Array', cat: 'payload', shape: 'panel', r: 0.03, len: 0.8, mass: 24, radialOnly: true, radialOff: 0,
  nodes: { top: false, bottom: false }, surface: false, panelLen: 3.2, deploy: true, maxTemp: 1200, crashTol: 3,
  desc: 'Solar array that folds flat against the side for launch and fits in a fairing. O unfolds it in space.' });
add({ id: 'dish', name: 'Comms Dish', cat: 'payload', shape: 'dish', r: 0.5, len: 0.5, mass: 30, nodes: { top: false, bottom: true },
  maxTemp: 1200, crashTol: 3, cdTop: 1.1, desc: 'High-gain antenna (decorative in this version).' });
add({ id: 'fan', name: 'Round Solar Array', cat: 'payload', shape: 'fanpanel', r: 0.03, len: 0.3, mass: 28, radialOnly: true, radialOff: 0,
  nodes: { top: false, bottom: false }, surface: false, fanR: 1.1, maxTemp: 1200, crashTol: 3, desc: 'Circular fan-fold solar array on a short boom (decorative).' });
add({ id: 'antenna', name: 'Antenna Mast', cat: 'payload', shape: 'antenna', r: 0.04, len: 0.12, mass: 6, radialOnly: true, radialOff: 0.04,
  nodes: { top: false, bottom: false }, surface: false, mast: 1.4, maxTemp: 1200, crashTol: 3, desc: 'Whip antenna (decorative).' });
add({ id: 'telescope', name: 'Space Telescope', cat: 'payload', shape: 'telescope', r: 1.25, len: 5.2, mass: 3200, maxTemp: 1300, envTop: 1.0, envR: 2.25,
  nodes: { top: false, bottom: true }, desc: 'Orbital telescope with an aperture door. Put it in orbit to prove your launcher.' });
add({ id: 'habitat', name: 'Habitat Module', cat: 'station', shape: 'habitat', r: 1.25, len: 3.6, mass: 4600,
  desc: 'Pressurised crew module with windows and handrails.' });
add({ id: 'service_M', name: 'Service Module M', cat: 'payload', shape: 'service', r: 1.25, len: 1.8, mass: 1300, fuel: { liquid: 2600, mono: 300 },
  desc: 'Short tank with radiators and steering thruster quads. Sits under a capsule.' });
add({ id: 'cargo_S', name: 'Cargo Canister S', cat: 'payload', shape: 'cargo', r: 0.625, len: 1.2, mass: 900,
  desc: 'One tonne of "science instruments".' });
add({ id: 'cargo_M', name: 'Cargo Canister M', cat: 'payload', shape: 'cargo', r: 1.25, len: 2.0, mass: 5000,
  desc: 'Five tonnes of payload to prove your launcher.' });

// ---------- Docking & station ----------
// Ports of the same size latch when they meet face to face: closer than ~0.3 m, lined up within ~10°,
// closing slower than ~0.5 m/s. Docked craft fly as one. U undocks.
for (const [id, nm, r, len, mass, size] of [['dock_XS', 'Docking Port Jr', 0.3125, 0.28, 30, 'XS'], ['dock_S', 'Docking Port', 0.625, 0.4, 80, 'S'], ['dock_M', 'Docking Port Sr', 1.25, 0.5, 260, 'M']]) {
  add({ id, name: nm, cat: 'station', shape: 'dock', r, len, mass, dock: { size }, crashTol: 9,
    desc: `Androgynous ${size} docking port with guide petals. Docks with another ${size} port. The free face is the docking face.` });
}
add({ id: 'dock_r', name: 'Radial Docking Port', cat: 'station', shape: 'rdock', r: 0.5, len: 0.9, mass: 90, dock: { size: 'S', radial: true },
  radialOnly: true, radialOff: 0.3, outerFace: true, nodes: { top: false, bottom: false }, crashTol: 9,
  desc: 'Docking Port on the side of a module: for station hubs and berthing.' });
add({ id: 'node', name: 'Station Node', cat: 'station', shape: 'node', r: 1.25, len: 2.4, mass: 1900,
  desc: 'Pressurised hub. Put radial docking ports round it and ports on both ends to build out a station.' });
add({ id: 'lab', name: 'Laboratory Module', cat: 'station', shape: 'lab', r: 1.875, len: 6.5, mass: 11500, crew: 4,
  desc: 'Big pressurised laboratory: racks, windows and a berthing ring at each end.' });
add({ id: 'cupola', name: 'Cupola', cat: 'station', shape: 'cupola', r: 1.0, rTop: 0.6, len: 1.4, mass: 1800, nodes: { top: false, bottom: true },
  desc: 'Seven-window observation dome.' });
add({ id: 'st_truss', name: 'Station Truss', cat: 'station', shape: 'sttruss', r: 0.8, len: 8, mass: 5200, hollow: 0.3, cdTop: 0.5, cdBottom: 0.5,
  desc: 'Square integrated truss segment with a rail and utility trays. Hang solar wings and radiators off it.' });
add({ id: 'wing_sol', name: 'Solar Wing', cat: 'station', shape: 'panel', r: 0.03, len: 1.2, mass: 1100, radialOnly: true, radialOff: 0,
  nodes: { top: false, bottom: false }, surface: false, panelLen: 16, deploy: true, maxTemp: 1200, crashTol: 3,
  desc: 'Huge folding solar wing (16 m). Folded flat for launch, O unfolds it. Unfolded in thick air it rips off.' });
add({ id: 'radiator', name: 'Radiator Panel', cat: 'station', shape: 'radiator', r: 0.03, len: 1.6, mass: 380, radialOnly: true, radialOff: 0,
  nodes: { top: false, bottom: false }, surface: false, panelLen: 6, deploy: true, maxTemp: 1400, crashTol: 3,
  desc: 'Folding heat radiator. O unfolds it.' });

// ---------- Warheads ----------
// Yield in kilotons of TNT. Stage once to arm. Armed: nuclear devices burst in the air at the height that
// spreads their blast widest; the rest go off on impact. B sets off everything armed right now.
const wh = (d) => add({ cat: 'warheads', maxTemp: 2600, crashTol: 40, nodes: { top: false, bottom: true }, cdTop: 0.12, ...d });
wh({ id: 'wh_he', name: 'Conventional Warhead', shape: 'rv', r: 0.3125, len: 1.7, mass: 700, warhead: { kt: 0.0005, kind: 'he' },
  desc: 'Half a tonne of high explosive in a re-entry body. Impact fuse.' });
wh({ id: 'wh_fae', name: 'Thermobaric Warhead', shape: 'rv', r: 0.42, len: 2.1, mass: 1600, warhead: { kt: 0.008, kind: 'fae' },
  desc: 'Fuel-air explosive: sprays a cloud of fuel, then lights it. A long, rolling fireball. Impact fuse.' });
wh({ id: 'wh_tac', name: 'Tactical Fission Warhead', shape: 'rv', r: 0.3125, len: 1.4, mass: 250, nuke: true, warhead: { kt: 10, kind: 'fission' },
  desc: '10 kilotons. Air burst.' });
wh({ id: 'wh_strat', name: 'Thermonuclear Warhead', shape: 'rv', r: 0.3125, len: 1.75, mass: 360, nuke: true, warhead: { kt: 475, kind: 'fusion' },
  desc: '475 kilotons in a slim re-entry cone. Air burst.' });
wh({ id: 'wh_mega', name: 'Megaton Device', shape: 'bomb', r: 1.05, len: 8, mass: 27000, nuke: true, warhead: { kt: 50000, kind: 'fusion' }, radial: false,
  desc: '50 megatons, the largest yield ever tested. 27 tonnes. Air burst; the cloud climbs past 60 km.' });
wh({ id: 'wh_rod', name: 'Kinetic Rod', shape: 'rod', r: 0.15, len: 6, mass: 8200, warhead: { kt: 0, kind: 'kinetic' }, maxTemp: 3600, cdTop: 0.08,
  desc: 'Eight tonnes of tungsten, no explosive. Hits with the energy of its speed: drop it from orbit.' });
wh({ id: 'wh_bus', name: 'Warhead Bus', shape: 'bus', r: 0.625, len: 0.7, mass: 420, command: true, wheel: 2500, fuel: { mono: 80 },
  nodes: { top: true, bottom: true }, cdTop: 0.85, crashTol: 9, maxTemp: 1600,
  desc: 'Post-boost vehicle: a guidance core that carries several re-entry vehicles on radial decouplers and sets each one loose.' });

// ---------- Lights (L switches them on and off in flight) ----------
add({ id: 'light_flood', name: 'Floodlight', cat: 'lights', shape: 'floodlight', r: 0.11, len: 0.22, mass: 9, radialOnly: true, radialOff: 0.025,
  nodes: { top: false, bottom: false }, surface: false, maxTemp: 1300, crashTol: 8, light: { kind: 'spot', dir: [1, -0.6, 0], at: [0.2, -0.09, 0] },
  desc: 'Bright lamp aimed out and down. Lights the ground under you when you land at night.' });
add({ id: 'light_strobe', name: 'Strobe Light', cat: 'lights', shape: 'navlight', r: 0.05, len: 0.09, mass: 2, radialOnly: true, radialOff: 0.02,
  nodes: { top: false, bottom: false }, surface: false, maxTemp: 1300, crashTol: 8, light: { kind: 'strobe', at: [0.07, 0, 0] },
  desc: 'White flash every second or so. Easy to spot your rocket against the night sky.' });
add({ id: 'light_red', name: 'Nav Light Red', cat: 'lights', shape: 'navlight', r: 0.05, len: 0.09, mass: 2, radialOnly: true, radialOff: 0.02,
  nodes: { top: false, bottom: false }, surface: false, maxTemp: 1300, crashTol: 8, light: { kind: 'red', at: [0.07, 0, 0] },
  desc: 'Steady red position light. Traditionally on the left side.' });
add({ id: 'light_green', name: 'Nav Light Green', cat: 'lights', shape: 'navlight', r: 0.05, len: 0.09, mass: 2, radialOnly: true, radialOff: 0.02,
  nodes: { top: false, bottom: false }, surface: false, maxTemp: 1300, crashTol: 8, light: { kind: 'green', at: [0.07, 0, 0] },
  desc: 'Steady green position light. Traditionally on the right side.' });

export const PARTS = Object.fromEntries(P.map((p) => [p.id, p]));
export const PART_LIST = P;

export function partFuelMass(def) {
  if (!def.fuel) return 0;
  return (def.fuel.liquid || 0) + (def.fuel.solid || 0) + (def.fuel.mono || 0);
}
