import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PACK_CASES, type PackCaseCheck } from "./pack-cases.ts";

const check: PackCaseCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("validate-pack engine cases", () => {
	for (const packCase of PACK_CASES) {
		it(packCase.name, async () => {
			await packCase.run(check);
		});
	}
});
