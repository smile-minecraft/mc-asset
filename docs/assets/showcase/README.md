# Showcase assets — how they were made

Every file in this directory was produced by **mc-asset itself** (CLI 0.3.1).
No external image tools were used. All procedural sources use fixed seeds, so
the full set below is reproducible end to end. The showcase sources are
deliberately chosen so each effect stays visible at README display size:
high-detail noise for pixelize, a 64-band gradient for quantize, and a
hand-built seamless brick for tiling.

Conventions used in the commands: `OUT=docs/assets/showcase`,
`SCRATCH=/tmp/showcase` (throwaway intermediates only; nothing is read from
outside mc-asset). All upscales use `--resize-mode nearest` to keep pixels
crisp.

## File list

| File | Size (px) | Purpose |
| --- | --- | --- |
| `pixelize-before.png` | 256×256 | Clustered-noise reference, ×2 nearest upscale (the "before") |
| `pixelize-after.png` | 256×256 | Same reference run through `pixelize` to 16px, then ×16 nearest (the "after") |
| `quantize-source.grid` | 64×64 ASCII grid | Hand-built source: 64 horizontal bands, deep blue → purple → warm gold |
| `quantize-before.png` | 256×256 | The 64-band gradient, ×4 nearest upscale (the "before") |
| `quantize-after.png` | 256×256 | Same gradient through `quantize --colors 8`, then ×4 (the "after") |
| `variant-iron.png` / `variant-gold.png` / `variant-wood.png` / `variant-crystal.png` | 64×64 each | One 16px spots swatch recolored into four builtin materials, ×4 nearest |
| `tile-source.grid` | 32×32 ASCII grid | Hand-built running-bond brick: the tile source |
| `tile-pattern.png` | 128×128 | The 32px hand-built source, ×4 nearest (the tile source) |
| `tile-preview-2x2.png` | 256×256 | 2×2 repeat preview of the 32px source (64px preview, ×4 nearest) |
| `anim/frame-1.grid` … `anim/frame-4.grid` | 16×16 ASCII grids | Hand-authored "central glow pulse" frames |
| `anim-sheet.png` | 64×256 | The four frames packed vertically (16×64 sheet), ×4 nearest |

## 1. Pixelize before / after

Base: `clustered-noise`, 128px, seed 7, palette `crystal` — a high-detail
swatch whose finest cells are 4px wide. The before is a ×2 nearest upscale;
the after goes through `pixelize` (preset `block`) down to 16px and back up
×16, so the 4px clusters merge into visibly coarser blocks. Size 32 was
tried first but rejected: 128/32 = 4 aligns exactly with the 4px cells, so
the round trip came back byte-identical to the before.

```sh
mc-asset generate clustered-noise --size 128 --seed 7 --palette crystal \
  --output $SCRATCH/px-base.png --source $SCRATCH/px-base.mcpx
mc-asset transform $SCRATCH/px-base.png --resize 256x256 --resize-mode nearest \
  --output $OUT/pixelize-before.png
mc-asset pixelize $SCRATCH/px-base.png --size 16 --preset block \
  --output $SCRATCH/px-16.png
mc-asset transform $SCRATCH/px-16.png --resize 256x256 --resize-mode nearest \
  --output $OUT/pixelize-after.png
```

## 2. Quantize before / after

Source: `quantize-source.grid`, a 64×64 `[grid tokens]` grid with one solid
color per row — 64 bands interpolating deep blue `#16245E` → purple
(mid-range) → warm gold `#F5C04A` in piecewise-linear RGB.
Single-character symbols cap at 63, so the grid uses tokenized `c00`…`c63`
symbols. Rendered with `render` to 64×64, then ×4 nearest for display; the
after passes through `quantize --colors 8` first, collapsing the 64 bands
into 8.

```sh
mc-asset render $OUT/quantize-source.grid \
  --output $SCRATCH/q64.png --source $SCRATCH/q64.mcpx
mc-asset transform $SCRATCH/q64.png --resize 256x256 --resize-mode nearest \
  --output $OUT/quantize-before.png
mc-asset quantize $SCRATCH/q64.png --colors 8 --output $SCRATCH/q8.png
mc-asset transform $SCRATCH/q8.png --resize 256x256 --resize-mode nearest \
  --output $OUT/quantize-after.png
```

## 3. Material variants

Base: `spots`, 16px, seed 11, palette `stone` (kept as editable `.mcpx`),
recolored into exactly `iron,gold,wood,crystal`. Each 16px variant is
upscaled ×4 to 64×64. Dominant recolor tones: iron `#D7DCE2`, gold
`#F9DC7E`, wood `#D0A266`, crystal `#C3CDF5` (over transparency).

```sh
mc-asset generate spots --size 16 --seed 11 --palette stone \
  --output $SCRATCH/spots16.png --source $SCRATCH/spots16.mcpx
mc-asset variant $SCRATCH/spots16.mcpx \
  --materials iron,gold,wood,crystal --output-dir $SCRATCH/variants
for m in iron gold wood crystal; do
  mc-asset transform $SCRATCH/variants/spots16_${m}.png \
    --resize 64x64 --resize-mode nearest --output $OUT/variant-${m}.png
done
```

## 4. Tile pattern and 2×2 preview

Source: `tile-source.grid`, a hand-built 32×32 `[grid]` brick in running
bond, using the stone trio — mortar `#17171A`, even courses `#A3A3AB`, odd
courses `#E8E8EE`. Every period divides 32 so the source tiles natively,
with no edge-match or brightness-match corrections:

- Vertical: 3px brick + 1px mortar × 8 courses (32 ÷ 4 = 8). One course
  straddles the top/bottom edge (rows 31, 0, 1), so the top and bottom
  lines are byte-equal and the 4px rhythm continues across the boundary.
- Horizontal: 7px brick + 1px mortar, period 8 (32 ÷ 8 = 4 repeats per
  row); odd courses shift by 4. Mortar sits at `x % 8 == 2` on even
  courses and `x % 8 == 6` on odd courses, so both edges fall mid-brick
  and the left and right lines are byte-equal; the 7+1 rhythm continues
  across the boundary (5 + 2 bricks on even courses, 1 + 6 on odd).

Rendered with `render` to 32×32, displayed ×4 nearest (128px); the 2×2
preview is tiled from the same 32px source (64px) and shown ×4 (256px).
Seam analysis of the source is printed by the `tile` call itself:
seam=h:0.000000 v:0.000000 c:0.000000, tileFriendly=true. (The earlier
`generate brick` source is retired: its 2px-brick + 1px-mortar rhythm has
period 3, and 32 is not divisible by 3, so the vertical join dropped a
mortar line. Edge-matching could zero the score but could not restore the
rhythm, so the source was redrawn by hand instead.)

```sh
mc-asset render $OUT/tile-source.grid \
  --output $SCRATCH/tile32.png --source $SCRATCH/tile32.mcpx
mc-asset tile $SCRATCH/tile32.png
mc-asset transform $SCRATCH/tile32.png --resize 128x128 --resize-mode nearest \
  --output $OUT/tile-pattern.png
mc-asset tile $SCRATCH/tile32.png --preview 2x2 \
  --output $SCRATCH/tile-preview64.png
mc-asset transform $SCRATCH/tile-preview64.png --resize 256x256 --resize-mode nearest \
  --output $OUT/tile-preview-2x2.png
```

Rhythm check (the acceptance test for the join): ASCII-read the 64px
preview and confirm the mortar lines keep their 4px rhythm across the
tile boundary at rows 31/32 — three brick rows, one mortar row, no
double-height brick band where the tiles meet.

## 5. Animation: glow pulse sheet

Four hand-authored 16×16 grids (`anim/frame-1.grid` … `anim/frame-4.grid`)
show a central glow pulse on a dark `#14141C` ground: frame 1 is a 2×2 white
core; frame 2 adds a `#4FD3D3` ring; frame 3 adds a `#2F9E9E` outer ring;
frame 4 is full bloom (`#A9F1EC` mid ring, brighter outer rings). Rendered
with `render`, packed vertically with `animate pack` (16×64 sheet), then ×4
nearest to 64×256.

```sh
for i in 1 2 3 4; do
  mc-asset render $OUT/anim/frame-$i.grid \
    --output $SCRATCH/frame-$i.png --source $SCRATCH/frames/frame-$i.mcpx
done
mc-asset animate pack --frames-dir $SCRATCH/frames --layout vertical \
  --output $SCRATCH/sheet-16x64.png
mc-asset transform $SCRATCH/sheet-16x64.png --resize 64x256 --resize-mode nearest \
  --output $OUT/anim-sheet.png
```

## Verification (spot checks)

```sh
mc-asset analyze $OUT/pixelize-after.png      # 256x256, 7 colors, solid
mc-asset analyze $OUT/quantize-before.png     # 256x256, 64 colors, solid
mc-asset analyze $OUT/quantize-after.png      # 256x256, 8 colors, solid
mc-asset analyze $OUT/variant-iron.png        # 64x64, cutout, 2 colors
mc-asset analyze $OUT/tile-pattern.png        # 128x128, 3 colors, solid
mc-asset analyze $OUT/tile-preview-2x2.png    # 256x256, 3 colors, solid
mc-asset analyze $OUT/anim-sheet.png          # 64x256, 5 colors, solid
mc-asset preview $OUT/variant-iron.png --ascii  # ASCII readout: non-blank artwork
```

Size note: the 256×256 display files are ~256KB each. That is the known
standing exception — the deterministic encoder writes these uncompressed —
and it applies to `pixelize-before.png`, `pixelize-after.png`,
`quantize-before.png`, `quantize-after.png`, and `tile-preview-2x2.png`.
All other files stay under 100KB.
