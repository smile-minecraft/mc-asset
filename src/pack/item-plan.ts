/**
 * Model and item definition output planning helpers.
 *
 * Pure helpers to enumerate the JSON documents a target generates so
 * planPackBuild can register them before any byte is written.
 */

import { McAssetError } from "../core/errors.ts";
import type { RecipeStep } from "./recipe.ts";

const NAMESPACE_PATTERN = /^[a-z0-9_.-]+$/;

function assertValidItemName(
	item: string,
	targetId: string,
	stepIndex: number,
): void {
	if (
		typeof item !== "string" ||
		item.trim() === "" ||
		!NAMESPACE_PATTERN.test(item)
	) {
		throw new McAssetError(
			"RECIPE_INVALID",
			`Invalid item id '${item}' for target '${targetId}'.`,
			{
				targetId,
				item,
			},
		);
	}
	void stepIndex;
}

/** Validate a value is a resource location with explicit namespace. */
export function parseItemResourceLocation(value: unknown): {
	namespace: string;
	path: string;
} {
	if (typeof value !== "string") {
		throw new Error("expected resource location string");
	}
	const cut = value.indexOf(":");
	if (cut <= 0 || cut === value.length - 1) {
		throw new Error(`invalid resource location: ${value}`);
	}
	return {
		namespace: value.slice(0, cut),
		path: value.slice(cut + 1),
	};
}

/** Enumerate model outputs: one per model step. */
export function collectModelOutputsForStep(
	step: RecipeStep,
	targetId: string,
): Array<{ item: string }> {
	if (step.type !== "model") {
		return [];
	}
	const item =
		typeof step.item === "string" && step.item.trim() !== ""
			? step.item
			: targetId;
	assertValidItemName(item, targetId, -1);
	return [{ item }];
}

/** Enumerate item definition outputs: at most one per itemDefinition step. */
export function collectItemOutputsForStep(
	step: RecipeStep,
	targetId: string,
): Array<{ item: string }> {
	if (step.type !== "itemDefinition") {
		return [];
	}
	const item =
		typeof step.item === "string" && step.item.trim() !== ""
			? step.item
			: targetId;
	assertValidItemName(item, targetId, -1);
	return [{ item }];
}
