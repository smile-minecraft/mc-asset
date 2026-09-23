# AGENTS.md — working in the mc-asset repository

This file is for coding agents that change this repository. It lists the
commands, the invariants that must not break, and the boundaries of a change.
It is not user documentation — the README and `docs/` are for that.

## Toolchain

```sh
bun install --frozen-lockfile   # install dependencies from the lockfile
bun test                        # run the test suite
bun run test:typecheck          # tsc --noEmit
bun run lint                    # biome check .
bun run check:docs              # doc links, anchors, no stray release versions
bun run build                   # node scripts/build.mjs
```

`bun run release` (`node scripts/release-artifacts.mjs`) stages release
artifacts and is only for cutting a version — do not run it as part of a normal
change. Node.js 22 or newer is required (`engines.node` is `>=22`), and `src/`
must run under plain Node as well as under Bun.

## Invariants

- **Determinism.** No unseeded randomness and no floating-point drift.
  `Math.random` and the transcendental `Math.*` functions (`pow`, `sqrt`,
  `sin`, …) are forbidden in `src/` and `tests/` — CI greps for them and fails
  the build. Color blending stays integer-only, and the same inputs plus seed
  must produce byte-identical PNG and `.mcpx` output across Bun and Node.
- **Portability.** `src/` must not use Bun-only APIs: no `Bun.*`, no
  `from "bun"`. CI greps for those too.
- **No heavy image dependencies.** `sharp`, `libvips`, and Skia are forbidden;
  the dependency gate fails the build if any of them appear.
- **Frozen surfaces.** The MCP tool names and input shapes in
  `src/mcp/schema.ts`, and the CLI/MCP contracts in `docs/mcp-surface.md` and
  `docs/cli-surface.md`, are frozen. Changing them is a product decision, not
  a refactor.

## Repository map

- `src/core/` — the pixel engine: canvas, layers, regions, ops, selection,
  transform, quantizer, cleanup, palette, material, recolor, procedural
  generation, tile, frameset, batch, and the error registry.
- `src/io/` — PNG / JPEG / WebP decode and encode.
- `src/mcpx/` — the editable `.mcpx` grammar: tokenizer, parser, serializer,
  validator.
- `src/profiles/` — asset profiles and the Minecraft version facts.
- `src/validate/` — single-asset and whole-pack validation.
- `src/analyze/` — read-only metric reports.
- `src/cli/` — the commander program and one module per command.
- `src/mcp/` — the stdio MCP server: `schema.ts` (frozen inputs),
  `handlers.ts`, `tools.ts`, `server.ts`.
- `tests/` — Bun and Node dual-entry suites plus fixtures.
- `docs/` — the public CLI/MCP surfaces and the MCP guide.
- `scripts/` — build, release staging, cross-runtime comparison, and the docs check.
- `homebrew/` — the Homebrew tap formula source.

## Tests

Shared assertions live in a `*-cases.ts` module. A `*.test.ts` wrapper runs
them under `bun:test`, and a `*.node.ts` wrapper runs the same assertions under
`node:test`. Put new cases in the shared module so both runtimes cover them.
`scripts/compare-runtime.mjs` checks byte parity between the Bun source CLI and
the Node bundle.

## Commits

Use Conventional Commits (`feat`, `fix`, `docs`, `test`, `chore`, …), scoped to
the area you touched, and keep the message style consistent with the existing
history.

## Boundaries

- Do not change the release pipelines in `.github/workflows/` (`ci.yml`,
  `release.yml`, `publish.yml`) or the release staging script without an
  explicit decision — releases follow the documented pipeline. Routine
  maintenance of the `publish.yml` pins (for example the `mcp-publisher`
  version and its checksum) is expected in normal changes.
- Do not add dependencies without a decision that justifies them — the
  dependency gate and the portability rule both apply.
- `.project-doc/` holds local internal notes and is gitignored; treat it as
  context, not as a published artifact.
