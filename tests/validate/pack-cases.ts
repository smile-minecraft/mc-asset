import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPack } from "../../src/validate/pack.ts";
import {
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
 * be a second code in every fixture. Engine cases pass packFormat 75.
 */
const VERSIONED = {
	packFormat: 75,
	target: "resource-pack 75 / packFormat 75",
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
];
