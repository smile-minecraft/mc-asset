# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Quality checks and delivery (interfaces only; engines land in the follow-up): `preview contact-sheet` / `preview_asset` `contact-sheet` lays labeled sheets with the original 5x7 pixel font; `style audit` / `style_asset` `audit` compares a texture group against one baseline; `pack check` / `pack_asset` `check` merges pack validation with style measurement and an ordered fix list; `pack package` / `pack_asset` `package` writes the built pack as a reproducible zip. New error codes `STYLE_FAMILY_SIZE_DRIFT`, `STYLE_FAMILY_SILHOUETTE_DRIFT`, and `STYLE_FAMILY_PALETTE_DRIFT`.

- Vanilla texture catalog and client jar extraction (interfaces only; engines land in the follow-up): `pack catalog` / `pack_asset` `catalog` lists the PNG textures under a caller-given vanilla tree with category, decoded size, animation flag, and mask family; `pack extract` / `pack_asset` `extract` copies only `assets/` entries from a caller-specified jar. New error codes `PACK_CATALOG_INVALID` and `PACK_ARCHIVE_INVALID`.

- Recipe-driven resource pack building with the `pack build` command and the `pack_asset` MCP tool `build` mode: executes batch asset generation from recipes (`*.recipe.json`) into the pack directory structure, tracked by an `mc-asset.lock.json` lockfile. Execution follows three stages: parse and plan (memory-only expansion of recipes, variables, styles, and sources), classification against lock entries and disk state into four judgements (`new`, `own-clean`, `own-modified`, `foreign`), and safe atomic writes. If any output is modified on disk (`own-modified`) or exists unrecorded (`foreign`), the entire batch is refused with `PACK_BUILD_CONFLICT` and a conflict list, writing nothing. `--dry-run` / `dryRun: true` stops after classification and reports planned outputs without disk writes. New error codes `RECIPE_INVALID`, `RECIPE_UNSUPPORTED_VERSION`, `RECIPE_OUTPUT_CONFLICT`, `RECIPE_VERSION_UNSUPPORTED`, `RECIPE_SOURCE_MISSING`, `PACK_BUILD_CONFLICT`, `PACK_LOCK_INVALID`, `PACK_LOCK_UNSUPPORTED_VERSION`, and `PACK_BROKEN_REFERENCE`.

- Model and item definition auto-generation from `model` and `itemDefinition` recipe steps: a `model` step writes `assets/<namespace>/models/item/<item>.json` from a parent preset or a custom model document, and an `itemDefinition` step writes `assets/<namespace>/items/<item>.json` from one of the four templates (`simple`, `select`, `condition`, `range_dispatch`) per spec section 5.4. Both are planned as `kind: model` / `kind: itemDefinition` lock entries alongside texture outputs. Item definitions require resource-pack format 46.0 or higher; model and item files follow the fixed relative paths, use byte-ordered keys with two-space indent and a trailing newline, and the `minecraft` namespace requires `override: true`.

- Sweep band animation and timeline presets: `animate sweep <image>` and `animate_asset` mode `sweep` turn one still image into a vertical sheet of frames where a highlight band walks across it, frame 0 being the untouched source. `angle` takes 45, 90, 135, or 180 and refuses every other angle; the band coordinate is `x - y` at 135 degrees, `x + y` at 45, `x` at 90, and `y` at 180, and the band advances two coordinate units per frame on the two diagonals and one on the straight angles. `width` (1 to 8), `color` (an opaque `#RRGGBB`), `frames` (including frame 0), `frametime`, and `holdTicks` come from the resolved style's animation rules unless a flag overrides one; the CLI takes `--style` (a builtin preset id or a `.style.json` file, default `vanilla`) and the tool takes the builtin default. Only fully opaque source pixels are repainted, so the silhouette, the alpha plane, and every hidden colour under alpha 0 stay byte-identical across the whole sheet, and the sweep is integer-only with no trigonometry. `mcmeta animation` and `mcmeta_asset` gain `preset` (`hold-and-sweep`, `ping-pong`, or `pulse`), which expands `frames` from a named timeline instead of taking a list: the first shape rests frame 0 for `holdTicks` and plays forward, the second plays forward and back without repeating either end, the third rests both ends on the way out and back. `preset` and `frames` together are `ARGUMENT_CONFLICT`, a sheet of one or two frames expands without repeating an end, and plain entries stay bare indices so `frametime` applies to them.
- `animate unpack` / `animate_asset` `unpack` take a `format` field: `mcpx` stays the default and keeps its bytes, `png` writes one PNG per frame with the historical zero-padded names (`frame_0.png` to `frame_9.png`); any other value is `INVALID_ARGUMENT`. `animate preview` / `animate_asset` `preview` write the sheet image when an output PNG path is given, in exactly the layout the report describes; without one the report is unchanged and nothing is written.
- Palette family recolor for `recolor` / `recolor_asset` and `variant` / `create_variants`: a family recolors with one of the twelve builtin families taken from `--style` (a builtin preset id or a `.style.json` file, default `vanilla`), mapping a role-aware source's roles directly onto the family ramp roles (`outline`, `shadow`, `dark`, `base`, `light`, `highlight`) while `accent` and `custom` follow the six integer luminance bands (<43 outline, 43–85 shadow, 86–127 dark, 128–170 base, 171–213 light, ≥214 highlight); a flat PNG source carries no roles and maps by those same six bands. Outline pixels, the body pixels touching transparency or the canvas boundary, always take the family `outline` colour instead of following the band; fully transparent pixels stay byte-identical including hidden RGB; translucent pixels are forced to fully opaque ramp colours; `--region`, `selection`, and the preserved regions and roles restore every protected pixel verbatim. `recolor` takes exactly one of `--material` or `--family` (neither `INVALID_ARGUMENT`, both `ARGUMENT_CONFLICT`), `create_variants` takes at least one of `--materials` or `--families` (neither `INVALID_ARGUMENT`; both coexist producing the union of both sets, and colliding output filenames are `ARGUMENT_CONFLICT`), and `--name-template` takes `{stem}` and `{name}` (default `{stem}_{name}`). The existing material path keeps its three-band mapping and its output bytes unchanged.
- Batch operation `outline`, a twenty-sixth operation `type` for `--operations` and `apply_asset_operations`: it frames the non-transparent pixels of one `layerId`, either on the body edge (`inside`, default) or on the empty cells touching the body (`outside`), in five modes. `tinted` (default) darkens the adjacent body colour in integer HSL by `luminanceDropPermille` (default 120) while scaling its saturation by `saturationRatioPermille` (default 1000); `selective` applies the same derived colour only to the backlit side, with the light at the top left; `uniform` fills the frame with a required `#RRGGBB` colour; `black` fills it with opaque black; `strip` removes an existing frame by copying the darkest neighbouring interior pixel over each body edge pixel, so the body never changes size and empty pixels keep their hidden bytes. `family` takes one of the twelve builtin families and, while `snapFamilies` is true, snaps the derived colour to the closer of that family's `outline` and `shadow` steps on the builtin vanilla ramp. `color` on a non-`uniform` mode, an unknown family id, and a number outside its range are `INVALID_ARGUMENT`; an empty `selection` is `EMPTY_SELECTION` with the usual batch rollback, and unselected bytes, including hidden RGB under alpha 0, stay verbatim. Every step is integer-only and the same bytes produce the same bytes on Bun and Node.
- Resource pack project creation with the `pack init` command and the `pack_asset` MCP tool (twenty-six to twenty-seven tools). `init` writes one preflighted batch: the project document `mc-asset.pack.json` (name, description, namespace, release version, resource-pack format, style, output and recipe directories), `pack/pack.mcmeta` generated for the pinned target, a 64x64 original placeholder icon, and the resource pack directories including `items/` from resource pack format 46.0 on. The root metadata pins `min_format` and `max_format` from resource pack format 65.0 and writes the single legacy major below it, and the generated document is checked in memory against the `validate-pack` root metadata rules before it is written. a `minecraft` namespace requires an explicit opt-in, a project is created once and never rewritten, an occupied path refuses the whole batch with `PACK_INIT_CONFLICT` and a conflict list instead of overwriting, and a symbolic link is refused outright. Project documents are read in strict mode by the commands that consume them, naming the rejected field. New error codes `PACK_PROJECT_NOT_FOUND`, `PACK_PROJECT_INVALID`, `PACK_PROJECT_UNSUPPORTED_VERSION`, and `PACK_INIT_CONFLICT`.
- Builtin materials `diamond` and `netherite` with complete seven-role ramps (`outline`, `shadow`, `dark`, `base`, `light`, `highlight`, `accent`) measured from vanilla gear textures. `material list` now yields nine materials in deterministic order.
- Style measurement and per-asset style checks: `style lint` and the `style_asset` `lint` mode measure one image with the frozen integer formulas (relative luminance permille, integer HSL, 36 hue bins, inside-outline cells, level count, dynamic range, TL-BR light direction, highlight and buffer ratios, dither windows, margins, and the main-axis second moments) and compare it with one style. Each finding carries `code`, `level`, `measured`, `threshold`, `message`, and `suggestion`; every code is a warning except `STYLE_COLOR_BUDGET`, and the report ends in `pass`, `warnings`, or `fail`. A metric with nothing to compare adds a `skipped` reason instead of a finding, a category applies its threshold overrides, and an animation strip is measured as its first frame. `analyze_asset` gains the same measurement under `styleMetrics` while its existing report fields stay unchanged.
- Builtin style presets and a palette library, with the `style` command group and the `style_asset` MCP tool (twenty-five to twenty-six tools). `style list` names four presets — `vanilla`, `soft`, `fairy-flat`, `dark-frame` — each carrying twelve families with six roles (`outline`, `shadow`, `dark`, `base`, `light`, `highlight`) plus outline, light, level, highlight, dither, and animation rules. `style show <builtin id|file.style.json>` resolves a document through its `extends` chain (at most eight levels, cycles refused) and reports the full JSON with that chain; `style export-palette --family <id|all>` writes a palette `.mcpx` that `quantize --palette` and `generate --palette` take directly; `style create` writes a new `.style.json` document after validating it. Custom documents override single fields, whole families, or per-category limits, and families with missing roles are completed by the frozen integer derivation. Style files are read in strict mode: an unknown field, a value outside its enumeration, or a color that is not `#RRGGBB` is `STYLE_INVALID` naming the field path. A style file is never rewritten by any other mode. New error codes `STYLE_INVALID`, `STYLE_NOT_FOUND`, `STYLE_INHERITANCE_CYCLE`, `STYLE_FAMILY_NOT_FOUND`, and `STYLE_UNSUPPORTED_VERSION`.
- Seamless procedural tiling: `brick`, `veins`, `clustered-noise`, `spots`, `grain`, `stripes`, and `checker` now sample the canvas as a torus and close their boundaries, ensuring repeat seams do not exceed interior neighbor variance.
- `validate-pack` now checks the root `pack.mcmeta` structure against game behavior: `PACK_MCMETA_INVALID` errors for what the game refuses to load (missing `pack` section or `pack.description`, half or inverted `min_format` / `max_format` ranges, `supported_formats` disagreeing with the declared range, retained legacy `pack_format` outside the declared majors, illegal overlay directory names, overlay `formats` contradicting the old-format rule) and `PACK_MCMETA_SUSPICIOUS` warnings for what loads but looks wrong (missing overlay directories, version-less overlay entries, scan target outside the declared range). Effective overlays are left uninterpreted with one `overlay-not-interpreted` coverage skip and one `PACK_COVERAGE_SKIPPED` warning each. Values the game accepts are never accused.

### Changed

- Updated procedural pattern golden SHA-256 digests to match seamless tiling geometry; showcase pattern artifacts regenerated and optimized accordingly.
- MCP schema and tool header comments now state the actual registered count of 25 tools; documentation in English, Traditional Chinese, and Simplified Chinese corrected to remove outdated hints regarding `--force`/`--mkdir`.
- The CLI internal `stub` probe is registered with `{ hidden: true }` so it no longer appears in `--help` output while remaining directly callable by tests.
- `validate-pack` and model commands refine texture variable and atlas sprite resolution: template models whose undefined texture variables are supplied by descendant child models produce no findings; models used directly as final models by `blockstates` or `items` definitions (including vanilla overrides under `--vanilla`) retain `PACK_BROKEN_REFERENCE` errors when variables cannot be resolved across the parent chain; unused models with unresolved variables and standalone `model validate` / `model inspect` invocations report `PACK_UNRESOLVED_VARIABLE` warnings without failing the scan; and texture references producible at runtime by pack or vanilla atlas `paletted_permutations` entries no longer report false `PACK_MISSING_TEXTURE` errors.

### Fixed

- `validate-pack` suppresses false findings and noise across three scan areas: OS metadata files and archive mirrors (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*` prefix, `__MACOSX`) under `assets/` are silently ignored during pack scanning without findings, coverage skips, or verdict changes; files inside uninterpreted top-level resource type directories (`assets/<namespace>/<type>/...`) skip per-file checks while keeping one `uninterpreted-resource` coverage skip and one `PACK_COVERAGE_SKIPPED` warning per type (namespace-level files, namespace-level issues, and misplaced files in interpreted types still report as before); and texture files covering an identical path in a provided `--vanilla` tree no longer trigger `PACK_ORPHAN_TEXTURE`.

## [0.4.0] - 2026-10-16

### Added

- `recolor` / `variant` and `recolor_asset` / `create_variants` accept a flat PNG in addition to an editable `.mcpx` source. A PNG carries no palette roles, so its pixels map by integer luminance bands (below 96 to shadow, 96–159 to base, 160 and above to highlight) onto the target material palette; no layer roles are invented, fully transparent pixels stay byte-identical including hidden RGB, and the region mask is never rewritten. A missing region keeps the existing `REGION_NOT_FOUND` error, `--selection` still scopes the write-back, and JPEG / WebP are still refused. Each `variant` material starts from the same pristine source, so material order never matters; files land as `<stem>_<material>.png` plus `<stem>_<material>.mcpx`. Inputs are never modified and file targets are preflighted as one union before the first byte lands.
- Cross-runtime comparison covers PNG recolor and PNG variant fan-out, verifying byte-identical PNG and `.mcpx` outputs on Bun and Node with the source left untouched.
- `optimize --input-dir` and `optimize_asset` with `inputDir`: lossless PNG optimization for whole directories (up to 4096 PNGs, optional `--recursive` / `recursive`), preserving relative directory structure under `--output-dir` / `outputDir`. Enforces strict UTF-8 byte ordering, resource budgets (256 MiB total source size, 16,777,216 total decoded pixels), non-overlapping source and output roots, refusal of symbolic links in the scan scope, and skips non-PNG files without copying. Partial write failures report `completed`, `failedTarget`, and `notStarted`. Existing explicit input mode (up to 256 files) remains unchanged.
- Cross-runtime comparison covers recursive directory optimization, verifying byte-identical output PNGs, canonical JSON reports with fixed ordering and totals, and untouched source files.

- `compare` and `compare_assets` compare same-size PNGs with raw RGBA and visible difference reports, optional magenta/cyan diagnostic PNGs, explicit safe outputs, and Bun/Node byte parity.

- `mcmeta animation`, `mcmeta gui`, and `mcmeta_asset` generate a single metadata section from PNG dimensions, with explicit outputs, version gates, whole-file force replacement, and Bun/Node byte comparison. Metadata validity does not establish game-client appearance.

- `quantize` and `quantize_asset` accept an explicit palette (`--palette` / `palette`: builtin material name or `.mcpx` path, up to 4096 colors) instead of a color count, and keep chosen RGBA colors unchanged (`--keep-color` / `keepColors`). Using both a count and a palette is `ARGUMENT_CONFLICT`. Output targets are checked together before any write, and the palette file is never overwritten.
- Cross-runtime comparison covers quantize with a palette and with kept colors.
- `optimize` command and `optimize_asset` MCP tool (twenty-one to twenty-two tools): lossless PNG re-encoding into the smallest exact encoding, or the source bytes kept, with a per-file report, `--dry-run`, `--mode`, and `--ancillary`. Inputs are never rewritten.
- `model` command (`inspect`, `validate`, `create`, `apply`, `export`, `preview`) and `model_asset` MCP tool (twenty-two to twenty-three tools; still twenty-five tools total) for Java block/item model JSON with cuboid `elements`, including item definition and blockstate generation from a binding. `preview` renders a fixed diagnostic three-view PNG (`front`, `right`, `top` panels side by side, `--size 64|128|256` default 64, `size` / `outputPngPath` on MCP): front shows the north face, right shows the east face, top shows the up face with north at the top. It draws only axis-aligned cuboids with exact 1/256 coordinates, existing UVs, and face rotations of 0/90/180/270 via integer projection and a depth buffer; parent chains and texture variables reuse the existing resolution context. A missing texture renders as a fixed checkerboard with a warning, and element rotation, non-1/256 coordinates, translucent faces, and unresolvable textures are listed as `partial` coverage. `display` transforms and game lighting are not applied: this is a diagnostic view, and no game client verified the appearance.
- Error codes `OPTIMIZE_MODE_NOT_EXACT`, `MODEL_INVALID_JSON`, `MODEL_INVALID_OPERATION`, `MODEL_UNSUPPORTED_VERSION`, and the finding codes `MODEL_INVALID_STRUCTURE`, `MODEL_INVALID_UV`, `MODEL_INVALID_ROTATION`, `MODEL_INVALID_DISPLAY`, `MODEL_VERSION_FEATURE`, `MODEL_SUSPICIOUS_VALUE`.
- Shared write protection for the new commands and tools: every target is checked before the first byte is written, and aliases of an input, symlink targets, symlinked parent directories, and paths outside `--pack` are refused.
- Cross-runtime comparison covers optimized PNG output and model create, apply, and export output, plus model preview PNG bytes (fixed cube render, source model and texture untouched).
- `validate-pack` now resolves equipment (`equipment/`, plus `models/equipment/` at pack format 42.0), particle (`particles/`), and font (`font/` providers: `bitmap.file`, `reference.id`, `ttf.file`) references, with missing targets reported as errors and `minecraft`-namespace misses without a vanilla tree reported as `PACK_UNRESOLVED_EXTERNAL` warnings.
- `validate-pack` classifies `assets/<namespace>/` top-level types: `textures`, `models`, `blockstates`, `items`, `atlases`, `equipment`, `particles`, and `font` are read; `lang` is inert; anything else is uninterpreted and makes `coverage` `partial` with one skip (`resource-type-not-interpreted: <type>`) and one `PACK_COVERAGE_SKIPPED` warning per type.
- `skills/` ships two Agent Skills, installable with `npx skills add smile-minecraft/mc-asset`: `mc-asset` (the draw, render, preview, measure, and validate loop with this tool, the CLI/MCP command map, and how palette roles drive recoloring) and `minecraft-pixel-art` (vanilla style rules for items, blocks, GUI sprites, and animations, with an anti-pattern review checklist). Both are registered in `llms.txt` and the `AGENTS.md` repository map.
- `docs/mcpx-format.md` (plus Simplified and Traditional Chinese editions) specifies the editable `.mcpx` grammar, checked against the parser and the CLI.

### Changed

- `quantize` and `quantize_asset` now check every output target before the first write, so a symbolic-link target or symbolic-link parent directory is refused instead of followed. Output extensions are still unrestricted, and multi-file writes are still one atomic file at a time, not a transaction.
- Dotted texture IDs now resolve to PNG paths without false missing-texture or orphan findings, preserving explicit `.png` inputs.
- Invalid equipment, particle, and font resource locations now retain `PACK_WRONG_PATH`, `PACK_NAMESPACE_PROBLEM`, and `PACK_INVALID_FILENAME` instead of being rewritten to `PACK_BROKEN_REFERENCE`; `PACK_CASE_MISMATCH`, empty-string errors, missing-file codes, and shape skips remain unchanged.

- Every PNG the tool writes is now compressed instead of stored. Existing commands produce PNG files with different bytes and hashes, and identical pixels. The 25 showcase images under `docs/assets` went from 2,764,911 to 9,617 bytes through `optimize`, with identical decoded pixels.
- `validate-pack` now checks model JSON as a whole: wrong element geometry, UV, rotation, and display transforms are reported as findings (errors or warnings) that earlier scans missed.
- Object-form model textures (`{"sprite": ...}`) on Minecraft 26.1 and later no longer produce false reports.
- A model with unknown fields or `overrides` makes the report `coverage` `partial` instead of complete.
- On pack formats below 46.0 where item definitions are unavailable, legacy model `overrides[].model` entries are resolved again (a miss is a `PACK_BROKEN_REFERENCE` error); at 46.0 and later they stay untouched.
- New coverage skip reasons: `resource-type-not-interpreted`, `trim-overrides-not-interpreted`, `particle-atlas-customized`, `internal-reference`, `pattern-reference`, `provider-not-interpreted`, `version-not-determined`, `feature-version-unknown`, `feature-not-in-version`, `unexpected-shape`. Every skip also carries a `PACK_COVERAGE_SKIPPED` warning, and `partial` coverage alone never changes the verdict.

### Known limits

- Model support covers structure and reference validity only. No Minecraft client renders a model, so appearance, lighting, and in-game behavior are not verified.
- Pack validation is not verified by loading in the game client. A customized particle atlas (`atlases/particles.json` in the pack or a dependency) turns particle misses into coverage skips, so those packs get no particle texture check; `trim_overrides[].texture` is skipped, never resolved; the font `reference` 15.0 boundary and the particle `#` internal-reference rule are unconfirmed inferences; the earliest format of the equipment, particle, and font types is unconfirmed, so an old but known format can still report errors; only `lang` is inert, so packs containing other unread types report `partial` coverage.
- `optimize` confirms pixel equality by decoding, not how the result looks in a game client.

## [0.3.2] - 2026-09-23

### Added

- `AGENTS.md`, `llms.txt`, `llms-full.txt`, and this changelog.
- README badges, a Showcase section, and a For AI agents section in all three editions.
- `gui-scale` command and `scale_gui_asset` MCP tool for GUI sprite scaling with stretch/tile/nine_slice mapping (nineteen to twenty tools).
- `pixel-aware` resize mode for transform, animate resize, and MCP.
- `validate-pack` resolution layers (`--vanilla` / `--dependency`), `coverage` reports, and `PACK_UNRESOLVED_EXTERNAL` / `PACK_COVERAGE_SKIPPED` diagnostics.
- Sprite-ID-centered atlas validation (directory / single / filter / paletted_permutations) and `PACK_GUI_SCALING_BORDER`.
- Resource reference graph: texture variable expansion, blockstates / items tracing, `PACK_REFERENCE_CYCLE`.
- `inspect` top-level command and `inspect_asset` MCP tool (twenty to twenty-one tools): read-only `structure` (layers, regions, color usage, overlaps) and `view` (composited PNG image block plus metadata) over `.mcpx` or raster inputs.
- Optional `feedback` on `apply_asset_operations` (`image` none/full/changed, `scale` 1–16, `crop`, `diff` none/summary); absent feedback keeps the legacy output byte-for-byte, and included images travel as MCP `type:image` blocks without duplicated bytes.
- Compact drawing operations `ellipse`, `polygonFill`, and `strokeMask` (25 typed batch variants with 9 pixel operations), with `SELF_INTERSECTING_POLYGON` for self-intersecting rings and `RESOURCE_LIMIT_EXCEEDED` beyond 4096 polygon points.
- Five-stage pixelize pipeline for the item preset.

### Changed

- The README and the MCP guide document the npm install path (`npx -y mc-asset mcp`, `npm install -g mc-asset`) alongside Homebrew and source builds.
- The MCP guide's registration section covers multiple MCP clients instead of OpenCode alone.
- Legal animation playback sequences (repeated or partial frames, per-step time) are no longer rejected.
- nine_slice border equality (`==`) is now invalid.
- `pixelize` item preset output changes (five stages enabled); other presets stay byte-identical.
- Validation reports add `coverage`; `partial` never changes the exit code.
- `preview --nine-slice` reports an error finding for equal borders (exit code unchanged).
- Pixelize report `stages` is now per-stage status; MCP guide examples synced.

## [0.3.1] - 2026-09-21

### Added

- Extended Minecraft release support back to `1.19.3`; the supported range is now `1.19.3`–`26.3`, from a single 26-version table.
- The `item-model-definitions` compatibility fact (since 46.0) and `items/` model-reference checks behind a 46.0 gate.
- Decoder robustness tests: progressive JPEG, animated WebP (explicitly rejected), EXIF/ICC, oversized dimensions, large images, wasm payload parity, and a `djpeg` cross-check.

### Changed

- `package.json` declares `engines.node >=22`, matching the CI Node baseline.
- Batch-operation per-type tables documented in `cli-surface` and `mcp-surface` in English, Traditional Chinese, and Simplified Chinese.
- The MCP guide's limits updated with the verified coverage and the Node baseline.
- The Homebrew formula pinned to the published v0.3.0 asset; README quickstart outputs and the MCP docs aligned with the release.

### Fixed

- MCP error messages no longer carry the CLI-only `--force` / `--mkdir` hints; the codes and shapes are unchanged and the CLI keeps them.
- `transform_asset` and `animate_asset` descriptions aligned with actual behavior: a selection cannot be combined with a geometry operation, and `layout` is required for `pack`, `unpack`, and `preview`.

## [0.3.0] - 2026-09-20

### Added

- Twelve more MCP tools (`import_asset` through `validate_pack_asset`), bringing the server to nineteen, with `mode` merges for palette, material, preview, and animate.
- Traditional and Simplified Chinese editions of the README and the CLI/MCP surface docs, plus a public-facing rewrite of the English docs.
- `.project-doc/` for internal design and release notes, removed from tracking.

### Changed

- Minecraft version support accepts `1.21.11` through `26.3`; resource-pack versions accept dotted `N.M` values and normalize to `major.minor`.
- `validate-pack` resolves its target from `pack.mcmeta` `max_format`, then `min_format`, then the legacy `pack_format`.
- All seven compatibility facts carry determined dotted `since` values; the `resource-pack-format` fact was retired.
- Release notes, the staging helper comment, and tests no longer point at files that moved into `.project-doc/`.

### Fixed

- The release-staging tests isolate the tag environment (GitHub Actions sets `GITHUB_REF` on tag pushes), with an added env-fallback positive case; test files only, no script changes.

## [0.2.0] - 2026-09-20

### Added

- Selection model, integer transform engine (`flip`, `rotate`, `crop`, `pad`, `translate`, `resize`), palette engine, and an integer median-cut quantizer.
- Cleanup engine with an explicit alpha gate, the material system and recolor engine, the deterministic pixelize pipeline with JPEG/WebP intake, and the `variant` fan-out command.
- Batch operations extended with layer and region operations.
- `analyze` palette, pixel-art, and recommended sections, with PNG/JPEG/WebP raster intake.
- `tile` (seam metrics, repetition scoring, edge/brightness matching, previews), `generate` (ten deterministic procedural patterns), and `preview` (`ascii`, `palette-map`, `scale`).
- The `animate` command (`pack`, `unpack`, `reorder`, `resize`, `validate`, `preview`), `preview --nine-slice`, `validate --mcmeta`, and the `minecraft:gui` / `minecraft:particle` profiles with matching pixelize presets.
- `validate-pack`, the resource-location validator with filename checks, the eight-fact Minecraft version layer, and atlas-aware pack validation.
- The native stdio MCP server (`mc-asset mcp`) and its first seven tools, with frozen zod input schemas.

### Changed

- The Minecraft version facts became version-interval data with per-fact sources; `validate-pack` reads the pack root's `pack.pack_format` when no version flag is given.
- Batch vocabulary documented per operation type across the CLI and MCP surfaces.

### Fixed

- Editable-canvas intake now accepts PNG, JPEG, and WebP, matching the frozen input table.
- The cleanup `aa` fix no longer counts wrapped neighbors at the canvas edges.
- Homebrew: the formula exposes the `mc-asset` command via `install_symlink` and pins the published v0.1.0 asset digest.

## [0.1.0] - 2026-09-19

### Added

- Core `PixelCanvas` model: layers, regions, authoring palette, dimension and coordinate validation, resource limits, and the 33-code error registry.
- Integer drawing primitives: Bresenham lines, rect outlines and fills, and an explicit-stack flood fill.
- PNG codec preserving RGBA, with fixed stored-deflate output for byte reproducibility.
- The editable `.mcpx` grammar: tolerant parser, strict canonical serializer, and seam validation.
- Atomic batch operations with per-operation reports and rollback on the first failure.
- Asset profiles (`generic`, `minecraft:item`, `minecraft:block`) and predicted alpha classification.
- CLI commands `import`, `render`, `build`, `analyze`, and `validate`, plus `--json` envelopes and the standardized exit codes.
- `--minecraft-version` / `--resource-pack-version` targeting on `analyze` and `validate`.
- An executable Node CLI bundle, the reproducible tagged release pipeline (deterministic staging, a per-file SHA-256 manifest, a hand-built deterministic `.tar.gz`), and the `v*` tag workflow.
- The public Homebrew tap formula.
- A cross-runtime conformance suite with CI guards for determinism, portability, and forbidden dependencies.

### Fixed

- Output-target safety: NFC and case-fold identity checks across platforms, `O_EXCL` temp files that never clean up foreign files, full preflight before writing multiple targets, and per-file atomic failure reporting.

[Unreleased]: https://github.com/smile-minecraft/mc-asset/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/smile-minecraft/mc-asset/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/smile-minecraft/mc-asset/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/smile-minecraft/mc-asset/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/smile-minecraft/mc-asset/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/smile-minecraft/mc-asset/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/smile-minecraft/mc-asset/releases/tag/v0.1.0
