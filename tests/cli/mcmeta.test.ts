import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMcpxText } from "../../src/cli/artifacts.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import type { RGBA } from "../../src/core/types.ts";
import { decodePng } from "../../src/io/png.ts";

/**
 * mcmeta wiring via spawn: `validate --mcmeta` plus
 * `animate validate --mcmeta` and `animate unpack --mcmeta`.
 * Sheets are packed from runtime-built .mcpx frames, so every byte on
 * disk comes from this repo; no Mojang assets are read.
 */

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

function mustResult(body: JsonEnvelope): Record<string, unknown> {
	const result = body.result as Record<string, unknown> | undefined;
	if (result === undefined) {
		throw new Error("expected a success envelope with a result");
	}
	return result;
}

function mustError(body: JsonEnvelope): { code?: string; details?: unknown } {
	if (body.error === undefined) {
		throw new Error("expected an error envelope");
	}
	return body.error;
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

function frameMcpx(color: RGBA, width: number, height: number): string {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels[i] = color.r;
		pixels[i + 1] = color.g;
		pixels[i + 2] = color.b;
		pixels[i + 3] = color.a;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return ensureMcpxText(canvas, () => {});
}

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBA = { r: 0, g: 255, b: 0, a: 255 };

/** Pack solid frames vertically and return the sheet path. */
async function packVerticalSheet(
	dir: string,
	colors: RGBA[],
	frameWidth: number,
	frameHeight: number,
	name = "sheet",
): Promise<{ sheet: string; framesDir: string }> {
	const framesDir = join(dir, `${name}-frames`);
	await mkdir(framesDir, { recursive: true });
	for (let i = 0; i < colors.length; i += 1) {
		await writeFile(
			join(framesDir, `frame_${i}.mcpx`),
			frameMcpx(colors[i] as RGBA, frameWidth, frameHeight),
		);
	}
	const sheet = join(dir, `${name}.png`);
	const packed = await runCli([
		"animate",
		"pack",
		"--frames-dir",
		framesDir,
		"--layout",
		"vertical",
		"--output",
		sheet,
	]);
	expect(packed.code).toBe(0);
	return { sheet, framesDir };
}

describe("mcmeta wiring via spawn", () => {
	test("validate --mcmeta passes and leaves PNG and mcmeta bytes alone", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { sheet } = await packVerticalSheet(
				dir,
				[RED, GREEN, RED, GREEN],
				32,
				32,
			);
			expect(
				decodePng(new Uint8Array(await readFile(sheet))).canvas.width,
			).toBe(32);
			const mcmeta = join(dir, "sheet.mcmeta");
			await writeFile(
				mcmeta,
				JSON.stringify({
					texture: { mipmap_strategy: "mean", alpha_cutoff_bias: 0 },
					animation: {
						frametime: 2,
						interpolate: false,
						width: 32,
						height: 32,
						frames: [0, 1, 2, 3],
					},
				}),
			);
			const pngBefore = sha256(new Uint8Array(await readFile(sheet)));
			const mcmetaBefore = sha256(new Uint8Array(await readFile(mcmeta)));
			const result = await runCli([
				"--json",
				"validate",
				sheet,
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			expect(body.success).toBe(true);
			const outcome = mustResult(body);
			expect(outcome.verdict).toBe("pass");
			const info = outcome.mcmeta as Record<string, unknown>;
			expect(info).toBeDefined();
			expect(pngBefore).toBe(sha256(new Uint8Array(await readFile(sheet))));
			expect(mcmetaBefore).toBe(sha256(new Uint8Array(await readFile(mcmeta))));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("validate --mcmeta reports the mipmap section in human text", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { sheet } = await packVerticalSheet(dir, [RED, GREEN], 4, 4);
			const mcmeta = join(dir, "sheet.mcmeta");
			await writeFile(
				mcmeta,
				JSON.stringify({
					texture: { mipmap_strategy: "mean", alpha_cutoff_bias: 0 },
					animation: { width: 4, height: 4, frames: [0, 1] },
				}),
			);
			const result = await runCli(["validate", sheet, "--mcmeta", mcmeta]);
			expect(result.code).toBe(0);
			const text = stdoutText(result);
			expect(text).toContain("mipmap");
			expect(text).toContain("mean");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("validate --mcmeta rejects an out-of-range frame index with details.path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { sheet } = await packVerticalSheet(
				dir,
				[RED, GREEN, RED, GREEN],
				32,
				32,
			);
			const mcmeta = join(dir, "sheet.mcmeta");
			await writeFile(
				mcmeta,
				JSON.stringify({
					animation: { width: 32, height: 32, frames: [0, 1, { index: 4 }] },
				}),
			);
			const before = await listAllFiles(dir);
			const result = await runCli([
				"--json",
				"validate",
				sheet,
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(2);
			const body = parseJsonStdout(result);
			expect(mustError(body).code).toBe("INVALID_ANIMATION_FRAME");
			const details = mustError(body).details as Record<string, unknown>;
			expect(details.path).toBe("animation.frames[2].index");
			expect(details.index).toBe(4);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("validate --mcmeta maps unreadable JSON to INVALID_MCMETA", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { sheet } = await packVerticalSheet(dir, [RED, GREEN], 4, 4);
			const mcmeta = join(dir, "sheet.mcmeta");
			await writeFile(mcmeta, "{not json");
			const result = await runCli([
				"--json",
				"validate",
				sheet,
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(2);
			expect(mustError(parseJsonStdout(result)).code).toBe("INVALID_MCMETA");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("animate validate --mcmeta passes a repeated-index playback sequence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { framesDir } = await packVerticalSheet(dir, [RED, GREEN], 4, 4);
			const mcmeta = join(dir, "anim.mcmeta");
			await writeFile(
				mcmeta,
				JSON.stringify({
					animation: { width: 4, height: 4, frames: [0, 1, 1] },
				}),
			);
			const result = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			expect(mustResult(parseJsonStdout(result)).verdict).toBe("pass");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("animate validate --mcmeta passes playback sequence [0,1,0] with per-step time", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { framesDir } = await packVerticalSheet(dir, [RED, GREEN], 4, 4);
			const mcmeta = join(dir, "anim.mcmeta");
			await writeFile(
				mcmeta,
				JSON.stringify({
					animation: {
						width: 4,
						height: 4,
						frames: [0, { index: 1, time: 3 }, 0],
					},
				}),
			);
			const result = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			expect(mustResult(parseJsonStdout(result)).verdict).toBe("pass");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("animate validate --mcmeta passes a partial-frame playback sequence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { framesDir } = await packVerticalSheet(
				dir,
				[RED, GREEN, RED, GREEN],
				4,
				4,
			);
			const mcmeta = join(dir, "anim.mcmeta");
			await writeFile(
				mcmeta,
				JSON.stringify({
					animation: { width: 4, height: 4, frames: [0, 2] },
				}),
			);
			const result = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			expect(mustResult(parseJsonStdout(result)).verdict).toBe("pass");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("validate, animate validate and animate unpack agree on a repeated-index sequence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { sheet, framesDir } = await packVerticalSheet(
				dir,
				[RED, GREEN],
				4,
				4,
			);
			const mcmeta = join(dir, "anim.mcmeta");
			await writeFile(
				mcmeta,
				JSON.stringify({
					animation: { width: 4, height: 4, frames: [0, 1, 0] },
				}),
			);
			const single = await runCli([
				"--json",
				"validate",
				sheet,
				"--mcmeta",
				mcmeta,
			]);
			expect(single.code).toBe(0);
			expect(mustResult(parseJsonStdout(single)).verdict).toBe("pass");
			const animateValidate = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
				"--mcmeta",
				mcmeta,
			]);
			expect(animateValidate.code).toBe(0);
			expect(mustResult(parseJsonStdout(animateValidate)).verdict).toBe("pass");
			const outDir = join(dir, "unpacked");
			const unpack = await runCli([
				"--json",
				"animate",
				"unpack",
				sheet,
				"--layout",
				"vertical",
				"--frame-size",
				"4x4",
				"--output-dir",
				outDir,
				"--mkdir",
				"--mcmeta",
				mcmeta,
			]);
			expect(unpack.code).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("animate validate --mcmeta passes the matching geometry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { framesDir } = await packVerticalSheet(dir, [RED, GREEN], 4, 4);
			const mcmeta = join(dir, "anim.mcmeta");
			await writeFile(
				mcmeta,
				JSON.stringify({
					animation: { width: 4, height: 4, frames: [0, 1] },
				}),
			);
			const result = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			expect(mustResult(parseJsonStdout(result)).verdict).toBe("pass");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("animate unpack --mcmeta refuses geometry drift with zero writes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcmeta-"));
		try {
			const { sheet } = await packVerticalSheet(dir, [RED, GREEN], 4, 4);
			const mcmeta = join(dir, "anim.mcmeta");
			await writeFile(
				mcmeta,
				JSON.stringify({ animation: { width: 2, height: 2 } }),
			);
			const outDir = join(dir, "unpacked");
			const before = await listAllFiles(dir);
			const result = await runCli([
				"--json",
				"animate",
				"unpack",
				sheet,
				"--layout",
				"vertical",
				"--frame-size",
				"4x4",
				"--output-dir",
				outDir,
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(2);
			expect(mustError(parseJsonStdout(result)).code).toBe(
				"INVALID_ANIMATION_FRAME",
			);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);
});
