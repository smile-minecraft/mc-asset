import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMcpxText } from "../../src/cli/artifacts.ts";
import { addLayer, createCanvas, setPixel } from "../../src/core/canvas.ts";
import { decodePng, encodePng, flattenCanvas } from "../../src/io/png.ts";
import { PNG_VECTORS } from "../io/png-cases.ts";

// CLI behavior needs real subprocesses, so it stays in this bun:test entry
// on purpose: there is no node:test mirror for spawn coverage, matching the
// existing commands/analyze/validate suites. Pure cross-module checks live
// in conformance-cases.ts with both bun and node entries.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const FIXTURES = "tests/cli/fixtures";
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");
const TINY_GRID = join(FIXTURES, "tiny.grid");

interface SpawnResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

function stdoutText(result: SpawnResult): string {
	return Buffer.from(result.stdout).toString("utf-8");
}

async function runCli(args: string[], stdin?: string): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin, "utf-8"),
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: new Uint8Array(stdout), stderr };
}

async function listAllFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true });
	return [...entries].sort();
}

async function writeVectorPng(
	dir: string,
	name = "vector.png",
): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64"));
	return path;
}

/** 128x64 canvas with 8192 distinct colors: past the 4096 mcpx ceiling. */
async function writeManyColorPng(dir: string): Promise<string> {
	const path = join(dir, "many.png");
	const canvas = createCanvas(128, 64);
	const layer = addLayer(canvas, { id: "base" });
	let i = 0;
	for (let y = 0; y < 64; y += 1) {
		for (let x = 0; x < 128; x += 1) {
			setPixel(canvas, layer.id, x, y, {
				r: i & 255,
				g: (i >> 8) & 255,
				b: 0,
				a: 255,
			});
			i += 1;
		}
	}
	await writeFile(path, encodePng(canvas));
	return path;
}

/** Fake PNG: valid signature + IHDR claiming 5000x5000, no pixel data. */
async function writeOversizePng(dir: string): Promise<string> {
	const path = join(dir, "huge.png");
	const bytes = new Uint8Array(8 + 4 + 4 + 13 + 4);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const view = new DataView(bytes.buffer);
	view.setUint32(8, 13);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
	view.setUint32(16, 5000);
	view.setUint32(20, 5000);
	bytes.set([8, 6, 0, 0, 0], 24);
	await writeFile(path, bytes);
	return path;
}

async function writeOversizeGrid(dir: string): Promise<string> {
	const path = join(dir, "big.grid");
	await writeFile(
		path,
		`[palette]\n. = transparent\n\n[grid]\n${".".repeat(5000)}\n`,
	);
	return path;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

// V0.4 helpers: runtime-built two-frame set (4x4 solid red + green) over the
// frozen .mcpx pipeline, so every byte on disk comes from this repo. The
// geometry (two 4x4 frames, vertical sheet 4x8) matches the committed
// v04-anim-frames / v04-sheet.mcmeta fixtures used by compare-runtime.
async function writeV04Frames(parent: string, name: string): Promise<string> {
	const dir = join(parent, name);
	await mkdir(dir, { recursive: true });
	const colors = [
		{ r: 255, g: 0, b: 0, a: 255 },
		{ r: 0, g: 255, b: 0, a: 255 },
	];
	for (const [index, color] of colors.entries()) {
		const canvas = createCanvas(4, 4);
		const layer = addLayer(canvas, { id: "base" });
		for (let y = 0; y < 4; y += 1) {
			for (let x = 0; x < 4; x += 1) {
				setPixel(canvas, layer.id, x, y, color);
			}
		}
		await writeFile(
			join(dir, `frame_${index}.mcpx`),
			ensureMcpxText(canvas, () => {}),
		);
	}
	return dir;
}

async function writeV04SheetMcmeta(dir: string): Promise<string> {
	const path = join(dir, "sheet.mcmeta");
	await writeFile(
		path,
		JSON.stringify({
			texture: { mipmap_strategy: "mean", alpha_cutoff_bias: 0 },
			animation: {
				frametime: 2,
				interpolate: false,
				width: 4,
				height: 4,
				frames: [0, 1],
			},
		}),
	);
	return path;
}

async function writeV04NineSliceMcmeta(dir: string): Promise<string> {
	const path = join(dir, "nine-slice.mcmeta");
	await writeFile(
		path,
		JSON.stringify({
			gui: {
				scaling: {
					type: "nine_slice",
					border: { left: 2, top: 2, right: 2, bottom: 2 },
					stretch_inner: false,
				},
			},
		}),
	);
	return path;
}

describe("conformance: import gaps (t08 spawn缺口補齊)", () => {
	test("import --in-place rewrites the input PNG and reports it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const png = await writeVectorPng(dir);
			const before = decodePng(new Uint8Array(await readFile(png)));
			const result = await runCli(["import", png, "--in-place", "--json"]);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: { command: string; output: string; applied: number };
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.command).toBe("import");
			expect(envelope.result.output).toBe(png);
			const after = decodePng(new Uint8Array(await readFile(png)));
			expect(
				Buffer.from(flattenCanvas(after.canvas)).equals(
					Buffer.from(flattenCanvas(before.canvas)),
				),
			).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("import --operations applies a pixel and reports it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const png = await writeVectorPng(dir);
			const out = join(dir, "op.png");
			const ops = JSON.stringify({
				operations: [
					{
						id: "tip",
						type: "setPixel",
						layerId: "base",
						x: 0,
						y: 0,
						color: "#FF0000FF",
					},
				],
			});
			const opsPath = join(dir, "ops.json");
			await writeFile(opsPath, ops);
			const result = await runCli([
				"import",
				png,
				"--operations",
				opsPath,
				"--output",
				out,
				"--json",
			]);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: { applied: number };
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.applied).toBe(1);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			const flat = flattenCanvas(decoded.canvas);
			expect([...flat.slice(0, 4)]).toEqual([255, 0, 0, 255]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("import without any output target is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const png = await writeVectorPng(dir);
			const before = await listAllFiles(dir);
			const result = await runCli(["import", png]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("JPEG bytes are rejected as unsupported with exit 5 and zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const jpg = join(dir, "photo.jpg");
			await writeFile(
				jpg,
				Buffer.from([
					0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
					0x01,
				]),
			);
			const before = await listAllFiles(dir);
			const result = await runCli([
				"import",
				jpg,
				"--output",
				join(dir, "photo.png"),
				"--json",
			]);
			expect(result.code).toBe(5);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				error: { code: string };
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("UNSUPPORTED_IMAGE_FORMAT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("conformance: §98 output guards at the CLI layer", () => {
	test("second --source without --force is OUTPUT_EXISTS and the target is untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const source = join(dir, "sword.mcpx");
			expect(
				(await runCli(["build", SWORD_MCPX, "--source", source])).code,
			).toBe(0);
			const original = await readFile(source);
			const before = await listAllFiles(dir);
			const refused = await runCli([
				"build",
				SWORD_MCPX,
				"--source",
				source,
				"--json",
			]);
			expect(refused.code).toBe(4);
			const envelope = JSON.parse(stdoutText(refused)) as {
				success: boolean;
				error: { code: string };
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("OUTPUT_EXISTS");
			expect(await readFile(source)).toEqual(original);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("OUTPUT_EXISTS refusal writes nothing across --output and --source", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const existing = join(dir, "existing.mcpx");
			await writeFile(existing, await readFile(SWORD_MCPX, "utf-8"));
			const original = await readFile(existing);
			const fresh = join(dir, "fresh.png");
			const refused = await runCli([
				"build",
				SWORD_MCPX,
				"--output",
				fresh,
				"--source",
				existing,
			]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			expect(await fileExists(fresh)).toBe(false);
			expect(await readFile(existing)).toEqual(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("duplicate operation ids fail end to end with index and zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const opsPath = join(dir, "dup.json");
			await writeFile(
				opsPath,
				JSON.stringify({
					operations: [
						{
							id: "dup",
							type: "setPixel",
							layerId: "base",
							x: 0,
							y: 0,
							color: "#FF0000FF",
						},
						{
							id: "dup",
							type: "setPixel",
							layerId: "base",
							x: 1,
							y: 0,
							color: "#00FF00FF",
						},
					],
				}),
			);
			const out = join(dir, "never.png");
			const result = await runCli([
				"build",
				SWORD_MCPX,
				"--operations",
				opsPath,
				"--output",
				out,
				"--json",
			]);
			expect(result.code).toBe(2);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				error: {
					code: string;
					details: { operationIndex: number; operationId: string };
				};
				result: { applied: number; rolledBack: boolean };
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("DUPLICATE_OPERATION_ID");
			expect(envelope.error.details.operationIndex).toBe(1);
			expect(envelope.error.details.operationId).toBe("dup");
			expect(envelope.result).toEqual({ applied: 0, rolledBack: true });
			expect(await fileExists(out)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("failing batch operation reports its index end to end", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const opsPath = join(dir, "oob.json");
			await writeFile(
				opsPath,
				JSON.stringify({
					operations: [
						{
							id: "first",
							type: "setPixel",
							layerId: "base",
							x: 0,
							y: 0,
							color: "#FF0000FF",
						},
						{
							id: "guard",
							type: "setPixel",
							layerId: "base",
							x: 99,
							y: 99,
							color: "#00FF00FF",
						},
					],
				}),
			);
			const out = join(dir, "never.png");
			const result = await runCli([
				"build",
				SWORD_MCPX,
				"--operations",
				opsPath,
				"--output",
				out,
				"--json",
			]);
			expect(result.code).toBe(2);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				error: {
					code: string;
					details: { operationIndex: number; operationId: string };
				};
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("OUT_OF_BOUNDS");
			expect(envelope.error.details.operationIndex).toBe(1);
			expect(envelope.error.details.operationId).toBe("guard");
			expect(await fileExists(out)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("conformance: overflow and §102 limits at the CLI layer", () => {
	test("many-color import --source reports palette overflow with actual counts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const many = await writeManyColorPng(dir);
			const out = join(dir, "many-out.png");
			const source = join(dir, "many.mcpx");
			const result = await runCli([
				"import",
				many,
				"--output",
				out,
				"--source",
				source,
				"--json",
			]);
			expect(result.code).toBe(2);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				error: { code: string; details: { colorCount: number; limit: number } };
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("MCPX_PALETTE_OVERFLOW");
			expect(envelope.error.details.colorCount).toBe(8192);
			expect(envelope.error.details.limit).toBe(4096);
			expect(await fileExists(out)).toBe(false);
			expect(await fileExists(source)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("§102: oversize grid is rejected before allocation with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const grid = await writeOversizeGrid(dir);
			const out = join(dir, "big.png");
			const result = await runCli(["render", grid, "--output", out, "--json"]);
			expect(result.code).toBe(2);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				error: { code: string };
			};
			expect(envelope.success).toBe(false);
			expect(typeof envelope.error.code).toBe("string");
			expect(await fileExists(out)).toBe(false);
			expect(await listAllFiles(dir)).toEqual(["big.grid"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("§102: oversize PNG dimensions are rejected before decode with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const huge = await writeOversizePng(dir);
			const out = join(dir, "huge-out.png");
			const result = await runCli(["import", huge, "--output", out, "--json"]);
			expect(result.code).toBe(2);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				error: { code: string; details: { value: number } };
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("INVALID_DIMENSION");
			expect(envelope.error.details.value).toBe(5000);
			expect(await fileExists(out)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("conformance: §98.1 channel matrix across all commands", () => {
	const WRITE_COMMANDS: Array<{
		command: string;
		input: () => string;
		needsPng: boolean;
	}> = [
		{ command: "build", input: () => SWORD_MCPX, needsPng: false },
		{ command: "render", input: () => TINY_GRID, needsPng: false },
		{ command: "import", input: () => "", needsPng: true },
	];

	for (const entry of WRITE_COMMANDS) {
		test(`${entry.command}: default human to stdout, --json envelope to stdout`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
			try {
				const input = entry.needsPng
					? await writeVectorPng(dir)
					: entry.input();
				const plain = await runCli([
					entry.command,
					input,
					"--output",
					join(dir, "plain.png"),
				]);
				expect(plain.code).toBe(0);
				expect(stdoutText(plain)).toContain(`ok ${entry.command}`);
				expect(plain.stderr).not.toContain(`ok ${entry.command}`);
				const withJson = await runCli([
					entry.command,
					input,
					"--output",
					join(dir, "shaped.png"),
					"--json",
				]);
				expect(withJson.code).toBe(0);
				const envelope = JSON.parse(stdoutText(withJson)) as {
					success: boolean;
					result: Record<string, unknown>;
				};
				expect(envelope.success).toBe(true);
				expect(withJson.stderr).not.toContain('"success":true');
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}, 30_000);

		test(`${entry.command}: --stdout owns stdout, --json --stdout moves the envelope to stderr`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
			try {
				const input = entry.needsPng
					? await writeVectorPng(dir)
					: entry.input();
				const plain = await runCli([entry.command, input, "--stdout"]);
				expect(plain.code).toBe(0);
				expect([...plain.stdout.slice(0, 8)]).toEqual(PNG_SIGNATURE);
				const withJson = await runCli([
					entry.command,
					input,
					"--stdout",
					"--json",
				]);
				expect(withJson.code).toBe(0);
				expect([...withJson.stdout.slice(0, 8)]).toEqual(PNG_SIGNATURE);
				const envelope = JSON.parse(withJson.stderr) as { success: boolean };
				expect(envelope.success).toBe(true);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}, 30_000);
	}

	test("analyze/validate: default human to stdout, --json envelope to stdout", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const png = await writeVectorPng(dir);
			const humanAnalyze = await runCli(["analyze", png]);
			expect(humanAnalyze.code).toBe(0);
			expect(stdoutText(humanAnalyze) + humanAnalyze.stderr).toContain("2x2");
			const jsonAnalyze = await runCli(["analyze", png, "--json"]);
			expect(jsonAnalyze.code).toBe(0);
			const report = JSON.parse(
				Buffer.from(jsonAnalyze.stdout).toString("utf-8"),
			) as { success: boolean; result: Record<string, unknown> };
			expect(report.success).toBe(true);
			expect(jsonAnalyze.stderr).not.toContain('"success":true');
			const humanValidate = await runCli(["validate", png]);
			expect(humanValidate.code).toBe(0);
			expect(stdoutText(humanValidate) + humanValidate.stderr).toContain(
				"verdict: pass",
			);
			const jsonValidate = await runCli(["validate", png, "--json"]);
			expect(jsonValidate.code).toBe(0);
			const verdict = JSON.parse(
				Buffer.from(jsonValidate.stdout).toString("utf-8"),
			) as { success: boolean; result: { verdict: string } };
			expect(verdict.success).toBe(true);
			expect(verdict.result.verdict).toBe("pass");
			expect(jsonValidate.stderr).not.toContain('"success":true');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("conformance: error to exit wiring per command", () => {
	test("import missing file is FILESYSTEM_ERROR with exit 4", async () => {
		const result = await runCli([
			"import",
			"/no/such/dir/missing.png",
			"--output",
			"/tmp/never.png",
			"--json",
		]);
		expect(result.code).toBe(4);
		const envelope = JSON.parse(stdoutText(result)) as {
			success: boolean;
			error: { code: string; message: string };
		};
		expect(envelope.success).toBe(false);
		expect(envelope.error.code).toBe("FILESYSTEM_ERROR");
		expect(typeof envelope.error.message).toBe("string");
	}, 30_000);

	test("render missing grid is FILESYSTEM_ERROR with exit 4", async () => {
		const result = await runCli([
			"render",
			"/no/such/dir/missing.grid",
			"--output",
			"/tmp/never.png",
			"--json",
		]);
		expect(result.code).toBe(4);
		const envelope = JSON.parse(stdoutText(result)) as {
			success: boolean;
			error: { code: string };
		};
		expect(envelope.success).toBe(false);
		expect(envelope.error.code).toBe("FILESYSTEM_ERROR");
	}, 30_000);

	test("build malformed mcpx is an mcpx error with exit 2", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const bad = join(dir, "bad.mcpx");
			await writeFile(bad, "this is not a mcpx document\n");
			const out = join(dir, "never.png");
			const result = await runCli(["build", bad, "--output", out, "--json"]);
			expect(result.code).toBe(2);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				error: { code: string };
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code.startsWith("MCPX_")).toBe(true);
			expect(await fileExists(out)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("analyze missing file is FILESYSTEM_ERROR with exit 4", async () => {
		const result = await runCli([
			"analyze",
			"/no/such/dir/missing.png",
			"--json",
		]);
		expect(result.code).toBe(4);
		const envelope = JSON.parse(stdoutText(result)) as {
			success: boolean;
			error: { code: string };
		};
		expect(envelope.success).toBe(false);
		expect(envelope.error.code).toBe("FILESYSTEM_ERROR");
	}, 30_000);

	test("validate misnamed minecraft asset is VALIDATION_FAILED with exit 3", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const input = join(dir, "Sword.PNG");
			await writeFile(input, Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64"));
			const result = await runCli([
				"validate",
				input,
				"--profile",
				"minecraft:item",
				"--json",
			]);
			expect(result.code).toBe(3);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				error: { code: string };
				result: { verdict: string };
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("VALIDATION_FAILED");
			expect(envelope.result.verdict).toBe("fail");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("conformance: --json shapes and determinism", () => {
	test("success envelopes carry stable keys for every core command", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const png = await writeVectorPng(dir);
			for (const [command, input] of [
				["import", png],
				["render", TINY_GRID],
				["build", SWORD_MCPX],
			] as Array<[string, string]>) {
				const result = await runCli([
					command,
					input,
					"--output",
					join(dir, `${command}.png`),
					"--json",
				]);
				expect(result.code).toBe(0);
				const envelope = JSON.parse(stdoutText(result)) as {
					success: boolean;
					result: Record<string, unknown>;
				};
				expect(envelope.success).toBe(true);
				for (const key of [
					"command",
					"profile",
					"applied",
					"operations",
					"warnings",
				]) {
					expect(key in envelope.result).toBe(true);
				}
			}
			const analyzed = await runCli(["analyze", png, "--json"]);
			const report = JSON.parse(stdoutText(analyzed)) as {
				success: boolean;
				result: Record<string, unknown>;
			};
			expect(report.success).toBe(true);
			for (const key of [
				"dimensions",
				"colorCount",
				"alpha",
				"dominantColors",
			]) {
				expect(key in report.result).toBe(true);
			}
			const validated = await runCli(["validate", png, "--json"]);
			const verdict = JSON.parse(stdoutText(validated)) as {
				success: boolean;
				result: Record<string, unknown>;
			};
			expect(verdict.success).toBe(true);
			for (const key of ["verdict", "findings"]) {
				expect(key in verdict.result).toBe(true);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("render and build repeat byte-identical on the same input", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const firstRender = join(dir, "tiny-a.png");
			const secondRender = join(dir, "tiny-b.png");
			expect(
				(await runCli(["render", TINY_GRID, "--output", firstRender])).code,
			).toBe(0);
			expect(
				(await runCli(["render", TINY_GRID, "--output", secondRender])).code,
			).toBe(0);
			expect(await readFile(firstRender)).toEqual(await readFile(secondRender));
			const firstBuild = join(dir, "sword-a.png");
			const secondBuild = join(dir, "sword-b.png");
			expect(
				(await runCli(["build", SWORD_MCPX, "--output", firstBuild])).code,
			).toBe(0);
			expect(
				(await runCli(["build", SWORD_MCPX, "--output", secondBuild])).code,
			).toBe(0);
			expect(await readFile(firstBuild)).toEqual(await readFile(secondBuild));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("analyze and validate are read-only and create no files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const png = await writeVectorPng(dir);
			const before = await readFile(png);
			expect((await runCli(["analyze", png])).code).toBe(0);
			expect((await runCli(["analyze", png, "--json"])).code).toBe(0);
			expect((await runCli(["validate", png])).code).toBe(0);
			expect((await runCli(["validate", png, "--json"])).code).toBe(0);
			expect(await listAllFiles(dir)).toEqual(["vector.png"]);
			expect(await readFile(png)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("D5 retired in V0.2: analyze reports measured isolatedPixels, still no anti-aliasing claim", async () => {
		// §63 names cleanup detections (isolated pixel, anti-aliasing, …)
		// without giving algorithms. V0.1 recorded that gap here and kept
		// the analyze report silent on them. V0.2 retires the isolated half:
		// pixelArtCharacteristics.isolatedPixels is a measured field with a
		// fixed, golden-locked rule (opaque pixel whose existing 4-neighbors
		// are all fully transparent), not an invented detection. The
		// anti-aliasing half stays silent: V0.2 adds no AA detection.
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const png = await writeVectorPng(dir);
			const jsoned = await runCli(["analyze", png, "--json"]);
			expect(jsoned.code).toBe(0);
			const body = stdoutText(jsoned).toLowerCase();
			expect(body.includes("isolatedpixels")).toBe(true);
			expect(body.includes("anti-alias") || body.includes("antialias")).toBe(
				false,
			);
			const human = await runCli(["analyze", png]);
			const humanBody = (stdoutText(human) + human.stderr).toLowerCase();
			expect(humanBody.includes("isolated=")).toBe(true);
			expect(
				humanBody.includes("anti-alias") || humanBody.includes("antialias"),
			).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("conformance: V0.2 §98 output guards", () => {
	const PX_PNG = join(FIXTURES, "px-8x8.png");

	interface GuardEntry {
		command: string;
		input: string;
		args: string[];
		workName: string;
	}

	// Minimal valid invocation per write command: the guard matrix below
	// only varies the output targeting, never the operation itself.
	const ENTRIES: GuardEntry[] = [
		{
			command: "transform",
			input: SWORD_MCPX,
			args: ["--flip", "h"],
			workName: "work.mcpx",
		},
		{
			command: "quantize",
			input: SWORD_MCPX,
			args: ["--colors", "2"],
			workName: "work.mcpx",
		},
		{ command: "cleanup", input: SWORD_MCPX, args: [], workName: "work.mcpx" },
		{
			command: "pixelize",
			input: PX_PNG,
			args: ["--size", "16"],
			workName: "work.png",
		},
		{
			command: "recolor",
			input: SWORD_MCPX,
			args: ["--material", "copper"],
			workName: "work.mcpx",
		},
	];

	for (const entry of ENTRIES) {
		test(`${entry.command}: missing output is OUTPUT_REQUIRED with zero files`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
			try {
				const before = await listAllFiles(dir);
				const result = await runCli([
					entry.command,
					entry.input,
					...entry.args,
				]);
				expect(result.code).toBe(2);
				expect(stdoutText(result) + result.stderr).toContain("OUTPUT_REQUIRED");
				expect(await listAllFiles(dir)).toEqual(before);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}, 30_000);

		test(`${entry.command}: existing output needs --force; forced rerun matches`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
			try {
				const out = join(dir, "guard.png");
				expect(
					(
						await runCli([
							entry.command,
							entry.input,
							...entry.args,
							"--output",
							out,
						])
					).code,
				).toBe(0);
				const original = await readFile(out);
				const before = await listAllFiles(dir);
				const refused = await runCli([
					entry.command,
					entry.input,
					...entry.args,
					"--output",
					out,
				]);
				expect(refused.code).toBe(4);
				expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
				expect(await readFile(out)).toEqual(original);
				expect(await listAllFiles(dir)).toEqual(before);
				expect(
					(
						await runCli([
							entry.command,
							entry.input,
							...entry.args,
							"--output",
							out,
							"--force",
						])
					).code,
				).toBe(0);
				expect(await readFile(out)).toEqual(original);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}, 60_000);

		test(`${entry.command}: missing parents need --mkdir`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
			try {
				const nested = join(dir, "nope", "nested", "guard.png");
				const refused = await runCli([
					entry.command,
					entry.input,
					...entry.args,
					"--output",
					nested,
				]);
				expect(refused.code).toBe(4);
				expect(stdoutText(refused) + refused.stderr).toContain(
					"FILESYSTEM_ERROR",
				);
				expect(await fileExists(join(dir, "nope"))).toBe(false);
				const made = join(dir, "fresh", "nested", "guard.png");
				expect(
					(
						await runCli([
							entry.command,
							entry.input,
							...entry.args,
							"--output",
							made,
							"--mkdir",
						])
					).code,
				).toBe(0);
				expect(await fileExists(made)).toBe(true);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}, 60_000);

		test(`${entry.command}: output aliasing the input is refused without touching it`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
			try {
				const work = join(dir, entry.workName);
				await writeFile(work, await readFile(entry.input));
				const original = await readFile(work);
				const literal = await runCli([
					entry.command,
					work,
					...entry.args,
					"--output",
					work,
				]);
				expect(literal.code).toBe(2);
				expect(stdoutText(literal) + literal.stderr).toContain(
					"ARGUMENT_CONFLICT",
				);
				expect(await readFile(work)).toEqual(original);
				// Dot-segment spellings of the same path fold to the same
				// identity, so they are refused the same way.
				const dotted = await runCli([
					entry.command,
					work,
					...entry.args,
					"--output",
					`${dir}/./${entry.workName}`,
				]);
				expect(dotted.code).toBe(2);
				expect(stdoutText(dotted) + dotted.stderr).toContain(
					"ARGUMENT_CONFLICT",
				);
				expect(await readFile(work)).toEqual(original);
				expect(await listAllFiles(dir)).toEqual([entry.workName]);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}, 60_000);
	}
});

describe("conformance: V0.2 variant output guards", () => {
	test("missing --output-dir is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const before = await listAllFiles(dir);
			const result = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron",
			]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("existing variant files need --force; forced rerun is byte-identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const outDir = join(dir, "out");
			expect(
				(
					await runCli([
						"variant",
						SWORD_MCPX,
						"--materials",
						"iron,copper",
						"--output-dir",
						outDir,
						"--mkdir",
					])
				).code,
			).toBe(0);
			const names = await listAllFiles(outDir);
			expect(names).toEqual([
				"sword_copper.mcpx",
				"sword_copper.png",
				"sword_iron.mcpx",
				"sword_iron.png",
			]);
			const original: string[] = [];
			for (const name of names) {
				original.push((await readFile(join(outDir, name))).toString("base64"));
			}
			const refused = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron,copper",
				"--output-dir",
				outDir,
			]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			for (let index = 0; index < names.length; index += 1) {
				const name = names[index] as string;
				expect((await readFile(join(outDir, name))).toString("base64")).toBe(
					original[index] as string,
				);
			}
			expect(
				(
					await runCli([
						"variant",
						SWORD_MCPX,
						"--materials",
						"iron,copper",
						"--output-dir",
						outDir,
						"--force",
					])
				).code,
			).toBe(0);
			for (let index = 0; index < names.length; index += 1) {
				const name = names[index] as string;
				expect((await readFile(join(outDir, name))).toString("base64")).toBe(
					original[index] as string,
				);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("missing parents need --mkdir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const nested = join(dir, "a", "b", "out");
			const refused = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron",
				"--output-dir",
				nested,
			]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain(
				"FILESYSTEM_ERROR",
			);
			expect(await listAllFiles(dir)).toEqual([]);
			const made = join(dir, "fresh", "out");
			expect(
				(
					await runCli([
						"variant",
						SWORD_MCPX,
						"--materials",
						"iron",
						"--output-dir",
						made,
						"--mkdir",
					])
				).code,
			).toBe(0);
			expect(await listAllFiles(made)).toEqual([
				"sword_iron.mcpx",
				"sword_iron.png",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("--output alongside variant is ARGUMENT_CONFLICT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const before = await listAllFiles(dir);
			const result = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron",
				"--output-dir",
				join(dir, "out"),
				"--output",
				join(dir, "single.png"),
			]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("ARGUMENT_CONFLICT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("source inside the output dir still fans out: derived names never alias it", async () => {
		// Variant targets are always <stem>_<material>.png/.mcpx, so they
		// can never fold to the source identity; the fan-out must succeed
		// with the source bytes untouched instead of refusing as an alias.
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const outDir = join(dir, "out");
			await mkdir(outDir, { recursive: true });
			const source = join(outDir, "base.mcpx");
			await writeFile(source, await readFile(SWORD_MCPX));
			const original = await readFile(source);
			const result = await runCli([
				"variant",
				source,
				"--materials",
				"iron",
				"--output-dir",
				outDir,
				"--mkdir",
			]);
			expect(result.code).toBe(0);
			expect(await listAllFiles(outDir)).toEqual([
				"base.mcpx",
				"base_iron.mcpx",
				"base_iron.png",
			]);
			expect(await readFile(source)).toEqual(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("conformance: V0.2 rerun determinism", () => {
	test("transform, quantize, cleanup, and recolor rerun byte-identical", async () => {
		// Pixelize and variant reruns are already locked in their own spawn
		// suites; this case covers the remaining V0.2 write commands.
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const cases: Array<{ command: string; args: string[] }> = [
				{ command: "transform", args: ["--flip", "h"] },
				{ command: "quantize", args: ["--colors", "2"] },
				{ command: "cleanup", args: [] },
				{ command: "recolor", args: ["--material", "copper"] },
			];
			for (const entry of cases) {
				const firstPng = join(dir, `${entry.command}-a.png`);
				const firstMcpx = join(dir, `${entry.command}-a.mcpx`);
				const secondPng = join(dir, `${entry.command}-b.png`);
				const secondMcpx = join(dir, `${entry.command}-b.mcpx`);
				expect(
					(
						await runCli([
							entry.command,
							SWORD_MCPX,
							...entry.args,
							"--output",
							firstPng,
							"--source",
							firstMcpx,
						])
					).code,
				).toBe(0);
				expect(
					(
						await runCli([
							entry.command,
							SWORD_MCPX,
							...entry.args,
							"--output",
							secondPng,
							"--source",
							secondMcpx,
						])
					).code,
				).toBe(0);
				expect(await readFile(firstPng)).toEqual(await readFile(secondPng));
				expect(await readFile(firstMcpx)).toEqual(await readFile(secondMcpx));
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("conformance: V0.3 §98 output guards", () => {
	const PX_PNG = join(FIXTURES, "px-8x8.png");
	const GEN_BASE = [
		"generate",
		"noise",
		"--size",
		"8",
		"--palette",
		"stone",
		"--seed",
		"7",
	];

	test("tile report-only needs no output; --preview without output is OUTPUT_REQUIRED", async () => {
		// Plain tile is analysis-only (exit 0, zero files); only the
		// --preview form writes a PNG, so only it carries the guard.
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const report = await runCli(["tile", PX_PNG]);
			expect(report.code).toBe(0);
			expect(stdoutText(report) + report.stderr).toContain("ok tile");
			expect(await listAllFiles(dir)).toEqual([]);
			const before = await listAllFiles(dir);
			const refused = await runCli([
				"tile",
				PX_PNG,
				"--preview",
				"2x2",
				"--json",
			]);
			expect(refused.code).toBe(2);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("generate without any output channel is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const before = await listAllFiles(dir);
			const result = await runCli([...GEN_BASE, "--json"]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("preview --scale without output is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const before = await listAllFiles(dir);
			const result = await runCli([
				"preview",
				PX_PNG,
				"--scale",
				"2",
				"--json",
			]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("tile: existing output needs --force; forced rerun matches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const out = join(dir, "tile.png");
			expect((await runCli(["tile", PX_PNG, "--output", out])).code).toBe(0);
			const original = await readFile(out);
			const before = await listAllFiles(dir);
			const refused = await runCli(["tile", PX_PNG, "--output", out]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			expect(await readFile(out)).toEqual(original);
			expect(await listAllFiles(dir)).toEqual(before);
			expect(
				(await runCli(["tile", PX_PNG, "--output", out, "--force"])).code,
			).toBe(0);
			expect(await readFile(out)).toEqual(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("generate: existing output needs --force; forced rerun matches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const out = join(dir, "gen.png");
			expect((await runCli([...GEN_BASE, "--output", out])).code).toBe(0);
			const original = await readFile(out);
			const before = await listAllFiles(dir);
			const refused = await runCli([...GEN_BASE, "--output", out, "--json"]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			expect(await readFile(out)).toEqual(original);
			expect(await listAllFiles(dir)).toEqual(before);
			expect(
				(await runCli([...GEN_BASE, "--output", out, "--force"])).code,
			).toBe(0);
			expect(await readFile(out)).toEqual(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("preview --scale: existing output needs --force; forced rerun matches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const out = join(dir, "scaled.png");
			expect(
				(await runCli(["preview", PX_PNG, "--scale", "2", "--output", out]))
					.code,
			).toBe(0);
			const original = await readFile(out);
			const before = await listAllFiles(dir);
			const refused = await runCli([
				"preview",
				PX_PNG,
				"--scale",
				"2",
				"--output",
				out,
			]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			expect(await readFile(out)).toEqual(original);
			expect(await listAllFiles(dir)).toEqual(before);
			expect(
				(
					await runCli([
						"preview",
						PX_PNG,
						"--scale",
						"2",
						"--output",
						out,
						"--force",
					])
				).code,
			).toBe(0);
			expect(await readFile(out)).toEqual(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("tile: missing parents need --mkdir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const nested = join(dir, "nope", "nested", "tile.png");
			const refused = await runCli([
				"tile",
				PX_PNG,
				"--output",
				nested,
				"--json",
			]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain(
				"FILESYSTEM_ERROR",
			);
			expect(await fileExists(join(dir, "nope"))).toBe(false);
			const made = join(dir, "fresh", "nested", "tile.png");
			expect(
				(await runCli(["tile", PX_PNG, "--output", made, "--mkdir"])).code,
			).toBe(0);
			expect(await fileExists(made)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("generate: missing parents need --mkdir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const nested = join(dir, "nope", "nested", "gen.png");
			const refused = await runCli([...GEN_BASE, "--output", nested, "--json"]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain(
				"FILESYSTEM_ERROR",
			);
			expect(await fileExists(join(dir, "nope"))).toBe(false);
			const made = join(dir, "fresh", "nested", "gen.png");
			expect(
				(await runCli([...GEN_BASE, "--output", made, "--mkdir"])).code,
			).toBe(0);
			expect(await fileExists(made)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("preview --scale: missing parents need --mkdir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const nested = join(dir, "nope", "nested", "scaled.png");
			const refused = await runCli([
				"preview",
				PX_PNG,
				"--scale",
				"2",
				"--output",
				nested,
				"--json",
			]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain(
				"FILESYSTEM_ERROR",
			);
			expect(await fileExists(join(dir, "nope"))).toBe(false);
			const made = join(dir, "fresh", "nested", "scaled.png");
			expect(
				(
					await runCli([
						"preview",
						PX_PNG,
						"--scale",
						"2",
						"--output",
						made,
						"--mkdir",
					])
				).code,
			).toBe(0);
			expect(await fileExists(made)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("tile: output aliasing the input is refused without touching it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const work = join(dir, "work.png");
			await writeFile(work, await readFile(PX_PNG));
			const original = await readFile(work);
			const literal = await runCli(["tile", work, "--output", work]);
			expect(literal.code).toBe(2);
			expect(stdoutText(literal) + literal.stderr).toContain(
				"ARGUMENT_CONFLICT",
			);
			expect(await readFile(work)).toEqual(original);
			// Dot-segment spellings of the same path fold to the same
			// identity, so they are refused the same way.
			const dotted = await runCli([
				"tile",
				work,
				"--output",
				`${dir}/./work.png`,
			]);
			expect(dotted.code).toBe(2);
			expect(stdoutText(dotted) + dotted.stderr).toContain("ARGUMENT_CONFLICT");
			expect(await readFile(work)).toEqual(original);
			expect(await listAllFiles(dir)).toEqual(["work.png"]);
			// Tile has no editable output: --source and --in-place stay
			// undeclared options.
			expect(
				(await runCli(["tile", work, "--source", join(dir, "x.mcpx")])).code,
			).toBe(2);
			expect((await runCli(["tile", work, "--in-place"])).code).toBe(2);
			expect(await readFile(work)).toEqual(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("generate declares no input file: --input and --in-place stay undeclared", async () => {
		// Generate synthesizes from pattern/size/palette/seed, so an
		// input/output identity can never arise; the adjacent surface is
		// the undeclared pair, rejected before any file is touched.
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const before = await listAllFiles(dir);
			const viaInput = await runCli([
				...GEN_BASE,
				"--output",
				join(dir, "out.png"),
				"--input",
				"x",
			]);
			expect(viaInput.code).toBe(2);
			const inPlace = await runCli([
				...GEN_BASE,
				"--output",
				join(dir, "out.png"),
				"--in-place",
			]);
			expect(inPlace.code).toBe(2);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("preview --scale aliasing the input is refused without touching it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const work = join(dir, "work.png");
			await writeFile(work, await readFile(PX_PNG));
			const original = await readFile(work);
			const literal = await runCli([
				"preview",
				work,
				"--scale",
				"2",
				"--output",
				work,
			]);
			expect(literal.code).toBe(2);
			expect(stdoutText(literal) + literal.stderr).toContain(
				"ARGUMENT_CONFLICT",
			);
			expect(await readFile(work)).toEqual(original);
			const dotted = await runCli([
				"preview",
				work,
				"--scale",
				"2",
				"--output",
				`${dir}/./work.png`,
			]);
			expect(dotted.code).toBe(2);
			expect(stdoutText(dotted) + dotted.stderr).toContain("ARGUMENT_CONFLICT");
			expect(await readFile(work)).toEqual(original);
			expect(await listAllFiles(dir)).toEqual(["work.png"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("preview report modes reject every file flag", async () => {
		// --ascii and --palette-map are read-only reports: none of the
		// file-targeting flags may appear alongside them.
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			for (const mode of ["--ascii", "--palette-map"]) {
				for (const extra of [
					["--output", join(dir, "report.bin")],
					["--stdout"],
					["--force"],
					["--mkdir"],
					["--in-place"],
					["--input", PX_PNG],
				]) {
					const before = await listAllFiles(dir);
					const result = await runCli([
						"preview",
						PX_PNG,
						mode,
						...extra,
						"--json",
					]);
					expect(result.code).toBe(2);
					expect(stdoutText(result) + result.stderr).toContain(
						"INVALID_ARGUMENT",
					);
					expect(await listAllFiles(dir)).toEqual(before);
				}
			}
			// --scale mode takes no --source, and preview owns no tile flag.
			const viaSource = await runCli([
				"preview",
				PX_PNG,
				"--scale",
				"2",
				"--source",
				join(dir, "x.mcpx"),
				"--json",
			]);
			expect(viaSource.code).toBe(2);
			const viaPreview = await runCli([
				"preview",
				PX_PNG,
				"--preview",
				"4x4",
				"--json",
			]);
			expect(viaPreview.code).toBe(2);
			expect(await listAllFiles(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("conformance: V0.3 tile and preview report determinism", () => {
	const PX_PNG = join(FIXTURES, "px-8x8.png");

	test("tile report and tile PNG rerun identical, input untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const work = join(dir, "work.png");
			await writeFile(work, await readFile(PX_PNG));
			const inputBefore = await readFile(work);
			const firstReport = await runCli(["tile", work, "--json"]);
			const secondReport = await runCli(["tile", work, "--json"]);
			expect(firstReport.code).toBe(0);
			expect(secondReport.code).toBe(0);
			expect(stdoutText(secondReport)).toBe(stdoutText(firstReport));
			const firstPng = join(dir, "tile-a.png");
			const secondPng = join(dir, "tile-b.png");
			expect((await runCli(["tile", work, "--output", firstPng])).code).toBe(0);
			expect((await runCli(["tile", work, "--output", secondPng])).code).toBe(
				0,
			);
			expect(await readFile(firstPng)).toEqual(await readFile(secondPng));
			expect(await readFile(work)).toEqual(inputBefore);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("preview ascii, palette-map, and scale rerun identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const work = join(dir, "work.png");
			await writeFile(work, await readFile(PX_PNG));
			const inputBefore = await readFile(work);
			const firstAscii = await runCli(["preview", work, "--ascii"]);
			const secondAscii = await runCli(["preview", work, "--ascii"]);
			expect(firstAscii.code).toBe(0);
			expect(Buffer.from(secondAscii.stdout)).toEqual(
				Buffer.from(firstAscii.stdout),
			);
			const firstMap = await runCli([
				"preview",
				work,
				"--palette-map",
				"--json",
			]);
			const secondMap = await runCli([
				"preview",
				work,
				"--palette-map",
				"--json",
			]);
			expect(firstMap.code).toBe(0);
			expect(stdoutText(secondMap)).toBe(stdoutText(firstMap));
			const firstPng = join(dir, "scale-a.png");
			const secondPng = join(dir, "scale-b.png");
			expect(
				(await runCli(["preview", work, "--scale", "2", "--output", firstPng]))
					.code,
			).toBe(0);
			expect(
				(await runCli(["preview", work, "--scale", "2", "--output", secondPng]))
					.code,
			).toBe(0);
			expect(await readFile(firstPng)).toEqual(await readFile(secondPng));
			expect(await readFile(work)).toEqual(inputBefore);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("conformance: V0.4 §98 output guards", () => {
	const PX_PNG = join(FIXTURES, "px-8x8.png");

	test("animate pack without any output channel is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const framesDir = await writeV04Frames(dir, "frames");
			const before = await listAllFiles(dir);
			const result = await runCli([
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
			]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("animate pack second write is OUTPUT_EXISTS; --force reruns byte-identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const framesDir = await writeV04Frames(dir, "frames");
			const out = join(dir, "sheet.png");
			const base = [
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
			];
			expect((await runCli([...base, "--output", out])).code).toBe(0);
			const original = await readFile(out);
			const before = await listAllFiles(dir);
			const refused = await runCli([...base, "--output", out]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			expect(await readFile(out)).toEqual(original);
			expect(await listAllFiles(dir)).toEqual(before);
			expect((await runCli([...base, "--output", out, "--force"])).code).toBe(
				0,
			);
			expect(await readFile(out)).toEqual(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("animate pack missing parents need --mkdir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const framesDir = await writeV04Frames(dir, "frames");
			const base = [
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
			];
			const nested = join(dir, "nope", "nested", "sheet.png");
			const refused = await runCli([...base, "--output", nested]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain(
				"FILESYSTEM_ERROR",
			);
			expect(await fileExists(join(dir, "nope"))).toBe(false);
			const made = join(dir, "fresh", "nested", "sheet.png");
			expect((await runCli([...base, "--output", made, "--mkdir"])).code).toBe(
				0,
			);
			expect(await fileExists(made)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("validate --mcmeta rejects file flags as unknown options with exit 2", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const framesDir = await writeV04Frames(dir, "frames");
			const sheet = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						sheet,
					])
				).code,
			).toBe(0);
			const mcmeta = await writeV04SheetMcmeta(dir);
			const before = await listAllFiles(dir);
			const withOutput = await runCli([
				"--json",
				"validate",
				sheet,
				"--mcmeta",
				mcmeta,
				"--output",
				join(dir, "out.json"),
			]);
			expect(withOutput.code).toBe(2);
			expect(stdoutText(withOutput) + withOutput.stderr).toContain(
				"unknown option",
			);
			const withStdout = await runCli([
				"validate",
				sheet,
				"--mcmeta",
				mcmeta,
				"--stdout",
			]);
			expect(withStdout.code).toBe(2);
			expect(stdoutText(withStdout) + withStdout.stderr).toContain(
				"unknown option",
			);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("animate validate rejects file flags as read-only with exit 2", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const framesDir = await writeV04Frames(dir, "frames");
			const before = await listAllFiles(dir);
			const result = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
				"--output",
				join(dir, "out.json"),
			]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("read-only");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("preview without a mode is INVALID_ARGUMENT with exit 2", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const before = await listAllFiles(dir);
			const result = await runCli(["--json", "preview", PX_PNG]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("preview with two modes is ARGUMENT_CONFLICT with exit 2", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const mcmeta = await writeV04NineSliceMcmeta(dir);
			const pair = await runCli([
				"--json",
				"preview",
				PX_PNG,
				"--ascii",
				"--palette-map",
			]);
			expect(pair.code).toBe(2);
			expect(stdoutText(pair) + pair.stderr).toContain("ARGUMENT_CONFLICT");
			const mixed = await runCli([
				"--json",
				"preview",
				PX_PNG,
				"--ascii",
				"--nine-slice",
				"--mcmeta",
				mcmeta,
			]);
			expect(mixed.code).toBe(2);
			expect(stdoutText(mixed) + mixed.stderr).toContain("ARGUMENT_CONFLICT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("validate --mcmeta leaves the PNG and mcmeta bytes alone", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const framesDir = await writeV04Frames(dir, "frames");
			const sheet = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						sheet,
					])
				).code,
			).toBe(0);
			const mcmeta = await writeV04SheetMcmeta(dir);
			const pngBefore = await readFile(sheet);
			const mcmetaBefore = await readFile(mcmeta);
			const result = await runCli([
				"--json",
				"validate",
				sheet,
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			expect(await readFile(sheet)).toEqual(pngBefore);
			expect(await readFile(mcmeta)).toEqual(mcmetaBefore);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("conformance: V0.4 rerun determinism", () => {
	test("animate pack reruns byte-identical on the same frames", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const framesDir = await writeV04Frames(dir, "frames");
			const first = join(dir, "sheet-a.png");
			const second = join(dir, "sheet-b.png");
			const base = [
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
			];
			expect((await runCli([...base, "--output", first])).code).toBe(0);
			expect((await runCli([...base, "--output", second])).code).toBe(0);
			expect(await readFile(first)).toEqual(await readFile(second));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("validate --mcmeta reruns with identical stdout on the same inputs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const framesDir = await writeV04Frames(dir, "frames");
			const sheet = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						sheet,
					])
				).code,
			).toBe(0);
			const mcmeta = await writeV04SheetMcmeta(dir);
			const first = await runCli([
				"--json",
				"validate",
				sheet,
				"--mcmeta",
				mcmeta,
			]);
			const second = await runCli([
				"--json",
				"validate",
				sheet,
				"--mcmeta",
				mcmeta,
			]);
			expect(first.code).toBe(0);
			expect(stdoutText(second)).toBe(stdoutText(first));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
