# CLI Surface Specification

[English](cli-surface.md) | [繁體中文](cli-surface.zh-TW.md) | [简体中文](cli-surface.zh-CN.md)

Entry point: `mc-asset` (or `bun src/cli/index.ts` during local development).

Global behavior follows deterministic standards (channels, `OUTPUT_EXISTS`/`--force`/`--mkdir`, atomic writes, `--force`/`--in-place` mutual exclusion) and standardized exit codes via the `src/core/errors.ts` registry.

---

## Global Flags

```text
--json       Emit structured JSON envelope to stdout (or stderr if artifact is to stdout)
--help       Print help and exit (code 0)
--version    Print toolchain version (code 0)
```

---

## Common File Flags (File-Producing Commands)

All commands that produce or modify files adhere to strict path and safety rules:

```text
--output <path>   Explicit output file path (no implicit filenames)
--stdout          Artifact bytes written to stdout (envelope and logs route to stderr)
--force           Allow overwriting an existing target (otherwise OUTPUT_EXISTS, exit 4)
--mkdir           Create missing parent directories (otherwise FILESYSTEM_ERROR, exit 4)
--in-place        Target the input path directly (mutually exclusive with --force)
--input <path>    Input path backing --in-place when not provided as positional argument
--profile <name>  Asset profile: generic | minecraft:item | minecraft:block | minecraft:gui | minecraft:particle
```

### Safety & Filesystem Guarantees

- **Explicit Targets Required**: Omitting `--output`, `--stdout`, `--source`, or `--in-place` on a file-producing command raises `OUTPUT_REQUIRED` (exit 2) and creates zero files.
- **Normalized Path Comparison**: Target paths are resolved to absolute normalized paths folded with Unicode NFC and case-folding. Aliasing the input without `--in-place` or defining duplicate output targets raises `ARGUMENT_CONFLICT` (exit 2) before any bytes land.
- **Per-File Atomic Commit**: Each output file is staged in an exclusive temporary file (`O_EXCL`) in the target directory and committed via atomic rename. Failed writes leave no partial artifacts.
- **Minecraft Profile Constraints**: Minecraft texture profiles (`minecraft:item`, `minecraft:block`, `minecraft:gui`, `minecraft:particle`) require `.png` outputs. Non-PNG extensions fail with `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT` (exit 5).

---

## Command Reference

### 1. Intake, Authoring & Source Build

| Command | Input | Output | Description |
|---|---|---|---|
| `import <image>` | Raster file (PNG, JPEG, WebP) | PNG and/or `.mcpx` | Decodes raster formats into Pixel Canvas. |
| `render <grid>` | ASCII Grid file (`.grid`) | PNG and/or `.mcpx` | Compiles human/Agent-authored ASCII grids. |
| `build [source]` | `.mcpx` source file or stdin (`--stdin`) | PNG and/or `.mcpx` | Builds editable source files into textures or re-serializes source. |

```text
import <image> [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
render <grid>  [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
build  [source] [--stdin] [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
```

- `--source <path>` saves the editable `.mcpx` text source.
- `--in-place` rewrites the input file in-place (implies force for that target).
- `build --stdin` together with `--operations -` is `ARGUMENT_CONFLICT`.

---

### 2. Spatial & Geometric Transformations

| Command | Input | Output | Description |
|---|---|---|---|
| `transform <input>` | PNG, JPEG, WebP, `.mcpx` | PNG and/or `.mcpx` | Spatial transformations: flip, rotate, crop, pad, resize, translate. |

```text
transform <input> [--flip <h|v>] [--rotate <90|180|270>] [--crop <x,y,w,h>]
                  [--pad <l,t,r,b>] [--pad-color <hex|transparent>]
                  [--resize <WxH>] [--resize-mode <nearest|box|pixel-aware>]
                  [--translate <dx,dy>] [--selection <scope>] <file flags>
```

- Exactly **one** geometry flag allowed per invocation; combining multiple flags raises `ARGUMENT_CONFLICT`.
- `--selection` scopes operations to a selection expression: `all`, `rect:x,y,w,h`, `region:id`, `alpha[:layer]`, `color[:layer]:r,g,b,a`, `connected[:layer]:x,y`, or a JSON expression object `{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}` (a leading `{` enters the JSON path; anything else parses as an atom). Geometry operations combined with `--selection` raise `ARGUMENT_CONFLICT`.

---

### 3. Palette, Quantization & Cleanup

| Command | Input | Output | Description |
|---|---|---|---|
| `quantize <input>` | PNG, JPEG, WebP, `.mcpx` | PNG and/or `.mcpx` | Reduces distinct colors to a target count. |
| `cleanup <input>` | PNG, JPEG, WebP, `.mcpx` | PNG and/or `.mcpx` | Detects or eliminates isolated, noise, or outlier pixels. |
| `palette extract <image>` | PNG, JPEG, WebP, `.mcpx` | Report only | Extracts unique RGBA colors from the image. |
| `palette inspect <image>` | PNG, JPEG, WebP, `.mcpx` | Report only | Analyzes palette distribution, roles, and contrast. |
| `material list` | None | Report only | Lists available built-in material definitions. |
| `material show <name>` | None | Report only | Inspects color ramps and definitions for a material. |
| `recolor <source>` | `.mcpx` | PNG and/or `.mcpx` | Remaps colors to a built-in material palette. |
| `variant <source>` | `.mcpx` | Multi-file under `--output-dir` | Generates material variants (e.g. iron, copper, gold). |

```text
quantize <input> --colors <N> [--selection <scope>] <file flags>
cleanup  <input> [--fix <classes>] [--allow-render-pass-change] [--selection <scope>] <file flags>
recolor  <source> --material <name> [--region <id>] <file flags>
variant  <source> --materials <a,b,...> --output-dir <dir> [--mkdir] [--force] [--profile <p>]
```

- `cleanup --fix <classes>`: Comma-separated list (`isolated`, `noise`, `cluster`, `fringe`, `outlier`, `hole`, `aa`). Modifying alpha-affecting classes requires `--allow-render-pass-change`.
- `palette` and `material` subcommands are read-only reports and reject file write flags (`INVALID_ARGUMENT`).

---

### 4. Pixel Art Pipeline

| Command | Input | Output | Description |
|---|---|---|---|
| `pixelize <image>` | PNG, JPEG, WebP | PNG and/or `.mcpx` | Deterministic 11-stage raster-to-pixel-art pipeline. |

```text
pixelize <image> --size <N|WxH> [--preset <item|block|gui|particle|generic>] <file flags>
```

- Target `--size` is required (standard Minecraft squares: 16, 32, 64, 128, or custom `WxH`).
- Preset sets the color budget, cleanup heuristics, and which pipeline stages run for an asset role. The `item` preset enables the crop, background, subject, edge, and cluster stages; all other presets keep their existing output byte-identical. The input is a single raster (never `.mcpx`); the five stages run over that one layer.

---

### 5. Procedural Generation, Tiles & Previews

| Command | Input | Output | Description |
|---|---|---|---|
| `tile <input>` | PNG, JPEG, WebP, `.mcpx` | Report only, or PNG | Seam analysis, edge repetition analysis, or tile fix/preview. |
| `generate <pattern>` | None | PNG and/or `.mcpx` | Deterministic procedural texture generator. |
| `preview <input>` | PNG, JPEG, WebP, `.mcpx` | Report only, or PNG | ASCII preview, palette map, 9-slice guide, or nearest upscale. |
| `gui-scale <input>` | PNG, JPEG, WebP, `.mcpx` | PNG | Scales a GUI sprite to an explicit target size with the mcmeta stretch/tile/nine_slice mapping. |

```text
tile     <input> [--preview <2x2|4x4|8x8>] [--edge-match <axis>] [--brightness-match <axis>]
                  [--output <png>] [--stdout] <file flags>
generate <pattern> --size <N|WxH> --palette <name|path> --seed <int>
                  [--output <png>] [--source <mcpx>] [--stdout] <file flags>
preview  <input> --ascii | --palette-map | --scale <N> | --nine-slice --mcmeta <path>
                  [--output <png>] [--stdout] <file flags>
gui-scale <input> --size <N|WxH> [--mcmeta <path>]
                  [--minecraft-version <v>|--resource-pack-version <f>]
                  [--output <png>] [--stdout] <file flags>
```

- `generate` supports deterministic patterns (`noise`, `clustered-noise`, `stripes`, `checker`, `gradient`, `brick`, `spots`, `veins`, `cracks`, `grain`) seeded via `--seed` (integer 0–4294967295).
- `preview` requires exactly one mode flag:
  - `--ascii`: Outputs `.grid`-compatible plain ASCII text representation.
  - `--palette-map`: Emits JSON palette indexing.
  - `--scale <N>`: Nearest-neighbor upscale PNG output.
  - `--nine-slice`: Evaluates GUI 9-slice borders from `.mcmeta` with visual guides.
- `gui-scale` maps a GUI sprite to an explicit target size with the `.mcmeta` `gui.scaling` stretch/tile/nine_slice rules:
  - `--mcmeta` is an explicit path and is never derived from a same-named sibling; omitting it means `stretch`.
  - Output is PNG only.
  - Illegal nine_slice borders are `INVALID_MCMETA` (exit 2).
  - When the target predates `stretch_inner` (resource-pack format 42) and the field is true, it is ignored with a `STRETCH_INNER_IGNORED` warning.
  - The existing `preview --nine-slice` stays a guide preview; the two are separate entries.

---

### 6. Animation & Sprite Sheets

| Command | Input | Output | Description |
|---|---|---|---|
| `animate pack` | Frames directory (`.mcpx`) | PNG sprite sheet | Combines individual frames into a sprite sheet. |
| `animate unpack <sheet>` | PNG sprite sheet | Frames directory (`.mcpx`) | Slices an animation sheet into individual frames. |
| `animate reorder` | Frames directory | Frames directory | Re-sequences animation frames according to index list. |
| `animate resize` | Frames directory | Frames directory | Rescales all frames in an animation set. |
| `animate validate` | Frames directory (+ `.mcmeta`) | Report only | Validates frame dimensions, playback-sequence indices, and per-step times against `.mcmeta`; repeated or partial playback sequences are legal. |
| `animate preview` | Frames directory | Report or ASCII preview | Previews animation sequence. |

```text
animate pack     --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns <N>]
                 [--output <png>] [--stdout] <file flags>
animate unpack   <sheet.png> --layout <vertical|horizontal|grid> --frame-size <N|WxH>
                 [--columns <N>] [--mcmeta <path>] --output-dir <dir> <file flags>
animate reorder  --frames-dir <dir> --order <i,j,...> --output-dir <dir> <file flags>
animate resize   --frames-dir <dir> --frame-size <N|WxH> [--resize-mode <nearest|box|pixel-aware>]
                 --output-dir <dir> <file flags>
animate validate --frames-dir <dir> [--mcmeta <path>] [--profile <name>] [--json]
animate preview  --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns <N>]
                 [--ascii] [--profile <name>] [--json]
```

---

### 7. Inspection, Validation & Pack Verification

| Command | Input | Output | Description |
|---|---|---|---|
| `analyze <image>` | PNG, JPEG, WebP | Report only | Structural and color metrics (predicted classification). |
| `validate <asset>` | Asset file (PNG) | Report only (exit 3 on defect) | Validates single asset texture and optional `.mcmeta`. |
| `validate-pack <path>` | Resource Pack root directory | Report only (exit 3 on defect) | Full scan of resource pack integrity, namespaces, models, textures, and atlases. |

```text
analyze       <image> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
validate      <asset> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--mcmeta <path>] [--json]
validate-pack <path>  [--minecraft-version <v>] [--resource-pack-version <n>]
                       [--vanilla <path>] [--dependency <path>]... [--json]
```

- Validation exit behavior: Exit 0 on pass; Exit 3 (`VALIDATION_FAILED`) when validation checks fail; Exit 2 on invocation syntax error; Exit 4 on filesystem error.
- Version targeting: `--minecraft-version` accepts release versions `1.19.3` through `26.3` (for example `1.19.3`, `1.21.4`, `26.3`; each release maps to its resource-pack format); `--resource-pack-version` accepts `N` or `N.M` (e.g. `84`, `97.1`) and normalizes to `major.minor`. The two flags are mutually exclusive, and omitting both keeps engine defaults.
- Version echo: human reports print `target: minecraft <v> / resource-pack <f>`, `target: resource-pack <f>`, or `target: default (engine defaults)`; `--json` carries `version: { minecraftVersion?, resourcePackVersion? }` with normalized dotted strings.
- No-flag resolution: `validate-pack` without a version flag reads the root `pack.mcmeta` for `pack.max_format`, then `pack.min_format`, then legacy `pack.pack_format` (integer, `[major, minor]` array, or dotted string, normalized to `major.minor`); the resolved target prints as `pack.mcmeta resource-pack <f>`. `supported_formats` is ignored for targeting, and with no usable value the scan warns once (`PACK_VERSION_UNDETERMINED`) and applies no default.
- `--vanilla`: caller-provided vanilla resource tree (pack-root shape, including `assets/`). Once provided, `minecraft`-namespace references are confirmed against that tree; without it they report a `PACK_UNRESOLVED_EXTERNAL` warning and a coverage entry instead of a missing-asset error.
- `--dependency`: dependency pack roots, repeatable; the first occurrence has the highest priority.
- Coverage: `validate` and `validate-pack` reports carry `coverage: {status, skipped}`; `partial` means some checks were skipped (for example `vanilla-not-provided`, `unsupported-source-type`, `unsupported-regex`, `unknown-node-type`, `renderer-fields-not-interpreted`, `version-undetermined`, `model-documents-not-loaded`), each skip with `kind` / `reason` / `target`. Coverage never changes the exit code (pass stays 0, fail stays 3). Texture-variable resolution reads the current pack's model documents only; a variable that leaves them is reported as `model-documents-not-loaded` coverage instead of being resolved across dependency or vanilla packs.

---

### 8. Model Context Protocol (MCP) Server

```text
mc-asset mcp
```

Runs the native Model Context Protocol (MCP) stdio server for LLM agent integration. Provides 20 native tools without subprocess spawning:
- `analyze_asset`
- `pixelize_asset`
- `render_pixel_asset`
- `apply_asset_operations`
- `recolor_asset`
- `create_variants`
- `validate_asset`
- `import_asset`
- `build_asset`
- `transform_asset`
- `quantize_asset`
- `cleanup_asset`
- `palette_asset`
- `material_asset`
- `tile_asset`
- `generate_asset`
- `preview_asset`
- `animate_asset`
- `validate_pack_asset`
- `scale_gui_asset`

---

## Batch Operations Specification (`--operations`)

Batch pixel edits can be applied to `import`, `render`, and `build` via `--operations <path>` or `--operations -` (stdin).

Format is JSON array of operations:
```json
[
  { "type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF" },
  { "type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF" },
  { "type": "drawRect", "rect": { "x": 2, "y": 2, "width": 4, "height": 4 }, "color": "#0000FFFF" },
  { "type": "fillRect", "rect": { "x": 8, "y": 8, "width": 4, "height": 4 }, "color": "#FFFF00FF" },
  { "type": "floodFill", "x": 3, "y": 3, "color": "#FF00FFFF" },
  { "type": "clearPixel", "x": 0, "y": 0 }
]
```

The same JSON shape is accepted by `apply_asset_operations` on the MCP surface: a bare array or an `{"operations": [...]}` envelope; an empty array is a valid no-op. Every operation accepts an optional string `id` (unique within one batch). `layerId` defaults to the sole layer on single-layer canvases; set it explicitly when the canvas has more than one layer (`regionFromSelection`, `mergeLayer`, and the region operations take no `layerId`). Colors are `transparent`, `#RRGGBB`, or `#RRGGBBAA`; coordinates are integers, never rounded.

The six pixel operations accept an optional `selection` (a selection-expression atom string or object, same grammar as `--selection`). Only selected pixels are written; every unselected raw byte is restored verbatim, including hidden RGB under alpha 0. `fillRect` may omit `rect` when `selection` is present (the fill covers the selection bounds, clipped by the selection). A selection that matches no pixels refuses the write with `EMPTY_SELECTION` and rolls the batch back; the `quantize` / `cleanup` / `recolor` `--selection` paths keep their existing restore behavior instead.

| `type` | Required keys | Optional keys | Example |
|---|---|---|---|
| `setPixel` | `x`, `y`, `color` | `layerId`, `selection`, `id` | `{"type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF"}` |
| `clearPixel` | `x`, `y` | `layerId`, `selection`, `id` | `{"type": "clearPixel", "x": 0, "y": 0}` |
| `drawLine` | `from`, `to`, `color` | `layerId`, `selection`, `id` | `{"type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF"}` |
| `drawRect` | `rect`, `color` | `layerId`, `selection`, `id` | `{"type": "drawRect", "rect": {"x": 2, "y": 2, "width": 4, "height": 4}, "color": "#0000FFFF"}` |
| `fillRect` | `color` (`rect` required unless `selection` is present) | `layerId`, `rect`, `selection`, `id` | `{"type": "fillRect", "rect": {"x": 8, "y": 8, "width": 4, "height": 4}, "color": "#FFFF00FF"}` |
| `floodFill` | `x`, `y`, `color` | `layerId`, `selection`, `id` | `{"type": "floodFill", "x": 3, "y": 3, "color": "#FF00FFFF"}` |
| `createLayer` | (none) | `layerId` (new id), `name`, `id` | `{"type": "createLayer", "layerId": "shade"}` |
| `removeLayer` | `layerId` | `id` | `{"type": "removeLayer", "layerId": "shade"}` |
| `renameLayer` | `layerId`, `name` | `id` | `{"type": "renameLayer", "layerId": "shade", "name": "shadow"}` |
| `reorderLayer` | `layerId`, `toIndex` | `id` | `{"type": "reorderLayer", "layerId": "shade", "toIndex": 0}` |
| `duplicateLayer` | `layerId` | `newLayerId`, `name`, `id` | `{"type": "duplicateLayer", "layerId": "shade", "newLayerId": "shade-copy"}` |
| `mergeLayer` | `sourceId`, `targetId` | `id` | `{"type": "mergeLayer", "sourceId": "shade", "targetId": "base"}` |
| `clearLayer` | `layerId` | `id` | `{"type": "clearLayer", "layerId": "shade"}` |
| `fillLayer` | `layerId`, `color` | `id` | `{"type": "fillLayer", "layerId": "shade", "color": "#0000FFFF"}` |
| `moveLayer` | `layerId`, `dx`, `dy` | `id` | `{"type": "moveLayer", "layerId": "shade", "dx": 1, "dy": -1}` |
| `createRegion` | (none) | `regionId` (new id), `name`, `id` | `{"type": "createRegion", "regionId": "mask"}` |
| `removeRegion` | `regionId` | `id` | `{"type": "removeRegion", "regionId": "mask"}` |
| `renameRegion` | `regionId`, `name` | `id` | `{"type": "renameRegion", "regionId": "mask", "name": "cutout"}` |
| `reorderRegion` | `regionId`, `toIndex` | `id` | `{"type": "reorderRegion", "regionId": "mask", "toIndex": 0}` |
| `setRegionPixel` | `regionId`, `x`, `y`, `value` | `id` | `{"type": "setRegionPixel", "regionId": "mask", "x": 1, "y": 2, "value": 1}` |
| `stampRect` | `layerId`, `source`, one of `to` / `offset` | `transform` (`flip`: `h` / `v`; `rotate`: `0` / `90` / `180` / `270`), `merge` (`replace` default / `source-over`), `carryRegions` (default false), `selection`, `id` | `{"type": "stampRect", "layerId": "base", "source": "rect:8,8,8,8", "offset": {"dx": 0, "dy": 8}}` |
| `regionFromSelection` | `selection`, `mode` (`create` / `update`) | `regionId`, `name`, `id` | `{"type": "regionFromSelection", "selection": "alpha:base", "mode": "create", "regionId": "body"}` |

`from`/`to` are `[x, y]` integer pairs; `rect` is `{x, y, width, height}` with width and height at least 1; `toIndex` is 0 or a positive integer; `value` is `0` (outside) or `1` (inside). `stampRect` copies the `source` read scope without clearing it (`source` decides what is read, `selection` only clips the write; `to` pins the transformed output's top-left, `offset` shifts it relative to the source bounds, and passing both is `ARGUMENT_CONFLICT`). Unknown `type` values are `INVALID_ARGUMENT`; duplicate `id` values are `DUPLICATE_OPERATION_ID`.

Batch execution is atomic: the first invalid operation rolls back all changes.

---

## Exit Code Registry

| Code | Category | Meaning | Examples |
|---|---|---|---|
| **0** | Success | Command completed successfully. | Clean validation, successful render. |
| **1** | Internal Error | Unhandled engine defect (`INTERNAL_ERROR`). | Unexpected engine failure. |
| **2** | Invalid Invocation | Syntax error, conflicting flags, missing required parameters. | Missing `--output`, conflicting `--force --in-place`. |
| **3** | Asset Validation Failure | Engine executed properly, but the asset or pack failed validation. | `VALIDATION_FAILED`, broken textures, bad `.mcmeta`. |
| **4** | Filesystem Refusal | File exists without `--force`, missing directories without `--mkdir`. | `OUTPUT_EXISTS`, `FILESYSTEM_ERROR`. |
| **5** | Unsupported / Resource Limit | Input format not supported, canvas limits exceeded. | Corrupt image header, `UNSUPPORTED_IMAGE_FORMAT`. |
