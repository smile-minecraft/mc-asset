import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPack } from "../../src/validate/pack.ts";
import {
	makePngBytes,
	modelJson,
	writeCleanBaseline,
	writePackFile,
} from "./pack-fixtures.ts";
import type { PackCaseCheck } from "./pack-model-cases.ts";

/**
 * pack.mcmeta structure cases. Every case builds the smallest pack that
 * carries the one declaration under test, then reads the findings the
 * scan hands back. Severity follows the game: a form the game refuses to
 * load is an error, a form it loads but that looks wrong is a warning,
 * and a form the game accepts must stay unreported.
 */

export interface PackMcmetaCase {
	name: string;
	run(check: PackCaseCheck): Promise<void>;
}

type PackReport = Awaited<ReturnType<typeof scanPack>>;

async function withPackDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-mcmeta-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** One model plus its texture, so nothing else in the scan has an opinion. */
async function writeBase(dir: string): Promise<void> {
	await writeCleanBaseline(dir);
}

async function writeMcmeta(dir: string, body: unknown): Promise<void> {
	await writePackFile(dir, "pack.mcmeta", modelJson(body));
}

/** An overlay directory the pack root does not hold stays undiscussed. */
function findingsOf(report: PackReport, code: string) {
	return report.findings.filter((finding) => finding.code === code);
}

/** The two pack.mcmeta codes this change adds; neither is a coverage code. */
function structureFindings(report: PackReport) {
	return report.findings.filter(
		(finding) =>
			finding.code === "PACK_MCMETA_INVALID" ||
			finding.code === "PACK_MCMETA_SUSPICIOUS",
	);
}

function overlaySkips(report: PackReport) {
	return report.coverage.skipped.filter((skip) => skip.kind === "overlay");
}

function overlayWarnings(report: PackReport, directory: string) {
	return findingsOf(report, "PACK_COVERAGE_SKIPPED").filter((finding) =>
		finding.message.includes(directory),
	);
}

/** One overlay directory with a file inside, so the root really holds it. */
async function writeOverlayDir(dir: string, name: string): Promise<void> {
	await writePackFile(
		dir,
		`${name}/assets/testpack/textures/item/gem.png`,
		makePngBytes(),
	);
}

/** An overlay entry that spans old and new resource pack formats. */
function crossingOverlays(entries: unknown[]): {
	pack: Record<string, unknown>;
	overlays: { entries: unknown[] };
} {
	return {
		pack: {
			description: "crossing old and new",
			min_format: 15,
			max_format: 99,
			pack_format: 15,
			supported_formats: { min_inclusive: 15, max_inclusive: 99 },
		},
		overlays: { entries },
	};
}

export const PACK_MCMETA_CASES: PackMcmetaCase[] = [
	// ─── Errors: forms the game refuses to load ─────────────────────────────
	{
		name: "mcmeta error: a pack section without description fails the verdict",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, {
					pack: { min_format: 90, max_format: 99 },
				});
				const report = await scanPack(dir, {});
				const errors = findingsOf(report, "PACK_MCMETA_INVALID");
				check.equal(errors.length, 1, "one structure error");
				check.equal(
					errors[0]?.level,
					"error",
					"missing description is an error",
				);
				check.ok(
					errors[0]?.message.includes("pack.description"),
					"the message names the missing description field",
				);
				check.equal(report.verdict, "fail", "an error fails the verdict");
			});
		},
	},
	{
		name: "mcmeta error: a pack.mcmeta without a pack section fails the verdict",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, { note: "no pack section" });
				const report = await scanPack(dir, {});
				const errors = findingsOf(report, "PACK_MCMETA_INVALID");
				check.equal(errors.length, 1, "one structure error");
				check.equal(
					errors[0]?.level,
					"error",
					"a missing pack section is an error",
				);
				check.ok(
					errors[0]?.message.includes("description"),
					"the message names the description the file cannot carry",
				);
				check.equal(report.verdict, "fail", "an error fails the verdict");
				// The version lookup keeps its own behaviour beside the new
				// error: nothing is borrowed and nothing is defaulted.
				const undetermined = findingsOf(report, "PACK_VERSION_UNDETERMINED");
				check.equal(undetermined.length, 1, "one undetermined warning");
				check.equal(
					undetermined[0]?.level,
					"warning",
					"the version warning never becomes an error",
				);
				check.equal(
					report.target,
					"default (engine defaults)",
					"no version is borrowed or defaulted",
				);
			});
		},
	},
	{
		name: "mcmeta error: half a version range is rejected, naming the missing end",
		run: async (check) => {
			const variants: Array<{
				name: string;
				pack: Record<string, unknown>;
				missing: string;
			}> = [
				{
					name: "min_format only",
					pack: { description: "t", min_format: 90 },
					missing: "max_format",
				},
				{
					name: "max_format only",
					pack: { description: "t", max_format: 99 },
					missing: "min_format",
				},
			];
			for (const variant of variants) {
				await withPackDir(async (dir) => {
					await writeBase(dir);
					await writeMcmeta(dir, { pack: variant.pack });
					const report = await scanPack(dir, {});
					const errors = findingsOf(report, "PACK_MCMETA_INVALID");
					check.equal(errors.length, 1, `${variant.name} reports one error`);
					check.ok(
						errors[0]?.message.includes(variant.missing),
						`${variant.name} names the missing ${variant.missing}`,
					);
					check.equal(
						report.verdict,
						"fail",
						`${variant.name} fails the verdict`,
					);
				});
			}
		},
	},
	{
		name: "mcmeta error: a negative version value is rejected in either end",
		run: async (check) => {
			const variants: Array<{
				name: string;
				pack: Record<string, unknown>;
				field: string;
			}> = [
				{
					name: "negative min_format",
					pack: { description: "t", min_format: -1, max_format: 99 },
					field: "min_format",
				},
				{
					name: "negative max_format",
					pack: { description: "t", min_format: 90, max_format: [-5, 0] },
					field: "max_format",
				},
			];
			for (const variant of variants) {
				await withPackDir(async (dir) => {
					await writeBase(dir);
					await writeMcmeta(dir, { pack: variant.pack });
					const report = await scanPack(dir, {});
					const errors = findingsOf(report, "PACK_MCMETA_INVALID");
					check.equal(errors.length, 1, `${variant.name} reports one error`);
					check.equal(errors[0]?.level, "error", `${variant.name} is an error`);
					check.ok(
						errors[0]?.message.includes(variant.field),
						`${variant.name} names ${variant.field}`,
					);
					check.equal(
						report.verdict,
						"fail",
						`${variant.name} fails the verdict`,
					);
				});
			}
		},
	},
	{
		name: "mcmeta error: min above max is rejected in the pack section",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: [90, 0], max_format: [15, 0] },
				});
				const report = await scanPack(dir, {});
				const errors = findingsOf(report, "PACK_MCMETA_INVALID");
				check.equal(errors.length, 1, "one structure error");
				check.ok(
					errors[0]?.message.includes("min_format") &&
						errors[0]?.message.includes("max_format"),
					"the message names both ends of the empty range",
				);
				check.equal(report.verdict, "fail", "an error fails the verdict");
			});
		},
	},
	{
		name: "mcmeta error: min above max is rejected in an overlay entry",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeOverlayDir(dir, "overlay_1");
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: 90, max_format: 99 },
					overlays: {
						entries: [
							{
								directory: "overlay_1",
								min_format: [80, 0],
								max_format: [70, 0],
							},
						],
					},
				});
				const report = await scanPack(dir, {});
				const errors = findingsOf(report, "PACK_MCMETA_INVALID");
				check.equal(errors.length, 1, "one structure error");
				check.ok(
					errors[0]?.message.includes("overlay_1"),
					"the message names the overlay entry",
				);
				check.equal(
					structureFindings(report).length,
					1,
					"one broken range never drags a second code along",
				);
				check.equal(
					overlaySkips(report).length,
					0,
					"an entry with an empty range applies to no version",
				);
			});
		},
	},
	{
		name: "mcmeta error: supported_formats is rejected once min_format is 65 or later",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, {
					pack: {
						description: "t",
						min_format: 65,
						max_format: 99,
						supported_formats: { min_inclusive: 65, max_inclusive: 99 },
					},
				});
				const report = await scanPack(dir, {});
				const errors = findingsOf(report, "PACK_MCMETA_INVALID");
				check.equal(errors.length, 1, "one structure error");
				check.ok(
					errors[0]?.message.includes("supported_formats"),
					"the message names the legacy field",
				);
				check.equal(report.verdict, "fail", "an error fails the verdict");
			});
		},
	},
	{
		name: "mcmeta error: supported_formats must repeat the declared majors while old formats are covered",
		run: async (check) => {
			const variants: Array<{
				name: string;
				supported: Record<string, unknown>;
				field: string;
			}> = [
				{
					name: "min_inclusive disagrees with min_format",
					supported: { min_inclusive: 61, max_inclusive: 99 },
					field: "min_inclusive",
				},
				{
					name: "max_inclusive is neither max_format nor 64",
					supported: { min_inclusive: 15, max_inclusive: 80 },
					field: "max_inclusive",
				},
			];
			for (const variant of variants) {
				await withPackDir(async (dir) => {
					await writeBase(dir);
					await writeMcmeta(dir, {
						pack: {
							description: "t",
							min_format: 15,
							max_format: 99,
							pack_format: 15,
							supported_formats: variant.supported,
						},
					});
					const report = await scanPack(dir, {});
					const errors = findingsOf(report, "PACK_MCMETA_INVALID");
					check.equal(errors.length, 1, `${variant.name} reports one error`);
					check.ok(
						errors[0]?.message.includes(variant.field),
						`${variant.name} names ${variant.field}`,
					);
					check.equal(
						report.verdict,
						"fail",
						`${variant.name} fails the verdict`,
					);
				});
			}
		},
	},
	{
		name: "mcmeta error: a retained pack_format outside the declared range is rejected",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, {
					pack: {
						description: "t",
						pack_format: 50,
						min_format: 65,
						max_format: 99,
					},
				});
				const report = await scanPack(dir, {});
				const errors = findingsOf(report, "PACK_MCMETA_INVALID");
				check.equal(errors.length, 1, "one structure error");
				check.ok(
					errors[0]?.message.includes("pack_format"),
					"the message names the retained legacy field",
				);
				check.equal(report.verdict, "fail", "an error fails the verdict");
			});
		},
	},
	{
		name: "mcmeta error: an overlay directory outside the allowed characters is rejected",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeOverlayDir(dir, "over!ay");
				const body = crossingOverlays([
					{
						directory: "over!ay",
						min_format: 15,
						max_format: 64,
						formats: { min_inclusive: 15, max_inclusive: 64 },
					},
				]);
				await writeMcmeta(dir, body);
				const report = await scanPack(dir, {});
				const errors = findingsOf(report, "PACK_MCMETA_INVALID");
				check.equal(errors.length, 1, "one structure error");
				check.ok(
					errors[0]?.message.includes("over!ay"),
					"the message repeats the rejected directory name",
				);
				check.equal(
					structureFindings(report).length,
					1,
					"one bad name never drags a second code along",
				);
				check.equal(report.verdict, "fail", "an error fails the verdict");
			});
		},
	},
	{
		name: "mcmeta error: an overlay reaching old formats forces formats on every entry",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeOverlayDir(dir, "overlay_1");
				await writeOverlayDir(dir, "overlay_2");
				await writeMcmeta(
					dir,
					crossingOverlays([
						{
							directory: "overlay_1",
							min_format: 15,
							max_format: 64,
							formats: { min_inclusive: 15, max_inclusive: 64 },
						},
						{ directory: "overlay_2", min_format: 70, max_format: 80 },
					]),
				);
				const report = await scanPack(dir, {});
				const errors = findingsOf(report, "PACK_MCMETA_INVALID");
				check.equal(errors.length, 1, "one structure error");
				check.ok(
					errors[0]?.message.includes("overlay_2"),
					"the message names the entry that omits formats",
				);
				check.ok(
					errors[0]?.message.includes("formats"),
					"the message names the legacy overlay field",
				);
				check.equal(report.verdict, "fail", "an error fails the verdict");
			});
		},
	},
	{
		name: "mcmeta error: formats on an all-new overlay block is rejected",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeOverlayDir(dir, "overlay_1");
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: 90, max_format: 99 },
					overlays: {
						entries: [
							{
								directory: "overlay_1",
								min_format: 90,
								max_format: 99,
								formats: { min_inclusive: 90, max_inclusive: 99 },
							},
						],
					},
				});
				const report = await scanPack(dir, {});
				const errors = findingsOf(report, "PACK_MCMETA_INVALID");
				check.equal(errors.length, 1, "one structure error");
				check.ok(
					errors[0]?.message.includes("formats"),
					"the message names the legacy overlay field",
				);
				check.equal(
					findingsOf(report, "PACK_MCMETA_SUSPICIOUS").length,
					0,
					"the directory is present, so nothing else is reported",
				);
				check.equal(report.verdict, "fail", "an error fails the verdict");
			});
		},
	},
	// ─── Warnings: forms the game loads anyway ────────────────────────────
	{
		name: "mcmeta warning: an overlay directory the pack root lacks stays a warning",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: 90, max_format: 99 },
					overlays: {
						entries: [
							{ directory: "overlay_9", min_format: 90, max_format: 99 },
						],
					},
				});
				const report = await scanPack(dir, {});
				const warnings = findingsOf(report, "PACK_MCMETA_SUSPICIOUS");
				check.equal(warnings.length, 1, "one structure warning");
				check.equal(
					warnings[0]?.level,
					"warning",
					"a missing directory only warns",
				);
				check.ok(
					warnings[0]?.message.includes("overlay_9"),
					"the message names the directory the pack root lacks",
				);
				check.equal(
					report.verdict,
					"pass",
					"a warning never fails the verdict",
				);
				check.equal(
					overlaySkips(report).length,
					0,
					"nothing was left uninterpreted, so nothing is skipped",
				);
			});
		},
	},
	{
		name: "mcmeta warning: an overlay entry with no version field at all stays a warning",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeOverlayDir(dir, "overlay_1");
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: 90, max_format: 99 },
					overlays: { entries: [{ directory: "overlay_1" }] },
				});
				const report = await scanPack(dir, {});
				const warnings = findingsOf(report, "PACK_MCMETA_SUSPICIOUS");
				check.equal(warnings.length, 1, "one structure warning");
				check.equal(
					warnings[0]?.level,
					"warning",
					"no version field only warns",
				);
				for (const field of ["min_format", "max_format", "formats"]) {
					check.ok(
						warnings[0]?.message.includes(field),
						`the message names ${field} as one of the absent fields`,
					);
				}
				check.equal(
					report.verdict,
					"pass",
					"a warning never fails the verdict",
				);
				check.equal(
					overlaySkips(report).length,
					0,
					"an entry with no range applies to no version",
				);
			});
		},
	},
	{
		name: "mcmeta warning: a scan target outside the declared range stays a warning",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: 65, max_format: 99 },
				});
				const report = await scanPack(dir, {
					packFormat: "60.0",
					target: "resource-pack 60.0",
				});
				const warnings = findingsOf(report, "PACK_MCMETA_SUSPICIOUS");
				check.equal(warnings.length, 1, "one structure warning");
				check.equal(
					warnings[0]?.level,
					"warning",
					"a mismatched target only warns",
				);
				check.ok(
					warnings[0]?.message.includes("60.0"),
					"the message repeats the target the scan used",
				);
				check.equal(
					report.verdict,
					"pass",
					"a warning never fails the verdict",
				);
			});
		},
	},
	// ─── Coverage: overlays the scan leaves uninterpreted ─────────────────
	{
		name: "mcmeta coverage: an overlay covering the target records a skip and its warning",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeOverlayDir(dir, "overlay_1");
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: 90, max_format: 99 },
					overlays: {
						entries: [
							{ directory: "overlay_1", min_format: 90, max_format: 99 },
						],
					},
				});
				const report = await scanPack(dir, {});
				const skips = overlaySkips(report);
				check.equal(skips.length, 1, "one overlay skip");
				check.equal(skips[0]?.reason, "overlay-not-interpreted", "skip reason");
				check.equal(
					skips[0]?.target,
					"overlay_1",
					"skip target is the directory",
				);
				check.equal(
					skips[0]?.kind,
					"overlay",
					"the skip carries its own kind, apart from the version and model skips",
				);
				check.equal(
					report.coverage.status,
					"partial",
					"coverage lowers to partial",
				);
				const warnings = overlayWarnings(report, "overlay_1");
				check.equal(warnings.length, 1, "every skip carries one warning");
				check.equal(
					warnings[0]?.level,
					"warning",
					"the coverage warning stays a warning",
				);
				check.ok(
					warnings[0]?.message.includes("not interpreted"),
					"the warning says the overlay was not interpreted",
				);
				check.equal(
					findingsOf(report, "PACK_MCMETA_SUSPICIOUS").length,
					0,
					"a declared overlay that exists is not suspicious",
				);
				check.equal(
					report.verdict,
					"pass",
					"coverage alone never fails the verdict",
				);
			});
		},
	},
	{
		name: "mcmeta coverage: an overlay outside the target range records nothing",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeOverlayDir(dir, "overlay_1");
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: 90, max_format: 99 },
					overlays: {
						entries: [
							{ directory: "overlay_1", min_format: 20, max_format: 40 },
						],
					},
				});
				const report = await scanPack(dir, {});
				check.equal(
					overlaySkips(report).length,
					0,
					"an overlay that never applies costs no coverage",
				);
				check.equal(
					overlayWarnings(report, "overlay_1").length,
					0,
					"and raises no coverage warning",
				);
			});
		},
	},
	// ─── Forms the game accepts must stay unreported ──────────────────────
	{
		name: "mcmeta accepted: a legacy-only pack reports no structure finding",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, {
					pack: {
						description: "t",
						pack_format: 15,
						supported_formats: { min_inclusive: 15, max_inclusive: 46 },
					},
				});
				const report = await scanPack(dir, {});
				check.deepEqual(
					structureFindings(report).map((finding) => finding.code),
					[],
					"a pack that only carries old fields is not accused",
				);
				check.equal(report.verdict, "pass", "legacy packs keep passing");
				check.equal(overlaySkips(report).length, 0, "no overlay, no skip");
			});
		},
	},
	{
		name: "mcmeta accepted: matching supported_formats majors are not accused",
		run: async (check) => {
			const variants: Array<{
				name: string;
				supported: Record<string, unknown>;
			}> = [
				{
					name: "max_inclusive repeats max_format",
					supported: { min_inclusive: 15, max_inclusive: 99 },
				},
				{
					name: "max_inclusive stops at 64",
					supported: { min_inclusive: 15, max_inclusive: 64 },
				},
			];
			for (const variant of variants) {
				await withPackDir(async (dir) => {
					await writeBase(dir);
					await writeMcmeta(dir, {
						pack: {
							description: "t",
							min_format: 15,
							max_format: 99,
							pack_format: 15,
							supported_formats: variant.supported,
						},
					});
					const report = await scanPack(dir, {});
					check.deepEqual(
						structureFindings(report),
						[],
						`${variant.name} stays unreported`,
					);
					check.equal(report.verdict, "pass", `${variant.name} passes`);
				});
			}
		},
	},
	{
		name: "mcmeta accepted: a retained pack_format inside the declared range is not accused",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, {
					pack: {
						description: "t",
						pack_format: 75,
						min_format: 65,
						max_format: 99,
					},
				});
				const report = await scanPack(dir, {});
				check.deepEqual(
					structureFindings(report),
					[],
					"a pack_format inside the range is what old clients read",
				);
				check.equal(report.verdict, "pass", "the pack passes");
			});
		},
	},
	{
		name: "mcmeta accepted: a far-future max_format is not accused",
		run: async (check) => {
			const variants: Array<{ name: string; pack: Record<string, unknown> }> = [
				{
					name: "integer max_format with an array min_format",
					pack: {
						description: "t",
						min_format: [65, 0],
						max_format: 2147483647,
					},
				},
				{
					name: "max_format 9999",
					pack: { description: "t", min_format: 65, max_format: 9999 },
				},
			];
			for (const variant of variants) {
				await withPackDir(async (dir) => {
					await writeBase(dir);
					await writeMcmeta(dir, { pack: variant.pack });
					const report = await scanPack(dir, {});
					check.deepEqual(
						structureFindings(report),
						[],
						`${variant.name} stays unreported`,
					);
					check.equal(report.verdict, "pass", `${variant.name} passes`);
				});
			}
		},
	},
	{
		name: "mcmeta accepted: a single-element min_format array is not a malformed shape",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: [74], max_format: 99 },
				});
				const report = await scanPack(dir, {});
				check.deepEqual(
					structureFindings(report),
					[],
					"[74] is the major version the game reads",
				);
				check.equal(report.verdict, "pass", "the pack passes");
			});
		},
	},
	{
		name: "mcmeta accepted: an overlay directory with dots and capitals is not accused",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeOverlayDir(dir, "Overlay.v2_Beta");
				await writeMcmeta(dir, {
					pack: { description: "t", min_format: 90, max_format: 99 },
					overlays: {
						entries: [
							{
								directory: "Overlay.v2_Beta",
								min_format: 90,
								max_format: 99,
							},
						],
					},
				});
				const report = await scanPack(dir, {});
				check.deepEqual(
					structureFindings(report),
					[],
					"the game accepts dots and capitals in a directory name",
				);
				check.equal(report.verdict, "pass", "the pack passes");
				check.equal(
					overlaySkips(report).length,
					1,
					"the overlay is still reported as skipped",
				);
			});
		},
	},
	{
		name: "mcmeta accepted: every description form the game reads stays unreported",
		run: async (check) => {
			const variants: Array<{ name: string; description: unknown }> = [
				{ name: "plain string", description: "Demo pack" },
				{ name: "component list", description: ["Demo ", { text: "pack" }] },
				{ name: "component object", description: { text: "Demo pack" } },
			];
			for (const variant of variants) {
				await withPackDir(async (dir) => {
					await writeBase(dir);
					await writeMcmeta(dir, {
						pack: {
							description: variant.description,
							min_format: 90,
							max_format: 99,
						},
					});
					const report = await scanPack(dir, {});
					check.deepEqual(
						structureFindings(report),
						[],
						`${variant.name} stays unreported`,
					);
					check.equal(report.verdict, "pass", `${variant.name} passes`);
				});
			}
		},
	},
	{
		name: "mcmeta accepted: overlays that all carry formats across the old split are not accused",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeBase(dir);
				await writeOverlayDir(dir, "overlay_1");
				await writeOverlayDir(dir, "overlay_2");
				await writeMcmeta(
					dir,
					crossingOverlays([
						{
							directory: "overlay_1",
							min_format: 15,
							max_format: 64,
							formats: { min_inclusive: 15, max_inclusive: 64 },
						},
						{
							directory: "overlay_2",
							min_format: 90,
							max_format: 99,
							formats: { min_inclusive: 90, max_inclusive: 99 },
						},
					]),
				);
				const report = await scanPack(dir, {});
				check.deepEqual(
					structureFindings(report),
					[],
					"every entry repeating its majors is what the game reads",
				);
				check.equal(report.verdict, "pass", "the pack passes");
				check.equal(
					overlaySkips(report).length,
					1,
					"only the overlay that covers the target is skipped",
				);
			});
		},
	},
];
