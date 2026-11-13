import type { ModelEditResult } from "./edit.ts";
import { createModelDocument } from "./edit.ts";
import { closeDocument, parseModelDocument } from "./edit-support.ts";
import type { ModelSpec } from "./types.ts";
import type { ModelRules } from "./versions.ts";

/**
 * export: canonical re-serialization plus a representability gate for the target rules. Throws
 * MODEL_UNSUPPORTED_VERSION (details: feature, since, target, pointer) for content the target
 * version cannot express; never rewrites, bakes, or drops such content.
 */
export function exportModelDocument(
	sourceText: string,
	rules: ModelRules,
): ModelEditResult {
	const root = parseModelDocument(sourceText);
	return closeDocument(root, rules, 0, { sourceText });
}

/**
 * Build a model document from a typed specification with the same
 * representability gate as export. `model create` and the resource-pack
 * recipe block step both enter here, so a model this toolchain writes is
 * checked once, in one place.
 */
export function buildModelDocument(
	spec: ModelSpec,
	rules: ModelRules,
): ModelEditResult {
	return createModelDocument(spec, rules);
}
