# Release playbook (mc-asset)

How to install, upgrade, reinstall, roll back, and publish a version of
`mc-asset` through the public GitHub Release and the Homebrew tap. The
pipeline is live and has carried v0.1.0 and v0.2.0; versions V0.3–V0.6
reuse the same steps, so this page doubles as the repeatable checklist
for future releases.

Facts are split into **verified** (actually executed, with evidence) and
**pending** (not yet done). Do not cite a pending item as done.

Sources of truth:

- Artifact contract and determinism checks: `docs/release-contract.md`
- Formula source and install details: `docs/homebrew.md`,
  `homebrew/Formula/mc-asset.rb`
- Version plans: `mc-asset-v02` … `mc-asset-v06` in the plan registry
  (`.opencode/memory/plans.json`); this page never re-creates their task
  tables.

## Current state: v0.2.0 (published)

Verified during the v0.2.0 release:

- Public source repo: `https://github.com/smile-minecraft/mc-asset`
- GitHub Release `v0.2.0` (published 2026-09-20) with asset
  `https://github.com/smile-minecraft/mc-asset/releases/download/v0.2.0/mc-asset-0.2.0.tar.gz`
  and its `.sha256` companion
- Official tarball SHA-256:
  `3cf7dd7690833cbce866ef717bd2ac2b6b056b7bc2215ba6acd7f2911ad15d81`
  (matches the release `.sha256` companion and the formula)
- The tag release workflow run `35503197797` succeeded
- Public tap: `https://github.com/smile-minecraft/homebrew-tap`,
  formula at `Formula/mc-asset.rb` bumped to v0.2.0, with its own README
- Local macOS Homebrew 7.0.4: `brew reinstall
  smile-minecraft/tap/mc-asset` installed Cellar 0.2.0 (9 files);
  `brew test` chain render → analyze → validate passed (exit 0);
  `mc-asset --version` prints `0.2.0`
- The formula installs the command as `mc-asset` via
  `bin.install_symlink libexec/"bin/mc-asset.js" => "mc-asset"`. An
  earlier draft used `bin.install` on the launcher file, which would
  have produced a `mc-asset.js` command name and broken nothing else —
  the symlink form is the fixed and verified one. Keep this line when
  bumping the formula.

Pending (not done, do not claim otherwise):

- No homebrew/core submission (self-hosted tap only; revisit after a
  few stable releases).
- No MCP live verification yet — that is V0.6 (`v06-t03`), scheduled
  after an OpenCode restart, and it must run against the
  Homebrew-installed binary (see the V0.6 checklist).
- No rollback has ever been executed; the rollback steps below follow
  documented Homebrew behavior but are untested in practice.

## Install

```sh
brew tap smile-minecraft/tap
brew install smile-minecraft/tap/mc-asset
mc-asset --version
```

Runtime needs only Node (`depends_on "node"`). No Bun, no source
checkout. Details and out-of-band hash verification: `docs/homebrew.md`.

## Upgrade

```sh
brew update
brew upgrade smile-minecraft/tap/mc-asset
mc-asset --version
```

An upgrade only takes effect after the tap formula was bumped for the
new version (see the release pipeline below). If `mc-asset --version`
still shows the old version, the tap commit has not landed or `brew
update` has not run.

## Reinstall (same version, clean slate)

```sh
brew reinstall smile-minecraft/tap/mc-asset
```

Verified for v0.2.0 (see Current state).

## Rollback

Two directions, neither of which deletes anything under the user's
control:

**User side — go back to a previous version.** Homebrew keeps no
server-side tap history, so reinstall the older formula from the tap's
git history:

```sh
cd "$(brew --repo smile-minecraft/tap)"
git log --oneline -- Formula/mc-asset.rb
git show <older-sha>:Formula/mc-asset.rb > /tmp/mc-asset-old.rb
brew uninstall mc-asset
brew install /tmp/mc-asset-old.rb
```

If the older tag tarball was removed from the Release page, re-upload
it (or cut a patch release) first — the formula URL must keep
resolving. Status: documented, never executed (pending).

**Maintainer side — withdraw a bad release.** Deleting the GitHub
Release or tag breaks every installed formula pointing at that URL, so
the default is *not* to delete:

1. Fix forward: cut a patch release (`v<version>+patch`) through the
   normal pipeline and bump the tap to it. This is the preferred
   outcome.
2. If the release must disappear anyway, first point the tap formula at
   a good version and commit/push, so no user resolves to the dead
   URL; only then remove the GitHub Release/tag. This is an
   irreversible external action — get explicit owner approval before
   doing it.
3. Never remove files from a user's machine as part of a withdrawal;
   `brew uninstall` is the user's own action.

## Release pipeline: tag → GitHub Release → SHA → formula bump

Performed by the release owner. Steps 1–3 produce the release; steps
4–6 publish it to the tap. Full artifact and determinism rules:
`docs/release-contract.md`.

1. Bump `version` in `package.json` — the single source; nothing else
   carries a copy, and the release script refuses any `--tag` that is
   not exactly `v<version>`.
2. `bun run build`, then stage twice and compare:
   `node scripts/release-artifacts.mjs --dry-run --out /tmp/rel-a` and
   `--out /tmp/rel-b`, `diff -r` the directories, recompute the
   manifest hashes (exact commands in `docs/release-contract.md`).
3. Commit, create tag `v<version>`, push the tag.
   `.github/workflows/release.yml` rebuilds from the tag ref and
   publishes the GitHub Release with the staged directory, the
   `.tar.gz`, and the `.sha256` companion.
4. Download the **published** tarball and compute
   `shasum -a 256 mc-asset-<version>.tar.gz`. Never blind-trust the
   dry-run value; compare against the release `.sha256` companion.
5. Bump the formula in this repo (`homebrew/Formula/mc-asset.rb`):
   `url` → the new `v<version>` tarball URL, `sha256` → the hash from
   step 4. Copy the file to the tap repo at `Formula/mc-asset.rb`,
   commit, push. The tap README's version line, if it names a version,
   goes with the same commit.
6. Verify on a machine: `brew update && brew reinstall
   smile-minecraft/tap/mc-asset`; `mc-asset --version` must print the
   new version; run the test chain render → analyze → validate on a
   real grid file.

Status for v0.2.0: steps 1–6 all executed and verified (Current state).

**Known incident from the v0.2.0 tag.** The first CI run on the `v0.2.0`
tag (`35503197832`) failed: GitHub Actions sets
`GITHUB_REF=refs/tags/v0.2.0` on a tag ref, so the release-staging test
case "real mode without `--tag` must reject" picked up a valid tag from
the environment instead of an unset one. Fixed in commit `f2e0e43` by
isolating the test environment and adding an env-fallback positive case
— test files only, no script changes; neither the Release nor
`release.yml` was affected (release run `35503197797` succeeded).

## Troubleshooting

- **`mc-asset: command not found` after install** — the tap formula
  must install the symlink (`install_symlink … => "mc-asset"`). If a
  hand-edited formula used `bin.install` on `bin/mc-asset.js`, the
  command lands as `mc-asset.js`. Fix the formula, reinstall.
- **Version still old after upgrade** — tap commit not pushed, or
  `brew update` not run. Check `git log` in the tap repo.
- **`sha256 mismatch` during install** — the formula hash and the
  published asset diverge. Re-download the published tarball, recompute
  `shasum -a 256`, and fix the formula; never adjust the asset to match
  the formula.
- **Dead download URL** — the tag tarball was deleted from the Release
  page. Re-upload the asset or cut a patch release (see Rollback,
  maintainer side).
- **`brew test` fails but source build works** — check the formula's
  `install` block kept `bin` and `dist` together (the launcher resolves
  `../dist/mc-asset.js` relatively); see the comment in
  `homebrew/Formula/mc-asset.rb`.

## Upcoming releases: V0.3–V0.6

Every version runs the same core pipeline (Release pipeline above),
plus the deltas below. Plan names and scope come from the plan
registry; the per-version task breakdowns live there, not here.

Core checklist (every version):

- [ ] `package.json` version bumped; tag `v<version>` matches
- [ ] two dry-run stagings byte-identical; manifest hashes recompute
- [ ] tag pushed; GitHub Release published by CI with `.tar.gz` +
      `.sha256`
- [ ] published asset SHA recomputed and formula bumped; tap commit
      pushed
- [ ] installed version verified (`mc-asset --version`) and test chain
      render → analyze → validate passes
- [ ] docs updated where the version changes behavior (README, this
      repo's `docs/`)

Per-version deltas:

- **V0.2 — 轉換、選取、色彩處理與像素化** (`mc-asset-v02`): shipped as
  v0.2.0 — the new CLI surface landed with `docs/cli-surface.md` and
  README examples updated in the same release, and the frozen-surface
  claim reflects the new commands.
- **V0.3 — Tile Engine、程序化生成與 Block 工作流** (`mc-asset-v03`):
  core checklist + docs for the new workflows.
- **V0.4 — 動畫、GUI／Particle Profile 與 mcmeta 驗證** (`mc-asset-v04`):
  core checklist + docs for the new profiles and `.mcmeta` validation.
- **V0.5 — Atlas 感知 Pack 驗證與版本相容層** (`mc-asset-v05`): adds
  `validate-pack` and version-target flags. README's "effective alpha
  needs validate-pack (V0.5)" note and the "no version-target flags"
  gap entry must be rewritten when this ships.
- **V0.6 — MCP Server** (`mc-asset-v06`): core checklist, then the MCP
  verification checklist below. The MCP test is deliberately last and
  uses the installed binary, not the source checkout.

### V0.6 MCP verification checklist

- [ ] All V0.6 code merged and released through the core checklist;
      tap formula bumped to the V0.6 version
- [ ] Verification target is the Homebrew-installed `mc-asset`
      (`mc-asset --version` shows the V0.6 version before starting) —
      per the V0.6 plan, the installed build is the verification
      target, never `bun src/cli/index.ts`
- [ ] Register `mc-asset mcp` in the OpenCode MCP config; record the
      exact config change so it can be reverted
- [ ] Restart OpenCode (MCP servers load at startup; a config change
      without a restart proves nothing)
- [ ] After restart, exercise all seven MCP tools end to end and keep
      the real tool outputs as evidence
- [ ] If the package is upgraded during verification, reinstall and
      restart OpenCode again so the new version is loaded
- [ ] Schedule the whole block last: the restart interrupts the user's
      environment
