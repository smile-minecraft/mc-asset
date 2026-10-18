import { test } from "bun:test";
import { ITEM_MODEL_CASES } from "./item-model-cases.ts";

for (const entry of ITEM_MODEL_CASES) test(entry.name, entry.run, 30_000);
