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
import { decodePng, flattenCanvas } from "../../src/io/png.ts";
import { parseMcpx } from "../../src/mcpx/index.ts";
import { PNG_VECTORS } from "../io/png-cases.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const FIXTURES = "tests/cli/fixtures";
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");
const TINY_GRID = join(FIXTURES, "tiny.grid");
const BLANK16_GRID = join(FIXTURES, "blank16.grid");
const OPS_SET_RED = join(FIXTURES, "ops-set-red.json");
const OPS_EMPTY = join(FIXTURES, "ops-empty.json");
const OPS_BAD_COLOR = join(FIXTURES, "ops-bad-color.json");
const OPS_LINE = join(FIXTURES, "ops-line.json");

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

function pixelsEqual(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.from(a).equals(Buffer.from(b));
}

async function listAllFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true });
	return [...entries].sort();
}

async function writeVectorPng(dir: string): Promise<string> {
	const path = join(dir, "vector.png");
	await writeFile(path, Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64"));
	return path;
}

describe("cli write commands via spawn", () => {
	test("import decodes PNG and writes PNG plus mcpx", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const png = await writeVectorPng(dir);
			const copy = join(dir, "copy.png");
			const source = join(dir, "vector.mcpx");
			const result = await runCli([
				"import",
				png,
				"--output",
				copy,
				"--source",
				source,
			]);
			expect(result.code).toBe(0);
			const original = decodePng(new Uint8Array(await readFile(png)));
			const copied = decodePng(new Uint8Array(await readFile(copy)));
			expect(
				pixelsEqual(
					flattenCanvas(copied.canvas),
					flattenCanvas(original.canvas),
				),
			).toBe(true);
			const roundTripped = parseMcpx(await readFile(source, "utf-8"));
			expect(
				pixelsEqual(
					flattenCanvas(roundTripped),
					flattenCanvas(original.canvas),
				),
			).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("build renders mcpx to PNG with exact pixels", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const out = join(dir, "sword.png");
			const result = await runCli(["build", SWORD_MCPX, "--output", out]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(4);
			expect(decoded.canvas.height).toBe(4);
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

	test("render turns a hand grid into PNG with exact pixels", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const out = join(dir, "tiny.png");
			const result = await runCli(["render", TINY_GRID, "--output", out]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(4);
			expect(decoded.canvas.height).toBe(4);
			expect(getPixel(decoded.canvas, "base", 0, 0)).toEqual({
				r: 0,
				g: 0,
				b: 0,
				a: 0,
			});
			expect(getPixel(decoded.canvas, "base", 1, 0)).toEqual({
				r: 173,
				g: 183,
				b: 192,
				a: 255,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("from-zero 16x16 grid renders to a 16x16 PNG", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const out = join(dir, "blank16.png");
			const result = await runCli(["render", BLANK16_GRID, "--output", out]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(16);
			expect(decoded.canvas.height).toBe(16);
			expect(getPixel(decoded.canvas, "base", 15, 15)).toEqual({
				r: 0,
				g: 0,
				b: 0,
				a: 0,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--operations applies a pixel and reports it in the JSON envelope", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const out = join(dir, "op.png");
			const result = await runCli([
				"build",
				SWORD_MCPX,
				"--operations",
				OPS_SET_RED,
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
			expect(getPixel(decoded.canvas, "base", 0, 0)).toEqual({
				r: 255,
				g: 0,
				b: 0,
				a: 255,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--operations travels on the render path too", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const out = join(dir, "lined.png");
			const result = await runCli([
				"render",
				BLANK16_GRID,
				"--operations",
				OPS_LINE,
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(getPixel(decoded.canvas, "base", 0, 0)).toEqual({
				r: 255,
				g: 255,
				b: 255,
				a: 255,
			});
			expect(getPixel(decoded.canvas, "base", 3, 0)).toEqual({
				r: 255,
				g: 255,
				b: 255,
				a: 255,
			});
			expect(getPixel(decoded.canvas, "base", 4, 0)).toEqual({
				r: 0,
				g: 0,
				b: 0,
				a: 0,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("build accepts mcpx over stdin without temp files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const input = await readFile(SWORD_MCPX, "utf-8");
			const out = join(dir, "stdin.png");
			const before = await listAllFiles(dir);
			expect(before).toEqual([]);
			const result = await runCli(["build", "--stdin", "--output", out], input);
			expect(result.code).toBe(0);
			expect(await listAllFiles(dir)).toEqual(["stdin.png"]);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(4);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--operations - reads the batch from stdin", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const ops = await readFile(OPS_SET_RED, "utf-8");
			const out = join(dir, "op-stdin.png");
			const result = await runCli(
				["build", SWORD_MCPX, "--operations", "-", "--output", out],
				ops,
			);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(getPixel(decoded.canvas, "base", 0, 0)).toEqual({
				r: 255,
				g: 0,
				b: 0,
				a: 255,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("missing outputs is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const png = await writeVectorPng(dir);
			const before = await listAllFiles(dir);
			const first = await runCli(["import", png]);
			expect(first.code).toBe(2);
			expect(stdoutText(first) + first.stderr).toContain("OUTPUT_REQUIRED");
			const second = await runCli(["build", SWORD_MCPX]);
			expect(second.code).toBe(2);
			expect(stdoutText(second) + second.stderr).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("second write without --force is OUTPUT_EXISTS; --force overwrites", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const out = join(dir, "sword.png");
			expect((await runCli(["build", SWORD_MCPX, "--output", out])).code).toBe(
				0,
			);
			const refused = await runCli(["build", SWORD_MCPX, "--output", out]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			expect(
				(await runCli(["build", SWORD_MCPX, "--output", out, "--force"])).code,
			).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--in-place rewrites a file input; stdin input is rejected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const work = join(dir, "work.mcpx");
			await writeFile(work, await readFile(SWORD_MCPX, "utf-8"));
			const result = await runCli([
				"build",
				work,
				"--operations",
				OPS_SET_RED,
				"--in-place",
			]);
			expect(result.code).toBe(0);
			const rewritten = parseMcpx(await readFile(work, "utf-8"));
			expect(getPixel(rewritten, "base", 0, 0)).toEqual({
				r: 255,
				g: 0,
				b: 0,
				a: 255,
			});
			const input = await readFile(SWORD_MCPX, "utf-8");
			const before = await listAllFiles(dir);
			const stdinResult = await runCli(
				["build", "--stdin", "--in-place"],
				input,
			);
			expect(stdinResult.code).toBe(2);
			expect(stdoutText(stdinResult) + stdinResult.stderr).toContain(
				"INVALID_ARGUMENT",
			);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--force with --in-place is ARGUMENT_CONFLICT", async () => {
		const conflict = await runCli([
			"build",
			SWORD_MCPX,
			"--in-place",
			"--force",
		]);
		expect(conflict.code).toBe(2);
		expect(stdoutText(conflict) + conflict.stderr).toContain(
			"ARGUMENT_CONFLICT",
		);
	}, 30_000);

	test("--mkdir gates parent creation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const target = join(dir, "nope", "nested", "sword.png");
			const refused = await runCli(["build", SWORD_MCPX, "--output", target]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain(
				"FILESYSTEM_ERROR",
			);
			await expect(stat(join(dir, "nope"))).rejects.toThrow();
			const made = join(dir, "fresh", "nested", "sword.png");
			expect(
				(await runCli(["build", SWORD_MCPX, "--output", made, "--mkdir"])).code,
			).toBe(0);
			expect((await stat(made)).isFile()).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--stdout emits PNG bytes; --json --stdout keeps the envelope on stderr", async () => {
		const plain = await runCli(["render", TINY_GRID, "--stdout"]);
		expect(plain.code).toBe(0);
		expect([...plain.stdout.slice(0, 8)]).toEqual(PNG_SIGNATURE);
		const withJson = await runCli(["render", TINY_GRID, "--stdout", "--json"]);
		expect(withJson.code).toBe(0);
		expect([...withJson.stdout.slice(0, 8)]).toEqual(PNG_SIGNATURE);
		const envelope = JSON.parse(withJson.stderr) as { success: boolean };
		expect(envelope.success).toBe(true);
	}, 30_000);

	test("illegal operations JSON fails INVALID_ARGUMENT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const out = join(dir, "never.png");
			const result = await runCli([
				"build",
				SWORD_MCPX,
				"--operations",
				OPS_BAD_COLOR,
				"--output",
				out,
			]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("INVALID_ARGUMENT");
			await expect(stat(out)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("empty operations array succeeds as a no-op", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const out = join(dir, "noop.png");
			const result = await runCli([
				"build",
				SWORD_MCPX,
				"--operations",
				OPS_EMPTY,
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
			expect(envelope.result.applied).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("PNG to mcpx to PNG round-trips pixels", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const png = await writeVectorPng(dir);
			const source = join(dir, "vector.mcpx");
			const out = join(dir, "vector-out.png");
			expect((await runCli(["import", png, "--source", source])).code).toBe(0);
			expect((await runCli(["build", source, "--output", out])).code).toBe(0);
			const original = decodePng(new Uint8Array(await readFile(png)));
			const roundTripped = decodePng(new Uint8Array(await readFile(out)));
			expect(
				pixelsEqual(
					flattenCanvas(roundTripped.canvas),
					flattenCanvas(original.canvas),
				),
			).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("large grid smoke does not explode", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const rows = Array.from({ length: 256 }, () => ".".repeat(256));
			await writeFile(
				join(dir, "big.grid"),
				`[palette]\n. = transparent\n\n[grid]\n${rows.join("\n")}\n`,
			);
			const out = join(dir, "big.png");
			const result = await runCli([
				"render",
				join(dir, "big.grid"),
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(256);
			expect(decoded.canvas.height).toBe(256);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("minecraft profile rejects non-PNG output paths", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cmd-"));
		try {
			const out = join(dir, "tiny.webp");
			const result = await runCli([
				"render",
				TINY_GRID,
				"--profile",
				"minecraft:item",
				"--output",
				out,
			]);
			expect(result.code).toBe(5);
			expect(stdoutText(result) + result.stderr).toContain(
				"UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT",
			);
			await expect(stat(out)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
