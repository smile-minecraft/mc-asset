# GUI sprites

The Java GUI is a flat, bevelled, light-gray style with pure-black outlines. It
does not follow the item rules: here black is correct.

## Measured vanilla container panel

Colors measured from the vanilla container background:

| Part | Color |
| --- | --- |
| Outline | `#000000` |
| Top-left bevel (2px) | `#FFFFFF` |
| Panel fill | `#C6C6C6` |
| Bottom-right bevel (2px) | `#555555` |
| Slot fill | `#8B8B8B` |
| Slot top-left edge (1px) | `#373737` |
| Slot bottom-right edge (1px) | `#FFFFFF` |

Structure of the panel border, from the outside in:

- A 1px black outline with **cut corners**: the corner steps in by two pixels
  (row 0 starts at x=2, row 1 at x=1), so the panel looks rounded.
- A 2px white bevel along the top and left, with one extra white pixel filling
  the inner corner so the bevel turns smoothly.
- A 2px `#555555` bevel along the bottom and right, mirrored the same way.
- The flat `#C6C6C6` fill.

Slots are *inset*: dark on the top-left, white on the bottom-right — the
opposite of the panel's raised bevel. The two corner pixels where the dark and
white edges meet take the slot fill color.

## Sizes and locations (1.20.2 and later)

- Sprites live under `textures/gui/sprites/` in subfolders: `hud/`, `widget/`,
  `container/`, `tooltip/`, `boss_bar/`, …
- Hotbar 182×22; hotbar selection frame 24×24; hearts 9×9; crosshair 15×15;
  XP bar 182×5.
- Container screens are drawn on a 256×256 sheet; the inventory uses the
  176×166 region at the top-left.
- Before 1.20.2 the GUI lived in atlases (`gui/icons.png`, `gui/widgets.png`).

## Nine-slice scaling

A sprite's `.mcmeta` can declare how it stretches:

```json
{ "gui": { "scaling": { "type": "nine_slice", "width": 16, "height": 16, "border": 4 } } }
```

- The corners (the `border` pixels on each side) copy 1:1, the edges tile
  (or stretch with `stretch_inner: true`), and the center fills the rest.
- Keep everything that must not distort — the cut corner, the bevel turn —
  inside the border. A 4px border fits the vanilla outline + 2px bevel + 1px of
  fill.
- The edge and center strips should be uniform along their length so tiling is
  invisible.
- Check the sprite at the size it will actually be used, not only at its
  source size.

## Style notes

- Keep GUI art flat: no gradients, no noise, no hue shifting.
- Text areas and slots need the flat fill; decoration belongs in the border.
- Buttons use the same bevel logic: raised (light top-left) at rest, inset
  when pressed.
