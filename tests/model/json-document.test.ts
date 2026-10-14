import { describe, expect, test } from "bun:test";
import { type CaseCheck, JSON_DOCUMENT_CASES } from "./json-document-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, message) => expect(actual, message).toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message).toEqual(expected),
	ok: (value, message) => expect(value, message).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("model json-document", () => {
	for (const modelCase of JSON_DOCUMENT_CASES) {
		test(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});
