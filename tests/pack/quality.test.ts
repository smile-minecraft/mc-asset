import { test } from "bun:test";
import { QUALITY_CASES } from "./quality-cases.ts";

for (const entry of QUALITY_CASES) test(entry.name, entry.run, 30_000);
