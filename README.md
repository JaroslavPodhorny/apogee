# Apogee

A 3D rocket game for the browser: build a rocket in the hangar, fly it to orbit, bring it home.

**▶ Play it: https://jaroslavpodhorny.github.io/apogee/** (desktop browser with a keyboard and a decent GPU recommended)

## Run

```bash
python3 serve.py
```

Then open http://localhost:5173.

## Hangar

- Drag a part off the shelf and bring it to the rocket. It jumps into place when it is close to where it fits: white rings mark the ends you can stack on, and side parts (fins, boosters, legs) attach when you bring them to the side of a part.
- Drag a placed part to move it (everything attached to it comes along). Drag it back onto the shelf, or right-click it, to remove it.
- Drag empty space to look around, scroll to zoom, right-drag or Shift+scroll to move up and down.
- X cycles symmetry, C toggles angle snap, Q/E/R/F tilt the part you are holding, Ctrl+Z undoes.
- The bar at the bottom shows whether the rocket has enough delta-v to reach orbit on the chosen world.

## Flight

- Space launches, then fires the next stage (or click the orange button).
- A / D lean the rocket left / right as you see it on screen; W / S lean it away from / toward you; Q / E roll.
- Shift / Ctrl or the slider set the throttle; Z is full, X is off.
- T toggles the steady-hold autopilot; the Prograde / Retrograde buttons point the rocket along or against its motion.
- . and , change time speed, M opens the orbit map, I shows full telemetry, ? shows the controls.
- O unfolds solar arrays and radiators, L switches lights, Backspace aborts (the escape tower pulls the capsule away).
- With RCS on (R): I / K, J / L and H / N move the craft forward / back, left / right, up / down.
- The line at the top is the current goal with a hint for what to do next.

## Photo mode

Choose **Photo** in the hangar or in flight, or press **F8**. Flight freezes while the viewfinder is open. Drag to orbit, scroll to move closer, or hold Shift and drag to place the rocket off-centre. On touchscreens, use two fingers to reframe and pinch to zoom. With the viewfinder focused, arrow keys orbit, Shift + arrows reframe, and Enter saves a photo.

Choose a frame, adjust the lens and exposure, and select **Save PNG**. Photos have a 2560-pixel long edge. The thirds grid is a composition aid and the optional Apogee signature appears in the finished image. Supported browsers also offer **Share last PNG**. Press **Esc** to return to your original camera.

## Fairings and interstages

- A stack decoupler with an engine standing on it grows an interstage shell round that engine; it drops away with the spent stage.
- A Payload Fairing (Aero) is a ring: stack the payload on it and a two-piece shell grows round it. V (or "See-through shells") lets you see and build inside. Stage it above the thick air and the halves spring away.

## Docking, stations and universes

- Docking ports of the same size latch when they meet face to face, lined up and closing slowly. Docked craft fly as one; U undocks.
- Y targets the nearest craft; the navball and readouts then show the target, closing speed and port alignment.
- Everything left in orbit (and landed craft with a command part) stays in the current universe. V lists every craft; [ and ] switch to nearby ones. Pick, create and delete universes on the title screen.

## Warheads

- Stage to arm. Nuclear devices burst in the air at the height that spreads their blast widest; the rest go off on impact. B sets off everything armed.
- Blast overpressure follows the Kinney–Graham fit with altitude scaling; fireball size, mushroom-cloud height and craters scale with yield.

## Development

`npm test` (or `node test/orbit.test.mjs real 1`) flies a stock rocket to orbit and back without a browser.

## Credits

Earth day, night, cloud, water and relief maps: [Solar System Scope](https://www.solarsystemscope.com/textures/), licensed CC BY 4.0 (repacked and resized in `assets/earth/`). three.js (MIT) is bundled in `vendor/`.
