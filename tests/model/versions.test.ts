import { describe, expect, test } from "bun:test";
import type { CaseCheck } from "./json-document-cases.ts";
import { VERSIONS_CASES } from "./versions-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, message) => expect(actual, message).toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message).toEqual(expected),
	ok: (value, message) => expect(value, message).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("model versions", () => {
	for (const modelCase of VERSIONS_CASES) {
		test(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});
