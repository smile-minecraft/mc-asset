import { test } from "node:test";
import { safeOutputCases } from "./safe-output-cases.ts";

for (const entry of safeOutputCases) test(entry.name, entry.run);
