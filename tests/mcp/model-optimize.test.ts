import { test } from "bun:test";
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
	test(entry.name, entry.run, 30_000);
