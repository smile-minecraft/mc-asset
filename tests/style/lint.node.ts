import { test } from "node:test";
import { LINT_CASES } from "./lint-cases.ts";

for (const entry of LINT_CASES) test(entry.name, entry.run);
