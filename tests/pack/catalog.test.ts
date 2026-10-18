import { test } from "bun:test";
import { CATALOG_CASES } from "./catalog-cases.ts";

for (const entry of CATALOG_CASES) test(entry.name, entry.run, 30_000);
