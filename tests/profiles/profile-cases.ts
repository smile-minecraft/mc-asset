import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { VersionedFact } from "../../src/profiles/types.ts";
import {
	COMPAT_FACTS,
	comparePackFormats,
	getItemAtlasPolicy,
	ITEM_ATLAS_PLACEMENT_FACT,
	ITEM_MODEL_DEFINITIONS_FACT,
	ITEMS_ATLAS_FACT,
	isFactActive,
	normalizePackFormat,
	pendingSourceWarnings,
	resolveVersionedFact,
	TEXTURE_MIPMAP_FACT,
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
		name: "versioned fact switches behavior across packFormat 75.0",
		run: (check) => {
			check.equal(
				resolveVersionedFact(ITEMS_ATLAS_FACT, "74.0"),
				undefined,
				"74.0 predates the separate items atlas",
			);
			check.deepEqual(
				resolveVersionedFact(ITEMS_ATLAS_FACT, "75.0"),
				{ atlas: "items", mipmapped: false },
				"75.0 activates the separate items atlas",
			);
			check.deepEqual(
				getItemAtlasPolicy("75.0"),
				{ preferredAtlas: "items", mipmapped: false },
				"policy at 75.0",
			);
			check.equal(
				getItemAtlasPolicy("74.0"),
				undefined,
				"no separate policy at 74.0",
			);
			check.ok(COMPAT_FACTS.length >= 1, "version interval table is populated");
			for (const fact of COMPAT_FACTS) {
				check.ok(typeof fact.fact === "string", "fact name");
				check.ok(
					fact.since.packFormat === undefined ||
						typeof fact.since.packFormat === "string",
					"since.packFormat is a dotted string or undetermined",
				);
				check.ok(fact.value !== undefined, "value present");
			}
		},
	},
	{
		name: "all facts determined: no pending-source warnings remain",
		run: (check) => {
			check.deepEqual(
				pendingSourceWarnings(),
				[],
				"no pending-source warnings once every fact is determined",
			);
		},
	},
	{
		name: "nine compat facts carry source, check date, and sourced since",
		run: (check) => {
			const byName = new Map(COMPAT_FACTS.map((fact) => [fact.fact, fact]));
			check.equal(COMPAT_FACTS.length, 9, "nine facts");
			check.ok(
				!byName.has("resource-pack-format"),
				"resource-pack-format fact is retired",
			);
			const expected: Array<{
				fact: string;
				status: "verified" | "pending-source";
				since: string | undefined;
				sourcePart: string;
				checkedAt: string;
			}> = [
				{
					fact: "trim-palette-location",
					status: "verified",
					since: "97.1",
					sourcePart: "26.3-snap1 / RP 97.1",
					checkedAt: "2026-09-20",
				},
				{
					fact: "items-atlas-separated",
					status: "verified",
					since: "75.0",
					sourcePart: "1.21.11 / RP 75.0",
					checkedAt: "2026-09-20",
				},
				{
					fact: "item-same-atlas-block-blocks-atlas",
					status: "verified",
					since: "75.0",
					sourcePart: "1.21.11 / RP 75.0",
					checkedAt: "2026-09-20",
				},
				{
					fact: "texture-mipmap-fields",
					status: "verified",
					since: "75.0",
					sourcePart: "1.21.11 / RP 75.0",
					checkedAt: "2026-09-20",
				},
				{
					fact: "block-render-pass-auto",
					status: "verified",
					since: "84.0",
					sourcePart: "Java Edition 26.1 (Block model)",
					checkedAt: "2026-09-20",
				},
				{
					fact: "block-force-translucent",
					status: "verified",
					since: "84.0",
					sourcePart: "Java Edition 26.1 (Block model)",
					checkedAt: "2026-09-20",
				},
				{
					fact: "texture-png-only",
					status: "verified",
					since: "22.0",
					sourcePart: "1.20.3 / RP 22.0",
					checkedAt: "2026-09-20",
				},
				{
					fact: "item-model-definitions",
					status: "verified",
					since: "46.0",
					sourcePart: "1.21.4 / RP 46.0",
					checkedAt: "2026-09-21",
				},
				{
					fact: "gui-stretch-inner",
					status: "verified",
					since: "42.0",
					sourcePart: "1.21.2",
					checkedAt: "2026-09-22",
				},
			];
			for (const want of expected) {
				const found = byName.get(want.fact);
				check.ok(found !== undefined, `fact ${want.fact} present`);
				check.equal(found?.status, want.status, `${want.fact} status`);
				check.equal(
					found?.since.packFormat,
					want.since,
					`${want.fact} since.packFormat`,
				);
				check.ok(
					typeof found?.source === "string" &&
						found.source.includes(want.sourcePart) &&
						found.source.includes("§95"),
					`${want.fact} source cites origin and §95`,
				);
				check.equal(
					found?.checkedAt,
					want.checkedAt,
					`${want.fact} check date`,
				);
				check.ok(found?.value !== undefined, `${want.fact} value present`);
			}
			for (const fact of COMPAT_FACTS) {
				const since = fact.since.packFormat;
				check.ok(
					since !== undefined && /^\d+\.\d+$/.test(since),
					`${fact.fact}: since.packFormat is a normalized dotted major.minor string`,
				);
			}
		},
	},
	{
		name: "determined facts activate at since and never warn",
		run: (check) => {
			for (const fact of COMPAT_FACTS) {
				const since = fact.since.packFormat;
				if (since === undefined) {
					throw new Error(`${fact.fact} has no determined since.packFormat`);
				}
				check.equal(
					isFactActive(fact, since),
					true,
					`${fact.fact} active at its since ${since}`,
				);
				check.ok(
					resolveVersionedFact(fact, since) !== undefined,
					`${fact.fact} resolves at its since ${since}`,
				);
			}
			check.deepEqual(
				pendingSourceWarnings(),
				[],
				"no gate warnings once every fact is determined",
			);
		},
	},
	{
		name: "fact activation boundary follows since.packFormat",
		run: (check) => {
			check.equal(
				resolveVersionedFact(ITEMS_ATLAS_FACT, "1.0"),
				undefined,
				"packFormat 1.0 predates the fact",
			);
			check.equal(
				resolveVersionedFact(ITEMS_ATLAS_FACT, "74.0"),
				undefined,
				"74.0 stays below since 75.0",
			);
			check.ok(
				resolveVersionedFact(ITEMS_ATLAS_FACT, "75.0") !== undefined,
				"75.0 activates the fact",
			);
			check.ok(
				resolveVersionedFact(ITEMS_ATLAS_FACT, "999.0") !== undefined,
				"later formats keep the fact",
			);
		},
	},
	{
		name: "item-model-definitions gates at packFormat 46.0",
		run: (check) => {
			check.equal(
				isFactActive(ITEM_MODEL_DEFINITIONS_FACT, "45.0"),
				false,
				"45.0 predates item model definitions",
			);
			check.equal(
				resolveVersionedFact(ITEM_MODEL_DEFINITIONS_FACT, "45.0"),
				undefined,
				"45.0 does not resolve item model definitions",
			);
			for (const format of ["46.0", "75.0", "97.1"]) {
				check.equal(
					isFactActive(ITEM_MODEL_DEFINITIONS_FACT, format),
					true,
					`${format} activates item model definitions`,
				);
				check.ok(
					resolveVersionedFact(ITEM_MODEL_DEFINITIONS_FACT, format) !==
						undefined,
					`${format} resolves item model definitions`,
				);
			}
		},
	},
	{
		name: "dotted pack formats compare by (major, minor) tuples",
		run: (check) => {
			check.equal(normalizePackFormat("75"), "75.0", "N normalizes to N.0");
			check.equal(normalizePackFormat("97.1"), "97.1", "N.M stays as-is");
			check.ok(comparePackFormats("75.0", "75.0") === 0, "equal formats");
			check.ok(comparePackFormats("74.0", "75.0") < 0, "minor below");
			check.ok(comparePackFormats("84.0", "75.0") > 0, "major above");
			check.ok(comparePackFormats("97.1", "97.0") > 0, "minor above");
			check.ok(comparePackFormats("9.0", "75.0") < 0, "numeric, not lexical");
			check.ok(comparePackFormats("75.0", "999.0") < 0, "later stays above");
		},
	},
	{
		name: "1.21.11 facts stay active for all six supported versions",
		run: (check) => {
			for (const format of ["75.0", "84.0", "88.0", "97.1"]) {
				const facts: VersionedFact<unknown>[] = [
					ITEMS_ATLAS_FACT,
					ITEM_ATLAS_PLACEMENT_FACT,
					TEXTURE_MIPMAP_FACT,
				];
				for (const fact of facts) {
					check.equal(
						isFactActive(fact, format),
						true,
						`${fact.fact} active at ${format}`,
					);
				}
			}
		},
	},
	{
		name: "core keeps no compatibility references",
		run: (check) => {
			const coreDir = join(
				dirname(fileURLToPath(import.meta.url)),
				"../../src/core",
			);
			const files = readdirSync(coreDir)
				.filter((file) => file.endsWith(".ts"))
				.sort();
			check.ok(files.length > 0, "core files found");
			for (const file of files) {
				const text = readFileSync(join(coreDir, file), "utf8");
				check.ok(
					!text.includes("pack.mcmeta"),
					`${file} never reads pack.mcmeta`,
				);
				check.ok(
					!text.includes("resource location"),
					`${file} never names resource location`,
				);
				check.ok(
					!text.includes("../profiles") &&
						!text.includes("../validate") &&
						!text.includes("../cli"),
					`${file} imports no compatibility layer`,
				);
				if (file === "errors.ts") {
					continue;
				}
				check.ok(!/atlas/i.test(text), `${file} never names atlas`);
				check.ok(!/namespace/i.test(text), `${file} never names namespace`);
			}
			const errors = readFileSync(join(coreDir, "errors.ts"), "utf8");
			for (const token of [
				"ATLAS_REFERENCE_ERROR",
				"TEXTURE_NOT_IN_REQUIRED_ATLAS",
				"PACK_NAMESPACE_PROBLEM",
				"PACK_TEXTURE_NOT_IN_ATLAS",
			]) {
				check.ok(errors.includes(token), `frozen code ${token} kept`);
			}
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
