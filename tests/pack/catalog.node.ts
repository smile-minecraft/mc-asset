import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOG_CASES } from "./catalog-cases.ts";

describe("vanilla catalog and jar extraction", () => {
	for (const entry of CATALOG_CASES) {
		it(entry.name, async () => {
			await entry.run();
		});
	}
	assert.ok(CATALOG_CASES.length > 0);
});
