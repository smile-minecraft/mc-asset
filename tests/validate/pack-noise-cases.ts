import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPack } from "../../src/validate/pack.ts";
import {
	makePngBytes,
	writeCleanBaseline,
	writePackFile,
} from "./pack-fixtures.ts";
import type { PackCaseCheck } from "./pack-model-cases.ts";

export interface PackNoiseCase {
	name: string;
	run(check: PackCaseCheck): Promise<void>;
}

async function withPackDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-noise-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const DEFAULT_OPTIONS = { packFormat: "46.0" };

export const PACK_NOISE_CASES: PackNoiseCase[] = [
	{
		name: "pack noise: assets root .DS_Store is silently ignored without findings",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/.DS_Store",
					"dummy desktop services store binary",
				);
				const report = await scanPack(dir, DEFAULT_OPTIONS);
				check.equal(report.verdict, "pass");
				check.equal(report.findings.length, 0);
				check.equal(report.coverage.status, "complete");
				check.equal(report.coverage.skipped.length, 0);
			});
		},
	},
	{
		name: "pack noise: deep nested .DS_Store inside namespace is silently ignored",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/.DS_Store",
					"dummy nested store",
				);
				const report = await scanPack(dir, DEFAULT_OPTIONS);
				check.equal(report.verdict, "pass");
				check.equal(report.findings.length, 0);
				check.equal(report.coverage.status, "complete");
			});
		},
	},
	{
		name: "pack noise: Windows Thumbs.db and desktop.ini are silently ignored",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/Thumbs.db",
					"dummy thumbs cache",
				);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/desktop.ini",
					"[.ShellClassInfo]\nIconResource=...",
				);
				const report = await scanPack(dir, DEFAULT_OPTIONS);
				check.equal(report.verdict, "pass");
				check.equal(report.findings.length, 0);
				check.equal(report.coverage.status, "complete");
			});
		},
	},
	{
		name: "pack noise: macOS AppleDouble ._ prefix file is silently ignored",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/._sword.png",
					"Mac OS X resource fork payload",
				);
				const report = await scanPack(dir, DEFAULT_OPTIONS);
				check.equal(report.verdict, "pass");
				check.equal(report.findings.length, 0);
				check.equal(report.coverage.status, "complete");
			});
		},
	},
	{
		name: "pack noise: __MACOSX directory tree mirror is silently ignored",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/__MACOSX/assets/minecraft/textures/item/sword.png",
					"resource fork inside __MACOSX mirror",
				);
				const report = await scanPack(dir, DEFAULT_OPTIONS);
				check.equal(report.verdict, "pass");
				check.equal(report.findings.length, 0);
				check.equal(report.coverage.status, "complete");
			});
		},
	},
	{
		name: "pack noise: system file differences between two packs produce identical reports",
		run: async (check) => {
			await withPackDir(async (baseDir) => {
				await withPackDir(async (noisyDir) => {
					await writeCleanBaseline(baseDir);
					await writeCleanBaseline(noisyDir);

					await writePackFile(noisyDir, "assets/.DS_Store", "binary store");
					await writePackFile(
						noisyDir,
						"assets/minecraft/.DS_Store",
						"binary store",
					);
					await writePackFile(
						noisyDir,
						"assets/minecraft/textures/item/Thumbs.db",
						"thumbs",
					);
					await writePackFile(
						noisyDir,
						"assets/minecraft/textures/item/desktop.ini",
						"ini",
					);
					await writePackFile(
						noisyDir,
						"assets/minecraft/textures/item/._sword.png",
						"fork",
					);
					await writePackFile(
						noisyDir,
						"assets/__MACOSX/assets/minecraft/textures/item/sword.png",
						"mac",
					);

					const baseReport = await scanPack(baseDir, DEFAULT_OPTIONS);
					const noisyReport = await scanPack(noisyDir, DEFAULT_OPTIONS);

					check.equal(noisyReport.verdict, baseReport.verdict);
					check.deepEqual(noisyReport.findings, baseReport.findings);
					check.deepEqual(noisyReport.coverage, baseReport.coverage);
				});
			});
		},
	},
	{
		name: "pack noise: uninterpreted directory skips per-file checks and retains single coverage skip and warning",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/minecraft/unused/invalid.json",
					"{ unclosed json",
				);
				await writePackFile(
					dir,
					"assets/minecraft/unused/bad filename.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/unused/corrupt.png",
					"not real png data",
				);

				const report = await scanPack(dir, DEFAULT_OPTIONS);
				check.equal(report.verdict, "pass");
				check.equal(
					report.findings.filter((f) => f.level === "error").length,
					0,
				);

				const skips = report.coverage.skipped.filter(
					(s) =>
						s.kind === "uninterpreted-resource" &&
						s.target === "assets/minecraft/unused",
				);
				check.equal(skips.length, 1);
				check.equal(skips[0]?.reason, "resource-type-not-interpreted: unused");

				const warnings = report.findings.filter(
					(f) =>
						f.code === "PACK_COVERAGE_SKIPPED" &&
						f.path === "assets/minecraft/unused",
				);
				check.equal(warnings.length, 1);
				check.equal(warnings[0]?.level, "warning");
				check.ok(warnings[0]?.message.includes("unused"));
			});
		},
	},
	{
		name: "pack noise: uninterpreted directory skips per-file checks while checked models directory still reports misplaced png",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/minecraft/unused/broken.json",
					"{ bad",
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/misplaced.png",
					makePngBytes(),
				);

				const report = await scanPack(dir, DEFAULT_OPTIONS);
				check.equal(report.verdict, "fail");

				const errors = report.findings.filter((f) => f.level === "error");
				check.equal(errors.length, 1);
				check.equal(errors[0]?.code, "PACK_WRONG_PATH");
				check.equal(
					errors[0]?.path,
					"assets/minecraft/models/item/misplaced.png",
				);

				const skips = report.coverage.skipped.filter(
					(s) =>
						s.kind === "uninterpreted-resource" &&
						s.target === "assets/minecraft/unused",
				);
				check.equal(skips.length, 1);
			});
		},
	},
	{
		name: "pack noise: vanilla override texture suppresses orphan finding when vanilla tree is provided",
		run: async (check) => {
			await withPackDir(async (packDir) => {
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						packDir,
						"assets/minecraft/textures/block/stone.png",
						makePngBytes(),
					);
					await writePackFile(
						vanillaDir,
						"assets/minecraft/textures/block/stone.png",
						makePngBytes(),
					);

					const report = await scanPack(packDir, {
						vanillaPath: vanillaDir,
						packFormat: "46.0",
					});
					check.equal(report.verdict, "pass");
					const orphans = report.findings.filter(
						(f) => f.code === "PACK_ORPHAN_TEXTURE",
					);
					check.equal(orphans.length, 0);
				});
			});
		},
	},
	{
		name: "pack noise: vanilla override texture without vanilla tree retains orphan warning",
		run: async (check) => {
			await withPackDir(async (packDir) => {
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						packDir,
						"assets/minecraft/textures/block/stone.png",
						makePngBytes(),
					);
					await writePackFile(
						vanillaDir,
						"assets/minecraft/textures/block/stone.png",
						makePngBytes(),
					);

					const reportWithoutVanilla = await scanPack(packDir, {
						packFormat: "46.0",
					});
					const reportWithVanilla = await scanPack(packDir, {
						vanillaPath: vanillaDir,
						packFormat: "46.0",
					});

					const orphansWithout = reportWithoutVanilla.findings.filter(
						(f) => f.code === "PACK_ORPHAN_TEXTURE",
					);
					check.equal(orphansWithout.length, 1);
					check.equal(
						orphansWithout[0]?.path,
						"assets/minecraft/textures/block/stone.png",
					);

					const orphansWith = reportWithVanilla.findings.filter(
						(f) => f.code === "PACK_ORPHAN_TEXTURE",
					);
					check.equal(orphansWith.length, 0);
				});
			});
		},
	},
	{
		name: "pack noise: custom new texture absent from vanilla retains orphan warning while override texture is suppressed",
		run: async (check) => {
			await withPackDir(async (packDir) => {
				await withPackDir(async (vanillaDir) => {
					await writePackFile(
						packDir,
						"assets/minecraft/textures/block/stone.png",
						makePngBytes(),
					);
					await writePackFile(
						packDir,
						"assets/minecraft/textures/block/custom_gem.png",
						makePngBytes(),
					);
					await writePackFile(
						vanillaDir,
						"assets/minecraft/textures/block/stone.png",
						makePngBytes(),
					);

					const report = await scanPack(packDir, {
						vanillaPath: vanillaDir,
						packFormat: "46.0",
					});

					const orphans = report.findings.filter(
						(f) => f.code === "PACK_ORPHAN_TEXTURE",
					);
					check.equal(orphans.length, 1);
					check.equal(
						orphans[0]?.path,
						"assets/minecraft/textures/block/custom_gem.png",
					);
				});
			});
		},
	},
];
