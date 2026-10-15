import assert from "node:assert/strict";
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
import { cloneCanvas } from "../../src/cli/canvas-input.ts";
import { runRecolor } from "../../src/cli/cmd-recolor.ts";
import { runVariant } from "../../src/cli/cmd-variant.ts";
import {
	addLayer,
	addRegion,
	createCanvas,
	getPixel,
	setPixel,
	setRegionValue,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import { getMaterialPalette } from "../../src/core/material.ts";
import { recolorRolelessCanvas } from "../../src/core/recolor.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import { decodePng, encodePng } from "../../src/io/png.ts";
import {
	handleCreateVariants,
	handleRecolorAsset,
} from "../../src/mcp/handlers.ts";
import { captureQuantizeStreams } from "./quantize-palette-cases.ts";

/**
 * Flat-raster (PNG) recolor and variant coverage, written Red-first: the
 * role-less engine is still a skeleton returning zero changes, so every
 * mapping assertion below fails until the core pass is implemented. The
 * .mcpx pin hashes guard the frozen editable path against regressions.
 */

const SWORD_MCPX = "tests/cli/fixtures/sword.mcpx";
const JPG_FIXTURE = "tests/cli/fixtures/px-8x8.png".replace(/\.png$/, ".jpg");

const RECOLOR_IRON_MCPX_SHA =
	"31d29cf7f90f56e8341686b06cc7373ff5f25a4bd378c5fa86ce24f406fc9f34";
const VARIANT_COPPER_MCPX_SHA =
	"69c30bd0b33f6aa773937dc80b0831216e3f3805fdfbed6a15c311ea4683f245";

export interface PngRecolorCase {
	name: string;
	run(): Promise<void>;
}

function gray(value: number): RGBA {
	return { r: value, g: value, b: value, a: 255 };
}

function bandEntry(
	materialId: string,
	band: "shadow" | "base" | "highlight",
): RGBA {
	const entry = getMaterialPalette(materialId).entries.find(
		(candidate) => candidate.role === band,
	);
	assert.ok(entry !== undefined, `material ${materialId} needs ${band}`);
	return { ...entry.color };
}

function paintStrip(colors: RGBA[]): PixelCanvas {
	const canvas = createCanvas(colors.length, 1);
	const layer = addLayer(canvas, { id: "base" });
	colors.forEach((color, x) => {
		setPixel(canvas, layer.id, x, 0, color);
	});
	return canvas;
}

function stripPixels(canvas: PixelCanvas): RGBA[] {
	const out: RGBA[] = [];
	for (let x = 0; x < canvas.width; x += 1) {
		out.push(getPixel(canvas, "base", x, 0));
	}
	return out;
}

function sha256Hex(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError) {
			return error.code;
		}
		throw error;
	}
	return "NO_THROW";
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "recolor-png-"));
	try {
		await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeStrip(
	root: string,
	name: string,
	colors: RGBA[],
): Promise<string> {
	const path = join(root, name);
	await writeFile(path, encodePng(paintStrip(colors)));
	return path;
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

function successResult(out: Uint8Array): Record<string, unknown> {
	const body = parseEnvelope(out);
	assert.equal(body.success, true);
	assert.ok(body.result !== undefined);
	return body.result;
}

function failureCode(call: CliCall): string {
	const raw =
		call.out.length > 0 ? Buffer.from(call.out).toString("utf8") : call.err;
	return (parseEnvelope(raw).error?.code ?? "NO_ERROR") as string;
}

async function decodedStrip(path: string): Promise<RGBA[]> {
	return stripPixels(decodePng(new Uint8Array(await readFile(path))).canvas);
}

export const RECOLOR_PNG_CASES: PngRecolorCase[] = [
	{
		name: "roleless maps gray bands to the target material palette",
		async run() {
			const canvas = paintStrip([gray(20), gray(120), gray(200)]);
			const report = recolorRolelessCanvas(canvas, "iron");
			assert.equal(report.pixelsChanged, 3);
			assert.deepEqual(stripPixels(canvas), [
				bandEntry("iron", "shadow"),
				bandEntry("iron", "base"),
				bandEntry("iron", "highlight"),
			]);
		},
	},
	{
		name: "roleless keeps transparent pixels and hidden RGB byte-identical",
		async run() {
			const canvas = paintStrip([
				{ r: 0, g: 0, b: 0, a: 0 },
				{ r: 17, g: 34, b: 51, a: 0 },
				gray(20),
				gray(200),
			]);
			const report = recolorRolelessCanvas(canvas, "iron");
			assert.deepEqual(stripPixels(canvas), [
				{ r: 0, g: 0, b: 0, a: 0 },
				{ r: 17, g: 34, b: 51, a: 0 },
				bandEntry("iron", "shadow"),
				bandEntry("iron", "highlight"),
			]);
			assert.equal(report.pixelsChanged, 2);
		},
	},
	{
		name: "roleless limits writes to the region mask without touching it",
		async run() {
			const canvas = paintStrip([gray(20), gray(20), gray(20), gray(20)]);
			const region = addRegion(canvas, { id: "blade" });
			setRegionValue(canvas, region.id, 1, 0, 1);
			setRegionValue(canvas, region.id, 2, 0, 1);
			const maskBefore = region.mask.slice();
			const report = recolorRolelessCanvas(canvas, "crystal", {
				regionId: "blade",
			});
			assert.deepEqual(stripPixels(canvas), [
				gray(20),
				bandEntry("crystal", "shadow"),
				bandEntry("crystal", "shadow"),
				gray(20),
			]);
			assert.deepEqual(region.mask, maskBefore);
			assert.equal(report.pixelsChanged, 2);
		},
	},
	{
		name: "roleless rejects unknown materials and regions before writing",
		async run() {
			const canvas = paintStrip([gray(100), gray(100)]);
			const before = stripPixels(canvas);
			assert.equal(
				codeOf(() => recolorRolelessCanvas(canvas, "steel")),
				"INVALID_ARGUMENT",
			);
			assert.equal(
				codeOf(() =>
					recolorRolelessCanvas(canvas, "iron", { regionId: "ghost" }),
				),
				"REGION_NOT_FOUND",
			);
			assert.deepEqual(stripPixels(canvas), before);
		},
	},
	{
		name: "canvas clone keeps version and isolates buffers",
		async run() {
			const source = paintStrip([gray(10), gray(200)]);
			source.metadata.tag = "origin";
			const copy = cloneCanvas(source);
			assert.equal(copy.version, source.version);
			assert.deepEqual(stripPixels(copy), stripPixels(source));
			setPixel(copy, "base", 0, 0, gray(200));
			assert.deepEqual(getPixel(source, "base", 0, 0), gray(10));
			assert.equal(copy.metadata.tag, "origin");
		},
	},
	{
		name: "recolor png maps each gray band to iron",
		async run() {
			await withRoot(async (root) => {
				const before = [gray(20), gray(120), gray(200)];
				const input = await writeStrip(root, "chip.png", before);
				const inputHash = sha256Hex(new Uint8Array(await readFile(input)));
				const output = join(root, "out.png");
				const source = join(root, "out.mcpx");
				const result = await callRecolor(input, {
					material: "iron",
					output,
					source,
				});
				assert.equal(result.code, 0);
				assert.equal(successResult(result.out).pixelsChanged, 3);
				assert.deepEqual(await decodedStrip(output), [
					bandEntry("iron", "shadow"),
					bandEntry("iron", "base"),
					bandEntry("iron", "highlight"),
				]);
				assert.equal(
					sha256Hex(new Uint8Array(await readFile(input))),
					inputHash,
					"source stays byte-identical",
				);
			});
		},
	},
	{
		name: "recolor png restores unselected pixels including hidden rgb",
		async run() {
			await withRoot(async (root) => {
				const input = await writeStrip(root, "chip.png", [
					gray(20),
					gray(120),
					gray(200),
				]);
				const output = join(root, "out.png");
				const result = await callRecolor(input, {
					material: "iron",
					output,
					selection: "rect:1,0,1,1",
				});
				assert.equal(result.code, 0);
				assert.deepEqual(await decodedStrip(output), [
					gray(20),
					bandEntry("iron", "base"),
					gray(200),
				]);
				assert.equal(successResult(result.out).modifiedPixels, 1);
			});
		},
	},
	{
		name: "recolor png keeps transparent pixels and hidden rgb",
		async run() {
			await withRoot(async (root) => {
				const input = await writeStrip(root, "chip.png", [
					{ r: 0, g: 0, b: 0, a: 0 },
					{ r: 17, g: 34, b: 51, a: 0 },
					gray(20),
					gray(200),
				]);
				const output = join(root, "out.png");
				const result = await callRecolor(input, {
					material: "iron",
					output,
				});
				assert.equal(result.code, 0);
				assert.equal(successResult(result.out).pixelsChanged, 2);
				assert.deepEqual(await decodedStrip(output), [
					{ r: 0, g: 0, b: 0, a: 0 },
					{ r: 17, g: 34, b: 51, a: 0 },
					bandEntry("iron", "shadow"),
					bandEntry("iron", "highlight"),
				]);
			});
		},
	},
	{
		name: "recolor refuses jpeg with invalid argument and writes nothing",
		async run() {
			await withRoot(async (root) => {
				const before = await readdir(root);
				const result = await callRecolor(JPG_FIXTURE, {
					material: "iron",
					output: join(root, "out.png"),
				});
				assert.equal(result.code, 2);
				assert.equal(failureCode(result), "INVALID_ARGUMENT");
				assert.deepEqual(await readdir(root), before);
			});
		},
	},
	{
		name: "recolor png reports a missing region without writing",
		async run() {
			await withRoot(async (root) => {
				const input = await writeStrip(root, "chip.png", [gray(120)]);
				const result = await callRecolor(input, {
					material: "iron",
					output: join(root, "out.png"),
					region: "ghost",
				});
				assert.equal(result.code, 2);
				assert.equal(failureCode(result), "REGION_NOT_FOUND");
				assert.deepEqual(await readdir(root), ["chip.png"]);
			});
		},
	},
	{
		name: "recolor png preflights file targets before stdout bytes",
		async run() {
			await withRoot(async (root) => {
				const input = await writeStrip(root, "chip.png", [gray(120)]);
				const taken = join(root, "taken.png");
				await writeFile(taken, "sentinel");
				const result = await callRecolor(input, {
					material: "iron",
					output: taken,
					stdout: true,
				});
				assert.equal(result.code, 4);
				assert.equal(result.out.length, 0);
				assert.equal(failureCode(result), "OUTPUT_EXISTS");
				assert.equal(await readFile(taken, "utf8"), "sentinel");
			});
		},
	},
	{
		name: "variant png fans out per material from the pristine source",
		async run() {
			await withRoot(async (root) => {
				const grays = [gray(20), gray(120), gray(200)];
				const input = await writeStrip(root, "chip.png", grays);
				const inputHash = sha256Hex(new Uint8Array(await readFile(input)));
				const outA = join(root, "a");
				const outB = join(root, "b");
				const first = await callVariant(input, {
					materials: "iron,copper",
					outputDir: outA,
					mkdir: true,
				});
				assert.equal(first.code, 0, JSON.stringify(parseEnvelope(first.out)));
				assert.deepEqual((await readdir(outA)).sort(), [
					"chip_copper.mcpx",
					"chip_copper.png",
					"chip_iron.mcpx",
					"chip_iron.png",
				]);
				const ironHash = sha256Hex(
					new Uint8Array(await readFile(join(outA, "chip_iron.png"))),
				);
				const copperHash = sha256Hex(
					new Uint8Array(await readFile(join(outA, "chip_copper.png"))),
				);
				assert.notEqual(ironHash, copperHash);
				assert.notEqual(ironHash, inputHash);
				assert.notEqual(copperHash, inputHash);
				assert.deepEqual(await decodedStrip(join(outA, "chip_iron.png")), [
					bandEntry("iron", "shadow"),
					bandEntry("iron", "base"),
					bandEntry("iron", "highlight"),
				]);
				const second = await callVariant(input, {
					materials: "copper,iron",
					outputDir: outB,
					mkdir: true,
				});
				assert.equal(second.code, 0);
				for (const material of ["iron", "copper"]) {
					assert.equal(
						sha256Hex(
							new Uint8Array(
								await readFile(join(outB, `chip_${material}.png`)),
							),
						),
						sha256Hex(
							new Uint8Array(
								await readFile(join(outA, `chip_${material}.png`)),
							),
						),
						`${material} is order-independent`,
					);
				}
				assert.equal(
					sha256Hex(new Uint8Array(await readFile(input))),
					inputHash,
					"source stays byte-identical",
				);
			});
		},
	},
	{
		name: "variant png matches standalone recolor bytes per material",
		async run() {
			await withRoot(async (root) => {
				const input = await writeStrip(root, "chip.png", [
					gray(20),
					gray(120),
					gray(200),
				]);
				const outDir = join(root, "variants");
				const solo = join(root, "solo.png");
				assert.equal(
					(
						await callVariant(input, {
							materials: "iron",
							outputDir: outDir,
							mkdir: true,
						})
					).code,
					0,
				);
				assert.equal(
					(await callRecolor(input, { material: "iron", output: solo })).code,
					0,
				);
				assert.equal(
					sha256Hex(
						new Uint8Array(await readFile(join(outDir, "chip_iron.png"))),
					),
					sha256Hex(new Uint8Array(await readFile(solo))),
				);
			});
		},
	},
	{
		name: "variant png refuses bad materials, missing dir, and conflicts file-free",
		async run() {
			await withRoot(async (root) => {
				const input = await writeStrip(root, "chip.png", [gray(120)]);
				const unknown = await callVariant(input, {
					materials: "iron,adamantine",
					outputDir: join(root, "out"),
					mkdir: true,
				});
				assert.equal(unknown.code, 2);
				assert.equal(failureCode(unknown), "INVALID_ARGUMENT");
				const missing = await callVariant(input, {
					materials: "iron",
					outputDir: join(root, "missing"),
				});
				assert.equal(missing.code, 4);
				assert.equal(failureCode(missing), "FILESYSTEM_ERROR");
				const outDir = join(root, "out");
				await mkdir(outDir);
				await writeFile(join(outDir, "chip_iron.png"), "sentinel");
				const conflict = await callVariant(input, {
					materials: "iron,copper",
					outputDir: outDir,
				});
				assert.equal(conflict.code, 4);
				assert.equal(failureCode(conflict), "OUTPUT_EXISTS");
				assert.deepEqual(await readdir(outDir), ["chip_iron.png"]);
				assert.equal(
					await readFile(join(outDir, "chip_iron.png"), "utf8"),
					"sentinel",
				);
			});
		},
	},
	{
		name: "mcpx recolor and variant outputs keep their pinned bytes",
		async run() {
			await withRoot(async (root) => {
				const recolored = join(root, "recolor-iron.mcpx");
				const recoloredPng = join(root, "recolor-iron.png");
				const recolor = await callRecolor(SWORD_MCPX, {
					material: "iron",
					output: recoloredPng,
					source: recolored,
				});
				assert.equal(recolor.code, 0);
				assert.equal(
					sha256Hex(await readFile(recolored, "utf8")),
					RECOLOR_IRON_MCPX_SHA,
				);
				const outDir = join(root, "variants");
				const fanned = await callVariant(SWORD_MCPX, {
					materials: "iron,copper",
					outputDir: outDir,
					mkdir: true,
				});
				assert.equal(fanned.code, 0);
				assert.equal(
					sha256Hex(await readFile(join(outDir, "sword_iron.mcpx"), "utf8")),
					RECOLOR_IRON_MCPX_SHA,
				);
				assert.equal(
					sha256Hex(await readFile(join(outDir, "sword_copper.mcpx"), "utf8")),
					VARIANT_COPPER_MCPX_SHA,
				);
			});
		},
	},
	{
		name: "mcp recolor png matches the cli bytes and repeats identically",
		async run() {
			await withRoot(async (root) => {
				const input = await writeStrip(root, "chip.png", [
					gray(20),
					gray(120),
					gray(200),
				]);
				const solo = join(root, "solo.png");
				const soloSource = join(root, "solo.mcpx");
				assert.equal(
					(
						await callRecolor(input, {
							material: "iron",
							output: solo,
							source: soloSource,
						})
					).code,
					0,
				);
				const first = await handleRecolorAsset({
					sourcePath: input,
					material: "iron",
				});
				assert.notEqual(first.isError, true);
				const firstText = first.content[0];
				assert.ok(firstText?.type === "text");
				const firstBody = JSON.parse(
					firstText.type === "text" ? firstText.text : "null",
				) as { pixelsChanged?: unknown; pngBase64?: string; mcpxText?: string };
				assert.equal(firstBody.pixelsChanged, 3);
				assert.ok(typeof firstBody.pngBase64 === "string");
				assert.ok(typeof firstBody.mcpxText === "string");
				assert.deepEqual(
					stripPixels(
						decodePng(
							new Uint8Array(Buffer.from(firstBody.pngBase64, "base64")),
						).canvas,
					),
					[
						bandEntry("iron", "shadow"),
						bandEntry("iron", "base"),
						bandEntry("iron", "highlight"),
					],
				);
				assert.equal(
					sha256Hex(Buffer.from(firstBody.pngBase64, "base64")),
					sha256Hex(new Uint8Array(await readFile(solo))),
				);
				assert.equal(firstBody.mcpxText, await readFile(soloSource, "utf8"));
				const second = await handleRecolorAsset({
					sourcePath: input,
					material: "iron",
				});
				assert.equal(JSON.stringify(second), JSON.stringify(first));
			});
		},
	},
	{
		name: "mcp variants png matches the cli per-material bytes",
		async run() {
			await withRoot(async (root) => {
				const input = await writeStrip(root, "chip.png", [
					gray(20),
					gray(120),
					gray(200),
				]);
				const cliDir = join(root, "cli");
				assert.equal(
					(
						await callVariant(input, {
							materials: "iron,copper",
							outputDir: cliDir,
							mkdir: true,
						})
					).code,
					0,
				);
				const mcpDir = join(root, "mcp");
				await mkdir(mcpDir);
				const result = await handleCreateVariants({
					sourcePath: input,
					materials: ["iron", "copper"],
					outputDir: mcpDir,
				});
				assert.notEqual(result.isError, true);
				for (const material of ["iron", "copper"]) {
					assert.equal(
						sha256Hex(
							new Uint8Array(
								await readFile(join(mcpDir, `chip_${material}.png`)),
							),
						),
						sha256Hex(
							new Uint8Array(
								await readFile(join(cliDir, `chip_${material}.png`)),
							),
						),
						`${material} matches the cli bytes`,
					);
				}
			});
		},
	},
	{
		name: "mcp refuses jpeg and missing regions with matching codes",
		async run() {
			const jpeg = await handleRecolorAsset({
				sourcePath: JPG_FIXTURE,
				material: "iron",
			});
			assert.equal(jpeg.isError, true);
			const jpegText = jpeg.content[0];
			assert.ok(jpegText?.type === "text");
			assert.equal(
				JSON.parse(jpegText.type === "text" ? jpegText.text : "null").code,
				"INVALID_ARGUMENT",
			);
			await withRoot(async (root) => {
				const input = await writeStrip(root, "chip.png", [gray(120)]);
				const missing = await handleRecolorAsset({
					sourcePath: input,
					material: "iron",
					region: "ghost",
				});
				assert.equal(missing.isError, true);
				const missingText = missing.content[0];
				assert.ok(missingText?.type === "text");
				assert.equal(
					JSON.parse(missingText.type === "text" ? missingText.text : "null")
						.code,
					"REGION_NOT_FOUND",
				);
				const unknown = await handleCreateVariants({
					sourcePath: input,
					materials: ["iron", "adamantine"],
					outputDir: root,
				});
				assert.equal(unknown.isError, true);
				const unknownText = unknown.content[0];
				assert.ok(unknownText?.type === "text");
				assert.equal(
					JSON.parse(unknownText.type === "text" ? unknownText.text : "null")
						.code,
					"INVALID_ARGUMENT",
				);
			});
		},
	},
];
