import {
	addLayer,
	createCanvas,
	getPixel,
	setPixel,
} from "../../src/core/canvas.ts";
import type { PixelCanvas } from "../../src/core/types.ts";
import {
	analyzeCanvasAlphaPredicted,
	checkBlockResolutionWarnings,
	classifyPredictedClassification,
	collectPartialAlphaWarnings,
	summarizeAlphaFromValues,
	summarizeCanvasAlpha,
} from "../../src/profiles/classify.ts";
import {
	getAssetProfile,
	listAssetProfileIds,
} from "../../src/profiles/profiles.ts";
import {
	COMPAT_FACTS,
	getItemAtlasPolicy,
	ITEMS_ATLAS_FACT,
	pendingSourceWarnings,
	resolveVersionedFact,
} from "../../src/profiles/versions.ts";

/** Runner-agnostic assertion surface: bun:test and node:test entries adapt to this. */
export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface ModelCase {
	name: string;
	run(check: CaseCheck): void;
}

function fillCanvas(
	width: number,
	height: number,
	alphas: number[],
): { canvas: PixelCanvas; layerId: string } {
	if (alphas.length !== width * height) {
		throw new Error("alpha vector length must match canvas area");
	}
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const a = alphas[y * width + x] as number;
			setPixel(canvas, layer.id, x, y, { r: 200, g: 100, b: 50, a });
		}
	}
	return { canvas, layerId: layer.id };
}

function snapshotPixels(canvas: PixelCanvas, layerId: string): number[] {
	const out: number[] = [];
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			out.push(getPixel(canvas, layerId, x, y).a);
		}
	}
	return out;
}

export const MODEL_CASES: ModelCase[] = [
	{
		name: "§78 case A: all A=255 is predicted solid",
		run: (check) => {
			const { canvas, layerId } = fillCanvas(2, 2, [255, 255, 255, 255]);
			const histogram = summarizeCanvasAlpha(canvas, layerId);
			check.equal(histogram.opaquePixels, 4, "opaque count");
			check.equal(histogram.transparentPixels, 0, "transparent count");
			check.equal(histogram.partialAlphaPixels, 0, "partial count");
			check.equal(
				classifyPredictedClassification(histogram),
				"solid",
				"classification",
			);
			const report = analyzeCanvasAlphaPredicted(canvas, layerId);
			check.equal(
				report.predictedClassification,
				"solid",
				"report classification",
			);
			check.deepEqual(
				collectPartialAlphaWarnings(histogram),
				[],
				"no partial warning",
			);
		},
	},
	{
		name: "§78 case B: A=0 + A=255 is predicted cutout",
		run: (check) => {
			const { canvas, layerId } = fillCanvas(2, 2, [0, 255, 255, 0]);
			const histogram = summarizeCanvasAlpha(canvas, layerId);
			check.equal(histogram.opaquePixels, 2, "opaque count");
			check.equal(histogram.transparentPixels, 2, "transparent count");
			check.equal(histogram.partialAlphaPixels, 0, "partial count");
			check.equal(
				classifyPredictedClassification(histogram),
				"cutout",
				"classification",
			);
			const report = analyzeCanvasAlphaPredicted(canvas, layerId);
			check.equal(
				report.predictedClassification,
				"cutout",
				"report classification",
			);
			check.deepEqual(
				collectPartialAlphaWarnings(histogram),
				[],
				"no partial warning",
			);
		},
	},
	{
		name: "§78 case C: any 0<A<255 is predicted translucent with warning only",
		run: (check) => {
			const { canvas, layerId } = fillCanvas(2, 2, [255, 128, 255, 0]);
			const before = snapshotPixels(canvas, layerId);
			const histogram = summarizeCanvasAlpha(canvas, layerId);
			check.equal(histogram.partialAlphaPixels, 1, "partial count");
			check.deepEqual(histogram.partialAlphaValues, [128], "partial values");
			check.equal(
				classifyPredictedClassification(histogram),
				"translucent",
				"classification",
			);
			const report = analyzeCanvasAlphaPredicted(canvas, layerId);
			check.equal(
				report.predictedClassification,
				"translucent",
				"report classification",
			);
			const warnings = collectPartialAlphaWarnings(histogram);
			check.equal(warnings.length, 1, "one warning");
			check.equal(
				warnings[0]?.code,
				"PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING",
				"warning code",
			);
			check.equal(warnings[0]?.level, "warning", "warning level only");
			// Warn-only: analysis must not rewrite any pixel.
			check.deepEqual(
				snapshotPixels(canvas, layerId),
				before,
				"canvas bytes unchanged",
			);
			check.deepEqual(
				snapshotPixels(canvas, layerId),
				[255, 128, 255, 0],
				"partial value kept verbatim",
			);
		},
	},
	{
		name: "alpha 254 still counts as partial and warns without fixing",
		run: (check) => {
			const histogram = summarizeAlphaFromValues([255, 255, 254, 255]);
			check.equal(histogram.partialAlphaPixels, 1, "partial count");
			check.equal(
				classifyPredictedClassification(histogram),
				"translucent",
				"classification",
			);
			const warnings = collectPartialAlphaWarnings(histogram);
			check.equal(warnings.length, 1, "one warning");
			check.equal(
				warnings[0]?.code,
				"PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING",
				"warning code",
			);
		},
	},
	{
		name: "report fields carry predicted naming and no final-render claim",
		run: (check) => {
			const { canvas, layerId } = fillCanvas(2, 2, [255, 255, 255, 0]);
			const report = analyzeCanvasAlphaPredicted(canvas, layerId);
			const keys = Object.keys(report);
			check.ok(
				keys.some((key) => key.includes("predicted")),
				"at least one predicted field",
			);
			check.ok(
				keys.includes("predictedClassification"),
				"predictedClassification present",
			);
			check.ok(
				!keys.some((key) => key.toLowerCase().includes("effective")),
				"no effective field",
			);
			const text = JSON.stringify(report).toLowerCase();
			check.ok(!text.includes("effective"), "no effective claim in output");
			check.ok(text.includes("predicted"), "predicted tone in output");
		},
	},
	{
		name: "item profile asserts items atlas without mipmaps",
		run: (check) => {
			const profile = getAssetProfile("minecraft:item");
			check.equal(profile.preferredAtlas, "items", "preferred atlas");
			check.equal(profile.mipmapped, false, "no mipmaps");
			check.ok(
				listAssetProfileIds().includes("minecraft:item"),
				"item id listed",
			);
		},
	},
	{
		name: "block profile never errors on size, only warns",
		run: (check) => {
			const profile = getAssetProfile("minecraft:block");
			check.equal(profile.preferredAtlas, "blocks", "preferred atlas");
			// 16x16 recommended: no warning expected.
			check.deepEqual(
				checkBlockResolutionWarnings(16, 16),
				[],
				"16x16 is quiet",
			);
			// 24x24 loads fine but is non-standard: warning only, no throw.
			const warnings = checkBlockResolutionWarnings(24, 24);
			check.equal(warnings.length, 1, "one warning");
			check.equal(warnings[0]?.code, "NON_STANDARD_RESOLUTION", "warning code");
			check.equal(warnings[0]?.level, "warning", "warning level only");
			// Non-square is also recommendation-only.
			const wide = checkBlockResolutionWarnings(32, 16);
			check.equal(wide.length, 1, "non-square warns");
			check.equal(wide[0]?.level, "warning", "still warning only");
		},
	},
	{
		name: "generic profile carries no minecraft restriction",
		run: (check) => {
			const profile = getAssetProfile("generic");
			check.equal(profile.id, "generic", "id");
			check.equal(profile.preferredAtlas, undefined, "no atlas demand");
			check.ok(listAssetProfileIds().includes("generic"), "generic id listed");
		},
	},
	{
		name: "versioned fact switches behavior across packFormat 75",
		run: (check) => {
			check.equal(
				resolveVersionedFact(ITEMS_ATLAS_FACT, 74),
				undefined,
				"74 predates the separate items atlas",
			);
			check.deepEqual(
				resolveVersionedFact(ITEMS_ATLAS_FACT, 75),
				{ atlas: "items", mipmapped: false },
				"75 activates the separate items atlas",
			);
			check.deepEqual(
				getItemAtlasPolicy(75),
				{ preferredAtlas: "items", mipmapped: false },
				"policy at 75",
			);
			check.equal(
				getItemAtlasPolicy(74),
				undefined,
				"no separate policy at 74",
			);
			check.ok(COMPAT_FACTS.length >= 1, "version interval table is populated");
			for (const fact of COMPAT_FACTS) {
				check.ok(typeof fact.fact === "string", "fact name");
				check.ok(typeof fact.since.packFormat === "number", "since.packFormat");
				check.ok(fact.value !== undefined, "value present");
			}
		},
	},
	{
		name: "pending-source fact only warns, never errors",
		run: (check) => {
			const warnings = pendingSourceWarnings();
			check.ok(warnings.length >= 1, "at least one pending warning");
			for (const warning of warnings) {
				check.equal(warning.level, "warning", "warning level only");
			}
			const text = JSON.stringify(warnings).toLowerCase();
			check.ok(!text.includes("error"), "no error claim");
		},
	},
	{
		name: "edge: fully transparent canvas is cutout, fully opaque is solid",
		run: (check) => {
			const clear = summarizeAlphaFromValues([0, 0, 0, 0]);
			check.equal(
				classifyPredictedClassification(clear),
				"cutout",
				"all clear is cutout",
			);
			const solid = summarizeAlphaFromValues([255]);
			check.equal(
				classifyPredictedClassification(solid),
				"solid",
				"single opaque is solid",
			);
			const singlePartial = summarizeAlphaFromValues([1]);
			check.equal(
				classifyPredictedClassification(singlePartial),
				"translucent",
				"single partial is translucent",
			);
		},
	},
	{
		name: "large canvas walk stays linear without exploding",
		run: (check) => {
			const width = 256;
			const height = 256;
			const canvas = createCanvas(width, height);
			const layer = addLayer(canvas, { id: "base" });
			// Sparse writes: only the diagonal is opaque, rest stays clear.
			for (let i = 0; i < 256; i += 1) {
				setPixel(canvas, layer.id, i, i, { r: 1, g: 2, b: 3, a: 255 });
			}
			const histogram = summarizeCanvasAlpha(canvas, layer.id);
			check.equal(histogram.opaquePixels, 256, "diagonal count");
			check.equal(
				histogram.transparentPixels,
				width * height - 256,
				"rest is clear",
			);
			check.equal(
				classifyPredictedClassification(histogram),
				"cutout",
				"mixed clear and opaque",
			);
		},
	},
];
