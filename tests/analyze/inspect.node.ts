import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CaseCheck, INSPECT_CASES } from "./inspect-cases.ts";

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

describe("inspect engine pure cases", () => {
	for (const inspectCase of INSPECT_CASES) {
		it(inspectCase.name, () => {
			inspectCase.run(check);
		});
	}
});
