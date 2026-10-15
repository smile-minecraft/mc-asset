import { test } from "node:test";
import { MCMETA_GENERATE_CORE_CASES } from "./mcmeta-generate-cases.ts";

for (const entry of MCMETA_GENERATE_CORE_CASES) {
	test(entry.name, () => entry.run());
}
