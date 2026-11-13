/**
 * Model, blockstate, and item definition output planning helpers.
 *
 * Pure helpers to enumerate the JSON documents a target generates so
 * planPackBuild can register them before any byte is written.
 */

import { McAssetError } from "../core/errors.ts";
import { parseBlockModelStep, parseBlockstateStep } from "./block.ts";
import { isJsonObject, requirePlainAssetName } from "./document.ts";
import type { RecipeStep, RecipeTarget } from "./recipe.ts";

/** The document families a recipe step can write under `assets/`. */
export type JsonOutputKind =
	| "model"
	| "itemDefinition"
	| "blockModel"
	| "blockItemModel"
	| "blockstate";

export interface JsonOutput {
	/** Project-relative path inside the output directory. */
	readonly path: string;
	readonly kind: JsonOutputKind;
	/** The plain asset name the step declared (item, block, or target id). */
	readonly name: string;
	readonly stepIndex: number;
}

/**
 * FormatVersion 1 `model` and `itemDefinition` steps treat a missing or
 * blank `item` as "use the target id". Keep that fallback exactly; the
 * build path has always resolved it this way.
 */
export function resolveStepItemName(
	step: RecipeStep,
	targetId: string,
): string {
	const raw = step.item;
	if (raw === undefined) {
		return targetId;
	}
	if (typeof raw === "string" && raw.trim() === "") {
		return targetId;
	}
	return requirePlainAssetName(raw, "item", targetId);
}

/**
 * Run a step parser and make sure a refusal names the step's position in
 * the target, so a document with several steps says which one failed.
 */
function withStepIndex<T>(
	body: () => T,
	targetId: string,
	stepIndex: number,
): T {
	try {
		return body();
	} catch (error) {
		if (error instanceof McAssetError) {
			const details = isJsonObject(error.details) ? error.details : {};
			throw new McAssetError(error.code, error.message, {
				...details,
				targetId,
				stepIndex,
			});
		}
		throw error;
	}
}

/**
 * Enumerate every JSON document one recipe step writes. Paths are relative
 * to the project output directory (`assets/...`), the same shape the
 * duplicate-output checks and the writer use.
 */
export function collectJsonOutputsForStep(
	step: RecipeStep,
	targetId: string,
	namespace: string,
	stepIndex: number,
): JsonOutput[] {
	if (step.type === "model") {
		const item = resolveStepItemName(step, targetId);
		return [
			{
				path: `assets/${namespace}/models/item/${item}.json`,
				kind: "model",
				name: item,
				stepIndex,
			},
		];
	}
	if (step.type === "itemDefinition") {
		const item = resolveStepItemName(step, targetId);
		return [
			{
				path: `assets/${namespace}/items/${item}.json`,
				kind: "itemDefinition",
				name: item,
				stepIndex,
			},
		];
	}
	if (step.type === "blockModel") {
		const spec = withStepIndex(
			() => parseBlockModelStep(step, targetId),
			targetId,
			stepIndex,
		);
		const block = spec.blockId;
		return [
			{
				path: `assets/${namespace}/models/block/${block}.json`,
				kind: "blockModel",
				name: block,
				stepIndex,
			},
			{
				path: `assets/${namespace}/models/item/${block}.json`,
				kind: "blockItemModel",
				name: block,
				stepIndex,
			},
			{
				path: `assets/${namespace}/items/${block}.json`,
				kind: "itemDefinition",
				name: block,
				stepIndex,
			},
		];
	}
	if (step.type === "blockstate") {
		const spec = withStepIndex(
			() => parseBlockstateStep(step, targetId),
			targetId,
			stepIndex,
		);
		return [
			{
				path: `assets/${namespace}/blockstates/${spec.blockId}.json`,
				kind: "blockstate",
				name: spec.blockId,
				stepIndex,
			},
		];
	}
	return [];
}

/**
 * Whether a target produces JSON documents only.
 *
 * A target that declares no source has no image pipeline: the recipe reader
 * refuses image steps without a source, so its steps are JSON steps only.
 * Such a target plans JSON outputs only — no texture output, no canvas, no
 * PNG. A target that declares a source keeps its texture output even when
 * every step is a JSON step, because the source image is the texture it
 * copies into the pack.
 */
export function isJsonOnlyTarget(target: RecipeTarget): boolean {
	return (
		target.source === undefined &&
		target.steps.every((step) =>
			["model", "itemDefinition", "blockModel", "blockstate"].includes(
				step.type,
			),
		)
	);
}
