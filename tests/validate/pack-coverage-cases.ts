import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPack } from "../../src/validate/pack.ts";
import { classifyResourceKind } from "../../src/validate/resource-kinds.ts";
import { makePngBytes, modelJson, writePackFile } from "./pack-fixtures.ts";
import type { PackCaseCheck } from "./pack-model-cases.ts";

export interface PackCoverageCase {
	name: string;
	run(check: PackCaseCheck): Promise<void>;
}

async function withPackDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-coverage-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** One model referencing one texture, both inside the test namespace. */
async function writeCleanNamespace(dir: string): Promise<void> {
	await writePackFile(
		dir,
		"assets/testpack/models/item/gem.json",
		modelJson({ textures: { layer0: "testpack:item/gem" } }),
	);
	await writePackFile(
		dir,
		"assets/testpack/textures/item/gem.png",
		makePngBytes(),
	);
}

const SCAN_OPTIONS = { packFormat: "75.0" };

function skipReasons(report: {
	coverage: { skipped: { reason: string }[] };
}): string[] {
	return report.coverage.skipped.map((skip) => skip.reason);
}

export const PACK_COVERAGE_CASES: PackCoverageCase[] = [
	{
		name: "coverage: an unread type yields a skip and a warning that names the type",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(dir, "assets/testpack/shaders/a.json", "{}");
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.skipped.length, 1);
				const warnings = report.findings.filter(
					(finding) => finding.code === "PACK_COVERAGE_SKIPPED",
				);
				check.equal(warnings.length, 1);
				check.equal(warnings[0]?.level, "warning");
				check.ok(warnings[0]?.message.includes("shaders"));
				check.ok(warnings[0]?.message.includes("not interpreted"));
			});
		},
	},
	{
		name: "coverage: an uninterpreted resource type makes coverage partial and names the type",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(dir, "assets/testpack/waypoint_style/x.json", "{}");
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.status, "partial");
				check.ok(
					skipReasons(report).some((reason) =>
						reason.includes("waypoint_style"),
					),
					"a skip reason must name waypoint_style",
				);
			});
		},
	},
	{
		name: "coverage: lang alone does not lower coverage",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanNamespace(dir);
				await writePackFile(
					dir,
					"assets/testpack/lang/en_us.json",
					'{"item.testpack.gem":"Gem"}',
				);
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.status, "complete");
				check.deepEqual(report.coverage.skipped, []);
			});
		},
	},
	{
		name: "coverage: only the uninterpreted type is named when lang sits beside it",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanNamespace(dir);
				await writePackFile(dir, "assets/testpack/lang/en_us.json", "{}");
				await writePackFile(dir, "assets/testpack/waypoint_style/x.json", "{}");
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.status, "partial");
				const reasons = skipReasons(report);
				check.equal(reasons.length, 1);
				check.ok(reasons[0]?.includes("waypoint_style"));
				check.ok(
					!JSON.stringify(report.coverage.skipped).includes("lang"),
					"the inert type must not appear in any skip",
				);
			});
		},
	},
	{
		name: "coverage: font, particles and equipment are read, so they are not uninterpreted",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/equipment/wings.json",
					'{"layers":{}}',
				);
				await writePackFile(
					dir,
					"assets/testpack/particles/spark.json",
					'{"textures":["testpack:spark"]}',
				);
				await writePackFile(
					dir,
					"assets/testpack/textures/particle/spark.png",
					makePngBytes(),
				);
				await writePackFile(
					dir,
					"assets/testpack/font/custom.json",
					'{"providers":[]}',
				);
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.status, "complete");
				check.deepEqual(report.coverage.skipped, []);
			});
		},
	},
	{
		name: "coverage: a file directly under the namespace is reported by its own name",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(dir, "assets/testpack/sounds.json", "{}");
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.status, "partial");
				check.ok(
					skipReasons(report).some((reason) => reason.includes("sounds.json")),
				);
			});
		},
	},
	{
		name: "coverage: one skip per unread type however many files it holds",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(dir, "assets/testpack/shaders/a.json", "{}");
				await writePackFile(dir, "assets/testpack/shaders/post/b.json", "{}");
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.skipped.length, 1);
			});
		},
	},
	{
		name: "coverage: classification defaults to uninterpreted",
		run: async (check) => {
			for (const kind of [
				"textures",
				"models",
				"blockstates",
				"items",
				"atlases",
				"font",
				"particles",
				"equipment",
			]) {
				check.equal(classifyResourceKind(kind), "checked", kind);
			}
			check.equal(classifyResourceKind("lang"), "inert");
			for (const kind of ["sounds.json", "anything_new"]) {
				check.equal(classifyResourceKind(kind), "uninterpreted", kind);
			}
		},
	},
	{
		name: "coverage: a partial coverage status does not change a passing verdict",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writeCleanNamespace(dir);
				await writePackFile(dir, "assets/testpack/waypoint_style/x.json", "{}");
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.status, "partial");
				check.equal(report.verdict, "pass");
			});
		},
	},
	{
		name: "coverage: an unknown item model node type still records its own skip",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/items/odd.json",
					JSON.stringify({ model: { type: "testpack:mystery" } }),
				);
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.status, "partial");
				check.ok(
					report.coverage.skipped.every(
						(skip) => skip.kind !== "uninterpreted-resource",
					),
					"a checked type must not add an unread-type skip",
				);
			});
		},
	},
	{
		name: "coverage: a missing vanilla tree still records an external reference skip",
		run: async (check) => {
			await withPackDir(async (dir) => {
				await writePackFile(
					dir,
					"assets/testpack/models/item/gem.json",
					modelJson({ textures: { layer0: "minecraft:item/sword" } }),
				);
				const report = await scanPack(dir, SCAN_OPTIONS);
				check.equal(report.coverage.status, "partial");
				check.deepEqual(
					report.coverage.skipped.map((skip) => skip.reason),
					["vanilla-not-provided"],
				);
			});
		},
	},
];
