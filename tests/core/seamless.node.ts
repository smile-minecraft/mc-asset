import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEAMLESS_CASES, type SeamlessCheck } from "./seamless-cases.ts";

const check: SeamlessCheck = {
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("procedural patterns tile without a seam", () => {
	for (const seamlessCase of SEAMLESS_CASES) {
		it(seamlessCase.name, () => {
			seamlessCase.run(check);
		});
	}
});
