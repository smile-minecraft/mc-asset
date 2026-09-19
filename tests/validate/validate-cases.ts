import type { AnalyzeReport } from "../../src/analyze/metrics.ts";
import {
	addLayer,
	createCanvas,
	getPixel,
	setPixel,
} from "../../src/core/canvas.ts";
import type { PixelCanvas } from "../../src/core/types.ts";
import { validateCanvas, validateReport } from "../../src/validate/checks.ts";

export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface ValidateCase {
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

function opaque(
	count: number,
	color: { r: number; g: number; b: number } = { r: 255, g: 0, b: 0 },
): Array<{ r: number; g: number; b: number; a: number }> {
	const out: Array<{ r: number; g: number; b: number; a: number }> = [];
	for (let i = 0; i < count; i += 1) {
		out.push({ r: color.r, g: color.g, b: color.b, a: 255 });
	}
	return out;
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

function errorCodes(report: { findings: Array<{ level: string }> }): number {
	return report.findings.filter((f) => f.level === "error").length;
}

export const VALIDATE_CASES: ValidateCase[] = [
	{
		name: "pass: clean opaque png validates with no errors",
		run: (check) => {
			const canvas = makeCanvas(2, 2, opaque(4));
			const report = validateCanvas(canvas, {
				profile: "generic",
				filename: "sword.png",
			});
			check.equal(report.verdict, "pass", "clean asset passes");
			check.equal(errorCodes(report), 0, "no error findings");
			check.deepEqual(
				report.dimensions,
				{ width: 2, height: 2 },
				"dimensions visible",
			);
			check.equal(report.colorCount, 1, "single color counted");
			check.equal(
				report.alpha.predictedClassification,
				"solid",
				"all opaque is solid",
			);
			check.equal(report.profile.id, "generic", "profile id kept");
		},
	},
	{
		name: "fail: minecraft item rejects a non-png filename",
		run: (check) => {
			const canvas = makeCanvas(2, 2, opaque(4));
			const report = validateCanvas(canvas, {
				profile: "minecraft:item",
				filename: "Sword.PNG",
			});
			check.equal(report.verdict, "fail", "uppercase extension fails");
			const errors = report.findings.filter((f) => f.level === "error");
			check.equal(errors.length, 1, "exactly one error");
			check.equal(
				(errors[0] as { code: string }).code,
				"FILENAME_EXTENSION_NOT_PNG",
				"filename error code",
			);
		},
	},
	{
		name: "fail: minecraft block rejects a webp filename",
		run: (check) => {
			const canvas = makeCanvas(1, 1, opaque(1));
			const report = validateCanvas(canvas, {
				profile: "minecraft:block",
				filename: "tile.webp",
			});
			check.equal(report.verdict, "fail", "webp name fails for block");
			check.equal(errorCodes(report), 1, "one error");
		},
	},
	{
		name: "generic ignores the filename extension",
		run: (check) => {
			const canvas = makeCanvas(2, 2, opaque(4));
			const report = validateCanvas(canvas, {
				profile: "generic",
				filename: "Sword.PNG",
			});
			check.equal(report.verdict, "pass", "generic has no filename rule");
			check.equal(errorCodes(report), 0, "no errors for generic");
		},
	},
	{
		name: "warning: partial alpha never fails validation",
		run: (check) => {
			const canvas = makeCanvas(2, 2, [
				{ r: 255, g: 0, b: 0, a: 255 },
				{ r: 0, g: 255, b: 0, a: 255 },
				{ r: 0, g: 0, b: 255, a: 0 },
				{ r: 255, g: 255, b: 255, a: 128 },
			]);
			const report = validateCanvas(canvas, {
				profile: "minecraft:block",
				filename: "ghost.png",
			});
			check.equal(report.verdict, "pass", "partial alpha still passes");
			const codes = report.findings.map((f) => f.code);
			check.ok(
				codes.includes("PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING"),
				"partial alpha warns",
			);
			const partial = report.findings.find(
				(f) => f.code === "PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING",
			) as { level: string } | undefined;
			check.equal(partial?.level, "warning", "partial alpha is warning-only");
		},
	},
	{
		name: "warning: non-standard block resolution never fails",
		run: (check) => {
			const canvas = makeCanvas(3, 2, opaque(6));
			const report = validateCanvas(canvas, {
				profile: "minecraft:block",
				filename: "odd.png",
			});
			check.equal(report.verdict, "pass", "odd size still passes");
			const codes = report.findings.map((f) => f.code);
			check.ok(codes.includes("NON_STANDARD_RESOLUTION"), "odd size warns");
		},
	},
	{
		name: "warning: large palettes are a hygiene note, not a failure",
		run: (check) => {
			const width = 17;
			const height = 16;
			const colors: Array<{ r: number; g: number; b: number; a: number }> = [];
			for (let i = 0; i < width * height; i += 1) {
				colors.push({ r: i % 256, g: Math.floor(i / 256), b: 0, a: 255 });
			}
			const canvas = makeCanvas(width, height, colors);
			const report = validateCanvas(canvas, {
				profile: "generic",
				filename: "big.png",
			});
			check.ok(report.colorCount > 256, "more than 256 colors");
			check.equal(report.verdict, "pass", "large palette still passes");
			const codes = report.findings.map((f) => f.code);
			check.ok(codes.includes("PALETTE_SIZE_LARGE"), "palette size warns");
		},
	},
	{
		name: "pending-source facts never produce errors",
		run: (check) => {
			const canvas = makeCanvas(1, 1, opaque(1));
			const report = validateCanvas(canvas, {
				profile: "generic",
				filename: "a.png",
			});
			const pending = report.findings.filter((f) =>
				f.code.startsWith("PENDING_SOURCE"),
			);
			check.ok(pending.length > 0, "pending-source warning present");
			for (const finding of pending) {
				check.equal(finding.level, "warning", `${finding.code} warns only`);
			}
			check.equal(report.verdict, "pass", "pending source never fails");
		},
	},
	{
		name: "read-only: validate never mutates canvas bytes",
		run: (check) => {
			const canvas = makeCanvas(2, 2, [
				{ r: 10, g: 20, b: 30, a: 0 },
				{ r: 40, g: 50, b: 60, a: 128 },
				{ r: 70, g: 80, b: 90, a: 255 },
				{ r: 100, g: 110, b: 120, a: 254 },
			]);
			const before = snapshot(canvas);
			validateCanvas(canvas, { profile: "generic", filename: "a.png" });
			validateCanvas(canvas, {
				profile: "minecraft:block",
				filename: "Bad.PNG",
			});
			check.deepEqual(snapshot(canvas), before, "canvas bytes unchanged");
		},
	},
	{
		name: "edge: single opaque pixel passes with warnings-only findings",
		run: (check) => {
			const canvas = makeCanvas(1, 1, opaque(1));
			const report = validateCanvas(canvas, {
				profile: "generic",
				filename: "a.png",
			});
			check.equal(report.verdict, "pass", "1x1 passes");
			check.equal(errorCodes(report), 0, "no errors on minimal asset");
			for (const finding of report.findings) {
				check.equal(finding.level, "warning", "every finding warns only");
			}
		},
	},
	{
		name: "validateReport maps an analyze report without touching the canvas",
		run: (check) => {
			const base: AnalyzeReport = {
				dimensions: { width: 2, height: 2 },
				totalPixels: 4,
				colorCount: 1,
				alpha: {
					predictedClassification: "solid",
					opaquePixels: 4,
					transparentPixels: 0,
					partialAlphaPixels: 0,
					partialAlphaValues: [],
					opaqueRatio: "1.0000",
					transparentRatio: "0.0000",
					partialAlphaRatio: "0.0000",
					predictedNote:
						"predicted classification from PNG bytes only; not the final in-game render result.",
				},
				dominantColors: [],
				profile: {
					id: "minecraft:item",
					predictedDescription:
						"predicted profile minecraft:item prefers the items atlas without mipmaps.",
				},
				warnings: [],
			};
			const ok = validateReport(base, { filename: "sword.png" });
			check.equal(ok.verdict, "pass", "matching filename passes");
			const bad = validateReport(base, { filename: "sword.webp" });
			check.equal(bad.verdict, "fail", "webp filename fails for item");
			const noName = validateReport(base, {});
			check.equal(noName.verdict, "pass", "missing filename skips the check");
		},
	},
];
