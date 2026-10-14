import { test } from "node:test";
import {
	cliMcpConsistencyCases,
	modelOptimizeCases,
	modelOptimizeSurfaceCases,
} from "./model-optimize-cases.ts";

for (const entry of [
	...modelOptimizeCases,
	...modelOptimizeSurfaceCases,
	...cliMcpConsistencyCases,
])
	test(entry.name, entry.run);
