# CLI Surface Specification

[English](cli-surface.md) | [繁體中文](cli-surface.zh-TW.md) | [简体中文](cli-surface.zh-CN.md)

## Contents

- [Global Flags](#global-flags)
- [Common File Flags (File-Producing Commands)](#common-file-flags-file-producing-commands)
  - [Safety & Filesystem Guarantees](#safety--filesystem-guarantees)
- [Command Reference](#command-reference)
  - [1. Intake, Authoring & Source Build](#1-intake-authoring--source-build)
  - [2. Spatial & Geometric Transformations](#2-spatial--geometric-transformations)
  - [3. Palette, Quantization & Cleanup](#3-palette-quantization--cleanup)
  - [4. Pixel Art Pipeline](#4-pixel-art-pipeline)
  - [5. Procedural Generation, Tiles & Previews](#5-procedural-generation-tiles--previews)
  - [6. Animation & Sprite Sheets](#6-animation--sprite-sheets)
  - [7. Inspection, Validation & Pack Verification](#7-inspection-validation--pack-verification)
  - [8. Model Context Protocol (MCP) Server](#8-model-context-protocol-mcp-server)
  - [9. PNG Optimization & Java Models](#9-png-optimization--java-models)
- [Batch Operations Specification (`--operations`)](#batch-operations-specification---operations)
- [Exit Code Registry](#exit-code-registry)
- [Troubleshooting & Common Pitfalls](#troubleshooting--common-pitfalls)

---

Entry point: `mc-asset` (or `bun src/cli/index.ts` during local development).

Global behavior follows deterministic standards (channels, `OUTPUT_EXISTS`/`--force`/`--mkdir`, atomic writes, `--force`/`--in-place` mutual exclusion) and standardized exit codes via the `src/core/errors.ts` registry.

Release history, including when each command and operation arrived, lives in [`CHANGELOG.md`](../CHANGELOG.md).

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
| `pack init <dir>` | None | Project skeleton | Creates the project document, pack root metadata, placeholder icon, and the resource pack directories. |

```text
import <image> [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
render <grid>  [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
build  [source] [--stdin] [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
pack init <dir> --namespace <ns> --minecraft-version <version> [--name <name>] [--description <text>]
       [--style <id|path>] [--resource-pack-version <N>] [--allow-minecraft-namespace]
```

- `pack init <dir>` writes one skeleton in a single preflighted batch: the project document `mc-asset.pack.json` in the project root, `pack/pack.mcmeta` for the pinned target, a 64x64 `pack/pack.png` placeholder icon, and the directories `recipes/`, `pack/assets/<ns>/textures/item`, `pack/assets/<ns>/textures/block`, `pack/assets/<ns>/models/item`, plus `pack/assets/<ns>/items/` from resource pack format 46.0 on. `--namespace` and `--minecraft-version` are required; every other setting has a default (project name from the directory name, description from the name, `vanilla` style, `pack` output directory, `recipes` recipe directory).
- The project document records `formatVersion`, `name`, `description`, `namespace`, `allowMinecraftNamespace`, `minecraftVersion`, `resourcePackVersion`, `style`, `outputDir`, `recipeDir`, and `vanillaSource`, and is read in strict mode: an unknown field, a value outside its shape, or a path leaving the project root is `PACK_PROJECT_INVALID` naming the field, an unreadable path is `PACK_PROJECT_NOT_FOUND`, and a newer `formatVersion` is `PACK_PROJECT_UNSUPPORTED_VERSION`. `--resource-pack-version` overrides the format the release version maps to; the release version stays in the document either way, and no command rewrites the document afterwards.
- The root metadata follows the pinned target: from resource pack format 65.0 the document declares `min_format` and `max_format` for that target and leaves the legacy `pack_format` out; below it the document carries the single legacy major. The generated document is checked in memory against the same root metadata rules `validate-pack` applies before it is written, so a document with a finding never reaches the disk. A release version outside `1.19.3` through `26.3` is `INVALID_ARGUMENT` naming the version, and nothing is written.
- Every planned path is read before the first byte. A path that already exists refuses the whole batch with `PACK_INIT_CONFLICT` and a `conflicts` list of every relative path already in place, so a rerun is refused instead of half-overwriting; a symbolic link, in the project directory or anywhere below it, is refused with `FILESYSTEM_ERROR` and is never written through. `init` takes no `--force` and no `--mkdir`: a project is created once.
- `namespace: minecraft` overrides the game's own assets, so it needs `--allow-minecraft-namespace`; without it the call is `PACK_PROJECT_INVALID` naming `namespace`.
- The placeholder icon is an original 64x64 motif painted from integer geometry (a checker field, a bordered plate, and a diamond mark), so the same request always writes the same bytes.

- `--source <path>` saves the editable `.mcpx` text source.
- `--in-place` rewrites the input file in-place (implies force for that target).
- `build --stdin` together with `--operations -` is `ARGUMENT_CONFLICT`.
- For the editable `.mcpx` v1 and `.grid` grammar, canonical section order, compact/token grid rules, and error codes, see [`docs/mcpx-format.md`](mcpx-format.md).

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
| `quantize <input>` | PNG, JPEG, WebP, `.mcpx` | PNG and/or `.mcpx` | Reduces distinct colors to a target count, or maps them onto an explicit palette; reserved colors stay unchanged. |
| `cleanup <input>` | PNG, JPEG, WebP, `.mcpx` | PNG and/or `.mcpx` | Detects or eliminates isolated, noise, or outlier pixels. |
| `palette extract <image>` | PNG, JPEG, WebP, `.mcpx` | Report only | Extracts unique RGBA colors from the image. |
| `palette inspect <image>` | PNG, JPEG, WebP, `.mcpx` | Report only | Analyzes palette distribution, roles, and contrast. |
| `material list` | None | Report only | Lists available built-in material definitions. |
| `material show <name>` | None | Report only | Inspects color ramps and definitions for a material. |
| `recolor <source>` | `.mcpx`, PNG | PNG and/or `.mcpx` | Remaps colors to a built-in material palette. |
| `variant <source>` | `.mcpx`, PNG | Multi-file under `--output-dir` | Generates material variants (e.g. iron, copper, gold). |
| `style list` | None | Report only | Lists the builtin style presets. |
| `style show <style>` | None | Report only | Resolves one style (builtin id or `.style.json` path) into its full JSON. |
| `style export-palette <style>` | None | `.mcpx` palette file | Writes the palette of one family, or of every family, as `.mcpx`. |
| `style create` | None | `.style.json` file | Writes a new style document. |
| `style lint <path>` | PNG, JPEG, WebP, `.mcpx` | Report only | Measures one image against a style and reports findings. |

```text
quantize <input> (--colors <N> | --palette <name|path>) [--keep-color <r,g,b,a> ...] [--selection <scope>] <file flags>
cleanup  <input> [--fix <classes>] [--allow-render-pass-change] [--selection <scope>] <file flags>
recolor  <source> (--material <name> | --family <name>) [--style <id|path>] [--region <id>] [--selection <scope>] <file flags>
variant  <source> (--materials <a,b,...> | --families <a,b,...>) [--style <id|path>] [--output-dir <dir>] [--selection <scope>] [--region <id>] [--name-template <tmpl>] [--mkdir] [--force] [--profile <p>]
style list
style show <style>
style export-palette <style> --family <id|all> --output <file.mcpx> [--force] [--mkdir]
style create --output <file.style.json> --id <id> [--name <name>] [--extends <id|path>] [--force] [--mkdir]
style lint <path> [--style <id|path>] [--category <name>] [--json]
```

- `quantize` needs exactly one of `--colors` or `--palette`: both is `ARGUMENT_CONFLICT`, neither is `INVALID_ARGUMENT`. `--palette` takes a builtin material name or an `.mcpx` path (at most 4096 colors, declared `[palette]` order, unused entries included). Each pixel maps to the nearest entry by integer squared RGBA distance; an exact tie takes the earlier entry, and hidden RGB under alpha 0 takes part.
- `--keep-color <r,g,b,a>` (repeatable) keeps that exact RGBA unchanged. With `--palette`, every kept color must be a palette entry (`INVALID_ARGUMENT`). With `--colors`, each layer counts only the distinct kept colors present in the selected pixels against the budget, then quantizes the other selected pixels with the remaining budget; with no budget left they map to the kept colors, and more kept colors than the budget is `INVALID_ARGUMENT` before any write. With `--keep-color` or `--palette`, `--selection` limits the budget and the mapping to selected pixels; pixels outside stay byte-identical.
- The palette file is read-only input: no output flag, including `--force` and `--in-place`, may overwrite it. The quantized palette can differ from the declared palette of a written `.mcpx`, which keeps the canvas palette. The `--json` result adds `palette` and `keepColors` (RGBA objects) when used; `colorCount` is the largest per-layer quantized palette size.
- `cleanup --fix <classes>`: Comma-separated list (`isolated`, `noise`, `cluster`, `fringe`, `outlier`, `hole`, `aa`). Modifying alpha-affecting classes requires `--allow-render-pass-change`.
- `palette` and `material` subcommands are read-only reports and reject file write flags (`INVALID_ARGUMENT`).
- `recolor` and `variant` accept an editable `.mcpx` source or a flat PNG. `recolor` requires either `--material <name>` or `--family <name>` (mutually exclusive: neither is `INVALID_ARGUMENT`, both is `ARGUMENT_CONFLICT`). `variant` requires at least one of `--materials <list>` or `--families <list>` (neither is `INVALID_ARGUMENT`; both coexist producing the union of both, and colliding output filenames raise `ARGUMENT_CONFLICT`). `--name-template <tmpl>` supports `{stem}` and `{name}` (defaulting to `{stem}_{name}`). On the existing material path, PNG pixels map by integer luminance bands (<96 shadow, 96–159 base, ≥160 highlight) onto the target material palette. On the palette family path (`--family` / `--families`, using `--style` or defaulting to `vanilla`), role-aware sources map roles directly to the family roles (`outline`, `shadow`, `dark`, `base`, `light`, `highlight`) while `accent` and `custom` follow the six integer luminance bands; flat PNG sources map by the six bands (<43 outline, 43–85 shadow, 86–127 dark, 128–170 base, 171–213 light, ≥214 highlight); outline pixels (adjacent to transparency or canvas boundary) are forced to the target family's `outline` color; fully transparent pixels (alpha 0) stay byte-identical including hidden RGB; translucent pixels are forced to fully opaque ramp colors. `--region` limits the write to that region's mask (outside pixels stay byte-identical, and a missing region raises `REGION_NOT_FOUND`); `--selection` scopes the write-back, restoring unselected pixels verbatim. JPEG and WebP are still refused (`INVALID_ARGUMENT`). Each variant starts from the pristine source; inputs are never modified; file targets are preflighted as one union before the first byte lands.
- `style` carries four builtin presets — `vanilla`, `soft`, `fairy-flat`, `dark-frame` — each with twelve families (`iron`, `gold`, `diamond`, `netherite`, `copper`, `wood`, `stone`, `emerald`, `amethyst`, `redstone`, `lapis`, `quartz`) and six roles per family (`outline`, `shadow`, `dark`, `base`, `light`, `highlight`), plus outline, light, level, highlight, dither, and animation rules. A style source is a builtin id or a `.style.json` path; a custom document inherits one source through `extends` (at most eight levels) and overrides single fields, whole families, or per-category limits.
- `style list` and `style show` report only and write nothing. `style show` prints the resolved document: `formatVersion`, `id`, `name`, `description`, `palettes`, `outline`, `light`, `limits`, `highlight`, `dither`, `animation`, `categoryOverrides`, and the `extendsChain` it walked from the requested source down to the base.
- `style export-palette --family <id|all> --output <file.mcpx>` writes a palette document: one row per family and one column per role, `[palette]` in family-then-role order with `.` first as `#00000000`, and `kind = palette`. The result is accepted directly by `quantize --palette` and `generate --palette`. A family the style does not resolve is `STYLE_FAMILY_NOT_FOUND`; without `--output` the command is `OUTPUT_REQUIRED`.
- `style create` writes `{formatVersion, id, name, extends}` (`extends` defaults to `vanilla`) after the document validates, then writes through the shared output guard: the target must end in `.style.json`, an existing file needs `--force`, a missing parent needs `--mkdir`, and a target may not be the style it extends. The tool never rewrites a style file it did not create; no other command writes one.
- `style lint <path>` measures one image and compares it against a style (default `vanilla`). It reports `metrics` (opaque pixels, distinct colors, level count, dynamic range, TL-BR light direction, coverage, smallest margin, inside-outline pixels, outline gap and hue offset, hue bins, highlight pixels and ratio, buffer ratio, dither permille, main axis with its second moments, and `firstFrameOnly`), then `findings`. Every finding carries `code`, `level`, `measured`, `threshold`, `message`, and `suggestion`. All findings are warnings except `STYLE_COLOR_BUDGET`, the only code that can turn the run into a failure; the verdict is `pass`, `warnings`, or `fail`, and a `fail` verdict exits 3 like a failing validation. A metric with nothing to compare produces no finding and a `skipped` entry (`no-opaque-pixels`, `animation-first-frame-only`). `--category` applies that category's threshold overrides; without it the category-scoped rules (such as the main-axis angle check) stay quiet. An animation strip is measured as its first frame and says so through `firstFrameOnly`.
- A style file is read in strict mode: an unknown field, a value outside its enumeration, or a color that is not `#RRGGBB` is `STYLE_INVALID` naming the field path (for example `palettes.stone.base: expected #RRGGBB, got "#12345"`). A file that cannot be read or parsed, a `formatVersion` above the supported one (`STYLE_UNSUPPORTED_VERSION`), an `extends` cycle (`STYLE_INHERITANCE_CYCLE`), an id that reuses a builtin name, and an unknown builtin id (`STYLE_NOT_FOUND`) each carry the document path, the field path, and the chain.

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
| `mcmeta animation` | PNG sprite sheet (one column or horizontal row, `.mcpx` not accepted) | `.mcmeta` text (`.json` not accepted) | Generates the `animation` section from PNG dimensions. The PNG is only read. |
| `mcmeta gui` | PNG design sprite | `.mcmeta` text (`.json` not accepted) | Generates `gui.scaling` with its design dimensions. The PNG is only read. |

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
| `inspect <input>` | PNG, JPEG, WebP, `.mcpx` | Report only (plus PNG bytes in `--json` view) | Frozen structure report or composited view (read-only). |
| `validate <asset>` | Asset file (PNG) | Report only (exit 3 on defect) | Validates single asset texture and optional `.mcmeta`. |
| `validate-pack <path>` | Resource Pack root directory | Report only (exit 3 on defect) | Full scan of resource pack integrity, namespaces, models, textures, and atlases. |
| `compare <before> <after>` | Two same-size PNGs | Report only, or diagnostic PNG (`--output`, `--stdout`) | Compares two same-size PNGs and reports raw RGBA and visible difference pixel counts and bounds. |

```text
analyze       <image> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
inspect       <input> --mode <structure|view> [--crop <scope>] [--scale <N>] [--json]
validate      <asset> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>]
                       [--mcmeta <path>] [--json]
validate-pack <path>  [--minecraft-version <v>] [--resource-pack-version <n>]
                        [--vanilla <path>] [--dependency <path>]... [--json]
compare       <before> <after> [--output <path>] [--stdout] [--scale <N>] [--force] [--mkdir] [--json]
```

- Validation exit behavior: Exit 0 on pass; Exit 3 (`VALIDATION_FAILED`) when validation checks fail; Exit 2 on invocation syntax error; Exit 4 on filesystem error.
- Version targeting: `--minecraft-version` accepts release versions `1.19.3` through `26.3` (for example `1.19.3`, `1.21.4`, `26.3`; each release maps to its resource-pack format); `--resource-pack-version` accepts `N` or `N.M` (e.g. `84`, `97.1`) and normalizes to `major.minor`. The two flags are mutually exclusive, and omitting both keeps engine defaults.
- Version echo: human reports print `target: minecraft <v> / resource-pack <f>`, `target: resource-pack <f>`, or `target: default (engine defaults)`; `--json` carries `version: { minecraftVersion?, resourcePackVersion? }` with normalized dotted strings.
- No-flag resolution: `validate-pack` without a version flag reads the root `pack.mcmeta` for `pack.max_format`, then `pack.min_format`, then legacy `pack.pack_format` (integer, `[major, minor]` array, or dotted string, normalized to `major.minor`); the resolved target prints as `pack.mcmeta resource-pack <f>`. `supported_formats` is ignored for targeting, and with no usable value the scan warns once (`PACK_VERSION_UNDETERMINED`) and applies no default.
- `pack.mcmeta` structure: `validate-pack` checks the parsed root `pack.mcmeta` against game behavior. `PACK_MCMETA_INVALID` (error, fails the scan) covers what the game refuses to load: a missing `pack` section or `pack.description`, half a `min_format` / `max_format` range, negative or inverted bounds, a `supported_formats` field that disagrees with the declared range (including its presence at `min_format` 65 or later), a retained legacy `pack_format` outside the declared majors, an overlay directory name outside `[-_a-zA-Z0-9.]`, and an overlay `formats` field that contradicts the old-format rule (required on every entry when any entry reaches below 65, forbidden when none does). `PACK_MCMETA_SUSPICIOUS` (warning, never fails the scan by itself) covers what loads but looks wrong: an overlay directory the pack root does not hold, an overlay entry with no version field at all, and a scan target outside the declared range. Values the game accepts are never accused: a `max_format` beyond every known version, and anything outside the accepted syntax, which the scan leaves alone because it only reports defects it can prove.
- Overlay coverage: an overlay whose version range covers the scan target is left uninterpreted; it records one `overlay` / `overlay-not-interpreted` skip plus one `PACK_COVERAGE_SKIPPED` warning, under the same contract as every other skip (coverage alone never changes the verdict). A declared directory the pack root does not hold warns without a skip, and with no resolved target nothing is skipped.
- `--vanilla`: caller-provided vanilla resource tree (pack-root shape, including `assets/`). Once provided, `minecraft`-namespace references are confirmed against that tree; without it they report a `PACK_UNRESOLVED_EXTERNAL` warning and a coverage entry instead of a missing-asset error.
- `--dependency`: dependency pack roots, repeatable; the first occurrence has the highest priority.
- Coverage: `validate` and `validate-pack` reports carry `coverage: {status, skipped}`; `partial` means some checks were skipped (for example `vanilla-not-provided`, `unsupported-source-type`, `unsupported-regex`, `unknown-node-type`, `renderer-fields-not-interpreted`, `version-undetermined`, `model-documents-not-loaded`, `resource-type-not-interpreted: <type>`, `trim-overrides-not-interpreted`, `particle-atlas-customized`, `internal-reference`, `pattern-reference`, `provider-not-interpreted`, `version-not-determined`, `feature-version-unknown`, `feature-not-in-version`, `unexpected-shape`, `overlay-not-interpreted`), each skip with `kind` / `reason` / `target`. Every skip is also reported as a `PACK_COVERAGE_SKIPPED` warning. Coverage never changes the exit code or the verdict by itself (pass stays 0, fail stays 3). Texture-variable resolution reads the current pack's model documents only; a variable that leaves them is reported as `model-documents-not-loaded` coverage instead of being resolved across dependency or vanilla packs. Under `assets/<namespace>/` the scan reads `textures`, `models`, `blockstates`, `items`, `atlases`, `equipment`, `particles`, and `font`; `lang` is inert and loses nothing; any other top-level type is uninterpreted and makes coverage `partial` with one `uninterpreted-resource` skip (`resource-type-not-interpreted: <type>`) and one warning per type. Equipment `layers.<layerType>[].texture` resolves to `textures/entity/equipment/<layerType>/<path>.png` (`models/equipment/` counts as equipment definitions only at pack format 42.0; `equipment/` is read at 46.0 and later); particle `textures[]` resolves to `textures/particle/<path>.png`; font `bitmap.file` resolves under `textures/`, `reference.id` to another `font/*.json` (read at pack format 15.0 and later), and `ttf.file` under `font/`. On a pack format below 46.0 where item definitions are unavailable, legacy model `overrides[].model` entries are resolved and a miss is a `PACK_BROKEN_REFERENCE` error; at 46.0 and later they are left untouched. Limits: a customized particle atlas (`atlases/particles.json` in the pack or a dependency) turns particle misses into skips; `trim_overrides[].texture` is only skipped, never resolved; the font `reference` 15.0 boundary and the particle `#` internal-reference rule are unconfirmed inferences; the earliest format of the three types is unconfirmed, so an old but known format can still report errors; only `lang` is inert, so packs containing other unread types report `partial`; nothing is verified by loading it in the game client.
- Texture references: dots in model texture IDs remain part of the name (`item/foo.v2` resolves to `textures/item/foo.v2.png`); an explicit trailing `.png` remains compatible. Font `bitmap.file` is an explicit file path and is used unchanged. Invalid equipment, particle, and font resource locations retain `PACK_WRONG_PATH`, `PACK_NAMESPACE_PROBLEM`, `PACK_INVALID_FILENAME`, or `PACK_CASE_MISMATCH` instead of `PACK_BROKEN_REFERENCE`; empty strings keep `PACK_BROKEN_REFERENCE`. Determined missing files and unexpected-shape skips keep their existing codes.
- Ignored system artifacts: OS metadata files and archive mirrors (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*` AppleDouble files, and `__MACOSX` directories) under `assets/` are silently ignored during pack scanning and produce no findings, skips, or verdict changes.
- Uninterpreted resource directories: files inside uninterpreted top-level resource type directories (`assets/<namespace>/<type>/...`) skip all per-file checks (filename, JSON syntax, image decoding, and misplaced-file checks); each distinct (namespace, type) pair keeps exactly one `uninterpreted-resource` coverage skip and one `PACK_COVERAGE_SKIPPED` warning. Files directly under a namespace directory, namespace-level problems at the `assets/` root, and misplaced files inside interpreted types (such as `models/`) still report as before with their original codes and severity levels.
- Vanilla texture overrides: when `--vanilla` is supplied and the vanilla tree holds a texture at an identical relative path, that texture override no longer triggers `PACK_ORPHAN_TEXTURE`; without `--vanilla`, and for custom textures absent from the vanilla tree, the warning stays.
- Template models and texture variables: a texture variable that cannot be resolved across its full parent chain still reports a `PACK_BROKEN_REFERENCE` error when the model is used directly as a final model by `blockstates` or `items` definitions. Template models used solely as parent models produce no finding when a descendant child model supplies that variable in its `textures` mapping. Models not referenced by any definition or child model that contain unresolved variables, as well as single-file `model validate` and `model inspect` invocations where child models cannot be determined, report a `PACK_UNRESOLVED_VARIABLE` warning (exit 0, does not affect the scan verdict). When `--vanilla` is provided, models referenced by vanilla `blockstates` or `items` definitions also count as final models.
- Atlas runtime-generated textures: when a model texture reference has no corresponding file but can be generated at runtime by `paletted_permutations` entries in pack or vanilla atlases, it no longer triggers `PACK_MISSING_TEXTURE`. When no atlas can generate the referenced texture, the existing code and defect level are maintained; when atlas information is unavailable, existing behavior is preserved.
- `inspect` is read-only and takes no file flags (`INVALID_ARGUMENT`): `--mode structure` (default) reports layers (id, name, index, raw-alpha bounds, area, visibility, opacity, blend mode, raw RGBA color usage with hidden alpha-zero colors and stable top-16 truncation), regions (id, name, index, bounds, area only), and overlaps (layer box intersections plus real region-mask intersections); `--mode view` renders the composited pixels with `--crop <scope>` (a selection expression; an empty match is `EMPTY_SELECTION`) and `--scale <N>` (integer 1–16, nearest; default 1), returning the six-key metadata (`mode`, `sourceDimensions`, `crop`, `scale`, `outputDimensions`, `colorFormat`) plus `pngBase64` under `--json`. The long-edge auto-scale (a pre-scale long edge below 128 scales up toward 128, capped at 16) applies to the `apply_asset_operations` `feedback` images only, never to `inspect view`. Outputs beyond the 1024px edge are `RESOURCE_LIMIT_EXCEEDED` with a crop hint instead of a silent downscale. Do not confuse top-level `inspect` with `palette inspect` (palette characteristics).

---

### 8. Model Context Protocol (MCP) Server

```text
mc-asset mcp
```

Runs the native Model Context Protocol (MCP) stdio server for LLM agent integration. Provides native tools without subprocess spawning:
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
- `inspect_asset`
- `optimize_asset`
- `model_asset`
- `mcmeta_asset`
- `compare_assets`

---

### 9. PNG Optimization & Java Models

| Command | Input | Output | Description |
|---|---|---|---|
| `optimize <input...>` | One to 256 explicit PNG files | PNG files at explicit new paths, or a report only (`--dry-run`) | Lossless re-encoding into the smallest exact encoding, or the source bytes kept when nothing smaller exists. |
| `optimize --input-dir <dir>` | Directory containing PNG files (up to 4096 PNGs, `--recursive`) | Preserved relative directory structure under `--output-dir`, or a report only (`--dry-run`) | Scans PNGs in UTF-8 byte order, enforces budget limits (256 MiB source, 16,777,216 decoded pixels), and losslessly re-encodes each file. |
| `model inspect <file>` | Java block/item model JSON | Report only | Describes parent, textures, elements, display transforms, and resolved references. |
| `model validate <file>` | Java block/item model JSON | Report only (exit 3 on defect) | Checks structure, UV, rotation, display transforms, and reference validity. |
| `model create` | A model description (`--spec`) | Model JSON | Builds a model document from an explicit description. |
| `model apply <file>` | Model JSON plus typed operations (`--operations`) | Model JSON | Applies all operations or none, then writes a new document. |
| `model export <file>` | Model JSON, optional binding (`--binding`) | Model JSON, item definition, blockstate | Places a model in a pack and generates the item definition and blockstate next to it. |
| `model preview <file>` | Java block/item model JSON | Diagnostic PNG (front, right, top) | Renders a fixed three-view diagnostic image from cuboid `elements`. |

```text
optimize     <input...> (--output <png> | --output-dir <dir> | --stdout | --dry-run)
                        [--mode <auto|rgba|rgb|grayscale|grayscale-alpha|indexed>]
                        [--ancillary <preserve|strip>] [--force] [--mkdir] [--json]
optimize     --input-dir <dir> [--recursive] (--output-dir <dir> | --dry-run)
                        [--mode <auto|rgba|rgb|grayscale|grayscale-alpha|indexed>]
                        [--ancillary <preserve|strip>] [--force] [--mkdir] [--json]
model inspect  <file> [--pack <dir>] [--vanilla <dir>] [--dependency <dir>]...
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model validate <file> [--pack <dir>] [--vanilla <dir>] [--dependency <dir>]...
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model create   --spec <file|-> (--output <json> | --stdout) [--force] [--mkdir]
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model apply    <file> --operations <file|-> (--output <json> | --stdout) [--force] [--mkdir]
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model export   <file> [--output <json>] [--binding <file|->] [--item-output <json>]
                      [--blockstate-output <json>] [--pack <dir>] [--force] [--mkdir]
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model preview  <file> [--pack <dir>] [--vanilla <dir>] [--dependency <dir>]...
                      [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--size <64|128|256>] (--output <png> | --stdout) [--force] [--mkdir] [--json]
```

- `optimize` input: either explicit PNG paths (1 to 256 files; no globs, no directories) or `--input-dir <dir>` (`[--recursive]`, up to 4096 PNGs). Providing both raises `ARGUMENT_CONFLICT`; providing neither raises `INVALID_ARGUMENT`. `--recursive` without `--input-dir` raises `ARGUMENT_CONFLICT`.
- In explicit path mode, files are detected from the PNG signature; non-PNG files raise `UNSUPPORTED_IMAGE_FORMAT`. Duplicates or basename collisions under `--output-dir` raise `ARGUMENT_CONFLICT`.
- In directory mode (`--input-dir`):
  - Traverses directory entries in strict UTF-8 byte order of relative paths and preserves the relative directory structure under `--output-dir`. Missing intermediate output directories require `--mkdir`.
  - Symbolic links are never followed: any symlink in the scan scope or a symlinked input root raises `FILESYSTEM_ERROR` (`symlink-not-supported`).
  - Source and output directories must be disjoint: they cannot be aliases (including case-folding aliases) and cannot contain each other; violations raise `ARGUMENT_CONFLICT`.
  - Resource budgets are enforced before writing: at most 4096 PNG files, at most 256 MiB (268,435,456 bytes) total source size, at most 16,777,216 total decoded pixels, and per-file size limits. Exceeding any budget raises `RESOURCE_LIMIT_EXCEEDED` without automatic batching.
  - Regular non-PNG files (such as `.mcmeta`, `.txt`, `.json`) are skipped and never copied or modified; a directory with no PNG files raises `INVALID_ARGUMENT`.
  - Directory mode accepts only `--output-dir` or `--dry-run`; single-file outputs (`--output`) and `--stdout` are refused with `ARGUMENT_CONFLICT`.
  - Under `--dry-run`, no directory is created, no file is written, and non-PNG files (`.mcmeta` etc.) are never touched; the report returns computed results for every PNG.
- `optimize` output: for explicit inputs, exactly one of `--output` (a single input), `--output-dir` (each input written as `<dir>/<input name>`), `--stdout` (a single input), or `--dry-run` (computes the report, writes nothing). None raises `OUTPUT_REQUIRED`; more than one raises `ARGUMENT_CONFLICT`. There is no `--in-place`: inputs are never rewritten.
- `--mode auto` (default) picks the smallest encoding that holds the pixels exactly, or keeps the source bytes; a named mode forces that encoding and raises `OPTIMIZE_MODE_NOT_EXACT` (exit 5) when it cannot hold the pixels exactly. `--ancillary preserve` (default) copies metadata chunks and refuses sources whose chunks depend on the color layout; `strip` drops every ancillary chunk and lists what it dropped.
- `optimize` phases: every output path is preflighted together first, then every input is computed in memory, then files are written. If any input fails to compute, nothing is written and the error `details` list `processed` and `notProcessed`. If a write fails midway, files already written stay (multi-file writes are atomic per file, not a transaction), and `details` list `completed`, `failedTarget`, and `notStarted`. A file that cannot be made smaller (`unchanged`) is still written with the source bytes, except under `--dry-run`.
- Human output is one line per file: `ok optimize input=<p> output=<p|-> status=<s> source=<bytes> result=<bytes> mode=<mode>`; warnings follow as `warning [CODE] message`. `--json` carries the same result with per-file `candidates`, `preservedChunks`, `strippedChunks`, and `totals`.
- `model inspect` and `model validate` are read-only and take no output flags. `inspect` always exits 0; `validate` exits 3 when the verdict is `fail`. With `--pack`, `<file>` must sit under `<pack>/assets/<namespace>/models/` and the version comes from `pack.mcmeta` when no version flag is given (no usable value means the version is undetermined and no default is applied).
- `model create` / `model apply` read their JSON from a file or `-` (stdin; at most one `-` per command) and need exactly one of `--output` or `--stdout`. They check the document itself and refuse `--pack`, `--vanilla`, and `--dependency`. Model support covers cuboid `elements` only.
- `model export` needs at least one of `--output`, `--item-output`, `--blockstate-output`. `--item-output` needs `binding.item` (and the reverse), and `--blockstate-output` needs `binding.blockstate`. `binding.item` needs an explicit version at pack format 46.0 or later, otherwise `MODEL_UNSUPPORTED_VERSION` (exit 5). `--pack` adds layout and boundary checks. `--force` never applies to `--item-output` or `--blockstate-output`, which are never overwritten.
- `model preview` renders a fixed diagnostic image: three square panels side by side (`front`, `right`, `top`), each `--size` pixels (64, 128, or 256; default 64), so the PNG is `size * 3` wide and `size` high. `front` shows the north face seen from the north, `right` shows the east face seen from the east, and `top` shows the up face seen from above with north at the top. It draws only axis-aligned cuboid `elements` with existing UVs and face rotations of 0/90/180/270, using integer projection and a depth buffer; coordinates must be exact 1/256 multiples. Parent chains and texture variables reuse the existing resolution context. A missing texture fills its rectangle with a fixed checkerboard and raises a warning; element rotation, non-1/256 coordinates, translucent faces, and unresolvable textures are listed in `coverage.skipped` (`partial`), never silently misdrawn. `display` transforms and game lighting are not applied. Exactly one of `--output` or `--stdout` is required (`OUTPUT_REQUIRED` otherwise, `ARGUMENT_CONFLICT` for both); a non-64/128/256 size is `INVALID_ARGUMENT`. The model and its textures are only read.
- Shared write protection (`optimize` and `model`): every target is checked before the first byte is written. Outputs that alias an input or another output, directory targets, symlink targets (dangling ones included, even with `--force`), symlinked parent directories, and paths outside `--pack` for `model export` are refused. Existing files raise `OUTPUT_EXISTS` unless `--force` applies. Each file is still committed by an atomic rename.
- Reports verify structure and reference validity only. Nothing renders a model in the game client, so appearance, lighting, and in-game behavior are not verified. `model preview` is a diagnostic view, not a game renderer.

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
  { "type": "clearPixel", "x": 0, "y": 0 },
  { "type": "ellipse", "rect": { "x": 1, "y": 1, "width": 6, "height": 4 }, "color": "#FF0000FF", "mode": "fill" },
  { "type": "polygonFill", "points": [[0, 0], [4, 0], [2, 3]], "color": "#00FF00FF" },
  { "type": "strokeMask", "layerId": "base", "source": "alpha:base", "color": "#FFFFFFFF" },
  { "type": "outline", "layerId": "base", "mode": "tinted", "family": "gold" }
]
```

The same JSON shape is accepted by `apply_asset_operations` on the MCP surface: a bare array or an `{"operations": [...]}` envelope; an empty array is a valid no-op. Every operation accepts an optional string `id` (unique within one batch). `layerId` defaults to the sole layer on single-layer canvases; set it explicitly when the canvas has more than one layer (`regionFromSelection`, `mergeLayer`, and the region operations take no `layerId`). Colors are `transparent`, `#RRGGBB`, or `#RRGGBBAA`; coordinates are integers, never rounded.

The nine pixel operations accept an optional `selection` (a selection-expression atom string or object, same grammar as `--selection`). Only selected pixels are written; every unselected raw byte is restored verbatim, including hidden RGB under alpha 0. `fillRect` may omit `rect` when `selection` is present (the fill covers the selection bounds, clipped by the selection). The three shapes follow the frozen integer geometry and selection clipping: `ellipse` fills or outlines the ellipse inscribed in `rect` (`mode` is required, `fill` or `outline`); `polygonFill` fills the polygon named by `points`; `strokeMask` outlines the `source` selection read scope on `layerId` without painting the scope itself. `outline` takes the same optional `selection` and only paints the selected frame cells. A selection that matches no pixels refuses the write with `EMPTY_SELECTION` and rolls the batch back; the `quantize` / `cleanup` / `recolor` `--selection` paths keep their existing restore behavior instead.

Selection expressions name atoms (`all`, `rect:x,y,w,h`, `region:id`, `alpha[:layer]`, `color[:layer]:r,g,b,a`, `connected[:layer]:x,y`) or a JSON AST object (`{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`), capped at depth 32 and 1024 nodes.

| `type` | Required keys | Optional keys | Example |
|---|---|---|---|
| `setPixel` | `x`, `y`, `color` | `layerId`, `selection`, `id` | `{"type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF"}` |
| `clearPixel` | `x`, `y` | `layerId`, `selection`, `id` | `{"type": "clearPixel", "x": 0, "y": 0}` |
| `drawLine` | `from`, `to`, `color` | `layerId`, `selection`, `id` | `{"type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF"}` |
| `drawRect` | `rect`, `color` | `layerId`, `selection`, `id` | `{"type": "drawRect", "rect": {"x": 2, "y": 2, "width": 4, "height": 4}, "color": "#0000FFFF"}` |
| `fillRect` | `color` (`rect` required unless `selection` is present) | `layerId`, `rect`, `selection`, `id` | `{"type": "fillRect", "rect": {"x": 8, "y": 8, "width": 4, "height": 4}, "color": "#FFFF00FF"}` |
| `floodFill` | `x`, `y`, `color` | `layerId`, `selection`, `id` | `{"type": "floodFill", "x": 3, "y": 3, "color": "#FF00FFFF"}` |
| `ellipse` | `rect`, `color`, `mode` (`fill` / `outline`) | `layerId`, `selection`, `id` | `{"type": "ellipse", "rect": {"x": 1, "y": 1, "width": 6, "height": 4}, "color": "#FF0000FF", "mode": "fill"}` |
| `polygonFill` | `points` (array of `[x, y]` integer pairs), `color` | `layerId`, `selection`, `id` | `{"type": "polygonFill", "points": [[0, 0], [4, 0], [2, 3]], "color": "#00FF00FF"}` |
| `strokeMask` | `layerId`, `source` (selection expression), `color` | `selection`, `id` | `{"type": "strokeMask", "layerId": "base", "source": "alpha:base", "color": "#FFFFFFFF"}` |
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
| `outline` | `layerId`; `color` (`#RRGGBB`) when `mode` is `uniform` | `mode` (`tinted` default / `selective` / `uniform` / `black` / `strip`), `position` (`inside` default / `outside`), `family`, `luminanceDropPermille` (default 120, 0..400), `saturationRatioPermille` (default 1000, 0..2000), `maxHueOffsetDegrees` (default 5, 0..180), `snapFamilies` (default true), `selection`, `id` | `{"type": "outline", "layerId": "base", "mode": "tinted", "family": "gold"}` |

`outline` frames the non-transparent pixels of `layerId`: `inside` (default) rewrites the body edge pixels, and `outside` paints the empty cells that touch the body, the same footprint an outside stroke uses. `tinted` (default) darkens the adjacent body colour in integer HSL, dropping HSL lightness by `luminanceDropPermille` and scaling saturation by `saturationRatioPermille`; `selective` applies the same derived colour only to the backlit side, which with the light at the top left means `x >= cx` or `y >= cy` for the integer body centre; `uniform` fills the frame with `color`, which is required here and refused on every other mode; `black` fills it with opaque black; `strip` removes an existing frame by copying the darkest neighbouring interior pixel over each body edge pixel, so the body never changes size and empty pixels keep their hidden bytes. Each frame cell reads the body pixels the pass does not rewrite — the interior body pixels for `inside`, the adjacent body pixels for `outside` — and a cell with no such pixel keeps its current colour. `family` takes one of the twelve builtin families (`iron`, `gold`, `diamond`, `netherite`, `copper`, `wood`, `stone`, `emerald`, `amethyst`, `redstone`, `lapis`, `quartz`); while `snapFamilies` is true the derived colour snaps to the closer of that family's `outline` and `shadow` steps on the builtin vanilla ramp, and any other family id is `INVALID_ARGUMENT`. `maxHueOffsetDegrees` is recorded for style checks and never changes the output. All of the arithmetic is integer-only, so the same input bytes always produce the same output bytes.

In `drawLine`, `from` and `to` are `[x, y]` integer pairs; in `stampRect`, `to` is `{x, y}` and `offset` is `{dx, dy}`. `rect` is always `{x, y, width, height}` with width and height at least 1; `toIndex` is 0 or a positive integer; `value` is `0` (outside) or `1` (inside). `polygonFill` takes at most 4096 points (`RESOURCE_LIMIT_EXCEEDED` beyond that); a self-intersecting ring is `SELF_INTERSECTING_POLYGON`, and holes are unsupported (nested rings read as separate outlines). `stampRect` copies the `source` read scope without clearing it (`source` decides what is read, `selection` only clips the write; `to` pins the transformed output's top-left, `offset` shifts it relative to the source bounds, and passing both is `ARGUMENT_CONFLICT`). Unknown `type` values are `INVALID_ARGUMENT`; duplicate `id` values are `DUPLICATE_OPERATION_ID`.

Batch execution is atomic: the first invalid operation rolls back all changes. (`apply_asset_operations` on the MCP surface additionally accepts `atomic: false`, which runs every operation and reports per-operation applied/failed statuses instead of rolling back.)

---

## Exit Code Registry

| Code | Category | Meaning | Examples |
|---|---|---|---|
| **0** | Success | Command completed successfully. | Clean validation, successful render. |
| **1** | Internal Error | Unhandled engine defect (`INTERNAL_ERROR`). | Unexpected engine failure. |
| **2** | Invalid Invocation | Syntax error, conflicting flags, missing required parameters. | Missing `--output`, conflicting `--force --in-place`, `MODEL_INVALID_JSON`, `MODEL_INVALID_OPERATION`. |
| **3** | Asset Validation Failure | Engine executed properly, but the asset or pack failed validation. | `VALIDATION_FAILED`, broken textures, bad `.mcmeta`, model findings (`MODEL_INVALID_STRUCTURE`, `MODEL_INVALID_UV`, `MODEL_INVALID_ROTATION`, `MODEL_INVALID_DISPLAY`, `MODEL_VERSION_FEATURE`, `MODEL_SUSPICIOUS_VALUE`). |
| **4** | Filesystem Refusal | File exists without `--force`, missing directories without `--mkdir`. | `OUTPUT_EXISTS`, `FILESYSTEM_ERROR`. |
| **5** | Unsupported / Resource Limit | Input format not supported, canvas limits exceeded. | Corrupt image header, `UNSUPPORTED_IMAGE_FORMAT`, `OPTIMIZE_MODE_NOT_EXACT`, `MODEL_UNSUPPORTED_VERSION`. |

---

## Troubleshooting & Common Pitfalls

| Error Code | Exit | Root Cause | Remediation |
|---|---|---|---|
| `EMPTY_SELECTION` | 2 | A batch operation's `selection` or the `inspect --mode view` `--crop` matched no pixels. | Check layer and region bounds with `inspect --mode structure`, then widen the expression. |
| `ARGUMENT_CONFLICT` | 2 | Mutually exclusive options supplied together (`--force` + `--in-place`, more than one geometry flag, `--selection` with a geometry flag, both `to` and `offset` in `stampRect`). | Drop one of the conflicting options. |
| `OUTPUT_EXISTS` | 4 | Destination file already exists and `--force` was omitted. | Provide `--force` to confirm overwrite, or specify a new `--output` target. |
| `FILESYSTEM_ERROR` | 4 | An input cannot be read, or the output's parent directory does not exist and `--mkdir` was omitted. | Check the input path, or pass `--mkdir` to create missing directories. |
| `PACK_UNRESOLVED_EXTERNAL` | 0 (warning) | A `minecraft`-namespace reference (model parent, texture, model, or an equipment, particle, or font reference) cannot be resolved without the vanilla tree. Reported as a warning plus a `vanilla-not-provided` coverage entry; it never fails the scan by itself. | Supply `--vanilla <path>` pointing to an extracted vanilla asset root to verify external references. |
| `PACK_REFERENCE_CYCLE` | 3 | A model `parent` chain or a texture variable refers back to itself. | Break the loop in the model JSON (`parent` or `textures`). |
| `INVALID_MCMETA` | 2 | A malformed `.mcmeta`; for `gui-scale`, also nine-slice borders that leave no middle band (`left + right >= width` or `top + bottom >= height`). | Keep `left + right < width` and `top + bottom < height`. |
| `STYLE_INVALID` | 2 | A `.style.json` field is unknown, outside its enumeration, or carries a color that is not `#RRGGBB`; also an unreadable or unparsable style file, and an `extends` target that cannot be loaded. | Read the field path in the message (`palettes.stone.base: expected #RRGGBB, got "#12345"`) and fix exactly that field; a file-level failure names the path. |
| `STYLE_NOT_FOUND` | 2 | `style show` or `style export-palette` was given a style id that is not one of the four builtin presets. | Use `vanilla`, `soft`, `fairy-flat`, `dark-frame`, or a `.style.json` path. |
| `STYLE_INHERITANCE_CYCLE` | 2 | An `extends` chain returns to a style it already walked (at most eight levels). | Remove the loop; the message lists the repeated chain. |
| `STYLE_FAMILY_NOT_FOUND` | 2 | `--family` names a family the resolved style does not carry (for example after a document deleted one with `null`). | Pick a family from `style show <style>`, or stop deleting it. |
| `STYLE_UNSUPPORTED_VERSION` | 5 | A `.style.json` declares a `formatVersion` above the supported one. | Set `formatVersion` to 1 and adjust the document to this release. |
| `PACK_INIT_CONFLICT` | 4 | `pack init` found a path it would create already in place (a file, or a directory of the skeleton). | Read the `conflicts` list, remove or rename those paths, then run `pack init` again; nothing was written. |
| `PACK_PROJECT_INVALID` | 2 | A project document field is unknown, outside its shape, or names a path leaving the project root; `pack init` was also refused a `minecraft` namespace without `--allow-minecraft-namespace`. | Read the field path in the message and fix exactly that field; for `namespace`, either pick a different namespace or pass the opt-in flag. |
| `PACK_PROJECT_NOT_FOUND` | 2 | A project document was given at an explicit path that cannot be read. | Check the path; the commands never search parent directories for the document. |
| `PACK_PROJECT_UNSUPPORTED_VERSION` | 5 | A project document declares a `formatVersion` above the supported one. | Set `formatVersion` to 1 and adjust the document to this release. |
| `PACK_GUI_SCALING_BORDER` | 3 | `validate-pack` found a GUI sprite whose nine-slice borders leave no middle band (same test as `INVALID_MCMETA`). | Shrink the borders in that sprite's `.mcmeta`. |
| `PACK_MCMETA_INVALID` | 3 | The root `pack.mcmeta` declares something the game refuses to load: a missing `pack` section or `pack.description`, half a `min_format` / `max_format` range, negative or inverted bounds, a `supported_formats` field that disagrees with the declared range, a retained legacy `pack_format` outside the declared majors, an illegal overlay directory name, or an overlay `formats` field that contradicts the old-format rule. | Fix the named field so both range ends read and the declared majors agree, or drop the legacy field the rule forbids. |
| `PACK_MCMETA_SUSPICIOUS` | 0 (warning) | The pack still loads, but something looks wrong: an overlay directory the pack root does not hold, an overlay entry with no version field, or a scan target outside the declared range. Reported as a warning; it never fails the scan by itself. | Add the missing overlay directory, give the entry a version range, or re-target the scan into the declared range. |
| `PACK_UNRESOLVED_VARIABLE` | 0 (warning) | A texture variable cannot be resolved across its parent chain, and the model is neither used directly as a final model by blockstate or item definitions nor supplied with that variable by any child model (or single-file `model validate` / `model inspect` cannot determine child models). Reported as a warning; it never fails the scan by itself. | Define the missing variable in child models inheriting from this template, or remove the obsolete variable reference if the model is unused. |
| `RESOURCE_LIMIT_EXCEEDED` | 5 | A hard limit was crossed: more than 4096 polygon points, a selection AST deeper than 32 or larger than 1024 nodes, an `inspect view` output edge over 1024px, or the canvas size and memory limits. | Use fewer points or a smaller selection expression; view a large canvas in pieces with `--crop`. |
| `OPTIMIZE_MODE_NOT_EXACT` | 5 | `optimize --mode <name>` forced an encoding that cannot hold the pixels exactly (for example `rgb` on a source with transparency). | Use `--mode auto`, or a mode that can hold every pixel. |
| `MODEL_UNSUPPORTED_VERSION` | 5 | The target version cannot express a requested feature, or `model export` with `binding.item` has no explicit version of pack format 46.0 or later. | Pass `--minecraft-version` or `--resource-pack-version` that supports the feature. |
| `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT` | 5 | A `minecraft:*` profile with an output path that does not end in `.png`. | Write Minecraft textures as `.png`. |

## Generate metadata with mcmeta

Generate an animation or GUI scaling document from a PNG:

```sh
mc-asset mcmeta animation sheet.png --frame-size 16 --frametime 2 --frames '[0,{"index":1,"time":4},0]' --minecraft-version 1.21.2 --output sheet.png.mcmeta
mc-asset mcmeta gui panel.png --type nine_slice --border 4 --stretch-inner --resource-pack-version 42 --stdout
```

Animation requires `--frame-size <N|WxH>` and a single row or column of equal-sized frames that divide the PNG exactly; grids are rejected. `frametime` defaults to 1. `frames` accepts indices or `{index,time}` objects, including repeated or partial sequences; omitted means all frames in order. Times are positive integers and indices must be in range. `--interpolate` enables interpolation. GUI requires `--type <stretch|tile|nine_slice>`; tile and nine_slice use the PNG dimensions as design dimensions. Nine_slice requires `--border <N|json>` (four nonnegative sides: left, top, right, bottom) with a positive center. Only nine_slice accepts `--stretch-inner`.

CLI requires exactly one explicit `--output <path.mcmeta>` or `--stdout`; it never guesses a sibling name. Existing outputs require `--force`, which replaces the entire file and preserves no other sections. `--mkdir` permits missing parent directories. Inputs and unrelated sibling metadata remain unchanged; aliases and symbolic links are refused. Output is compact JSON with fixed key order and one trailing newline, containing only the requested section.

Use one of `--minecraft-version` or `--resource-pack-version`. GUI scaling requires pack format 16.0; stretch_inner requires 42.0. An incompatible target is `ARGUMENT_CONFLICT` before output. With no target, or a target outside 12.0 through 97.1, `versionChecked` is false with `VERSION_NOT_CHECKED`; this does not bypass GUI minimum versions. Animation is marked checked within that table based on the documented format and its history; this is not a per-release game-client test. See [texture animation and its history](https://minecraft.wiki/w/Resource_pack#Texture_animation) (interpolate added in 14w25a, before the supported release table), [GUI scaling](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w31a), and [pack formats](https://minecraft.wiki/w/Pack_format). These checks establish metadata structure and known version compatibility, not appearance or behavior in a game client.

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
