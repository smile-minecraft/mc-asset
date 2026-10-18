import { parseOperationsJson } from "../../src/cli/operations-json.ts";
import { applyOperations, type BatchOperation } from "../../src/core/batch.ts";
import { addLayer, createCanvas, getLayer } from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import { VANILLA_PALETTE } from "../../src/style/palette.ts";

/**
 * Outline operation cases. Expected pixels are derived here from the frozen
 * integer formulas (relative luminance, integer HSL, Manhattan distance) so
 * the cases never lean on the implementation or on the analysis surface.
 */

/** Runner-agnostic assertion surface: bun:test and node:test adapt to this. */
export interface OutlineCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throwsCode(fn: () => unknown, code: string, message?: string): void;
	/** sha256 hex of bytes; identical on Bun and Node for golden locking. */
	sha256Hex(bytes: Uint8Array): string;
}

export interface OutlineCase {
	name: string;
	run(check: OutlineCheck): void;
}

const WIDTH = 16;
const HEIGHT = 16;

// Original test art only: no external pixel art is copied or traced.
const SWORD_COLOR: RGBA = { r: 168, g: 172, b: 200, a: 255 };
const GEM_COLOR: RGBA = { r: 82, g: 196, b: 164, a: 255 };
const INGOT_COLOR: RGBA = { r: 250, g: 214, b: 74, a: 255 };
const FRAME_COLOR: RGBA = { r: 28, g: 52, b: 76, a: 255 };
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
const EMPTY: RGBA = { r: 0, g: 0, b: 0, a: 0 };

type OutlineMode = "tinted" | "selective" | "uniform" | "black" | "strip";
type OutlinePosition = "inside" | "outside";

/* ------------------------------------------------------------------ */
/* Canvas helpers                                                      */
/* ------------------------------------------------------------------ */

function fresh(width = WIDTH, height = HEIGHT): PixelCanvas {
	const canvas = createCanvas(width, height);
	addLayer(canvas, { id: "base" });
	return canvas;
}

function layerBytes(canvas: PixelCanvas, layerId: string): Uint8Array {
	return getLayer(canvas, layerId).pixels;
}

function readPixel(
	pixels: Uint8Array,
	width: number,
	x: number,
	y: number,
): RGBA {
	const offset = (y * width + x) * 4;
	return {
		r: pixels[offset] as number,
		g: pixels[offset + 1] as number,
		b: pixels[offset + 2] as number,
		a: pixels[offset + 3] as number,
	};
}

function writePixel(
	pixels: Uint8Array,
	width: number,
	x: number,
	y: number,
	color: RGBA,
): void {
	const offset = (y * width + x) * 4;
	pixels[offset] = color.r;
	pixels[offset + 1] = color.g;
	pixels[offset + 2] = color.b;
	pixels[offset + 3] = color.a;
}

function snapshot(canvas: PixelCanvas, layerId = "base"): Uint8Array {
	return layerBytes(canvas, layerId).slice();
}

function pixelAt(
	canvas: PixelCanvas,
	x: number,
	y: number,
	layerId = "base",
): RGBA {
	return readPixel(layerBytes(canvas, layerId), canvas.width, x, y);
}

interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

function paintBox(
	canvas: PixelCanvas,
	layerId: string,
	box: Box,
	color: RGBA,
): void {
	const pixels = layerBytes(canvas, layerId);
	for (let y = box.y0; y <= box.y1; y += 1) {
		for (let x = box.x0; x <= box.x1; x += 1) {
			writePixel(pixels, canvas.width, x, y, color);
		}
	}
}

/** Original 16x16 sword: four-pixel blade, guard bar, narrow grip, pommel. */
function paintSword(canvas: PixelCanvas, color = SWORD_COLOR): void {
	const boxes: Box[] = [
		{ x0: 6, y0: 1, x1: 9, y1: 10 },
		{ x0: 3, y0: 11, x1: 12, y1: 12 },
		{ x0: 7, y0: 13, x1: 8, y1: 14 },
		{ x0: 6, y0: 15, x1: 9, y1: 15 },
	];
	for (const box of boxes) {
		paintBox(canvas, "base", box, color);
	}
}

/** Original round gem: an integer disc of radius 6 around (7, 7). */
function paintGem(canvas: PixelCanvas, color = GEM_COLOR): void {
	const pixels = layerBytes(canvas, "base");
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			const dx = x - 7;
			const dy = y - 7;
			if (dx * dx + dy * dy <= 36) {
				writePixel(pixels, canvas.width, x, y, color);
			}
		}
	}
}

/** Original ingot: a ten-wide, five-tall trapezoid with clipped corners. */
function paintIngot(canvas: PixelCanvas, color = INGOT_COLOR): void {
	const boxes: Box[] = [
		{ x0: 4, y0: 6, x1: 11, y1: 6 },
		{ x0: 3, y0: 7, x1: 12, y1: 9 },
		{ x0: 4, y0: 10, x1: 11, y1: 10 },
	];
	for (const box of boxes) {
		paintBox(canvas, "base", box, color);
	}
}

function firstDifference(
	actual: Uint8Array,
	expected: Uint8Array,
	width: number,
): string | undefined {
	if (actual.length !== expected.length) {
		return `length ${actual.length} != ${expected.length}`;
	}
	for (let index = 0; index < expected.length; index += 1) {
		if (actual[index] === expected[index]) {
			continue;
		}
		const pixel = Math.floor(index / 4);
		const x = pixel % width;
		const y = Math.floor(pixel / width);
		const channel = index % 4;
		return `pixel (${x},${y}) channel ${channel} is ${actual[index]}, expected ${expected[index]}`;
	}
	return undefined;
}

function expectPixels(
	check: OutlineCheck,
	canvas: PixelCanvas,
	layerId: string,
	expected: Uint8Array,
	message: string,
): void {
	const actual = layerBytes(canvas, layerId);
	const difference = firstDifference(actual, expected, canvas.width);
	check.ok(
		difference === undefined,
		`${message}: ${difference ?? "byte-identical"}`,
	);
}

function changedCells(
	before: Uint8Array,
	after: Uint8Array,
	width: number,
	height: number,
): string[] {
	const cells: string[] = [];
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			for (let channel = 0; channel < 4; channel += 1) {
				if (before[offset + channel] !== after[offset + channel]) {
					cells.push(`${x},${y}`);
					break;
				}
			}
		}
	}
	return cells;
}

/* ------------------------------------------------------------------ */
/* Frozen integer formulas (measured independently of the engine)      */
/* ------------------------------------------------------------------ */

function truncDiv(a: number, b: number): number {
	return Math.trunc(a / b);
}

function clampByte(value: number): number {
	if (value < 0) {
		return 0;
	}
	if (value > 255) {
		return 255;
	}
	return value;
}

/** Relative luminance in permille, value range 0..1000. */
function luminancePermille(color: RGBA): number {
	return truncDiv(2126 * color.r + 7152 * color.g + 722 * color.b, 2550);
}

interface Hsl {
	l255: number;
	s255: number;
	h: number;
	delta: number;
}

/** Integer HSL; `h` is -1 for a grey pixel. */
function hslOf(color: RGBA): Hsl {
	const max = Math.max(color.r, color.g, color.b);
	const min = Math.min(color.r, color.g, color.b);
	const delta = max - min;
	const l255 = truncDiv(max + min, 2);
	if (delta === 0) {
		return { l255, s255: 0, h: -1, delta: 0 };
	}
	const s255 = Math.min(
		255,
		truncDiv(delta * 255, 255 - Math.abs(2 * l255 - 255)),
	);
	let h: number;
	if (max === color.r) {
		h = truncDiv(60 * (color.g - color.b), delta);
	} else if (max === color.g) {
		h = 120 + truncDiv(60 * (color.b - color.r), delta);
	} else {
		h = 240 + truncDiv(60 * (color.r - color.g), delta);
	}
	h = ((h % 360) + 360) % 360;
	return { l255, s255, h, delta };
}

/** Hue distance in degrees, 0..180. */
function hueDistance(h1: number, h2: number): number {
	if (h1 < 0 || h2 < 0) {
		return 0;
	}
	const difference = Math.abs(h1 - h2);
	return Math.min(difference, 360 - difference);
}

function parseHex(hex: string): RGBA {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
		a: 255,
	};
}

function colorDistance(a: RGBA, b: RGBA): number {
	return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/* ------------------------------------------------------------------ */
/* Spec-side outline model                                             */
/* ------------------------------------------------------------------ */

/** Body mask: alpha not zero. */
function bodyMaskSpec(
	pixels: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let index = 0; index < mask.length; index += 1) {
		if ((pixels[index * 4 + 3] as number) !== 0) {
			mask[index] = 1;
		}
	}
	return mask;
}

function isBody(
	body: Uint8Array,
	x: number,
	y: number,
	width: number,
): boolean {
	return body[y * width + x] === 1;
}

function inCanvas(
	x: number,
	y: number,
	width: number,
	height: number,
): boolean {
	return x >= 0 && y >= 0 && x < width && y < height;
}

/** Inside frame cells: body pixels with an empty or out-of-canvas 4-neighbour. */
function insideMaskSpec(
	body: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			if (body[index] !== 1) {
				continue;
			}
			const neighbours: Array<[number, number]> = [
				[x - 1, y],
				[x + 1, y],
				[x, y - 1],
				[x, y + 1],
			];
			let edge = false;
			for (const [nx, ny] of neighbours) {
				if (!inCanvas(nx, ny, width, height) || !isBody(body, nx, ny, width)) {
					edge = true;
					break;
				}
			}
			if (edge) {
				mask[index] = 1;
			}
		}
	}
	return mask;
}

/** Outside frame cells: empty cells with a body 4-neighbour. */
function outsideMaskSpec(
	body: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			if (body[index] === 1) {
				continue;
			}
			if (
				(x > 0 && isBody(body, x - 1, y, width)) ||
				(x + 1 < width && isBody(body, x + 1, y, width)) ||
				(y > 0 && isBody(body, x, y - 1, width)) ||
				(y + 1 < height && isBody(body, x, y + 1, width))
			) {
				mask[index] = 1;
			}
		}
	}
	return mask;
}

interface SpecGrid {
	pixels: Uint8Array;
	width: number;
	height: number;
	body: Uint8Array;
	inside: Uint8Array;
}

function neighbourPoints(
	x: number,
	y: number,
	width: number,
	height: number,
	diagonals: boolean,
): Array<[number, number]> {
	const points: Array<[number, number]> = [];
	for (let dy = -1; dy <= 1; dy += 1) {
		for (let dx = -1; dx <= 1; dx += 1) {
			if (dx === 0 && dy === 0) {
				continue;
			}
			if (!diagonals && dx !== 0 && dy !== 0) {
				continue;
			}
			const nx = x + dx;
			const ny = y + dy;
			if (inCanvas(nx, ny, width, height)) {
				points.push([nx, ny]);
			}
		}
	}
	return points;
}

/**
 * The reference colour of one frame cell: the darkest body neighbour the
 * pass does not rewrite. An inside pass skips body pixels that are
 * themselves inside frame cells; an outside pass rewrites only empty cells,
 * so every adjacent body pixel is a candidate. The 4-neighbourhood wins;
 * without a candidate the search widens to the 8-neighbourhood.
 */
function referenceSpec(
	grid: SpecGrid,
	x: number,
	y: number,
	position: OutlinePosition,
): RGBA | undefined {
	const candidates: RGBA[] = [];
	const collect = (diagonals: boolean): void => {
		for (const [nx, ny] of neighbourPoints(
			x,
			y,
			grid.width,
			grid.height,
			diagonals,
		)) {
			const index = ny * grid.width + nx;
			if (grid.body[index] !== 1) {
				continue;
			}
			if (position === "inside" && grid.inside[index] === 1) {
				continue;
			}
			candidates.push(readPixel(grid.pixels, grid.width, nx, ny));
		}
	};
	collect(false);
	if (candidates.length === 0) {
		collect(true);
	}
	if (candidates.length === 0) {
		return undefined;
	}
	let best = candidates[0] as RGBA;
	for (let index = 1; index < candidates.length; index += 1) {
		const candidate = candidates[index] as RGBA;
		const candidateHsl = hslOf(candidate);
		const bestHsl = hslOf(best);
		if (
			candidateHsl.l255 < bestHsl.l255 ||
			(candidateHsl.l255 === bestHsl.l255 &&
				(candidateHsl.s255 < bestHsl.s255 ||
					(candidateHsl.s255 === bestHsl.s255 && candidateHsl.h < bestHsl.h)))
		) {
			best = candidate;
		}
	}
	return best;
}

interface DeriveOptions {
	luminanceDropPermille?: number;
	saturationRatioPermille?: number;
	family?: string;
	snapFamilies?: boolean;
}

function snapSpec(color: RGBA, family: string): RGBA {
	const ramp = (
		VANILLA_PALETTE as Record<string, { outline: string; shadow: string }>
	)[family];
	if (ramp === undefined) {
		throw new Error(`unknown test family: ${family}`);
	}
	const entries = [parseHex(ramp.outline), parseHex(ramp.shadow)];
	let best = entries[0] as RGBA;
	for (let index = 1; index < entries.length; index += 1) {
		const entry = entries[index] as RGBA;
		const distance = colorDistance(color, entry);
		const bestDistance = colorDistance(color, best);
		if (
			distance < bestDistance ||
			(distance === bestDistance &&
				luminancePermille(entry) < luminancePermille(best))
		) {
			best = entry;
		}
	}
	return { r: best.r, g: best.g, b: best.b, a: 255 };
}

/** Darken the reference in integer HSL, then snap onto the family ramp. */
function deriveSpec(reference: RGBA, options: DeriveOptions): RGBA {
	const drop = options.luminanceDropPermille ?? 120;
	const ratio = options.saturationRatioPermille ?? 1000;
	const hsl = hslOf(reference);
	const l255 = clampByte(truncDiv(hsl.l255 * (1000 - drop), 1000));
	const s255 = Math.min(255, truncDiv(hsl.s255 * ratio, 1000));
	let derived: RGBA;
	if (hsl.delta === 0) {
		derived = { r: l255, g: l255, b: l255, a: 255 };
	} else {
		const delta = truncDiv(s255 * (255 - Math.abs(2 * l255 - 255)), 255);
		derived = {
			r: clampByte(
				l255 + truncDiv((reference.r - hsl.l255) * delta, hsl.delta),
			),
			g: clampByte(
				l255 + truncDiv((reference.g - hsl.l255) * delta, hsl.delta),
			),
			b: clampByte(
				l255 + truncDiv((reference.b - hsl.l255) * delta, hsl.delta),
			),
			a: 255,
		};
	}
	if (options.family === undefined || !(options.snapFamilies ?? true)) {
		return derived;
	}
	return snapSpec(derived, options.family);
}

interface ExpectedOptions extends DeriveOptions {
	mode?: OutlineMode;
	position?: OutlinePosition;
	color?: RGBA;
	selection?: Uint8Array;
}

/** The full expected layer after one outline pass, from the frozen rules. */
function expectedOutline(
	source: Uint8Array,
	width: number,
	height: number,
	options: ExpectedOptions,
): Uint8Array {
	const body = bodyMaskSpec(source, width, height);
	const inside = insideMaskSpec(body, width, height);
	const mode = options.mode ?? "tinted";
	const position = options.position ?? "inside";
	const targets =
		mode === "strip"
			? inside
			: position === "inside"
				? inside
				: outsideMaskSpec(body, width, height);
	const grid: SpecGrid = { pixels: source, width, height, body, inside };
	const out = source.slice();

	let sumX = 0;
	let sumY = 0;
	let count = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (body[y * width + x] === 1) {
				sumX += x;
				sumY += y;
				count += 1;
			}
		}
	}
	const centreX = count === 0 ? 0 : truncDiv(sumX, count);
	const centreY = count === 0 ? 0 : truncDiv(sumY, count);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			if (targets[index] !== 1) {
				continue;
			}
			if (options.selection !== undefined && options.selection[index] !== 1) {
				continue;
			}
			let next: RGBA | undefined;
			if (mode === "uniform") {
				next = options.color;
			} else if (mode === "black") {
				next = BLACK;
			} else if (mode === "strip") {
				next = referenceSpec(grid, x, y, "inside");
			} else {
				if (mode === "selective" && x < centreX && y < centreY) {
					continue;
				}
				const reference = referenceSpec(grid, x, y, position);
				if (reference !== undefined) {
					next = deriveSpec(reference, options);
				}
			}
			if (next === undefined) {
				continue;
			}
			writePixel(out, width, x, y, next);
		}
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Error helpers                                                       */
/* ------------------------------------------------------------------ */

function caughtDetails(error: unknown): Record<string, unknown> {
	if (!(error instanceof McAssetError)) {
		throw new Error(`expected McAssetError but got ${String(error)}`);
	}
	const details = error.details;
	if (typeof details !== "object" || details === null) {
		throw new Error("expected McAssetError details to be an object");
	}
	return details as Record<string, unknown>;
}

function expectCode(
	check: OutlineCheck,
	fn: () => unknown,
	code: string,
	label: string,
): void {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError && error.code === code) {
			return;
		}
		check.fail(
			`${label}: expected McAssetError(${code}) but got ${error instanceof McAssetError ? `${error.code} ${error.message}` : String(error)}`,
		);
	}
	check.fail(`${label}: expected McAssetError(${code}) but nothing was thrown`);
}

function expectInvalidAt(
	check: OutlineCheck,
	text: string,
	path: string,
): void {
	try {
		parseOperationsJson(text, "base");
	} catch (error) {
		if (!(error instanceof McAssetError) || error.code !== "INVALID_ARGUMENT") {
			check.fail(
				`${path}: expected INVALID_ARGUMENT but got ${error instanceof McAssetError ? `${error.code} ${error.message}` : String(error)}`,
			);
			return;
		}
		check.equal(caughtDetails(error).path, path, `error path ${path}`);
		return;
	}
	check.fail(`${path}: expected INVALID_ARGUMENT but nothing was thrown`);
}

function outlineOp(fields: Record<string, unknown>): BatchOperation {
	return {
		type: "outline",
		layerId: "base",
		...fields,
	} as unknown as BatchOperation;
}

/* ------------------------------------------------------------------ */
/* Byte-parity goldens                                                 */
/* ------------------------------------------------------------------ */

export function goldenSwordTinted(): {
	canvas: PixelCanvas;
	expected: Uint8Array;
} {
	const canvas = fresh();
	paintSword(canvas);
	const expected = expectedOutline(layerBytes(canvas, "base"), WIDTH, HEIGHT, {
		mode: "tinted",
	});
	return { canvas, expected };
}

export function goldenGemUniformOutside(): {
	canvas: PixelCanvas;
	expected: Uint8Array;
} {
	const canvas = fresh();
	paintGem(canvas);
	const expected = expectedOutline(layerBytes(canvas, "base"), WIDTH, HEIGHT, {
		mode: "uniform",
		position: "outside",
		color: FRAME_COLOR,
	});
	return { canvas, expected };
}

/** Pinned sha256 digests of the expected layers, identical on Bun and Node. */
export const OUTLINE_GOLDENS = {
	swordTinted:
		"41fb6c4b954c5e4b90162354f6c1357e43efc98a7d11c6ecc160f0a6992b8e57",
	gemUniformOutside:
		"e2c187f39b000f18bc5d6fe6f7b91d32b0be8cebc6ea3743e700681a7f0b0ae4",
};

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

export const OUTLINE_CASES: OutlineCase[] = [
	{
		name: "tinted inside frames the body edge and leaves the interior alone",
		run: (check) => {
			const canvas = fresh();
			paintSword(canvas);
			const before = snapshot(canvas);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "tinted",
			});
			applyOperations(canvas, [
				{ type: "outline", layerId: "base", mode: "tinted" },
			]);
			expectPixels(check, canvas, "base", expected, "tinted inside pixels");

			const body = bodyMaskSpec(before, WIDTH, HEIGHT);
			const inside = insideMaskSpec(body, WIDTH, HEIGHT);
			const grid: SpecGrid = {
				pixels: before,
				width: WIDTH,
				height: HEIGHT,
				body,
				inside,
			};
			const expectedCells: string[] = [];
			for (let y = 0; y < HEIGHT; y += 1) {
				for (let x = 0; x < WIDTH; x += 1) {
					if (inside[y * WIDTH + x] !== 1) {
						continue;
					}
					if (referenceSpec(grid, x, y, "inside") !== undefined) {
						expectedCells.push(`${x},${y}`);
					}
				}
			}
			check.deepEqual(
				changedCells(before, layerBytes(canvas, "base"), WIDTH, HEIGHT),
				expectedCells,
				"tinted writes exactly the frame cells that have a reference",
			);
			check.deepEqual(
				pixelAt(canvas, 8, 5),
				SWORD_COLOR,
				"blade interior keeps its colour",
			);
		},
	},
	{
		name: "tinted keeps the reference hue and drops HSL lightness by the ratio",
		run: (check) => {
			const canvas = fresh();
			paintIngot(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "tinted",
					luminanceDropPermille: 120,
					saturationRatioPermille: 1000,
				},
			]);
			const reference = INGOT_COLOR;
			const derived = pixelAt(canvas, 4, 6);
			const expected = deriveSpec(reference, {});
			check.deepEqual(
				derived,
				expected,
				"frame colour follows the frozen formulas",
			);

			const referenceHsl = hslOf(reference);
			const derivedHsl = hslOf(derived);
			check.equal(
				derivedHsl.l255,
				clampByte(truncDiv(referenceHsl.l255 * (1000 - 120), 1000)),
				"HSL lightness drops by 120 permille",
			);
			check.ok(
				Math.abs(derivedHsl.s255 - referenceHsl.s255) <= 2,
				"HSL saturation is kept within integer quantization",
			);
			check.ok(
				hueDistance(derivedHsl.h, referenceHsl.h) <= 5,
				"hue offset stays inside the 5 degree bound",
			);
			check.ok(
				luminancePermille(derived) < luminancePermille(reference),
				"frame luminance stays below the reference luminance",
			);
			check.equal(derived.a, 255, "derived frame is opaque");
		},
	},
	{
		name: "selective inside paints only the backlit right and bottom edges",
		run: (check) => {
			const canvas = fresh();
			paintGem(canvas);
			const before = snapshot(canvas);
			applyOperations(canvas, [
				{ type: "outline", layerId: "base", mode: "selective" },
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "selective",
			});
			expectPixels(check, canvas, "base", expected, "selective inside pixels");

			const body = bodyMaskSpec(before, WIDTH, HEIGHT);
			const inside = insideMaskSpec(body, WIDTH, HEIGHT);
			const cells: string[] = [];
			for (let y = 0; y < HEIGHT; y += 1) {
				for (let x = 0; x < WIDTH; x += 1) {
					if (inside[y * WIDTH + x] === 1 && (x >= 7 || y >= 7)) {
						cells.push(`${x},${y}`);
					}
				}
			}
			check.deepEqual(
				changedCells(before, layerBytes(canvas, "base"), WIDTH, HEIGHT),
				cells,
				"only backlit frame cells change",
			);
			check.deepEqual(
				pixelAt(canvas, 2, 6),
				GEM_COLOR,
				"left edge above centre stays body colour",
			);
			check.deepEqual(
				pixelAt(canvas, 7, 13),
				deriveSpec(GEM_COLOR, {}),
				"bottom edge takes the derived frame colour",
			);
		},
	},
	{
		name: "selective outside fills the backlit outside cells only",
		run: (check) => {
			const canvas = fresh();
			paintGem(canvas);
			const before = snapshot(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "selective",
					position: "outside",
				},
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "selective",
				position: "outside",
			});
			expectPixels(check, canvas, "base", expected, "selective outside pixels");

			check.equal(pixelAt(canvas, 2, 3).a, 0, "lit outside cell stays empty");
			check.equal(
				pixelAt(canvas, 7, 0).a,
				255,
				"backlit outside cell above centre is painted",
			);
			check.deepEqual(
				pixelAt(canvas, 14, 7),
				deriveSpec(GEM_COLOR, {}),
				"right outside cell takes the derived colour",
			);
			const body = bodyMaskSpec(before, WIDTH, HEIGHT);
			for (let index = 0; index < body.length; index += 1) {
				if (body[index] !== 1) {
					continue;
				}
				for (let channel = 0; channel < 4; channel += 1) {
					check.equal(
						layerBytes(canvas, "base")[index * 4 + channel],
						before[index * 4 + channel],
						"outside painting never rewrites body pixels",
					);
				}
			}
		},
	},
	{
		name: "uniform paints every inside frame cell with the requested colour",
		run: (check) => {
			const canvas = fresh();
			paintSword(canvas);
			const before = snapshot(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "uniform",
					color: FRAME_COLOR,
				},
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "uniform",
				color: FRAME_COLOR,
			});
			expectPixels(check, canvas, "base", expected, "uniform inside pixels");

			const body = bodyMaskSpec(before, WIDTH, HEIGHT);
			const inside = insideMaskSpec(body, WIDTH, HEIGHT);
			let wrongColour = 0;
			for (let y = 0; y < HEIGHT; y += 1) {
				for (let x = 0; x < WIDTH; x += 1) {
					if (inside[y * WIDTH + x] !== 1) {
						continue;
					}
					const pixel = pixelAt(canvas, x, y);
					if (
						pixel.r !== FRAME_COLOR.r ||
						pixel.g !== FRAME_COLOR.g ||
						pixel.b !== FRAME_COLOR.b ||
						pixel.a !== FRAME_COLOR.a
					) {
						wrongColour += 1;
					}
				}
			}
			check.equal(wrongColour, 0, "every inside frame cell takes the colour");
			check.deepEqual(pixelAt(canvas, 8, 5), SWORD_COLOR, "interior untouched");
		},
	},
	{
		name: "uniform outside paints empty cells and keeps every body byte",
		run: (check) => {
			const canvas = fresh();
			paintIngot(canvas);
			const before = snapshot(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "uniform",
					position: "outside",
					color: FRAME_COLOR,
				},
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "uniform",
				position: "outside",
				color: FRAME_COLOR,
			});
			expectPixels(check, canvas, "base", expected, "uniform outside pixels");

			const body = bodyMaskSpec(before, WIDTH, HEIGHT);
			for (let index = 0; index < body.length; index += 1) {
				if (body[index] !== 1) {
					continue;
				}
				for (let channel = 0; channel < 4; channel += 1) {
					check.equal(
						layerBytes(canvas, "base")[index * 4 + channel],
						before[index * 4 + channel],
						`body byte ${index * 4 + channel} unchanged`,
					);
				}
			}
			const outside = outsideMaskSpec(body, WIDTH, HEIGHT);
			check.deepEqual(
				pixelAt(canvas, 2, 8),
				FRAME_COLOR,
				"left outside cell is painted",
			);
			check.equal(
				outside.reduce((sum, value) => sum + value, 0) > 0,
				true,
				"outside cells exist in the fixture",
			);
		},
	},
	{
		name: "black paints the frame with opaque black",
		run: (check) => {
			const canvas = fresh();
			paintSword(canvas);
			const before = snapshot(canvas);
			applyOperations(canvas, [
				{ type: "outline", layerId: "base", mode: "black" },
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "black",
			});
			expectPixels(check, canvas, "base", expected, "black pixels");
			const body = bodyMaskSpec(before, WIDTH, HEIGHT);
			const inside = insideMaskSpec(body, WIDTH, HEIGHT);
			let wrongColour = 0;
			for (let y = 0; y < HEIGHT; y += 1) {
				for (let x = 0; x < WIDTH; x += 1) {
					if (inside[y * WIDTH + x] !== 1) {
						continue;
					}
					const pixel = pixelAt(canvas, x, y);
					if (
						pixel.r !== 0 ||
						pixel.g !== 0 ||
						pixel.b !== 0 ||
						pixel.a !== 255
					) {
						wrongColour += 1;
					}
				}
			}
			check.equal(wrongColour, 0, "every inside frame cell is opaque black");
		},
	},
	{
		name: "strip replaces the old frame with the darkest interior colour",
		run: (check) => {
			const canvas = fresh();
			paintIngot(canvas);
			const body = bodyMaskSpec(layerBytes(canvas, "base"), WIDTH, HEIGHT);
			const inside = insideMaskSpec(body, WIDTH, HEIGHT);
			const dark: RGBA = { r: 40, g: 30, b: 20, a: 255 };
			const pixels = layerBytes(canvas, "base");
			for (let y = 0; y < HEIGHT; y += 1) {
				for (let x = 0; x < WIDTH; x += 1) {
					if (inside[y * WIDTH + x] === 1) {
						writePixel(pixels, WIDTH, x, y, dark);
					}
				}
			}
			writePixel(pixels, WIDTH, 0, 0, { r: 9, g: 8, b: 7, a: 0 });
			const before = snapshot(canvas);
			const bodyCountBefore = body.reduce((sum, value) => sum + value, 0);

			applyOperations(canvas, [
				{ type: "outline", layerId: "base", mode: "strip" },
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "strip",
			});
			expectPixels(check, canvas, "base", expected, "strip pixels");
			check.deepEqual(
				pixelAt(canvas, 4, 6),
				INGOT_COLOR,
				"top-left frame pixel takes the interior body colour",
			);
			check.deepEqual(
				pixelAt(canvas, 0, 0),
				{ r: 9, g: 8, b: 7, a: 0 },
				"empty pixels keep their hidden RGB",
			);
			const afterBody = bodyMaskSpec(layerBytes(canvas, "base"), WIDTH, HEIGHT);
			const bodyCountAfter = afterBody.reduce((sum, value) => sum + value, 0);
			check.equal(
				bodyCountAfter,
				bodyCountBefore,
				"strip never changes the body count",
			);
		},
	},
	{
		name: "strip removes the body frame whatever the position says",
		run: (check) => {
			const prepare = (): PixelCanvas => {
				const canvas = fresh();
				paintIngot(canvas);
				const body = bodyMaskSpec(layerBytes(canvas, "base"), WIDTH, HEIGHT);
				const inside = insideMaskSpec(body, WIDTH, HEIGHT);
				const pixels = layerBytes(canvas, "base");
				for (let y = 0; y < HEIGHT; y += 1) {
					for (let x = 0; x < WIDTH; x += 1) {
						if (inside[y * WIDTH + x] === 1) {
							writePixel(pixels, WIDTH, x, y, {
								r: 40,
								g: 30,
								b: 20,
								a: 255,
							});
						}
					}
				}
				return canvas;
			};
			const insideCanvas = prepare();
			const before = snapshot(insideCanvas);
			const outsideCanvas = prepare();
			applyOperations(insideCanvas, [
				{ type: "outline", layerId: "base", mode: "strip" },
			]);
			applyOperations(outsideCanvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "strip",
					position: "outside",
				},
			]);
			check.deepEqual(
				layerBytes(outsideCanvas, "base"),
				layerBytes(insideCanvas, "base"),
				"position does not change the strip target set",
			);
			expectPixels(
				check,
				outsideCanvas,
				"base",
				expectedOutline(before, WIDTH, HEIGHT, { mode: "strip" }),
				"strip outside pixels",
			);
		},
	},
	{
		name: "outside tinted derives from the adjacent body pixels",
		run: (check) => {
			const canvas = fresh();
			paintGem(canvas);
			const before = snapshot(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "tinted",
					position: "outside",
				},
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "tinted",
				position: "outside",
			});
			expectPixels(check, canvas, "base", expected, "tinted outside pixels");
			check.deepEqual(
				pixelAt(canvas, 14, 7),
				deriveSpec(GEM_COLOR, {}),
				"outside cell derives from the adjacent body colour",
			);
			check.deepEqual(
				pixelAt(canvas, 7, 7),
				GEM_COLOR,
				"outside pass leaves the body untouched",
			);
		},
	},
	{
		name: "selection clips the frame write and restores the rest verbatim",
		run: (check) => {
			const canvas = fresh();
			paintIngot(canvas);
			writePixel(layerBytes(canvas, "base"), WIDTH, 0, 15, {
				r: 1,
				g: 2,
				b: 3,
				a: 0,
			});
			const before = snapshot(canvas);
			const selection = new Uint8Array(WIDTH * HEIGHT);
			for (let y = 0; y < 7; y += 1) {
				for (let x = 0; x < WIDTH; x += 1) {
					selection[y * WIDTH + x] = 1;
				}
			}
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "uniform",
					color: FRAME_COLOR,
					selection: "rect:0,0,16,7",
				},
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "uniform",
				color: FRAME_COLOR,
				selection,
			});
			expectPixels(check, canvas, "base", expected, "clipped outline pixels");
			check.deepEqual(
				pixelAt(canvas, 4, 10),
				INGOT_COLOR,
				"frame cell outside the selection keeps the body colour",
			);
			check.deepEqual(
				pixelAt(canvas, 0, 15),
				{ r: 1, g: 2, b: 3, a: 0 },
				"unselected empty pixel keeps its hidden RGB",
			);
		},
	},
	{
		name: "empty selection refuses the batch with EMPTY_SELECTION and rollback",
		run: (check) => {
			const canvas = fresh();
			paintIngot(canvas);
			const before = snapshot(canvas);
			const ops = [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: FRAME_COLOR,
				},
				{
					type: "outline",
					layerId: "base",
					mode: "uniform",
					color: FRAME_COLOR,
					selection: {
						op: "intersect",
						operands: ["rect:0,0,1,1", "rect:15,15,1,1"],
					},
				},
			] as unknown as BatchOperation[];
			try {
				applyOperations(canvas, ops);
				check.fail("expected the empty selection to refuse the write");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"EMPTY_SELECTION",
					"empty selection code",
				);
				check.equal(
					caughtDetails(error).operationIndex,
					1,
					"failing operation index",
				);
			}
			check.deepEqual(snapshot(canvas), before, "whole batch rolled back");
		},
	},
	{
		name: "family snaps the derived colour onto the closer ramp step",
		run: (check) => {
			const canvas = fresh();
			paintIngot(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "tinted",
					family: "gold",
				},
			]);
			const derived = deriveSpec(INGOT_COLOR, {});
			const ramp = VANILLA_PALETTE.gold;
			const outline = parseHex(ramp.outline);
			const shadow = parseHex(ramp.shadow);
			const snapped = snapSpec(derived, "gold");
			check.deepEqual(
				pixelAt(canvas, 4, 6),
				snapped,
				"frame colour is the closer ramp step",
			);
			check.ok(
				colorDistance(derived, snapped) <=
					colorDistance(derived, snapped === outline ? shadow : outline),
				"snapped step is the minimum-distance step",
			);
		},
	},
	{
		name: "a neutral family keeps the frame grey",
		run: (check) => {
			const canvas = fresh();
			paintSword(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "tinted",
					family: "stone",
				},
			]);
			const frame = pixelAt(canvas, 6, 1);
			check.equal(frame.r, frame.g, "stone frame red equals green");
			check.equal(frame.g, frame.b, "stone frame green equals blue");
			check.deepEqual(
				frame,
				snapSpec(deriveSpec(SWORD_COLOR, {}), "stone"),
				"stone frame is the snapped ramp step",
			);
		},
	},
	{
		name: "snapFamilies false keeps the raw derived colour",
		run: (check) => {
			const canvas = fresh();
			paintIngot(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "tinted",
					family: "gold",
					snapFamilies: false,
				},
			]);
			check.deepEqual(
				pixelAt(canvas, 4, 6),
				deriveSpec(INGOT_COLOR, { snapFamilies: false }),
				"raw derived colour is kept",
			);
		},
	},
	{
		name: "an unknown family is refused and names the family",
		run: (check) => {
			const canvas = fresh();
			paintSword(canvas);
			const before = snapshot(canvas);
			try {
				applyOperations(canvas, [
					{
						type: "outline",
						layerId: "base",
						mode: "tinted",
						family: "plaid",
					},
				]);
				check.fail("expected the unknown family to be refused");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"INVALID_ARGUMENT",
					"unknown family code",
				);
				check.equal(
					caughtDetails(error).family,
					"plaid",
					"family is named in details",
				);
			}
			check.deepEqual(snapshot(canvas), before, "nothing was written");
		},
	},
	{
		name: "uniform owns the colour: missing, stray, and translucent are refused",
		run: (check) => {
			const canvas = fresh();
			paintSword(canvas);
			expectCode(
				check,
				() =>
					applyOperations(canvas, [
						{ type: "outline", layerId: "base", mode: "uniform" },
					]),
				"INVALID_ARGUMENT",
				"uniform without colour",
			);
			expectCode(
				check,
				() =>
					applyOperations(canvas, [
						{
							type: "outline",
							layerId: "base",
							mode: "tinted",
							color: FRAME_COLOR,
						},
					]),
				"INVALID_ARGUMENT",
				"colour on a tinted pass",
			);
			expectCode(
				check,
				() =>
					applyOperations(canvas, [
						{
							type: "outline",
							layerId: "base",
							mode: "uniform",
							color: { r: 1, g: 2, b: 3, a: 128 },
						},
					]),
				"INVALID_ARGUMENT",
				"translucent uniform colour",
			);
		},
	},
	{
		name: "out-of-range numbers and unknown enums are refused",
		run: (check) => {
			const canvas = fresh();
			paintSword(canvas);
			const bad = [
				{ luminanceDropPermille: 401 },
				{ saturationRatioPermille: 2001 },
				{ maxHueOffsetDegrees: 181 },
			];
			for (const fields of bad) {
				expectCode(
					check,
					() => applyOperations(canvas, [outlineOp(fields)]),
					"INVALID_ARGUMENT",
					JSON.stringify(fields),
				);
			}
			expectCode(
				check,
				() => applyOperations(canvas, [outlineOp({ mode: "glow" })]),
				"INVALID_ARGUMENT",
				"unknown mode",
			);
			expectCode(
				check,
				() => applyOperations(canvas, [outlineOp({ position: "middle" })]),
				"INVALID_ARGUMENT",
				"unknown position",
			);
		},
	},
	{
		name: "empty and one-pixel inputs keep the frame rules defined",
		run: (check) => {
			const empty = fresh();
			applyOperations(empty, [
				{ type: "outline", layerId: "base", mode: "tinted" },
				{
					type: "outline",
					layerId: "base",
					mode: "uniform",
					color: FRAME_COLOR,
				},
				{ type: "outline", layerId: "base", mode: "strip" },
			] as unknown as BatchOperation[]);
			check.deepEqual(
				snapshot(empty),
				new Uint8Array(WIDTH * HEIGHT * 4),
				"fully empty canvas stays byte-identical",
			);

			const lone = fresh();
			writePixel(layerBytes(lone, "base"), WIDTH, 8, 8, SWORD_COLOR);
			applyOperations(lone, [
				{ type: "outline", layerId: "base", mode: "tinted" },
			]);
			check.deepEqual(
				pixelAt(lone, 8, 8),
				SWORD_COLOR,
				"a lone pixel has no reference and keeps its colour",
			);

			applyOperations(lone, [
				{
					type: "outline",
					layerId: "base",
					mode: "tinted",
					position: "outside",
				},
			]);
			const outsideColor = deriveSpec(SWORD_COLOR, {});
			for (const [x, y] of [
				[7, 8],
				[9, 8],
				[8, 7],
				[8, 9],
			]) {
				check.deepEqual(
					pixelAt(lone, x, y),
					outsideColor,
					`outside cell (${x},${y}) is derived`,
				);
			}

			const corner = fresh();
			writePixel(layerBytes(corner, "base"), WIDTH, 0, 0, SWORD_COLOR);
			applyOperations(corner, [
				{
					type: "outline",
					layerId: "base",
					mode: "uniform",
					position: "outside",
					color: FRAME_COLOR,
				},
			]);
			check.deepEqual(
				pixelAt(corner, 1, 0),
				FRAME_COLOR,
				"right cell clipped in",
			);
			check.deepEqual(
				pixelAt(corner, 0, 1),
				FRAME_COLOR,
				"lower cell clipped in",
			);
			check.equal(
				changedCells(
					new Uint8Array(WIDTH * HEIGHT * 4),
					layerBytes(corner, "base"),
					WIDTH,
					HEIGHT,
				).length,
				3,
				"only the corner pixel and its two in-canvas neighbours change",
			);
		},
	},
	{
		name: "an edge-touching object is framed inside the canvas",
		run: (check) => {
			const canvas = fresh();
			paintBox(canvas, "base", { x0: 0, y0: 4, x1: 4, y1: 11 }, SWORD_COLOR);
			const before = snapshot(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "uniform",
					position: "inside",
					color: FRAME_COLOR,
				},
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "uniform",
				color: FRAME_COLOR,
			});
			expectPixels(check, canvas, "base", expected, "edge-touching pixels");
			check.deepEqual(
				pixelAt(canvas, 0, 4),
				FRAME_COLOR,
				"canvas edge counts as a frame boundary",
			);
			check.deepEqual(
				pixelAt(canvas, 2, 8),
				SWORD_COLOR,
				"interior stays body colour",
			);
		},
	},
	{
		name: "a transparent hole is an outside frame target",
		run: (check) => {
			const canvas = fresh();
			paintBox(canvas, "base", { x0: 3, y0: 3, x1: 12, y1: 12 }, SWORD_COLOR);
			paintBox(canvas, "base", { x0: 6, y0: 6, x1: 9, y1: 9 }, EMPTY);
			const before = snapshot(canvas);
			applyOperations(canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "uniform",
					position: "outside",
					color: FRAME_COLOR,
				},
			]);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "uniform",
				position: "outside",
				color: FRAME_COLOR,
			});
			expectPixels(check, canvas, "base", expected, "hole frame pixels");
			check.deepEqual(
				pixelAt(canvas, 6, 6),
				FRAME_COLOR,
				"hole edge takes the frame colour",
			);
			for (const [x, y] of [
				[7, 7],
				[8, 7],
				[7, 8],
				[8, 8],
			]) {
				check.equal(
					pixelAt(canvas, x, y).a,
					0,
					`hole centre (${x},${y}) stays empty`,
				);
			}
		},
	},
	{
		name: "a multi-layer canvas only changes the named layer",
		run: (check) => {
			const canvas = fresh();
			addLayer(canvas, { id: "overlay" });
			paintIngot(canvas);
			paintBox(
				canvas,
				"overlay",
				{ x0: 0, y0: 0, x1: 3, y1: 3 },
				{ r: 9, g: 8, b: 7, a: 0 },
			);
			paintBox(
				canvas,
				"overlay",
				{ x0: 12, y0: 12, x1: 15, y1: 15 },
				FRAME_COLOR,
			);
			const overlayBefore = snapshot(canvas, "overlay");
			const baseBefore = snapshot(canvas, "base");
			applyOperations(canvas, [
				{ type: "outline", layerId: "base", mode: "black" },
			]);
			const expected = expectedOutline(baseBefore, WIDTH, HEIGHT, {
				mode: "black",
			});
			expectPixels(check, canvas, "base", expected, "base pixels");
			check.deepEqual(
				snapshot(canvas, "overlay"),
				overlayBefore,
				"overlay layer is byte-identical",
			);
		},
	},
	{
		name: "JSON outline fields reach the typed op and paint",
		run: (check) => {
			const uniform = fresh();
			paintIngot(uniform);
			const before = snapshot(uniform);
			const parsed = parseOperationsJson(
				JSON.stringify([
					{
						type: "outline",
						layerId: "base",
						mode: "uniform",
						position: "outside",
						color: "#1C344C",
						luminanceDropPermille: 100,
						saturationRatioPermille: 900,
						maxHueOffsetDegrees: 10,
						snapFamilies: false,
						selection: "all",
					},
				]),
			);
			const expected = expectedOutline(before, WIDTH, HEIGHT, {
				mode: "uniform",
				position: "outside",
				color: { r: 0x1c, g: 0x34, b: 0x4c, a: 255 },
			});
			applyOperations(uniform, parsed);
			expectPixels(check, uniform, "base", expected, "JSON uniform outside");

			const tinted = fresh();
			paintIngot(tinted);
			applyOperations(
				tinted,
				parseOperationsJson(
					JSON.stringify([
						{
							type: "outline",
							layerId: "base",
							mode: "tinted",
							family: "gold",
						},
					]),
				),
			);
			check.deepEqual(
				pixelAt(tinted, 4, 6),
				snapSpec(deriveSpec(INGOT_COLOR, {}), "gold"),
				"JSON family reaches the alignment rule",
			);
		},
	},
	{
		name: "JSON outline field errors name their path",
		run: (check) => {
			expectInvalidAt(
				check,
				'[{"type": "outline", "mode": "uniform"}]',
				"operations[0].color",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "color": "#112233"}]',
				"operations[0].color",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "mode": "uniform", "color": "#11223344"}]',
				"operations[0].color",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "mode": "uniform", "color": "transparent"}]',
				"operations[0].color",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "mode": "glow"}]',
				"operations[0].mode",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "position": "middle"}]',
				"operations[0].position",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "luminanceDropPermille": 401}]',
				"operations[0].luminanceDropPermille",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "saturationRatioPermille": 2001}]',
				"operations[0].saturationRatioPermille",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "maxHueOffsetDegrees": 181}]',
				"operations[0].maxHueOffsetDegrees",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "snapFamilies": "yes"}]',
				"operations[0].snapFamilies",
			);
			expectInvalidAt(
				check,
				'[{"type": "outline", "family": 42}]',
				"operations[0].family",
			);
		},
	},
	{
		name: "golden bytes lock the tinted and uniform-outside passes",
		run: (check) => {
			const tinted = goldenSwordTinted();
			applyOperations(tinted.canvas, [
				{ type: "outline", layerId: "base", mode: "tinted" },
			]);
			check.equal(
				check.sha256Hex(tinted.expected),
				OUTLINE_GOLDENS.swordTinted,
				"tinted expectation stays pinned",
			);
			check.equal(
				check.sha256Hex(layerBytes(tinted.canvas, "base")),
				OUTLINE_GOLDENS.swordTinted,
				"tinted bytes match the pinned digest on this runtime",
			);

			const uniform = goldenGemUniformOutside();
			applyOperations(uniform.canvas, [
				{
					type: "outline",
					layerId: "base",
					mode: "uniform",
					position: "outside",
					color: FRAME_COLOR,
				},
			]);
			check.equal(
				check.sha256Hex(uniform.expected),
				OUTLINE_GOLDENS.gemUniformOutside,
				"uniform-outside expectation stays pinned",
			);
			check.equal(
				check.sha256Hex(layerBytes(uniform.canvas, "base")),
				OUTLINE_GOLDENS.gemUniformOutside,
				"uniform-outside bytes match the pinned digest on this runtime",
			);
		},
	},
];
