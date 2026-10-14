import { McAssetError } from "../../src/core/errors.ts";
import {
	type JsonNode,
	jsonPointer,
	parseJsonDocument,
	serializeJsonDocument,
} from "../../src/model/json-document.ts";
import { MODEL_LIMITS } from "../../src/model/limits.ts";

export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface ModelCase {
	name: string;
	run(check: CaseCheck): void | Promise<void>;
}

export function assertError(
	check: CaseCheck,
	fn: () => unknown,
	codes: readonly string[],
): McAssetError {
	try {
		fn();
	} catch (error) {
		check.ok(error instanceof McAssetError, "expected McAssetError");
		if (!(error instanceof McAssetError)) return check.fail("wrong error type");
		check.ok(codes.includes(error.code), `expected ${codes.join(" or ")}`);
		return error;
	}
	return check.fail(`expected ${codes.join(" or ")} but nothing was thrown`);
}

export async function assertAsyncError(
	check: CaseCheck,
	fn: () => Promise<unknown>,
	code: string,
): Promise<void> {
	let caught: unknown;
	try {
		await fn();
	} catch (error) {
		caught = error;
	}
	check.ok(caught instanceof McAssetError, `expected McAssetError(${code})`);
	if (caught instanceof McAssetError) check.equal(caught.code, code);
}

/** Build structure inputs independently of the parser under test. */
export function jsonNode(value: unknown): JsonNode {
	if (value === null) return { type: "null" };
	if (typeof value === "boolean") return { type: "boolean", value };
	if (typeof value === "string") return { type: "string", value };
	if (typeof value === "number") {
		return {
			type: "number",
			raw: Number.isFinite(value) ? String(value) : "1e999",
			value,
		};
	}
	if (Array.isArray(value))
		return { type: "array", items: value.map(jsonNode) };
	if (typeof value === "object") {
		return {
			type: "object",
			members: Object.entries(value).map(([key, member]) => ({
				key,
				value: jsonNode(member),
			})),
		};
	}
	throw new Error("invalid test input");
}

const canonical =
	'{\n  "z": 1.0,\n  "angle": 22.5,\n  "tiny": 1e-3,\n  "unknown": {\n    "a/b~c": [\n      true,\n      null,\n      "😀"\n    ]\n  }\n}\n';

export const JSON_DOCUMENT_CASES: ModelCase[] = [
	{
		name: "JSON: legal document retains ordered members and numeric raw text",
		run(check) {
			check.deepEqual(parseJsonDocument('{"z":1.0,"a":22.5,"b":1e-3}'), {
				type: "object",
				members: [
					{ key: "z", value: { type: "number", raw: "1.0", value: 1 } },
					{ key: "a", value: { type: "number", raw: "22.5", value: 22.5 } },
					{ key: "b", value: { type: "number", raw: "1e-3", value: 0.001 } },
				],
			});
		},
	},
	{
		name: "JSON: canonical round trip preserves unknown contents and numeric spelling",
		run(check) {
			check.equal(
				serializeJsonDocument(parseJsonDocument(canonical)),
				canonical,
			);
		},
	},
	{
		name: "JSON: serialization uses raw numbers, two spaces, LF and one newline",
		run(check) {
			check.equal(
				serializeJsonDocument({
					type: "object",
					members: [
						{ key: "b", value: { type: "number", raw: "-0", value: -0 } },
						{ key: "a", value: jsonNode(["\n", false, null]) },
					],
				}),
				'{\n  "b": -0,\n  "a": [\n    "\\n",\n    false,\n    null\n  ]\n}\n',
			);
		},
	},
	{
		name: "JSON: overflow exponent remains strict JSON and is not rounded away",
		run(check) {
			check.deepEqual(parseJsonDocument('{"n":1e999}'), {
				type: "object",
				members: [
					{
						key: "n",
						value: { type: "number", raw: "1e999", value: Infinity },
					},
				],
			});
			check.equal(
				serializeJsonDocument(parseJsonDocument('{"n":1e999}')),
				'{\n  "n": 1e999\n}\n',
			);
		},
	},
	{
		name: "JSON: RFC 6901 pointer escapes slash and tilde",
		run(check) {
			check.equal(jsonPointer(["a/b~c", 0, ""]), "/a~1b~0c/0/");
			check.equal(jsonPointer([]), "");
		},
	},
];

for (const [label, text] of [
	["BOM", "\uFEFF{}"],
	["line comment", '{// comment\n"a":1}'],
	["block comment", '{/* comment */"a":1}'],
	["trailing object comma", '{"a":1,}'],
	["trailing array comma", '{"a":[1,]}'],
	["duplicate key", '{"a":1,"a":2}'],
	["escaped duplicate key", '{"a":1,"\\u0061":2}'],
	["nested duplicate key", '{"a":{"b":1,"b":2}}'],
	["escaped high surrogate", '{"a":"\\ud800"}'],
	["escaped low surrogate", '{"a":"\\udfff"}'],
	["literal lone surrogate", '{"a":"\uD800"}'],
	["surrogate in key", '{"\\ud800":1}'],
	["non-object root array", "[]"],
	["non-object root null", "null"],
	["non-object root number", "1"],
	["leading zero", '{"a":01}'],
	["invalid number", '{"a":NaN}'],
	["trailing text", "{} true"],
] as const) {
	JSON_DOCUMENT_CASES.push({
		name: `JSON: reject ${label} with diagnostics`,
		run(check) {
			const error = assertError(check, () => parseJsonDocument(text), [
				"MODEL_INVALID_JSON",
			]);
			const details = error.details as { reason?: unknown; offset?: unknown };
			check.equal(typeof details.reason, "string");
			check.ok(typeof details.reason === "string" && details.reason.length > 0);
			const offset = details.offset;
			check.ok(typeof offset === "number" && Number.isInteger(offset));
			check.ok(
				typeof offset === "number" && offset >= 0 && offset <= text.length,
			);
		},
	});
}

JSON_DOCUMENT_CASES.push(
	{
		name: "limits: JSON nesting 65 is rejected and 64 is accepted",
		run(check) {
			const nested = (containers: number) =>
				`{"a":${"[".repeat(containers - 1)}0${"]".repeat(containers - 1)}}`;
			const text = nested(65);
			const error = assertError(check, () => parseJsonDocument(text), [
				"MODEL_INVALID_JSON",
			]);
			const details = error.details as { reason?: unknown; offset?: unknown };
			check.equal(details.reason, "depth-limit");
			check.ok(
				typeof details.offset === "number" &&
					Number.isInteger(details.offset) &&
					details.offset >= 0 &&
					details.offset <= text.length,
			);
			check.equal(parseJsonDocument(nested(64)).type, "object");
		},
	},
	{
		name: "limits: file byte limit is inclusive and counts UTF-8 bytes",
		run(check) {
			const exact = `{}${" ".repeat(1_048_574)}`;
			assertError(check, () => parseJsonDocument(`${exact} `), [
				"RESOURCE_LIMIT_EXCEEDED",
			]);
			check.equal(parseJsonDocument(exact).type, "object");
			assertError(check, () => parseJsonDocument(`{}${"é".repeat(524_288)}`), [
				"RESOURCE_LIMIT_EXCEEDED",
			]);
		},
	},
	{
		name: "limits: individual strings and keys count UTF-8 bytes",
		run(check) {
			for (const text of [
				JSON.stringify({ a: "a".repeat(4097) }),
				JSON.stringify({ a: "é".repeat(2049) }),
				JSON.stringify({ ["a".repeat(4097)]: 0 }),
			]) {
				assertError(check, () => parseJsonDocument(text), [
					"RESOURCE_LIMIT_EXCEEDED",
				]);
			}
			check.deepEqual(
				parseJsonDocument(JSON.stringify({ a: "é".repeat(2048) })),
				jsonNode({ a: "é".repeat(2048) }),
			);
		},
	},
	{
		name: "limits: declared ceilings match the model specification",
		run(check) {
			check.deepEqual(MODEL_LIMITS, {
				maxFileBytes: 1_048_576,
				maxJsonDepth: 64,
				maxElements: 4096,
				maxTextures: 256,
				maxStringBytes: 4096,
				maxParentDepth: 32,
				maxOperations: 1000,
				maxVariants: 256,
				maxMultipartParts: 64,
				maxLoadedDocuments: 64,
			});
		},
	},
);
