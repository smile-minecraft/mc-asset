import { describe, expect, test } from "bun:test";
import { RECOLOR_FAMILY_CASES } from "./recolor-family-cases.ts";

describe("recolor and variant palette family path", () => {
	for (const entry of RECOLOR_FAMILY_CASES) {
		test(entry.name, () => entry.run(), 30_000);
	}
	expect(RECOLOR_FAMILY_CASES.length).toBeGreaterThan(0);
});
