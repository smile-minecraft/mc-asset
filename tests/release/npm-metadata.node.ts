import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "publish.yml");

interface PackageJson {
	name: string;
	version: string;
	mcpName?: string;
	repository?: { type?: string; url?: string } | string;
}

interface ServerJson {
	name: string;
	version: string;
	repository?: { url?: string };
	packages?: Array<{
		identifier?: string;
		version?: string;
		packageArguments?: Array<{ type?: string; value?: string }>;
	}>;
}

function readJson<T>(rel: string): T {
	return JSON.parse(readFileSync(join(ROOT, rel), "utf-8")) as T;
}

// Full-line YAML comments can echo contract strings (e.g. the header
// comment names "id-token: write"); strip them so the contains-checks
// below only pass on real workflow lines.
function stripYamlComments(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

describe("npm metadata", () => {
	it("server.json name matches package.json mcpName", () => {
		const pkg = readJson<PackageJson>("package.json");
		const server = readJson<ServerJson>("server.json");
		assert.equal(
			typeof pkg.mcpName,
			"string",
			"package.json mcpName is missing",
		);
		assert.equal(server.name, pkg.mcpName);
	});

	it("server.json package identifier matches package.json name", () => {
		const pkg = readJson<PackageJson>("package.json");
		const server = readJson<ServerJson>("server.json");
		assert.equal(server.packages?.[0]?.identifier, pkg.name);
	});

	it("server.json version and package version match package.json version", () => {
		const pkg = readJson<PackageJson>("package.json");
		const server = readJson<ServerJson>("server.json");
		assert.equal(server.version, pkg.version);
		assert.equal(server.packages?.[0]?.version, pkg.version);
	});

	it("repository url points at this repo", () => {
		const pkg = readJson<PackageJson>("package.json");
		const server = readJson<ServerJson>("server.json");
		const repoUrl =
			typeof pkg.repository === "string"
				? pkg.repository
				: (pkg.repository?.url ?? "");
		assert.ok(
			repoUrl.includes("github.com/smile-minecraft/mc-asset"),
			"package.json repository must point at this repo",
		);
		assert.ok(
			(server.repository?.url ?? "").includes(
				"github.com/smile-minecraft/mc-asset",
			),
			"server.json repository must point at this repo",
		);
	});

	it("server.json package launches the MCP server via the mcp command", () => {
		const server = readJson<ServerJson>("server.json");
		const args = server.packages?.[0]?.packageArguments ?? [];
		assert.ok(
			args.some((arg) => arg.value === "mcp"),
			"server.json packageArguments must include the mcp command",
		);
	});

	it("publish workflow exists", () => {
		assert.ok(existsSync(WORKFLOW), ".github/workflows/publish.yml is missing");
	});

	it("publish workflow static contract", () => {
		const workflow = readFileSync(WORKFLOW, "utf-8");
		const code = stripYamlComments(workflow);
		for (const snippet of [
			"id-token: write",
			"node-version: 24",
			"workflow_dispatch",
			"tags:",
			"refs/tags/",
			"refs/heads/main",
			"npm view",
			"github-oidc",
			"mcp-publisher",
			"v1.8.1",
			"sha256",
			"wait for npm metadata propagation",
		]) {
			assert.ok(
				code.includes(snippet),
				`publish workflow must contain: ${snippet}`,
			);
		}
		for (const snippet of ["NODE_AUTH_TOKEN", "secrets."]) {
			assert.ok(
				!workflow.includes(snippet),
				`publish workflow must not contain: ${snippet}`,
			);
		}
	});
});
