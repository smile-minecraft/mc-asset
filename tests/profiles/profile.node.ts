import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CaseCheck, MODEL_CASES } from "./profile-cases.ts";

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

describe("asset profiles and predicted alpha", () => {
	for (const modelCase of MODEL_CASES) {
		it(modelCase.name, () => {
			modelCase.run(check);
		});
	}
});
