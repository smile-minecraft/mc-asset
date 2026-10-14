import {
	type ModelFinding,
	type ModelStructureResult,
	validateModelStructure,
} from "../../src/model/structure.ts";
import { DISPLAY_POSITIONS } from "../../src/model/types.ts";
import {
	assertError,
	type CaseCheck,
	jsonNode,
	type ModelCase,
} from "./json-document-cases.ts";
import { fixtureRules, VERSION_ROWS } from "./versions-cases.ts";

const rel = "assets/demo/models/item/test.json";
const face = { texture: "demo:stone" };
const element = { from: [0, 0, 0], to: [16, 16, 16], faces: { north: face } };

// Finding pointer 使用欄位層級；整體幾何問題使用零件層級。
type ExpectedFinding = readonly [
	ModelFinding["code"],
	ModelFinding["level"],
	string,
];

function findings(result: ModelStructureResult): ExpectedFinding[] {
	return result.findings.map(({ code, level, pointer }) => [
		code,
		level,
		pointer,
	]);
}

export const STRUCTURE_CASES: ModelCase[] = [];

function ruleCase(
	category: string,
	name: string,
	input: unknown,
	expected: readonly ExpectedFinding[],
	version: string | undefined = "84.0",
): void {
	STRUCTURE_CASES.push({
		name: `${category}: ${name}`,
		run(check) {
			const root = jsonNode(input);
			const before = JSON.stringify(root);
			const result = validateModelStructure(root, fixtureRules(version), rel);
			check.deepEqual(findings(result), expected);
			check.equal(
				JSON.stringify(root),
				before,
				"pure checks must not change input",
			);
		},
	});
}

function pair(
	category: string,
	name: string,
	bad: unknown,
	good: unknown,
	code: ModelFinding["code"],
	level: ModelFinding["level"],
	pointer: string,
	version: string | undefined = "84.0",
): void {
	ruleCase(category, `reject ${name}`, bad, [[code, level, pointer]], version);
	ruleCase(category, `accept ${name}`, good, [], version);
}

pair(
	"root",
	"ambientocclusion type",
	{ ambientocclusion: 1 },
	{ ambientocclusion: false },
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/ambientocclusion",
);
pair(
	"root",
	"gui_light enum",
	{ gui_light: "rear" },
	{ gui_light: "side" },
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/gui_light",
);
ruleCase("root", "gui_light front", { gui_light: "front" }, []);
pair(
	"root",
	"elements array",
	{ elements: {} },
	{ elements: [] },
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/elements",
);
pair(
	"display",
	"root display object",
	{ display: [] },
	{ display: {} },
	"MODEL_INVALID_DISPLAY",
	"error",
	"/display",
);

for (const [label, bad] of [
	["non-object", 1],
	["from missing", { to: [16, 16, 16], faces: { north: face } }],
	["to missing", { from: [0, 0, 0], faces: { north: face } }],
	["from length two", { ...element, from: [0, 0] }],
	["to length four", { ...element, to: [0, 0, 0, 0] }],
	["from string", { ...element, from: "0,0,0" }],
	["non-finite from", { ...element, from: [Infinity, 0, 0] }],
	["non-finite to", { ...element, to: [16, Infinity, 16] }],
	["from below bound", { ...element, from: [-16.01, 0, 0] }],
	["to above bound", { ...element, to: [32.01, 16, 16] }],
] as const) {
	const pointer =
		label === "non-object"
			? "/elements/0"
			: `/elements/0/${label.startsWith("to") || label.endsWith("to") ? "to" : "from"}`;
	ruleCase("elements", label, { elements: [bad] }, [
		["MODEL_INVALID_STRUCTURE", "error", pointer],
	]);
}
ruleCase(
	"elements",
	"finite coordinate endpoints -16 and 32",
	{ elements: [{ ...element, from: [-16, -16, -16], to: [32, 32, 32] }] },
	[],
);
ruleCase("elements", "ordinary cube", { elements: [element] }, []);
ruleCase(
	"elements",
	"inverted extent warns",
	{ elements: [{ ...element, from: [17, 0, 0] }] },
	[["MODEL_SUSPICIOUS_VALUE", "warning", "/elements/0"]],
);
for (let axis = 0; axis < 3; axis += 1) {
	const to = [16, 16, 16];
	to[axis] = 0;
	ruleCase(
		"elements",
		`single zero-thickness axis ${axis} is a valid plane`,
		{ elements: [{ ...element, to }] },
		[],
	);
}
ruleCase(
	"elements",
	"two zero-thickness axes warn",
	{ elements: [{ ...element, to: [0, 0, 16] }] },
	[["MODEL_SUSPICIOUS_VALUE", "warning", "/elements/0"]],
);
ruleCase(
	"elements",
	"three zero-thickness axes warn",
	{ elements: [{ ...element, to: [0, 0, 0] }] },
	[["MODEL_SUSPICIOUS_VALUE", "warning", "/elements/0"]],
);
pair(
	"elements",
	"faces object",
	{ elements: [{ ...element, faces: [] }] },
	{ elements: [element] },
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/elements/0/faces",
);
for (const [name, input] of [
	["missing", { from: [0, 0, 0], to: [16, 16, 16] }],
	["empty", { ...element, faces: {} }],
] as const) {
	ruleCase("elements", `faces ${name} warns`, { elements: [input] }, [
		["MODEL_SUSPICIOUS_VALUE", "warning", "/elements/0/faces"],
	]);
}
pair(
	"elements",
	"face direction",
	{ elements: [{ ...element, faces: { diagonal: face } }] },
	{ elements: [element] },
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/elements/0/faces/diagonal",
);
pair(
	"elements",
	"face value object",
	{ elements: [{ ...element, faces: { north: 1 } }] },
	{ elements: [element] },
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/elements/0/faces/north",
);
for (const bad of [{}, { texture: 3 }]) {
	pair(
		"elements",
		`face texture string ${JSON.stringify(bad)}`,
		{ elements: [{ ...element, faces: { north: bad } }] },
		{ elements: [element] },
		"MODEL_INVALID_STRUCTURE",
		"error",
		"/elements/0/faces/north/texture",
	);
}
function withFace(values: Record<string, unknown>): unknown {
	return {
		elements: [{ ...element, faces: { north: { ...face, ...values } } }],
	};
}
pair(
	"elements",
	"cullface direction",
	withFace({ cullface: "diagonal" }),
	withFace({ cullface: "east" }),
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/elements/0/faces/north/cullface",
);
pair(
	"elements",
	"tintindex integer",
	withFace({ tintindex: 0.5 }),
	withFace({ tintindex: -1 }),
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/elements/0/faces/north/tintindex",
);
pair(
	"UV",
	"four finite numbers",
	withFace({ uv: [0, 0, 16] }),
	withFace({ uv: [0, 0, 16, 16] }),
	"MODEL_INVALID_UV",
	"error",
	"/elements/0/faces/north/uv",
);
ruleCase("UV", "non-finite component", withFace({ uv: [0, 0, Infinity, 16] }), [
	["MODEL_INVALID_UV", "error", "/elements/0/faces/north/uv"],
]);
ruleCase("UV", "absent UV is valid", withFace({}), []);
for (const [name, uv] of [
	["below zero", [-0.01, 0, 16, 16]],
	["above sixteen", [0, 0, 16.01, 16]],
	["collapsed x", [0, 0, 0, 16]],
	["collapsed y", [0, 0, 16, 0]],
] as const) {
	ruleCase("UV", name, withFace({ uv }), [
		["MODEL_SUSPICIOUS_VALUE", "warning", "/elements/0/faces/north/uv"],
	]);
}
ruleCase("UV", "flipped UV is valid", withFace({ uv: [16, 16, 0, 0] }), []);
pair(
	"rotation",
	"face rotation enum",
	withFace({ rotation: 45 }),
	withFace({ rotation: 90 }),
	"MODEL_INVALID_ROTATION",
	"error",
	"/elements/0/faces/north/rotation",
);
for (const rotation of [0, 180, 270])
	ruleCase("rotation", `face rotation ${rotation}`, withFace({ rotation }), []);

for (const position of DISPLAY_POSITIONS) {
	ruleCase(
		"display",
		`position ${position}`,
		{
			display: {
				[position]: {
					rotation: [22.5, 0, 0],
					translation: [-80, 80, 0],
					scale: [4, 0, -1],
				},
			},
		},
		[],
	);
}
pair(
	"display",
	"known position",
	{ display: { mystery: {} } },
	{ display: { gui: {} } },
	"MODEL_SUSPICIOUS_VALUE",
	"warning",
	"/display/mystery",
);
pair(
	"display",
	"on_shelf version",
	{ display: { on_shelf: {} } },
	{ display: { gui: {} } },
	"MODEL_VERSION_FEATURE",
	"warning",
	"/display/on_shelf",
	"63.0",
);
pair(
	"display",
	"position value object",
	{ display: { gui: false } },
	{ display: { gui: {} } },
	"MODEL_INVALID_DISPLAY",
	"error",
	"/display/gui",
);
for (const field of ["rotation", "translation", "scale"]) {
	pair(
		"display",
		`${field} vec3`,
		{ display: { gui: { [field]: [0, 0] } } },
		{ display: { gui: { [field]: [0, 0, 0] } } },
		"MODEL_INVALID_DISPLAY",
		"error",
		`/display/gui/${field}`,
	);
	ruleCase(
		"display",
		`${field} finite`,
		{ display: { gui: { [field]: [0, Infinity, 0] } } },
		[["MODEL_INVALID_DISPLAY", "error", `/display/gui/${field}`]],
	);
}
pair(
	"display",
	"translation clamp warning",
	{ display: { gui: { translation: [81, 0, 0] } } },
	{ display: { gui: { translation: [80, -80, 0] } } },
	"MODEL_SUSPICIOUS_VALUE",
	"warning",
	"/display/gui/translation",
);
pair(
	"display",
	"scale clamp warning",
	{ display: { gui: { scale: [4.01, 1, 1] } } },
	{ display: { gui: { scale: [4, 1, 1] } } },
	"MODEL_SUSPICIOUS_VALUE",
	"warning",
	"/display/gui/scale",
);

ruleCase(
	"textures",
	"string variable and resource id",
	{ textures: { a: "demo:stone", b: "#a" } },
	[],
);
ruleCase(
	"textures",
	"object sprite at threshold",
	{ textures: { a: { sprite: "demo:stone", force_translucent: false } } },
	[],
);
ruleCase(
	"textures",
	"object sprite without optional flag",
	{ textures: { a: { sprite: "demo:stone" } } },
	[],
);
ruleCase(
	"textures",
	"object sprite before threshold",
	{ textures: { a: { sprite: "demo:stone" } } },
	[["MODEL_VERSION_FEATURE", "error", "/textures/a"]],
	"75.0",
);
for (const [name, entry, pointer] of [
	["sprite missing", {}, "/textures/a/sprite"],
	["sprite type", { sprite: 1 }, "/textures/a/sprite"],
	["sprite variable", { sprite: "#b" }, "/textures/a/sprite"],
	[
		"translucency type",
		{ sprite: "demo:stone", force_translucent: 1 },
		"/textures/a/force_translucent",
	],
] as const) {
	ruleCase("textures", name, { textures: { a: entry } }, [
		["MODEL_INVALID_STRUCTURE", "error", pointer],
	]);
}
for (const [label, value] of [
	["number", 1],
	["boolean", true],
	["array", []],
	["null", null],
] as const) {
	ruleCase(
		"textures",
		`non-entry ${label} at modern version`,
		{ textures: { a: value } },
		[["MODEL_INVALID_STRUCTURE", "error", "/textures/a"]],
	);
}
ruleCase(
	"textures",
	"numeric legacy value has no modern structure rule",
	{ textures: { a: 1 } },
	[],
	"75.0",
);

const withElement = (values: Record<string, unknown>) => ({
	elements: [{ ...element, ...values }],
});
pair(
	"features",
	"light_emission integer range",
	withElement({ light_emission: 16 }),
	withElement({ light_emission: 15 }),
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/elements/0/light_emission",
);
for (const value of [-1, 0.5, "1"])
	ruleCase(
		"features",
		`invalid light_emission ${value}`,
		withElement({ light_emission: value }),
		[["MODEL_INVALID_STRUCTURE", "error", "/elements/0/light_emission"]],
	);
ruleCase(
	"features",
	"light emission zero",
	withElement({ light_emission: 0 }),
	[],
);
ruleCase(
	"features",
	"light emission before secondary-source threshold warns",
	withElement({ light_emission: 1 }),
	[["MODEL_VERSION_FEATURE", "warning", "/elements/0/light_emission"]],
	"15.0",
);
ruleCase(
	"features",
	"light emission at threshold",
	withElement({ light_emission: 1 }),
	[],
	"42.0",
);
pair(
	"features",
	"shade boolean",
	withElement({ shade: 1 }),
	withElement({ shade: false }),
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/elements/0/shade",
);
ruleCase(
	"features",
	"removed shade warns",
	withElement({ shade: true }),
	[["MODEL_VERSION_FEATURE", "warning", "/elements/0/shade"]],
	"97.1",
);
ruleCase(
	"features",
	"absent removed shade is valid",
	withElement({}),
	[],
	"97.1",
);
pair(
	"features",
	"shade direction",
	withElement({ shade_direction_override: "diagonal" }),
	withElement({ shade_direction_override: "north" }),
	"MODEL_INVALID_STRUCTURE",
	"error",
	"/elements/0/shade_direction_override",
	"97.1",
);
ruleCase(
	"features",
	"shade override before threshold",
	withElement({ shade_direction_override: "north" }),
	[
		[
			"MODEL_VERSION_FEATURE",
			"warning",
			"/elements/0/shade_direction_override",
		],
	],
);
ruleCase(
	"features",
	"overrides ignored in item-definition era",
	{ overrides: [] },
	[["MODEL_VERSION_FEATURE", "warning", "/overrides"]],
	"46.0",
);
ruleCase("features", "absent overrides at threshold", {}, [], "46.0");
STRUCTURE_CASES.push({
	name: "features: legacy overrides add coverage without a finding",
	run(check) {
		const result = validateModelStructure(
			jsonNode({ overrides: [] }),
			fixtureRules("42.0"),
			rel,
		);
		check.deepEqual(result.findings, []);
		check.ok(
			result.skipped.some(
				(skip) =>
					skip.kind === "model-overrides" &&
					skip.reason === "predicates-not-interpreted",
			),
		);
	},
});

const origin = [8, 8, 8];
const validRotation = { origin, axis: "y", angle: 22.5 };
const withRotation = (rotation: unknown) => withElement({ rotation });
pair(
	"rotation",
	"object rotation",
	withRotation(1),
	withRotation(validRotation),
	"MODEL_INVALID_ROTATION",
	"error",
	"/elements/0/rotation",
);
pair(
	"rotation",
	"required origin",
	withRotation({ axis: "y", angle: 22.5 }),
	withRotation(validRotation),
	"MODEL_INVALID_ROTATION",
	"error",
	"/elements/0/rotation/origin",
);
pair(
	"rotation",
	"origin vector",
	withRotation({ ...validRotation, origin: [0, 0] }),
	withRotation(validRotation),
	"MODEL_INVALID_ROTATION",
	"error",
	"/elements/0/rotation/origin",
);
for (const [name, rotation, pointer] of [
	["axis enum", { ...validRotation, axis: "w" }, "axis"],
	["angle finite", { ...validRotation, angle: Infinity }, "angle"],
	["angle missing", { origin, axis: "x" }, "angle"],
	["axis missing", { origin, angle: 22.5 }, "axis"],
	["no rotation form", { origin }, ""],
	["xyz finite", { origin, x: Infinity }, "x"],
	["rescale boolean", { ...validRotation, rescale: 1 }, "rescale"],
] as const) {
	pair(
		"rotation",
		name,
		withRotation(rotation),
		withRotation({ ...validRotation, rescale: false }),
		"MODEL_INVALID_ROTATION",
		"error",
		`/elements/0/rotation${pointer ? `/${pointer}` : ""}`,
	);
}
for (const row of VERSION_ROWS.slice(0, 10)) {
	for (const angle of [22.5, 23, 45, 46, -46]) {
		const bad =
			row[4] === "multiples-of-22.5"
				? ![22.5, 45].includes(angle)
				: row[4] === "within-45"
					? angle > 45 || angle < -45
					: false;
		ruleCase(
			"rotation",
			`axis angle ${angle} at ${row[0]}`,
			withRotation({ origin, axis: "x", angle }),
			bad
				? [["MODEL_INVALID_ROTATION", "error", "/elements/0/rotation/angle"]]
				: [],
			row[0],
		);
	}
	const xyz = row[3][5] === true;
	ruleCase(
		"rotation",
		`xyz at ${row[0]}`,
		withRotation({ origin, x: 22.5, y: -46, z: 720 }),
		xyz ? [] : [["MODEL_VERSION_FEATURE", "error", "/elements/0/rotation"]],
		row[0],
	);
	ruleCase(
		"rotation",
		`both forms at ${row[0]}`,
		withRotation({ ...validRotation, x: 23 }),
		[
			[
				xyz ? "MODEL_SUSPICIOUS_VALUE" : "MODEL_VERSION_FEATURE",
				"warning",
				"/elements/0/rotation",
			],
		],
		row[0],
	);
}
for (const angle of [-45, -22.5, 0])
	ruleCase(
		"rotation",
		`legacy exact angle ${angle}`,
		withRotation({ origin, axis: "z", angle }),
		[],
		"46.0",
	);
for (const axis of ["x", "y", "z"])
	ruleCase(
		"rotation",
		`single xyz component ${axis}`,
		withRotation({ origin, [axis]: 360 }),
		[],
		"75.0",
	);
ruleCase("rotation", "omitted rescale", withRotation(validRotation), []);

for (const version of [undefined, "98.0", "15.0", "60.0"]) {
	STRUCTURE_CASES.push({
		name: `coverage: version rules ${version ?? "unspecified"}`,
		run(check) {
			const result = validateModelStructure(
				jsonNode({}),
				fixtureRules(version),
				rel,
			);
			check.ok(
				result.skipped.some((skip) => skip.kind === "model-version-rules"),
			);
			if (version === "15.0" || version === "60.0") {
				check.ok(
					result.skipped.some((skip) => skip.reason === "rules-inferred"),
				);
			}
		},
	});
}
ruleCase(
	"coverage",
	"undetermined versions still check independent structure",
	{
		ambientocclusion: "bad",
		elements: [{ ...element, rotation: { origin, x: 100 } }],
	},
	[["MODEL_INVALID_STRUCTURE", "error", "/ambientocclusion"]],
	undefined,
);
STRUCTURE_CASES.push({
	name: "coverage: unknown fields at every supported object depth and escaped pointers",
	run(check) {
		const result = validateModelStructure(
			jsonNode({
				"a/b~c": 1,
				texture_size: [16, 16],
				elements: [
					{
						...element,
						name: "plane",
						unknown: true,
						rotation: { ...validRotation, custom: 1 },
						faces: { north: { ...face, custom: 2 } },
					},
				],
				display: { gui: { custom: 3 } },
			}),
			fixtureRules("84.0"),
			rel,
		);
		check.deepEqual(result.findings, []);
		check.deepEqual(
			result.skipped,
			[
				"/a~1b~0c",
				"/display/gui/custom",
				"/elements/0/faces/north/custom",
				"/elements/0/rotation/custom",
				"/elements/0/unknown",
			].map((pointer) => ({
				kind: "model-unknown-field",
				target: `${rel}#${pointer}`,
				reason: "field-not-interpreted",
			})),
		);
	},
});
STRUCTURE_CASES.push({
	name: "coverage: Blockbench name and texture_size exceptions are interpreted for preservation",
	run(check) {
		const result = validateModelStructure(
			jsonNode({
				texture_size: [16, 16],
				elements: [{ ...element, name: "cube" }],
			}),
			fixtureRules("84.0"),
			rel,
		);
		check.deepEqual(result, { findings: [], skipped: [] });
	},
});
for (const [name, input, boundary] of [
	[
		"elements",
		{ elements: Array.from({ length: 4097 }, () => element) },
		{ elements: Array.from({ length: 4096 }, () => element) },
	],
	[
		"textures",
		{
			textures: Object.fromEntries(
				Array.from({ length: 257 }, (_, i) => [`t${i}`, "demo:stone"]),
			),
		},
		{
			textures: Object.fromEntries(
				Array.from({ length: 256 }, (_, i) => [`t${i}`, "demo:stone"]),
			),
		},
	],
] as const) {
	STRUCTURE_CASES.push({
		name: `limits: ${name} ceiling is inclusive`,
		run(check) {
			assertError(
				check,
				() =>
					validateModelStructure(jsonNode(input), fixtureRules("84.0"), rel),
				["RESOURCE_LIMIT_EXCEEDED"],
			);
			check.deepEqual(
				validateModelStructure(jsonNode(boundary), fixtureRules("84.0"), rel)
					.findings,
				[],
			);
		},
	});
}

export function assertByteSorted(
	check: CaseCheck,
	values: readonly string[],
): void {
	const encoder = new TextEncoder();
	const compare = (a: string, b: string) => {
		const left = encoder.encode(a);
		const right = encoder.encode(b);
		for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
			if (left[i] !== right[i]) return left[i] - right[i];
		}
		return left.length - right.length;
	};
	check.deepEqual(values, [...values].sort(compare));
}
STRUCTURE_CASES.push({
	name: "report stability: structure findings and skipped fields are sorted by bytes",
	run(check) {
		const root = jsonNode({
			𐀀: 1,
			"": 2,
			z: 3,
			ambientocclusion: 0,
			gui_light: 0,
			display: { gui: { scale: [9, 1, 1], rotation: [0, 0] } },
		});
		const first = validateModelStructure(root, fixtureRules("84.0"), rel);
		check.equal(first.findings.length, 4);
		check.equal(first.skipped.length, 3);
		assertByteSorted(
			check,
			first.findings.map(
				(f) => `${f.pointer}\u0000${f.code}\u0000${f.message}`,
			),
		);
		assertByteSorted(
			check,
			first.skipped.map((s) => `${s.kind}\u0000${s.target}\u0000${s.reason}`),
		);
		check.equal(
			JSON.stringify(first),
			JSON.stringify(validateModelStructure(root, fixtureRules("84.0"), rel)),
		);
	},
});
