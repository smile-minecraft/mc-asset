import { describe, expect, test } from "bun:test";
import { BBMODEL_CASES } from "./bbmodel-cases.ts";
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

describe("model bbmodel exchange", () => {
	for (const modelCase of BBMODEL_CASES) {
		test(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});
