import { test } from "node:test";
import { quantizeBoundaryCases } from "./quantize-boundary-cases.ts";

for (const entry of quantizeBoundaryCases) test(entry.name, entry.run);
