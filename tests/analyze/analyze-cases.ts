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
];
