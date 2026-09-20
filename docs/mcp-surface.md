# MCP Surface (frozen)

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

Entry point: `mc-asset mcp` starts a stdio MCP server. Stdout carries
only MCP JSON-RPC; diagnostics go to stderr; the process ends cleanly
when stdin closes. The server hangs directly off Core and never
reimplements image logic.

Tool names are frozen. Earlier drafts called the batch-edit tool
`edit_asset`; the frozen name is `apply_asset_operations`.

Capability base: analyze, pixelize with presets, ASCII Grid render,
batch operations with atomic transactions, material recolor, variant
fan-out, and validation with explicit `--mcmeta` wiring.

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

## Input semantics

- Every file path is explicit. Producing tools never invent filenames;
  read-only tools never write.
- `profile` is one of `generic`, `minecraft:item`, `minecraft:block`,
  `minecraft:gui`, `minecraft:particle`; omitted means `generic`.
- `minecraftVersion` / `resourcePackVersion` (analyze, validate) select
  the compatibility behavior; accepts `26.3` and packFormat `75`.
- `apply_asset_operations` takes an array of operation objects, each
  with a `type` (the Core batch vocabulary: `setPixel`, `drawLine`,
  `fillRect`, `floodFill`, layer and region operations, and the rest)
  plus its per-type arguments. `atomic` defaults to true.
- When an output path is omitted, the artifact is embedded in the tool
  result (PNG bytes, `.mcpx` text) instead of written to disk.

## Output semantics

- Read-only tools (`analyze_asset`, `validate_asset`) return reports;
  `validate_asset` reports `fail` with findings rather than raising.
- Producing tools return the applied count, per-operation statuses,
  warnings, and either the explicit paths written or the embedded
  artifacts.
