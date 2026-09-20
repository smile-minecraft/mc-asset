import {
	applyBrightnessMatch,
	applyEdgeMatch,
	applyTileCorrections,
	buildTilePreview,
	formatTileScore,
	parsePreviewSize,
	parseTileAxis,
	repetitionScore,
	seamMetrics,
} from "../../src/core/tile.ts";

/** Runner-agnostic assertion surface: bun:test and node:test adapt to this. */
export interface TileCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throwsCode(fn: () => unknown, code: string, message?: string): void;
}

export interface TileCase {
	name: string;
	run(check: TileCheck): void;
}

const B = { r: 0, g: 0, b: 0, a: 255 };
const W = { r: 255, g: 255, b: 255, a: 255 };

function rgbaBytes(
	pixels: { r: number; g: number; b: number; a: number }[],
): Uint8Array {
	const out = new Uint8Array(pixels.length * 4);
	for (let i = 0; i < pixels.length; i += 1) {
		const p = pixels[i] as { r: number; g: number; b: number; a: number };
		out[i * 4] = p.r;
		out[i * 4 + 1] = p.g;
		out[i * 4 + 2] = p.b;
		out[i * 4 + 3] = p.a;
	}
	return out;
}

/** Frozen worked example: (0,0)=B (1,0)=W / (0,1)=B (1,1)=W. */
function checker2x2(): Uint8Array {
	return rgbaBytes([B, W, B, W]);
}

function solidBytes(
	width: number,
	height: number,
	color: { r: number; g: number; b: number; a: number },
): Uint8Array {
	return rgbaBytes(
		Array.from({ length: width * height }, () => ({ ...color })),
	);
}

function pixelAt(
	pixels: Uint8Array,
	width: number,
	x: number,
	y: number,
): { r: number; g: number; b: number; a: number } {
	const offset = (y * width + x) * 4;
	return {
		r: pixels[offset] as number,
		g: pixels[offset + 1] as number,
		b: pixels[offset + 2] as number,
		a: pixels[offset + 3] as number,
	};
}

export const TILE_CASES: TileCase[] = [
	{
		name: "seam worked example locks raw pairs and score",
		run: (check) => {
			const seam = seamMetrics(checker2x2(), 2, 2);
			check.equal(seam.vertical.raw, 390150, "vertical raw");
			check.equal(seam.vertical.pairs, 2, "vertical pairs");
			check.equal(seam.vertical.score, 0.75, "vertical score");
			check.equal(seam.horizontal.raw, 0, "horizontal raw");
			check.equal(seam.horizontal.pairs, 2, "horizontal pairs");
			check.equal(seam.horizontal.score, 0, "horizontal score");
			check.equal(seam.corner.raw, 390150, "corner raw");
			check.equal(seam.corner.pairs, 2, "corner pairs");
			check.equal(seam.corner.score, 0.75, "corner score");
		},
	},
	{
		name: "scores serialize to fixed six decimals",
		run: (check) => {
			check.equal(formatTileScore(0.75), "0.750000", "vertical score text");
			check.equal(formatTileScore(0), "0.000000", "zero score text");
			check.equal(formatTileScore(1), "1.000000", "perfect score text");
			check.equal(formatTileScore(0.25), "0.250000", "repeat score text");
		},
	},
	{
		name: "degenerate axes compare a pixel with itself",
		run: (check) => {
			const single = seamMetrics(rgbaBytes([{ ...B }]), 1, 1);
			check.equal(single.vertical.raw, 0, "1x1 vertical raw");
			check.equal(single.horizontal.raw, 0, "1x1 horizontal raw");
			check.equal(single.corner.raw, 0, "1x1 corner raw");
			check.equal(single.corner.pairs, 2, "1x1 corner pairs");
			const column = seamMetrics(solidBytes(1, 3, B), 1, 3);
			check.equal(column.vertical.raw, 0, "1-wide vertical raw");
			check.equal(column.vertical.pairs, 3, "1-wide vertical pairs");
			const row = seamMetrics(solidBytes(3, 1, W), 3, 1);
			check.equal(row.horizontal.raw, 0, "1-tall horizontal raw");
			check.equal(row.horizontal.pairs, 3, "1-tall horizontal pairs");
		},
	},
	{
		name: "repetition worked example locks score and periods",
		run: (check) => {
			// Definition-literal reading: the x axis gives 0.25 but the
			// y axis matches perfectly (uniform columns, total 0), so the
			// frozen max rule yields 1.0. The frozen text lists 0.250000
			// here ("y axis is the same"), which contradicts its own
			// definition; the deviation is reported for a spec decision.
			const repeat = repetitionScore(checker2x2(), 2, 2);
			check.equal(repeat.score, 1, "repeat score");
			check.equal(formatTileScore(repeat.score), "1.000000", "repeat text");
			check.equal(repeat.periodX, 1, "periodX");
			check.equal(repeat.periodY, 1, "periodY");
		},
	},
	{
		name: "single row repetition follows the x axis only",
		run: (check) => {
			// 2x1 [B, W]: only the x axis has a candidate, locking the
			// frozen 0.25 arithmetic (total 390150 over 520200).
			const repeat = repetitionScore(rgbaBytes([B, W]), 2, 1);
			check.equal(repeat.score, 0.25, "row repeat score");
			check.equal(formatTileScore(repeat.score), "0.250000", "row text");
			check.equal(repeat.periodX, 1, "row periodX");
			check.equal(repeat.periodY, null, "row periodY is null");
		},
	},
	{
		name: "solid canvas repeats perfectly at shift one",
		run: (check) => {
			const repeat = repetitionScore(solidBytes(3, 2, B), 3, 2);
			check.equal(repeat.score, 1, "solid repeat score");
			check.equal(formatTileScore(repeat.score), "1.000000", "solid text");
			check.equal(repeat.periodX, 1, "solid periodX");
			check.equal(repeat.periodY, 1, "solid periodY");
		},
	},
	{
		name: "single pixel has no repetition candidate",
		run: (check) => {
			const repeat = repetitionScore(rgbaBytes([{ ...B }]), 1, 1);
			check.equal(repeat.score, 0, "1x1 repeat score");
			check.equal(repeat.periodX, null, "1x1 periodX");
			check.equal(repeat.periodY, null, "1x1 periodY");
		},
	},
	{
		name: "repetition tie keeps the smallest shift",
		run: (check) => {
			const repeat = repetitionScore(solidBytes(4, 1, W), 4, 1);
			check.equal(repeat.periodX, 1, "tie takes smallest s");
			check.equal(repeat.periodY, null, "1-tall periodY is null");
			check.equal(repeat.score, 1, "tie score");
		},
	},
	{
		name: "edge-match vertical zeroes the vertical seam",
		run: (check) => {
			const fixed = applyEdgeMatch(checker2x2(), 2, 2, "vertical");
			for (let y = 0; y < 2; y += 1) {
				for (let x = 0; x < 2; x += 1) {
					check.deepEqual(
						pixelAt(fixed, 2, x, y),
						{ r: 127, g: 127, b: 127, a: 255 },
						`averaged pixel (${x},${y})`,
					);
				}
			}
			const seam = seamMetrics(fixed, 2, 2);
			check.equal(seam.vertical.raw, 0, "vertical raw after match");
			check.equal(seam.vertical.score, 0, "vertical score after match");
		},
	},
	{
		name: "edge-match both applies vertical before horizontal",
		run: (check) => {
			const input = checker2x2();
			const both = applyEdgeMatch(input, 2, 2, "both");
			const vertical = applyEdgeMatch(input, 2, 2, "vertical");
			const sequential = applyEdgeMatch(vertical, 2, 2, "horizontal");
			check.deepEqual(
				[...both],
				[...sequential],
				"both equals vertical-then-horizontal",
			);
		},
	},
	{
		name: "brightness-match keeps alpha and clamps channels",
		run: (check) => {
			const input = rgbaBytes([
				{ r: 10, g: 10, b: 10, a: 128 },
				{ r: 250, g: 250, b: 250, a: 200 },
				{ r: 20, g: 20, b: 20, a: 128 },
				{ r: 250, g: 250, b: 250, a: 200 },
			]);
			const fixed = applyBrightnessMatch(input, 2, 2, "vertical");
			check.deepEqual(
				pixelAt(fixed, 2, 0, 0),
				{ r: 245, g: 245, b: 245, a: 128 },
				"dim line lifted, alpha kept",
			);
			check.deepEqual(
				pixelAt(fixed, 2, 0, 1),
				{ r: 255, g: 255, b: 255, a: 128 },
				"lifted channel clamps at 255",
			);
			check.deepEqual(
				pixelAt(fixed, 2, 1, 0),
				{ r: 250, g: 250, b: 250, a: 200 },
				"bright line untouched",
			);
			check.deepEqual(
				pixelAt(fixed, 2, 1, 1),
				{ r: 250, g: 250, b: 250, a: 200 },
				"bright line untouched",
			);
		},
	},
	{
		name: "brightness-match leaves interior pixels alone",
		run: (check) => {
			const input = rgbaBytes([
				{ r: 0, g: 0, b: 0, a: 255 },
				{ r: 9, g: 80, b: 7, a: 255 },
				{ r: 255, g: 255, b: 255, a: 255 },
				{ r: 0, g: 0, b: 0, a: 255 },
				{ r: 9, g: 80, b: 7, a: 255 },
				{ r: 255, g: 255, b: 255, a: 255 },
			]);
			const fixed = applyBrightnessMatch(input, 3, 2, "vertical");
			check.deepEqual(
				pixelAt(fixed, 3, 1, 0),
				{ r: 9, g: 80, b: 7, a: 255 },
				"interior column kept",
			);
			check.deepEqual(
				pixelAt(fixed, 3, 1, 1),
				{ r: 9, g: 80, b: 7, a: 255 },
				"interior column kept",
			);
		},
	},
	{
		name: "corrections record edge before brightness in fixed order",
		run: (check) => {
			const input = checker2x2();
			const { pixels, corrections } = applyTileCorrections(
				input,
				2,
				2,
				"vertical",
				"horizontal",
			);
			check.deepEqual(
				corrections,
				["edge-match:vertical", "brightness-match:horizontal"],
				"corrections order",
			);
			const afterEdge = applyEdgeMatch(input, 2, 2, "vertical");
			const sequential = applyBrightnessMatch(afterEdge, 2, 2, "horizontal");
			check.deepEqual([...pixels], [...sequential], "edge runs first");
			const none = applyTileCorrections(input, 2, 2, undefined, undefined);
			check.deepEqual(none.corrections, [], "no corrections when unset");
			check.deepEqual([...none.pixels], [...input], "pixels kept verbatim");
		},
	},
	{
		name: "preview tiles the input N by N without scaling",
		run: (check) => {
			const preview = buildTilePreview(checker2x2(), 2, 2, 2);
			check.equal(preview.width, 4, "preview width");
			check.equal(preview.height, 4, "preview height");
			check.deepEqual(pixelAt(preview.pixels, 4, 0, 0), B, "tile origin");
			check.deepEqual(pixelAt(preview.pixels, 4, 1, 0), W, "tile step x");
			check.deepEqual(pixelAt(preview.pixels, 4, 2, 0), B, "tile wraps x");
			check.deepEqual(pixelAt(preview.pixels, 4, 0, 2), B, "tile wraps y");
			check.deepEqual(pixelAt(preview.pixels, 4, 3, 3), W, "far corner");
		},
	},
	{
		name: "parse helpers reject out-of-frozen values",
		run: (check) => {
			check.equal(parsePreviewSize("4x4"), 4, "preview 4x4");
			check.equal(parseTileAxis("both", "--edge-match"), "both", "axis both");
			check.throwsCode(
				() => parsePreviewSize("3x3"),
				"INVALID_ARGUMENT",
				"preview 3x3 rejected",
			);
			check.throwsCode(
				() => parseTileAxis("diagonal", "--edge-match"),
				"INVALID_ARGUMENT",
				"bad axis rejected",
			);
		},
	},
];
