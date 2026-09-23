# MCP Surface (frozen)

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

Entry point: `mc-asset mcp` starts a stdio MCP server. Stdout carries
only MCP JSON-RPC; diagnostics go to stderr; the process ends cleanly
when stdin closes. The server hangs directly off Core and never
reimplements image logic.

Tool names are frozen. Earlier drafts called the batch-edit tool
`edit_asset`; the frozen name is `apply_asset_operations`.

Minecraft targets span `1.19.3` through `26.3`. Of the twenty-one tools, twelve (`import_asset` through `validate_pack_asset`) exist for full CLI parity. Release history lives in [`CHANGELOG.md`](../CHANGELOG.md).

Capability base: full CLI parity — intake and source build, spatial
transforms, palette and quantization, the deterministic pixelize
pipeline, procedural generation, tiles and previews, animation sheets,
and single-asset plus whole-pack validation.

Pixel work never requires hundreds of per-pixel tool calls: authorship
at pixel granularity travels through the ASCII Grid document, the batch
operations array, or the editable `.mcpx` source returned inline. There
is no `set_pixel` tool on purpose.

## Tools

| Tool | Reads | Writes | Result |
|---|---|---|---|
| `analyze_asset` | Raster image (PNG, JPEG, WebP) | Nothing | Read-only report: dimensions, palette, predicted alpha classification (never effective), pixel-art characteristics, recommendations |
| `pixelize_asset` | Reference raster (PNG, JPEG, WebP; never `.mcpx`) | Optional explicit PNG / `.mcpx` paths | Deterministic pipeline output: PNG bytes and/or editable source |
| `render_pixel_asset` | ASCII Grid: exactly one of inline `gridText` or a `gridPath` file, plus an optional batch | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or editable source |
| `apply_asset_operations` | Editable `.mcpx` source plus an operations array | Optional explicit PNG / `.mcpx` paths | Applied count with per-operation statuses; atomic by default (first failure rolls back) |
| `recolor_asset` | Editable `.mcpx` source, builtin material id, optional region id | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or recolored source with change counts |
| `create_variants` | Editable `.mcpx` source, one or more builtin material ids | Required explicit output directory | Per-material `<stem>_<material>.png` plus `.mcpx`, each from the pristine source |
| `validate_asset` | Asset file (PNG), optional explicit `.mcmeta` path used verbatim | Nothing | Read-only verdict with findings |
| `import_asset` | Raster image (PNG, JPEG, WebP) plus an optional batch | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or editable source |
| `build_asset` | Editable `.mcpx` source plus an optional batch | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or built source |
| `transform_asset` | Raster image or `.mcpx`, one geometry flag (a selection raises `ARGUMENT_CONFLICT`) | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or editable source |
| `scale_gui_asset` | Raster image or `.mcpx`, optional explicit `.mcmeta` path | Optional explicit PNG path | Scaled PNG (explicit path or embedded bytes) with the parsed scaling summary |
| `quantize_asset` | Raster image or `.mcpx`, required color count, optional selection | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or editable source |
| `cleanup_asset` | Raster image or `.mcpx`, optional fix classes, optional selection | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or editable source |
| `palette_asset` | Image, one `mode` (`extract` / `inspect`) | Nothing | Read-only report: unique colors, or distribution, roles, and contrast |
| `material_asset` | None (`list`) or a builtin material name (`show` via `mode` + `name`) | Nothing | Read-only report: material list or color ramps |
| `tile_asset` | Raster image or `.mcpx`, optional preview grid and match axes | Optional explicit PNG path | Seam and edge report, or preview PNG |
| `generate_asset` | None (pattern + size + palette + seed) | Optional explicit PNG / `.mcpx` paths | Deterministic procedural PNG bytes and/or editable source |
| `preview_asset` | Raster image or `.mcpx`, one `mode` (`ascii` / `palette-map` / `scale` / `nine-slice`) | Optional explicit PNG path (`scale`, `nine-slice`) | Read-only report, or preview PNG |
| `animate_asset` | Frames directory or sprite sheet, one `mode` (`pack` / `unpack` / `reorder` / `resize` / `validate` / `preview`) | Explicit PNG path (`pack`) or output directory (`unpack`, `reorder`, `resize`) | Sheet PNG, frames, or read-only report |
| `validate_pack_asset` | Resource pack root, plus optional vanilla tree and dependency roots | Nothing | Read-only verdict with findings and a coverage object |
| `inspect_asset` | Editable `.mcpx` source or raster image (raster reads as a single base layer), one `mode` (`structure` / `view`), view-only `crop` and `scale` | Nothing | Read-only report (structure), or composited PNG image block plus metadata (view) |

## Input semantics

- Every file path is explicit. Producing tools never invent filenames;
  read-only tools never write.
- `profile` is one of `generic`, `minecraft:item`, `minecraft:block`,
  `minecraft:gui`, `minecraft:particle`; omitted means `generic`.
- `minecraftVersion` / `resourcePackVersion` (analyze, validate,
  validate-pack) select the compatibility behavior; accepts release
  versions `1.19.3` through `26.3` (for example `1.19.3`, `1.21.4`,
  `26.3`) and resource-pack `N` or `N.M` (e.g. `84`, `97.1`),
  normalized to `major.minor`. Omitted means engine defaults.
- Subcommand tools merge CLI modes into a `mode` field: `palette_asset`
  (`extract` / `inspect`), `material_asset` (`list` / `show`),
  `preview_asset` (`ascii` / `palette-map` / `scale` / `nine-slice`),
  `animate_asset` (`pack` / `unpack` / `reorder` / `resize` /
  `validate` / `preview`).
- `apply_asset_operations` takes an array of operation objects, each
  with a `type` (the Core batch vocabulary: the nine pixel operations
  `setPixel`, `clearPixel`, `drawLine`, `drawRect`, `fillRect`,
  `floodFill`, `ellipse`, `polygonFill`, `strokeMask`, plus layer and
  region operations, `stampRect`, `regionFromSelection`, and the rest)
  plus its per-type arguments.
  `atomic` defaults to true; with `atomic: false` every operation runs
  and the result reports per-operation applied/failed statuses instead
  of rolling back. Pixel operations accept an optional
  `selection` expression; an empty match refuses the write with
  `EMPTY_SELECTION` and rolls the batch back.
- Selection expressions name atoms (`all`, `rect:x,y,w,h`, `region:id`,
  `alpha[:layer]`, `color[:layer]:r,g,b,a`, `connected[:layer]:x,y`) or
  a JSON AST object (`{"op": "union" | "intersect" | "subtract" |
  "invert", "operands": [...]}`), capped at depth 32 and 1024 nodes.
  `polygonFill` takes at most 4096 points; a self-intersecting ring is
  `SELF_INTERSECTING_POLYGON`, and holes are unsupported.
- `apply_asset_operations` accepts an optional `feedback` object
  (`image`: `none` / `full` / `changed`; `scale`: integer 1–16;
  `crop`: selection expression; `diff`: `none` / `summary`). Absent
  `feedback` keeps the output fields and bytes exactly as before. With
  `feedback`, the result carries a `feedback` object (`image`,
  `imageIncluded`, optional `noVisibleChange`, optional `diff` with
  `raw` / `composited` / `structural` / `outsideSelectionUnchanged`)
  and never embeds `pngBase64`: an included image travels as a standard
  image content block (`type: "image"`, `mimeType: "image/png"`) with no
  duplicate bytes in the text block. `changed` renders the composited
  change bounds (the crop is ignored) and reports `noVisibleChange`
  instead of an image when nothing visible moved; guide pixels (grids,
  checkers) never enter artwork bytes. A `crop` with `none` is
  `INVALID_ARGUMENT`.
- `inspect_asset` takes `inputPath` plus `mode`: `structure` returns
  layers (bounds, area, visibility, raw RGBA color usage), regions
  (identity, bounds, area only), and overlaps; `view` returns the
  composited PNG as an image block plus the six-key metadata, with the
  same crop/scale/1024px-edge rules as the top-level `inspect` command.
  View scale defaults to 1; the long-edge auto-scale applies to
  `apply_asset_operations` feedback images only.
- The full per-type parameter table lives in the “Batch Operations Specification”
  section of [CLI Surface](cli-surface.md); both surfaces share that JSON shape.
- `scale_gui_asset` takes `size` (`N` or `WxH`), an optional
  `mcmetaPath` (omitted means `stretch`), and optional version fields;
  output is PNG only.
- `validate_pack_asset` takes an optional `vanillaPath` and an optional
  ordered `dependencyPaths` (earlier entries win).
- `transform_asset` / `animate_asset` accept `nearest` / `box` /
  `pixel-aware` for `resizeMode`.
- When an output path is omitted, the artifact is embedded in the tool
  result (PNG bytes, `.mcpx` text) instead of written to disk.

## Output semantics

- Read-only tools (`analyze_asset`, `validate_asset`, `palette_asset`,
  `material_asset`, `validate_pack_asset`) return reports;
  `validate_asset` reports `fail` with findings rather than raising.
- Validation reports carry `coverage: {status, skipped}`; `partial`
  lists each skipped check with its kind and reason, and never changes
  the exit code.
- Mixed tools (`tile_asset`, `preview_asset`, `animate_asset`) return
  reports in read-only modes and write only to the explicit output
  path or directory in writing modes.
- Producing tools return the applied count, per-operation statuses,
  warnings, and either the explicit paths written or the embedded
  artifacts.
