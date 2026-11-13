import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureMcpxText } from "../../src/cli/artifacts.ts";
import type { OutputStreams } from "../../src/cli/channels.ts";
import { runCli } from "../../src/cli/program.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import { encodePng } from "../../src/io/png.ts";
import { handleParticleAsset } from "../../src/mcp/handlers.ts";
import {
	compareFrameNames,
	type ParticleFrame,
	planParticleAsset,
} from "../../src/particle/index.ts";
import { scanPack } from "../../src/validate/pack.ts";

/**
 * Particle definition generation cases. They run twice, under Bun
 * (`particle.test.ts`) and under Node (`particle.node.ts`), so every
 * byte-level expectation doubles as the cross-runtime check: the definition
 * text, the sprite order, and the canonical PNG bytes must match on both.
 */

export interface ParticleCase {
	name: string;
	run(): Promise<void>;
}

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBA = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
const COLORS = [RED, GREEN, BLUE, WHITE] as const;

function solidCanvas(width: number, height: number, color: RGBA): PixelCanvas {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let index = 0; index < pixels.length; index += 4) {
		pixels[index] = color.r;
		pixels[index + 1] = color.g;
		pixels[index + 2] = color.b;
		pixels[index + 3] = color.a;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return canvas;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-particle-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeFrame(
	dir: string,
	name: string,
	canvas: PixelCanvas,
): Promise<void> {
	await writeFile(join(dir, name), encodePng(canvas));
}

async function writeFrames(
	dir: string,
	names: readonly string[],
): Promise<void> {
	await mkdir(dir, { recursive: true });
	for (const [index, name] of names.entries()) {
		await writeFrame(
			dir,
			name,
			solidCanvas(8, 8, COLORS[index % COLORS.length] ?? RED),
		);
	}
}

interface ParticleCliResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

/**
 * In-process CLI invocation with injected streams. Unlike the shared Bun
 * runner it never touches `process.stdin` or `process.stdout`, so the same
 * cases run under Node's test runner too.
 */
async function runParticleCli(
	args: readonly string[],
): Promise<ParticleCliResult> {
	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: string[] = [];
	const streams: OutputStreams = {
		stdout: {
			write(chunk: string | Uint8Array): boolean {
				stdoutChunks.push(
					typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
				);
				return true;
			},
		},
		stderr: {
			write(chunk: string | Uint8Array): boolean {
				stderrChunks.push(
					typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
				);
				return true;
			},
		},
	};
	const savedExitCode = process.exitCode;
	process.exitCode = undefined;
	try {
		const code = await runCli(["node", "mc-asset", ...args], streams);
		const total = stdoutChunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const stdout = new Uint8Array(total);
		let offset = 0;
		for (const chunk of stdoutChunks) {
			stdout.set(chunk, offset);
			offset += chunk.length;
		}
		return { code, stdout, stderr: stderrChunks.join("") };
	} finally {
		process.exitCode = savedExitCode;
	}
}

function stdoutText(result: ParticleCliResult): string {
	return new TextDecoder().decode(result.stdout);
}

function envelopeOf(result: ParticleCliResult): Record<string, unknown> {
	const envelope = JSON.parse(stdoutText(result)) as Record<string, unknown>;
	assert.equal(envelope.success, true);
	return envelope.result as Record<string, unknown>;
}

async function readText(path: string): Promise<string> {
	return await readFile(path, "utf8");
}

function mcpText(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	const first = result.content[0];
	assert.ok(first !== undefined, "result needs one content block");
	assert.equal(first.type, "text");
	if (first.type !== "text" || first.text === undefined) {
		throw new Error("expected a text content block");
	}
	return first.text;
}

function assertCode(fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		assert.ok(error instanceof McAssetError, "expected McAssetError");
		assert.equal(error.code, code);
		return;
	}
	throw new Error(`expected McAssetError(${code}) but nothing was thrown`);
}

const FOUR_FRAME_DEFINITION = `{
  "textures": [
    "demo:spark_0",
    "demo:spark_1",
    "demo:spark_2",
    "demo:spark_3"
  ]
}
`;

const ORDERED_DEFINITION = `{
  "textures": [
    "demo:spark_0",
    "demo:spark_1"
  ]
}
`;

export const PARTICLE_CASES: readonly ParticleCase[] = [
	{
		name: "four frames produce four textures that resolve under textures/particle",
		async run() {
			await withTempDir(async (dir) => {
				const framesDir = join(dir, "frames");
				await writeFrames(framesDir, [
					"frame_0.png",
					"frame_1.png",
					"frame_2.png",
					"frame_3.png",
				]);
				const packDir = join(dir, "pack");
				const result = await runParticleCli([
					"particle",
					framesDir,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					packDir,
					"--mkdir",
					"--json",
				]);
				assert.equal(result.code, 0, stdoutText(result));
				const report = envelopeOf(result);
				assert.equal(report.command, "particle");
				assert.equal(report.frameCount, 4);

				const definitionPath = join(
					packDir,
					"assets/demo/particles/spark.json",
				);
				assert.equal(await readText(definitionPath), FOUR_FRAME_DEFINITION);
				for (let index = 0; index < 4; index += 1) {
					const texturePath = join(
						packDir,
						`assets/demo/textures/particle/spark_${index}.png`,
					);
					assert.equal(existsSync(texturePath), true);
					assert.deepEqual(
						new Uint8Array(await readFile(texturePath)),
						encodePng(solidCanvas(8, 8, COLORS[index] ?? RED)),
					);
				}

				const pack = await scanPack(packDir, { packFormat: "75.0" });
				assert.deepEqual(
					pack.findings.filter((finding) => finding.level === "error"),
					[],
				);
				assert.equal(
					pack.findings.filter(
						(finding) => finding.code === "PACK_MISSING_TEXTURE",
					).length,
					0,
				);
				assert.equal(
					pack.findings.filter(
						(finding) => finding.code === "PACK_ORPHAN_TEXTURE",
					).length,
					0,
				);
			});
		},
	},
	{
		name: "frame_10 sorts before frame_2 by UTF-8 bytes and both reports name the order",
		async run() {
			await withTempDir(async (dir) => {
				const framesDir = join(dir, "frames");
				await mkdir(framesDir, { recursive: true });
				// Written in the opposite order so a readdir-order bug stays visible.
				await writeFrame(framesDir, "frame_2.png", solidCanvas(8, 8, GREEN));
				await writeFrame(framesDir, "frame_10.png", solidCanvas(8, 8, RED));

				const jsonPack = join(dir, "pack-json");
				const jsonResult = await runParticleCli([
					"particle",
					framesDir,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					jsonPack,
					"--mkdir",
					"--json",
				]);
				assert.equal(jsonResult.code, 0, stdoutText(jsonResult));
				const report = envelopeOf(jsonResult);
				assert.deepEqual(
					(report.frames as Array<{ input: string }>).map(
						(frame) => frame.input,
					),
					["frame_10.png", "frame_2.png"],
				);
				assert.deepEqual(
					(report.frames as Array<{ texture: string }>).map(
						(frame) => frame.texture,
					),
					["demo:spark_0", "demo:spark_1"],
				);
				assert.equal(
					await readText(join(jsonPack, "assets/demo/particles/spark.json")),
					ORDERED_DEFINITION,
				);

				const humanPack = join(dir, "pack-human");
				const humanResult = await runParticleCli([
					"particle",
					framesDir,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					humanPack,
					"--mkdir",
				]);
				assert.equal(humanResult.code, 0, stdoutText(humanResult));
				assert.match(
					stdoutText(humanResult),
					/order: frame_10\.png -> demo:spark_0, frame_2\.png -> demo:spark_1/,
				);
			});
		},
	},
	{
		name: "an existing output refuses the whole batch without --force and writes nothing",
		async run() {
			await withTempDir(async (dir) => {
				const framesDir = join(dir, "frames");
				await writeFrames(framesDir, [
					"frame_0.png",
					"frame_1.png",
					"frame_2.png",
					"frame_3.png",
				]);
				const packDir = join(dir, "pack");
				const definitionPath = join(
					packDir,
					"assets/demo/particles/spark.json",
				);
				await mkdir(dirname(definitionPath), { recursive: true });
				await writeFile(definitionPath, "sentinel");

				const refused = await runParticleCli([
					"particle",
					framesDir,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					packDir,
					"--mkdir",
					"--json",
				]);
				assert.equal(refused.code, 4);
				const failure = JSON.parse(stdoutText(refused)) as {
					success: boolean;
					error: { code: string };
				};
				assert.equal(failure.success, false);
				assert.equal(failure.error.code, "OUTPUT_EXISTS");
				assert.equal(await readText(definitionPath), "sentinel");
				for (let index = 0; index < 4; index += 1) {
					assert.equal(
						existsSync(
							join(packDir, `assets/demo/textures/particle/spark_${index}.png`),
						),
						false,
					);
				}

				const forced = await runParticleCli([
					"particle",
					framesDir,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					packDir,
					"--mkdir",
					"--force",
					"--json",
				]);
				assert.equal(forced.code, 0, stdoutText(forced));
				assert.equal(await readText(definitionPath), FOUR_FRAME_DEFINITION);

				const texturePack = join(dir, "pack-texture");
				const occupiedTexture = join(
					texturePack,
					"assets/demo/textures/particle/spark_2.png",
				);
				await mkdir(dirname(occupiedTexture), { recursive: true });
				await writeFile(occupiedTexture, "sentinel-texture");
				const textureRefused = await runParticleCli([
					"particle",
					framesDir,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					texturePack,
					"--mkdir",
					"--json",
				]);
				assert.equal(textureRefused.code, 4);
				assert.equal(await readText(occupiedTexture), "sentinel-texture");
				assert.equal(
					existsSync(join(texturePack, "assets/demo/particles/spark.json")),
					false,
				);
			});
		},
	},
	{
		name: "the pure planner pins the JSON text, byte order, and reference shape",
		async run() {
			const frames: ParticleFrame[] = [
				{ name: "frame_2.png", canvas: solidCanvas(8, 8, GREEN) },
				{ name: "frame_10.png", canvas: solidCanvas(8, 8, RED) },
			];
			const plan = planParticleAsset({
				namespace: "demo",
				id: "spark",
				frames,
			});
			assert.equal(
				plan.definition.relativePath,
				"assets/demo/particles/spark.json",
			);
			assert.equal(plan.definition.text, ORDERED_DEFINITION);
			assert.deepEqual(
				plan.textures.map((texture) => texture.frame),
				["frame_10.png", "frame_2.png"],
			);
			assert.deepEqual(
				plan.textures.map((texture) => texture.texture),
				["demo:spark_0", "demo:spark_1"],
			);
			assert.deepEqual(
				plan.textures.map((texture) => texture.relativePath),
				[
					"assets/demo/textures/particle/spark_0.png",
					"assets/demo/textures/particle/spark_1.png",
				],
			);
			for (const texture of plan.textures) {
				assert.equal(texture.texture.endsWith(".png"), false);
				assert.equal(texture.texture.includes("textures/particle"), false);
			}
			assert.deepEqual(
				plan.textures[0]?.data,
				encodePng(solidCanvas(8, 8, RED)),
			);

			const prefixed = planParticleAsset({
				namespace: "demo",
				id: "spark",
				texturePrefix: "flash",
				frames,
			});
			assert.deepEqual(prefixed.definition.json.textures, [
				"demo:flash_0",
				"demo:flash_1",
			]);
			assert.deepEqual(
				compareFrameNames("frame_10.png", "frame_2.png") < 0,
				true,
			);
		},
	},
	{
		name: "an .mcpx frame is parsed and flattened into the canonical PNG bytes",
		async run() {
			await withTempDir(async (dir) => {
				const canvas = createCanvas(4, 4);
				const base = addLayer(canvas, { id: "base" });
				const basePixels = new Uint8Array(4 * 4 * 4);
				for (let index = 0; index < basePixels.length; index += 4) {
					basePixels[index] = 255;
					basePixels[index + 3] = 255;
				}
				replaceLayerPixels(canvas, base.id, basePixels);
				const top = addLayer(canvas, { id: "top", opacity: 0.5 });
				const topPixels = new Uint8Array(4 * 4 * 4);
				for (let index = 0; index < topPixels.length; index += 4) {
					topPixels[index + 2] = 255;
					topPixels[index + 3] = 255;
				}
				replaceLayerPixels(canvas, top.id, topPixels);

				const framesDir = join(dir, "frames");
				await mkdir(framesDir, { recursive: true });
				await writeFile(
					join(framesDir, "frame_0.mcpx"),
					ensureMcpxText(canvas, () => undefined),
				);
				const packDir = join(dir, "pack");
				const result = await runParticleCli([
					"particle",
					framesDir,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					packDir,
					"--mkdir",
					"--json",
				]);
				assert.equal(result.code, 0, stdoutText(result));
				const texturePath = join(
					packDir,
					"assets/demo/textures/particle/spark_0.png",
				);
				assert.deepEqual(
					new Uint8Array(await readFile(texturePath)),
					encodePng(canvas),
				);
			});
		},
	},
	{
		name: "a single PNG file and a single .mcpx file are one-frame inputs",
		async run() {
			await withTempDir(async (dir) => {
				const singlePng = join(dir, "only.png");
				await writeFrame(dir, "only.png", solidCanvas(8, 8, BLUE));
				const pngPack = join(dir, "pack-png");
				const pngResult = await runParticleCli([
					"particle",
					singlePng,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					pngPack,
					"--mkdir",
					"--json",
				]);
				assert.equal(pngResult.code, 0, stdoutText(pngResult));
				assert.equal(
					(
						JSON.parse(stdoutText(pngResult)) as {
							result: { frameCount: number };
						}
					).result.frameCount,
					1,
				);
				assert.equal(
					await readText(join(pngPack, "assets/demo/particles/spark.json")),
					`{\n  "textures": [\n    "demo:spark_0"\n  ]\n}\n`,
				);

				const singleMcpx = join(dir, "only.mcpx");
				await writeFile(
					singleMcpx,
					ensureMcpxText(solidCanvas(8, 8, RED), () => undefined),
				);
				const mcpxPack = join(dir, "pack-mcpx");
				const mcpxResult = await runParticleCli([
					"particle",
					singleMcpx,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					mcpxPack,
					"--mkdir",
					"--json",
				]);
				assert.equal(mcpxResult.code, 0, stdoutText(mcpxResult));
				assert.deepEqual(
					new Uint8Array(
						await readFile(
							join(mcpxPack, "assets/demo/textures/particle/spark_0.png"),
						),
					),
					encodePng(solidCanvas(8, 8, RED)),
				);
			});
		},
	},
	{
		name: "invalid names, an empty directory, and a foreign input file are refused before any write",
		async run() {
			assertCode(
				() =>
					planParticleAsset({
						namespace: "Demo",
						id: "spark",
						frames: [{ name: "a.png", canvas: solidCanvas(1, 1, RED) }],
					}),
				"INVALID_ARGUMENT",
			);
			assertCode(
				() =>
					planParticleAsset({
						namespace: "demo",
						id: "spark/extra",
						frames: [{ name: "a.png", canvas: solidCanvas(1, 1, RED) }],
					}),
				"INVALID_ARGUMENT",
			);
			assertCode(
				() =>
					planParticleAsset({
						namespace: "demo",
						id: "spark",
						texturePrefix: "Bad",
						frames: [{ name: "a.png", canvas: solidCanvas(1, 1, RED) }],
					}),
				"INVALID_ARGUMENT",
			);
			assertCode(
				() => planParticleAsset({ namespace: "demo", id: "spark", frames: [] }),
				"INVALID_ANIMATION_FRAME",
			);

			await withTempDir(async (dir) => {
				const emptyDir = join(dir, "empty");
				await mkdir(emptyDir, { recursive: true });
				const emptyResult = await runParticleCli([
					"particle",
					emptyDir,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					join(dir, "pack-empty"),
					"--mkdir",
					"--json",
				]);
				assert.equal(emptyResult.code, 2);
				assert.equal(
					(
						JSON.parse(stdoutText(emptyResult)) as {
							error: { code: string };
						}
					).error.code,
					"INVALID_ANIMATION_FRAME",
				);
				assert.equal(existsSync(join(dir, "pack-empty")), false);

				const textPath = join(dir, "notes.txt");
				await writeFile(textPath, "not a frame");
				const textResult = await runParticleCli([
					"particle",
					textPath,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					join(dir, "pack-text"),
					"--mkdir",
					"--json",
				]);
				assert.equal(textResult.code, 2);
				assert.equal(
					(
						JSON.parse(stdoutText(textResult)) as {
							error: { code: string };
						}
					).error.code,
					"INVALID_ARGUMENT",
				);

				const missingResult = await runParticleCli([
					"particle",
					join(dir, "missing"),
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					join(dir, "pack-missing"),
					"--mkdir",
					"--json",
				]);
				assert.equal(missingResult.code, 4);
				assert.equal(
					(
						JSON.parse(stdoutText(missingResult)) as {
							error: { code: string };
						}
					).error.code,
					"FILESYSTEM_ERROR",
				);
			});
		},
	},
	{
		name: "ignored directory entries are warned about in byte order",
		async run() {
			await withTempDir(async (dir) => {
				const framesDir = join(dir, "frames");
				await writeFrames(framesDir, ["frame_0.png"]);
				await writeFile(join(framesDir, "notes.txt"), "ignored");
				await writeFile(join(framesDir, ".DS_Store"), "ignored");
				await mkdir(join(framesDir, "nested"));
				const result = await runParticleCli([
					"particle",
					framesDir,
					"--id",
					"spark",
					"--namespace",
					"demo",
					"--output-dir",
					join(dir, "pack"),
					"--mkdir",
					"--json",
				]);
				assert.equal(result.code, 0, stdoutText(result));
				const report = envelopeOf(result);
				assert.deepEqual(report.warnings, [
					{
						code: "NON_FRAME_IGNORED",
						message: "Ignoring non-frame entry: .DS_Store.",
					},
					{
						code: "NON_FRAME_IGNORED",
						message: "Ignoring non-frame entry: nested.",
					},
					{
						code: "NON_FRAME_IGNORED",
						message: "Ignoring non-frame entry: notes.txt.",
					},
				]);
			});
		},
	},
	{
		name: "particle_asset writes the same tree and refuses occupied outputs without force",
		async run() {
			await withTempDir(async (dir) => {
				const framesDir = join(dir, "frames");
				await writeFrames(framesDir, ["frame_0.png", "frame_1.png"]);
				const packDir = join(dir, "pack");
				const first = await handleParticleAsset({
					inputPath: framesDir,
					outputDir: packDir,
					namespace: "demo",
					id: "spark",
					mkdir: true,
				});
				assert.equal(first.isError, undefined);
				const report = JSON.parse(mcpText(first)) as Record<string, unknown>;
				assert.equal(report.command, "particle");
				assert.equal(report.frameCount, 2);
				assert.equal(
					existsSync(join(packDir, "assets/demo/particles/spark.json")),
					true,
				);
				assert.equal(
					existsSync(
						join(packDir, "assets/demo/textures/particle/spark_1.png"),
					),
					true,
				);

				const refused = await handleParticleAsset({
					inputPath: framesDir,
					outputDir: packDir,
					namespace: "demo",
					id: "spark",
					mkdir: true,
				});
				assert.equal(refused.isError, true);
				const failure = JSON.parse(mcpText(refused)) as { code: string };
				assert.equal(failure.code, "OUTPUT_EXISTS");

				const forced = await handleParticleAsset({
					inputPath: framesDir,
					outputDir: packDir,
					namespace: "demo",
					id: "spark",
					mkdir: true,
					force: true,
				});
				assert.equal(forced.isError, undefined);
			});
		},
	},
];
