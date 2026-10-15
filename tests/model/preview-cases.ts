import { Buffer } from "node:buffer";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModelRequest } from "../../src/cli/cmd-model.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import { decodePng, encodePng, flattenCanvas } from "../../src/io/png.ts";
import { handleModelAsset } from "../../src/mcp/handlers-model-optimize.ts";
import type {
	ModelResolutionContext,
	ModelResolutionLayer,
} from "../../src/model/context.ts";
import { renderModelPreview } from "../../src/model/preview/render.ts";
import type { CaseCheck, ModelCase } from "./json-document-cases.ts";

const PREVIEW_PATH = "assets/demo/models/item/cube.json";
const STONE_REL = "assets/demo/textures/stone.png";
const RED_REL = "assets/demo/textures/red.png";
const GREEN_REL = "assets/demo/textures/green.png";
const BLUE_REL = "assets/demo/textures/blue.png";
const YELLOW_REL = "assets/demo/textures/yellow.png";
const MIX_REL = "assets/demo/textures/mix.png";
const PARENT_REL = "assets/demo/models/block/base.json";

const RED: readonly [number, number, number, number] = [255, 0, 0, 255];
const GREEN: readonly [number, number, number, number] = [0, 255, 0, 255];
const BLUE: readonly [number, number, number, number] = [0, 0, 255, 255];
const MAGENTA: readonly [number, number, number, number] = [255, 0, 255, 255];

const encoder = new TextEncoder();

function solidPng(r: number, g: number, b: number, a = 255): Uint8Array {
	const size = 16;
	const canvas = createCanvas(size, size);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(size * size * 4);
	for (let i = 0; i < size * size; i += 1) {
		pixels[i * 4] = r;
		pixels[i * 4 + 1] = g;
		pixels[i * 4 + 2] = b;
		pixels[i * 4 + 3] = a;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

function splitPng(): Uint8Array {
	const size = 16;
	const canvas = createCanvas(size, size);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const left = x < 8;
			const o = (y * size + x) * 4;
			pixels[o] = left ? 255 : 0;
			pixels[o + 1] = left ? 0 : 255;
			pixels[o + 2] = 0;
			pixels[o + 3] = 255;
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

function memoryContext(
	files: Record<string, Uint8Array>,
): ModelResolutionContext {
	const layer: ModelResolutionLayer = {
		source: "current",
		has: (rel) => Object.hasOwn(files, rel),
		async read(rel) {
			return files[rel];
		},
	};
	return { layers: [layer], hasVanilla: false };
}

function flatOf(png: Uint8Array): {
	flat: Uint8Array;
	width: number;
	height: number;
} {
	const decoded = decodePng(png);
	return {
		flat: flattenCanvas(decoded.canvas),
		width: decoded.canvas.width,
		height: decoded.canvas.height,
	};
}

function at(
	flat: Uint8Array,
	width: number,
	x: number,
	y: number,
): readonly [number, number, number, number] {
	const o = (y * width + x) * 4;
	return [
		flat[o] as number,
		flat[o + 1] as number,
		flat[o + 2] as number,
		flat[o + 3] as number,
	];
}

function assertRgba(
	check: CaseCheck,
	flat: Uint8Array,
	width: number,
	x: number,
	y: number,
	expected: readonly [number, number, number, number],
	message: string,
): void {
	const got = at(flat, width, x, y);
	check.deepEqual(
		[got[0], got[1], got[2], got[3]],
		[expected[0], expected[1], expected[2], expected[3]],
		`${message} at ${x},${y}: got ${got.join(",")}`,
	);
}

function assertTransparent(
	check: CaseCheck,
	flat: Uint8Array,
	width: number,
	x: number,
	y: number,
	message: string,
): void {
	const got = at(flat, width, x, y);
	check.equal(got[3], 0, `${message} at ${x},${y}: alpha ${got[3]}`);
}

function fullCubeFaces(texture: string): Record<string, unknown> {
	return {
		north: { texture },
		south: { texture },
		west: { texture },
		east: { texture },
		up: { texture },
		down: { texture },
	};
}

function cubeModel(
	texture: string,
	from: readonly number[] = [0, 0, 0],
	to: readonly number[] = [16, 16, 16],
): string {
	return JSON.stringify({
		textures: { all: "demo:stone" },
		elements: [{ from, to, faces: fullCubeFaces(texture) }],
	});
}

async function withTempRoot(
	body: (root: string) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "model-preview-"));
	try {
		await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function makePack(
	root: string,
	textureBytes: Uint8Array,
	modelText: string,
): Promise<{ pack: string; model: string }> {
	const pack = join(root, "pack");
	const modelDir = join(pack, "assets/demo/models/item");
	const texDir = join(pack, "assets/demo/textures");
	await mkdir(modelDir, { recursive: true });
	await mkdir(texDir, { recursive: true });
	const model = join(modelDir, "cube.json");
	await writeFile(model, modelText);
	await writeFile(join(texDir, "stone.png"), Buffer.from(textureBytes));
	return { pack, model };
}

export const PREVIEW_CASES: ModelCase[] = [
	{
		name: "solid cube draws the same color in all three panels",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(255, 0, 0) });
			const rendered = await renderModelPreview(cubeModel("#all"), {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			check.equal(rendered.report.command, "model");
			check.equal(rendered.report.mode, "preview");
			check.equal(rendered.report.size, 64);
			check.deepEqual(
				[rendered.report.image.width, rendered.report.image.height],
				[192, 64],
			);
			check.deepEqual(
				rendered.report.panels.map((panel) => [
					panel.name,
					panel.x,
					panel.y,
					panel.width,
					panel.height,
				]),
				[
					["front", 0, 0, 64, 64],
					["right", 64, 0, 64, 64],
					["top", 128, 0, 64, 64],
				],
			);
			check.deepEqual([...rendered.report.range.min], [0, 0, 0]);
			check.deepEqual([...rendered.report.range.max], [16, 16, 16]);
			check.equal(rendered.report.range.pixelsPerUnit, 3);
			check.equal(rendered.report.coverage.status, "complete");
			check.ok(
				rendered.report.unapplied.includes("display"),
				"unapplied mentions display",
			);
			check.ok(
				rendered.report.unapplied.includes("lighting"),
				"unapplied mentions lighting",
			);
			const { flat, width, height } = flatOf(rendered.png);
			check.equal(width, 192);
			check.equal(height, 64);
			assertRgba(check, flat, width, 32, 32, RED, "front center");
			assertRgba(check, flat, width, 96, 32, RED, "right center");
			assertRgba(check, flat, width, 160, 32, RED, "top center");
			assertTransparent(check, flat, width, 0, 0, "outside corner");
			assertTransparent(check, flat, width, 191, 63, "outside corner");
		},
	},
	{
		name: "each panel shows only the face pointing at its camera",
		async run(check) {
			const context = memoryContext({
				[RED_REL]: solidPng(255, 0, 0),
				[GREEN_REL]: solidPng(0, 255, 0),
				[BLUE_REL]: solidPng(0, 0, 255),
				[YELLOW_REL]: solidPng(255, 255, 0),
			});
			const text = JSON.stringify({
				textures: {
					r: "demo:red",
					g: "demo:green",
					b: "demo:blue",
					y: "demo:yellow",
				},
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: {
							north: { texture: "#r" },
							south: { texture: "#y" },
							east: { texture: "#g" },
							west: { texture: "#y" },
							up: { texture: "#b" },
							down: { texture: "#y" },
						},
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 32, 32, RED, "front shows north");
			assertRgba(check, flat, width, 96, 32, GREEN, "right shows east");
			assertRgba(check, flat, width, 160, 32, BLUE, "top shows up");
		},
	},
	{
		name: "full texture maps left to left and right to right",
		async run(check) {
			const context = memoryContext({ [MIX_REL]: splitPng() });
			const text = JSON.stringify({
				textures: { mix: "demo:mix" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: { north: { texture: "#mix", uv: [0, 0, 16, 16] } },
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 20, 32, RED, "front left quarter");
			assertRgba(check, flat, width, 44, 32, GREEN, "front right quarter");
		},
	},
	{
		name: "half uv stretches only the sampled half across the face",
		async run(check) {
			const context = memoryContext({ [MIX_REL]: splitPng() });
			const text = JSON.stringify({
				textures: { mix: "demo:mix" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: { north: { texture: "#mix", uv: [0, 0, 8, 16] } },
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 32, 32, RED, "half uv center");
			assertRgba(check, flat, width, 44, 32, RED, "half uv hides green");
		},
	},
	{
		name: "face rotation turns the sampled texture clockwise",
		async run(check) {
			const context = memoryContext({ [MIX_REL]: splitPng() });
			const text = JSON.stringify({
				textures: { mix: "demo:mix" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: {
							north: { texture: "#mix", uv: [0, 0, 16, 16], rotation: 90 },
						},
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 32, 20, RED, "rotated top");
			assertRgba(check, flat, width, 32, 44, GREEN, "rotated bottom");
		},
	},
	{
		name: "omitted north uv mirrors the element x range",
		async run(check) {
			const context = memoryContext({ [MIX_REL]: splitPng() });
			const text = JSON.stringify({
				textures: { mix: "demo:mix" },
				elements: [
					{
						from: [0, 0, 0],
						to: [8, 16, 16],
						faces: { north: { texture: "#mix" } },
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 32, 32, GREEN, "half-wide front center");
		},
	},
	{
		name: "omitted east uv mirrors the element z range",
		async run(check) {
			const context = memoryContext({ [MIX_REL]: splitPng() });
			const text = JSON.stringify({
				textures: { mix: "demo:mix" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 8],
						faces: { east: { texture: "#mix" } },
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 96, 32, GREEN, "half-deep right center");
		},
	},
	{
		name: "omitted up uv maps x to u and z to v directly",
		async run(check) {
			const context = memoryContext({ [MIX_REL]: splitPng() });
			const text = JSON.stringify({
				textures: { mix: "demo:mix" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: { up: { texture: "#mix" } },
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 148, 32, RED, "top left half");
			assertRgba(check, flat, width, 172, 32, GREEN, "top right half");
		},
	},
	{
		name: "a nearer element covers a farther one",
		async run(check) {
			const context = memoryContext({
				[RED_REL]: solidPng(255, 0, 0),
				[BLUE_REL]: solidPng(0, 0, 255),
			});
			const text = JSON.stringify({
				textures: { r: "demo:red", b: "demo:blue" },
				elements: [
					{
						from: [0, 0, 8],
						to: [16, 16, 16],
						faces: {
							north: { texture: "#b" },
							east: { texture: "#b" },
							up: { texture: "#b" },
						},
					},
					{
						from: [0, 0, 0],
						to: [16, 16, 8],
						faces: {
							north: { texture: "#r" },
							east: { texture: "#r" },
							up: { texture: "#r" },
						},
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 32, 32, RED, "front prefers near");
			assertRgba(check, flat, width, 96, 32, RED, "right prefers later on tie");
			assertRgba(check, flat, width, 160, 32, RED, "top prefers later on tie");
		},
	},
	{
		name: "equal depth belongs to the later element",
		async run(check) {
			const context = memoryContext({
				[RED_REL]: solidPng(255, 0, 0),
				[GREEN_REL]: solidPng(0, 255, 0),
			});
			const text = JSON.stringify({
				textures: { r: "demo:red", g: "demo:green" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: fullCubeFaces("#r"),
					},
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: fullCubeFaces("#g"),
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 32, 32, GREEN, "front later wins");
			assertRgba(check, flat, width, 96, 32, GREEN, "right later wins");
			assertRgba(check, flat, width, 160, 32, GREEN, "top later wins");
		},
	},
	{
		name: "parent elements and textures render through the child",
		async run(check) {
			const parent = JSON.stringify({
				textures: { all: "demo:stone" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: {
							north: { texture: "#all" },
							east: { texture: "#all" },
							up: { texture: "#all" },
						},
					},
				],
			});
			const context = memoryContext({
				[PARENT_REL]: encoder.encode(parent),
				[STONE_REL]: solidPng(255, 0, 0),
			});
			const rendered = await renderModelPreview(
				JSON.stringify({ parent: "demo:block/base" }),
				{ path: PREVIEW_PATH, context, size: 64 },
			);
			check.equal(rendered.report.coverage.status, "complete");
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 32, 32, RED, "inherited front");
			assertRgba(check, flat, width, 96, 32, RED, "inherited right");
			assertRgba(check, flat, width, 160, 32, RED, "inherited top");
		},
	},
	{
		name: "missing textures use the fixed checkerboard and warn",
		async run(check) {
			const context = memoryContext({});
			const text = JSON.stringify({
				textures: { all: "demo:missing" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: {
							north: { texture: "#all" },
							east: { texture: "#all" },
							up: { texture: "#all" },
						},
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			check.equal(rendered.report.coverage.status, "partial");
			check.ok(rendered.report.warnings.length > 0, "texture warning");
			check.ok(
				rendered.report.warnings.every((warning) =>
					warning.code.startsWith("MODEL_PREVIEW_TEXTURE_"),
				),
				"warning codes",
			);
			check.ok(
				rendered.report.coverage.skipped.length > 0,
				"skipped lists texture",
			);
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 32, 32, MAGENTA, "checker anchor");
			const neighbor = at(flat, width, 40, 32);
			check.ok(
				neighbor[3] === 255 &&
					!(neighbor[0] === 255 && neighbor[1] === 0 && neighbor[2] === 255),
				`checker alternates, got ${neighbor.join(",")}`,
			);
			assertTransparent(check, flat, width, 0, 0, "outside stays empty");
		},
	},
	{
		name: "a model without elements stays blank and complete",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(255, 0, 0) });
			const rendered = await renderModelPreview(
				JSON.stringify({ textures: { all: "demo:stone" } }),
				{ path: PREVIEW_PATH, context, size: 64 },
			);
			check.equal(rendered.report.coverage.status, "complete");
			check.equal(rendered.report.warnings.length, 0);
			const { flat, width } = flatOf(rendered.png);
			assertTransparent(check, flat, width, 32, 32, "empty front");
			assertTransparent(check, flat, width, 96, 32, "empty right");
			assertTransparent(check, flat, width, 160, 32, "empty top");
		},
	},
	{
		name: "element rotation is listed as partial",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(255, 0, 0) });
			const text = JSON.stringify({
				textures: { all: "demo:stone" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						rotation: { origin: [8, 8, 8], axis: "y", angle: 22.5 },
						faces: { north: { texture: "#all" } },
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			check.equal(rendered.report.coverage.status, "partial");
			check.ok(rendered.report.coverage.skipped.length > 0, "rotation skipped");
		},
	},
	{
		name: "coordinates outside 1/256 units are listed as partial",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(255, 0, 0) });
			const text = JSON.stringify({
				textures: { all: "demo:stone" },
				elements: [
					{
						from: [0, 0, 0],
						to: [8.123, 8, 8],
						faces: { north: { texture: "#all" } },
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			check.equal(rendered.report.coverage.status, "partial");
			check.ok(
				rendered.report.coverage.skipped.length > 0,
				"coordinate skipped",
			);
		},
	},
	{
		name: "translucent textures are listed as partial",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(255, 0, 0) });
			const text = JSON.stringify({
				textures: { all: { sprite: "demo:stone", force_translucent: true } },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: { north: { texture: "#all" } },
					},
				],
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				packFormat: "84.0",
				size: 64,
			});
			check.equal(rendered.report.coverage.status, "partial");
			check.ok(
				rendered.report.coverage.skipped.length > 0,
				"translucent skipped",
			);
		},
	},
	{
		name: "size 128 centers the same cube with scale seven",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(255, 0, 0) });
			const rendered = await renderModelPreview(cubeModel("#all"), {
				path: PREVIEW_PATH,
				context,
				size: 128,
			});
			check.deepEqual(
				[rendered.report.image.width, rendered.report.image.height],
				[384, 128],
			);
			check.equal(rendered.report.range.pixelsPerUnit, 7);
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 64, 64, RED, "front center 128");
			assertRgba(check, flat, width, 192, 64, RED, "right center 128");
			assertRgba(check, flat, width, 320, 64, RED, "top center 128");
		},
	},
	{
		name: "size 256 centers the same cube with scale fourteen",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(255, 0, 0) });
			const rendered = await renderModelPreview(cubeModel("#all"), {
				path: PREVIEW_PATH,
				context,
				size: 256,
			});
			check.deepEqual(
				[rendered.report.image.width, rendered.report.image.height],
				[768, 256],
			);
			check.equal(rendered.report.range.pixelsPerUnit, 14);
			const { flat, width } = flatOf(rendered.png);
			assertRgba(check, flat, width, 128, 128, RED, "front center 256");
			assertRgba(check, flat, width, 384, 128, RED, "right center 256");
			assertRgba(check, flat, width, 640, 128, RED, "top center 256");
		},
	},
	{
		name: "an unsupported preview size is rejected",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(255, 0, 0) });
			let caught: unknown;
			try {
				await renderModelPreview(cubeModel("#all"), {
					path: PREVIEW_PATH,
					context,
					size: 32 as never,
				});
			} catch (error) {
				caught = error;
			}
			check.ok(caught instanceof McAssetError, "expected McAssetError");
		},
	},
	{
		name: "cli preview writes an explicit png with the same pixels",
		async run(check) {
			await withTempRoot(async (root) => {
				const red = solidPng(255, 0, 0);
				const { pack, model } = await makePack(root, red, cubeModel("#all"));
				const out = join(root, "out.png");
				const outcome = await runModelRequest({
					mode: "preview",
					inputPath: model,
					packPath: pack,
					size: 64,
					outputPath: out,
					requireOutput: true,
				});
				check.equal(outcome.failed, false);
				const bytes = new Uint8Array(await readFile(out));
				check.ok(bytes.length > 0, "output not empty");
				const { flat, width } = flatOf(bytes);
				assertRgba(check, flat, width, 32, 32, RED, "cli front");
				assertRgba(check, flat, width, 96, 32, RED, "cli right");
				assertRgba(check, flat, width, 160, 32, RED, "cli top");
			});
		},
	},
	{
		name: "cli preview refuses bad targets without writing",
		async run(check) {
			await withTempRoot(async (root) => {
				const red = solidPng(255, 0, 0);
				const { model } = await makePack(root, red, cubeModel("#all"));
				const out = join(root, "out.png");
				await writeFile(out, "old");
				let exists: unknown;
				try {
					await runModelRequest({
						mode: "preview",
						inputPath: model,
						size: 64,
						outputPath: out,
						requireOutput: true,
					});
				} catch (error) {
					exists = error;
				}
				check.ok(exists instanceof McAssetError, "existing refused");
				check.equal((exists as McAssetError).code, "OUTPUT_EXISTS");
				check.equal(await readFile(out, "utf8"), "old");
				const nested = join(root, "missing", "out.png");
				let noMkdir: unknown;
				try {
					await runModelRequest({
						mode: "preview",
						inputPath: model,
						size: 64,
						outputPath: nested,
						requireOutput: true,
					});
				} catch (error) {
					noMkdir = error;
				}
				check.ok(noMkdir instanceof McAssetError, "mkdir refused");
				let created = false;
				try {
					await stat(nested);
					created = true;
				} catch {
					created = false;
				}
				check.equal(created, false);
				let alias: unknown;
				try {
					await runModelRequest({
						mode: "preview",
						inputPath: model,
						size: 64,
						outputPath: model,
						force: true,
						requireOutput: true,
					});
				} catch (error) {
					alias = error;
				}
				check.ok(alias instanceof McAssetError, "alias refused");
				const elsewhere = join(root, "elsewhere.png");
				await writeFile(elsewhere, "old");
				const link = join(root, "link.png");
				await symlink(elsewhere, link);
				let symlinkError: unknown;
				try {
					await runModelRequest({
						mode: "preview",
						inputPath: model,
						size: 64,
						outputPath: link,
						force: true,
						requireOutput: true,
					});
				} catch (error) {
					symlinkError = error;
				}
				check.ok(symlinkError instanceof McAssetError, "symlink refused");
				check.equal(await readFile(elsewhere, "utf8"), "old");
			});
		},
	},
	{
		name: "cli preview to stdout returns png bytes and writes nothing",
		async run(check) {
			await withTempRoot(async (root) => {
				const red = solidPng(255, 0, 0);
				const { pack, model } = await makePack(root, red, cubeModel("#all"));
				const before = new Uint8Array(await readFile(model)).length;
				check.ok(before > 0, "model readable");
				const outcome = await runModelRequest({
					mode: "preview",
					inputPath: model,
					packPath: pack,
					size: 64,
					stdout: true,
					requireOutput: true,
				});
				check.ok(outcome.artifact !== undefined, "stdout artifact");
				const { flat, width } = flatOf(outcome.artifact as Uint8Array);
				assertRgba(check, flat, width, 32, 32, RED, "stdout front");
				const after = new Uint8Array(await readFile(model)).length;
				check.equal(after, before);
			});
		},
	},
	{
		name: "mcp preview without a path returns an image block",
		async run(check) {
			await withTempRoot(async (root) => {
				const red = solidPng(255, 0, 0);
				const { pack, model } = await makePack(root, red, cubeModel("#all"));
				const result = await handleModelAsset({
					mode: "preview",
					inputPath: model,
					packPath: pack,
					size: 64,
				});
				check.equal(result.isError, undefined);
				const text = result.content.find((entry) => entry.type === "text");
				check.ok(text?.type === "text", "report block");
				const image = result.content.find((entry) => entry.type === "image");
				check.ok(image?.type === "image", "image block");
				if (image?.type !== "image") return check.fail("missing image");
				check.equal(image.mimeType, "image/png");
				const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
				const { flat, width } = flatOf(bytes);
				assertRgba(check, flat, width, 32, 32, RED, "mcp front");
			});
		},
	},
	{
		name: "mcp preview with a path writes the file and still returns pixels",
		async run(check) {
			await withTempRoot(async (root) => {
				const red = solidPng(255, 0, 0);
				const { pack, model } = await makePack(root, red, cubeModel("#all"));
				const out = join(root, "mcp.png");
				const result = await handleModelAsset({
					mode: "preview",
					inputPath: model,
					packPath: pack,
					size: 64,
					outputPngPath: out,
				});
				check.equal(result.isError, undefined);
				const bytes = new Uint8Array(await readFile(out));
				check.ok(bytes.length > 0, "mcp file written");
				const { flat, width } = flatOf(bytes);
				assertRgba(check, flat, width, 96, 32, RED, "mcp file right");
			});
		},
	},
];
