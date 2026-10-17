import {
	type GeneratePatternName,
	generateProcedural,
} from "../../src/core/procedural.ts";
import { seamMetrics } from "../../src/core/tile.ts";
import type { RGBA } from "../../src/core/types.ts";

/** Runner-agnostic assertion surface: bun:test and node:test adapt to this. */
export interface SeamlessCheck {
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface SeamlessCase {
	name: string;
	run(check: SeamlessCheck): void;
}

/**
 * Patterns a surface builder repeats across a wall or an item face. Every
 * one of them has to wrap: the first column has to continue into the last
 * and the first row into the last, exactly like two interior neighbours do.
 * `noise` and `gradient` are excluded because both are single-shot fields
 * with no repeating structure.
 */
export const TILING_PATTERNS: readonly GeneratePatternName[] = [
	"brick",
	"veins",
	"clustered-noise",
	"spots",
	"grain",
	"stripes",
	"checker",
];

const TILE_SIZES: readonly number[] = [16, 32];
const TILE_SEEDS: readonly number[] = [0, 7, 12345];

/** Contrast-heavy palette so a wrapped edge is easy to see. */
const TILE_PALETTE: RGBA[] = [
	{ r: 0x17, g: 0x17, b: 0x1a, a: 255 },
	{ r: 0x84, g: 0x84, b: 0x8c, a: 255 },
	{ r: 0xe8, g: 0xe8, b: 0xee, a: 255 },
	{ r: 0x4a, g: 0x0c, b: 0x2a, a: 255 },
];

function offsetOf(width: number, x: number, y: number): number {
	return (y * width + x) * 4;
}

/** Same four-channel squared distance the tile report uses. */
function squaredDistance(
	pixels: Uint8Array,
	first: number,
	second: number,
): number {
	const dr = (pixels[first] as number) - (pixels[second] as number);
	const dg = (pixels[first + 1] as number) - (pixels[second + 1] as number);
	const db = (pixels[first + 2] as number) - (pixels[second + 2] as number);
	const da = (pixels[first + 3] as number) - (pixels[second + 3] as number);
	return dr * dr + dg * dg + db * db + da * da;
}

/** Mean squared distance between interior neighbours of one image. */
function interiorAverage(
	pixels: Uint8Array,
	width: number,
	height: number,
): number {
	let raw = 0;
	let pairs = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x + 1 < width; x += 1) {
			raw += squaredDistance(
				pixels,
				offsetOf(width, x, y),
				offsetOf(width, x + 1, y),
			);
			pairs += 1;
		}
	}
	for (let y = 0; y + 1 < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			raw += squaredDistance(
				pixels,
				offsetOf(width, x, y),
				offsetOf(width, x, y + 1),
			);
			pairs += 1;
		}
	}
	return pairs === 0 ? 0 : raw / pairs;
}

function assertWraps(
	check: SeamlessCheck,
	pattern: GeneratePatternName,
	width: number,
	height: number,
	seed: number,
): void {
	const result = generateProcedural(pattern, {
		width,
		height,
		seed,
		palette: TILE_PALETTE.map((color) => ({ ...color })),
	});
	const seams = seamMetrics(result.pixels, width, height);
	const inside = interiorAverage(result.pixels, width, height);
	const label = `${pattern} ${width}x${height} seed ${seed}`;
	check.ok(
		seams.vertical.raw / seams.vertical.pairs <= inside,
		`${label}: left/right seam ${(seams.vertical.raw / seams.vertical.pairs).toFixed(1)} exceeds interior average ${inside.toFixed(1)}`,
	);
	check.ok(
		seams.horizontal.raw / seams.horizontal.pairs <= inside,
		`${label}: top/bottom seam ${(seams.horizontal.raw / seams.horizontal.pairs).toFixed(1)} exceeds interior average ${inside.toFixed(1)}`,
	);
	check.ok(
		seams.corner.raw / seams.corner.pairs <= inside,
		`${label}: corner seam ${(seams.corner.raw / seams.corner.pairs).toFixed(1)} exceeds interior average ${inside.toFixed(1)}`,
	);
}

export const SEAMLESS_CASES: SeamlessCase[] = TILING_PATTERNS.map(
	(pattern): SeamlessCase => ({
		name: `${pattern} wraps every edge at 16 and 32 pixels square`,
		run(check) {
			for (const size of TILE_SIZES) {
				for (const seed of TILE_SEEDS) {
					assertWraps(check, pattern, size, size, seed);
				}
			}
		},
	}),
);
