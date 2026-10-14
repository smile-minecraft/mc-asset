import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonDocument } from "../../src/model/json-document.ts";
import { validateModelStructure } from "../../src/model/structure.ts";
import { resolveModelRules } from "../../src/model/versions.ts";
import { scanPack } from "../../src/validate/pack.ts";
import {
	makePngBytes,
	modelJson,
	writeCleanBaseline,
	writePackFile,
} from "./pack-fixtures.ts";

export interface PackCaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface PackModelCase {
	name: string;
	run(check: PackCaseCheck): Promise<void>;
}

async function withPackDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-model-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export const PACK_MODEL_CASES: PackModelCase[] = [
	// ─── Pack Model Integration Cases ───────────────────────────────────────
	{
		name: "pack integration: invalid geometry caught by validate-pack (red light case)",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/bad_geom.json",
					modelJson({
						elements: [
							{
								from: [-20, 0, 0],
								to: [40, 16, 16],
								faces: {
									up: { texture: "#top" },
								},
							},
						],
					}),
				);
				const report = await scanPack(dir, { packFormat: "75.0" });
				check.equal(
					report.verdict,
					"fail",
					"invalid geometry must fail pack validation",
				);
				check.ok(
					report.findings.some((f) => f.code === "MODEL_INVALID_STRUCTURE"),
					"finding code must be MODEL_INVALID_STRUCTURE",
				);
			});
		},
	},
	{
		name: "pack integration: invalid UV coordinates caught by validate-pack",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/bad_uv.json",
					modelJson({
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								faces: {
									north: {
										texture: "#side",
										uv: [-1, 0, 18, 16],
									},
								},
							},
						],
					}),
				);
				const report = await scanPack(dir, { packFormat: "75.0" });
				check.equal(report.verdict, "pass", "out-of-range UV is a warning");
				check.ok(
					report.findings.some(
						(f) => f.code === "MODEL_SUSPICIOUS_VALUE" && f.level === "warning",
					),
					"out-of-range UV retains MODEL_SUSPICIOUS_VALUE warning",
				);
			});
		},
	},
	{
		name: "pack integration: invalid rotation angle caught by validate-pack",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/bad_rotation.json",
					modelJson({
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								rotation: {
									origin: [8, 8, 8],
									axis: "y",
									angle: 23,
								},
								faces: {
									up: { texture: "#top" },
								},
							},
						],
					}),
				);
				const report = await scanPack(dir, { packFormat: "46.0" });
				check.equal(
					report.verdict,
					"fail",
					"invalid rotation angle must fail pack validation",
				);
				check.ok(
					report.findings.some((f) => f.code === "MODEL_INVALID_ROTATION"),
					"finding code must be MODEL_INVALID_ROTATION",
				);
			});
		},
	},
	{
		name: "pack integration: invalid display transform scale caught by validate-pack",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/bad_display.json",
					modelJson({
						display: {
							gui: {
								scale: [5, 5, 5],
							},
						},
					}),
				);
				const report = await scanPack(dir, { packFormat: "75.0" });
				check.equal(report.verdict, "pass", "large display scale is a warning");
				check.ok(
					report.findings.some(
						(f) => f.code === "MODEL_SUSPICIOUS_VALUE" && f.level === "warning",
					),
					"large scale retains MODEL_SUSPICIOUS_VALUE warning",
				);
			});
		},
	},
	{
		name: "pack integration: version boundary below 63.0 rejects non-22.5 angle",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/angle_30.json",
					modelJson({
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								rotation: {
									origin: [8, 8, 8],
									axis: "y",
									angle: 30,
								},
								faces: {
									up: { texture: "#top" },
								},
							},
						],
					}),
				);
				const report = await scanPack(dir, { packFormat: "46.0" });
				check.equal(report.verdict, "fail", "angle 30 rejected below 63.0");
				check.ok(
					report.findings.some((f) => f.code === "MODEL_INVALID_ROTATION"),
					"reports MODEL_INVALID_ROTATION",
				);
			});
		},
	},
	{
		name: "pack integration: version boundary 74.x rejects angle exceeding 45 degrees",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/angle_50.json",
					modelJson({
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								rotation: {
									origin: [8, 8, 8],
									axis: "y",
									angle: 50,
								},
								faces: {
									up: { texture: "#top" },
								},
							},
						],
					}),
				);
				const report = await scanPack(dir, { packFormat: "74.0" });
				check.equal(report.verdict, "fail", "angle 50 rejected at 74.x");
				check.ok(
					report.findings.some((f) => f.code === "MODEL_INVALID_ROTATION"),
					"reports MODEL_INVALID_ROTATION",
				);
			});
		},
	},
	{
		name: "pack integration: version 26.1 textures object form accepted without error",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/sword.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/sword.json",
					modelJson({
						textures: {
							layer0: {
								sprite: "minecraft:item/sword",
								force_translucent: false,
							},
						},
					}),
				);
				const report = await scanPack(dir, { packFormat: "84.0" });
				check.equal(
					report.verdict,
					"pass",
					"object form textures accepted at 84.0",
				);
			});
		},
	},
	{
		name: "pack integration: version 26.3 shade forbidden from pack format 97.1",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/shaded.json",
					modelJson({
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								shade: false,
								faces: {
									up: { texture: "#top" },
								},
							},
						],
					}),
				);
				const report = await scanPack(dir, { packFormat: "97.1" });
				check.equal(
					report.verdict,
					"pass",
					"boolean shade at 97.1 is a warning",
				);
				check.ok(
					report.findings.some(
						(f) => f.code === "MODEL_VERSION_FEATURE" && f.level === "warning",
					),
					"reports MODEL_VERSION_FEATURE",
				);
			});
		},
	},

	// ─── False Positive Correction Cases ────────────────────────────────────
	{
		name: "false positive fix: pack format >= 84.0 does not report PACK_BROKEN_REFERENCE for object texture",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/custom.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/custom.json",
					modelJson({
						textures: {
							layer0: {
								sprite: "minecraft:item/custom",
								force_translucent: true,
							},
						},
					}),
				);
				const report = await scanPack(dir, { packFormat: "84.0" });
				const broken = report.findings.filter(
					(f) => f.code === "PACK_BROKEN_REFERENCE",
				);
				check.equal(
					broken.length,
					0,
					"object texture form at 84.0 must not be flagged as broken reference",
				);
			});
		},
	},
	{
		name: "false positive fix: pack format < 84.0 reports error for object texture",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/textures/item/custom.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/custom.json",
					modelJson({
						textures: {
							layer0: {
								sprite: "minecraft:item/custom",
								force_translucent: true,
							},
						},
					}),
				);
				const report = await scanPack(dir, { packFormat: "75.0" });
				check.ok(
					report.findings.some(
						(f) =>
							f.code === "PACK_BROKEN_REFERENCE" ||
							f.code === "MODEL_VERSION_FEATURE",
					),
					"object texture below 84.0 is reported as error",
				);
			});
		},
	},

	// ─── Partial Coverage Cases ─────────────────────────────────────────────
	{
		name: "partial coverage: unknown model field produces partial coverage",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/minecraft/models/item/extra.json",
					modelJson({
						textures: { layer0: "minecraft:item/sword" },
						custom_unknown_field: true,
					}),
				);
				const report = await scanPack(dir, { packFormat: "75.0" });
				check.equal(
					report.coverage.status,
					"partial",
					"unknown model field marks coverage partial",
				);
			});
		},
	},
	{
		name: "partial coverage: unknown item definition type produces partial coverage",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				await writePackFile(
					dir,
					"assets/minecraft/items/special.json",
					modelJson({
						model: {
							type: "minecraft:future_special_type",
						},
					}),
				);
				const report = await scanPack(dir, { packFormat: "75.0" });
				check.equal(
					report.coverage.status,
					"partial",
					"unknown item definition type marks coverage partial",
				);
			});
		},
	},
	{
		name: "partial coverage: missing vanilla context for minecraft namespace assets marks coverage partial",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/minecraft/models/item/custom_cube.json",
					modelJson({
						parent: "minecraft:block/cube_all",
						textures: {},
					}),
				);
				const report = await scanPack(dir, { packFormat: "75.0" });
				check.equal(
					report.coverage.status,
					"partial",
					"missing vanilla context marks coverage partial instead of complete",
				);
			});
		},
	},
	{
		name: "missing dependency context: foreign parent remains a missing asset",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/dep_item.json",
					modelJson({
						parent: "depmod:item/base",
						textures: {},
					}),
				);
				const report = await scanPack(dir, { packFormat: "75.0" });
				check.equal(report.verdict, "fail", "missing foreign parent fails");
				check.ok(
					report.findings.some(
						(finding) =>
							finding.code === "PACK_MISSING_ASSET" &&
							finding.level === "error",
					),
					"missing foreign parent reports PACK_MISSING_ASSET error",
				);
			});
		},
	},

	// ─── Existing Behavior & Priority Order Cases ───────────────────────────
	{
		name: "existing behavior: clean baseline pack passes without findings",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (dir) => {
				await writeCleanBaseline(dir);
				const report = await scanPack(dir, { packFormat: "75.0" });
				check.equal(report.verdict, "pass", "clean baseline passes");
				check.equal(report.findings.length, 0, "no findings on baseline");
			});
		},
	},
	{
		name: "priority order: current pack assets take precedence over dependency and vanilla",
		run: async (check: PackCaseCheck) => {
			await withPackDir(async (depDir) => {
				await writePackFile(
					depDir,
					"assets/minecraft/textures/item/sword.png",
					makePngBytes(),
				);
				await withPackDir(async (packDir) => {
					await writePackFile(
						packDir,
						"assets/minecraft/textures/item/sword.png",
						makePngBytes(),
					);
					await writePackFile(
						packDir,
						"assets/minecraft/models/item/sword.json",
						modelJson({ textures: { layer0: "minecraft:item/sword" } }),
					);
					const report = await scanPack(packDir, {
						packFormat: "75.0",
						dependencyPaths: [depDir],
					});
					check.equal(
						report.verdict,
						"pass",
						"current pack resolves texture before dependency",
					);
				});
			});
		},
	},
];

for (const [name, model, code, level] of [
	[
		"UV outside bounds",
		{
			elements: [
				{
					from: [0, 0, 0],
					to: [16, 16, 16],
					faces: { up: { texture: "#top", uv: [-1, 0, 18, 16] } },
				},
			],
		},
		"MODEL_SUSPICIOUS_VALUE",
		"warning",
	],
	[
		"zero-area UV",
		{
			elements: [
				{
					from: [0, 0, 0],
					to: [16, 16, 16],
					faces: { up: { texture: "#top", uv: [0, 0, 0, 16] } },
				},
			],
		},
		"MODEL_SUSPICIOUS_VALUE",
		"warning",
	],
	[
		"large display scale",
		{ display: { gui: { scale: [5, 5, 5] } } },
		"MODEL_SUSPICIOUS_VALUE",
		"warning",
	],
	[
		"boolean shade",
		{
			elements: [
				{
					from: [0, 0, 0],
					to: [16, 16, 16],
					shade: false,
					faces: { up: { texture: "#top" } },
				},
			],
		},
		"MODEL_VERSION_FEATURE",
		"warning",
	],
	[
		"short UV",
		{
			elements: [
				{
					from: [0, 0, 0],
					to: [16, 16, 16],
					faces: { up: { texture: "#top", uv: [0, 0, 16] } },
				},
			],
		},
		"MODEL_INVALID_UV",
		"error",
	],
	[
		"invalid display vector",
		{ display: { gui: { scale: "large" } } },
		"MODEL_INVALID_DISPLAY",
		"error",
	],
] as const) {
	PACK_MODEL_CASES.push({
		name: `pack preserves structure severity: ${name}`,
		run: async (check) => {
			await withPackDir(async (dir) => {
				const text = modelJson(model);
				const rel = "assets/probe/models/item/example.json";
				await writePackFile(dir, rel, text);
				const direct = validateModelStructure(
					parseJsonDocument(text),
					resolveModelRules("97.1"),
					rel,
				);
				check.ok(
					direct.findings.some((f) => f.code === code && f.level === level),
					"direct structure severity",
				);
				const report = await scanPack(dir, { packFormat: "97.1" });
				check.equal(
					report.verdict,
					level === "error" ? "fail" : "pass",
					"pack severity matches structure",
				);
				check.ok(
					report.findings.some((f) => f.code === code && f.level === level),
					"pack preserves finding",
				);
			});
		},
	});
}
PACK_MODEL_CASES.push({
	name: "strict blockstate parse failure marks coverage",
	run: async (check) => {
		await withPackDir(async (dir) => {
			await writePackFile(
				dir,
				"assets/probe/blockstates/example.json",
				'{"variants":{"":{"model":"probe:block/example","x":45}},"variants":{}}',
			);
			const report = await scanPack(dir, { packFormat: "75.0" });
			check.ok(
				report.coverage.skipped.some(
					(s) =>
						s.reason === "strict-parse-failed" &&
						s.target.includes("blockstates/"),
				),
				"strict blockstate failure recorded",
			);
		});
	},
});
