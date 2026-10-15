import assert from "node:assert/strict";
import { McAssetError } from "../../src/core/errors.ts";
import {
	checkAnimationFrameIndices,
	deriveAnimationGeometry,
	deriveNineSliceRegions,
	extractAnimationSection,
	extractGuiScaling,
	nineSliceGeometryError,
	parseMcmetaText,
} from "../../src/core/mcmeta.ts";
import {
	type GenerateAnimationInput,
	type GenerateGuiInput,
	generateAnimationMcmeta,
	generateGuiMcmeta,
	parseBorderOption,
	parseFramesOption,
	parsePositiveIntOption,
} from "../../src/core/mcmeta-generate.ts";

function rejectsWith(code: string, run: () => unknown): void {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof McAssetError, "expected McAssetError");
		assert.equal(error.code, code);
		return true;
	});
}

const SHEET = { sheetWidth: 16, sheetHeight: 64, frameSize: "16" };
const PANEL = { sheetWidth: 16, sheetHeight: 16 };

function animation(overrides: Partial<GenerateAnimationInput> = {}) {
	return generateAnimationMcmeta({ ...SHEET, ...overrides });
}

function gui(type: string, overrides: Partial<GenerateGuiInput> = {}) {
	return generateGuiMcmeta({ ...PANEL, type, ...overrides });
}

export const MCMETA_GENERATE_CORE_CASES: {
	name: string;
	run(): void;
}[] = [
	{
		name: "animation: vertical sheet defaults to every frame, frametime 1",
		run() {
			assert.equal(
				animation().text,
				'{"animation":{"width":16,"height":16,"frametime":1,"frames":[0,1,2,3]}}\n',
			);
		},
	},
	{
		name: "animation: horizontal strip gives the same frame list",
		run() {
			assert.equal(
				animation({ sheetWidth: 64, sheetHeight: 16 }).text,
				'{"animation":{"width":16,"height":16,"frametime":1,"frames":[0,1,2,3]}}\n',
			);
		},
	},
	{
		name: "animation: WxH frame size keeps width and height apart",
		run() {
			assert.equal(
				animation({ sheetWidth: 16, sheetHeight: 96, frameSize: "16x32" }).text,
				'{"animation":{"width":16,"height":32,"frametime":1,"frames":[0,1,2]}}\n',
			);
		},
	},
	{
		name: "animation: a single-frame sheet lists frame 0",
		run() {
			assert.equal(
				animation({ sheetWidth: 16, sheetHeight: 16 }).text,
				'{"animation":{"width":16,"height":16,"frametime":1,"frames":[0]}}\n',
			);
		},
	},
	{
		name: "animation: frametime and interpolate keep their fixed key order",
		run() {
			assert.equal(
				animation({ frametime: 4, interpolate: true }).text,
				'{"animation":{"width":16,"height":16,"frametime":4,"interpolate":true,"frames":[0,1,2,3]}}\n',
			);
		},
	},
	{
		name: "animation: interpolate false is left out",
		run() {
			assert.equal(
				animation({ interpolate: false }).text,
				'{"animation":{"width":16,"height":16,"frametime":1,"frames":[0,1,2,3]}}\n',
			);
		},
	},
	{
		name: "animation: repeated, partial, and per-frame time entries are kept verbatim",
		run() {
			assert.equal(
				animation({ frames: [3, { index: 0, time: 5 }, 3] }).text,
				'{"animation":{"width":16,"height":16,"frametime":1,"frames":[3,{"index":0,"time":5},3]}}\n',
			);
		},
	},
	{
		name: "animation: a frame object without time stays index-only",
		run() {
			assert.equal(
				animation({ frames: [{ index: 2 }] }).text,
				'{"animation":{"width":16,"height":16,"frametime":1,"frames":[{"index":2}]}}\n',
			);
		},
	},
	{
		name: "animation: a sheet that does not divide into frames is INVALID_ANIMATION_FRAME",
		run() {
			rejectsWith("INVALID_ANIMATION_FRAME", () =>
				animation({ sheetWidth: 16, sheetHeight: 50 }),
			);
		},
	},
	{
		name: "animation: a sheet that is neither a column nor a row of frames is rejected",
		run() {
			rejectsWith("INVALID_ANIMATION_FRAME", () =>
				animation({ sheetWidth: 32, sheetHeight: 32 }),
			);
		},
	},
	{
		name: "animation: frame indices outside [0, frameCount) are rejected",
		run() {
			rejectsWith("INVALID_ANIMATION_FRAME", () => animation({ frames: [4] }));
			rejectsWith("INVALID_ANIMATION_FRAME", () => animation({ frames: [-1] }));
			rejectsWith("INVALID_ANIMATION_FRAME", () =>
				animation({ frames: [1.5] }),
			);
			rejectsWith("INVALID_ANIMATION_FRAME", () =>
				animation({ frames: [0, { index: 9, time: 2 }] }),
			);
		},
	},
	{
		name: "animation: zero, negative, and fractional times are INVALID_ARGUMENT",
		run() {
			for (const frametime of [0, -1, 1.5]) {
				rejectsWith("INVALID_ARGUMENT", () => animation({ frametime }));
			}
			for (const time of [0, -3, 2.5]) {
				rejectsWith("INVALID_ARGUMENT", () =>
					animation({ frames: [{ index: 0, time }] }),
				);
			}
		},
	},
	{
		name: "animation: an empty frame list and a bad frame size are INVALID_ARGUMENT",
		run() {
			rejectsWith("INVALID_ARGUMENT", () => animation({ frames: [] }));
			rejectsWith("INVALID_ARGUMENT", () => animation({ frameSize: "abc" }));
			rejectsWith("INVALID_ARGUMENT", () => animation({ frameSize: "16x" }));
		},
	},
	{
		name: "animation: output is deterministic and carries only the animation section",
		run() {
			const first = animation({ frametime: 2, frames: [1, 0] });
			const second = animation({ frametime: 2, frames: [1, 0] });
			assert.equal(first.text, second.text);
			assert.deepEqual(Object.keys(JSON.parse(first.text)), ["animation"]);
			assert.ok(first.text.endsWith("}\n"));
			assert.equal(first.text.indexOf("\n"), first.text.length - 1);
		},
	},
	{
		name: "animation: generated text reads back through the existing readers",
		run() {
			const generated = animation({
				frametime: 3,
				interpolate: true,
				frames: [2, { index: 0, time: 6 }, 2],
			});
			const info = extractAnimationSection(parseMcmetaText(generated.text));
			assert.equal(info.present, true);
			assert.equal(info.frametime, 3);
			assert.equal(info.interpolate, true);
			assert.deepEqual(info.frames, [
				{ index: 2 },
				{ index: 0, time: 6 },
				{ index: 2 },
			]);
			const geometry = deriveAnimationGeometry(16, 64, info);
			assert.deepEqual(geometry, {
				frameWidth: 16,
				frameHeight: 16,
				frameCount: 4,
				layout: "vertical",
			});
			checkAnimationFrameIndices(info, geometry.frameCount);
		},
	},
	{
		name: "gui: stretch carries only its type",
		run() {
			assert.equal(
				gui("stretch").text,
				'{"gui":{"scaling":{"type":"stretch"}}}\n',
			);
		},
	},
	{
		name: "gui: tile takes its design size from the PNG",
		run() {
			assert.equal(
				gui("tile", { sheetWidth: 16, sheetHeight: 32 }).text,
				'{"gui":{"scaling":{"type":"tile","width":16,"height":32}}}\n',
			);
		},
	},
	{
		name: "gui: nine_slice with one border number writes four equal sides",
		run() {
			assert.equal(
				gui("nine_slice", { border: 4 }).text,
				'{"gui":{"scaling":{"type":"nine_slice","width":16,"height":16,"border":{"left":4,"top":4,"right":4,"bottom":4}}}}\n',
			);
		},
	},
	{
		name: "gui: per-side border and stretch_inner follow the fixed key order",
		run() {
			const generated = gui("nine_slice", {
				sheetWidth: 20,
				sheetHeight: 12,
				border: { left: 1, top: 2, right: 3, bottom: 4 },
				stretchInner: true,
			});
			assert.equal(
				generated.text,
				'{"gui":{"scaling":{"type":"nine_slice","width":20,"height":12,"border":{"left":1,"top":2,"right":3,"bottom":4},"stretch_inner":true}}}\n',
			);
		},
	},
	{
		name: "gui: stretchInner false is left out",
		run() {
			assert.equal(
				gui("nine_slice", { border: 2, stretchInner: false }).text,
				'{"gui":{"scaling":{"type":"nine_slice","width":16,"height":16,"border":{"left":2,"top":2,"right":2,"bottom":2}}}}\n',
			);
		},
	},
	{
		name: "gui: a border that leaves a positive center reads back as the same regions",
		run() {
			const generated = gui("nine_slice", { border: 7 });
			const scaling = extractGuiScaling(parseMcmetaText(generated.text));
			assert.deepEqual(scaling, {
				kind: "nine_slice",
				width: 16,
				height: 16,
				border: { left: 7, top: 7, right: 7, bottom: 7 },
				stretchInner: false,
			});
			assert.equal(
				nineSliceGeometryError(16, 16, {
					left: 7,
					top: 7,
					right: 7,
					bottom: 7,
				}),
				undefined,
			);
			assert.deepEqual(
				deriveNineSliceRegions(16, 16, { left: 7, top: 7, right: 7, bottom: 7 })
					.center,
				{ x: 7, y: 7, width: 2, height: 2 },
			);
		},
	},
	{
		name: "gui: a border that exactly fills the center or overflows is INVALID_MCMETA",
		run() {
			rejectsWith("INVALID_MCMETA", () => gui("nine_slice", { border: 8 }));
			rejectsWith("INVALID_MCMETA", () => gui("nine_slice", { border: 9 }));
			rejectsWith("INVALID_MCMETA", () =>
				gui("nine_slice", {
					border: { left: 1, top: 8, right: 1, bottom: 8 },
				}),
			);
		},
	},
	{
		name: "gui: nine_slice needs a border and the border must be well formed",
		run() {
			rejectsWith("INVALID_ARGUMENT", () => gui("nine_slice"));
			rejectsWith("INVALID_ARGUMENT", () => gui("nine_slice", { border: -1 }));
			rejectsWith("INVALID_ARGUMENT", () => gui("nine_slice", { border: 1.5 }));
			rejectsWith("INVALID_ARGUMENT", () =>
				gui("nine_slice", {
					border: { left: 1, top: 1, right: 1 } as unknown as number,
				}),
			);
		},
	},
	{
		name: "gui: border and stretchInner are refused outside nine_slice",
		run() {
			rejectsWith("INVALID_ARGUMENT", () => gui("stretch", { border: 2 }));
			rejectsWith("INVALID_ARGUMENT", () => gui("tile", { border: 2 }));
			rejectsWith("INVALID_ARGUMENT", () =>
				gui("tile", { stretchInner: true }),
			);
			rejectsWith("INVALID_ARGUMENT", () =>
				gui("stretch", { stretchInner: false }),
			);
		},
	},
	{
		name: "gui: an unknown or empty type is INVALID_ARGUMENT",
		run() {
			rejectsWith("INVALID_ARGUMENT", () => gui("repeat"));
			rejectsWith("INVALID_ARGUMENT", () => gui(""));
		},
	},
	{
		name: "options: --frames parses indices and objects, anything else is INVALID_ARGUMENT",
		run() {
			assert.deepEqual(parseFramesOption('[0, 1, {"index": 2, "time": 3}]'), [
				0,
				1,
				{ index: 2, time: 3 },
			]);
			for (const raw of [
				"",
				"[",
				"{}",
				"3",
				'["a"]',
				"[null]",
				'[{"time":2}]',
			]) {
				rejectsWith("INVALID_ARGUMENT", () => parseFramesOption(raw));
			}
		},
	},
	{
		name: "options: --border takes digits or a four-side JSON object",
		run() {
			assert.equal(parseBorderOption("4"), 4);
			assert.equal(parseBorderOption("0"), 0);
			assert.deepEqual(
				parseBorderOption('{"left":1,"top":2,"right":3,"bottom":4}'),
				{ left: 1, top: 2, right: 3, bottom: 4 },
			);
			for (const raw of ["", "abc", "-1", "1.5", "{", '{"left":1}', "[1,2]"]) {
				rejectsWith("INVALID_ARGUMENT", () => parseBorderOption(raw));
			}
		},
	},
	{
		name: "options: --frametime must be a positive integer string",
		run() {
			assert.equal(parsePositiveIntOption("3", "--frametime"), 3);
			for (const raw of ["", "0", "-2", "1.5", "abc", "2x"]) {
				rejectsWith("INVALID_ARGUMENT", () =>
					parsePositiveIntOption(raw, "--frametime"),
				);
			}
		},
	},
];
