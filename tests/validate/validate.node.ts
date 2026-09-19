import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CaseCheck, VALIDATE_CASES } from "./validate-cases.ts";

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

describe("validate engine pure cases", () => {
	for (const validateCase of VALIDATE_CASES) {
		it(validateCase.name, () => {
			validateCase.run(check);
		});
	}
});
