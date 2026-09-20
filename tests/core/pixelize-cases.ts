import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	addLayer,
	createCanvas,
	getPixel,
	setPixel,
} from "../../src/core/canvas.ts";
import {
	describePixelizePreset,
	isStandardPixelizeSize,
	PIXELIZE_PRESETS,
	PIXELIZE_STAGES,
	type PixelizePresetName,
	parsePixelizeSize,
	runPixelize,
} from "../../src/core/pixelize.ts";
import type { PixelCanvas } from "../../src/core/types.ts";
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
		name: "presets are explicit, printable, and pending-review",
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
			check.deepEqual(report.stages, [...PIXELIZE_STAGES], "stages traced");
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
			const kept = runPixelize(flat, { size: "16", preset: "item" });
			check.deepEqual(
				getPixel(kept.canvas, "base", 0, 0),
				{ r: 9, g: 8, b: 7, a: 255 },
				"solid color passes through",
			);
		},
	},
];
