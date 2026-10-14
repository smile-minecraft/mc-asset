import { readFile } from "node:fs/promises";
import type { McAssetError } from "../../src/core/errors.ts";
import {
	applyModelOperations,
	createModelDocument,
	type ModelOperation,
} from "../../src/model/edit.ts";
import { exportModelDocument } from "../../src/model/export.ts";
import { inspectModel } from "../../src/model/inspect.ts";
import {
	type JsonNode,
	parseJsonDocument,
} from "../../src/model/json-document.ts";
import type { ModelFinding } from "../../src/model/structure.ts";
import type { ElementSpec, ModelSpec } from "../../src/model/types.ts";
import {
	assertError,
	type CaseCheck,
	type ModelCase,
} from "./json-document-cases.ts";
import { fixtureRules } from "./versions-cases.ts";

export const EDIT_CASES: ModelCase[] = [];

const inspectPath = "assets/demo/models/item/made.json";

/** Expected text for a canonical document: 2-space indent, LF, one trailing newline. */
export function pretty(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

export function omit(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

export function replaceOnce(
	text: string,
	search: string,
	replacement: string,
): string {
	const first = text.indexOf(search);
	if (first < 0 || text.indexOf(search, first + 1) >= 0)
		throw new Error(`test text must contain exactly one: ${search}`);
	return text.replace(search, () => replacement);
}

export function detailsOf(error: McAssetError): Record<string, unknown> {
	return (error.details ?? {}) as Record<string, unknown>;
}

/** Error-level findings of a MODEL_INVALID_OPERATION as [code, pointer] pairs. */
export function errorFindings(error: McAssetError): [string, string][] {
	const findings = detailsOf(error).findings as ModelFinding[] | undefined;
	if (!Array.isArray(findings)) throw new Error("details.findings missing");
	return findings
		.filter((finding) => finding.level === "error")
		.map((finding) => [finding.code, finding.pointer]);
}

/** Parses an editor result, failing at an assertion (not in the parser) when no document came back. */
export function parseResult(check: CaseCheck, text: string): JsonNode {
	check.ok(text.startsWith("{"), "a document was returned");
	return parseJsonDocument(text);
}

export function nodeAt(root: JsonNode, pointer: string): JsonNode | undefined {
	let node: JsonNode | undefined = root;
	for (const segment of pointer.split("/").slice(1)) {
		if (node === undefined) return undefined;
		if (node.type === "object")
			node = node.members.find((member) => member.key === segment)?.value;
		else if (node.type === "array") node = node.items[Number(segment)];
		else return undefined;
	}
	return node;
}

/** Version-rejection details: feature (when pinned), since, target, and the first use's pointer. */
export function assertUnsupported(
	check: CaseCheck,
	error: McAssetError,
	expected: {
		readonly feature: string;
		readonly since: string;
		readonly pointer: string;
		readonly version: string | undefined;
	},
): void {
	const details = detailsOf(error);
	check.equal(details.feature, expected.feature);
	check.equal(details.since, expected.since);
	check.equal(details.pointer, expected.pointer);
	check.equal(details.target, expected.version ?? "unspecified");
}

/** Inspect output of the real checker: no error findings, same unknown-field pointers. */
export async function assertInspectsClean(
	check: CaseCheck,
	text: string,
	version: string | undefined,
	preservedUnknown: readonly string[],
): Promise<void> {
	check.ok(text.startsWith("{"), "a document was returned");
	const report = await inspectModel(text, {
		path: inspectPath,
		packFormat: version,
	});
	check.deepEqual(
		report.findings.filter((finding) => finding.level === "error"),
		[],
	);
	check.equal(report.verdict, "pass");
	check.deepEqual(report.preservedUnknown, preservedUnknown);
}

// ───────────────────────── documents shared by the cases ─────────────────────────

const ELEMENT_A = {
	from: [0, 0, 0],
	to: [16, 8, 16],
	faces: {
		down: { texture: "#all", cullface: "down" },
		up: { texture: "#all" },
	},
};
const ELEMENT_B = {
	from: [4, 8, 4],
	to: [12, 16, 12],
	faces: { north: { texture: "#all" } },
};
export const BASE: Record<string, unknown> = {
	parent: "minecraft:block/block",
	textures: { all: "demo:block/a", particle: "#all" },
	elements: [ELEMENT_A, ELEMENT_B],
	display: {
		gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] },
	},
};
/** No parent: variables used by faces must be defined by the document itself. */
const NO_PARENT: Record<string, unknown> = {
	textures: { all: "demo:block/a" },
	elements: [
		{
			from: [0, 0, 0],
			to: [16, 16, 16],
			faces: { north: { texture: "#all" } },
		},
	],
};

const NEW_ELEMENT_INPUT: ElementSpec = {
	faces: {
		west: { texture: "#all", uv: [0, 0, 8, 8] },
		down: {
			tintindex: 1,
			cullface: "down",
			rotation: 90,
			texture: "#all",
			uv: [0, 0, 4, 4],
		},
	},
	lightEmission: 5,
	shade: false,
	to: [10, 10, 10],
	from: [6, 6, 6],
	name: "core",
	rotation: { rescale: true, angle: 45, axis: "x", origin: [8, 8, 8] },
};
const NEW_ELEMENT_JSON = {
	name: "core",
	from: [6, 6, 6],
	to: [10, 10, 10],
	rotation: { origin: [8, 8, 8], axis: "x", angle: 45, rescale: true },
	shade: false,
	light_emission: 5,
	faces: {
		down: {
			uv: [0, 0, 4, 4],
			texture: "#all",
			cullface: "down",
			rotation: 90,
			tintindex: 1,
		},
		west: { uv: [0, 0, 8, 8], texture: "#all" },
	},
};

const CANONICAL_POSITIONS = [
	"thirdperson_righthand",
	"thirdperson_lefthand",
	"firstperson_righthand",
	"firstperson_lefthand",
	"gui",
	"head",
	"ground",
	"fixed",
	"on_shelf",
] as const;

export const ITEM_SPEC: ModelSpec = {
	display: {
		ground: { scale: [0.5, 0.5, 0.5], translation: [0, 2, 0] },
		gui: { translation: [0, 1, 0], rotation: [30, 225, 0] },
	},
	elements: [
		{
			faces: {
				up: { texture: "#layer0", uv: [0, 0, 16, 16] },
				down: {
					tintindex: 1,
					cullface: "down",
					rotation: 90,
					texture: "#layer0",
					uv: [0, 0, 4, 4],
				},
			},
			to: [14, 2, 14],
			from: [2, 0, 2],
			name: "base",
		},
		{
			faces: {
				east: { texture: "#layer1", uv: [0, 0, 8, 8] },
				north: { texture: "#layer1" },
			},
			lightEmission: 7,
			shade: false,
			rotation: { rescale: false, angle: 22.5, axis: "y", origin: [8, 2, 8] },
			to: [10, 12, 10],
			from: [6, 2, 6],
		},
	],
	textures: {
		particle: "demo:item/gem",
		layer1: "demo:item/gem_glow",
		layer0: "demo:item/gem",
	},
	guiLight: "front",
	ambientocclusion: false,
	parent: "minecraft:item/generated",
};

export async function createdItemFixture(): Promise<string> {
	return readFile(
		new URL("./fixtures/created-item-model.txt", import.meta.url),
		"utf8",
	);
}

// ───────────────────────── case builders ─────────────────────────

interface ApplyOk {
	readonly source: unknown;
	readonly ops: readonly ModelOperation[];
	readonly expected: unknown;
	readonly version?: string | undefined;
	readonly preservedUnknown?: readonly string[];
	readonly warnings?: readonly [string, string][];
}

function sourceText(source: unknown): string {
	return typeof source === "string" ? source : pretty(source);
}

function applyOk(name: string, input: ApplyOk): void {
	EDIT_CASES.push({
		name: `apply: ${name}`,
		run(check) {
			const version = "version" in input ? input.version : "84.0";
			const text = sourceText(input.source);
			const snapshot = text.slice();
			const ops = deepFreeze(structuredClone(input.ops));
			const result = applyModelOperations(text, ops, fixtureRules(version));
			const expectedText = sourceText(input.expected);
			check.equal(result.text, expectedText);
			check.equal(result.applied, ops.length);
			check.equal(result.changed, expectedText !== text);
			check.equal(text, snapshot);
			if (input.preservedUnknown !== undefined)
				check.deepEqual(result.preservedUnknown, input.preservedUnknown);
			if (input.warnings !== undefined)
				check.deepEqual(
					result.warnings.map((w) => [w.code, w.pointer]),
					input.warnings,
				);
		},
	});
}

interface OperationFailure {
	readonly index: number;
	readonly op: string;
	readonly reason: string;
}

function operationFails(
	name: string,
	source: unknown,
	ops: readonly unknown[],
	failure: OperationFailure,
	version: string | undefined = "84.0",
): void {
	EDIT_CASES.push({
		name: `apply failure: ${name}`,
		run(check) {
			const text = sourceText(source);
			const snapshot = text.slice();
			const frozen = deepFreeze(structuredClone(ops)) as ModelOperation[];
			const error = assertError(
				check,
				() => applyModelOperations(text, frozen, fixtureRules(version)),
				["MODEL_INVALID_OPERATION"],
			);
			const details = detailsOf(error);
			check.equal(details.index, failure.index);
			check.equal(details.op, failure.op);
			check.equal(details.reason, failure.reason);
			check.equal(text, snapshot);
		},
	});
}

function gateFails(
	name: string,
	source: unknown,
	ops: readonly unknown[],
	findings: readonly [string, string][],
	version: string | undefined = "84.0",
): void {
	EDIT_CASES.push({
		name: `apply post-edit gate: ${name}`,
		run(check) {
			const text = sourceText(source);
			const frozen = deepFreeze(structuredClone(ops)) as ModelOperation[];
			const error = assertError(
				check,
				() => applyModelOperations(text, frozen, fixtureRules(version)),
				["MODEL_INVALID_OPERATION"],
			);
			check.deepEqual(errorFindings(error), findings);
			check.equal(detailsOf(error).index, undefined);
		},
	});
}

// ───────────────────────── create ─────────────────────────

EDIT_CASES.push(
	{
		name: "create: multi-element item model matches the literal bytes and §6.1 order",
		async run(check) {
			const spec = deepFreeze(structuredClone(ITEM_SPEC));
			const result = createModelDocument(spec, fixtureRules("84.0"));
			check.equal(result.text, await createdItemFixture());
			check.equal(result.changed, true);
			check.deepEqual(result.warnings, []);
			check.deepEqual(result.preservedUnknown, []);
			check.equal(
				createModelDocument(spec, fixtureRules("84.0")).text,
				result.text,
				"repeat creation is byte-identical",
			);
		},
	},
	{
		name: "create: created item model passes the model checker without errors",
		async run(check) {
			const result = createModelDocument(ITEM_SPEC, fixtureRules("84.0"));
			await assertInspectsClean(check, result.text, "84.0", []);
			const root = parseResult(check, result.text);
			const layer = nodeAt(root, "/textures/layer0");
			check.deepEqual(layer, { type: "string", value: "demo:item/gem" });
		},
	},
	{
		name: "create: cube_all style block model with nine display positions",
		async run(check) {
			const reversed = [...CANONICAL_POSITIONS].reverse();
			const display = Object.fromEntries(
				reversed.map((position, index) => [
					position,
					{
						scale: [1, 1, 1],
						translation: [0, index, 0],
						rotation: [index * 10, 0, 0],
					},
				]),
			);
			const face = (direction: string) => ({
				texture: "#all",
				cullface: direction,
			});
			const spec = {
				display,
				elements: [
					{
						faces: {
							east: face("east"),
							west: face("west"),
							south: face("south"),
							north: face("north"),
							up: face("up"),
							down: face("down"),
						},
						to: [16, 16, 16],
						from: [0, 0, 0],
					},
				],
				textures: {
					particle: "#all",
					Overlay: "demo:block/ore_overlay",
					all: "demo:block/ore",
				},
				ambientocclusion: true,
			} as unknown as ModelSpec;
			const expected = {
				ambientocclusion: true,
				textures: {
					Overlay: "demo:block/ore_overlay",
					all: "demo:block/ore",
					particle: "#all",
				},
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						faces: {
							down: face("down"),
							up: face("up"),
							north: face("north"),
							south: face("south"),
							west: face("west"),
							east: face("east"),
						},
					},
				],
				display: Object.fromEntries(
					CANONICAL_POSITIONS.map((position) => {
						const index = reversed.indexOf(position);
						return [
							position,
							{
								rotation: [index * 10, 0, 0],
								translation: [0, index, 0],
								scale: [1, 1, 1],
							},
						];
					}),
				),
			};
			const result = createModelDocument(
				deepFreeze(spec),
				fixtureRules("84.0"),
			);
			check.equal(result.text, pretty(expected));
			check.deepEqual(
				Object.keys((JSON.parse(result.text) as { display: object }).display),
				[...CANONICAL_POSITIONS],
			);
			await assertInspectsClean(check, result.text, "84.0", []);
		},
	},
	{
		name: "create: texture variables sort by UTF-8 bytes, not by locale",
		run(check) {
			const result = createModelDocument(
				{ textures: { b: "x:b", a: "x:a", B: "x:B", é: "x:e", Z: "x:Z" } },
				fixtureRules("84.0"),
			);
			const textures = nodeAt(parseResult(check, result.text), "/textures");
			check.deepEqual(
				textures?.type === "object"
					? textures.members.map((member) => member.key)
					: [],
				["B", "Z", "a", "b", "é"],
			);
		},
	},
	{
		name: "create: minimal spec without a version is written byte for byte",
		run(check) {
			const result = createModelDocument(
				{
					textures: { all: "demo:block/stone" },
					parent: "minecraft:block/cube_all",
				},
				fixtureRules(undefined),
			);
			check.equal(
				result.text,
				'{\n  "parent": "minecraft:block/cube_all",\n  "textures": {\n    "all": "demo:block/stone"\n  }\n}\n',
			);
			check.deepEqual(result.warnings, []);
		},
	},
	{
		name: "create: both rotation forms keep their member order",
		run(check) {
			const spec: ModelSpec = {
				parent: "minecraft:block/block",
				elements: [
					{
						from: [0, 0, 0],
						to: [4, 4, 4],
						rotation: { z: 20, x: 10, origin: [2, 2, 2], rescale: true },
						faces: { up: { texture: "#all" } },
					},
					{
						from: [4, 4, 4],
						to: [8, 8, 8],
						rotation: {
							rescale: false,
							angle: -22.5,
							axis: "z",
							origin: [6, 6, 6],
						},
						faces: { up: { texture: "#all" } },
					},
				],
			};
			const result = createModelDocument(spec, fixtureRules("75.0"));
			const expected = {
				parent: "minecraft:block/block",
				elements: [
					{
						from: [0, 0, 0],
						to: [4, 4, 4],
						rotation: { origin: [2, 2, 2], x: 10, z: 20, rescale: true },
						faces: { up: { texture: "#all" } },
					},
					{
						from: [4, 4, 4],
						to: [8, 8, 8],
						rotation: {
							origin: [6, 6, 6],
							axis: "z",
							angle: -22.5,
							rescale: false,
						},
						faces: { up: { texture: "#all" } },
					},
				],
			};
			check.equal(result.text, pretty(expected));
		},
	},
	{
		name: "create: shade_direction_override replaces shade from 97.1",
		run(check) {
			const result = createModelDocument(
				{
					parent: "minecraft:block/block",
					elements: [
						{
							from: [0, 0, 0],
							to: [4, 4, 4],
							shadeDirectionOverride: "up",
							faces: { up: { texture: "#all" } },
						},
					],
				},
				fixtureRules("97.1"),
			);
			check.equal(
				result.text,
				pretty({
					parent: "minecraft:block/block",
					elements: [
						{
							from: [0, 0, 0],
							to: [4, 4, 4],
							shade_direction_override: "up",
							faces: { up: { texture: "#all" } },
						},
					],
				}),
			);
		},
	},
	{
		name: "create: object-form texture is written as sprite then force_translucent",
		run(check) {
			const result = createModelDocument(
				{
					parent: "minecraft:item/generated",
					textures: {
						layer0: { forceTranslucent: true, sprite: "demo:item/glass" },
						layer1: { sprite: "demo:item/plain" },
					},
				},
				fixtureRules("84.0"),
			);
			check.equal(
				result.text,
				pretty({
					parent: "minecraft:item/generated",
					textures: {
						layer0: { sprite: "demo:item/glass", force_translucent: true },
						layer1: { sprite: "demo:item/plain" },
					},
				}),
			);
		},
	},
	{
		name: "create: an element without faces is written and reported as a warning",
		run(check) {
			const result = createModelDocument(
				{ elements: [{ from: [0, 0, 0], to: [4, 4, 4], faces: {} }] },
				fixtureRules("84.0"),
			);
			check.equal(
				result.text,
				pretty({ elements: [{ from: [0, 0, 0], to: [4, 4, 4], faces: {} }] }),
			);
			check.deepEqual(
				result.warnings.map((w) => [w.code, w.level, w.pointer]),
				[["MODEL_SUSPICIOUS_VALUE", "warning", "/elements/0/faces"]],
			);
		},
	},
	{
		name: "create failure: an error finding throws MODEL_INVALID_OPERATION with findings",
		run(check) {
			const error = assertError(
				check,
				() =>
					createModelDocument(
						{
							parent: "minecraft:block/block",
							elements: [
								{
									from: [-16.01, 0, 0],
									to: [4, 4, 4],
									faces: { up: { texture: "#all" } },
								},
							],
						},
						fixtureRules("84.0"),
					),
				["MODEL_INVALID_OPERATION"],
			);
			check.deepEqual(errorFindings(error), [
				["MODEL_INVALID_STRUCTURE", "/elements/0/from"],
			]);
		},
	},
	{
		name: "create failure: a variable the document does not define is an error without a parent",
		run(check) {
			const spec: ModelSpec = {
				textures: { all: "demo:block/a" },
				elements: [
					{
						from: [0, 0, 0],
						to: [4, 4, 4],
						faces: { up: { texture: "#all" }, north: { texture: "#side" } },
					},
				],
			};
			const error = assertError(
				check,
				() => createModelDocument(spec, fixtureRules("84.0")),
				["MODEL_INVALID_OPERATION"],
			);
			check.deepEqual(errorFindings(error), [
				["PACK_BROKEN_REFERENCE", "/elements/0/faces/north/texture"],
			]);
		},
	},
	{
		name: "create: the same variable is not checked when a parent supplies variables",
		run(check) {
			const result = createModelDocument(
				{
					parent: "minecraft:block/block",
					elements: [
						{
							from: [0, 0, 0],
							to: [4, 4, 4],
							faces: { up: { texture: "#side" } },
						},
					],
				},
				fixtureRules("84.0"),
			);
			check.ok(result.text.includes('"#side"'));
		},
	},
	{
		name: "create failure: light_emission 16 is an invalid structure, not a version error",
		run(check) {
			const error = assertError(
				check,
				() =>
					createModelDocument(
						{
							parent: "minecraft:block/block",
							elements: [
								{
									from: [0, 0, 0],
									to: [4, 4, 4],
									lightEmission: 16,
									faces: { up: { texture: "#all" } },
								},
							],
						},
						fixtureRules("84.0"),
					),
				["MODEL_INVALID_OPERATION"],
			);
			check.deepEqual(errorFindings(error), [
				["MODEL_INVALID_STRUCTURE", "/elements/0/light_emission"],
			]);
		},
	},
	{
		name: "create failure: non-finite numbers never reach the output",
		run(check) {
			for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
				assertError(
					check,
					() =>
						createModelDocument(
							{
								parent: "minecraft:block/block",
								elements: [
									{
										from: [bad, 0, 0],
										to: [4, 4, 4],
										faces: { up: { texture: "#all" } },
									},
								],
							},
							fixtureRules("84.0"),
						),
					["MODEL_INVALID_OPERATION"],
				);
			}
		},
	},
);

// ───────────────────────── apply: per operation ─────────────────────────

const REASON = {
	emptyChange: "empty-change",
	wouldDrop: "would-drop-unknown-members",
	notFound: "not-found",
	faceExists: "face-exists",
	faceNotFound: "face-not-found",
	invalidExisting: "invalid-existing",
	invalidValue: "invalid-value",
	indexOutOfRange: "index-out-of-range",
	elementNotFound: "element-not-found",
	unknownOp: "unknown-op",
} as const;

// set_parent
applyOk("set_parent replaces the value in place", {
	source: BASE,
	ops: [{ op: "set_parent", parent: "minecraft:block/cube" }],
	expected: { ...BASE, parent: "minecraft:block/cube" },
});
applyOk("set_parent null removes the member", {
	source: BASE,
	ops: [{ op: "set_parent", parent: null }],
	expected: omit(BASE, "parent"),
});
applyOk("set_parent appends a new member after the existing ones", {
	source: omit(BASE, "parent"),
	ops: [{ op: "set_parent", parent: "minecraft:block/cube" }],
	expected: { ...omit(BASE, "parent"), parent: "minecraft:block/cube" },
});
applyOk("set_parent null on a document without a parent changes nothing", {
	source: omit(BASE, "parent"),
	ops: [{ op: "set_parent", parent: null }],
	expected: omit(BASE, "parent"),
});
operationFails(
	"set_parent with a non-string value",
	BASE,
	[{ op: "set_parent", parent: 5 }],
	{ index: 0, op: "set_parent", reason: REASON.invalidValue },
);

// set_property
applyOk("set_property appends ambientocclusion", {
	source: BASE,
	ops: [{ op: "set_property", ambientocclusion: false }],
	expected: { ...BASE, ambientocclusion: false },
});
applyOk("set_property appends gui_light", {
	source: BASE,
	ops: [{ op: "set_property", guiLight: "side" }],
	expected: { ...BASE, gui_light: "side" },
});
applyOk(
	"set_property replaces an existing value in place and leaves other keys",
	{
		source: { ...BASE, ambientocclusion: true, gui_light: "front" },
		ops: [{ op: "set_property", ambientocclusion: false }],
		expected: { ...BASE, ambientocclusion: false, gui_light: "front" },
	},
);
applyOk("set_property null removes only the given key", {
	source: { ...BASE, ambientocclusion: true, gui_light: "front" },
	ops: [{ op: "set_property", ambientocclusion: null }],
	expected: { ...BASE, gui_light: "front" },
});
operationFails("set_property without any key", BASE, [{ op: "set_property" }], {
	index: 0,
	op: "set_property",
	reason: REASON.emptyChange,
});
gateFails(
	"set_property gui_light outside front/side",
	BASE,
	[{ op: "set_property", guiLight: "back" }],
	[["MODEL_INVALID_STRUCTURE", "/gui_light"]],
);

// set_texture
applyOk("set_texture appends a new variable after the existing ones", {
	source: BASE,
	ops: [{ op: "set_texture", name: "alt", value: "demo:block/b" }],
	expected: {
		...BASE,
		textures: { all: "demo:block/a", particle: "#all", alt: "demo:block/b" },
	},
});
applyOk("set_texture replaces an existing variable in place", {
	source: BASE,
	ops: [{ op: "set_texture", name: "all", value: "demo:block/c" }],
	expected: {
		...BASE,
		textures: { all: "demo:block/c", particle: "#all" },
	},
});
applyOk("set_texture creates textures after the existing root members", {
	source: { parent: "minecraft:block/block" },
	ops: [{ op: "set_texture", name: "all", value: "demo:block/a" }],
	expected: {
		parent: "minecraft:block/block",
		textures: { all: "demo:block/a" },
	},
});
applyOk("set_texture writes the object form as sprite then force_translucent", {
	source: BASE,
	ops: [
		{
			op: "set_texture",
			name: "all",
			value: { forceTranslucent: true, sprite: "demo:block/a2" },
		},
	],
	expected: {
		...BASE,
		textures: {
			all: { sprite: "demo:block/a2", force_translucent: true },
			particle: "#all",
		},
	},
});
applyOk("set_texture replaces the whole value of an object-form entry", {
	source: {
		...BASE,
		textures: {
			all: { sprite: "demo:block/a", force_translucent: true },
			particle: "#all",
		},
	},
	ops: [{ op: "set_texture", name: "all", value: { sprite: "demo:block/b" } }],
	expected: {
		...BASE,
		textures: { all: { sprite: "demo:block/b" }, particle: "#all" },
	},
});
applyOk("set_texture may replace an object entry that has only known members", {
	source: {
		...BASE,
		textures: {
			all: { sprite: "demo:block/a", force_translucent: false },
			particle: "#all",
		},
	},
	ops: [{ op: "set_texture", name: "all", value: "demo:block/b" }],
	expected: { ...BASE, textures: { all: "demo:block/b", particle: "#all" } },
});
operationFails(
	"set_texture would drop unknown members of an object entry",
	{
		...BASE,
		textures: {
			all: { sprite: "demo:block/a", future: 1 },
			particle: "#all",
		},
	},
	[{ op: "set_texture", name: "all", value: "demo:block/b" }],
	{ index: 0, op: "set_texture", reason: REASON.wouldDrop },
);
gateFails(
	"set_texture sprite that references another variable",
	BASE,
	[{ op: "set_texture", name: "all", value: { sprite: "#particle" } }],
	[["MODEL_INVALID_STRUCTURE", "/textures/all/sprite"]],
);

// remove_texture
applyOk("remove_texture keeps the order of the remaining variables", {
	source: {
		...BASE,
		textures: { all: "demo:block/a", mid: "demo:block/m", particle: "#all" },
	},
	ops: [{ op: "remove_texture", name: "mid" }],
	expected: BASE,
});
operationFails(
	"remove_texture of a variable that does not exist",
	BASE,
	[{ op: "remove_texture", name: "missing" }],
	{ index: 0, op: "remove_texture", reason: REASON.notFound },
);
gateFails(
	"remove_texture of a variable a face still uses (no parent)",
	NO_PARENT,
	[{ op: "remove_texture", name: "all" }],
	[["PACK_BROKEN_REFERENCE", "/elements/0/faces/north/texture"]],
);

// add_element
applyOk("add_element appends by default and writes the §6.1 member order", {
	source: BASE,
	ops: [{ op: "add_element", element: NEW_ELEMENT_INPUT }],
	expected: { ...BASE, elements: [ELEMENT_A, ELEMENT_B, NEW_ELEMENT_JSON] },
});
applyOk("add_element at index 0 inserts before the first element", {
	source: BASE,
	ops: [{ op: "add_element", element: NEW_ELEMENT_INPUT, index: 0 }],
	expected: { ...BASE, elements: [NEW_ELEMENT_JSON, ELEMENT_A, ELEMENT_B] },
});
applyOk("add_element at a middle index shifts the later elements", {
	source: BASE,
	ops: [{ op: "add_element", element: NEW_ELEMENT_INPUT, index: 1 }],
	expected: { ...BASE, elements: [ELEMENT_A, NEW_ELEMENT_JSON, ELEMENT_B] },
});
applyOk("add_element at index equal to the length appends", {
	source: BASE,
	ops: [{ op: "add_element", element: NEW_ELEMENT_INPUT, index: 2 }],
	expected: { ...BASE, elements: [ELEMENT_A, ELEMENT_B, NEW_ELEMENT_JSON] },
});
applyOk("add_element creates elements after the existing root members", {
	source: { parent: "minecraft:block/block" },
	ops: [{ op: "add_element", element: NEW_ELEMENT_INPUT }],
	expected: { parent: "minecraft:block/block", elements: [NEW_ELEMENT_JSON] },
});
operationFails(
	"add_element beyond the end",
	BASE,
	[{ op: "add_element", element: NEW_ELEMENT_INPUT, index: 3 }],
	{ index: 0, op: "add_element", reason: REASON.indexOutOfRange },
);

// update_element
applyOk("update_element appends name after the existing members", {
	source: BASE,
	ops: [{ op: "update_element", index: 0, changes: { name: "slab" } }],
	expected: { ...BASE, elements: [{ ...ELEMENT_A, name: "slab" }, ELEMENT_B] },
});
applyOk("update_element null removes an optional key", {
	source: { ...BASE, elements: [{ ...ELEMENT_A, name: "slab" }, ELEMENT_B] },
	ops: [{ op: "update_element", index: 0, changes: { name: null } }],
	expected: BASE,
});
applyOk("update_element replaces from and to in place", {
	source: BASE,
	ops: [
		{
			op: "update_element",
			index: 1,
			changes: { to: [13, 15, 12.5], from: [3, 8, 4] },
		},
	],
	expected: {
		...BASE,
		elements: [
			ELEMENT_A,
			{ ...ELEMENT_B, from: [3, 8, 4], to: [13, 15, 12.5] },
		],
	},
});
applyOk("update_element adds shade then light_emission in operation order", {
	source: BASE,
	ops: [
		{ op: "update_element", index: 0, changes: { shade: false } },
		{ op: "update_element", index: 0, changes: { lightEmission: 3 } },
	],
	expected: {
		...BASE,
		elements: [{ ...ELEMENT_A, shade: false, light_emission: 3 }, ELEMENT_B],
	},
});
applyOk("update_element null removes shade and light_emission", {
	source: {
		...BASE,
		elements: [{ ...ELEMENT_A, shade: false, light_emission: 3 }, ELEMENT_B],
	},
	ops: [
		{
			op: "update_element",
			index: 0,
			changes: { shade: null, lightEmission: null },
		},
	],
	expected: BASE,
});
applyOk(
	"update_element rotation replaces known members and keeps unknown ones",
	{
		source: {
			...BASE,
			elements: [
				{
					...ELEMENT_A,
					rotation: {
						origin: [8, 8, 8],
						axis: "y",
						angle: 22.5,
						rescale: true,
						future: 1,
					},
				},
				ELEMENT_B,
			],
		},
		ops: [
			{
				op: "update_element",
				index: 0,
				changes: { rotation: { angle: 45, axis: "x", origin: [8, 8, 8] } },
			},
		],
		expected: {
			...BASE,
			elements: [
				{
					...ELEMENT_A,
					rotation: { origin: [8, 8, 8], axis: "x", angle: 45, future: 1 },
				},
				ELEMENT_B,
			],
		},
		preservedUnknown: ["/elements/0/rotation/future"],
	},
);
applyOk("update_element rotation switches to the x/y/z form", {
	source: {
		...BASE,
		elements: [
			{ ...ELEMENT_A, rotation: { origin: [8, 8, 8], axis: "y", angle: 22.5 } },
			ELEMENT_B,
		],
	},
	ops: [
		{
			op: "update_element",
			index: 0,
			changes: { rotation: { z: 20, x: 10, origin: [8, 8, 8] } },
		},
	],
	expected: {
		...BASE,
		elements: [
			{ ...ELEMENT_A, rotation: { origin: [8, 8, 8], x: 10, z: 20 } },
			ELEMENT_B,
		],
	},
	version: "75.0",
});
applyOk("update_element rotation null removes the rotation", {
	source: {
		...BASE,
		elements: [
			{ ...ELEMENT_A, rotation: { origin: [8, 8, 8], axis: "y", angle: 22.5 } },
			ELEMENT_B,
		],
	},
	ops: [{ op: "update_element", index: 0, changes: { rotation: null } }],
	expected: BASE,
});
operationFails(
	"update_element with empty changes",
	BASE,
	[{ op: "update_element", index: 0, changes: {} }],
	{ index: 0, op: "update_element", reason: REASON.emptyChange },
);
operationFails(
	"update_element with an index that does not exist",
	BASE,
	[{ op: "update_element", index: 2, changes: { name: "x" } }],
	{ index: 0, op: "update_element", reason: REASON.elementNotFound },
);
operationFails(
	"update_element with a negative index",
	BASE,
	[{ op: "update_element", index: -1, changes: { name: "x" } }],
	{ index: 0, op: "update_element", reason: REASON.elementNotFound },
);
gateFails(
	"update_element moves a corner outside −16..32",
	BASE,
	[{ op: "update_element", index: 0, changes: { from: [-16.01, 0, 0] } }],
	[["MODEL_INVALID_STRUCTURE", "/elements/0/from"]],
);

// remove_element
applyOk("remove_element removes the element at the index", {
	source: BASE,
	ops: [{ op: "remove_element", index: 0 }],
	expected: { ...BASE, elements: [ELEMENT_B] },
});
operationFails(
	"remove_element with an index that does not exist",
	BASE,
	[{ op: "remove_element", index: 2 }],
	{ index: 0, op: "remove_element", reason: REASON.elementNotFound },
);

// positions are zero-based and follow the earlier operations
applyOk("indices follow the document as the earlier operations left it", {
	source: BASE,
	ops: [
		{ op: "add_element", element: NEW_ELEMENT_INPUT, index: 0 },
		{ op: "update_element", index: 1, changes: { name: "old-first" } },
		{ op: "remove_element", index: 0 },
		{ op: "update_element", index: 1, changes: { name: "old-second" } },
	],
	expected: {
		...BASE,
		elements: [
			{ ...ELEMENT_A, name: "old-first" },
			{ ...ELEMENT_B, name: "old-second" },
		],
	},
});

// add_face
applyOk(
	"add_face appends the face after the existing ones in the §6.1 member order",
	{
		source: BASE,
		ops: [
			{
				op: "add_face",
				element: 1,
				face: "down",
				value: {
					tintindex: 0,
					rotation: 180,
					cullface: "down",
					texture: "#all",
					uv: [0, 0, 8, 8],
				},
			},
		],
		expected: {
			...BASE,
			elements: [
				ELEMENT_A,
				{
					...ELEMENT_B,
					faces: {
						north: { texture: "#all" },
						down: {
							uv: [0, 0, 8, 8],
							texture: "#all",
							cullface: "down",
							rotation: 180,
							tintindex: 0,
						},
					},
				},
			],
		},
	},
);
applyOk("add_face creates faces on an element that has none", {
	source: {
		...BASE,
		elements: [{ from: [0, 0, 0], to: [4, 4, 4] }],
	},
	ops: [{ op: "add_face", element: 0, face: "up", value: { texture: "#all" } }],
	expected: {
		...BASE,
		elements: [
			{ from: [0, 0, 0], to: [4, 4, 4], faces: { up: { texture: "#all" } } },
		],
	},
});
operationFails(
	"add_face on a face that already exists",
	BASE,
	[{ op: "add_face", element: 0, face: "up", value: { texture: "#all" } }],
	{ index: 0, op: "add_face", reason: REASON.faceExists },
);
operationFails(
	"add_face on an element that does not exist",
	BASE,
	[{ op: "add_face", element: 2, face: "up", value: { texture: "#all" } }],
	{ index: 0, op: "add_face", reason: REASON.elementNotFound },
);

// update_face
applyOk("update_face replaces texture in place and appends new members", {
	source: BASE,
	ops: [
		{
			op: "update_face",
			element: 0,
			face: "up",
			changes: { texture: "#particle", uv: [0, 0, 16, 8], rotation: 90 },
		},
	],
	expected: {
		...BASE,
		elements: [
			{
				...ELEMENT_A,
				faces: {
					down: { texture: "#all", cullface: "down" },
					up: { texture: "#particle", uv: [0, 0, 16, 8], rotation: 90 },
				},
			},
			ELEMENT_B,
		],
	},
});
applyOk("update_face null removes an optional member", {
	source: BASE,
	ops: [
		{
			op: "update_face",
			element: 0,
			face: "down",
			changes: { cullface: null },
		},
	],
	expected: {
		...BASE,
		elements: [
			{
				...ELEMENT_A,
				faces: { down: { texture: "#all" }, up: { texture: "#all" } },
			},
			ELEMENT_B,
		],
	},
});
applyOk("update_face keeps unknown members of the face", {
	source: {
		...BASE,
		elements: [
			{
				...ELEMENT_A,
				faces: { up: { texture: "#all", future: [1, 2] } },
			},
			ELEMENT_B,
		],
	},
	ops: [
		{
			op: "update_face",
			element: 0,
			face: "up",
			changes: { texture: "#particle" },
		},
	],
	expected: {
		...BASE,
		elements: [
			{
				...ELEMENT_A,
				faces: { up: { texture: "#particle", future: [1, 2] } },
			},
			ELEMENT_B,
		],
	},
	preservedUnknown: ["/elements/0/faces/up/future"],
});
operationFails(
	"update_face on a face that does not exist",
	BASE,
	[
		{
			op: "update_face",
			element: 0,
			face: "west",
			changes: { texture: "#all" },
		},
	],
	{ index: 0, op: "update_face", reason: REASON.faceNotFound },
);
operationFails(
	"update_face with empty changes",
	BASE,
	[{ op: "update_face", element: 0, face: "up", changes: {} }],
	{ index: 0, op: "update_face", reason: REASON.emptyChange },
);
operationFails(
	"update_face on an element that does not exist",
	BASE,
	[{ op: "update_face", element: 9, face: "up", changes: { texture: "#all" } }],
	{ index: 0, op: "update_face", reason: REASON.elementNotFound },
);
gateFails(
	"update_face texture variable the document does not define (no parent)",
	NO_PARENT,
	[
		{
			op: "update_face",
			element: 0,
			face: "north",
			changes: { texture: "#missing" },
		},
	],
	[["PACK_BROKEN_REFERENCE", "/elements/0/faces/north/texture"]],
);

// remove_face
applyOk("remove_face removes one face and keeps the others", {
	source: BASE,
	ops: [{ op: "remove_face", element: 0, face: "down" }],
	expected: {
		...BASE,
		elements: [{ ...ELEMENT_A, faces: { up: { texture: "#all" } } }, ELEMENT_B],
	},
});
applyOk("remove_face of the last face leaves empty faces and a warning", {
	source: BASE,
	ops: [{ op: "remove_face", element: 1, face: "north" }],
	expected: { ...BASE, elements: [ELEMENT_A, { ...ELEMENT_B, faces: {} }] },
	warnings: [["MODEL_SUSPICIOUS_VALUE", "/elements/1/faces"]],
});
operationFails(
	"remove_face on a face that does not exist",
	BASE,
	[{ op: "remove_face", element: 0, face: "west" }],
	{ index: 0, op: "remove_face", reason: REASON.faceNotFound },
);
operationFails(
	"remove_face on an element that does not exist",
	BASE,
	[{ op: "remove_face", element: 7, face: "up" }],
	{ index: 0, op: "remove_face", reason: REASON.elementNotFound },
);

// set_display
applyOk("set_display appends a new position after the existing ones", {
	source: BASE,
	ops: [
		{
			op: "set_display",
			position: "ground",
			value: {
				scale: [0.5, 0.5, 0.5],
				translation: [0, 1, 0],
				rotation: [0, 90, 0],
			},
		},
	],
	expected: {
		...BASE,
		display: {
			gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] },
			ground: {
				rotation: [0, 90, 0],
				translation: [0, 1, 0],
				scale: [0.5, 0.5, 0.5],
			},
		},
	},
});
applyOk(
	"set_display merges: given parts replace, the others and unknown members stay",
	{
		source: {
			...BASE,
			display: {
				gui: {
					rotation: [30, 225, 0],
					scale: [0.625, 0.625, 0.625],
					future: true,
				},
			},
		},
		ops: [
			{
				op: "set_display",
				position: "gui",
				value: { translation: [0, 4, 0], rotation: [45, 0, 0] },
			},
		],
		expected: {
			...BASE,
			display: {
				gui: {
					rotation: [45, 0, 0],
					scale: [0.625, 0.625, 0.625],
					future: true,
					translation: [0, 4, 0],
				},
			},
		},
		preservedUnknown: ["/display/gui/future"],
	},
);
applyOk("set_display creates display after the existing root members", {
	source: omit(BASE, "display"),
	ops: [{ op: "set_display", position: "head", value: { scale: [1, 1, 1] } }],
	expected: { ...BASE, display: { head: { scale: [1, 1, 1] } } },
});
operationFails(
	"set_display on a position that is not an object",
	{ ...BASE, display: { gui: 5 } },
	[{ op: "set_display", position: "gui", value: { scale: [1, 1, 1] } }],
	{ index: 0, op: "set_display", reason: REASON.invalidExisting },
);

// remove_display
applyOk("remove_display removes one position", {
	source: {
		...BASE,
		display: {
			gui: { rotation: [30, 225, 0] },
			ground: { translation: [0, 1, 0] },
		},
	},
	ops: [{ op: "remove_display", position: "gui" }],
	expected: { ...BASE, display: { ground: { translation: [0, 1, 0] } } },
});
operationFails(
	"remove_display on a position that does not exist",
	BASE,
	[{ op: "remove_display", position: "ground" }],
	{ index: 0, op: "remove_display", reason: REASON.notFound },
);

// ───────────────────────── apply: whole-call behaviour ─────────────────────────

EDIT_CASES.push(
	{
		name: "apply: no operations only normalizes the format",
		run(check) {
			const compact = JSON.stringify(BASE);
			const result = applyModelOperations(compact, [], fixtureRules("84.0"));
			check.equal(result.text, pretty(BASE));
			check.equal(result.applied, 0);
			check.equal(result.changed, true);
			const again = applyModelOperations(result.text, [], fixtureRules("84.0"));
			check.equal(again.text, result.text);
			check.equal(again.changed, false);
		},
	},
	{
		name: "apply: unparseable source throws MODEL_INVALID_JSON before any operation",
		run(check) {
			const ops = [{ op: "set_parent", parent: null }] as const;
			const duplicate = assertError(
				check,
				() => applyModelOperations('{"a":1,"a":2}', ops, fixtureRules("84.0")),
				["MODEL_INVALID_JSON"],
			);
			check.equal(detailsOf(duplicate).reason, "duplicate-key");
			const array = assertError(
				check,
				() => applyModelOperations("[]", ops, fixtureRules("84.0")),
				["MODEL_INVALID_JSON"],
			);
			check.equal(detailsOf(array).reason, "root-not-object");
		},
	},
	{
		name: "apply: errors already in the source fail the post-edit gate",
		run(check) {
			const broken = {
				...BASE,
				elements: [{ ...ELEMENT_A, from: [-20, 0, 0] }, ELEMENT_B],
			};
			const error = assertError(
				check,
				() =>
					applyModelOperations(
						pretty(broken),
						[{ op: "set_parent", parent: "minecraft:block/cube" }],
						fixtureRules("84.0"),
					),
				["MODEL_INVALID_OPERATION"],
			);
			check.deepEqual(errorFindings(error), [
				["MODEL_INVALID_STRUCTURE", "/elements/0/from"],
			]);
		},
	},
	{
		name: "atomicity: the third operation fails, so there is no result and the inputs are untouched",
		run(check) {
			const text = pretty(BASE);
			const ops = deepFreeze([
				{ op: "set_parent", parent: "minecraft:block/cube" },
				{ op: "add_element", element: NEW_ELEMENT_INPUT },
				{ op: "update_element", index: 99, changes: { name: "nope" } },
				{ op: "set_parent", parent: null },
			] as ModelOperation[]);
			let result: unknown;
			const error = assertError(check, () => {
				result = applyModelOperations(text, ops, fixtureRules("84.0"));
			}, ["MODEL_INVALID_OPERATION"]);
			check.equal(result, undefined);
			const details = detailsOf(error);
			check.equal(details.index, 2);
			check.equal(details.op, "update_element");
			check.equal(details.reason, REASON.elementNotFound);
			check.equal(text, pretty(BASE));
			// The same call with the failing operation removed succeeds, so nothing was held back.
			const ok = applyModelOperations(
				text,
				[ops[0] as ModelOperation, ops[1] as ModelOperation],
				fixtureRules("84.0"),
			);
			check.equal(ok.applied, 2);
		},
	},
	{
		name: "atomicity: a post-edit failure after valid operations also yields no result",
		run(check) {
			const text = pretty(NO_PARENT);
			let result: unknown;
			assertError(check, () => {
				result = applyModelOperations(
					text,
					[
						{ op: "set_texture", name: "extra", value: "demo:block/e" },
						{ op: "remove_texture", name: "all" },
					],
					fixtureRules("84.0"),
				);
			}, ["MODEL_INVALID_OPERATION"]);
			check.equal(result, undefined);
		},
	},
	{
		name: "stability: the same operation list on the same source gives the same bytes",
		run(check) {
			const ops: ModelOperation[] = [
				{ op: "set_texture", name: "zeta", value: "demo:block/z" },
				{ op: "set_texture", name: "Alpha", value: "demo:block/al" },
				{ op: "add_element", element: NEW_ELEMENT_INPUT },
			];
			const first = applyModelOperations(
				pretty(BASE),
				ops,
				fixtureRules("84.0"),
			);
			const second = applyModelOperations(
				pretty(BASE),
				ops,
				fixtureRules("84.0"),
			);
			check.equal(first.text, second.text);
			check.equal(
				first.text,
				pretty({
					...BASE,
					textures: {
						all: "demo:block/a",
						particle: "#all",
						zeta: "demo:block/z",
						Alpha: "demo:block/al",
					},
					elements: [ELEMENT_A, ELEMENT_B, NEW_ELEMENT_JSON],
				}),
				"apply appends new variables in operation order; only create sorts",
			);
		},
	},
);

// ───────────────────────── preservation ─────────────────────────

export const PRESERVE_SOURCE = [
	"{",
	'  "x_custom": {',
	'    "keep": [',
	"      1.0,",
	"      1e-3,",
	"      0.10",
	"    ],",
	'    "empty": {}',
	"  },",
	'  "texture_size": [',
	"    16,",
	"    16",
	"  ],",
	'  "parent": "minecraft:block/block",',
	'  "textures": {',
	'    "all": "demo:block/a"',
	"  },",
	'  "elements": [',
	"    {",
	'      "name": "top",',
	'      "future_flag": true,',
	'      "from": [',
	"        0,",
	"        8,",
	"        0",
	"      ],",
	'      "to": [',
	"        16,",
	"        16,",
	"        16",
	"      ],",
	'      "rotation": {',
	'        "origin": [',
	"          8,",
	"          8,",
	"          8",
	"        ],",
	'        "axis": "y",',
	'        "angle": 22.5,',
	'        "future": 1.0',
	"      },",
	'      "faces": {',
	'        "up": {',
	'          "texture": "#all",',
	'          "uv": [',
	"            0,",
	"            0,",
	"            16.0,",
	"            16",
	"          ]",
	"        }",
	"      }",
	"    },",
	"    {",
	'      "name": "bottom",',
	'      "from": [',
	"        0,",
	"        0,",
	"        0",
	"      ],",
	'      "to": [',
	"        16,",
	"        8,",
	"        16",
	"      ],",
	'      "faces": {',
	'        "down": {',
	'          "texture": "#all",',
	'          "cullface": "down"',
	"        }",
	"      }",
	"    }",
	"  ],",
	'  "display": {',
	'    "gui": {',
	'      "rotation": [',
	"        30,",
	"        225,",
	"        0",
	"      ]",
	"    }",
	"  }",
	"}",
	"",
].join("\n");
export const PRESERVED_POINTERS = [
	"/elements/0/future_flag",
	"/elements/0/rotation/future",
	"/x_custom",
];

EDIT_CASES.push(
	{
		name: "preserve: a source in canonical form survives zero operations byte for byte",
		run(check) {
			const result = applyModelOperations(
				PRESERVE_SOURCE,
				[],
				fixtureRules("84.0"),
			);
			check.equal(result.text, PRESERVE_SOURCE);
			check.equal(result.changed, false);
			check.deepEqual(result.preservedUnknown, PRESERVED_POINTERS);
		},
	},
	{
		name: "preserve: changing one corner of one element changes only those lines",
		run(check) {
			const result = applyModelOperations(
				PRESERVE_SOURCE,
				[{ op: "update_element", index: 1, changes: { to: [16, 7.5, 16] } }],
				fixtureRules("84.0"),
			);
			const expected = replaceOnce(
				PRESERVE_SOURCE,
				'"to": [\n        16,\n        8,\n        16\n      ],\n      "faces": {\n        "down"',
				'"to": [\n        16,\n        7.5,\n        16\n      ],\n      "faces": {\n        "down"',
			);
			check.equal(result.text, expected);
			check.deepEqual(result.preservedUnknown, PRESERVED_POINTERS);
		},
	},
	{
		name: "preserve: a new rotation keeps the old unknown member with its original number text",
		run(check) {
			const result = applyModelOperations(
				PRESERVE_SOURCE,
				[
					{
						op: "update_element",
						index: 0,
						changes: { rotation: { origin: [8, 8, 8], axis: "x", angle: 45 } },
					},
				],
				fixtureRules("84.0"),
			);
			const expected = replaceOnce(
				replaceOnce(PRESERVE_SOURCE, '"axis": "y"', '"axis": "x"'),
				'"angle": 22.5',
				'"angle": 45',
			);
			check.equal(result.text, expected);
			check.ok(result.text.includes('"future": 1.0'));
		},
	},
	{
		name: "preserve: appending a variable leaves every other line, including 1.0 and 16.0, as written",
		run(check) {
			const result = applyModelOperations(
				PRESERVE_SOURCE,
				[{ op: "set_texture", name: "side", value: "demo:block/s" }],
				fixtureRules("84.0"),
			);
			const expected = replaceOnce(
				PRESERVE_SOURCE,
				'"all": "demo:block/a"\n',
				'"all": "demo:block/a",\n    "side": "demo:block/s"\n',
			);
			check.equal(result.text, expected);
			for (const raw of ["1.0", "1e-3", "0.10", "16.0", "22.5"])
				check.ok(result.text.includes(raw), raw);
		},
	},
	{
		name: "preserve: untouched number text and member order survive from a non-canonical source",
		run(check) {
			const messy =
				'{"elements":[{"faces":{"up":{"uv":[0,0,16.0,1e1],"texture":"#a"}},"to":[16,2.50,16],"from":[0,0,0]}],"parent":"x:y","textures":{"a":"x:a"}}';
			const result = applyModelOperations(
				messy,
				[{ op: "set_parent", parent: "x:z" }],
				fixtureRules("84.0"),
			);
			const root = parseResult(check, result.text);
			check.deepEqual(
				(root.type === "object" ? root.members : []).map((m) => m.key),
				["elements", "parent", "textures"],
			);
			const raws = (pointer: string) => {
				const node = nodeAt(root, pointer);
				return node?.type === "array"
					? node.items.map((item) => (item.type === "number" ? item.raw : ""))
					: [];
			};
			check.deepEqual(raws("/elements/0/faces/up/uv"), [
				"0",
				"0",
				"16.0",
				"1e1",
			]);
			check.deepEqual(raws("/elements/0/to"), ["16", "2.50", "16"]);
			check.deepEqual(
				nodeAt(root, "/elements/0/faces")?.type === "object" ? "ok" : "bad",
				"ok",
			);
		},
	},
	{
		name: "preserve: name and texture_size are carried but are not reported as unknown",
		run(check) {
			const result = applyModelOperations(
				PRESERVE_SOURCE,
				[{ op: "set_parent", parent: "minecraft:block/cube" }],
				fixtureRules("84.0"),
			);
			check.ok(result.text.includes('"texture_size": [\n    16,\n    16\n  ]'));
			check.ok(result.text.includes('"name": "top"'));
			check.equal(
				result.preservedUnknown.some(
					(p) => p === "/texture_size" || p.endsWith("/name"),
				),
				false,
			);
		},
	},
);

// ───────────────────────── numbers ─────────────────────────

EDIT_CASES.push(
	{
		name: "numbers: new values are written with String(n) and -0 becomes 0 (create)",
		run(check) {
			const result = createModelDocument(
				{
					display: {
						gui: {
							rotation: [0.1, -0, 22.5],
							translation: [1e21, -0, 0],
						},
					},
				},
				fixtureRules("84.0"),
			);
			check.equal(
				result.text,
				[
					"{",
					'  "display": {',
					'    "gui": {',
					'      "rotation": [',
					"        0.1,",
					"        0,",
					"        22.5",
					"      ],",
					'      "translation": [',
					"        1e+21,",
					"        0,",
					"        0",
					"      ]",
					"    }",
					"  }",
					"}",
					"",
				].join("\n"),
			);
			check.deepEqual(
				result.warnings.map((w) => [w.code, w.pointer]),
				[["MODEL_SUSPICIOUS_VALUE", "/display/gui/translation"]],
			);
		},
	},
	{
		name: "numbers: new values written by apply follow the same rules",
		run(check) {
			const result = applyModelOperations(
				pretty(BASE),
				[
					{
						op: "update_element",
						index: 0,
						changes: { from: [-0, 0.1, 22.5] },
					},
					{
						op: "set_display",
						position: "head",
						value: { translation: [1e21, -0, 2.5e-7] },
					},
				],
				fixtureRules("84.0"),
			);
			const root = parseResult(check, result.text);
			const raws = (pointer: string) => {
				const node = nodeAt(root, pointer);
				return node?.type === "array"
					? node.items.map((item) => (item.type === "number" ? item.raw : ""))
					: [];
			};
			check.deepEqual(raws("/elements/0/from"), ["0", "0.1", "22.5"]);
			check.deepEqual(raws("/display/head/translation"), [
				"1e+21",
				"0",
				"2.5e-7",
			]);
		},
	},
	{
		name: "numbers: NaN and Infinity from apply are rejected, not written",
		run(check) {
			for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY]) {
				assertError(
					check,
					() =>
						applyModelOperations(
							pretty(BASE),
							[
								{
									op: "update_element",
									index: 0,
									changes: { from: [bad, 0, 0] },
								},
							],
							fixtureRules("84.0"),
						),
					["MODEL_INVALID_OPERATION"],
				);
			}
		},
	},
);

// ───────────────────────── limits ─────────────────────────

const tinyElement = { from: [0, 0, 0], to: [1, 1, 1] };
function elementsDocument(count: number): string {
	return JSON.stringify({
		parent: "minecraft:block/block",
		elements: Array.from({ length: count }, () => tinyElement),
	});
}

EDIT_CASES.push(
	{
		name: "limits: 1000 operations are accepted and 1001 are RESOURCE_LIMIT_EXCEEDED",
		run(check) {
			const text = pretty(BASE);
			const ops = (count: number): ModelOperation[] =>
				Array.from({ length: count }, () => ({
					op: "set_property" as const,
					ambientocclusion: true,
				}));
			const ok = applyModelOperations(text, ops(1000), fixtureRules("84.0"));
			check.equal(ok.applied, 1000);
			assertError(
				check,
				() => applyModelOperations(text, ops(1001), fixtureRules("84.0")),
				["RESOURCE_LIMIT_EXCEEDED"],
			);
		},
	},
	{
		name: "limits: add_element accepts the 4096th element and rejects the 4097th",
		run(check) {
			const add: ModelOperation[] = [
				{
					op: "add_element",
					element: { from: [0, 0, 0], to: [1, 1, 1], faces: {} },
				},
			];
			const ok = applyModelOperations(
				elementsDocument(4095),
				add,
				fixtureRules("84.0"),
			);
			const root = parseResult(check, ok.text);
			const elements = nodeAt(root, "/elements");
			check.equal(
				elements?.type === "array" ? elements.items.length : -1,
				4096,
			);
			assertError(
				check,
				() =>
					applyModelOperations(
						elementsDocument(4096),
						add,
						fixtureRules("84.0"),
					),
				["RESOURCE_LIMIT_EXCEEDED"],
			);
		},
	},
	{
		name: "limits: a source with 4097 elements is RESOURCE_LIMIT_EXCEEDED even for an unrelated operation",
		run(check) {
			assertError(
				check,
				() =>
					applyModelOperations(
						elementsDocument(4097),
						[{ op: "set_parent", parent: null }],
						fixtureRules("84.0"),
					),
				["RESOURCE_LIMIT_EXCEEDED"],
			);
		},
	},
	{
		name: "limits: create accepts 4096 elements and rejects 4097",
		run(check) {
			const spec = (count: number): ModelSpec => ({
				parent: "minecraft:block/block",
				elements: Array.from({ length: count }, () => ({
					from: [0, 0, 0] as const,
					to: [1, 1, 1] as const,
					faces: {},
				})),
			});
			const ok = createModelDocument(spec(4096), fixtureRules("84.0"));
			const elements = nodeAt(parseResult(check, ok.text), "/elements");
			check.equal(
				elements?.type === "array" ? elements.items.length : -1,
				4096,
			);
			assertError(
				check,
				() => createModelDocument(spec(4097), fixtureRules("84.0")),
				["RESOURCE_LIMIT_EXCEEDED"],
			);
		},
	},
	{
		name: "limits: set_texture accepts the 256th variable and rejects the 257th",
		run(check) {
			const textures = (count: number) =>
				Object.fromEntries(
					Array.from({ length: count }, (_, i) => [`t${i}`, "demo:block/a"]),
				);
			const source = (count: number) =>
				pretty({ parent: "minecraft:block/block", textures: textures(count) });
			const add: ModelOperation[] = [
				{ op: "set_texture", name: "extra", value: "demo:block/a" },
			];
			const ok = applyModelOperations(source(255), add, fixtureRules("84.0"));
			const node = nodeAt(parseResult(check, ok.text), "/textures");
			check.equal(node?.type === "object" ? node.members.length : -1, 256);
			assertError(
				check,
				() => applyModelOperations(source(256), add, fixtureRules("84.0")),
				["RESOURCE_LIMIT_EXCEEDED"],
			);
		},
	},
);

// ───────────────────────── version rejection ─────────────────────────

const PARENT = "minecraft:block/block";

export interface Rejection {
	readonly name: string;
	/** Target pack format; undefined means "not specified". */
	readonly version: string | undefined;
	readonly feature: string;
	readonly since: string;
	readonly pointer: string;
	/** A pack format at which the same content must be accepted. */
	readonly okVersion: string;
	readonly spec: ModelSpec;
	readonly doc: Record<string, unknown>;
	readonly applySource: Record<string, unknown>;
	readonly ops: readonly ModelOperation[];
}

function elementRejection(
	name: string,
	version: string | undefined,
	feature: string,
	since: string,
	pointerTail: string,
	okVersion: string,
	specElement: ElementSpec,
	docElement: Record<string, unknown>,
): Rejection {
	return {
		name,
		version,
		feature,
		since,
		pointer: `/elements/0/${pointerTail}`,
		okVersion,
		spec: { parent: PARENT, elements: [specElement] },
		doc: { parent: PARENT, elements: [docElement] },
		applySource: { parent: PARENT },
		ops: [{ op: "add_element", element: specElement }],
	};
}

const faceUp = { up: { texture: "#all" } };
const box = { from: [0, 0, 0], to: [4, 4, 4] };
const boxSpec = { from: [0, 0, 0], to: [4, 4, 4] } as const;
const xyzSpec: ElementSpec = {
	...boxSpec,
	rotation: { origin: [2, 2, 2], y: 45 },
	faces: faceUp,
};
const xyzDoc = {
	...box,
	rotation: { origin: [2, 2, 2], y: 45 },
	faces: faceUp,
};
const angle23Spec: ElementSpec = {
	...boxSpec,
	rotation: { origin: [2, 2, 2], axis: "y", angle: 23 },
	faces: faceUp,
};
const angle23Doc = {
	...box,
	rotation: { origin: [2, 2, 2], axis: "y", angle: 23 },
	faces: faceUp,
};
const angleSpec = (angle: number): ElementSpec => ({
	...boxSpec,
	rotation: { origin: [2, 2, 2], axis: "y", angle },
	faces: faceUp,
});
const angleDoc = (angle: number) => ({
	...box,
	rotation: { origin: [2, 2, 2], axis: "y", angle },
	faces: faceUp,
});
const lightSpec: ElementSpec = { ...boxSpec, lightEmission: 9, faces: faceUp };
const lightDoc = { ...box, light_emission: 9, faces: faceUp };

export const REJECTIONS: readonly Rejection[] = [
	elementRejection(
		"angle 46 on 63.0 (beyond 45 needs the x/y/z generation)",
		"63.0",
		"rotationXyz",
		"75.0",
		"rotation/angle",
		"75.0",
		angleSpec(46),
		angleDoc(46),
	),
	elementRejection(
		"angle -46 on 69.0 (beyond 45 needs the x/y/z generation)",
		"69.0",
		"rotationXyz",
		"75.0",
		"rotation/angle",
		"75.0",
		angleSpec(-46),
		angleDoc(-46),
	),
	elementRejection(
		"x/y/z rotation on 46.0",
		"46.0",
		"rotationXyz",
		"75.0",
		"rotation/y",
		"75.0",
		xyzSpec,
		xyzDoc,
	),
	elementRejection(
		"angle 23 on 46.0",
		"46.0",
		"rotationAnyAngle",
		"63.0",
		"rotation/angle",
		"63.0",
		angle23Spec,
		angle23Doc,
	),
	elementRejection(
		"angle 23 on 55.0",
		"55.0",
		"rotationAnyAngle",
		"63.0",
		"rotation/angle",
		"63.0",
		angle23Spec,
		angle23Doc,
	),
	elementRejection(
		"shade_direction_override on 88.0",
		"88.0",
		"shadeDirectionOverride",
		"97.1",
		"shade_direction_override",
		"97.1",
		{ ...boxSpec, shadeDirectionOverride: "south", faces: faceUp },
		{ ...box, shade_direction_override: "south", faces: faceUp },
	),
	elementRejection(
		"shade on 97.1",
		"97.1",
		"shadeDirectionOverride",
		"97.1",
		"shade",
		"84.0",
		{ ...boxSpec, shade: false, faces: faceUp },
		{ ...box, shade: false, faces: faceUp },
	),
	elementRejection(
		"light_emission on 15.0",
		"15.0",
		"lightEmission",
		"42.0",
		"light_emission",
		"42.0",
		lightSpec,
		lightDoc,
	),
	elementRejection(
		"light_emission with no version",
		undefined,
		"lightEmission",
		"42.0",
		"light_emission",
		"84.0",
		lightSpec,
		lightDoc,
	),
	elementRejection(
		"x/y/z rotation with no version",
		undefined,
		"rotationXyz",
		"75.0",
		"rotation/y",
		"84.0",
		xyzSpec,
		xyzDoc,
	),
	elementRejection(
		"angle 23 with no version",
		undefined,
		"rotationAnyAngle",
		"63.0",
		"rotation/angle",
		"84.0",
		angle23Spec,
		angle23Doc,
	),
	elementRejection(
		"x/y/z rotation on the unlisted 60.0",
		"60.0",
		"rotationXyz",
		"75.0",
		"rotation/y",
		"75.0",
		xyzSpec,
		xyzDoc,
	),
	{
		name: "object-form texture on 75.0",
		version: "75.0",
		feature: "texturesObjectForm",
		since: "84.0",
		pointer: "/textures/layer0",
		okVersion: "84.0",
		spec: {
			parent: PARENT,
			textures: { layer0: { sprite: "demo:item/gem", forceTranslucent: true } },
		},
		doc: {
			parent: PARENT,
			textures: {
				layer0: { sprite: "demo:item/gem", force_translucent: true },
			},
		},
		applySource: { parent: PARENT },
		ops: [
			{
				op: "set_texture",
				name: "layer0",
				value: { sprite: "demo:item/gem", forceTranslucent: true },
			},
		],
	},
	{
		name: "display on_shelf on 63.0",
		version: "63.0",
		feature: "displayOnShelf",
		since: "69.0",
		pointer: "/display/on_shelf",
		okVersion: "69.0",
		spec: { parent: PARENT, display: { on_shelf: { rotation: [0, 0, 0] } } },
		doc: { parent: PARENT, display: { on_shelf: { rotation: [0, 0, 0] } } },
		applySource: { parent: PARENT },
		ops: [
			{
				op: "set_display",
				position: "on_shelf",
				value: { rotation: [0, 0, 0] },
			},
		],
	},
	{
		name: "display on_shelf beyond the verified range (98.0)",
		version: "98.0",
		feature: "displayOnShelf",
		since: "69.0",
		pointer: "/display/on_shelf",
		okVersion: "84.0",
		spec: { parent: PARENT, display: { on_shelf: { rotation: [0, 0, 0] } } },
		doc: { parent: PARENT, display: { on_shelf: { rotation: [0, 0, 0] } } },
		applySource: { parent: PARENT },
		ops: [
			{
				op: "set_display",
				position: "on_shelf",
				value: { rotation: [0, 0, 0] },
			},
		],
	},
];

EDIT_CASES.push(
	...REJECTIONS.flatMap((rejection): ModelCase[] => {
		const expected = {
			feature: rejection.feature,
			since: rejection.since,
			pointer: rejection.pointer,
			version: rejection.version,
		};
		return [
			{
				name: `version rejection (create): ${rejection.name}`,
				run(check) {
					let result: unknown;
					const error = assertError(check, () => {
						result = createModelDocument(
							deepFreeze(structuredClone(rejection.spec)),
							fixtureRules(rejection.version),
						);
					}, ["MODEL_UNSUPPORTED_VERSION"]);
					check.equal(result, undefined);
					assertUnsupported(check, error, expected);
					const ok = createModelDocument(
						rejection.spec,
						fixtureRules(rejection.okVersion),
					);
					check.ok(
						nodeAt(parseResult(check, ok.text), rejection.pointer) !==
							undefined,
						"content is written where the pointer says when the version allows it",
					);
				},
			},
			{
				name: `version rejection (apply): ${rejection.name}`,
				run(check) {
					const text = pretty(rejection.applySource);
					let result: unknown;
					const error = assertError(check, () => {
						result = applyModelOperations(
							text,
							deepFreeze(structuredClone(rejection.ops)),
							fixtureRules(rejection.version),
						);
					}, ["MODEL_UNSUPPORTED_VERSION"]);
					check.equal(result, undefined);
					assertUnsupported(check, error, expected);
					check.equal(text, pretty(rejection.applySource));
					const ok = applyModelOperations(
						text,
						rejection.ops,
						fixtureRules(rejection.okVersion),
					);
					check.ok(
						nodeAt(parseResult(check, ok.text), rejection.pointer) !==
							undefined,
					);
				},
			},
		];
	}),
	{
		name: "version rejection: the first use in document order is reported",
		run(check) {
			const error = assertError(
				check,
				() =>
					createModelDocument(
						{
							parent: PARENT,
							elements: [
								{ ...boxSpec, lightEmission: 3, faces: faceUp },
								{
									...boxSpec,
									shadeDirectionOverride: "up",
									rotation: { origin: [2, 2, 2], y: 10 },
									faces: faceUp,
								},
							],
						},
						fixtureRules("46.0"),
					),
				["MODEL_UNSUPPORTED_VERSION"],
			);
			// light_emission is available from 42.0, so the first unavailable use is in the second element.
			check.equal(detailsOf(error).pointer, "/elements/1/rotation/y");
		},
	},
	{
		name: "no version: documents without threshold features are accepted at any version",
		async run(check) {
			const spec: ModelSpec = {
				parent: PARENT,
				ambientocclusion: false,
				textures: { all: "demo:block/a" },
				elements: [
					{
						...boxSpec,
						rotation: { origin: [2, 2, 2], axis: "y", angle: 22.5 },
						faces: { up: { texture: "#all", uv: [0, 0, 4, 4] } },
					},
				],
				display: { gui: { scale: [1, 1, 1] } },
			};
			for (const version of [undefined, "15.0", "98.0"]) {
				const result = createModelDocument(spec, fixtureRules(version));
				check.deepEqual(result.warnings, []);
				await assertInspectsClean(check, result.text, version, []);
			}
		},
	},
	{
		name: "version: angles 22.5, 45 and -45 are valid on every version that can be named",
		run(check) {
			for (const angle of [-45, -22.5, 0, 22.5, 45]) {
				for (const version of ["46.0", "63.0", "75.0", undefined]) {
					const result = createModelDocument(
						{
							parent: PARENT,
							elements: [
								{
									...boxSpec,
									rotation: { origin: [2, 2, 2], axis: "x", angle },
									faces: faceUp,
								},
							],
						},
						fixtureRules(version),
					);
					const written = nodeAt(
						parseResult(check, result.text),
						"/elements/0/rotation/angle",
					);
					check.equal(
						written?.type === "number" ? written.raw : undefined,
						String(angle),
					);
				}
			}
		},
	},
);

// ───────────────────────── apply: version check covers only what the operations write ─────────────────────────

/** An existing new-style model: element 0 uses x/y/z rotation and is not touched by most cases. */
export const XYZ_SOURCE = {
	parent: "minecraft:block/block",
	elements: [
		{
			from: [0, 0, 0],
			to: [4, 4, 4],
			rotation: { origin: [2, 2, 2], y: 45 },
			faces: { up: { texture: "#all" } },
		},
		{
			from: [4, 4, 4],
			to: [8, 8, 8],
			faces: { up: { texture: "#all", uv: [0, 0, 4, 4] } },
		},
	],
};
const xyzSourceEdited = {
	...XYZ_SOURCE,
	elements: [
		XYZ_SOURCE.elements[0],
		{
			from: [4, 4, 4],
			to: [8, 8, 8],
			faces: { up: { texture: "#all", uv: [0, 0, 8, 8] } },
		},
	],
};
const editUv: ModelOperation = {
	op: "update_face",
	element: 1,
	face: "up",
	changes: { uv: [0, 0, 8, 8] },
};

for (const version of [undefined, "46.0"]) {
	applyOk(
		`untouched x/y/z rotation is kept when the version is ${version ?? "not specified"}`,
		{
			source: XYZ_SOURCE,
			ops: [editUv],
			expected: xyzSourceEdited,
			version,
		},
	);
}
applyOk(
	"an operation on the same element as an untouched x/y/z rotation is accepted",
	{
		source: XYZ_SOURCE,
		ops: [{ op: "update_element", index: 0, changes: { name: "pivot" } }],
		expected: {
			...XYZ_SOURCE,
			elements: [
				{ ...XYZ_SOURCE.elements[0], name: "pivot" },
				XYZ_SOURCE.elements[1],
			],
		},
		version: "46.0",
	},
);

EDIT_CASES.push(
	{
		name: "apply version scope: a new feature is still rejected next to untouched old content",
		run(check) {
			const text = pretty(XYZ_SOURCE);
			const error = assertError(
				check,
				() =>
					applyModelOperations(
						text,
						[
							{
								op: "add_element",
								element: {
									from: [0, 0, 0],
									to: [1, 1, 1],
									shadeDirectionOverride: "up",
									faces: { up: { texture: "#all" } },
								},
							},
						],
						fixtureRules("46.0"),
					),
				["MODEL_UNSUPPORTED_VERSION"],
			);
			assertUnsupported(check, error, {
				feature: "shadeDirectionOverride",
				since: "97.1",
				pointer: "/elements/2/shade_direction_override",
				version: "46.0",
			});
		},
	},
	{
		name: "apply version scope: replacing the rotation re-checks it",
		run(check) {
			const error = assertError(
				check,
				() =>
					applyModelOperations(
						pretty(XYZ_SOURCE),
						[
							{
								op: "update_element",
								index: 0,
								changes: { rotation: { origin: [2, 2, 2], y: 10 } },
							},
						],
						fixtureRules("46.0"),
					),
				["MODEL_UNSUPPORTED_VERSION"],
			);
			assertUnsupported(check, error, {
				feature: "rotationXyz",
				since: "75.0",
				pointer: "/elements/0/rotation/y",
				version: "46.0",
			});
		},
	},
	{
		name: "apply version scope: setting a value to the same number is still a write and is checked",
		run(check) {
			const source = {
				parent: "minecraft:block/block",
				elements: [
					{
						from: [0, 0, 0],
						to: [4, 4, 4],
						light_emission: 9,
						faces: { up: { texture: "#all" } },
					},
				],
			};
			assertError(
				check,
				() =>
					applyModelOperations(
						pretty(source),
						[{ op: "update_element", index: 0, changes: { lightEmission: 9 } }],
						fixtureRules("15.0"),
					),
				["MODEL_UNSUPPORTED_VERSION"],
			);
			const untouched = applyModelOperations(
				pretty(source),
				[{ op: "update_element", index: 0, changes: { name: "lamp" } }],
				fixtureRules("15.0"),
			);
			check.equal(
				untouched.text,
				pretty({
					...source,
					elements: [{ ...source.elements[0], name: "lamp" }],
				}),
			);
		},
	},
);

for (const [angle, version] of [
	[23, "46.0"],
	[46, "63.0"],
] as const) {
	const source = {
		parent: "minecraft:block/block",
		elements: [angleDoc(angle)],
	};
	applyOk(`untouched angle ${angle} is kept for target ${version}`, {
		source,
		ops: [{ op: "update_element", index: 0, changes: { name: "pivot" } }],
		expected: {
			...source,
			elements: [{ ...angleDoc(angle), name: "pivot" }],
		},
		version,
	});
}

gateFails(
	"untouched invalid angle type remains a structure error",
	{
		parent: "minecraft:block/block",
		elements: [
			{
				...box,
				rotation: { origin: [2, 2, 2], axis: "y", angle: "bad" },
				faces: faceUp,
			},
		],
	},
	[{ op: "update_element", index: 0, changes: { name: "pivot" } }],
	[["MODEL_INVALID_ROTATION", "/elements/0/rotation/angle"]],
	"46.0",
);

// ───────────────────────── unknown operation, applied counts ─────────────────────────

operationFails(
	"an operation name the core does not know",
	BASE,
	[{ op: "set_parent", parent: "minecraft:block/cube" }, { op: "explode" }],
	{ index: 1, op: "explode", reason: REASON.unknownOp },
);

EDIT_CASES.push({
	name: "create: applied is 0 and changed is true",
	run(check) {
		const result = createModelDocument(
			{ parent: "minecraft:block/cube_all" },
			fixtureRules("84.0"),
		);
		check.equal(result.applied, 0);
		check.equal(result.changed, true);
		check.equal(result.text, pretty({ parent: "minecraft:block/cube_all" }));
	},
});

// ───────────────────────── version gate: unknown subtrees keep their names ─────────────────────────

const UNKNOWN_GATE_ELEMENT = {
	from: [0, 0, 0],
	to: [4, 4, 4],
	faces: { up: { texture: "demo:block/a" } },
};
const UNKNOWN_GATE_BASE = {
	parent: "minecraft:block/block",
	elements: [UNKNOWN_GATE_ELEMENT],
};

function unknownGateSource(): Record<string, unknown> {
	return structuredClone({
		...UNKNOWN_GATE_BASE,
		custom: {
			rotation: { x: 1, y: 2, z: 3, angle: 23 },
			shade: true,
			light_emission: 9,
			transformation: { translation: [0, 0, 0] },
			display: { on_shelf: { rotation: [0, 0, 0] } },
			textures: { layer0: { sprite: "demo:item/gem" } },
		},
	}) as unknown as Record<string, unknown>;
}

EDIT_CASES.push(
	{
		name: "version gate: unknown root fields with feature-like keys are kept for 46.0",
		run(check) {
			const source = unknownGateSource();
			const text = pretty(source);
			const exported = exportModelDocument(text, fixtureRules("46.0"));
			check.equal(exported.text, text);
			check.equal(exported.changed, false);
			const kept = nodeAt(parseResult(check, exported.text), "/custom");
			check.deepEqual(kept, nodeAt(parseJsonDocument(text), "/custom"));
			check.deepEqual(exported.preservedUnknown, ["/custom"]);
		},
	},
	{
		name: "version gate: unknown element fields with rotation-like keys are kept for 46.0",
		run(check) {
			const source = structuredClone(UNKNOWN_GATE_BASE) as unknown as Record<
				string,
				unknown
			>;
			(source.elements as Record<string, unknown>[])[0] = {
				...UNKNOWN_GATE_ELEMENT,
				future: { rotation: { x: 1 }, shade: false, x: 1, y: 2, angle: 23 },
			};
			const text = pretty(source);
			const exported = exportModelDocument(text, fixtureRules("46.0"));
			check.equal(exported.text, text);
			check.equal(exported.changed, false);
			check.deepEqual(exported.preservedUnknown, ["/elements/0/future"]);
		},
	},
);

// ───────────────────────── output limits: strings ─────────────────────────

EDIT_CASES.push(
	{
		name: "limits: a 4096-byte name is accepted and a 4097-byte name is RESOURCE_LIMIT_EXCEEDED",
		run(check) {
			const element = (name: string): ElementSpec => ({
				from: [0, 0, 0],
				to: [1, 1, 1],
				name,
				faces: {},
			});
			const ok = createModelDocument(
				{ parent: PARENT, elements: [element("a".repeat(4096))] },
				fixtureRules("84.0"),
			);
			const name = nodeAt(parseResult(check, ok.text), "/elements/0/name");
			check.deepEqual(name, { type: "string", value: "a".repeat(4096) });
			let result: unknown;
			const error = assertError(check, () => {
				result = createModelDocument(
					{ parent: PARENT, elements: [element("a".repeat(4097))] },
					fixtureRules("84.0"),
				);
			}, ["RESOURCE_LIMIT_EXCEEDED"]);
			check.equal(result, undefined);
			check.deepEqual(detailsOf(error), { limit: 4096, actual: 4097 });
		},
	},
	{
		name: "limits: non-ASCII strings are measured in UTF-8 bytes",
		run(check) {
			const ok = createModelDocument(
				{
					parent: PARENT,
					elements: [
						{
							from: [0, 0, 0],
							to: [1, 1, 1],
							name: "é".repeat(2048),
							faces: {},
						},
					],
				},
				fixtureRules("84.0"),
			);
			const name = nodeAt(parseResult(check, ok.text), "/elements/0/name");
			check.deepEqual(name, { type: "string", value: "é".repeat(2048) });
			assertError(
				check,
				() =>
					createModelDocument(
						{
							parent: PARENT,
							elements: [
								{
									from: [0, 0, 0],
									to: [1, 1, 1],
									name: `a${"é".repeat(2048)}`,
									faces: {},
								},
							],
						},
						fixtureRules("84.0"),
					),
				["RESOURCE_LIMIT_EXCEEDED"],
			);
		},
	},
);
