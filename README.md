# mc-asset

Pixel-native Minecraft asset toolchain (V0.1).

Entry point: `bun src/cli/index.ts` — distribution packaging is out of scope
for V0.1. The frozen CLI surface (flags, envelopes, exit codes) lives in
`docs/cli-surface.md`; this README only shows commands that were run
verbatim, with their real outputs.

V0.1 commands (five — `stub` in `--help` is a skeleton-test mount probe,
not product surface):

| Command | Input | Output |
|---|---|---|
| `import <image>` | Raster file (PNG today) | PNG and/or `.mcpx` |
| `render <grid>` | ASCII Grid file (`.grid`) | PNG and/or `.mcpx` |
| `build [source.mcpx]` (or `--stdin`) | `.mcpx` source | PNG and/or `.mcpx` |
| `analyze <image>` | Image file | Report only, no artifact file |
| `validate <asset>` | Asset file | Report only; exit 3 when the asset fails |

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
# warning [PENDING_SOURCE_PNG_ONLY] Compat fact "texture-png-only" is pending an official source; reported as warning only.
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
```

Machine-readable variants — `--json` moves the envelope to its own stream:

```sh
bun src/cli/index.ts --json analyze /tmp/mc-asset-quickstart/blank.png
# {"success":true,"result":{"dimensions":{"width":16,"height":16},"totalPixels":256,"colorCount":2,"alpha":{"predictedClassification":"cutout","opaquePixels":60,"transparentPixels":196,"partialAlphaPixels":0,"partialAlphaValues":[],"opaqueRatio":"0.2344","transparentRatio":"0.7656","partialAlphaRatio":"0.0000","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"dominantColors":[{"hex":"#00000000","r":0,"g":0,"b":0,"a":0,"count":196,"ratio":"0.7656"},{"hex":"#FF0000FF","r":255,"g":0,"b":0,"a":255,"count":60,"ratio":"0.2344"}],"profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"warnings":[{"code":"PENDING_SOURCE_PNG_ONLY","level":"warning","message":"Compat fact \"texture-png-only\" is pending an official source; reported as warning only."}]}

bun src/cli/index.ts --json validate /tmp/mc-asset-quickstart/blank.png
# {"success":true,"result":{"verdict":"pass","profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"dimensions":{"width":16,"height":16},"totalPixels":256,"colorCount":2,"alpha":{"predictedClassification":"cutout","opaquePixels":60,"transparentPixels":196,"partialAlphaPixels":0,"partialAlphaValues":[],"opaqueRatio":"0.2344","transparentRatio":"0.7656","partialAlphaRatio":"0.0000","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"findings":[{"code":"PENDING_SOURCE_PNG_ONLY","level":"warning","message":"Compat fact \"texture-png-only\" is pending an official source; reported as warning only."}]}}
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

## `import` and formats: PNG in, JPEG/WebP refused

The V0.1 decoder is PNG-only. JPEG/WebP bytes are rejected, not converted —
a real multi-format decoder is V0.2+ work:

```sh
bun src/cli/index.ts import /tmp/mc-asset-quickstart/fake.jpg --output /tmp/mc-asset-quickstart/fake.png
# error [UNSUPPORTED_IMAGE_FORMAT] Input does not start with the PNG signature.
# exit code: 5
```

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

## Determinism scope (CI-limited, V0.1 only)

What V0.1 guarantees, and where it was checked:

- Same canvas → byte-identical PNG. Verified locally: grid-render vs
  `.mcpx`-rebuild are identical bytes, and `--stdout` bytes match the file
  bytes. The encoder uses fixed parameters (8-bit, color type 6, filter 0,
  fixed deflate level/strategy in `src/io/png.ts`) with integer-only
  compositing — no timestamps, no randomness.
- Cross-runtime: CI runs a `node` job alongside the `bun` job
  (`.github/workflows/ci.yml`); the shared golden/canonical/determinism
  cases in `tests/**/*.node.ts` run under `node:test` with the same
  assertions as the `bun:test` entries, plus guards that forbid
  `Math.random`, transcendental `Math` functions in `src/`, and Bun-only
  APIs in `src/`.
- Scope limit: this covers V0.1 inputs and behaviors only. Nothing here
  promises byte-stability for future formats, profiles, or operations.

## Known gaps (honest list, V0.1)

- **JPEG/WebP**: rejected with `UNSUPPORTED_IMAGE_FORMAT` (exit 5).
  Decoding them is V0.2+ work.
- **No version-target flags**: only `--profile` exists. There is no
  `--minecraft-version`, `--pack-format`, or `--preset` flag —
  `validate blank.png --minecraft-version 26.3` fails with
  `error: unknown option '--minecraft-version'` (exit 2). The engine already
  carries packFormat-aware versioned facts (`src/profiles/versions.ts`),
  but the CLI exposes no switching (§73 is future work).
- **`--version` prints the toolchain version** (`0.1.0`, commander-owned,
  exit 0) and nothing more; it does not select compat behavior.
- **No isolated-pixel / anti-aliasing analysis or repair**: `analyze`
  reports counts and distributions (`colorCount`, alpha histogram, dominant
  colors) and never mutates pixels. Detection/cleanup heuristics are
  recorded as future work only.
- **`PENDING_SOURCE_PNG_ONLY` warning**: every analyze/validate report
  carries it, because the PNG-only texture fact still lacks an official
  source (§95). It is warning-only by construction and can never fail
  validation.
- **Effective alpha needs `validate-pack` (V0.5)** — see above.

## Development

```sh
bun test              # full suite (bun:test entries)
bun run test:typecheck # tsc --noEmit
bun run lint          # biome check .
```

(`bun run build` bundles `src/index.ts` to `dist/` for Node; CI additionally
loads `dist/index.js` under plain `node` to prove portability.)

See `LICENSE` (MIT).
