import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecolor } from "../../src/cli/cmd-recolor.ts";
import { runVariant } from "../../src/cli/cmd-variant.ts";
import {
	addLayer,
	addRegion,
	createAuthoringPalette,
	createCanvas,
	setPixel,
	setRegionValue,
} from "../../src/core/canvas.ts";
import type {
	AuthoringPalette,
	PixelCanvas,
	RGBA,
} from "../../src/core/types.ts";
import { decodePng, encodePng } from "../../src/io/png.ts";
import { serializeMcpx } from "../../src/mcpx/index.ts";
import { VANILLA_PALETTE } from "../../src/style/palette.ts";
import { captureQuantizeStreams } from "./quantize-palette-cases.ts";

export interface RecolorFamilyCase {
	name: string;
	run(): Promise<void>;
}

function parseHexColor(hex: string): RGBA {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
		a: 255,
	};
}

const GOLD_RAMP = {
	outline: parseHexColor(VANILLA_PALETTE.gold.outline),
	shadow: parseHexColor(VANILLA_PALETTE.gold.shadow),
	dark: parseHexColor(VANILLA_PALETTE.gold.dark),
	base: parseHexColor(VANILLA_PALETTE.gold.base),
	light: parseHexColor(VANILLA_PALETTE.gold.light),
	highlight: parseHexColor(VANILLA_PALETTE.gold.highlight),
};

const EMERALD_RAMP = {
	outline: parseHexColor(VANILLA_PALETTE.emerald.outline),
	shadow: parseHexColor(VANILLA_PALETTE.emerald.shadow),
	dark: parseHexColor(VANILLA_PALETTE.emerald.dark),
	base: parseHexColor(VANILLA_PALETTE.emerald.base),
	light: parseHexColor(VANILLA_PALETTE.emerald.light),
	highlight: parseHexColor(VANILLA_PALETTE.emerald.highlight),
};

const SWORD_PALETTE: AuthoringPalette = createAuthoringPalette([
	{ id: ".", color: { r: 0, g: 0, b: 0, a: 0 } },
	{ id: "O", color: { r: 10, g: 10, b: 10, a: 255 }, role: "outline" },
	{ id: "S", color: { r: 60, g: 60, b: 60, a: 255 }, role: "shadow" },
	{ id: "D", color: { r: 105, g: 105, b: 105, a: 255 }, role: "dark" },
	{ id: "B", color: { r: 150, g: 150, b: 150, a: 255 }, role: "base" },
	{ id: "L", color: { r: 190, g: 190, b: 190, a: 255 }, role: "light" },
	{
		id: "H",
		color: { r: 235, g: 235, b: 235, a: 255 },
		role: "highlight",
	},
	{ id: "G", color: { r: 110, g: 60, b: 25, a: 255 }, role: "custom" },
	{ id: "P", color: { r: 75, g: 40, b: 15, a: 255 }, role: "accent" },
]);

function buildSwordCanvas(): PixelCanvas {
	const canvas = createCanvas(16, 16, { palette: SWORD_PALETTE });
	const layer = addLayer(canvas, { id: "main" });
	const region = addRegion(canvas, { id: "hilt", name: "Hilt" });

	const outlineEntry = SWORD_PALETTE.entries.find((c) => c.role === "outline");
	if (outlineEntry === undefined) {
		throw new Error("missing outline entry");
	}
	const outlineColor = outlineEntry.color;
	setPixel(canvas, layer.id, 7, 1, outlineColor);
	for (let y = 2; y <= 7; y += 1) {
		setPixel(canvas, layer.id, 6, y, outlineColor);
		setPixel(canvas, layer.id, 8, y, outlineColor);
	}
	setPixel(canvas, layer.id, 7, 7, outlineColor);

	const bladeRoles = [
		{ y: 2, role: "highlight" },
		{ y: 3, role: "light" },
		{ y: 4, role: "base" },
		{ y: 5, role: "dark" },
		{ y: 6, role: "shadow" },
	];
	for (const item of bladeRoles) {
		const entry = SWORD_PALETTE.entries.find((c) => c.role === item.role);
		if (entry === undefined) {
			throw new Error(`missing role ${item.role}`);
		}
		setPixel(canvas, layer.id, 7, item.y, entry.color);
	}

	const guardColor: RGBA = { r: 110, g: 60, b: 25, a: 255 };
	const gripColor: RGBA = { r: 75, g: 40, b: 15, a: 255 };
	for (let x = 4; x <= 10; x += 1) {
		setPixel(canvas, layer.id, x, 8, guardColor);
		setRegionValue(canvas, region.id, x, 8, 1);
	}
	for (let y = 9; y <= 11; y += 1) {
		setPixel(canvas, layer.id, 7, y, gripColor);
		setRegionValue(canvas, region.id, 7, y, 1);
	}
	for (let x = 6; x <= 8; x += 1) {
		setPixel(canvas, layer.id, x, 12, guardColor);
		setRegionValue(canvas, region.id, x, 12, 1);
	}

	return canvas;
}

interface CliCall {
	code: number;
	out: Uint8Array;
	err: string;
}

async function callRecolor(
	input: string,
	options: Parameters<typeof runRecolor>[1],
): Promise<CliCall> {
	const capture = captureQuantizeStreams();
	const code = await runRecolor(input, options, true, capture.streams);
	return { code, out: capture.stdout(), err: capture.stderrText() };
}

async function callVariant(
	source: string,
	options: Parameters<typeof runVariant>[1],
): Promise<CliCall> {
	const capture = captureQuantizeStreams();
	const code = await runVariant(source, options, true, capture.streams);
	return { code, out: capture.stdout(), err: capture.stderrText() };
}

interface CliEnvelope {
	success: boolean;
	result?: Record<string, unknown>;
	error?: { code: string; message: string };
}

function parseEnvelope(raw: Uint8Array | string): CliEnvelope {
	const text =
		typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
	return JSON.parse(text.trim()) as CliEnvelope;
}

function failureCode(call: CliCall): string {
	const raw =
		call.out.length > 0 ? Buffer.from(call.out).toString("utf8") : call.err;
	return (parseEnvelope(raw).error?.code ?? "NO_ERROR") as string;
}

function failureMessage(call: CliCall): string {
	const raw =
		call.out.length > 0 ? Buffer.from(call.out).toString("utf8") : call.err;
	return (parseEnvelope(raw).error?.message ?? "") as string;
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "recolor-family-"));
	try {
		await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function prepareSwordFixtures(root: string): Promise<{
	mcpxPath: string;
	pngPath: string;
}> {
	const canvas = buildSwordCanvas();
	const mcpxText = serializeMcpx(canvas);
	const pngBytes = encodePng(canvas);
	const mcpxPath = join(root, "sword.mcpx");
	const pngPath = join(root, "sword.png");
	await writeFile(mcpxPath, mcpxText, "utf8");
	await writeFile(pngPath, pngBytes);
	return { mcpxPath, pngPath };
}

async function readPixelAt(
	pngPath: string,
	x: number,
	y: number,
): Promise<RGBA> {
	const bytes = new Uint8Array(await readFile(pngPath));
	const decoded = decodePng(bytes);
	const offset = (y * decoded.canvas.width + x) * 4;
	const decodedLayer = decoded.canvas.layers[0];
	if (decodedLayer === undefined) {
		throw new Error("missing layer in decoded png");
	}
	const pixels = decodedLayer.pixels;
	return {
		r: pixels[offset] as number,
		g: pixels[offset + 1] as number,
		b: pixels[offset + 2] as number,
		a: pixels[offset + 3] as number,
	};
}

export const RECOLOR_FAMILY_CASES: RecolorFamilyCase[] = [
	{
		name: "recolor rejects when both --material and --family are missing (INVALID_ARGUMENT)",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const call = await callRecolor(mcpxPath, {});
				assert.equal(call.code, 2, "exit code 2");
				assert.equal(
					failureCode(call),
					"INVALID_ARGUMENT",
					"error code INVALID_ARGUMENT",
				);
				assert.ok(
					failureMessage(call).includes("either --material or --family"),
					`expected message to mention either --material or --family, got: ${failureMessage(call)}`,
				);
			}),
	},
	{
		name: "recolor rejects when both --material and --family are given (ARGUMENT_CONFLICT)",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const call = await callRecolor(mcpxPath, {
					material: "iron",
					family: "gold",
				});
				assert.equal(call.code, 2, "exit code 2");
				assert.equal(
					failureCode(call),
					"ARGUMENT_CONFLICT",
					"error code ARGUMENT_CONFLICT",
				);
			}),
	},
	{
		name: "recolor CLI with --family recolors sword .mcpx to gold",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const outPng = join(root, "out.png");
				const call = await callRecolor(mcpxPath, {
					family: "gold",
					output: outPng,
				});
				assert.equal(call.code, 0, "exit code 0");
				const tipPixel = await readPixelAt(outPng, 7, 1);
				assert.deepEqual(
					tipPixel,
					GOLD_RAMP.outline,
					"blade tip is gold outline",
				);
			}),
	},
	{
		name: "recolor CLI with --family and --selection scopes the write",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const outPng = join(root, "out.png");
				const call = await callRecolor(mcpxPath, {
					family: "gold",
					selection: "rect:0,0,16,6",
					output: outPng,
				});
				assert.equal(call.code, 0, "exit code 0");
				const tipPixel = await readPixelAt(outPng, 7, 1);
				assert.deepEqual(
					tipPixel,
					GOLD_RAMP.outline,
					"selected tip is gold outline",
				);
				const basePixel = await readPixelAt(outPng, 7, 7);
				assert.deepEqual(
					basePixel,
					{ r: 10, g: 10, b: 10, a: 255 },
					"unselected blade base is unchanged",
				);
			}),
	},
	{
		name: "recolor CLI with --family and --region limits the write to region",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const outPng = join(root, "out.png");
				const call = await callRecolor(mcpxPath, {
					family: "gold",
					region: "hilt",
					output: outPng,
				});
				assert.equal(call.code, 0, "exit code 0");
				const tipPixel = await readPixelAt(outPng, 7, 1);
				assert.deepEqual(
					tipPixel,
					{ r: 10, g: 10, b: 10, a: 255 },
					"blade outside region is untouched",
				);
			}),
	},
	{
		name: "variant rejects when neither --materials nor --families are given (INVALID_ARGUMENT)",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const outDir = join(root, "out");
				const call = await callVariant(mcpxPath, { outputDir: outDir });
				assert.equal(call.code, 2, "exit code 2");
				assert.equal(
					failureCode(call),
					"INVALID_ARGUMENT",
					"error code INVALID_ARGUMENT",
				);
				assert.ok(
					failureMessage(call).includes(
						"at least one material or family via --materials or --families",
					),
					`expected message to mention materials or families, got: ${failureMessage(call)}`,
				);
			}),
	},
	{
		name: "variant with --families fans out to per-family files",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const outDir = join(root, "out");
				const call = await callVariant(mcpxPath, {
					families: "gold,emerald",
					outputDir: outDir,
					mkdir: true,
				});
				assert.equal(call.code, 0, "exit code 0");
				const goldPng = join(outDir, "sword_gold.png");
				const goldTip = await readPixelAt(goldPng, 7, 1);
				assert.deepEqual(
					goldTip,
					GOLD_RAMP.outline,
					"sword_gold.png has gold outline",
				);
				const emeraldPng = join(outDir, "sword_emerald.png");
				const emeraldTip = await readPixelAt(emeraldPng, 7, 1);
				assert.deepEqual(
					emeraldTip,
					EMERALD_RAMP.outline,
					"sword_emerald.png has emerald outline",
				);
			}),
	},
	{
		name: "variant union of --materials and --families produces both variants",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const outDir = join(root, "out");
				const call = await callVariant(mcpxPath, {
					materials: "iron",
					families: "gold",
					outputDir: outDir,
					mkdir: true,
				});
				assert.equal(call.code, 0, "exit code 0");
				const ironPng = join(outDir, "sword_iron.png");
				const goldPng = join(outDir, "sword_gold.png");
				const ironBytes = await readFile(ironPng);
				const goldBytes = await readFile(goldPng);
				assert.ok(ironBytes.length > 0, "sword_iron.png exists");
				assert.ok(goldBytes.length > 0, "sword_gold.png exists");
			}),
	},
	{
		name: "variant rejects duplicate name collision between materials and families (ARGUMENT_CONFLICT)",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const outDir = join(root, "out");
				const call = await callVariant(mcpxPath, {
					materials: "iron",
					families: "iron",
					outputDir: outDir,
					mkdir: true,
				});
				assert.equal(call.code, 2, "exit code 2");
				assert.equal(
					failureCode(call),
					"ARGUMENT_CONFLICT",
					"error code ARGUMENT_CONFLICT",
				);
			}),
	},
	{
		name: "variant respects --name-template with {stem} and {name}",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const outDir = join(root, "out");
				const call = await callVariant(mcpxPath, {
					families: "gold",
					nameTemplate: "{name}_{stem}",
					outputDir: outDir,
					mkdir: true,
				});
				assert.equal(call.code, 0, "exit code 0");
				const templatedPng = join(outDir, "gold_sword.png");
				const bytes = await readFile(templatedPng);
				assert.ok(bytes.length > 0, "gold_sword.png exists");
			}),
	},
	{
		name: "variant with --selection and --region scopes the family variant generation",
		run: () =>
			withRoot(async (root) => {
				const { mcpxPath } = await prepareSwordFixtures(root);
				const outDir = join(root, "out");
				const call = await callVariant(mcpxPath, {
					families: "gold",
					region: "hilt",
					outputDir: outDir,
					mkdir: true,
				});
				assert.equal(call.code, 0, "exit code 0");
				const outPng = join(outDir, "sword_gold.png");
				const tipPixel = await readPixelAt(outPng, 7, 1);
				assert.deepEqual(
					tipPixel,
					{ r: 10, g: 10, b: 10, a: 255 },
					"blade outside region is untouched in variant output",
				);
			}),
	},
];
