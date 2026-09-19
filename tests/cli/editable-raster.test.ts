import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng } from "../../src/io/png.ts";

const FIXTURES = "tests/cli/fixtures";
const JPG = join(FIXTURES, "px-8x8.jpg");
const WEBP = join(FIXTURES, "px-lossless.webp");

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

async function runCli(args: string[]): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: new Uint8Array(stdout), stderr };
}

describe("editable raster intake (PNG/JPEG/WebP) via spawn", () => {
	test("transform accepts jpeg and webp", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-er-"));
		try {
			for (const [name, input] of [
				["jpg", JPG],
				["webp", WEBP],
			] as const) {
				const out = join(dir, `t-${name}.png`);
				const result = await runCli([
					"transform",
					input,
					"--flip",
					"h",
					"--output",
					out,
				]);
				expect(result.code).toBe(0);
				const decoded = decodePng(new Uint8Array(await readFile(out)));
				expect(decoded.canvas.width).toBe(8);
				expect(decoded.canvas.height).toBe(8);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("quantize accepts jpeg and webp", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-er-"));
		try {
			for (const [name, input] of [
				["jpg", JPG],
				["webp", WEBP],
			] as const) {
				const out = join(dir, `q-${name}.png`);
				const result = await runCli([
					"quantize",
					input,
					"--colors",
					"4",
					"--output",
					out,
				]);
				expect(result.code).toBe(0);
				const decoded = decodePng(new Uint8Array(await readFile(out)));
				expect(decoded.canvas.width).toBe(8);
				expect(decoded.canvas.height).toBe(8);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("cleanup accepts jpeg and webp", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-er-"));
		try {
			for (const [name, input] of [
				["jpg", JPG],
				["webp", WEBP],
			] as const) {
				const out = join(dir, `c-${name}.png`);
				const result = await runCli(["cleanup", input, "--output", out]);
				expect(result.code).toBe(0);
				const decoded = decodePng(new Uint8Array(await readFile(out)));
				expect(decoded.canvas.width).toBe(8);
				expect(decoded.canvas.height).toBe(8);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("palette extract accepts jpeg and webp", async () => {
		for (const input of [JPG, WEBP]) {
			const result = await runCli(["palette", "extract", input, "--json"]);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
			};
			expect(envelope.success).toBe(true);
		}
	}, 60_000);

	test("truncated jpeg stays UNSUPPORTED_IMAGE_FORMAT with exit 5", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-er-"));
		try {
			const bytes = new Uint8Array(await readFile(JPG)).subarray(0, 20);
			const input = join(dir, "truncated.jpg");
			await writeFile(input, bytes);
			const out = join(dir, "never.png");
			const result = await runCli([
				"transform",
				input,
				"--flip",
				"h",
				"--output",
				out,
			]);
			expect(result.code).toBe(5);
			expect(combined(result)).toContain("UNSUPPORTED_IMAGE_FORMAT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("non-image bytes stay UNSUPPORTED_IMAGE_FORMAT with exit 5", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-er-"));
		try {
			const input = join(dir, "note.png");
			await writeFile(input, "not an image");
			const result = await runCli(["palette", "extract", input, "--json"]);
			expect(result.code).toBe(5);
			expect(combined(result)).toContain("UNSUPPORTED_IMAGE_FORMAT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
