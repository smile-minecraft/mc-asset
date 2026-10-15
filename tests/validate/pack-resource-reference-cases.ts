import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PackReport, scanPack } from "../../src/validate/pack.ts";
import { makePngBytes, writePackFile } from "./pack-fixtures.ts";
import type { PackCaseCheck } from "./pack-model-cases.ts";

/**
 * Equipment, particle and font reference cases. Every texture a reference
 * names is a real PNG, so a texture that is found is also not an orphan;
 * that makes "found" observable even where no error would be raised.
 */

export interface PackResourceReferenceCase {
	name: string;
	run(check: PackCaseCheck): Promise<void>;
}

const SKIP_KIND = "resource-reference";

async function withDirs<T>(
	count: number,
	fn: (dirs: string[]) => Promise<T>,
): Promise<T> {
	const dirs: string[] = [];
	try {
		for (let index = 0; index < count; index += 1) {
			dirs.push(await mkdtemp(join(tmpdir(), "mc-asset-pack-refs-")));
		}
		return await fn(dirs);
	} finally {
		for (const dir of dirs) {
			await rm(dir, { recursive: true, force: true });
		}
	}
}

async function withPack<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	return withDirs(1, (dirs) => fn(dirs[0] as string));
}

async function png(dir: string, rel: string): Promise<void> {
	await writePackFile(dir, rel, makePngBytes());
}

function json(dir: string, rel: string, body: unknown): Promise<void> {
	return writePackFile(dir, rel, JSON.stringify(body));
}

function findingsOf(report: PackReport, code: string): PackReport["findings"] {
	return report.findings.filter((finding) => finding.code === code);
}

function errorsOf(report: PackReport): PackReport["findings"] {
	return report.findings.filter((finding) => finding.level === "error");
}

function skipsOf(
	report: PackReport,
	reason: string,
): PackReport["coverage"]["skipped"] {
	return report.coverage.skipped.filter(
		(skip) => skip.kind === SKIP_KIND && skip.reason === reason,
	);
}

function isOrphan(report: PackReport, textureRel: string): boolean {
	return findingsOf(report, "PACK_ORPHAN_TEXTURE").some(
		(finding) => finding.path === textureRel,
	);
}

const V75 = { packFormat: "75.0" };
const EQUIPMENT_DIR = "assets/testpack/textures/entity/equipment";

function wingsDoc(texture: string): unknown {
	return { layers: { wings: [{ texture }] } };
}

export const PACK_RESOURCE_REFERENCE_CASES: PackResourceReferenceCase[] = [
	{
		name: "dotted model texture ids resolve through parent variables without orphan warnings",
		run: async (check) => {
			await withDirs(3, async ([dir, dependency, vanilla]) => {
				for (const [index, path] of [
					"item/foo.v2",
					"item.v2/foo",
					"item/foo.v2.final",
					"item/plain",
					"item/explicit.png",
				].entries()) {
					const namespace =
						index === 1 ? "libpack" : index === 2 ? "minecraft" : "testpack";
					const root = index === 1 ? dependency : index === 2 ? vanilla : dir;
					await png(
						root as string,
						`assets/${namespace}/textures/${path.endsWith(".png") ? path : `${path}.png`}`,
					);
					await json(
						dir as string,
						`assets/testpack/models/base_${index}.json`,
						{ textures: { base: `${namespace}:${path}` } },
					);
					await json(
						dir as string,
						`assets/testpack/models/child_${index}.json`,
						{ parent: `testpack:base_${index}`, textures: { layer0: "#base" } },
					);
				}
				const report = await scanPack(dir as string, {
					...V75,
					dependencyPaths: [dependency as string],
					vanillaPath: vanilla as string,
				});
				check.deepEqual(errorsOf(report), []);
				check.deepEqual(findingsOf(report, "PACK_ORPHAN_TEXTURE"), []);
			});
		},
	},
	...[
		"bad ns:item/foo",
		"testpack:item//foo",
		"testpack:item/my foo",
		"Testpack:item/foo",
	].map(
		(value): PackResourceReferenceCase => ({
			name: `invalid locations preserve model diagnostic codes across resource types: ${value}`,
			run: async (check) => {
				await withPack(async (dir) => {
					const paths = [
						"assets/testpack/models/check.json",
						"assets/testpack/equipment/check.json",
						"assets/testpack/particles/check.json",
						"assets/testpack/font/check.json",
					];
					await json(dir, paths[0] as string, { textures: { layer0: value } });
					await json(dir, paths[1] as string, wingsDoc(value));
					await json(dir, paths[2] as string, { textures: [value] });
					await json(dir, paths[3] as string, {
						providers: [
							{ type: "bitmap", file: value },
							{ type: "ttf", file: value },
							{ type: "reference", id: value },
						],
					});
					const report = await scanPack(dir, V75);
					const codesAt = (path: string) =>
						errorsOf(report)
							.filter((finding) => finding.path === path)
							.map((finding) => finding.code)
							.sort();
					const expected = codesAt(paths[0] as string);
					check.ok(expected.length > 0);
					for (const path of paths.slice(1, 3))
						check.deepEqual(codesAt(path), expected);
					check.deepEqual(
						codesAt(paths[3] as string),
						[...expected, ...expected, ...expected].sort(),
					);
					check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 0);
					check.equal(findingsOf(report, "PACK_MISSING_ASSET").length, 0);
				});
			},
		}),
	),
	// --- equipment ---
	{
		name: "equipment: a missing layer texture is an error naming the layer-type path",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(
					dir,
					"assets/testpack/equipment/wings.json",
					wingsDoc("testpack:elytra_skin"),
				);
				const report = await scanPack(dir, V75);
				const missing = findingsOf(report, "PACK_MISSING_TEXTURE");
				check.equal(missing.length, 1);
				check.equal(missing[0]?.level, "error");
				check.equal(missing[0]?.path, "assets/testpack/equipment/wings.json");
				check.ok(
					missing[0]?.message.includes(
						`${EQUIPMENT_DIR}/wings/elytra_skin.png`,
					),
					"the message must name the path with the layer type inserted",
				);
				check.equal(report.verdict, "fail");
			});
		},
	},
	{
		name: "equipment: a texture under the layer-type directory resolves and is not an orphan",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/equipment/wings.json", {
					layers: {
						wings: [
							{
								texture: "testpack:elytra_skin",
								dyeable: { color_when_undyed: 16777215 },
								use_player_texture: false,
							},
						],
					},
					trim_overrides: [
						{ when: { material: "minecraft:gold" }, texture: "testpack:trim" },
					],
				});
				await png(dir, `${EQUIPMENT_DIR}/wings/elytra_skin.png`);
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.equal(report.verdict, "pass");
				check.equal(
					isOrphan(report, `${EQUIPMENT_DIR}/wings/elytra_skin.png`),
					false,
					"a referenced equipment texture must not be an orphan",
				);
			});
		},
	},
	{
		name: "equipment: a texture only at the plain textures path does not satisfy the reference",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(
					dir,
					"assets/testpack/equipment/wings.json",
					wingsDoc("testpack:elytra_skin"),
				);
				await png(dir, "assets/testpack/textures/elytra_skin.png");
				const report = await scanPack(dir, V75);
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 1);
				check.equal(report.verdict, "fail");
			});
		},
	},
	{
		name: "equipment: the layer type picks the directory for each layer",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/equipment/gear.json", {
					layers: {
						humanoid: [{ texture: "testpack:gear" }],
						humanoid_leggings: [{ texture: "testpack:gear" }],
					},
				});
				await png(dir, `${EQUIPMENT_DIR}/humanoid/gear.png`);
				const onlyOne = await scanPack(dir, V75);
				const missing = findingsOf(onlyOne, "PACK_MISSING_TEXTURE");
				check.equal(missing.length, 1);
				check.ok(
					missing[0]?.message.includes(
						`${EQUIPMENT_DIR}/humanoid_leggings/gear.png`,
					),
				);
				await png(dir, `${EQUIPMENT_DIR}/humanoid_leggings/gear.png`);
				const both = await scanPack(dir, V75);
				check.deepEqual(errorsOf(both), []);
				check.equal(
					isOrphan(both, `${EQUIPMENT_DIR}/humanoid/gear.png`),
					false,
				);
				check.equal(
					isOrphan(both, `${EQUIPMENT_DIR}/humanoid_leggings/gear.png`),
					false,
				);
			});
		},
	},
	{
		name: "equipment: a layer type this tool has never heard of still resolves by its own name",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/equipment/new.json", {
					layers: { future_body: [{ texture: "testpack:thing" }] },
				});
				await png(dir, `${EQUIPMENT_DIR}/future_body/thing.png`);
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.equal(
					isOrphan(report, `${EQUIPMENT_DIR}/future_body/thing.png`),
					false,
				);
			});
		},
	},
	{
		name: "equipment: a case-only difference in the texture is a case mismatch",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(
					dir,
					"assets/testpack/equipment/wings.json",
					wingsDoc("testpack:Elytra_Skin"),
				);
				await png(dir, `${EQUIPMENT_DIR}/wings/elytra_skin.png`);
				const report = await scanPack(dir, V75);
				check.equal(findingsOf(report, "PACK_CASE_MISMATCH").length, 1);
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 0);
				check.equal(report.verdict, "fail");
			});
		},
	},
	{
		name: "equipment: unexpected shapes are skipped, never errors",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/equipment/empty_list.json", {
					layers: { humanoid: [] },
				});
				await json(dir, "assets/testpack/equipment/bad_entry.json", {
					layers: { humanoid: ["testpack:x", 7, null] },
				});
				await json(dir, "assets/testpack/equipment/bad_texture.json", {
					layers: { humanoid: [{ texture: 5 }] },
				});
				await json(dir, "assets/testpack/equipment/bad_layers.json", {
					layers: [],
				});
				await json(dir, "assets/testpack/equipment/not_object.json", []);
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.equal(report.verdict, "pass");
				const targets = skipsOf(report, "unexpected-shape").map(
					(skip) => skip.target.split("#")[0],
				);
				for (const name of [
					"empty_list",
					"bad_entry",
					"bad_texture",
					"bad_layers",
					"not_object",
				]) {
					check.ok(
						targets.includes(`assets/testpack/equipment/${name}.json`),
						`${name} must record an unexpected-shape skip`,
					);
				}
			});
		},
	},
	{
		name: "equipment: trim_overrides textures are not read, so coverage records a skip instead of claiming completeness",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/equipment/wings.json", {
					layers: { wings: [{ texture: "testpack:elytra_skin" }] },
					trim_overrides: [
						{
							when: { material: "minecraft:gold" },
							texture: "testpack:absent",
						},
					],
				});
				await png(dir, `${EQUIPMENT_DIR}/wings/elytra_skin.png`);
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				const skips = skipsOf(report, "trim-overrides-not-interpreted");
				check.equal(skips.length, 1);
				check.equal(
					skips[0]?.target,
					"assets/testpack/equipment/wings.json#/trim_overrides",
				);
				check.ok(
					findingsOf(report, "PACK_COVERAGE_SKIPPED").some((finding) =>
						finding.message.includes("trim-overrides-not-interpreted"),
					),
					"the skip must also surface as a warning",
				);
			});
		},
	},
	{
		name: "reference skips each raise a deduplicated PACK_COVERAGE_SKIPPED warning naming the reason",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/equipment/bad_layers.json", {
					layers: [],
				});
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["#other"],
				});
				const report = await scanPack(dir, V75);
				const shape = skipsOf(report, "unexpected-shape");
				const internal = skipsOf(report, "internal-reference");
				check.equal(shape.length, 1);
				check.equal(internal.length, 1);
				const warnings = findingsOf(report, "PACK_COVERAGE_SKIPPED").filter(
					(finding) => finding.message.startsWith("resource reference"),
				);
				check.equal(warnings.length, 2);
				check.ok(
					warnings.some(
						(finding) =>
							finding.message.includes("unexpected-shape") &&
							finding.level === "warning",
					),
				);
				check.ok(
					warnings.some((finding) =>
						finding.message.includes("internal-reference"),
					),
				);
			});
		},
	},
	{
		name: "equipment: models/equipment at pack format 42.0 is equipment, not a model",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/models/equipment/gear.json", {
					layers: { humanoid: [{ texture: "testpack:gear" }] },
				});
				await png(dir, `${EQUIPMENT_DIR}/humanoid/gear.png`);
				const report = await scanPack(dir, { packFormat: "42.0" });
				check.deepEqual(errorsOf(report), []);
				check.deepEqual(
					report.findings.filter((finding) =>
						finding.code.startsWith("MODEL_"),
					),
					[],
				);
				check.equal(
					isOrphan(report, `${EQUIPMENT_DIR}/humanoid/gear.png`),
					false,
					"the legacy location must still resolve its textures",
				);
				check.deepEqual(
					report.coverage.skipped.filter((skip) =>
						skip.kind.startsWith("model"),
					),
					[],
				);
			});
		},
	},
	{
		name: "equipment: a missing texture is an error in the legacy location too",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/models/equipment/gear.json", {
					layers: { humanoid: [{ texture: "testpack:gear" }] },
				});
				const report = await scanPack(dir, { packFormat: "42.0" });
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 1);
				check.equal(report.verdict, "fail");
			});
		},
	},
	{
		name: "equipment: models/equipment at other pack formats stays an ordinary model",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/models/equipment/gear.json", {
					layers: { humanoid: [{ texture: "testpack:gear" }] },
				});
				for (const options of [
					{ packFormat: "75.0" },
					{ packFormat: "46.0" },
					{},
				]) {
					const report = await scanPack(dir, options);
					check.equal(
						report.findings.some((finding) =>
							finding.message.includes("entity/equipment"),
						),
						false,
						`no equipment resolution at ${JSON.stringify(options)}`,
					);
				}
			});
		},
	},
	{
		name: "equipment: equipment/ is read only from pack format 46.0 and skipped before it",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(
					dir,
					"assets/testpack/equipment/wings.json",
					wingsDoc("testpack:elytra_skin"),
				);
				const old = await scanPack(dir, { packFormat: "42.0" });
				check.deepEqual(errorsOf(old), []);
				check.equal(skipsOf(old, "feature-not-in-version").length, 1);
				const current = await scanPack(dir, { packFormat: "46.0" });
				check.equal(findingsOf(current, "PACK_MISSING_TEXTURE").length, 1);
			});
		},
	},
	{
		name: "equipment: an undetermined pack format is a skip, not an error",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(
					dir,
					"assets/testpack/equipment/wings.json",
					wingsDoc("testpack:elytra_skin"),
				);
				const report = await scanPack(dir, {});
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 0);
				check.equal(skipsOf(report, "version-not-determined").length, 1);
				check.equal(report.coverage.status, "partial");
			});
		},
	},

	// --- particles ---
	{
		name: "particles: a missing sprite is an error naming the particle directory path",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["testpack:spark_0", "testpack:spark_1"],
				});
				await png(dir, "assets/testpack/textures/particle/spark_0.png");
				const report = await scanPack(dir, V75);
				const missing = findingsOf(report, "PACK_MISSING_TEXTURE");
				check.equal(missing.length, 1);
				check.equal(missing[0]?.level, "error");
				check.ok(
					missing[0]?.message.includes(
						"assets/testpack/textures/particle/spark_1.png",
					),
				);
				check.equal(report.verdict, "fail");
				check.equal(
					isOrphan(report, "assets/testpack/textures/particle/spark_0.png"),
					false,
					"a referenced particle sprite must not be an orphan",
				);
			});
		},
	},
	{
		name: "particles: an undetermined pack format is a skip, not an error",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["testpack:spark"],
				});
				const report = await scanPack(dir, {});
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 0);
				check.deepEqual(errorsOf(report), []);
				check.ok(report.verdict !== "fail", "a skip must not fail the pack");
				check.equal(skipsOf(report, "version-not-determined").length, 1);
				check.equal(report.coverage.status, "partial");
				check.ok(
					findingsOf(report, "PACK_COVERAGE_SKIPPED").some(
						(finding) =>
							finding.level === "warning" &&
							finding.message.includes("version-not-determined"),
					),
					"the skip must surface as a coverage warning",
				);
			});
		},
	},
	{
		name: "particles: a sprite only at the plain textures path does not satisfy the reference",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["testpack:spark"],
				});
				await png(dir, "assets/testpack/textures/spark.png");
				const report = await scanPack(dir, V75);
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 1);
			});
		},
	},
	{
		name: "particles: an entry starting with # is skipped, not a missing file",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["#spark_alias"],
				});
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.equal(skipsOf(report, "internal-reference").length, 1);
			});
		},
	},
	{
		name: "particles: unexpected shapes are skipped, never errors",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/particles/not_array.json", {
					textures: "testpack:x",
				});
				await json(dir, "assets/testpack/particles/bad_entry.json", {
					textures: [5, { id: "testpack:x" }, null],
				});
				await json(dir, "assets/testpack/particles/not_object.json", []);
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				const targets = skipsOf(report, "unexpected-shape").map(
					(skip) => skip.target.split("#")[0],
				);
				for (const name of ["not_array", "bad_entry", "not_object"]) {
					check.ok(
						targets.includes(`assets/testpack/particles/${name}.json`),
						`${name} must record an unexpected-shape skip`,
					);
				}
			});
		},
	},
	{
		name: "particles: a pack that replaces the particle atlas turns a miss into a skip",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["testpack:spark"],
				});
				await json(dir, "assets/minecraft/atlases/particles.json", {
					sources: [],
				});
				const report = await scanPack(dir, V75);
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 0);
				check.equal(skipsOf(report, "particle-atlas-customized").length, 1);
			});
		},
	},
	{
		name: "particles: an atlas in the current pack keeps the verdict out of fail and warns about the skip",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["testpack:spark"],
				});
				await json(dir, "assets/minecraft/atlases/particles.json", {
					sources: [],
				});
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.ok(report.verdict !== "fail", "a skip must not fail the pack");
				const skips = skipsOf(report, "particle-atlas-customized");
				check.equal(skips.length, 1);
				check.ok(
					skips[0]?.target.startsWith("assets/testpack/particles/spark.json"),
					"the skip must name the particle definition it could not confirm",
				);
				check.ok(
					findingsOf(report, "PACK_COVERAGE_SKIPPED").some(
						(finding) =>
							finding.level === "warning" &&
							finding.message.includes("particle-atlas-customized"),
					),
					"the skip must surface as a coverage warning",
				);
			});
		},
	},
	{
		name: "particles: an atlas only in a dependency pack also turns a miss into a skip",
		run: async (check) => {
			await withDirs(2, async ([dir, dependency]) => {
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["testpack:spark"],
				});
				await json(
					dependency as string,
					"assets/minecraft/atlases/particles.json",
					{ sources: [] },
				);
				const report = await scanPack(dir, {
					...V75,
					dependencyPaths: [dependency as string],
				});
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 0);
				check.deepEqual(errorsOf(report), []);
				check.ok(report.verdict !== "fail", "a skip must not fail the pack");
				check.equal(skipsOf(report, "particle-atlas-customized").length, 1);
				check.ok(
					findingsOf(report, "PACK_COVERAGE_SKIPPED").some(
						(finding) =>
							finding.level === "warning" &&
							finding.message.includes("particle-atlas-customized"),
					),
					"the skip must surface as a coverage warning",
				);
			});
		},
	},
	{
		name: "particles: a dependency pack without a particle atlas still leaves a miss as an error",
		run: async (check) => {
			await withDirs(2, async ([dir, dependency]) => {
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["testpack:spark"],
				});
				await png(
					dependency as string,
					"assets/libpack/textures/unrelated.png",
				);
				const report = await scanPack(dir, {
					...V75,
					dependencyPaths: [dependency as string],
				});
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 1);
				check.equal(skipsOf(report, "particle-atlas-customized").length, 0);
				check.equal(report.verdict, "fail");
			});
		},
	},

	// --- fonts ---
	{
		name: "fonts: a bitmap file that is missing is a texture error",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [
						{
							type: "bitmap",
							file: "testpack:font/glyphs.png",
							ascent: 7,
							height: 8,
							chars: ["ab"],
						},
					],
				});
				const report = await scanPack(dir, V75);
				const missing = findingsOf(report, "PACK_MISSING_TEXTURE");
				check.equal(missing.length, 1);
				check.equal(missing[0]?.level, "error");
				check.ok(
					missing[0]?.message.includes(
						"assets/testpack/textures/font/glyphs.png",
					),
				);
				check.equal(report.verdict, "fail");
			});
		},
	},
	{
		name: "fonts: a bitmap file with an undetermined pack format is a skip, not an error",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [
						{
							type: "bitmap",
							file: "testpack:font/glyphs.png",
							ascent: 7,
							height: 8,
							chars: ["ab"],
						},
					],
				});
				const report = await scanPack(dir, {});
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 0);
				check.deepEqual(errorsOf(report), []);
				check.ok(report.verdict !== "fail", "a skip must not fail the pack");
				check.equal(skipsOf(report, "version-not-determined").length, 1);
				check.equal(report.coverage.status, "partial");
				check.ok(
					findingsOf(report, "PACK_COVERAGE_SKIPPED").some(
						(finding) =>
							finding.level === "warning" &&
							finding.message.includes("version-not-determined"),
					),
					"the skip must surface as a coverage warning",
				);
			});
		},
	},
	{
		name: "fonts: a bitmap file under textures resolves and is not an orphan",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [
						{
							type: "bitmap",
							file: "testpack:font/glyphs.png",
							ascent: 7,
							chars: ["ab"],
						},
					],
				});
				await png(dir, "assets/testpack/textures/font/glyphs.png");
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.equal(
					isOrphan(report, "assets/testpack/textures/font/glyphs.png"),
					false,
				);
			});
		},
	},
	{
		name: "fonts: a reference provider to a missing font file is a missing asset",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [{ type: "reference", id: "testpack:include/extra" }],
				});
				const report = await scanPack(dir, V75);
				const missing = findingsOf(report, "PACK_MISSING_ASSET");
				check.equal(missing.length, 1);
				check.equal(missing[0]?.level, "error");
				check.ok(
					missing[0]?.message.includes(
						"assets/testpack/font/include/extra.json",
					),
				);
				check.equal(report.verdict, "fail");
				await json(dir, "assets/testpack/font/include/extra.json", {
					providers: [],
				});
				const fixed = await scanPack(dir, V75);
				check.equal(findingsOf(fixed, "PACK_MISSING_ASSET").length, 0);
				check.equal(fixed.verdict, "pass");
			});
		},
	},
	{
		name: "fonts: a ttf provider to a missing font file is a missing asset",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [
						{ type: "ttf", file: "testpack:fonts/face.ttf", size: 11 },
					],
				});
				const report = await scanPack(dir, V75);
				const missing = findingsOf(report, "PACK_MISSING_ASSET");
				check.equal(missing.length, 1);
				check.ok(
					missing[0]?.message.includes("assets/testpack/font/fonts/face.ttf"),
				);
				check.equal(report.verdict, "fail");
				await writePackFile(
					dir,
					"assets/testpack/font/fonts/face.ttf",
					new Uint8Array([0, 1, 0, 0]),
				);
				const fixed = await scanPack(dir, V75);
				check.equal(findingsOf(fixed, "PACK_MISSING_ASSET").length, 0);
			});
		},
	},
	{
		name: "fonts: a ttf file with an undetermined pack format is a skip, not an error",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [
						{ type: "ttf", file: "testpack:fonts/face.ttf", size: 11 },
					],
				});
				const report = await scanPack(dir, {});
				check.equal(findingsOf(report, "PACK_MISSING_ASSET").length, 0);
				check.deepEqual(errorsOf(report), []);
				check.ok(report.verdict !== "fail", "a skip must not fail the pack");
				check.equal(skipsOf(report, "version-not-determined").length, 1);
				check.equal(report.coverage.status, "partial");
				check.ok(
					findingsOf(report, "PACK_COVERAGE_SKIPPED").some(
						(finding) =>
							finding.level === "warning" &&
							finding.message.includes("version-not-determined"),
					),
					"the skip must surface as a coverage warning",
				);
			});
		},
	},
	{
		name: "fonts: a legacy_unicode template is skipped, not expanded",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [
						{
							type: "legacy_unicode",
							sizes: "testpack:font/glyph_sizes.bin",
							template: "testpack:font/unicode_page_%s.png",
						},
					],
				});
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.equal(findingsOf(report, "PACK_MISSING_TEXTURE").length, 0);
				check.equal(skipsOf(report, "pattern-reference").length, 1);
			});
		},
	},
	{
		name: "fonts: space, unihex and unknown provider types are skipped, not errors",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [
						{ type: "space", advances: { " ": 4 } },
						{ type: "unihex", hex_file: "testpack:font/unifont.zip" },
						{ type: "testpack:mystery", file: "testpack:nowhere.png" },
					],
				});
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.equal(report.verdict, "pass");
				check.equal(skipsOf(report, "provider-not-interpreted").length, 3);
				check.equal(report.coverage.status, "partial");
			});
		},
	},
	{
		name: "fonts: unexpected shapes are skipped, never errors",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/not_array.json", {
					providers: {},
				});
				await json(dir, "assets/testpack/font/bad_provider.json", {
					providers: [5, null, { type: 7 }],
				});
				await json(dir, "assets/testpack/font/bad_file.json", {
					providers: [{ type: "bitmap", file: 9 }],
				});
				await json(dir, "assets/testpack/font/bad_id.json", {
					providers: [{ type: "reference" }],
				});
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				const targets = skipsOf(report, "unexpected-shape").map(
					(skip) => skip.target.split("#")[0],
				);
				for (const name of [
					"not_array",
					"bad_provider",
					"bad_file",
					"bad_id",
				]) {
					check.ok(
						targets.includes(`assets/testpack/font/${name}.json`),
						`${name} must record an unexpected-shape skip`,
					);
				}
			});
		},
	},
	{
		name: "fonts: the reference provider needs pack format 15.0 and is skipped before it",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [{ type: "reference", id: "testpack:include/extra" }],
				});
				const old = await scanPack(dir, { packFormat: "13.0" });
				check.deepEqual(errorsOf(old), []);
				check.equal(skipsOf(old, "feature-not-in-version").length, 1);
				const unknown = await scanPack(dir, {});
				check.deepEqual(errorsOf(unknown), []);
				check.equal(skipsOf(unknown, "version-not-determined").length, 1);
				const current = await scanPack(dir, { packFormat: "15.0" });
				check.equal(findingsOf(current, "PACK_MISSING_ASSET").length, 1);
			});
		},
	},

	// --- across the three types ---
	{
		name: "references to minecraft: files without a vanilla tree are unresolved warnings",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/equipment/gear.json", {
					layers: { humanoid: [{ texture: "minecraft:leather" }] },
				});
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["minecraft:flame"],
				});
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [
						{ type: "bitmap", file: "minecraft:font/ascii.png", chars: ["a"] },
						{ type: "reference", id: "minecraft:include/space" },
						{ type: "ttf", file: "minecraft:unifont.ttf", size: 8 },
					],
				});
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.equal(report.verdict, "pass");
				const external = findingsOf(report, "PACK_UNRESOLVED_EXTERNAL");
				check.equal(external.length, 5);
				check.ok(external.every((finding) => finding.level === "warning"));
				const targets = report.coverage.skipped
					.filter((skip) => skip.reason === "vanilla-not-provided")
					.map((skip) => skip.target);
				for (const target of [
					"assets/minecraft/textures/entity/equipment/humanoid/leather.png",
					"assets/minecraft/textures/particle/flame.png",
					"assets/minecraft/textures/font/ascii.png",
					"assets/minecraft/font/include/space.json",
					"assets/minecraft/font/unifont.ttf",
				]) {
					check.ok(
						targets.includes(target),
						`${target} must be an external skip`,
					);
				}
			});
		},
	},
	{
		name: "references to minecraft: files resolve against a provided vanilla tree",
		run: async (check) => {
			await withDirs(2, async ([dir, vanilla]) => {
				await json(dir, "assets/testpack/equipment/gear.json", {
					layers: { humanoid: [{ texture: "minecraft:leather" }] },
				});
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["minecraft:flame"],
				});
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [{ type: "reference", id: "minecraft:include/space" }],
				});
				await png(
					vanilla as string,
					"assets/minecraft/textures/entity/equipment/humanoid/leather.png",
				);
				await json(
					vanilla as string,
					"assets/minecraft/font/include/space.json",
					{
						providers: [],
					},
				);
				const report = await scanPack(dir, {
					...V75,
					vanillaPath: vanilla as string,
				});
				// flame.png is absent from the vanilla tree: determined miss.
				const missing = findingsOf(report, "PACK_MISSING_TEXTURE");
				check.equal(missing.length, 1);
				check.ok(
					missing[0]?.message.includes(
						"assets/minecraft/textures/particle/flame.png",
					),
				);
				check.equal(findingsOf(report, "PACK_UNRESOLVED_EXTERNAL").length, 0);
				check.equal(findingsOf(report, "PACK_MISSING_ASSET").length, 0);
			});
		},
	},
	{
		name: "references resolve through dependency packs",
		run: async (check) => {
			await withDirs(2, async ([dir, dependency]) => {
				await json(dir, "assets/testpack/equipment/gear.json", {
					layers: { humanoid: [{ texture: "libpack:shared" }] },
				});
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [{ type: "reference", id: "libpack:shared" }],
				});
				await png(
					dependency as string,
					"assets/libpack/textures/entity/equipment/humanoid/shared.png",
				);
				await json(dependency as string, "assets/libpack/font/shared.json", {
					providers: [],
				});
				await json(dir, "assets/testpack/equipment/absent.json", {
					layers: { humanoid: [{ texture: "libpack:absent" }] },
				});
				const report = await scanPack(dir, {
					...V75,
					dependencyPaths: [dependency as string],
				});
				const missing = findingsOf(report, "PACK_MISSING_TEXTURE");
				check.equal(missing.length, 1, "only the absent texture is missing");
				check.ok(missing[0]?.message.includes("libpack/textures/entity"));
				check.equal(findingsOf(report, "PACK_MISSING_ASSET").length, 0);
			});
		},
	},
	{
		name: "coverage: equipment, particles and fonts with understood shapes stay complete",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/equipment/wings.json", {
					layers: { wings: [{ texture: "testpack:elytra_skin" }] },
				});
				await png(dir, `${EQUIPMENT_DIR}/wings/elytra_skin.png`);
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: ["testpack:spark"],
				});
				await png(dir, "assets/testpack/textures/particle/spark.png");
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [
						{ type: "bitmap", file: "testpack:font/glyphs.png", chars: ["a"] },
					],
				});
				await png(dir, "assets/testpack/textures/font/glyphs.png");
				const report = await scanPack(dir, V75);
				check.deepEqual(errorsOf(report), []);
				check.equal(report.coverage.status, "complete");
				check.deepEqual(report.coverage.skipped, []);
				check.equal(
					findingsOf(report, "PACK_ORPHAN_TEXTURE").length,
					0,
					"every texture is referenced by a covered source",
				);
			});
		},
	},
	{
		name: "coverage: these types no longer read as uninterpreted, only the finer skip remains",
		run: async (check) => {
			await withPack(async (dir) => {
				await json(dir, "assets/testpack/font/custom.json", {
					providers: [{ type: "testpack:mystery" }],
				});
				await json(dir, "assets/testpack/particles/spark.json", {
					textures: [],
				});
				await json(dir, "assets/testpack/equipment/none.json", { layers: {} });
				const report = await scanPack(dir, V75);
				check.equal(report.coverage.status, "partial");
				check.ok(
					report.coverage.skipped.every(
						(skip) => !skip.reason.includes("resource-type-not-interpreted"),
					),
					"no resource-type-not-interpreted skip may remain for these types",
				);
				check.equal(skipsOf(report, "provider-not-interpreted").length, 1);
			});
		},
	},
];
