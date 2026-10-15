import { test } from "node:test";
import { COMPARE_CASES } from "./compare-cases.ts";

for (const entry of COMPARE_CASES) test(entry.name, () => entry.run());
