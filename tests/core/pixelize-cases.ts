import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	addLayer,
	addRegion,
	createCanvas,
	getPixel,
	getRegionValue,
	setPixel,
	setRegionValue,
} from "../../src/core/canvas.ts";
import {
	describePixelizePreset,
	isStandardPixelizeSize,
	PIXELIZE_PRESETS,
	PIXELIZE_STAGES,
	type PixelizePresetName,
	type PixelizeReport,
	parsePixelizeSize,
	runPixelize,
} from "../../src/core/pixelize.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import { decodePng } from "../../src/io/png.ts";

/** Runner-agnostic assertion surface: bun:test and node:test adapt to this. */
export interface PixelizeCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throwsCode(fn: () => unknown, code: string, message?: string): void;
}

export interface PixelizeCase {
	name: string;
	run(check: PixelizeCheck): void;
}

const FIXTURES = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"cli",
	"fixtures",
);

function fixtureCanvas(): PixelCanvas {
	const bytes = new Uint8Array(readFileSync(join(FIXTURES, "px-8x8.png")));
	return decodePng(bytes).canvas;
}

function solidCanvas(
	width: number,
	height: number,
	color: { r: number; g: number; b: number; a: number },
): PixelCanvas {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			setPixel(canvas, layer.id, x, y, color);
		}
	}
	return canvas;
}

function fillRect(
	canvas: PixelCanvas,
	layerId: string,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	color: RGBA,
): void {
	for (let y = y0; y <= y1; y += 1) {
		for (let x = x0; x <= x1; x += 1) {
			setPixel(canvas, layerId, x, y, color);
		}
	}
}

function stageStatus(report: PixelizeReport, stage: string): string {
	for (const entry of report.stages) {
		if (entry.stage === stage) {
			return entry.status;
		}
	}
	return "missing";
}

function stageNames(report: PixelizeReport): string[] {
	return report.stages.map((entry) => entry.stage);
}

function alphaBBox(
	canvas: PixelCanvas,
	layerId: string,
): { x: number; y: number; width: number; height: number } | undefined {
	let minX = canvas.width;
	let minY = canvas.height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			if (getPixel(canvas, layerId, x, y).a > 0) {
				if (x < minX) {
					minX = x;
				}
				if (y < minY) {
					minY = y;
				}
				if (x > maxX) {
					maxX = x;
				}
				if (y > maxY) {
					maxY = y;
				}
			}
		}
	}
	if (maxX < 0) {
		return undefined;
	}
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBA = { r: 0, g: 200, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
const CLEAR: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export const PIXELIZE_CASES: PixelizeCase[] = [
	{
		name: "pipeline stages are the frozen eleven in order",
		run: (check) => {
			check.deepEqual(
				[...PIXELIZE_STAGES],
				[
					"decode",
					"crop",
					"background",
					"subject",
					"resize",
					"edge",
					"quantize",
					"cluster",
					"cleanup",
					"preset",
					"output",
				],
				"stage order",
			);
			const report = runPixelize(fixtureCanvas(), {
				size: "16",
				preset: "generic",
			});
			check.deepEqual(stageNames(report), [...PIXELIZE_STAGES], "trace order");
		},
	},
	{
		name: "size accepts 16/32/64/128 and WxH custom",
		run: (check) => {
			check.deepEqual(parsePixelizeSize("16"), { width: 16, height: 16 }, "16");
			check.deepEqual(
				parsePixelizeSize("128"),
				{ width: 128, height: 128 },
				"128",
			);
			check.deepEqual(
				parsePixelizeSize("24x12"),
				{ width: 24, height: 12 },
				"custom",
			);
			check.throwsCode(
				() => parsePixelizeSize(""),
				"INVALID_ARGUMENT",
				"empty",
			);
			check.throwsCode(
				() => parsePixelizeSize("abc"),
				"INVALID_ARGUMENT",
				"non-numeric",
			);
			check.throwsCode(
				() => parsePixelizeSize("0"),
				"INVALID_ARGUMENT",
				"zero",
			);
			check.throwsCode(
				() => parsePixelizeSize("16x0"),
				"INVALID_ARGUMENT",
				"zero height",
			);
			check.throwsCode(
				() => parsePixelizeSize("16.5"),
				"INVALID_ARGUMENT",
				"fractional",
			);
			check.throwsCode(
				() => parsePixelizeSize("5000"),
				"INVALID_DIMENSION",
				"oversize",
			);
		},
	},
	{
		name: "only square 16/32/64/128 count as standard resolutions",
		run: (check) => {
			check.equal(isStandardPixelizeSize(16, 16), true, "16 standard");
			check.equal(isStandardPixelizeSize(64, 64), true, "64 standard");
			check.equal(isStandardPixelizeSize(24, 24), false, "24 warns");
			check.equal(isStandardPixelizeSize(16, 32), false, "rect warns");
		},
	},
	{
		name: "presets are explicit, printable, and carry the frozen stage matrix",
		run: (check) => {
			for (const name of [
				"item",
				"block",
				"generic",
				"gui",
				"particle",
			] as const) {
				const preset = PIXELIZE_PRESETS[name];
				check.ok(
					Number.isInteger(preset.colors) &&
						preset.colors >= 1 &&
						preset.colors <= 4096,
					`${name} colors in range`,
				);
				check.ok(
					typeof preset.description === "string" &&
						preset.description.length > 0,
					`${name} described`,
				);
				const text = describePixelizePreset(name as PixelizePresetName);
				check.ok(text.includes(name), `${name} printable`);
				check.ok(text.includes(String(preset.colors)), "budget printable");
				check.ok(!text.includes("pending"), `${name} has no pending marker`);
				check.ok(!text.includes("starter"), `${name} has no starter marker`);
				check.ok(!text.includes("no-op"), `${name} has no no-op marker`);
			}
			const item = PIXELIZE_PRESETS.item;
			check.equal(item.crop, true, "item enables crop");
			check.equal(item.background, true, "item enables background");
			check.equal(item.subject, true, "item enables subject");
			check.equal(item.edge, 128, "item edge threshold");
			check.equal(item.cluster, 8, "item cluster threshold");
			for (const name of ["block", "generic", "gui", "particle"] as const) {
				const preset = PIXELIZE_PRESETS[name];
				check.equal(preset.crop, false, `${name} disables crop`);
				check.equal(preset.background, false, `${name} disables background`);
				check.equal(preset.subject, false, `${name} disables subject`);
				check.equal(preset.edge, 0, `${name} disables edge`);
				check.equal(preset.cluster, 0, `${name} disables cluster`);
			}
			check.throwsCode(
				() => describePixelizePreset("retro" as PixelizePresetName),
				"INVALID_ARGUMENT",
				"unknown preset",
			);
		},
	},
	{
		name: "resize reaches the requested size with nearest sampling",
		run: (check) => {
			const report = runPixelize(fixtureCanvas(), {
				size: "16",
				preset: "generic",
			});
			check.equal(report.canvas.width, 16, "width");
			check.equal(report.canvas.height, 16, "height");
			check.deepEqual(
				stageNames(report),
				[...PIXELIZE_STAGES],
				"stages traced",
			);
			for (const stage of [
				"crop",
				"background",
				"subject",
				"edge",
				"cluster",
			] as const) {
				check.equal(
					stageStatus(report, stage),
					"disabled",
					`${stage} disabled`,
				);
			}
			check.ok(
				report.colorCount <= PIXELIZE_PRESETS.generic.colors,
				"within budget",
			);
			// Nearest sampling keeps the grid aligned: the solid pass-through
			// case below pins that no new colors appear for flat input.
		},
	},
	{
		name: "custom WxH is honored and flagged non-standard",
		run: (check) => {
			const report = runPixelize(fixtureCanvas(), {
				size: "24x12",
				preset: "generic",
			});
			check.equal(report.canvas.width, 24, "width");
			check.equal(report.canvas.height, 12, "height");
			check.equal(report.nonStandardResolution, true, "flagged");
			const standard = runPixelize(fixtureCanvas(), {
				size: "16",
				preset: "generic",
			});
			check.equal(standard.nonStandardResolution, false, "16 unflagged");
		},
	},
	{
		name: "same input and preset is byte-identical on rerun",
		run: (check) => {
			const first = runPixelize(fixtureCanvas(), {
				size: "16",
				preset: "item",
			});
			const second = runPixelize(fixtureCanvas(), {
				size: "16",
				preset: "item",
			});
			const a = first.canvas.layers[0];
			const b = second.canvas.layers[0];
			if (a === undefined || b === undefined) {
				check.fail("single-layer canvas expected");
				return;
			}
			check.deepEqual(
				Array.from(a.pixels),
				Array.from(b.pixels),
				"rerun bytes",
			);
			check.deepEqual(first.stages, second.stages, "rerun trace");
		},
	},
	{
		name: "quantize budget from the preset caps the color count",
		run: (check) => {
			const report = runPixelize(fixtureCanvas(), {
				size: "16",
				preset: "item",
			});
			check.ok(
				report.colorCount <= PIXELIZE_PRESETS.item.colors,
				"within budget",
			);
			const flat = solidCanvas(4, 4, { r: 9, g: 8, b: 7, a: 255 });
			const kept = runPixelize(flat, { size: "16", preset: "generic" });
			check.deepEqual(
				getPixel(kept.canvas, "base", 0, 0),
				{ r: 9, g: 8, b: 7, a: 255 },
				"solid color passes through",
			);
		},
	},
	{
		name: "crop trims transparent borders across layers and masks together",
		run: (check) => {
			const canvas = createCanvas(8, 8);
			const base = addLayer(canvas, { id: "base" });
			const top = addLayer(canvas, { id: "top" });
			fillRect(canvas, base.id, 2, 2, 5, 5, WHITE);
			// Two off corners keep the cropped ring below the 90 percent
			// backdrop bar, so the base layer survives background removal.
			setPixel(canvas, base.id, 2, 2, RED);
			setPixel(canvas, base.id, 5, 5, RED);
			setPixel(canvas, top.id, 2, 5, { r: 200, g: 100, b: 50, a: 255 });
			const region = addRegion(canvas, { id: "sel" });
			for (let y = 2; y <= 5; y += 1) {
				for (let x = 2; x <= 5; x += 1) {
					setRegionValue(canvas, region.id, x, y, 1);
				}
			}
			const report = runPixelize(canvas, { size: "4", preset: "item" });
			check.equal(report.canvas.width, 4, "cropped width");
			check.equal(report.canvas.height, 4, "cropped height");
			check.equal(stageStatus(report, "crop"), "applied", "crop applied");
			check.deepEqual(
				getPixel(report.canvas, "base", 1, 0),
				WHITE,
				"base content follows the crop",
			);
			check.deepEqual(
				getPixel(report.canvas, "base", 0, 0),
				RED,
				"corner marker follows the crop",
			);
			check.deepEqual(
				getPixel(report.canvas, "top", 0, 3),
				{ r: 200, g: 100, b: 50, a: 255 },
				"second layer follows the same crop",
			);
			check.equal(getRegionValue(report.canvas, "sel", 0, 0), 1, "mask kept");
			check.equal(getRegionValue(report.canvas, "sel", 3, 3), 1, "mask kept");
			check.equal(
				(report.canvas.regions[0] as { mask: Uint8Array }).mask.length,
				16,
				"mask resized with the canvas",
			);
			check.equal(
				stageStatus(report, "background"),
				"not-needed",
				"no ring majority without the corners",
			);
			check.equal(
				stageStatus(report, "subject"),
				"not-needed",
				"cropped content fills the frame",
			);
			check.equal(stageStatus(report, "edge"), "not-needed", "no edge work");
			check.equal(
				stageStatus(report, "cluster"),
				"not-needed",
				"far-apart colors stay separate",
			);
		},
	},
	{
		name: "crop stays not-needed for full-frame and fully transparent input",
		run: (check) => {
			const full = solidCanvas(4, 4, WHITE);
			const fullReport = runPixelize(full, { size: "4", preset: "item" });
			check.equal(stageStatus(fullReport, "crop"), "not-needed", "full frame");
			check.equal(
				stageStatus(fullReport, "background"),
				"applied",
				"uniform frame is all backdrop",
			);
			check.equal(
				stageStatus(fullReport, "subject"),
				"not-needed",
				"nothing left to center",
			);
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					const pixel = getPixel(fullReport.canvas, "base", x, y);
					check.equal(pixel.a, 0, `cleared alpha at ${x},${y}`);
					check.deepEqual(
						{ r: pixel.r, g: pixel.g, b: pixel.b },
						{ r: 255, g: 255, b: 255 },
						`hidden RGB kept at ${x},${y}`,
					);
				}
			}
			const empty = createCanvas(4, 4);
			addLayer(empty, { id: "base" });
			const emptyReport = runPixelize(empty, { size: "4", preset: "item" });
			for (const stage of [
				"crop",
				"background",
				"subject",
				"edge",
				"cluster",
			] as const) {
				check.equal(
					stageStatus(emptyReport, stage),
					"not-needed",
					`empty ${stage}`,
				);
			}
			check.deepEqual(
				getPixel(emptyReport.canvas, "base", 1, 1),
				CLEAR,
				"empty canvas passes through",
			);
		},
	},
	{
		name: "background removes a solid connected backdrop and keeps hidden RGB",
		run: (check) => {
			const canvas = createCanvas(6, 6);
			const base = addLayer(canvas, { id: "base" });
			fillRect(canvas, base.id, 0, 0, 5, 5, GREEN);
			fillRect(canvas, base.id, 2, 2, 3, 3, RED);
			const report = runPixelize(canvas, { size: "6", preset: "item" });
			check.equal(stageStatus(report, "crop"), "not-needed", "frame is full");
			check.equal(
				stageStatus(report, "background"),
				"applied",
				"backdrop removed",
			);
			const corner = getPixel(report.canvas, "base", 0, 0);
			check.equal(corner.a, 0, "corner cleared");
			check.deepEqual(
				{ r: corner.r, g: corner.g, b: corner.b },
				{ r: 0, g: 200, b: 0 },
				"cleared RGB kept, not flattened",
			);
			check.deepEqual(
				getPixel(report.canvas, "base", 2, 2),
				RED,
				"subject red survives",
			);
			check.equal(
				stageStatus(report, "subject"),
				"not-needed",
				"subject already centered",
			);
			check.equal(stageStatus(report, "edge"), "not-needed", "no edge work");
			check.equal(
				stageStatus(report, "cluster"),
				"not-needed",
				"red stands alone",
			);
		},
	},
	{
		name: "background needs a 90 percent opaque outer-ring majority",
		run: (check) => {
			function ringCanvas(
				blueCells: Array<{ x: number; y: number }>,
			): PixelCanvas {
				const canvas = createCanvas(6, 6);
				const base = addLayer(canvas, { id: "base" });
				fillRect(canvas, base.id, 0, 0, 5, 5, GREEN);
				fillRect(canvas, base.id, 2, 2, 3, 3, RED);
				for (const cell of blueCells) {
					setPixel(canvas, base.id, cell.x, cell.y, BLUE);
				}
				return canvas;
			}
			const below = runPixelize(
				ringCanvas([
					{ x: 0, y: 0 },
					{ x: 0, y: 5 },
					{ x: 5, y: 0 },
				]),
				{ size: "6", preset: "item" },
			);
			check.equal(
				stageStatus(below, "background"),
				"not-needed",
				"17 of 20 ring cells is below 90 percent",
			);
			check.deepEqual(
				getPixel(below.canvas, "base", 3, 0),
				GREEN,
				"ring green stays opaque below the bar",
			);
			const exact = runPixelize(
				ringCanvas([
					{ x: 0, y: 0 },
					{ x: 5, y: 5 },
				]),
				{ size: "6", preset: "item" },
			);
			check.equal(
				stageStatus(exact, "background"),
				"applied",
				"18 of 20 ring cells meets 90 percent",
			);
			const cleared = getPixel(exact.canvas, "base", 3, 0);
			check.equal(cleared.a, 0, "ring green cleared at the bar");
			check.deepEqual(
				getPixel(exact.canvas, "base", 0, 0),
				BLUE,
				"minority ring color is not backdrop",
			);
			const ghost = createCanvas(6, 6);
			const layer = addLayer(ghost, { id: "base" });
			fillRect(ghost, layer.id, 0, 0, 5, 5, { r: 0, g: 200, b: 0, a: 128 });
			fillRect(ghost, layer.id, 2, 2, 3, 3, RED);
			const ghostReport = runPixelize(ghost, { size: "6", preset: "item" });
			check.equal(
				stageStatus(ghostReport, "background"),
				"not-needed",
				"semi-transparent ring is no backdrop",
			);
			check.equal(
				stageStatus(ghostReport, "edge"),
				"applied",
				"the same pixels still go through edge hardening",
			);
		},
	},
	{
		name: "subject centers content freed by background removal",
		run: (check) => {
			const canvas = createCanvas(8, 8);
			const base = addLayer(canvas, { id: "base" });
			fillRect(canvas, base.id, 0, 0, 7, 7, GREEN);
			fillRect(canvas, base.id, 1, 1, 2, 2, RED);
			const report = runPixelize(canvas, { size: "8", preset: "item" });
			check.equal(
				stageStatus(report, "background"),
				"applied",
				"backdrop cleared first",
			);
			check.equal(stageStatus(report, "subject"), "applied", "subject moved");
			check.deepEqual(
				getPixel(report.canvas, "base", 3, 3),
				RED,
				"red block lands centered",
			);
			check.deepEqual(
				getPixel(report.canvas, "base", 4, 4),
				RED,
				"red block lands centered",
			);
			const vacated = getPixel(report.canvas, "base", 1, 1);
			check.equal(vacated.a, 0, "old corner is transparent now");
		},
	},
	{
		name: "subject stays not-needed when already centered",
		run: (check) => {
			const canvas = createCanvas(8, 8);
			const base = addLayer(canvas, { id: "base" });
			fillRect(canvas, base.id, 0, 0, 7, 7, GREEN);
			fillRect(canvas, base.id, 3, 3, 4, 4, RED);
			const report = runPixelize(canvas, { size: "8", preset: "item" });
			check.equal(
				stageStatus(report, "background"),
				"applied",
				"backdrop cleared first",
			);
			check.equal(
				stageStatus(report, "subject"),
				"not-needed",
				"centered content does not move",
			);
			check.deepEqual(
				getPixel(report.canvas, "base", 3, 3),
				RED,
				"red block unmoved",
			);
		},
	},
	{
		name: "edge hardens semi-transparent alpha at the threshold",
		run: (check) => {
			const canvas = createCanvas(8, 8);
			const base = addLayer(canvas, { id: "base" });
			const rows: Array<{ color: RGBA }> = [
				{ color: { r: 255, g: 0, b: 0, a: 100 } },
				{ color: { r: 0, g: 255, b: 0, a: 127 } },
				{ color: { r: 0, g: 0, b: 255, a: 128 } },
				{ color: { r: 255, g: 255, b: 255, a: 200 } },
			];
			for (let y = 0; y < 4; y += 1) {
				const row = rows[y] as { color: RGBA };
				for (let x = 0; x < 8; x += 1) {
					setPixel(canvas, base.id, x, y, row.color);
				}
			}
			fillRect(canvas, base.id, 0, 4, 7, 7, BLACK);
			const report = runPixelize(canvas, { size: "8", preset: "item" });
			check.equal(stageStatus(report, "crop"), "not-needed", "frame is full");
			check.equal(
				stageStatus(report, "background"),
				"not-needed",
				"mixed ring is no backdrop",
			);
			check.equal(
				stageStatus(report, "subject"),
				"not-needed",
				"frame is full",
			);
			check.equal(stageStatus(report, "edge"), "applied", "edge hardened");
			const row0 = getPixel(report.canvas, "base", 2, 0);
			check.equal(row0.a, 0, "alpha 100 clears below 128");
			check.deepEqual(
				{ r: row0.r, g: row0.g, b: row0.b },
				{ r: 255, g: 0, b: 0 },
				"cleared RGB kept",
			);
			check.equal(
				getPixel(report.canvas, "base", 2, 1).a,
				0,
				"alpha 127 clears below 128",
			);
			const row2 = getPixel(report.canvas, "base", 2, 2);
			check.equal(row2.a, 255, "alpha 128 rounds up at the threshold");
			check.deepEqual(
				{ r: row2.r, g: row2.g, b: row2.b },
				{ r: 0, g: 0, b: 255 },
				"hardened RGB kept",
			);
			check.equal(
				getPixel(report.canvas, "base", 2, 3).a,
				255,
				"alpha 200 hardens to opaque",
			);
			check.deepEqual(
				getPixel(report.canvas, "base", 2, 6),
				BLACK,
				"opaque rows untouched",
			);
			check.equal(
				stageStatus(report, "cluster"),
				"not-needed",
				"far-apart rows stay separate",
			);
		},
	},
	{
		name: "cluster merges near colors with earliest-representative tie-breaks",
		run: (check) => {
			const canvas = createCanvas(8, 8);
			const base = addLayer(canvas, { id: "base" });
			const dark: RGBA = { r: 0, g: 0, b: 0, a: 255 };
			const near: RGBA = { r: 10, g: 0, b: 0, a: 255 };
			const between: RGBA = { r: 5, g: 0, b: 0, a: 255 };
			const far: RGBA = { r: 13, g: 0, b: 0, a: 255 };
			fillRect(canvas, base.id, 0, 0, 7, 3, dark);
			fillRect(canvas, base.id, 0, 4, 7, 5, near);
			fillRect(canvas, base.id, 0, 6, 7, 6, between);
			fillRect(canvas, base.id, 0, 7, 7, 7, far);
			setPixel(canvas, base.id, 0, 6, { r: 2, g: 0, b: 0, a: 0 });
			const report = runPixelize(canvas, { size: "8", preset: "item" });
			check.equal(stageStatus(report, "edge"), "not-needed", "no edge work");
			check.equal(
				stageStatus(report, "cluster"),
				"applied",
				"near colors merged",
			);
			check.deepEqual(
				getPixel(report.canvas, "base", 3, 6),
				dark,
				"equidistant color joins the earlier representative",
			);
			check.deepEqual(
				getPixel(report.canvas, "base", 3, 7),
				near,
				"in-threshold color joins the near representative",
			);
			check.deepEqual(
				getPixel(report.canvas, "base", 0, 6),
				{ r: 2, g: 0, b: 0, a: 0 },
				"transparent pixels keep hidden RGB through cluster",
			);
			for (let y = 0; y < 8; y += 1) {
				for (let x = 0; x < 8; x += 1) {
					if (x === 0 && y === 6) {
						continue;
					}
					check.equal(
						getPixel(report.canvas, "base", x, y).a,
						255,
						`alpha untouched at ${x},${y}`,
					);
				}
			}
		},
	},
	{
		name: "only item enables the five stages, other presets stay disabled",
		run: (check) => {
			function bordered(): PixelCanvas {
				const canvas = createCanvas(8, 8);
				const base = addLayer(canvas, { id: "base" });
				fillRect(canvas, base.id, 2, 2, 5, 5, WHITE);
				return canvas;
			}
			for (const name of ["block", "generic", "gui", "particle"] as const) {
				const report = runPixelize(bordered(), { size: "8", preset: name });
				for (const stage of [
					"crop",
					"background",
					"subject",
					"edge",
					"cluster",
				] as const) {
					check.equal(
						stageStatus(report, stage),
						"disabled",
						`${name} ${stage} disabled`,
					);
				}
				check.deepEqual(
					getPixel(report.canvas, "base", 0, 0),
					CLEAR,
					`${name} keeps the transparent border`,
				);
				check.deepEqual(
					getPixel(report.canvas, "base", 4, 4),
					WHITE,
					`${name} keeps content in place`,
				);
			}
			const item = runPixelize(bordered(), { size: "4", preset: "item" });
			check.equal(stageStatus(item, "crop"), "applied", "item crops");
			check.equal(
				stageStatus(item, "edge"),
				"not-needed",
				"item edge idle without semi-transparent pixels",
			);
			check.equal(
				stageStatus(item, "cluster"),
				"not-needed",
				"item cluster idle for a single color",
			);
		},
	},
	{
		name: "gui keeps position, block keeps seams, particle keeps alpha",
		run: (check) => {
			const gui = createCanvas(16, 16);
			const guiBase = addLayer(gui, { id: "base" });
			fillRect(gui, guiBase.id, 4, 4, 11, 11, WHITE);
			setPixel(gui, guiBase.id, 5, 5, RED);
			const guiReport = runPixelize(gui, { size: "16", preset: "gui" });
			check.equal(stageStatus(guiReport, "crop"), "disabled", "gui no crop");
			check.equal(
				stageStatus(guiReport, "subject"),
				"disabled",
				"gui no shift",
			);
			check.equal(guiReport.canvas.width, 16, "gui width kept");
			check.equal(guiReport.canvas.height, 16, "gui height kept");
			check.deepEqual(
				alphaBBox(guiReport.canvas, "base"),
				{ x: 4, y: 4, width: 8, height: 8 },
				"gui content box unmoved",
			);
			check.deepEqual(
				getPixel(guiReport.canvas, "base", 5, 5),
				RED,
				"gui detail pixel unmoved",
			);
			const block = createCanvas(8, 8);
			const blockBase = addLayer(block, { id: "base" });
			fillRect(block, blockBase.id, 0, 0, 3, 7, RED);
			fillRect(block, blockBase.id, 4, 0, 7, 7, BLUE);
			const before = Array.from(
				(block.layers[0] as { pixels: Uint8Array }).pixels,
			);
			const blockReport = runPixelize(block, { size: "8", preset: "block" });
			check.deepEqual(
				Array.from(
					(blockReport.canvas.layers[0] as { pixels: Uint8Array }).pixels,
				),
				before,
				"block seam pixels bit-identical",
			);
			const particle = createCanvas(8, 8);
			const particleBase = addLayer(particle, { id: "base" });
			for (let y = 0; y < 8; y += 1) {
				for (let x = 0; x < 8; x += 1) {
					setPixel(particle, particleBase.id, x, y, {
						r: 255,
						g: 0,
						b: 0,
						a: (x + y) % 2 === 0 ? 100 : 200,
					});
				}
			}
			const particleReport = runPixelize(particle, {
				size: "8",
				preset: "particle",
			});
			check.equal(
				stageStatus(particleReport, "edge"),
				"disabled",
				"particle keeps semi-transparent alpha",
			);
			check.equal(
				getPixel(particleReport.canvas, "base", 0, 0).a,
				100,
				"particle alpha 100 kept",
			);
			check.equal(
				getPixel(particleReport.canvas, "base", 1, 0).a,
				200,
				"particle alpha 200 kept",
			);
			check.deepEqual(
				{
					r: getPixel(particleReport.canvas, "base", 1, 0).r,
					g: getPixel(particleReport.canvas, "base", 1, 0).g,
					b: getPixel(particleReport.canvas, "base", 1, 0).b,
				},
				{ r: 255, g: 0, b: 0 },
				"particle RGB kept",
			);
		},
	},
	{
		name: "item keeps thin lines, holes, and separated blocks",
		run: (check) => {
			const canvas = createCanvas(16, 16);
			const base = addLayer(canvas, { id: "base" });
			fillRect(canvas, base.id, 5, 2, 5, 13, RED);
			fillRect(canvas, base.id, 9, 9, 13, 13, BLUE);
			setPixel(canvas, base.id, 11, 11, CLEAR);
			fillRect(canvas, base.id, 2, 2, 3, 3, GREEN);
			const report = runPixelize(canvas, { size: "16", preset: "item" });
			check.equal(stageStatus(report, "crop"), "applied", "item crops");
			check.equal(
				stageStatus(report, "background"),
				"not-needed",
				"transparent ring is no backdrop",
			);
			let reds = 0;
			let blues = 0;
			let greens = 0;
			let clears = 0;
			for (let y = 0; y < 16; y += 1) {
				for (let x = 0; x < 16; x += 1) {
					const pixel = getPixel(report.canvas, "base", x, y);
					if (pixel.a === 0) {
						clears += 1;
					} else if (pixel.r === 255 && pixel.g === 0 && pixel.b === 0) {
						reds += 1;
					} else if (pixel.r === 0 && pixel.g === 0 && pixel.b === 255) {
						blues += 1;
					} else if (pixel.r === 0 && pixel.g === 200 && pixel.b === 0) {
						greens += 1;
					}
				}
			}
			check.ok(reds > 0, `thin red line survives (${reds} pixels)`);
			check.ok(blues > 0, `separated blue block survives (${blues} pixels)`);
			check.ok(greens > 0, `separated green block survives (${greens} pixels)`);
			check.ok(clears > 0, `hole and interior survive (${clears} pixels)`);
		},
	},
];
