import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CaseCheck, CONVERT_CASES } from "./convert-cases.ts";

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

describe("cli conversion pure cases", () => {
	for (const convertCase of CONVERT_CASES) {
		it(convertCase.name, () => {
			convertCase.run(check);
		});
	}
});
