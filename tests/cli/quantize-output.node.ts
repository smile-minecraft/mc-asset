import { test } from "node:test";
import { quantizeOutputCases } from "./quantize-output-cases.ts";

for (const entry of quantizeOutputCases) test(entry.name, entry.run);
