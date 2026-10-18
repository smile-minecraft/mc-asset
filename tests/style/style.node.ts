import { test } from "node:test";
import { STYLE_CASES } from "./style-cases.ts";

for (const entry of STYLE_CASES) test(entry.name, entry.run);
