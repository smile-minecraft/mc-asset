import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMaterialPalette } from "../../src/core/material.ts";
import { decodePng } from "../../src/io/png.ts";
import { parseMcpx } from "../../src/mcpx/index.ts";

/**
 * generate spawn coverage: deterministic pattern synthesis from a builtin
 * material palette or an .mcpx [palette], with the shared output guards.
 * No Mojang assets: palettes come from builtin materials or self-made .mcpx.
 */

const FIXTURES = "tests/cli/fixtures";
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");
const RASTER_PNG = join(FIXTURES, "px-8x8.png");

interface SpawnResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

interface JsonEnvelope {
	success: boolean;
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string; details?: unknown };
}

function stdoutText(result: SpawnResult): string {
	return Buffer.from(result.stdout).toString("utf-8");
}

function parseJsonStdout(result: SpawnResult): JsonEnvelope {
	return JSON.parse(stdoutText(result)) as JsonEnvelope;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function runCli(args: string[]): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
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

function stoneKeys(): Set<string> {
	const palette = getMaterialPalette("stone");
	const keys = new Set(
		palette.entries.map(
			(e) => `${e.color.r},${e.color.g},${e.color.b},${e.color.a}`,
		),
	);
	keys.add("0,0,0,0");
	return keys;
}

function toHex(n: number): string {
	return n.toString(16).padStart(6, "0").toUpperCase();
}

/** .mcpx whose [palette] holds `count` distinct opaque colors. */
function bigPaletteMcpx(count: number): string {
	const lines = [
		"mcpx 1",
		"",
		"[canvas]",
		"width = 2",
		"height = 2",
		"",
		"[palette]",
		". = transparent",
	];
	for (let i = 0; i < count; i += 1) {
		lines.push(
			`C${String(i).padStart(5, "0")} = #${toHex((i * 7919 + 12345) % 0xffffff)}FF`,
		);
	}
	lines.push(
		"",
		"[layer base]",
		"visible = true",
		"opacity = 1.000",
		"",
		"[grid tokens]",
		"C00000 C00001",
		"C00002 C00003",
		"",
	);
	return lines.join("\n");
}

describe("generate wiring via spawn", () => {
	test("missing --size/--palette/--seed are INVALID_ARGUMENT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const base = ["generate", "noise"];
			const cases: string[][] = [
				[
					...base,
					"--palette",
					"stone",
					"--seed",
					"1",
					"--output",
					join(dir, "a.png"),
				],
				[...base, "--size", "8", "--seed", "1", "--output", join(dir, "b.png")],
				[
					...base,
					"--size",
					"8",
					"--palette",
					"stone",
					"--output",
					join(dir, "c.png"),
				],
			];
			for (const args of cases) {
				const result = await runCli(["--json", ...args]);
				expect(result.code).toBe(2);
				expect(parseJsonStdout(result).error?.code).toBe("INVALID_ARGUMENT");
			}
			expect(await listAllFiles(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("unknown pattern is INVALID_ARGUMENT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const result = await runCli([
				"--json",
				"generate",
				"clouds",
				"--size",
				"8",
				"--palette",
				"stone",
				"--seed",
				"1",
				"--output",
				join(dir, "out.png"),
			]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("all ten patterns resolve and rerun byte-identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const patterns = [
				"noise",
				"clustered-noise",
				"stripes",
				"checker",
				"gradient",
				"brick",
				"spots",
				"veins",
				"cracks",
				"grain",
			];
			for (const pattern of patterns) {
				const first = join(dir, `${pattern}-1.png`);
				const second = join(dir, `${pattern}-2.png`);
				expect(
					(
						await runCli([
							"generate",
							pattern,
							"--size",
							"8",
							"--palette",
							"stone",
							"--seed",
							"7",
							"--output",
							first,
						])
					).code,
				).toBe(0);
				expect(
					(
						await runCli([
							"generate",
							pattern,
							"--size",
							"8",
							"--palette",
							"stone",
							"--seed",
							"7",
							"--output",
							second,
						])
					).code,
				).toBe(0);
				expect(sha256(new Uint8Array(await readFile(first)))).toBe(
					sha256(new Uint8Array(await readFile(second))),
				);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	test("output pixels are palette members or transparent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const allowed = stoneKeys();
			for (const pattern of ["noise", "spots", "cracks", "grain"]) {
				const out = join(dir, `${pattern}.png`);
				expect(
					(
						await runCli([
							"generate",
							pattern,
							"--size",
							"12x10",
							"--palette",
							"stone",
							"--seed",
							"99",
							"--output",
							out,
						])
					).code,
				).toBe(0);
				const decoded = decodePng(new Uint8Array(await readFile(out)));
				expect(decoded.canvas.width).toBe(12);
				expect(decoded.canvas.height).toBe(10);
				const flat = decoded.canvas.layers[0]?.pixels as Uint8Array;
				for (let i = 0; i < flat.length; i += 4) {
					const key = `${flat[i]},${flat[i + 1]},${flat[i + 2]},${flat[i + 3]}`;
					expect(allowed.has(key)).toBe(true);
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("palette priority: material, .mcpx file, rejects, missing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const materialOut = join(dir, "material.png");
			expect(
				(
					await runCli([
						"generate",
						"checker",
						"--size",
						"8",
						"--palette",
						"stone",
						"--seed",
						"3",
						"--output",
						materialOut,
					])
				).code,
			).toBe(0);
			const mcpxOut = join(dir, "mcpx.png");
			expect(
				(
					await runCli([
						"generate",
						"checker",
						"--size",
						"8",
						"--palette",
						SWORD_MCPX,
						"--seed",
						"3",
						"--output",
						mcpxOut,
					])
				).code,
			).toBe(0);
			const notMcpx = await runCli([
				"--json",
				"generate",
				"checker",
				"--size",
				"8",
				"--palette",
				RASTER_PNG,
				"--seed",
				"3",
				"--output",
				join(dir, "rejected.png"),
			]);
			expect(notMcpx.code).toBe(2);
			expect(parseJsonStdout(notMcpx).error?.code).toBe("INVALID_ARGUMENT");
			const missing = await runCli([
				"--json",
				"generate",
				"checker",
				"--size",
				"8",
				"--palette",
				join(dir, "no-such.mcpx"),
				"--seed",
				"3",
				"--output",
				join(dir, "missing.png"),
			]);
			expect(missing.code).toBe(4);
			expect(parseJsonStdout(missing).error?.code).toBe("FILESYSTEM_ERROR");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("three output channels and OUTPUT_REQUIRED without any", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const pngOut = join(dir, "gen.png");
			expect(
				(
					await runCli([
						"generate",
						"stripes",
						"--size",
						"8",
						"--palette",
						"stone",
						"--seed",
						"5",
						"--output",
						pngOut,
					])
				).code,
			).toBe(0);
			const mcpxOut = join(dir, "gen.mcpx");
			expect(
				(
					await runCli([
						"generate",
						"stripes",
						"--size",
						"8",
						"--palette",
						"stone",
						"--seed",
						"5",
						"--source",
						mcpxOut,
					])
				).code,
			).toBe(0);
			parseMcpx(await readFile(mcpxOut, "utf-8"));
			const bothA = join(dir, "both-a.png");
			const bothB = join(dir, "both-b.mcpx");
			expect(
				(
					await runCli([
						"generate",
						"stripes",
						"--size",
						"8",
						"--palette",
						"stone",
						"--seed",
						"5",
						"--output",
						bothA,
						"--source",
						bothB,
					])
				).code,
			).toBe(0);
			const viaStdout = await runCli([
				"generate",
				"stripes",
				"--size",
				"8",
				"--palette",
				"stone",
				"--seed",
				"5",
				"--stdout",
			]);
			expect(viaStdout.code).toBe(0);
			expect(sha256(viaStdout.stdout)).toBe(
				sha256(new Uint8Array(await readFile(pngOut))),
			);
			const emptyDir = await mkdtemp(join(tmpdir(), "mc-asset-gen-empty-"));
			try {
				const required = await runCli([
					"--json",
					"generate",
					"stripes",
					"--size",
					"8",
					"--palette",
					"stone",
					"--seed",
					"5",
				]);
				expect(required.code).toBe(2);
				expect(parseJsonStdout(required).error?.code).toBe("OUTPUT_REQUIRED");
				expect(await listAllFiles(emptyDir)).toEqual([]);
			} finally {
				await rm(emptyDir, { recursive: true, force: true });
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("--source over capacity is MCPX_PALETTE_OVERFLOW", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const big = join(dir, "big.mcpx");
			await writeFile(big, bigPaletteMcpx(5000));
			const result = await runCli([
				"--json",
				"generate",
				"noise",
				"--size",
				"256",
				"--palette",
				big,
				"--seed",
				"11",
				"--source",
				join(dir, "out.mcpx"),
			]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("MCPX_PALETTE_OVERFLOW");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("OUTPUT_EXISTS force and mkdir guards hold", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const out = join(dir, "gen.png");
			const args = [
				"generate",
				"gradient",
				"--size",
				"8",
				"--palette",
				"stone",
				"--seed",
				"2",
				"--output",
				out,
			];
			expect((await runCli(args)).code).toBe(0);
			const clash = await runCli(["--json", ...args]);
			expect(clash.code).toBe(4);
			expect(parseJsonStdout(clash).error?.code).toBe("OUTPUT_EXISTS");
			expect((await runCli([...args, "--force"])).code).toBe(0);
			const nested = join(dir, "missing", "gen.png");
			const noMkdir = await runCli([
				"--json",
				"generate",
				"gradient",
				"--size",
				"8",
				"--palette",
				"stone",
				"--seed",
				"2",
				"--output",
				nested,
			]);
			expect(noMkdir.code).toBe(4);
			expect(parseJsonStdout(noMkdir).error?.code).toBe("FILESYSTEM_ERROR");
			expect(
				(
					await runCli([
						"generate",
						"gradient",
						"--size",
						"8",
						"--palette",
						"stone",
						"--seed",
						"2",
						"--output",
						nested,
						"--mkdir",
					])
				).code,
			).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("--json envelope carries the frozen shape", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const out = join(dir, "gen.png");
			const result = await runCli([
				"--json",
				"generate",
				"brick",
				"--size",
				"16x8",
				"--palette",
				"stone",
				"--seed",
				"42",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const envelope = parseJsonStdout(result);
			const shaped = envelope.result as {
				command: unknown;
				profile: unknown;
				applied: unknown;
				operations: unknown;
				warnings: unknown;
				pattern: unknown;
				seed: unknown;
				width: unknown;
				height: unknown;
				palette: unknown;
				output: unknown;
			};
			expect(shaped.command).toBe("generate");
			expect(shaped.profile).toBe("generic");
			expect(shaped.applied).toBe(0);
			expect(shaped.operations).toEqual([]);
			expect(Array.isArray(shaped.warnings)).toBe(true);
			expect(shaped.pattern).toBe("brick");
			expect(shaped.seed).toBe(42);
			expect(shaped.width).toBe(16);
			expect(shaped.height).toBe(8);
			expect(shaped.palette).toBe("stone");
			expect(shaped.output).toBe(out);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--input and --in-place are unknown options on generate", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gen-"));
		try {
			const shared = [
				"generate",
				"noise",
				"--size",
				"8",
				"--palette",
				"stone",
				"--seed",
				"1",
				"--output",
				join(dir, "out.png"),
			];
			expect((await runCli([...shared, "--input", "x"])).code).toBe(2);
			expect((await runCli([...shared, "--in-place"])).code).toBe(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
