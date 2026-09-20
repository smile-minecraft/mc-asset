# MCP server guide (mc-asset)

[English](mcp-guide.md) | [繁體中文](mcp-guide.zh-TW.md) | [简体中文](mcp-guide.zh-CN.md)

`mc-asset mcp` starts a stdio MCP server: stdout carries only MCP JSON-RPC,
diagnostics go to stderr, and the process ends when stdin closes. The frozen
surface — seven tool names, their inputs, and the read/write contract — lives
in `docs/mcp-surface.md`; the input fields are frozen in `src/mcp/schema.ts`.
This guide covers registration, one verbatim capture per tool, the error
model, and the limits.

The server hangs directly off Core, so every tool runs the same engine the CLI
commands use. Pixel-granularity authorship travels through the ASCII Grid
document, the batch operations array, or the editable `.mcpx` source returned
inline; there is no `set_pixel` tool by design.

## Installing and registering the server

The server ships inside the Homebrew-installed `mc-asset` binary, so install
that first (see the Installation section of the README for the Homebrew tap).

Then add the `mc-asset` entry to the global OpenCode config
(`~/.config/opencode/opencode.jsonc`) as an MCP server:

```jsonc
"mc-asset": {
  "type": "local",
  "command": ["/opt/homebrew/bin/mc-asset", "mcp"],
  "enabled": true
}
```

The `command` points at the installed binary (`/opt/homebrew/bin/mc-asset` is
the Homebrew install on this machine).

Then fully restart OpenCode. MCP servers load at startup, so a config change
without a restart proves nothing. To roll back, remove the entry (or restore
the config backup) and restart again.

The captures below were taken against the installed build with the MCP client
SDK, from a demo working directory; every path in them is relative to that
directory.

## The seven tools

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
{"profile":"generic","preset":"item","presetDetail":"preset=item colors=16 edge=0 cluster=0 cleanup=outlier pending-review (item: tight 16-color budget, outlier cleanup, no heuristics)","width":16,"height":16,"colors":16,"colorCount":16,"stages":["decode","crop","background","subject","resize","edge","quantize","cluster","cleanup","preset","output"],"warnings":[],"output":"out/pixelize16.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n0 = #124B44FF\n… 15 more palette entries (1–F); the last is F = #DDA5DEFF …\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[gr… (truncated) …"}
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

### recolor_asset

Recolors every layer of an `.mcpx` source with one builtin material id; an
optional `region` limits the write to a single region. `material` is required.

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

Fans one `.mcpx` source out to one PNG plus one `.mcpx` per material under an
explicit `outputDir`, each starting from the pristine source. Listing the same
material twice in one call is `ARGUMENT_CONFLICT`.

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

Result (verbatim; the second finding's message is truncated):

```text
{"verdict":"pass","profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"dimensions":{"width":8,"height":8},"totalPixels":64,"colorCount":64,"findings":[{"code":"PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING","level":"warning","message":"predicted translucent: 1 partial-alpha pixel(s) use the translucent render pass; left as-is with no auto-fix."},{"code":"VERSION_FACT_UNDETERMINED","level":"warning","message":"Com… (truncated) …"}]}
```

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
  `OUTPUT_EXISTS` and a missing parent is `FILESYSTEM_ERROR`. The error
  messages still mention `--force` / `--mkdir`, but there is no way to pass
  either through MCP — pick a new path, or create the directory yourself.
- **Omitted output paths embed the artifact.** Without an output path the
  result carries `pngBase64` (PNG) or `mcpxText` (`.mcpx`) instead of writing
  a file. This is decided per artifact: giving only `outputPngPath` writes the
  PNG and still returns the `.mcpx` text inline.
- **The surface covers core engine tools.** `tile`, `generate`, `preview`,
  `animate`, `validate-pack`, and version targeting stay on the CLI for now.
- **`validate_asset` checks a single PNG.** Pack-level and atlas-aware
  validation lives in `validate-pack` on the CLI.
- **Determinism was checked for the demo inputs.** Same input plus same
  arguments produced identical results; only the demo `px-8x8.png` /
  `sword.mcpx` inputs were exercised, so other formats stay unverified.
- **Runtime.** The MCP path uses only `node:` imports, so the bundled `dist`
  runs under plain Node; CI's `node` job uses Node 22. No minimum Node version
  is declared (there is no `engines` field).
- **Not exercised here**: `mcmetaPath`, `region`, `atomic: false`, JPEG/WebP
  inputs, `WxH` sizes, and any error path other than the one captured above.
