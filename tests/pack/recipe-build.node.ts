import { test } from "node:test";
import { RECIPE_BUILD_CASES } from "./recipe-build-cases.ts";

for (const entry of RECIPE_BUILD_CASES) test(entry.name, entry.run);
