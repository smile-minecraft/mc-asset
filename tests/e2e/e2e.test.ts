import { test } from "bun:test";
import { E2E_CASES } from "./e2e-cases.ts";

for (const entry of E2E_CASES) test(entry.name, entry.run, 60_000);
