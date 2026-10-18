import { test } from "node:test";
import { STYLE_METRIC_CASES } from "./style-metrics-cases.ts";

for (const entry of STYLE_METRIC_CASES) test(entry.name, entry.run);
