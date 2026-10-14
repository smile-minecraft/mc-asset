import { test } from "bun:test";
import {
	assertModelWorkflow,
	withModelWorkflow,
} from "./model-workflow-cases.ts";

test(
	"model create, apply, export and validate-pack produce a valid pack",
	() => withModelWorkflow(assertModelWorkflow),
	30_000,
);
