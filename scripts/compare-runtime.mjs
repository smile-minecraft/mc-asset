#!/usr/bin/env node
// Cross-runtime equivalence harness (Bun source CLI vs Node bundle).
// Pure Node: only node: builtins. Compares fixed-fixture outputs by bytes:
//   - render PNG bytes + render .mcpx text bytes (tiny.grid)
//   - build PNG bytes + build .mcpx text bytes (sword.mcpx)
//   - analyze JSON canonical bytes (stable key order, stdout envelope only)
//   - V0.2: transform PNG+mcpx (sword.mcpx --flip h)
//   - V0.2: quantize PNG+mcpx (sword.mcpx --colors 2)
//   - V0.2: pixelize PNG bytes (px-8x8.jpg and px-lossless.webp --size 16)
//   - V0.2: variant fan-out (sword.mcpx iron,copper: 2 PNG + 2 mcpx)
//   - V0.2: analyze JSON canonical bytes (px-8x8.png --json)
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
const PX_PNG_FIXTURE = join(ROOT, "tests", "cli", "fixtures", "px-8x8.png");
const PX_JPG_FIXTURE = join(ROOT, "tests", "cli", "fixtures", "px-8x8.jpg");
const PX_WEBP_FIXTURE = join(ROOT, "tests", "cli", "fixtures", "px-lossless.webp");

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

function compareCanonicalJson(label, bunStdout, nodeStdout) {
	let bunCanon;
	let nodeCanon;
	try {
		bunCanon = canonicalize(JSON.parse(String(bunStdout).trim()));
		nodeCanon = canonicalize(JSON.parse(String(nodeStdout).trim()));
	} catch {
		fail(`${label} stdout was not a single JSON envelope`);
	}
	if (bunCanon !== nodeCanon) {
		fail(
			`${label} differs: bun sha256=${sha256Hex(bunCanon)} vs node sha256=${sha256Hex(nodeCanon)}`,
		);
	}
	process.stdout.write(
		`ok ${label} sha256=${sha256Hex(bunCanon)} bytes=${Buffer.byteLength(bunCanon)}\n`,
	);
}

function main() {
	if (!existsSync(BUNDLE)) {
		fail(`bundle missing at ${BUNDLE}; run "bun run build" first`);
	}
	if (
		!existsSync(GRID_FIXTURE) ||
		!existsSync(MCPX_FIXTURE) ||
		!existsSync(PX_PNG_FIXTURE) ||
		!existsSync(PX_JPG_FIXTURE) ||
		!existsSync(PX_WEBP_FIXTURE)
	) {
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
		compareCanonicalJson("analyze.json", bunAnalyze.stdout, nodeAnalyze.stdout);

		// V0.2 wave1 commands on the shared mcpx fixture: PNG bytes plus
		// re-serialized .mcpx text bytes enter the comparison.
		const transformArgs = (dir) => [
			"transform",
			MCPX_FIXTURE,
			"--flip",
			"h",
			"--output",
			join(dir, "transform.png"),
			"--source",
			join(dir, "transform.mcpx"),
		];
		const quantizeArgs = (dir) => [
			"quantize",
			MCPX_FIXTURE,
			"--colors",
			"2",
			"--output",
			join(dir, "quantize.png"),
			"--source",
			join(dir, "quantize.mcpx"),
		];
		runBun(transformArgs(bunDir), "transform");
		runNode(transformArgs(nodeDir), "transform");
		runBun(quantizeArgs(bunDir), "quantize");
		runNode(quantizeArgs(nodeDir), "quantize");

		compareFile(
			"transform.png",
			join(bunDir, "transform.png"),
			join(nodeDir, "transform.png"),
		);
		compareFile(
			"transform.mcpx",
			join(bunDir, "transform.mcpx"),
			join(nodeDir, "transform.mcpx"),
		);
		compareFile(
			"quantize.png",
			join(bunDir, "quantize.png"),
			join(nodeDir, "quantize.png"),
		);
		compareFile(
			"quantize.mcpx",
			join(bunDir, "quantize.mcpx"),
			join(nodeDir, "quantize.mcpx"),
		);

		// V0.2 pixelize raster intake: JPEG and lossless WebP each decode
		// to PNG bytes at the requested size.
		const pixelizeArgs = (dir, input, name) => [
			"pixelize",
			input,
			"--size",
			"16",
			"--output",
			join(dir, name),
		];
		runBun(pixelizeArgs(bunDir, PX_JPG_FIXTURE, "pixelize-jpg.png"), "pixelize-jpg");
		runNode(
			pixelizeArgs(nodeDir, PX_JPG_FIXTURE, "pixelize-jpg.png"),
			"pixelize-jpg",
		);
		runBun(
			pixelizeArgs(bunDir, PX_WEBP_FIXTURE, "pixelize-webp.png"),
			"pixelize-webp",
		);
		runNode(
			pixelizeArgs(nodeDir, PX_WEBP_FIXTURE, "pixelize-webp.png"),
			"pixelize-webp",
		);
		compareFile(
			"pixelize-jpg.png",
			join(bunDir, "pixelize-jpg.png"),
			join(nodeDir, "pixelize-jpg.png"),
		);
		compareFile(
			"pixelize-webp.png",
			join(bunDir, "pixelize-webp.png"),
			join(nodeDir, "pixelize-webp.png"),
		);

		// V0.2 variant fan-out: two materials give four named files per
		// runtime, each compared by bytes.
		const variantArgs = (dir) => [
			"variant",
			MCPX_FIXTURE,
			"--materials",
			"iron,copper",
			"--output-dir",
			join(dir, "variant"),
			"--mkdir",
		];
		runBun(variantArgs(bunDir), "variant");
		runNode(variantArgs(nodeDir), "variant");
		for (const name of [
			"sword_iron.png",
			"sword_iron.mcpx",
			"sword_copper.png",
			"sword_copper.mcpx",
		]) {
			compareFile(
				`variant/${name}`,
				join(bunDir, "variant", name),
				join(nodeDir, "variant", name),
			);
		}

		// V0.2 analyze on the shared PNG fixture; again only the stdout
		// JSON envelope enters the comparison, in canonical form.
		const bunPxAnalyze = runBun(
			["analyze", PX_PNG_FIXTURE, "--json"],
			"analyze-px8x8",
		);
		const nodePxAnalyze = runNode(
			["analyze", PX_PNG_FIXTURE, "--json"],
			"analyze-px8x8",
		);
		compareCanonicalJson(
			"analyze-px8x8.json",
			bunPxAnalyze.stdout,
			nodePxAnalyze.stdout,
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
