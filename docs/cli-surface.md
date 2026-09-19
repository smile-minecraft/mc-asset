# CLI Surface (frozen, V0.1)

Entry point: `bun src/cli/index.ts` (distribution packaging is out of scope for V0.1).

Global behavior follows `project-detail.md` §98 (channels, OUTPUT_EXISTS/--force/--mkdir, atomic write, --force/--in-place mutex) and §99 (exit codes via the `core/errors` registry; no local table). V0.1 implements `--profile` only; there is no `--preset` flag.

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

## Framework helpers for t08

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

`stub` is skeleton-only and proves the mount; t08 replaces it with the real
commands above reusing these helpers unchanged.
