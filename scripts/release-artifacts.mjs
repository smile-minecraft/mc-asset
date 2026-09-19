#!/usr/bin/env node
// Release staging helper (plain Node, builtins only).
// Contract (see docs/release-contract.md):
//   - Reads the version from package.json (single source).
//   - Stages a deterministic directory: dist/mc-asset.js, dist/index.js,
//     bin/mc-asset.js, LICENSE, THIRD_PARTY_NOTICES.md, plus manifest.json.
//   - Writes a deterministic mc-asset-<version>.tar.gz (sorted ustar
//     entries, mtime 0, uid/gid 0, gzip MTIME 0, pure Node, no system tar)
//     and a companion .sha256 file.
// Modes:
//   - Real mode requires an exact tag: --tag v<version> (or GITHUB_REF /
//     RELEASE_TAG resolving to refs/tags/v<version>). Anything else exits 2.
//   - --dry-run stages without a tag (records tag "dry-run", or the exact
//     tag when --tag is also given).
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const USAGE = `usage: node scripts/release-artifacts.mjs [--out <dir>] [--tag <tag>] [--dry-run]
  --out <dir>  staging output directory (default: dist/release)
  --tag <tag>  release tag, must equal v<package.json version>
               (fallback: $GITHUB_REF refs/tags/<tag>, then $RELEASE_TAG)
  --dry-run    stage without a tag; records tag "dry-run"
               (with --tag, the tag must still match exactly)`;

function fail(message) {
	process.stderr.write(`release-artifacts: ${message}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opts = { out: null, tag: null, dryRun: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--out") {
			opts.out = argv[(i += 1)];
			if (!opts.out) fail("missing value for --out");
		} else if (arg === "--tag") {
			opts.tag = argv[(i += 1)];
			if (!opts.tag) fail("missing value for --tag");
		} else if (arg === "--dry-run") {
			opts.dryRun = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(`${USAGE}\n`);
			process.exit(0);
		} else {
			fail(`unknown argument: ${arg}\n${USAGE}`);
		}
	}
	return opts;
}

function tagFromEnv() {
	const ref = process.env.GITHUB_REF ?? "";
	const refTag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
	return refTag || process.env.RELEASE_TAG || null;
}

function readPackage() {
	const pkg = JSON.parse(
		readFileSync(join(ROOT, "package.json"), "utf-8"),
	);
	if (typeof pkg.version !== "string" || pkg.version.length === 0) {
		fail("package.json version must be a non-empty string");
	}
	return pkg;
}

function sha256Bytes(data) {
	return createHash("sha256").update(data).digest("hex");
}

// CRC-32 (ISO 3309) over bytes, for the deterministic gzip trailer.
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(data) {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i += 1) {
		c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function gzipDeterministic(raw) {
	const deflated = deflateRawSync(raw, { level: 9 });
	const header = Buffer.from([
		0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
	]);
	const trailer = Buffer.alloc(8);
	trailer.writeUInt32LE(crc32(raw), 0);
	trailer.writeUInt32LE(raw.length >>> 0, 4);
	return Buffer.concat([header, deflated, trailer]);
}

function tarField(text, size) {
	const buf = Buffer.alloc(size, 0);
	buf.write(text, 0, Math.min(Buffer.byteLength(text), size), "utf-8");
	return buf;
}

function tarOctal(value, size) {
	const text = value.toString(8).padStart(size - 1, "0");
	const buf = Buffer.alloc(size, 0);
	buf.write(text, 0, size - 1, "ascii");
	return buf;
}

// One 512-byte ustar entry with fixed ownership and timestamp.
function tarEntry(name, data, mode, typeflag) {
	const header = Buffer.alloc(512, 0);
	tarField(name, 100).copy(header, 0);
	tarOctal(mode, 8).copy(header, 100);
	tarOctal(0, 8).copy(header, 108); // uid 0
	tarOctal(0, 8).copy(header, 116); // gid 0
	tarOctal(data.length, 12).copy(header, 124);
	tarOctal(0, 12).copy(header, 136); // mtime 0
	header.write("        ", 148, "ascii"); // checksum placeholder
	header.write(typeflag, 156, "ascii");
	header.write("ustar\0", 257, "ascii");
	header.write("00", 263, "ascii");
	let sum = 0;
	for (let i = 0; i < 512; i += 1) sum += header[i];
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	const body =
		data.length === 0
			? Buffer.alloc(0)
			: Buffer.concat([
					data,
					Buffer.alloc((512 - (data.length % 512)) % 512, 0),
				]);
	return Buffer.concat([header, body]);
}

function buildTar(entries) {
	const sorted = [...entries].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);
	const parts = [];
	const seenDirs = new Set();
	for (const entry of sorted) {
		const dir = dirname(entry.name);
		if (dir !== "." && !seenDirs.has(dir)) {
			seenDirs.add(dir);
			parts.push(tarEntry(`${dir}/`, Buffer.alloc(0), 0o755, "5"));
		}
		parts.push(tarEntry(entry.name, entry.data, entry.mode, "0"));
	}
	parts.push(Buffer.alloc(1024, 0)); // end-of-archive markers
	return Buffer.concat(parts);
}

function licenseOf(depName) {
	const depPkg = JSON.parse(
		readFileSync(
			join(ROOT, "node_modules", depName, "package.json"),
			"utf-8",
		),
	);
	return {
		name: depName,
		version: String(depPkg.version ?? "unknown"),
		license: String(depPkg.license ?? "unknown"),
	};
}

function thirdPartyNotices(version, deps) {
	const rows = deps
		.map((d) => licenseOf(d))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const lines = [
		"# Third-party notices",
		"",
		`Runtime dependencies bundled with mc-asset ${version}.`,
		"Generated deterministically by scripts/release-artifacts.mjs",
		"(no timestamps; sorted by package name).",
		"",
		"| package | version | license |",
		"| --- | --- | --- |",
	];
	for (const row of rows) {
		lines.push(`| ${row.name} | ${row.version} | ${row.license} |`);
	}
	lines.push(
		"",
		"The mc-asset project itself is MIT (see LICENSE).",
		`Runtime dependency licenses: ${rows.map((r) => `${r.name}@${r.version} (${r.license})`).join(", ")}.`,
		"",
	);
	return lines.join("\n");
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const pkg = readPackage();
	const version = pkg.version;
	const expectedTag = `v${version}`;
	const tag = opts.tag ?? tagFromEnv();

	let recordedTag;
	if (opts.dryRun) {
		if (tag !== null && tag !== expectedTag) {
			fail(`--tag mismatch: got ${tag}, want ${expectedTag} (package.json ${version})`);
		}
		recordedTag = tag ?? "dry-run";
	} else {
		if (tag === null) {
			fail(
				"release tag is required in real mode: pass --tag v<version> (or set GITHUB_REF), or use --dry-run for a local staging check",
			);
		}
		if (tag !== expectedTag) {
			fail(`--tag mismatch: got ${tag}, want ${expectedTag} (package.json ${version})`);
		}
		recordedTag = tag;
	}

	const out = opts.out ? resolve(process.cwd(), opts.out) : join(ROOT, "dist", "release");
	if (out === ROOT || out.startsWith(`${ROOT}/`)) {
		for (const guarded of ["src", "scripts", "bin", "tests", "docs", ".github", ".opencode", ".project-doc"]) {
			if (out === join(ROOT, guarded) || out.startsWith(`${join(ROOT, guarded)}/`)) {
				fail(`--out must not target ${guarded}/ (got ${out})`);
			}
		}
	}

	const payloadFiles = [
		"dist/mc-asset.js",
		"dist/index.js",
		"bin/mc-asset.js",
		"LICENSE",
	];
	for (const rel of payloadFiles) {
		if (!existsSync(join(ROOT, rel))) {
			fail(`missing input ${rel}; run \`bun run build\` first`);
		}
	}

	const runtimeDeps = Object.keys(pkg.dependencies ?? {}).sort();
	if (runtimeDeps.length === 0) {
		fail("package.json dependencies is empty; nothing to inventory");
	}

	const stageName = `mc-asset-${version}`;
	const stageDir = join(out, stageName);
	const tarName = `${stageName}.tar.gz`;
	const tarPath = join(out, tarName);

	rmSync(stageDir, { recursive: true, force: true });
	if (existsSync(tarPath)) rmSync(tarPath);
	if (existsSync(`${tarPath}.sha256`)) rmSync(`${tarPath}.sha256`);
	mkdirSync(stageDir, { recursive: true });
	mkdirSync(join(stageDir, "dist"), { recursive: true });
	mkdirSync(join(stageDir, "bin"), { recursive: true });

	for (const rel of payloadFiles) {
		copyFileSync(join(ROOT, rel), join(stageDir, rel));
	}
	writeFileSync(
		join(stageDir, "THIRD_PARTY_NOTICES.md"),
		thirdPartyNotices(version, runtimeDeps),
	);

	const manifestFiles = [
		"dist/mc-asset.js",
		"dist/index.js",
		"bin/mc-asset.js",
		"LICENSE",
		"THIRD_PARTY_NOTICES.md",
	].map((rel) => {
		const data = readFileSync(join(stageDir, rel));
		return { path: rel, sha256: sha256Bytes(data), size: data.length };
	});
	const manifest = {
		name: "mc-asset",
		version,
		tag: recordedTag,
		generator: "scripts/release-artifacts.mjs",
		files: manifestFiles,
	};
	writeFileSync(join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	const entries = manifestFiles.map((f) => ({
		name: `${stageName}/${f.path}`,
		data: readFileSync(join(stageDir, f.path)),
		mode:
			f.path === "dist/mc-asset.js" || f.path === "bin/mc-asset.js" ? 0o755 : 0o644,
	}));
	const tarball = gzipDeterministic(buildTar(entries));
	writeFileSync(tarPath, tarball);
	const tarSha = sha256Bytes(tarball);
	writeFileSync(`${tarPath}.sha256`, `${tarSha}  ${tarName}\n`);

	const stat = statSync(tarPath);
	process.stdout.write(
		[
			`mc-asset release staged: version ${version}, tag ${recordedTag}`,
			`stage: ${stageDir} (${manifestFiles.length} files + manifest.json)`,
			`archive: ${tarPath} (${stat.size} bytes, sha256 ${tarSha})`,
		].join("\n") + "\n",
	);
}

main();
