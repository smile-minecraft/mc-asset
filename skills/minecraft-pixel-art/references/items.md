# Item textures (16×16)

Items are cutout sprites on a transparent 16×16 canvas. They are seen tiny in
an inventory slot and large when held, so the silhouette carries most of the
read and the shading carries the material.

## Process (Blockbench style guide, Jappa workflow)

1. Draw the shape in a single midtone with a **significantly darker outline**.
2. Add one highlight and one shadow, light from the **top-left corner**, and
   shade the outline too: its top/left edge is lighter than its bottom/right
   edge.
3. Add the rest of the palette: more highlight and shadow steps, following the
   form (the curve of an apple, the edge bevel of a blade).
4. Add surface properties: shine, translucency, roughness, cracks, grain.

## Measured vanilla items (current textures)

Opaque color counts measured with `mc-asset analyze` (the transparent color is
not counted):

| Item | Opaque colors | Notes |
| --- | --- | --- |
| Stick | 4 | 2-pixel diagonal, no full outline |
| Bow, bread | 7 | one material + string / crust |
| Iron ingot, gold ingot | 8 | one ramp, bright white specular |
| Glass bottle | 8 | sparse outline-only glass |
| Pickaxe (iron, diamond), golden apple | 9 | head ramp + stick ramp |
| Apple, carrot, diamond, emerald, book, wooden sword | 10 | |
| Sword (iron, diamond) | 11 | blade ramp + guard + stick ramp |
| Torch | 12 | wood ramp + 4 flame colors, no outline |
| Water bottle | 15 | glass + liquid + cork, the upper end |

Budget: **8–12 opaque colors per item, 4–7 per material ramp.** Fewer is fine
for a simple object; above 12 needs a reason.

## How vanilla items are built

These are observations about structure, written so you can apply them to your
own designs. Do not reproduce the vanilla grids.

### Outline

- One pixel wide, made of the enclosed material's darkest shades.
- Two tones: a lighter dark along the top and left edges, the darkest along
  the bottom and right edges. On the iron sword the lit edge is a mid-dark gray
  (`#444444`) and the far edge near black (`#181818`); on the apple the lit edge
  is a dark red (`#9C1017`) and the far edge a maroon (`#54090E`).
- Each material gets its own outline: the blade and the stick of a sword have
  different outline colors, and they meet without a black line between them.
- Organic items (food, wood, leather, plants) never use black or neutral gray
  outlines. Hue-shift the outline toward the material's shadow hue.
- Glass is drawn mostly as outline: light blue edge pixels with gaps, and the
  inside left transparent or tinted.

### Light and form

- Highlight clusters sit inside the top-left of each form, not on the rim.
  Shiny materials (metal, gems, glass) get a small pure-white or near-white
  specular cluster of 1–4 pixels.
- The bottom-right third of a form carries the shadows. Follow the 3D shape:
  a round fruit darkens along its lower-right curve; a blade has a lit edge and
  a shaded edge along its length.
- Vanilla midtones are fairly saturated (apple red `#DD1725`, diamond cyan
  `#2CE0D8`); the darkest shades lose saturation and drift in hue.

### Handles, sticks, and thin parts

- A stick is a 2-pixel-wide diagonal from bottom-left to top-right.
- Each diagonal step pairs a lighter pixel on the upper-left with a darker pixel
  on the lower-right; the darkest shade caps the bottom end.
- There is no outline on the lit side of a thin part — the part is its own
  edge. The dark lower-right pixels act as the outline.
- Tools and weapons reuse the same stick: the handle enters from the
  bottom-left corner and meets the head or guard around the canvas center.

### Tools and weapons

- Diagonal composition: handle or grip at the bottom-left, working end at the
  top-right, so the item fills the 16×16 diagonal.
- Sword: a blade 3–4 pixels wide measured horizontally, lit edge on the
  upper-left side, shaded edge on the lower-right side, a 1-pixel light spine
  near the lit edge, and a short crossguard perpendicular to the blade just
  above the grip.
- Pickaxe: a narrow head (2–3 pixels thick) arcing across the top and down
  the right side, thinnest at its two tips; the handle meets the head's
  midpoint.
- Keep metal parts on one ramp and wooden parts on another; don't blend them.

### Food and round objects

- Build the round shape from straight runs and clean diagonals, not a
  mathematical circle: consistent steps (1-2-3 or 3-2-1 run lengths) avoid
  jaggies.
- Put a highlight cluster at the upper-left (often 2×2 or an L of 3) and a dark
  crescent along the lower-right.
- Stems and leaves are small, deliberate clusters in their own ramp.

### Gems and crystals

- Facets are flat areas of one shade each; neighbouring facets differ by one
  step. A large white specular sits on the upper-left facet.
- The outline is a dark, hue-shifted version of the gem color (teal for cyan,
  maroon for red), not black.

### Bottles and glass

- Cork or stopper at the top in a wood ramp, a narrow neck, a rounded body.
- Glass reads through a pale blue edge, a few white glints, and gaps; liquid
  fills the lower body with its own darker ramp and a lighter top surface line.

## Worked example

`examples/sword.grid` in this skill is an original sword drawn with these rules:
material outlines lit on the top-left, a 2-pixel stick handle, a blade with a
lit spine, and palette roles that let `mc-asset variant` recolor the blade.
