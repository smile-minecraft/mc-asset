import { test } from "bun:test";
import { DEMO_PACK_CASES } from "./demo-pack-cases.ts";

for (const entry of DEMO_PACK_CASES) test(entry.name, entry.run, 60_000);
