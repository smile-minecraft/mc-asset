import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { executePackBuild, planPackBuild } from "../../src/pack/build.ts";
import { checkResourcePack } from "../../src/pack/check.ts";
import { parseLockText } from "../../src/pack/lock.ts";
import { packageResourcePack } from "../../src/pack/package.ts";
import { scanPack } from "../../src/validate/pack.ts";

/**
 * The whole-pack demo: one formatVersion 3 recipe builds a custom block, a
 * layered item, one armor set, one entity texture template, one icon font,
 * and a two-frame particle. The cases cover the build, the check verdict,
 * the lock vocabulary, the conflict refusal, the defect fix list, stale lock
 * entry pruning, and the frozen bytes both runtimes must produce.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "demo-pack");
const PROJECT_FILE = "mc-asset.pack.json";

const RECIPE_REL = "recipes/demo.recipe.json";
const HERO_TEXTURE_REL =
	"pack/assets/aurelian/textures/entity/aurelian_hero.png";
const SECOND_HERO_TEXTURE_REL =
	"pack/assets/aurelian/textures/entity/second_hero.png";
const GEAR_DEFINITION_REL = "pack/assets/aurelian/equipment/aurelian_gear.json";
const GEAR_HUMANOID_REL =
	"pack/assets/aurelian/textures/entity/equipment/humanoid/aurelian_gear.png";
const GEAR_LEGGINGS_REL =
	"pack/assets/aurelian/textures/entity/equipment/humanoid_leggings/aurelian_gear.png";

/** Frozen SHA-256 of every project byte, inputs and lock included. */
const EXPECTED_TREE_SHA256 =
	"d5c8ebf40dee1ac6c9e1ba2dee6d9fee52b7623ca6c1e7853586d25628080eaa";

/** Frozen SHA-256 of the lock document. */
const EXPECTED_LOCK_SHA256 =
	"58eecd757f7385c49b3442d37d7315ecf7fd4bfbc6997592f029bc141f97dc33";

/** Every output the demo recipe plans, by lock kind. */
const EXPECTED_LOCK_KINDS: Readonly<Record<string, string>> = {
	"pack/assets/aurelian/blockstates/aurelian_block.json": "blockstate",
	"pack/assets/aurelian/equipment/aurelian_gear.json": "equipmentDefinition",
	"pack/assets/aurelian/font/icons.json": "fontDefinition",
	"pack/assets/aurelian/items/aurelian_blade.json": "itemDefinition",
	"pack/assets/aurelian/items/aurelian_block.json": "itemDefinition",
	"pack/assets/aurelian/models/block/aurelian_block.json": "blockModel",
	"pack/assets/aurelian/models/item/aurelian_blade.json": "model",
	"pack/assets/aurelian/models/item/aurelian_blade_overlay.json": "model",
	"pack/assets/aurelian/models/item/aurelian_block.json": "blockItemModel",
	"pack/assets/aurelian/particles/aurelian_spark.json": "particleDefinition",
	"pack/assets/aurelian/textures/block/aurelian_block.png": "texture",
	"pack/assets/aurelian/textures/entity/aurelian_hero.png": "entityTemplate",
	"pack/assets/aurelian/textures/entity/equipment/humanoid/aurelian_gear.png":
		"equipmentTexture",
	"pack/assets/aurelian/textures/entity/equipment/humanoid_leggings/aurelian_gear.png":
		"equipmentTexture",
	"pack/assets/aurelian/textures/font/icons.png": "fontAtlas",
	"pack/assets/aurelian/textures/item/aurelian_blade.png": "texture",
	"pack/assets/aurelian/textures/item/aurelian_blade_overlay.png": "texture",
	"pack/assets/aurelian/textures/particle/aurelian_spark_0.png":
		"particleTexture",
	"pack/assets/aurelian/textures/particle/aurelian_spark_1.png":
		"particleTexture",
	"font/icons.table.json": "fontTable",
};

interface DemoCase {
	readonly name: string;
	run(): Promise<void>;
}

async function withDemoProject(
	body: (projectDir: string, root: string) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "mc-asset-demo-"));
	try {
		const projectDir = join(root, "aurelian-forge");
		await cp(FIXTURE, projectDir, { recursive: true });
		await body(projectDir, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function projectPath(projectDir: string): string {
	return join(projectDir, PROJECT_FILE);
}

async function buildDemo(projectDir: string, recipe?: string) {
	return executePackBuild(
		await planPackBuild(
			projectPath(projectDir),
			recipe === undefined ? {} : { recipe },
		),
	);
}

interface RecipeJson {
	readonly formatVersion?: number;
	readonly id?: string;
	targets: Array<{
		id: string;
		steps: Array<Record<string, unknown>>;
		[key: string]: unknown;
	}>;
	[key: string]: unknown;
}

async function readRecipe(projectDir: string): Promise<RecipeJson> {
	return JSON.parse(
		await readFile(join(projectDir, RECIPE_REL), "utf8"),
	) as RecipeJson;
}

async function writeRecipe(
	projectDir: string,
	recipe: RecipeJson,
): Promise<void> {
	await writeFile(
		join(projectDir, RECIPE_REL),
		`${JSON.stringify(recipe, null, "\t")}\n`,
		"utf8",
	);
}

/** Rewrite the demo recipe without one target, as a user would edit it. */
async function removeRecipeTarget(
	projectDir: string,
	targetId: string,
): Promise<void> {
	const recipe = await readRecipe(projectDir);
	const targets = recipe.targets.filter((target) => target.id !== targetId);
	assert.equal(
		targets.length,
		recipe.targets.length - 1,
		`recipe declares target ${targetId}`,
	);
	await writeRecipe(projectDir, { ...recipe, targets });
}

/**
 * Switch the equipment step off its filled template: the two armor sheets get
 * new bytes, the definition keeps its bytes but records a new input hash, so
 * the next build rewrites all three outputs and commits a fresh lock.
 */
async function disableEquipmentFill(projectDir: string): Promise<void> {
	const recipe = await readRecipe(projectDir);
	const gear = recipe.targets.find((target) => target.id === "aurelian_gear");
	assert.ok(gear, "the demo recipe declares the equipment target");
	const step = gear.steps[0];
	assert.ok(step, "the equipment target declares a step");
	step.fill = false;
	await writeRecipe(projectDir, recipe);
}

/**
 * A second recipe file. A `--recipe` build plans one file only, so this
 * recipe's lock entries are the ones such a build must leave alone.
 */
async function addSecondRecipe(projectDir: string): Promise<void> {
	const recipe = {
		formatVersion: 3,
		id: "second-demo",
		targets: [
			{
				id: "second_hero",
				steps: [
					{
						type: "entityTemplate",
						layout: "player_wide",
						output: "assets/{namespace}/textures/entity/second_hero.png",
					},
				],
			},
		],
	};
	await writeFile(
		join(projectDir, "recipes", "second.recipe.json"),
		`${JSON.stringify(recipe, null, "\t")}\n`,
		"utf8",
	);
}

/** Write one more recipe file next to the demo recipe. */
async function writeExtraRecipe(
	projectDir: string,
	fileName: string,
	recipe: RecipeJson,
): Promise<void> {
	await writeFile(
		join(projectDir, "recipes", fileName),
		`${JSON.stringify(recipe, null, "\t")}\n`,
		"utf8",
	);
}

/**
 * Move the hero target out of the demo recipe into a second recipe file,
 * leaving the same output path and bytes behind: exactly what a user does
 * when they reorganize recipes.
 */
async function moveHeroToSecondRecipe(projectDir: string): Promise<void> {
	const recipe = await readRecipe(projectDir);
	const hero = recipe.targets.find((target) => target.id === "aurelian_hero");
	assert.ok(hero, "the demo recipe declares the hero target");
	await writeRecipe(projectDir, {
		...recipe,
		targets: recipe.targets.filter((target) => target.id !== "aurelian_hero"),
	});
	await writeExtraRecipe(projectDir, "second.recipe.json", {
		formatVersion: 3,
		id: "second-demo",
		targets: [hero],
	});
}

/** Change the demo recipe id, as a user renaming the recipe would. */
async function renameRecipeId(projectDir: string, id: string): Promise<void> {
	const recipe = await readRecipe(projectDir);
	await writeRecipe(projectDir, { ...recipe, id });
}

async function walkFiles(directory: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await walkFiles(path)));
		} else {
			found.push(path);
		}
	}
	return found;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** One hash over every file's relative path and bytes, in byte order. */
async function treeHash(projectDir: string): Promise<string> {
	const files = (await walkFiles(projectDir))
		.map((path) => relative(projectDir, path).replace(/\\/g, "/"))
		.sort();
	const parts: string[] = [];
	for (const rel of files) {
		parts.push(`${rel}\0${sha256(await readFile(join(projectDir, rel)))}\n`);
	}
	return sha256(new TextEncoder().encode(parts.join("")));
}

interface Refusal {
	code?: string;
	details?: Record<string, unknown> | undefined;
}

async function refusalOf(body: () => Promise<unknown>): Promise<Refusal> {
	try {
		await body();
	} catch (error) {
		return error as Refusal;
	}
	assert.fail("expected a refusal but the call succeeded");
}

export const DEMO_PACK_CASES: readonly DemoCase[] = [
	{
		name: "the demo recipe builds every family and pack check passes",
		async run() {
			await withDemoProject(async (projectDir) => {
				const plan = await planPackBuild(projectPath(projectDir));
				assert.equal(plan.outputs.length, 20, "twenty planned outputs");
				const executed = await buildDemo(projectDir);
				assert.equal(executed.completed.length, 20, "twenty files written");

				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				assert.deepEqual(
					Object.fromEntries(
						Object.entries(lock.outputs).map(([path, entry]) => [
							path,
							entry.kind,
						]),
					),
					EXPECTED_LOCK_KINDS,
					"every family is locked under its own kind",
				);

				const summary = await checkResourcePack({
					projectPath: projectPath(projectDir),
				});
				assert.equal(summary.verdict, "pass", "pack check passes");
				assert.deepEqual(summary.fixList, [], "nothing to fix");

				const report = await scanPack(join(projectDir, "pack"));
				assert.deepEqual(
					report.findings.filter((finding) => finding.level === "error"),
					[],
					"validate-pack reports no error",
				);

				const lockBefore = await readFile(
					join(projectDir, "mc-asset.lock.json"),
				);
				const second = await planPackBuild(projectPath(projectDir));
				assert.ok(
					second.outputs.every((output) => output.judgement === "own-clean"),
					"a rerun sees only own-clean outputs",
				);
				const rerun = await executePackBuild(second);
				assert.deepEqual(rerun.completed, [], "the rerun rewrites nothing");
				assert.deepEqual(
					await readFile(join(projectDir, "mc-asset.lock.json")),
					lockBefore,
					"the lock is unchanged",
				);
			});
		},
	},
	{
		name: "the demo pack has the same bytes on every runtime",
		async run() {
			await withDemoProject(async (projectDir) => {
				await buildDemo(projectDir);
				assert.equal(
					await treeHash(projectDir),
					EXPECTED_TREE_SHA256,
					"the frozen project tree hash",
				);
				assert.equal(
					sha256(await readFile(join(projectDir, "mc-asset.lock.json"))),
					EXPECTED_LOCK_SHA256,
					"the frozen lock hash",
				);
			});
		},
	},
	{
		name: "a hand-edited font definition refuses the build and lists the file",
		async run() {
			await withDemoProject(async (projectDir, root) => {
				await buildDemo(projectDir);
				const definitionRel = "pack/assets/aurelian/font/icons.json";
				const definitionPath = join(projectDir, definitionRel);
				await writeFile(
					definitionPath,
					`${await readFile(definitionPath, "utf8")}\n`,
					"utf8",
				);
				const lockBefore = await readFile(
					join(projectDir, "mc-asset.lock.json"),
				);
				const otherBefore = new Map<string, Uint8Array>();
				for (const path of await walkFiles(join(projectDir, "pack"))) {
					const rel = relative(projectDir, path).replace(/\\/g, "/");
					if (rel !== definitionRel) {
						otherBefore.set(rel, await readFile(path));
					}
				}
				const refusal = await refusalOf(async () => buildDemo(projectDir));
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				assert.deepEqual(refusal.details?.conflicts, [
					{ path: definitionRel, reason: "own-modified" },
				]);
				assert.deepEqual(
					await readFile(join(projectDir, "mc-asset.lock.json")),
					lockBefore,
					"the lock is unchanged",
				);
				for (const [rel, bytes] of otherBefore) {
					assert.deepEqual(
						await readFile(join(projectDir, rel)),
						bytes,
						`${rel} is unchanged`,
					);
				}
				void root;
			});
		},
	},
	{
		name: "pack check lists a defect in every generated family",
		async run() {
			const defects: ReadonlyArray<{
				name: string;
				file: string;
				code: string;
				break: (path: string) => Promise<void>;
			}> = [
				{
					name: "equipment texture",
					file: "pack/assets/aurelian/textures/entity/equipment/humanoid/aurelian_gear.png",
					code: "PACK_MISSING_TEXTURE",
					break: (path) => unlink(path),
				},
				{
					name: "font atlas",
					file: "pack/assets/aurelian/textures/font/icons.png",
					code: "PACK_MISSING_TEXTURE",
					break: (path) => unlink(path),
				},
				{
					name: "particle sprite",
					file: "pack/assets/aurelian/textures/particle/aurelian_spark_1.png",
					code: "PACK_MISSING_TEXTURE",
					break: (path) => unlink(path),
				},
				{
					name: "entity template",
					file: "pack/assets/aurelian/textures/entity/aurelian_hero.png",
					code: "PACK_INVALID_IMAGE_DATA",
					break: (path) => writeFile(path, "not a png", "utf8"),
				},
			];
			for (const defect of defects) {
				await withDemoProject(async (projectDir) => {
					await buildDemo(projectDir);
					await defect.break(join(projectDir, defect.file));
					const summary = await checkResourcePack({
						projectPath: projectPath(projectDir),
					});
					assert.equal(
						summary.verdict,
						"fail",
						`${defect.name}: the defect fails the verdict`,
					);
					assert.ok(
						summary.fixList.some(
							(entry) => entry.code === defect.code && entry.level === "error",
						),
						`${defect.name}: the fix list carries ${defect.code}`,
					);
				});
			}
		},
	},
	{
		name: "pack check reports every generated output deleted from disk",
		async run() {
			const missing: ReadonlyArray<{ name: string; file: string }> = [
				{
					name: "entity template",
					file: "pack/assets/aurelian/textures/entity/aurelian_hero.png",
				},
				{
					name: "equipment definition",
					file: "pack/assets/aurelian/equipment/aurelian_gear.json",
				},
				{
					name: "font definition",
					file: "pack/assets/aurelian/font/icons.json",
				},
				{
					name: "particle definition",
					file: "pack/assets/aurelian/particles/aurelian_spark.json",
				},
			];
			for (const entry of missing) {
				await withDemoProject(async (projectDir) => {
					await buildDemo(projectDir);
					await unlink(join(projectDir, entry.file));
					const summary = await checkResourcePack({
						projectPath: projectPath(projectDir),
					});
					assert.equal(
						summary.verdict,
						"fail",
						`${entry.name}: a missing generated output fails the verdict`,
					);
					const fix = summary.fixList.find(
						(candidate) => candidate.code === "PACK_GENERATED_OUTPUT_MISSING",
					);
					assert.ok(
						fix,
						`${entry.name}: the fix list names the missing output`,
					);
					assert.equal(
						fix.level,
						"error",
						`${entry.name}: the fix is an error`,
					);
					assert.ok(
						fix.samplePaths.includes(entry.file),
						`${entry.name}: the fix points at ${entry.file}`,
					);
				});
			}
		},
	},
	{
		name: "a generated target the check cannot plan keeps its missing output reported",
		async run() {
			await withDemoProject(async (projectDir) => {
				await buildDemo(projectDir);
				// The font step no longer plans, so the check cannot know which
				// paths that target owns; its lock entries must keep reporting.
				await unlink(join(projectDir, "recipes", "sources", "icon_gem.mcpx"));
				const definitionRel = "pack/assets/aurelian/font/icons.json";
				await unlink(join(projectDir, definitionRel));

				const summary = await checkResourcePack({
					projectPath: projectPath(projectDir),
				});
				assert.equal(summary.verdict, "fail");
				const fix = summary.fixList.find(
					(candidate) => candidate.code === "PACK_GENERATED_OUTPUT_MISSING",
				);
				assert.ok(fix, "the missing output is still reported");
				assert.ok(
					fix.samplePaths.includes(definitionRel),
					"the fix points at the planned font definition",
				);
			});
		},
	},
	{
		name: "a target removed from the recipe stops being locked and pack check recovers",
		async run() {
			await withDemoProject(async (projectDir) => {
				await buildDemo(projectDir);
				const firstCheck = await checkResourcePack({
					projectPath: projectPath(projectDir),
				});
				assert.equal(firstCheck.verdict, "pass", "the fresh build passes");

				const lockPath = join(projectDir, "mc-asset.lock.json");
				const originalLock = parseLockText(await readFile(lockPath, "utf8"));

				await removeRecipeTarget(projectDir, "aurelian_hero");
				await unlink(join(projectDir, HERO_TEXTURE_REL));

				const pruned = await buildDemo(projectDir);
				assert.deepEqual(
					pruned.completed,
					[],
					"nothing is rewritten: only the lock entry is stale",
				);
				const prunedLock = parseLockText(await readFile(lockPath, "utf8"));
				assert.equal(
					prunedLock.outputs[HERO_TEXTURE_REL],
					undefined,
					"the removed target leaves the lock",
				);
				const expected = { ...originalLock.outputs };
				delete expected[HERO_TEXTURE_REL];
				assert.deepEqual(
					prunedLock.outputs,
					expected,
					"every other lock entry survives",
				);

				const recovered = await checkResourcePack({
					projectPath: projectPath(projectDir),
				});
				assert.equal(recovered.verdict, "pass", "pack check passes again");
				assert.deepEqual(recovered.fixList, [], "nothing to fix");

				// A second rerun stays quiet: the pruned lock is the baseline now.
				const lockBytes = await readFile(lockPath);
				assert.deepEqual((await buildDemo(projectDir)).completed, []);
				assert.deepEqual(
					await readFile(lockPath),
					lockBytes,
					"the lock is unchanged",
				);

				// Rewriting another target commits the lock again and must not
				// resurrect the removed entry.
				const beforeFill = parseLockText(await readFile(lockPath, "utf8"));
				await disableEquipmentFill(projectDir);
				const rewritten = await buildDemo(projectDir);
				assert.deepEqual(
					[...rewritten.completed].sort(),
					[GEAR_DEFINITION_REL, GEAR_HUMANOID_REL, GEAR_LEGGINGS_REL].sort(),
					"the equipment step rewrites its three outputs",
				);
				const afterFill = parseLockText(await readFile(lockPath, "utf8"));
				assert.equal(
					afterFill.outputs[HERO_TEXTURE_REL],
					undefined,
					"the removed entry stays gone",
				);
				assert.notEqual(
					afterFill.outputs[GEAR_DEFINITION_REL]?.inputHash,
					beforeFill.outputs[GEAR_DEFINITION_REL]?.inputHash,
					"the rewrite records a new input hash",
				);
				assert.equal(
					afterFill.outputs[GEAR_DEFINITION_REL]?.outputHash,
					beforeFill.outputs[GEAR_DEFINITION_REL]?.outputHash,
					"the definition bytes stayed the same",
				);
				const finalCheck = await checkResourcePack({
					projectPath: projectPath(projectDir),
				});
				assert.equal(finalCheck.verdict, "pass");
				assert.deepEqual(finalCheck.fixList, []);
			});
		},
	},
	{
		name: "a single-recipe build keeps the lock entries of recipes it did not plan",
		async run() {
			await withDemoProject(async (projectDir) => {
				await addSecondRecipe(projectDir);
				const first = await buildDemo(projectDir);
				assert.equal(first.completed.length, 21, "both recipes build");

				const lockPath = join(projectDir, "mc-asset.lock.json");
				const before = parseLockText(await readFile(lockPath, "utf8"));
				const secondLocked = before.outputs[SECOND_HERO_TEXTURE_REL];
				assert.ok(secondLocked, "the second recipe is locked");
				const secondBytes = await readFile(
					join(projectDir, SECOND_HERO_TEXTURE_REL),
				);

				await removeRecipeTarget(projectDir, "aurelian_hero");
				await unlink(join(projectDir, HERO_TEXTURE_REL));
				await disableEquipmentFill(projectDir);

				const partial = await buildDemo(
					projectDir,
					join(projectDir, "recipes", "demo.recipe.json"),
				);
				assert.deepEqual(
					[...partial.completed].sort(),
					[GEAR_DEFINITION_REL, GEAR_HUMANOID_REL, GEAR_LEGGINGS_REL].sort(),
					"the planned recipe rewrites only its own outputs",
				);

				const after = parseLockText(await readFile(lockPath, "utf8"));
				assert.equal(
					after.outputs[HERO_TEXTURE_REL],
					undefined,
					"the removed target of the planned recipe is pruned",
				);
				assert.deepEqual(
					after.outputs[SECOND_HERO_TEXTURE_REL],
					secondLocked,
					"the unplanned recipe keeps its lock entry",
				);
				assert.deepEqual(
					await readFile(join(projectDir, SECOND_HERO_TEXTURE_REL)),
					secondBytes,
					"the unplanned recipe's asset is not rewritten",
				);
				assert.equal(
					Object.keys(after.outputs).length,
					Object.keys(before.outputs).length - 1,
					"exactly one entry left the lock",
				);

				const summary = await checkResourcePack({
					projectPath: projectPath(projectDir),
				});
				assert.equal(summary.verdict, "pass");
				assert.deepEqual(summary.fixList, []);
			});
		},
	},
	{
		name: "moving a target to another recipe updates its lock ownership without rewriting the asset",
		async run() {
			await withDemoProject(async (projectDir) => {
				await buildDemo(projectDir);
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const before = parseLockText(await readFile(lockPath, "utf8"));
				const heroBefore = before.outputs[HERO_TEXTURE_REL];
				assert.ok(heroBefore, "the first recipe owns the hero texture");
				const heroBytes = await readFile(join(projectDir, HERO_TEXTURE_REL));

				await moveHeroToSecondRecipe(projectDir);

				const moved = await buildDemo(projectDir);
				assert.deepEqual(
					moved.completed,
					[],
					"the same bytes are not rewritten",
				);
				const afterMove = parseLockText(await readFile(lockPath, "utf8"));
				assert.equal(
					afterMove.outputs[HERO_TEXTURE_REL]?.recipeId,
					"second-demo",
					"the lock follows the target to its new recipe",
				);
				assert.equal(
					afterMove.outputs[HERO_TEXTURE_REL]?.targetId,
					"aurelian_hero",
					"the lock keeps the target id",
				);
				assert.equal(
					afterMove.outputs[HERO_TEXTURE_REL]?.outputHash,
					heroBefore.outputHash,
					"the recorded output is unchanged",
				);
				assert.deepEqual(
					await readFile(join(projectDir, HERO_TEXTURE_REL)),
					heroBytes,
					"the asset file is unchanged",
				);

				const firstRecipePath = join(projectDir, RECIPE_REL);
				const secondRecipePath = join(
					projectDir,
					"recipes",
					"second.recipe.json",
				);
				const firstOnly = await buildDemo(projectDir, firstRecipePath);
				assert.deepEqual(firstOnly.completed, []);
				const afterFirst = parseLockText(await readFile(lockPath, "utf8"));
				assert.deepEqual(
					afterFirst.outputs[HERO_TEXTURE_REL],
					afterMove.outputs[HERO_TEXTURE_REL],
					"building the old recipe leaves the moved entry alone",
				);

				const secondPlan = await planPackBuild(projectPath(projectDir), {
					recipe: secondRecipePath,
				});
				assert.ok(
					secondPlan.outputs.every(
						(output) => output.judgement === "own-clean",
					),
					"the new recipe sees only its own clean output",
				);
				const secondOnly = await executePackBuild(secondPlan);
				assert.deepEqual(
					secondOnly.completed,
					[],
					"the new recipe rewrites nothing",
				);
			});
		},
	},
	{
		name: "a moved target survives building the old recipe first and the new one second",
		async run() {
			await withDemoProject(async (projectDir) => {
				await buildDemo(projectDir);
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const before = parseLockText(await readFile(lockPath, "utf8"));
				const heroBefore = before.outputs[HERO_TEXTURE_REL];
				assert.ok(heroBefore, "the first recipe owns the hero texture");
				const heroBytes = await readFile(join(projectDir, HERO_TEXTURE_REL));

				await moveHeroToSecondRecipe(projectDir);
				const firstRecipePath = join(projectDir, RECIPE_REL);
				const secondRecipePath = join(
					projectDir,
					"recipes",
					"second.recipe.json",
				);

				// No full build in between: the old recipe must not mistake the
				// moved target's entry for one of its own stale files.
				const firstOnly = await buildDemo(projectDir, firstRecipePath);
				assert.deepEqual(firstOnly.completed, []);
				const afterFirst = parseLockText(await readFile(lockPath, "utf8"));
				assert.deepEqual(
					afterFirst.outputs[HERO_TEXTURE_REL],
					heroBefore,
					"building the old recipe first keeps the moved entry",
				);

				const secondPlan = await planPackBuild(projectPath(projectDir), {
					recipe: secondRecipePath,
				});
				assert.ok(
					secondPlan.outputs.every(
						(output) => output.judgement === "own-clean",
					),
					"the new recipe sees only its own clean output",
				);
				const secondOnly = await executePackBuild(secondPlan);
				assert.deepEqual(
					secondOnly.completed,
					[],
					"the new recipe rewrites nothing",
				);
				const afterSecond = parseLockText(await readFile(lockPath, "utf8"));
				assert.equal(
					afterSecond.outputs[HERO_TEXTURE_REL]?.recipeId,
					"second-demo",
					"the new recipe now owns the moved entry",
				);
				assert.equal(
					afterSecond.outputs[HERO_TEXTURE_REL]?.outputHash,
					heroBefore.outputHash,
					"the recorded output stays the same",
				);
				assert.deepEqual(
					await readFile(join(projectDir, HERO_TEXTURE_REL)),
					heroBytes,
					"the asset file is unchanged",
				);
			});
		},
	},
	{
		name: "a recipe outside the project keeps its lock entries across a full build",
		async run() {
			await withDemoProject(async (projectDir, root) => {
				const externalDir = join(root, "external");
				await mkdir(externalDir, { recursive: true });
				const externalRecipePath = join(externalDir, "ext.recipe.json");
				await writeFile(
					externalRecipePath,
					`${JSON.stringify(
						{
							formatVersion: 3,
							id: "ext",
							targets: [
								{
									id: "ext_hero",
									steps: [
										{
											type: "entityTemplate",
											layout: "player_wide",
											output: "assets/{namespace}/textures/entity/ext_hero.png",
										},
									],
								},
							],
						},
						null,
						"\t",
					)}\n`,
					"utf8",
				);
				const externalHeroRel =
					"pack/assets/aurelian/textures/entity/ext_hero.png";
				const lockPath = join(projectDir, "mc-asset.lock.json");

				const externalOnly = await buildDemo(projectDir, externalRecipePath);
				assert.deepEqual(
					externalOnly.completed,
					[externalHeroRel],
					"the external recipe builds its output",
				);
				const afterExternal = parseLockText(await readFile(lockPath, "utf8"));
				const extEntry = afterExternal.outputs[externalHeroRel];
				assert.ok(extEntry, "the external recipe is locked");
				assert.equal(extEntry.recipeId, "ext", "the lock records its id");
				const extBytes = await readFile(join(projectDir, externalHeroRel));

				const full = await buildDemo(projectDir);
				assert.equal(
					full.completed.length,
					20,
					"the full build plans every demo output",
				);
				const afterFull = parseLockText(await readFile(lockPath, "utf8"));
				assert.deepEqual(
					afterFull.outputs[externalHeroRel],
					extEntry,
					"the full build keeps the external entry",
				);

				const again = await buildDemo(projectDir, externalRecipePath);
				assert.deepEqual(
					again.completed,
					[],
					"the external recipe is still own-clean",
				);
				const final = parseLockText(await readFile(lockPath, "utf8"));
				assert.deepEqual(
					final.outputs[externalHeroRel],
					extEntry,
					"the entry survives the round trip unchanged",
				);
				assert.deepEqual(
					await readFile(join(projectDir, externalHeroRel)),
					extBytes,
					"the external asset is unchanged",
				);
			});
		},
	},
	{
		name: "two recipe files that share an id keep each other's lock entries in a single-recipe build",
		async run() {
			await withDemoProject(async (projectDir) => {
				await writeExtraRecipe(projectDir, "second.recipe.json", {
					formatVersion: 3,
					id: "aurelian-demo",
					targets: [
						{
							id: "second_hero",
							steps: [
								{
									type: "entityTemplate",
									layout: "player_wide",
									output: "assets/{namespace}/textures/entity/second_hero.png",
								},
							],
						},
					],
				});
				const first = await buildDemo(projectDir);
				assert.equal(first.completed.length, 21, "both recipe files build");

				const lockPath = join(projectDir, "mc-asset.lock.json");
				const before = parseLockText(await readFile(lockPath, "utf8"));
				const secondLocked = before.outputs[SECOND_HERO_TEXTURE_REL];
				assert.ok(secondLocked, "the second recipe file is locked");

				const firstRecipePath = join(projectDir, RECIPE_REL);
				const secondRecipePath = join(
					projectDir,
					"recipes",
					"second.recipe.json",
				);
				const firstOnly = await buildDemo(projectDir, firstRecipePath);
				assert.deepEqual(
					firstOnly.completed,
					[],
					"the first file rewrites nothing",
				);
				const afterFirst = parseLockText(await readFile(lockPath, "utf8"));
				assert.deepEqual(
					afterFirst.outputs[SECOND_HERO_TEXTURE_REL],
					secondLocked,
					"the shared id keeps the other file's entry",
				);

				const secondPlan = await planPackBuild(projectPath(projectDir), {
					recipe: secondRecipePath,
				});
				assert.ok(
					secondPlan.outputs.every(
						(output) => output.judgement === "own-clean",
					),
					"the second file is still tracked as own-clean",
				);
				const secondOnly = await executePackBuild(secondPlan);
				assert.deepEqual(secondOnly.completed, []);
			});
		},
	},
	{
		name: "renaming the recipe id and dropping a target keeps pack check passing before any lock cleanup",
		async run() {
			await withDemoProject(async (projectDir) => {
				await buildDemo(projectDir);
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const before = parseLockText(await readFile(lockPath, "utf8"));
				const heroBefore = before.outputs[HERO_TEXTURE_REL];
				assert.ok(heroBefore, "the hero starts locked");

				await renameRecipeId(projectDir, "aurelian-demo-v2");
				await removeRecipeTarget(projectDir, "aurelian_hero");
				await unlink(join(projectDir, HERO_TEXTURE_REL));

				// Nothing has cleaned the lock: it still names the old id and a
				// file that no recipe plans anymore, which is not a pack defect.
				const stale = parseLockText(await readFile(lockPath, "utf8"));
				assert.deepEqual(
					stale.outputs[HERO_TEXTURE_REL],
					heroBefore,
					"the old entry is still recorded",
				);
				const summary = await checkResourcePack({
					projectPath: projectPath(projectDir),
				});
				assert.equal(
					summary.verdict,
					"pass",
					"the dropped target is not reported as missing",
				);
				assert.deepEqual(summary.fixList, [], "nothing to fix");

				// A full build renames the planned entries but cannot prove the
				// old id is gone rather than owned by a recipe outside the
				// project, so the old entry stays until the lock is cleaned.
				const rebuilt = await buildDemo(projectDir);
				assert.deepEqual(rebuilt.completed, [], "only lock records change");
				const after = parseLockText(await readFile(lockPath, "utf8"));
				assert.deepEqual(
					after.outputs[HERO_TEXTURE_REL],
					heroBefore,
					"the removed target's old entry stays for a manual cleanup",
				);
				assert.ok(
					Object.entries(after.outputs)
						.filter(([path]) => path !== HERO_TEXTURE_REL)
						.every(([, entry]) => entry.recipeId === "aurelian-demo-v2"),
					"every surviving planned entry records the new id",
				);

				const finalCheck = await checkResourcePack({
					projectPath: projectPath(projectDir),
				});
				assert.equal(finalCheck.verdict, "pass", "pack check still passes");
				assert.deepEqual(finalCheck.fixList, [], "nothing to fix");
			});
		},
	},
	{
		name: "a dry run or a build conflict leaves a stale lock entry untouched",
		async run() {
			await withDemoProject(async (projectDir) => {
				await buildDemo(projectDir);
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const lockBytes = await readFile(lockPath);

				await removeRecipeTarget(projectDir, "aurelian_hero");
				await unlink(join(projectDir, HERO_TEXTURE_REL));

				const dryPlan = await planPackBuild(projectPath(projectDir), {
					dryRun: true,
				});
				assert.deepEqual((await executePackBuild(dryPlan)).completed, []);
				assert.deepEqual(
					await readFile(lockPath),
					lockBytes,
					"a dry run writes no lock",
				);
				const afterDryRun = parseLockText(await readFile(lockPath, "utf8"));
				assert.ok(
					afterDryRun.outputs[HERO_TEXTURE_REL],
					"the dropped target is not committed yet",
				);
				const meanwhile = await checkResourcePack({
					projectPath: projectPath(projectDir),
				});
				assert.equal(
					meanwhile.verdict,
					"pass",
					"the dropped target is reconciled by the recipes, not the lock",
				);
				assert.deepEqual(meanwhile.fixList, [], "nothing to fix");

				// A hand-edited generated file conflicts before anything is staged,
				// so the conflict must not prune the entry either.
				const definitionRel = "pack/assets/aurelian/font/icons.json";
				const definitionPath = join(projectDir, definitionRel);
				await writeFile(
					definitionPath,
					`${await readFile(definitionPath, "utf8")}\n`,
					"utf8",
				);
				const refusal = await refusalOf(async () => buildDemo(projectDir));
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				assert.deepEqual(
					await readFile(lockPath),
					lockBytes,
					"the conflict writes no lock",
				);
				const afterConflict = parseLockText(await readFile(lockPath, "utf8"));
				assert.ok(
					afterConflict.outputs[HERO_TEXTURE_REL],
					"the conflict leaves the stale entry",
				);
			});
		},
	},
	{
		name: "packaging the demo twice produces the same zip",
		async run() {
			await withDemoProject(async (projectDir, root) => {
				await buildDemo(projectDir);
				const first = join(root, "pack-1.zip");
				const second = join(root, "pack-2.zip");
				const a = await packageResourcePack({
					projectPath: projectPath(projectDir),
					outputPath: first,
					mkdir: true,
				});
				const b = await packageResourcePack({
					projectPath: projectPath(projectDir),
					outputPath: second,
					mkdir: true,
				});
				assert.equal(a.fileCount, b.fileCount);
				assert.equal(a.totalBytes, b.totalBytes);
				const bytes = await readFile(first);
				assert.deepEqual(await readFile(second), bytes, "the two zips match");
				// Deflate streams come from the runtime's zlib, so the frozen
				// cross-runtime tree hash above covers the build outputs and
				// the lock; this case covers reproducibility within a runtime.
			});
		},
	},
];
