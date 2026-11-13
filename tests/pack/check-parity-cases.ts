import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { encodePng } from "../../src/io/png.ts";
import { executePackBuild, planPackBuild } from "../../src/pack/build.ts";
import {
	checkResourcePack,
	type PackCheckSummary,
} from "../../src/pack/check.ts";
import { initializePackProject } from "../../src/pack/init.ts";
import type { LockDocument, LockEntry } from "../../src/pack/lock.ts";
import { parseLockText, serializeLockText } from "../../src/pack/lock.ts";

/**
 * `pack check` over packs that mix painted textures with recipe-generated
 * families. Generator outputs carry a lock kind of their own, so the check
 * can leave their noisy style and orphan findings out without changing what
 * it reports for every other texture: the same project must produce the same
 * findings it produced before generator steps existed, whatever the folder.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_FIXTURE = join(HERE, "fixtures", "demo-pack");
const PROJECT_FILE = "mc-asset.pack.json";

interface CheckCase {
	readonly name: string;
	run(): Promise<void>;
}

/** Codes whose output the pre-generator check and this one must agree on. */
function isStyleOrOrphan(code: string): boolean {
	return code === "PACK_ORPHAN_TEXTURE" || code.startsWith("STYLE_");
}

/** The style and orphan part of a summary, untouched, as `pack check` reports it. */
function styleAndOrphan(summary: PackCheckSummary) {
	return {
		groups: summary.groups.filter((group) => isStyleOrOrphan(group.code)),
		fixList: summary.fixList.filter((fix) => isStyleOrOrphan(fix.code)),
		textureCount: summary.textureCount,
	};
}

function rgba(hex: string): [number, number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
		255,
	];
}

/**
 * A 16x16 painted sprite: a two-step body, a dark frame, and two isolated
 * bright pixels. Vanilla style measures it with three warnings and the pack
 * scan calls it orphan, which is exactly what a hand-drawn, unreferenced
 * texture looked like before recipe generators existed.
 */
function paintedSprite(): Uint8Array {
	const width = 16;
	const height = 16;
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	const put = (x: number, y: number, color: readonly number[]) => {
		const offset = (y * width + x) * 4;
		pixels[offset] = color[0];
		pixels[offset + 1] = color[1];
		pixels[offset + 2] = color[2];
		pixels[offset + 3] = color[3];
	};
	const transparent = [0, 0, 0, 0];
	const frame = rgba("#404040");
	const body = rgba("#909090");
	const bright = rgba("#F4F4F4");
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			put(x, y, transparent);
		}
	}
	for (let y = 3; y < 13; y += 1) {
		for (let x = 3; x < 13; x += 1) {
			const edge = x === 3 || y === 3 || x === 12 || y === 12;
			put(x, y, edge ? frame : body);
		}
	}
	put(5, 5, bright);
	put(10, 10, bright);
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function withTempDir(
	body: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-check-parity-"));
	try {
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function withDemoProject(
	body: (projectDir: string) => Promise<void>,
): Promise<void> {
	await withTempDir(async (dir) => {
		const projectDir = join(dir, "aurelian-forge");
		await cp(DEMO_FIXTURE, projectDir, { recursive: true });
		await body(projectDir);
	});
}

function projectPathOf(projectDir: string): string {
	return join(projectDir, PROJECT_FILE);
}

async function buildDemo(projectDir: string): Promise<void> {
	await executePackBuild(await planPackBuild(projectPathOf(projectDir)));
}

async function writeSprite(
	projectDir: string,
	relativePath: string,
	bytes: Uint8Array,
): Promise<void> {
	const full = join(projectDir, relativePath);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, bytes);
}

/**
 * What `pack check` reported for the hand-painted fixture at 61c422e, the
 * commit before recipe generator steps existed. Every entry is part of the
 * `pack check --json` output: the five sprites are painted, no lock names
 * them, and the fix list keeps its stable order (count descending, then
 * code bytes).
 */
const PRE_GENERATOR_FINDINGS = {
	groups: [
		{ code: "PACK_ORPHAN_TEXTURE", count: 5 },
		{ code: "STYLE_HIGHLIGHT_ISOLATED", count: 5 },
		{ code: "STYLE_LEVELS_TOO_FEW", count: 5 },
		{ code: "STYLE_LIGHT_DIRECTION", count: 5 },
	],
	fixList: [
		{
			code: "PACK_ORPHAN_TEXTURE",
			level: "warning",
			count: 5,
			samplePaths: [
				"assets/demo/textures/block/hero.png",
				"assets/demo/textures/entity/hero.png",
				"assets/demo/textures/environment/hero.png",
			],
			suggestion: "Fix pack finding: PACK_ORPHAN_TEXTURE.",
		},
		{
			code: "STYLE_HIGHLIGHT_ISOLATED",
			level: "warning",
			count: 5,
			samplePaths: [
				"assets/demo/textures/block/hero.png",
				"assets/demo/textures/entity/hero.png",
				"assets/demo/textures/environment/hero.png",
			],
			suggestion: "add a transition color beside the brightest pixels",
		},
		{
			code: "STYLE_LEVELS_TOO_FEW",
			level: "warning",
			count: 5,
			samplePaths: [
				"assets/demo/textures/block/hero.png",
				"assets/demo/textures/entity/hero.png",
				"assets/demo/textures/environment/hero.png",
			],
			suggestion: "add one mid lightness step instead of extra noise pixels",
		},
		{
			code: "STYLE_LIGHT_DIRECTION",
			level: "warning",
			count: 5,
			samplePaths: [
				"assets/demo/textures/block/hero.png",
				"assets/demo/textures/entity/hero.png",
				"assets/demo/textures/environment/hero.png",
			],
			suggestion:
				"move the highlight to the top-left edge and repaint the shaded side",
		},
	],
	textureCount: 5,
};

const PAINTED_PATHS = [
	"pack/assets/demo/textures/block/hero.png",
	"pack/assets/demo/textures/entity/hero.png",
	"pack/assets/demo/textures/environment/hero.png",
	"pack/assets/demo/textures/gui/hero.png",
	"pack/assets/demo/textures/item/hero.png",
] as const;

export const CHECK_PARITY_CASES: readonly CheckCase[] = [
	{
		name: "pack check reports the same style and orphan findings as before generator steps",
		async run() {
			await withTempDir(async (dir) => {
				const projectDir = join(dir, "painted");
				await initializePackProject({
					projectDir,
					namespace: "demo",
					minecraftVersion: "1.21.9",
					name: "painted",
				});
				const sprite = paintedSprite();
				for (const relativePath of PAINTED_PATHS) {
					await writeSprite(projectDir, relativePath, sprite);
				}

				const summary = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.deepEqual(
					styleAndOrphan(summary),
					PRE_GENERATOR_FINDINGS,
					"a pack without a lock keeps every pre-generator finding",
				);

				// An older build's lock names the same files as ordinary
				// target textures. None of the generator kinds appear, so the
				// check must not start skipping anything.
				const outputs: Record<string, LockEntry> = {};
				for (const [index, path] of PAINTED_PATHS.entries()) {
					outputs[path] = {
						targetId: `hero_${index}`,
						recipeId: "one",
						kind: "texture",
						inputHash: sha256(new TextEncoder().encode(path)),
						outputHash: sha256(sprite),
					};
				}
				const lock: LockDocument = {
					formatVersion: 1,
					tool: { name: "mc-asset", version: "0.5.0" },
					project: { namespace: "demo", style: "vanilla" },
					outputs,
				};
				await writeFile(
					join(projectDir, "mc-asset.lock.json"),
					serializeLockText(lock),
					"utf8",
				);
				const withLock = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.deepEqual(
					styleAndOrphan(withLock),
					PRE_GENERATOR_FINDINGS,
					"a lock without generator kinds keeps every pre-generator finding",
				);
			});
		},
	},
	{
		name: "recipe-generated textures skip style and orphan findings while a hand-written entity texture keeps them",
		async run() {
			await withDemoProject(async (projectDir) => {
				await buildDemo(projectDir);
				const baseline = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.deepEqual(
					styleAndOrphan(baseline),
					{ groups: [], fixList: [], textureCount: 9 },
					"every texture of the demo pack is either measured clean or generated",
				);

				const handmade = "pack/assets/aurelian/textures/entity/handmade.png";
				await writeSprite(projectDir, handmade, paintedSprite());
				const summary = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.deepEqual(
					styleAndOrphan(summary).groups,
					[
						{ code: "PACK_ORPHAN_TEXTURE", count: 1 },
						{ code: "STYLE_HIGHLIGHT_ISOLATED", count: 1 },
						{ code: "STYLE_LEVELS_TOO_FEW", count: 1 },
						{ code: "STYLE_LIGHT_DIRECTION", count: 1 },
					],
					"a hand-written entity texture keeps the findings it had before generator steps",
				);
				const relevant = summary.fixList.filter((fix) =>
					isStyleOrOrphan(fix.code),
				);
				assert.equal(relevant.length, 4, "one fix entry per code");
				for (const fix of relevant) {
					assert.deepEqual(
						fix.samplePaths,
						["assets/aurelian/textures/entity/handmade.png"],
						`${fix.code} points at the hand-written texture only`,
					);
				}
			});
		},
	},
	{
		name: "the lock kind, not the texture path, decides whether a texture was generated",
		async run() {
			await withDemoProject(async (projectDir) => {
				await buildDemo(projectDir);
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const entityTemplate =
					"pack/assets/aurelian/textures/entity/aurelian_hero.png";
				const lock = parseLockText(await readFile(lockPath, "utf8"));
				const entry = lock.outputs[entityTemplate];
				assert.ok(entry !== undefined, "the template has a lock entry");
				assert.equal(
					entry.kind,
					"entityTemplate",
					"the template is locked under its generator kind",
				);
				const rewritten = {
					...lock,
					outputs: {
						...lock.outputs,
						[entityTemplate]: { ...entry, kind: "texture" as const },
					},
				};
				await writeFile(lockPath, serializeLockText(rewritten), "utf8");

				const summary = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.deepEqual(
					styleAndOrphan(summary).groups,
					[
						{ code: "PACK_ORPHAN_TEXTURE", count: 1 },
						{ code: "STYLE_DYNAMIC_RANGE", count: 1 },
						{ code: "STYLE_HIGHLIGHT_COUNT", count: 1 },
						{ code: "STYLE_HIGHLIGHT_ISOLATED", count: 1 },
						{ code: "STYLE_LIGHT_DIRECTION", count: 1 },
						{ code: "STYLE_OUTLINE_DARKNESS", count: 1 },
						{ code: "STYLE_OUTLINE_HUE", count: 1 },
					],
					"the entity path reports once its lock kind is no longer a generator kind",
				);
				for (const fix of summary.fixList.filter((candidate) =>
					isStyleOrOrphan(candidate.code),
				)) {
					assert.deepEqual(
						fix.samplePaths,
						["assets/aurelian/textures/entity/aurelian_hero.png"],
						`${fix.code} points at the reclassified template`,
					);
				}
			});
		},
	},
	{
		name: "a lock that records only older kinds reports no generated-output finding",
		async run() {
			await withTempDir(async (dir) => {
				const projectDir = join(dir, "old-kinds");
				await initializePackProject({
					projectDir,
					namespace: "demo",
					minecraftVersion: "1.21.9",
					name: "old-kinds",
				});
				const entries: ReadonlyArray<[string, LockEntry["kind"]]> = [
					["pack/assets/demo/textures/item/missing.png", "texture"],
					["pack/assets/demo/models/item/missing.json", "model"],
					["pack/assets/demo/items/missing.json", "itemDefinition"],
					["pack/assets/demo/models/block/missing.json", "blockModel"],
					["pack/assets/demo/models/item/missing_block.json", "blockItemModel"],
					["pack/assets/demo/blockstates/missing.json", "blockstate"],
				];
				const outputs: Record<string, LockEntry> = {};
				for (const [index, [path, kind]] of entries.entries()) {
					outputs[path] = {
						targetId: `missing_${index}`,
						recipeId: "one",
						kind,
						inputHash: sha256(new TextEncoder().encode(path)),
						outputHash: sha256(new TextEncoder().encode(`${path}:out`)),
					};
				}
				const lock: LockDocument = {
					formatVersion: 1,
					tool: { name: "mc-asset", version: "0.5.0" },
					project: { namespace: "demo", style: "vanilla" },
					outputs,
				};
				await writeFile(
					join(projectDir, "mc-asset.lock.json"),
					serializeLockText(lock),
					"utf8",
				);
				const summary = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.equal(
					summary.verdict,
					"pass",
					"missing paths under older kinds stay outside the generated-output check",
				);
				assert.deepEqual(summary.fixList, [], "there is nothing to fix");
			});
		},
	},
];
