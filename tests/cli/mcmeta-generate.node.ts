import { test } from "node:test";
import {
	MCMETA_GENERATE_MCP_CASES,
	MCMETA_GENERATE_SURFACE_CASES,
	runMcmetaCli,
} from "./mcmeta-generate-cases.ts";

const surface = { cli: runMcmetaCli };

for (const entry of MCMETA_GENERATE_SURFACE_CASES) {
	test(entry.name, async () => {
		await entry.run(surface);
	});
}

for (const entry of MCMETA_GENERATE_MCP_CASES) {
	test(entry.name, entry.run);
}

import { MCMETA_VERSION_CASES } from "./mcmeta-version-cases.ts";

for (const entry of MCMETA_VERSION_CASES) {
	test(entry.name, entry.run);
}
