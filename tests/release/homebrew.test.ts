import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const FORMULA = join(ROOT, "homebrew", "Formula", "mc-asset.rb");
const DOC = join(ROOT, "docs", "homebrew.md");
const BUNDLE = join(ROOT, "dist", "mc-asset.js");

function readFormula(): string {
	return readFileSync(FORMULA, "utf-8");
}

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "mc-asset-homebrew-"));
}

function removeDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

describe("homebrew formula (static)", () => {
	test("formula file exists at the tap layout path", () => {
		expect(existsSync(FORMULA)).toBe(true);
	});

	test("formula declares class, public URL, tag and license", () => {
		const text = readFormula();
		expect(text).toContain("class McAsset < Formula");
		expect(text).toContain(
			"https://github.com/smile-minecraft/mc-asset/releases/download/v0.1.0/mc-asset-0.1.0.tar.gz",
		);
		expect(text).toContain("v0.1.0");
		expect(text).toMatch(/sha256\s+"[0-9a-f]{64}"/);
		expect(text).toMatch(/license\s+"MIT"/);
	});

	test("formula pins the published v0.1.0 asset digest, no pending marker", () => {
		const text = readFormula();
		expect(text).toContain(
			"bdc941bce9eff148732398bb767d4b73f05c20a6ff4d6718b82a4317dba98881",
		);
		expect(text).not.toContain("PENDING_TAG_RECHECK");
		expect(text).not.toContain(
			"019a240cedbd50dc4076312eb19dffaca5054111d0ff90a68dcca7741a832dd7",
		);
	});

	test("formula uses a Node runtime dependency, never Bun or checkout", () => {
		const text = readFormula();
		expect(text).toMatch(/depends_on\s+"node"/);
		expect(text).not.toMatch(/depends_on\s+"bun"/i);
		expect(text).not.toMatch(/system\s+["']bun/i);
	});

	test("formula installs the bundle layout without breaking ../dist", () => {
		const text = readFormula();
		expect(text).toContain("libexec.install");
		expect(text).toContain('"bin"');
		expect(text).toContain('"dist"');
		expect(text).toContain("LICENSE");
		expect(text).toContain("THIRD_PARTY_NOTICES");
		expect(text).toMatch(/bin\.write_exec_script|bin\.install_symlink/);
	});

	test("formula test block runs render, analyze and validate", () => {
		const text = readFormula();
		expect(text).toContain("test do");
		expect(text).toContain("render");
		expect(text).toContain("analyze");
		expect(text).toContain("validate");
	});

	test("homebrew doc covers install, upgrade, reinstall, rollback and bump", () => {
		expect(existsSync(DOC)).toBe(true);
		const doc = readFileSync(DOC, "utf-8");
		for (const token of [
			"smile-minecraft/tap/mc-asset",
			"upgrade",
			"reinstall",
			"rollback",
			"sha256",
			"v0.1.0",
			"public",
		]) {
			expect(doc).toContain(token);
		}
	});
});

describe("homebrew install layout simulation (node launcher)", () => {
	test("staged libexec layout keeps bin -> ../dist working", () => {
		const built = spawnSync("bun", ["run", "build"], {
			cwd: ROOT,
			encoding: "utf-8",
		});
		expect(built.status ?? -1).toBe(0);
		const dir = makeTempDir();
		try {
			const staged = spawnSync(
				"node",
				[
					join(ROOT, "scripts", "release-artifacts.mjs"),
					"--dry-run",
					"--out",
					dir,
				],
				{ cwd: ROOT, encoding: "utf-8" },
			);
			expect(staged.status ?? -1).toBe(0);
			const pkg = JSON.parse(
				readFileSync(join(ROOT, "package.json"), "utf-8"),
			) as { version: string };
			const prefix = join(dir, `mc-asset-${pkg.version}`);
			// Simulate `libexec.install "bin", "dist", ...`: directory names stay.
			const libexec = join(dir, "libexec-sim");
			spawnSync("node", [
				"-e",
				`require("node:fs").cpSync(${JSON.stringify(prefix)}, ${JSON.stringify(libexec)}, {recursive:true})`,
			]);
			const launcher = join(libexec, "bin", "mc-asset.js");
			expect(existsSync(launcher)).toBe(true);
			const run = spawnSync("node", [launcher, "--version"], {
				cwd: dir,
				encoding: "utf-8",
			});
			expect(run.status ?? -1).toBe(0);
			expect((run.stdout ?? "").trim()).toBe(pkg.version);
			expect(existsSync(BUNDLE)).toBe(true);
		} finally {
			removeDir(dir);
		}
	});
});
