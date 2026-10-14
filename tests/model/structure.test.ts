import { describe, expect, test } from "bun:test";
import type { CaseCheck } from "./json-document-cases.ts";
import { STRUCTURE_CASES } from "./structure-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, message) => expect(actual, message).toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message).toEqual(expected),
	ok: (value, message) => expect(value, message).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("model structure", () => {
	for (const modelCase of STRUCTURE_CASES) {
		test(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});
