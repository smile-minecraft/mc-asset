import { test } from "bun:test";
import { BLOCK_MODEL_CASES } from "./block-model-cases.ts";

for (const entry of BLOCK_MODEL_CASES) test(entry.name, entry.run, 30_000);
