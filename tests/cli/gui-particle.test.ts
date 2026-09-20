import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng } from "../../src/io/png.ts";

/**
 * minecraft:gui / minecraft:particle profile and pixelize gui/particle
 * preset spawn coverage. Inputs reuse the shared 8x8 fixture (no Mojang
 * assets); assertions stay on CLI behavior (profile accepted, PNG-only
 * gate, preset parse/print/determinism) rather than art values.
 */

const FIXTURES = "tests/cli/fixtures";
const PNG = join(FIXTURES, "px-8x8.png");

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

describe("gui and particle profiles via spawn", () => {
	test("--profile minecraft:gui and minecraft:particle shape reports", async () => {
		for (const profile of ["minecraft:gui", "minecraft:particle"]) {
			const result = await runCli([
				"--json",
				"preview",
				PNG,
				"--palette-map",
				"--profile",
				profile,
			]);
			expect(result.code).toBe(0);
			const body = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: { profile: string };
			};
			expect(body.success).toBe(true);
			expect(body.result.profile).toBe(profile);
		}
	}, 30_000);

	test("gui and particle outputs are PNG-only", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gp-"));
		try {
			for (const profile of ["minecraft:gui", "minecraft:particle"]) {
				const before = await listAllFiles(dir);
				const pixelize = await runCli([
					"pixelize",
					PNG,
					"--size",
					"16",
					"--output",
					join(dir, `${profile === "minecraft:gui" ? "gui" : "particle"}.bin`),
					"--profile",
					profile,
				]);
				expect(pixelize.code).toBe(5);
				expect(combined(pixelize)).toContain(
					"UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT",
				);
				expect(await listAllFiles(dir)).toEqual(before);
				const scaled = await runCli([
					"--json",
					"preview",
					PNG,
					"--scale",
					"2",
					"--output",
					join(dir, "scaled.bin"),
					"--profile",
					profile,
				]);
				expect(scaled.code).toBe(5);
				expect(combined(scaled)).toContain(
					"UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT",
				);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("pixelize gui and particle presets parse, print, and rerun identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gp-"));
		try {
			for (const preset of ["gui", "particle"]) {
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
				const envelope = JSON.parse(stdoutText(result)) as {
					success: boolean;
					result: {
						command: string;
						preset: string;
						presetDetail: string;
						stages: string[];
					};
				};
				expect(envelope.success).toBe(true);
				expect(envelope.result.command).toBe("pixelize");
				expect(envelope.result.preset).toBe(preset);
				expect(envelope.result.presetDetail).toContain(`preset=${preset}`);
				// The frozen eleven-stage pipeline order never changes per preset.
				expect(envelope.result.stages).toEqual([
					"decode",
					"crop",
					"background",
					"subject",
					"resize",
					"edge",
					"quantize",
					"cluster",
					"cleanup",
					"preset",
					"output",
				]);
				// The gui preset never synthesizes nine-slice metadata.
				expect("nineSlice" in envelope.result).toBe(false);
				expect("scaling" in envelope.result).toBe(false);
				const once = sha256(new Uint8Array(await readFile(out)));
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
				expect(sha256(new Uint8Array(await readFile(rerun)))).toBe(once);
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

	test("particle preset never pins a size and profiles never reject one", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gp-"));
		try {
			const out = join(dir, "particle-custom.png");
			const result = await runCli([
				"pixelize",
				PNG,
				"--size",
				"24x12",
				"--preset",
				"particle",
				"--profile",
				"minecraft:particle",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(24);
			expect(decoded.canvas.height).toBe(12);
			const gui = join(dir, "gui-custom.png");
			const guiResult = await runCli([
				"pixelize",
				PNG,
				"--size",
				"20x10",
				"--preset",
				"gui",
				"--profile",
				"minecraft:gui",
				"--output",
				gui,
			]);
			expect(guiResult.code).toBe(0);
			const guiDecoded = decodePng(new Uint8Array(await readFile(gui)));
			expect(guiDecoded.canvas.width).toBe(20);
			expect(guiDecoded.canvas.height).toBe(10);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
