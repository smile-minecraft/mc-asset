import { test } from "bun:test";
import { TOOL_VERSION_CASES } from "./tool-version-cases.ts";

for (const entry of TOOL_VERSION_CASES) test(entry.name, entry.run);
