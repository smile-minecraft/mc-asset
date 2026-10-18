/**
 * Model and item definition template builders for pack authoring.
 *
 * Implements parent model templates (generated, handheld, handheld_rod),
 * custom modelSpec structures, and the four item definition templates
 * (simple, select, condition, range_dispatch) per spec §5.4.
 */

export type ParentModelPreset = "generated" | "handheld" | "handheld_rod";

export interface ParentModelOptions {
	readonly parent?: string | undefined;
	readonly texture?: string | undefined;
	readonly item: string;
	readonly namespace: string;
}

export interface SimpleItemDefinitionOptions {
	readonly model: string;
}

export interface SelectCase {
	readonly when: readonly string[];
	readonly model: string;
}

export interface SelectItemDefinitionOptions {
	readonly property?: string | undefined;
	readonly cases: readonly SelectCase[];
	readonly fallback: string;
}

export interface ConditionItemDefinitionOptions {
	readonly property?: string | undefined;
	readonly on_true: string;
	readonly on_false: string;
}

export interface RangeDispatchEntry {
	readonly threshold: number;
	readonly model: string;
}

export interface RangeDispatchItemDefinitionOptions {
	readonly property?: string | undefined;
	readonly entries: readonly RangeDispatchEntry[];
	readonly fallback: string;
}

/** Build a model document referencing a parent model. */
export function buildParentModel(
	options: ParentModelOptions,
): Record<string, unknown> {
	const parent = options.parent ?? "generated";
	const texture =
		options.texture ?? `${options.namespace}:item/${options.item}`;
	return {
		parent: `minecraft:item/${parent}`,
		textures: { layer0: texture },
	};
}

/** Build an item definition with a simple single model. */
export function buildSimpleItemDefinition(
	options: SimpleItemDefinitionOptions,
): Record<string, unknown> {
	return {
		model: { type: "minecraft:model", model: options.model },
	};
}

/** Build an item definition with display-context or property select. */
export function buildSelectItemDefinition(
	options: SelectItemDefinitionOptions,
): Record<string, unknown> {
	return {
		model: {
			type: "minecraft:select",
			property: options.property ?? "minecraft:display_context",
			cases: options.cases.map((entry) => ({
				when: [...entry.when],
				model: entry.model,
			})),
			fallback: options.fallback,
		},
	};
}

/** Build an item definition with a condition branch. */
export function buildConditionItemDefinition(
	options: ConditionItemDefinitionOptions,
): Record<string, unknown> {
	return {
		model: {
			type: "minecraft:condition",
			property: options.property ?? "minecraft:damaged",
			on_true: options.on_true,
			on_false: options.on_false,
		},
	};
}

/** Build an item definition with range dispatch thresholds. */
export function buildRangeDispatchItemDefinition(
	options: RangeDispatchItemDefinitionOptions,
): Record<string, unknown> {
	return {
		model: {
			type: "minecraft:range_dispatch",
			property: options.property ?? "minecraft:damage",
			entries: options.entries.map((entry) => ({
				threshold: entry.threshold,
				model: entry.model,
			})),
			fallback: options.fallback,
		},
	};
}

/**
 * Every string inside a template's cases, entries, branches, and fallback is
 * a model the built definition points at. Non-string leaves contribute
 * nothing; the planner decides whether the collected reference resolves.
 */
export function collectItemDefinitionModelRefs(
	definition: Record<string, unknown> | undefined,
): string[] {
	const refs: string[] = [];
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			if (value.trim() !== "") {
				refs.push(value);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) {
				visit(entry);
			}
			return;
		}
		if (typeof value === "object" && value !== null) {
			const record = value as Record<string, unknown>;
			for (const key of [
				"cases",
				"entries",
				"fallback",
				"on_true",
				"on_false",
				"model",
			]) {
				if (key in record) {
					visit(record[key]);
				}
			}
		}
	};
	if (definition !== undefined) {
		for (const key of ["cases", "entries", "fallback", "on_true", "on_false"]) {
			if (key in definition) {
				visit(definition[key]);
			}
		}
	}
	return refs;
}

/**
 * Dispatch and build an item definition document from recipe declaration.
 * An absent definition defaults to the simple single-model form;
 * explicit type fields select select, condition, or range_dispatch.
 *
 * A string `model` next to a definition object is the definition's own
 * top-level fallback, not a model-file reference: in the recipe that field
 * only applies when the definition is absent. Templates already carry their
 * own fallback, so it stays out of the built document and out of the
 * reference check.
 */
export function buildItemDefinitionDocument(
	definition: Record<string, unknown> | undefined,
	defaultModel: string,
): Record<string, unknown> {
	if (definition === undefined) {
		return buildSimpleItemDefinition({ model: defaultModel });
	}
	const type = definition.type;
	if (type === "select") {
		const cases = Array.isArray(definition.cases) ? definition.cases : [];
		return buildSelectItemDefinition({
			property:
				typeof definition.property === "string"
					? definition.property
					: undefined,
			cases: cases as SelectCase[],
			fallback:
				typeof definition.fallback === "string"
					? definition.fallback
					: defaultModel,
		});
	}
	if (type === "condition") {
		return buildConditionItemDefinition({
			property:
				typeof definition.property === "string"
					? definition.property
					: undefined,
			on_true:
				typeof definition.on_true === "string"
					? definition.on_true
					: defaultModel,
			on_false:
				typeof definition.on_false === "string"
					? definition.on_false
					: defaultModel,
		});
	}
	if (type === "range_dispatch") {
		const entries = Array.isArray(definition.entries) ? definition.entries : [];
		return buildRangeDispatchItemDefinition({
			property:
				typeof definition.property === "string"
					? definition.property
					: undefined,
			entries: entries as RangeDispatchEntry[],
			fallback:
				typeof definition.fallback === "string"
					? definition.fallback
					: defaultModel,
		});
	}
	return buildSimpleItemDefinition({ model: defaultModel });
}
