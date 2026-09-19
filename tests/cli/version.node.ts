import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CaseCheck, VERSION_CASES } from "./version-cases.ts";

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

describe("version flag resolution pure cases", () => {
	for (const versionCase of VERSION_CASES) {
		it(versionCase.name, () => {
			versionCase.run(check);
		});
	}
});
