import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFsModelContext,
	createStandaloneContext,
	type ModelResolutionContext,
	type ModelResolutionLayer,
} from "../../src/model/context.ts";
import {
	inspectModel,
	type ModelInspectReport,
	validateModel,
} from "../../src/model/inspect.ts";
import type { ResolutionSource } from "../../src/validate/resource-context.ts";
import {
	assertAsyncError,
	type CaseCheck,
	type ModelCase,
} from "./json-document-cases.ts";
import { assertByteSorted } from "./structure-cases.ts";

const path = "assets/demo/models/item/child.json";
const stone = "assets/demo/textures/stone.png";
const cube = {
	from: [0, 0, 0],
	to: [16, 16, 16],
	faces: { north: { texture: "#all" } },
};
const parentRel = "assets/demo/models/block/base.json";
const base = {
	textures: { all: "demo:stone", inherited: "demo:stone" },
	elements: [cube],
	ambientocclusion: false,
	gui_light: "front",
	display: {
		gui: { rotation: [10, 20, 30], scale: [2, 2, 2] },
		ground: { translation: [0, 1, 0] },
	},
};
const encoder = new TextEncoder();

function memoryLayer(
	source: ResolutionSource,
	files: Record<string, unknown>,
	reads: string[] = [],
): ModelResolutionLayer {
	return {
		source,
		has: (rel) => Object.hasOwn(files, rel),
		async read(rel) {
			reads.push(rel);
			const value = files[rel];
			if (value === undefined) return undefined;
			return encoder.encode(
				typeof value === "string" ? value : JSON.stringify(value),
			);
		},
	};
}

function context(files: Record<string, unknown> = {}): ModelResolutionContext {
	return {
		layers: [memoryLayer("current", { [stone]: "texture bytes", ...files })],
		hasVanilla: false,
	};
}

function inspect(
	input: unknown,
	resolution = context(),
): Promise<ModelInspectReport> {
	return inspectModel(JSON.stringify(input), {
		path,
		modelId: "demo:item/child",
		packFormat: "84.0",
		context: resolution,
	});
}

function hasFinding(
	check: CaseCheck,
	report: ModelInspectReport,
	code: string,
	level: string,
): void {
	check.ok(
		report.findings.some(
			(finding) => finding.code === code && finding.level === level,
		),
		`expected ${level} ${code}`,
	);
}

function hasSkip(
	check: CaseCheck,
	report: ModelInspectReport,
	kind: string,
	reason: string,
): void {
	check.ok(
		report.coverage.skipped.some(
			(skip) => skip.kind === kind && skip.reason === reason,
		),
		`expected ${kind}/${reason}`,
	);
	check.equal(report.coverage.status, "partial");
}

export const INSPECT_CASES: ModelCase[] = [
	{
		name: "report stability: Bun and Node match literal report projection bytes",
		async run(check) {
			const text = await readFile(
				new URL("./fixtures/stable-model.json", import.meta.url),
				"utf8",
			);
			const expected = await readFile(
				new URL("./fixtures/stable-report-projection.json", import.meta.url),
				"utf8",
			);
			const report = await inspectModel(text, {
				path,
				modelId: "demo:item/child",
				packFormat: "84.0",
				context: context(),
			});
			const projection = {
				path: report.path,
				modelId: report.modelId,
				kind: report.kind,
				version: report.version,
				verdict: report.verdict,
				findings: report.findings,
				coverage: report.coverage,
				properties: report.properties,
				elementsSource: report.elementsSource,
				sizes: report.elements.map((element) => element.size),
				resolvedTextures: report.elements.flatMap((element) =>
					element.faces.map((face) => face.textureResolution.resolvedTo),
				),
				summary: report.summary,
			};
			check.equal(
				JSON.stringify(projection),
				JSON.stringify(JSON.parse(expected)),
			);
		},
	},
	{
		name: "report: basic inspect shape, counts, geometry and finite fractional size",
		async run(check) {
			const report = await inspect({
				textures: { all: "demo:stone" },
				elements: [
					{
						...cube,
						name: "fraction",
						from: [0.25, 0, 0],
						to: [15.75, 16, 16],
					},
				],
			});
			check.equal(report.path, path);
			check.equal(report.command, "model");
			check.equal(report.mode, "inspect");
			check.equal(report.modelId, "demo:item/child");
			check.equal(report.kind, "item");
			check.equal(report.verdict, "pass");
			check.equal(report.coverage.status, "complete");
			check.deepEqual(report.version, {
				packFormat: "84.0",
				rules: "verified",
				rulesReason: "verified-release",
			});
			check.deepEqual(report.summary, {
				elementCount: 1,
				faceCount: 1,
				textureCount: 1,
			});
			check.deepEqual(report.elementsSource, { from: "own" });
			check.deepEqual(report.elements[0]?.size, [15.5, 16, 16]);
			check.equal(report.elements[0]?.name, "fraction");
			check.equal(report.elements[0]?.faces[0]?.rotation, 0);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.resolvedTo,
				"demo:stone",
			);
		},
	},
	{
		name: "inheritance: closest parent supplies elements, variables and properties",
		async run(check) {
			const report = await inspect(
				{ parent: "demo:block/base" },
				context({ [parentRel]: base }),
			);
			check.deepEqual(report.elementsSource, {
				from: "inherited",
				parent: "demo:block/base",
			});
			check.deepEqual(report.summary, {
				elementCount: 1,
				faceCount: 1,
				textureCount: 0,
			});
			check.deepEqual(report.properties, {
				ambientocclusion: false,
				guiLight: "front",
			});
			check.deepEqual(report.inheritedTextures, [
				{ name: "all", value: "demo:stone", from: "demo:block/base" },
				{ name: "inherited", value: "demo:stone", from: "demo:block/base" },
			]);
			check.deepEqual(report.elements[0]?.from, [0, 0, 0]);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"resolved",
			);
		},
	},
	{
		name: "inheritance: own empty elements suppress parent elements",
		async run(check) {
			const report = await inspect(
				{ parent: "demo:block/base", elements: [] },
				context({ [parentRel]: base }),
			);
			check.deepEqual(report.elementsSource, { from: "own" });
			check.deepEqual(report.elements, []);
			check.equal(report.summary.faceCount, 0);
		},
	},
	{
		name: "inheritance: child texture overrides apply to inherited faces",
		async run(check) {
			const report = await inspect(
				{ parent: "demo:block/base", textures: { all: "demo:alternate" } },
				context({
					[parentRel]: base,
					"assets/demo/textures/alternate.png": "texture",
				}),
			);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.resolvedTo,
				"demo:alternate",
			);
			check.deepEqual(
				report.inheritedTextures.map((entry) => entry.name),
				["inherited"],
			);
		},
	},
	{
		name: "inheritance: display overrides whole position rather than individual components",
		async run(check) {
			const report = await inspect(
				{
					parent: "demo:block/base",
					display: { gui: { translation: [1, 2, 3] } },
					ambientocclusion: true,
				},
				context({ [parentRel]: base }),
			);
			check.deepEqual(report.display, [
				{ position: "ground", from: "demo:block/base", translation: [0, 1, 0] },
				{ position: "gui", from: "own", translation: [1, 2, 3] },
			]);
			check.deepEqual(report.properties, {
				ambientocclusion: true,
				guiLight: "front",
			});
		},
	},
	{
		name: "inheritance: nearest defining ancestor wins over distant ancestor",
		async run(check) {
			const report = await inspect(
				{ parent: "demo:block/middle" },
				context({
					"assets/demo/models/block/middle.json": {
						parent: "demo:block/base",
						gui_light: "side",
						textures: { all: "demo:alternate" },
					},
					[parentRel]: base,
					"assets/demo/textures/alternate.png": "texture",
				}),
			);
			check.deepEqual(report.elementsSource, {
				from: "inherited",
				parent: "demo:block/base",
			});
			check.equal(report.properties.guiLight, "side");
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.resolvedTo,
				"demo:alternate",
			);
		},
	},
	{
		name: "inheritance: structure validation applies only to own elements",
		async run(check) {
			const report = await inspect(
				{ parent: "demo:block/base", elements: [] },
				context({ [parentRel]: { elements: [{ from: [0, 0], to: [0, 0] }] } }),
			);
			check.equal(report.path, path);
			check.deepEqual(report.findings, []);
			check.equal(report.verdict, "pass");
		},
	},
];

const sources: readonly ResolutionSource[] = [
	"current",
	"dependency:0",
	"dependency:1",
	"vanilla",
];
for (let first = 0; first < sources.length; first += 1) {
	const expectedSource = sources[first];
	INSPECT_CASES.push({
		name: `resolution priority: ${expectedSource} precedes remaining layers`,
		async run(check) {
			const reads: string[] = [];
			const resolution: ModelResolutionContext = {
				hasVanilla: true,
				layers: sources.map((source, index) =>
					memoryLayer(
						source,
						index < first
							? {}
							: {
									[parentRel]: {
										textures: { all: "demo:stone" },
										elements: [{ ...cube, to: [index + 1, 16, 16] }],
									},
									[stone]: "texture",
								},
						reads,
					),
				),
			};
			const report = await inspect({ parent: "demo:block/base" }, resolution);
			check.equal(report.parent?.source, expectedSource);
			check.equal(report.parentChain[0]?.source, expectedSource);
			check.equal(report.elements[0]?.to[0], first + 1);
			check.equal(
				reads.filter((rel) => rel === parentRel).length,
				1,
				"only selected layer is loaded",
			);
		},
	});
}

INSPECT_CASES.push(
	{
		name: "parent chain: missing custom parent is an error",
		async run(check) {
			const report = await inspect({ parent: "demo:missing" });
			check.equal(report.parent?.status, "missing");
			hasFinding(check, report, "PACK_MISSING_ASSET", "error");
			check.equal(report.verdict, "fail");
		},
	},
	{
		name: "parent chain: minecraft without vanilla is unresolved rather than missing",
		async run(check) {
			const report = await inspect({ parent: "minecraft:block/stone" });
			check.equal(report.parent?.status, "unresolved");
			hasFinding(check, report, "PACK_UNRESOLVED_EXTERNAL", "warning");
			hasSkip(check, report, "external-reference", "vanilla-not-provided");
			check.ok(!report.findings.some((f) => f.code === "PACK_MISSING_ASSET"));
			check.equal(report.verdict, "pass");
		},
	},
	{
		name: "parent chain: standalone custom reference stays unresolved",
		async run(check) {
			const resolution = createStandaloneContext();
			check.deepEqual(resolution, { layers: [], hasVanilla: false });
			const report = await inspect({ parent: "demo:block/base" }, resolution);
			check.equal(report.parent?.status, "unresolved");
			hasFinding(check, report, "PACK_UNRESOLVED_EXTERNAL", "warning");
			hasSkip(check, report, "external-reference", "no-resolution-context");
		},
	},
	{
		name: "parent chain: omitted context uses standalone semantics",
		async run(check) {
			const report = await inspectModel('{"parent":"demo:block/base"}', {
				path,
				packFormat: "84.0",
			});
			check.equal(report.parent?.status, "unresolved");
			hasSkip(check, report, "external-reference", "no-resolution-context");
			check.equal(report.modelId, undefined);
		},
	},
	{
		name: "parent chain: self cycle reports the traversed model",
		async run(check) {
			const report = await inspect(
				{ parent: "demo:item/child" },
				context({ [path]: { parent: "demo:item/child" } }),
			);
			hasFinding(check, report, "PACK_REFERENCE_CYCLE", "error");
			check.ok(
				report.findings.some(
					(f) =>
						f.code === "PACK_REFERENCE_CYCLE" &&
						(f.message.includes("demo:item/child") || f.message.includes(path)),
				),
			);
		},
	},
	{
		name: "parent chain: two-node cycle terminates with an error",
		async run(check) {
			const reads: string[] = [];
			const report = await inspect(
				{ parent: "demo:block/base" },
				{
					hasVanilla: false,
					layers: [
						memoryLayer(
							"current",
							{
								[parentRel]: { parent: "demo:item/child" },
								[path]: { parent: "demo:block/base" },
							},
							reads,
						),
					],
				},
			);
			hasFinding(check, report, "PACK_REFERENCE_CYCLE", "error");
			check.ok(reads.length <= 2, "cycle must not continue loading files");
		},
	},
);

for (const id of [
	"minecraft:builtin/entity",
	"minecraft:builtin/generated",
	"minecraft:item/generated",
	"minecraft:item/handheld",
	"minecraft:item/handheld_rod",
]) {
	INSPECT_CASES.push({
		name: `parent chain: builtin ${id} terminates without file reads`,
		async run(check) {
			const reads: string[] = [];
			const report = await inspect(
				{ parent: id },
				{ hasVanilla: false, layers: [memoryLayer("current", {}, reads)] },
			);
			check.equal(report.parent?.status, "builtin");
			check.equal(report.parent?.source, "builtin");
			check.deepEqual(reads, []);
			check.deepEqual(report.findings, []);
		},
	});
}
INSPECT_CASES.push({
	name: "resolution priority: file layers override builtin registry",
	async run(check) {
		const report = await inspect(
			{ parent: "minecraft:item/generated" },
			context({
				"assets/minecraft/models/item/generated.json": {
					gui_light: "side",
					elements: [],
				},
			}),
		);
		check.equal(report.parent?.source, "current");
		check.equal(report.parent?.status, "resolved");
		check.equal(report.properties.guiLight, "side");
	},
});
for (const id of [
	"minecraft:builtin/unknown",
	"minecraft:item/generated_extra",
]) {
	INSPECT_CASES.push({
		name: `parent chain: builtin lookalike ${id} is unresolved`,
		async run(check) {
			const report = await inspect({ parent: id });
			check.equal(report.parent?.status, "unresolved");
			hasFinding(check, report, "PACK_UNRESOLVED_EXTERNAL", "warning");
		},
	});
}

// 自身文字加上最多 32 份父文件，共 33 份；跨模型的 64 份彙總上限不在單檔案例斷言。
for (const count of [32, 33]) {
	INSPECT_CASES.push({
		name: `parent chain: ${count === 32 ? "own document plus 32 parents allows 33 documents" : "33rd parent exceeds single-model depth limit"}`,
		async run(check) {
			const files: Record<string, unknown> = {};
			for (let i = 0; i < count; i += 1) {
				files[`assets/demo/models/chain/${i}.json`] =
					i === count - 1
						? { elements: [] }
						: { parent: `demo:chain/${i + 1}` };
			}
			const reads: string[] = [];
			const report = await inspect(
				{ parent: "demo:chain/0" },
				{ hasVanilla: false, layers: [memoryLayer("current", files, reads)] },
			);
			check.equal(report.parentChain.length, 32);
			check.equal(reads.length, 32);
			check.equal(reads.length + 1, 33, "own document plus loaded parents");
			if (count === 32) {
				check.equal(report.coverage.status, "complete");
				check.deepEqual(report.elementsSource, {
					from: "inherited",
					parent: "demo:chain/31",
				});
			} else {
				hasSkip(check, report, "model-parent", "depth-limit");
			}
		},
	});
}
for (const [label, content, reason] of [
	["invalid JSON", '{"a":}', "document-invalid-json"],
	["too large", `{}${" ".repeat(1_048_575)}`, "document-too-large"],
] as const) {
	INSPECT_CASES.push({
		name: `parent chain: ${label} creates coverage instead of throwing`,
		async run(check) {
			const report = await inspect(
				{ parent: "demo:block/base" },
				context({ [parentRel]: content }),
			);
			hasSkip(check, report, "model-parent", reason);
		},
	});
}
for (const mode of ["missing bytes", "read exception"]) {
	INSPECT_CASES.push({
		name: `parent chain: ${mode} is document-unreadable coverage`,
		async run(check) {
			const layer: ModelResolutionLayer = {
				source: "current",
				has: () => true,
				async read() {
					if (mode === "read exception") throw new Error("read failed");
					return undefined;
				},
			};
			const report = await inspect(
				{ parent: "demo:block/base" },
				{ layers: [layer], hasVanilla: false },
			);
			hasSkip(check, report, "model-parent", "document-unreadable");
		},
	});
}

const textureModel = (textures: Record<string, unknown>, texture = "#all") => ({
	textures,
	elements: [{ ...cube, faces: { north: { texture } } }],
});
INSPECT_CASES.push(
	{
		name: "texture variables: alias chain resolves to sprite resource id",
		async run(check) {
			const report = await inspect(
				textureModel({ all: "#middle", middle: "#leaf", leaf: "demo:stone" }),
			);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"resolved",
			);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.resolvedTo,
				"demo:stone",
			);
			check.deepEqual(report.findings, []);
		},
	},
	{
		name: "texture variables: undefined variable is a broken reference",
		async run(check) {
			const report = await inspect(textureModel({}));
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"undefined-variable",
			);
			hasFinding(check, report, "PACK_BROKEN_REFERENCE", "error");
		},
	},
	{
		name: "texture variables: alias cycle terminates with reference cycle",
		async run(check) {
			const report = await inspect(
				textureModel({ all: "#other", other: "#all" }),
			);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"cycle",
			);
			hasFinding(check, report, "PACK_REFERENCE_CYCLE", "error");
		},
	},
	{
		name: "texture variables: self-reference terminates with reference cycle",
		async run(check) {
			const report = await inspect(textureModel({ all: "#all" }));
			hasFinding(check, report, "PACK_REFERENCE_CYCLE", "error");
		},
	},
	{
		name: "texture variables: aliases cross parent model while retaining child overrides",
		async run(check) {
			const report = await inspect(
				{
					parent: "demo:block/base",
					textures: { all: "#leaf", leaf: "demo:alternate" },
					elements: [cube],
				},
				context({
					[parentRel]: { textures: { leaf: "demo:stone" } },
					"assets/demo/textures/alternate.png": "texture",
				}),
			);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.resolvedTo,
				"demo:alternate",
			);
		},
	},
	{
		name: "texture variables: alias to parent-only variable",
		async run(check) {
			const report = await inspect(
				{
					parent: "demo:block/base",
					textures: { all: "#leaf" },
					elements: [cube],
				},
				context({ [parentRel]: { textures: { leaf: "demo:stone" } } }),
			);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.resolvedTo,
				"demo:stone",
			);
		},
	},
	{
		name: "texture variables: object sprite resolves and preserves translucency",
		async run(check) {
			const report = await inspect(
				textureModel({
					all: { sprite: "demo:stone", force_translucent: true },
				}),
			);
			check.equal(report.textures[0]?.value, "demo:stone");
			check.equal(report.textures[0]?.forceTranslucent, true);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"resolved",
			);
		},
	},
	{
		name: "texture variables: object sprite cannot reference another variable",
		async run(check) {
			const report = await inspect(
				textureModel({ all: { sprite: "#leaf" }, leaf: "demo:stone" }),
			);
			hasFinding(check, report, "MODEL_INVALID_STRUCTURE", "error");
			check.ok(
				report.elements[0]?.faces[0]?.textureResolution.status !== "resolved",
			);
		},
	},
	{
		name: "texture variables: missing texture is distinct from undefined variable",
		async run(check) {
			const report = await inspect(textureModel({ all: "demo:missing" }));
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"missing",
			);
			hasFinding(check, report, "PACK_MISSING_TEXTURE", "error");
		},
	},
	{
		name: "texture variables: direct face texture uses resource lookup",
		async run(check) {
			const report = await inspect(textureModel({}, "demo:stone"));
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"resolved",
			);
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.source,
				"current",
			);
		},
	},
	{
		name: "texture variables: unavailable parent leaves variable resolution partial",
		async run(check) {
			const report = await inspect({
				parent: "minecraft:block/unknown",
				elements: [cube],
			});
			hasSkip(check, report, "external-reference", "vanilla-not-provided");
			check.ok(
				!report.findings.some((f) => f.code === "PACK_BROKEN_REFERENCE"),
			);
			check.ok(
				["external", "unresolved"].includes(
					report.elements[0]?.faces[0]?.textureResolution.status ?? "",
				),
			);
		},
	},
	{
		name: "texture variables: lookup includes dependency and vanilla textures",
		async run(check) {
			for (const source of ["dependency:0", "vanilla"] as const) {
				const report = await inspect(textureModel({ all: "demo:stone" }), {
					hasVanilla: source === "vanilla",
					layers: [
						memoryLayer("current", {}),
						memoryLayer(source, { [stone]: "texture" }),
					],
				});
				check.equal(
					report.elements[0]?.faces[0]?.textureResolution.source,
					source,
				);
				check.deepEqual(report.findings, []);
			}
		},
	},
	{
		name: "unknown contents: preserved pointers and coverage exclude Blockbench exceptions",
		async run(check) {
			const input = {
				"a/b~c": { n: 22.5 },
				texture_size: [16, 16],
				textures: { all: "demo:stone" },
				elements: [{ ...cube, name: "named", custom: 1 }],
			};
			const report = await inspect(input);
			check.deepEqual(report.preservedUnknown, [
				"/a~1b~0c",
				"/elements/0/custom",
			]);
			hasSkip(check, report, "model-unknown-field", "field-not-interpreted");
			check.equal(report.verdict, "pass");
		},
	},
);

for (const [label, input] of [
	["4097 elements", { elements: Array.from({ length: 4097 }, () => cube) }],
	[
		"257 texture variables",
		{
			textures: Object.fromEntries(
				Array.from({ length: 257 }, (_, i) => [`t${i}`, "demo:stone"]),
			),
		},
	],
] as const) {
	INSPECT_CASES.push({
		name: `limits: inspect rejects ${label}`,
		async run(check) {
			await assertAsyncError(
				check,
				() => inspect(input),
				"RESOURCE_LIMIT_EXCEEDED",
			);
		},
	});
}
INSPECT_CASES.push({
	name: "limits: inspect rejects file larger than 1 MiB",
	async run(check) {
		await assertAsyncError(
			check,
			() => inspectModel(`{}${" ".repeat(1_048_575)}`, { path }),
			"RESOURCE_LIMIT_EXCEEDED",
		);
	},
});

for (const version of [undefined, "98.0", "15.0", "60.0"]) {
	INSPECT_CASES.push({
		name: `coverage: inspect version ${version ?? "unspecified"} cannot claim complete`,
		async run(check) {
			const report = await inspectModel('{"ambientocclusion":"bad"}', {
				path,
				packFormat: version,
			});
			hasFinding(check, report, "MODEL_INVALID_STRUCTURE", "error");
			check.ok(
				report.coverage.skipped.some(
					(skip) => skip.kind === "model-version-rules",
				),
			);
			check.equal(report.coverage.status, "partial");
			if (version === "15.0" || version === "60.0") {
				hasSkip(check, report, "model-version-rules", "rules-inferred");
			}
			check.equal(report.verdict, "fail");
		},
	});
}
for (const [reportPath, expected] of [
	["assets/demo/models/block/a.json", "block"],
	["assets/demo/models/item/a.json", "item"],
	["custom.json", "unknown"],
] as const) {
	INSPECT_CASES.push({
		name: `report: path determines ${expected} kind`,
		async run(check) {
			const report = await inspectModel("{}", {
				path: reportPath,
				packFormat: "84.0",
			});
			check.equal(report.path, reportPath);
			check.equal(report.kind, expected);
			check.equal(report.modelId, undefined);
		},
	});
}
INSPECT_CASES.push(
	{
		name: "report: validate uses same findings, verdict and coverage as inspect",
		async run(check) {
			const text = '{"ambientocclusion":1,"unknown":true}';
			const options = { path, packFormat: "84.0", minecraftVersion: "26.1" };
			const inspected = await inspectModel(text, options);
			const validated = await validateModel(text, options);
			check.equal(validated.path, path);
			check.equal(validated.mode, "validate");
			check.equal(validated.verdict, "fail");
			check.deepEqual(validated.findings, inspected.findings);
			check.deepEqual(validated.coverage, inspected.coverage);
			check.deepEqual(validated.version, {
				packFormat: "84.0",
				minecraftVersion: "26.1",
				rules: "verified",
				rulesReason: "verified-release",
			});
		},
	},
	{
		name: "report: warnings do not fail validation",
		async run(check) {
			const report = await inspect({
				elements: [{ from: [0, 0, 0], to: [1, 1, 1], faces: {} }],
			});
			hasFinding(check, report, "MODEL_SUSPICIOUS_VALUE", "warning");
			check.equal(report.verdict, "pass");
		},
	},
	{
		name: "report stability: same input yields identical bytes and byte-sorted unknown fields",
		async run(check) {
			const input = {
				𐀀: 1,
				"": 1,
				z: true,
				ambientocclusion: 1,
				gui_light: "invalid",
			};
			const first = await inspect(input);
			const second = await inspect(input);
			check.equal(first.path, path);
			check.equal(first.findings.length, 2);
			check.equal(first.preservedUnknown.length, 3);
			assertByteSorted(check, first.preservedUnknown);
			assertByteSorted(
				check,
				first.findings.map(
					(f) => `${f.pointer}\u0000${f.code}\u0000${f.message}`,
				),
			);
			assertByteSorted(
				check,
				first.coverage.skipped.map(
					(s) => `${s.kind}\u0000${s.target}\u0000${s.reason}`,
				),
			);
			check.equal(JSON.stringify(first), JSON.stringify(second));
		},
	},
);

INSPECT_CASES.push({
	name: "filesystem context: layer order, readonly bytes, absent files and case mismatch",
	async run(check) {
		const temp = await mkdtemp(join(tmpdir(), "mc-asset-model-"));
		try {
			const roots = ["current", "dep0", "dep1", "vanilla"].map((name) =>
				join(temp, name),
			);
			for (const root of roots) {
				await mkdir(join(root, "assets/demo/models/block"), {
					recursive: true,
				});
				await mkdir(join(root, "assets/demo/textures"), { recursive: true });
				await writeFile(
					join(root, "assets/demo/models/block/Base.json"),
					JSON.stringify(base),
				);
				await writeFile(
					join(root, "assets/demo/textures/Stone.png"),
					"texture",
				);
			}
			const resolution = await createFsModelContext({
				packRoot: roots[0],
				dependencyRoots: [roots[1], roots[2]],
				vanillaRoot: roots[3],
			});
			check.deepEqual(
				resolution.layers.map((layer) => layer.source),
				sources,
			);
			check.equal(resolution.hasVanilla, true);
			const layer = resolution.layers[0];
			check.ok(layer);
			if (!layer) return;
			check.equal(layer.has("assets/demo/models/block/Base.json"), true);
			check.equal(layer.has("missing.json"), false);
			check.equal(await layer.read("missing.json"), undefined);
			check.deepEqual(
				await layer.read("assets/demo/models/block/Base.json"),
				encoder.encode(JSON.stringify(base)),
			);
			const parent = await inspect({ parent: "demo:block/base" }, resolution);
			hasFinding(check, parent, "PACK_CASE_MISMATCH", "error");
			check.ok(!parent.findings.some((f) => f.code === "PACK_MISSING_ASSET"));
			const texture = await inspect(
				textureModel({ all: "demo:stone" }),
				resolution,
			);
			hasFinding(check, texture, "PACK_CASE_MISMATCH", "error");
			check.ok(
				!texture.findings.some((f) => f.code === "PACK_MISSING_TEXTURE"),
			);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	},
});

for (const [label, input, pointer, version] of [
	["numeric parent", { parent: 123 }, "/parent", "84.0"],
	["array textures", { textures: [] }, "/textures", "84.0"],
	[
		"numeric texture before object support",
		{ textures: { bad: 42 } },
		"/textures/bad",
		"75.0",
	],
	["empty parent", { parent: "" }, "/parent", "84.0"],
	["invalid parent location", { parent: "INVALID ID" }, "/parent", "84.0"],
	["image parent", { parent: "demo:block/base.png" }, "/parent", "84.0"],
	[
		"invalid texture location",
		{ textures: { bad: "demo:bad value" } },
		"/textures/bad",
		"84.0",
	],
	["empty texture", { textures: { bad: "" } }, "/textures/bad", "84.0"],
	[
		"model texture",
		{ textures: { bad: "demo:block/base.json" } },
		"/textures/bad",
		"84.0",
	],
	["empty variable", { textures: { bad: "#" } }, "/textures/bad", "84.0"],
	[
		"invalid object sprite location",
		{ textures: { bad: { sprite: "demo:bad value" } } },
		"/textures/bad/sprite",
		"84.0",
	],
	[
		"invalid direct face location",
		{
			elements: [{ ...cube, faces: { north: { texture: "demo:bad value" } } }],
		},
		"/elements/0/faces/north/texture",
		"84.0",
	],
] as const) {
	INSPECT_CASES.push({
		name: `reference validation: rejects ${label} before resolution`,
		async run(check) {
			const report = await inspectModel(JSON.stringify(input), {
				path,
				packFormat: version,
			});
			check.ok(
				report.findings.some(
					(finding) =>
						finding.code === "PACK_BROKEN_REFERENCE" &&
						finding.level === "error" &&
						finding.pointer === pointer,
				),
				`expected error PACK_BROKEN_REFERENCE at ${pointer}`,
			);
			check.equal(report.verdict, "fail");
			check.ok(
				!report.findings.some(
					(finding) => finding.code === "PACK_UNRESOLVED_EXTERNAL",
				),
				"invalid references must not reach external resolution",
			);
		},
	});
}

for (const version of [undefined, "45.9", "46.0", "84.0", "98.0"]) {
	for (const both of [false, true]) {
		INSPECT_CASES.push({
			name: `rotation version: ${version ?? "unspecified"} ${both ? "both forms" : "xyz"}`,
			async run(check) {
				const rotation = {
					origin: [8, 8, 8],
					x: 30,
					y: 20,
					z: 10,
					...(both ? { axis: "y", angle: 22.5 } : {}),
				};
				const report = await inspectModel(
					JSON.stringify({
						textures: { all: "demo:stone" },
						elements: [{ ...cube, rotation }],
					}),
					{ path, packFormat: version, context: context() },
				);
				const rotationFindings = report.findings.filter((finding) =>
					finding.pointer.startsWith("/elements/0/rotation"),
				);
				const unknown = version === undefined || version === "98.0";
				const unsupported = version === "45.9" || version === "46.0";
				check.deepEqual(
					rotationFindings.map(({ code, level }) => [code, level]),
					unknown
						? []
						: unsupported
							? [["MODEL_VERSION_FEATURE", both ? "warning" : "error"]]
							: both
								? [["MODEL_SUSPICIOUS_VALUE", "warning"]]
								: [],
				);
				if (unknown) {
					check.equal(report.verdict, "pass");
					hasSkip(
						check,
						report,
						"model-version-rules",
						"feature-version-unknown",
					);
					check.ok(
						report.coverage.skipped.some(
							(skip) => skip.detail === "rotationXyz",
						),
					);
				}
			},
		});
	}
}
for (const version of [undefined, "98.0"]) {
	INSPECT_CASES.push({
		name: `rotation version: ${version ?? "unspecified"} still rejects nonfinite xyz and angle`,
		async run(check) {
			const report = await inspectModel(
				'{"elements":[{"from":[0,0,0],"to":[16,16,16],"rotation":{"origin":[8,8,8],"x":1e400,"axis":"y","angle":1e400},"faces":{"north":{"texture":"demo:stone"}}}]}',
				{ path, packFormat: version, context: context() },
			);
			for (const component of ["x", "angle"])
				check.ok(
					report.findings.some(
						(finding) =>
							finding.code === "MODEL_INVALID_ROTATION" &&
							finding.pointer === `/elements/0/rotation/${component}`,
					),
				);
			check.ok(
				!report.findings.some(
					(finding) => finding.code === "MODEL_VERSION_FEATURE",
				),
			);
			check.equal(report.verdict, "fail");
		},
	});
}

for (const inherited of [false, true]) {
	INSPECT_CASES.push({
		name: `parent termination: readable parent exits to vanilla with ${inherited ? "inherited" : "own"} faces`,
		async run(check) {
			const report = await inspect(
				{
					parent: "demo:block/base",
					textures: { alias: "#all" },
					...(inherited ? {} : { elements: [cube] }),
				},
				context({
					[parentRel]: {
						parent: "minecraft:block/cube_all",
						...(inherited ? { elements: [cube] } : {}),
					},
				}),
			);
			check.equal(report.textures[0]?.resolution.status, "external");
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"external",
			);
			hasSkip(check, report, "external-reference", "vanilla-not-provided");
			check.ok(!report.findings.some((finding) => finding.level === "error"));
			check.equal(report.verdict, "pass");
		},
	});
}
for (const count of [1, 32]) {
	INSPECT_CASES.push({
		name: `parent termination: complete ${count}-parent chain proves variables undefined`,
		async run(check) {
			const files: Record<string, unknown> = {};
			for (let i = 0; i < count; i += 1)
				files[`assets/demo/models/chain/${i}.json`] =
					i === count - 1 ? {} : { parent: `demo:chain/${i + 1}` };
			const report = await inspect(
				{
					parent: "demo:chain/0",
					textures: { alias: "#all" },
					elements: [cube],
				},
				context(files),
			);
			check.equal(report.textures[0]?.resolution.status, "undefined-variable");
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"undefined-variable",
			);
			hasFinding(check, report, "PACK_BROKEN_REFERENCE", "error");
			check.equal(report.coverage.status, "complete");
		},
	});
}
for (const [label, parent, reason] of [
	["invalid JSON", '{"a":}', "document-invalid-json"],
	["oversized document", `{}${" ".repeat(1_048_575)}`, "document-too-large"],
] as const) {
	INSPECT_CASES.push({
		name: `parent termination: ${label} does not prove variables undefined`,
		async run(check) {
			const report = await inspect(
				{
					parent: "demo:block/base",
					textures: { alias: "#all" },
					elements: [cube],
				},
				context({
					[parentRel]: { parent: "demo:block/exit" },
					"assets/demo/models/block/exit.json": parent,
				}),
			);
			check.equal(report.textures[0]?.resolution.status, "external");
			check.equal(
				report.elements[0]?.faces[0]?.textureResolution.status,
				"external",
			);
			hasSkip(check, report, "model-parent", reason);
			hasSkip(check, report, "external-reference", reason);
			check.ok(!report.findings.some((finding) => finding.level === "error"));
		},
	});
}
for (const [label, value, pointer, message] of [
	[
		"numeric entry",
		42,
		"/textures/all",
		"Texture entry must be a string or texture object.",
	],
	[
		"numeric sprite",
		{ sprite: 42 },
		"/textures/all/sprite",
		"Texture sprite must be a resource location string.",
	],
] as const) {
	INSPECT_CASES.push({
		name: `texture inheritance: parent ${label} blocks a valid grandparent definition`,
		async run(check) {
			const report = await inspect(
				{ parent: "demo:block/base", textures: { alias: "#all" } },
				context({
					[parentRel]: {
						parent: "demo:block/grandparent",
						textures: { all: value },
						elements: [cube],
					},
					"assets/demo/models/block/grandparent.json": {
						textures: { all: "demo:stone" },
					},
				}),
			);
			check.ok(
				report.findings.some(
					(finding) =>
						finding.code === "MODEL_INVALID_STRUCTURE" &&
						finding.level === "error" &&
						finding.pointer === pointer &&
						finding.message === message,
				),
				`expected parent MODEL_INVALID_STRUCTURE at ${pointer}`,
			);
			check.equal(report.verdict, "fail");
			check.equal(report.coverage.status, "complete");
			check.deepEqual(report.elementsSource, {
				from: "inherited",
				parent: "demo:block/base",
			});
			check.deepEqual(report.elements[0]?.faces[0]?.textureResolution, {
				status: "missing",
				via: ["#all"],
			});
			check.deepEqual(report.textures[0]?.resolution, {
				status: "missing",
				via: ["#all"],
			});
			check.ok(!report.inheritedTextures.some(({ name }) => name === "all"));
		},
	});
}
for (const [label, value] of [
	["string", "demo:stone"],
	["sprite object", { sprite: "demo:stone" }],
] as const) {
	INSPECT_CASES.push({
		name: `texture inheritance: legal parent ${label} wins over the grandparent`,
		async run(check) {
			const report = await inspect(
				{ parent: "demo:block/base", textures: { alias: "#all" } },
				context({
					[parentRel]: {
						parent: "demo:block/grandparent",
						textures: { all: value },
						elements: [cube],
					},
					"assets/demo/models/block/grandparent.json": {
						textures: { all: "demo:other" },
					},
					"assets/demo/textures/other.png": "other texture bytes",
				}),
			);
			check.equal(report.verdict, "pass");
			check.deepEqual(report.findings, []);
			check.equal(report.coverage.status, "complete");
			const expected = {
				status: "resolved",
				resolvedTo: "demo:stone",
				source: "current",
				via: ["#all"],
			};
			check.deepEqual(
				report.elements[0]?.faces[0]?.textureResolution,
				expected,
			);
			check.deepEqual(report.textures[0]?.resolution, expected);
			check.deepEqual(report.inheritedTextures, [
				{ name: "all", value: "demo:stone", from: "demo:block/base" },
			]);
		},
	});
}
INSPECT_CASES.push({
	name: "parent termination: builtin ends the chain and proves variables undefined",
	async run(check) {
		const report = await inspect({
			parent: "minecraft:item/generated",
			textures: { alias: "#all" },
			elements: [cube],
		});
		check.equal(report.textures[0]?.resolution.status, "undefined-variable");
		check.equal(
			report.elements[0]?.faces[0]?.textureResolution.status,
			"undefined-variable",
		);
		hasFinding(check, report, "PACK_BROKEN_REFERENCE", "error");
	},
});
