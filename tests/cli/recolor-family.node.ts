import { test } from "node:test";
import { RECOLOR_FAMILY_CASES } from "./recolor-family-cases.ts";

for (const entry of RECOLOR_FAMILY_CASES) {
	test(entry.name, () => entry.run());
}
