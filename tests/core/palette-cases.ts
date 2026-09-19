import { McAssetError } from "../../src/core/errors.ts";
import {
	applyPalette,
	extractPalette,
	inspectPalette,
	mapPixelsToPalette,
} from "../../src/core/palette.ts";
import type { RGBA } from "../../src/core/types.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface PaletteCase {
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

export const PALETTE_CASES: PaletteCase[] = [
	{
		name: "extract returns first-appearance entries with stable ids",
		run: (check) => {
			const input = px([
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 0, g: 255, b: 0, a: 255 },
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 0, g: 0, b: 0, a: 0 },
			]);
			const palette = extractPalette(input);
			check.deepEqual(
				palette,
				{
					entries: [
						{ id: "color-0", color: { r: 255, g: 0, b: 0, a: 255 } },
						{ id: "color-1", color: { r: 0, g: 255, b: 0, a: 255 } },
						{ id: "color-2", color: { r: 0, g: 0, b: 0, a: 0 } },
					],
				},
				"entries golden",
			);
			// Rerun is byte-identical in shape: same ids, same order.
			check.deepEqual(extractPalette(input), palette, "rerun stable");
			check.deepEqual(
				extractPalette(new Uint8Array(0)),
				{ entries: [] },
				"empty",
			);
		},
	},
	{
		name: "map returns nearest indices with lowest-index ties",
		run: (check) => {
			const palette = {
				entries: [
					{ id: "k", color: { r: 0, g: 0, b: 0, a: 255 } },
					{ id: "w", color: { r: 255, g: 255, b: 255, a: 255 } },
				],
			};
			const input = px([
				{ r: 10, g: 10, b: 10, a: 255 },
				{ r: 200, g: 200, b: 200, a: 255 },
			]);
			check.deepEqual(
				Array.from(mapPixelsToPalette(input, palette)),
				[0, 1],
				"near/far",
			);
			// Exact tie: (0,0,1) is distance 1 from both entries, lowest wins.
			const tied = {
				entries: [
					{ id: "a", color: { r: 0, g: 0, b: 0, a: 255 } },
					{ id: "b", color: { r: 0, g: 0, b: 2, a: 255 } },
				],
			};
			check.deepEqual(
				Array.from(
					mapPixelsToPalette(px([{ r: 0, g: 0, b: 1, a: 255 }]), tied),
				),
				[0],
				"tie takes the lower index",
			);
		},
	},
	{
		name: "apply rewrites to palette colors without touching the input",
		run: (check) => {
			const palette = {
				entries: [
					{ id: "k", color: { r: 0, g: 0, b: 0, a: 255 } },
					{ id: "w", color: { r: 255, g: 255, b: 255, a: 255 } },
				],
			};
			const input = px([
				{ r: 10, g: 10, b: 10, a: 255 },
				{ r: 200, g: 200, b: 200, a: 255 },
			]);
			const before = flat(input);
			const applied = applyPalette(input, palette);
			check.deepEqual(
				flat(applied),
				[0, 0, 0, 255, 255, 255, 255, 255],
				"output golden",
			);
			check.deepEqual(flat(input), before, "input buffer untouched");
			check.ok(applied !== input, "returns a fresh buffer");
		},
	},
	{
		name: "inspect report shape is stable",
		run: (check) => {
			const input = px([
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 0, g: 0, b: 0, a: 0 },
				{ r: 0, g: 255, b: 0, a: 128 },
			]);
			const palette = {
				entries: [
					{
						id: "r",
						color: { r: 255, g: 0, b: 0, a: 255 },
						role: "base" as const,
					},
					{ id: "x", color: { r: 9, g: 9, b: 9, a: 255 } },
				],
			};
			check.deepEqual(
				inspectPalette(input, palette),
				{
					pixelCount: 4,
					colorCount: 3,
					alphaLevels: 3,
					transparentPixels: 1,
					partialAlphaPixels: 1,
					opaquePixels: 2,
					paletteSize: 2,
					unmappedPixels: 2,
					roles: [{ role: "base", count: 1 }],
					dominantColors: [
						{ r: 255, g: 0, b: 0, a: 255, count: 2 },
						{ r: 0, g: 0, b: 0, a: 0, count: 1 },
						{ r: 0, g: 255, b: 0, a: 128, count: 1 },
					],
				},
				"report golden",
			);
			// No timestamps or runtime-varying keys: rerun is deep-equal.
			check.deepEqual(
				inspectPalette(input, palette),
				inspectPalette(input, palette),
				"rerun stable",
			);
		},
	},
	{
		name: "inspect without a palette reports full unmapped",
		run: (check) => {
			const input = px([
				{ r: 1, g: 2, b: 3, a: 255 },
				{ r: 1, g: 2, b: 3, a: 255 },
			]);
			const report = inspectPalette(input);
			check.equal(report.paletteSize, 0, "no palette entries");
			check.deepEqual(report.roles, [], "no roles");
			check.equal(report.unmappedPixels, 2, "everything unmapped");
			check.equal(report.colorCount, 1, "one distinct color");
			check.equal(report.opaquePixels, 2, "both opaque");
		},
	},
	{
		name: "hidden RGB under A=0 stays distinct data",
		run: (check) => {
			const input = px([
				{ r: 255, g: 0, b: 0, a: 0 },
				{ r: 0, g: 0, b: 0, a: 0 },
			]);
			const palette = extractPalette(input);
			check.equal(palette.entries.length, 2, "hidden colors not merged");
			check.deepEqual(
				palette.entries[0]?.color,
				{ r: 255, g: 0, b: 0, a: 0 },
				"hidden red kept",
			);
			const report = inspectPalette(input, {
				entries: [{ id: "only", color: { r: 255, g: 0, b: 0, a: 0 } }],
			});
			check.equal(report.transparentPixels, 2, "both transparent");
			check.equal(report.unmappedPixels, 1, "one exact miss");
		},
	},
	{
		name: "empty palette and malformed buffers are rejected",
		run: (check) => {
			const input = px([{ r: 1, g: 2, b: 3, a: 255 }]);
			throwsCode(
				check,
				() => mapPixelsToPalette(input, { entries: [] }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => applyPalette(input, { entries: [] }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => extractPalette(new Uint8Array(3)),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => mapPixelsToPalette(new Uint8Array(6), { entries: [] }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => inspectPalette(new Uint8Array(1)),
				"INVALID_ARGUMENT",
			);
		},
	},
];
