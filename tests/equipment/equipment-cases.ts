import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBuild } from "../../src/cli/cmd-build.ts";
import {
	type EquipmentCliOptions,
	runEquipment,
	undyedColorFromHex,
} from "../../src/cli/cmd-equipment.ts";
import { buildProgram } from "../../src/cli/program.ts";
import {
	type EquipmentTextureOutput,
	planEquipmentAsset,
} from "../../src/equipment/index.ts";
import { decodePng } from "../../src/io/png.ts";
import type { McpTextResult } from "../../src/mcp/handlers.ts";
import { handleEquipmentAsset } from "../../src/mcp/handlers-equipment.ts";
import { scanPack } from "../../src/validate/index.ts";
import { captureStreams } from "../cli/optimize-model-cases.ts";

/**
 * Equipment generation checks shared by the Bun and Node entries.
 *
 * The expected face rectangles below are written out by hand from the vanilla
 * model constants rather than read back from the engine:
 *
 * - `HumanoidModel.createMesh` samples head at (0,0), the helmet overlay (hat)
 *   at (32,0), body at (16,16), both arms at (40,16), and both legs at (0,16),
 *   each as an 8x8x8, 8x8x8, 8x12x4, 4x12x4, and 4x12x4 box.
 * - `ElytraModel.createLayer` samples both wings at (22,0) as a 10x20x2 box.
 *
 * A box of size w x h x d at UV (u,v) paints top at (u+d, v), bottom at
 * (u+w+d, v), right at (u, v+d), front at (u+d, v+d), left at (u+w+d, v+d),
 * and back at (u+w+2d, v+d) in the Minecraft box-UV unfolding. The six faces
 * are listed in `top, bottom, right, front, left, back` order, which is the
 * order the shared entity template engine reports.
 */

type RegionRow = readonly [
	id: string,
	layer: "base" | "overlay",
	x: number,
	y: number,
	width: number,
	height: number,
];

const HEAD_AND_HAT: readonly RegionRow[] = [
	["head.top", "base", 8, 0, 8, 8],
	["head.bottom", "base", 16, 0, 8, 8],
	["head.right", "base", 0, 8, 8, 8],
	["head.front", "base", 8, 8, 8, 8],
	["head.left", "base", 16, 8, 8, 8],
	["head.back", "base", 24, 8, 8, 8],
	["hat.top", "overlay", 40, 0, 8, 8],
	["hat.bottom", "overlay", 48, 0, 8, 8],
	["hat.right", "overlay", 32, 8, 8, 8],
	["hat.front", "overlay", 40, 8, 8, 8],
	["hat.left", "overlay", 48, 8, 8, 8],
	["hat.back", "overlay", 56, 8, 8, 8],
];

const BODY_AND_LEGS: readonly RegionRow[] = [
	["body.top", "base", 20, 16, 8, 4],
	["body.bottom", "base", 28, 16, 8, 4],
	["body.right", "base", 16, 20, 4, 12],
	["body.front", "base", 20, 20, 8, 12],
	["body.left", "base", 28, 20, 4, 12],
	["body.back", "base", 32, 20, 8, 12],
	["right_leg.top", "base", 4, 16, 4, 4],
	["right_leg.bottom", "base", 8, 16, 4, 4],
	["right_leg.right", "base", 0, 20, 4, 12],
	["right_leg.front", "base", 4, 20, 4, 12],
	["right_leg.left", "base", 8, 20, 4, 12],
	["right_leg.back", "base", 12, 20, 4, 12],
];

const HUMANODI_ARMS: readonly RegionRow[] = [
	["right_arm.top", "base", 44, 16, 4, 4],
	["right_arm.bottom", "base", 48, 16, 4, 4],
	["right_arm.right", "base", 40, 20, 4, 12],
	["right_arm.front", "base", 44, 20, 4, 12],
	["right_arm.left", "base", 48, 20, 4, 12],
	["right_arm.back", "base", 52, 20, 4, 12],
];

/** The whole humanoid sheet: head, hat, body, arms, legs. */
const EXPECTED_HUMANOID: readonly RegionRow[] = [
	...HEAD_AND_HAT,
	...BODY_AND_LEGS.slice(0, 6),
	...HUMANODI_ARMS,
	...BODY_AND_LEGS.slice(6),
];

/** The leggings layer samples only the body and both legs. */
const EXPECTED_LEGGINGS: readonly RegionRow[] = BODY_AND_LEGS;

/**
 * `ElytraModel` 10x20x2 at (22,0): the footprint runs x 22..46, y 0..22, so
 * the painted cells are x 22..45 and y 0..21 — exactly the non-transparent
 * range of vanilla `elytra.png` from 1.21.2 through 26.3.
 */
const EXPECTED_WINGS: readonly RegionRow[] = [
	["wing.top", "base", 24, 0, 10, 2],
	["wing.bottom", "base", 34, 0, 10, 2],
	["wing.right", "base", 22, 2, 2, 20],
	["wing.front", "base", 24, 2, 10, 20],
	["wing.left", "base", 34, 2, 2, 20],
	["wing.back", "base", 36, 2, 10, 20],
];

interface EquipmentEntryBody {
	texture: string;
	dyeable?: unknown;
	use_player_texture?: true;
}

interface EquipmentTextureBody {
	layerType: string;
	texture: string;
	path: string;
	layout: string;
	width: number;
	height: number;
	regions: EntityRegionBody[];
	output?: string;
	pngBase64?: string;
	sourceText?: string;
}

interface EntityRegionBody {
	id: string;
	partId: string;
	face: string;
	layer: "base" | "overlay";
	rect: { x: number; y: number; width: number; height: number };
}

interface EquipmentResultBody {
	command: string;
	id: string;
	namespace: string;
	packFormat: string;
	definitionDirectory: string;
	definition: string;
	layers: Record<string, EquipmentEntryBody[]>;
	textures: EquipmentTextureBody[];
	files: string[];
	outputDir?: string;
	definitionText?: string;
	version: Record<string, string>;
}

interface CliEnvelopeBody {
	success: boolean;
	result?: EquipmentResultBody;
	error?: { code: string; message: string; details?: unknown };
}

export interface EquipmentCase {
	readonly name: string;
	readonly run: () => Promise<void> | void;
}

/** Every path below a directory as `a/b/c`; symlinks count as entries. */
async function listAll(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (current: string, prefix: string): Promise<void> => {
		const entries = await readdir(current, { withFileTypes: true }).catch(
			() => [],
		);
		for (const entry of entries) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				await walk(join(current, entry.name), rel);
			} else {
				out.push(rel);
			}
		}
	};
	await walk(root, "");
	return out.sort();
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

interface CliRun {
	readonly code: number;
	readonly body: CliEnvelopeBody;
	readonly stdout: string;
	readonly stderr: string;
}

async function runEquipmentCli(
	id: string,
	options: EquipmentCliOptions,
): Promise<CliRun> {
	const capture = captureStreams();
	const code = await runEquipment(id, options, true, capture.streams);
	const stdout = Buffer.from(capture.stdout()).toString("utf8");
	return {
		code,
		body: JSON.parse(stdout) as CliEnvelopeBody,
		stdout,
		stderr: capture.stderrText(),
	};
}

function assertOk(run: CliRun): EquipmentResultBody {
	assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
	assert.equal(run.body.success, true, run.stdout);
	const result = run.body.result;
	assert.ok(result !== undefined, "success envelope without result");
	return result;
}

function assertRefused(run: CliRun, code: string, exitCode: number): void {
	assert.equal(run.code, exitCode, `${run.stdout}${run.stderr}`);
	assert.equal(run.body.success, false, run.stdout);
	assert.equal(run.body.error?.code, code, run.stdout);
}

function assertRegions(
	texture: EquipmentTextureOutput,
	expected: readonly RegionRow[],
): void {
	assert.equal(
		texture.regions.length,
		expected.length,
		`${texture.layerType} region count`,
	);
	for (const [index, row] of expected.entries()) {
		const region = texture.regions[index];
		assert.ok(region !== undefined, `missing region ${index}`);
		assert.deepEqual(
			[
				region.id,
				region.layer,
				region.rect.x,
				region.rect.y,
				region.rect.width,
				region.rect.height,
			],
			[...row],
			`region ${index} (${row[0]})`,
		);
		assert.equal(region.partId, row[0].slice(0, row[0].indexOf(".")));
		assert.equal(region.face, row[0].slice(row[0].indexOf(".") + 1));
	}
}

function planTexture(layerType: string): EquipmentTextureOutput {
	const plan = planEquipmentAsset({
		namespace: "demo",
		id: "gear",
		packFormat: "46.0",
		layers: [{ type: layerType }],
	});
	const texture = plan.textures[0];
	assert.ok(texture !== undefined, `no template for ${layerType}`);
	return texture;
}

function mcpBody(result: McpTextResult): Record<string, unknown> {
	const block = result.content[0];
	if (block === undefined || block.type !== "text") {
		throw new Error("MCP result has no leading text block");
	}
	return JSON.parse(block.text) as Record<string, unknown>;
}

/** Clean-pack scan: no error findings and no unreferenced equipment texture. */
async function assertPackClean(
	packRoot: string,
	packFormat: string,
): Promise<void> {
	const report = await scanPack(packRoot, { packFormat });
	const errors = report.findings.filter((finding) => finding.level === "error");
	assert.deepEqual(errors, [], JSON.stringify(report.findings, null, 2));
	const orphans = report.findings.filter(
		(finding) => finding.code === "PACK_ORPHAN_TEXTURE",
	);
	assert.deepEqual(orphans, []);
	assert.equal(report.verdict, "pass");
}

/**
 * Remove one template and rescan: the definition must now be reported as a
 * broken equipment reference. That is the proof the scan reads the definition
 * from the location the generator chose for this format, not as a model.
 */
async function assertEquipmentReferenceInterpreted(
	packRoot: string,
	packFormat: string,
	definitionPath: string,
	texturePath: string,
	layerType: string,
): Promise<void> {
	await rm(join(packRoot, ...texturePath.split("/")));
	const report = await scanPack(packRoot, { packFormat });
	const missing = report.findings.filter(
		(finding) => finding.code === "PACK_MISSING_TEXTURE",
	);
	assert.equal(missing.length, 1, JSON.stringify(report.findings, null, 2));
	const finding = missing[0];
	assert.ok(finding !== undefined);
	assert.equal(finding.path, definitionPath);
	assert.ok(
		finding.message.includes(`layers.${layerType}[0].texture`),
		finding.message,
	);
	assert.ok(finding.message.includes(texturePath), finding.message);
}

async function withTempRoot(
	prefix: string,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const GENERATED = {
	packFormat: "46.0",
	namespace: "demo",
	id: "gear",
	humanoid: "assets/demo/textures/entity/equipment/humanoid/gear.png",
	leggings: "assets/demo/textures/entity/equipment/humanoid_leggings/gear.png",
	wings: "assets/demo/textures/entity/equipment/wings/gear.png",
} as const;

export const EQUIPMENT_CASES: readonly EquipmentCase[] = [
	{
		name: "humanoid and humanoid_leggings write a pack validate-pack accepts",
		async run() {
			await withTempRoot("equipment-basic-", async (root) => {
				const pack = join(root, "pack");
				const run = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: pack,
					minecraftVersion: "1.21.4",
					layer: ["humanoid", "humanoid_leggings"],
					dyeable: ["humanoid"],
					mkdir: true,
				});
				const result = assertOk(run);
				assert.equal(result.definitionDirectory, "equipment");
				assert.equal(result.definition, "assets/demo/equipment/gear.json");
				assert.deepEqual(result.files, [
					result.definition,
					GENERATED.humanoid,
					GENERATED.leggings,
				]);
				assert.deepEqual(Object.keys(result.layers), [
					"humanoid",
					"humanoid_leggings",
				]);
				assert.deepEqual(result.layers.humanoid, [
					{ texture: "demo:gear", dyeable: {} },
				]);
				assert.deepEqual(result.layers.humanoid_leggings, [
					{ texture: "demo:gear" },
				]);

				const definition = await readJson(
					join(pack, "assets", "demo", "equipment", "gear.json"),
				);
				assert.deepEqual(definition, {
					layers: {
						humanoid: [{ texture: "demo:gear", dyeable: {} }],
						humanoid_leggings: [{ texture: "demo:gear" }],
					},
				});

				for (const relative of [GENERATED.humanoid, GENERATED.leggings]) {
					const bytes = await readFile(join(pack, ...relative.split("/")));
					const decoded = decodePng(new Uint8Array(bytes));
					assert.equal(decoded.canvas.width, 64, relative);
					assert.equal(decoded.canvas.height, 32, relative);
				}

				await assertPackClean(pack, GENERATED.packFormat);
				assert.deepEqual(
					result.textures.map((texture) => texture.path),
					[GENERATED.humanoid, GENERATED.leggings],
				);
			});
		},
	},
	{
		name: "pack format 42.0 writes models/equipment and the scan reads it as equipment",
		async run() {
			await withTempRoot("equipment-42-", async (root) => {
				const pack = join(root, "pack");
				const run = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: pack,
					resourcePackVersion: "42",
					layer: ["humanoid", "humanoid_leggings"],
					mkdir: true,
				});
				const result = assertOk(run);
				assert.equal(result.packFormat, "42.0");
				assert.equal(result.definitionDirectory, "models/equipment");
				assert.equal(
					result.definition,
					"assets/demo/models/equipment/gear.json",
				);
				const files = await listAll(pack);
				assert.ok(files.includes(result.definition), files.join(", "));
				assert.ok(
					!files.includes("assets/demo/equipment/gear.json"),
					"42.0 must not write the 46.0 location",
				);
				await assertPackClean(pack, "42.0");
				await assertEquipmentReferenceInterpreted(
					pack,
					"42.0",
					result.definition,
					GENERATED.humanoid,
					"humanoid",
				);
			});
		},
	},
	{
		name: "pack format 46.0 and 97.1 write equipment/ and the scan reads it as equipment",
		async run() {
			await withTempRoot("equipment-46-", async (root) => {
				for (const [version, format] of [
					["46", "46.0"],
					["97.1", "97.1"],
				] as const) {
					const pack = join(root, `pack-${format}`);
					const run = await runEquipmentCli("gear", {
						namespace: GENERATED.namespace,
						outputDir: pack,
						resourcePackVersion: version,
						layer: ["humanoid"],
						mkdir: true,
					});
					const result = assertOk(run);
					assert.equal(result.packFormat, format);
					assert.equal(result.definitionDirectory, "equipment");
					assert.equal(result.definition, "assets/demo/equipment/gear.json");
					const files = await listAll(pack);
					assert.ok(files.includes(result.definition), files.join(", "));
					assert.ok(
						!files.includes("assets/demo/models/equipment/gear.json"),
						`${format} must not write the 42.0 location`,
					);
					await assertPackClean(pack, format);
					await assertEquipmentReferenceInterpreted(
						pack,
						format,
						result.definition,
						GENERATED.humanoid,
						"humanoid",
					);
				}
			});
		},
	},
	{
		name: "humanoid template regions match the hand-checked HumanoidModel mesh",
		run() {
			const texture = planTexture("humanoid");
			assert.equal(texture.layoutId, "equipment_humanoid");
			assert.equal(texture.width, 64);
			assert.equal(texture.height, 32);
			assertRegions(texture, EXPECTED_HUMANOID);
			assert.deepEqual(
				texture.regions
					.filter((region) => region.layer === "overlay")
					.map((region) => region.partId),
				Array(6).fill("hat"),
			);
		},
	},
	{
		name: "humanoid_leggings template covers the body and legs at their HumanoidModel cells",
		run() {
			const texture = planTexture("humanoid_leggings");
			assert.equal(texture.layoutId, "equipment_humanoid_leggings");
			assert.equal(texture.width, 64);
			assert.equal(texture.height, 32);
			assertRegions(texture, EXPECTED_LEGGINGS);
			assert.deepEqual(
				[...new Set(texture.regions.map((region) => region.partId))],
				["body", "right_leg"],
			);
		},
	},
	{
		name: "wings template matches the ElytraModel (22,0) 10x20x2 box",
		run() {
			const texture = planTexture("wings");
			assert.equal(texture.layoutId, "equipment_wings");
			assert.equal(texture.width, 64);
			assert.equal(texture.height, 32);
			assertRegions(texture, EXPECTED_WINGS);
			let minX = Number.POSITIVE_INFINITY;
			let maxX = Number.NEGATIVE_INFINITY;
			let minY = Number.POSITIVE_INFINITY;
			let maxY = Number.NEGATIVE_INFINITY;
			for (const [, , x, y, width, height] of EXPECTED_WINGS) {
				if (x < minX) minX = x;
				if (x + width - 1 > maxX) maxX = x + width - 1;
				if (y < minY) minY = y;
				if (y + height - 1 > maxY) maxY = y + height - 1;
			}
			// Vanilla elytra.png paints exactly this block of cells.
			assert.deepEqual([minX, maxX, minY, maxY], [22, 45, 0, 21]);
		},
	},
	{
		name: "an unsupported pack format is EQUIPMENT_VERSION_UNSUPPORTED and writes nothing",
		async run() {
			await withTempRoot("equipment-format-", async (root) => {
				for (const version of ["34", "41.9", "98"]) {
					const pack = join(root, `pack-${version}`);
					const run = await runEquipmentCli("gear", {
						namespace: GENERATED.namespace,
						outputDir: pack,
						resourcePackVersion: version,
						layer: ["humanoid"],
						mkdir: true,
					});
					assertRefused(run, "EQUIPMENT_VERSION_UNSUPPORTED", 5);
					assert.deepEqual(await listAll(pack), [], version);
				}
			});
		},
	},
	{
		name: "a layer type outside the target version is EQUIPMENT_VERSION_UNSUPPORTED and writes nothing",
		async run() {
			await withTempRoot("equipment-since-", async (root) => {
				for (const [version, layer] of [
					["42", "humanoid_baby"],
					["46", "nautilus_body"],
					["42", "horse_saddle"],
				] as const) {
					const pack = join(root, `pack-${version}-${layer}`);
					const run = await runEquipmentCli("gear", {
						namespace: GENERATED.namespace,
						outputDir: pack,
						resourcePackVersion: version,
						layer: [layer],
						mkdir: true,
					});
					assertRefused(run, "EQUIPMENT_VERSION_UNSUPPORTED", 5);
					const details = run.body.error?.details as
						| { layerType?: string; since?: string }
						| undefined;
					assert.equal(details?.layerType, layer);
					assert.deepEqual(await listAll(pack), [], layer);
				}
			});
		},
	},
	{
		name: "an unknown layer type is EQUIPMENT_INVALID and writes nothing",
		async run() {
			await withTempRoot("equipment-unknown-", async (root) => {
				const pack = join(root, "pack");
				const run = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: pack,
					resourcePackVersion: "46",
					layer: ["not_a_layer"],
					mkdir: true,
				});
				assertRefused(run, "EQUIPMENT_INVALID", 2);
				assert.deepEqual(await listAll(pack), []);
			});
		},
	},
	{
		name: "a layer type without a verified layout needs template false",
		async run() {
			await withTempRoot("equipment-layout-", async (root) => {
				const pack = join(root, "pack");
				const refusal = await runEquipmentCli("horse", {
					namespace: GENERATED.namespace,
					outputDir: pack,
					resourcePackVersion: "46",
					layer: ["horse_body"],
					mkdir: true,
				});
				assertRefused(refusal, "EQUIPMENT_INVALID", 2);
				assert.deepEqual(await listAll(pack), []);

				const definitionOnly = await runEquipmentCli("horse", {
					namespace: GENERATED.namespace,
					outputDir: pack,
					resourcePackVersion: "46",
					layer: ["horse_body"],
					template: false,
					mkdir: true,
				});
				const result = assertOk(definitionOnly);
				assert.deepEqual(result.textures, []);
				assert.deepEqual(result.files, ["assets/demo/equipment/horse.json"]);
				const definition = await readJson(
					join(pack, "assets", "demo", "equipment", "horse.json"),
				);
				assert.deepEqual(definition, {
					layers: { horse_body: [{ texture: "demo:horse" }] },
				});
			});
		},
	},
	{
		name: "dyeable colors become a signed ARGB color_when_undyed and bad hex refuses",
		async run() {
			// 0xFF alpha plus the 24-bit RGB, kept in the int32 the document stores.
			assert.equal(undyedColorFromHex("#A5CF6E"), (0xff << 24) | 0xa5cf6e);
			assert.equal(undyedColorFromHex("#000000"), -16777216);
			assert.ok(undyedColorFromHex("#A5CF6E") < 0);

			await withTempRoot("equipment-dyeable-", async (root) => {
				const pack = join(root, "pack");
				const run = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: pack,
					resourcePackVersion: "46",
					layer: ["humanoid"],
					dyeable: ["humanoid=#A5CF6E"],
					mkdir: true,
				});
				const result = assertOk(run);
				assert.deepEqual(result.layers.humanoid, [
					{
						texture: "demo:gear",
						dyeable: { color_when_undyed: (0xff << 24) | 0xa5cf6e },
					},
				]);
				const text = await readFile(
					join(pack, "assets", "demo", "equipment", "gear.json"),
					"utf8",
				);
				assert.ok(text.includes(`"color_when_undyed": ${-5910674}`), text);

				const badPack = join(root, "bad-pack");
				const bad = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: badPack,
					resourcePackVersion: "46",
					layer: ["humanoid"],
					dyeable: ["humanoid=#A5CF"],
					mkdir: true,
				});
				assertRefused(bad, "INVALID_ARGUMENT", 2);
				assert.deepEqual(await listAll(badPack), []);
			});
		},
	},
	{
		name: "an occupied target refuses the whole batch without force and leaves it untouched",
		async run() {
			await withTempRoot("equipment-exists-", async (root) => {
				const pack = join(root, "pack");
				const definition = join(
					pack,
					"assets",
					"demo",
					"equipment",
					"gear.json",
				);
				await mkdir(join(pack, "assets", "demo", "equipment"), {
					recursive: true,
				});
				await writeFile(definition, "sentinel");

				const refused = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: pack,
					resourcePackVersion: "46",
					layer: ["humanoid"],
					mkdir: true,
				});
				assertRefused(refused, "OUTPUT_EXISTS", 4);
				assert.equal(await readFile(definition, "utf8"), "sentinel");
				assert.deepEqual(await listAll(pack), [
					"assets/demo/equipment/gear.json",
				]);

				// An occupied template refuses just the same: nothing else is
				// written even though the definition target is free.
				const pack2 = join(root, "pack2");
				const texture = join(pack2, ...GENERATED.humanoid.split("/"));
				await mkdir(dirname(texture), { recursive: true });
				await writeFile(texture, "png-sentinel");
				const refusedPng = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: pack2,
					resourcePackVersion: "46",
					layer: ["humanoid"],
					mkdir: true,
				});
				assertRefused(refusedPng, "OUTPUT_EXISTS", 4);
				assert.equal(await readFile(texture, "utf8"), "png-sentinel");
				assert.deepEqual(await listAll(pack2), [GENERATED.humanoid]);

				const forced = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: pack2,
					resourcePackVersion: "46",
					layer: ["humanoid"],
					force: true,
					mkdir: true,
				});
				assertOk(forced);
				const decoded = decodePng(new Uint8Array(await readFile(texture)));
				assert.equal(decoded.canvas.width, 64);
			});
		},
	},
	{
		name: "a symlinked assets directory cannot redirect writes outside the pack root",
		async run() {
			await withTempRoot("equipment-symlink-", async (root) => {
				const pack = join(root, "pack");
				const outside = join(root, "outside");
				await mkdir(pack, { recursive: true });
				await mkdir(outside, { recursive: true });
				await symlink(outside, join(pack, "assets"));

				const run = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: pack,
					resourcePackVersion: "46",
					layer: ["humanoid"],
					force: true,
					mkdir: true,
				});
				assertRefused(run, "INVALID_ARGUMENT", 2);
				assert.equal(
					(run.body.error?.details as { reason?: string } | undefined)?.reason,
					"outside-allowed-root",
				);
				assert.deepEqual(await listAll(outside), []);
				assert.deepEqual(await listAll(pack), ["assets"]);
			});
		},
	},
	{
		name: "the embedded .mcpx source builds back to the template PNG byte for byte",
		async run() {
			await withTempRoot("equipment-mcpx-", async (root) => {
				const result = await handleEquipmentAsset({
					namespace: GENERATED.namespace,
					id: GENERATED.id,
					layers: [{ type: "humanoid" }, { type: "wings" }],
					resourcePackVersion: "46",
				});
				assert.equal(result.isError, undefined);
				const body = mcpBody(result) as unknown as EquipmentResultBody;
				assert.equal(typeof body.definitionText, "string");
				assert.deepEqual(Object.keys(body.layers), ["humanoid", "wings"]);
				assert.deepEqual(
					result.content.slice(1).map((block) => block.type),
					["image", "image"],
				);
				for (const [index, texture] of body.textures.entries()) {
					assert.equal(typeof texture.pngBase64, "string");
					assert.equal(typeof texture.sourceText, "string");
					const sourcePath = join(root, `template-${index}.mcpx`);
					await writeFile(sourcePath, texture.sourceText as string);
					const pngPath = join(root, `template-${index}.png`);
					const capture = captureStreams();
					const code = await runBuild(
						sourcePath,
						{ output: pngPath },
						false,
						capture.streams,
					);
					assert.equal(
						code,
						0,
						`build ${texture.layerType}: ${capture.stderrText()}`,
					);
					assert.deepEqual(
						new Uint8Array(await readFile(pngPath)),
						new Uint8Array(Buffer.from(texture.pngBase64 as string, "base64")),
						texture.layerType,
					);
				}
			});
		},
	},
	{
		name: "the CLI and the MCP tool write byte-identical packs",
		async run() {
			await withTempRoot("equipment-parity-", async (root) => {
				const cliPack = join(root, "cli");
				const cli = await runEquipmentCli("gear", {
					namespace: GENERATED.namespace,
					outputDir: cliPack,
					resourcePackVersion: "46",
					layer: ["humanoid", "wings"],
					mkdir: true,
				});
				const cliResult = assertOk(cli);

				const toolPack = join(root, "tool");
				const tool = await handleEquipmentAsset({
					namespace: GENERATED.namespace,
					id: GENERATED.id,
					layers: [{ type: "humanoid" }, { type: "wings" }],
					resourcePackVersion: "46",
					outputDir: toolPack,
					mkdir: true,
				});
				assert.equal(tool.isError, undefined);
				const toolBody = mcpBody(tool) as unknown as EquipmentResultBody;
				assert.equal(toolBody.outputDir, toolPack);
				assert.deepEqual(toolBody.files, cliResult.files);
				assert.deepEqual(toolBody.layers, cliResult.layers);
				assert.equal(
					toolBody.definitionDirectory,
					cliResult.definitionDirectory,
				);
				assert.deepEqual(
					toolBody.textures.map((texture) => ({
						layerType: texture.layerType,
						path: texture.path,
						regions: texture.regions,
					})),
					cliResult.textures.map((texture) => ({
						layerType: texture.layerType,
						path: texture.path,
						regions: texture.regions,
					})),
				);
				for (const texture of toolBody.textures) {
					assert.equal(texture.pngBase64, undefined);
				}
				assert.equal(toolBody.definitionText, undefined);

				for (const relative of cliResult.files) {
					assert.deepEqual(
						new Uint8Array(
							await readFile(join(cliPack, ...relative.split("/"))),
						),
						new Uint8Array(
							await readFile(join(toolPack, ...relative.split("/"))),
						),
						relative,
					);
				}
			});
		},
	},
	{
		name: "every existing CLI command keeps its place and equipment is appended",
		run() {
			const names = buildProgram().commands.map((command) => command.name());
			assert.deepEqual(names, [
				"stub",
				"analyze",
				"validate",
				"validate-pack",
				"import",
				"render",
				"transform",
				"gui-scale",
				"quantize",
				"cleanup",
				"palette",
				"material",
				"style",
				"pack",
				"recolor",
				"build",
				"pixelize",
				"variant",
				"tile",
				"generate",
				"preview",
				"animate",
				"inspect",
				"mcp",
				"optimize",
				"compare",
				"mcmeta",
				"particle",
				"model",
				"font",
				"entity",
				"equipment",
			]);
		},
	},
];
