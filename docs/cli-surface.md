# CLI Surface (frozen, V0.1)

Entry point: `bun src/cli/index.ts` (distribution packaging is out of scope for V0.1).

Global behavior follows `project-detail.md` §98 (channels, OUTPUT_EXISTS/--force/--mkdir, atomic write, --force/--in-place mutex) and §99 (exit codes via the `core/errors` registry; no local table). V0.1 implements `--profile` everywhere plus `--minecraft-version`/`--resource-pack-version` on `analyze`/`validate` only; there is no `--preset` flag.

## Global flags

```text
--json       JSON envelope to the envelope stream, everything else to stderr
--help       Command help (commander-owned, exit 0)
--version    Print version (commander-owned, exit 0)
```

## Per-command file flags (all file-producing commands)

```text
--output <path>   Explicit output file (no implicit filenames, §57)
--stdout          Artifact bytes to stdout (envelope/logs move to stderr)
--force           Allow overwriting an existing target (else OUTPUT_EXISTS)
--mkdir           Create missing parent directories (else FILESYSTEM_ERROR)
--in-place        Target the input path (--force with --in-place is ARGUMENT_CONFLICT)
--input <path>    Input path backing --in-place
--profile <name>  V0.1: generic | minecraft:item | minecraft:block
```

Each file path a command writes (including a future `--source` path for
saving `.mcpx` alongside PNG, §58) applies the OUTPUT_EXISTS/atomic/--mkdir
guard individually. Missing `--output`/`--stdout` (and no `--in-place`) is
OUTPUT_REQUIRED and creates zero files.

## V0.1 commands

| Command | Input | Output | Difference from neighbors |
|---|---|---|---|
| `import <image>` | Raster file (PNG/JPEG/WebP) | PNG and/or `.mcpx` | Only command that decodes binary images; text sources cannot enter here |
| `render <grid>` | ASCII Grid file (`.grid`) | PNG and/or `.mcpx` | Only command that reads hand/ Agent-authored text grids |
| `build <source.mcpx>` (stdin also accepted) | `.mcpx` source | PNG and/or `.mcpx` | Only command whose input is the editable source format itself |
| `analyze <image>` | Image file | Report only (human/JSON), no artifact file | Read-only; classification output is predicted, never effective (§40) |
| `validate <asset>` | Asset file | Report only; exit 3 when the asset fails validation | Read-only; exit 3 means "tool ok, asset bad", distinct from tool errors |

`compose` is **not** a V0.1 command: no clear difference from layer/batch
operations could be stated, so per §104.1 it is merged away rather than kept
as a synonym. Layer/region/pixel manipulation travels through batch
operations, not a separate compose entry.

Deferred (names reserved, not V0.1): `pixelize`, `quantize`, `cleanup`,
`recolor`, `variant`, `transform`, `tile`, `preview`, `animate`,
`validate-pack` (V0.5), `mcp` (V0.6).

## Authoring text inputs

- ASCII Grid: extension `.grid`; `[grid]` compact vs `[grid tokens]`
  tokenized per §96.8. Example input: `sword.grid`.
- Pixel Spec: the batch-operations JSON body (§29/§103, `id` optional,
  unique when present). It has **no** standalone file extension and MUST NOT
  be called `.pixel`; it travels via `--operations <path>`/stdin or the
  relevant command's input payload (t08 wires the flag).
- `.pixel` MUST NOT appear anywhere as an extension.

## Write commands (V0.1 production paths)

```text
import <image> [--output png] [--source mcpx] [--stdout] [--operations ops.json]
render <grid>  [--output png] [--source mcpx] [--stdout] [--operations ops.json]
build [source] [--stdin] [--output png] [--source mcpx] [--stdout] [--operations ops.json]
```

Common file flags per command: `--output`, `--stdout`, `--source`,
`--force`, `--mkdir`, `--in-place`, `--input`, `--profile`, plus
`--operations` below. `build` additionally accepts `--stdin` to read the
`.mcpx` source from stdin instead of a path argument.

- `--output <path>` carries PNG bytes; `--source <path>` carries the
  editable `.mcpx` text (assigned before serialize, existing symbols kept).
  Either artifact alone is a complete invocation: `--source` without
  `--output` only saves the source (§58), `--output` without `--source`
  only renders PNG.
- `--in-place` rewrites the file input and implies force for that target
  only: PNG back to the input for `import`/`render`, re-serialized `.mcpx`
  back to the input for `build`. It needs a file input; with stdin input
  it is INVALID_ARGUMENT. `--force` with `--in-place` is ARGUMENT_CONFLICT.
- `--input <path>` backs `--in-place` when the input does not come from
  the positional argument; disagreeing with the positional is
  ARGUMENT_CONFLICT.
- Missing `--output`/`--stdout`/`--source`/`--in-place` is OUTPUT_REQUIRED
  and creates zero files. Every file target is existence-checked before
  the first byte lands anywhere, so an OUTPUT_EXISTS refusal writes
  nothing.
- Minecraft profiles (`minecraft:item`, `minecraft:block`) export PNG
  only (§34): an explicit `--output` path with any other extension is
  UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT.

### Target identity, duplicates, and write timing (release safety)

- **One identity, one write.** Every file target (across `--output`,
  `--source`, and `--in-place`) is compared by its full normalized
  absolute path folded with Unicode NFC plus en-US case folding. Two
  targets with the same folded identity — the same path, a
  relative/absolute/dot-segment alias, a symlink alias, a case-only
  difference (`case.png` vs `CASE.png`), or NFC/NFD spellings of the same
  name — are the same target. The folding is deliberately conservative:
  it refuses confusingly equivalent names even on a case-sensitive
  filesystem, so safety never depends on detecting the volume's actual
  case or normalization sensitivity (macOS defaults are insensitive for
  both).
- **Alias and duplicate refusals.** A file target that aliases the input
  without an explicit `--in-place` is ARGUMENT_CONFLICT (exit 2); so is
  any pair of file targets sharing one identity, including a PNG target
  and an `.mcpx` target on the same path. Both checks run before the
  first byte lands anywhere, and `--force` never authorizes them — only
  `--in-place` authorizes rewriting the input.
- **stdout timing.** When `--stdout` is combined with file targets, the
  full file-target preflight (alias, duplicate, existence, parents) runs
  before any stdout artifact byte. A conflicting file target therefore
  keeps stdout at zero bytes.
- **Per-file atomic, not all-or-nothing.** Refusals detected in union
  preflight (OUTPUT_EXISTS, missing parents without `--mkdir`,
  alias/duplicate) write nothing. Once writes start, each file commits
  atomically (same-directory temp plus rename) on its own: if a later
  target fails, earlier commits stay, and the thrown error reports them
  in `details.completed` (paths in commit order) with the failing path
  in `details.failedTarget`. The error code stays the original cause
  (usually FILESYSTEM_ERROR); the batch is never claimed to be
  transactional.
- **Temp files.** Each write stages a same-directory temp created
  exclusively (O_EXCL): a taken name is never truncated, the writer
  retries with a fresh name, and cleanup only ever removes temps this
  call created — a collided name owned by someone else is left alone.
  Temp names carry pid, a counter, and a cryptographic suffix, never a
  fixed counter alone.
- **TOCTOU limit.** The preflight/write gap is best-effort against
  concurrent writers to one target: two writers may both pass preflight
  and the atomic rename decides (last-wins, always a whole file). The
  write phase re-checks existence per file, but a race resolved after
  stdout bytes went out cannot be recalled.

## Batch operations (`--operations`)

Pixel/rect/line/fill manipulation travels through `--operations <path>`
on all three write commands, not through separate commands. The JSON body
is the §29/§103 Pixel Spec: a bare array or an `{"operations": [...]}`.
envelope; `id` is optional and unique when present; an empty array is a
valid no-op. Use `--operations -` to read the body from stdin (stdin is
consumed as bytes, never staged in a temp file). `build --stdin` together
with `--operations -` is ARGUMENT_CONFLICT: one stdin stream cannot feed
both.

Supported `type` values mirror the typed core vocabulary: `setPixel`,
`clearPixel`, `drawLine`, `drawRect`, `fillRect`, `floodFill`.

- `color`: `transparent`, `#RRGGBB` (opaque), or `#RRGGBBAA`,
  case-insensitive. Anything else is INVALID_ARGUMENT at
  `operations[i].color`.
- Coordinates (`x`/`y`, `from`/`to` pairs, `rect` objects) must be
  integers; `from`/`to` are `[x, y]` pairs for `drawLine`, `rect` is
  `{x, y, width, height}` with width/height at least 1 for
  `drawRect`/`fillRect`. Violations are INVALID_ARGUMENT with the field
  path (`operations[i].x`, `operations[i].from`, `operations[i].rect`,
  ...). Out-of-canvas values pass this seam and fail in the core as
  OUT_OF_BOUNDS with `operationIndex`/`operationId` in details.
- `layerId` may be omitted only when the canvas has exactly one layer
  (always true for `import`/`render`); otherwise the omission is
  INVALID_ARGUMENT at `operations[i].layerId`.
- Unknown `type` values are INVALID_ARGUMENT at `operations[i].type`;
  every failure carries its field path in `details.path` so agents never
  parse human text.
- The batch runs atomically: the first failure rolls the canvas back and
  the envelope reports the original error code with
  `{applied: 0, rolledBack: true}` as `result` (§103).

## Authoring text inputs

- ASCII Grid: extension `.grid`; `[grid]` compact vs `[grid tokens]`
  tokenized per §96.8. Example input: `sword.grid`. A `.grid` file holds
  exactly `[palette]` then `[grid]`/`[grid tokens]`; dimensions come from
  the rows and pixels land on a single layer named `base`. Regions,
  metadata, and multi-layer canvases stay in `.mcpx` with `build`.
- Pixel Spec: the batch-operations JSON body (§29/§103, `id` optional,
  unique when present). It has **no** standalone file extension and MUST NOT
  be called `.pixel`; it travels via `--operations <path>` (or `-` for
  stdin).
- `.pixel` MUST NOT appear anywhere as an extension.

## Success envelope for write commands

```json
{
  "success": true,
  "result": {
    "command": "build",
    "profile": "generic",
    "output": "sword.png",
    "applied": 1,
    "operations": [{ "index": 0, "id": "tip", "status": "applied" }],
    "warnings": []
  }
}
```

`output`/`source` carry the written file paths, `stdout: true` marks the
stdout artifact, `warnings` surfaces PNG normalization notes and the
`MCPX_LARGE_CANVAS` practical-size notice. Batch failures attach
`{applied: 0, rolledBack: true}` as `result` on the error envelope.

## Version flags (analyze / validate only)

```text
--minecraft-version <version>      Target Minecraft version (V0.1: 26.3 only)
--resource-pack-version <version>  Target packFormat as a positive integer (V0.1: 75)
```

- `--minecraft-version 26.3` resolves to packFormat 75 with the §95
  display echo `resource-pack 97.1` (Resource Pack Format 97.1 ↔ Java
  Edition 26.3, source `Minecraft Wiki Template:Resource pack format`).
  The integer 75 is the engine's sole version group (the §95
  `{ fact, since: { packFormat }, value }` example); finer per-version
  splits arrive with the full version-fact layer.
- `--resource-pack-version` takes a positive integer packFormat only
  (validated by the existing `validatePackFormat` check). Dotted
  versions such as `97.1` are INVALID_ARGUMENT in V0.1: target 26.3 via
  `--minecraft-version` instead.
- At most one of the two flags per invocation; both together,
  an unknown `--minecraft-version`, a non-integer
  `--resource-pack-version`, or a repeated flag is INVALID_ARGUMENT
  (exit 2 via the existing registry, no local table).
- The JSON result carries `version: { minecraftVersion?,
  resourcePackVersion?, packFormat? }` (default `{}`) plus a human
  `target:` summary line. Existing report fields are unchanged, and
  `PENDING_SOURCE_PNG_ONLY` stays warning-only under either flag.

## V0.1 gaps and where they go

- Layer/region/pixel manipulation: no separate `compose` command; use
  `--operations` batch on `import`/`render`/`build` (frozen).
- Cross-runtime behavior: Bun runs the full suite (including spawn);
  the `*.node.ts` entries run the pure cases only, so both runtimes
  stay green without subprocesses on the Node side.
- Full version-fact layer (dotted `97.x` handling, multi-group
  `since` splits, atlas/pack validators, `pack.mcmeta`
  auto-detection): deferred to the V0.5 track (`validate-pack`,
  `v05-t05` owns the profiles-engine fact work).

## Framework helpers (frozen, t07)

```text
src/cli/envelope.ts      successEnvelope / errorEnvelope (§60/§103 shapes)
src/cli/channels.ts      routeStreams / emitLog / emitEnvelope / emitArtifact (§98.1)
src/cli/output-guard.ts  resolveOutputTarget (OUTPUT_REQUIRED, ARGUMENT_CONFLICT)
src/cli/filesystem.ts    atomicWriteFile (OUTPUT_EXISTS, --mkdir, temp+rename)
src/cli/exit.ts          exitCodeForMcAssetError (delegates to resolveExitCode)
src/cli/profiles.ts      SUPPORTED_PROFILES / parseProfile (V0.1 frozen set)
src/cli/program.ts       buildProgram / runStub (commander skeleton + mount probe)
src/cli/index.ts         entry, commander error mapping (invalid usage -> exit 2)
```

`import`, `render`, and `build` reuse these helpers unchanged.
