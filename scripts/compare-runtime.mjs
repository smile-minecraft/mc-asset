#!/usr/bin/env node
// Cross-runtime equivalence harness (Bun source CLI vs Node bundle).
// Pure Node: only node: builtins. Compares fixed-fixture outputs by bytes:
//   - render PNG bytes + render .mcpx text bytes (tiny.grid)
//   - build PNG bytes + build .mcpx text bytes (sword.mcpx)
//   - analyze JSON canonical bytes (stable key order, stdout envelope only)
//   - V0.2: transform PNG+mcpx (sword.mcpx --flip h)
//   - V0.2: quantize PNG+mcpx (sword.mcpx --colors 2)
//   - quantize palette PNG+mcpx (sword.mcpx --palette iron) and
//     quantize colors+keep PNG+mcpx (sword.mcpx --colors 2
//     --keep-color 0,255,0,255)
//   - V0.2: pixelize PNG bytes (px-8x8.jpg and px-lossless.webp --size 16)
//   - V0.2: variant fan-out (sword.mcpx iron,copper: 2 PNG + 2 mcpx)
//   - PNG recolor (px-8x8.png to iron: PNG + mcpx bytes) and PNG
//   - variant fan-out (px-8x8.png iron,copper: 2 PNG + 2 mcpx)
//   - V0.2: analyze JSON canonical bytes (px-8x8.png --json)
//   - V0.3: generate PNG bytes + generate .mcpx text bytes
//   - V0.3: tile JSON canonical bytes (px-8x8.png report mode)
//   - V0.3: preview ascii JSON + palette-map JSON canonical bytes,
//   - V0.3: preview --scale PNG bytes (px-8x8.png --scale 2)
//   - V0.4: animate pack sheet PNG bytes (v04-anim-frames, vertical)
//   - V0.4: animate unpack per-frame .mcpx text bytes (from each
//   - V0.4: runtime's own packed sheet, frame-size 4x4)
//   - V0.4: validate --mcmeta JSON canonical bytes (own sheet + mcmeta)
//   - V0.4: preview --nine-slice JSON canonical bytes (px-8x8.png + mcmeta)
//   - V0.5: validate-pack clean + defect JSON canonical bytes (fixed pack
//   - V0.5: fixtures, explicit --resource-pack-version 75, result.path
//   - V0.5: normalized to a fixed token so temp dirs never leak in)
//   - optimize: every docs/assets PNG (--output-dir), the fixture PNG and each
//   - runtime's own render.png (auto, forced rgba, ancillary strip), plus the
//   - dry-run report in canonical JSON
//   - directory optimize: docs/assets recursively (--input-dir), relative paths
//   - preserved, source files untouched, plus dry-run in canonical JSON
//   - model: create, apply and export text outputs, and the inspect and
//   - validate reports in canonical JSON (fixed spec, operations, binding),
//   - plus the model preview PNG bytes (fixed cube render with its texture,
//   - source model and texture untouched)
// Any difference exits non-zero so CI fails. stderr, timing, and absolute
// paths never enter the comparison. Temp dirs are always cleaned up.
import { PNG } from "pngjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
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
const V04_FRAMES_FIXTURE = join(
	ROOT,
	"tests",
	"cli",
	"fixtures",
	"v04-anim-frames",
);
const V04_SHEET_MCMETA_FIXTURE = join(
	ROOT,
	"tests",
	"cli",
	"fixtures",
	"v04-sheet.mcmeta",
);
const V04_NINE_SLICE_MCMETA_FIXTURE = join(
	ROOT,
	"tests",
	"cli",
	"fixtures",
	"v04-nine-slice.mcmeta",
);
const V05_CLEAN_PACK_FIXTURE = join(
	ROOT,
	"tests",
	"cli",
	"fixtures",
	"v05-clean-pack",
);
const V05_DEFECT_PACK_FIXTURE = join(
	ROOT,
	"tests",
	"cli",
	"fixtures",
	"v05-defect-pack",
);

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

function runBun(args, label, okStatuses = [0]) {
	const result = spawnSync("bun", [SOURCE_ENTRY, ...args], {
		cwd: ROOT,
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (!okStatuses.includes(result.status ?? 1)) {
		fail(
			`bun source CLI failed on ${label} (exit ${result.status ?? "?"}):\n${String(result.stderr ?? "")}`,
		);
	}
	return result;
}

function runNode(args, label, okStatuses = [0]) {
	const result = spawnSync("node", [BUNDLE, ...args], {
		cwd: ROOT,
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (!okStatuses.includes(result.status ?? 1)) {
		fail(
			`node bundle failed on ${label} (exit ${result.status ?? "?"}):\n${String(result.stderr ?? "")}`,
		);
	}
	return result;
}

/** Recursive pack-tree copy: fixtures stay fixed, each runtime scans its own copy. */
function copyDirSync(from, to) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from).sort()) {
		const src = join(from, entry);
		const dst = join(to, entry);
		if (statSync(src).isDirectory()) {
			copyDirSync(src, dst);
		} else {
			copyFileSync(src, dst);
		}
	}
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

function comparePackJson(label, bunStdout, nodeStdout) {
	// validate-pack echoes the scanned root as result.path, which is a
	// different temp dir per runtime by construction. Both sides scan the
	// same fixed fixture tree, so the path folds to one token before the
	// canonical comparison; every finding path is already relative.
	let bunCanon;
	let nodeCanon;
	try {
		const bunJson = JSON.parse(String(bunStdout).trim());
		const nodeJson = JSON.parse(String(nodeStdout).trim());
		for (const doc of [bunJson, nodeJson]) {
			if (
				doc.result !== null &&
				typeof doc.result === "object" &&
				typeof doc.result.path === "string"
			) {
				doc.result.path = "pack";
			}
		}
		bunCanon = canonicalize(bunJson);
		nodeCanon = canonicalize(nodeJson);
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

const DOCS_ASSETS = join(ROOT, "docs", "assets");

/** Every PNG under a directory, in a stable order, as repo-relative paths. */
function listPngs(dir) {
	const found = [];
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...listPngs(full));
		} else if (entry.endsWith(".png")) {
			found.push(full);
		}
	}
	return found;
}

/** optimize outputs by bytes; the dry-run report by canonical JSON. */
function compareOptimize(bunDir, nodeDir) {
	const docs = listPngs(DOCS_ASSETS);
	const names = docs.map((path) => path.slice(path.lastIndexOf("/") + 1));
	if (new Set(names).size !== names.length) {
		fail("docs/assets PNG basenames must be unique for --output-dir");
	}
	const dirArgs = (dir) => [
		"optimize",
		...docs,
		"--output-dir",
		join(dir, "optimize-docs"),
		"--mkdir",
	];
	runBun(dirArgs(bunDir), "optimize-docs");
	runNode(dirArgs(nodeDir), "optimize-docs");
	for (const name of names) {
		compareFile(
			`optimize-docs/${name}`,
			join(bunDir, "optimize-docs", name),
			join(nodeDir, "optimize-docs", name),
		);
	}
	const cases = [
		["optimize-fixture", PX_PNG_FIXTURE, []],
		["optimize-fixture-rgba", PX_PNG_FIXTURE, ["--mode", "rgba"]],
		["optimize-fixture-strip", PX_PNG_FIXTURE, ["--ancillary", "strip"]],
	];
	for (const [label, input, extra] of cases) {
		const args = (dir) => [
			"optimize",
			input,
			...extra,
			"--output",
			join(dir, `${label}.png`),
		];
		runBun(args(bunDir), label);
		runNode(args(nodeDir), label);
		compareFile(`${label}.png`, join(bunDir, `${label}.png`), join(nodeDir, `${label}.png`));
	}
	// Each runtime's own render.png (an unoptimized encodePng result).
	const ownArgs = (dir) => [
		"optimize",
		join(dir, "render.png"),
		"--output",
		join(dir, "optimize-render.png"),
	];
	runBun(ownArgs(bunDir), "optimize-render");
	runNode(ownArgs(nodeDir), "optimize-render");
	compareFile(
		"optimize-render.png",
		join(bunDir, "optimize-render.png"),
		join(nodeDir, "optimize-render.png"),
	);
	const bunDry = runBun(["optimize", PX_PNG_FIXTURE, "--dry-run", "--json"], "optimize-dry-run");
	const nodeDry = runNode(["optimize", PX_PNG_FIXTURE, "--dry-run", "--json"], "optimize-dry-run");
	compareCanonicalJson("optimize-dry-run.json", bunDry.stdout, nodeDry.stdout);

	// Directory mode: recursive optimize with --input-dir, preserving relative paths
	const beforeHashes = new Map();
	for (const doc of docs) {
		beforeHashes.set(doc, sha256Hex(readFileSync(doc)));
	}
	const dirModeArgs = (dir) => [
		"optimize",
		"--input-dir",
		DOCS_ASSETS,
		"--recursive",
		"--output-dir",
		join(dir, "optimize-dir-docs"),
		"--mkdir",
	];
	runBun(dirModeArgs(bunDir), "optimize-dir-docs");
	runNode(dirModeArgs(nodeDir), "optimize-dir-docs");
	const relPaths = docs.map((p) => p.slice(DOCS_ASSETS.length + 1));
	for (const rel of relPaths) {
		compareFile(
			`optimize-dir-docs/${rel}`,
			join(bunDir, "optimize-dir-docs", rel),
			join(nodeDir, "optimize-dir-docs", rel),
		);
	}
	const bunDirDry = runBun(
		["optimize", "--input-dir", DOCS_ASSETS, "--recursive", "--dry-run", "--json"],
		"optimize-dir-dry-run",
	);
	const nodeDirDry = runNode(
		["optimize", "--input-dir", DOCS_ASSETS, "--recursive", "--dry-run", "--json"],
		"optimize-dir-dry-run",
	);
	compareCanonicalJson(
		"optimize-dir-dry-run.json",
		bunDirDry.stdout,
		nodeDirDry.stdout,
	);
	for (const doc of docs) {
		if (sha256Hex(readFileSync(doc)) !== beforeHashes.get(doc)) {
			fail(`source file was modified during directory optimization: ${doc}`);
		}
	}
}

const MODEL_SPEC = {
	textures: { all: "mypack:block/placeholder" },
	elements: [
		{
			from: [0, 0, 0],
			to: [16, 16, 16],
			faces: {
				down: { texture: "#all" },
				up: { texture: "#all" },
				north: { texture: "#all", uv: [0, 0, 16, 16] },
				south: { texture: "#all" },
				west: { texture: "#all" },
				east: { texture: "#all" },
			},
		},
	],
};
const MODEL_OPERATIONS = [
	{ op: "set_texture", name: "all", value: "mypack:block/ruby" },
	{ op: "update_face", element: 0, face: "up", changes: { rotation: 90 } },
];
const MODEL_BINDING = {
	item: { itemId: "mypack:ruby", modelId: "mypack:block/ruby" },
	blockstate: {
		blockId: "mypack:ruby",
		variants: { "": { model: "mypack:block/ruby" } },
	},
};

/** model create, apply and export text by bytes; inspect and validate by canonical JSON; preview PNG by bytes with sources untouched. */
function compareModel(bunDir, nodeDir, workdir) {
	const specPath = join(workdir, "model-spec.json");
	const operationsPath = join(workdir, "model-operations.json");
	const bindingPath = join(workdir, "model-binding.json");
	writeFileSync(specPath, JSON.stringify(MODEL_SPEC));
	writeFileSync(operationsPath, JSON.stringify(MODEL_OPERATIONS));
	writeFileSync(bindingPath, JSON.stringify(MODEL_BINDING));
	const version = ["--resource-pack-version", "75"];
	const modelRel = join("pack", "assets", "mypack", "models", "block", "ruby.json");
	const itemRel = join("pack", "assets", "mypack", "items", "ruby.json");
	const stateRel = join("pack", "assets", "mypack", "blockstates", "ruby.json");
	const steps = (dir) => [
		["model-create", ["model", "create", "--spec", specPath, "--output", join(dir, "model-created.json"), ...version]],
		["model-apply", ["model", "apply", join(dir, "model-created.json"), "--operations", operationsPath, "--output", join(dir, modelRel), "--mkdir", ...version]],
		["model-export", ["model", "export", join(dir, modelRel), "--binding", bindingPath, "--pack", join(dir, "pack"), "--item-output", join(dir, itemRel), "--blockstate-output", join(dir, stateRel), "--mkdir", ...version]],
	];
	const bunSteps = steps(bunDir);
	const nodeSteps = steps(nodeDir);
	bunSteps.forEach(([label, args], index) => {
		runBun(args, label);
		runNode(nodeSteps[index][1], label);
	});
	for (const dir of [bunDir, nodeDir]) {
		const textureDir = join(dir, "pack", "assets", "mypack", "textures", "block");
		mkdirSync(textureDir, { recursive: true });
		copyFileSync(PX_PNG_FIXTURE, join(textureDir, "ruby.png"));
	}
	for (const [label, rel] of [
		["model-created.json", "model-created.json"],
		["model-applied.json", modelRel],
		["model-item.json", itemRel],
		["model-blockstate.json", stateRel],
	]) {
		compareFile(label, join(bunDir, rel), join(nodeDir, rel));
	}
	for (const mode of ["inspect", "validate"]) {
		const args = (dir) => ["model", mode, join(dir, modelRel), "--pack", join(dir, "pack"), ...version, "--json"];
		const bun = runBun(args(bunDir), `model-${mode}`);
		const node = runNode(args(nodeDir), `model-${mode}`);
		const normalize = (stdout, dir) =>
			String(stdout).split(dir).join("<dir>");
		compareCanonicalJson(
			`model-${mode}.json`,
			normalize(bun.stdout, bunDir),
			normalize(node.stdout, nodeDir),
		);
	}

	// Model preview: the fixed cube plus its texture renders to
	// byte-identical PNGs on both runtimes (explicit names, never readdir
	// order). The model file and the texture stay untouched.
	const previewModelText = JSON.stringify({
		textures: { all: "mypack:block/ruby" },
		elements: [
			{
				from: [0, 0, 0],
				to: [16, 16, 16],
				faces: {
					north: { texture: "#all", uv: [0, 0, 16, 16] },
					east: { texture: "#all" },
					up: { texture: "#all" },
				},
			},
		],
	});
	const previewRel = join("pack", "assets", "mypack", "models", "block", "preview.json");
	for (const dir of [bunDir, nodeDir]) {
		writeFileSync(join(dir, previewRel), previewModelText);
	}
	const previewHashBefore = sha256Hex(Buffer.from(previewModelText, "utf8"));
	const textureHashBefore = sha256Hex(readFileSync(PX_PNG_FIXTURE));
	for (const [run, dir] of [[runBun, bunDir], [runNode, nodeDir]]) {
		run(
			[
				"model",
				"preview",
				join(dir, previewRel),
				"--pack",
				join(dir, "pack"),
				...version,
				"--size",
				"64",
				"--output",
				join(dir, "model-preview.png"),
			],
			"model-preview",
		);
	}
	compareFile(
		"model-preview.png",
		join(bunDir, "model-preview.png"),
		join(nodeDir, "model-preview.png"),
	);
	if (
		sha256Hex(readFileSync(join(bunDir, previewRel))) !== previewHashBefore ||
		sha256Hex(readFileSync(join(nodeDir, previewRel))) !== previewHashBefore
	) {
		fail("model preview changed its source model");
	}
	if (
		sha256Hex(readFileSync(join(bunDir, "pack", "assets", "mypack", "textures", "block", "ruby.png"))) !== textureHashBefore ||
		sha256Hex(readFileSync(join(nodeDir, "pack", "assets", "mypack", "textures", "block", "ruby.png"))) !== textureHashBefore
	) {
		fail("model preview changed its source texture");
	}
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
		!existsSync(PX_WEBP_FIXTURE) ||
		!existsSync(join(V04_FRAMES_FIXTURE, "frame_0.mcpx")) ||
		!existsSync(join(V04_FRAMES_FIXTURE, "frame_1.mcpx")) ||
		!existsSync(V04_SHEET_MCMETA_FIXTURE) ||
		!existsSync(V04_NINE_SLICE_MCMETA_FIXTURE) ||
		!existsSync(join(V05_CLEAN_PACK_FIXTURE, "assets")) ||
		!existsSync(join(V05_DEFECT_PACK_FIXTURE, "assets"))
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
		const quantizePaletteArgs = (dir) => [
			"quantize",
			MCPX_FIXTURE,
			"--palette",
			"iron",
			"--output",
			join(dir, "quantize-palette.png"),
			"--source",
			join(dir, "quantize-palette.mcpx"),
		];
		const quantizeKeepArgs = (dir) => [
			"quantize",
			MCPX_FIXTURE,
			"--colors",
			"2",
			"--keep-color",
			"0,255,0,255",
			"--output",
			join(dir, "quantize-keep.png"),
			"--source",
			join(dir, "quantize-keep.mcpx"),
		];
		runBun(quantizePaletteArgs(bunDir), "quantize-palette");
		runNode(quantizePaletteArgs(nodeDir), "quantize-palette");
		runBun(quantizeKeepArgs(bunDir), "quantize-keep");
		runNode(quantizeKeepArgs(nodeDir), "quantize-keep");
		compareFile(
			"quantize-palette.png",
			join(bunDir, "quantize-palette.png"),
			join(nodeDir, "quantize-palette.png"),
		);
		compareFile(
			"quantize-palette.mcpx",
			join(bunDir, "quantize-palette.mcpx"),
			join(nodeDir, "quantize-palette.mcpx"),
		);
		compareFile(
			"quantize-keep.png",
			join(bunDir, "quantize-keep.png"),
			join(nodeDir, "quantize-keep.png"),
		);
		compareFile(
			"quantize-keep.mcpx",
			join(bunDir, "quantize-keep.mcpx"),
			join(nodeDir, "quantize-keep.mcpx"),
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

		// PNG recolor plus PNG variant fan-out: the shared 8x8 fixture maps
		// by integer luminance bands to iron; the two variant materials each
		// start from the pristine PNG, so outputs are compared per file and
		// never depend on directory listing order.
		const pngRecolorArgs = (dir) => [
			"recolor",
			PX_PNG_FIXTURE,
			"--material",
			"iron",
			"--output",
			join(dir, "recolor-png.png"),
			"--source",
			join(dir, "recolor-png.mcpx"),
		];
		runBun(pngRecolorArgs(bunDir), "recolor-png");
		runNode(pngRecolorArgs(nodeDir), "recolor-png");
		compareFile(
			"recolor-png.png",
			join(bunDir, "recolor-png.png"),
			join(nodeDir, "recolor-png.png"),
		);
		compareFile(
			"recolor-png.mcpx",
			join(bunDir, "recolor-png.mcpx"),
			join(nodeDir, "recolor-png.mcpx"),
		);
		const pngVariantArgs = (dir) => [
			"variant",
			PX_PNG_FIXTURE,
			"--materials",
			"iron,copper",
			"--output-dir",
			join(dir, "variant-png"),
			"--mkdir",
		];
		runBun(pngVariantArgs(bunDir), "variant-png");
		runNode(pngVariantArgs(nodeDir), "variant-png");
		for (const name of [
			"px-8x8_iron.png",
			"px-8x8_iron.mcpx",
			"px-8x8_copper.png",
			"px-8x8_copper.mcpx",
		]) {
			compareFile(
				`variant-png/${name}`,
				join(bunDir, "variant-png", name),
				join(nodeDir, "variant-png", name),
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

		// V0.3 generate determinism: one fixed pattern/size/palette/seed
		// gives byte-identical PNG plus re-serialized .mcpx text bytes on
		// both runtimes (integer-only engine, seed-derived sampling).
		const generateArgs = (dir) => [
			"generate",
			"noise",
			"--size",
			"8",
			"--palette",
			"stone",
			"--seed",
			"7",
			"--output",
			join(dir, "generate.png"),
			"--source",
			join(dir, "generate.mcpx"),
		];
		runBun(generateArgs(bunDir), "generate");
		runNode(generateArgs(nodeDir), "generate");
		compareFile(
			"generate.png",
			join(bunDir, "generate.png"),
			join(nodeDir, "generate.png"),
		);
		compareFile(
			"generate.mcpx",
			join(bunDir, "generate.mcpx"),
			join(nodeDir, "generate.mcpx"),
		);

		// V0.3 tile report mode writes no files; only the stdout JSON
		// envelope enters the comparison, in canonical form.
		const bunTile = runBun(["tile", PX_PNG_FIXTURE, "--json"], "tile");
		const nodeTile = runNode(["tile", PX_PNG_FIXTURE, "--json"], "tile");
		compareCanonicalJson("tile.json", bunTile.stdout, nodeTile.stdout);

		// V0.3 preview read-only reports: ascii and palette-map envelopes
		// in canonical form; the --scale PNG by bytes.
		const bunAscii = runBun(
			["preview", PX_PNG_FIXTURE, "--ascii", "--json"],
			"preview-ascii",
		);
		const nodeAscii = runNode(
			["preview", PX_PNG_FIXTURE, "--ascii", "--json"],
			"preview-ascii",
		);
		compareCanonicalJson(
			"preview-ascii.json",
			bunAscii.stdout,
			nodeAscii.stdout,
		);
		const bunMap = runBun(
			["preview", PX_PNG_FIXTURE, "--palette-map", "--json"],
			"preview-palette-map",
		);
		const nodeMap = runNode(
			["preview", PX_PNG_FIXTURE, "--palette-map", "--json"],
			"preview-palette-map",
		);
		compareCanonicalJson(
			"preview-palette-map.json",
			bunMap.stdout,
			nodeMap.stdout,
		);
		const previewScaleArgs = (dir) => [
			"preview",
			PX_PNG_FIXTURE,
			"--scale",
			"2",
			"--output",
			join(dir, "preview-scale.png"),
		];
		runBun(previewScaleArgs(bunDir), "preview-scale");
		runNode(previewScaleArgs(nodeDir), "preview-scale");
		compareFile(
			"preview-scale.png",
			join(bunDir, "preview-scale.png"),
			join(nodeDir, "preview-scale.png"),
		);

		// V0.4 animate pack: the fixed two-frame fixture packs to a
		// byte-identical vertical sheet PNG on both runtimes.
		const packArgs = (dir) => [
			"animate",
			"pack",
			"--frames-dir",
			V04_FRAMES_FIXTURE,
			"--layout",
			"vertical",
			"--output",
			join(dir, "v04-sheet.png"),
		];
		runBun(packArgs(bunDir), "animate-pack");
		runNode(packArgs(nodeDir), "animate-pack");
		compareFile(
			"v04-sheet.png",
			join(bunDir, "v04-sheet.png"),
			join(nodeDir, "v04-sheet.png"),
		);

		// V0.4 animate unpack: each runtime unpacks its own packed sheet
		// (same precedent as analyze on each runtime's own render.png);
		// every per-frame .mcpx text file enters the comparison.
		const unpackArgs = (dir) => [
			"animate",
			"unpack",
			join(dir, "v04-sheet.png"),
			"--layout",
			"vertical",
			"--frame-size",
			"4x4",
			"--output-dir",
			join(dir, "v04-unpacked"),
			"--mkdir",
		];
		runBun(unpackArgs(bunDir), "animate-unpack");
		runNode(unpackArgs(nodeDir), "animate-unpack");
		for (const name of ["frame_0.mcpx", "frame_1.mcpx"]) {
			compareFile(
				`v04-unpacked/${name}`,
				join(bunDir, "v04-unpacked", name),
				join(nodeDir, "v04-unpacked", name),
			);
		}

		for (const [mode, input, options] of [
			["animation", join(bunDir, "v04-sheet.png"), ["--frame-size", "4", "--frametime", "2", "--frames", '[1,{"index":0,"time":3},1]', "--interpolate"]],
			["gui", PX_PNG_FIXTURE, ["--type", "nine_slice", "--border", "2", "--stretch-inner", "--resource-pack-version", "42"]],
		]) {
			const label = `mcmeta-${mode}`;
			const args = (dir) => ["mcmeta", mode, mode === "animation" ? join(dir, "v04-sheet.png") : input, ...options, "--output", join(dir, `${label}.mcmeta`)];
			runBun(args(bunDir), label);
			runNode(args(nodeDir), label);
			compareFile(`${label}.mcmeta`, join(bunDir, `${label}.mcmeta`), join(nodeDir, `${label}.mcmeta`));
		}

		// V0.4 validate --mcmeta: read-only report over each runtime's own
		// sheet; only the stdout JSON envelope enters the comparison, in
		// canonical form. Each side gets the same mcmeta basename so the
		// envelope path field cannot leak the temp dir.
		copyFileSync(V04_SHEET_MCMETA_FIXTURE, join(bunDir, "v04-sheet.mcmeta"));
		copyFileSync(V04_SHEET_MCMETA_FIXTURE, join(nodeDir, "v04-sheet.mcmeta"));
		const bunMcmeta = runBun(
			[
				"validate",
				join(bunDir, "v04-sheet.png"),
				"--mcmeta",
				join(bunDir, "v04-sheet.mcmeta"),
				"--json",
			],
			"validate-mcmeta",
		);
		const nodeMcmeta = runNode(
			[
				"validate",
				join(nodeDir, "v04-sheet.png"),
				"--mcmeta",
				join(nodeDir, "v04-sheet.mcmeta"),
				"--json",
			],
			"validate-mcmeta",
		);
		compareCanonicalJson(
			"validate-mcmeta.json",
			bunMcmeta.stdout,
			nodeMcmeta.stdout,
		);

		// V0.4 preview --nine-slice: read-only report over the shared PNG
		// fixture; only the stdout JSON envelope enters the comparison,
		// in canonical form.
		copyFileSync(
			V04_NINE_SLICE_MCMETA_FIXTURE,
			join(bunDir, "v04-nine-slice.mcmeta"),
		);
		copyFileSync(
			V04_NINE_SLICE_MCMETA_FIXTURE,
			join(nodeDir, "v04-nine-slice.mcmeta"),
		);
		const bunNineSlice = runBun(
			[
				"preview",
				PX_PNG_FIXTURE,
				"--nine-slice",
				"--mcmeta",
				join(bunDir, "v04-nine-slice.mcmeta"),
				"--json",
			],
			"preview-nine-slice",
		);
		const nodeNineSlice = runNode(
			[
				"preview",
				PX_PNG_FIXTURE,
				"--nine-slice",
				"--mcmeta",
				join(nodeDir, "v04-nine-slice.mcmeta"),
				"--json",
			],
			"preview-nine-slice",
		);
		compareCanonicalJson(
			"preview-nine-slice.json",
			bunNineSlice.stdout,
			nodeNineSlice.stdout,
		);

		// V0.5 validate-pack: read-only report over each runtime's own
		// copy of the fixed fixture packs, explicit --resource-pack-version
		// 75 so the target is reproducible without a pack.mcmeta. Only
		// the stdout JSON envelope enters the comparison, in canonical
		// form with result.path folded (see comparePackJson). The clean
		// pack exits 0; the defect pack carries PACK_INVALID_JSON plus
		// PACK_MISSING_TEXTURE and exits 3 on both runtimes.
		copyDirSync(V05_CLEAN_PACK_FIXTURE, join(bunDir, "v05-clean-pack"));
		copyDirSync(V05_CLEAN_PACK_FIXTURE, join(nodeDir, "v05-clean-pack"));
		copyDirSync(V05_DEFECT_PACK_FIXTURE, join(bunDir, "v05-defect-pack"));
		copyDirSync(V05_DEFECT_PACK_FIXTURE, join(nodeDir, "v05-defect-pack"));
		// The unparsable model is written here from a fixed string: an
		// intentionally broken JSON document cannot live in the repo
		// without tripping the formatter, so it never becomes a fixture.
		for (const dir of [bunDir, nodeDir]) {
			writeFileSync(
				join(dir, "v05-defect-pack", "assets", "minecraft", "models", "item", "broken.json"),
				"{ not valid json",
			);
		}
		const packCleanArgs = (dir, name) => [
			"validate-pack",
			join(dir, name),
			"--resource-pack-version",
			"75",
			"--json",
		];
		const bunPackClean = runBun(
			packCleanArgs(bunDir, "v05-clean-pack"),
			"validate-pack-clean",
		);
		const nodePackClean = runNode(
			packCleanArgs(nodeDir, "v05-clean-pack"),
			"validate-pack-clean",
		);
		comparePackJson(
			"validate-pack-clean.json",
			bunPackClean.stdout,
			nodePackClean.stdout,
		);
		const bunPackDefect = runBun(
			packCleanArgs(bunDir, "v05-defect-pack"),
			"validate-pack-defect",
			[3],
		);
		const nodePackDefect = runNode(
			packCleanArgs(nodeDir, "v05-defect-pack"),
			"validate-pack-defect",
			[3],
		);
		comparePackJson(
			"validate-pack-defect.json",
			bunPackDefect.stdout,
			nodePackDefect.stdout,
		);
		const beforePath = join(workdir, "compare-before.png");
		const afterPath = join(workdir, "compare-after.png");
		const beforeBytes = PNG.sync.write({ width: 3, height: 1, gamma: 0, data: Buffer.from([0,0,0,255, 10,20,30,0, 7,8,9,255]) });
		const afterBytes = PNG.sync.write({ width: 3, height: 1, gamma: 0, data: Buffer.from([255,0,0,255, 40,20,30,0, 7,8,9,255]) });
		writeFileSync(beforePath, beforeBytes);
		writeFileSync(afterPath, afterBytes);
		const compareArgs = ["compare", beforePath, afterPath, "--json"];
		const bunReport = runBun(compareArgs, "compare-report");
		const nodeReport = runNode(compareArgs, "compare-report");
		compareCanonicalJson("compare-report.json", bunReport.stdout, nodeReport.stdout);
		const expectedReport = { width: 3, height: 1, totalPixels: 3, rawChangedPixels: 2, visibleChangedPixels: 1, rawBounds: { x: 0, y: 0, width: 2, height: 1 }, visibleBounds: { x: 0, y: 0, width: 1, height: 1 } };
		if (canonicalize(JSON.parse(String(bunReport.stdout)).result) !== canonicalize(expectedReport)) fail("compare report differs from hand-calculated values");
		for (const [run, dir] of [[runBun, bunDir], [runNode, nodeDir]]) {
			run([...compareArgs, "--output", join(dir, "compare-diff.png"), "--scale", "2"], "compare-diff");
		}
		const diffBytes = compareFile("compare-diff.png", join(bunDir, "compare-diff.png"), join(nodeDir, "compare-diff.png"));
		const diff = PNG.sync.read(diffBytes);
		const row = [255,0,255,255, 255,0,255,255, 0,255,255,255, 0,255,255,255, 0,0,0,0, 0,0,0,0];
		if (diff.width !== 6 || diff.height !== 2 || !buffersEqual(diff.data, Buffer.from([...row, ...row]))) fail("compare diagnostic pixels differ from hand-calculated nearest markers");
		if (!buffersEqual(readFileSync(beforePath), beforeBytes) || !buffersEqual(readFileSync(afterPath), afterBytes)) fail("compare changed a source PNG");
		compareOptimize(bunDir, nodeDir, workdir);
		compareModel(bunDir, nodeDir, workdir);
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
