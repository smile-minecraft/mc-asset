import { describe, expect, test } from "bun:test";
import { EXPORT_CASES } from "./export-cases.ts";
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

describe("model export", () => {
	for (const modelCase of EXPORT_CASES) {
		test(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});
