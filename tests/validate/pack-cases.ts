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
					"only that code",
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
					"assets/minecraft/models/item/sword.json",
					modelJson({ textures: { layer0: "minecraft:item/missing" } }),
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
					"assets/minecraft/models/item/sword.json",
					modelJson({ parent: "minecraft:item/missing_parent" }),
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
					modelJson({ textures: { layer0: "minecraft:item/missing" } }),
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
					atlasJson([{ type: "directory", source: "block", prefix: "block" }]),
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
				const report = await scanPack(dir, VERSIONED);
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
			});
		},
	},
	{
		name: "fail: existing texture absent from the required atlas",
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
				const report = await scanPack(dir, VERSIONED);
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
		},
	},
	{
		name: "fail: missing texture stays missing even when its atlas is defined",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/block/stone.json",
					modelJson({ textures: { all: "minecraft:block/gone" } }),
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
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "fail", "item outside items fails");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_TEXTURE_NOT_IN_ATLAS"],
					"only that code",
				);
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
				const report = await scanPack(dir, {});
				check.equal(report.verdict, "fail", "lent version activates atlas");
				check.deepEqual(
					uniqueCodes(report),
					["PACK_TEXTURE_NOT_IN_ATLAS"],
					"only that code",
				);
			});
		},
	},
	{
		name: "pass: unknown atlas source types never accuse",
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
					atlasJson([{ type: "future-type", anything: true }]),
				);
				const report = await scanPack(dir, VERSIONED);
				check.equal(report.verdict, "pass", "unknown sources skip");
				check.ok(
					!codesOf(report).includes("PACK_TEXTURE_NOT_IN_ATLAS"),
					"no accusation from an unreadable source",
				);
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
						model: { type: "minecraft:model", model: "minecraft:item/gone" },
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
												model: "minecraft:item/gone",
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
						model: { type: "minecraft:model", model: "minecraft:item/gone" },
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
];
