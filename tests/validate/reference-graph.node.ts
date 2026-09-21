import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	REFERENCE_GRAPH_CASES,
	type ReferenceGraphCaseCheck,
} from "./reference-graph-cases.ts";

const check: ReferenceGraphCaseCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
};

describe("reference graph cases", () => {
	for (const graphCase of REFERENCE_GRAPH_CASES) {
		it(graphCase.name, () => {
			return graphCase.run(check);
		});
	}
});
