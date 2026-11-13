import { test } from "node:test";
import { PARTICLE_CASES } from "./particle-cases.ts";

for (const entry of PARTICLE_CASES) test(entry.name, entry.run);
