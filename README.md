# mc-asset

Pixel-native Minecraft asset toolchain. The V0.1 command set and the frozen
V0.2 and V0.3 command sets all ship from this entry point; `--version` still
prints `0.1.0` (commander-owned).

Entry point for development: `bun src/cli/index.ts`. For installation,
`mc-asset` ships through Homebrew — see `docs/homebrew.md` and
`docs/release-playbook.md`. The frozen CLI surface (flags, envelopes, exit
codes) lives in `docs/cli-surface.md`; this README only shows commands that
were run verbatim, with their real outputs.

V0.1 commands (five — `stub` in `--help` is a skeleton-test mount probe,
not product surface):

| Command | Input | Output |
|---|---|---|
| `import <image>` | Raster file (PNG today) | PNG and/or `.mcpx` |
| `render <grid>` | ASCII Grid file (`.grid`) | PNG and/or `.mcpx` |
| `build [source.mcpx]` (or `--stdin`) | `.mcpx` source | PNG and/or `.mcpx` |
| `analyze <image>` | Image file | Report only, no artifact file |
| `validate <asset>` | Asset file | Report only; exit 3 when the asset fails |

V0.2 commands (nine, frozen; semantics in `docs/v02-design.md`, flags and
exit codes in `docs/cli-surface.md`):

| Command | Input | Output |
|---|---|---|
| `transform <input>` | PNG/JPEG/WebP/`.mcpx` | PNG and/or `.mcpx` |
| `quantize <input>` | PNG/JPEG/WebP/`.mcpx` | PNG and/or `.mcpx` |
| `cleanup <input>` | PNG/JPEG/WebP/`.mcpx` | PNG and/or `.mcpx` |
| `pixelize <image>` | PNG/JPEG/WebP | PNG and/or `.mcpx`; Minecraft profiles PNG only |
| `palette extract` / `palette inspect <image>` | PNG/JPEG/WebP/`.mcpx` | Report only |
| `material list` / `material show <name>` | — | Report only |
| `recolor <source>` | `.mcpx` | PNG and/or `.mcpx` |
| `variant <source>` | `.mcpx` | Several PNG and/or `.mcpx` under `--output-dir` |
| `analyze <image>` (extended) | PNG/JPEG/WebP | Report only |

V0.3 commands (three, frozen; semantics in `docs/v03-design.md`, flags and
exit codes in `docs/cli-surface.md`):

| Command | Input | Output |
|---|---|---|
| `tile <input>` | PNG/JPEG/WebP/`.mcpx` | Report only, or PNG (single corrected tile / NxN repeat preview) |
| `generate <pattern>` | None (palette from built-in material name or `.mcpx`) | PNG and/or `.mcpx` |
| `preview <input>` | PNG/JPEG/WebP/`.mcpx` | Report only (`--ascii`/`--palette-map`), or PNG (`--scale`) |

## Prerequisites

- [Bun](https://bun.sh) (see `.github/workflows/ci.yml` for the runtime CI uses).
- First-time setup: `bun install` (exercised by CI via
  `bun install --frozen-lockfile` on every push; not re-run locally for this
  README to avoid touching `node_modules`/`bun.lock`).

All commands below assume the working directory is the repo root and use
explicit paths under `/tmp/mc-asset-quickstart`, so nothing pollutes the repo.

## Quickstart: blank grid to validated PNG

The 16×16 from-zero path: hand-authored grid → PNG → analyze → validate.

```sh
mkdir -p /tmp/mc-asset-quickstart
printf '%s\n' \
  '[palette]' \
  '. = transparent' \
  'X = #FF0000FF' \
  '' \
  '[grid]' \
  'XXXXXXXXXXXXXXXX' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'X..............X' \
  'XXXXXXXXXXXXXXXX' \
  > /tmp/mc-asset-quickstart/blank.grid
```

Render it (every write needs an explicit target — see the next section):

```sh
bun src/cli/index.ts render /tmp/mc-asset-quickstart/blank.grid --output /tmp/mc-asset-quickstart/blank.png
# ok render profile=generic applied=0 output=/tmp/mc-asset-quickstart/blank.png
```

Analyze (read-only; classification is **predicted**, never effective):

```sh
bun src/cli/index.ts analyze /tmp/mc-asset-quickstart/blank.png
# dimensions: 16x16
# colors: 2
# alpha: predicted cutout (opaque=60 transparent=196 partial=0)
# dominant: #00000000 x196 (0.7656), #FF0000FF x60 (0.2344)
# profile: predicted profile generic has no Minecraft-specific restrictions.
# palette: colorCount=2 alphaLevels=2 transparent=196 partial=0
# pixel-art: 16x16 aspect=1:1 isolated=0 semiTransparent=0 tileFriendly=true
# recommended: quantize.colors=2 cleanup=none resize=nearest
# warning [PENDING_SOURCE_PNG_ONLY] Compat fact "texture-png-only" is pending an official source; reported as warning only.
# target: default (engine defaults)
```

Validate (read-only; exit 0 here because the asset passes):

```sh
bun src/cli/index.ts validate /tmp/mc-asset-quickstart/blank.png
# verdict: pass
# dimensions: 16x16
# colors: 2
# alpha: predicted cutout (opaque=60 transparent=196 partial=0)
# profile: predicted profile generic has no Minecraft-specific restrictions.
# warning [PENDING_SOURCE_PNG_ONLY] Compat fact "texture-png-only" is pending an official source; reported as warning only.
# target: default (engine defaults)
```

Machine-readable variants — `--json` moves the envelope to its own stream:

```sh
bun src/cli/index.ts --json analyze /tmp/mc-asset-quickstart/blank.png
# {"success":true,"result":{"dimensions":{"width":16,"height":16},"totalPixels":256,"colorCount":2,"alpha":{"predictedClassification":"cutout","opaquePixels":60,"transparentPixels":196,"partialAlphaPixels":0,"partialAlphaValues":[],"opaqueRatio":"0.2344","transparentRatio":"0.7656","partialAlphaRatio":"0.0000","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"dominantColors":[{"hex":"#00000000","r":0,"g":0,"b":0,"a":0,"count":196,"ratio":"0.7656"},{"hex":"#FF0000FF","r":255,"g":0,"b":0,"a":255,"count":60,"ratio":"0.2344"}],"profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"paletteCharacteristics":{"colorCount":2,"alphaLevels":2,"roles":[],"transparentPixels":196,"partialAlphaPixels":0},"pixelArtCharacteristics":{"resolution":{"width":16,"height":16},"aspect":"1:1","isolatedPixels":0,"semiTransparentPixels":0,"paletteSize":2,"tileFriendly":true},"recommended":{"quantize":{"colors":2},"cleanup":{"classes":[]},"resize":{"mode":"nearest"}},"warnings":[{"code":"PENDING_SOURCE_PNG_ONLY","level":"warning","message":"Compat fact \"texture-png-only\" is pending an official source; reported as warning only."}],"version":{},"target":"default (engine defaults)"}

bun src/cli/index.ts --json validate /tmp/mc-asset-quickstart/blank.png
# {"success":true,"result":{"verdict":"pass","profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"dimensions":{"width":16,"height":16},"totalPixels":256,"colorCount":2,"alpha":{"predictedClassification":"cutout","opaquePixels":60,"transparentPixels":196,"partialAlphaPixels":0,"partialAlphaValues":[],"opaqueRatio":"0.2344","transparentRatio":"0.7656","partialAlphaRatio":"0.0000","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"findings":[{"code":"PENDING_SOURCE_PNG_ONLY","level":"warning","message":"Compat fact \"texture-png-only\" is pending an official source; reported as warning only."}],"version":{},"target":"default (engine defaults)"}}
```

## Explicit paths: no implicit filenames, no silent overwrites

mc-asset never invents an output name. A write command without
`--output` / `--stdout` / `--source` / `--in-place` writes zero files:

```sh
bun src/cli/index.ts render /tmp/mc-asset-quickstart/blank.grid
# error [OUTPUT_REQUIRED] One of --output, --stdout, --source, or --in-place is required.
# exit code: 2
```

An existing target is refused unless the rerun is explicit:

```sh
bun src/cli/index.ts render /tmp/mc-asset-quickstart/blank.grid --output /tmp/mc-asset-quickstart/blank.png
# error [OUTPUT_EXISTS] Output exists: /tmp/mc-asset-quickstart/blank.png. Pass --force to overwrite.
# exit code: 4
```

Rerun recipe — same command plus `--force`:

```sh
bun src/cli/index.ts render /tmp/mc-asset-quickstart/blank.grid --output /tmp/mc-asset-quickstart/blank.png --force
# ok render profile=generic applied=0 output=/tmp/mc-asset-quickstart/blank.png
# exit code: 0
```

Related path rules (flag list verified via `render --help`):

- `--mkdir` creates missing parent directories (else `FILESYSTEM_ERROR`):
  `render blank.grid --output nested/dir/blank.png --mkdir` succeeds.
- `--in-place` rewrites the input path and implies force for that target
  only: `import inplace.png --in-place` succeeds with
  `ok import profile=generic applied=0 output=.../inplace.png`.
- `--force` with `--in-place` is rejected, not merged:
  `import inplace.png --in-place --force` →
  `error [ARGUMENT_CONFLICT] --force and --in-place must not be combined.`
  (exit 2).
- `--profile` accepts `generic` (default), `minecraft:item`,
  `minecraft:block`. Minecraft profiles export PNG only: a non-`.png`
  output path is `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT`.
- Every file target is existence-checked before the first byte lands
  anywhere, and writes are atomic (temp file + rename).

## `--json` and `--stdout` channel routing

- Without `--stdout`: human log on stdout; with `--json`, the JSON envelope
  goes to stdout and logs/diagnostics go to stderr.
- With `--stdout`: PNG bytes go to stdout, so the envelope and logs move to
  stderr (also under `--json`). Agent pipeline usage:

```sh
bun src/cli/index.ts render /tmp/mc-asset-quickstart/blank.grid --stdout > /tmp/mc-asset-quickstart/stdout.png
# stderr: ok render profile=generic applied=0 stdout=true
# stdout.png is byte-identical to blank.png (verified with cmp)
```

A failure under `--json` is still a JSON envelope (stderr), with the
matching exit code:

```sh
bun src/cli/index.ts --json render /tmp/mc-asset-quickstart/blank.grid --output /tmp/mc-asset-quickstart/blank.png
# {"success":false,"error":{"code":"OUTPUT_EXISTS","message":"Output exists: /tmp/mc-asset-quickstart/blank.png. Pass --force to overwrite."}}
# exit code: 4
```

## Exit codes

Single source of truth: `ERROR_EXIT_CODE` in `src/core/errors.ts`
(commander misuse such as unknown flags maps to 2 in `src/cli/index.ts`).
Each row below names the command that demonstrated it:

| Exit | Meaning | Demonstrated with |
|---|---|---|
| 0 | Success | quickstart commands above |
| 1 | General (`INTERNAL_ERROR`) | Registry-defined; no simple manual trigger exists, so no demo command is claimed |
| 2 | Invalid input (`INVALID_ARGUMENT`, `ARGUMENT_CONFLICT`, `OUTPUT_REQUIRED`, `MCPX_*`, …) | `render` without a target → `OUTPUT_REQUIRED`; `--in-place --force` → `ARGUMENT_CONFLICT`; unknown `--minecraft-version` flag (see gaps) |
| 3 | Tool ok, asset bad (`VALIDATION_FAILED`, …) | `validate tile.webp --profile minecraft:item` (PNG bytes under a `.webp` name): verdict `fail` plus `error [VALIDATION_FAILED] validation failed: 1 error(s), 1 warning(s).` |
| 4 | Filesystem (`FILESYSTEM_ERROR`, `OUTPUT_EXISTS`) | rerun without `--force` → `OUTPUT_EXISTS` |
| 5 | Unsupported (`UNSUPPORTED_IMAGE_FORMAT`, `MCPX_UNSUPPORTED_VERSION`, `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT`, `RESOURCE_LIMIT_EXCEEDED`) | `import` of JPEG-magic bytes → `error [UNSUPPORTED_IMAGE_FORMAT] Input does not start with the PNG signature.` |

## `.mcpx`: when to save it, when to build from it

`--source <path>` saves the editable text source alongside (or instead of)
the PNG. Save it when a human or agent will edit the asset later; skip it
for one-shot renders.

```sh
bun src/cli/index.ts render /tmp/mc-asset-quickstart/blank.grid --source /tmp/mc-asset-quickstart/blank.mcpx --force
# ok render profile=generic applied=0 source=/tmp/mc-asset-quickstart/blank.mcpx
```

(`--source` without `--output` only saves the source; `--output` without
`--source` only renders PNG — either artifact alone is complete.)

Rebuild later from the saved source — the result is byte-identical to the
grid render (verified with `cmp`):

```sh
bun src/cli/index.ts build /tmp/mc-asset-quickstart/blank.mcpx --output /tmp/mc-asset-quickstart/rebuilt.png
# ok build profile=generic applied=0 output=/tmp/mc-asset-quickstart/rebuilt.png
```

Stdin form (pipe; `build --stdin` with `--operations -` is
`ARGUMENT_CONFLICT` — one stdin stream cannot feed both):

```sh
cat /tmp/mc-asset-quickstart/blank.mcpx | bun src/cli/index.ts build --stdin --output /tmp/mc-asset-quickstart/from-stdin.png
# ok build profile=generic applied=0 output=/tmp/mc-asset-quickstart/from-stdin.png
```

`import` also round-trips through `.mcpx` (decodes PNG, saves the source):

```sh
bun src/cli/index.ts import /tmp/mc-asset-quickstart/blank.png --source /tmp/mc-asset-quickstart/imported.mcpx --force
# ok import profile=generic applied=0 source=/tmp/mc-asset-quickstart/imported.mcpx
```

## `import` and formats: PNG-only import, multi-format commands

`import` stays on the PNG-only decoder: JPEG/WebP bytes are rejected, not
converted. The shared multi-format decoder backs `transform`, `quantize`,
`cleanup`, `palette`, and — since V0.3 — `tile` and `preview`, which all read
PNG, JPEG, WebP, and `.mcpx`; `pixelize` and `analyze` take PNG, JPEG, and
WebP only. `generate` has no input image: its palette comes from a built-in
material name or an `.mcpx` `[palette]`. `recolor` and `variant` take an
editable `.mcpx` source, and `import`/`validate` remain PNG-only (see the
V0.2 section below):

```sh
bun src/cli/index.ts import /tmp/mc-asset-quickstart/fake.jpg --output /tmp/mc-asset-quickstart/fake.png
# error [UNSUPPORTED_IMAGE_FORMAT] Input does not start with the PNG signature.
# exit code: 5
```

## V0.2 commands in practice

The V0.2 engines reuse the V0.1 file rules: an explicit target is required,
an existing target needs `--force`, missing parents need `--mkdir`, and every
write is atomic. Geometry is one operation per call — two geometry flags, or
a geometry flag together with `--selection`, is `ARGUMENT_CONFLICT`.

```sh
bun src/cli/index.ts transform /tmp/mc-asset-quickstart/blank.mcpx --flip h --output /tmp/mc-asset-quickstart/flipped.png
# ok transform profile=generic applied=0 output=/tmp/mc-asset-quickstart/flipped.png

bun src/cli/index.ts quantize /tmp/mc-asset-quickstart/blank.mcpx --colors 2 --output /tmp/mc-asset-quickstart/quantized.png
# ok quantize profile=generic applied=0 output=/tmp/mc-asset-quickstart/quantized.png

bun src/cli/index.ts cleanup /tmp/mc-asset-quickstart/blank.mcpx --output /tmp/mc-asset-quickstart/cleaned.png
# ok cleanup profile=generic applied=0 output=/tmp/mc-asset-quickstart/cleaned.png
```

`cleanup` without `--fix` detects and reports only; fixing an alpha-affecting
class additionally needs `--allow-render-pass-change` (`outlier` does not).

`pixelize` runs a reference image through the fixed eleven-stage pipeline and
always needs `--size`:

```sh
bun src/cli/index.ts pixelize /tmp/mc-asset-quickstart/blank.png --size 32 --preset item --output /tmp/mc-asset-quickstart/pixel.png
# ok pixelize profile=generic applied=0 output=/tmp/mc-asset-quickstart/pixel.png
```

`variant` fans one `.mcpx` source out to one PNG plus one `.mcpx` per
material, all inside an explicit `--output-dir` (a repeat run is
byte-identical):

```sh
bun src/cli/index.ts variant /tmp/mc-asset-quickstart/blank.mcpx --materials iron,copper --output-dir /tmp/mc-asset-quickstart/variants --mkdir
# ok variant profile=generic applied=0 outputDir=/tmp/mc-asset-quickstart/variants files=4
# writes blank_iron.png, blank_iron.mcpx, blank_copper.png, blank_copper.mcpx
```

`palette extract`, `palette inspect`, `material list`, and `material show`
produce reports only and refuse every file flag. `analyze` keeps its V0.1
fields and adds `paletteCharacteristics`, `pixelArtCharacteristics`, and
`recommended` (see the quickstart sample above); its output stays predicted.

## V0.3 commands in practice

`tile`, `generate`, and `preview` reuse the V0.1 file rules: an explicit
target is required where a command writes, an existing target needs
`--force`, missing parents need `--mkdir`, and every write is atomic. `tile`
is report-only unless `--output` is given, `generate` has no input file
(pattern, palette, and seed replace it), and `preview` runs exactly one mode.
The transcript below keeps the real outputs but uses bare command names
instead of the full `bun src/cli/index.ts` entry prefix:

```text
$ generate noise --size 16 --palette stone --seed 1234 --output stone.png
ok generate profile=generic applied=0 pattern=noise seed=1234 size=16x16 palette=stone output=stone.png

$ tile stone.png
ok tile profile=generic seam=h:0.078226 v:0.083931 c:0.054562 repeat=0.913975

$ tile stone.png --json
{"success":true,"result":{"command":"tile","profile":"generic","width":16,"height":16,"seam":{"horizontal":{"raw":325544,"pairs":16,"score":"0.078226"},"vertical":{"raw":349288,"pairs":16,"score":"0.083931"},"corner":{"raw":28383,"pairs":2,"score":"0.054562"}},"repeat":{"score":"0.913975","periodX":2,"periodY":3},"corrections":[]}}

$ tile stone.png --edge-match both --output fixed.png
ok tile profile=generic seam=h:0.078226 v:0.083931 c:0.054562 repeat=0.913975 output=fixed.png

$ tile stone.png --preview 4x4 --output preview.png
ok tile profile=generic seam=h:0.078226 v:0.083931 c:0.054562 repeat=0.913975 output=preview.png

$ preview stone.png --palette-map
ok preview profile=generic mode=palette-map colors=7 size=16x16

$ preview stone.png --scale 4 --output big.png
ok preview profile=generic mode=scale size=64x64 scale=4 output=big.png
```

`preview stone.png --ascii` prints the flattened canvas as a document in the
`.grid` format:

```text
[palette]
0 = #17171AFF
1 = #55555CFF
2 = #6B6B73FF
3 = #84848CFF
4 = #A3A3ABFF
5 = #C9C9D1FF
6 = #E8E8EEFF

[grid]
2336235330526123
4522306531653216
1625431242236524
6223104060023614
0631105555564454
3403266614061161
5544203002013606
5566001015325452
5455523212321636
0566231315104646
3014354163103004
6535336525260264
5630415266361416
0446555652221412
2312606651626531
2651515315521115
```

That document is `.grid`-compatible: save it and feed it straight back to
`render`, and `--json` carries the same document structurally. Tile
measurement is an authoring tool — it reports, and with explicit correction
flags writes PNG, but never writes back to a `.mcpx`.

## Batch operations (`--operations`)

Pixel/rect/line/fill edits travel through `--operations <path>` on
`import`/`render`/`build`, not through separate commands. The body is a bare
array or `{"operations": [...]}`; `id` is optional and unique when present;
an empty array is a valid no-op. Colors: `transparent`, `#RRGGBB`, or
`#RRGGBBAA`.

```sh
printf '%s' '[{"type":"setPixel","x":0,"y":0,"color":"#00FF00FF"}]' > /tmp/mc-asset-quickstart/ops.json
bun src/cli/index.ts render /tmp/mc-asset-quickstart/blank.grid --operations /tmp/mc-asset-quickstart/ops.json --output /tmp/mc-asset-quickstart/edited.png
# ok render profile=generic applied=1 output=/tmp/mc-asset-quickstart/edited.png
```

The batch runs atomically: the first failure rolls the canvas back and the
error envelope reports `{applied: 0, rolledBack: true}`.

## Alpha classification is predicted, never effective

`analyze`/`validate` report `predictedClassification` (`solid` | `cutout` |
`translucent`) computed from PNG bytes only — the reports even say so
(`predictedNote: "predicted classification from PNG bytes only; not the
final in-game render result."`). A block model can force any quad into the
translucent pass (`force_translucent`), so the effective classification
needs the model JSON too. That check belongs to `validate-pack` (V0.5), not
V0.1: never treat a V0.1 report as the in-game result.

## Determinism scope (CI-limited, V0.1 + V0.2 + V0.3)

What the toolchain guarantees, and where it was checked:

- Same canvas → byte-identical PNG. Verified locally: grid-render vs
  `.mcpx`-rebuild are identical bytes, and `--stdout` bytes match the file
  bytes. The encoder uses fixed parameters (8-bit, color type 6, filter 0,
  fixed deflate level/strategy in `src/io/png.ts`) with integer-only
  compositing — no timestamps, no randomness.
- Same input plus same flags → byte-identical output for the V0.2 write
  commands. `transform`, `quantize`, `cleanup`, `recolor`, `pixelize`, and
  `variant` rerun byte-identically: locked in their spawn suites and in the
  rerun case of `tests/conformance/cli-conformance.test.ts`. The eleven-stage
  pixelize pipeline and the integer-only engines carry no timestamps and no
  randomness.
- Same input plus same flags → byte-identical output for the V0.3 commands
  too. `tile`, `generate`, and `preview` rerun byte-identically, locked in
  their spawn suites and in the V0.3 determinism cases of
  `tests/conformance/cli-conformance.test.ts`. `generate` produces identical
  bytes for the same seed across Bun and Node, because its only randomness is
  a fixed xorshift32 stream derived from `--seed`.
- Cross-runtime: CI runs a `node` job alongside the `bun` job
  (`.github/workflows/ci.yml`); the shared golden/canonical/determinism cases
  in `tests/**/*.node.ts` run under `node:test` with the same assertions as
  the `bun:test` entries. `scripts/compare-runtime.mjs` additionally compares
  Bun (running the source CLI) against Node (running the bundle) byte for
  byte: the V0.1 render/build chain and the V0.2 scenarios `transform`,
  `quantize`, `pixelize` on JPEG and WebP, a four-file `variant` fan-out, and
  canonical `analyze` JSON. The V0.3 scenarios add `generate` PNG and `.mcpx`
  bytes, the `tile` report JSON, and the three `preview` modes (`--ascii`,
  `--palette-map`, and `--scale` PNG).
- Static guards in CI forbid `Math.random` and transcendental `Math`
  functions in `src/` (§100.2, §100.3), and Bun-only APIs in `src/` (§100.5).
- Scope limit: this covers the checked V0.1, V0.2, and V0.3 inputs, formats,
  and flags only. JPEG decode is not claimed bit-exact across
  implementations, and untested format variants stay unverified (see the
  gaps below).

## Known gaps (honest list)

- **Raster format coverage is split**: `transform`, `quantize`, `cleanup`,
  `palette`, `tile`, and `preview` accept PNG/JPEG/WebP/`.mcpx`; `pixelize`
  and `analyze` accept PNG/JPEG/WebP; `import` and `validate` are still
  PNG-only (JPEG/WebP rejected with `UNSUPPORTED_IMAGE_FORMAT`, exit 5);
  `generate` reads no input image (its palette comes from a built-in material
  name or an `.mcpx` `[palette]`); `recolor` and `variant` take an editable
  `.mcpx` source. The decoder pins `jpeg-js@0.4.4` and
  `@jsquash/webp@1.5.0` (libwebp via a wasm binary embedded as base64 so the
  single-file bundle needs no sidecar), recorded in
  `.project-doc/decoder-selection.md`.
- **JPEG decode is not bit-exact against other implementations**, and its
  dependency is dormant: `jpeg-js` has had no releases since 2022, so JPEG
  goldens must stay pinned to this decoder (a bit-exact path would mean
  swapping to `@jsquash/jpeg`).
- **Format coverage beyond the fixtures is unverified**: progressive JPEG,
  animated WebP, and ICC/EXIF color payloads were never tested, and
  large-image performance and memory were never measured (the fixtures are
  8×8).
- **`pixelize` is a starter pipeline**: Crop, Background, Subject, Edge, and
  Cluster are starter no-ops (full frame, verbatim alpha, subject in place,
  emphasis 0, merge threshold 0), and the presets are starter parameter sets
  — `item` 16 colors, `block` 12, `generic` 32 — all pending art-direction
  review. Sizes other than a 16/32/64/128 square warn
  (`NON_STANDARD_RESOLUTION`) but still write.
- **`analyze`'s pixel-art fields are starter rules**: `tileFriendly` uses a
  strict edge-equality wrapping rule pending review, `recommended.cleanup`
  has no rule yet (always `[]`), and `paletteSize` is the distinct RGBA count
  because raster intake has no authoring palette.
- **The seven built-in materials are starter palettes**: `iron`, `copper`,
  `oxidized_copper`, `gold`, `wood`, `stone`, `crystal` are project-owned hex
  values pending art-direction review; `steel`/`leather`/`cloth` are not
  built in. An unknown material is `INVALID_ARGUMENT` for now — a dedicated
  error code is an open decision (§105.12).
- **`pixel-aware` resize is name-only**: `--resize-mode pixel-aware` is
  accepted by name and then refused with `INVALID_ARGUMENT`; `nearest`
  (default) and `box` are the real modes. `resize`/`crop` have no top-level
  aliases — both travel through `transform` — and geometry never enters the
  `--operations` batch vocabulary (`INVALID_ARGUMENT`).
- **`variant` writes two files per material**: `<basename>_<material>.png`
  plus `.mcpx`, always under an explicit `--output-dir`. Listing the same
  material twice in one `--materials` value is `ARGUMENT_CONFLICT` (a V0.2
  reading, pending review).
- **Closed V0.1 gaps**: layer/region manipulation is reachable through
  `--operations` and the CLI, and `analyze` now reports a measured
  `isolatedPixels` (the V0.1 "silent on isolated pixels" gap is retired);
  there is still no anti-aliasing detection.
- **Version targets are narrow**: `analyze`/`validate` accept
  `--minecraft-version 26.3` or an integer `--resource-pack-version`; dotted
  resource-pack versions such as `97.1` are `INVALID_ARGUMENT`, and the
  multi-version fact layer is V0.5 work. `--preset` exists on `pixelize` only;
  there is no `--pack-format`.
- **`--version` prints the toolchain version** (`0.1.0`, commander-owned,
  exit 0) and nothing more; it does not select compat behavior.
- **`PENDING_SOURCE_PNG_ONLY` warning**: every analyze/validate report
  carries it, because the PNG-only texture fact still lacks an official
  source (§95). It is warning-only by construction and can never fail
  validation.
- **Effective alpha needs `validate-pack` (V0.5)**, and later-version surface
  stays unimplemented: no `animate`, `validate-pack`, or `mcp` command
  (V0.4–V0.6).
- **The ten procedural patterns are a starter**: `generate`'s pattern
  algorithms and color sampling are deterministic — goldens pin the 8×8
  seed-7 stone output for every pattern — but the algorithms and the color
  choices are pending art-direction review.
- **`repeat` scoring has no cost ceiling**: `tile` scans every shift along
  both axes, so large images are slow. The score is deterministic, its cost
  is just unbounded.
- **`preview --ascii` `[grid tokens]` is untested**: the tokenized path (more
  than 62 colors in the flattened canvas) has no dedicated spawn test.
- **Generation quality is not guaranteed**: determinism promises identical
  reruns, not good-looking output. Aesthetics are explicitly out of scope.

## Development

```sh
bun test              # full suite (bun:test entries)
bun run test:typecheck # tsc --noEmit
bun run lint          # biome check .
```

(`bun run build` bundles `src/index.ts` to `dist/` for Node; CI additionally
loads `dist/index.js` under plain `node` to prove portability.)

See `LICENSE` (MIT).
