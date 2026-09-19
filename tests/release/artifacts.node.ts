import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(ROOT, "scripts", "release-artifacts.mjs");
const WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");
const CONTRACT = join(ROOT, "docs", "release-contract.md");

interface PackageJson {
	version: string;
	scripts?: Record<string, string>;
}

function readPackage(): PackageJson {
	return JSON.parse(
		readFileSync(join(ROOT, "package.json"), "utf-8"),
	) as PackageJson;
}

describe("release artifacts (static contract, no build required)", () => {
	it("package.json exposes a release script without moving the version", () => {
		const pkg = readPackage();
		assert.ok(
			typeof pkg.version === "string" && pkg.version.length > 0,
			"package.json version must stay the single source",
		);
		assert.ok(
			typeof pkg.scripts?.release === "string" &&
				pkg.scripts.release.includes("release-artifacts.mjs"),
			"package.json scripts.release must run scripts/release-artifacts.mjs",
		);
		assert.ok(existsSync(SCRIPT), "scripts/release-artifacts.mjs is missing");
	});

	it("release script stays on Node builtins and handles tag/ref explicitly", () => {
		const text = readFileSync(SCRIPT, "utf-8");
		assert.ok(
			text.includes("--dry-run"),
			"release script must document a --dry-run mode",
		);
		assert.ok(
			text.includes("GITHUB_REF"),
			"release script must resolve the tag from --tag or GITHUB_REF",
		);
		assert.ok(
			text.includes("sha256") || text.includes("createHash"),
			"release script must hash staged files with SHA-256",
		);
		assert.match(
			text,
			/from\s+["']node:/,
			"release script must use node: builtins",
		);
		assert.ok(
			!text.includes("secrets.") &&
				!text.includes("AKIA") &&
				!text.includes("BEGIN PRIVATE KEY"),
			"release script must not embed secrets",
		);
	});

	it("tag workflow is version-controlled and pins its source to the tag", () => {
		assert.ok(existsSync(WORKFLOW), ".github/workflows/release.yml is missing");
		const workflow = readFileSync(WORKFLOW, "utf-8");
		assert.ok(
			workflow.includes("v*") && workflow.includes("tags"),
			"release workflow must trigger on version tags",
		);
		assert.ok(
			workflow.includes("github.ref"),
			"release workflow must check out the tag ref, not a moving branch",
		);
		assert.ok(
			!workflow.includes("branches:") || workflow.includes("tags"),
			"release workflow must not build from a moving branch",
		);
		assert.ok(
			workflow.includes("release-artifacts.mjs"),
			"release workflow must run the versioned release script",
		);
		assert.ok(
			workflow.includes("frozen-lockfile"),
			"release workflow must install locked dependencies",
		);
		assert.ok(
			!workflow.includes("secrets.") ||
				workflow.includes("GITHUB_TOKEN") === false,
			"release workflow must not hardcode secrets",
		);
		for (const match of workflow.matchAll(/uses:\s*(\S+)/g)) {
			assert.ok(
				match[1].includes("@v") || match[1].includes("@sha"),
				`third-party action must be pinned to a major version: ${match[1]}`,
			);
			assert.ok(
				!match[1].includes("@main") &&
					!match[1].includes("@latest") &&
					!match[1].includes("@master"),
				`action must not track a moving ref: ${match[1]}`,
			);
		}
	});

	it("release contract names the deterministic directory product", () => {
		assert.ok(existsSync(CONTRACT), "docs/release-contract.md is missing");
		const doc = readFileSync(CONTRACT, "utf-8");
		for (const token of [
			"manifest.json",
			"SHA-256",
			"THIRD_PARTY_NOTICES",
			"v",
			"dry-run",
			"frozen",
		]) {
			assert.ok(doc.includes(token), `release contract must mention ${token}`);
		}
		assert.ok(
			doc.includes("rel-t06") || doc.includes("Homebrew"),
			"release contract must leave publishing strategy to the rel-t06 decision",
		);
	});

	it("release outputs stay out of version control", () => {
		const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf-8");
		assert.ok(
			gitignore.split("\n").some((line) => line.trim() === "dist/"),
			".gitignore must keep dist/ (and release staging) out of version control",
		);
	});
});
