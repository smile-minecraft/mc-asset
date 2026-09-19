import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANALYZE_CASES, type CaseCheck } from "./analyze-cases.ts";

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

describe("analyze engine pure cases", () => {
	for (const analyzeCase of ANALYZE_CASES) {
		it(analyzeCase.name, () => {
			analyzeCase.run(check);
		});
	}
});
