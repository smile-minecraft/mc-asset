import { describe, expect, test } from "bun:test";
import {
	REFERENCE_GRAPH_CASES,
	type ReferenceGraphCaseCheck,
} from "./reference-graph-cases.ts";

const check: ReferenceGraphCaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
};

describe("reference graph cases", () => {
	for (const graphCase of REFERENCE_GRAPH_CASES) {
		test(graphCase.name, () => {
			return graphCase.run(check);
		});
	}
});
