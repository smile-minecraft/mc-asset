import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

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
	test("server.json name matches package.json mcpName", () => {
		const pkg = readJson<PackageJson>("package.json");
		const server = readJson<ServerJson>("server.json");
		if (typeof pkg.mcpName !== "string") {
			throw new Error("package.json mcpName is missing");
		}
		expect(server.name).toBe(pkg.mcpName);
	});

	test("server.json package identifier matches package.json name", () => {
		const pkg = readJson<PackageJson>("package.json");
		const server = readJson<ServerJson>("server.json");
		expect(server.packages?.[0]?.identifier).toBe(pkg.name);
	});

	test("server.json version and package version match package.json version", () => {
		const pkg = readJson<PackageJson>("package.json");
		const server = readJson<ServerJson>("server.json");
		expect(server.version).toBe(pkg.version);
		expect(server.packages?.[0]?.version).toBe(pkg.version);
	});

	test("repository url points at this repo", () => {
		const pkg = readJson<PackageJson>("package.json");
		const server = readJson<ServerJson>("server.json");
		const repoUrl =
			typeof pkg.repository === "string"
				? pkg.repository
				: (pkg.repository?.url ?? "");
		expect(repoUrl).toContain("github.com/smile-minecraft/mc-asset");
		expect(server.repository?.url ?? "").toContain(
			"github.com/smile-minecraft/mc-asset",
		);
	});

	test("server.json package launches the MCP server via the mcp command", () => {
		const server = readJson<ServerJson>("server.json");
		const args = server.packages?.[0]?.packageArguments ?? [];
		expect(args.some((arg) => arg.value === "mcp")).toBe(true);
	});

	test("publish workflow exists", () => {
		expect(existsSync(join(ROOT, ".github", "workflows", "publish.yml"))).toBe(
			true,
		);
	});

	test("publish workflow static contract", () => {
		const workflow = readFileSync(
			join(ROOT, ".github", "workflows", "publish.yml"),
			"utf-8",
		);
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
			expect(code).toContain(snippet);
		}
		for (const snippet of ["NODE_AUTH_TOKEN", "secrets."]) {
			expect(workflow).not.toContain(snippet);
		}
	});
});
