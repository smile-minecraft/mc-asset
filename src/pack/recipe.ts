/**
 * Recipe document types and expansion.
 *
 * Strict parsing, variable validation, and Cartesian expansion of `*.recipe.json`.
 */

import { McAssetError } from "../core/errors.ts";
import { isJsonObject, isRelativeProjectPath } from "./document.ts";
import { compareCodeUnits } from "./skeleton.ts";

export interface RecipeSource {
	readonly kind: "grid" | "mcpx" | "png" | "generate" | "vanilla";
	readonly path?: string | undefined;
	readonly pattern?: string | undefined;
	readonly size?: string | undefined;
	readonly palette?: string | undefined;
	readonly seed?: number | undefined;
}

export interface RecipeStep {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface RecipeTarget {
	readonly id: string;
	readonly category?: string | null | undefined;
	readonly source?: string | undefined;
	readonly output?: string | undefined;
	readonly steps: readonly RecipeStep[];
}

export interface RecipeDocument {
	readonly formatVersion: number;
	readonly id: string;
	readonly description?: string | undefined;
	readonly style?: string | undefined;
	readonly variables?: Readonly<Record<string, readonly string[]>> | undefined;
	readonly sources?: Readonly<Record<string, RecipeSource>> | undefined;
	readonly targets: readonly RecipeTarget[];
}

const RECIPE_TOP_FIELDS: ReadonlySet<string> = new Set([
	"formatVersion",
	"id",
	"description",
	"style",
	"variables",
	"sources",
	"targets",
]);

const SOURCE_KINDS: ReadonlySet<string> = new Set([
	"grid",
	"mcpx",
	"png",
	"generate",
	"vanilla",
]);

const SUPPORTED_STEP_TYPES: ReadonlySet<string> = new Set([
	"recolor",
	"outline",
	"sweep",
	"operations",
]);

const PLACEHOLDER_REGEX = /\{([a-zA-Z0-9_.-]+)\}/g;

/** Parse a recipe document text in strict mode. */
export function parseRecipeText(text: string): RecipeDocument {
	if (typeof text !== "string") {
		throw new McAssetError(
			"RECIPE_INVALID",
			"Recipe document must be a string.",
			{ reason: "syntax" },
		);
	}
	let json: unknown;
	try {
		json = JSON.parse(text) as unknown;
	} catch {
		throw new McAssetError("RECIPE_INVALID", "Cannot parse recipe JSON.", {
			reason: "syntax",
		});
	}
	if (!isJsonObject(json)) {
		throw new McAssetError(
			"RECIPE_INVALID",
			"Recipe document root must be an object.",
			{ reason: "field" },
		);
	}

	for (const key of Object.keys(json)) {
		if (!RECIPE_TOP_FIELDS.has(key)) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Unknown top-level field in recipe: ${key}`,
				{ field: key },
			);
		}
	}

	const formatVersion = json.formatVersion;
	if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion)) {
		throw new McAssetError(
			"RECIPE_INVALID",
			"formatVersion must be an integer.",
			{ field: "formatVersion" },
		);
	}
	if (formatVersion > 1) {
		throw new McAssetError(
			"RECIPE_UNSUPPORTED_VERSION",
			`Unsupported recipe formatVersion: ${formatVersion}`,
			{ formatVersion },
		);
	}
	if (formatVersion < 1) {
		throw new McAssetError(
			"RECIPE_INVALID",
			`Unsupported recipe formatVersion: ${formatVersion}`,
			{ field: "formatVersion" },
		);
	}

	const id = json.id;
	if (typeof id !== "string" || id.trim() === "") {
		throw new McAssetError(
			"RECIPE_INVALID",
			"Recipe id must be a non-empty string.",
			{ field: "id" },
		);
	}

	let description: string | undefined;
	if (json.description !== undefined) {
		if (typeof json.description !== "string" || json.description.length > 200) {
			throw new McAssetError(
				"RECIPE_INVALID",
				"Recipe description must be a string up to 200 characters.",
				{ field: "description" },
			);
		}
		description = json.description;
	}

	let style: string | undefined;
	if (json.style !== undefined) {
		if (typeof json.style !== "string" || json.style.trim() === "") {
			throw new McAssetError(
				"RECIPE_INVALID",
				"Recipe style must be a non-empty string.",
				{ field: "style" },
			);
		}
		style = json.style;
	}

	let variables: Record<string, readonly string[]> | undefined;
	if (json.variables !== undefined) {
		if (!isJsonObject(json.variables)) {
			throw new McAssetError(
				"RECIPE_INVALID",
				"Recipe variables must be an object.",
				{ field: "variables" },
			);
		}
		variables = {};
		for (const [varName, values] of Object.entries(json.variables)) {
			if (varName === "namespace") {
				throw new McAssetError(
					"RECIPE_INVALID",
					"Cannot declare or override the implicit variable 'namespace'.",
					{ variable: varName },
				);
			}
			if (
				!Array.isArray(values) ||
				values.length === 0 ||
				!values.every((v) => typeof v === "string")
			) {
				throw new McAssetError(
					"RECIPE_INVALID",
					`Variable '${varName}' must be a non-empty array of strings.`,
					{ variable: varName },
				);
			}
			if (new Set(values).size !== values.length) {
				throw new McAssetError(
					"RECIPE_INVALID",
					`Duplicate values in variable axis '${varName}'.`,
					{ variable: varName },
				);
			}
			variables[varName] = [...values];
		}
	}

	let sources: Record<string, RecipeSource> | undefined;
	if (json.sources !== undefined) {
		if (!isJsonObject(json.sources)) {
			throw new McAssetError(
				"RECIPE_INVALID",
				"Recipe sources must be an object.",
				{ field: "sources" },
			);
		}
		sources = {};
		for (const [srcName, srcObj] of Object.entries(json.sources)) {
			if (!isJsonObject(srcObj)) {
				throw new McAssetError(
					"RECIPE_INVALID",
					`Source '${srcName}' must be an object.`,
					{ source: srcName },
				);
			}
			const kind = srcObj.kind;
			if (typeof kind !== "string" || !SOURCE_KINDS.has(kind)) {
				throw new McAssetError(
					"RECIPE_INVALID",
					`Invalid source kind for '${srcName}': ${String(kind)}`,
					{ source: srcName },
				);
			}
			const typedKind = kind as RecipeSource["kind"];
			if (
				typedKind === "grid" ||
				typedKind === "mcpx" ||
				typedKind === "png" ||
				typedKind === "vanilla"
			) {
				if (typeof srcObj.path !== "string" || srcObj.path.trim() === "") {
					throw new McAssetError(
						"RECIPE_INVALID",
						`Source '${srcName}' must have a path string.`,
						{ source: srcName },
					);
				}
				sources[srcName] = { kind: typedKind, path: srcObj.path };
			} else if (typedKind === "generate") {
				if (
					typeof srcObj.pattern !== "string" ||
					typeof srcObj.size !== "string" ||
					typeof srcObj.palette !== "string" ||
					typeof srcObj.seed !== "number"
				) {
					throw new McAssetError(
						"RECIPE_INVALID",
						`Generate source '${srcName}' requires pattern, size, palette, and integer seed.`,
						{ source: srcName },
					);
				}
				sources[srcName] = {
					kind: typedKind,
					pattern: srcObj.pattern,
					size: srcObj.size,
					palette: srcObj.palette,
					seed: srcObj.seed,
				};
			}
		}
	}

	const rawTargets = json.targets;
	if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
		throw new McAssetError(
			"RECIPE_INVALID",
			"targets must be an array with at least one target.",
			{ field: "targets" },
		);
	}

	const targets: RecipeTarget[] = [];
	for (const [index, rawTarget] of rawTargets.entries()) {
		if (!isJsonObject(rawTarget)) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Target at index ${index} must be an object.`,
				{ targetIndex: index },
			);
		}
		if (typeof rawTarget.id !== "string" || rawTarget.id.trim() === "") {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Target at index ${index} must have a non-empty id string.`,
				{ targetIndex: index },
			);
		}
		if (
			rawTarget.category !== undefined &&
			rawTarget.category !== null &&
			typeof rawTarget.category !== "string"
		) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Target '${rawTarget.id}' category must be a string or null.`,
				{ targetId: rawTarget.id },
			);
		}
		if (
			rawTarget.source !== undefined &&
			typeof rawTarget.source !== "string"
		) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Target '${rawTarget.id}' source must be a string.`,
				{ targetId: rawTarget.id },
			);
		}
		if (
			rawTarget.output !== undefined &&
			typeof rawTarget.output !== "string"
		) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Target '${rawTarget.id}' output must be a string.`,
				{ targetId: rawTarget.id },
			);
		}
		if (
			!Array.isArray(rawTarget.steps) ||
			rawTarget.steps.length === 0 ||
			!rawTarget.steps.every(isJsonObject)
		) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Target '${rawTarget.id}' steps must be a non-empty array of step objects.`,
				{ targetId: rawTarget.id },
			);
		}
		const steps: RecipeStep[] = [];
		for (const [stepIndex, rawStep] of rawTarget.steps.entries()) {
			if (typeof rawStep.type !== "string" || rawStep.type.trim() === "") {
				throw new McAssetError(
					"RECIPE_INVALID",
					`Target '${rawTarget.id}' step at index ${stepIndex} must have a type string.`,
					{ targetId: rawTarget.id, stepIndex },
				);
			}
			if (!SUPPORTED_STEP_TYPES.has(rawStep.type)) {
				throw new McAssetError(
					"RECIPE_INVALID",
					`Target '${rawTarget.id}' step at index ${stepIndex} has unsupported step type '${rawStep.type}'.`,
					{ targetId: rawTarget.id, stepIndex, stepType: rawStep.type },
				);
			}
			steps.push({ ...rawStep, type: rawStep.type });
		}

		if (
			typeof rawTarget.output !== "string" ||
			rawTarget.output.trim() === ""
		) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Target '${rawTarget.id}' with image steps must declare output.`,
				{ targetId: rawTarget.id },
			);
		}
		if (
			typeof rawTarget.source !== "string" ||
			rawTarget.source.trim() === ""
		) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Target '${rawTarget.id}' with image steps must declare source.`,
				{ targetId: rawTarget.id },
			);
		}

		targets.push({
			id: rawTarget.id,
			category: rawTarget.category as string | null | undefined,
			source: rawTarget.source,
			output: rawTarget.output,
			steps,
		});
	}

	return {
		formatVersion,
		id,
		...(description !== undefined ? { description } : {}),
		...(style !== undefined ? { style } : {}),
		...(variables !== undefined ? { variables } : {}),
		...(sources !== undefined ? { sources } : {}),
		targets,
	};
}

/** Collect all `{var}` placeholder names from a string. */
function extractPlaceholders(text: string, out: Set<string>): void {
	for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
		if (match[1]) {
			out.add(match[1]);
		}
	}
}

/** Collect placeholders across all string fields of a target. */
function collectTargetPlaceholders(
	target: RecipeTarget,
	out: Set<string>,
): void {
	extractPlaceholders(target.id, out);
	if (typeof target.category === "string") {
		extractPlaceholders(target.category, out);
	}
	if (typeof target.source === "string") {
		extractPlaceholders(target.source, out);
	}
	if (typeof target.output === "string") {
		extractPlaceholders(target.output, out);
	}
	const walkValues = (val: unknown) => {
		if (typeof val === "string") {
			extractPlaceholders(val, out);
		} else if (Array.isArray(val)) {
			for (const item of val) walkValues(item);
		} else if (isJsonObject(val)) {
			for (const v of Object.values(val)) walkValues(v);
		}
	};
	walkValues(target.steps);
}

/** Substitute `{var}` placeholders with scope values. */
function substituteString(
	text: string,
	scope: Readonly<Record<string, string>>,
): string {
	return text.replace(PLACEHOLDER_REGEX, (orig, key: string) => {
		return scope[key] !== undefined ? scope[key] : orig;
	});
}

function substituteValue(
	value: unknown,
	scope: Readonly<Record<string, string>>,
): unknown {
	if (typeof value === "string") {
		return substituteString(value, scope);
	}
	if (Array.isArray(value)) {
		return value.map((item) => substituteValue(item, scope));
	}
	if (isJsonObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = substituteValue(v, scope);
		}
		return out;
	}
	return value;
}

/** Expand recipe targets into a flat list sorted by target id. */
export function expandRecipeTargets(
	recipe: RecipeDocument,
	namespace: string,
): readonly RecipeTarget[] {
	const allUsedPlaceholders = new Set<string>();
	for (const target of recipe.targets) {
		collectTargetPlaceholders(target, allUsedPlaceholders);
	}

	const declaredVars = new Set(Object.keys(recipe.variables ?? {}));

	// Validate: every placeholder must be declared or namespace
	for (const placeholder of allUsedPlaceholders) {
		if (placeholder !== "namespace" && !declaredVars.has(placeholder)) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Unknown placeholder '{${placeholder}}' in recipe.`,
				{ placeholder },
			);
		}
	}

	// Validate: every declared variable must be used in at least one target
	for (const varName of declaredVars) {
		if (!allUsedPlaceholders.has(varName)) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Declared variable '${varName}' is not used in any target.`,
				{ variable: varName },
			);
		}
	}

	const expandedList: RecipeTarget[] = [];
	const varAxes = Object.keys(recipe.variables ?? {});

	for (const target of recipe.targets) {
		const targetPlaceholders = new Set<string>();
		collectTargetPlaceholders(target, targetPlaceholders);

		// Determine variable axes used by this target, preserving declaration order
		const usedAxes = varAxes.filter((axis) => targetPlaceholders.has(axis));

		// Cartesian product
		let combinations: Record<string, string>[] = [{}];
		for (const axis of usedAxes) {
			const values = recipe.variables?.[axis] ?? [];
			const next: Record<string, string>[] = [];
			for (const prev of combinations) {
				for (const val of values) {
					next.push({ ...prev, [axis]: val });
				}
			}
			combinations = next;
		}

		for (const combo of combinations) {
			const scope: Record<string, string> = { ...combo, namespace };

			const id = substituteString(target.id, scope);
			const category =
				typeof target.category === "string"
					? substituteString(target.category, scope)
					: target.category;
			const source =
				typeof target.source === "string"
					? substituteString(target.source, scope)
					: target.source;
			const output =
				typeof target.output === "string"
					? substituteString(target.output, scope)
					: target.output;

			if (output !== undefined) {
				if (!isRelativeProjectPath(output) || output.startsWith("..")) {
					throw new McAssetError(
						"RECIPE_INVALID",
						`Output path escapes output directory: ${output}`,
						{ output },
					);
				}
			}

			const steps = substituteValue(target.steps, scope) as RecipeStep[];

			for (const step of steps) {
				if (step.type === "sweep" && typeof step.mcmetaOutput === "string") {
					if (!step.mcmetaOutput.endsWith(".mcmeta")) {
						throw new McAssetError(
							"RECIPE_INVALID",
							`mcmetaOutput must end with .mcmeta: ${step.mcmetaOutput}`,
							{ output: step.mcmetaOutput },
						);
					}
					if (
						!isRelativeProjectPath(step.mcmetaOutput) ||
						step.mcmetaOutput.startsWith("..")
					) {
						throw new McAssetError(
							"RECIPE_INVALID",
							`mcmetaOutput escapes output directory: ${step.mcmetaOutput}`,
							{ output: step.mcmetaOutput },
						);
					}
				}
			}

			expandedList.push({
				id,
				category,
				source,
				output,
				steps,
			});
		}
	}

	// Sort expanded targets by id in UTF-8 byte order
	expandedList.sort((a, b) => compareCodeUnits(a.id, b.id));

	// Validate unique expanded target ids
	const seenIds = new Set<string>();
	for (const t of expandedList) {
		if (seenIds.has(t.id)) {
			throw new McAssetError(
				"RECIPE_INVALID",
				`Duplicate expanded target id: ${t.id}`,
				{ targetId: t.id },
			);
		}
		seenIds.add(t.id);
	}

	// Validate unique output paths
	const seenOutputs = new Set<string>();
	const dupeOutputs = new Set<string>();
	for (const t of expandedList) {
		if (t.output !== undefined) {
			if (seenOutputs.has(t.output)) {
				dupeOutputs.add(t.output);
			}
			seenOutputs.add(t.output);
		}
	}
	if (dupeOutputs.size > 0) {
		const conflicts = [...dupeOutputs].sort(compareCodeUnits);
		throw new McAssetError(
			"RECIPE_OUTPUT_CONFLICT",
			`Recipe targets expand to duplicate output paths: ${conflicts.join(", ")}`,
			{ conflicts, paths: conflicts },
		);
	}

	return expandedList;
}
