import { test } from "bun:test";
import { CHECK_PARITY_CASES } from "./check-parity-cases.ts";

for (const entry of CHECK_PARITY_CASES) test(entry.name, entry.run);
