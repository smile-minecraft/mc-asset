import { test } from "bun:test";
import { SWEEP_CASES } from "./sweep-cases.ts";

for (const entry of SWEEP_CASES) {
	test(entry.name, () => entry.run());
}
