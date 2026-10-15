# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `optimize` command and `optimize_asset` MCP tool (twenty-one to twenty-two tools): lossless PNG re-encoding into the smallest exact encoding, or the source bytes kept, with a per-file report, `--dry-run`, `--mode`, and `--ancillary`. Inputs are never rewritten.
- `model` command (`inspect`, `validate`, `create`, `apply`, `export`) and `model_asset` MCP tool (twenty-two to twenty-three tools) for Java block/item model JSON with cuboid `elements`, including item definition and blockstate generation from a binding.
- Error codes `OPTIMIZE_MODE_NOT_EXACT`, `MODEL_INVALID_JSON`, `MODEL_INVALID_OPERATION`, `MODEL_UNSUPPORTED_VERSION`, and the finding codes `MODEL_INVALID_STRUCTURE`, `MODEL_INVALID_UV`, `MODEL_INVALID_ROTATION`, `MODEL_INVALID_DISPLAY`, `MODEL_VERSION_FEATURE`, `MODEL_SUSPICIOUS_VALUE`.
- Shared write protection for the new commands and tools: every target is checked before the first byte is written, and aliases of an input, symlink targets, symlinked parent directories, and paths outside `--pack` are refused.
- Cross-runtime comparison covers optimized PNG output and model create, apply, and export output.
- `validate-pack` now resolves equipment (`equipment/`, plus `models/equipment/` at pack format 42.0), particle (`particles/`), and font (`font/` providers: `bitmap.file`, `reference.id`, `ttf.file`) references, with missing targets reported as errors and `minecraft`-namespace misses without a vanilla tree reported as `PACK_UNRESOLVED_EXTERNAL` warnings.
- `validate-pack` classifies `assets/<namespace>/` top-level types: `textures`, `models`, `blockstates`, `items`, `atlases`, `equipment`, `particles`, and `font` are read; `lang` is inert; anything else is uninterpreted and makes `coverage` `partial` with one skip (`resource-type-not-interpreted: <type>`) and one `PACK_COVERAGE_SKIPPED` warning per type.

### Changed

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

[Unreleased]: https://github.com/smile-minecraft/mc-asset/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/smile-minecraft/mc-asset/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/smile-minecraft/mc-asset/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/smile-minecraft/mc-asset/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/smile-minecraft/mc-asset/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/smile-minecraft/mc-asset/releases/tag/v0.1.0
