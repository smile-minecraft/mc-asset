---
name: minecraft-pixel-art
description: Draw textures that look like vanilla Minecraft Java Edition art — 16×16 items, tiling blocks, GUI sprites, and animated textures. Use whenever you author, redraw, or review Minecraft-style pixel art (a .grid, .mcpx, or PNG for a resource pack, a mod, or a showcase image), choose a palette or color ramp for it, or judge whether a sprite "looks like Minecraft". Pairs with the mc-asset skill, which covers the tool that renders and checks the result.
---

# Minecraft Pixel Art

Vanilla Minecraft textures follow a small, consistent set of rules. Generic
pixel-art habits — thick black outlines, smooth vector-like circles, flat
saturated fills, one outline color all the way round — read as "fan art", not
as Minecraft. This skill is the rulebook. Follow it before you place a pixel,
and check the result against it before you call a texture done.

The rules come from the Blockbench Minecraft Style Guide, the Jappa-style
workflow documented by resource-pack artists, the Pixel Joint pixel-art
tutorial, the Lospec / Slynyrd palette material, and measurements of the
current vanilla textures. `references/sources.md` lists them.

Draw **original** designs in the vanilla style. Never trace or copy a vanilla
texture pixel for pixel: the style is shared, the artwork is Mojang's.

## Which reference to read

| Task | Read |
| --- | --- |
| A 16×16 item: tool, weapon, food, gem, ingot, bottle | `references/items.md` |
| A block face that must tile | `references/blocks.md` |
| Picking colors, building a ramp, material palettes | `references/palettes.md` |
| GUI panels, slots, buttons, nine-slice sprites | `references/gui.md` |
| Animated textures (`.mcmeta` animation strips) | `references/animation.md` |
| Entity (mob) textures on a box-UV template | `references/entities.md` |
| Reviewing a sprite, or it "looks off" | `references/anti-patterns.md` |

Always read `references/anti-patterns.md` before you sign off on any texture.

## The core rules

1. **16×16 is the canvas, and one texel is the smallest unit.** No mixels: never
   mix pixel sizes, never upscale art to fake detail, never draw at a higher
   resolution and shrink it. If a detail does not fit in 16×16, simplify the
   design rather than squeezing the detail in.
2. **Silhouette first.** Block the whole shape in one midtone. It must read at
   1× scale in an inventory slot before any shading exists. Items fill the
   canvas: tools and weapons run corner to corner (handle bottom-left, head or
   tip top-right); round objects span about 11–13 pixels.
3. **Light comes from the top left.** Highlights sit on the top and left of each
   form, shadows on the bottom and right. Shade the *form* (a cylinder, a
   sphere, a bevelled blade), not the outline of the flat shape.
4. **Outlines are the material's own darkest shades, not black.** An item
   outline uses the darkest one or two colors of the ramp it encloses: dark red
   around an apple, dark teal around a diamond, dark brown around a stick. The
   outline is lighter on the lit top-left edge and darkest on the bottom-right
   edge. Different materials in one item get different outline colors. Metals
   and stone can go near black (`#181818`), organics never do.
5. **Thin parts are not outlined all round.** A stick or handle is a 2-pixel
   diagonal: a lighter pixel on the upper-left side, a darker pixel on the
   lower-right side, the darkest color capping the bottom end.
6. **Small palettes.** A vanilla item uses about 8–12 opaque colors in total and
   4–7 per material; a block face uses about 4–9. Start with midtone + one
   shadow + one highlight, shade, and only then add shades. Every color must
   earn its place: no near-duplicates.
7. **Ramps shift hue, not only value.** Organic and warm materials shift toward
   red/brown in the darks and toward yellow or pink in the lights; keep
   saturation highest in the midtones. Neutral metals (iron, stone) may use a
   straight gray ramp. See `references/palettes.md` for measured vanilla ramps.
8. **Clusters, not noise.** Pixels read in groups. Every lone pixel must be
   deliberate (a specular glint, an eye, a seed). Texture comes from clusters
   of 2–5 pixels, never from random speckle.
9. **Hard edges against transparency.** Item textures are cutout: alpha is only
   0 or 255. No semi-transparent pixels and no anti-aliasing into the
   background.
10. **Blocks must tile.** Put the dark seams on the bottom and right of each
    element, check the tile early with two or three shades, and review a repeated
    wall (3×3 or larger) before you finish.

## Workflow

1. Decide the design and its read at 1× (what shape says "sword"?).
2. Pick the ramps (`references/palettes.md`). Write them down with roles:
   outline, shadow, base, light, highlight, accent.
3. Block the silhouette in the midtone.
4. Add the outline in the material's dark shades, lighter on the top-left edge.
5. Add one highlight and one shadow following the form and the top-left light.
6. Add the remaining shades and the surface detail (grain, facets, glints).
7. Review against `references/anti-patterns.md` at 1× and at ×8 or more.
   Fix banding, pillow shading, stray pixels, and jaggies.
8. For blocks, review the 3×3 tile. For GUI sprites, review at the target size.

When mc-asset is available, author the texture as a `.grid` or `.mcpx`, render
it, and look at an upscaled preview after every pass — the mc-asset skill has
the commands.

## Done checklist

- [ ] Reads at 1×; the silhouette alone identifies the object.
- [ ] Light from the top left everywhere; no pillow or pancake shading.
- [ ] Outline uses the material's own dark shades, lighter top-left, darkest
      bottom-right; no pure-black outline around organic materials.
- [ ] Color count within budget (items ~8–12, blocks ~4–9); no near-duplicate
      colors; ramps hue-shift where the material calls for it.
- [ ] No lone pixels except deliberate glints; no single-pixel noise fields.
- [ ] No banding (staircase, hugging, fat lines) and no jaggies in lines/curves.
- [ ] Items: alpha only 0 or 255. Blocks: tiles cleanly in a 3×3 wall.
- [ ] Original design — not a trace of a vanilla texture.
