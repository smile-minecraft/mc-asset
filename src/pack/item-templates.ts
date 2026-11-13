/**
 * Model and item definition template builders for pack authoring.
 *
 * Implements parent model templates (generated, handheld, handheld_rod),
 * custom modelSpec structures, the four formatVersion 1 item definition
 * templates (simple, select, condition, range_dispatch) per spec §5.4, and
 * the formatVersion 2 item model node grammar (model with tints, composite,
 * special, nested condition/select/range_dispatch, empty).
 */

import { McAssetError } from "../core/errors.ts";
import {
	REMOVED_ITEM_TINT_TYPES_FACT,
	REMOVED_SPECIAL_MODEL_TYPES_FACT,
	type RemovedTypesAtFormat,
	removedTypesAtFormat,
} from "../profiles/versions.ts";
import { isJsonObject } from "./document.ts";

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

/**
 * The vanilla item model node names the formatVersion 2 grammar builds.
 * All eight exist in 1.21.4 (pack format 46.0): the vanilla `items/`
 * documents use every one but `empty`, which 1.21.4 pre-release 1 added.
 * The formatVersion 1 templates never emit them.
 */
const ITEM_NODE_NAMES: ReadonlySet<string> = new Set([
	"model",
	"composite",
	"condition",
	"select",
	"range_dispatch",
	"special",
	"empty",
	"bundle/selected_item",
]);

/** Target version context for the formatVersion 2 node grammar. */
export interface ItemDefinitionV2Version {
	/** Target resource-pack format; types removed at or below it are refused. */
	readonly packFormat: string;
	/** Target id used in RECIPE_VERSION_UNSUPPORTED details. */
	readonly targetId?: string | undefined;
}

interface ItemNodeVersionContext {
	readonly packFormat: string;
	readonly targetId: string | undefined;
	readonly removedSpecialModelTypes: RemovedTypesAtFormat | undefined;
	readonly removedTintTypes: RemovedTypesAtFormat | undefined;
}

/**
 * Refuse a normalized node type the target format no longer has. The client
 * removed these types outright, so writing them would produce a document
 * the target silently ignores; the refusal names the first format without
 * the type and the format the project targets.
 */
function assertTypeExistsAtFormat(
	removed: RemovedTypesAtFormat | undefined,
	type: string,
	kind: "special model type" | "tint source",
	field: string,
	context: ItemNodeVersionContext,
): void {
	if (removed === undefined || !removed.types.has(type)) {
		return;
	}
	const details: Record<string, unknown> = {
		field,
		type,
		since: removed.since,
		actualFormat: context.packFormat,
	};
	if (context.targetId !== undefined) {
		details.targetId = context.targetId;
	}
	throw new McAssetError(
		"RECIPE_VERSION_UNSUPPORTED",
		`Item ${kind} '${type}' at ${field} was removed in pack format ${removed.since}; the target uses ${context.packFormat}.`,
		details,
	);
}

/** Resource-location and type-name shapes for model references and node ids. */
const ITEM_NODE_RESOURCE_LOCATION = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/;
const ITEM_NODE_PATH = /^[a-z0-9/._-]+$/;
const ITEM_NODE_TYPE_NAME = /^[a-z0-9_./-]+$/;

function invalidItemNode(field: string, message: string): McAssetError {
	return new McAssetError("RECIPE_INVALID", message, { field });
}

function assertItemModelReference(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.startsWith("#") ||
		(!ITEM_NODE_RESOURCE_LOCATION.test(value) && !ITEM_NODE_PATH.test(value))
	) {
		throw invalidItemNode(
			field,
			`Item model reference at ${field} must be a model resource location.`,
		);
	}
	return value;
}

/**
 * A property field defaults only when it is absent. An explicit `null`,
 * number, array, or object is a type error: silently replacing it with the
 * default would write a branch the recipe did not ask for.
 */
function parseNodeProperty(
	value: unknown,
	field: string,
	fallback: string,
): string {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "string" || value.trim() === "") {
		throw invalidItemNode(
			`${field}.property`,
			`Item node property at ${field}.property must be a non-empty string.`,
		);
	}
	return value;
}

/**
 * Node and tint type ids may be written without a namespace; the game
 * resolves those to `minecraft:`. Normalize for one canonical rendering.
 */
function normalizeItemNodeType(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw invalidItemNode(
			field,
			`Item node type at ${field} must be a string.`,
		);
	}
	const trimmed = value.trim();
	const cut = trimmed.indexOf(":");
	const namespace = cut < 0 ? "minecraft" : trimmed.slice(0, cut);
	const name = cut < 0 ? trimmed : trimmed.slice(cut + 1);
	if (
		namespace !== "minecraft" ||
		!ITEM_NODE_TYPE_NAME.test(name) ||
		!ITEM_NODE_NAMES.has(name)
	) {
		throw invalidItemNode(
			field,
			`Unknown item model node type '${trimmed}' at ${field}; formatVersion 2 knows ${[...ITEM_NODE_NAMES].join(", ")}.`,
		);
	}
	return `minecraft:${name}`;
}

function normalizeTintType(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw invalidItemNode(
			field,
			`Item tint type at ${field} must be a string.`,
		);
	}
	const trimmed = value.trim();
	const cut = trimmed.indexOf(":");
	const namespace = cut < 0 ? "minecraft" : trimmed.slice(0, cut);
	const name = cut < 0 ? trimmed : trimmed.slice(cut + 1);
	if (namespace !== "minecraft" || !ITEM_NODE_TYPE_NAME.test(name)) {
		throw invalidItemNode(
			field,
			`Invalid item tint type '${trimmed}' at ${field}.`,
		);
	}
	return `minecraft:${name}`;
}

function parseTints(
	value: unknown,
	field: string,
	context: ItemNodeVersionContext,
): unknown[] {
	if (!Array.isArray(value)) {
		throw invalidItemNode(field, `"tints" at ${field} must be an array.`);
	}
	return value.map((entry, index) => {
		const at = `${field}.tints[${index}]`;
		if (!isJsonObject(entry)) {
			throw invalidItemNode(at, `Item tint at ${at} must be an object.`);
		}
		const type = normalizeTintType(entry.type, `${at}.type`);
		assertTypeExistsAtFormat(
			context.removedTintTypes,
			type,
			"tint source",
			`${at}.type`,
			context,
		);
		return {
			...entry,
			type,
		};
	});
}

function assertOnlyMembers(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	field: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			throw invalidItemNode(
				`${field}.${key}`,
				`Unknown field '${key}' at ${field}.`,
			);
		}
	}
}

function parseItemModelNode(
	value: unknown,
	field: string,
	refs: string[],
	context: ItemNodeVersionContext,
): Record<string, unknown> {
	if (typeof value === "string") {
		const model = assertItemModelReference(value, field);
		refs.push(model);
		return { type: "minecraft:model", model };
	}
	if (!isJsonObject(value)) {
		throw invalidItemNode(
			field,
			`Item model node at ${field} must be an object or a model string.`,
		);
	}

	const type = normalizeItemNodeType(value.type, `${field}.type`);
	const name = type.slice("minecraft:".length);

	switch (name) {
		case "model": {
			assertOnlyMembers(value, new Set(["type", "model", "tints"]), field);
			const model = assertItemModelReference(value.model, `${field}.model`);
			refs.push(model);
			const node: Record<string, unknown> = {
				type: "minecraft:model",
				model,
			};
			if (value.tints !== undefined) {
				node.tints = parseTints(value.tints, field, context);
			}
			return node;
		}
		case "composite": {
			assertOnlyMembers(value, new Set(["type", "models"]), field);
			if (!Array.isArray(value.models) || value.models.length === 0) {
				throw invalidItemNode(
					`${field}.models`,
					`A composite node at ${field} needs a non-empty "models" array.`,
				);
			}
			return {
				type,
				models: value.models.map((entry, index) =>
					parseItemModelNode(entry, `${field}.models[${index}]`, refs, context),
				),
			};
		}
		case "condition": {
			const node: Record<string, unknown> = {
				type,
				property: parseNodeProperty(value.property, field, "minecraft:damaged"),
				on_true: parseItemModelNode(
					value.on_true,
					`${field}.on_true`,
					refs,
					context,
				),
				on_false: parseItemModelNode(
					value.on_false,
					`${field}.on_false`,
					refs,
					context,
				),
			};
			copyPropertyArguments(node, value, field);
			return node;
		}
		case "select": {
			if (!Array.isArray(value.cases)) {
				throw invalidItemNode(
					`${field}.cases`,
					`A select node at ${field} needs a "cases" array.`,
				);
			}
			const cases = value.cases.map((entry, index) => {
				const at = `${field}.cases[${index}]`;
				if (!isJsonObject(entry)) {
					throw invalidItemNode(at, `Select case at ${at} must be an object.`);
				}
				assertOnlyMembers(entry, new Set(["when", "model"]), at);
				return {
					when: parseSelectWhen(entry.when, `${at}.when`),
					model: parseItemModelNode(entry.model, `${at}.model`, refs, context),
				};
			});
			const node: Record<string, unknown> = {
				type,
				property: parseNodeProperty(
					value.property,
					field,
					"minecraft:display_context",
				),
				cases,
				fallback: parseItemModelNode(
					value.fallback,
					`${field}.fallback`,
					refs,
					context,
				),
			};
			copyPropertyArguments(node, value, field);
			return node;
		}
		case "range_dispatch": {
			if (!Array.isArray(value.entries)) {
				throw invalidItemNode(
					`${field}.entries`,
					`A range_dispatch node at ${field} needs an "entries" array.`,
				);
			}
			const entries = value.entries.map((entry, index) => {
				const at = `${field}.entries[${index}]`;
				if (!isJsonObject(entry)) {
					throw invalidItemNode(at, `Range entry at ${at} must be an object.`);
				}
				assertOnlyMembers(entry, new Set(["threshold", "model"]), at);
				if (
					typeof entry.threshold !== "number" ||
					!Number.isFinite(entry.threshold)
				) {
					throw invalidItemNode(
						`${at}.threshold`,
						`Range entry threshold at ${at} must be a number.`,
					);
				}
				return {
					threshold: entry.threshold,
					model: parseItemModelNode(entry.model, `${at}.model`, refs, context),
				};
			});
			const node: Record<string, unknown> = {
				type,
				property: parseNodeProperty(value.property, field, "minecraft:damage"),
				entries,
				fallback: parseItemModelNode(
					value.fallback,
					`${field}.fallback`,
					refs,
					context,
				),
			};
			copyPropertyArguments(node, value, field);
			return node;
		}
		case "special": {
			assertOnlyMembers(value, new Set(["type", "base", "model"]), field);
			const base = assertItemModelReference(value.base, `${field}.base`);
			if (!isJsonObject(value.model)) {
				throw invalidItemNode(
					`${field}.model`,
					`A special node at ${field} needs a renderer "model" object.`,
				);
			}
			const rendererType = normalizeSpecialRendererType(
				value.model.type,
				`${field}.model.type`,
			);
			assertTypeExistsAtFormat(
				context.removedSpecialModelTypes,
				rendererType,
				"special model type",
				`${field}.model.type`,
				context,
			);
			refs.push(base);
			return {
				type,
				base,
				model: { ...value.model, type: rendererType },
			};
		}
		case "empty":
			assertOnlyMembers(value, new Set(["type"]), field);
			return { type };
		case "bundle/selected_item":
			assertOnlyMembers(value, new Set(["type"]), field);
			return { type };
		default:
			throw invalidItemNode(field, `Unknown item model node at ${field}.`);
	}
}

function parseSelectWhen(value: unknown, field: string): string | string[] {
	if (typeof value === "string") {
		if (value.trim() === "") {
			throw invalidItemNode(field, `Select case "when" at ${field} is empty.`);
		}
		return value;
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw invalidItemNode(
			field,
			`Select case "when" at ${field} must be a string or a non-empty string array.`,
		);
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim() === "") {
			throw invalidItemNode(
				`${field}[${index}]`,
				`Select case value at ${field}[${index}] must be a non-empty string.`,
			);
		}
		return entry;
	});
}

function copyPropertyArguments(
	node: Record<string, unknown>,
	source: Record<string, unknown>,
	field: string,
): void {
	for (const [key, value] of Object.entries(source)) {
		if (key === "type" || key === "property") continue;
		if (
			key === "on_true" ||
			key === "on_false" ||
			key === "cases" ||
			key === "fallback" ||
			key === "entries"
		) {
			continue;
		}
		if (
			key === "tints" ||
			key === "model" ||
			key === "models" ||
			key === "base" ||
			key === "threshold" ||
			key === "when"
		) {
			throw invalidItemNode(
				`${field}.${key}`,
				`Field '${key}' is not a property argument at ${field}.`,
			);
		}
		node[key] = value;
	}
}

/**
 * Renderer type names come from the client's special-model registry, which
 * grows between releases. Accept any minecraft type id and carry the
 * renderer fields verbatim; the game owns their meaning and the reference
 * graph deliberately does not interpret them.
 */
function normalizeSpecialRendererType(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw invalidItemNode(
			field,
			`Special renderer type at ${field} must be a string.`,
		);
	}
	const trimmed = value.trim();
	const cut = trimmed.indexOf(":");
	const namespace = cut < 0 ? "minecraft" : trimmed.slice(0, cut);
	const name = cut < 0 ? trimmed : trimmed.slice(cut + 1);
	if (namespace !== "minecraft" || !ITEM_NODE_TYPE_NAME.test(name)) {
		throw invalidItemNode(
			field,
			`Invalid special renderer type '${trimmed}' at ${field}.`,
		);
	}
	return `minecraft:${name}`;
}

export interface ItemDefinitionModelDocument {
	/** The built `items/*.json` document. */
	readonly document: Record<string, unknown>;
	/** Every model the definition points at, including nested nodes. */
	readonly refs: readonly string[];
}

/**
 * Build a formatVersion 2 item definition from the recursive node grammar.
 *
 * Every model reference is collected while the tree is built, so the
 * planner can refuse dangling references before anything is written. Tint
 * entries keep their subtype fields verbatim: the client jar is the source
 * for the node set, but tint subtype semantics live in the version's
 * registry and are not re-implemented here. Node and tint types the target
 * format has removed are refused with RECIPE_VERSION_UNSUPPORTED.
 */
export function buildItemDefinitionDocumentV2(
	definition: Record<string, unknown> | undefined,
	defaultModel: string,
	version: ItemDefinitionV2Version,
): ItemDefinitionModelDocument {
	if (definition === undefined) {
		return {
			document: buildSimpleItemDefinition({ model: defaultModel }),
			refs: [defaultModel],
		};
	}
	const context: ItemNodeVersionContext = {
		packFormat: version.packFormat,
		targetId: version.targetId,
		removedSpecialModelTypes: removedTypesAtFormat(
			REMOVED_SPECIAL_MODEL_TYPES_FACT,
			version.packFormat,
		),
		removedTintTypes: removedTypesAtFormat(
			REMOVED_ITEM_TINT_TYPES_FACT,
			version.packFormat,
		),
	};
	const refs: string[] = [];
	const model = parseItemModelNode(definition, "model", refs, context);
	return { document: { model }, refs };
}
