# MCP server guide (mc-asset)

[English](mcp-guide.md) | [繁體中文](mcp-guide.zh-TW.md) | [简体中文](mcp-guide.zh-CN.md)

## Contents

- [Installing and registering the server](#installing-and-registering-the-server)
- [Tools](#tools)
- [How failures come back](#how-failures-come-back)
- [Limits and gaps](#limits-and-gaps)

---

`mc-asset mcp` starts a stdio MCP server: stdout carries only MCP JSON-RPC,
diagnostics go to stderr, and the process ends when stdin closes. The frozen
surface — twenty-seven tool names, their inputs, and the read/write contract — lives
in `docs/mcp-surface.md`; the input fields are frozen in `src/mcp/schema.ts`.
This guide covers registration, one capture per tool (image bytes are
abbreviated where noted, never verbatim), the error model, and the limits.

The server hangs directly off Core, so every tool runs the same engine the CLI
commands use. Pixel-granularity authorship travels through the ASCII Grid
document, the batch operations array, or the editable `.mcpx` source returned
inline; there is no `set_pixel` tool by design.

## Installing and registering the server

Install the package once, then point your MCP client at `npx -y mc-asset mcp`.
Any of the three install paths works:

- **npm (recommended)** — run it straight from the registry with `npx -y mc-asset mcp`, or install the CLI globally with `npm install -g mc-asset`.
- **Homebrew (macOS / Linux)** — `brew tap smile-minecraft/tap && brew install smile-minecraft/tap/mc-asset`, then use the `mc-asset` command.
- **From source** — `bun install --frozen-lockfile && bun run build`, then run `./bin/mc-asset.js mcp`.

However you install it, the server command stays `npx -y mc-asset mcp`. Config
file names differ between clients and can change between their versions; when
in doubt, check that client's own documentation. The registrations below are
all stdio.

**Claude Code**

```sh
claude mcp add mc-asset -- npx -y mc-asset mcp
```

**Claude Desktop** — `claude_desktop_config.json`:

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

**Cursor** — `.cursor/mcp.json`:

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

**VS Code** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "mc-asset": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

**Cline** — `cline_mcp_settings.json`:

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

**OpenCode** — `~/.config/opencode/opencode.jsonc`:

```jsonc
"mc-asset": {
  "type": "local",
  "command": ["npx", "-y", "mc-asset", "mcp"],
  "enabled": true
}
```

Then fully restart the client. MCP servers load at startup, so a config change
without a restart proves nothing. To roll back, remove the entry (or restore
the config backup) and restart again.

The captures below were taken with the MCP client SDK from a demo working
directory; every path in them is relative to that directory, except the
`inspect_asset` structure capture, which names the repo fixture
`tests/cli/fixtures/sword.mcpx` directly. The seven
original captures come from the installed build and the later additions from
the local source server — the same server code runs either way.

## Tools

| Tool Index | | |
|---|---|---|
| [`analyze_asset`](#analyze_asset) | [`pixelize_asset`](#pixelize_asset) | [`render_pixel_asset`](#render_pixel_asset) |
| [`apply_asset_operations`](#apply_asset_operations) | [`recolor_asset`](#recolor_asset) | [`create_variants`](#create_variants) |
| [`validate_asset`](#validate_asset) | [`import_asset`](#import_asset) | [`build_asset`](#build_asset) |
| [`transform_asset`](#transform_asset) | [`quantize_asset`](#quantize_asset) | [`cleanup_asset`](#cleanup_asset) |
| [`palette_asset`](#palette_asset) | [`material_asset`](#material_asset) | [`tile_asset`](#tile_asset) |
| [`generate_asset`](#generate_asset) | [`preview_asset`](#preview_asset) | [`scale_gui_asset`](#scale_gui_asset) |
| [`animate_asset`](#animate_asset) | [`validate_pack_asset`](#validate_pack_asset) | [`inspect_asset`](#inspect_asset) |
| [`optimize_asset`](#optimize_asset) | [`model_asset`](#model_asset) | [`mcmeta_asset`](#mcmeta_asset) |
| [`compare_assets`](#compare_assets) | [`style_asset`](#style_asset) | [`pack_asset`](#pack_asset) |

### analyze_asset

Read-only report over a raster image; never writes. Call it with `path` and,
optionally, `profile`, `minecraftVersion`, or `resourcePackVersion`.

Call:

```json
{"path":"px-8x8.png"}
```

Result (verbatim; the `dominantColors` array is truncated after the first of
8 entries — each entry carries `count` 1 and `ratio` "0.0156"):

```text
{"dimensions":{"width":8,"height":8},"totalPixels":64,"colorCount":64,"alpha":{"predictedClassification":"translucent","opaquePixels":62,"transparentPixels":1,"partialAlphaPixels":1,"partialAlphaValues":[128],"opaqueRatio":"0.9688","transparentRatio":"0.0156","partialAlphaRatio":"0.0156","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"dominantColors":[{"hex":"#03ED20FF","r":3,"g":237,"b":32,"a":255,"count":1,"ratio":"0.0156"} … 7 more entries, each count 1 / ratio "0.0156" …]}
```

The classification is predicted from PNG bytes only, never the in-game render
result — the same caveat the CLI reports.

### pixelize_asset

Runs a reference raster through the deterministic pixelize pipeline. The input
must be PNG, JPEG, or WebP, never `.mcpx`. The call needs `size` (`16`, `32`,
`64`, `128`, or `WxH`); omitting it is `INVALID_ARGUMENT`. `preset` is
optional.

Call:

```json
{"inputPath":"px-8x8.png","size":"16","preset":"item","outputPngPath":"out/pixelize16.png"}
```

Result (verbatim; only the PNG path was given, so the `.mcpx` text is
embedded, and the palette block and the tail are truncated):

```text
{"profile":"generic","preset":"item","presetDetail":"preset=item colors=16 edge=128 cluster=8 cleanup=outlier (item: tight 16-color budget with crop, background, subject, edge 128, cluster 8, outlier cleanup)","width":16,"height":16,"colors":16,"colorCount":16,"stages":[{"stage":"decode","status":"applied","reason":"decoded by the caller"},{"stage":"crop","status":"not-needed","reason":"content fills the full frame"},{"stage":"background","status":"not-needed","reason":"outer ring has no opaque majority at 90 percent coverage"},{"stage":"subject","status":"not-needed","reason":"subject already centered"},{"stage":"resize","status":"applied","reason":"nearest resize to 16x16"},{"stage":"edge","status":"applied","reason":"hardened 4 edge pixels at threshold 128"},{"stage":"quantize","status":"applied","reason":"median-cut at 16 colors, 16 kept"},{"stage":"cluster","status":"not-needed","reason":"no colors merged"},{"stage":"cleanup","status":"applied","reason":"cleanup outlier"},{"stage":"preset","status":"applied","reason":"recorded preset item"},{"stage":"output","status":"applied","reason":"encoded by the caller"}],"warnings":[],"output":"out/pixelize16.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n0 = #175754FF\n… 15 more palette entries (1–F); the last is F = #DDA5DEFF …\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[gr… (truncated) …"}
```

### render_pixel_asset

Renders a hand-authored ASCII Grid into PNG bytes and/or `.mcpx`. Pass exactly
one of `gridText` (inline document) or `gridPath` (a `.grid` file); both is
`ARGUMENT_CONFLICT`, neither is `INVALID_ARGUMENT`. An optional `operations`
JSON string is applied after the grid parses.

Call:

```json
{"gridText":"[palette]\n. = transparent\nS = #ADB7C0FF\n\n[grid]\n.SS.\nSSSS\nSSSS\n.SS.\n","outputPngPath":"out/render.png"}
```

Result (verbatim; `mcpxText` is embedded because no `.mcpx` path was given):

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"width":4,"height":4,"output":"out/render.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nS = #ADB7C0FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.SS.\nSSSS\nSSSS\n.SS.\n"}
```

### apply_asset_operations

Applies a batch of Core pixel/layer/region operations to an `.mcpx` source in
one call. `sourcePath` must end in `.mcpx`; `atomic` defaults to true, so the
first failure rolls the whole batch back.

Call:

```json
{"sourcePath":"sword.mcpx","operations":[{"type":"setPixel","x":0,"y":0,"color":"#FF0000FF"},{"type":"fillRect","rect":{"x":1,"y":1,"width":2,"height":2},"color":"#00FF00FF"}],"outputMcpxPath":"out/applied.mcpx","outputPngPath":"out/applied.png"}
```

Result (verbatim; both output paths were given, so neither artifact is
embedded):

```text
{"applied":2,"failed":0,"operations":[{"index":0,"status":"applied"},{"index":1,"status":"applied"}],"warnings":[],"output":"out/applied.png","source":"out/applied.mcpx"}
```

Without `feedback` the shape above is frozen: `applied`, `failed`, the
per-operation `operations` array, `warnings`, then the PNG and source
artifacts (explicit paths, or embedded `pngBase64` / `mcpxText`). Passing
`feedback` is optional and only adds to that shape — leaving it out keeps the
output fields and bytes exactly as before.

`feedback` takes `image` (`none` / `full` / `changed`), `scale` (integer
1–16), `crop` (a selection expression), and `diff` (`none` / `summary`):

- `image: "none"` (the default) returns flags only. `"full"` renders the whole
  crop; `"changed"` ignores the crop and renders the composited change bounds,
  reporting `noVisibleChange: true` instead of an image when nothing visible
  moved. A `crop` combined with `none` is `INVALID_ARGUMENT`.
- An included image is never embedded as `pngBase64`: it travels as a second,
  standard image content block (`type: "image"`, `mimeType: "image/png"`) with
  no duplicate bytes in the text block.
- An omitted `scale` auto-scales from the pre-scale long edge only: an edge
  below 128 scales up toward 128, capped at 16. Outputs beyond the 1024px edge
  refuse with `RESOURCE_LIMIT_EXCEEDED` instead of downsampling. Guide pixels
  (grids, checkers) never enter the artwork bytes.
- `diff: "summary"` adds `raw` / `composited` / `structural` plus
  `outsideSelectionUnchanged`, which is true when every pixel outside the
  selection survived byte-identical, including hidden RGB under alpha 0.
- `atomic: false` runs every operation and keeps the partial successes: the
  result still reports per-operation applied/failed statuses (for example
  `applied: 1, failed: 1`) instead of rolling back, including alongside a
  `changed` image or a diff summary.

Pixel operations accept an optional `selection`: only selected pixels are
written and everything else is restored verbatim. A selection names atoms —
`all`, `rect:x,y,w,h`, `region:id`, `alpha[:layer]`,
`color[:layer]:r,g,b,a`, `connected[:layer]:x,y` — or a JSON AST object
(`{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`),
capped at depth 32 and 1024 nodes. An empty match refuses the write with
`EMPTY_SELECTION` and rolls the batch back.

The pixel vocabulary is nine operations; the three shape additions are
`ellipse` (the ellipse inscribed in `rect`; `mode` is required, `fill` or
`outline`), `polygonFill` (fills the polygon named by `points`), and
`strokeMask` (outlines the `source` selection read scope on `layerId` without
painting the scope itself). `polygonFill` takes at most 4096 points
(`RESOURCE_LIMIT_EXCEEDED` beyond that); a self-intersecting ring is
`SELF_INTERSECTING_POLYGON`, and holes are unsupported.

`outline`, the twenty-sixth operation type, frames the non-transparent pixels
of one `layerId`: on the body edge (`inside`, default) or on the empty cells
touching the body (`outside`), in one of five modes — `tinted` darkens the
adjacent body colour in integer HSL, `selective` paints only the backlit side
with the light at the top left, `uniform` fills the frame with a required
`#RRGGBB` colour, `black` fills it with opaque black, and `strip` turns an
existing frame into the neighbouring interior colour without changing the body
size. `color` belongs to `uniform` alone, and `family` names one of the twelve
builtin families to snap the derived colour onto the builtin vanilla ramp
while `snapFamilies` is true. It accepts the same optional `selection`. The
full per-type table lives in the “Batch Operations Specification” section of
`docs/cli-surface.md`.

Feedback example — one changed pixel with a summary (abbreviated, not
verbatim; image data omitted):

Call:

```json
{"sourcePath":"sword.mcpx","operations":[{"type":"setPixel","layerId":"base","x":0,"y":0,"color":"#FF0000FF"}],"feedback":{"image":"changed","diff":"summary"}}
```

Result: the text block carries `applied: 1, failed: 0`, one raw and one
composited changed pixel, and `outsideSelectionUnchanged: true`; the image
arrives as a second `type: "image"`, `mimeType: "image/png"` block:

```text
{"applied":1,"failed":0,"operations":[{"index":0,"status":"applied"}],"warnings":[],"feedback":{"image":"changed","imageIncluded":true,"diff":{"raw":{"changedPixels":1 …},"composited":{"changedPixels":1 …},"structural":…,"outsideSelectionUnchanged":true}},"mcpxText":"mcpx 1\n… (truncated) …"}
[second block: {"type":"image","mimeType":"image/png","data":"… (omitted) …"}]
```

### recolor_asset

Recolors every layer of an `.mcpx` source with one builtin material id or
palette family id, or remaps a flat PNG the same way; an optional `region` limits the
write to a single region. Exactly one of `material` or `family` is required
(omitting both is `INVALID_ARGUMENT`, providing both is `ARGUMENT_CONFLICT`).
`style` defaults to `vanilla`, and an optional `selection` scopes the write.
On the material path, a flat PNG maps by integer luminance bands (<96 shadow,
96–159 base, ≥160 highlight) onto the target palette. On the palette family path
(`family`), role-aware sources map roles directly to the family roles (`outline`,
`shadow`, `dark`, `base`, `light`, `highlight`) while `accent` and `custom` follow
the six integer luminance bands; flat PNG sources map by the six bands (<43 outline,
43–85 shadow, 86–127 dark, 128–170 base, 171–213 light, ≥214 highlight); outline pixels
(adjacent to transparency or canvas boundary) are forced to the family's `outline`
color; fully transparent pixels stay byte-identical including hidden RGB; translucent
pixels are forced to fully opaque ramp colors. JPEG and WebP are still refused
(`INVALID_ARGUMENT`), and a missing region keeps `REGION_NOT_FOUND`.

Call:

```json
{"sourcePath":"sword.mcpx","material":"iron","outputPngPath":"out/sword_iron.png"}
```

Result (verbatim; only the PNG path was given, so the recolored `.mcpx` text
is embedded):

```text
{"profile":"generic","material":"iron","pixelsChanged":12,"warnings":[],"output":"out/sword_iron.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n0 = #5A6068FF\n1 = #9AA1A9FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.00.\n0110\n0110\n.00.\n"}
```

### create_variants

Fans one `.mcpx` source or flat PNG out to one PNG plus one `.mcpx` per
material or palette family under an explicit `outputDir`, each starting from
the pristine source, so material order never matters. At least one of
`materials` or `families` is required (omitting both is `INVALID_ARGUMENT`);
both may coexist producing the union of both variants. Colliding filenames
raise `ARGUMENT_CONFLICT`. `nameTemplate` supports `{stem}` and `{name}`,
defaulting to `{stem}_{name}`. `selection` and `region` scope the fan-out
the same way as in `recolor_asset`.

Call:

```json
{"sourcePath":"sword.mcpx","materials":["iron","copper"],"outputDir":"variants-out"}
```

Result (verbatim):

```text
{"profile":"generic","materials":["iron","copper"],"outputDir":"variants-out","files":[{"material":"iron","png":"variants-out/sword_iron.png","mcpx":"variants-out/sword_iron.mcpx","pixelsChanged":12},{"material":"copper","png":"variants-out/sword_copper.png","mcpx":"variants-out/sword_copper.mcpx","pixelsChanged":12}],"warnings":[]}
```

### validate_asset

Returns a read-only verdict with findings; never writes. `path` is a PNG, and
an optional `mcmetaPath` is used verbatim (a sibling file is never derived). A
`fail` verdict is a normal result, not an error.

Call:

```json
{"path":"px-8x8.png"}
```

Result (verbatim):

```text
{"verdict":"pass","profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"dimensions":{"width":8,"height":8},"totalPixels":64,"colorCount":64,"alpha":{"predictedClassification":"translucent","opaquePixels":62,"transparentPixels":1,"partialAlphaPixels":1,"partialAlphaValues":[128],"opaqueRatio":"0.9688","transparentRatio":"0.0156","partialAlphaRatio":"0.0156","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"findings":[{"code":"PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING","level":"warning","message":"predicted translucent: 1 partial-alpha pixel(s) use the translucent render pass; left as-is with no auto-fix."}],"version":{},"target":"default (engine defaults)","coverage":{"status":"complete","skipped":[]}}
```

### import_asset

Imports a raster image into the engine: PNG, JPEG, or WebP in, plus an
optional batch. With no output paths the PNG bytes and the `.mcpx` text
are both embedded in the result.

Call:

```json
{"inputPath":"px-8x8.png"}
```

Result (verbatim; `pngBase64` and the `.mcpx` palette and grid are
truncated — the full palette holds all 64 colors, `0`–`T0002`):

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAI… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 8\nheight = 8\n\n[palette]\n0 = #03ED20FF\n… 63 more palette entries (1–T0002) …\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid tokens]\no 7 F N V d l u\n… 7 more grid rows …"}
```

### build_asset

Rebuilds an editable `.mcpx` source into PNG bytes and/or built source.
`sourcePath` must end in `.mcpx` — a raster source is
`INVALID_ARGUMENT`. An optional batch runs first.

Call:

```json
{"sourcePath":"sword.mcpx"}
```

Result (verbatim; `pngBase64` is truncated):

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n"}
```

### transform_asset

Applies one geometry operation (`flip`, `rotate`, …) to a raster image or `.mcpx`; a selection cannot be combined with geometry operations (`ARGUMENT_CONFLICT`). Exactly one geometry flag is required: two is `ARGUMENT_CONFLICT`, none is `INVALID_ARGUMENT`.

Call:

```json
{"inputPath":"sword.mcpx","flip":"h"}
```

Result (verbatim; `pngBase64` is truncated):

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"geometry":"flip:h","width":4,"height":4,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n"}
```

### quantize_asset

Reduces a raster image or `.mcpx` to a color count (`colors`) or maps it
onto an explicit `palette` (builtin material name or `.mcpx` path); pass
exactly one (both is `ARGUMENT_CONFLICT`, neither is `INVALID_ARGUMENT`).
`keepColors` (RGBA objects) stay unchanged; with `palette` each must be a
palette entry, and with `colors` each layer counts only the distinct kept
colors present in the selected pixels against the budget. An optional
selection limits the work to selected pixels. The palette file is never
overwritten by an output path. The result reports `colors` or `palette`,
`colorCount`, `modifiedPixels`, and the normalized `keepColors`; the written
`.mcpx` keeps the canvas palette rather than the declared input palette.
Output paths may use any extension, as before. All output targets are checked
together before the first write: an alias of the input or palette file, a
symbolic-link target, a symbolic-link parent directory, or an existing file
refuses the whole call (symbolic-link targets used to be followed). The writes
themselves are one atomic file at a time, not a transaction; a disk failure
mid-way can leave earlier outputs written.

Call:

```json
{"inputPath":"px-8x8.png","colors":4}
```

Result (verbatim; `pngBase64` is truncated):

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"colors":4,"colorCount":4,"modifiedPixels":64,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAI… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 8\nheight = 8\n\n[palette]\n0 = #2A6353E7\n1 = #5D8787FF\n2 = #B9417FFF\n3 = #C0C0B0FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n20002222\n00002222\n00011233\n00111333\n01113333\n11133330\n11333320\n11322220\n"}
```

### cleanup_asset

Detects (and optionally fixes) pixel defects in a raster image or
`.mcpx`. With no `fix` class this is a detect-only run:
`modifiedPixels` is 0 and nothing changes. A `fix` class without
render-pass authorization is `INVALID_ARGUMENT`.

Call:

```json
{"inputPath":"sword.mcpx"}
```

Result (verbatim; `pngBase64` is truncated):

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"detected":{"isolated":0,"noise":0,"cluster":0,"fringe":0,"outlier":0,"hole":0,"aa":0},"fixed":{"isolated":0,"noise":0,"cluster":0,"fringe":0,"outlier":0,"hole":0,"aa":0},"modifiedPixels":0,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n"}
```

### palette_asset

Read-only color report over an image. `extract` lists the unique
colors; `inspect` reports distribution, roles, and contrast. `mode` is
required.

Call:

```json
{"mode":"extract","inputPath":"sword.mcpx"}
```

Result (verbatim):

```text
{"mode":"extract","profile":"generic","colorCount":3,"entries":[{"id":"color-0","color":"#00000000"},{"id":"color-1","color":"#FF0000FF"},{"id":"color-2","color":"#00FF00FF"}]}
```

### material_asset

Read-only builtin-material report. `list` names every material; `show`
plus `name` returns one definition with its color ramps. An unknown
name is `INVALID_ARGUMENT`.

Call:

```json
{"mode":"list"}
```

Result (verbatim):

```text
{"mode":"list","profile":"generic","materials":["iron","copper","oxidized_copper","gold","diamond","netherite","wood","stone","crystal"]}
```

### tile_asset

Seam and edge report over a raster image or `.mcpx`, with optional
match axes. With `preview` (e.g. `2x2`) the tiled preview PNG is
embedded as `pngBase64`.

Call:

```json
{"inputPath":"px-8x8.png","preview":"2x2"}
```

Result (verbatim; `pngBase64` is truncated):

```text
{"profile":"generic","width":8,"height":8,"preview":"2x2","seam":{"horizontal":{"raw":422822,"pairs":8,"score":"0.203202"},"vertical":{"raw":494206,"pairs":8,"score":"0.237508"},"corner":{"raw":100918,"pairs":2,"score":"0.193998"}},"repeat":{"score":"0.930164","periodX":1,"periodY":1},"corrections":[],"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ… (truncated) …"}
```

### generate_asset

Synthesizes a deterministic procedural texture from `pattern` plus
`size` plus `palette` plus `seed`; no input file. With no output paths
the PNG bytes and the `.mcpx` text are both embedded.

Call:

```json
{"pattern":"checker","size":"16","palette":"iron","seed":7}
```

Result (verbatim; `pngBase64` and the grid are truncated — the full
`.mcpx` holds the two-color palette and all 16 grid rows):

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"pattern":"checker","seed":7,"width":16,"height":16,"palette":"iron","pngBase64":"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n0 = #1A1D21FF\n1 = #EEF2F6FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n1110001110001110\n1110001110001110\n1110001110001110\n… 13 more grid rows …"}
```

### preview_asset

Read-only previews in one `mode`: `ascii` and `palette-map` return
reports, while `scale` and `nine-slice` can write a PNG to an explicit
path. The call below is the `ascii` report over `sword.mcpx`.

Call:

```json
{"inputPath":"sword.mcpx","mode":"ascii"}
```

Result (verbatim):

```text
{"mode":"ascii","profile":"generic","width":4,"height":4,"ascii":["[palette]",". = #00000000","R = #FF0000FF","G = #00FF00FF","","[grid]",".RR.","RGGR","RGGR",".RR."],"palette":{".":"#00000000","R":"#FF0000FF","G":"#00FF00FF"},"warnings":[]}
```

### scale_gui_asset

Scales a GUI sprite to an explicit target size with the mcmeta `stretch` / `tile` / `nine_slice` mapping; the `.mcmeta` path is used verbatim and an omitted one means `stretch`. An optional version target gates `stretch_inner`; the output is PNG only — an explicit `outputPngPath` writes the file, otherwise the bytes are embedded as `pngBase64`.

Call:

```json
{"inputPath":"px-8x8.png","size":"16x16"}
```

Result (verbatim; `pngBase64` is truncated):

```text
{"size":"16x16","width":16,"height":16,"scaling":{"type":"stretch"},"version":{},"target":"default (engine defaults)","warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ… (truncated) …"}
```

### animate_asset

Animation sheets in one `mode`: `pack` builds a sheet from a frames
directory, `unpack` / `reorder` / `resize` write frames under an
explicit output directory, and `validate` / `preview` are read-only.
Without an output path the packed sheet is embedded as `pngBase64`.

Call:

```json
{"mode":"pack","framesDir":"v04-anim-frames","layout":"vertical"}
```

Result (verbatim; `pngBase64` is truncated):

```text
{"mode":"pack","profile":"generic","frameCount":2,"frameWidth":4,"frameHeight":4,"layout":"vertical","width":4,"height":8,"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAI… (truncated) …"}
```

`sweep` turns one still image into a highlight band that walks across it:
`inputPath` plus the optional `angle` (45, 90, 135, or 180; default 135),
`width` (1 to 8), `color` (`#RRGGBB`), `frames` (including the untouched
frame 0), `frametime`, and `holdTicks`, with `outputPngPath` and
`outputMcmetaPath` as the optional targets. Frame 0 is the source and only
fully opaque pixels are repainted, so the silhouette and the alpha plane
never move. Parameters left out take the builtin default style's animation
rules. `unpack` takes `format` (`mcpx` by default, or `png`), and `preview`
writes its sheet image when `outputPngPath` is given and reports only
without it.

Call:

```json
{"mode":"sweep","inputPath":"gem.png","angle":45,"width":2,"frames":8,"outputPngPath":"gem_sweep.png","outputMcmetaPath":"gem_sweep.png.mcmeta"}
```

### validate_pack_asset

Read-only verdict over a whole resource pack root; never writes. An
optional `resourcePackVersion` selects the compatibility target. A
`fail` verdict is a normal result, not an error. `vanillaPath`
(optional) supplies the vanilla resource tree and `dependencyPaths`
(ordered, first wins) adds dependency roots; the report carries a
`coverage` object, and supplying the vanilla tree completes the atlas
checks that would otherwise be skipped.

Call:

```json
{"packPath":"clean-pack","resourcePackVersion":"75"}
```

Result (verbatim):

```text
{"command":"validate-pack","path":"clean-pack","target":"resource-pack 75.0","verdict":"pass","findings":[{"code":"PACK_COVERAGE_SKIPPED","level":"warning","message":"atlas \"items\" for sprite \"minecraft:item/sword\" in \"assets/minecraft/models/item/sword.json\" cannot be completed without the vanilla resource tree; coverage recorded as skipped.","path":"assets/minecraft/models/item/sword.json"}],"coverage":{"status":"partial","skipped":[{"kind":"atlas-source","reason":"vanilla-not-provided","target":"items","detail":"sprite \"minecraft:item/sword\" needs the vanilla atlas sources"}]},"version":{"resourcePackVersion":"75.0"}}
```

### inspect_asset

Read-only inspection over an `.mcpx` source or a raster image — a raster
reads as a single base layer — and it never writes. It takes `inputPath` plus
`mode` (`structure` / `view`); `crop` and `scale` are view-only, so
`structure` with either is `INVALID_ARGUMENT`.

Call:

```json
{"inputPath":"tests/cli/fixtures/sword.mcpx","mode":"structure"}
```

Result (actual local MCP text-block response on that fixture):

```text
{"mode":"structure","width":4,"height":4,"layers":[{"id":"base","name":"base","index":0,"bounds":{"x":0,"y":0,"width":4,"height":4},"area":12,"visible":true,"opacity":1,"blendMode":"normal","colorUsage":{"uniqueColors":3,"transparentPixels":4,"topColors":[{"rgba":"#FF0000FF","count":8},{"rgba":"#00000000","count":4},{"rgba":"#00FF00FF","count":4}],"truncated":false}}],"regions":[],"overlaps":{"layerBounds":[],"regionPixels":[]}}
```

`structure` reports layers (bounds, area, visibility, raw RGBA color usage),
regions (identity, bounds, area only), and overlaps. `view` instead returns
the composited pixels as a standard image block plus a six-key metadata object
(`mode`, `sourceDimensions`, `crop`, `scale`, `outputDimensions`,
`colorFormat`) — under the same crop/scale/1024px-edge rules as the top-level
`inspect` command, with no `pngBase64` duplicate of the image bytes. View
`scale` is an integer 1–16 and defaults to 1; the long-edge auto-scale (a
pre-scale edge below 128 scaling up toward 128) applies to
`apply_asset_operations` feedback images only, never to `view`. `crop` is a
selection expression like the batch `selection`; an empty match refuses with
`EMPTY_SELECTION`, and outputs beyond the 1024px edge refuse with
`RESOURCE_LIMIT_EXCEEDED` and a crop hint.

### optimize_asset

Losslessly re-encodes explicit PNG files or a directory of PNGs into the smallest exact encoding, or
keeps the source bytes when nothing smaller exists. It accepts either explicit `inputPaths` (1 to 256 files)
or `inputDir` (up to 4096 PNGs, optional `recursive`). It reads its inputs and
never rewrites them; it writes only to an explicit new `outputPath` (one explicit input)
or into an existing `outputDir`. In directory mode, relative paths are traversed in UTF-8 byte order and
preserved under `outputDir`, budgets are enforced (256 MiB source, 16,777,216 decoded pixels), symlinks and
overlapping/aliased directories are rejected, and non-PNG files (`.mcmeta` etc.) are skipped.
`dryRun` computes the full report and writes nothing. With one explicit input and no output field,
the result embeds `pngBase64`. `mode` defaults to `auto`; a named mode forces that encoding and raises
`OPTIMIZE_MODE_NOT_EXACT` when it cannot hold the pixels exactly. `ancillary`
defaults to `preserve`; `strip` drops every metadata chunk and lists it. Multi-file writes are atomic per file
rather than a transaction: if writing fails midway, files already committed stay, and error details report
`completed`, `failedTarget`, and `notStarted`.

Call:

```json
{"inputPaths":["px-8x8.png"],"dryRun":true}
```

Result (actual local MCP text-block response):

```text
{"command":"optimize","dryRun":true,"mode":"auto","ancillary":"preserve","engine":"pako@3.0.2 level=9 memLevel=9 windowBits=15 legacyHash=false","files":[{"input":"px-8x8.png","output":null,"status":"optimized","source":{"bytes":184,"width":8,"height":8,"bitDepth":8,"colorType":6,"interlaced":false},"result":{"bytes":102,"mode":"rgba","bitDepth":8,"colorType":6,"paletteSize":0},"savedBytes":82,"savedPermille":445,"candidates":[{"mode":"rgba","applicable":true,"bytes":102,"selected":true},{"mode":"rgb","applicable":false,"unavailableReason":"not-opaque","selected":false},{"mode":"grayscale-alpha","applicable":false,"unavailableReason":"not-gray","selected":false},{"mode":"grayscale","applicable":false,"unavailableReason":"not-opaque","selected":false},{"mode":"indexed","applicable":true,"bytes":296,"selected":false}],"preservedChunks":[],"strippedChunks":[],"interlaceRemoved":false,"warnings":[]}],"totals":{"files":1,"sourceBytes":184,"resultBytes":102,"savedBytes":82,"optimized":1,"unchanged":0,"converted":0}}
```

The `candidates` list shows every encoding that was tried and why the others
did not apply. In the compute phase a batch is all or nothing: if any input
fails, nothing is written and the error lists `processed` and `notProcessed`.

### model_asset

Inspects, validates, creates, edits, or exports a Java block/item model JSON
(cuboid `elements` only). `inspect` and `validate` are read-only; `create`,
`apply`, and `export` write only to explicit new paths, and `export` can also
generate an item definition and a blockstate from a `binding`. It reports
structure and reference validity, not rendered appearance.

Call (create, writing the model into a pack):

```json
{"mode":"create","spec":{"textures":{"all":"mypack:block/ruby"},"elements":[{"from":[0,0,0],"to":[16,16,16],"faces":{"north":{"texture":"#all","uv":[0,0,16,16]},"up":{"texture":"#all"}}}]},"outputPath":"pack/assets/mypack/models/block/ruby.json","resourcePackVersion":"75"}
```

Result (actual local MCP text-block response):

```text
{"command":"model","mode":"create","version":{"packFormat":"75.0","rules":"verified","rulesReason":"verified-release"},"changed":true,"warnings":[],"preservedUnknown":[],"output":"pack/assets/mypack/models/block/ruby.json"}
```

Call (validate that model against the pack):

```json
{"mode":"validate","inputPath":"pack/assets/mypack/models/block/ruby.json","packPath":"pack","resourcePackVersion":"75"}
```

Result (actual local MCP text-block response; the pack held the referenced texture `pack/assets/mypack/textures/block/ruby.png`):

```text
{"command":"model","mode":"validate","path":"assets/mypack/models/block/ruby.json","target":"mypack:block/ruby","version":{"packFormat":"75.0","rules":"verified","rulesReason":"verified-release"},"verdict":"pass","findings":[],"coverage":{"status":"complete","skipped":[]}}
```

`apply` takes typed `operations` and applies all of them or none. `export` with
`binding.item` needs an explicit version of pack format 46.0 or later
(`MODEL_UNSUPPORTED_VERSION` otherwise). Without a vanilla tree, `minecraft`
references are recorded as skipped coverage instead of being resolved.

Call (preview that model as a diagnostic three-view PNG):

```json
{"mode":"preview","inputPath":"pack/assets/mypack/models/block/ruby.json","packPath":"pack","size":64,"resourcePackVersion":"75"}
```

Result (actual local MCP text-block response; the pack held no texture, so the
faces render as the fixed checkerboard and coverage is `partial`):

```text
{"command":"model","mode":"preview","path":"assets/mypack/models/block/ruby.json","size":64,"version":{"packFormat":"75.0","rules":"verified","rulesReason":"verified-release"},"image":{"width":192,"height":64},"panels":[{"name":"front","x":0,"y":0,"width":64,"height":64},{"name":"right","x":64,"y":0,"width":64,"height":64},{"name":"top","x":128,"y":0,"width":64,"height":64}],"range":{"min":[0,0,0],"max":[16,16,16],"pixelsPerUnit":3},"coverage":{"status":"partial","skipped":[{"kind":"texture","reason":"missing","target":"mypack:block/ruby"}]},"warnings":[{"code":"MODEL_PREVIEW_TEXTURE_MISSING","level":"warning","message":"Texture mypack:block/ruby could not be resolved (missing).","target":"mypack:block/ruby"}],"unapplied":["display","lighting"]}
```

Without `outputPngPath` the PNG returns as a standard image block next to
that report. With `outputPngPath` the file is written and only the report
returns as text. The preview image output path field is named `outputPngPath`, matching the other PNG-output tools; the model's `.json` output still uses the existing `outputPath`. The three panels are always `front` (north face), `right`
(east face), and `top` (up face, north at the top); each panel is `size`
pixels square. Only axis-aligned cuboids with exact 1/256 coordinates draw;
`size` accepts 64, 128, or 256 (default 64). This is a diagnostic view:
`display` transforms and game lighting are not applied, and nothing in a
game client verified the appearance.

### style_asset

Style presets and the palette library. `list` names the four builtin
presets (`vanilla`, `soft`, `fairy-flat`, `dark-frame`), each with twelve
families and six roles; adding `paths` also reports the custom
`.style.json` sources it can load, and one that cannot load fails the call
with `STYLE_INVALID`. `show` resolves a builtin id or a `.style.json` path
through its `extends` chain (at most eight levels) and returns the whole
document plus that chain. `export-palette` writes the palette of one family,
or of every family, as `.mcpx` — returning the text when `outputMcpxPath` is
omitted. `create` writes a new `.style.json` document.

Call:

```json
{"mode":"export-palette","style":"vanilla","family":"iron"}
```

The palette is one `.mcpx` document: one row per family, one column per
role, `[palette]` in family-then-role order with `.` first as `#00000000`,
and `kind = palette`. Hand it to `quantize` or `generate` as a palette file.

```json
{"mode":"create","outputPath":"styles/iron-tide.style.json","id":"iron-tide","name":"Iron Tide","extends":"vanilla","overrides":{"limits":{"maxColors":12}}}
```

A style file is read strictly: an unknown field, a value outside its
enumeration, or a color that is not `#RRGGBB` is `STYLE_INVALID` naming the
field path (`palettes.stone.base: expected #RRGGBB, got "#12345"`). The
other codes are `STYLE_NOT_FOUND` (unknown id), `STYLE_INHERITANCE_CYCLE`,
`STYLE_UNSUPPORTED_VERSION`, and `STYLE_FAMILY_NOT_FOUND` (a family the
resolved style does not carry). Only `export-palette` and `create` write,
and only to their explicit output path; `force` replaces that file and
`mkdir` creates missing parents.

`lint` measures one image against one style and returns the frozen report:

```json
{"mode":"lint","inputPath":"assets/pack/textures/item/ruby_sword.png","style":"vanilla","category":"sword"}
```

The result carries `path`, `style`, `category`, the `metrics` block (the same
fields `analyze_asset` reports as `styleMetrics`), `findings`, `skipped`,
and `verdict` (`pass`, `warnings`, `fail`). Each finding carries `code`,
`level`, `measured`, `threshold`, `message`, and `suggestion`; every code is
a warning except `STYLE_COLOR_BUDGET`. A metric with nothing to compare adds
a `skipped` reason instead of a finding, `category` applies that category's
threshold overrides, and an animation strip is measured as its first frame
(`firstFrameOnly: true`). `analyze_asset` reports the same measurement
block under `styleMetrics`; its other fields are unchanged.

### pack_asset

Creates one resource pack project. `init` takes `projectDir`,
`namespace`, and `minecraftVersion` (all required) plus optional `name`,
`description`, `style`, and `resourcePackVersion`; `namespace: minecraft`
additionally needs `allowMinecraftNamespace`.

Call:

```json
{"mode":"init","projectDir":"packs/aurelian-forge","namespace":"aurelian","minecraftVersion":"1.21.9","style":"soft"}
```

One preflighted batch writes `mc-asset.pack.json`, `pack/pack.mcmeta`,
a 64x64 `pack/pack.png` placeholder icon, and the resource pack
directories (`recipes/` plus `pack/assets/aurelian/...`, with `items/`
from resource pack format 46.0 on). The result reports the pinned
format and every path it created:

```json
{"mode":"init","projectDir":"/abs/packs/aurelian-forge","minecraftVersion":"1.21.9","packFormat":"69.0","resourcePackVersion":"69.0","files":["mc-asset.pack.json","pack/pack.mcmeta","pack/pack.png"],"directories":["pack","pack/assets","pack/assets/aurelian","pack/assets/aurelian/items","pack/assets/aurelian/models","pack/assets/aurelian/models/item","pack/assets/aurelian/textures","pack/assets/aurelian/textures/block","pack/assets/aurelian/textures/item","recipes"]}
```

`--resource-pack-version` equivalent (`resourcePackVersion`) overrides the
format the release version maps to while the release version stays in the
document. The root metadata follows the pinned target: from resource pack
format 65.0 it declares `min_format` and `max_format` for that target and
leaves the legacy `pack_format` out; below it the document carries the
single legacy major. The generated document is checked in memory against
the `validate-pack` root metadata rules before it is written.

Nothing is overwritten. A path that already exists refuses the whole
batch:

```json
{"code":"PACK_INIT_CONFLICT","message":"pack init found 2 paths it would create.","details":{"path":"/abs/packs/aurelian-forge","minecraftVersion":"1.21.9","conflicts":["pack","pack/pack.mcmeta"]}}
```

A symbolic link, in the project directory or anywhere below it, is
`FILESYSTEM_ERROR` and never written through, and an unknown release
version or an illegal namespace is `INVALID_ARGUMENT`. The tool takes no
`force` and no `mkdir`; the project document it writes is read in strict
mode by the commands that consume it (`PACK_PROJECT_INVALID` naming the
field, `PACK_PROJECT_NOT_FOUND`, `PACK_PROJECT_UNSUPPORTED_VERSION`).

`build` builds the pack project from its recipes into the pack asset directory structure, tracked by `mc-asset.lock.json`. It requires `projectPath` (path to `mc-asset.pack.json`), plus optional `recipe` (a single recipe file; omitted reads every `*.recipe.json` in `recipeDir` in byte-sorted order) and optional `dryRun`.

Call:

```json
{"mode":"build","projectPath":"packs/aurelian-forge/mc-asset.pack.json","dryRun":true}
```

Build execution runs in three stages:
1. *Parse & Plan*: Reads the project document, recipes, resolved style, lockfile (`mc-asset.lock.json`), and source files; expands variables, resolves palettes, and validates all planned outputs in memory without writing bytes.
2. *Classify*: Compares each planned output against the lockfile and disk state into four judgements:
   - `new`: not in lock, not on disk (planned for write).
   - `own-clean`: in lock with matching output hash (skipped if input hash is unchanged, or planned for rewrite if input hash changed).
   - `own-modified`: in lock but disk file output hash differs (user-modified conflict).
   - `foreign`: not in lock but file exists on disk (conflict).
3. *Write*: Performs safe-output preflights across all targets; if all pass, files are written atomically and `mc-asset.lock.json` is updated atomically.

If any planned output is `own-modified` or `foreign`, the entire batch is refused with `PACK_BUILD_CONFLICT` (code 4) listing all conflicts in `details.conflicts`, writing nothing and leaving the lockfile untouched:

```json
{"code":"PACK_BUILD_CONFLICT","message":"pack build found conflicting outputs.","details":{"recipeId":"tool-matrix","conflicts":[{"path":"pack/assets/aurelian/textures/item/iron_sword.png","reason":"foreign"}]}}
```

Result:

```json
{"mode":"build","recipeId":"tool-matrix","outputs":35,"completed":[],"dryRun":true}
```

When run without `dryRun`, `completed` lists every path written, and `mc-asset.lock.json` records output hashes to guarantee idempotent subsequent runs.

A recipe `model` step writes `assets/<namespace>/models/item/<item>.json` (parent preset or custom modelSpec) and an `itemDefinition` step writes `assets/<namespace>/items/<item>.json` (simple default or the select / condition / range_dispatch template), so one target can produce a texture plus several JSON outputs tracked by `kind: model` / `kind: itemDefinition` lock entries. Item definitions require resource-pack format 46.0 or higher (`RECIPE_VERSION_UNSUPPORTED` with `targetId` and the actual format); references to missing models fail with `PACK_BROKEN_REFERENCE`; in the `minecraft` namespace they require `override: true`, otherwise `RECIPE_INVALID`.

## How failures come back

A tool failure sets `isError: true`, and the payload is a JSON string in
`content[0].text`:

```text
isError: true
{"code":"INVALID_ARGUMENT","message":"Rect must be an object with x, y, width, and height.","details":{"path":"operations[1].rect"}}
```

That capture came from `apply_asset_operations` where the second operation's
`fillRect` had no `rect` object.

- `code` is a registry code shared with the CLI (`INVALID_ARGUMENT`,
  `ARGUMENT_CONFLICT`, `FILESYSTEM_ERROR`, `OUTPUT_EXISTS`, …); a failure that
  is not a `McAssetError` becomes `INTERNAL_ERROR`.
- `message` is the CLI message with its leading `[CODE] ` prefix stripped.
- `details` is present only when the error carries context, such as the
  offending operation path.
- `validate_asset` reports `fail` with findings instead of raising, so a bad
  asset is still a normal result.

File-rule failures to expect:

- An existing explicit output path → `OUTPUT_EXISTS`.
- A missing parent directory → `FILESYSTEM_ERROR`.
- `apply_asset_operations` / `recolor_asset` / `create_variants` given a
  non-`.mcpx` source → `INVALID_ARGUMENT`.
- `create_variants` given a missing or non-directory `outputDir` →
  `FILESYSTEM_ERROR`.
- `render_pixel_asset` with both `gridPath` and `gridText` →
  `ARGUMENT_CONFLICT`; with neither → `INVALID_ARGUMENT`.

## Limits and gaps

- **No per-pixel tool.** There is no `set_pixel`; pixel work goes through the
  ASCII Grid, the batch operations array, or the inline `.mcpx` text.
- **Explicit paths only, no overwrite, no mkdir.** An existing target is
  `OUTPUT_EXISTS` and a missing parent is `FILESYSTEM_ERROR`. Pick a new
  path, or create the directory yourself — MCP passes no `--force` and no
  `--mkdir`.
- **Omitted output paths embed the artifact.** Without an output path the
  result carries `pngBase64` (PNG) or `mcpxText` (`.mcpx`) instead of writing
  a file. This is decided per artifact: giving only `outputPngPath` writes the
  PNG and still returns the `.mcpx` text inline.
- **View and feedback images are image blocks, never duplicates.** Neither
  `inspect_asset` `view` nor `apply_asset_operations` feedback repeats its PNG
  as `pngBase64`; the bytes travel as a standard `type: "image"`,
  `mimeType: "image/png"` block. View scale defaults to 1; the long-edge
  auto-scale (a pre-scale edge below 128 scaling up toward 128, capped at 16)
  applies to feedback images only. Anything beyond the 1024px edge is
  `RESOURCE_LIMIT_EXCEEDED`, never a silent downscale.
- **Full CLI parity.** The tools cover intake and source build,
  transforms, palette and quantization, the deterministic pixelize
  pipeline, procedural generation, tiles and previews, animation sheets,
  and single-asset plus whole-pack validation, including
  dependency/vanilla resolution and GUI sprite scaling; version
  targeting travels
  through `analyze_asset`, `validate_asset`, and `validate_pack_asset`
  via `minecraftVersion` / `resourcePackVersion`.
- **Models are checked for structure and references, not appearance.**
  `model_asset` and `validate_pack_asset` verify JSON structure, UV and
  rotation ranges, display transforms, and that referenced models and
  textures exist. No Minecraft client rendered any model, so how a model
  looks or behaves in the game is not verified. Only cuboid `elements` are
  supported. `model_asset` in `preview` mode is a diagnostic view, not a
  game renderer.
- **`optimize_asset` is lossless by pixel comparison.** The result decodes to
  the same pixels as the source, with different bytes. How the result looks
  in a game client was not checked.
- **`validate_asset` checks a single PNG.** Pack-level and atlas-aware
  validation is `validate_pack_asset`.
- **Determinism was verified only for the demo inputs.** Same input plus same
  arguments produced identical results for the demo `px-8x8.png` /
  `sword.mcpx` / `v04-anim-frames/` inputs and a clean pack. Other inputs and
  options (WebP, `WxH` sizes, `region`, `atomic: false`, `animate` `resize`)
  were exercised, but not re-run to confirm they reproduce identically.
- **Runtime.** The MCP path uses only `node:` imports, so the bundled `dist`
  runs under plain Node; CI's `node` job uses Node 22. Node.js 22 or newer is
  required, and the `engines` field declares `>=22`.
- **Not exercised here**: `mcmetaPath`, JPEG input, the uncaptured `mode`
  branches (`palette` `inspect`, `material` `show`, `preview` `palette-map` /
  `scale` / `nine-slice`, `animate` `unpack` / `reorder` / `validate` /
  `preview`), and any error path other than the captured `INVALID_ARGUMENT`
  and the exercised `OUTPUT_EXISTS` / `FILESYSTEM_ERROR` cases.

## Generate metadata with mcmeta

Generate an animation or GUI scaling document from a PNG:

```sh
mc-asset mcmeta animation sheet.png --frame-size 16 --frametime 2 --frames '[0,{"index":1,"time":4},0]' --minecraft-version 1.21.2 --output sheet.png.mcmeta
mc-asset mcmeta gui panel.png --type nine_slice --border 4 --stretch-inner --resource-pack-version 42 --stdout
```

Animation requires `--frame-size <N|WxH>` and a single row or column of equal-sized frames that divide the PNG exactly; grids are rejected. `frametime` defaults to 1. `frames` accepts indices or `{index,time}` objects, including repeated or partial sequences; omitted means all frames in order. Times are positive integers and indices must be in range. `--interpolate` enables interpolation. GUI requires `--type <stretch|tile|nine_slice>`; tile and nine_slice use the PNG dimensions as design dimensions. Nine_slice requires `--border <N|json>` (four nonnegative sides: left, top, right, bottom) with a positive center. Only nine_slice accepts `--stretch-inner`.

CLI requires exactly one explicit `--output <path.mcmeta>` or `--stdout`; it never guesses a sibling name. Existing outputs require `--force`, which replaces the entire file and preserves no other sections. `--mkdir` permits missing parent directories. Inputs and unrelated sibling metadata remain unchanged; aliases and symbolic links are refused. Output is compact JSON with fixed key order and one trailing newline, containing only the requested section.

Use one of `--minecraft-version` or `--resource-pack-version`. GUI scaling requires pack format 16.0; stretch_inner requires 42.0. An incompatible target is `ARGUMENT_CONFLICT` before output. With no target, or a target outside 12.0 through 97.1, `versionChecked` is false with `VERSION_NOT_CHECKED`; this does not bypass GUI minimum versions. Animation is marked checked within that table based on the documented format and its history; this is not a per-release game-client test. See [texture animation and its history](https://minecraft.wiki/w/Resource_pack#Texture_animation) (interpolate added in 14w25a, before the supported release table), [GUI scaling](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w31a), and [pack formats](https://minecraft.wiki/w/Pack_format). These checks establish metadata structure and known version compatibility, not appearance or behavior in a game client.

### mcmeta_asset

Use `mode` (`animation` or `gui`) and `inputPath` (PNG). `animation`: `frameSize`, `frametime`, `frames`, `preset`, `holdTicks`, `interpolate`; `preset` (`hold-and-sweep`, `ping-pong`, or `pulse`) expands `frames` from a named timeline and cannot be combined with `frames`; `gui`: `type`, `border`, `stretchInner`. `minecraftVersion` / `resourcePackVersion` select the target. Fields belonging to the other mode are `INVALID_ARGUMENT`, including false values. `outputPath` writes an explicit `.mcmeta` file with optional `force` / `mkdir`; without `outputPath`, the result includes `mcmetaText` and writes nothing (`force` / `mkdir` require a path). Results include `mode`, `width`, `height`, `versionChecked`, `version`, `target`, `warnings`, and either `output` or `mcmetaText`.

```json
{"mode":"gui","inputPath":"panel.png","type":"nine_slice","border":4,"stretchInner":true,"resourcePackVersion":"42"}
```

## Compare PNG changes

```sh
mc-asset compare before.png after.png --json
mc-asset compare before.png after.png --output diff.png --scale 4
mc-asset compare before.png after.png --stdout --json > diff.png
```

Only same-size PNGs are accepted; different dimensions raise `INVALID_ARGUMENT`. Without `--output` or `--stdout`, the command returns a report and writes nothing. With `--stdout`, PNG bytes go to stdout and the report goes to stderr. `--output` and `--stdout` are mutually exclusive.

The report contains `width`, `height`, `totalPixels`, `rawChangedPixels`, `visibleChangedPixels`, `rawBounds`, and `visibleBounds`. Raw differences compare decoded RGBA channels, including hidden RGB under alpha zero. Visible differences use the existing flatten composition rules but ignore RGB when both pixels have alpha zero. Bounds are zero-based `{x,y,width,height}` rectangles in original-image coordinates, including the last changed pixel; no differences means `null`.

The diagnostic PNG marks visible changes magenta (`255,0,255,255`), raw-only changes cyan (`0,255,255,255`), and unchanged pixels transparent (`0,0,0,0`). It is a diagnostic marker image, not the modified asset. `--scale` is an integer from 1 to 16, default 1, and uses nearest sampling without changing report statistics. Image output, including scaling, must have a longest edge of at most 1024 pixels or raises `RESOURCE_LIMIT_EXCEEDED`; it is never automatically downscaled. Report-only comparisons retain the existing PNG decoder limits.

Both sources remain unchanged. An explicit output must end in `.png`; source aliases and symbolic-link outputs or parents are refused. Existing targets require `--force`; missing parent directories require `--mkdir`. These flags require a file output path. Every output is checked before any file or stdout artifact bytes are emitted.

### compare_assets

Pass `beforePath` and `afterPath` for two same-size PNGs. `image` is `none` (default, report only) or `diff`. `scale` is an integer from 1 to 16, default 1. `outputPath` is accepted only with `image: "diff"`; it writes an explicit `.png`, with optional `force` and `mkdir`. Without `outputPath`, diff mode returns a standard `image/png` image content block alongside the JSON report; Base64 is not duplicated in text. `force` and `mkdir` require `outputPath`.

The report and diagnostic colors, original-coordinate bounds, 1024-pixel scaled-image limit, source protection, and errors follow the PNG comparison rules above. No source is rewritten.

```json
{"beforePath":"before.png","afterPath":"after.png","image":"diff","scale":4}
```
