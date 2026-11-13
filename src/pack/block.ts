/**
 * Block authoring for pack recipes: the common vanilla parent-model presets,
 * the strict shape of the `blockModel` and `blockstate` steps, and the JSON
 * documents they write.
 *
 * The model document itself is built by `src/model/export.ts` (the same
 * typed-spec path `model create` uses) and blockstates by
 * `src/model/binding.ts`; this module only expands recipe declarations into
 * those inputs and keeps the pack's canonical JSON rendering.
 */

import { McAssetError } from "../core/errors.ts";
import { modelSpecSchema } from "../mcp/schema.ts";
import {
	type BlockstateBindingSpec,
	type BlockstateEntrySpec,
	buildBlockstate,
} from "../model/binding.ts";
import { buildModelDocument } from "../model/export.ts";
import type { ModelSpec } from "../model/types.ts";
import type { ModelRules } from "../model/versions.ts";
import { validateResourceLocation } from "../validate/resource-location.ts";
import {
	canonicalDocumentText,
	isJsonObject,
	requirePlainAssetName,
} from "./document.ts";
import { buildSimpleItemDefinition } from "./item-templates.ts";
import type { RecipeStep } from "./recipe.ts";

interface BlockModelPreset {
	/** The vanilla parent this preset names. */
	readonly parent: string;
	/** Texture variables the parent model actually reads. */
	readonly required: readonly string[];
	/** Extra texture variables the child may set (particle, optional overrides). */
	readonly optional: readonly string[];
}

/**
 * Common block parents, verified in the 1.21.4 client jar (pack format
 * 46.0). Each parent's texture variables were read from the vanilla model
 * document, not guessed; a preset requires exactly those variables and
 * accepts only the listed optional extras.
 */
const BLOCK_MODEL_PRESETS: Readonly<Record<string, BlockModelPreset>> = {
	cube: {
		parent: "minecraft:block/cube",
		required: ["down", "up", "north", "south", "east", "west"],
		optional: ["particle"],
	},
	cube_all: {
		parent: "minecraft:block/cube_all",
		required: ["all"],
		optional: ["particle"],
	},
	cube_column: {
		parent: "minecraft:block/cube_column",
		required: ["end", "side"],
		optional: ["particle"],
	},
	cube_bottom_top: {
		parent: "minecraft:block/cube_bottom_top",
		required: ["bottom", "top", "side"],
		optional: ["particle"],
	},
	orientable: {
		parent: "minecraft:block/orientable",
		required: ["front", "side", "top"],
		optional: ["bottom", "particle"],
	},
	cross: {
		parent: "minecraft:block/cross",
		required: ["cross"],
		optional: ["particle"],
	},
	slab: {
		parent: "minecraft:block/slab",
		required: ["side", "bottom", "top"],
		optional: ["particle"],
	},
	stairs: {
		parent: "minecraft:block/stairs",
		required: ["side", "bottom", "top"],
		optional: ["particle"],
	},
};

const BLOCK_MODEL_STEP_FIELDS: ReadonlySet<string> = new Set([
	"type",
	"item",
	"parent",
	"textures",
	"modelSpec",
	"override",
]);

const BLOCKSTATE_STEP_FIELDS: ReadonlySet<string> = new Set([
	"type",
	"block",
	"variants",
	"multipart",
	"override",
]);

const BLOCKSTATE_ENTRY_FIELDS: ReadonlySet<string> = new Set([
	"model",
	"x",
	"y",
	"z",
	"uvlock",
	"weight",
]);

const MULTIPART_FIELDS: ReadonlySet<string> = new Set(["when", "apply"]);

const RESOURCE_LOCATION = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/;
const TEXTURE_VARIABLE = /^[a-z0-9_.-]+$/;

function stepFailure(
	targetId: string,
	stepType: string,
	field: string,
	message: string,
	details: Record<string, unknown> = {},
): McAssetError {
	return new McAssetError("RECIPE_INVALID", message, {
		targetId,
		stepType,
		field,
		...details,
	});
}

function assertStepFields(
	step: RecipeStep,
	allowed: ReadonlySet<string>,
	targetId: string,
	stepType: string,
): void {
	for (const key of Object.keys(step)) {
		if (!allowed.has(key)) {
			throw stepFailure(
				targetId,
				stepType,
				key,
				`Unknown field '${key}' in ${stepType} step for target '${targetId}'.`,
			);
		}
	}
}

function parseOverride(
	value: unknown,
	targetId: string,
	stepType: string,
): boolean {
	if (value === undefined) {
		return false;
	}
	if (typeof value !== "boolean") {
		throw stepFailure(
			targetId,
			stepType,
			"override",
			`${stepType} step 'override' must be a boolean.`,
		);
	}
	return value;
}

function normalizeParent(value: unknown, targetId: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw stepFailure(
			targetId,
			"blockModel",
			"parent",
			`blockModel step needs a non-empty parent string for target '${targetId}'.`,
		);
	}
	const trimmed = value.trim();
	if (trimmed.includes(":")) {
		if (!RESOURCE_LOCATION.test(trimmed)) {
			throw stepFailure(
				targetId,
				"blockModel",
				"parent",
				`Invalid parent resource location '${trimmed}' for target '${targetId}'.`,
			);
		}
		return trimmed;
	}
	const namespaced = `minecraft:${trimmed}`;
	if (!RESOURCE_LOCATION.test(namespaced)) {
		throw stepFailure(
			targetId,
			"blockModel",
			"parent",
			`Invalid parent resource location '${trimmed}' for target '${targetId}'.`,
		);
	}
	return namespaced;
}

function parseBlockTextures(
	raw: unknown,
	required: readonly string[],
	optional: readonly string[],
	targetId: string,
	parent: string,
): Record<string, string> {
	if (!isJsonObject(raw)) {
		throw stepFailure(
			targetId,
			"blockModel",
			"textures",
			`blockModel preset '${parent}' needs a textures object for target '${targetId}'.`,
		);
	}
	const allowed = new Set([...required, ...optional]);
	const textures: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!TEXTURE_VARIABLE.test(name)) {
			throw stepFailure(
				targetId,
				"blockModel",
				`textures.${name}`,
				`Invalid texture variable '${name}' for target '${targetId}'.`,
			);
		}
		if (!allowed.has(name)) {
			throw stepFailure(
				targetId,
				"blockModel",
				`textures.${name}`,
				`Texture variable '${name}' is not used by block model preset '${parent}' for target '${targetId}'.`,
			);
		}
		if (typeof value !== "string" || value.trim() === "") {
			throw stepFailure(
				targetId,
				"blockModel",
				`textures.${name}`,
				`Texture '${name}' must be a non-empty string for target '${targetId}'.`,
			);
		}
		textures[name] = value;
	}
	for (const name of required) {
		if (!(name in textures)) {
			throw stepFailure(
				targetId,
				"blockModel",
				`textures.${name}`,
				`blockModel preset '${parent}' needs texture '${name}' for target '${targetId}'.`,
			);
		}
	}
	for (const [name, value] of Object.entries(textures)) {
		if (!value.startsWith("#")) {
			continue;
		}
		const alias = value.slice(1);
		if (!(alias in textures)) {
			throw stepFailure(
				targetId,
				"blockModel",
				`textures.${name}`,
				`Texture alias '${value}' has no target in the same step for target '${targetId}'.`,
			);
		}
	}
	return textures;
}

function parseLooseTextures(
	raw: unknown,
	targetId: string,
): Record<string, string> {
	if (!isJsonObject(raw)) {
		throw stepFailure(
			targetId,
			"blockModel",
			"textures",
			`blockModel textures must be an object for target '${targetId}'.`,
		);
	}
	const textures: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!TEXTURE_VARIABLE.test(name)) {
			throw stepFailure(
				targetId,
				"blockModel",
				`textures.${name}`,
				`Invalid texture variable '${name}' for target '${targetId}'.`,
			);
		}
		if (typeof value !== "string" || value.trim() === "") {
			throw stepFailure(
				targetId,
				"blockModel",
				`textures.${name}`,
				`Texture '${name}' must be a non-empty string for target '${targetId}'.`,
			);
		}
		textures[name] = value;
	}
	for (const [name, value] of Object.entries(textures)) {
		if (!value.startsWith("#")) {
			continue;
		}
		const alias = value.slice(1);
		if (!(alias in textures)) {
			throw stepFailure(
				targetId,
				"blockModel",
				`textures.${name}`,
				`Texture alias '${value}' has no target in the same step for target '${targetId}'.`,
			);
		}
	}
	return textures;
}

function parseModelSpec(raw: unknown, targetId: string): ModelSpec {
	const parsed = modelSpecSchema.safeParse(raw);
	if (!parsed.success) {
		throw stepFailure(
			targetId,
			"blockModel",
			"modelSpec",
			`blockModel modelSpec is not a valid model description for target '${targetId}'.`,
			{
				issues: parsed.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			},
		);
	}
	return parsed.data as ModelSpec;
}

export type BlockModelStepSpec =
	| {
			readonly kind: "parent";
			readonly blockId: string;
			readonly override: boolean;
			readonly parent: string;
			readonly textures: Readonly<Record<string, string>>;
	  }
	| {
			readonly kind: "modelSpec";
			readonly blockId: string;
			readonly override: boolean;
			readonly modelSpec: ModelSpec;
	  };

/** Parse and validate a `blockModel` recipe step. */
export function parseBlockModelStep(
	step: RecipeStep,
	targetId: string,
): BlockModelStepSpec {
	assertStepFields(step, BLOCK_MODEL_STEP_FIELDS, targetId, "blockModel");
	const blockId = requirePlainAssetName(
		step.item ?? targetId,
		"item",
		targetId,
	);
	const override = parseOverride(step.override, targetId, "blockModel");
	const hasParent = step.parent !== undefined;
	const hasSpec = step.modelSpec !== undefined;
	if (hasParent === hasSpec) {
		throw stepFailure(
			targetId,
			"blockModel",
			hasParent ? "modelSpec" : "parent",
			`blockModel step needs exactly one of parent or modelSpec for target '${targetId}'.`,
		);
	}
	if (hasSpec) {
		return {
			kind: "modelSpec",
			blockId,
			override,
			modelSpec: parseModelSpec(step.modelSpec, targetId),
		};
	}
	const rawParent = typeof step.parent === "string" ? step.parent.trim() : "";
	const preset = BLOCK_MODEL_PRESETS[rawParent];
	if (preset !== undefined) {
		return {
			kind: "parent",
			blockId,
			override,
			parent: preset.parent,
			textures: parseBlockTextures(
				step.textures,
				preset.required,
				preset.optional,
				targetId,
				rawParent,
			),
		};
	}
	return {
		kind: "parent",
		blockId,
		override,
		parent: normalizeParent(step.parent, targetId),
		textures:
			step.textures === undefined
				? {}
				: parseLooseTextures(step.textures, targetId),
	};
}

/**
 * Map model-layer failures onto the recipe vocabulary: a format gate is
 * RECIPE_VERSION_UNSUPPORTED, any other malformed model is RECIPE_INVALID.
 */
function translateModelFailure(
	error: unknown,
	targetId: string,
	stepType: string,
): never {
	if (error instanceof McAssetError) {
		const details = isJsonObject(error.details) ? error.details : {};
		if (error.code === "MODEL_UNSUPPORTED_VERSION") {
			throw new McAssetError("RECIPE_VERSION_UNSUPPORTED", error.message, {
				...details,
				targetId,
				stepType,
				...(typeof details.target === "string"
					? { actualFormat: details.target }
					: {}),
			});
		}
		if (error.code.startsWith("MODEL_")) {
			throw new McAssetError("RECIPE_INVALID", error.message, {
				...details,
				targetId,
				stepType,
			});
		}
	}
	throw error;
}

function buildBlockModelSpecText(
	spec: BlockModelStepSpec,
	rules: ModelRules,
	targetId: string,
): string {
	const modelSpec: ModelSpec =
		spec.kind === "modelSpec"
			? spec.modelSpec
			: spec.textures !== undefined && Object.keys(spec.textures).length > 0
				? { parent: spec.parent, textures: spec.textures }
				: { parent: spec.parent };
	try {
		return canonicalDocumentText(
			JSON.parse(buildModelDocument(modelSpec, rules).text) as unknown,
		);
	} catch (error) {
		translateModelFailure(error, targetId, "blockModel");
	}
}

/** The block model document (`models/block/<id>.json`). */
export function buildBlockModelText(
	spec: BlockModelStepSpec,
	rules: ModelRules,
	targetId: string,
): string {
	return buildBlockModelSpecText(spec, rules, targetId);
}

/** The matching block item model (`models/item/<id>.json`). */
export function buildBlockItemModelText(
	spec: BlockModelStepSpec,
	namespace: string,
): string {
	return canonicalDocumentText({
		parent: `${namespace}:block/${spec.blockId}`,
	});
}

/** The matching block item definition (`items/<id>.json`). */
export function buildBlockItemDefinitionText(
	spec: BlockModelStepSpec,
	namespace: string,
): string {
	return canonicalDocumentText(
		buildSimpleItemDefinition({
			model: `${namespace}:item/${spec.blockId}`,
		}),
	);
}

export interface BlockstateStepSpec {
	readonly blockId: string;
	readonly override: boolean;
	readonly binding: BlockstateBindingSpec;
}

function assertBlockstateEntry(
	value: unknown,
	targetId: string,
	field: string,
): asserts value is BlockstateEntrySpec {
	if (!isJsonObject(value)) {
		throw stepFailure(
			targetId,
			"blockstate",
			field,
			`Blockstate entry at ${field} must be an object.`,
		);
	}
	for (const key of Object.keys(value)) {
		if (!BLOCKSTATE_ENTRY_FIELDS.has(key)) {
			throw stepFailure(
				targetId,
				"blockstate",
				`${field}.${key}`,
				`Unknown field '${key}' in blockstate entry at ${field}.`,
			);
		}
	}
	if (typeof value.model !== "string" || value.model.trim() === "") {
		throw stepFailure(
			targetId,
			"blockstate",
			`${field}.model`,
			`Blockstate entry at ${field} needs a non-empty model.`,
		);
	}
	const modelFindings = validateResourceLocation(value.model).filter(
		(finding) => finding.level === "error",
	);
	if (modelFindings.length > 0) {
		throw stepFailure(
			targetId,
			"blockstate",
			`${field}.model`,
			`Blockstate entry at ${field} has an unusable model reference '${value.model}'.`,
			{
				model: value.model,
				issues: modelFindings.map((finding) => finding.code),
			},
		);
	}
	if (value.uvlock !== undefined && typeof value.uvlock !== "boolean") {
		throw stepFailure(
			targetId,
			"blockstate",
			`${field}.uvlock`,
			`Blockstate entry at ${field} must declare "uvlock" as a boolean.`,
		);
	}
}

/** Parse and validate a `blockstate` recipe step. */
export function parseBlockstateStep(
	step: RecipeStep,
	targetId: string,
): BlockstateStepSpec {
	assertStepFields(step, BLOCKSTATE_STEP_FIELDS, targetId, "blockstate");
	const blockId = requirePlainAssetName(
		step.block ?? targetId,
		"block",
		targetId,
	);
	const override = parseOverride(step.override, targetId, "blockstate");
	const hasVariants = step.variants !== undefined;
	const hasMultipart = step.multipart !== undefined;
	if (hasVariants === hasMultipart) {
		throw stepFailure(
			targetId,
			"blockstate",
			hasVariants ? "multipart" : "variants",
			`blockstate step needs exactly one of variants or multipart for target '${targetId}'.`,
		);
	}

	if (hasVariants) {
		if (!isJsonObject(step.variants)) {
			throw stepFailure(
				targetId,
				"blockstate",
				"variants",
				`blockstate variants must be an object for target '${targetId}'.`,
			);
		}
		for (const [key, value] of Object.entries(step.variants)) {
			const at = key === "" ? "variants" : `variants.${key}`;
			if (Array.isArray(value)) {
				for (const [index, entry] of value.entries()) {
					assertBlockstateEntry(entry, targetId, `${at}[${index}]`);
				}
			} else {
				assertBlockstateEntry(value, targetId, at);
			}
		}
		return {
			blockId,
			override,
			binding: {
				blockId,
				variants: step.variants as Readonly<
					Record<string, BlockstateEntrySpec | readonly BlockstateEntrySpec[]>
				>,
			},
		};
	}

	if (!Array.isArray(step.multipart)) {
		throw stepFailure(
			targetId,
			"blockstate",
			"multipart",
			`blockstate multipart must be an array for target '${targetId}'.`,
		);
	}
	for (const [index, part] of step.multipart.entries()) {
		const at = `multipart[${index}]`;
		if (!isJsonObject(part)) {
			throw stepFailure(
				targetId,
				"blockstate",
				at,
				`Multipart part at ${at} must be an object.`,
			);
		}
		for (const key of Object.keys(part)) {
			if (!MULTIPART_FIELDS.has(key)) {
				throw stepFailure(
					targetId,
					"blockstate",
					`${at}.${key}`,
					`Unknown field '${key}' in multipart part at ${at}.`,
				);
			}
		}
		if (part.when !== undefined) {
			if (!isJsonObject(part.when)) {
				throw stepFailure(
					targetId,
					"blockstate",
					`${at}.when`,
					`Multipart "when" at ${at} must be an object.`,
				);
			}
			for (const [property, value] of Object.entries(part.when)) {
				if (typeof value !== "string" && typeof value !== "boolean") {
					throw stepFailure(
						targetId,
						"blockstate",
						`${at}.when.${property}`,
						`Multipart condition '${property}' at ${at} must be a string or boolean.`,
					);
				}
			}
		}
		if (part.apply === undefined) {
			throw stepFailure(
				targetId,
				"blockstate",
				`${at}.apply`,
				`Multipart part at ${at} needs an apply entry.`,
			);
		}
		if (Array.isArray(part.apply)) {
			for (const [applyIndex, entry] of part.apply.entries()) {
				assertBlockstateEntry(entry, targetId, `${at}.apply[${applyIndex}]`);
			}
		} else {
			assertBlockstateEntry(part.apply, targetId, `${at}.apply`);
		}
	}
	return {
		blockId,
		override,
		binding: {
			blockId,
			multipart: step.multipart as unknown as NonNullable<
				BlockstateBindingSpec["multipart"]
			>,
		},
	};
}

/** The blockstate document (`blockstates/<id>.json`). */
export function buildBlockstateText(
	spec: BlockstateStepSpec,
	rules: ModelRules,
	targetId: string,
): string {
	try {
		const built = buildBlockstate(spec.binding, rules);
		return canonicalDocumentText(JSON.parse(built.text) as unknown);
	} catch (error) {
		translateModelFailure(error, targetId, "blockstate");
	}
}
