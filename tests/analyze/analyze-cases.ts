import {
	analyzeCanvas,
	MAX_DOMINANT_COLORS,
} from "../../src/analyze/metrics.ts";
import {
	addLayer,
	createCanvas,
	getPixel,
	setPixel,
} from "../../src/core/canvas.ts";
import type { PixelCanvas } from "../../src/core/types.ts";

export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface AnalyzeCase {
	name: string;
	run(check: CaseCheck): void;
}

function makeCanvas(
	width: number,
	height: number,
	colors: Array<{ r: number; g: number; b: number; a: number }>,
): PixelCanvas {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	for (let i = 0; i < width * height; i += 1) {
		const c = colors[i] as { r: number; g: number; b: number; a: number };
		setPixel(canvas, layer.id, i % width, Math.floor(i / width), c);
	}
	return canvas;
}

function snapshot(canvas: PixelCanvas): number[] {
	const layer = canvas.layers[0] as { id: string };
	const out: number[] = [];
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			const p = getPixel(canvas, layer.id, x, y);
			out.push(p.r, p.g, p.b, p.a);
		}
	}
	return out;
}

const FIXED4 = /^\d+\.\d{4}$/;

export const ANALYZE_CASES: AnalyzeCase[] = [
	{
		name: "metrics: known 2x2 canvas reports exact dimensions and counts",
		run: (check) => {
			const canvas = makeCanvas(2, 2, [
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 0, g: 255, b: 0, a: 0 },
				{ r: 0, g: 0, b: 255, a: 128 },
			]);
			const report = analyzeCanvas(canvas, {});
			check.deepEqual(report.dimensions, { width: 2, height: 2 }, "dimensions");
			check.equal(report.totalPixels, 4, "totalPixels");
			check.equal(report.colorCount, 3, "distinct RGBA colors");
			check.equal(
				report.alpha.predictedClassification,
				"translucent",
				"partial alpha wins",
			);
			check.equal(report.alpha.opaquePixels, 2, "opaque count");
			check.equal(report.alpha.transparentPixels, 1, "transparent count");
			check.equal(report.alpha.partialAlphaPixels, 1, "partial count");
			check.deepEqual(report.alpha.partialAlphaValues, [128], "partial values");
		},
	},
	{
		name: "ratios use fixed 4 decimals and dominant ordering is total",
		run: (check) => {
			const canvas = makeCanvas(2, 2, [
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 0, g: 255, b: 0, a: 255 },
				{ r: 0, g: 0, b: 255, a: 255 },
			]);
			const report = analyzeCanvas(canvas, {});
			for (const key of [
				"opaqueRatio",
				"transparentRatio",
				"partialAlphaRatio",
			] as const) {
				const value: unknown = report.alpha[key];
				check.ok(
					typeof value === "string" && FIXED4.test(value),
					`${key} is fixed 4 decimals, got ${String(value)}`,
				);
			}
			check.equal(report.alpha.opaqueRatio, "1.0000", "all opaque ratio");
			check.equal(report.dominantColors.length, 3, "three distinct colors");
			const top = report.dominantColors[0] as {
				count: number;
				ratio: string;
				hex: string;
			};
			check.equal(top.count, 2, "top count first");
			check.equal(top.ratio, "0.5000", "top ratio fixed");
			check.ok(
				typeof top.hex === "string" && top.hex.startsWith("#"),
				"dominant hex present",
			);
			// Tied counts (1 vs 1) fall back to hex order: full order.
			const tied = report.dominantColors.slice(1).map((c) => c.hex);
			const sorted = [...tied].sort();
			check.deepEqual(tied, sorted, "ties break by hex order");
		},
	},
	{
		name: "predicted tone: no effective claim, note present",
		run: (check) => {
			const canvas = makeCanvas(1, 1, [{ r: 1, g: 2, b: 3, a: 255 }]);
			const report = analyzeCanvas(canvas, {});
			const text = JSON.stringify(report).toLowerCase();
			check.ok(!text.includes("effective"), "no effective claim");
			check.ok(text.includes("predicted"), "predicted tone");
			check.ok(
				"predictedClassification" in report.alpha,
				"predictedClassification present",
			);
			check.ok(
				typeof report.alpha.predictedNote === "string" &&
					report.alpha.predictedNote.length > 0,
				"predictedNote present",
			);
		},
	},
	{
		name: "read-only: analyze never mutates canvas bytes",
		run: (check) => {
			const canvas = makeCanvas(2, 2, [
				{ r: 10, g: 20, b: 30, a: 0 },
				{ r: 40, g: 50, b: 60, a: 128 },
				{ r: 70, g: 80, b: 90, a: 255 },
				{ r: 100, g: 110, b: 120, a: 254 },
			]);
			const before = snapshot(canvas);
			analyzeCanvas(canvas, {});
			analyzeCanvas(canvas, { profile: "minecraft:block" });
			check.deepEqual(snapshot(canvas), before, "canvas bytes unchanged");
		},
	},
	{
		name: "source warnings surface gAMA and iCCP notes",
		run: (check) => {
			const canvas = makeCanvas(1, 1, [{ r: 1, g: 2, b: 3, a: 255 }]);
			const report = analyzeCanvas(canvas, {
				sourceWarnings: [
					{
						code: "GAMMA_IGNORED",
						message: "gAMA chunk ignored: pixels are used verbatim.",
					},
					{
						code: "ICCP_IGNORED",
						message: "iCCP chunk ignored: profile not applied.",
					},
				],
			});
			const codes = report.warnings.map((w) => w.code);
			check.ok(codes.includes("GAMMA_IGNORED"), "gAMA surfaced");
			check.ok(codes.includes("ICCP_IGNORED"), "iCCP surfaced");
		},
	},
	{
		name: "edge: fully transparent is cutout, single opaque is solid",
		run: (check) => {
			const clear = makeCanvas(2, 1, [
				{ r: 5, g: 6, b: 7, a: 0 },
				{ r: 8, g: 9, b: 10, a: 0 },
			]);
			check.equal(
				analyzeCanvas(clear, {}).alpha.predictedClassification,
				"cutout",
				"all clear is cutout",
			);
			const solid = makeCanvas(1, 1, [{ r: 1, g: 2, b: 3, a: 255 }]);
			const solidReport = analyzeCanvas(solid, {});
			check.equal(
				solidReport.alpha.predictedClassification,
				"solid",
				"single opaque is solid",
			);
			check.equal(solidReport.colorCount, 1, "single color");
			check.equal(solidReport.dominantColors.length, 1, "single dominant");
		},
	},
	{
		name: "edge: 64+ colors truncate dominant list with counts intact",
		run: (check) => {
			const width = 8;
			const height = 8;
			const colors: Array<{ r: number; g: number; b: number; a: number }> = [];
			for (let i = 0; i < width * height; i += 1) {
				colors.push({ r: i, g: 0, b: 0, a: 255 });
			}
			const canvas = makeCanvas(width, height, colors);
			const report = analyzeCanvas(canvas, {});
			check.equal(report.colorCount, 64, "64 distinct colors");
			check.equal(
				report.dominantColors.length,
				MAX_DOMINANT_COLORS,
				"dominant truncated",
			);
			check.ok(MAX_DOMINANT_COLORS < 64, "truncation limit below 64");
			check.equal(
				report.colorCount - report.dominantColors.length,
				64 - MAX_DOMINANT_COLORS,
				"omitted count derivable",
			);
		},
	},
	{
		name: "extended: paletteCharacteristics mirrors counts and alpha boundaries",
		run: (check) => {
			const canvas = makeCanvas(2, 2, [
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 0, g: 255, b: 0, a: 0 },
				{ r: 0, g: 0, b: 255, a: 128 },
			]);
			const report = analyzeCanvas(canvas, {});
			check.equal(
				report.paletteCharacteristics.colorCount,
				report.colorCount,
				"palette colorCount matches",
			);
			check.equal(
				report.paletteCharacteristics.alphaLevels,
				3,
				"three distinct alpha values",
			);
			check.equal(
				report.paletteCharacteristics.transparentPixels,
				1,
				"A = 0 is fully transparent",
			);
			check.equal(
				report.paletteCharacteristics.partialAlphaPixels,
				1,
				"0 < A < 255 is partial",
			);
			check.deepEqual(
				report.paletteCharacteristics.roles,
				[],
				"raster canvas carries no palette roles",
			);
		},
	},
	{
		name: "extended: alpha edge values split transparent and partial",
		run: (check) => {
			const canvas = makeCanvas(4, 1, [
				{ r: 1, g: 2, b: 3, a: 0 },
				{ r: 1, g: 2, b: 3, a: 1 },
				{ r: 1, g: 2, b: 3, a: 254 },
				{ r: 1, g: 2, b: 3, a: 255 },
			]);
			const report = analyzeCanvas(canvas, {});
			check.equal(
				report.paletteCharacteristics.alphaLevels,
				4,
				"four distinct alpha values",
			);
			check.equal(
				report.paletteCharacteristics.transparentPixels,
				1,
				"only A = 0 is transparent",
			);
			check.equal(
				report.paletteCharacteristics.partialAlphaPixels,
				2,
				"A = 1 and A = 254 are partial",
			);
			check.equal(
				report.pixelArtCharacteristics.semiTransparentPixels,
				2,
				"semiTransparent mirrors partial",
			);
		},
	},
	{
		name: "extended: aspect is gcd-reduced w:h",
		run: (check) => {
			const solid = { r: 9, g: 9, b: 9, a: 255 };
			const square = makeCanvas(
				16,
				16,
				Array.from({ length: 256 }, () => ({ ...solid })),
			);
			check.equal(
				analyzeCanvas(square, {}).pixelArtCharacteristics.aspect,
				"1:1",
				"16x16",
			);
			const wide = makeCanvas(
				64,
				32,
				Array.from({ length: 2048 }, () => ({ ...solid })),
			);
			const wideReport = analyzeCanvas(wide, {});
			check.equal(wideReport.pixelArtCharacteristics.aspect, "2:1", "64x32");
			check.deepEqual(
				wideReport.pixelArtCharacteristics.resolution,
				{ width: 64, height: 32 },
				"resolution echoes dimensions",
			);
			const tall = makeCanvas(
				64,
				48,
				Array.from({ length: 3072 }, () => ({ ...solid })),
			);
			check.equal(
				analyzeCanvas(tall, {}).pixelArtCharacteristics.aspect,
				"4:3",
				"64x48",
			);
		},
	},
	{
		name: "extended: isolatedPixels follows cleanup isolated semantics",
		run: (check) => {
			const clear = { r: 0, g: 0, b: 0, a: 0 };
			const solid = { r: 200, g: 10, b: 10, a: 255 };
			const speck = makeCanvas(3, 3, [
				clear,
				clear,
				clear,
				clear,
				solid,
				clear,
				clear,
				clear,
				clear,
			]);
			check.equal(
				analyzeCanvas(speck, {}).pixelArtCharacteristics.isolatedPixels,
				1,
				"lone opaque pixel is isolated",
			);
			const filled = makeCanvas(2, 2, [solid, solid, solid, solid]);
			check.equal(
				analyzeCanvas(filled, {}).pixelArtCharacteristics.isolatedPixels,
				0,
				"connected fill has no isolated pixels",
			);
			const partial = { r: 200, g: 10, b: 10, a: 128 };
			const partialSpeck = makeCanvas(3, 3, [
				clear,
				clear,
				clear,
				clear,
				partial,
				clear,
				clear,
				clear,
				clear,
			]);
			check.equal(
				analyzeCanvas(partialSpeck, {}).pixelArtCharacteristics.isolatedPixels,
				0,
				"partial-alpha pixels never count as isolated",
			);
		},
	},
	{
		name: "extended: tileFriendly starter rule with wrap equality",
		run: (check) => {
			const solid = { r: 7, g: 7, b: 7, a: 255 };
			const uniform = makeCanvas(2, 2, [solid, solid, solid, solid]);
			check.equal(
				analyzeCanvas(uniform, {}).pixelArtCharacteristics.tileFriendly,
				true,
				"uniform canvas tiles",
			);
			const seam = makeCanvas(2, 2, [
				{ r: 1, g: 1, b: 1, a: 255 },
				{ r: 2, g: 2, b: 2, a: 255 },
				{ r: 1, g: 1, b: 1, a: 255 },
				{ r: 2, g: 2, b: 2, a: 255 },
			]);
			check.equal(
				analyzeCanvas(seam, {}).pixelArtCharacteristics.tileFriendly,
				false,
				"left/right seam breaks tiling",
			);
			const horizontal = makeCanvas(2, 1, [
				{ r: 1, g: 1, b: 1, a: 255 },
				{ r: 1, g: 1, b: 1, a: 255 },
			]);
			check.equal(
				analyzeCanvas(horizontal, {}).pixelArtCharacteristics.tileFriendly,
				true,
				"matching wrap edges tile",
			);
			const strip = makeCanvas(1, 3, [solid, solid, solid]);
			check.equal(
				analyzeCanvas(strip, {}).pixelArtCharacteristics.tileFriendly,
				true,
				"1-wide strip tolerates the degenerate axis",
			);
		},
	},
	{
		name: "extended: recommended starter rules and quantize boundaries",
		run: (check) => {
			const one = { r: 5, g: 6, b: 7, a: 255 };
			const single = makeCanvas(1, 1, [one]);
			const singleReport = analyzeCanvas(single, {});
			check.equal(
				singleReport.recommended.quantize.colors,
				1,
				"1 color needs 1",
			);
			check.deepEqual(
				singleReport.recommended.cleanup.classes,
				[],
				"starter cleanup proposes nothing",
			);
			check.equal(
				singleReport.recommended.resize.mode,
				"nearest",
				"starter resize is nearest",
			);
			const three = makeCanvas(3, 1, [
				{ r: 1, g: 0, b: 0, a: 255 },
				{ r: 0, g: 1, b: 0, a: 255 },
				{ r: 0, g: 0, b: 1, a: 255 },
			]);
			check.equal(
				analyzeCanvas(three, {}).recommended.quantize.colors,
				4,
				"3 colors round up to 4",
			);
			const sixteenColors: Array<{
				r: number;
				g: number;
				b: number;
				a: number;
			}> = [];
			for (let i = 0; i < 16; i += 1) {
				sixteenColors.push({ r: i, g: 0, b: 0, a: 255 });
			}
			const sixteen = makeCanvas(4, 4, sixteenColors);
			check.equal(
				analyzeCanvas(sixteen, {}).recommended.quantize.colors,
				16,
				"16 colors stay at 16",
			);
			const seventeenColors = [...sixteenColors, { r: 16, g: 0, b: 0, a: 255 }];
			const seventeen = makeCanvas(17, 1, seventeenColors);
			check.equal(
				analyzeCanvas(seventeen, {}).recommended.quantize.colors,
				32,
				"17 colors round up to 32",
			);
		},
	},
	{
		name: "extended: quantize clamp at 4096",
		run: (check) => {
			const full: Array<{ r: number; g: number; b: number; a: number }> = [];
			for (let i = 0; i < 4096; i += 1) {
				full.push({ r: i % 256, g: Math.floor(i / 256), b: 0, a: 255 });
			}
			const maxed = makeCanvas(64, 64, full);
			const maxedReport = analyzeCanvas(maxed, {});
			check.equal(maxedReport.colorCount, 4096, "64x64 distinct colors");
			check.equal(
				maxedReport.recommended.quantize.colors,
				4096,
				"4096 stays at 4096",
			);
			const over: Array<{ r: number; g: number; b: number; a: number }> = [];
			for (let i = 0; i < 4225; i += 1) {
				over.push({ r: i % 256, g: Math.floor(i / 256) % 256, b: 1, a: 255 });
			}
			const overflow = makeCanvas(65, 65, over);
			const overflowReport = analyzeCanvas(overflow, {});
			check.ok(
				overflowReport.colorCount > 4096,
				`over 4096 colors, got ${overflowReport.colorCount}`,
			);
			check.equal(
				overflowReport.recommended.quantize.colors,
				4096,
				"overflow clamps to 4096",
			);
			check.equal(
				overflowReport.pixelArtCharacteristics.paletteSize,
				overflowReport.colorCount,
				"paletteSize echoes distinct colors",
			);
		},
	},
	{
		name: "extended: new sections keep predicted tone and rerun stable",
		run: (check) => {
			const canvas = makeCanvas(2, 2, [
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 0, g: 255, b: 0, a: 255 },
				{ r: 0, g: 0, b: 255, a: 0 },
				{ r: 9, g: 9, b: 9, a: 128 },
			]);
			const first = analyzeCanvas(canvas, {});
			const text = JSON.stringify(first).toLowerCase();
			check.ok(!text.includes("effective"), "no effective claim");
			check.ok(text.includes("predicted"), "predicted tone");
			const second = analyzeCanvas(canvas, {});
			check.deepEqual(
				JSON.stringify(second),
				JSON.stringify(first),
				"same input reruns byte-identical",
			);
		},
	},
];
