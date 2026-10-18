import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUALITY_CASES } from "./quality-cases.ts";

describe("pack quality and delivery", () => {
	for (const entry of QUALITY_CASES) {
		it(entry.name, async () => {
			await entry.run();
		});
	}
	assert.ok(QUALITY_CASES.length > 0);
});
