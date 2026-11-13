import { test } from "bun:test";
import { PROJECT_STYLE_CASES } from "./project-style-cases.ts";

for (const entry of PROJECT_STYLE_CASES) test(entry.name, entry.run);
