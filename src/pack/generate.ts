/**
 * Generator-backed recipe steps: entity texture templates, equipment
 * definitions, icon fonts, and particle definitions.
 *
 * A step is a thin declaration in front of the single-asset planner that
 * already owns the format, so a pack build and a standalone run of the same
 * generator produce identical bytes. Planning happens before the first write
 * and returns every output with its bytes, which lets the build classify
 * own-clean, own-modified, and foreign files and keep the lock complete.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import {
	canonicalEntityLayoutId,
	type EntityLayout,
	getEntityLayoutDocument,
	resolveEntityLayoutDocument,
} from "../entity/index.ts";
import { buildEntityTemplate } from "../entity/template.ts";
import type { EquipmentLayerRequest } from "../equipment/index.ts";
import { planEquipmentAsset } from "../equipment/index.ts";
import {
	type FontGlyphSource,
	type FontSpec,
	type FontSpecIcon,
	parseFontSpec,
	planFont,
} from "../font/index.ts";
import { decodeImage } from "../io/decode.ts";
import { encodePng } from "../io/png.ts";
import { parseMcpx, serializeMcpx } from "../mcpx/index.ts";
import { planParticleAsset } from "../particle/index.ts";
import { loadParticleFrames } from "../particle/load.ts";
import { PACK_BUILD_MAX_DECODED_PIXELS } from "./budget.ts";
import { isJsonObject, isRelativeProjectPath } from "./document.ts";
import type { RecipeStep } from "./recipe.ts";

/** Step types that delegate to a single-asset generator. */
export const GENERATED_STEP_TYPES: ReadonlySet<string> = new Set([
	"entityTemplate",
	"equipment",
	"font",
	"particle",
]);

/** Lock kinds a generator-backed step writes. */
export type GeneratedOutputKind =
	| "entityTemplate"
	| "entityTemplateSource"
	| "equipmentDefinition"
	| "equipmentTexture"
	| "fontDefinition"
	| "fontAtlas"
	| "fontTable"
	| "particleDefinition"
	| "particleTexture";

/** The file extension each generated family writes. */
const EXTENSION_BY_KIND: Readonly<
	Record<GeneratedOutputKind, ".png" | ".json" | ".mcpx">
> = {
	entityTemplate: ".png",
	entityTemplateSource: ".mcpx",
	equipmentDefinition: ".json",
	equipmentTexture: ".png",
	fontDefinition: ".json",
	fontAtlas: ".png",
	fontTable: ".json",
	particleDefinition: ".json",
	particleTexture: ".png",
};

/** One file a step produces, with the bytes fixed before any write. */
export interface GeneratedOutput {
	/** Path relative to its anchor: the output directory or the project root. */
	readonly relativePath: string;
	readonly kind: GeneratedOutputKind;
	readonly extension: ".png" | ".json" | ".mcpx";
	/** `pack` anchors below the output directory, `project` below the project root. */
	readonly scope: "pack" | "project";
	readonly bytes: Uint8Array;
}

function generatedOutput(
	relativePath: string,
	kind: GeneratedOutputKind,
	bytes: Uint8Array,
	scope: "pack" | "project" = "pack",
): GeneratedOutput {
	return {
		relativePath,
		kind,
		extension: EXTENSION_BY_KIND[kind],
		scope,
		bytes,
	};
}

/** One input file a step read, recorded in the target input hash. */
export interface GeneratedInput {
	/** Declared reference, never an absolute path. */
	readonly ref: string;
	readonly sha256: string;
	/** Absolute path of the file, for the write preflight's alias check. */
	readonly filePath?: string | undefined;
}

/** Everything one generator-backed step plans. */
export interface GeneratedStepPlan {
	readonly outputs: readonly GeneratedOutput[];
	readonly inputs: readonly GeneratedInput[];
	/** Bytes of every source file the step read. */
	readonly sourceBytes: number;
	/**
	 * Decoded source-image pixels plus pixels of the canvases this step holds:
	 * template and atlas buffers the build must charge to its memory budget.
	 */
	readonly decodedPixels: number;
}

/** What a generator-backed step needs from the project being planned. */
export interface GeneratedStepContext {
	readonly targetId: string;
	readonly stepIndex: number;
	readonly step: RecipeStep;
	/** Project namespace; generator output must stay inside it. */
	readonly namespace: string;
	/** Normalized resource-pack format of the project. */
	readonly packFormat: string;
	/** Directory holding the recipe document, the base for relative paths. */
	readonly recipeDir: string;
}

/**
 * Replaceable intake for the particle frames. Production always uses the real
 * loader; the seam lets a test change the source files between decoding and
 * hashing to prove the plan records the bytes it decoded.
 */
export interface GeneratedStepDependencies {
	readonly loadParticleFrames?: typeof loadParticleFrames | undefined;
}

const ENTITY_TEMPLATE_FIELDS: ReadonlySet<string> = new Set([
	"type",
	"layout",
	"output",
	"mcpxOutput",
	"fill",
	"override",
]);

const EQUIPMENT_FIELDS: ReadonlySet<string> = new Set([
	"type",
	"id",
	"layers",
	"template",
	"fill",
	"override",
]);

const EQUIPMENT_LAYER_FIELDS: ReadonlySet<string> = new Set([
	"type",
	"texture",
	"dyeable",
	"usePlayerTexture",
]);

const EQUIPMENT_DYEABLE_FIELDS: ReadonlySet<string> = new Set([
	"colorWhenUndyed",
]);

const FONT_FIELDS: ReadonlySet<string> = new Set([
	"type",
	"spec",
	"table",
	"override",
]);

const PARTICLE_FIELDS: ReadonlySet<string> = new Set([
	"type",
	"id",
	"frames",
	"texturePrefix",
	"override",
]);

const TEXT_ENCODER = new TextEncoder();

/**
 * Files the build owns at the project root. A generator step writes its
 * pack files below the output directory and, for the font table, a document
 * below the project root; that project-level path must never name the build's
 * own lock or the project document, or the later lock write would silently
 * replace the step's output.
 */
const RESERVED_PROJECT_OUTPUTS: ReadonlySet<string> = new Set([
	"mc-asset.lock.json",
	"mc-asset.pack.json",
]);

function assertProjectOutputAllowed(
	output: GeneratedOutput,
	context: GeneratedStepContext,
): void {
	if (output.scope !== "project") {
		return;
	}
	const normalized = output.relativePath
		.split("/")
		.filter((segment) => segment !== ".")
		.join("/")
		.toLowerCase();
	if (!RESERVED_PROJECT_OUTPUTS.has(normalized)) {
		return;
	}
	stepFailure(
		context,
		output.kind === "fontTable" ? "table" : "output",
		`${context.step.type} step output '${output.relativePath}' is reserved for the project documents.`,
		{ value: output.relativePath },
	);
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** A refusal that names the step, the target, and the offending field. */
function stepFailure(
	context: GeneratedStepContext,
	field: string,
	message: string,
	extra: Record<string, unknown> = {},
): never {
	throw new McAssetError("RECIPE_INVALID", message, {
		targetId: context.targetId,
		stepType: context.step.type,
		stepIndex: context.stepIndex,
		field,
		...extra,
	});
}

/** Refuse a step that names a field its type does not define. */
function assertStepFields(
	step: RecipeStep,
	allowed: ReadonlySet<string>,
	context: GeneratedStepContext,
): void {
	for (const key of Object.keys(step)) {
		if (!allowed.has(key)) {
			stepFailure(
				context,
				key,
				`Unknown field '${key}' in ${step.type} step for target '${context.targetId}'.`,
			);
		}
	}
}

/**
 * A step that reads images stops once its own decoded pixels pass the public
 * pack budget. Without this, a directory of large frames would all be held in
 * memory before the build's total check could refuse the plan; the total is
 * still checked across every target once the step returns.
 */
function assertDecodedPixelBudget(
	context: GeneratedStepContext,
	decodedPixels: number,
): void {
	if (decodedPixels > PACK_BUILD_MAX_DECODED_PIXELS) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`${context.step.type} step decodes ${decodedPixels} pixels, over the budget of ${PACK_BUILD_MAX_DECODED_PIXELS}.`,
			{
				limit: PACK_BUILD_MAX_DECODED_PIXELS,
				actual: decodedPixels,
				targetId: context.targetId,
				stepType: context.step.type,
				stepIndex: context.stepIndex,
			},
		);
	}
}

/**
 * A boolean step field. `undefined` keeps the generator's own default; any
 * other value must be a boolean, because `false` is meaningful and a truthy
 * string would silently change the output.
 */
function optionalBoolean(
	value: unknown,
	field: string,
	context: GeneratedStepContext,
	fallback: boolean,
): boolean {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		stepFailure(
			context,
			field,
			`${context.step.type} step field '${field}' must be a boolean for target '${context.targetId}'.`,
		);
	}
	return value;
}

/**
 * A declared output path: relative to the project output directory, slash
 * separated, inside that directory, and carrying the expected extension.
 */
function declaredOutputPath(
	value: unknown,
	field: string,
	context: GeneratedStepContext,
	extension: string,
): string {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		!isRelativeProjectPath(value) ||
		value.startsWith("..") ||
		!value.endsWith(extension)
	) {
		stepFailure(
			context,
			field,
			`${context.step.type} step field '${field}' must be a relative path ending in ${extension} for target '${context.targetId}'.`,
			{ value },
		);
	}
	return value;
}

/**
 * `override` as every document step reads it: absent means false, and a
 * generator step that writes into the `minecraft` namespace needs the opt-in
 * just like a `model` or `itemDefinition` step does.
 */
function parseOverride(value: unknown, context: GeneratedStepContext): boolean {
	if (value !== undefined && typeof value !== "boolean") {
		stepFailure(
			context,
			"override",
			`${context.step.type} step field 'override' must be a boolean for target '${context.targetId}'.`,
		);
	}
	const override = value === true;
	if (context.namespace === "minecraft" && !override) {
		stepFailure(
			context,
			"override",
			`${context.step.type} step in the minecraft namespace requires override: true for target '${context.targetId}'.`,
		);
	}
	return override;
}

/**
 * Map a generator's own refusal onto the recipe vocabulary. Version gates stay
 * `RECIPE_VERSION_UNSUPPORTED`; every other malformed input becomes
 * `RECIPE_INVALID`; the original code is kept as `cause`.
 */
const GENERATOR_VERSION_CODES: ReadonlySet<string> = new Set([
	"ENTITY_LAYOUT_UNSUPPORTED_VERSION",
	"EQUIPMENT_VERSION_UNSUPPORTED",
]);

const PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
	"RESOURCE_LIMIT_EXCEEDED",
]);

function translateGeneratorFailure(
	error: unknown,
	context: GeneratedStepContext,
): never {
	if (error instanceof McAssetError) {
		const details = isJsonObject(error.details) ? error.details : {};
		const unsupportedVersion = GENERATOR_VERSION_CODES.has(error.code);
		const passthrough = PASSTHROUGH_CODES.has(error.code);
		const code = passthrough
			? error.code
			: unsupportedVersion
				? "RECIPE_VERSION_UNSUPPORTED"
				: error.code === "FILESYSTEM_ERROR"
					? "RECIPE_SOURCE_MISSING"
					: "RECIPE_INVALID";
		throw new McAssetError(code, error.message, {
			...details,
			targetId: context.targetId,
			stepType: context.step.type,
			stepIndex: context.stepIndex,
			cause: error.code,
		});
	}
	throw error;
}

/** Read a declared source file, refusing with the recipe source vocabulary. */
function readSourceText(
	path: string,
	declared: string,
	context: GeneratedStepContext,
	field: string,
): { readonly text: string; readonly bytes: Uint8Array } {
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(readFileSync(path));
	} catch {
		throw new McAssetError(
			"RECIPE_SOURCE_MISSING",
			`Source file not found: ${declared}`,
			{
				path: declared,
				targetId: context.targetId,
				stepType: context.step.type,
				stepIndex: context.stepIndex,
				field,
			},
		);
	}
	return {
		text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
		bytes,
	};
}

/** Parse a layout document read from a file or an inline declaration. */
function loadEntityLayout(context: GeneratedStepContext): {
	layout: EntityLayout;
	input?: GeneratedInput;
	sourceBytes: number;
} {
	const raw = context.step.layout;
	if (raw === undefined) {
		return {
			layout: resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_wide"),
			),
			sourceBytes: 0,
		};
	}
	if (typeof raw !== "string" || raw.trim() === "") {
		stepFailure(
			context,
			"layout",
			`entityTemplate step field 'layout' must be a builtin layout id or a layout .json path for target '${context.targetId}'.`,
			{ value: raw },
		);
	}
	const builtin = canonicalEntityLayoutId(raw);
	if (builtin !== undefined) {
		return {
			layout: resolveEntityLayoutDocument(getEntityLayoutDocument(builtin)),
			sourceBytes: 0,
		};
	}
	const path = resolve(context.recipeDir, raw);
	const source = readSourceText(path, raw, context, "layout");
	let value: unknown;
	try {
		value = JSON.parse(source.text) as unknown;
	} catch {
		throw new McAssetError(
			"RECIPE_INVALID",
			`Entity layout is not valid JSON: ${raw}.`,
			{
				path: raw,
				targetId: context.targetId,
				stepType: context.step.type,
				stepIndex: context.stepIndex,
				field: "layout",
			},
		);
	}
	let layout: EntityLayout;
	try {
		layout = resolveEntityLayoutDocument(value);
	} catch (error) {
		translateGeneratorFailure(error, context);
	}
	return {
		layout,
		input: {
			ref: `entity-layout:${raw}`,
			sha256: sha256Hex(source.bytes),
		},
		sourceBytes: source.bytes.length,
	};
}

function planEntityTemplate(context: GeneratedStepContext): GeneratedStepPlan {
	const step = context.step;
	assertStepFields(step, ENTITY_TEMPLATE_FIELDS, context);
	parseOverride(step.override, context);
	const fill = optionalBoolean(step.fill, "fill", context, true);
	const loaded = loadEntityLayout(context);
	const canvasPixels =
		loaded.layout.texture.width * loaded.layout.texture.height;
	assertDecodedPixelBudget(context, canvasPixels);
	const template = buildEntityTemplate(loaded.layout, { fill });
	const output =
		step.output === undefined
			? `assets/${context.namespace}/textures/entity/${context.targetId}.png`
			: declaredOutputPath(step.output, "output", context, ".png");
	const outputs: GeneratedOutput[] = [
		generatedOutput(output, "entityTemplate", encodePng(template.canvas)),
	];
	if (step.mcpxOutput !== undefined) {
		outputs.push(
			generatedOutput(
				declaredOutputPath(step.mcpxOutput, "mcpxOutput", context, ".mcpx"),
				"entityTemplateSource",
				TEXT_ENCODER.encode(serializeMcpx(template.canvas)),
			),
		);
	}
	return {
		outputs,
		inputs: loaded.input === undefined ? [] : [loaded.input],
		sourceBytes: loaded.sourceBytes,
		decodedPixels: canvasPixels,
	};
}

/** One `layers[]` entry: the short string form or the full object form. */
function parseEquipmentLayer(
	value: unknown,
	index: number,
	context: GeneratedStepContext,
): EquipmentLayerRequest {
	const field = `layers[${index}]`;
	if (typeof value === "string") {
		if (value.trim() === "") {
			stepFailure(
				context,
				field,
				`equipment step entry at ${field} must name a layer type.`,
			);
		}
		return { type: value };
	}
	if (!isJsonObject(value)) {
		stepFailure(
			context,
			field,
			`equipment step entry at ${field} must be a layer type string or an object.`,
		);
	}
	for (const key of Object.keys(value)) {
		if (!EQUIPMENT_LAYER_FIELDS.has(key)) {
			stepFailure(
				context,
				`${field}.${key}`,
				`Unknown field '${key}' in equipment layer at ${field}.`,
			);
		}
	}
	if (typeof value.type !== "string" || value.type.trim() === "") {
		stepFailure(
			context,
			`${field}.type`,
			`equipment step entry at ${field} needs a non-empty layer type.`,
		);
	}
	if (
		value.texture !== undefined &&
		(typeof value.texture !== "string" || value.texture.trim() === "")
	) {
		stepFailure(
			context,
			`${field}.texture`,
			`equipment step entry at ${field} needs a non-empty texture name.`,
		);
	}
	const layer: {
		type: string;
		texture?: string;
		dyeable?: { colorWhenUndyed?: number };
		usePlayerTexture?: boolean;
	} = { type: value.type };
	if (value.texture !== undefined) {
		layer.texture = value.texture as string;
	}
	if (value.dyeable !== undefined) {
		if (!isJsonObject(value.dyeable)) {
			stepFailure(
				context,
				`${field}.dyeable`,
				`equipment layer 'dyeable' at ${field} must be an object.`,
			);
		}
		for (const key of Object.keys(value.dyeable)) {
			if (!EQUIPMENT_DYEABLE_FIELDS.has(key)) {
				stepFailure(
					context,
					`${field}.dyeable.${key}`,
					`Unknown field '${key}' in equipment layer 'dyeable' at ${field}.`,
				);
			}
		}
		const color = value.dyeable.colorWhenUndyed;
		if (color !== undefined && typeof color !== "number") {
			stepFailure(
				context,
				`${field}.dyeable.colorWhenUndyed`,
				`equipment layer 'dyeable.colorWhenUndyed' at ${field} must be an integer.`,
			);
		}
		layer.dyeable =
			color === undefined ? {} : { colorWhenUndyed: color as number };
	}
	if (value.usePlayerTexture !== undefined) {
		if (typeof value.usePlayerTexture !== "boolean") {
			stepFailure(
				context,
				`${field}.usePlayerTexture`,
				`equipment layer 'usePlayerTexture' at ${field} must be a boolean.`,
			);
		}
		layer.usePlayerTexture = value.usePlayerTexture;
	}
	return layer;
}

function planEquipment(context: GeneratedStepContext): GeneratedStepPlan {
	const step = context.step;
	assertStepFields(step, EQUIPMENT_FIELDS, context);
	parseOverride(step.override, context);
	const id =
		step.id === undefined
			? context.targetId
			: typeof step.id === "string" && step.id.trim() !== ""
				? step.id
				: stepFailure(
						context,
						"id",
						`equipment step field 'id' must be a non-empty string for target '${context.targetId}'.`,
					);
	if (!Array.isArray(step.layers) || step.layers.length === 0) {
		stepFailure(
			context,
			"layers",
			`equipment step needs a non-empty 'layers' array for target '${context.targetId}'.`,
		);
	}
	const layers = step.layers.map((layer, index) =>
		parseEquipmentLayer(layer, index, context),
	);
	const template = optionalBoolean(step.template, "template", context, true);
	const fill = optionalBoolean(step.fill, "fill", context, true);
	let plan: ReturnType<typeof planEquipmentAsset>;
	try {
		plan = planEquipmentAsset({
			namespace: context.namespace,
			id,
			packFormat: context.packFormat,
			layers,
			template,
			fill,
		});
	} catch (error) {
		translateGeneratorFailure(error, context);
	}
	const outputs: GeneratedOutput[] = [
		generatedOutput(
			plan.definition.relativePath,
			"equipmentDefinition",
			TEXT_ENCODER.encode(plan.definition.text),
		),
	];
	for (const texture of plan.textures) {
		outputs.push(
			generatedOutput(texture.relativePath, "equipmentTexture", texture.png),
		);
	}
	let decodedPixels = 0;
	for (const texture of plan.textures) {
		decodedPixels += texture.width * texture.height;
	}
	assertDecodedPixelBudget(context, decodedPixels);
	return { outputs, inputs: [], sourceBytes: 0, decodedPixels };
}

/** A bitmap atlas location names its own path inside the pack. */
function atlasLocationToAssets(texture: string): string {
	const at = texture.indexOf(":");
	return `assets/${texture.slice(0, at)}/textures/${texture.slice(at + 1)}`;
}

/** Load one icon the way `font` does: `.mcpx` as editable text, anything else through the raster decoder. */
async function loadFontIcon(
	icon: FontSpecIcon,
	context: GeneratedStepContext,
): Promise<{
	source: FontGlyphSource;
	input: GeneratedInput;
	sourceBytes: number;
	decodedPixels: number;
}> {
	const path = icon.path;
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(readFileSync(path));
	} catch {
		throw new McAssetError(
			"RECIPE_SOURCE_MISSING",
			`Source file not found: ${path}`,
			{
				path: icon.path,
				targetId: context.targetId,
				stepType: context.step.type,
				stepIndex: context.stepIndex,
				field: `icons.${icon.name}`,
			},
		);
	}
	let canvas: FontGlyphSource["canvas"];
	if (path.toLowerCase().endsWith(".mcpx")) {
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			stepFailure(
				context,
				`icons.${icon.name}`,
				`icon "${icon.name}" is not valid UTF-8: ${path}.`,
			);
		}
		try {
			canvas = parseMcpx(text);
		} catch (error) {
			translateGeneratorFailure(error, context);
		}
	} else {
		let decoded: Awaited<ReturnType<typeof decodeImage>>;
		try {
			decoded = await decodeImage(bytes);
		} catch (error) {
			translateGeneratorFailure(error, context);
		}
		const created = createCanvas(decoded.width, decoded.height);
		const layer = addLayer(created, { id: "base" });
		replaceLayerPixels(created, layer.id, decoded.pixels);
		canvas = created;
	}
	return {
		source: { name: icon.name, canvas },
		input: {
			ref: `font-icon:${icon.name}`,
			sha256: sha256Hex(bytes),
			filePath: path,
		},
		sourceBytes: bytes.length,
		decodedPixels: canvas.width * canvas.height,
	};
}

async function planFontStep(
	context: GeneratedStepContext,
): Promise<GeneratedStepPlan> {
	const step = context.step;
	assertStepFields(step, FONT_FIELDS, context);
	parseOverride(step.override, context);
	const declared = step.spec;
	if (typeof declared !== "string" || declared.trim() === "") {
		stepFailure(
			context,
			"spec",
			`font step field 'spec' must be a path to a font spec document for target '${context.targetId}'.`,
		);
	}
	const specPath = resolve(context.recipeDir, declared);
	const specSource = readSourceText(specPath, declared, context, "spec");
	let raw: unknown;
	try {
		raw = JSON.parse(specSource.text) as unknown;
	} catch {
		throw new McAssetError(
			"RECIPE_INVALID",
			`Font spec is not valid JSON: ${declared}.`,
			{
				path: declared,
				targetId: context.targetId,
				stepType: context.step.type,
				stepIndex: context.stepIndex,
				field: "spec",
			},
		);
	}
	let spec: FontSpec;
	try {
		spec = parseFontSpec(raw, {
			baseDir: dirname(specPath),
			source: declared,
		});
	} catch (error) {
		translateGeneratorFailure(error, context);
	}
	if (spec.namespace !== context.namespace) {
		stepFailure(
			context,
			"spec",
			`font spec declares namespace '${spec.namespace}', which differs from the project namespace '${context.namespace}'.`,
		);
	}
	const inputs: GeneratedInput[] = [];
	inputs.push({
		ref: `font-spec:${declared}`,
		sha256: sha256Hex(specSource.bytes),
	});
	const sources: FontGlyphSource[] = [];
	let sourceBytes = specSource.bytes.length;
	let decodedPixels = 0;
	for (const icon of spec.icons) {
		const loaded = await loadFontIcon(icon, context);
		inputs.push(loaded.input);
		sources.push(loaded.source);
		sourceBytes += loaded.sourceBytes;
		decodedPixels += loaded.decodedPixels;
		assertDecodedPixelBudget(context, decodedPixels);
	}
	let plan: ReturnType<typeof planFont>;
	try {
		plan = planFont(spec, sources);
	} catch (error) {
		translateGeneratorFailure(error, context);
	}
	const outputs: GeneratedOutput[] = [
		generatedOutput(
			`assets/${spec.namespace}/font/${spec.id}.json`,
			"fontDefinition",
			TEXT_ENCODER.encode(plan.definitionText),
		),
	];
	for (const atlas of plan.atlases) {
		outputs.push(
			generatedOutput(
				atlasLocationToAssets(atlas.texture),
				"fontAtlas",
				atlas.atlas.png,
			),
		);
		decodedPixels += atlas.atlasWidth * atlas.atlasHeight;
	}
	assertDecodedPixelBudget(context, decodedPixels);
	// The icon-to-character table is project documentation, not a pack asset:
	// it lands under the project root so no client reads it and no pack scan
	// has to interpret it.
	const tablePath =
		step.table === undefined
			? `font/${spec.id}.table.json`
			: declaredOutputPath(step.table, "table", context, ".json");
	outputs.push(
		generatedOutput(
			tablePath,
			"fontTable",
			TEXT_ENCODER.encode(plan.tableText),
			"project",
		),
	);
	return { outputs, inputs, sourceBytes, decodedPixels };
}

async function planParticleStep(
	context: GeneratedStepContext,
	loadFrames: typeof loadParticleFrames,
): Promise<GeneratedStepPlan> {
	const step = context.step;
	assertStepFields(step, PARTICLE_FIELDS, context);
	parseOverride(step.override, context);
	const declared = step.frames;
	if (typeof declared !== "string" || declared.trim() === "") {
		stepFailure(
			context,
			"frames",
			`particle step field 'frames' must be a frames directory or a single .mcpx/.png file for target '${context.targetId}'.`,
		);
	}
	const id =
		step.id === undefined
			? context.targetId
			: typeof step.id === "string" && step.id.trim() !== ""
				? step.id
				: stepFailure(
						context,
						"id",
						`particle step field 'id' must be a non-empty string for target '${context.targetId}'.`,
					);
	if (
		step.texturePrefix !== undefined &&
		(typeof step.texturePrefix !== "string" || step.texturePrefix.trim() === "")
	) {
		stepFailure(
			context,
			"texturePrefix",
			`particle step field 'texturePrefix' must be a non-empty string for target '${context.targetId}'.`,
		);
	}
	const fullPath = resolve(context.recipeDir, declared);
	let loaded: Awaited<ReturnType<typeof loadParticleFrames>>;
	try {
		loaded = await loadFrames(fullPath, {
			maxDecodedPixels: PACK_BUILD_MAX_DECODED_PIXELS,
		});
	} catch (error) {
		translateGeneratorFailure(error, context);
	}
	let plan: ReturnType<typeof planParticleAsset>;
	try {
		plan = planParticleAsset({
			namespace: context.namespace,
			id,
			...(step.texturePrefix === undefined
				? {}
				: { texturePrefix: step.texturePrefix }),
			frames: loaded.frames,
		});
	} catch (error) {
		translateGeneratorFailure(error, context);
	}
	const inputs: GeneratedInput[] = loaded.frames.map((frame, index) => ({
		ref: `particle-frame:${basename(loaded.inputFiles[index])}`,
		sha256: frame.sourceSha256,
		filePath: loaded.inputFiles[index],
	}));
	const outputs: GeneratedOutput[] = [
		generatedOutput(
			plan.definition.relativePath,
			"particleDefinition",
			TEXT_ENCODER.encode(plan.definition.text),
		),
	];
	for (const texture of plan.textures) {
		outputs.push(
			generatedOutput(texture.relativePath, "particleTexture", texture.data),
		);
	}
	return {
		outputs,
		inputs,
		sourceBytes: loaded.sourceBytes,
		decodedPixels: loaded.decodedPixels,
	};
}

/** Plan one generator-backed step; every refusal happens before a write. */
export async function planGeneratedStep(
	context: GeneratedStepContext,
	dependencies: GeneratedStepDependencies = {},
): Promise<GeneratedStepPlan> {
	let plan: GeneratedStepPlan;
	if (context.step.type === "entityTemplate") {
		plan = planEntityTemplate(context);
	} else if (context.step.type === "equipment") {
		plan = planEquipment(context);
	} else if (context.step.type === "font") {
		plan = await planFontStep(context);
	} else if (context.step.type === "particle") {
		plan = await planParticleStep(
			context,
			dependencies.loadParticleFrames ?? loadParticleFrames,
		);
	} else {
		throw new McAssetError(
			"RECIPE_INVALID",
			`Unknown generator step type: ${context.step.type}`,
			{
				targetId: context.targetId,
				stepType: context.step.type,
				stepIndex: context.stepIndex,
			},
		);
	}
	for (const output of plan.outputs) {
		assertProjectOutputAllowed(output, context);
	}
	return plan;
}
