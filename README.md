# mc-asset

[![CI](https://img.shields.io/github/actions/workflow/status/smile-minecraft/mc-asset/ci.yml?branch=main)](https://github.com/smile-minecraft/mc-asset/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/releases)
[![License](https://img.shields.io/github/license/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/mc-asset)](https://www.npmjs.com/package/mc-asset)

[English](https://github.com/smile-minecraft/mc-asset/blob/main/README.md) | [繁體中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-TW.md) | [简体中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-CN.md)

![mc-asset banner](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/banner.png)

A pixel-native 2D asset engine and deterministic CLI/MCP toolchain for Minecraft Java Edition resource packs, built for human creators and AI coding agents.

Language models can't place pixels by eye, so `mc-asset` turns texture work into text and commands. Draw a sprite as a character grid, pixelize reference art, generate tiling textures, pack animation sheets, and validate a whole resource pack, from a shell or over MCP. The same input and seed always produce the same bytes.

---

## Contents

- [Highlights](#highlights)
- [Showcase](#showcase)
- [Installation](#installation)
- [For AI agents](#for-ai-agents)
- [Quickstart](#quickstart)
- [Practical Recipes](#practical-recipes)
- [MCP Server](#mcp-server)
- [Command Reference](#command-reference)
- [Batch Operations (`--operations`)](#batch-operations---operations)
- [Architecture & Reliability Guarantees](#architecture--reliability-guarantees)
- [Development](#development)
- [License](#license)

---

## Highlights

- **Text in, texture out.** Sprites are character grids (`.grid`) or editable multi-layer sources (`.mcpx`) that build to PNG. See [`docs/mcpx-format.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcpx-format.md).
- **Reproducible bytes.** No unseeded randomness and integer-only color blending, so PNG and `.mcpx` output is identical run to run and between Bun and Node.
- **One engine, two front ends.** The CLI and the stdio MCP server call the same core, so an agent gets exactly what a shell script gets.
- **Output you can parse.** `--json` returns one `{ success, result, error }` envelope with a stable error code, and logs never mix into data on stdout.
- **No surprise writes.** Every output path is explicit, existing files need `--force`, and each file lands through a temp file and an atomic rename.

---

## Showcase

Every image below is produced by mc-asset itself, with fixed seeds for the procedural sources, so the whole set is reproducible. The commands live in [`docs/assets/showcase/README.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/assets/showcase/README.md).

| Pixelize | Quantize |
|---|---|
| ![pixelize before](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-before.png) → ![pixelize after](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-after.png) | ![quantize before](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-before.png) → ![quantize after](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-after.png) |
| A detailed reference image (128px, shown ×2) reduced to 16px (shown ×16): the grain coarsens and shapes snap to a tidy pixel grid. | A 64-color gradient reduced to 8 colors (both ×4): the color count drops and the result settles into clear steps. |

**Material variants** — one source fanned out into four ramps (`iron`, `gold`, `wood`, `crystal`); the shape stays the same and only the palette changes:

![variant iron](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variant-iron.png) ![variant gold](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variant-gold.png) ![variant wood](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variant-wood.png) ![variant crystal](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variant-crystal.png)

**Seamless tiling** — a single 32px seamless tile (left, ×4) and a 2×2 repeat of it (right, ×4); the edges meet with no visible seam:

![tile pattern](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-pattern.png) ![2x2 tiled preview](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-preview-2x2.png)

**Animation sheet** packed from individual frames:

![animation sprite sheet](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/anim-sheet.png)

---

## Installation

### Via npm (recommended)

Run the server straight from the registry — no local install needed:

```sh
npx -y mc-asset mcp
```

Install the CLI globally to get the `mc-asset` command on your PATH:

```sh
npm install -g mc-asset
mc-asset --version
```

### Via Homebrew (macOS / Linux)

```sh
brew tap smile-minecraft/tap
brew install smile-minecraft/tap/mc-asset
mc-asset --version
```

### Via Bun or Node.js (From Source)

```sh
git clone https://github.com/smile-minecraft/mc-asset.git
cd mc-asset
bun install --frozen-lockfile
bun run build
./bin/mc-asset.js --version
```

*Prerequisites*: tested with [Node.js](https://nodejs.org) 22 and [Bun](https://bun.sh) 1.3. `bun run build` needs Bun and `./bin/mc-asset.js` needs Node.js; with Bun alone, run `bun ./bin/mc-asset.js`.

---

## For AI agents

- [`llms.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms.txt) — a compact index of the repository for agents.
- [`llms-full.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms-full.txt) — the same material as a single file: install, the twenty-one MCP tools, batch operations, the error model, and the limits.
- [`docs/cli-surface.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/cli-surface.md) — the frozen CLI commands, the batch operations specification, and the exit-code registry.
- [`docs/mcpx-format.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcpx-format.md) — the editable multi-layer `.mcpx` and `.grid` grammar and specification.
- [`docs/mcp-guide.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-guide.md) — registration, one verbatim capture per MCP tool, and the error model.
- [`docs/mcp-surface.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-surface.md) — the frozen MCP surface: tool names, inputs, and the read/write contract.
- [`AGENTS.md`](https://github.com/smile-minecraft/mc-asset/blob/main/AGENTS.md) — the rules for changing this repository.

---

## Quickstart

### From a Text Grid to a Validated Texture

Draw a 16×16 gem as a character grid, one character per pixel:

```sh
mkdir -p /tmp/mc-asset-demo
cat << 'EOF' > /tmp/mc-asset-demo/gem.grid
[palette]
. = transparent
R = #E74C3CFF
D = #C0392BFF
L = #F1948AFF
W = #FFFFFFFF

[grid]
................
......LLLL......
.....LRRRRD.....
....LRRRRRRD....
...LRRRWWRRRD...
...LRRWWWRRRD...
..LRRRWWWRRRRD..
..LRRRRRRRRRRD..
..LRRRRRRRRRRD..
..LRRRRRRRRRRD..
...DRRRRRRRRD...
...DRRRRRRRRD...
....DRRRRRRD....
.....DRRRRD.....
......DDDD......
................
EOF
```

Render the grid into a PNG texture and save the editable `.mcpx` source:

```sh
mc-asset render /tmp/mc-asset-demo/gem.grid \
  --output /tmp/mc-asset-demo/gem.png \
  --source /tmp/mc-asset-demo/gem.mcpx
# ok render profile=generic applied=0 output=/tmp/mc-asset-demo/gem.png source=/tmp/mc-asset-demo/gem.mcpx
```

Check its colors and alpha:

```sh
mc-asset analyze /tmp/mc-asset-demo/gem.png
# dimensions: 16x16
# colors: 5
# alpha: predicted cutout (opaque=124 transparent=132 partial=0)
# dominant: #00000000 x132 (0.5156), #E74C3CFF x84 (0.3281), #C0392BFF x20 (0.0781), #F1948AFF x12 (0.0469), #FFFFFFFF x8 (0.0313)
# profile: predicted profile generic has no Minecraft-specific restrictions.
# palette: colorCount=5 alphaLevels=2 transparent=132 partial=0
# pixel-art: 16x16 aspect=1:1 isolated=0 semiTransparent=0 tileFriendly=true
# recommended: quantize.colors=8 cleanup=none resize=nearest
```

Validate it as a Minecraft item texture:

```sh
mc-asset validate /tmp/mc-asset-demo/gem.png --profile minecraft:item
# verdict: pass
# dimensions: 16x16
# colors: 5
# alpha: predicted cutout (opaque=124 transparent=132 partial=0)
# profile: predicted profile minecraft:item prefers the items atlas without mipmaps.
```

---

## Practical Recipes

### Recipe 1: Downsampling Reference Art (`pixelize`)

Turn a high-resolution reference image into a 16×16 item texture. The same image and preset always give the same pixels:

```sh
mc-asset pixelize reference.png \
  --size 16 \
  --preset item \
  --profile minecraft:item \
  --output item_texture.png
```

- `--preset item` sets a 16-color budget and turns on the crop, background, subject, edge, and cluster stages.
- The other presets are `block`, `gui`, `particle`, and `generic`.

### Recipe 2: Procedural Textures & Seam Tiling (`generate` & `tile`)

Generate a stone texture from a fixed seed, then check whether it tiles:

```sh
mc-asset generate noise \
  --size 16 \
  --palette stone \
  --seed 42 \
  --output stone.png

# Seam scores: horizontal, vertical, corner (lower is smoother)
mc-asset tile stone.png
# ok tile profile=generic seam=h:0.065196 v:0.096051 c:0.003604 repeat=0.908038

# Match the opposite edges and preview a 4x4 repeat
mc-asset tile stone.png \
  --edge-match both \
  --preview 4x4 \
  --output stone_preview.png
```

### Recipe 3: Palette Quantization & Artifact Cleanup (`quantize` & `cleanup`)

Cut a sprite down to 8 colors, then remove the stray pixels left behind:

```sh
mc-asset quantize sprite.png --colors 8 --output quantized.png

mc-asset cleanup quantized.png \
  --fix isolated,noise \
  --allow-render-pass-change \
  --output clean.png
```

These fix classes can change alpha, and with it the render pass the texture needs, so `cleanup` refuses them without `--allow-render-pass-change`.

### Recipe 4: Material Variants (`variant` & `recolor`)

Fan one source out into several material tiers, or recolor it to a single material:

```sh
mc-asset variant sword.mcpx \
  --materials iron,copper,gold \
  --output-dir ./dist_variants \
  --mkdir
# Writes sword_iron.png, sword_iron.mcpx, sword_copper.png, etc.

mc-asset recolor sword.mcpx --material gold --output sword_gold.png
```

### Recipe 5: Animated Sprite Sheets (`animate`)

Pack a folder of frames into a vertical sheet, then check it against its `.mcmeta`:

```sh
mc-asset animate pack \
  --frames-dir ./textures/fire_frames \
  --layout vertical \
  --output ./textures/fire.png

mc-asset validate ./textures/fire.png --mcmeta ./textures/fire.png.mcmeta
```

### Recipe 6: Full Resource Pack Validation (`validate-pack`)

Scan a whole resource pack for missing textures, bad namespaces, orphaned textures, broken model references, and reference cycles. `--minecraft-version` picks the pack format to check against:

```sh
mc-asset validate-pack ./MyResourcePack \
  --minecraft-version 26.3 \
  --json
```

### Recipe 7: Batch Edits with Visual Feedback (`build` & `apply_asset_operations`)

Edit the Quickstart gem in one batch: a 4×4 gold square framed by a 6×6 black outline. The CLI applies the batch and writes a PNG:

```sh
cat << 'EOF' > /tmp/mc-asset-demo/ops.json
[
  { "type": "fillRect", "rect": { "x": 6, "y": 6, "width": 4, "height": 4 }, "color": "#FFD700FF" },
  { "type": "drawRect", "rect": { "x": 5, "y": 5, "width": 6, "height": 6 }, "color": "#000000FF" }
]
EOF

mc-asset build /tmp/mc-asset-demo/gem.mcpx \
  --operations /tmp/mc-asset-demo/ops.json \
  --output /tmp/mc-asset-demo/gem_modified.png
# ok build profile=generic applied=2 output=/tmp/mc-asset-demo/gem_modified.png
```

Over MCP, `apply_asset_operations` runs the same batch and can send back a picture of what changed:

```json
{
  "sourcePath": "/tmp/mc-asset-demo/gem.mcpx",
  "operations": [
    { "type": "fillRect", "rect": { "x": 6, "y": 6, "width": 4, "height": 4 }, "color": "#FFD700FF" },
    { "type": "drawRect", "rect": { "x": 5, "y": 5, "width": 6, "height": 6 }, "color": "#000000FF" }
  ],
  "outputPngPath": "/tmp/mc-asset-demo/gem_feedback.png",
  "feedback": { "image": "changed", "scale": 8, "diff": "summary" }
}
```

With `feedback`, the result keeps its usual fields and adds a PNG image block cropped to the changed area and upscaled by `scale` (1–16), plus a `diff` summary (`raw`, `composited`, `structural`, `outsideSelectionUnchanged`). An edit with no visible change returns `noVisibleChange` instead of an image. The agent sees its edit without pulling the whole canvas. The output path differs from the CLI run because MCP tools never overwrite an existing file.

### Recipe 8: Nine-Slice GUI Scaling (`gui-scale`)

Resize a GUI frame without smearing its border. With `nine_slice`, the corners copy 1:1 and the edges and center tile (or stretch, with `stretch_inner: true`). The 16×16 `dialog.png` declares a 4px border in `dialog.png.mcmeta`:

```json
{ "gui": { "scaling": { "type": "nine_slice", "width": 16, "height": 16, "border": 4 } } }
```

```sh
mc-asset gui-scale ./textures/gui/dialog.png \
  --mcmeta ./textures/gui/dialog.png.mcmeta \
  --size 48x32 \
  --output ./textures/gui/dialog_large.png
# ok gui-scale profile=generic size=48x32 scaling=nine_slice output=./textures/gui/dialog_large.png
```

`gui-scale` never picks up a sibling `.mcmeta` on its own; without `--mcmeta` it stretches the whole sprite.

---

## MCP Server

`mc-asset mcp` starts a stdio MCP server on the same core as the CLI, so a tool call and the matching command return the same result. It exposes 21 tools.

### Exposed MCP Tools

| Tool | Capability |
|---|---|
| `analyze_asset` | Read-only inspection: dimensions, palette distribution, alpha classification, pixel-art heuristics. |
| `pixelize_asset` | Converts raster inputs (PNG, JPEG, WebP) into pixel art; returns PNG bytes or `.mcpx` source. |
| `render_pixel_asset` | Compiles inline ASCII grid strings or `.grid` files with optional batch operations. |
| `apply_asset_operations`| Applies atomic batch pixel/layer/region mutations to `.mcpx` text. |
| `recolor_asset` | Remaps texture palettes to built-in material ramps (`iron`, `gold`, `stone`, etc.). |
| `create_variants` | Fans out a source asset into per-material variants in an output directory. |
| `validate_asset` | Checks single texture and `.mcmeta` conformance against Minecraft requirements. |
| `import_asset` | Decodes raster inputs (PNG, JPEG, WebP) into the pixel canvas with an optional batch. |
| `build_asset` | Builds `.mcpx` sources into PNG bytes or re-serialized source with an optional batch. |
| `transform_asset` | Applies one geometry operation (flip, rotate, crop, pad, resize, translate) to a raster or `.mcpx` input. |
| `scale_gui_asset` | Scales a GUI sprite with the mcmeta stretch/tile/nine_slice mapping; PNG only. |
| `quantize_asset` | Reduces distinct colors to a target count. |
| `cleanup_asset` | Detects or fixes pixel defects (`isolated`, `noise`, `cluster`, `fringe`, `outlier`, `hole`, `aa`). |
| `palette_asset` | Read-only palette `extract` / `inspect` reports (unique colors, distribution, roles, contrast). |
| `material_asset` | Read-only `list` / `show` reports over the built-in material set. |
| `tile_asset` | Seam, edge-repetition, and brightness analysis with an optional tiled preview PNG. |
| `generate_asset` | Deterministic procedural texture generation (pattern, size, palette, seed). |
| `preview_asset` | `ascii` / `palette-map` reports, `scale` and `nine-slice` guide PNGs. |
| `animate_asset` | Animation `pack` / `unpack` / `reorder` / `resize` / `validate` / `preview` over frame sets. |
| `validate_pack_asset` | Read-only whole-pack scan: namespaces, models, textures, atlases, version targeting. |
| `inspect_asset` | Read-only `structure` (layers, regions, color usage, overlaps) or `view` (composited PNG image block plus metadata); takes `inputPath`. |

`inspect_asset` has two modes: `structure` reports layers, regions, color usage, and overlaps; `view` returns the composited canvas as a PNG image block, with optional `crop` and `scale` (1–16). A view wider than 1024px is refused with a crop hint instead of being downscaled. `apply_asset_operations` takes an optional `feedback` object ([Recipe 7](#recipe-7-batch-edits-with-visual-feedback-build--apply_asset_operations)); without it the result is unchanged. [`docs/mcp-guide.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-guide.md) has one captured call per tool.

### Configuration

Every client runs the same stdio command, `npx -y mc-asset mcp`. Config file locations change between client versions, so check the client's own docs if one below has moved.

#### Claude Code

```sh
claude mcp add mc-asset -- npx -y mc-asset mcp
```

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mc-asset": {
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

#### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mc-asset": {
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

#### OpenCode

Add to `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "mc-asset": {
      "type": "local",
      "command": ["npx", "-y", "mc-asset", "mcp"],
      "enabled": true
    }
  }
}
```

---

## Command Reference

| Category | Command | Description |
|---|---|---|
| **Intake & Build** | `import <image>` | Decodes PNG, JPEG, or WebP to PNG and/or `.mcpx`. |
| | `render <grid>` | Compiles ASCII grid (`.grid`) to PNG and/or `.mcpx`. |
| | `build [source]` | Builds `.mcpx` source file or stdin (`--stdin`) to PNG. |
| **Transform & Geometry** | `transform <input>` | Spatial operations: `--flip`, `--rotate`, `--crop`, `--pad`, `--resize`, `--translate`. |
| **Color & Cleanup** | `quantize <input>` | Color reduction to target count (`--colors <N>`). |
| | `cleanup <input>` | Artifact removal (`--fix isolated,noise,outlier`). |
| | `palette extract` | Extracts palette from image. |
| | `palette inspect` | Detailed palette analysis and role mapping. |
| | `material list` | Lists built-in Minecraft materials. |
| | `material show` | Shows color ramps for a material. |
| | `recolor <source>` | Remaps `.mcpx` colors using a material ramp. |
| | `variant <source>` | Generates multiple material variants into `--output-dir`. |
| **Generation & Tiles** | `generate <pattern>` | Deterministic procedural texture generation (`--seed <int>`). |
| | `tile <input>` | Seam measurement and automatic tile correction. |
| | `preview <input>` | Visual previews: `--ascii`, `--palette-map`, `--scale <N>`, `--nine-slice`. |
| | `gui-scale <input>` | Scales a GUI sprite to `--size <N\|WxH>` with the mcmeta stretch/tile/nine_slice mapping. |
| **Animation** | `animate pack` | Packs frame directory into sprite sheet. |
| | `animate unpack` | Unpacks sprite sheet into frame directory. |
| | `animate reorder` | Re-sequences animation frames. |
| | `animate resize` | Rescales animation frames. |
| | `animate validate`| Validates frame counts and layout against `.mcmeta`. |
| | `animate preview` | ASCII or diagnostic preview of animation sequence. |
| **Validation** | `analyze <image>` | Read-only metric analysis (colors, alpha, dimensions). |
| | `inspect <input>` | Read-only structure report or composited view (`--mode structure\|view`, `--crop`, `--scale`). |
| | `validate <asset>` | Validates single asset texture and optional `.mcmeta`. |
| | `validate-pack <path>`| Validates entire resource pack root directory. |
| **Agent Interface** | `mcp` | Starts the stdio MCP server. |

---

## Batch Operations (`--operations`)

The `import`, `render`, and `build` commands support batch pixel edits via `--operations <path>` or `--operations -` (stdin).

```json
[
  { "type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF" },
  { "type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF" },
  { "type": "fillRect", "rect": { "x": 2, "y": 2, "width": 4, "height": 4 }, "color": "#FFFF00FF" },
  { "type": "floodFill", "x": 5, "y": 5, "color": "#0000FFFF" },
  { "type": "clearPixel", "x": 0, "y": 0 }
]
```

- **Atomicity**: Execution is all-or-nothing. If an operation fails (e.g. out of bounds), all preceding operations in the batch roll back.
- **Color Values**: Accepts `transparent`, `#RRGGBB`, or `#RRGGBBAA`.
- **Vocabulary**: 25 typed variants, including 9 pixel operations (`setPixel`, `clearPixel`, `drawLine`, `drawRect`, `fillRect`, `floodFill`, `ellipse`, `polygonFill`, `strokeMask`) plus layer, region, `stampRect`, and `regionFromSelection` operations. The full per-type table lives in [`docs/cli-surface.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/cli-surface.md).
- **Shapes**: `ellipse` fills or outlines the ellipse inside a `rect`; `polygonFill` takes up to 4096 integer `[x, y]` points (more is `RESOURCE_LIMIT_EXCEEDED`; a self-intersecting ring is `SELF_INTERSECTING_POLYGON`; no holes); `strokeMask` outlines a `source` selection on one layer.
- **Selection**: Pixel operations accept an optional `selection` expression; an empty match refuses the write with `EMPTY_SELECTION` and rolls the batch back.

---

## Architecture & Reliability Guarantees

```text
                  ┌─────────────────────────────────┐
                  │          mc-asset Core          │
                  │  PixelCanvas • IO • Algorithms  │
                  └───────────────┬─────────────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
     ┌───────────▼───────────┐         ┌───────────▼───────────┐
     │     CLI Interface     │         │   Native MCP Server   │
     │  (Terminal & Scripts) │         │  (Stdio Agent Bridge) │
     └───────────────────────┘         └───────────────────────┘
```

### Determinism Model

1. **Byte-Identical PNG Encoding**: Uses fixed deflate levels and filter strategies (`src/io/png.ts`) with pure integer color blending. Output files do not embed timestamps or host metadata.
2. **Seed-Driven PRNG**: Procedural generation relies exclusively on an integer xorshift32 PRNG initialized via `--seed`.
3. **Cross-Runtime Consistency**: Output bytes produced under Bun match bytes produced under Node.js byte for byte for the commands covered by the `scripts/compare-runtime.mjs` matrix.

### File & Channel Safety

- **Atomic Writes**: Every output file is written to a unique temporary file (`.tmp-<pid>-<counter>-<randomhex>-<original name>`) in the target directory and committed via atomic rename.
- **Collision Protection**: Paths are resolved to absolute normalized paths folded with Unicode NFC and case-folding. Aliasing the input without `--in-place` or defining duplicate output targets fails before any bytes land on disk.
- **Channel Isolation**:
  - Without `--stdout`: Human logs route to stdout. With `--json`, a structured `{ success, result, error }` envelope routes to stdout and logs route to stderr.
  - With `--stdout`: Raw artifact bytes exclusively own stdout. Envelope and logs route to stderr.

### Standardized Exit Codes

| Exit Code | Category | Meaning |
|---|---|---|
| **0** | Success | Operation completed successfully. |
| **1** | Internal Error | Unhandled engine failure (`INTERNAL_ERROR`). |
| **2** | Invalid Invocation | Syntax error, conflicting options, missing parameters (`INVALID_ARGUMENT`). |
| **3** | Validation Failure | Engine succeeded, but asset or pack failed validation (`VALIDATION_FAILED`). |
| **4** | Filesystem Error | Output exists without `--force`, missing directory without `--mkdir`, or an unreadable input. |
| **5** | Unsupported / Limit | Unsupported file type, or a size or resource limit exceeded. |

---

## Development

```sh
# Run test suite
bun test

# Run TypeScript type check
bun run test:typecheck

# Run linter
bun run lint

# Build standalone distribution bundles
bun run build

# Verify cross-runtime byte parity (Bun vs Node)
node scripts/compare-runtime.mjs

# Check doc links, anchors, and stray release versions
bun run check:docs
```

---

## License

[MIT](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE) © 2026 Smile Minecraft Project
