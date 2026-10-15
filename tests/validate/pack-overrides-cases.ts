import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPack } from "../../src/validate/pack.ts";
import { modelJson, writePackFile } from "./pack-fixtures.ts";
import type { PackModelCase } from "./pack-model-cases.ts";

export const PACK_OVERRIDE_CASES: PackModelCase[] = [
	...["15.0", "46.0", "75.0", undefined, "999.0"].map(
		(packFormat): PackModelCase => ({
			name: `overrides: missing target with format ${packFormat ?? "unknown"}`,
			run: async (check) => {
				const dir = await mkdtemp(join(tmpdir(), "mc-asset-overrides-"));
				try {
					await writePackFile(
						dir,
						"assets/testpack/models/item/demo.json",
						modelJson({
							overrides: [
								{ predicate: { damage: 0.5 }, model: "testpack:item/missing" },
							],
						}),
					);
					const report = await scanPack(
						dir,
						packFormat === undefined ? {} : { packFormat },
					);
					const errors = report.findings.filter((f) => f.level === "error");
					if (packFormat === "15.0") {
						check.equal(report.verdict, "fail");
						check.equal(errors.length, 1);
						check.equal(errors[0]?.code, "PACK_BROKEN_REFERENCE");
						check.ok(errors[0]?.message.includes("overrides[0].model"));
					} else {
						check.equal(report.verdict, "pass");
						check.equal(errors.length, 0);
						if (packFormat === "46.0" || packFormat === "75.0") {
							check.equal(report.coverage.status, "complete");
							check.equal(report.coverage.skipped.length, 0);
							check.equal(report.findings.length, 1);
							check.equal(report.findings[0]?.code, "MODEL_VERSION_FEATURE");
							check.equal(report.findings[0]?.level, "warning");
						} else {
							check.equal(report.coverage.status, "partial");
							check.ok(
								report.coverage.skipped.some(
									(s) => s.reason === "feature-version-unknown",
								),
							);
						}
					}
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			},
		}),
	),
	...["testpack:item/target", "minecraft:item/target"].map(
		(target): PackModelCase => ({
			name: `overrides: legacy target ${target}`,
			run: async (check) => {
				const dir = await mkdtemp(join(tmpdir(), "mc-asset-overrides-"));
				try {
					await writePackFile(
						dir,
						"assets/testpack/models/item/demo.json",
						modelJson({ overrides: [{ model: target }] }),
					);
					if (target.startsWith("testpack:"))
						await writePackFile(
							dir,
							"assets/testpack/models/item/target.json",
							modelJson({}),
						);
					const report = await scanPack(dir, { packFormat: "15.0" });
					check.equal(report.verdict, "pass");
					check.equal(
						report.findings.filter((f) => f.level === "error").length,
						0,
					);
					check.equal(
						report.findings.filter((f) => f.code === "PACK_UNRESOLVED_EXTERNAL")
							.length,
						target.startsWith("minecraft:") ? 1 : 0,
					);
					check.equal(
						report.findings.filter(
							(f) =>
								f.code === "PACK_BROKEN_REFERENCE" ||
								f.code === "PACK_MISSING_ASSET",
						).length,
						0,
					);
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			},
		}),
	),
	...[{}, [null], [7], [{ model: 7 }], [{}]].map(
		(overrides, index): PackModelCase => ({
			name: `overrides: unexpected shape ${index}`,
			run: async (check) => {
				const dir = await mkdtemp(join(tmpdir(), "mc-asset-overrides-"));
				try {
					await writePackFile(
						dir,
						"assets/testpack/models/item/demo.json",
						modelJson({ overrides }),
					);
					const report = await scanPack(dir, { packFormat: "15.0" });
					check.equal(report.verdict, "pass");
					check.equal(
						report.findings.filter((f) => f.level === "error").length,
						0,
					);
					check.ok(
						report.coverage.skipped.some(
							(s) => s.reason === "unexpected-shape",
						),
					);
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			},
		}),
	),
];
