# Commands and their MCP tools

The CLI and the MCP server share one engine. The authoritative surfaces are
`docs/cli-surface.md` and `docs/mcp-surface.md` in the mc-asset repository;
this table is the working summary.

| CLI | MCP tool | Use it for |
| --- | --- | --- |
| `render <grid>` | `render_pixel_asset` (`gridPath` or `gridText`) | `.grid` → PNG and/or `.mcpx` |
| `build [source]` | `build_asset` | `.mcpx` → PNG, optionally with a batch |
| — | `apply_asset_operations` | batch edits on a `.mcpx`, with optional visual `feedback` |
| `import <image>` | `import_asset` | PNG / JPEG / WebP → canvas / `.mcpx` |
| `pixelize <image>` | `pixelize_asset` | reference art → 16px pixel art (`--preset item\|block\|gui\|particle\|generic`) |
| `generate <pattern>` | `generate_asset` | seeded procedural swatch |
| `transform <input>` | `transform_asset` | one of flip, rotate, crop, pad, resize, translate |
| `quantize <input>` | `quantize_asset` | reduce to N colors |
| `cleanup <input>` | `cleanup_asset` | detect or fix `isolated`, `noise`, `cluster`, `fringe`, `outlier`, `hole`, `aa` |
| `recolor <source>` | `recolor_asset` | one material ramp, optionally a region |
| `variant <source>` | `create_variants` | many materials into an output folder |
| `palette extract\|inspect` | `palette_asset` | color reports |
| `material list\|show` | `material_asset` | the built-in ramps |
| `tile <input>` | `tile_asset` | seam scores, edge match, tiled preview |
| `preview <input>` | `preview_asset` | `--ascii`, `--palette-map`, `--scale N`, `--nine-slice` |
| `inspect <input>` | `inspect_asset` | layer/region structure, or a composited `view` image |
| `gui-scale <input>` | `scale_gui_asset` | stretch / tile / nine_slice scaling from an mcmeta |
| `animate pack\|unpack\|reorder\|resize\|validate\|preview` | `animate_asset` | animation strips |
| `analyze <image>` | `analyze_asset` | size, colors, alpha class, heuristics |
| `validate <asset>` | `validate_asset` | one texture (+ `--mcmeta`) against a profile |
| `validate-pack <path>` | `validate_pack_asset` | a whole resource pack |

## Reviewing a texture

- `analyze` prints the color count (transparent included), the alpha class
  (`solid`, `cutout`, `translucent`), and dominant colors. For item art the
  alpha class must be `cutout` with `partial=0`.
- `--json palette inspect` gives every color with its pixel count — useful to
  find near-duplicates and to check ramp balance.
- `--json cleanup <in> --output <tmp>` without `--fix` reports `detected`
  counts per defect class and writes an unchanged copy. Non-zero `isolated`
  or `noise` means lone pixels to look at; some are deliberate glints.
- `preview --ascii` returns the image as a `.grid`, which you can diff against
  the source you meant to draw.
- `tile` prints `seam=h:… v:… c:…` (lower is smoother) and a `repeat` score;
  `--preview 2x2|4x4|8x8 --output wall.png` writes the repeated wall.

## Built-in materials

`material list` → `iron`, `copper`, `oxidized_copper`, `gold`, `wood`,
`stone`, `crystal`. Each has seven entries (outline, shadow, dark, base,
light, highlight, accent); `recolor` uses shadow, base, and highlight.
`generate --palette <material>` also accepts these names.

## Procedural patterns

`generate` patterns: `noise`, `clustered-noise`, `stripes`, `checker`,
`gradient`, `brick`, `spots`, `veins`, `cracks`, `grain`. Output is a starting
point: vanilla-style blocks still need hand-placed seams, light, and cluster
cleanup (see the minecraft-pixel-art skill, `references/blocks.md`).

## Batch operations

`--operations ops.json` (CLI `import` / `render` / `build`) and
`apply_asset_operations` take a JSON array. Pixel operations: `setPixel`,
`clearPixel`, `drawLine`, `drawRect`, `fillRect`, `floodFill`, `ellipse`,
`polygonFill`, `strokeMask`; plus layer, region, `stampRect`, and
`regionFromSelection` operations. Batches are atomic by default: one failure
rolls everything back. Pixel operations accept a `selection`: `all`,
`rect:<x>,<y>,<w>,<h>`, `region:<id>`, `alpha[:<layerId>]`,
`color[:<layerId>]:<r>,<g>,<b>,<a>`, `connected[:<layerId>]:<x>,<y>`, or a
JSON expression object.

Prefer editing the `.grid` and re-rendering for hand-drawn art; use batches
for mechanical edits (fill a region, stamp a detail, draw a guide line) and
when an MCP client should see the diff via `feedback`.
