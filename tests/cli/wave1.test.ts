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
import { getPixel } from "../../src/core/canvas.ts";
import { isPixelSelected, resolveSelection } from "../../src/core/selection.ts";
import { decodePng } from "../../src/io/png.ts";
import { parseMcpx } from "../../src/mcpx/index.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const FIXTURES = "tests/cli/fixtures";
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");
const OPS_LAYERS = join(FIXTURES, "ops-layers.json");
const OPS_GEOMETRY = join(FIXTURES, "ops-geometry.json");

interface SpawnResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

function stdoutText(result: SpawnResult): string {
	return Buffer.from(result.stdout).toString("utf-8");
}

function combined(result: SpawnResult): string {
	return stdoutText(result) + result.stderr;
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

describe("wave1 wiring via spawn", () => {
	test("transform --crop writes exact pixels", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "crop.png");
			const result = await runCli([
				"transform",
				SWORD_MCPX,
				"--crop",
				"0,0,2,2",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(2);
			expect(decoded.canvas.height).toBe(2);
			expect(getPixel(decoded.canvas, "base", 0, 0)).toEqual({
				r: 0,
				g: 0,
				b: 0,
				a: 0,
			});
			expect(getPixel(decoded.canvas, "base", 1, 0)).toEqual({
				r: 255,
				g: 0,
				b: 0,
				a: 255,
			});
			expect(getPixel(decoded.canvas, "base", 0, 1)).toEqual({
				r: 255,
				g: 0,
				b: 0,
				a: 255,
			});
			expect(getPixel(decoded.canvas, "base", 1, 1)).toEqual({
				r: 0,
				g: 255,
				b: 0,
				a: 255,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("transform --flip writes a same-size PNG", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "flip.png");
			const result = await runCli([
				"transform",
				SWORD_MCPX,
				"--flip",
				"h",
				"--output",
				out,
				"--json",
			]);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: { command: string };
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.command).toBe("transform");
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(4);
			expect(decoded.canvas.height).toBe(4);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("transform without geometry is INVALID_ARGUMENT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "never.png");
			const before = await listAllFiles(dir);
			const result = await runCli(["transform", SWORD_MCPX, "--output", out]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("transform with two geometries is ARGUMENT_CONFLICT", async () => {
		const result = await runCli([
			"transform",
			SWORD_MCPX,
			"--flip",
			"h",
			"--rotate",
			"90",
			"--stdout",
		]);
		expect(result.code).toBe(2);
		expect(combined(result)).toContain("ARGUMENT_CONFLICT");
	}, 30_000);

	test("transform --selection with geometry is ARGUMENT_CONFLICT", async () => {
		const result = await runCli([
			"transform",
			SWORD_MCPX,
			"--flip",
			"h",
			"--selection",
			"rect:0,0,2,2",
			"--stdout",
		]);
		expect(result.code).toBe(2);
		expect(combined(result)).toContain("ARGUMENT_CONFLICT");
	}, 30_000);

	test("transform missing output is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const before = await listAllFiles(dir);
			const result = await runCli(["transform", SWORD_MCPX, "--flip", "h"]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("transform second write without --force is OUTPUT_EXISTS", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "t.png");
			expect(
				(
					await runCli([
						"transform",
						SWORD_MCPX,
						"--flip",
						"h",
						"--output",
						out,
					])
				).code,
			).toBe(0);
			const refused = await runCli([
				"transform",
				SWORD_MCPX,
				"--flip",
				"h",
				"--output",
				out,
			]);
			expect(refused.code).toBe(4);
			expect(combined(refused)).toContain("OUTPUT_EXISTS");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("quantize --colors writes a PNG within the color budget", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "q.png");
			const result = await runCli([
				"quantize",
				SWORD_MCPX,
				"--colors",
				"2",
				"--output",
				out,
				"--json",
			]);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: { command: string; colors: number };
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.command).toBe("quantize");
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(4);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("quantize without --colors is INVALID_ARGUMENT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "never.png");
			const before = await listAllFiles(dir);
			const result = await runCli(["quantize", SWORD_MCPX, "--output", out]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("quantize --selection keeps outside pixels byte-identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "qs.png");
			const result = await runCli([
				"quantize",
				SWORD_MCPX,
				"--colors",
				"1",
				"--selection",
				"rect:0,0,2,2",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const before = parseMcpx(await readFile(SWORD_MCPX, "utf-8"));
			const after = decodePng(new Uint8Array(await readFile(out)));
			expect(getPixel(after.canvas, "base", 3, 3)).toEqual(
				getPixel(before, "base", 3, 3),
			);
			expect(getPixel(after.canvas, "base", 3, 0)).toEqual(
				getPixel(before, "base", 3, 0),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("quantize --selection accepts new atoms and JSON expressions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			for (const [name, selection] of [
				["qa.png", "alpha:base"],
				[
					"qe.png",
					'{"op":"subtract","operands":["rect:0,0,4,4","rect:0,0,2,2"]}',
				],
			] as Array<[string, string]>) {
				const out = join(dir, name);
				const result = await runCli([
					"quantize",
					SWORD_MCPX,
					"--colors",
					"1",
					"--selection",
					selection,
					"--output",
					out,
				]);
				expect(result.code).toBe(0);
				const before = parseMcpx(await readFile(SWORD_MCPX, "utf-8"));
				const scope = resolveSelection(before, selection);
				const after = decodePng(new Uint8Array(await readFile(out)));
				for (let y = 0; y < 4; y += 1) {
					for (let x = 0; x < 4; x += 1) {
						if (!isPixelSelected(scope, before, x, y)) {
							expect(getPixel(after.canvas, "base", x, y)).toEqual(
								getPixel(before, "base", x, y),
							);
						}
					}
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("pixelize --selection stays ARGUMENT_CONFLICT", async () => {
		const result = await runCli([
			"pixelize",
			SWORD_MCPX,
			"--selection",
			"rect:0,0,2,2",
			"--stdout",
		]);
		expect(result.code).toBe(2);
		expect(combined(result)).toContain("ARGUMENT_CONFLICT");
	}, 30_000);

	test("cleanup without --fix writes the artifact unchanged", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "c.png");
			const result = await runCli([
				"cleanup",
				SWORD_MCPX,
				"--output",
				out,
				"--json",
			]);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: { command: string; modifiedPixels: number };
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.modifiedPixels).toBe(0);
			const before = parseMcpx(await readFile(SWORD_MCPX, "utf-8"));
			const after = decodePng(new Uint8Array(await readFile(out)));
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					expect(getPixel(after.canvas, "base", x, y)).toEqual(
						getPixel(before, "base", x, y),
					);
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("cleanup alpha class without authorization writes nothing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "never.png");
			const before = await listAllFiles(dir);
			const result = await runCli([
				"cleanup",
				SWORD_MCPX,
				"--fix",
				"isolated",
				"--output",
				out,
			]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("cleanup outlier fix needs no render-pass authorization", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "cout.png");
			const result = await runCli([
				"cleanup",
				SWORD_MCPX,
				"--fix",
				"outlier",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			await stat(out);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("cleanup unknown class is INVALID_ARGUMENT", async () => {
		const result = await runCli([
			"cleanup",
			SWORD_MCPX,
			"--fix",
			"smudge",
			"--stdout",
		]);
		expect(result.code).toBe(2);
		expect(combined(result)).toContain("INVALID_ARGUMENT");
	}, 30_000);

	test("palette extract reports colors as JSON", async () => {
		const result = await runCli(["palette", "extract", SWORD_MCPX, "--json"]);
		expect(result.code).toBe(0);
		const envelope = JSON.parse(stdoutText(result)) as {
			success: boolean;
			result: { command: string; colorCount: number };
		};
		expect(envelope.success).toBe(true);
		expect(envelope.result.command).toBe("palette");
		expect(envelope.result.colorCount).toBe(3);
	}, 30_000);

	test("palette inspect reports the frozen shape", async () => {
		const result = await runCli(["palette", "inspect", SWORD_MCPX, "--json"]);
		expect(result.code).toBe(0);
		const envelope = JSON.parse(stdoutText(result)) as {
			success: boolean;
			result: { colorCount: number; transparentPixels: number };
		};
		expect(envelope.success).toBe(true);
		expect(envelope.result.colorCount).toBe(3);
		expect(envelope.result.transparentPixels).toBe(4);
	}, 30_000);

	test("palette rejects file flags as INVALID_ARGUMENT", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "never.png");
			const result = await runCli([
				"palette",
				"extract",
				SWORD_MCPX,
				"--output",
				out,
			]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			await expect(stat(out)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("material list reports the seven builtins", async () => {
		const result = await runCli(["material", "list", "--json"]);
		expect(result.code).toBe(0);
		const envelope = JSON.parse(stdoutText(result)) as {
			success: boolean;
			result: { materials: string[] };
		};
		expect(envelope.success).toBe(true);
		expect(envelope.result.materials).toEqual([
			"iron",
			"copper",
			"oxidized_copper",
			"gold",
			"wood",
			"stone",
			"crystal",
		]);
	}, 30_000);

	test("material show reports one definition; unknown is INVALID_ARGUMENT", async () => {
		const shown = await runCli(["material", "show", "iron", "--json"]);
		expect(shown.code).toBe(0);
		const envelope = JSON.parse(stdoutText(shown)) as {
			success: boolean;
			result: { id: string };
		};
		expect(envelope.success).toBe(true);
		expect(envelope.result.id).toBe("iron");
		const missing = await runCli(["material", "show", "mithril", "--json"]);
		expect(missing.code).toBe(2);
		expect(combined(missing)).toContain("INVALID_ARGUMENT");
	}, 30_000);

	test("material rejects file flags as INVALID_ARGUMENT", async () => {
		const result = await runCli(["material", "list", "--output", "never.png"]);
		expect(result.code).toBe(2);
		expect(combined(result)).toContain("INVALID_ARGUMENT");
	}, 30_000);

	test("recolor --material writes a PNG", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "r.png");
			const result = await runCli([
				"recolor",
				SWORD_MCPX,
				"--material",
				"copper",
				"--output",
				out,
				"--json",
			]);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: { command: string; material: string };
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.material).toBe("copper");
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(4);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("recolor without --material is INVALID_ARGUMENT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "never.png");
			const before = await listAllFiles(dir);
			const result = await runCli(["recolor", SWORD_MCPX, "--output", out]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("recolor unknown material is INVALID_ARGUMENT", async () => {
		const result = await runCli([
			"recolor",
			SWORD_MCPX,
			"--material",
			"mithril",
			"--stdout",
		]);
		expect(result.code).toBe(2);
		expect(combined(result)).toContain("INVALID_ARGUMENT");
	}, 30_000);

	test("recolor missing region is REGION_NOT_FOUND", async () => {
		const result = await runCli([
			"recolor",
			SWORD_MCPX,
			"--material",
			"copper",
			"--region",
			"blade",
			"--stdout",
		]);
		expect(result.code).toBe(2);
		expect(combined(result)).toContain("REGION_NOT_FOUND");
	}, 30_000);

	test("recolor missing output is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const before = await listAllFiles(dir);
			const result = await runCli([
				"recolor",
				SWORD_MCPX,
				"--material",
				"copper",
			]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--stdout emits PNG bytes with the envelope on stderr under --json", async () => {
		const plain = await runCli([
			"quantize",
			SWORD_MCPX,
			"--colors",
			"2",
			"--stdout",
		]);
		expect(plain.code).toBe(0);
		expect([...plain.stdout.slice(0, 8)]).toEqual(PNG_SIGNATURE);
		const withJson = await runCli([
			"quantize",
			SWORD_MCPX,
			"--colors",
			"2",
			"--stdout",
			"--json",
		]);
		expect(withJson.code).toBe(0);
		expect([...withJson.stdout.slice(0, 8)]).toEqual(PNG_SIGNATURE);
		const envelope = JSON.parse(withJson.stderr) as { success: boolean };
		expect(envelope.success).toBe(true);
	}, 30_000);

	test("--mkdir gates parent creation on wave1 commands", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const target = join(dir, "nope", "nested", "q.png");
			const refused = await runCli([
				"quantize",
				SWORD_MCPX,
				"--colors",
				"2",
				"--output",
				target,
			]);
			expect(refused.code).toBe(4);
			expect(combined(refused)).toContain("FILESYSTEM_ERROR");
			await expect(stat(join(dir, "nope"))).rejects.toThrow();
			const made = join(dir, "fresh", "nested", "q.png");
			expect(
				(
					await runCli([
						"quantize",
						SWORD_MCPX,
						"--colors",
						"2",
						"--output",
						made,
						"--mkdir",
					])
				).code,
			).toBe(0);
			expect((await stat(made)).isFile()).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--operations layer vocabulary runs on build", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const source = join(dir, "layered.mcpx");
			const result = await runCli([
				"build",
				SWORD_MCPX,
				"--operations",
				OPS_LAYERS,
				"--source",
				source,
				"--json",
			]);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: { applied: number };
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.applied).toBe(3);
			const canvas = parseMcpx(await readFile(source, "utf-8"));
			expect(canvas.layers.map((layer) => layer.id)).toEqual(["base", "shade"]);
			expect(getPixel(canvas, "shade", 0, 0)).toEqual({
				r: 0,
				g: 0,
				b: 255,
				a: 255,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--operations rejects geometry vocabulary as INVALID_ARGUMENT", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const out = join(dir, "never.png");
			const result = await runCli([
				"build",
				SWORD_MCPX,
				"--operations",
				OPS_GEOMETRY,
				"--output",
				out,
			]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			await expect(stat(out)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("wave1 --in-place rewrites the input source", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-w1-"));
		try {
			const work = join(dir, "work.mcpx");
			await writeFile(work, await readFile(SWORD_MCPX, "utf-8"));
			const result = await runCli([
				"quantize",
				work,
				"--colors",
				"2",
				"--in-place",
			]);
			expect(result.code).toBe(0);
			const rewritten = parseMcpx(await readFile(work, "utf-8"));
			expect(rewritten.width).toBe(4);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
