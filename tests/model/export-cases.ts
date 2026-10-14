import { applyModelOperations } from "../../src/model/edit.ts";
import { exportModelDocument } from "../../src/model/export.ts";
import { inspectModel } from "../../src/model/inspect.ts";
import { parseJsonDocument } from "../../src/model/json-document.ts";
import {
	assertInspectsClean,
	assertUnsupported,
	createdItemFixture,
	detailsOf,
	errorFindings,
	nodeAt,
	PRESERVE_SOURCE,
	PRESERVED_POINTERS,
	parseResult,
	pretty,
	REJECTIONS,
	XYZ_SOURCE,
} from "./edit-cases.ts";
import {
	assertError,
	type CaseCheck,
	type ModelCase,
} from "./json-document-cases.ts";
import { fixtureRules } from "./versions-cases.ts";

export const EXPORT_CASES: ModelCase[] = [];

const MESSY_SOURCE =
	'{"x_custom":{"a":[1.0,1e-3]},"elements":[{"faces":{"up":{"uv":[0,0,16.0,16],"texture":"#all"}},"to":[16,2.50,16],"from":[0,0,0],"name":"slab","future":0.10}],"parent":"x:y","texture_size":[16,16],"textures":{"all":"x:a"}}';
const MESSY_CANONICAL = [
	"{",
	'  "x_custom": {',
	'    "a": [',
	"      1.0,",
	"      1e-3",
	"    ]",
	"  },",
	'  "elements": [',
	"    {",
	'      "faces": {',
	'        "up": {',
	'          "uv": [',
	"            0,",
	"            0,",
	"            16.0,",
	"            16",
	"          ],",
	'          "texture": "#all"',
	"        }",
	"      },",
	'      "to": [',
	"        16,",
	"        2.50,",
	"        16",
	"      ],",
	'      "from": [',
	"        0,",
	"        0,",
	"        0",
	"      ],",
	'      "name": "slab",',
	'      "future": 0.10',
	"    }",
	"  ],",
	'  "parent": "x:y",',
	'  "texture_size": [',
	"    16,",
	"    16",
	"  ],",
	'  "textures": {',
	'    "all": "x:a"',
	"  }",
	"}",
	"",
].join("\n");

EXPORT_CASES.push(
	{
		name: "export: re-serializes to canonical bytes and keeps number text, order and unknown fields",
		run(check) {
			const snapshot = MESSY_SOURCE.slice();
			const result = exportModelDocument(MESSY_SOURCE, fixtureRules("84.0"));
			check.equal(result.text, MESSY_CANONICAL);
			check.equal(result.changed, true);
			check.deepEqual(result.preservedUnknown, [
				"/elements/0/future",
				"/x_custom",
			]);
			check.deepEqual(result.warnings, []);
			check.equal(MESSY_SOURCE, snapshot);
		},
	},
	{
		name: "export: canonical bytes are a fixed point (the created item model comes back unchanged)",
		async run(check) {
			const fixture = await createdItemFixture();
			const result = exportModelDocument(fixture, fixtureRules("84.0"));
			check.equal(result.text, fixture);
			check.equal(result.changed, false);
			const again = exportModelDocument(result.text, fixtureRules("84.0"));
			check.equal(again.text, result.text);
		},
	},
	{
		name: "export: a document without threshold features is accepted with no version",
		run(check) {
			const text = pretty({
				parent: "minecraft:block/block",
				textures: { all: "demo:block/a" },
				elements: [
					{
						from: [0, 0, 0],
						to: [4, 4, 4],
						rotation: { origin: [2, 2, 2], axis: "y", angle: 22.5 },
						faces: { up: { texture: "#all" } },
					},
				],
			});
			for (const version of [undefined, "98.0", "15.0"]) {
				const result = exportModelDocument(text, fixtureRules(version));
				check.equal(result.text, text);
				check.equal(result.changed, false);
				check.deepEqual(result.warnings, []);
			}
		},
	},
	{
		name: "export: warnings from the structure check come back, errors from rule gaps do not",
		run(check) {
			const doc = pretty({
				parent: "minecraft:item/generated",
				overrides: [{ predicate: { custom: 1 }, model: "x:y" }],
			});
			const modern = exportModelDocument(doc, fixtureRules("84.0"));
			check.deepEqual(
				modern.warnings.map((w) => [w.code, w.level, w.pointer]),
				[["MODEL_VERSION_FEATURE", "warning", "/overrides"]],
			);
			check.equal(modern.text, doc);
			const legacy = exportModelDocument(doc, fixtureRules("15.0"));
			check.deepEqual(legacy.warnings, []);
		},
	},
	{
		name: "export failure: source that is not strict JSON throws MODEL_INVALID_JSON",
		run(check) {
			const cases: readonly [string, string][] = [
				['{"a":1,"a":2}', "duplicate-key"],
				["[]", "root-not-object"],
				["\ufeff{}", "bom-not-allowed"],
				['{"a":1,}', "expected-object-key"],
			];
			for (const [text, reason] of cases) {
				const error = assertError(
					check,
					() => exportModelDocument(text, fixtureRules("84.0")),
					["MODEL_INVALID_JSON"],
				);
				check.equal(detailsOf(error).reason, reason, text);
			}
		},
	},
	{
		name: "export failure: a source over 1 MiB is RESOURCE_LIMIT_EXCEEDED",
		run(check) {
			assertError(
				check,
				() =>
					exportModelDocument(
						`{}${" ".repeat(1_048_575)}`,
						fixtureRules("84.0"),
					),
				["RESOURCE_LIMIT_EXCEEDED"],
			);
		},
	},
	{
		name: "export: apply then export is a fixed point and keeps the unknown-field report",
		async run(check) {
			const edited = applyModelOperations(
				PRESERVE_SOURCE,
				[{ op: "update_element", index: 1, changes: { name: "floor" } }],
				fixtureRules("84.0"),
			);
			const exported = exportModelDocument(edited.text, fixtureRules("84.0"));
			check.equal(exported.text, edited.text);
			check.equal(exported.changed, false);
			check.deepEqual(exported.preservedUnknown, edited.preservedUnknown);
			check.deepEqual(edited.preservedUnknown, PRESERVED_POINTERS);
			await assertInspectsClean(
				check,
				exported.text,
				"84.0",
				exported.preservedUnknown,
			);
			const root = parseResult(check, exported.text);
			const name = nodeAt(root, "/elements/1/name");
			check.deepEqual(name, { type: "string", value: "floor" });
			const report = await inspectModel(exported.text, {
				path: "assets/demo/models/block/made.json",
				packFormat: "84.0",
			});
			check.deepEqual(report.preservedUnknown, edited.preservedUnknown);
		},
	},
	{
		name: "export: running twice on the same source gives the same bytes",
		run(check) {
			const first = exportModelDocument(MESSY_SOURCE, fixtureRules("84.0"));
			const second = exportModelDocument(MESSY_SOURCE, fixtureRules("84.0"));
			check.equal(first.text, second.text);
			check.equal(first.text, MESSY_CANONICAL);
		},
	},
	{
		name: "export: applied is 0",
		run(check) {
			check.equal(
				exportModelDocument(MESSY_SOURCE, fixtureRules("84.0")).applied,
				0,
			);
			const canonical = exportModelDocument(
				MESSY_CANONICAL,
				fixtureRules("84.0"),
			);
			check.equal(canonical.applied, 0);
			check.equal(canonical.text, MESSY_CANONICAL);
			check.equal(canonical.changed, false);
		},
	},
	{
		name: "export checks the whole document: the source apply accepted is refused for an old target",
		run(check) {
			const text = pretty(XYZ_SOURCE);
			for (const version of ["46.0", undefined]) {
				const error = assertError(
					check,
					() => exportModelDocument(text, fixtureRules(version)),
					["MODEL_UNSUPPORTED_VERSION"],
				);
				assertUnsupported(check, error, {
					feature: "rotationXyz",
					since: "75.0",
					pointer: "/elements/0/rotation/y",
					version,
				});
			}
			const ok = exportModelDocument(text, fixtureRules("75.0"));
			check.equal(ok.text, text);
		},
	},
	{
		name: "export failure: structure errors in the source throw MODEL_INVALID_OPERATION with findings",
		run(check) {
			const outOfRange = pretty({
				parent: "minecraft:block/block",
				elements: [
					{
						from: [-20, 0, 0],
						to: [4, 4, 4],
						faces: { up: { texture: "#all" } },
					},
				],
			});
			const first = assertError(
				check,
				() => exportModelDocument(outOfRange, fixtureRules("84.0")),
				["MODEL_INVALID_OPERATION"],
			);
			check.deepEqual(errorFindings(first), [
				["MODEL_INVALID_STRUCTURE", "/elements/0/from"],
			]);
			const undefinedVariable = pretty({
				textures: { all: "demo:block/a" },
				elements: [
					{
						from: [0, 0, 0],
						to: [4, 4, 4],
						faces: { up: { texture: "#side" } },
					},
				],
			});
			const second = assertError(
				check,
				() => exportModelDocument(undefinedVariable, fixtureRules("84.0")),
				["MODEL_INVALID_OPERATION"],
			);
			check.deepEqual(errorFindings(second), [
				["PACK_BROKEN_REFERENCE", "/elements/0/faces/up/texture"],
			]);
		},
	},
	...REJECTIONS.map(
		(rejection): ModelCase => ({
			name: `version rejection (export): ${rejection.name}`,
			run(check: CaseCheck) {
				const text = pretty(rejection.doc);
				let result: unknown;
				const error = assertError(check, () => {
					result = exportModelDocument(text, fixtureRules(rejection.version));
				}, ["MODEL_UNSUPPORTED_VERSION"]);
				check.equal(result, undefined);
				assertUnsupported(check, error, {
					feature: rejection.feature,
					since: rejection.since,
					pointer: rejection.pointer,
					version: rejection.version,
				});
				const ok = exportModelDocument(text, fixtureRules(rejection.okVersion));
				check.equal(ok.text, text, "accepted content is written unchanged");
				check.equal(ok.changed, false);
			},
		}),
	),
);

// ───────────────────────── version gate: unknown subtrees keep their names ─────────────────────────

EXPORT_CASES.push(
	{
		name: "export version gate: unknown root fields with feature-like keys are kept for 46.0",
		run(check) {
			const doc = {
				parent: "minecraft:block/block",
				custom: {
					rotation: { x: 1, y: 2, z: 3, angle: 23 },
					shade: true,
					light_emission: 9,
					transformation: { translation: [0, 0, 0] },
					display: { on_shelf: { rotation: [0, 0, 0] } },
					textures: { layer0: { sprite: "demo:item/gem" } },
				},
				elements: [
					{
						from: [0, 0, 0],
						to: [4, 4, 4],
						faces: { up: { texture: "demo:block/a" } },
					},
				],
			};
			const text = pretty(doc);
			const result = exportModelDocument(text, fixtureRules("46.0"));
			check.equal(result.text, text);
			check.equal(result.changed, false);
			const kept = nodeAt(parseResult(check, result.text), "/custom");
			check.deepEqual(kept, nodeAt(parseJsonDocument(text), "/custom"));
			check.deepEqual(result.preservedUnknown, ["/custom"]);
		},
	},
	{
		name: "export version gate: unknown face fields with texture-like keys are kept for 46.0",
		run(check) {
			const doc = {
				parent: "minecraft:block/block",
				elements: [
					{
						from: [0, 0, 0],
						to: [4, 4, 4],
						faces: {
							up: {
								texture: "demo:block/a",
								future: { textures: { x: { sprite: "demo:block/a" } } },
							},
						},
					},
				],
			};
			const text = pretty(doc);
			const result = exportModelDocument(text, fixtureRules("46.0"));
			check.equal(result.text, text);
			check.equal(result.changed, false);
			check.deepEqual(result.preservedUnknown, ["/elements/0/faces/up/future"]);
		},
	},
);

// ───────────────────────── output limits: file bytes ─────────────────────────

const exportEncoder = new TextEncoder();

function sixFaceElements(count: number): Record<string, unknown>[] {
	const face = { texture: "demo:block/a" };
	return Array.from({ length: count }, () => ({
		from: [0, 0, 0],
		to: [1, 1, 1],
		faces: {
			down: face,
			up: face,
			north: face,
			south: face,
			west: face,
			east: face,
		},
	}));
}

EXPORT_CASES.push(
	{
		name: "export limits: a document that serializes to exactly 1,048,576 bytes is accepted",
		run(check) {
			const elements = sixFaceElements(1945);
			(elements[0] as Record<string, unknown>).name = "a".repeat(143);
			const text = pretty({ parent: "minecraft:block/block", elements });
			const selfBytes = exportEncoder.encode(text).length;
			check.equal(selfBytes, 1_048_576);
			const result = exportModelDocument(text, fixtureRules("84.0"));
			check.equal(result.text, text);
			check.equal(result.changed, false);
		},
	},
	{
		name: "export limits: a document that serializes past 1,048,576 bytes is RESOURCE_LIMIT_EXCEEDED",
		run(check) {
			const doc = {
				parent: "minecraft:block/block",
				elements: sixFaceElements(1946),
			};
			const compact = JSON.stringify(doc);
			const compactBytes = exportEncoder.encode(compact).length;
			check.ok(
				compactBytes <= 1_048_576,
				`compact source is ${compactBytes} bytes`,
			);
			const serializedBytes = exportEncoder.encode(pretty(doc)).length;
			check.ok(
				serializedBytes > 1_048_576,
				`serialized probe is ${serializedBytes} bytes`,
			);
			let result: unknown;
			const error = assertError(check, () => {
				result = exportModelDocument(compact, fixtureRules("84.0"));
			}, ["RESOURCE_LIMIT_EXCEEDED"]);
			check.equal(result, undefined);
			check.equal(detailsOf(error).limit, 1_048_576);
			check.equal(detailsOf(error).actual, serializedBytes);
		},
	},
);
