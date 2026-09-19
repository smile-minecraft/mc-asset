# Release contract (mc-asset)

Version source: `package.json` (`version`, currently `0.1.0`). No other
file carries a second copy: `src/index.ts` reads it from `package.json`
at build time, and the release script refuses any `--tag` that is not
exactly `v<version>`.

## Product

`node scripts/release-artifacts.mjs [--tag v<version>] [--out <dir>] [--dry-run]`
stages, under `<out>/mc-asset-<version>/`:

| staged path | source |
|---|---|
| `dist/mc-asset.js` | Node CLI bundle (`bun run build`, mode 0755) |
| `dist/index.js` | library bundle |
| `bin/mc-asset.js` | committed launcher (hands off to the CLI bundle, mode 0755) |
| `LICENSE` | MIT project license, copied verbatim |
| `THIRD_PARTY_NOTICES.md` | generated runtime dependency inventory (sorted, no timestamps) |
| `manifest.json` | `{ name, version, tag, generator, files: [{ path, sha256, size }] }`, keys sorted by path, 2-space JSON plus trailing newline |

Plus, next to the directory:

- `mc-asset-<version>.tar.gz` — deterministic archive of the five payload
  files above (not of `manifest.json`), entry names prefixed
  `mc-asset-<version>/`.
- `mc-asset-<version>.tar.gz.sha256` — `<sha>  <filename>` companion.

Filenames always carry the version (`mc-asset-<version>[.tar.gz[.sha256]]`).

## Determinism

The product contract is the **deterministic directory plus per-file
SHA-256 hashes**: two stagings of the same tag tree produce identical file
bytes and an identical `manifest.json`, verifiable by recomputing
`SHA-256` over each listed file (commands below).

The `.tar.gz` is additionally byte-stable across runs given identical
inputs, because it is built with pure Node (no system `tar`/`gzip`):

- ustar entries sorted by name; explicit `0755` directory entries;
  file modes `0755` for the two executables, `0644` otherwise;
- `mtime 0`, `uid/gid 0`, empty `uname/gname`;
- gzip wrapper with `MTIME 0`, `OS 3`, raw deflate level 9, correct
  CRC-32/ISIZE trailer.

Verify locally:

```sh
bun run build
node scripts/release-artifacts.mjs --dry-run --out /tmp/rel-a
node scripts/release-artifacts.mjs --dry-run --out /tmp/rel-b
diff -r /tmp/rel-a/mc-asset-0.1.0 /tmp/rel-b/mc-asset-0.1.0
node -e "const m=require('/tmp/rel-a/mc-asset-0.1.0/manifest.json');const c=require('node:crypto');const f=require('node:fs');const p=require('node:path');for(const e of m.files){const d=f.readFileSync(p.join('/tmp/rel-a/mc-asset-0.1.0',e.path));if(c.createHash('sha256').update(d).digest('hex')!==e.sha256||d.length!==e.size)throw new Error(e.path)}console.log('manifest recomputes OK')"
sha256sum /tmp/rel-a/mc-asset-0.1.0.tar.gz && cat /tmp/rel-a/mc-asset-0.1.0.tar.gz.sha256
```

Limit: archive byte-stability assumes identical input bytes (same tag
tree, same `bun run build` outputs). The tests pin the directory plus
manifest equality and the tarball hash equality between two dry-runs of
one tree; cross-machine `bun` bundle variance, if any, would surface as
a manifest mismatch, never as a silently different tarball.

## Tag workflow

`.github/workflows/release.yml` triggers only on `push` of tags `v*`.
It checks out exactly `${{ github.ref }}` (the tag ref, never a moving
branch), installs with `bun install --frozen-lockfile` (no unlocked
dependencies), runs `bun run build`, stages with
`node scripts/release-artifacts.mjs --tag "${GITHUB_REF_NAME}" --out dist/release`,
recomputes the manifest hashes, and creates the GitHub Release from that
tag, uploading the staged directory, the `.tar.gz`, and the `.sha256`.
All third-party actions are pinned to a major version (`@vN`); no secrets
or tokens are hardcoded — authentication uses the ephemeral
`${{ github.token }}` only.

## License inventory

`THIRD_PARTY_NOTICES.md` is generated from `package.json`
`dependencies` (runtime only: `commander`, `pngjs`) joined with each
installed package's own `name/version/license` from `node_modules`.
Source and limits: versions come from the locked install
(`bun.lock`, `--frozen-lockfile` in CI); license labels are the
packages' own declarations (both MIT at V0.1). Dev dependencies
(`@biomejs/biome`, `bun-types`, `typescript`) are build-time only and
are not shipped, so they are not listed.

## Not in this task

No tag was created and no GitHub Release was published here. The actual
upload, the public-source versus private-repo decision, and any public
download or Homebrew strategy stay open for the explicit decision point
before rel-t06. This task only versions the automation and the contract.
