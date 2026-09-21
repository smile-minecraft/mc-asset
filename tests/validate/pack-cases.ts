import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPack } from "../../src/validate/pack.ts";
import {
	atlasJson,
	makeBadDimensionPngBytes,
	makePngBytes,
	modelJson,
	writeCleanBaseline,
	writePackFile,
} from "./pack-fixtures.ts";

/** Runner-agnostic assertion surface shared by the bun and node entries. */
export interface PackCaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface PackCase {
	name: string;
	run(check: PackCaseCheck): Promise<void>;
}

function codesOf(report: { findings: Array<{ code: string }> }): string[] {
	return report.findings.map((finding) => finding.code);
}

function uniqueCodes(report: { findings: Array<{ code: string }> }): string[] {
	return [...new Set(codesOf(report))].sort();
}

async function withPackDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Single-code isolation needs a determined version target: without a
 * version flag the engine reports PACK_VERSION_UNDETERMINED, which would
 * be a second code in every fixture. Engine cases pass packFormat "75.0".
 */
const VERSIONED = {
	packFormat: "75.0",
	target: "resource-pack 75.0",
};

export const PACK_CASES: PackCase[] = [
	{
		name: "pass: clean pack has no error findings",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "clean pack passes");
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"no error findings",
				);
				check.equal(report.command, "validate-pack", "command field");
			});
		},
	},
	{
		name: "warning: undetermined version without a flag",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				const report = await scanPack(dir, {});
				check.equal(report.verdict, "pass", "warning never fails");
				check.ok(
					codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"version warning present",
				);
				check.equal(
					report.findings.find((f) => f.code === "PACK_VERSION_UNDETERMINED")
						?.level,
					"warning",
					"warning level",
				);
			});
		},
	},
	{
		name: "pack.mcmeta pack.pack_format becomes the target with no flag",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"pack.mcmeta",
					modelJson({ pack: { pack_format: 75, description: "reads" } }),
				);
				const report = await scanPack(dir, {});
				check.equal(
					report.verdict,
					"pass",
					"pack with a versioned mcmeta passes",
				);
				check.ok(
					!codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"no undetermined warning when pack_format is usable",
				);
				check.equal(
					report.target,
					"pack.mcmeta resource-pack 75.0",
					"report target echoes the resolved dotted format",
				);
				check.ok(
					!JSON.stringify(report).includes("97.1"),
					"no hardcoded 97.1 default in the report",
				);
			});
		},
	},
	{
		name: "pack.mcmeta max_format wins over min_format and legacy pack_format",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"pack.mcmeta",
					modelJson({
						pack: {
							pack_format: 75,
							min_format: 84,
							max_format: 88,
							description: "range",
						},
					}),
				);
				const report = await scanPack(dir, {});
				check.equal(
					report.target,
					"pack.mcmeta resource-pack 88.0",
					"range resolves to max_format",
				);
				check.ok(
					!codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"no undetermined warning when max_format is usable",
				);
			});
		},
	},
	{
		name: "pack.mcmeta min_format is the fallback with no max_format",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"pack.mcmeta",
					modelJson({
						pack: { min_format: 84, description: "min only" },
					}),
				);
				const report = await scanPack(dir, {});
				check.equal(
					report.target,
					"pack.mcmeta resource-pack 84.0",
					"min-only resolves to min_format",
				);
				check.ok(
					!codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"no undetermined warning when min_format is usable",
				);
			});
		},
	},
	{
		name: "pack.mcmeta integer, array, and dotted-string forms normalize",
		run: async (check) => {
			const variants: Array<{
				name: string;
				pack: Record<string, unknown>;
				expected: string;
			}> = [
				{
					name: "integer max_format",
					pack: { max_format: 88, description: "t" },
					expected: "pack.mcmeta resource-pack 88.0",
				},
				{
					name: "array max_format",
					pack: { max_format: [97, 1], description: "t" },
					expected: "pack.mcmeta resource-pack 97.1",
				},
				{
					name: "dotted-string max_format",
					pack: { max_format: "84.0", description: "t" },
					expected: "pack.mcmeta resource-pack 84.0",
				},
				{
					name: "whole-string min_format",
					pack: { min_format: "75", description: "t" },
					expected: "pack.mcmeta resource-pack 75.0",
				},
				{
					name: "dotted legacy pack_format string",
					pack: { pack_format: "97.1", description: "t" },
					expected: "pack.mcmeta resource-pack 97.1",
				},
				{
					name: "legacy pack_format integer",
					pack: { pack_format: 75, description: "t" },
					expected: "pack.mcmeta resource-pack 75.0",
				},
			];
			for (const variant of variants) {
				await withPackDir(async (dir) => {
					await writeCleanBaseline(dir);
					await writePackFile(
						dir,
						"pack.mcmeta",
						modelJson({ pack: variant.pack }),
					);
					const report = await scanPack(dir, {});
					check.equal(
						report.target,
						variant.expected,
						`${variant.name} normalizes to dotted`,
					);
					check.ok(
						!codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
						`${variant.name} has no undetermined warning`,
					);
				});
			}
		},
	},
	{
		name: "pack.mcmeta malformed values fall through to the next field",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"pack.mcmeta",
					modelJson({
						pack: {
							max_format: "bogus",
							min_format: [84],
							pack_format: 75,
							description: "t",
						},
					}),
				);
				const report = await scanPack(dir, {});
				check.equal(
					report.target,
					"pack.mcmeta resource-pack 75.0",
					"malformed max/min fall through to legacy pack_format",
				);
				check.ok(
					!codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"no undetermined warning after fall-through",
				);
			});
		},
	},
	{
		name: "pack.mcmeta supported_formats never selects the target",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"pack.mcmeta",
					modelJson({
						pack: { description: "t" },
						supported_formats: { min_inclusive: 75, max_inclusive: 88 },
					}),
				);
				const report = await scanPack(dir, {});
				check.ok(
					codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"supported_formats alone leaves the version undetermined",
				);
				check.equal(
					report.target,
					"default (engine defaults)",
					"no target is borrowed from supported_formats",
				);
			});
		},
	},
	{
		name: "pack.mcmeta without a usable pack_format warns and skips with no default",
		run: async (check) => {
			const variants: Array<{ name: string; body: string }> = [
				{
					name: "missing key",
					body: modelJson({ pack: { description: "t" } }),
				},
				{
					name: "zero max_format with zero min and pack_format",
					body: modelJson({
						pack: { max_format: 0, min_format: 0, pack_format: 0 },
					}),
				},
				{
					name: "bad shapes everywhere",
					body: modelJson({
						pack: {
							max_format: "bogus",
							min_format: [84],
							pack_format: "nope",
							description: "t",
						},
					}),
				},
				{ name: "no pack section", body: modelJson({ note: "t" }) },
			];
			for (const variant of variants) {
				await withPackDir(async (dir) => {
					await writeCleanBaseline(dir);
					await writePackFile(dir, "pack.mcmeta", variant.body);
					const report = await scanPack(dir, {});
					check.equal(report.verdict, "pass", `${variant.name} still passes`);
					const undetermined = report.findings.find(
						(f) => f.code === "PACK_VERSION_UNDETERMINED",
					);
					check.ok(
						undetermined !== undefined,
						`${variant.name} warns undetermined`,
					);
					check.equal(
						undetermined?.level,
						"warning",
						`${variant.name} warns only`,
					);
					check.equal(
						undetermined?.message,
						"no version flag was given and pack.mcmeta carries no usable min_format/max_format or pack_format; version-dependent checks were skipped with no default applied.",
						`${variant.name} frozen wording`,
					);
					check.ok(
						!JSON.stringify(report).includes("97.1"),
						`${variant.name} never defaults to 97.1`,
					);
				});
			}
		},
	},
	{
		name: "unparseable pack.mcmeta is INVALID_JSON plus undetermined version",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(dir, "pack.mcmeta", "{ not valid json");
				const report = await scanPack(dir, {});
				check.equal(report.verdict, "fail", "broken mcmeta fails");
				check.ok(
					codesOf(report).includes("PACK_INVALID_JSON"),
					"INVALID_JSON finding present",
				);
				check.equal(
					report.findings.find((f) => f.code === "PACK_INVALID_JSON")?.level,
					"error",
					"INVALID_JSON is an error",
				);
				const undetermined = report.findings.find(
					(f) => f.code === "PACK_VERSION_UNDETERMINED",
				);
				check.ok(undetermined !== undefined, "version stays undetermined");
				check.equal(undetermined?.level, "warning", "undetermined warns only");
			});
		},
	},
	{
		name: "undetermined version report never hardcodes 97.1",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				const report = await scanPack(dir, {});
				check.ok(
					!JSON.stringify(report).includes("97.1"),
					"no 97.1 anywhere in the undetermined report",
				);
				check.ok(
					!codesOf(report).some((code) => code.includes("97")),
					"no 97-family finding code",
				);
			});
		},
	},
	{
		name: "fail: invalid JSON is a finding, scan continues past it",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/broken.json",
					"{ not valid json",
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "invalid JSON fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_INVALID_JSON"],
					"unreachable models carry no atlas verdict alongside the JSON error",
				);
			});
		},
	},
	{
		name: "fail: missing referenced texture",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/sword.json",
					modelJson({ textures: { layer0: "testpack:item/missing" } }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "missing texture fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_MISSING_TEXTURE"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: missing referenced parent asset",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/sword.json",
					modelJson({ parent: "testpack:item/missing_parent" }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "missing parent fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_MISSING_ASSET"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: texture png outside textures/ is a wrong path",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/misplaced/sword.png",
					makePngBytes(),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "misplaced texture fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_WRONG_PATH"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: namespace charset outsiders are a namespace problem",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/bad ns/models/item/sword.json",
					modelJson({ textures: { layer0: "bad ns:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/bad ns/textures/item/sword.png",
					makePngBytes(),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "bad namespace fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_NAMESPACE_PROBLEM"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: uppercase filename is a case mismatch, not a missing texture",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/Sword.png",
					makePngBytes(),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "uppercase stem fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_CASE_MISMATCH"],
					"only that code",
				);
				check.ok(
					!codesOf(report).includes("PACK_MISSING_TEXTURE"),
					"no missing-texture alongside",
				);
			});
		},
	},
	{
		name: "warning: orphan texture passes the verdict",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/lonely.png",
					makePngBytes(),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "orphan still passes");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_ORPHAN_TEXTURE"],
					"only that code",
				);
				check.equal(
					report.findings[0]?.level,
					"warning",
					"orphan is warning-only",
				);
			});
		},
	},
	{
		name: "fail: animation sheet that cannot hold its frames",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png.mcmeta",
					modelJson({ animation: { width: 3, height: 3 } }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "bad sheet fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_INVALID_ANIMATION_SHEET"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: out-of-range IHDR dimensions",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					makeBadDimensionPngBytes(0, 16),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "bad dimensions fail");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_INVALID_IMAGE_DIMENSION"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: non-string texture reference is broken",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					'{"textures": {"layer0": 123}}',
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "broken reference fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_BROKEN_REFERENCE"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: undecodable png bytes",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					"this is not a PNG file",
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "bad bytes fail");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_INVALID_IMAGE_DATA"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: empty filename stem",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/.png",
					makePngBytes(),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "empty stem fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_INVALID_FILENAME"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: one bad model never blocks the rest of the report",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/broken.json",
					"{ not valid json",
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "testpack:item/missing" } }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "pack fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_INVALID_JSON", "PACK_MISSING_TEXTURE"],
					"both problems reported",
				);
			});
		},
	},
	{
		name: "pass: textures covered by their required atlases",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/blockstates/stone.json",
					modelJson({
						variants: { "": { model: "minecraft:block/stone" } },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: { type: "minecraft:model", model: "minecraft:item/sword" },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([{ type: "directory", source: "block", prefix: "block/" }]),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/items.json",
					atlasJson([{ type: "single", resource: "minecraft:item/sword" }]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([{ type: "single", resource: "minecraft:block/stone" }]),
					);
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/items.json",
						atlasJson([{ type: "single", resource: "minecraft:item/sword" }]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "pass", "covered textures pass");
					check.equal(
						report.findings.filter((f) => f.level === "error").length,
						0,
						"no error findings",
					);
					check.ok(
						!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
						"no atlas accusation",
					);
					check.deepEqual(
						report.coverage,
						{ status: "complete", skipped: [] },
						"merged layers agree with complete coverage",
					);
				});
			});
		},
	},
	{
		name: "fail: existing texture absent from the required atlas",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/blockstates/stone.json",
					modelJson({
						variants: { "": { model: "minecraft:block/stone" } },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "fail", "unstitched texture fails");
					check.deepEqual(
						uniqueCodes(report),
						["PACK_TEXTURE_NOT_IN_ATLAS"],
						"only that code",
					);
					check.equal(
						report.findings[0]?.level,
						"error",
						"atlas miss is an error",
					);
					check.equal(
						report.findings[0]?.path,
						"assets/minecraft/models/block/stone.json",
						"finding points at the model",
					);
					check.ok(
						!codesOf(report).includes("PACK_MISSING_TEXTURE"),
						"never confused with a missing texture",
					);
				});
			});
		},
	},
	{
		name: "fail: missing texture stays missing even when its atlas is defined",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "testpack:block/gone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([]),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "missing texture fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_MISSING_TEXTURE"],
					"only that code",
				);
				check.ok(
					!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
					"no atlas accusation for a file that does not exist",
				);
			});
		},
	},
	{
		name: "fail: item texture outside the items atlas",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: { type: "minecraft:model", model: "minecraft:item/sword" },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/items.json",
					atlasJson([]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/items.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "fail", "item outside items fails");
					check.deepEqual(
						uniqueCodes(report),
						["PACK_TEXTURE_NOT_IN_ATLAS"],
						"only that code",
					);
				});
			});
		},
	},
	{
		name: "pass: packFormat below the atlas split skips atlas verdicts",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([]),
				);
				const report = await scanPack(dir, {
					packFormat: "74.0",
					target: "resource-pack 74.0",
				});
				check.equal(report.verdict, "pass", "below-split skips atlas");
				check.ok(
					!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
					"no atlas accusation below the split",
				);
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"no error findings",
				);
			});
		},
	},
	{
		name: "pass: undetermined version skips atlas verdicts",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([]),
				);
				const report = await scanPack(dir, {});
				check.equal(report.verdict, "pass", "undetermined skips atlas");
				check.ok(
					codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"version warning present",
				);
				check.ok(
					!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
					"no atlas accusation without a version",
				);
			});
		},
	},
	{
		name: "fail: pack.mcmeta pack_format lends the atlas target",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/blockstates/stone.json",
					modelJson({
						variants: { "": { model: "minecraft:block/stone" } },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([]),
				);
				await writePackFile(
					dir,
					"pack.mcmeta",
					modelJson({ pack: { pack_format: 75, description: "lends" } }),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, { vanillaPath: vanillaDir });
					check.equal(report.verdict, "fail", "lent version activates atlas");
					check.deepEqual(
						uniqueCodes(report),
						["PACK_TEXTURE_NOT_IN_ATLAS"],
						"only that code",
					);
				});
			});
		},
	},
	{
		name: "pass: unknown atlas source types never accuse",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/blockstates/stone.json",
					modelJson({
						variants: { "": { model: "minecraft:block/stone" } },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([{ type: "future-type", anything: true }]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "pass", "unknown sources skip");
					check.ok(
						!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
						"no accusation from an unreadable source",
					);
					check.ok(
						codesOf(report).includes("PACK_COVERAGE_SKIPPED"),
						"the gap stays visible as a warning",
					);
					check.deepEqual(
						report.coverage,
						{
							status: "partial",
							skipped: [
								{
									kind: "atlas-source",
									reason: "unsupported-source-type",
									target: "assets/minecraft/atlases/blocks.json",
									detail: `source type "future-type" is not interpreted`,
								},
							],
						},
						"coverage records the skip",
					);
				});
			});
		},
	},
	{
		name: "pass: atlas without vanilla is unknown, never an error",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/blockstates/stone.json",
					modelJson({
						variants: { "": { model: "minecraft:block/stone" } },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([{ type: "directory", source: "block", prefix: "block/" }]),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "unknown never fails");
				check.ok(
					!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
					"no accusation without the vanilla tree",
				);
				check.deepEqual(
					uniqueCodes(report),
					["PACK_COVERAGE_SKIPPED"],
					"only the coverage warning",
				);
				check.deepEqual(
					report.coverage,
					{
						status: "partial",
						skipped: [
							{
								kind: "atlas-source",
								reason: "vanilla-not-provided",
								target: "assets/minecraft/atlases/blocks.json",
								detail: `sprite "minecraft:block/stone" needs the vanilla atlas sources`,
							},
						],
					},
					"coverage records the missing context",
				);
			});
		},
	},
	{
		name: "fail: higher layer filter removes the vanilla sprite",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/blockstates/stone.json",
					modelJson({
						variants: { "": { model: "minecraft:block/stone" } },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([{ type: "filter", pattern: { path: "stone" } }]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([
							{ type: "directory", source: "block", prefix: "block/" },
						]),
					);
					await writePackFile(
						vanillaDir,
						"assets/minecraft/textures/block/stone.png",
						"",
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "fail", "filtered sprite fails");
					check.deepEqual(
						uniqueCodes(report),
						["PACK_TEXTURE_NOT_IN_ATLAS"],
						"only that code",
					);
				});
			});
		},
	},
	{
		name: "pass: unsupported regex skips with a warning, never an error",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/blockstates/stone.json",
					modelJson({
						variants: { "": { model: "minecraft:block/stone" } },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([
						{ type: "directory", source: "block", prefix: "block/" },
						{ type: "filter", pattern: { path: "(?>stone)" } },
					]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "pass", "unsupported regex skips");
					check.ok(
						!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
						"no accusation from an unapplied filter",
					);
					check.deepEqual(
						uniqueCodes(report),
						["PACK_COVERAGE_SKIPPED"],
						"only the coverage warning",
					);
					check.deepEqual(
						report.coverage,
						{
							status: "partial",
							skipped: [
								{
									kind: "atlas-filter",
									reason: "unsupported-regex",
									target: "assets/minecraft/atlases/blocks.json",
									detail: `filter pattern path "(?>stone)" needs a Java-only construct`,
								},
							],
						},
						"coverage records the filter skip",
					);
				});
			});
		},
	},
	{
		name: "pass: renamed single sprite covers the model reference",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/custom.json",
					modelJson({
						model: { type: "minecraft:model", model: "minecraft:item/custom" },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/custom.json",
					modelJson({ textures: { layer0: "minecraft:item/renamed" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/renamed.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/items.json",
					atlasJson([
						{
							type: "single",
							resource: "minecraft:item/sword",
							sprite: "minecraft:item/renamed",
						},
					]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/items.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "pass", "renamed sprite passes");
					check.ok(
						!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
						"lookup follows the sprite, not the resource path",
					);
					check.deepEqual(
						report.coverage,
						{ status: "complete", skipped: [] },
						"complete coverage",
					);
				});
			});
		},
	},
	{
		name: "pass: paletted permutations with missing palettes stay unknown",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/atlases/items.json",
					atlasJson([
						{
							type: "paletted_permutations",
							textures: ["minecraft:item/x"],
							palette_key: "minecraft:palette/key",
							permutations: { emerald: "minecraft:palette/emerald" },
						},
					]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/items.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "pass", "missing palettes skip");
					check.deepEqual(
						uniqueCodes(report),
						["PACK_COVERAGE_SKIPPED"],
						"only the coverage warning",
					);
					check.deepEqual(
						report.coverage,
						{
							status: "partial",
							skipped: [
								{
									kind: "atlas-source",
									reason: "missing-dependency",
									target: "assets/minecraft/atlases/items.json",
									detail: `sprite "minecraft:item/x_emerald" needs base texture "assets/minecraft/textures/item/x.png" (missing)`,
								},
							],
						},
						"coverage records the missing dependency",
					);
				});
			});
		},
	},
	{
		name: "deterministic: reruns are byte-identical and findings sort by path",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/b.json",
					modelJson({ textures: { layer0: "minecraft:item/gone_b" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/a.json",
					modelJson({ textures: { layer0: "minecraft:item/gone_a" } }),
				);
				const first = await scanPack(dir, VERSIONED);
				const second = await scanPack(dir, VERSIONED);
				check.deepEqual(second, first, "rerun is identical");
				check.deepEqual(
					JSON.stringify(first),
					JSON.stringify(second),
					"serialized rerun is byte-identical",
				);
				const paths = first.findings.map((f) => f.path ?? "");
				const sorted = [...paths].sort();
				check.deepEqual(paths, sorted, "findings sort by path");
			});
		},
	},
	{
		name: "pass: items/ definition with a resolvable model reference",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: { type: "minecraft:model", model: "minecraft:item/sword" },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: {} }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "resolvable items ref passes");
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"no error findings",
				);
			});
		},
	},
	{
		name: "fail: items/ definition pointing at a missing model",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: { type: "minecraft:model", model: "testpack:item/gone" },
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "missing items model fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_BROKEN_REFERENCE"],
					"only that code",
				);
				check.equal(
					report.findings[0]?.level,
					"error",
					"broken items reference is an error",
				);
				check.equal(
					report.findings[0]?.path,
					"assets/minecraft/items/sword.json",
					"finding points at the items definition",
				);
			});
		},
	},
	{
		name: "fail: items/ composite, condition, select, and range_dispatch branches resolve",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/a.json",
					modelJson({ textures: {} }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/b.json",
					modelJson({ textures: {} }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: {
							type: "minecraft:composite",
							models: [
								{ type: "minecraft:model", model: "minecraft:item/a" },
								{
									type: "minecraft:condition",
									property: "minecraft:selected",
									on_true: {
										type: "minecraft:model",
										model: "minecraft:item/a",
									},
									on_false: {
										type: "minecraft:model",
										model: "minecraft:item/b",
									},
								},
								{
									type: "minecraft:select",
									property: "minecraft:display_context",
									cases: [
										{
											when: "gui",
											model: {
												type: "minecraft:model",
												model: "minecraft:item/b",
											},
										},
									],
									fallback: { type: "minecraft:empty" },
								},
								{
									type: "minecraft:range_dispatch",
									property: "minecraft:count",
									entries: [
										{
											threshold: 0.5,
											model: {
												type: "minecraft:model",
												model: "testpack:item/gone",
											},
										},
									],
									fallback: {
										type: "minecraft:model",
										model: "minecraft:item/a",
									},
								},
							],
						},
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "nested missing model fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_BROKEN_REFERENCE"],
					"only that code",
				);
				check.equal(
					report.findings[0]?.path,
					"assets/minecraft/items/sword.json",
					"finding points at the items definition",
				);
			});
		},
	},
	{
		name: "pass: items/ special, tag, and unknown types never accuse",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/chest.json",
					modelJson({
						model: {
							type: "minecraft:composite",
							models: [
								{
									type: "minecraft:special",
									model: { type: "minecraft:chest" },
									base: "minecraft:item/gone",
								},
								{
									type: "minecraft:model",
									model: "#minecraft:unresolvable_tag",
								},
								{ type: "minecraft:empty" },
								{ type: "minecraft:bundle/selected_item" },
								{
									type: "minecraft:future_type",
									model: "minecraft:item/also_gone",
								},
							],
						},
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "unresolvable shapes skip");
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"no error findings",
				);
				check.ok(
					!codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"no broken-reference accusation",
				);
			});
		},
	},
	{
		name: "pass: items/ check stays off below the 46.0 gate",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: { type: "minecraft:model", model: "minecraft:item/gone" },
					}),
				);
				const report = await scanPack(dir, {
					packFormat: "42.0",
					target: "resource-pack 42.0",
				});
				check.equal(report.verdict, "pass", "below-gate skips items");
				check.ok(
					!codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"no items accusation below the gate",
				);
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"no error findings",
				);
			});
		},
	},
	{
		name: "fail: items/ gate opens exactly at 46.0",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: { type: "minecraft:model", model: "testpack:item/gone" },
					}),
				);
				const atGate = await scanPack(dir, {
					packFormat: "46.0",
					target: "resource-pack 46.0",
				});
				check.equal(atGate.verdict, "fail", "46.0 runs the items check");
				check.deepEqual(
					uniqueCodes(atGate),
					["PACK_BROKEN_REFERENCE"],
					"only that code at the gate",
				);
				const belowGate = await scanPack(dir, {
					packFormat: "45.0",
					target: "resource-pack 45.0",
				});
				check.equal(belowGate.verdict, "pass", "45.0 skips the items check");
				check.ok(
					!codesOf(belowGate).includes("PACK_BROKEN_REFERENCE"),
					"no items accusation at 45.0",
				);
			});
		},
	},
	{
		name: "pass: items/ check stays off without a determinable version",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: { type: "minecraft:model", model: "minecraft:item/gone" },
					}),
				);
				const report = await scanPack(dir, {});
				check.equal(report.verdict, "pass", "undetermined skips items");
				check.ok(
					codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"version warning present",
				);
				check.ok(
					!codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"no items accusation without a version",
				);
			});
		},
	},
	{
		name: "fail: items/ model reference differing by case only",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: { type: "minecraft:model", model: "minecraft:item/Sword" },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: {} }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "case-only difference fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_CASE_MISMATCH"],
					"only that code",
				);
				check.ok(
					!codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"never confused with a broken reference",
				);
			});
		},
	},
	{
		name: "pack.mcmeta integer max_format 64 resolves as the old-regime boundary",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"pack.mcmeta",
					modelJson({ pack: { max_format: 64, description: "old regime" } }),
				);
				const report = await scanPack(dir, {});
				check.equal(
					report.target,
					"pack.mcmeta resource-pack 64.0",
					"integer 64 normalizes to dotted",
				);
				check.ok(
					!codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"no undetermined warning at the old-regime boundary",
				);
			});
		},
	},
	{
		name: "pack.mcmeta dotted 69.0 range resolves as the new-regime boundary",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"pack.mcmeta",
					modelJson({
						pack: {
							min_format: "69.0",
							max_format: [69, 0],
							description: "new regime",
						},
					}),
				);
				const report = await scanPack(dir, {});
				check.equal(
					report.target,
					"pack.mcmeta resource-pack 69.0",
					"max_format wins in dotted form",
				);
				check.ok(
					!codesOf(report).includes("PACK_VERSION_UNDETERMINED"),
					"no undetermined warning at the new-regime boundary",
				);
			});
		},
	},
	{
		name: "pass: nine_slice border inside the design size stays quiet",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png.mcmeta",
					modelJson({
						gui: {
							scaling: {
								type: "nine_slice",
								width: 4,
								height: 4,
								border: { left: 1, top: 1, right: 1, bottom: 1 },
							},
						},
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "fitting border passes");
				check.ok(
					!codesOf(report).includes("PACK_GUI_SCALING_BORDER"),
					"no gui border finding",
				);
			});
		},
	},
	{
		name: "fail: nine_slice border sums equal to the design size",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png.mcmeta",
					modelJson({
						gui: {
							scaling: {
								type: "nine_slice",
								width: 4,
								height: 4,
								border: { left: 2, top: 2, right: 2, bottom: 2 },
							},
						},
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "equal sums fail");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_GUI_SCALING_BORDER"],
					"only that code",
				);
			});
		},
	},
	{
		name: "fail: nine_slice border sums beyond the design size",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png.mcmeta",
					modelJson({
						gui: {
							scaling: {
								type: "nine_slice",
								width: 4,
								height: 4,
								border: { left: 3, top: 1, right: 3, bottom: 1 },
							},
						},
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "overflow fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_GUI_SCALING_BORDER"],
					"only that code",
				);
			});
		},
	},
	{
		name: "pass: builtin item template parent resolves without any file",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ parent: "minecraft:item/generated" }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "builtin hit passes");
				check.deepEqual(uniqueCodes(report), [], "no findings at all");
				check.ok(
					!codesOf(report).includes("PACK_MISSING_ASSET"),
					"never accused as a missing asset",
				);
				check.deepEqual(
					report.coverage,
					{ status: "complete", skipped: [] },
					"builtin hit needs no coverage skip",
				);
			});
		},
	},
	{
		name: "pass: vanilla texture without a vanilla tree is unresolved, not missing",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "unresolved never fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_UNRESOLVED_EXTERNAL"],
					"only the unresolved warning",
				);
				check.ok(
					!codesOf(report).includes("PACK_MISSING_TEXTURE"),
					"never accused as a missing texture",
				);
				check.deepEqual(
					report.coverage,
					{
						status: "partial",
						skipped: [
							{
								kind: "external-reference",
								reason: "vanilla-not-provided",
								target: "minecraft:item/sword",
							},
						],
					},
					"coverage records the skip",
				);
			});
		},
	},
	{
		name: "pass: one unresolved warning per target no matter how many referrers",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/a.json",
					modelJson({ parent: "minecraft:item/sword" }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/b.json",
					modelJson({
						parent: "minecraft:item/sword",
						textures: { layer0: "minecraft:item/generated_tex" },
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "unresolved never fails");
				check.equal(
					report.findings.filter(
						(finding) => finding.code === "PACK_UNRESOLVED_EXTERNAL",
					).length,
					2,
					"one warning per distinct target",
				);
				check.deepEqual(
					report.coverage,
					{
						status: "partial",
						skipped: [
							{
								kind: "external-reference",
								reason: "vanilla-not-provided",
								target: "minecraft:item/generated_tex",
							},
							{
								kind: "external-reference",
								reason: "vanilla-not-provided",
								target: "minecraft:item/sword",
							},
						],
					},
					"skips sort by target bytes",
				);
			});
		},
	},
	{
		name: "pass: items/ definition pointing at vanilla is unresolved without a tree",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/sword.json",
					modelJson({
						model: { type: "minecraft:model", model: "minecraft:item/sword" },
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "unresolved never fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_UNRESOLVED_EXTERNAL"],
					"only the unresolved warning",
				);
				check.ok(
					!codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"never accused as a broken reference",
				);
			});
		},
	},
	{
		name: "pass: vanilla tree resolves the parent with complete coverage",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ parent: "minecraft:item/generated" }),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/models/item/generated.json",
						modelJson({ parent: "minecraft:builtin/generated" }),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "pass", "vanilla hit passes");
					check.deepEqual(uniqueCodes(report), [], "no findings at all");
					check.deepEqual(
						report.coverage,
						{ status: "complete", skipped: [] },
						"coverage is complete",
					);
				});
			});
		},
	},
	{
		name: "fail: provided vanilla tree still missing is a determined missing asset",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ parent: "minecraft:item/gone" }),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/models/item/other.json",
						modelJson({ textures: {} }),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "fail", "determined missing fails");
					check.deepEqual(
						uniqueCodes(report),
						["PACK_MISSING_ASSET"],
						"missing error returns",
					);
					check.deepEqual(
						report.coverage,
						{ status: "complete", skipped: [] },
						"no skip when the miss is determined",
					);
				});
			});
		},
	},
	{
		name: "fail: provided vanilla tree still missing texture is a determined miss",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/sword.json",
					modelJson({ textures: { layer0: "testpack:item/gone" } }),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/models/item/generated.json",
						modelJson({ textures: {} }),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(report.verdict, "fail", "non-minecraft miss fails");
					check.deepEqual(
						uniqueCodes(report),
						["PACK_MISSING_TEXTURE"],
						"missing error even with vanilla around",
					);
				});
			});
		},
	},
	{
		name: "pass: dependency pack resolves the parent with complete coverage",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/sword.json",
					modelJson({ parent: "testpack:item/base" }),
				);
				await withPackDir(async (depDir) => {
					await writePackFile(
						depDir,
						"assets/testpack/models/item/base.json",
						modelJson({ textures: {} }),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						dependencyPaths: [depDir],
					});
					check.equal(report.verdict, "pass", "dependency hit passes");
					check.deepEqual(uniqueCodes(report), [], "no findings at all");
					check.deepEqual(
						report.coverage,
						{ status: "complete", skipped: [] },
						"coverage is complete",
					);
				});
			});
		},
	},
	{
		name: "fail: case-only difference against a dependency file is still a mismatch",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/sword.json",
					modelJson({ textures: { layer0: "testpack:item/sword" } }),
				);
				await withPackDir(async (depDir) => {
					await writePackFile(
						depDir,
						"assets/testpack/textures/item/Sword.png",
						makePngBytes(),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						dependencyPaths: [depDir],
					});
					check.equal(report.verdict, "fail", "case mismatch fails");
					check.deepEqual(
						uniqueCodes(report),
						["PACK_CASE_MISMATCH"],
						"only the mismatch code",
					);
				});
			});
		},
	},
	{
		name: "pass: clean pack reports complete coverage",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/items.json",
						atlasJson([{ type: "single", resource: "minecraft:item/sword" }]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.deepEqual(
						report.coverage,
						{ status: "complete", skipped: [] },
						"no skips means complete",
					);
				});
			});
		},
	},
	{
		name: "fail: tile scaling without design dimensions",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png.mcmeta",
					modelJson({ gui: { scaling: { type: "tile" } } }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "missing dimensions fail");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_GUI_SCALING_BORDER"],
					"only that code",
				);
			});
		},
	},
	{
		name: "red: texture variable self expansion never misjudges as a path",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/sword.json",
					modelJson({
						textures: {
							base: "testpack:item/real",
							layer0: "#base",
						},
					}),
				);
				await writePackFile(
					dir,
					"assets/testpack/textures/item/real.png",
					makePngBytes(),
				);
				const report = await scanPack(dir, VERSIONED);
				check.ok(
					!codesOf(report).includes("PACK_INVALID_FILENAME"),
					"no filename misjudgment for #var",
				);
				check.ok(
					!codesOf(report).includes("PACK_WRONG_PATH"),
					"no wrong-path misjudgment for #var",
				);
				check.ok(
					!codesOf(report).includes("PACK_MISSING_TEXTURE"),
					"resolved variable is not missing",
				);
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"self expansion passes",
				);
			});
		},
	},
	{
		name: "red: texture variable inherits along the parent chain",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/child.json",
					modelJson({
						parent: "testpack:item/base",
						textures: { layer0: "#base" },
					}),
				);
				await writePackFile(
					dir,
					"assets/testpack/models/item/base.json",
					modelJson({ textures: { base: "testpack:item/real" } }),
				);
				await writePackFile(
					dir,
					"assets/testpack/textures/item/real.png",
					makePngBytes(),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"parent inheritance passes",
				);
				check.ok(
					!codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"no broken reference when the parent defines the variable",
				);
			});
		},
	},
	{
		name: "red: texture variable cycle is PACK_REFERENCE_CYCLE",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/loop.json",
					modelJson({ textures: { a: "#b", b: "#a" } }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "variable cycle fails");
				check.ok(
					codesOf(report).includes("PACK_REFERENCE_CYCLE"),
					"cycle code present",
				);
			});
		},
	},
	{
		name: "red: parent cycle is PACK_REFERENCE_CYCLE with the chain",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/a.json",
					modelJson({ parent: "testpack:item/b" }),
				);
				await writePackFile(
					dir,
					"assets/testpack/models/item/b.json",
					modelJson({ parent: "testpack:item/a" }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "parent cycle fails");
				check.ok(
					codesOf(report).includes("PACK_REFERENCE_CYCLE"),
					"cycle code present",
				);
				const cycle = report.findings.find(
					(f) => f.code === "PACK_REFERENCE_CYCLE",
				);
				check.ok(
					(cycle?.message ?? "").includes("a.json") &&
						(cycle?.message ?? "").includes("b.json"),
					"message carries the cycle chain",
				);
			});
		},
	},
	{
		name: "red: unresolved texture variable names the variable and field",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/sword.json",
					modelJson({ textures: { layer0: "#missing_var" } }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "unresolved variable fails");
				check.ok(
					codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"broken reference present",
				);
				const broken = report.findings.find(
					(f) => f.code === "PACK_BROKEN_REFERENCE",
				);
				check.ok(
					(broken?.message ?? "").includes("#missing_var"),
					"message names the variable",
				);
				check.ok(
					(broken?.message ?? "").includes("textures.layer0"),
					"message carries the field path",
				);
			});
		},
	},
	{
		name: "red: blockstates variants and multipart resolve with field paths",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/block/stone.json",
					modelJson({ textures: {} }),
				);
				await writePackFile(
					dir,
					"assets/testpack/models/block/other.json",
					modelJson({ textures: {} }),
				);
				await writePackFile(
					dir,
					"assets/testpack/blockstates/stone.json",
					modelJson({
						variants: {
							"axis=y": { model: "testpack:block/stone" },
							"axis=x": [{ model: "testpack:block/other" }],
						},
						multipart: [
							{ apply: { model: "testpack:block/stone" } },
							{
								apply: [
									{ model: "testpack:block/other" },
									{ model: "testpack:block/stone" },
								],
							},
						],
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"well-formed blockstates pass",
				);
			});
		},
	},
	{
		name: "red: blockstates bad shape is PACK_BROKEN_REFERENCE",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/blockstates/stone.json",
					modelJson({ variants: { "axis=y": 123 } }),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "bad blockstate shape fails");
				check.ok(
					codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"broken reference present",
				);
			});
		},
	},
	{
		name: "red: blockstates missing model carries its field path",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/blockstates/stone.json",
					modelJson({
						variants: { "axis=y": { model: "testpack:block/gone" } },
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "missing blockstate model fails");
				check.ok(
					codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"non-minecraft miss is broken",
				);
				const broken = report.findings.find(
					(f) => f.code === "PACK_BROKEN_REFERENCE",
				);
				check.ok(
					(broken?.message ?? "").includes('variants["axis=y"].model'),
					"message carries the variants field path",
				);
			});
		},
	},
	{
		name: "red: items special.base missing model is diagnosed with coverage",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/items/chest.json",
					modelJson({
						model: {
							type: "minecraft:special",
							base: "testpack:item/gone",
							model: { type: "minecraft:chest" },
						},
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "missing special base fails");
				check.ok(
					codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"broken reference present",
				);
				check.ok(
					codesOf(report).includes("PACK_COVERAGE_SKIPPED"),
					"renderer fields stay visible as coverage",
				);
				check.ok(
					report.coverage.skipped.some(
						(s) =>
							s.kind === "item-model-special" &&
							s.reason === "renderer-fields-not-interpreted",
					),
					"special skip recorded",
				);
			});
		},
	},
	{
		name: "red: items unknown namespace type skips without accusing",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/items/custom.json",
					modelJson({
						model: {
							type: "custom:my_renderer",
							model: "testpack:item/gone",
						},
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"custom renderer never accuses",
				);
				check.ok(
					report.coverage.skipped.some(
						(s) =>
							s.kind === "item-model-node" && s.reason === "unknown-node-type",
					),
					"unknown node skip recorded",
				);
			});
		},
	},
	{
		name: "red: items minecraft unknown type skips without accusing",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/future.json",
					modelJson({
						model: {
							type: "minecraft:future_type",
							model: "minecraft:item/gone",
						},
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"unknown minecraft type never accuses",
				);
				check.ok(
					report.coverage.skipped.some(
						(s) =>
							s.kind === "item-model-node" && s.reason === "unknown-node-type",
					),
					"unknown node skip recorded",
				);
			});
		},
	},
	{
		name: "red: items empty and bundle selected item never accuse",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/items/kit.json",
					modelJson({
						model: {
							type: "minecraft:composite",
							models: [
								{ type: "minecraft:empty" },
								{ type: "minecraft:bundle/selected_item" },
								{ type: "bundle/selected_item" },
							],
						},
					}),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
					"empty leaves pass",
				);
			});
		},
	},
	{
		name: "red: atlas follows items usage, not the models/ path",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/block/stone.json",
					modelJson({ textures: { all: "testpack:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/testpack/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/testpack/items/stone.json",
					modelJson({
						model: { type: "minecraft:model", model: "testpack:block/stone" },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([{ type: "directory", source: "block", prefix: "block/" }]),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/items.json",
					atlasJson([]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([]),
					);
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/items.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(
						report.verdict,
						"fail",
						"items usage needs the items atlas",
					);
					check.ok(
						codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
						"atlas miss present",
					);
					const miss = report.findings.find(
						(f) => f.code === "PACK_TEXTURE_NOT_IN_ATLAS",
					);
					check.ok(
						(miss?.message ?? "").includes('"items"'),
						"miss names the items atlas, not blocks",
					);
				});
			});
		},
	},
	{
		name: "red: atlas follows blockstate usage, not the models/ path",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/sword.json",
					modelJson({ textures: { layer0: "testpack:item/sword" } }),
				);
				await writePackFile(
					dir,
					"assets/testpack/textures/item/sword.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/testpack/blockstates/sword.json",
					modelJson({
						variants: { "": { model: "testpack:item/sword" } },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/items.json",
					atlasJson([{ type: "single", resource: "testpack:item/sword" }]),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([]),
					);
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/items.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(
						report.verdict,
						"fail",
						"blockstate usage needs the blocks atlas",
					);
					const miss = report.findings.find(
						(f) => f.code === "PACK_TEXTURE_NOT_IN_ATLAS",
					);
					check.ok(
						(miss?.message ?? "").includes('"blocks"'),
						"miss names the blocks atlas, not items",
					);
				});
			});
		},
	},
	{
		name: "red: atlas dual usage needs both atlases",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/block/stone.json",
					modelJson({ textures: { all: "testpack:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/testpack/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/testpack/items/stone.json",
					modelJson({
						model: { type: "minecraft:model", model: "testpack:block/stone" },
					}),
				);
				await writePackFile(
					dir,
					"assets/testpack/blockstates/stone.json",
					modelJson({
						variants: { "": { model: "testpack:block/stone" } },
					}),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/items.json",
					atlasJson([{ type: "single", resource: "testpack:block/stone" }]),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([]),
					);
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/items.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(
						report.verdict,
						"fail",
						"dual usage still needs the blocks atlas",
					);
					const miss = report.findings.find(
						(f) => f.code === "PACK_TEXTURE_NOT_IN_ATLAS",
					);
					check.ok(
						(miss?.message ?? "").includes('"blocks"'),
						"miss names the blocks atlas even though items covers it",
					);
				});
			});
		},
	},
	{
		name: "red: atlas unreachable models are never accused",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/block/stone.json",
					modelJson({ textures: { all: "testpack:block/stone" } }),
				);
				await writePackFile(
					dir,
					"assets/testpack/textures/block/stone.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/atlases/blocks.json",
					atlasJson([]),
				);
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						vanillaDir,
						"assets/minecraft/atlases/blocks.json",
						atlasJson([]),
					);
					const report = await scanPack(dir, {
						...VERSIONED,
						vanillaPath: vanillaDir,
					});
					check.equal(
						report.verdict,
						"pass",
						"unreachable models skip the atlas verdict",
					);
					check.ok(
						!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
						"no atlas accusation without an entry",
					);
				});
			});
		},
	},
	{
		name: "red: orphan names covered sources instead of definite disuse",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/lonely.png",
					makePngBytes(),
				);
				const report = await scanPack(dir, VERSIONED);
				check.deepEqual(
					uniqueCodes(report),
					["PACK_ORPHAN_TEXTURE"],
					"only that code",
				);
				check.ok(
					(report.findings[0]?.message ?? "").includes(
						"covered reference source",
					),
					"orphan message describes covered sources",
				);
				check.ok(
					!(report.findings[0]?.message ?? "").includes("never referenced"),
					"old definite wording is gone",
				);
			});
		},
	},
	{
		name: "red: unreachable models still report format errors",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/lonely.json",
					'{"textures": {"layer0": 123}}',
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "format errors still fail");
				check.ok(
					codesOf(report).includes("PACK_BROKEN_REFERENCE"),
					"broken reference present without any entry",
				);
			});
		},
	},
];
