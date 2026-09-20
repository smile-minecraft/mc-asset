import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESOURCE_LOCATION_CASES } from "./resource-location-cases.ts";
import type { CaseCheck } from "./validate-cases.ts";

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

describe("resource location engine pure cases", () => {
	for (const resourceLocationCase of RESOURCE_LOCATION_CASES) {
		it(resourceLocationCase.name, () => {
			resourceLocationCase.run(check);
		});
	}
});
