# mc-asset

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

![mc-asset banner](docs/assets/banner.png)

A pixel-native 2D asset creation engine and deterministic CLI/MCP toolchain for Minecraft Java Edition resource packs, designed for human creators and AI coding agents.

`mc-asset` bridges the gap where language models struggle with visual pixel art. It provides deterministic pixel manipulation, procedural pattern generation, seamless tiling analysis, animated sprite sheet packaging, palette quantization, and resource pack validation.

---

## Highlights

- **Pixel-Native Engine**: All raster formats and editable text specifications map directly to an in-memory `PixelCanvas` with integer coordinates and strict layer/region bounds.
- **Strict Determinism**: Zero unseeded randomness and zero floating-point drift. Re-running a command with the same inputs and seed produces byte-identical PNG and `.mcpx` files across both Bun and Node runtimes.
- **Agent-First Architecture**: Clean separation between standard output and diagnostic logs. All core operations support `--json` structured envelopes with standardized error codes.
- **Dual Interface (CLI & MCP)**: A unified Core engine powers both a command-line interface and a native Model Context Protocol (MCP) server for integration with AI assistants (Claude Desktop, Cursor, and OpenCode).
- **Filesystem Safety**: Refuses implicit output filenames. Implements per-file atomic staging (`O_EXCL` temp files + rename), collision detection with Unicode NFC and case-folding, and guards against accidental overwrites.

---

## Installation

### Via Homebrew (macOS / Linux)

```sh
brew tap smile-minecraft/tap
brew install smile-minecraft/tap/mc-asset
mc-asset --version
# 0.3.1
```

### Via Bun or Node.js (From Source)

```sh
git clone https://github.com/smile-minecraft/mc-asset.git
cd mc-asset
bun install --frozen-lockfile
bun run build
./bin/mc-asset.js --version
# 0.3.1
```

*Prerequisites*: tested with [Node.js](https://nodejs.org) 22 and [Bun](https://bun.sh) 1.3. `bun run build` needs Bun and `./bin/mc-asset.js` needs Node.js; with Bun alone, run `bun ./bin/mc-asset.js`.

---

## Quickstart

### 1. From ASCII Grid to Validated Texture

Create a 16×16 sprite using human-readable text syntax:

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

Analyze color metrics and alpha distribution:

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

Validate the asset for Minecraft resource pack compliance:

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

Convert high-resolution reference art into pixel art with deterministic color reduction and edge alignment:

```sh
mc-asset pixelize reference.png \
  --size 16 \
  --preset item \
  --profile minecraft:item \
  --output item_texture.png
```

- `--preset item`: Applies 16-color target palette, item-specific boundary preservation, and noise elimination.
- Supported presets: `item`, `block`, `gui`, `particle`, `generic`.

### Recipe 2: Procedural Textures & Seam Tiling (`generate` & `tile`)

Generate a procedural stone texture and check its tiling seamlessness:

```sh
# Generate 16x16 procedural noise texture using built-in stone palette
mc-asset generate noise \
  --size 16 \
  --palette stone \
  --seed 42 \
  --output stone.png

# Evaluate horizontal, vertical, and corner seam discontinuity
mc-asset tile stone.png
# ok tile profile=generic seam=h:0.065196 v:0.096051 c:0.003604 repeat=0.908038

# Automatically repair seams and preview 4x4 repeat
mc-asset tile stone.png \
  --edge-match both \
  --preview 4x4 \
  --output stone_preview.png
```

### Recipe 3: Palette Quantization & Artifact Cleanup (`quantize` & `cleanup`)

Clean up stray semi-transparent pixels from third-party tools:

```sh
# Quantize to 8 colors
mc-asset quantize sprite.png --colors 8 --output quantized.png

# Remove isolated noise and stray pixels
mc-asset cleanup quantized.png \
  --fix isolated,noise \
  --allow-render-pass-change \
  --output clean.png
```

### Recipe 4: Material Variants (`variant` & `recolor`)

Fan out a single source asset into multiple material tiers:

```sh
mc-asset variant sword.mcpx \
  --materials iron,copper,gold \
  --output-dir ./dist_variants \
  --mkdir
# Writes sword_iron.png, sword_iron.mcpx, sword_copper.png, etc.
```

### Recipe 5: Animated Sprite Sheets (`animate`)

Pack individual frames into an animated vertical sprite sheet:

```sh
mc-asset animate pack \
  --frames-dir ./textures/fire_frames \
  --layout vertical \
  --output ./textures/fire.png

# Validate animation sheet against companion .mcmeta
mc-asset validate ./textures/fire.png --mcmeta ./textures/fire.png.mcmeta
```

### Recipe 6: Full Resource Pack Validation (`validate-pack`)

Scan an entire resource pack directory for missing texture dependencies, invalid namespaces, unreferenced files, and broken model JSON references:

```sh
mc-asset validate-pack ./MyResourcePack \
  --minecraft-version 26.3 \
  --json
```

---

## MCP Server Integration (For AI Agents)

`mc-asset` includes a native stdio Model Context Protocol server. Agents interact with the pixel engine directly through structured function calls without subprocess overhead.

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
| `quantize_asset` | Reduces distinct colors to a target count. |
| `cleanup_asset` | Detects or fixes pixel defects (`isolated`, `noise`, `cluster`, `fringe`, `outlier`, `hole`, `aa`). |
| `palette_asset` | Read-only palette `extract` / `inspect` reports (unique colors, distribution, roles, contrast). |
| `material_asset` | Read-only `list` / `show` reports over the built-in material set. |
| `tile_asset` | Seam, edge-repetition, and brightness analysis with an optional tiled preview PNG. |
| `generate_asset` | Deterministic procedural texture generation (pattern, size, palette, seed). |
| `preview_asset` | `ascii` / `palette-map` reports, `scale` and `nine-slice` guide PNGs. |
| `animate_asset` | Animation `pack` / `unpack` / `reorder` / `resize` / `validate` / `preview` over frame sets. |
| `validate_pack_asset` | Read-only whole-pack scan: namespaces, models, textures, atlases, version targeting. |

### Configuration

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mc-asset": {
      "command": "mc-asset",
      "args": ["mcp"]
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
      "command": ["mc-asset", "mcp"],
      "enabled": true
    }
  }
}
```

#### Cursor

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "mc-asset": {
      "command": "mc-asset",
      "args": ["mcp"]
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
| **Animation** | `animate pack` | Packs frame directory into sprite sheet. |
| | `animate unpack` | Unpacks sprite sheet into frame directory. |
| | `animate reorder` | Re-sequences animation frames. |
| | `animate resize` | Rescales animation frames. |
| | `animate validate`| Validates frame counts and layout against `.mcmeta`. |
| | `animate preview` | ASCII or diagnostic preview of animation sequence. |
| **Validation** | `analyze <image>` | Read-only metric analysis (colors, alpha, dimensions). |
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
| **4** | Filesystem Error | File exists without `--force`, missing directory without `--mkdir`. |
| **5** | Unsupported Format | Unsupported file type or resource limit exceeded. |

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
```

---

## License

[MIT](LICENSE) © 2026 Smile Minecraft Project
