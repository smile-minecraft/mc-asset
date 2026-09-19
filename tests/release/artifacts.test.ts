import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "release-artifacts.mjs");

interface PackageJson {
	version: string;
	scripts?: Record<string, string>;
}

interface ManifestEntry {
	path: string;
	sha256: string;
	size: number;
}

interface Manifest {
	version: string;
	tag: string;
	files: ManifestEntry[];
}

function readPackage(): PackageJson {
	return JSON.parse(
		readFileSync(join(ROOT, "package.json"), "utf-8"),
	) as PackageJson;
}

function sha256File(path: string): string {
	const data = readFileSync(path);
	return createHash("sha256").update(data).digest("hex");
}

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "mc-asset-rel-"));
}

function removeDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function runRelease(args: string[]) {
	const result = spawnSync("node", [SCRIPT, ...args], {
		cwd: ROOT,
		encoding: "utf-8",
	});
	return {
		status: result.status ?? -1,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

function dryRunTo(dir: string, extra: string[] = []) {
	return runRelease(["--dry-run", "--out", dir, ...extra]);
}

function readManifest(
	dir: string,
	version: string,
): {
	stageDir: string;
	manifest: Manifest;
	manifestPath: string;
} {
	const stageDir = join(dir, `mc-asset-${version}`);
	const manifestPath = join(stageDir, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
	return { stageDir, manifest, manifestPath };
}

// Ensure the bundles the release stages actually exist.
const built = spawnSync("bun", ["run", "build"], {
	cwd: ROOT,
	encoding: "utf-8",
});
if ((built.status ?? 1) !== 0) {
	throw new Error("fixture setup failed: `bun run build` did not succeed");
}

describe("release artifacts (deterministic staging)", () => {
	test("version comes from package.json and filenames carry it", () => {
		const pkg = readPackage();
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
		const dir = makeTempDir();
		try {
			const run = dryRunTo(dir);
			expect(run.status).toBe(0);
			const { manifest } = readManifest(dir, pkg.version);
			expect(manifest.version).toBe(pkg.version);
			const names = removeDirAndList(dir);
			expect(names.some((n) => n.includes(pkg.version))).toBe(true);
		} finally {
			removeDir(dir);
		}
	});

	test("manifest stages bundle, launcher, LICENSE and third-party inventory", () => {
		const pkg = readPackage();
		const dir = makeTempDir();
		try {
			expect(dryRunTo(dir).status).toBe(0);
			const { stageDir, manifest } = readManifest(dir, pkg.version);
			const paths = manifest.files.map((f) => f.path).sort();
			for (const expected of [
				"LICENSE",
				"THIRD_PARTY_NOTICES.md",
				"bin/mc-asset.js",
				"dist/index.js",
				"dist/mc-asset.js",
			]) {
				expect(paths).toContain(expected);
				expect(existsSync(join(stageDir, expected))).toBe(true);
			}
			const notices = readFileSync(
				join(stageDir, "THIRD_PARTY_NOTICES.md"),
				"utf-8",
			);
			for (const token of ["commander", "pngjs", "MIT"]) {
				expect(notices).toContain(token);
			}
		} finally {
			removeDir(dir);
		}
	});

	test("manifest SHA-256 entries recompute", () => {
		const pkg = readPackage();
		const dir = makeTempDir();
		try {
			expect(dryRunTo(dir).status).toBe(0);
			const { stageDir, manifest } = readManifest(dir, pkg.version);
			expect(manifest.files.length).toBeGreaterThan(0);
			for (const entry of manifest.files) {
				const abs = join(stageDir, entry.path);
				expect(existsSync(abs)).toBe(true);
				expect(sha256File(abs)).toBe(entry.sha256);
				expect(readFileSync(abs).length).toBe(entry.size);
			}
		} finally {
			removeDir(dir);
		}
	});

	test("two dry-runs over the same tree produce identical bytes", () => {
		const pkg = readPackage();
		const first = makeTempDir();
		const second = makeTempDir();
		try {
			expect(dryRunTo(first).status).toBe(0);
			expect(dryRunTo(second).status).toBe(0);
			const a = readManifest(first, pkg.version);
			const b = readManifest(second, pkg.version);
			expect(readFileSync(a.manifestPath, "utf-8")).toBe(
				readFileSync(b.manifestPath, "utf-8"),
			);
			const tarName = `mc-asset-${pkg.version}.tar.gz`;
			const tarA = join(first, tarName);
			const tarB = join(second, tarName);
			expect(existsSync(tarA)).toBe(true);
			expect(existsSync(tarB)).toBe(true);
			expect(basename(tarA)).toContain(pkg.version);
			expect(sha256File(tarA)).toBe(sha256File(tarB));
			for (const entry of a.manifest.files) {
				const other = b.manifest.files.find((f) => f.path === entry.path);
				expect(other?.sha256).toBe(entry.sha256);
			}
		} finally {
			removeDir(first);
			removeDir(second);
		}
	});

	test("real mode requires an exact tag; dry-run stays explicit", () => {
		const pkg = readPackage();
		const dir = makeTempDir();
		try {
			const refused = runRelease(["--out", join(dir, "refused")]);
			expect(refused.status).not.toBe(0);
			expect(refused.stderr + refused.stdout).toMatch(/tag|dry-run/i);

			const wrongTag = runRelease([
				"--out",
				join(dir, "wrong"),
				"--tag",
				"v9.9.9",
			]);
			expect(wrongTag.status).not.toBe(0);

			expect(dryRunTo(join(dir, "ok-implicit")).status).toBe(0);
			const explicit = dryRunTo(join(dir, "ok-explicit"), [
				"--tag",
				`v${pkg.version}`,
			]);
			expect(explicit.status).toBe(0);
		} finally {
			removeDir(dir);
		}
	});
});

function removeDirAndList(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else {
				out.push(full);
			}
		}
	};
	walk(dir);
	return out;
}
