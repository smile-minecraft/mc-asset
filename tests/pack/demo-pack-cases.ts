import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	cp,
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
 * the lock vocabulary, the conflict refusal, the defect fix list, and the
 * frozen bytes both runtimes must produce.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "demo-pack");
const PROJECT_FILE = "mc-asset.pack.json";

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

async function buildDemo(projectDir: string) {
	return executePackBuild(await planPackBuild(projectPath(projectDir)));
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
