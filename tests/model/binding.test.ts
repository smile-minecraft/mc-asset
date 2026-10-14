import { describe, expect, test } from "bun:test";
import { BINDING_CASES } from "./binding-cases.ts";
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

describe("model binding", () => {
	for (const modelCase of BINDING_CASES) {
		test(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});
