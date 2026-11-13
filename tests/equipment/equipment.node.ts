import { describe, test } from "node:test";
import { EQUIPMENT_CASES } from "./equipment-cases.ts";

describe("equipment", () => {
	for (const equipmentCase of EQUIPMENT_CASES) {
		test(equipmentCase.name, async () => {
			await equipmentCase.run();
		});
	}
});
