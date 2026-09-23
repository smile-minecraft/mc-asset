# Anti-patterns — review checklist

Check every texture for these before calling it done. Each entry says what the
problem is, how to spot it, and how to fix it.

## Mixels
Pixels of different sizes in one texture — upscaled parts, a detail drawn at
half size, a scaled-down reference pasted in.
**Fix:** redraw at one texel per pixel. If a detail does not fit 16×16, cut it.

## Black outlines on everything
A uniform `#000000` line around the whole sprite, regardless of material or
light. Reads as generic pixel art, not Minecraft.
**Fix:** outline each material with its own darkest shades, lighter on the
top-left edge, darkest on the bottom-right. Only GUI art uses pure black.

## Pillow shading
Shades applied in concentric rings from dark edges to a bright center,
ignoring the light direction.
**Fix:** shade the form from the top-left light: highlight top-left, shadow
bottom-right, following the object's 3D shape.

## Pancake shading
Highlights stuck along one side and shadows along the other, ignoring the
form (a sphere shaded like a flat plate).
**Fix:** place highlight and shadow where the 3D form turns toward and away
from the light, not along the silhouette.

## Banding
Pixels of successive shades lining up in straight rows, staircases, or
shapes that hug the outline — "fat lines", 45° staircase bands, a shade that
runs parallel to the outline all the way round. It exposes the pixel grid and
misrepresents the shape.
**Fix:** vary the length and position of each shade's clusters so edges of
neighbouring shades do not align. Break long parallel runs.

## Jaggies
Lines and curves whose steps are uneven (1-1-2-1-3), so they look broken.
**Fix:** use consistent step patterns: straight lines with equal runs
(1-1-1, 2-2-2), curves with runs that grow or shrink steadily (1-2-3-3-2-1).
Do not build circles from a distance formula without cleaning the steps.

## Noise
Isolated single pixels that add no information — random speckle, "texture"
made by scattering pixels.
**Fix:** merge into clusters of 2–5 pixels or delete. Keep a lone pixel only
for a deliberate specular glint or a tiny essential detail.

## Unnecessary dithering
Checkerboard patterns covering large areas, used inconsistently, or used where
a new shade would do.
**Fix:** limit dithering to short transitions; otherwise add one ramp step.

## Anti-aliasing against transparency
Semi-transparent or background-colored pixels on the outer edge of an item.
Item textures are cutout, so these render as a dirty fringe.
**Fix:** alpha is only 0 or 255 in item art. Internal AA between two shapes is
allowed in moderation; outer-edge AA is not.

## Too many colors
Near-duplicate shades, gradients with a new color every pixel, 20+ colors in
a 16×16 item.
**Fix:** merge near-duplicates; stay within ~8–12 opaque colors for items and
~4–9 for blocks.

## Oversaturation and flat ramps
Pure fully saturated colors everywhere, or ramps that only change value on
organic materials.
**Fix:** keep saturation strongest in the midtones, drop it at the ends, and
hue-shift organic and warm ramps.

## Tiling artifacts (blocks)
A standout feature or an uneven light distribution that forms a visible grid
when repeated; seams that do not meet at the edges.
**Fix:** check a 3×3 wall; spread features evenly; keep periods that divide 16.

## Wrong composition (items)
A tool or weapon drawn upright or centered small; a round item far smaller
than the canvas.
**Fix:** tools run bottom-left to top-right corner to corner; round items span
about 11–13 pixels.
