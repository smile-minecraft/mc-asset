# Homebrew distribution (mc-asset)

Public-source strategy (decided): `mc-asset` ships as a public GitHub
repository (`https://github.com/smile-minecraft/mc-asset`), and the
Homebrew formula downloads the versioned tag tarball from the public
GitHub Release. No private URLs, no tokens, no moving branches.

- Formula source in this repo: `homebrew/Formula/mc-asset.rb`
  (tap layout, so it drops straight into the tap repo).
- Public tap repo: `https://github.com/smile-minecraft/homebrew-tap`
  (formula lands at `Formula/mc-asset.rb` there).
- Release tarball URL pattern (pinned per version, never a branch):
  `https://github.com/smile-minecraft/mc-asset/releases/download/v<version>/mc-asset-<version>.tar.gz`
- Current version: v0.1.0 (released; `mc-asset-0.1.0.tar.gz`
  published on the v0.1.0 GitHub Release; the `sha256` in the formula
  matches the published asset digest
  (`bdc941bce9eff148732398bb767d4b73f05c20a6ff4d6718b82a4317dba98881`,
  cross-checked against the release `.sha256` companion) and is
  re-verified with `shasum -a 256` before every tap update).

## Install

```sh
brew tap smile-minecraft/tap
brew install smile-minecraft/tap/mc-asset
mc-asset --version
```

The bottle needs only Node at runtime (`depends_on "node"` in the
formula). No Bun and no source checkout are required: the tarball
carries `bin/mc-asset.js` (launcher), `dist/mc-asset.js` (Node CLI
bundle), `dist/index.js` (library bundle), `LICENSE`, and
`THIRD_PARTY_NOTICES.md`. `manifest.json` and the `.sha256` companion
ship next to the tarball on the Release page for verification — they
are not inside the tarball.

Verify the download out of band:

```sh
shasum -a 256 mc-asset-0.1.0.tar.gz
# must match the `sha256` line in homebrew/Formula/mc-asset.rb
```

## Upgrade

```sh
brew update
brew upgrade smile-minecraft/tap/mc-asset
mc-asset --version
```

## Reinstall (same version, clean slate)

```sh
brew reinstall smile-minecraft/tap/mc-asset
```

## Rollback (back to a previous version)

Homebrew keeps no server-side history of the tap, so rollback means
re-installing the older formula:

```sh
cd "$(brew --repo smile-minecraft/tap)"
git log --oneline -- Formula/mc-asset.rb
git show <older-sha>:Formula/mc-asset.rb > /tmp/mc-asset-old.rb
brew uninstall mc-asset
brew install /tmp/mc-asset-old.rb
```

If the older tag tarball was removed from the Release page, re-upload
it (or cut a patch release) first — the formula URL must keep
resolving.

## Releasing a new version: tag → Release → formula SHA bump

Performed by the release owner (not by raising a PR from this task):

1. Bump `version` in `package.json` (single source; nothing else
   carries a copy).
2. Run `bun run build`, then stage and hash:
   `node scripts/release-artifacts.mjs --dry-run --out /tmp/rel`
   and compare two runs (see `docs/release-contract.md`).
3. Create tag `v<version>`, push; `.github/workflows/release.yml`
   rebuilds from the tag ref and publishes the GitHub Release with
   the staged directory, the `.tar.gz`, and the `.sha256`.
4. Recompute the tarball hash from the **published** asset
   (`shasum -a 256 mc-asset-<version>.tar.gz` — never blind-trust the
   dry-run value), then bump the formula:
   - `url` → the new `v<version>` tarball URL,
   - `sha256` → the freshly computed hash,
   - copy the updated `homebrew/Formula/mc-asset.rb` to the tap repo
     at `Formula/mc-asset.rb`, commit, push.
5. `brew update && brew install smile-minecraft/tap/mc-asset` and run
   the formula test chain (`render` → `analyze` → `validate`).

## Tap README (copy to smile-minecraft/homebrew-tap on first publish)

```md
# smile-minecraft tap

Homebrew formulae for smile-minecraft tools.

```sh
brew tap smile-minecraft/tap
brew install smile-minecraft/tap/mc-asset
```

- `mc-asset`: pixel-native Minecraft asset toolchain
  (`render` / `build` / `import` / `analyze` / `validate`).
  Upstream: https://github.com/smile-minecraft/mc-asset
```
