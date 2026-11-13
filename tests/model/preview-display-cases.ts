import { Buffer } from "node:buffer";
import { join } from "node:path";
import { runModel, runModelRequest } from "../../src/cli/cmd-model.ts";
import { McAssetError } from "../../src/core/errors.ts";
import { handleModelAsset } from "../../src/mcp/handlers-model-optimize.ts";
import type { FixedVec3 } from "../../src/model/geometry/index.ts";
import { inspectModel } from "../../src/model/inspect.ts";
import {
	builtinDisplaySource,
	builtinGuiLight,
	displayMirrorsFaces,
	displayTransformFor,
	FACE_SHADE,
	PREVIEW_DISPLAY_SLOTS,
	parseTintColor,
	shadeForNormal,
} from "../../src/model/preview/display.ts";
import {
	ITEM_LAYER_Z_STEP,
	itemLayerElements,
} from "../../src/model/preview/item-layers.ts";
import { renderModelPreview } from "../../src/model/preview/render.ts";
import { buildParentModel } from "../../src/pack/item-templates.ts";
import { captureStreams } from "../cli/optimize-model-cases.ts";
import type { CaseCheck, ModelCase } from "./json-document-cases.ts";
import {
	assertRgba,
	bandPng,
	coloredCubeContext,
	coloredCubeModel,
	cubeModel,
	flatOf,
	fullCubeFaces,
	makePack,
	memoryContext,
	PREVIEW_PATH,
	panelBox,
	panelColors,
	STONE_REL,
	sha256,
	solidPng,
	splitPng,
	twoToneBandPng,
	withTempRoot,
} from "./preview-cases.ts";

const encoder = new TextEncoder();

const DISPLAY_SLOTS = PREVIEW_DISPLAY_SLOTS;

/**
 * One distinct scale per slot, so each slot's fixed hash also proves the
 * slot-specific transform was read. Translation stays zero here and gets its
 * own case; rotation is the value the acceptance criterion changes.
 */
const SLOT_POSE: Readonly<
	Record<
		(typeof DISPLAY_SLOTS)[number],
		{
			readonly translation: readonly [number, number, number];
			readonly scale: readonly [number, number, number];
		}
	>
> = {
	gui: { translation: [0, 0, 0], scale: [1, 1, 1] },
	firstperson_righthand: { translation: [0, 0, 0], scale: [0.6, 0.6, 0.6] },
	thirdperson_righthand: { translation: [0, 0, 0], scale: [0.7, 0.7, 0.7] },
	head: { translation: [0, 0, 0], scale: [0.8, 0.8, 0.8] },
	ground: { translation: [0, 0, 0], scale: [0.3, 0.3, 0.3] },
	fixed: { translation: [0, 0, 0], scale: [0.9, 0.9, 0.9] },
};

function displayFor(
	rotation: readonly [number, number, number],
): Record<string, unknown> {
	const display: Record<string, unknown> = {};
	for (const slot of DISPLAY_SLOTS) {
		display[slot] = { rotation, ...SLOT_POSE[slot] };
	}
	return display;
}

function withDisplay(
	text: string,
	display: Record<string, unknown>,
	guiLight?: "front" | "side",
): string {
	return JSON.stringify({
		...JSON.parse(text),
		display,
		...(guiLight === undefined ? {} : { gui_light: guiLight }),
	});
}

/** The fixed hashes for the two rotation variants, one per slot. */
const ROTATED_HASHES: Record<(typeof DISPLAY_SLOTS)[number], string> = {
	gui: "f211afab8832045e08772c044295511bb63ad1453b55842b1e97b229afcffc50",
	firstperson_righthand:
		"1c6979c32f4d99cc338fa6ba0dfbdbf57e41c6d7c683be2ab5bdaf9a515f566b",
	thirdperson_righthand:
		"7ac632ffa5f7ef32746cf7eafa47e535c17c63fa7c6cb22c029d40d9581412ce",
	head: "a26a18dd6db3933f418e3527970c8df5589a88431e58c47633488c62867af861",
	ground: "c7e3c91fe2263211e62003125914f9eb8239cdb8d3755ef913c4055244a0a957",
	fixed: "2195c223537d833a561735337732181d435278d538166065eac49875eb28ecbe",
};
const ZERO_HASHES: Record<(typeof DISPLAY_SLOTS)[number], string> = {
	gui: "ffc5ed41c0c801c6e4189446708df1f7efffef9291a78b2eb3861c73c72243ee",
	firstperson_righthand:
		"82d3d278e29da7a24d22c5cf44041e0905eb89b1122e31fcd605c9e2cf2268ed",
	thirdperson_righthand:
		"843539cb4ef76a0bae03deb0d073e882a4fda86c3a8ad708172576bc4914feee",
	head: "ea5fb5c00717a933d2eca959faa9bb8e2276329c36135645902dc8d7813ffc53",
	ground: "6b2c7dc1a1b54c6663a71ad714b4acf358b74383bedecb59731b54c70ea8adee",
	fixed: "1b3f8015ada26d7824f0341e5fb4dcd2214345956e270f0584c8eef301dff2ac",
};

const PARENT_PATH = "assets/demo/models/block/base.json";
const ITEM_BASE_PATH = "assets/demo/models/item/base.json";

function parentContext(parent: unknown): ReturnType<typeof memoryContext> {
	return memoryContext({
		[PARENT_PATH]: encoder.encode(JSON.stringify(parent)),
		[STONE_REL]: solidPng(200, 200, 200),
	});
}

function childOf(parentId: string): string {
	return JSON.stringify({
		parent: parentId,
		textures: { all: "demo:stone" },
		elements: [
			{
				from: [0, 0, 0],
				to: [16, 16, 16],
				faces: fullCubeFaces("#all"),
			},
		],
	});
}

function directChild(display: unknown, guiLight?: "front" | "side"): string {
	return JSON.stringify({
		textures: { all: "demo:stone" },
		...(guiLight === undefined ? {} : { gui_light: guiLight }),
		display,
		elements: [
			{
				from: [0, 0, 0],
				to: [16, 16, 16],
				faces: fullCubeFaces("#all"),
			},
		],
	});
}

async function expectCode(
	check: CaseCheck,
	body: () => Promise<unknown>,
	code: string,
	message: string,
): Promise<void> {
	let caught: unknown;
	try {
		await body();
	} catch (error) {
		caught = error;
	}
	check.ok(caught instanceof McAssetError, `${message}: expected McAssetError`);
	if (caught instanceof McAssetError) {
		check.equal(caught.code, code, `${message}: error code`);
	}
}

function centerY(box: {
	readonly minY: number;
	readonly maxY: number;
}): number {
	return (box.minY + box.maxY) / 2;
}

export const DISPLAY_PREVIEW_CASES: ModelCase[] = [
	{
		name: "display rotation changes every slot preview and matches its fixed hash",
		async run(check) {
			const context = coloredCubeContext();
			const rotated = withDisplay(coloredCubeModel(), displayFor([30, 225, 0]));
			const zero = withDisplay(coloredCubeModel(), displayFor([0, 0, 0]));
			for (const slot of DISPLAY_SLOTS) {
				const posed = await renderModelPreview(rotated, {
					path: PREVIEW_PATH,
					context,
					size: 64,
					display: slot,
				});
				const flat = await renderModelPreview(zero, {
					path: PREVIEW_PATH,
					context,
					size: 64,
					display: slot,
				});
				check.equal(posed.report.display?.slot, slot, `${slot}: slot`);
				check.deepEqual(
					[...(posed.report.display?.rotation ?? [])],
					[30, 225, 0],
					`${slot}: rotation is reported as authored`,
				);
				check.equal(
					posed.report.display?.applied,
					true,
					`${slot}: transform applied`,
				);
				check.equal(
					posed.report.coverage.status,
					"complete",
					`${slot}: coverage`,
				);
				check.equal(
					posed.report.range.pixelsPerUnit,
					2,
					`${slot}: display scale`,
				);
				check.deepEqual(
					[...posed.report.panels].map((panel) => [
						panel.name,
						panel.x,
						panel.y,
						panel.width,
						panel.height,
					]),
					[["display", 0, 0, 64, 64]],
					`${slot}: one display panel`,
				);
				check.ok(
					sha256(posed.png) !== sha256(flat.png),
					`${slot}: the two rotations differ`,
				);
				check.equal(
					sha256(posed.png),
					ROTATED_HASHES[slot],
					`${slot}: rotated PNG hash`,
				);
				check.equal(
					sha256(flat.png),
					ZERO_HASHES[slot],
					`${slot}: zero-rotation PNG hash`,
				);
			}
		},
	},
	{
		name: "a child inherits the parent display transform per slot",
		async run(check) {
			const parent = {
				gui_light: "front",
				textures: { all: "demo:stone" },
				display: {
					gui: {
						rotation: [10, 20, 30],
						translation: [1, 2, 3],
						scale: [0.5, 0.5, 0.5],
					},
					head: {
						rotation: [0, 180, 0],
						translation: [0, 13, 7],
						scale: [1, 1, 1],
					},
				},
			};
			const context = parentContext(parent);
			const inherited = await renderModelPreview(childOf("demo:block/base"), {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "gui",
			});
			check.deepEqual(
				[...(inherited.report.display?.rotation ?? [])],
				[10, 20, 30],
				"gui rotation from the parent",
			);
			check.deepEqual(
				[...(inherited.report.display?.translation ?? [])],
				[1, 2, 3],
				"gui translation from the parent",
			);
			check.deepEqual(
				[...(inherited.report.display?.scale ?? [])],
				[0.5, 0.5, 0.5],
				"gui scale from the parent",
			);
			check.equal(
				inherited.report.display?.from,
				"demo:block/base",
				"the report names the parent that supplied the slot",
			);
			check.equal(
				inherited.report.display?.applied,
				true,
				"parent transform applied",
			);
			const own = await renderModelPreview(
				directChild(parent.display, "front"),
				{ path: PREVIEW_PATH, context, size: 64, display: "gui" },
			);
			check.equal(
				sha256(inherited.png),
				sha256(own.png),
				"inherited and directly written gui transforms render the same bytes",
			);
			check.equal(
				inherited.report.lighting,
				undefined,
				"lighting is only reported when it is requested",
			);

			const lit = await renderModelPreview(childOf("demo:block/base"), {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "head",
				lighting: true,
			});
			check.equal(
				lit.report.lighting?.guiLight,
				"front",
				"gui_light is inherited",
			);
			check.equal(
				lit.report.lighting?.mode,
				"flat",
				"front gui_light uses flat shading",
			);

			const headParent = await renderModelPreview(
				directChild({ head: parent.display.head }),
				{ path: PREVIEW_PATH, context, size: 64, display: "head" },
			);
			check.equal(
				sha256(lit.png),
				sha256(headParent.png),
				"the inherited head transform matches one written on the child",
			);
		},
	},
	{
		name: "a child display slot overrides only that slot and defaults missing fields",
		async run(check) {
			const parent = {
				display: {
					gui: {
						rotation: [10, 20, 30],
						translation: [1, 2, 3],
						scale: [0.5, 0.5, 0.5],
					},
					head: {
						rotation: [0, 180, 0],
						translation: [0, 13, 7],
						scale: [1, 1, 1],
					},
				},
			};
			const context = parentContext(parent);
			const child = JSON.stringify({
				parent: "demo:block/base",
				textures: { all: "demo:stone" },
				display: { gui: { rotation: [45, 0, 0] } },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: fullCubeFaces("#all"),
					},
				],
			});
			const gui = await renderModelPreview(child, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "gui",
			});
			check.equal(gui.report.display?.from, "own", "own gui slot wins");
			check.deepEqual(
				[...(gui.report.display?.rotation ?? [])],
				[45, 0, 0],
				"own rotation",
			);
			check.deepEqual(
				[...(gui.report.display?.translation ?? [])],
				[0, 0, 0],
				"an omitted translation uses the game default, not the parent value",
			);
			check.deepEqual(
				[...(gui.report.display?.scale ?? [])],
				[1, 1, 1],
				"an omitted scale uses the game default, not the parent value",
			);
			const head = await renderModelPreview(child, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "head",
			});
			check.equal(
				head.report.display?.from,
				"demo:block/base",
				"head still comes from the parent",
			);
			check.deepEqual(
				[...(head.report.display?.rotation ?? [])],
				[0, 180, 0],
				"parent head rotation",
			);
		},
	},
	{
		name: "builtin item templates supply their display transforms and gui_light",
		async run(check) {
			const generated = childOf("minecraft:item/generated");
			const context = memoryContext({ [STONE_REL]: solidPng(200, 200, 200) });
			const head = await renderModelPreview(generated, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "head",
			});
			check.equal(
				head.report.display?.from,
				"minecraft:item/generated",
				"the builtin parent is named as the source",
			);
			check.equal(
				head.report.display?.applied,
				true,
				"builtin transform applied",
			);
			check.deepEqual(
				[...(head.report.display?.rotation ?? [])],
				[0, 180, 0],
				"generated head rotation",
			);
			check.deepEqual(
				[...(head.report.display?.translation ?? [])],
				[0, 13, 7],
				"generated head translation",
			);
			const lit = await renderModelPreview(generated, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "head",
				lighting: true,
			});
			check.equal(
				lit.report.lighting?.guiLight,
				"front",
				"generated gui_light",
			);
			check.equal(lit.report.lighting?.mode, "flat", "generated flat lighting");

			const noGui = await renderModelPreview(generated, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "gui",
			});
			check.equal(
				noGui.report.display?.applied,
				false,
				"generated has no gui entry",
			);
			check.deepEqual(
				[...(noGui.report.display?.rotation ?? [])],
				[0, 0, 0],
				"a missing slot uses the identity transform",
			);
			check.ok(
				noGui.report.unapplied.includes("display-slot-missing"),
				"a missing slot is listed in unapplied",
			);

			const rod = await renderModelPreview(
				childOf("minecraft:item/handheld_rod"),
				{
					path: PREVIEW_PATH,
					context,
					size: 64,
					display: "firstperson_righthand",
				},
			);
			check.equal(
				rod.report.display?.from,
				"minecraft:item/handheld_rod",
				"handheld_rod owns the firstperson entry",
			);
			check.deepEqual(
				[...(rod.report.display?.rotation ?? [])],
				[0, 90, 25],
				"handheld_rod firstperson rotation",
			);
			check.deepEqual(
				[...(rod.report.display?.scale ?? [])],
				[0.68, 0.68, 0.68],
				"handheld_rod firstperson scale",
			);
			check.deepEqual(
				builtinDisplaySource("minecraft:item/handheld_rod", "fixed")?.source,
				{ rotation: [0, 180, 0], scale: [1, 1, 1] },
				"handheld_rod falls through to generated for fixed",
			);
			check.equal(
				builtinGuiLight("minecraft:item/handheld_rod"),
				"front",
				"handheld_rod inherits generated gui_light",
			);
			check.equal(
				builtinDisplaySource("minecraft:item/generated", "on_shelf" as never),
				undefined,
				"unsupported slots are not supplied by the builtin table",
			);
		},
	},
	{
		name: "a builtin template reached through an intermediate parent supplies display and gui_light",
		async run(check) {
			const context = memoryContext({
				[ITEM_BASE_PATH]: encoder.encode(
					JSON.stringify({ parent: "minecraft:item/generated" }),
				),
				[STONE_REL]: solidPng(200, 200, 200),
			});
			const options = {
				path: PREVIEW_PATH,
				context,
				size: 64 as const,
				display: "fixed" as const,
				lighting: true,
			};
			const nested = await renderModelPreview(
				childOf("demo:item/base"),
				options,
			);
			const direct = await renderModelPreview(
				childOf("minecraft:item/generated"),
				options,
			);
			check.equal(
				nested.report.display?.from,
				"minecraft:item/generated",
				"the template at the end of the chain is named as the source",
			);
			check.equal(
				nested.report.display?.applied,
				true,
				"the template transform is applied",
			);
			check.deepEqual(
				[...(nested.report.display?.rotation ?? [])],
				[0, 180, 0],
				"fixed rotation comes from item/generated",
			);
			check.equal(
				nested.report.lighting?.guiLight,
				"front",
				"gui_light comes from item/generated",
			);
			check.equal(
				nested.report.lighting?.mode,
				"flat",
				"front gui_light uses flat shading",
			);
			check.deepEqual(
				nested.report.display,
				direct.report.display,
				"the nested chain reports the same display as a direct builtin parent",
			);
			check.deepEqual(
				nested.report.lighting,
				direct.report.lighting,
				"the nested chain reports the same lighting as a direct builtin parent",
			);
			check.equal(
				sha256(nested.png),
				sha256(direct.png),
				"the nested chain renders the same bytes as a direct builtin parent",
			);
		},
	},
	{
		name: "an unresolved parent stops the builtin lookup instead of guessing",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(200, 200, 200) });
			const rendered = await renderModelPreview(childOf("demo:item/missing"), {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "fixed",
				lighting: true,
			});
			check.equal(
				rendered.report.display?.applied,
				false,
				"no transform is invented",
			);
			check.deepEqual(
				[...(rendered.report.display?.rotation ?? [])],
				[0, 0, 0],
				"the missing slot keeps the identity rotation",
			);
			check.equal(
				rendered.report.lighting?.guiLight,
				"side",
				"gui_light falls back to side",
			);
			check.equal(
				rendered.report.lighting?.mode,
				"directional",
				"side gui_light is directional",
			);
			check.ok(
				rendered.report.unapplied.includes("display-slot-missing"),
				"the missing slot is still listed",
			);
		},
	},
	{
		name: "side lighting applies the fixed per-direction shade factors",
		async run(check) {
			const normals: Record<string, FixedVec3> = {
				up: [0, 65536, 0],
				down: [0, -65536, 0],
				north: [0, 0, -65536],
				south: [0, 0, 65536],
				west: [-65536, 0, 0],
				east: [65536, 0, 0],
			};
			for (const [direction, expected] of Object.entries(FACE_SHADE)) {
				check.equal(
					shadeForNormal(normals[direction] as FixedVec3, "directional"),
					expected,
					`${direction} shade`,
				);
				check.equal(
					shadeForNormal(normals[direction] as FixedVec3, "flat"),
					1000,
					`${direction} flat`,
				);
			}
			check.equal(
				shadeForNormal([0, 0, 0], "directional"),
				1000,
				"a degenerate normal stays unshaded",
			);
			const context = memoryContext({ [STONE_REL]: solidPng(200, 200, 200) });
			const text = JSON.stringify({
				gui_light: "side",
				textures: { all: "demo:stone" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: fullCubeFaces("#all"),
					},
					{
						from: [20, 0, 0],
						to: [28, 0, 8],
						faces: { down: { texture: "#all" } },
					},
					{
						from: [0, 0, 20],
						to: [8, 0, 28],
						faces: { down: { texture: "#all" } },
					},
				],
			});
			const lit = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				view: { kind: "isometric", direction: "south-east" },
				lighting: true,
			});
			const litFlat = flatOf(lit.png);
			check.deepEqual(
				panelColors(
					litFlat.flat,
					litFlat.width,
					0,
					0,
					litFlat.width - 1,
					litFlat.height - 1,
				),
				["100,100,100", "120,120,120", "160,160,160", "200,200,200"],
				"down 0.5, east 0.6, south 0.8 and up 1.0 appear as integer shades",
			);
			check.ok(
				lit.report.unapplied.includes("dominant-axis-shading"),
				"the report names the dominant-axis approximation",
			);
			check.ok(
				!lit.report.unapplied.includes("lighting"),
				"applied lighting leaves the historical entry out",
			);

			const flat = await renderModelPreview(
				JSON.stringify({ ...JSON.parse(text), gui_light: "front" }),
				{
					path: PREVIEW_PATH,
					context,
					size: 64,
					view: { kind: "isometric", direction: "south-east" },
					lighting: true,
				},
			);
			const flatPixels = flatOf(flat.png);
			check.deepEqual(
				panelColors(
					flatPixels.flat,
					flatPixels.width,
					0,
					0,
					flatPixels.width - 1,
					flatPixels.height - 1,
				),
				["200,200,200"],
				"front gui_light is a flat shade",
			);
			check.equal(flat.report.lighting?.mode, "flat", "front mode is reported");
			check.ok(
				flat.report.unapplied.includes("flat-item-lighting-variation"),
				"flat lighting keeps its own gap entry",
			);

			const unlit = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				view: { kind: "isometric", direction: "south-east" },
			});
			const unlitPixels = flatOf(unlit.png);
			check.deepEqual(
				panelColors(
					unlitPixels.flat,
					unlitPixels.width,
					0,
					0,
					unlitPixels.width - 1,
					unlitPixels.height - 1,
				),
				["200,200,200"],
				"without lighting every face keeps the texture colour",
			);
			check.ok(
				unlit.report.unapplied.includes("lighting"),
				"unlit previews keep lighting in unapplied",
			);
		},
	},
	{
		name: "tintindex faces multiply by the requested colour",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(200, 200, 200) });
			const text = JSON.stringify({
				textures: { all: "demo:stone" },
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: {
							south: { texture: "#all", tintindex: 0 },
							east: { texture: "#all", tintindex: 2 },
							up: { texture: "#all" },
						},
					},
				],
			});
			const single = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				view: { kind: "isometric", direction: "south-east" },
				tint: [0x80, 0xc0, 0x40],
			});
			const singlePixels = flatOf(single.png);
			check.deepEqual(
				panelColors(
					singlePixels.flat,
					singlePixels.width,
					0,
					0,
					singlePixels.width - 1,
					singlePixels.height - 1,
				),
				["100,151,50", "200,200,200"],
				"200 x 128/255 = 100, 192/255 = 151, 64/255 = 50; the untinted face stays 200",
			);
			check.deepEqual(single.report.tint, {
				color: "#80c040",
				appliedFaces: 2,
				uncoloredFaces: 0,
			});
			check.ok(
				!single.report.unapplied.includes("tintindex"),
				"every tintindex face received a colour",
			);

			const perIndex = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				view: { kind: "isometric", direction: "south-east" },
				tints: { "0": [0x80, 0xc0, 0x40], "2": [0xff, 0, 0] },
			});
			const perIndexPixels = flatOf(perIndex.png);
			check.deepEqual(
				panelColors(
					perIndexPixels.flat,
					perIndexPixels.width,
					0,
					0,
					perIndexPixels.width - 1,
					perIndexPixels.height - 1,
				),
				["100,151,50", "200,0,0", "200,200,200"],
				"each tintindex gets its own colour",
			);
			check.deepEqual(perIndex.report.tint?.tints, {
				"0": "#80c040",
				"2": "#ff0000",
			});

			const lit = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				view: { kind: "isometric", direction: "south-east" },
				lighting: true,
				tints: { "0": [0x80, 0xc0, 0x40], "2": [0xff, 0, 0] },
			});
			const litPixels = flatOf(lit.png);
			check.deepEqual(
				panelColors(
					litPixels.flat,
					litPixels.width,
					0,
					0,
					litPixels.width - 1,
					litPixels.height - 1,
				),
				["120,0,0", "200,200,200", "80,120,40"],
				"shading runs before the tint: south 160 -> 80/120/40, east 120 -> 120/0/0",
			);
			check.equal(
				lit.report.lighting?.guiLight,
				"side",
				"side gui_light is reported",
			);

			const sparse = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				view: { kind: "isometric", direction: "south-east" },
				tints: { "0": [0x80, 0xc0, 0x40] },
			});
			check.deepEqual(
				sparse.report.tint,
				{
					tints: { "0": "#80c040" },
					appliedFaces: 1,
					uncoloredFaces: 1,
				},
				"an index without a colour stays untinted and is counted",
			);
			check.ok(
				sparse.report.unapplied.includes("tintindex"),
				"an uncoloured tintindex is listed in unapplied",
			);

			const sorted = await renderModelPreview(
				JSON.stringify({
					textures: { all: "demo:stone" },
					elements: [
						{
							from: [0, 0, 0],
							to: [16, 16, 16],
							faces: {
								south: { texture: "#all", tintindex: 10 },
								east: { texture: "#all", tintindex: 2 },
							},
						},
					],
				}),
				{
					path: PREVIEW_PATH,
					context,
					size: 64,
					view: { kind: "isometric", direction: "south-east" },
					tints: { "10": [1, 2, 3], "2": [4, 5, 6] },
				},
			);
			check.deepEqual(
				Object.keys(sorted.report.tint?.tints ?? {}),
				["2", "10"],
				"the report orders tint indices numerically, not by first digit",
			);

			const spellings = await renderModelPreview(
				JSON.stringify({
					textures: { all: "demo:stone" },
					elements: [
						{
							from: [0, 0, 0],
							to: [16, 16, 16],
							faces: { south: { texture: "#all", tintindex: 2 } },
						},
					],
				}),
				{
					path: PREVIEW_PATH,
					context,
					size: 64,
					view: { kind: "isometric", direction: "south-east" },
					tints: {
						"0x10": [0x10, 0, 0],
						"1e1": [0x0a, 0, 0],
						"2.0": [0x02, 0, 0],
					},
				},
			);
			check.deepEqual(
				Object.keys(spellings.report.tint?.tints ?? {}),
				["2", "10", "16"],
				"the report keys are the canonical decimal index, in numeric order",
			);
			check.deepEqual(
				spellings.report.tint?.tints,
				{ "2": "#020000", "10": "#0a0000", "16": "#100000" },
				"each spelling keeps its own colour under the canonical key",
			);

			await expectCode(
				check,
				() =>
					renderModelPreview(text, {
						path: PREVIEW_PATH,
						context,
						size: 64,
						tint: [0x80, 0xc0, 0x40],
						tints: { "0": [0xff, 0, 0] },
					}),
				"ARGUMENT_CONFLICT",
				"tint and tints together",
			);
			await expectCode(
				check,
				() =>
					renderModelPreview(text, {
						path: PREVIEW_PATH,
						context,
						size: 64,
						tints: { "1": [0xff, 0, 0], "01": [0, 0xff, 0] },
					}),
				"ARGUMENT_CONFLICT",
				"two keys that name the same tint index",
			);
		},
	},
	{
		name: "a tint colour with no tintindex face warns instead of pretending",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(200, 200, 200) });
			const rendered = await renderModelPreview(testCube(), {
				path: PREVIEW_PATH,
				context,
				size: 64,
				view: { kind: "isometric", direction: "south-east" },
				tint: [0xff, 0, 0],
			});
			check.deepEqual(rendered.report.tint, {
				color: "#ff0000",
				appliedFaces: 0,
				uncoloredFaces: 0,
			});
			check.ok(
				rendered.report.warnings.some(
					(warning) => warning.code === "MODEL_PREVIEW_TINT_UNUSED",
				),
				"an unused tint colour warns",
			);
		},
	},
	{
		name: "display translation and scale stay visible in the fixed camera",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(200, 200, 200) });
			const base = JSON.parse(testCube());
			const render = (display: unknown) =>
				renderModelPreview(
					JSON.stringify({ ...base, display: { gui: display } }),
					{ path: PREVIEW_PATH, context, size: 64, display: "gui" },
				);
			const centred = await render({ rotation: [0, 0, 0] });
			const moved = await render({
				rotation: [0, 0, 0],
				translation: [0, 8, 0],
			});
			const centredPixels = flatOf(centred.png);
			const movedPixels = flatOf(moved.png);
			check.ok(
				sha256(centred.png) !== sha256(moved.png),
				"a display translation changes the image",
			);
			check.ok(
				centerY(
					panelBox(centredPixels.flat, centredPixels.width, 0, 0, 63, 63),
				) >
					centerY(panelBox(movedPixels.flat, movedPixels.width, 0, 0, 63, 63)),
				"a positive y translation moves the model up the panel",
			);
			check.deepEqual(
				[...(moved.report.range.min as readonly number[])],
				[-8, 0, -8],
				"the report range includes the translation",
			);
			check.deepEqual(
				[...(moved.report.range.max as readonly number[])],
				[8, 16, 8],
				"the report range includes the translation",
			);

			const full = await render({ rotation: [0, 0, 0], scale: [1, 1, 1] });
			const half = await render({
				rotation: [0, 0, 0],
				scale: [0.5, 0.5, 0.5],
			});
			const fullBox = panelBox(flatOf(full.png).flat, 64, 0, 0, 63, 63);
			const halfBox = panelBox(flatOf(half.png).flat, 64, 0, 0, 63, 63);
			check.ok(
				sha256(full.png) !== sha256(half.png),
				"a display scale changes the image",
			);
			check.ok(
				halfBox.width < fullBox.width && halfBox.height < fullBox.height,
				"a smaller display scale draws a smaller model",
			);
		},
	},
	{
		name: "mirrored display scales flip the shading normal",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(200, 200, 200) });
			const text = JSON.stringify({
				gui_light: "side",
				textures: { all: "demo:stone" },
				elements: [
					{
						from: [0, 8, 0],
						to: [16, 8, 16],
						faces: { up: { texture: "#all" } },
					},
				],
			});
			const render = async (scale: readonly [number, number, number]) => {
				const rendered = await renderModelPreview(
					JSON.stringify({
						...JSON.parse(text),
						display: { gui: { rotation: [30, 0, 0], scale } },
					}),
					{
						path: PREVIEW_PATH,
						context,
						size: 64,
						display: "gui",
						lighting: true,
					},
				);
				const pixels = flatOf(rendered.png);
				return panelColors(
					pixels.flat,
					pixels.width,
					0,
					0,
					pixels.width - 1,
					pixels.height - 1,
				);
			};
			check.deepEqual(
				await render([1, 1, 1]),
				["200,200,200"],
				"an up face gets the 1.0 shade",
			);
			check.deepEqual(
				await render([1, -1, 1]),
				["100,100,100"],
				"mirroring y turns the same face into a down face and it gets the 0.5 shade",
			);
			check.deepEqual(
				await render([1, 1, -1]),
				["200,200,200"],
				"mirroring z keeps the up dominant axis",
			);
			const transform = displayTransformFor("gui", {
				rotation: [0, 0, 0],
				scale: [-1, 1, 1],
			});
			check.equal(
				displayMirrorsFaces(transform),
				true,
				"odd negative scale mirrors",
			);
			check.equal(
				displayMirrorsFaces(
					displayTransformFor("gui", { rotation: [0, 0, 0], scale: [1, 1, 1] }),
				),
				false,
				"positive scale does not mirror",
			);
			check.equal(
				displayMirrorsFaces(
					displayTransformFor("gui", { rotation: [0, 0, 0], scale: [0, 1, 1] }),
				),
				false,
				"a zero scale is degenerate, not a mirror",
			);
		},
	},
	{
		name: "a zero display scale collapses the model without crashing",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(200, 200, 200) });
			const rendered = await renderModelPreview(
				JSON.stringify({
					...JSON.parse(testCube()),
					display: { gui: { rotation: [0, 0, 0], scale: [0, 1, 1] } },
				}),
				{
					path: PREVIEW_PATH,
					context,
					size: 64,
					display: "gui",
					lighting: true,
				},
			);
			check.equal(
				rendered.report.coverage.status,
				"complete",
				"degenerate path stays complete",
			);
			check.deepEqual(
				[...(rendered.report.range.min as readonly number[])],
				[0, -8, -8],
				"the collapsed x range is zero",
			);
			check.deepEqual(
				[...(rendered.report.range.max as readonly number[])],
				[0, 8, 8],
				"the collapsed x range is zero",
			);
			const pixels = flatOf(rendered.png);
			check.equal(
				panelBox(pixels.flat, pixels.width, 0, 0, 63, 63).count,
				0,
				"the degenerate model draws no pixels",
			);
		},
	},
	{
		name: "display reports list the poses and lighting still not simulated",
		async run(check) {
			const context = coloredCubeContext();
			const text = withDisplay(coloredCubeModel(), displayFor([0, 0, 0]));
			const expected: Record<string, readonly string[]> = {
				gui: [],
				firstperson_righthand: ["first-person-hand-pose"],
				thirdperson_righthand: ["third-person-hand-pose"],
				head: ["head-pose"],
				ground: ["dropped-item-pose"],
				fixed: ["item-frame-pose"],
			};
			for (const slot of DISPLAY_SLOTS) {
				const rendered = await renderModelPreview(text, {
					path: PREVIEW_PATH,
					context,
					size: 64,
					display: slot,
				});
				for (const gap of [
					"ambient-occlusion",
					"world-lightmap",
					"shadows",
					"perspective-projection",
					"camera-rig",
					"left-hand-mirroring",
					...expected[slot],
				]) {
					check.ok(
						rendered.report.unapplied.includes(gap),
						`${slot}: unapplied names ${gap}`,
					);
				}
				check.ok(
					!rendered.report.unapplied.some((entry) =>
						/match|accurate|identical|game render/i.test(entry),
					),
					`${slot}: no unapplied entry claims a game match`,
				);
			}
			const lit = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "gui",
				lighting: true,
			});
			check.ok(
				!lit.report.unapplied.includes("lighting"),
				"applied lighting is not listed",
			);
			check.ok(
				lit.report.unapplied.includes("dominant-axis-shading"),
				"the shading approximation is listed",
			);
			check.ok(
				lit.report.unapplied.includes("gui-item-shader-lighting"),
				"the unverified GUI item shader lighting is listed",
			);
		},
	},
	{
		name: "display data in the model does not change the default preview bytes",
		async run(check) {
			const context = memoryContext({ [STONE_REL]: solidPng(255, 0, 0) });
			const text = JSON.stringify({
				...JSON.parse(cubeModel("#all")),
				display: { gui: { rotation: [30, 225, 0] } },
				gui_light: "front",
			});
			const rendered = await renderModelPreview(text, {
				path: PREVIEW_PATH,
				context,
				size: 64,
			});
			check.deepEqual(
				[...rendered.report.unapplied],
				["display", "lighting"],
				"the compatibility path keeps the historical unapplied array",
			);
			check.equal(
				sha256(rendered.png),
				"503193a50eaf67a74227413d0001c9517a6adf231583f96c3e927e7bc76a1167",
				"the default PNG stays byte-identical",
			);
			check.equal(
				sha256(JSON.stringify(rendered.report)),
				"e2eddba201867b7f960395d924c239f058f49363a94f75d502ff4dee3844cc99",
				"the default report stays byte-identical",
			);
		},
	},
	{
		name: "cli and mcp display, lighting and tint previews agree",
		async run(check) {
			await withTempRoot(async (root) => {
				const modelText = JSON.stringify({
					gui_light: "side",
					textures: { all: "demo:stone" },
					display: {
						gui: {
							rotation: [0, 0, 0],
							translation: [0, 0, 0],
							scale: [0.75, 0.75, 0.75],
						},
					},
					elements: [
						{
							from: [0, 0, 0],
							to: [16, 16, 16],
							faces: {
								north: { texture: "#all" },
								south: { texture: "#all", tintindex: 0 },
								east: { texture: "#all" },
								up: { texture: "#all" },
							},
						},
					],
				});
				const { pack, model } = await makePack(
					root,
					solidPng(200, 200, 200),
					modelText,
				);
				const outcome = await runModelRequest({
					mode: "preview",
					inputPath: model,
					packPath: pack,
					size: 64,
					display: "gui",
					lighting: true,
					tint: "#80c040",
					stdout: true,
					requireOutput: true,
				});
				check.equal(outcome.failed, false, "cli render succeeds");
				const cliBytes = outcome.artifact as Uint8Array;
				check.ok(cliBytes instanceof Uint8Array, "cli stdout artifact");
				const cliReport = JSON.stringify(outcome.result);
				const mcp = await handleModelAsset({
					mode: "preview",
					inputPath: model,
					packPath: pack,
					size: 64,
					display: "gui",
					lighting: true,
					tint: "#80c040",
				});
				check.equal(mcp.isError, undefined, "mcp render succeeds");
				const textBlock = mcp.content.find((entry) => entry.type === "text");
				const imageBlock = mcp.content.find((entry) => entry.type === "image");
				check.ok(textBlock?.type === "text", "mcp report");
				check.ok(imageBlock?.type === "image", "mcp image");
				if (textBlock?.type !== "text" || imageBlock?.type !== "image") return;
				check.equal(
					textBlock.text,
					cliReport,
					"cli and mcp reports are identical",
				);
				check.equal(
					sha256(new Uint8Array(Buffer.from(imageBlock.data, "base64"))),
					sha256(cliBytes),
					"cli and mcp PNGs are identical",
				);
				const pixels = flatOf(cliBytes);
				assertRgba(
					check,
					pixels.flat,
					pixels.width,
					32,
					32,
					[80, 120, 40, 255],
					"the south tinted face is shaded then tinted",
				);
			});
		},
	},
	{
		name: "cli inline tints parse and produce the same report as the request core",
		async run(check) {
			await withTempRoot(async (root) => {
				const modelText = JSON.stringify({
					textures: { all: "demo:stone" },
					elements: [
						{
							from: [0, 0, 0],
							to: [16, 16, 16],
							faces: {
								south: { texture: "#all", tintindex: 2 },
								east: { texture: "#all", tintindex: 10 },
							},
						},
					],
				});
				const { pack, model } = await makePack(
					root,
					solidPng(200, 200, 200),
					modelText,
				);
				const out = join(root, "tints.png");
				const capture = captureStreams();
				const code = await runModel(
					"preview",
					model,
					{
						pack,
						size: "64",
						view: "isometric",
						viewDirection: "south-east",
						tints: '{"10":"#010203","2":"#040506"}',
						output: out,
					},
					true,
					capture.streams,
				);
				check.equal(code, 0, "cli --tints exits cleanly");
				const envelope = JSON.parse(
					Buffer.from(capture.stdout()).toString("utf8"),
				) as {
					result: {
						tint?: { tints?: Record<string, string>; appliedFaces: number };
					};
				};
				check.deepEqual(envelope.result.tint, {
					tints: { "2": "#040506", "10": "#010203" },
					appliedFaces: 2,
					uncoloredFaces: 0,
				});
				check.deepEqual(
					Object.keys(envelope.result.tint?.tints ?? {}),
					["2", "10"],
					"the CLI report also orders tint indices numerically",
				);
			});
		},
	},
	{
		name: "invalid display and tint inputs are refused",
		async run(check) {
			await withTempRoot(async (root) => {
				const { pack, model } = await makePack(
					root,
					solidPng(200, 200, 200),
					testCube(),
				);
				await expectCode(
					check,
					() =>
						renderModelPreview(testCube(), {
							path: PREVIEW_PATH,
							size: 64,
							display: "on_shelf" as never,
						}),
					"INVALID_ARGUMENT",
					"unsupported display slot",
				);
				await expectCode(
					check,
					() =>
						renderModelPreview(testCube(), {
							path: PREVIEW_PATH,
							size: 64,
							display: "gui",
							view: { kind: "isometric", direction: "south-east" },
						}),
					"ARGUMENT_CONFLICT",
					"display with view",
				);
				await expectCode(
					check,
					() =>
						runModelRequest({
							mode: "preview",
							inputPath: model,
							packPath: pack,
							size: 64,
							display: "left_hand" as never,
							stdout: true,
							requireOutput: true,
						}),
					"INVALID_ARGUMENT",
					"cli unsupported display slot",
				);
				await expectCode(
					check,
					() =>
						runModelRequest({
							mode: "preview",
							inputPath: model,
							packPath: pack,
							size: 64,
							display: "gui",
							view: "isometric",
							stdout: true,
							requireOutput: true,
						}),
					"ARGUMENT_CONFLICT",
					"cli display with view",
				);
				await expectCode(
					check,
					() =>
						runModelRequest({
							mode: "preview",
							inputPath: model,
							packPath: pack,
							size: 64,
							tint: "#12345",
							stdout: true,
							requireOutput: true,
						}),
					"INVALID_ARGUMENT",
					"cli invalid tint colour",
				);
				await expectCode(
					check,
					() =>
						runModelRequest({
							mode: "preview",
							inputPath: model,
							packPath: pack,
							size: 64,
							tint: "#80c040",
							tints: { "0": "#ffffff" },
							stdout: true,
							requireOutput: true,
						}),
					"ARGUMENT_CONFLICT",
					"cli tint and tints together",
				);
				await expectCode(
					check,
					() =>
						runModelRequest({
							mode: "inspect",
							inputPath: model,
							packPath: pack,
							size: 64,
							stdout: true,
							requireOutput: true,
						}),
					"INVALID_ARGUMENT",
					"size is preview-only",
				);
				const legacy = await handleModelAsset({
					mode: "inspect",
					inputPath: model,
					packPath: pack,
					size: 64,
				});
				check.equal(legacy.isError, true, "mcp refuses size on inspect");
				const legacyText = legacy.content.find(
					(entry) => entry.type === "text",
				);
				check.ok(legacyText?.type === "text", "mcp error text");
				if (legacyText?.type === "text") {
					check.equal(
						(JSON.parse(legacyText.text) as { message: string }).message,
						"size, view, viewDirection, and outputPngPath are only accepted by preview, not inspect.",
						"the historical preview-only message stays byte-identical",
					);
				}
				const displayOnly = await handleModelAsset({
					mode: "inspect",
					inputPath: model,
					packPath: pack,
					display: "gui",
				});
				const displayText = displayOnly.content.find(
					(entry) => entry.type === "text",
				);
				check.ok(displayText?.type === "text", "mcp display error text");
				if (displayText?.type === "text") {
					check.equal(
						(JSON.parse(displayText.text) as { message: string }).message,
						"display is only accepted by preview, not inspect.",
						"a new preview-only field names itself",
					);
				}
			});
		},
	},
	{
		name: "cli inline tints refuse malformed JSON and keys",
		async run(check) {
			await withTempRoot(async (root) => {
				const { pack, model } = await makePack(
					root,
					solidPng(200, 200, 200),
					testCube(),
				);
				const runTints = async (tints: string) => {
					const capture = captureStreams();
					const code = await runModel(
						"preview",
						model,
						{
							pack,
							size: "64",
							tints,
							stdout: true,
						},
						true,
						capture.streams,
					);
					return {
						code,
						text: capture.stderrText(),
					};
				};
				for (const [tints, expected] of [
					["not-json", "--tints expects a JSON object"],
					["[]", "--tints expects a JSON object"],
					['{"x":"#ffffff"}', "--tints keys must be non-negative integers"],
					['{"0":"red"}', "tints[0] expects a #RRGGBB colour"],
				] as const) {
					const result = await runTints(tints);
					check.ok(result.code !== 0, `${tints}: non-zero exit`);
					check.ok(
						result.text.includes(expected),
						`${tints}: message names the problem`,
					);
				}
			});
		},
	},
	{
		name: "parseTintColor accepts both forms and rejects everything else",
		async run(check) {
			check.deepEqual(parseTintColor("#80C040"), [0x80, 0xc0, 0x40]);
			check.deepEqual(parseTintColor("80c040"), [0x80, 0xc0, 0x40]);
			for (const value of ["#80c04", "#80c0400", "#gggggg", "", "red"]) {
				check.equal(parseTintColor(value), undefined, `${value} is rejected`);
			}
		},
	},
	{
		name: "a builtin parent written without a namespace resolves like minecraft:",
		async run(check) {
			const filesFor = (parent: string): Record<string, Uint8Array> => ({
				[ITEM_BASE_PATH]: encoder.encode(JSON.stringify({ parent })),
				[STONE_REL]: solidPng(200, 200, 200),
			});
			for (const entry of [
				{ template: "item/generated", slot: "fixed" as const },
				{ template: "item/handheld", slot: "firstperson_righthand" as const },
			]) {
				const options = {
					path: PREVIEW_PATH,
					size: 64 as const,
					display: entry.slot,
					lighting: true,
				};
				const alias = await renderModelPreview(childOf("demo:item/base"), {
					...options,
					context: memoryContext(filesFor(entry.template)),
				});
				const named = await renderModelPreview(childOf("demo:item/base"), {
					...options,
					context: memoryContext(filesFor(`minecraft:${entry.template}`)),
				});
				check.equal(
					alias.report.display?.from,
					`minecraft:${entry.template}`,
					`${entry.template}: the default namespace names the template`,
				);
				check.equal(
					alias.report.display?.applied,
					true,
					`${entry.template}: the template transform is applied`,
				);
				check.deepEqual(
					alias.report.display,
					named.report.display,
					`${entry.template}: same display report as the explicit namespace`,
				);
				check.deepEqual(
					alias.report.lighting,
					named.report.lighting,
					`${entry.template}: same lighting report as the explicit namespace`,
				);
				check.equal(
					sha256(alias.png),
					sha256(named.png),
					`${entry.template}: the same bytes as the explicit namespace`,
				);
				check.equal(
					JSON.stringify(alias.report),
					JSON.stringify(named.report),
					`${entry.template}: the whole report matches the explicit namespace`,
				);
			}

			const context = memoryContext({ [STONE_REL]: solidPng(200, 200, 200) });
			const direct = await renderModelPreview(childOf("item/generated"), {
				path: PREVIEW_PATH,
				context,
				size: 64,
				display: "head",
				lighting: true,
			});
			check.equal(
				direct.report.display?.from,
				"minecraft:item/generated",
				"a namespace-less direct parent is the template",
			);
			check.deepEqual(
				[...(direct.report.display?.translation ?? [])],
				[0, 13, 7],
				"the generated head transform is applied",
			);
			check.equal(
				direct.report.lighting?.guiLight,
				"front",
				"the generated gui_light is applied",
			);

			// The alias is a preview rule: inspect and validate keep reporting
			// the namespace-less parent exactly as before.
			const inspection = await inspectModel(childOf("item/generated"), {
				path: PREVIEW_PATH,
				context,
			});
			check.equal(
				inspection.parent?.status,
				"unresolved",
				"inspect still reports the namespace-less parent as unresolved",
			);
			check.equal(
				inspection.coverage.status,
				"partial",
				"inspect still lists the unread parent in coverage",
			);
		},
	},
	{
		name: "a recipe-built item model draws its layer plane and shows the pose",
		async run(check) {
			const itemModel = buildParentModel({ item: "ruby", namespace: "demo" });
			const context = memoryContext({
				"assets/demo/textures/item/ruby.png": splitPng(),
			});
			const modelPath = "assets/demo/models/item/ruby.json";
			const render = (rotation: readonly [number, number, number]) =>
				renderModelPreview(
					JSON.stringify({ ...itemModel, display: { gui: { rotation } } }),
					{
						path: modelPath,
						context,
						size: 64,
						display: "gui",
						lighting: true,
					},
				);
			const flat = await render([0, 0, 0]);
			const turned = await render([30, 225, 0]);
			const flatPixels = flatOf(flat.png);
			const turnedPixels = flatOf(turned.png);
			const flatBox = panelBox(
				flatPixels.flat,
				flatPixels.width,
				0,
				0,
				flatPixels.width - 1,
				flatPixels.height - 1,
			);
			const turnedBox = panelBox(
				turnedPixels.flat,
				turnedPixels.width,
				0,
				0,
				turnedPixels.width - 1,
				turnedPixels.height - 1,
			);
			check.deepEqual(
				[flatBox.minX, flatBox.minY, flatBox.maxX, flatBox.maxY],
				[16, 16, 47, 47],
				"the unrotated 16-unit plane is a 32 px square in the 64 px panel",
			);
			check.ok(
				turnedBox.count > 0,
				"the turned pose draws the item instead of a transparent image",
			);
			check.ok(
				sha256(flat.png) !== sha256(turned.png),
				"the gui rotation changes the image",
			);
			check.ok(
				turnedBox.width !== flatBox.width ||
					turnedBox.height !== flatBox.height,
				"the turned pose is not the flat square",
			);
			assertRgba(
				check,
				flatPixels.flat,
				flatPixels.width,
				20,
				32,
				[255, 0, 0, 255],
				"the left half of layer0 is drawn",
			);
			assertRgba(
				check,
				flatPixels.flat,
				flatPixels.width,
				43,
				32,
				[0, 255, 0, 255],
				"the right half of layer0 is drawn",
			);
			check.equal(
				flat.report.display?.applied,
				true,
				"the model's own gui display entry is applied",
			);
			check.equal(
				flat.report.coverage.status,
				"complete",
				"the drawn layer covers the model, so coverage is complete",
			);
			check.ok(
				flat.report.unapplied.includes("generated-item-edge-quads"),
				"the 1 px edge quads the preview omits are listed",
			);
		},
	},
	{
		name: "generated item layers stack with the upper layer in front",
		async run(check) {
			const context = memoryContext({
				"assets/demo/textures/item/ruby.png": splitPng(),
				"assets/demo/textures/item/ruby_top.png": bandPng(0, 0, 255),
			});
			const rendered = await renderModelPreview(
				JSON.stringify({
					parent: "minecraft:item/generated",
					textures: {
						layer0: "demo:item/ruby",
						layer1: "demo:item/ruby_top",
					},
				}),
				{
					path: "assets/demo/models/item/ruby.json",
					context,
					size: 64,
					display: "gui",
				},
			);
			const pixels = flatOf(rendered.png);
			check.equal(
				rendered.report.coverage.status,
				"complete",
				"both layers resolve, so coverage is complete",
			);
			assertRgba(
				check,
				pixels.flat,
				pixels.width,
				32,
				18,
				[0, 0, 255, 255],
				"layer1 covers layer0 where it is opaque",
			);
			assertRgba(
				check,
				pixels.flat,
				pixels.width,
				20,
				32,
				[255, 0, 0, 255],
				"layer0 shows through layer1's transparent texels",
			);
			assertRgba(
				check,
				pixels.flat,
				pixels.width,
				43,
				32,
				[0, 255, 0, 255],
				"layer0's right half is drawn under layer1's empty area",
			);

			// The generator stops at the first missing layer, so a gap ends the
			// generated geometry; layer2 alone must not appear.
			const gap = await renderModelPreview(
				JSON.stringify({
					parent: "minecraft:item/generated",
					textures: {
						layer0: "demo:item/ruby",
						layer2: "demo:item/ruby_top",
					},
				}),
				{
					path: "assets/demo/models/item/ruby.json",
					context,
					size: 64,
					display: "gui",
				},
			);
			const gapPixels = flatOf(gap.png);
			check.deepEqual(
				panelColors(
					gapPixels.flat,
					gapPixels.width,
					0,
					0,
					gapPixels.width - 1,
					gapPixels.height - 1,
				),
				["0,255,0", "255,0,0"],
				"a layer after a gap is not generated",
			);

			// A layer texture only the parent declares has no resolved texture
			// in the inspection report, so it is reported instead of drawn.
			const inherited = await renderModelPreview(
				JSON.stringify({ parent: "demo:item/base" }),
				{
					path: "assets/demo/models/item/ruby.json",
					context: memoryContext({
						"assets/demo/models/item/base.json": encoder.encode(
							JSON.stringify({
								parent: "minecraft:item/generated",
								textures: { layer0: "demo:item/ruby" },
							}),
						),
						"assets/demo/textures/item/ruby.png": splitPng(),
					}),
					size: 64,
					display: "gui",
				},
			);
			check.equal(
				inherited.report.coverage.status,
				"partial",
				"an inherited layer ends the drawn run and is reported",
			);
			check.ok(
				inherited.report.coverage.skipped.some(
					(entry) =>
						entry.kind === "generated-item-layer" &&
						entry.reason === "inherited-texture" &&
						entry.target === "layer0",
				),
				"the undrawn inherited layer is named",
			);
		},
	},
	{
		name: "a recipe-built item model keeps its historical transparent output without new options",
		async run(check) {
			const modelPath = "assets/demo/models/item/ruby.json";
			const context = memoryContext({
				"assets/demo/textures/item/ruby.png": splitPng(),
			});
			const text = JSON.stringify({
				parent: "minecraft:item/generated",
				textures: { layer0: "demo:item/ruby" },
			});
			const legacy = await renderModelPreview(text, {
				path: modelPath,
				context,
				size: 64,
			});
			// 77c78fd synthesised no geometry for a model with no elements: the
			// whole 192x64 image stayed transparent. The hash is that release's
			// byte-exact output for this input, so an accidentally generated
			// layer is caught even though every pixel is transparent.
			check.equal(
				sha256(legacy.png),
				"2e2042bece3f9ace257124fb50362318091fa9315bc0647c1355bf40fba579f1",
				"the no-option PNG matches the pre-layer release",
			);
			check.deepEqual(
				legacy.report.range,
				{ min: [0, 0, 0], max: [0, 0, 0], pixelsPerUnit: 1 },
				"the empty range of the compatibility renderer",
			);
			check.deepEqual(
				legacy.report.unapplied,
				["display", "lighting"],
				"the historical unapplied list",
			);
			check.equal(
				legacy.report.lighting,
				undefined,
				"no lighting block without --lighting",
			);
			check.equal(
				legacy.report.display,
				undefined,
				"no display block without --display",
			);
			check.equal(
				legacy.report.tint,
				undefined,
				"no tint block without a tint",
			);
			check.equal(
				legacy.report.coverage.status,
				"complete",
				"no new skip is reported",
			);
			check.deepEqual(
				legacy.report.warnings,
				[],
				"the legacy report carries no warning",
			);

			const gui = await renderModelPreview(text, {
				path: modelPath,
				context,
				size: 64,
				display: "gui",
			});
			const guiPixels = flatOf(gui.png);
			check.deepEqual(
				[guiPixels.width, guiPixels.height],
				[64, 64],
				"a display slot produces one panel",
			);
			assertRgba(
				check,
				guiPixels.flat,
				guiPixels.width,
				20,
				32,
				[255, 0, 0, 255],
				"--display gui draws layer0's left half",
			);
			assertRgba(
				check,
				guiPixels.flat,
				guiPixels.width,
				43,
				32,
				[0, 255, 0, 255],
				"--display gui draws layer0's right half",
			);
			check.equal(
				gui.report.coverage.status,
				"complete",
				"the drawn plane covers the display panel",
			);

			const lit = await renderModelPreview(text, {
				path: modelPath,
				context,
				size: 64,
				lighting: true,
			});
			const litPixels = flatOf(lit.png);
			check.ok(
				panelBox(
					litPixels.flat,
					litPixels.width,
					0,
					0,
					litPixels.width - 1,
					litPixels.height - 1,
				).count > 0,
				"--lighting draws the layer plane",
			);

			const tinted = await renderModelPreview(text, {
				path: modelPath,
				context,
				size: 64,
				tint: [0x80, 0xc0, 0x40],
			});
			check.equal(
				tinted.report.tint?.appliedFaces,
				2,
				"both faces of the single layer are tinted",
			);
			check.equal(
				tinted.report.tint?.uncoloredFaces,
				0,
				"no tintindex face is left uncoloured",
			);
		},
	},
	{
		name: "generated item layers render both faces with the upper layer nearest from either side",
		async run(check) {
			const modelPath = "assets/demo/models/item/ruby.json";
			const context = memoryContext({
				"assets/demo/textures/item/ruby.png": splitPng(),
				"assets/demo/textures/item/ruby_top.png": twoToneBandPng(),
			});
			const model = (display?: unknown): string =>
				JSON.stringify({
					parent: "minecraft:item/generated",
					textures: {
						layer0: "demo:item/ruby",
						layer1: "demo:item/ruby_top",
					},
					...(display === undefined ? {} : { display }),
				});
			const options = { path: modelPath, context, size: 64 as const };
			const front = await renderModelPreview(
				model({ gui: { rotation: [0, 0, 0] } }),
				{ ...options, display: "gui" },
			);
			const back = await renderModelPreview(
				model({ gui: { rotation: [0, 180, 0] } }),
				{ ...options, display: "gui" },
			);
			const fixed = await renderModelPreview(model(), {
				...options,
				display: "fixed",
			});

			const frontPixels = flatOf(front.png);
			assertRgba(
				check,
				frontPixels.flat,
				frontPixels.width,
				20,
				18,
				[0, 0, 255, 255],
				"front: layer1's blue half is on the left",
			);
			assertRgba(
				check,
				frontPixels.flat,
				frontPixels.width,
				43,
				18,
				[0, 255, 255, 255],
				"front: layer1's cyan half is on the right",
			);
			assertRgba(
				check,
				frontPixels.flat,
				frontPixels.width,
				20,
				32,
				[255, 0, 0, 255],
				"front: layer0 red shows below the band",
			);
			assertRgba(
				check,
				frontPixels.flat,
				frontPixels.width,
				43,
				32,
				[0, 255, 0, 255],
				"front: layer0 green shows below the band",
			);

			// The vanilla north UV attaches texel u = 0 to the same model-space x
			// as the south face, so the back is the sprite's mirrored side. The
			// upper layer is still nearest: the asymmetric band proves the north
			// face is drawn and not a duplicated south face.
			const backPixels = flatOf(back.png);
			assertRgba(
				check,
				backPixels.flat,
				backPixels.width,
				20,
				18,
				[0, 255, 255, 255],
				"back: layer1's cyan half is on the left",
			);
			assertRgba(
				check,
				backPixels.flat,
				backPixels.width,
				43,
				18,
				[0, 0, 255, 255],
				"back: layer1's blue half is on the right",
			);
			assertRgba(
				check,
				backPixels.flat,
				backPixels.width,
				20,
				32,
				[0, 255, 0, 255],
				"back: layer0 green shows below the band",
			);
			assertRgba(
				check,
				backPixels.flat,
				backPixels.width,
				43,
				32,
				[255, 0, 0, 255],
				"back: layer0 red shows below the band",
			);
			check.equal(
				sha256(back.png),
				sha256(fixed.png),
				"fixed uses item/generated's 180 degree rotation and renders the same bytes as gui 180",
			);
			check.equal(
				fixed.report.display?.from,
				"minecraft:item/generated",
				"fixed transform comes from the builtin template",
			);
			check.deepEqual(
				[...(fixed.report.display?.rotation ?? [])],
				[0, 180, 0],
				"fixed rotation",
			);
			check.equal(
				fixed.report.coverage.status,
				"complete",
				"both sides resolve and the stack is covered",
			);

			const tinted = await renderModelPreview(
				model({ gui: { rotation: [0, 180, 0] } }),
				{
					...options,
					display: "gui",
					tints: { "0": [0xff, 0xff, 0xff], "1": [0xff, 0xff, 0x00] },
				},
			);
			const tintedPixels = flatOf(tinted.png);
			assertRgba(
				check,
				tintedPixels.flat,
				tintedPixels.width,
				20,
				18,
				[0, 255, 0, 255],
				"tinted back: cyan x yellow",
			);
			assertRgba(
				check,
				tintedPixels.flat,
				tintedPixels.width,
				43,
				18,
				[0, 0, 0, 255],
				"tinted back: blue x yellow",
			);
			check.equal(
				tinted.report.tint?.appliedFaces,
				4,
				"both faces of both layers carry a tint index",
			);
			check.equal(
				tinted.report.tint?.uncoloredFaces,
				0,
				"every tintindex face gets a colour",
			);

			// The layer geometry itself: symmetric around z = 8, double-sided,
			// with the vanilla UVs and the layer's tint index on both faces.
			const layerTexture = (name: string) => ({
				name,
				resolution: {
					status: "resolved" as const,
					resolvedTo: `demo:item/${name}`,
					via: [] as const,
				},
			});
			const layers = itemLayerElements([
				layerTexture("layer0"),
				layerTexture("layer1"),
			]);
			check.equal(layers.length, 2, "two layers produce two elements");
			check.deepEqual(
				layers.map((element) => element.from),
				[
					[0, 0, 7.5],
					[0, 0, 7.5 - ITEM_LAYER_Z_STEP],
				],
				"each layer grows towards the back of the centre plane",
			);
			check.deepEqual(
				layers.map((element) => element.to),
				[
					[16, 16, 8.5],
					[16, 16, 8.5 + ITEM_LAYER_Z_STEP],
				],
				"each layer grows towards the front of the centre plane",
			);
			check.deepEqual(
				layers.map((element) => element.faces.map((face) => face.face)),
				[
					["south", "north"],
					["south", "north"],
				],
				"every layer declares both sides",
			);
			check.deepEqual(
				layers.map((element) => element.faces.map((face) => face.uv)),
				[
					[
						[0, 0, 16, 16],
						[16, 0, 0, 16],
					],
					[
						[0, 0, 16, 16],
						[16, 0, 0, 16],
					],
				],
				"the vanilla south and north UVs",
			);
			check.deepEqual(
				layers.flatMap((element) =>
					element.faces.map((face) => face.tintindex),
				),
				[0, 0, 1, 1],
				"both faces carry the layer's tint index",
			);
		},
	},
	{
		name: "mcp tint spellings are reported under the canonical numeric index",
		async run(check) {
			await withTempRoot(async (root) => {
				const { pack, model } = await makePack(
					root,
					solidPng(200, 200, 200),
					testCube(),
				);
				const mcp = await handleModelAsset({
					mode: "preview",
					inputPath: model,
					packPath: pack,
					size: 64,
					tints: { "10": "#010203", "02": "#040506" },
				});
				check.equal(mcp.isError, undefined, "mcp render succeeds");
				const textBlock = mcp.content.find((entry) => entry.type === "text");
				check.ok(textBlock?.type === "text", "mcp report");
				if (textBlock?.type !== "text") return;
				const report = JSON.parse(textBlock.text) as {
					tint?: { tints?: Record<string, string> };
				};
				check.deepEqual(
					Object.keys(report.tint?.tints ?? {}),
					["2", "10"],
					"mixed spellings report in numeric order",
				);
				check.deepEqual(
					report.tint?.tints,
					{ "2": "#040506", "10": "#010203" },
					"each colour keeps its index under the canonical key",
				);
			});
		},
	},
];

/** A plain cube used by the error and unused-tint cases. */
function testCube(): string {
	return JSON.stringify({
		textures: { all: "demo:stone" },
		elements: [
			{
				from: [0, 0, 0],
				to: [16, 16, 16],
				faces: fullCubeFaces("#all"),
			},
		],
	});
}
