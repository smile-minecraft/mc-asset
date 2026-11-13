import { test } from "bun:test";
import { GENERATED_RECIPE_CASES } from "./generated-recipe-cases.ts";

for (const entry of GENERATED_RECIPE_CASES) test(entry.name, entry.run, 30_000);
