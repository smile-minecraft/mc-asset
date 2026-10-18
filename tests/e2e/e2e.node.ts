import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { E2E_CASES } from "./e2e-cases.ts";

describe("end-to-end resource pack authoring", () => {
	for (const entry of E2E_CASES) {
		it(entry.name, async () => {
			await entry.run();
		});
	}
	assert.ok(E2E_CASES.length > 0);
});
