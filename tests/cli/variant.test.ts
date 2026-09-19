import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng } from "../../src/io/png.ts";
import { parseMcpx } from "../../src/mcpx/index.ts";

/**
 * variant spawn coverage: one .mcpx source fans out to one PNG plus one
 * .mcpx per --materials entry under the explicit --output-dir.
 * Fixture: tests/cli/fixtures/sword.mcpx (self-made 4x4 pattern).
 */

const FIXTURES = "tests/cli/fixtures";
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");
const PNG_FIXTURE = join(FIXTURES, "px-8x8.png");

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

describe("variant wiring via spawn", () => {
	test("two materials produce four named files with readable contents", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-va-"));
		try {
			const outDir = join(dir, "out");
			const result = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron,copper",
				"--output-dir",
				outDir,
				"--mkdir",
			]);
			expect(result.code).toBe(0);
			expect(await listAllFiles(outDir)).toEqual([
				"sword_copper.mcpx",
				"sword_copper.png",
				"sword_iron.mcpx",
				"sword_iron.png",
			]);
			for (const material of ["iron", "copper"]) {
				const pngBytes = new Uint8Array(
					await readFile(join(outDir, `sword_${material}.png`)),
				);
				const decoded = decodePng(pngBytes);
				expect(decoded.canvas.width).toBe(4);
				expect(decoded.canvas.height).toBe(4);
				const mcpxText = await readFile(
					join(outDir, `sword_${material}.mcpx`),
					"utf-8",
				);
				const canvas = parseMcpx(mcpxText);
				expect(canvas.width).toBe(4);
				expect(canvas.height).toBe(4);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("rerun is byte-identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-va-"));
		try {
			const first = join(dir, "first");
			const second = join(dir, "second");
			expect(
				(
					await runCli([
						"variant",
						SWORD_MCPX,
						"--materials",
						"iron,copper",
						"--output-dir",
						first,
						"--mkdir",
					])
				).code,
			).toBe(0);
			expect(
				(
					await runCli([
						"variant",
						SWORD_MCPX,
						"--materials",
						"iron,copper",
						"--output-dir",
						second,
						"--mkdir",
					])
				).code,
			).toBe(0);
			for (const name of [
				"sword_iron.png",
				"sword_iron.mcpx",
				"sword_copper.png",
				"sword_copper.mcpx",
			]) {
				const a = sha256(new Uint8Array(await readFile(join(first, name))));
				const b = sha256(new Uint8Array(await readFile(join(second, name))));
				expect(b).toBe(a);
			}
			// Same directory with --force overwrites to identical bytes.
			expect(
				(
					await runCli([
						"variant",
						SWORD_MCPX,
						"--materials",
						"iron,copper",
						"--output-dir",
						first,
						"--force",
					])
				).code,
			).toBe(0);
			for (const name of [
				"sword_iron.png",
				"sword_iron.mcpx",
				"sword_copper.png",
				"sword_copper.mcpx",
			]) {
				const a = sha256(new Uint8Array(await readFile(join(first, name))));
				const b = sha256(new Uint8Array(await readFile(join(second, name))));
				expect(a).toBe(b);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("missing --output-dir is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-va-"));
		try {
			const before = await listAllFiles(dir);
			const result = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron,copper",
			]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--output alongside variant is ARGUMENT_CONFLICT", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-va-"));
		try {
			const outDir = join(dir, "out");
			const before = await listAllFiles(dir);
			const result = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron",
				"--output-dir",
				outDir,
				"--output",
				join(dir, "single.png"),
			]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("ARGUMENT_CONFLICT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("unknown material is INVALID_ARGUMENT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-va-"));
		try {
			const outDir = join(dir, "out");
			const before = await listAllFiles(dir);
			const result = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron,adamantine",
				"--output-dir",
				outDir,
				"--mkdir",
			]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("missing --materials is INVALID_ARGUMENT with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-va-"));
		try {
			const outDir = join(dir, "out");
			const before = await listAllFiles(dir);
			const result = await runCli([
				"variant",
				SWORD_MCPX,
				"--output-dir",
				outDir,
				"--mkdir",
			]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("non-mcpx source is rejected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-va-"));
		try {
			const outDir = join(dir, "out");
			const result = await runCli([
				"variant",
				PNG_FIXTURE,
				"--materials",
				"iron",
				"--output-dir",
				outDir,
				"--mkdir",
			]);
			expect(result.code).toBe(2);
			expect(combined(result)).toContain("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("missing parents need --mkdir, existing files need --force", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-va-"));
		try {
			const nested = join(dir, "a", "b", "out");
			const withoutMkdir = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron",
				"--output-dir",
				nested,
			]);
			expect(withoutMkdir.code).toBe(4);
			expect(combined(withoutMkdir)).toContain("FILESYSTEM_ERROR");
			expect(await listAllFiles(dir)).toEqual([]);
			const outDir = join(dir, "out");
			expect(
				(
					await runCli([
						"variant",
						SWORD_MCPX,
						"--materials",
						"iron",
						"--output-dir",
						outDir,
						"--mkdir",
					])
				).code,
			).toBe(0);
			await stat(join(outDir, "sword_iron.png"));
			await stat(join(outDir, "sword_iron.mcpx"));
			const exists = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"iron",
				"--output-dir",
				outDir,
			]);
			expect(exists.code).toBe(4);
			expect(combined(exists)).toContain("OUTPUT_EXISTS");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("--json reports the material file list", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-va-"));
		try {
			const outDir = join(dir, "out");
			const result = await runCli([
				"variant",
				SWORD_MCPX,
				"--materials",
				"gold",
				"--output-dir",
				outDir,
				"--mkdir",
				"--json",
			]);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: {
					command: string;
					materials: string[];
					outputDir: string;
					files: Array<{ material: string; png: string; mcpx: string }>;
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.command).toBe("variant");
			expect(envelope.result.materials).toEqual(["gold"]);
			expect(envelope.result.outputDir).toBe(outDir);
			expect(envelope.result.files).toHaveLength(1);
			expect(envelope.result.files[0]?.material).toBe("gold");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
