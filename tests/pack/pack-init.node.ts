import { test } from "node:test";
import { PACK_CASES } from "./pack-init-cases.ts";

for (const entry of PACK_CASES) test(entry.name, entry.run);
