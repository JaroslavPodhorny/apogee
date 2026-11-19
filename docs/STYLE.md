# Apogee art direction

**A modern commercial launch company.** Monochrome, machined and confident. Gloss white, carbon black, polished stainless and raw concrete. The hardware looks factory-fresh and is photographed like a product. The pad is a clean industrial yard in graphite and grey steel. (The reference is the look of today's reusable-rocket companies, not any one company's branding: no logos, no names.)

The code that enforces this is `src/style.js`. The page that shows it is **`style.html`** (open it next to the game, e.g. `http://localhost:5173/style.html`).

## The rules

1. **Black, white and metal.** Shapes read through contrast: a white tank against a black interstage against a bare steel stage. If something needs to stand out, give it a different value, not a new hue.
2. **Colour is a signal, never decoration.** The only colours on the site each have a job:
   - hazard yellow where people must not stand (kerbs, rails, keep-out stripes);
   - aviation orange on the windsock;
   - red on the mast beacons.

   Before adding a colour, name its job. If it has none, it is grey, white or black.
3. **Flight hardware is clean and glossy.** Paint is clear-coated (`MeshPhysicalMaterial`, clearcoat 1) and nearly blank: the life is in the reflections, not in the texture. Stainless is polished to a soft, slightly uneven mirror (its own roughness map in `meshes.js`). Heat-shield tiles are black hexagons, each a shade apart. No grime, no wear, no patchwork.
4. **Ground equipment is maintained, not abandoned.** Even satin paint, a few rain streaks under the top edges, small chips where things get knocked, dust at the foot of things. No rust bleeding down every wall.
5. **Dirt has a cause.** Rain runs down from edges (`streaks`, on world UVs so "down" is down). Dust collects at the foot of things (`groundGrime`, driven by the height above the ground). Nothing is a random smudge.
6. **Colours come from the palette, by name.** `PALETTE` in `style.js` writes each colour's role beside it. Scene code asks for `col('structure')` and never writes a hex value.
7. **One texel density.** Site surfaces are box-mapped in metres (`boxUV`, `TILE` = 2 m unless a material says otherwise). Rocket skins tile per 1.6 m panel, and heat tiles are about 30 cm.
8. **One recipe weathers many colours.** A new painted thing is `surfaceMaterial('<palette name>', 'fieldPaint')`. Don't write a new texture.
9. **Markings mean something.** A black band is a joint or an interstage, a yellow stripe is a hazard, a line is a weld. If you can't say what a mark is, remove it.

## Workflow

1. Change a colour in `PALETTE`, or a layer in a recipe in `RECIPES` (both in `src/style.js`).
2. Refresh `style.html`. It shows:
   - the palette with each colour's role;
   - every flight material on a drum and every site material on a block, under daylight, low sun or studio light;
   - a row of real parts;
   - the raw colour, normal and roughness maps of every recipe.
3. Judge it under all three lights, then in the game: the pad at noon and at golden hour, and the hangar.
4. Need a new surface? Add a recipe built from the existing layers. Reach for a new layer type only if no combination of the existing ones can say it. If you do add one, document it here.

Things to look for when judging:

- Up close, does it show something specific (a seam, a streak, a chip), or only noise?
- From far away, does it settle into an even tone? If it blotches, the low-frequency layers are too strong.
- Next to its neighbours, does it look like it came from the same place, the same years and the same weather?

## Where things live

| What | Where |
| --- | --- |
| Palette, recipes, noise toolkit, world UVs, ground grime | `src/style.js` |
| Rocket materials (and their special maps: foil, tiles, cells, ribs) | `src/meshes.js` (`base()`) |
| Launch site materials | `src/site.js` (`siteMaterials()`) |
| Planet ground, sea, sky | `src/planet.js` (shaders: its own palette, tuned to the Earth imagery) |
| Material board | `style.html` |
