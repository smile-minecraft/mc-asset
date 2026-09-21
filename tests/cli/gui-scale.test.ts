import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { decodePng, encodePng } from "../../src/io/png.ts";

/**
 * gui-scale spawn coverage. Sprites are generated at runtime with the
 * frozen PNG codec (no Mojang assets): stretch defaults, tile repeats,
 * nine_slice corners/inner geometry, version gating of stretch_inner,
 * and the error paths.
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

async function writeSprite(
	dir: string,
	name: string,
	width: number,
	height: number,
): Promise<string> {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			pixels[offset] = (x * 16) % 256;
			pixels[offset + 1] = (y * 16) % 256;
			pixels[offset + 2] = (x + y) % 256;
			pixels[offset + 3] = 255;
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	const path = join(dir, name);
	await writeFile(path, encodePng(canvas));
	return path;
}

async function writeMcmeta(
	dir: string,
	name: string,
	doc: unknown,
): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, JSON.stringify(doc));
	return path;
}

function pixelOf(
	canvas: { width: number; layers: Array<{ pixels: Uint8Array }> },
	x: number,
	y: number,
): number[] {
	const pixels = canvas.layers[0]?.pixels ?? new Uint8Array();
	return [
		...pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4),
	];
}

describe("gui-scale via spawn", () => {
	test("missing mcmeta stretches with nearest mapping", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gui-"));
		try {
			const input = await writeSprite(dir, "sprite.png", 4, 4);
			const out = join(dir, "out.png");
			const result = await runCli([
				"--json",
				"gui-scale",
				input,
				"--size",
				"8x8",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			expect(body.success).toBe(true);
			expect(body.result?.command).toBe("gui-scale");
			expect(body.result?.width).toBe(8);
			expect(body.result?.height).toBe(8);
			expect(body.result?.scaling).toEqual({ type: "stretch" });
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(8);
			expect(decoded.canvas.height).toBe(8);
			// Nearest: out(x,y) = src(floor(x/2), floor(y/2)).
			expect(pixelOf(decoded.canvas, 2, 0)).toEqual(
				pixelOf(decoded.canvas, 3, 0),
			);
			expect(pixelOf(decoded.canvas, 0, 0)).toEqual([0, 0, 0, 255]);
			expect(pixelOf(decoded.canvas, 7, 7)).toEqual([48, 48, 6, 255]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("tile repeats and crops the last repeat", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gui-"));
		try {
			const input = await writeSprite(dir, "sprite.png", 4, 4);
			const mcmeta = await writeMcmeta(dir, "tile.mcmeta", {
				gui: { scaling: { type: "tile", width: 4, height: 4 } },
			});
			const out = join(dir, "out.png");
			const result = await runCli([
				"--json",
				"gui-scale",
				input,
				"--size",
				"6x6",
				"--mcmeta",
				mcmeta,
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			expect(parseJsonStdout(result).success).toBe(true);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			const source = decodePng(new Uint8Array(await readFile(input)));
			for (let y = 0; y < 6; y += 1) {
				for (let x = 0; x < 6; x += 1) {
					expect(pixelOf(decoded.canvas, x, y)).toEqual(
						pixelOf(source.canvas, x % 4, y % 4),
					);
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("nine_slice corners stay 1:1 and inner mode switches on stretch_inner", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gui-"));
		try {
			const input = await writeSprite(dir, "panel.png", 6, 6);
			const border = { left: 2, top: 2, right: 2, bottom: 2 };
			const tiledMcmeta = await writeMcmeta(dir, "tiled.mcmeta", {
				gui: {
					scaling: {
						type: "nine_slice",
						width: 6,
						height: 6,
						border,
						stretch_inner: false,
					},
				},
			});
			const stretchedMcmeta = await writeMcmeta(dir, "stretched.mcmeta", {
				gui: {
					scaling: {
						type: "nine_slice",
						width: 6,
						height: 6,
						border,
						stretch_inner: true,
					},
				},
			});
			const tiledOut = join(dir, "tiled.png");
			const stretchedOut = join(dir, "stretched.png");
			expect(
				(
					await runCli([
						"gui-scale",
						input,
						"--size",
						"10x10",
						"--mcmeta",
						tiledMcmeta,
						"--output",
						tiledOut,
					])
				).code,
			).toBe(0);
			expect(
				(
					await runCli([
						"gui-scale",
						input,
						"--size",
						"10x10",
						"--mcmeta",
						stretchedMcmeta,
						"--output",
						stretchedOut,
					])
				).code,
			).toBe(0);
			const tiled = decodePng(new Uint8Array(await readFile(tiledOut)));
			const stretched = decodePng(new Uint8Array(await readFile(stretchedOut)));
			// Corners match in both modes; the top edge advances by tiling
			// but holds by stretching.
			expect(pixelOf(tiled.canvas, 0, 0)).toEqual(
				pixelOf(stretched.canvas, 0, 0),
			);
			expect(pixelOf(tiled.canvas, 3, 0)).toEqual([48, 0, 3, 255]);
			expect(pixelOf(stretched.canvas, 3, 0)).toEqual([32, 0, 2, 255]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("old versions ignore stretch_inner with a warning", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gui-"));
		try {
			const input = await writeSprite(dir, "panel.png", 6, 6);
			const border = { left: 2, top: 2, right: 2, bottom: 2 };
			const innerMcmeta = await writeMcmeta(dir, "inner.mcmeta", {
				gui: {
					scaling: {
						type: "nine_slice",
						width: 6,
						height: 6,
						border,
						stretch_inner: true,
					},
				},
			});
			const flatMcmeta = await writeMcmeta(dir, "flat.mcmeta", {
				gui: {
					scaling: {
						type: "nine_slice",
						width: 6,
						height: 6,
						border,
						stretch_inner: false,
					},
				},
			});
			const gatedOut = join(dir, "gated.png");
			const flatOut = join(dir, "flat.png");
			const gated = await runCli([
				"--json",
				"gui-scale",
				input,
				"--size",
				"10x10",
				"--mcmeta",
				innerMcmeta,
				"--minecraft-version",
				"1.21",
				"--output",
				gatedOut,
			]);
			expect(gated.code).toBe(0);
			const body = parseJsonStdout(gated);
			const warnings = (body.result?.warnings ?? []) as Array<{ code: string }>;
			expect(warnings.map((warning) => warning.code)).toContain(
				"STRETCH_INNER_IGNORED",
			);
			expect(
				(
					await runCli([
						"gui-scale",
						input,
						"--size",
						"10x10",
						"--mcmeta",
						flatMcmeta,
						"--output",
						flatOut,
					])
				).code,
			).toBe(0);
			expect(new Uint8Array(await readFile(gatedOut))).toEqual(
				new Uint8Array(await readFile(flatOut)),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("border overflow is INVALID_MCMETA with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gui-"));
		try {
			const input = await writeSprite(dir, "panel.png", 6, 6);
			const mcmeta = await writeMcmeta(dir, "wide.mcmeta", {
				gui: {
					scaling: {
						type: "nine_slice",
						width: 6,
						height: 6,
						border: { left: 3, top: 2, right: 3, bottom: 2 },
						stretch_inner: false,
					},
				},
			});
			const before = await listAllFiles(dir);
			const result = await runCli([
				"--json",
				"gui-scale",
				input,
				"--size",
				"10x10",
				"--mcmeta",
				mcmeta,
				"--output",
				join(dir, "out.png"),
			]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("INVALID_MCMETA");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("missing or bad --size is INVALID_ARGUMENT", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gui-"));
		try {
			const input = await writeSprite(dir, "sprite.png", 4, 4);
			const before = await listAllFiles(dir);
			const missing = await runCli([
				"--json",
				"gui-scale",
				input,
				"--output",
				join(dir, "out.png"),
			]);
			expect(missing.code).toBe(2);
			expect(parseJsonStdout(missing).error?.code).toBe("INVALID_ARGUMENT");
			const bad = await runCli([
				"--json",
				"gui-scale",
				input,
				"--size",
				"0",
				"--output",
				join(dir, "out.png"),
			]);
			expect(bad.code).toBe(2);
			expect(parseJsonStdout(bad).error?.code).toBe("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("same size copies the sprite bytes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gui-"));
		try {
			const input = await writeSprite(dir, "sprite.png", 4, 4);
			const out = join(dir, "out.png");
			const result = await runCli([
				"gui-scale",
				input,
				"--size",
				"4",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			expect(new Uint8Array(await readFile(out))).toEqual(
				new Uint8Array(await readFile(input)),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--stdout carries PNG bytes with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-gui-"));
		try {
			const input = await writeSprite(dir, "sprite.png", 4, 4);
			const before = await listAllFiles(dir);
			const result = await runCli([
				"gui-scale",
				input,
				"--size",
				"8x8",
				"--stdout",
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(result.stdout);
			expect(decoded.canvas.width).toBe(8);
			expect(decoded.canvas.height).toBe(8);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
