import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
import { decodePng } from "../../src/io/png.ts";

/**
 * pixelize spawn coverage. Fixture provenance: see
 * tests/io/decode-cases.ts (self-made 8x8 pattern, jpeg-js q90,
 * cwebp lossless-exact and lossy q80; no Mojang assets).
 */

const FIXTURES = "tests/cli/fixtures";
const PNG = join(FIXTURES, "px-8x8.png");
const JPG = join(FIXTURES, "px-8x8.jpg");
const WEBP_LOSSLESS = join(FIXTURES, "px-lossless.webp");
const WEBP_LOSSY = join(FIXTURES, "px-lossy-q80.webp");

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

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
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

describe("pixelize wiring via spawn", () => {
	test("png to 16x16 exists, is sized, and reruns byte-identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const out = join(dir, "px.png");
			const first = await runCli([
				"pixelize",
				PNG,
				"--size",
				"16",
				"--output",
				out,
			]);
			expect(first.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(16);
			expect(decoded.canvas.height).toBe(16);
			const once = sha256(new Uint8Array(await readFile(out)));
			const out2 = join(dir, "px2.png");
			expect(
				(await runCli(["pixelize", PNG, "--size", "16", "--output", out2]))
					.code,
			).toBe(0);
			expect(sha256(new Uint8Array(await readFile(out2)))).toBe(once);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("jpeg input decodes to the requested size", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const out = join(dir, "jpg.png");
			const result = await runCli([
				"pixelize",
				JPG,
				"--size",
				"16",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(16);
			expect(decoded.canvas.height).toBe(16);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("lossless webp decodes to the requested size, rerun identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const out = join(dir, "webp.png");
			const result = await runCli([
				"pixelize",
				WEBP_LOSSLESS,
				"--size",
				"16",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(16);
			expect(decoded.canvas.height).toBe(16);
			const once = sha256(new Uint8Array(await readFile(out)));
			const rerun = join(dir, "webp-rerun.png");
			expect(
				(
					await runCli([
						"pixelize",
						WEBP_LOSSLESS,
						"--size",
						"16",
						"--output",
						rerun,
					])
				).code,
			).toBe(0);
			expect(sha256(new Uint8Array(await readFile(rerun)))).toBe(once);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("lossy webp input decodes successfully", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const out = join(dir, "lossy.png");
			const result = await runCli([
				"pixelize",
				WEBP_LOSSY,
				"--size",
				"32",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(32);
			expect(decoded.canvas.height).toBe(32);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("three output modes each stand alone", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const onlyPng = join(dir, "a.png");
			expect(
				(await runCli(["pixelize", PNG, "--size", "16", "--output", onlyPng]))
					.code,
			).toBe(0);
			await stat(onlyPng);
			const bothPng = join(dir, "b.png");
			const bothMcpx = join(dir, "b.mcpx");
			const both = await runCli([
				"pixelize",
				PNG,
				"--size",
				"16",
				"--output",
				bothPng,
				"--source",
				bothMcpx,
			]);
			expect(both.code).toBe(0);
			await stat(bothPng);
			await stat(bothMcpx);
			const onlyMcpx = join(dir, "c.mcpx");
			expect(
				(await runCli(["pixelize", PNG, "--size", "16", "--source", onlyMcpx]))
					.code,
			).toBe(0);
			await stat(onlyMcpx);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("minecraft profile rejects a non-png output extension", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const out = join(dir, "tex.bin");
			const before = await listAllFiles(dir);
			const result = await runCli([
				"pixelize",
				PNG,
				"--size",
				"16",
				"--output",
				out,
				"--profile",
				"minecraft:item",
			]);
			expect(result.code).toBe(5);
			expect(combined(result)).toContain(
				"UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT",
			);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("missing output is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const before = await listAllFiles(dir);
			const result = await runCli(["pixelize", PNG, "--size", "16"]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("corrupt input maps to the existing format error with exit 5", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const bad = join(dir, "bad.png");
			await writeFile(bad, "this is not image data");
			const out = join(dir, "never.png");
			const result = await runCli([
				"pixelize",
				bad,
				"--size",
				"16",
				"--output",
				out,
			]);
			expect(result.code).toBe(5);
			expect(combined(result)).toContain("UNSUPPORTED_IMAGE_FORMAT");
			await expect(stat(out)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("presets are deterministic and the unknown name is rejected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const digests: Record<string, string> = {};
			for (const preset of ["item", "block", "generic"]) {
				const out = join(dir, `${preset}.png`);
				const result = await runCli([
					"pixelize",
					PNG,
					"--size",
					"16",
					"--preset",
					preset,
					"--output",
					out,
					"--json",
				]);
				expect(result.code).toBe(0);
				digests[preset] = sha256(new Uint8Array(await readFile(out)));
				const envelope = JSON.parse(stdoutText(result)) as {
					success: boolean;
					result: { command: string; preset: string };
				};
				expect(envelope.success).toBe(true);
				expect(envelope.result.command).toBe("pixelize");
				expect(envelope.result.preset).toBe(preset);
				const rerun = join(dir, `${preset}-rerun.png`);
				expect(
					(
						await runCli([
							"pixelize",
							PNG,
							"--size",
							"16",
							"--preset",
							preset,
							"--output",
							rerun,
						])
					).code,
				).toBe(0);
				expect(sha256(new Uint8Array(await readFile(rerun)))).toBe(
					digests[preset] as string,
				);
			}
			const bad = await runCli([
				"pixelize",
				PNG,
				"--size",
				"16",
				"--preset",
				"retro",
				"--stdout",
			]);
			expect(bad.code).toBe(2);
			expect(combined(bad)).toContain("INVALID_ARGUMENT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("missing --size is INVALID_ARGUMENT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const out = join(dir, "never.png");
			const before = await listAllFiles(dir);
			const result = await runCli(["pixelize", PNG, "--output", out]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("non-standard size warns but still writes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-px-"));
		try {
			const out = join(dir, "custom.png");
			const result = await runCli([
				"pixelize",
				PNG,
				"--size",
				"24x12",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			expect(combined(result)).toContain("NON_STANDARD_RESOLUTION");
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(24);
			expect(decoded.canvas.height).toBe(12);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
