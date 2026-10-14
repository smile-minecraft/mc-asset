import type { ModelEditResult } from "./edit.ts";
import { closeDocument, parseModelDocument } from "./edit-support.ts";
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
