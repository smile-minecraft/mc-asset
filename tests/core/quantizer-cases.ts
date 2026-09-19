import { McAssetError } from "../../src/core/errors.ts";
import {
	assertMcpxPaletteCapacity,
	quantizePixels,
	validateColorsOption,
} from "../../src/core/quantizer.ts";
import type { RGBA } from "../../src/core/types.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface QuantizerCase {
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

function px(colors: RGBA[]): Uint8Array {
	const out = new Uint8Array(colors.length * 4);
	for (let i = 0; i < colors.length; i += 1) {
		const c = colors[i] as RGBA;
		out[i * 4] = c.r;
		out[i * 4 + 1] = c.g;
		out[i * 4 + 2] = c.b;
		out[i * 4 + 3] = c.a;
	}
	return out;
}

function flat(pixels: Uint8Array): number[] {
	return Array.from(pixels);
}

/** Integer-only LCG: deterministic fixture source, no randomness. */
function lcgPixels(count: number, seed: number): Uint8Array {
	let state = seed >>> 0;
	const out = new Uint8Array(count * 4);
	for (let i = 0; i < count * 4; i += 1) {
		state = (state * 1664525 + 1013904223) >>> 0;
		out[i] = (state >>> 24) & 0xff;
	}
	return out;
}

const OPAQUE = 255;

export const QUANTIZER_CASES: QuantizerCase[] = [
	{
		name: "colors option is required and must be an integer in [1, 4096]",
		run: (check) => {
			const bad: unknown[] = [
				undefined,
				null,
				0,
				-1,
				-4096,
				4097,
				65536,
				1.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				"8",
				{},
			];
			for (const value of bad) {
				throwsCode(
					check,
					() => validateColorsOption(value),
					"INVALID_ARGUMENT",
				);
				throwsCode(
					check,
					() =>
						quantizePixels(px([{ r: 1, g: 2, b: 3, a: 255 }]), value as number),
					"INVALID_ARGUMENT",
				);
			}
			check.equal(validateColorsOption(1), 1, "lower edge accepted");
			check.equal(validateColorsOption(4096), 4096, "upper edge accepted");
			check.equal(validateColorsOption(7), 7, "interior accepted");
		},
	},
	{
		name: "colors 1 averages to a single integer color, remainder rounds half up",
		run: (check) => {
			const input = px([
				{ r: 0, g: 0, b: 0, a: OPAQUE },
				{ r: 1, g: 0, b: 0, a: OPAQUE },
			]);
			const result = quantizePixels(input, 1);
			// r sum is 1 over 2 pixels: base 0, remainder 1, 2*1 >= 2 rounds up.
			check.deepEqual(
				result.palette,
				[{ r: 1, g: 0, b: 0, a: OPAQUE }],
				"single representative",
			);
			check.deepEqual(
				flat(result.pixels),
				[1, 0, 0, OPAQUE, 1, 0, 0, OPAQUE],
				"both pixels take the representative",
			);
			check.deepEqual(Array.from(result.indices), [0, 0], "indices");
			check.equal(result.colorCount, 1, "colorCount");
		},
	},
	{
		name: "remainder below half rounds down",
		run: (check) => {
			const input = px([
				{ r: 0, g: 0, b: 0, a: OPAQUE },
				{ r: 0, g: 0, b: 0, a: OPAQUE },
				{ r: 1, g: 0, b: 0, a: OPAQUE },
			]);
			const result = quantizePixels(input, 1);
			// r sum is 1 over 3 pixels: 2*1 < 3 stays at base 0.
			check.deepEqual(
				result.palette,
				[{ r: 0, g: 0, b: 0, a: OPAQUE }],
				"rounds down",
			);
			check.deepEqual(
				flat(result.pixels),
				[0, 0, 0, OPAQUE, 0, 0, 0, OPAQUE, 0, 0, 0, OPAQUE],
				"all pixels take the representative",
			);
		},
	},
	{
		name: "even-count median split takes the smaller side",
		run: (check) => {
			const input = px([
				{ r: 0, g: 0, b: 0, a: OPAQUE },
				{ r: 10, g: 0, b: 0, a: OPAQUE },
				{ r: 20, g: 0, b: 0, a: OPAQUE },
				{ r: 30, g: 0, b: 0, a: OPAQUE },
			]);
			const result = quantizePixels(input, 2);
			// Upper-side split would give reps 0 and 20; smaller side gives 5/25.
			check.deepEqual(
				result.palette,
				[
					{ r: 5, g: 0, b: 0, a: OPAQUE },
					{ r: 25, g: 0, b: 0, a: OPAQUE },
				],
				"representatives",
			);
			check.deepEqual(
				flat(result.pixels),
				[5, 0, 0, OPAQUE, 5, 0, 0, OPAQUE, 25, 0, 0, OPAQUE, 25, 0, 0, OPAQUE],
				"mapped bytes",
			);
			check.deepEqual(Array.from(result.indices), [0, 0, 1, 1], "indices");
		},
	},
	{
		name: "widest channel wins the split plane",
		run: (check) => {
			const input = px([
				{ r: 0, g: 0, b: 0, a: OPAQUE },
				{ r: 10, g: 0, b: 0, a: OPAQUE },
				{ r: 0, g: 0, b: 100, a: OPAQUE },
			]);
			const result = quantizePixels(input, 2);
			// b range (100) beats r range (10): {(0,0,0),(10,0,0)} vs {(0,0,100)}.
			// An r split would instead average to (0,0,50).
			check.deepEqual(
				result.palette,
				[
					{ r: 5, g: 0, b: 0, a: OPAQUE },
					{ r: 0, g: 0, b: 100, a: OPAQUE },
				],
				"representatives",
			);
			check.deepEqual(
				flat(result.pixels),
				[5, 0, 0, OPAQUE, 5, 0, 0, OPAQUE, 0, 0, 100, OPAQUE],
				"mapped bytes",
			);
			check.deepEqual(Array.from(result.indices), [0, 0, 1], "indices");
		},
	},
	{
		name: "equal-count buckets order by r, g, b, then min pixel index",
		run: (check) => {
			const input = px([
				{ r: 0, g: 0, b: 0, a: OPAQUE },
				{ r: 100, g: 0, b: 0, a: OPAQUE },
				{ r: 0, g: 100, b: 0, a: OPAQUE },
				{ r: 0, g: 0, b: 100, a: OPAQUE },
			]);
			const first = quantizePixels(input, 2);
			check.deepEqual(
				first.palette,
				[
					{ r: 0, g: 0, b: 50, a: OPAQUE },
					{ r: 50, g: 50, b: 0, a: OPAQUE },
				],
				"count tie broken by representative r",
			);
			check.deepEqual(
				flat(first.pixels),
				[
					0,
					0,
					50,
					OPAQUE,
					50,
					50,
					0,
					OPAQUE,
					50,
					50,
					0,
					OPAQUE,
					0,
					0,
					50,
					OPAQUE,
				],
				"mapped bytes",
			);
			check.deepEqual(
				Array.from(first.indices),
				[0, 1, 1, 0],
				"indices follow input order",
			);
			// Reversed input order must still quantize deterministically and
			// keep the same palette order rule (r decides, not input order).
			const reversed = px([
				{ r: 0, g: 0, b: 100, a: OPAQUE },
				{ r: 0, g: 100, b: 0, a: OPAQUE },
				{ r: 100, g: 0, b: 0, a: OPAQUE },
				{ r: 0, g: 0, b: 0, a: OPAQUE },
			]);
			const second = quantizePixels(reversed, 2);
			check.deepEqual(second.palette, first.palette, "palette order stable");
		},
	},
	{
		name: "same input quantizes byte-identical on rerun",
		run: (check) => {
			const input = lcgPixels(96, 0x51ed71ce);
			const first = quantizePixels(input, 7);
			const second = quantizePixels(input, 7);
			check.deepEqual(flat(first.pixels), flat(second.pixels), "pixels");
			check.deepEqual(first.palette, second.palette, "palette");
			check.deepEqual(
				Array.from(first.indices),
				Array.from(second.indices),
				"indices",
			);
			check.ok(first.palette.length <= 7, "respects the color cap");
			// The input buffer is read-only input: quantize must not mutate it.
			check.deepEqual(
				flat(input),
				flat(lcgPixels(96, 0x51ed71ce)),
				"input kept",
			);
		},
	},
	{
		name: "colors at or above the distinct count changes zero pixels",
		run: (check) => {
			const colors: RGBA[] = [
				{ r: 10, g: 20, b: 30, a: 255 },
				{ r: 40, g: 50, b: 60, a: 128 },
				{ r: 70, g: 80, b: 90, a: 0 },
			];
			const input = px(colors);
			for (const option of [3, 4, 9, 4096]) {
				const result = quantizePixels(input, option);
				check.deepEqual(
					flat(result.pixels),
					flat(input),
					`bytes kept (${option})`,
				);
				check.deepEqual(result.palette, colors, `palette exact (${option})`);
				check.equal(result.colorCount, 3, `colorCount (${option})`);
			}
		},
	},
	{
		name: "hidden RGB under A=0 is data, never silently zeroed",
		run: (check) => {
			// Averaging path: hidden channels participate like any other data.
			const mixed = px([
				{ r: 255, g: 0, b: 0, a: 0 },
				{ r: 255, g: 0, b: 0, a: 0 },
				{ r: 0, g: 0, b: 255, a: 0 },
			]);
			const averaged = quantizePixels(mixed, 1);
			check.deepEqual(
				averaged.palette,
				[{ r: 170, g: 0, b: 85, a: 0 }],
				"hidden RGB averaged, alpha kept at 0",
			);
			// Zero-change path: distinct hidden colors survive verbatim.
			const hidden: RGBA[] = [
				{ r: 255, g: 0, b: 0, a: 0 },
				{ r: 0, g: 0, b: 0, a: 0 },
			];
			const kept = quantizePixels(px(hidden), 2);
			check.deepEqual(flat(kept.pixels), flat(px(hidden)), "hidden bytes kept");
			check.deepEqual(kept.palette, hidden, "hidden palette exact");
		},
	},
	{
		name: "malformed buffers are rejected, empty buffers stay empty",
		run: (check) => {
			throwsCode(
				check,
				() => quantizePixels(new Uint8Array(7), 4),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => quantizePixels(new Uint8Array(3), 1),
				"INVALID_ARGUMENT",
			);
			const empty = quantizePixels(new Uint8Array(0), 4);
			check.equal(empty.palette.length, 0, "no palette for no pixels");
			check.equal(empty.pixels.length, 0, "no bytes for no pixels");
			check.equal(empty.indices.length, 0, "no indices for no pixels");
			check.equal(empty.colorCount, 0, "zero colors");
		},
	},
	{
		name: "mcpx capacity guard reports overflow above 4096",
		run: (check) => {
			assertMcpxPaletteCapacity(0);
			assertMcpxPaletteCapacity(4096);
			try {
				assertMcpxPaletteCapacity(4097);
			} catch (error) {
				if (
					error instanceof McAssetError &&
					error.code === "MCPX_PALETTE_OVERFLOW"
				) {
					const details = error.details as { colorCount?: unknown };
					check.equal(details.colorCount, 4097, "details carry the count");
					return;
				}
				check.fail(
					`expected MCPX_PALETTE_OVERFLOW but got ${error instanceof McAssetError ? error.code : String(error)}`,
				);
			}
			check.fail("expected MCPX_PALETTE_OVERFLOW but nothing was thrown");
		},
	},
];
