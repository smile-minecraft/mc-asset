import {
	addLayer,
	addRegion,
	createAuthoringPalette,
	createCanvas,
	getPixel,
	getRegionValue,
	replaceLayerPixels,
	replaceRegionMask,
	setPixel,
	setRegionValue,
} from "../../src/core/canvas.ts";
import type { FixedErrorCode } from "../../src/core/errors.ts";
import {
	exitCodeForError,
	McAssetError,
	resolveExitCode,
} from "../../src/core/errors.ts";
import type { PaletteRole, Rect, RGBA } from "../../src/core/types.ts";
import {
	assertRectInBounds,
	assertValidCanvas,
	BYTES_PER_PIXEL,
	checkResourceLimits,
	estimateMemoryBytes,
	MEMORY_BUDGET_BYTES,
	validateColor,
	validateCoordinate,
	validateDimension,
	validateLayerPixelsSize,
	validateMaskValue,
	validateOpacity,
	validateRect,
	validateRegionMaskSize,
} from "../../src/core/validate.ts";

/** Runner-agnostic assertion surface: bun:test and node:test entries adapt to this. */
export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throwsCode(fn: () => unknown, code: string, message?: string): void;
}

export interface ModelCase {
	name: string;
	run(check: CaseCheck): void;
}

function throwsCode(check: CaseCheck, fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError && error.code === code) {
			return;
		}
		check.fail(
			`expected McAssetError(${code}) but got ${error instanceof McAssetError ? error.code : String(error)}`,
		);
	}
	check.fail(`expected McAssetError(${code}) but nothing was thrown`);
}

function seedPixels(count: number, seed: number): RGBA[] {
	// Integer-only LCG: deterministic seed, no randomness source, no transcendental functions.
	let state = seed >>> 0;
	const out: RGBA[] = [];
	for (let i = 0; i < count; i += 1) {
		state = (state * 1664525 + 1013904223) >>> 0;
		const r = (state >>> 24) & 0xff;
		state = (state * 1664525 + 1013904223) >>> 0;
		const g = (state >>> 24) & 0xff;
		state = (state * 1664525 + 1013904223) >>> 0;
		const b = (state >>> 24) & 0xff;
		state = (state * 1664525 + 1013904223) >>> 0;
		const a = (state >>> 24) & 0xff;
		out.push({ r, g, b, a });
	}
	return out;
}

export const MODEL_CASES: ModelCase[] = [
	{
		name: "dimension 0 is rejected",
		run: (check) =>
			throwsCode(check, () => createCanvas(0, 16), "INVALID_DIMENSION"),
	},
	{
		name: "negative dimension is rejected",
		run: (check) =>
			throwsCode(check, () => createCanvas(-4, 16), "INVALID_DIMENSION"),
	},
	{
		name: "non-integer dimension is rejected",
		run: (check) =>
			throwsCode(check, () => createCanvas(16.5, 16), "INVALID_DIMENSION"),
	},
	{
		name: "dimension above 4096 is rejected",
		run: (check) =>
			throwsCode(check, () => createCanvas(4097, 16), "INVALID_DIMENSION"),
	},
	{
		name: "dimension boundaries 1 and 4096 are accepted",
		run: (check) => {
			const tiny = createCanvas(1, 1);
			check.equal(tiny.width, 1, "width 1");
			const huge = createCanvas(4096, 16);
			check.equal(huge.width, 4096, "width 4096");
			check.equal(huge.version, 1, "version is 1");
			check.deepEqual(huge.layers, [], "starts with no layers");
			check.deepEqual(huge.regions, [], "starts with no regions");
		},
	},
	{
		name: "validateDimension rejects NaN",
		run: (check) =>
			throwsCode(
				check,
				() => validateDimension(Number.NaN),
				"INVALID_DIMENSION",
			),
	},
	{
		name: "non-integer coordinate is rejected without rounding",
		run: (check) => {
			const canvas = createCanvas(16, 16);
			const layer = addLayer(canvas, { id: "base" });
			throwsCode(
				check,
				() => validateCoordinate(5.2, "x"),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => setPixel(canvas, layer.id, 5.2, 4, { r: 1, g: 2, b: 3, a: 255 }),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => getPixel(canvas, layer.id, 4, 2.5),
				"INVALID_COORDINATE",
			);
			// The failed write must not have rounded-and-written anywhere observable.
			check.deepEqual(
				getPixel(canvas, layer.id, 5, 4),
				{ r: 0, g: 0, b: 0, a: 0 },
				"no rounded write at (5,4)",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 4, 2),
				{ r: 0, g: 0, b: 0, a: 0 },
				"no rounded write at (4,2)",
			);
		},
	},
	{
		name: "integer coordinate outside canvas is OUT_OF_BOUNDS",
		run: (check) => {
			const canvas = createCanvas(16, 16);
			const layer = addLayer(canvas, { id: "base" });
			throwsCode(
				check,
				() => getPixel(canvas, layer.id, 16, 0),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => getPixel(canvas, layer.id, -1, 0),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => setPixel(canvas, layer.id, 0, 16, { r: 1, g: 1, b: 1, a: 255 }),
				"OUT_OF_BOUNDS",
			);
		},
	},
	{
		name: "corner pixels are addressable",
		run: (check) => {
			const canvas = createCanvas(16, 16);
			const layer = addLayer(canvas, { id: "base" });
			setPixel(canvas, layer.id, 0, 0, { r: 10, g: 20, b: 30, a: 40 });
			setPixel(canvas, layer.id, 15, 15, { r: 50, g: 60, b: 70, a: 80 });
			check.deepEqual(
				getPixel(canvas, layer.id, 0, 0),
				{ r: 10, g: 20, b: 30, a: 40 },
				"(0,0)",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 15, 15),
				{ r: 50, g: 60, b: 70, a: 80 },
				"(15,15)",
			);
		},
	},
	{
		name: "hidden RGB under A=0 is fully preserved",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			const layer = addLayer(canvas, { id: "base" });
			setPixel(canvas, layer.id, 1, 2, { r: 255, g: 0, b: 0, a: 0 });
			check.deepEqual(
				getPixel(canvas, layer.id, 1, 2),
				{ r: 255, g: 0, b: 0, a: 0 },
				"#FF000000 kept",
			);
			setPixel(canvas, layer.id, 1, 2, { r: 0, g: 0, b: 0, a: 0 });
			check.deepEqual(
				getPixel(canvas, layer.id, 1, 2),
				{ r: 0, g: 0, b: 0, a: 0 },
				"#00000000 distinct",
			);
			setPixel(canvas, layer.id, 3, 0, { r: 17, g: 34, b: 51, a: 0 });
			const raw = layer.pixels;
			check.equal(raw[(0 * 4 + 3) * 4 + 0], 17, "raw R byte kept");
			check.equal(raw[(0 * 4 + 3) * 4 + 3], 0, "raw A byte kept");
		},
	},
	{
		name: "invalid color channels are rejected",
		run: (check) => {
			throwsCode(
				check,
				() => validateColor({ r: 256, g: 0, b: 0, a: 255 }),
				"INVALID_COLOR",
			);
			throwsCode(
				check,
				() => validateColor({ r: -1, g: 0, b: 0, a: 255 }),
				"INVALID_COLOR",
			);
			throwsCode(
				check,
				() => validateColor({ r: 1.5, g: 0, b: 0, a: 255 }),
				"INVALID_COLOR",
			);
			throwsCode(
				check,
				() => validateColor({ r: 0, g: 0, b: 0, a: 300 }),
				"INVALID_COLOR",
			);
			const canvas = createCanvas(4, 4);
			const layer = addLayer(canvas, { id: "base" });
			throwsCode(
				check,
				() => setPixel(canvas, layer.id, 0, 0, { r: 0, g: 0, b: 0, a: -1 }),
				"INVALID_COLOR",
			);
		},
	},
	{
		name: "rect shape violations are rejected",
		run: (check) => {
			const badX: Rect = { x: 0.5, y: 0, width: 4, height: 4 };
			throwsCode(check, () => validateRect(badX), "INVALID_COORDINATE");
			throwsCode(
				check,
				() => validateRect({ x: 0, y: 0, width: 0, height: 4 }),
				"INVALID_DIMENSION",
			);
			throwsCode(
				check,
				() => validateRect({ x: 0, y: 0, width: -2, height: 4 }),
				"INVALID_DIMENSION",
			);
			throwsCode(
				check,
				() => validateRect({ x: 0, y: 0, width: 2.5, height: 4 }),
				"INVALID_DIMENSION",
			);
			// Shape-valid rect passes shape validation even with negative origin.
			validateRect({ x: -2, y: 0, width: 4, height: 4 });
			// ...but fails the in-bounds check for a concrete canvas.
			throwsCode(
				check,
				() => assertRectInBounds(16, 16, { x: -2, y: 0, width: 4, height: 4 }),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => assertRectInBounds(16, 16, { x: 14, y: 14, width: 4, height: 4 }),
				"OUT_OF_BOUNDS",
			);
			assertRectInBounds(16, 16, { x: 12, y: 12, width: 4, height: 4 });
		},
	},
	{
		name: "layer pixel buffer size must match canvas",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			const layer = addLayer(canvas, { id: "base" });
			check.equal(
				layer.pixels.length,
				4 * 4 * BYTES_PER_PIXEL,
				"layer buffer exact size",
			);
			throwsCode(
				check,
				() => validateLayerPixelsSize(4, 4, new Uint8Array(10)),
				"INVALID_DIMENSION",
			);
			throwsCode(
				check,
				() => validateLayerPixelsSize(4, 4, new Uint8Array(4 * 4 * 4 + 4)),
				"INVALID_DIMENSION",
			);
			throwsCode(
				check,
				() => replaceLayerPixels(canvas, layer.id, new Uint8Array(10)),
				"INVALID_DIMENSION",
			);
			const replacement = new Uint8Array(4 * 4 * 4);
			replacement[0] = 9;
			replaceLayerPixels(canvas, layer.id, replacement);
			check.deepEqual(
				getPixel(canvas, layer.id, 0, 0),
				{ r: 9, g: 0, b: 0, a: 0 },
				"replaced buffer readable",
			);
		},
	},
	{
		name: "region mask size must match canvas",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			const region = addRegion(canvas, { id: "blade" });
			check.equal(region.mask.length, 4 * 4, "mask exact size");
			throwsCode(
				check,
				() => validateRegionMaskSize(4, 4, new Uint8Array(15)),
				"INVALID_MASK_SIZE",
			);
			throwsCode(
				check,
				() => replaceRegionMask(canvas, region.id, new Uint8Array(17)),
				"INVALID_MASK_SIZE",
			);
			const replacement = new Uint8Array(4 * 4);
			replacement[5] = 1;
			replaceRegionMask(canvas, region.id, replacement);
			check.equal(
				getRegionValue(canvas, region.id, 1, 1),
				1,
				"replaced mask readable",
			);
		},
	},
	{
		name: "region mask values are only 0 or 1",
		run: (check) => {
			throwsCode(check, () => validateMaskValue(2), "INVALID_ARGUMENT");
			throwsCode(check, () => validateMaskValue(-1), "INVALID_ARGUMENT");
			throwsCode(check, () => validateMaskValue(0.5), "INVALID_ARGUMENT");
			validateMaskValue(0);
			validateMaskValue(1);
			const canvas = createCanvas(4, 4);
			const region = addRegion(canvas, { id: "blade" });
			throwsCode(
				check,
				() => setRegionValue(canvas, region.id, 0, 0, 7),
				"INVALID_ARGUMENT",
			);
			setRegionValue(canvas, region.id, 2, 3, 1);
			check.equal(getRegionValue(canvas, region.id, 2, 3), 1, "mask set");
			check.equal(
				getRegionValue(canvas, region.id, 0, 0),
				0,
				"mask default outside",
			);
		},
	},
	{
		name: "duplicate layer and region ids are rejected",
		run: (check) => {
			const canvas = createCanvas(8, 8);
			addLayer(canvas, { id: "base" });
			throwsCode(
				check,
				() => addLayer(canvas, { id: "base" }),
				"DUPLICATE_LAYER_ID",
			);
			addRegion(canvas, { id: "blade" });
			throwsCode(
				check,
				() => addRegion(canvas, { id: "blade" }),
				"DUPLICATE_REGION_ID",
			);
		},
	},
	{
		name: "unknown layer and region ids are rejected",
		run: (check) => {
			const canvas = createCanvas(8, 8);
			addLayer(canvas, { id: "base" });
			throwsCode(
				check,
				() => getPixel(canvas, "ghost", 0, 0),
				"LAYER_NOT_FOUND",
			);
			throwsCode(
				check,
				() => getRegionValue(canvas, "ghost", 0, 0),
				"REGION_NOT_FOUND",
			);
		},
	},
	{
		name: "layer opacity and blend mode are constrained",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			throwsCode(
				check,
				() => addLayer(canvas, { id: "a", opacity: 2 }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => addLayer(canvas, { id: "b", opacity: -0.1 }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => addLayer(canvas, { id: "c", opacity: Number.NaN }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() =>
					createAuthoringPalette([
						// Deliberately invalid role: cast feeds runtime-bad data past the type.
						{
							id: "weird",
							color: { r: 0, g: 0, b: 0, a: 255 },
							role: "neon" as PaletteRole,
						},
					]),
				"INVALID_ARGUMENT",
			);
			const layer = addLayer(canvas, { id: "e", opacity: 0.5 });
			check.equal(layer.opacity, 0.5, "opacity kept");
			check.equal(layer.blendMode, "normal", "default blend mode");
			check.equal(validateOpacity(0), 0, "opacity 0 edge");
			check.equal(validateOpacity(1), 1, "opacity 1 edge");
		},
	},
	{
		name: "layer array order is the compositing order",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "bottom" });
			addLayer(canvas, { id: "mid" });
			addLayer(canvas, { id: "top" });
			check.deepEqual(
				canvas.layers.map((layer) => layer.id),
				["bottom", "mid", "top"],
				"bottom-to-top order",
			);
		},
	},
	{
		name: "region keeps its own mask and ignores pixel colors",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			const layer = addLayer(canvas, { id: "base" });
			const region = addRegion(canvas, { id: "blade" });
			setRegionValue(canvas, region.id, 1, 1, 1);
			setRegionValue(canvas, region.id, 2, 2, 1);
			// Recolor-like writes must not move the region.
			setPixel(canvas, layer.id, 1, 1, { r: 200, g: 100, b: 50, a: 255 });
			setPixel(canvas, layer.id, 2, 2, { r: 1, g: 2, b: 3, a: 0 });
			check.equal(
				getRegionValue(canvas, region.id, 1, 1),
				1,
				"blade keeps (1,1)",
			);
			check.equal(
				getRegionValue(canvas, region.id, 2, 2),
				1,
				"blade keeps (2,2)",
			);
			check.equal(
				getRegionValue(canvas, region.id, 0, 0),
				0,
				"outside stays outside",
			);
		},
	},
	{
		name: "pixel truth is RGBA, deleting the palette keeps pixels",
		run: (check) => {
			const palette = createAuthoringPalette([
				{ id: "base", color: { r: 170, g: 170, b: 170, a: 255 }, role: "base" },
			]);
			const canvas = createCanvas(4, 4, { palette });
			const layer = addLayer(canvas, { id: "paint" });
			setPixel(canvas, layer.id, 0, 0, { r: 170, g: 170, b: 170, a: 255 });
			delete canvas.palette;
			check.deepEqual(
				getPixel(canvas, layer.id, 0, 0),
				{ r: 170, g: 170, b: 170, a: 255 },
				"pixel survives palette removal",
			);
		},
	},
	{
		name: "authoring palette entries are validated",
		run: (check) => {
			throwsCode(
				check,
				() =>
					createAuthoringPalette([
						{ id: "", color: { r: 0, g: 0, b: 0, a: 255 } },
					]),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() =>
					createAuthoringPalette([
						{ id: "bad", color: { r: 0, g: 0, b: 0, a: 999 } },
					]),
				"INVALID_COLOR",
			);
			throwsCode(
				check,
				() =>
					createAuthoringPalette([
						{ id: "dup", color: { r: 0, g: 0, b: 0, a: 255 } },
						{ id: "dup", color: { r: 1, g: 1, b: 1, a: 255 } },
					]),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() =>
					createAuthoringPalette([
						// Deliberately invalid role: double cast feeds runtime-bad data past the type.
						{
							id: "weird",
							color: { r: 0, g: 0, b: 0, a: 255 },
							role: "neon" as unknown as PaletteRole,
						},
					]),
				"INVALID_ARGUMENT",
			);
			const palette = createAuthoringPalette([
				{ id: "outline", color: { r: 0, g: 0, b: 0, a: 255 }, role: "outline" },
				{
					id: "custom-ink",
					color: { r: 10, g: 20, b: 30, a: 255 },
					role: "custom",
				},
			]);
			check.equal(palette.entries.length, 2, "two entries kept");
		},
	},
	{
		name: "memory estimate follows width x height x (4 x layers + regions)",
		run: (check) => {
			check.equal(
				estimateMemoryBytes(16, 16, 1, 0),
				16 * 16 * 4,
				"single layer",
			);
			check.equal(
				estimateMemoryBytes(16, 16, 2, 3),
				16 * 16 * (8 + 3),
				"mixed",
			);
			check.equal(
				estimateMemoryBytes(4096, 4096, 8, 0),
				MEMORY_BUDGET_BYTES,
				"exactly 512 MB",
			);
			check.equal(MEMORY_BUDGET_BYTES, 512 * 1024 * 1024, "budget is 512 MiB");
		},
	},
	{
		name: "512 MB budget boundary: exact fits, one byte over fails",
		run: (check) => {
			checkResourceLimits(4096, 4096, 8, 0);
			throwsCode(
				check,
				() => checkResourceLimits(4096, 4096, 8, 1),
				"RESOURCE_LIMIT_EXCEEDED",
			);
			throwsCode(
				check,
				() => checkResourceLimits(4096, 4096, 9, 0),
				"RESOURCE_LIMIT_EXCEEDED",
			);
		},
	},
	{
		name: "layer and region count limits are enforced before allocation",
		run: (check) => {
			throwsCode(
				check,
				() => checkResourceLimits(16, 16, 65, 0),
				"RESOURCE_LIMIT_EXCEEDED",
			);
			throwsCode(
				check,
				() => checkResourceLimits(16, 16, 0, 257),
				"RESOURCE_LIMIT_EXCEEDED",
			);
			// Limits themselves pass: a throw here fails the case naturally.
			checkResourceLimits(16, 16, 64, 256);
		},
	},
	{
		name: "64 layers fit, the 65th is rejected",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			for (let i = 0; i < 64; i += 1) {
				addLayer(canvas, { id: `layer-${i}` });
			}
			check.equal(canvas.layers.length, 64, "64 layers kept");
			throwsCode(
				check,
				() => addLayer(canvas, { id: "layer-64" }),
				"RESOURCE_LIMIT_EXCEEDED",
			);
		},
	},
	{
		name: "256 regions fit, the 257th is rejected",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			for (let i = 0; i < 256; i += 1) {
				addRegion(canvas, { id: `region-${i}` });
			}
			check.equal(canvas.regions.length, 256, "256 regions kept");
			throwsCode(
				check,
				() => addRegion(canvas, { id: "region-256" }),
				"RESOURCE_LIMIT_EXCEEDED",
			);
		},
	},
	{
		name: "over-budget layer add fails without allocating the buffer",
		run: (check) => {
			const canvas = createCanvas(4096, 4096);
			// Stand-ins carry only the count signal; addLayer must consult the
			// budget gate before touching any pixel storage.
			for (let i = 0; i < 8; i += 1) {
				canvas.layers.push({
					id: `prefill-${i}`,
					pixels: new Uint8Array(0),
					visible: true,
					opacity: 1,
					blendMode: "normal",
				});
			}
			const before = canvas.layers.length;
			throwsCode(
				check,
				() => addLayer(canvas, { id: "one-too-many" }),
				"RESOURCE_LIMIT_EXCEEDED",
			);
			check.equal(canvas.layers.length, before, "no layer appended on failure");
		},
	},
	{
		name: "canvas version must be 1",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			assertValidCanvas(canvas);
			canvas.version = 2;
			throwsCode(check, () => assertValidCanvas(canvas), "INVALID_ARGUMENT");
			throwsCode(
				check,
				() => addLayer(canvas, { id: "late" }),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "random legal sizes round-trip every pixel",
		run: (check) => {
			const cases = seedPixels(2, 0x9e3779b9);
			const width = 8 + (cases[0].r % 24);
			const height = 8 + (cases[0].g % 24);
			const canvas = createCanvas(width, height);
			const layer = addLayer(canvas, { id: "roundtrip" });
			const colors = seedPixels(width * height, 0x243f6a88);
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					setPixel(canvas, layer.id, x, y, colors[y * width + x]);
				}
			}
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					check.deepEqual(
						getPixel(canvas, layer.id, x, y),
						colors[y * width + x],
						`pixel (${x},${y})`,
					);
				}
			}
		},
	},
	{
		name: "error code to exit code mapping follows the section 99 table",
		run: (check) => {
			const expected: Array<[FixedErrorCode, number]> = [
				["INTERNAL_ERROR", 1],
				["INVALID_ARGUMENT", 2],
				["ARGUMENT_CONFLICT", 2],
				["INVALID_DIMENSION", 2],
				["INVALID_COORDINATE", 2],
				["OUT_OF_BOUNDS", 2],
				["INVALID_COLOR", 2],
				["INVALID_MASK_SIZE", 2],
				["INVALID_GRID_SIZE", 2],
				["UNKNOWN_PALETTE_SYMBOL", 2],
				["UNKNOWN_OPERATION", 2],
				["DUPLICATE_OPERATION_ID", 2],
				["LAYER_NOT_FOUND", 2],
				["REGION_NOT_FOUND", 2],
				["DUPLICATE_LAYER_ID", 2],
				["DUPLICATE_REGION_ID", 2],
				["INVALID_PROFILE", 2],
				["MCPX_SYNTAX_ERROR", 2],
				["MCPX_SCHEMA_ERROR", 2],
				["MCPX_SEMANTIC_ERROR", 2],
				["MCPX_PALETTE_OVERFLOW", 2],
				["INVALID_ANIMATION_FRAME", 2],
				["INVALID_MCMETA", 2],
				["OUTPUT_REQUIRED", 2],
				["VALIDATION_FAILED", 3],
				["ATLAS_REFERENCE_ERROR", 3],
				["TEXTURE_NOT_IN_REQUIRED_ATLAS", 3],
				["FILESYSTEM_ERROR", 4],
				["OUTPUT_EXISTS", 4],
				["MCPX_UNSUPPORTED_VERSION", 5],
				["UNSUPPORTED_IMAGE_FORMAT", 5],
				["UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT", 5],
				["RESOURCE_LIMIT_EXCEEDED", 5],
				["EMPTY_SELECTION", 2],
			];
			check.equal(expected.length, 34, "34 fixed codes in the table");
			for (const [code, exit] of expected) {
				check.equal(exitCodeForError(code), exit, `exit for ${code}`);
			}
			// TRANSACTION_FAILED has no fixed exit: the causing error decides.
			check.equal(
				resolveExitCode("TRANSACTION_FAILED", "OUT_OF_BOUNDS"),
				2,
				"unwrap to cause",
			);
			check.equal(
				resolveExitCode("TRANSACTION_FAILED", "RESOURCE_LIMIT_EXCEEDED"),
				5,
				"unwrap to cause",
			);
			check.equal(
				resolveExitCode("TRANSACTION_FAILED"),
				1,
				"falls back to general",
			);
		},
	},
	{
		name: "caller-owned palette cannot leak into the canvas",
		run: (check) => {
			const entries = [{ id: "base", color: { r: 1, g: 2, b: 3, a: 255 } }];
			const palette = { entries };
			const canvas = createCanvas(4, 4, { palette });
			entries[0].color.r = 99;
			entries.push({ id: "late", color: { r: 9, g: 9, b: 9, a: 255 } });
			palette.entries.length = 0;
			check.equal(canvas.palette?.entries.length, 1, "entry count frozen");
			check.deepEqual(
				canvas.palette?.entries[0].color,
				{ r: 1, g: 2, b: 3, a: 255 },
				"entry color frozen",
			);
		},
	},
	{
		name: "caller-owned metadata cannot leak into canvas, layer, or region",
		run: (check) => {
			const canvasMetadata: Record<string, unknown> = { author: "me" };
			const layerMetadata: Record<string, unknown> = { tag: "v1" };
			const regionMetadata: Record<string, unknown> = { tag: "r1" };
			const canvas = createCanvas(4, 4, { metadata: canvasMetadata });
			const layer = addLayer(canvas, { id: "base", metadata: layerMetadata });
			const region = addRegion(canvas, {
				id: "blade",
				metadata: regionMetadata,
			});
			canvasMetadata.author = "evil";
			layerMetadata.tag = "evil";
			regionMetadata.tag = "evil";
			check.equal(canvas.metadata.author, "me", "canvas metadata frozen");
			check.equal(layer.metadata?.tag, "v1", "layer metadata frozen");
			check.equal(region.metadata?.tag, "r1", "region metadata frozen");
		},
	},
];
