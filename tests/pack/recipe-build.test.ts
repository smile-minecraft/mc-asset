import { test } from "bun:test";
import { RECIPE_BUILD_CASES } from "./recipe-build-cases.ts";

for (const entry of RECIPE_BUILD_CASES) test(entry.name, entry.run, 30_000);
