import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getEntityLayoutDocument,
	resolveEntityLayoutDocument,
} from "../../src/entity/index.ts";
import { buildEntityTemplate } from "../../src/entity/template.ts";
import { planEquipmentAsset } from "../../src/equipment/index.ts";
import { encodePng } from "../../src/io/png.ts";
import { executePackBuild, planPackBuild } from "../../src/pack/build.ts";
import { initializePackProject } from "../../src/pack/init.ts";
import { parseLockText } from "../../src/pack/lock.ts";

/**
 * Generator-backed recipe steps: entity texture templates, equipment, fonts,
 * and particles. Every case builds a real project through the same plan and
 * execute pair `pack build` uses, so the lock, the classifications, and the
 * refusal shapes are observed end to end.
 */

const NAMESPACE = "aurelian";

interface Refusal {
	code?: string;
	details?: Record<string, unknown> | undefined;
}

interface GeneratedCase {
	readonly name: string;
	run(): Promise<void>;
}

async function withProject(
	body: (projectDir: string) => Promise<void>,
	minecraftVersion = "1.21.9",
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-generated-"));
	try {
		const projectDir = join(dir, "aurelian-forge");
		await initializePackProject({
			projectDir,
			namespace: NAMESPACE,
			minecraftVersion,
			name: "aurelian-forge",
		});
		await body(projectDir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeRecipe(
	projectDir: string,
	name: string,
	recipe: unknown,
): Promise<string> {
	const dir = join(projectDir, "recipes");
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${name}.recipe.json`);
	await writeFile(path, `${JSON.stringify(recipe, null, 2)}\n`, "utf8");
	return path;
}

async function writeText(
	projectDir: string,
	relativePath: string,
	text: string,
): Promise<void> {
	const path = join(projectDir, relativePath);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, text, "utf8");
}

function projectPath(projectDir: string): string {
	return join(projectDir, "mc-asset.pack.json");
}

async function build(projectDir: string) {
	return executePackBuild(await planPackBuild(projectPath(projectDir)));
}

async function bytesAt(path: string): Promise<Uint8Array | null> {
	try {
		return await readFile(path);
	} catch {
		return null;
	}
}

async function refusalOf(body: () => Promise<unknown>): Promise<Refusal> {
	try {
		await body();
	} catch (error) {
		return error as Refusal;
	}
	assert.fail("expected a refusal but the call succeeded");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The bytes the standalone entity template command writes for a layout. */
function expectedTemplate(layoutId: string, fill = true): Uint8Array {
	const layout = resolveEntityLayoutDocument(getEntityLayoutDocument(layoutId));
	return encodePng(buildEntityTemplate(layout, { fill }).canvas);
}

const ENTITY_OUTPUT = `assets/${NAMESPACE}/textures/entity/hero.png`;
const ENTITY_SOURCE = `assets/${NAMESPACE}/textures/entity/hero.mcpx`;

/** The file on disk for a pack-relative output path. */
function onDisk(projectDir: string, relativePath: string): string {
	return join(projectDir, "pack", relativePath);
}

/** Write a file below the pack output directory, creating parents. */
async function writePackFile(
	projectDir: string,
	relativePath: string,
	data: string | Uint8Array,
): Promise<void> {
	const path = onDisk(projectDir, relativePath);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, data);
}

function entityRecipe(
	steps: unknown[],
	formatVersion = 3,
): Record<string, unknown> {
	return {
		formatVersion,
		id: "hero-template",
		targets: [{ id: "hero", steps }],
	};
}

export const GENERATED_RECIPE_CASES: readonly GeneratedCase[] = [
	{
		name: "an entityTemplate step writes the player template and both lock entries",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(
					projectDir,
					"hero",
					entityRecipe([
						{
							type: "entityTemplate",
							layout: "player_wide",
							output: ENTITY_OUTPUT,
							mcpxOutput: ENTITY_SOURCE,
						},
					]),
				);
				const plan = await planPackBuild(projectPath(projectDir));
				assert.equal(plan.outputs.length, 2, "one PNG plus one .mcpx");
				assert.deepEqual(
					plan.outputs.map((output) => output.path),
					[`pack/${ENTITY_OUTPUT}`, `pack/${ENTITY_SOURCE}`],
					"both planned paths are project-relative",
				);
				const executed = await build(projectDir);
				assert.deepEqual(
					[...executed.completed].sort(),
					[`pack/${ENTITY_SOURCE}`, `pack/${ENTITY_OUTPUT}`],
					"both files are written",
				);

				const png = await bytesAt(onDisk(projectDir, ENTITY_OUTPUT));
				assert.ok(png, "the template PNG exists");
				assert.equal(
					sha256(png),
					sha256(expectedTemplate("player_wide")),
					"the PNG is the standalone template's bytes",
				);
				const mcpx = await bytesAt(onDisk(projectDir, ENTITY_SOURCE));
				assert.ok(mcpx, "the .mcpx exists");
				assert.ok(
					new TextDecoder().decode(mcpx).includes("player_wide"),
					"the .mcpx carries the layout id",
				);

				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				assert.deepEqual(
					Object.keys(lock.outputs).sort(),
					[`pack/${ENTITY_SOURCE}`, `pack/${ENTITY_OUTPUT}`],
					"the lock records both files",
				);
				const texture = lock.outputs[`pack/${ENTITY_OUTPUT}`];
				const source = lock.outputs[`pack/${ENTITY_SOURCE}`];
				assert.equal(texture?.kind, "entityTemplate");
				assert.equal(source?.kind, "entityTemplateSource");
				assert.equal(texture?.targetId, "hero");
				assert.equal(texture?.recipeId, "hero-template");
				assert.equal(texture?.inputHash, source?.inputHash);
				assert.equal(texture?.outputHash, sha256(png));
				assert.equal(source?.outputHash, sha256(mcpx));
			});
		},
	},
	{
		name: "an entityTemplate step defaults to a player_wide template named after the target",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(
					projectDir,
					"hero",
					entityRecipe([{ type: "entityTemplate" }]),
				);
				await build(projectDir);
				const path = `assets/${NAMESPACE}/textures/entity/hero.png`;
				const png = await bytesAt(onDisk(projectDir, path));
				assert.ok(png, "the default output exists");
				assert.equal(sha256(png), sha256(expectedTemplate("player_wide")));
			});
		},
	},
	{
		name: "an unchanged rerun classifies generated files own-clean and rewrites nothing",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(
					projectDir,
					"hero",
					entityRecipe([{ type: "entityTemplate", output: ENTITY_OUTPUT }]),
				);
				await build(projectDir);
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const lockBefore = await bytesAt(lockPath);
				const plan = await planPackBuild(projectPath(projectDir));
				assert.ok(
					plan.outputs.every((output) => output.judgement === "own-clean"),
					"the rerun sees only own-clean outputs",
				);
				const executed = await executePackBuild(plan);
				assert.deepEqual(executed.completed, [], "nothing is rewritten");
				assert.deepEqual(await bytesAt(lockPath), lockBefore);
			});
		},
	},
	{
		name: "a hand-edited generated file refuses the batch and lists the conflict",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(
					projectDir,
					"hero",
					entityRecipe([{ type: "entityTemplate", output: ENTITY_OUTPUT }]),
				);
				await build(projectDir);
				await writePackFile(projectDir, ENTITY_OUTPUT, "hand edit");
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const lockBefore = await bytesAt(lockPath);
				const refusal = await refusalOf(async () => build(projectDir));
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				assert.deepEqual(refusal.details?.conflicts, [
					{ path: `pack/${ENTITY_OUTPUT}`, reason: "own-modified" },
				]);
				assert.deepEqual(await bytesAt(lockPath), lockBefore);
			});
		},
	},
	{
		name: "a foreign file at a generated path refuses the batch before any write",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(
					projectDir,
					"hero",
					entityRecipe([{ type: "entityTemplate", output: ENTITY_OUTPUT }]),
				);
				await writePackFile(projectDir, ENTITY_OUTPUT, "someone else");
				const refusal = await refusalOf(async () => build(projectDir));
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				assert.deepEqual(refusal.details?.conflicts, [
					{ path: `pack/${ENTITY_OUTPUT}`, reason: "foreign" },
				]);
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"a refused batch writes no lock",
				);
			});
		},
	},
	{
		name: "a layout document path feeds the template and changing it forces a rewrite",
		async run() {
			await withProject(async (projectDir) => {
				const layout = {
					format: "mc-asset/entity-layout",
					version: 1,
					id: "demo_block",
					texture: { width: 16, height: 16 },
					parts: [
						{
							id: "cube",
							size: [4, 4, 4],
							uv: [0, 0],
							layer: "base",
							origin: [0, 0, 0],
							pivot: [0, 0, 0],
						},
					],
				};
				await writeText(
					projectDir,
					"recipes/sources/demo.layout.json",
					`${JSON.stringify(layout, null, 2)}\n`,
				);
				await writeRecipe(
					projectDir,
					"hero",
					entityRecipe([
						{
							type: "entityTemplate",
							layout: "sources/demo.layout.json",
							output: ENTITY_OUTPUT,
						},
					]),
				);
				await build(projectDir);
				const first = await bytesAt(onDisk(projectDir, ENTITY_OUTPUT));
				assert.ok(first, "the custom layout template exists");
				const expected = encodePng(
					buildEntityTemplate(resolveEntityLayoutDocument(layout), {
						fill: true,
					}).canvas,
				);
				assert.equal(
					sha256(first),
					sha256(expected),
					"the layout document drives the template",
				);

				const changed = { ...layout, id: "demo_block_v2" };
				await writeText(
					projectDir,
					"recipes/sources/demo.layout.json",
					`${JSON.stringify(changed, null, 2)}\n`,
				);
				const executed = await build(projectDir);
				assert.deepEqual(executed.completed, [`pack/${ENTITY_OUTPUT}`]);
			});
		},
	},
	{
		name: "a malformed entityTemplate step is refused before any write",
		async run() {
			await withProject(async (projectDir) => {
				const attempts: Array<{
					name: string;
					steps: unknown[];
					code: string;
				}> = [
					{
						name: "unknown-field",
						steps: [{ type: "entityTemplate", bogus: true }],
						code: "RECIPE_INVALID",
					},
					{
						name: "bad-fill",
						steps: [{ type: "entityTemplate", fill: "yes" }],
						code: "RECIPE_INVALID",
					},
					{
						name: "bad-output",
						steps: [{ type: "entityTemplate", output: "../escape.png" }],
						code: "RECIPE_INVALID",
					},
					{
						name: "bad-layout",
						steps: [{ type: "entityTemplate", layout: "sources/missing.json" }],
						code: "RECIPE_SOURCE_MISSING",
					},
				];
				for (const attempt of attempts) {
					await writeRecipe(
						projectDir,
						attempt.name,
						entityRecipe(attempt.steps),
					);
					const refusal = await refusalOf(async () =>
						planPackBuild(projectPath(projectDir), {
							recipe: join(
								projectDir,
								"recipes",
								`${attempt.name}.recipe.json`,
							),
						}),
					);
					assert.equal(
						refusal.code,
						attempt.code,
						`${attempt.name} is refused with ${attempt.code}`,
					);
				}
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"nothing is built",
				);
			});
		},
	},
	{
		name: "entityTemplate steps need recipe formatVersion 3",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(
					projectDir,
					"hero",
					entityRecipe([{ type: "entityTemplate" }], 2),
				);
				const refusal = await refusalOf(async () =>
					planPackBuild(projectPath(projectDir)),
				);
				assert.equal(refusal.code, "RECIPE_INVALID");
				assert.equal(refusal.details?.requiredFormatVersion, 3);
			});
		},
	},
	{
		name: "an equipment step writes the definition and both armor templates",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "armor", {
					formatVersion: 3,
					id: "hero-armor",
					targets: [
						{
							id: "hero_armor",
							steps: [
								{
									type: "equipment",
									layers: ["humanoid", "humanoid_leggings"],
								},
							],
						},
					],
				});
				await build(projectDir);
				const expected = planEquipmentAsset({
					namespace: NAMESPACE,
					id: "hero_armor",
					packFormat: "69.0",
					layers: [{ type: "humanoid" }, { type: "humanoid_leggings" }],
				});
				const definitionPath = "assets/aurelian/equipment/hero_armor.json";
				const definition = await bytesAt(onDisk(projectDir, definitionPath));
				assert.ok(definition);
				assert.equal(
					sha256(definition),
					sha256(new TextEncoder().encode(expected.definition.text)),
					"the definition is the generator's text",
				);
				for (const texture of expected.textures) {
					const bytes = await bytesAt(onDisk(projectDir, texture.relativePath));
					assert.ok(bytes, `${texture.relativePath} exists`);
					assert.equal(
						sha256(bytes),
						sha256(texture.png),
						`${texture.relativePath} is the generator's PNG`,
					);
				}
				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				assert.equal(
					lock.outputs[`pack/${definitionPath}`]?.kind,
					"equipmentDefinition",
				);
				const textureEntries = Object.entries(lock.outputs).filter(
					([, entry]) => entry.kind === "equipmentTexture",
				);
				assert.equal(textureEntries.length, 2, "two armor sheets are locked");
				assert.ok(
					textureEntries.every(([, entry]) => entry.targetId === "hero_armor"),
				);
			});
		},
	},
	{
		name: "an equipment step without templates writes the definition alone",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "armor", {
					formatVersion: 3,
					id: "standalone",
					targets: [
						{
							id: "hero_armor",
							steps: [
								{ type: "equipment", template: false, layers: ["wings"] },
							],
						},
					],
				});
				const plan = await planPackBuild(projectPath(projectDir));
				assert.equal(plan.outputs.length, 1, "one JSON document");
				await executePackBuild(plan);
				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				assert.deepEqual(Object.keys(lock.outputs), [
					"pack/assets/aurelian/equipment/hero_armor.json",
				]);
			});
		},
	},
	{
		name: "equipment layer options reach the document unchanged",
		async run() {
			await withProject(async (projectDir) => {
				const layers = [
					{
						type: "humanoid",
						texture: "hero_helmet",
						dyeable: { colorWhenUndyed: -1 },
					},
					{ type: "wings", usePlayerTexture: true },
				];
				await writeRecipe(projectDir, "armor", {
					formatVersion: 3,
					id: "hero-armor",
					targets: [
						{ id: "hero_armor", steps: [{ type: "equipment", layers }] },
					],
				});
				await build(projectDir);
				const expected = planEquipmentAsset({
					namespace: NAMESPACE,
					id: "hero_armor",
					packFormat: "69.0",
					layers,
				});
				assert.equal(
					await readFile(
						onDisk(projectDir, expected.definition.relativePath),
						"utf8",
					),
					expected.definition.text,
				);
			});
		},
	},
	{
		name: "equipment version and layer gates surface as recipe refusals",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "armor", {
					formatVersion: 3,
					id: "too-old",
					targets: [
						{
							id: "hero_armor",
							steps: [{ type: "equipment", layers: ["humanoid"] }],
						},
					],
				});
				const refusal = await refusalOf(async () =>
					planPackBuild(projectPath(projectDir)),
				);
				assert.equal(refusal.code, "RECIPE_VERSION_UNSUPPORTED");
				assert.equal(refusal.details?.cause, "EQUIPMENT_VERSION_UNSUPPORTED");
			}, "1.20.4");
		},
	},
	{
		name: "an equipment layer the target predates is a recipe version refusal",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "armor", {
					formatVersion: 3,
					id: "too-new",
					targets: [
						{
							id: "hero_armor",
							steps: [{ type: "equipment", layers: ["humanoid_baby"] }],
						},
					],
				});
				const refusal = await refusalOf(async () =>
					planPackBuild(projectPath(projectDir)),
				);
				assert.equal(refusal.code, "RECIPE_VERSION_UNSUPPORTED");
				assert.equal(refusal.details?.cause, "EQUIPMENT_VERSION_UNSUPPORTED");
			});
		},
	},
	{
		name: "an unknown equipment layer type is a recipe refusal",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "armor", {
					formatVersion: 3,
					id: "unknown",
					targets: [
						{
							id: "hero_armor",
							steps: [{ type: "equipment", layers: ["cape"] }],
						},
					],
				});
				const refusal = await refusalOf(async () =>
					planPackBuild(projectPath(projectDir)),
				);
				assert.equal(refusal.code, "RECIPE_INVALID");
				assert.equal(refusal.details?.cause, "EQUIPMENT_INVALID");
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
				);
			});
		},
	},
	{
		name: "a hand-edited equipment texture refuses the batch",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "armor", {
					formatVersion: 3,
					id: "hero-armor",
					targets: [
						{
							id: "hero_armor",
							steps: [{ type: "equipment", layers: ["humanoid"] }],
						},
					],
				});
				await build(projectDir);
				const texturePath =
					"assets/aurelian/textures/entity/equipment/humanoid/hero_armor.png";
				await writePackFile(projectDir, texturePath, "hand edit");
				const refusal = await refusalOf(async () => build(projectDir));
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				assert.deepEqual(refusal.details?.conflicts, [
					{ path: `pack/${texturePath}`, reason: "own-modified" },
				]);
			});
		},
	},
	{
		name: "a minecraft-namespace entityTemplate step needs override",
		async run() {
			await withProject(async (projectDir) => {
				const doc = JSON.parse(
					await readFile(projectPath(projectDir), "utf8"),
				) as Record<string, unknown>;
				doc.namespace = "minecraft";
				doc.allowMinecraftNamespace = true;
				await writeFile(
					projectPath(projectDir),
					`${JSON.stringify(doc, null, 2)}\n`,
				);
				const output = "assets/minecraft/textures/entity/hero.png";
				await writeRecipe(
					projectDir,
					"hero",
					entityRecipe([{ type: "entityTemplate", output }]),
				);
				const refusal = await refusalOf(async () =>
					planPackBuild(projectPath(projectDir)),
				);
				assert.equal(refusal.code, "RECIPE_INVALID");
				await writeRecipe(
					projectDir,
					"hero",
					entityRecipe([{ type: "entityTemplate", output, override: true }]),
				);
				const executed = await build(projectDir);
				assert.equal(executed.completed.length, 1);
			});
		},
	},
];
