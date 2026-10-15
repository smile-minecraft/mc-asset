import { test } from "node:test";
import { RECOLOR_PNG_CASES } from "./recolor-png-cases.ts";

for (const entry of RECOLOR_PNG_CASES) {
	test(entry.name, () => entry.run());
}
