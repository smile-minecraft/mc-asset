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
import { decodePng, encodePng } from "../../src/io/png.ts";
import { type CliResult, runCliInProcess } from "../support/cli-runner.ts";

/**
 * Sweep band, timeline presets, unpack PNG output, and the preview image in
 * process. The 16x16 gem is drawn here from scratch and encoded by this
 * repo, so every byte on disk is original; no Mojang assets are read.
 */

interface JsonEnvelope {
	success: boolean;
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string; details?: unknown };
}

const GEM_ART: readonly string[] = [
	"................",
	"......dddd......",
	"....ddlllldd....",
	"...dllhhhhhhd...",
	"..dlhbbbbbbhld..",
	"..olbbbbbblllo..",
	".odlbbbbbbblbdo.",
	".odlbbbbbbblbdo.",
	".oobbbbbbbbbboo.",
	"..oobbbbbbbboo..",
	"...oobbbbbboo...",
	"....oobbbboo....",
	".....oobboo.....",
	"......oooo......",
	"................",
	"................",
];

const GEM_COLORS: Record<string, RGBA> = {
	".": { r: 0, g: 0, b: 0, a: 0 },
	o: { r: 32, g: 34, b: 58, a: 255 },
	d: { r: 58, g: 76, b: 128, a: 255 },
	b: { r: 92, g: 124, b: 196, a: 255 },
	l: { r: 138, g: 176, b: 232, a: 255 },
	h: { r: 198, g: 222, b: 250, a: 255 },
};

function stdoutText(result: CliResult): string {
	return Buffer.from(result.stdout).toString("utf-8");
}

function parseJsonStdout(result: CliResult): JsonEnvelope {
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

function runCli(args: string[]): Promise<CliResult> {
	return runCliInProcess(args);
}

async function listAllFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true });
	return [...entries].sort();
}

function gemPngBytes(): Uint8Array {
	const height = GEM_ART.length;
	const width = (GEM_ART[0] as string).length;
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		const row = GEM_ART[y] as string;
		expect(row.length).toBe(width);
		for (let x = 0; x < width; x += 1) {
			const color = GEM_COLORS[row.charAt(x)] as RGBA;
			const offset = (y * width + x) * 4;
			pixels[offset] = color.r;
			pixels[offset + 1] = color.g;
			pixels[offset + 2] = color.b;
			pixels[offset + 3] = color.a;
		}
	}
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

function frameMcpx(color: RGBA): string {
	const canvas = createCanvas(4, 4);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(4 * 4 * 4);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		pixels[offset] = color.r;
		pixels[offset + 1] = color.g;
		pixels[offset + 2] = color.b;
		pixels[offset + 3] = color.a;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return ensureMcpxText(canvas, () => {});
}

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBA = { r: 0, g: 255, b: 0, a: 255 };

/** Alpha plane of one frame cell of a vertical sheet. */
function frameAlpha(
	decoded: Uint8Array,
	frameWidth: number,
	frameIndex: number,
) {
	const sheet = decodePng(decoded).canvas;
	const layer = sheet.layers[0];
	if (layer === undefined) throw new Error("sheet needs one layer");
	const alpha: number[] = [];
	for (let y = 0; y < frameWidth; y += 1) {
		for (let x = 0; x < frameWidth; x += 1) {
			const offset = ((frameIndex * frameWidth + y) * sheet.width + x) * 4 + 3;
			alpha.push(layer.pixels[offset] as number);
		}
	}
	return alpha.join(",");
}

async function writeFramesDir(
	parent: string,
	name: string,
	colors: RGBA[],
): Promise<string> {
	const dir = join(parent, name);
	await mkdir(dir, { recursive: true });
	for (let index = 0; index < colors.length; index += 1) {
		await writeFile(
			join(dir, `frame_${index}.mcpx`),
			frameMcpx(colors[index] as RGBA),
		);
	}
	return dir;
}

const HOLD_AND_SWEEP_TEN =
	'{"animation":{"width":16,"height":16,"frametime":1,"frames":[{"index":0,"time":100},1,2,3,4,5,6,7,8,9]}}\n';

describe("animate sweep and timeline wiring in process", () => {
	test("sweep writes the vertical sheet plus its metadata document", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-sweep-"));
		try {
			const source = join(dir, "gem.png");
			await writeFile(source, gemPngBytes());
			const sheet = join(dir, "gem_sweep.png");
			const mcmeta = join(dir, "gem_sweep.png.mcmeta");
			const result = await runCli([
				"animate",
				"sweep",
				source,
				"--output",
				sheet,
				"--output-mcmeta",
				mcmeta,
				"--json",
			]);
			expect(result.code).toBe(0);
			const body = mustResult(parseJsonStdout(result));
			expect(body.frameCount).toBe(10);
			expect(body.frameWidth).toBe(16);
			expect(body.frameHeight).toBe(16);
			expect(body.angle).toBe(135);
			expect(body.width).toBe(1);
			expect(body.color).toBe("#FFFFFF");
			expect(body.output).toBe(sheet);
			expect(body.outputMcmeta).toBe(mcmeta);
			const decoded = new Uint8Array(await readFile(sheet));
			const image = decodePng(decoded).canvas;
			expect(image.width).toBe(16);
			expect(image.height).toBe(160);
			const base = frameAlpha(decoded, 16, 0);
			for (let index = 1; index < 10; index += 1) {
				expect(frameAlpha(decoded, 16, index)).toBe(base);
			}
			expect(await readFile(mcmeta, "utf-8")).toBe(HOLD_AND_SWEEP_TEN);
			const again = join(dir, "gem_sweep-again.png");
			const rerun = await runCli([
				"animate",
				"sweep",
				source,
				"--output",
				again,
			]);
			expect(rerun.code).toBe(0);
			expect(sha256(decoded)).toBe(
				sha256(new Uint8Array(await readFile(again))),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("sweep takes explicit angle, width, colour, frames, and hold ticks", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-sweep-"));
		try {
			const source = join(dir, "gem.png");
			await writeFile(source, gemPngBytes());
			const sheet = join(dir, "gem45.png");
			const mcmeta = join(dir, "gem45.png.mcmeta");
			const result = await runCli([
				"animate",
				"sweep",
				source,
				"--angle",
				"45",
				"--width",
				"2",
				"--color",
				"#F0E0C8",
				"--frames",
				"4",
				"--frametime",
				"2",
				"--hold-ticks",
				"40",
				"--output",
				sheet,
				"--output-mcmeta",
				mcmeta,
				"--json",
			]);
			expect(result.code).toBe(0);
			const body = mustResult(parseJsonStdout(result));
			expect(body.frameCount).toBe(4);
			expect(body.angle).toBe(45);
			expect(body.width).toBe(2);
			const decoded = decodePng(new Uint8Array(await readFile(sheet))).canvas;
			expect(decoded.height).toBe(64);
			expect(await readFile(mcmeta, "utf-8")).toBe(
				'{"animation":{"width":16,"height":16,"frametime":2,"frames":[{"index":0,"time":40},1,2,3]}}\n',
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("sweep carries the band colour onto opaque cells of the sheet", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-sweep-"));
		try {
			const source = join(dir, "gem.png");
			await writeFile(source, gemPngBytes());
			const sheet = join(dir, "banded.png");
			const result = await runCli([
				"animate",
				"sweep",
				source,
				"--output",
				sheet,
				"--json",
			]);
			expect(result.code).toBe(0);
			const layer = decodePng(new Uint8Array(await readFile(sheet))).canvas
				.layers[0];
			if (layer === undefined) throw new Error("sheet needs one layer");
			const pixels = layer.pixels;
			const base = gemPngBytes();
			expect(base.byteLength).toBeGreaterThan(0);
			const sourceLayer = decodePng(base).canvas.layers[0];
			if (sourceLayer === undefined) throw new Error("gem needs one layer");
			let repainted = 0;
			for (let frame = 1; frame < 10; frame += 1) {
				for (let y = 0; y < 16; y += 1) {
					for (let x = 0; x < 16; x += 1) {
						const inFrame = ((frame * 16 + y) * 16 + x) * 4;
						const inSource = (y * 16 + x) * 4;
						const changed =
							pixels[inFrame] !== sourceLayer.pixels[inSource] ||
							pixels[inFrame + 1] !== sourceLayer.pixels[inSource + 1] ||
							pixels[inFrame + 2] !== sourceLayer.pixels[inSource + 2] ||
							pixels[inFrame + 3] !== sourceLayer.pixels[inSource + 3];
						if (!changed) continue;
						repainted += 1;
						expect(sourceLayer.pixels[inSource + 3]).toBe(255);
						expect([...pixels.slice(inFrame, inFrame + 4)]).toEqual([
							255, 255, 255, 255,
						]);
					}
				}
			}
			expect(repainted).toBeGreaterThan(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("sweep refuses an unsupported angle and writes nothing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-sweep-"));
		try {
			const source = join(dir, "gem.png");
			await writeFile(source, gemPngBytes());
			const sheet = join(dir, "refused.png");
			const result = await runCli([
				"animate",
				"sweep",
				source,
				"--angle",
				"30",
				"--output",
				sheet,
				"--json",
			]);
			expect(result.code).toBe(2);
			expect(mustError(parseJsonStdout(result)).code).toBe("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(["gem.png"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("sweep needs one explicit output channel", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-sweep-"));
		try {
			const source = join(dir, "gem.png");
			await writeFile(source, gemPngBytes());
			const result = await runCli(["animate", "sweep", source, "--json"]);
			expect(result.code).toBe(2);
			expect(mustError(parseJsonStdout(result)).code).toBe("OUTPUT_REQUIRED");
			const piped = await runCli(["animate", "sweep", source, "--stdout"]);
			expect(piped.code).toBe(0);
			expect(decodePng(new Uint8Array(piped.stdout)).canvas.height).toBe(160);
			expect(await listAllFiles(dir)).toEqual(["gem.png"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("unpack writes PNG frames and keeps mcpx as the default", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-sweep-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			const sheet = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						sheet,
					])
				).code,
			).toBe(0);
			const pngDir = join(dir, "png-frames");
			const pngRun = await runCli([
				"animate",
				"unpack",
				sheet,
				"--layout",
				"vertical",
				"--frame-size",
				"4",
				"--format",
				"png",
				"--output-dir",
				pngDir,
				"--mkdir",
				"--json",
			]);
			expect(pngRun.code).toBe(0);
			expect(mustResult(parseJsonStdout(pngRun)).format).toBe("png");
			expect(await listAllFiles(pngDir)).toEqual([
				"frame_0.png",
				"frame_1.png",
			]);
			const first = decodePng(
				new Uint8Array(await readFile(join(pngDir, "frame_0.png"))),
			).canvas;
			expect(first.width).toBe(4);
			expect([...(first.layers[0]?.pixels.slice(0, 4) ?? [])]).toEqual([
				255, 0, 0, 255,
			]);
			const mcpxDir = join(dir, "mcpx-frames");
			const mcpxRun = await runCli([
				"animate",
				"unpack",
				sheet,
				"--layout",
				"vertical",
				"--frame-size",
				"4",
				"--output-dir",
				mcpxDir,
				"--mkdir",
				"--json",
			]);
			expect(mcpxRun.code).toBe(0);
			expect(mustResult(parseJsonStdout(mcpxRun)).format).toBe("mcpx");
			expect(await listAllFiles(mcpxDir)).toEqual([
				"frame_0.mcpx",
				"frame_1.mcpx",
			]);
			const refused = await runCli([
				"animate",
				"unpack",
				sheet,
				"--layout",
				"vertical",
				"--frame-size",
				"4",
				"--format",
				"gif",
				"--output-dir",
				join(dir, "gif-frames"),
				"--json",
			]);
			expect(refused.code).toBe(2);
			expect(mustError(parseJsonStdout(refused)).code).toBe("INVALID_ARGUMENT");
			expect(
				await listAllFiles(join(dir, "gif-frames")).catch(() => []),
			).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("preview writes the sheet image only when asked", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-sweep-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			const reportOnly = await runCli([
				"animate",
				"preview",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
				"--json",
			]);
			expect(reportOnly.code).toBe(0);
			const body = mustResult(parseJsonStdout(reportOnly));
			expect(body.frameCount).toBe(2);
			expect(body.sheetWidth).toBe(4);
			expect(body.sheetHeight).toBe(8);
			expect(body.output).toBeUndefined();
			expect(await listAllFiles(dir)).toEqual([
				"frames",
				"frames/frame_0.mcpx",
				"frames/frame_1.mcpx",
			]);
			const image = join(dir, "preview.png");
			const withImage = await runCli([
				"animate",
				"preview",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
				"--output",
				image,
				"--json",
			]);
			expect(withImage.code).toBe(0);
			expect(mustResult(parseJsonStdout(withImage)).output).toBe(image);
			const decoded = decodePng(new Uint8Array(await readFile(image))).canvas;
			expect(decoded.width).toBe(4);
			expect(decoded.height).toBe(8);
			const top = decoded.layers[0]?.pixels.slice(0, 4) ?? [];
			expect([...top]).toEqual([255, 0, 0, 255]);
			const bottom =
				decoded.layers[0]?.pixels.slice(4 * 4 * 4, 4 * 4 * 4 + 4) ?? [];
			expect([...bottom]).toEqual([0, 255, 0, 255]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("mcmeta animation expands a timeline preset and conflicts with frames", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-sweep-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [
				RED,
				GREEN,
				RED,
				GREEN,
			]);
			const sheet = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						sheet,
					])
				).code,
			).toBe(0);
			const pulse = join(dir, "pulse.mcmeta");
			expect(
				(
					await runCli([
						"mcmeta",
						"animation",
						sheet,
						"--frame-size",
						"4",
						"--frametime",
						"2",
						"--preset",
						"pulse",
						"--hold-ticks",
						"40",
						"--output",
						pulse,
					])
				).code,
			).toBe(0);
			expect(await readFile(pulse, "utf-8")).toBe(
				'{"animation":{"width":4,"height":4,"frametime":2,"frames":[{"index":0,"time":40},1,2,3,{"index":3,"time":40},2,1]}}\n',
			);
			const pingPong = join(dir, "ping-pong.mcmeta");
			expect(
				(
					await runCli([
						"mcmeta",
						"animation",
						sheet,
						"--frame-size",
						"4",
						"--preset",
						"ping-pong",
						"--output",
						pingPong,
					])
				).code,
			).toBe(0);
			expect(await readFile(pingPong, "utf-8")).toBe(
				'{"animation":{"width":4,"height":4,"frametime":1,"frames":[0,1,2,3,2,1]}}\n',
			);
			const conflict = await runCli([
				"mcmeta",
				"animation",
				sheet,
				"--frame-size",
				"4",
				"--preset",
				"ping-pong",
				"--frames",
				"[0,1,2,3]",
				"--output",
				join(dir, "conflict.mcmeta"),
				"--json",
			]);
			expect(conflict.code).toBe(2);
			expect(mustError(parseJsonStdout(conflict)).code).toBe(
				"ARGUMENT_CONFLICT",
			);
			expect(await listAllFiles(dir)).not.toContain("conflict.mcmeta");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
