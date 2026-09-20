import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng } from "../../src/io/png.ts";

/**
 * Block Texture Workflow end-to-end coverage (v03 design, "Block Texture
 * Workflow" section): the workflow is a composition of existing commands,
 * no new command exists.
 *
 * Chain under test (fixed stone base: pattern noise, palette stone,
 * size 16, seed 1234):
 *
 *   generate -> tile (report, optional correction, --preview)
 *     -> pixelize --preset block --profile minecraft:block -> single PNG
 *
 * Authoring-tools boundary under test: tile measurements never rewrite the
 * input (.mcpx hash unchanged), metrics appear only in the report/--json,
 * and the minecraft:block profile exports PNG only.
 */

const STONE_PATTERN = "noise";
const STONE_PALETTE = "stone";
const STONE_SIZE = "16";
const STONE_SEED = "1234";

/** Locked after a human-checked deterministic run; placeholder first (Red). */
const GOLDEN_GENERATE_SHA256 =
	"cdbbbb1c997e1f2b9d5f0216f7b0e0ea1bf51fb3910fcb50aef22873b9fa7405";
/** Locked after a human-checked deterministic run; placeholder first (Red). */
const GOLDEN_FIXED_SHA256 =
	"98b69c8ac75e986554c6ebd07d5a9e3794c3cb2e246be81738060fa3cf468d6c";

interface SpawnResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

interface JsonEnvelope {
	success: boolean;
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string };
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

async function generateStoneBase(dir: string, name = "t.png"): Promise<string> {
	const out = join(dir, name);
	const result = await runCli([
		"generate",
		STONE_PATTERN,
		"--size",
		STONE_SIZE,
		"--palette",
		STONE_PALETTE,
		"--seed",
		STONE_SEED,
		"--output",
		out,
	]);
	expect(result.code).toBe(0);
	return out;
}

describe("block texture workflow via spawn", () => {
	test("stone base generation matches the golden digest", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-blockwf-"));
		try {
			const base = await generateStoneBase(dir);
			expect(sha256(new Uint8Array(await readFile(base)))).toBe(
				GOLDEN_GENERATE_SHA256,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("tile report locks the seam and repeat metrics", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-blockwf-"));
		try {
			const base = await generateStoneBase(dir);
			const result = await runCli(["--json", "tile", base]);
			expect(result.code).toBe(0);
			const tile = parseJsonStdout(result).result as {
				command: string;
				seam: Record<string, { raw: number; pairs: number; score: string }>;
				repeat: { score: string; periodX: number; periodY: number };
				corrections: unknown[];
			};
			expect(tile.command).toBe("tile");
			expect(tile.seam.horizontal).toEqual({
				raw: 325544,
				pairs: 16,
				score: "0.078226",
			});
			expect(tile.seam.vertical).toEqual({
				raw: 349288,
				pairs: 16,
				score: "0.083931",
			});
			expect(tile.seam.corner).toEqual({
				raw: 28383,
				pairs: 2,
				score: "0.054562",
			});
			expect(tile.repeat).toEqual({
				score: "0.913975",
				periodX: 2,
				periodY: 3,
			});
			expect(tile.corrections).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("tile --edge-match both correction matches the golden digest", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-blockwf-"));
		try {
			const base = await generateStoneBase(dir);
			const fixed = join(dir, "fixed.png");
			const result = await runCli([
				"--json",
				"tile",
				base,
				"--edge-match",
				"both",
				"--output",
				fixed,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			const corrected = body.result?.corrected as {
				seam: {
					horizontal: { raw: number };
					vertical: { raw: number };
				};
			};
			expect(corrected.seam.horizontal.raw).toBe(0);
			expect(corrected.seam.vertical.raw).toBe(0);
			expect(sha256(new Uint8Array(await readFile(fixed)))).toBe(
				GOLDEN_FIXED_SHA256,
			);
			const rerun = join(dir, "fixed-rerun.png");
			expect(
				(
					await runCli([
						"tile",
						base,
						"--edge-match",
						"both",
						"--output",
						rerun,
					])
				).code,
			).toBe(0);
			expect(sha256(new Uint8Array(await readFile(rerun)))).toBe(
				sha256(new Uint8Array(await readFile(fixed))),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("tile --preview 4x4 writes 64x64 and reruns identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-blockwf-"));
		try {
			const base = await generateStoneBase(dir);
			const first = join(dir, "prev.png");
			expect(
				(await runCli(["tile", base, "--preview", "4x4", "--output", first]))
					.code,
			).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(first)));
			expect(decoded.canvas.width).toBe(64);
			expect(decoded.canvas.height).toBe(64);
			const second = join(dir, "prev-rerun.png");
			expect(
				(await runCli(["tile", base, "--preview", "4x4", "--output", second]))
					.code,
			).toBe(0);
			expect(sha256(new Uint8Array(await readFile(second)))).toBe(
				sha256(new Uint8Array(await readFile(first))),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("tile report leaves the .mcpx input untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-blockwf-"));
		try {
			const source = join(dir, "t.mcpx");
			expect(
				(
					await runCli([
						"generate",
						STONE_PATTERN,
						"--size",
						STONE_SIZE,
						"--palette",
						STONE_PALETTE,
						"--seed",
						STONE_SEED,
						"--source",
						source,
					])
				).code,
			).toBe(0);
			const before = sha256(new Uint8Array(await readFile(source)));
			const report = await runCli(["--json", "tile", source]);
			expect(report.code).toBe(0);
			const tile = parseJsonStdout(report).result as {
				seam: Record<string, unknown>;
				repeat: Record<string, unknown>;
			};
			expect(Object.keys(tile.seam).sort()).toEqual([
				"corner",
				"horizontal",
				"vertical",
			]);
			expect(tile.repeat).toEqual({
				score: "0.913975",
				periodX: 2,
				periodY: 3,
			});
			expect(sha256(new Uint8Array(await readFile(source)))).toBe(before);
			const text = await readFile(source, "utf-8");
			expect(text).not.toContain("seam");
			expect(text).not.toContain("repeat");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("pixelize --preset block exports PNG; a .mcpx target is rejected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-blockwf-"));
		try {
			const base = await generateStoneBase(dir);
			const out = join(dir, "out.png");
			const result = await runCli([
				"--json",
				"pixelize",
				base,
				"--preset",
				"block",
				"--profile",
				"minecraft:block",
				"--size",
				"16",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			expect(body.success).toBe(true);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(16);
			expect(decoded.canvas.height).toBe(16);
			const rerun = join(dir, "out-rerun.png");
			expect(
				(
					await runCli([
						"pixelize",
						base,
						"--preset",
						"block",
						"--profile",
						"minecraft:block",
						"--size",
						"16",
						"--output",
						rerun,
					])
				).code,
			).toBe(0);
			expect(sha256(new Uint8Array(await readFile(rerun)))).toBe(
				sha256(new Uint8Array(await readFile(out))),
			);
			const before = await listAllFiles(dir);
			const rejected = await runCli([
				"--json",
				"pixelize",
				base,
				"--preset",
				"block",
				"--profile",
				"minecraft:block",
				"--size",
				"16",
				"--output",
				join(dir, "out.mcpx"),
			]);
			expect(rejected.code).toBe(5);
			expect(parseJsonStdout(rejected).error?.code).toBe(
				"UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT",
			);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("full chain reruns byte-identical and validate passes", async () => {
		const first = await mkdtemp(join(tmpdir(), "mc-asset-blockwf-a-"));
		const second = await mkdtemp(join(tmpdir(), "mc-asset-blockwf-b-"));
		try {
			async function runChain(dir: string): Promise<{
				base: string;
				fixed: string;
				final: string;
			}> {
				const base = await generateStoneBase(dir);
				const fixed = join(dir, "fixed.png");
				expect(
					(
						await runCli([
							"tile",
							base,
							"--edge-match",
							"both",
							"--output",
							fixed,
						])
					).code,
				).toBe(0);
				const final = join(dir, "out.png");
				expect(
					(
						await runCli([
							"pixelize",
							base,
							"--preset",
							"block",
							"--profile",
							"minecraft:block",
							"--size",
							"16",
							"--output",
							final,
						])
					).code,
				).toBe(0);
				return { base, fixed, final };
			}
			const a = await runChain(first);
			const b = await runChain(second);
			for (const key of ["base", "fixed", "final"] as const) {
				expect(sha256(new Uint8Array(await readFile(b[key])))).toBe(
					sha256(new Uint8Array(await readFile(a[key]))),
				);
			}
			for (const artifact of [a.fixed, a.final]) {
				const validated = await runCli([
					"--json",
					"validate",
					artifact,
					"--profile",
					"minecraft:block",
				]);
				expect(validated.code).toBe(0);
				const body = parseJsonStdout(validated);
				const verdict = body.result as {
					verdict: string;
					findings: { code: string }[];
				};
				expect(verdict.verdict).toBe("pass");
				expect(
					verdict.findings.filter((finding) => finding.code.includes("SEAM")),
				).toEqual([]);
			}
		} finally {
			await rm(first, { recursive: true, force: true });
			await rm(second, { recursive: true, force: true });
		}
	}, 120_000);
});
