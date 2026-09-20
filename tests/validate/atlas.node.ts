import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ATLAS_CASES, type AtlasCaseCheck } from "./atlas-cases.ts";

const check: AtlasCaseCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("atlas sources cases", () => {
	for (const atlasCase of ATLAS_CASES) {
		it(atlasCase.name, async () => {
			await atlasCase.run(check);
		});
	}
});
