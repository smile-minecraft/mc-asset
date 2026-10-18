import { test } from "bun:test";
import { PACK_CASES } from "./pack-init-cases.ts";

for (const entry of PACK_CASES) test(entry.name, entry.run, 30_000);
