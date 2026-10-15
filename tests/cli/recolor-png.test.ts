import { describe, expect, test } from "bun:test";
import { RECOLOR_PNG_CASES } from "./recolor-png-cases.ts";

describe("flat raster recolor and variants", () => {
	for (const entry of RECOLOR_PNG_CASES) {
		test(entry.name, () => entry.run(), 30_000);
	}
	expect(RECOLOR_PNG_CASES.length).toBeGreaterThan(0);
});
