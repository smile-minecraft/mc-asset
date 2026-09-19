import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	test("D5 gap: analyze claims no isolated-pixel or anti-aliasing detection", async () => {
		// §63 names cleanup detections (isolated pixel, anti-aliasing, …)
		// without giving algorithms. V0.1 records the gap here and MUST NOT
		// invent detections: the analyze report stays silent on them.
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-conf-"));
		try {
			const png = await writeVectorPng(dir);
			const jsoned = await runCli(["analyze", png, "--json"]);
			expect(jsoned.code).toBe(0);
			const body = stdoutText(jsoned).toLowerCase();
			expect(body.includes("isolat")).toBe(false);
			expect(body.includes("anti-alias") || body.includes("antialias")).toBe(
				false,
			);
			const human = await runCli(["analyze", png]);
			const humanBody = (stdoutText(human) + human.stderr).toLowerCase();
			expect(humanBody.includes("isolat")).toBe(false);
			expect(
				humanBody.includes("anti-alias") || humanBody.includes("antialias"),
			).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
