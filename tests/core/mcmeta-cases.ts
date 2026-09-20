import { McAssetError } from "../../src/core/errors.ts";
import {
	deriveNineSliceRegions,
	extractGuiScaling,
	NINE_SLICE_GUIDE,
	nineSliceGeometryError,
	paintNineSliceGuides,
	parseMcmetaText,
} from "../../src/core/mcmeta.ts";

/** Runner-agnostic assertion surface: bun:test and node:test entries adapt to this. */
export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throwsCode(fn: () => unknown, code: string, message?: string): void;
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

export interface McmetaCase {
	name: string;
	run(check: CaseCheck): void;
}

const NINE_SLICE_DOC = JSON.stringify({
	gui: {
		scaling: {
			type: "nine_slice",
			border: { left: 4, top: 4, right: 4, bottom: 4 },
			stretch_inner: false,
		},
	},
});

export const MCMETA_CASES: McmetaCase[] = [
	{
		name: "nine_slice scaling parses with border and stretch_inner false",
		run: (check) => {
			const scaling = extractGuiScaling(parseMcmetaText(NINE_SLICE_DOC));
			check.equal(scaling.kind, "nine_slice", "kind");
			if (scaling.kind === "nine_slice") {
				check.deepEqual(
					scaling.border,
					{ left: 4, top: 4, right: 4, bottom: 4 },
					"border",
				);
				check.equal(scaling.stretchInner, false, "stretchInner");
			} else {
				check.fail("expected nine_slice scaling");
			}
		},
	},
	{
		name: "top-level scaling is accepted when no gui section exists",
		run: (check) => {
			const doc = parseMcmetaText(
				JSON.stringify({
					scaling: {
						type: "nine_slice",
						border: { left: 1, top: 2, right: 3, bottom: 4 },
					},
				}),
			);
			const scaling = extractGuiScaling(doc);
			check.equal(scaling.kind, "nine_slice", "kind");
			if (scaling.kind === "nine_slice") {
				check.deepEqual(
					scaling.border,
					{ left: 1, top: 2, right: 3, bottom: 4 },
					"border",
				);
				check.equal(scaling.stretchInner, false, "stretchInner defaults false");
			} else {
				check.fail("expected nine_slice scaling");
			}
		},
	},
	{
		name: "missing scaling reports none",
		run: (check) => {
			check.deepEqual(
				extractGuiScaling(parseMcmetaText(JSON.stringify({ gui: {} }))),
				{ kind: "none" },
				"empty gui section",
			);
			check.deepEqual(
				extractGuiScaling(parseMcmetaText(JSON.stringify({}))),
				{ kind: "none" },
				"empty document",
			);
		},
	},
	{
		name: "stretch and tile scaling report their kind",
		run: (check) => {
			for (const type of ["stretch", "tile"]) {
				const scaling = extractGuiScaling(
					parseMcmetaText(JSON.stringify({ gui: { scaling: { type } } })),
				);
				check.equal(scaling.kind, type, `${type} kind`);
			}
		},
	},
	{
		name: "stretch_inner true is parsed and reported, never applied",
		run: (check) => {
			const scaling = extractGuiScaling(
				parseMcmetaText(
					JSON.stringify({
						gui: {
							scaling: {
								type: "nine_slice",
								border: { left: 4, top: 4, right: 4, bottom: 4 },
								stretch_inner: true,
							},
						},
					}),
				),
			);
			check.equal(scaling.kind, "nine_slice", "kind");
			if (scaling.kind === "nine_slice") {
				check.equal(scaling.stretchInner, true, "stretchInner reported true");
			} else {
				check.fail("expected nine_slice scaling");
			}
		},
	},
	{
		name: "malformed mcmeta text is INVALID_MCMETA",
		run: (check) => {
			throwsCode(check, () => parseMcmetaText("{not json"), "INVALID_MCMETA");
			throwsCode(check, () => parseMcmetaText("[1,2]"), "INVALID_MCMETA");
			throwsCode(check, () => parseMcmetaText("42"), "INVALID_MCMETA");
			throwsCode(
				check,
				() =>
					extractGuiScaling(
						parseMcmetaText(
							JSON.stringify({ gui: { scaling: { type: "stretchy" } } }),
						),
					),
				"INVALID_MCMETA",
			);
			throwsCode(
				check,
				() =>
					extractGuiScaling(
						parseMcmetaText(JSON.stringify({ gui: { scaling: {} } })),
					),
				"INVALID_MCMETA",
			);
			throwsCode(
				check,
				() =>
					extractGuiScaling(
						parseMcmetaText(JSON.stringify({ gui: { scaling: 7 } })),
					),
				"INVALID_MCMETA",
			);
		},
	},
	{
		name: "bad border values are INVALID_MCMETA",
		run: (check) => {
			const badBorders: unknown[] = [
				{ left: -1, top: 4, right: 4, bottom: 4 },
				{ left: 1.5, top: 4, right: 4, bottom: 4 },
				{ left: 4, top: 4, right: 4 },
				{ left: "4", top: 4, right: 4, bottom: 4 },
				undefined,
			];
			for (const border of badBorders) {
				throwsCode(
					check,
					() =>
						extractGuiScaling(
							parseMcmetaText(
								JSON.stringify({
									gui: { scaling: { type: "nine_slice", border } },
								}),
							),
						),
					"INVALID_MCMETA",
				);
			}
			throwsCode(
				check,
				() =>
					extractGuiScaling(
						parseMcmetaText(
							JSON.stringify({
								gui: {
									scaling: {
										type: "nine_slice",
										border: { left: 4, top: 4, right: 4, bottom: 4 },
										stretch_inner: "yes",
									},
								},
							}),
						),
					),
				"INVALID_MCMETA",
			);
		},
	},
	{
		name: "16x16 border 4 derives the nine frozen regions",
		run: (check) => {
			const regions = deriveNineSliceRegions(16, 16, {
				left: 4,
				top: 4,
				right: 4,
				bottom: 4,
			});
			check.deepEqual(
				regions,
				{
					topLeft: { x: 0, y: 0, width: 4, height: 4 },
					top: { x: 4, y: 0, width: 8, height: 4 },
					topRight: { x: 12, y: 0, width: 4, height: 4 },
					left: { x: 0, y: 4, width: 4, height: 8 },
					center: { x: 4, y: 4, width: 8, height: 8 },
					right: { x: 12, y: 4, width: 4, height: 8 },
					bottomLeft: { x: 0, y: 12, width: 4, height: 4 },
					bottom: { x: 4, y: 12, width: 8, height: 4 },
					bottomRight: { x: 12, y: 12, width: 4, height: 4 },
				},
				"frozen nine regions",
			);
		},
	},
	{
		name: "border geometry allows equality but rejects overflow",
		run: (check) => {
			check.equal(
				nineSliceGeometryError(16, 16, {
					left: 4,
					top: 4,
					right: 4,
					bottom: 4,
				}),
				undefined,
				"fitting border is quiet",
			);
			check.equal(
				nineSliceGeometryError(16, 16, {
					left: 8,
					top: 8,
					right: 8,
					bottom: 8,
				}),
				undefined,
				"exact fit is quiet",
			);
			check.ok(
				typeof nineSliceGeometryError(16, 16, {
					left: 9,
					top: 4,
					right: 8,
					bottom: 4,
				}) === "string",
				"horizontal overflow reports",
			);
			check.ok(
				typeof nineSliceGeometryError(16, 16, {
					left: 4,
					top: 9,
					right: 4,
					bottom: 8,
				}) === "string",
				"vertical overflow reports",
			);
		},
	},
	{
		name: "guide paint marks four 1px lines and leaves other pixels alone",
		run: (check) => {
			check.deepEqual(
				{ ...NINE_SLICE_GUIDE },
				{ r: 255, g: 0, b: 255, a: 255 },
				"frozen guide color",
			);
			const width = 8;
			const height = 8;
			const pixels = new Uint8Array(width * height * 4).fill(7);
			paintNineSliceGuides(pixels, width, height, {
				left: 2,
				top: 2,
				right: 2,
				bottom: 2,
			});
			const at = (x: number, y: number): number[] => [
				...pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4),
			];
			const guide = [255, 0, 255, 255];
			check.deepEqual(at(2, 0), guide, "vertical line x=left");
			check.deepEqual(at(6, 7), guide, "vertical line x=width-right");
			check.deepEqual(at(0, 2), guide, "horizontal line y=top");
			check.deepEqual(at(7, 6), guide, "horizontal line y=height-bottom");
			check.deepEqual(at(2, 2), guide, "line crossing");
			check.deepEqual(at(0, 0), [7, 7, 7, 7], "corner untouched");
			check.deepEqual(at(3, 3), [7, 7, 7, 7], "center untouched");
			// Deterministic: repainting the same inputs yields the same bytes.
			const again = new Uint8Array(width * height * 4).fill(7);
			paintNineSliceGuides(again, width, height, {
				left: 2,
				top: 2,
				right: 2,
				bottom: 2,
			});
			check.deepEqual([...again], [...pixels], "repaint is identical");
		},
	},
	{
		name: "edge: zero border keeps lines on the outer rim",
		run: (check) => {
			const width = 4;
			const height = 4;
			const pixels = new Uint8Array(width * height * 4);
			paintNineSliceGuides(pixels, width, height, {
				left: 0,
				top: 0,
				right: 0,
				bottom: 0,
			});
			const at = (x: number, y: number): number[] => [
				...pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4),
			];
			const guide = [255, 0, 255, 255];
			check.deepEqual(at(0, 0), guide, "rim pixel guided");
			check.deepEqual(at(1, 1), [0, 0, 0, 0], "inner pixel untouched");
			const regions = deriveNineSliceRegions(4, 4, {
				left: 0,
				top: 0,
				right: 0,
				bottom: 0,
			});
			check.deepEqual(
				regions.center,
				{ x: 0, y: 0, width: 4, height: 4 },
				"center covers the sprite",
			);
		},
	},
];
