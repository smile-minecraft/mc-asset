import { describe, expect, test } from "bun:test";
import { GEOMETRY_CASES } from "./geometry-cases.ts";
import type { CaseCheck } from "./json-document-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, message) => expect(actual, message).toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message).toEqual(expected),
	ok: (value, message) => expect(value, message).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("geometry", () => {
	for (const modelCase of GEOMETRY_CASES) {
		test(modelCase.name, () => {
			modelCase.run(check);
		});
	}
});
