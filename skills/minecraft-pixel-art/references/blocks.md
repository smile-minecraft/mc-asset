# Block textures (16×16, tiling)

A block face is a solid 16×16 texture (alpha 255 everywhere for opaque blocks)
that has to look good alone *and* repeated across a wall or floor.

## Measured vanilla blocks (current textures)

| Block | Colors | Structure |
| --- | --- | --- |
| Stone | 4 | soft clusters, very low contrast |
| Cobblestone, oak log (side) | 6 | rounded stones / vertical bark strands |
| Dirt, oak planks, stone bricks | 7 | planks: four 4-row boards; bricks: two courses |
| Bricks, iron ore | 8–9 | mortar + two brick tones / stone + ore specks |
| Block of iron | 11 | many near-identical light grays, bevelled bands |

Budget: **about 7 colors, often 5 or 9, plus 1–2 accent colors** (the light
specks in andesite, the gray grit in dirt). Values between neighbouring shades
are close — blocks are much lower contrast than items so a wall does not
become busy.

## The Jappa-style process

1. **Palette.** Pick or derive a ramp of about 7 colors sorted dark to light.
   When the block sits next to existing vanilla blocks, derive the ramp from a
   related block so it fits the world.
2. **Base fill.** Fill the whole face with the 4th color (the middle of a
   7-color ramp).
3. **Structure.** Draw the shapes (bricks, boards, stones) with the darkest
   color. Seams sit on the **bottom and right** of each element — this matches
   the rest of the game and sells the top-left light.
4. **Tile check.** Before shading further, preview the texture tiled (a 3×3
   wall is best). Fix edges that clash left/right or top/bottom. Two or three
   shades are enough to judge tiling.
5. **Light.** Put the lightest color along the top and left edges and corners
   of each element, loosely, not as a ruler-straight line.
6. **Seam depth.** Seams usually use 2 colors, sometimes 3: the darkest in the
   gap and the next shade as its soft edge.
7. **Shadows** go opposite the light, on the lower-right parts of each element.
8. **Fill out the palette** with the remaining shades as clusters, then adjust
   colors globally. Iterate on a few versions and keep the best.

## Structural patterns seen in vanilla

- **Planks:** four horizontal boards of 4 rows; the 4th row of each board is
  the darkest seam; board ends are staggered with short vertical seams; grain is
  horizontal streaks of 3–6 pixels.
- **Stone bricks / bricks:** courses of 7–8 rows including a 1–2 row dark seam
  at the bottom; a vertical seam on the right of each brick; courses offset by
  half a brick; a light top-left rim on each brick.
- **Cobblestone:** irregular rounded stones of 3–6 pixels, each with a light
  top-left and a dark lower-right, separated by dark gaps; no two stones the
  same shape.
- **Stone / natural surfaces:** soft clusters of 2–6 pixels in 3–4 close
  values; no single-pixel speckle.
- **Metal blocks:** large flat areas with a light top edge and dark bottom
  edge per band, very low contrast.

## Tiling rules

- The left and right edge columns must continue each other's pattern, and the
  same for top and bottom rows. Seams that cross the edge must line up.
- Avoid a single standout feature (one bright pixel, one odd stone) — repeated
  on a wall it becomes an obvious grid ("tiling artifact").
- Keep contrast low and distribute light and dark evenly across the face;
  a darker half turns into stripes when tiled.
- Periods must divide 16: brick widths of 8, board heights of 4, and so on,
  or the pattern breaks at the edge.
- With mc-asset, `tile` reports the seam scores and `tile --preview 4x4`
  writes a repeated wall to look at (`2x2`, `4x4`, and `8x8` are available).
