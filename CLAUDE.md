# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Apogee: a browser 3D rocket sandbox (build in a hangar, fly to orbit, dock, build stations, set off warheads). Plain ES modules + three.js r169 vendored in `vendor/` — no bundler, no build step, no npm dependencies. Deployed as-is to GitHub Pages from `main` (https://jaroslavpodhorny.github.io/apogee/); every push to `main` redeploys. All asset paths must stay relative (the site is served under `/apogee/`).

## Commands

```bash
python3 serve.py 5173          # dev server (no-cache), also `npm start`; .claude/launch.json config "apogee"
npm test                       # = node test/orbit.test.mjs compact 0
node test/orbit.test.mjs <compact|real> <stockIndex>   # fly stock rocket #i to orbit and back, headless
```

The test is the only automated check: it runs `sim.js` without a browser (flat sphere, no terrain) and should print `ORBIT at ...` and `LANDED ...`. Stock rockets 3 and 4 have no heat shield and are expected to be lost on re-entry. Rendering changes can only be verified in a browser (`window.apogee` exposes `builder`, `flight`, `setMode`). For screenshots from a background tab, call `apogee.flight.frame(dt, w, h)` manually (rAF does not run in background tabs) and read the canvas.

## Architecture

**Modes** (`main.js`): one WebGL renderer shared by the title screen, the hangar (`builder.js`) and flight (`flight.js`). `Builder` edits a *design* (`{name, parts:[{id,type,parent,attach,stage,symId}]}`) persisted in localStorage; launching passes a cloned design to `Flight.start(design, kind)`.

**Parts → physics → render pipeline**
- `parts.js`: pure data catalog (SI units). Behaviour is driven by def fields (`engine`, `fuel`, `decoupler`, `fairingBase`, `dock`, `warhead`, `les`, `deploy`, `chute`, `shield`, …). Part frame: +Y along the stack, radial parts +X outward.
- `rocket.js`: design tree logic shared by hangar and sim — `computeLayout`, symmetry attach/detach, `autoStage`, delta-v `analyze`, and `enclosures()` which derives **interstages** (a stack decoupler with an engine on top grows a shell) and **fairing shells** (profile wrapped round everything stacked on a fairing base). The same function feeds the hangar meshes, analysis mass, and flight physics.
- `sim.js`: `World`/`Vessel` rigid-body physics in an inertial planet-centred frame (planet spins about +Y). Contains staging, aero/heating, docking/undocking (merges vessel part trees, re-rooting the docked tree), fairing jettison (spawns synthetic `fhalf` part defs), blasts (Kinney–Graham overpressure, Sedov shock), LES abort, persistence (`serializeVessel`/`restoreVessel`, `World.serialize/restore`) and rails/Kepler propagation for vessels > `loadR` (2.5 km) from the active one. No rendering code here.
- `meshes.js`: procedural models per `def.shape` (cached by def id, merged by material); `interstageMesh`/`fairingHalfMesh` are built per rocket because they depend on context.
- `universe.js`: named saved worlds in localStorage (`apogee.universes`, `apogee.u.<id>.<compact|real>`), each with clock, inertial sun direction, persisted vessels and craters. Launching advances world time to the chosen launch hour.

**Planet rendering** — the ground is *not* scene geometry:
- `terrain.js`: CDLOD cube-sphere. `terrainH()` (GLSL in `TERRAIN_CORE`) has an exact JS mirror `Terrain.height()` used by physics (`groundAt`) — **any change to the terrain height must be made in both** and verified to match (GPU vs CPU agreed to ~1 cm). `terrainHd(n, spacing)` adds LOD-faded fine roughness for mesh vertices. The launch site is flattened; `siteRelief` adds rolling ground and lake hollows (`LAKE_LV`).
- Terrain patches render only a G-buffer (distance, height, normal). `planet.js` `SKY_FRAG` is one full-screen pass that shades sky, atmosphere, clouds, sea **and all ground colour/detail** from that G-buffer, at reduced resolution, then `flight.resolveSky` upscales (bicubic) and temporally steadies clouds; the result becomes `scene.background`. Meshes (rocket, site, smoke, bushes) render on top; the terrain does not depth-occlude them, so effects near the ground clip themselves (see `boom.js`).
- Ground detail is faded by pixel footprint (`footA`, `footL` for regular patterns) to avoid shimmer. Near the base, coordinates use the site tangent frame `sP` built from CPU-precise `uCamSite`/`uCamF`; avoid reconstructing positions from 600 km float32 vectors in the shader (causes jitter/striping).
- `bushes.js`: GLSL shared by the ground shader and `scatter.js` (instanced 3D bushes near the camera) so painted and 3D vegetation agree (`landUse`, `farmMask`, `lakeField`, `roadDist`, `copseField`, `bushDensity`). Change placement here, not in one consumer.
- `site.js`: launch complex meshes; its ground mesh draws only built surfaces over the planet's ground.

**Graphics settings**: `gfx.js` holds the quality preset and options (resolution, sky/ground pass scale, shadow map size, MSAA, volumetric clouds, 3D bushes, bloom, FPS readout) in `apogee.gfx`, plus the panel opened by every "Graphics" button. `flight.js` reads `gfx` each frame (`resizePipeline`, `skyRes`, `applyShadows`); new costly features should get an option there rather than a hard-coded quality.

**Effects**: `fx.js` (smoke particle system with world-space doubles drawn relative to the floating origin, per-puff `soot`; volumetric light on the CPU: puffs are splatted into a sparse density grid (`DensityGrid`) and each marches toward the sun, the sky and the flame, so the cloud shades itself as a whole; sprites are baked puffs with 6-way lighting from `puffbake.js` (four cauliflower volumes built from nested spheres, ray-marched once at start-up into two atlases holding the light from ±x, ±y, ±z), mixed in the shader by the sun, sky, ground and flame directions; the launch cloud is many puffs flagged with `smoke.pad()` that ride a divergence-free turbulence field (`TURB`), brake at their own rate, and climb at tower sites (`smoke.towers`) that `flight.emitSmoke` places where its ground jets stall; engine plume shaders with blackbody colour and propellant `chem` 0/1/2; `Sparks`, an additive, velocity-stretched particle system for embers, flashes, glints and RCS gas, one draw call, budget scaled by `gfx.fx`; fireball, re-entry plasma and vapour-cone materials). `flight.js` drives them (`updateHeatFx`, `updateRcsFx`, `sepFx`, `explosionSparks`) from sim state and `world.fx` events (`explosion`, `puff`, `sep`, `blast`), `boom.js` (fireballs, shock shells, mushroom clouds), `post.js` (physically based bloom; `outputPass()` = tone mapping plus lens vignette and 8-bit dither, used by flight and the title), `sun.js`. In flight the scene is drawn relative to `flight.origin` (the active vessel) — a floating origin.

**Two planets**: `compact` (R = 637.1 km, atmosphere scale `atmK = 3`, 6 h day) and `real` (Earth scale). Many terrain/atmosphere constants scale with `uTA = 1/sqrt(atmK)`.

**Look (art direction)**: monochrome modern-launch-company look (gloss white, carbon black, stainless, concrete; colour only as a signal). `docs/STYLE.md` is the art bible; `src/style.js` enforces it: the named `PALETTE`, surface `RECIPES` (tileable noise, rain streaks, chips, seams → colour + normal + roughness maps together), `boxUV`/`prepareWorldSurface` (world-space UVs in metres plus a height-above-ground attribute) and `surfaceMaterial(colour, recipe)` with a ground-grime shader. Rocket materials (`meshes.js` `base()`) and site materials (`site.js` `siteMaterials()`) draw from it. `style.html` is the material board: palette, every material, real parts, raw maps; refresh it after editing `style.js`.

## Conventions

- New colours go in `PALETTE` (by role), new surfaces as recipes in `style.js`; scene code never hard-codes a hex colour or draws its own weathering.
- Units are SI throughout; comments explain the physics or visual intent behind constants — keep that style.
- localStorage keys are prefixed `apogee.`; don't break saved designs/universes when changing part ids (old ids can be kept with `hidden: true`).
- Performance target is a MacBook Air: the sky/ground pass is the most expensive part of the frame; `flight.resScale` lowers resolution adaptively.
