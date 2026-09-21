import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RESOURCE_CONTEXT_CASES,
	type ResourceContextCheck,
} from "./resource-context-cases.ts";

const check: ResourceContextCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("resource resolution context cases", () => {
	for (const resourceCase of RESOURCE_CONTEXT_CASES) {
		it(resourceCase.name, async () => {
			await resourceCase.run(check);
		});
	}
});
