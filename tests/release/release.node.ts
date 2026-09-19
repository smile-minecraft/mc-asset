import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

interface PackageJson {
	version: string;
	bin?: Record<string, string>;
}

function readPackage(): PackageJson {
	return JSON.parse(
		readFileSync(join(ROOT, "package.json"), "utf-8"),
	) as PackageJson;
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listFiles(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

describe("release entry (static, no build required)", () => {
	it("package.json exposes a mc-asset bin launcher that is committed", () => {
		const pkg = readPackage();
		assert.ok(pkg.bin?.["mc-asset"], "package.json bin.mc-asset is missing");
		const launcher = join(ROOT, pkg.bin?.["mc-asset"] ?? "");
		assert.ok(existsSync(launcher), `launcher missing: ${launcher}`);
		const mode = statSync(launcher).mode;
		assert.ok((mode & 0o111) !== 0, "launcher must stay executable");
		const text = readFileSync(launcher, "utf-8");
		assert.ok(
			text.startsWith("#!/usr/bin/env node"),
			"launcher must start with a node shebang",
		);
		assert.ok(
			text.includes("dist/mc-asset.js"),
			"launcher must hand off to the built CLI bundle",
		);
	});

	it("VERSION has a single source in package.json", () => {
		const pkg = readPackage();
		assert.ok(
			typeof pkg.version === "string" && pkg.version.length > 0,
			"package.json version must be a non-empty string",
		);
		const indexSource = readFileSync(join(ROOT, "src", "index.ts"), "utf-8");
		assert.ok(
			indexSource.includes("package.json"),
			"src/index.ts must read the version from package.json",
		);
		assert.ok(
			!/VERSION\s*=\s*"/.test(indexSource),
			"src/index.ts must not hardcode a second VERSION copy",
		);
	});

	it("build outputs stay out of version control", () => {
		const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf-8");
		assert.ok(
			gitignore.split("\n").some((line) => line.trim() === "dist/"),
			".gitignore must keep dist/ out of version control",
		);
	});

	it("src stays free of Bun-only APIs so the bundle runs under Node", () => {
		const offenders: string[] = [];
		for (const file of listFiles(join(ROOT, "src"))) {
			if (/Bun\./.test(readFileSync(file, "utf-8"))) {
				offenders.push(file);
			}
		}
		assert.deepStrictEqual(offenders, []);
	});
});
