import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENTITY_CASES, type EntityCaseCheck } from "./entity-cases.ts";

const check: EntityCaseCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("entity", () => {
	for (const entityCase of ENTITY_CASES) {
		it(entityCase.name, async () => {
			await entityCase.run(check);
		});
	}
});
