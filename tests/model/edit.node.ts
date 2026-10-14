import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EDIT_CASES } from "./edit-cases.ts";
import type { CaseCheck } from "./json-document-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("model edit", () => {
	for (const modelCase of EDIT_CASES) {
		it(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});
