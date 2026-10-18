# MCP Surface (frozen)

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

Entry point: `mc-asset mcp` starts a stdio MCP server. Stdout carries
only MCP JSON-RPC; diagnostics go to stderr; the process ends cleanly
when stdin closes. The server hangs directly off Core and never
reimplements image logic.

Tool names are frozen. Earlier drafts called the batch-edit tool
`edit_asset`; the frozen name is `apply_asset_operations`.

Minecraft targets span `1.19.3` through `26.3`. Among the tools, twelve (`import_asset` through `validate_pack_asset`) exist for full CLI parity. Release history lives in [`CHANGELOG.md`](../CHANGELOG.md).

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
| `recolor_asset` | Editable `.mcpx` source or flat PNG, builtin material id or family id, optional region id, selection, style | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or recolored source with change counts |
| `create_variants` | Editable `.mcpx` source or flat PNG, builtin material ids and/or family ids, selection, region, nameTemplate | Required explicit output directory | Per-entry `<stem>_<name>.png` plus `.mcpx`, each from the pristine source |
| `validate_asset` | Asset file (PNG), optional explicit `.mcmeta` path used verbatim | Nothing | Read-only verdict with findings |
| `import_asset` | Raster image (PNG, JPEG, WebP) plus an optional batch | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or editable source |
| `build_asset` | Editable `.mcpx` source plus an optional batch | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or built source |
| `transform_asset` | Raster image or `.mcpx`, one geometry flag (a selection raises `ARGUMENT_CONFLICT`) | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or editable source |
| `scale_gui_asset` | Raster image or `.mcpx`, optional explicit `.mcmeta` path | Optional explicit PNG path | Scaled PNG (explicit path or embedded bytes) with the parsed scaling summary |
| `quantize_asset` | Raster image or `.mcpx`, exactly one of a color count (`colors`) or `palette` (builtin material name or `.mcpx` path), optional `keepColors` (RGBA objects), optional selection | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or editable source |
| `cleanup_asset` | Raster image or `.mcpx`, optional fix classes, optional selection | Optional explicit PNG / `.mcpx` paths | PNG bytes and/or editable source |
| `palette_asset` | Image, one `mode` (`extract` / `inspect`) | Nothing | Read-only report: unique colors, or distribution, roles, and contrast |
| `material_asset` | None (`list`) or a builtin material name (`show` via `mode` + `name`) | Nothing | Read-only report: material list or color ramps |
| `tile_asset` | Raster image or `.mcpx`, optional preview grid and match axes | Optional explicit PNG path | Seam and edge report, or preview PNG |
| `generate_asset` | None (pattern + size + palette + seed) | Optional explicit PNG / `.mcpx` paths | Deterministic procedural PNG bytes and/or editable source |
| `preview_asset` | Raster image or `.mcpx`, one `mode` (`ascii` / `palette-map` / `scale` / `nine-slice`) | Optional explicit PNG path (`scale`, `nine-slice`) | Read-only report, or preview PNG |
| `animate_asset` | Frames directory or sprite sheet, one `mode` (`pack` / `unpack` / `reorder` / `resize` / `validate` / `preview`) | Explicit PNG path (`pack`) or output directory (`unpack`, `reorder`, `resize`) | Sheet PNG, frames, or read-only report |
| `validate_pack_asset` | Resource pack root, plus optional vanilla tree and dependency roots | Nothing | Read-only verdict with findings and a coverage object |
| `inspect_asset` | Editable `.mcpx` source or raster image (raster reads as a single base layer), one `mode` (`structure` / `view`), view-only `crop` and `scale` | Nothing | Read-only report (structure), or composited PNG image block plus metadata (view) |
| `optimize_asset` | PNG files (1 to 256 explicit paths) or a directory (`inputDir`, up to 4096 PNGs, optional `recursive`) | Optional explicit PNG output path (single explicit input), or an existing output directory | Per-file report (source and result size, mode, candidates, chunks, warnings) plus totals; PNG bytes embedded for one input without an output |
| `model_asset` | Java block/item model JSON, one `mode` (`inspect` / `validate` / `create` / `apply` / `export` / `preview`), optional pack, vanilla, and dependency roots | Optional explicit `.json` paths (model, item definition, blockstate), or an explicit `.png` path (`preview`) | Read-only report (`inspect`, `validate`), the model document and generated bindings (`create`, `apply`, `export`), or a diagnostic three-view PNG (`preview`) |
| `mcmeta_asset` | PNG sprite sheet (`animation`) or design sprite (`gui`), mode-specific parameters, version fields | Optional explicit `.mcmeta` output path (`force`, `mkdir`) | Generated `.mcmeta` text and metadata summary (writes file only with `outputPath`) |
| `compare_assets` | Two same-size PNGs, `image` (`none` / `diff`), `scale` (1–16) | Optional explicit PNG output path (`force`, `mkdir`; only with `image: "diff"`) | Comparison report (dimensions, raw and visible difference counts, bounds) plus optional standard PNG image block (writes file only with `outputPath`) |
| `style_asset` | Style presets and `.style.json` sources, or one raster image (`lint`), one `mode` (`list` / `show` / `export-palette` / `create` / `lint`) | Optional explicit `.mcpx` path (`export-palette`) or `.style.json` path (`create`) | Preset list, resolved style, palette `.mcpx` text or file, the written style document, or a style report |
| `pack_asset` | Nothing; one `mode` (`init`) plus a project directory, namespace, and release version | The new project directory and nothing else | Report of the created project skeleton, or a refusal with the conflicting paths |

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
  `style_asset` (`list` / `show` / `export-palette` / `create` / `lint`),
  `pack_asset` (`init`),
  `preview_asset` (`ascii` / `palette-map` / `scale` / `nine-slice`),
  `animate_asset` (`pack` / `unpack` / `reorder` / `resize` /
  `validate` / `preview`).
- `style_asset` carries the four builtin presets (`vanilla`, `soft`,
  `fairy-flat`, `dark-frame`), each with twelve families and six roles
  (`outline`, `shadow`, `dark`, `base`, `light`, `highlight`).
  `list` reports the presets and, with `paths`, the custom `.style.json`
  sources it can load; a `paths` entry that cannot load fails the call with
  `STYLE_INVALID`. `show` takes `style` (builtin id or `.style.json` path)
  and returns the resolved document plus its `extendsChain`. `export-palette`
  takes `style` and `family` (a family id or `all`): without
  `outputMcpxPath` the palette `.mcpx` text returns in the result, with it
  the file is written (`force` replaces it). `create` takes `outputPath`
  and `id`, plus optional `name` (defaults to the id), `extends` (defaults
  to `vanilla`), `overrides` merged into the document, `force`, and `mkdir`.
  A style file is strict: an unknown field, an enumeration value outside
  its list, or a color that is not `#RRGGBB` is `STYLE_INVALID` naming the
  field path, and other codes cover an unknown id (`STYLE_NOT_FOUND`), an
  `extends` cycle (`STYLE_INHERITANCE_CYCLE`), a newer `formatVersion`
  (`STYLE_UNSUPPORTED_VERSION`), and a family the style does not resolve
  (`STYLE_FAMILY_NOT_FOUND`). The tool never rewrites a style file it did
  not create.
- `style_asset` in `lint` mode takes `inputPath` plus the optional `style`
  (default `vanilla`) and `category`, and returns the frozen report: `mode`,
  `path`, `style`, `category`, the same `metrics` block `analyze_asset`
  reports under `styleMetrics`, `findings`, `skipped`, and `verdict`
  (`pass`, `warnings`, `fail`). Each finding carries `code`, `level`,
  `measured`, `threshold`, `message`, and `suggestion`; every code is a
  warning except `STYLE_COLOR_BUDGET`. A metric with nothing to compare
  reports no finding and a `skipped` reason instead. `category` applies that
  category's threshold overrides, and an animation strip is measured as its
  first frame (`firstFrameOnly: true`). The image is read only.
- `pack_asset` creates one resource pack project. `init` takes
  `projectDir`, `namespace`, and `minecraftVersion` (all required) plus
  optional `name` (defaults to the directory name), `description`
  (defaults to the name), `style` (defaults to `vanilla`), and
  `resourcePackVersion` (overrides the format the release version maps
  to, while the release version stays in the document), with
  `allowMinecraftNamespace` required for `namespace: minecraft`. One
  preflighted batch writes `mc-asset.pack.json`, `pack/pack.mcmeta`, a
  64x64 `pack/pack.png` placeholder icon, and the resource pack
  directories, and the result reports the pinned format plus every file
  and directory it created. The root metadata follows the target: from
  resource pack format 65.0 it declares `min_format` and `max_format`
  for that target and leaves the legacy `pack_format` out, below it the
  document carries the single legacy major, and the generated document
  is checked in memory before it is written. An unknown release version
  or a namespace outside `[a-z][a-z0-9_.-]{0,63}` is
  `INVALID_ARGUMENT`. An occupied path refuses the whole batch with
  `PACK_INIT_CONFLICT` and a `conflicts` list of every relative path
  already in place, and a symbolic link is `FILESYSTEM_ERROR` and never
  written through; the tool takes no `force` and no `mkdir`. The project
  document is read in strict mode by the commands that consume it: an
  unknown field or a path leaving the project root is
  `PACK_PROJECT_INVALID` naming the field, an unreadable path is
  `PACK_PROJECT_NOT_FOUND`, and a newer `formatVersion` is
  `PACK_PROJECT_UNSUPPORTED_VERSION`.
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
- `outline` is the twenty-sixth operation `type`. It frames the
  non-transparent pixels of one `layerId`, on the body edge (`inside`,
  default) or on the empty cells touching the body (`outside`), in five
  modes: `tinted` (darkened adjacent body colour, integer HSL),
  `selective` (backlit side only, light at the top left), `uniform` (a
  required `#RRGGBB` colour), `black`, and `strip` (an existing frame
  becomes the neighbouring interior colour). `color` on any other mode is
  `INVALID_ARGUMENT`; `family` accepts one of the twelve builtin families
  and snaps the derived colour to the closer `outline` or `shadow` step of
  the builtin vanilla ramp while `snapFamilies` is true, otherwise an
  unknown family id is `INVALID_ARGUMENT`. `luminanceDropPermille`
  (default 120), `saturationRatioPermille` (default 1000), and
  `maxHueOffsetDegrees` (default 5) are integers; the last one is recorded
  for style checks and never changes the output. It accepts the same
  optional `selection`. The per-type table is in `docs/cli-surface.md`.
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
- `recolor_asset` requires either `material` or `family` (mutually exclusive: neither is `INVALID_ARGUMENT`, both is `ARGUMENT_CONFLICT`). `style` defaults to `vanilla`. `selection` limits the write scope, restoring unselected pixels verbatim.
- `create_variants` requires at least one of `materials` or `families` (neither is `INVALID_ARGUMENT`; both coexist producing the union of both, and colliding output filenames raise `ARGUMENT_CONFLICT`). `nameTemplate` supports `{stem}` and `{name}` (defaulting to `{stem}_{name}`).
- On the material path, flat PNG pixels map by integer luminance bands (<96 shadow, 96–159 base, ≥160 highlight) onto the target material palette. On the palette family path (`family` / `families`), role-aware sources map roles directly to the family roles (`outline`, `shadow`, `dark`, `base`, `light`, `highlight`) while `accent` and `custom` follow the six integer luminance bands; flat PNG sources map by the six bands (<43 outline, 43–85 shadow, 86–127 dark, 128–170 base, 171–213 light, ≥214 highlight); outline pixels (adjacent to transparency or canvas boundary) are forced to the target family's `outline` color; fully transparent pixels stay byte-identical including hidden RGB; translucent pixels are forced to fully opaque ramp colors. A missing region keeps `REGION_NOT_FOUND`. Each variant starts from the same pristine source; JPEG and WebP are still refused.
- The full per-type parameter table lives in the “Batch Operations Specification”
  section of [CLI Surface](cli-surface.md); both surfaces share that JSON shape.
- `scale_gui_asset` takes `size` (`N` or `WxH`), an optional
  `mcmetaPath` (omitted means `stretch`), and optional version fields;
  output is PNG only.
- `optimize_asset` takes either `inputPaths` (1 to 256 explicit PNG files) or `inputDir` (a directory containing PNG files, up to 4096 PNGs, optional `recursive` defaulting to false). Giving both raises `ARGUMENT_CONFLICT`; giving neither raises `INVALID_ARGUMENT`. In directory mode:
  - Relative paths are traversed in strict UTF-8 byte order and preserved under `outputDir`.
  - Symbolic links are never followed: any symlink in the scan scope raises `FILESYSTEM_ERROR` (`symlink-not-supported`).
  - Source and output directories must be disjoint and cannot contain or alias each other (`ARGUMENT_CONFLICT`).
  - Preflight enforces budget limits before writing: at most 4096 PNGs, at most 256 MiB source size, and at most 16,777,216 total decoded pixels (`RESOURCE_LIMIT_EXCEEDED`).
  - Non-PNG regular files (`.mcmeta` etc.) are skipped and never copied; a directory with no PNGs raises `INVALID_ARGUMENT`.
  - Directory mode accepts only `outputDir` (which must already exist; MCP never creates directories) or `dryRun: true`; single-file `outputPath` or embedding is refused.
- Other `optimize_asset` fields: optional `mode` (`auto` default, `rgba`, `rgb`, `grayscale`, `grayscale-alpha`, `indexed`), `ancillary` (`preserve` default, `strip`), `dryRun`, `outputPath` (exactly one explicit input), and `outputDir` (an existing directory). For explicit inputs, several inputs need `outputDir` or `dryRun`; otherwise the tool raises `INVALID_ARGUMENT`. A forced `mode` that cannot hold the pixels exactly is `OPTIMIZE_MODE_NOT_EXACT`.
- `model_asset` takes `mode` plus the fields that mode needs: `inputPath`
  (`inspect`, `validate`, `apply`, `export`, `preview`), `spec` (`create`), `operations`
  (`apply`, 1 to 1000), `binding` (`export`), `packPath` / `vanillaPath` /
  `dependencyPaths` (`inspect`, `validate`, `preview`; `packPath` also `export`),
  `outputPath`, `itemOutputPath`, and `blockstateOutputPath`. A field the
  mode does not accept is `INVALID_ARGUMENT` naming the field and the mode.
  Model support covers cuboid `elements` only.
- `model_asset` in `preview` mode renders a fixed diagnostic image with
  `size` (64, 128, or 256; default 64) and an optional `outputPngPath`.
  The PNG holds three square panels side by side (`front` = north face seen
  from the north, `right` = east face seen from the east, `top` = up face
  seen from above with north at the top). Without `outputPngPath` nothing is
  written and the image returns as a standard image block; with
  `outputPngPath` the file is written and only the report returns as text.
  The same first-release limits as the CLI apply (axis-aligned cuboids,
  exact 1/256 coordinates, existing UVs with 0/90/180/270 face rotation,
  fixed checkerboard for missing textures, partial coverage for element
  rotation, translucent faces, and unresolvable textures; `display` and
  game lighting are not applied).
- `validate_pack_asset` takes an optional `vanillaPath` and an optional
  ordered `dependencyPaths` (earlier entries win).
- `transform_asset` / `animate_asset` accept `nearest` / `box` /
  `pixel-aware` for `resizeMode`.
- When an output path is omitted, the artifact is embedded in the tool
  result (PNG bytes, `.mcpx` text) instead of written to disk.

## Output semantics

- `analyze_asset` adds one block to its report, `styleMetrics`: the frozen
  integer style measurement (opaque pixels, colors, levels, dynamic range,
  TL-BR, coverage, margin, outline pixels, outline gap and hue offset, hue
  bins, highlight and buffer, dither, main axis, and `firstFrameOnly`). Its
  existing fields are unchanged, and the image is still only read.
- Read-only tools (`analyze_asset`, `validate_asset`, `palette_asset`,
  `material_asset`, `validate_pack_asset`) return reports;
  `validate_asset` reports `fail` with findings rather than raising.
  In `style_asset`, `list` and `show` are read-only; `export-palette` and
  `create` write only to their explicit output path, and the style sources
  they read stay unchanged. `pack_asset` writes a new project directory
  once and never rewrites it.
- Validation reports carry `coverage: {status, skipped}`; `partial`
  lists each skipped check with its kind and reason, and never changes
  the exit code.
- Mixed tools (`tile_asset`, `preview_asset`, `animate_asset`) return
  reports in read-only modes and write only to the explicit output
  path or directory in writing modes.
- Producing tools return the applied count, per-operation statuses,
  warnings, and either the explicit paths written or the embedded
  artifacts.
- `optimize_asset` and `model_asset` never accept `force`, `mkdir`, or
  in-place targets: an existing output is `OUTPUT_EXISTS`, and a missing parent
  directory is `FILESYSTEM_ERROR`. Every target is checked before the first
  byte is written; aliases of an input, symlink targets, and symlinked parent
  directories are refused. Multi-file writes commit each target atomically rather
  than as a transaction: if a write fails midway, files already committed stay,
  and error details report `completed`, `failedTarget`, and `notStarted`.
  Without an output path the result embeds the
  artifact (`pngBase64`, `modelText`, `itemText`, `blockstateText`).
- `optimize_asset` and `model_asset` report pixel equality, structure, and
  reference validity only. No game client renders the result, so appearance
  and in-game behavior are not verified. `model_asset` in `preview` mode is
  a diagnostic view, not a game renderer.

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

Use `mode` (`animation` or `gui`) and `inputPath` (PNG). `animation`: `frameSize`, `frametime`, `frames`, `interpolate`; `gui`: `type`, `border`, `stretchInner`. `minecraftVersion` / `resourcePackVersion` select the target. Fields belonging to the other mode are `INVALID_ARGUMENT`, including false values. `outputPath` writes an explicit `.mcmeta` file with optional `force` / `mkdir`; without `outputPath`, the result includes `mcmetaText` and writes nothing (`force` / `mkdir` require a path). Results include `mode`, `width`, `height`, `versionChecked`, `version`, `target`, `warnings`, and either `output` or `mcmetaText`.

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
