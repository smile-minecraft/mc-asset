import { McAssetError } from "../../src/core/errors.ts";
import {
	normalizeKeepColors,
	parseKeepColorOption,
	QUANTIZE_PALETTE_MAX_COLORS,
	quantizePixelsWithPalette,
	quantizePixelsWithReservedColors,
	resolveQuantizeRequest,
} from "../../src/core/quantize-palette.ts";
import type { RGBA } from "../../src/core/types.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface QuantizePaletteCase {
	name: string;
	run(check: CaseCheck): void;
}

const OPAQUE = 255;

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

const RED: RGBA = { r: 255, g: 0, b: 0, a: OPAQUE };
const GREEN: RGBA = { r: 0, g: 255, b: 0, a: OPAQUE };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: OPAQUE };
const DARK_RED: RGBA = { r: 128, g: 0, b: 0, a: OPAQUE };
const OUTLINE: RGBA = { r: 26, g: 29, b: 33, a: OPAQUE };

export const QUANTIZE_PALETTE_CASES: QuantizePaletteCase[] = [
	{
		name: "explicit palette maps to the nearest entry, hidden RGB takes part",
		run: (check) => {
			const input = px([
				{ r: 200, g: 0, b: 0, a: OPAQUE },
				{ r: 200, g: 10, b: 10, a: 0 },
			]);
			const palette = [RED, GREEN];
			try {
				const result = quantizePixelsWithPalette(input, palette);
				check.deepEqual(
					flat(result.pixels),
					flat(px([RED, RED])),
					"both pixels take the nearest palette red",
				);
				check.deepEqual(result.palette, palette, "palette order kept");
				check.equal(result.colorCount, 2, "colorCount");
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("explicit palette mapping is not implemented yet");
				}
				throw error;
			}
		},
	},
	{
		name: "explicit palette breaks exact ties by first appearance",
		run: (check) => {
			const input = px([{ r: 128, g: 0, b: 0, a: OPAQUE }]);
			const palette = [RED, DARK_RED];
			try {
				const result = quantizePixelsWithPalette(input, palette);
				check.deepEqual(
					flat(result.pixels),
					flat(px([DARK_RED])),
					"128 is closer to 128 than to 255",
				);
				const equidistant = px([{ r: 127, g: 127, b: 127, a: OPAQUE }]);
				const tied = quantizePixelsWithPalette(equidistant, [
					{ r: 0, g: 0, b: 0, a: OPAQUE },
					{ r: 254, g: 254, b: 254, a: OPAQUE },
				]);
				check.deepEqual(
					flat(tied.pixels),
					flat(px([{ r: 0, g: 0, b: 0, a: OPAQUE }])),
					"exact tie takes the earlier palette entry",
				);
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("tie-breaking is not implemented yet");
				}
				throw error;
			}
		},
	},
	{
		name: "reserved colors stay byte-identical under an explicit palette",
		run: (check) => {
			const input = px([RED, { r: 250, g: 5, b: 5, a: OPAQUE }, BLUE]);
			try {
				const result = quantizePixelsWithPalette(input, [RED, BLUE], [RED]);
				check.deepEqual(
					flat(result.pixels),
					flat(px([RED, RED, BLUE])),
					"reserved red pixel stays red, near-red maps to red",
				);
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("reserved colors are not implemented yet");
				}
				throw error;
			}
		},
	},
	{
		name: "reserved colors stay byte-identical under a colors budget",
		run: (check) => {
			const input = px([RED, GREEN, BLUE, GREEN]);
			try {
				const result = quantizePixelsWithReservedColors(input, 2, [GREEN]);
				check.deepEqual(
					flat(result.pixels).slice(4, 8),
					flat(px([GREEN])),
					"green pixel stays green",
				);
				check.deepEqual(
					flat(result.pixels).slice(12, 16),
					flat(px([GREEN])),
					"second green pixel stays green",
				);
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("colors-budget reservation is not implemented yet");
				}
				throw error;
			}
		},
	},
	{
		name: "reserved colors outside the palette are rejected",
		run: (check) => {
			try {
				quantizePixelsWithPalette(px([OUTLINE]), [RED, BLUE], [OUTLINE]);
				check.fail("reserved color outside the palette should be rejected");
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("palette membership check is not implemented yet");
				}
				if (
					error instanceof McAssetError &&
					error.code === "INVALID_ARGUMENT"
				) {
					return;
				}
				throw error;
			}
		},
	},
	{
		name: "reserved colors beyond the budget are rejected before writing",
		run: (check) => {
			try {
				quantizePixelsWithReservedColors(px([RED, GREEN, BLUE]), 2, [
					RED,
					GREEN,
					BLUE,
				]);
				check.fail("three reserved colors over a budget of 2 should fail");
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("budget guard is not implemented yet");
				}
				if (
					error instanceof McAssetError &&
					error.code === "INVALID_ARGUMENT"
				) {
					return;
				}
				throw error;
			}
		},
	},
	{
		name: "duplicate reserved colors share one budget slot, absent ones cost nothing",
		run: (check) => {
			try {
				const deduped = normalizeKeepColors([RED, GREEN, RED]);
				check.deepEqual(deduped, [RED, GREEN], "duplicates removed");
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("keep-color dedupe is not implemented yet");
					return;
				}
				throw error;
			}
			try {
				const input = px([RED, GREEN]);
				const absent: RGBA = { r: 9, g: 9, b: 9, a: OPAQUE };
				const result = quantizePixelsWithReservedColors(input, 2, [
					RED,
					absent,
				]);
				check.equal(result.colorCount, 2, "absent keep color costs nothing");
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("absent keep colors are not implemented yet");
				}
				throw error;
			}
		},
	},
	{
		name: "zero remaining budget maps other pixels to reserved colors",
		run: (check) => {
			const input = px([RED, { r: 250, g: 5, b: 5, a: OPAQUE }]);
			try {
				const result = quantizePixelsWithReservedColors(input, 1, [RED]);
				check.deepEqual(
					flat(result.pixels),
					flat(px([RED, RED])),
					"near-red falls back to the reserved red",
				);
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("zero-budget fallback is not implemented yet");
				}
				throw error;
			}
		},
	},
	{
		name: "keep-color text parses r,g,b,a and rejects bad channels",
		run: (check) => {
			try {
				const parsed = parseKeepColorOption("255,0,0,255");
				check.deepEqual(parsed, RED, "parsed channels");
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("keep-color parsing is not implemented yet");
					return;
				}
				throw error;
			}
			throwsCode(check, () => parseKeepColorOption(""), "INVALID_ARGUMENT");
			throwsCode(
				check,
				() => parseKeepColorOption("255,0,0"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => parseKeepColorOption("256,0,0,255"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => parseKeepColorOption("255,0,0,1.5"),
				"INVALID_ARGUMENT",
			);
			throwsCode(check, () => parseKeepColorOption("red"), "INVALID_ARGUMENT");
		},
	},
	{
		name: "empty palette and oversized palette are rejected",
		run: (check) => {
			try {
				resolveQuantizeRequest({ palette: [] });
				check.fail("empty palette should be rejected");
			} catch (error) {
				if (error instanceof McAssetError && error.code === "INTERNAL_ERROR") {
					check.fail("palette validation is not implemented yet");
					return;
				}
				if (
					error instanceof McAssetError &&
					error.code === "INVALID_ARGUMENT"
				) {
					// Continue to the oversize check below.
				} else {
					throw error;
				}
			}
			throwsCode(
				check,
				() =>
					resolveQuantizeRequest({
						palette: Array.from(
							{ length: QUANTIZE_PALETTE_MAX_COLORS + 1 },
							(_, i) => ({
								r: i % 256,
								g: (i >> 8) % 16,
								b: 0,
								a: OPAQUE,
							}),
						),
					}),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "colors plus palette conflicts, neither is missing-input",
		run: (check) => {
			throwsCode(
				check,
				() => resolveQuantizeRequest({ colors: 4, palette: [RED] }),
				"ARGUMENT_CONFLICT",
			);
			throwsCode(check, () => resolveQuantizeRequest({}), "INVALID_ARGUMENT");
		},
	},
	{
		name: "4096 palette entries are accepted and 4097 are refused",
		run(check) {
			const palette = Array.from({ length: 4096 }, (_, i) => ({
				r: i % 256,
				g: i >> 8,
				b: 0,
				a: 255,
			}));
			const result = quantizePixelsWithPalette(
				px([{ r: 255, g: 15, b: 0, a: 255 }]),
				palette,
			);
			check.deepEqual(
				flat(result.pixels),
				[255, 15, 0, 255],
				"last palette entry reachable",
			);
			throwsCode(
				check,
				() => quantizePixelsWithPalette(px([RED]), [...palette, BLUE]),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "transparent hidden RGB and alpha both determine nearest entry",
		run(check) {
			const hidden = { r: 200, g: 0, b: 0, a: 0 };
			const result = quantizePixelsWithPalette(
				px([hidden]),
				[{ r: 0, g: 0, b: 0, a: 0 }, hidden, RED],
				[hidden],
			);
			check.deepEqual(
				flat(result.pixels),
				[200, 0, 0, 0],
				"all four reserved channels stay exact",
			);
			const alpha = quantizePixelsWithPalette(
				px([{ r: 200, g: 0, b: 0, a: 10 }]),
				[RED, hidden],
			);
			check.deepEqual(
				flat(alpha.pixels),
				[200, 0, 0, 0],
				"alpha participates in distance",
			);
		},
	},
	{
		name: "reservation removes kept pixels before median cut averages the rest",
		run(check) {
			const result = quantizePixelsWithReservedColors(
				px([
					{ r: 0, g: 0, b: 0, a: 255 },
					{ r: 100, g: 0, b: 0, a: 255 },
					{ r: 200, g: 0, b: 0, a: 255 },
				]),
				2,
				[{ r: 0, g: 0, b: 0, a: 255 }],
			);
			check.deepEqual(
				flat(result.pixels),
				[0, 0, 0, 255, 150, 0, 0, 255, 150, 0, 0, 255],
				"one slot reserved and remaining pair averages to 150",
			);
		},
	},
	{
		name: "explicit palette indices address the complete declared palette including unused entries",
		run(check) {
			const result = quantizePixelsWithPalette(px([BLUE, RED]), [
				RED,
				GREEN,
				BLUE,
			]);
			check.deepEqual(
				result.palette,
				[RED, GREEN, BLUE],
				"unused green entry remains",
			);
			check.deepEqual(
				Array.from(result.indices),
				[2, 0],
				"indices address declared entries",
			);
			check.equal(result.colorCount, 3, "count includes unused declared entry");
		},
	},
	{
		name: "colors result deduplicates reserved and quantized representatives and indexes their union",
		run(check) {
			const kept = { r: 100, g: 0, b: 0, a: 255 };
			const result = quantizePixelsWithReservedColors(
				px([
					kept,
					{ r: 0, g: 0, b: 0, a: 255 },
					{ r: 200, g: 0, b: 0, a: 255 },
				]),
				2,
				[kept],
			);
			check.deepEqual(
				result.palette,
				[kept],
				"remaining pair averages to the already reserved color",
			);
			check.deepEqual(
				Array.from(result.indices),
				[0, 0, 0],
				"indices address deduplicated union",
			);
			check.equal(
				result.colorCount,
				1,
				"union counts the coincident representative once",
			);
		},
	},
];
