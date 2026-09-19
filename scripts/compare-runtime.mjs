#!/usr/bin/env node
// Cross-runtime equivalence harness (Bun source CLI vs Node bundle).
// Pure Node: only node: builtins. Compares fixed-fixture outputs by bytes:
//   - render PNG bytes + render .mcpx text bytes (tiny.grid)
//   - build PNG bytes + build .mcpx text bytes (sword.mcpx)
//   - analyze JSON canonical bytes (stable key order, stdout envelope only)
// Any difference exits non-zero so CI fails. stderr, timing, and absolute
// paths never enter the comparison. Temp dirs are always cleaned up.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "dist", "mc-asset.js");
const SOURCE_ENTRY = join(ROOT, "src", "cli", "index.ts");
const GRID_FIXTURE = join(ROOT, "tests", "cli", "fixtures", "tiny.grid");
const MCPX_FIXTURE = join(ROOT, "tests", "cli", "fixtures", "sword.mcpx");

/** Stable serialization: object keys sorted recursively, arrays in order. */
export function canonicalize(value) {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function sha256Hex(data) {
	return createHash("sha256").update(data).digest("hex");
}

export function buffersEqual(a, b) {
	if (a.length !== b.length) {
		return false;
	}
	return Buffer.from(a).equals(Buffer.from(b));
}

function fail(message) {
	process.stderr.write(`compare-runtime: ${message}\n`);
	process.exit(1);
}

function runBun(args, label) {
	const result = spawnSync("bun", [SOURCE_ENTRY, ...args], {
		cwd: ROOT,
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
	});
	if ((result.status ?? 1) !== 0) {
		fail(
			`bun source CLI failed on ${label} (exit ${result.status ?? "?"}):\n${String(result.stderr ?? "")}`,
		);
	}
	return result;
}

function runNode(args, label) {
	const result = spawnSync("node", [BUNDLE, ...args], {
		cwd: ROOT,
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
	});
	if ((result.status ?? 1) !== 0) {
		fail(
			`node bundle failed on ${label} (exit ${result.status ?? "?"}):\n${String(result.stderr ?? "")}`,
		);
	}
	return result;
}

function readBytes(path, label, runtime) {
	try {
		return readFileSync(path);
	} catch {
		fail(`${runtime} did not produce ${label} at ${path}`);
	}
	throw new Error("unreachable");
}

function compareFile(label, bunPath, nodePath) {
	const bunBytes = readBytes(bunPath, label, "bun");
	const nodeBytes = readBytes(nodePath, label, "node");
	if (!buffersEqual(bunBytes, nodeBytes)) {
		fail(
			`${label} differs: bun sha256=${sha256Hex(bunBytes)} (${bunBytes.length} bytes) vs node sha256=${sha256Hex(nodeBytes)} (${nodeBytes.length} bytes)`,
		);
	}
	process.stdout.write(
		`ok ${label} sha256=${sha256Hex(bunBytes)} bytes=${bunBytes.length}\n`,
	);
	return bunBytes;
}

function main() {
	if (!existsSync(BUNDLE)) {
		fail(`bundle missing at ${BUNDLE}; run "bun run build" first`);
	}
	if (!existsSync(GRID_FIXTURE) || !existsSync(MCPX_FIXTURE)) {
		fail("fixed fixtures missing under tests/cli/fixtures");
	}
	const workdir = mkdtempSync(join(tmpdir(), "mc-asset-compare-"));
	const bunDir = join(workdir, "bun");
	const nodeDir = join(workdir, "node");
	try {
		mkdirSync(bunDir, { recursive: true });
		mkdirSync(nodeDir, { recursive: true });
		const renderArgs = (dir) => [
			"render",
			GRID_FIXTURE,
			"--output",
			join(dir, "render.png"),
			"--source",
			join(dir, "render.mcpx"),
		];
		const buildArgs = (dir) => [
			"build",
			MCPX_FIXTURE,
			"--output",
			join(dir, "build.png"),
			"--source",
			join(dir, "build.mcpx"),
		];
		runBun(renderArgs(bunDir), "render");
		runNode(renderArgs(nodeDir), "render");
		runBun(buildArgs(bunDir), "build");
		runNode(buildArgs(nodeDir), "build");

		compareFile("render.png", join(bunDir, "render.png"), join(nodeDir, "render.png"));
		compareFile(
			"render.mcpx",
			join(bunDir, "render.mcpx"),
			join(nodeDir, "render.mcpx"),
		);
		compareFile("build.png", join(bunDir, "build.png"), join(nodeDir, "build.png"));
		compareFile("build.mcpx", join(bunDir, "build.mcpx"), join(nodeDir, "build.mcpx"));

		// Analyze each runtime's own render.png; only the stdout JSON
		// envelope enters the comparison (logs ride on stderr under --json).
		const bunAnalyze = runBun(
			["analyze", join(bunDir, "render.png"), "--json"],
			"analyze",
		);
		const nodeAnalyze = runNode(
			["analyze", join(nodeDir, "render.png"), "--json"],
			"analyze",
		);
		let bunCanon;
		let nodeCanon;
		try {
			bunCanon = canonicalize(JSON.parse(String(bunAnalyze.stdout).trim()));
			nodeCanon = canonicalize(JSON.parse(String(nodeAnalyze.stdout).trim()));
		} catch {
			fail("analyze --json stdout was not a single JSON envelope");
		}
		if (bunCanon !== nodeCanon) {
			fail(
				`analyze.json differs: bun sha256=${sha256Hex(bunCanon)} vs node sha256=${sha256Hex(nodeCanon)}`,
			);
		}
		process.stdout.write(
			`ok analyze.json sha256=${sha256Hex(bunCanon)} bytes=${Buffer.byteLength(bunCanon)}\n`,
		);
		process.stdout.write("compare-runtime: all outputs identical\n");
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
}

const invokedAsScript =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
	main();
}
