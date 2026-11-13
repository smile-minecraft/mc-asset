import { McAssetError } from "../core/errors.ts";
import { resolveEntityLayout } from "../entity/layout.ts";
import {
	buildEntityTemplate,
	type EntityTemplateRegion,
} from "../entity/template.ts";
import { encodePng } from "../io/png.ts";
import { serializeMcpx } from "../mcpx/index.ts";
import {
	comparePackFormats,
	isPackFormatInKnownRange,
	normalizePackFormat,
} from "../profiles/versions.ts";
import {
	EQUIPMENT_LAYER_TYPES,
	EQUIPMENT_TEMPLATE_LAYER_TYPES,
	getEquipmentLayout,
} from "./layouts.ts";

/**
 * Deterministic equipment definition and texture-template generation.
 *
 * An equipment definition is `{"layers": {<layer type>: [<entry>, ...]}}`,
 * where an entry is a `texture` resource location plus an optional `dyeable`
 * (`{}` or `{"color_when_undyed": <int>}`) and an optional
 * `use_player_texture`. Layer types are a client enum, so an unknown name
 * makes the client reject the whole document; this module refuses names the
 * target version does not have instead of writing such a file.
 *
 * The document lives at `assets/<namespace>/models/equipment/<id>.json` when
 * the pack targets format 42.0 (1.21.2 and 1.21.3) and moves to
 * `assets/<namespace>/equipment/<id>.json` from 46.0 (1.21.4) on. Formats
 * below 42.0 have no equipment definitions at all.
 *
 * A layer entry names its texture by resource location; the client resolves
 * it as `assets/<namespace>/textures/entity/equipment/<layer type>/<path>.png`,
 * so the layer type is part of the path and every layer type of one set can
 * use the same leaf name.
 *
 * Templates reuse the entity box-UV engine. The 64x32 armor sheet and the
 * 64x32 elytra sheet are the same from format 42.0 through 97.1: the vanilla
 * `humanoid/iron.png` and `humanoid_leggings/iron.png` are byte-identical in
 * every jar from 1.21.2 to 26.3, and `ElytraModel` still samples (22,0) with
 * a 10x20x2 box in 26.3. Only the three layer types with a verified layout
 * get a template.
 */

/** First pack format with equipment definitions (Minecraft 1.21.2). */
export const EQUIPMENT_MIN_PACK_FORMAT = "42.0";

/** First pack format that reads them from `equipment/` (Minecraft 1.21.4). */
export const EQUIPMENT_DIRECTORY_PACK_FORMAT = "46.0";

/** Where the definition of a pack format lives, below `assets/<namespace>/`. */
export type EquipmentDefinitionDirectory = "models/equipment" | "equipment";

const NAMESPACE_PATTERN = /^[a-z0-9_.-]+$/;
const SEGMENT_PATTERN = /^[a-z0-9._-]+$/;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function invalid(message: string, details: Record<string, unknown>): never {
	throw new McAssetError("EQUIPMENT_INVALID", message, details);
}

/** `dyeable` as the caller writes it; the key mirrors the document field. */
export interface EquipmentDyeableRequest {
	/** Opaque ARGB color as the document stores it; omitted means `{}`. */
	readonly colorWhenUndyed?: number | undefined;
}

/** One `layers.<type>[]` entry of the requested definition. */
export interface EquipmentLayerRequest {
	/** Layer type name from the target version's enum. */
	readonly type: string;
	/** Texture leaf below `textures/entity/equipment/<type>/`; defaults to the id. */
	readonly texture?: string | undefined;
	readonly dyeable?: EquipmentDyeableRequest | undefined;
	/** Set `use_player_texture`; only the `wings` layer reads it. */
	readonly usePlayerTexture?: boolean | undefined;
}

export interface EquipmentPlanRequest {
	readonly namespace: string;
	/** Definition id; a resource path, one or more `/` segments. */
	readonly id: string;
	/** Target resource-pack format, `N` or `N.M`. */
	readonly packFormat: string;
	readonly layers: readonly EquipmentLayerRequest[];
	/** Write a template per texture entry; default true. */
	readonly template?: boolean | undefined;
	/** Fill every face with its direction color; default true. */
	readonly fill?: boolean | undefined;
}

/** One entry exactly as the document writes it. */
export interface EquipmentLayerOutput {
	readonly texture: string;
	readonly dyeable?: EquipmentDyeableOutput | undefined;
	readonly use_player_texture?: true | undefined;
}

/** An empty object (undyed color left to the client) or the explicit color. */
export type EquipmentDyeableOutput =
	| { readonly color_when_undyed: number }
	| Record<string, never>;

export type EquipmentLayers = Readonly<
	Record<string, readonly EquipmentLayerOutput[]>
>;

export interface EquipmentDefinitionOutput {
	/** Pack-relative path, e.g. `assets/demo/equipment/gear.json`. */
	readonly relativePath: string;
	readonly directory: EquipmentDefinitionDirectory;
	readonly json: { readonly layers: EquipmentLayers };
	/** Two-space indent plus one trailing newline. */
	readonly text: string;
}

export interface EquipmentTextureOutput {
	readonly layerType: string;
	/** Resource location written into the definition, e.g. `demo:gear`. */
	readonly texture: string;
	/** Pack-relative PNG path. */
	readonly relativePath: string;
	/** Id of the entity layout the template was built from. */
	readonly layoutId: string;
	readonly width: number;
	readonly height: number;
	/** One named region per face, in face order. */
	readonly regions: readonly EntityTemplateRegion[];
	/** Canonical PNG bytes. */
	readonly png: Uint8Array;
	/** The editable `.mcpx` text with the same pixels. */
	readonly mcpxText: string;
}

/** One complete, deterministic equipment asset plan. */
export interface EquipmentAssetPlan {
	readonly namespace: string;
	readonly id: string;
	readonly packFormat: string;
	readonly definition: EquipmentDefinitionOutput;
	/** In layer-entry order, one per distinct `(layer type, leaf)` pair. */
	readonly textures: readonly EquipmentTextureOutput[];
}

/** Validate a namespace and return it unchanged. */
export function validateEquipmentNamespace(value: string): string {
	if (value === "." || value === ".." || !NAMESPACE_PATTERN.test(value)) {
		invalid(`Invalid equipment namespace "${value}"; expected [a-z0-9_.-].`, {
			field: "namespace",
			value,
		});
	}
	return value;
}

/**
 * Validate a resource path (the definition id or a texture leaf) and return
 * it unchanged: one or more `[a-z0-9._-]` segments joined by single slashes,
 * with no `.` or `..` segment, so an output can never leave its directory.
 */
export function validateEquipmentPath(value: string, field: string): string {
	const segments = value.split("/");
	const badShape =
		value === "" ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("//");
	if (badShape) {
		invalid(
			`Invalid equipment ${field} "${value}"; expected [a-z0-9._-] segments joined by single "/".`,
			{ field, value },
		);
	}
	for (const segment of segments) {
		if (segment === "." || segment === ".." || !SEGMENT_PATTERN.test(segment)) {
			invalid(
				`Invalid equipment ${field} "${value}"; segment "${segment}" must use [a-z0-9._-] and must not be "." or "..".`,
				{ field, value },
			);
		}
	}
	return value;
}

/** Refuse formats outside the range whose equipment layout is known. */
function checkEquipmentPackFormat(packFormat: string): void {
	if (
		comparePackFormats(packFormat, EQUIPMENT_MIN_PACK_FORMAT) < 0 ||
		!isPackFormatInKnownRange(packFormat)
	) {
		throw new McAssetError(
			"EQUIPMENT_VERSION_UNSUPPORTED",
			`Equipment definitions exist from pack format ${EQUIPMENT_MIN_PACK_FORMAT} through 97.1; got ${packFormat}.`,
			{ packFormat, minimum: EQUIPMENT_MIN_PACK_FORMAT, maximum: "97.1" },
		);
	}
}

/** Where the definition of a target format lives below `assets/<namespace>/`. */
export function equipmentDefinitionDirectory(
	packFormat: string,
): EquipmentDefinitionDirectory {
	return comparePackFormats(
		normalizePackFormat(packFormat),
		EQUIPMENT_DIRECTORY_PACK_FORMAT,
	) < 0
		? "models/equipment"
		: "equipment";
}

/** Pack-relative definition path for one target format. */
export function equipmentDefinitionRelativePath(
	namespace: string,
	id: string,
	packFormat: string,
): string {
	return `assets/${namespace}/${equipmentDefinitionDirectory(packFormat)}/${id}.json`;
}

/** Pack-relative texture path; the layer type is a directory. */
export function equipmentTextureRelativePath(
	namespace: string,
	layerType: string,
	leaf: string,
): string {
	return `assets/${namespace}/textures/entity/equipment/${layerType}/${leaf}.png`;
}

/** Refuse a layer type the target version's client would reject. */
function checkLayerType(type: string, packFormat: string): void {
	const fact = EQUIPMENT_LAYER_TYPES.find((entry) => entry.type === type);
	if (fact === undefined) {
		invalid(
			`Unknown equipment layer type "${type}"; the target version knows ${EQUIPMENT_LAYER_TYPES.map((entry) => entry.type).join(", ")}.`,
			{
				field: "layers",
				value: type,
				supported: EQUIPMENT_LAYER_TYPES.map((entry) => entry.type),
			},
		);
	}
	if (comparePackFormats(packFormat, fact.since) < 0) {
		throw new McAssetError(
			"EQUIPMENT_VERSION_UNSUPPORTED",
			`Layer type "${type}" exists from pack format ${fact.since}; target is ${packFormat}.`,
			{ layerType: type, since: fact.since, packFormat },
		);
	}
}

function dyeableOutput(
	value: EquipmentDyeableRequest,
	type: string,
): EquipmentDyeableOutput {
	const color = value.colorWhenUndyed;
	if (color === undefined) {
		return {};
	}
	if (!Number.isInteger(color) || color < INT32_MIN || color > INT32_MAX) {
		invalid(
			`dyeable color_when_undyed for layer type "${type}" must be a 32-bit integer; got ${String(color)}.`,
			{ field: "dyeable.colorWhenUndyed", value: color },
		);
	}
	return { color_when_undyed: color };
}

interface PlannedEntry {
	readonly type: string;
	readonly leaf: string;
	readonly output: EquipmentLayerOutput;
}

/**
 * Plan the definition and its templates. Every refusal happens here, before
 * an output path is planned, so a rejected request writes nothing.
 */
export function planEquipmentAsset(
	request: EquipmentPlanRequest,
): EquipmentAssetPlan {
	const namespace = validateEquipmentNamespace(request.namespace);
	const packFormat = normalizePackFormat(request.packFormat);
	checkEquipmentPackFormat(packFormat);
	const id = validateEquipmentPath(request.id, "id");
	if (request.layers.length === 0) {
		invalid("An equipment definition needs at least one layer.", {
			field: "layers",
		});
	}

	const entriesByType = new Map<string, PlannedEntry[]>();
	for (const [index, layer] of request.layers.entries()) {
		checkLayerType(layer.type, packFormat);
		const leaf = validateEquipmentPath(
			layer.texture === undefined || layer.texture === "" ? id : layer.texture,
			`layers[${index}].texture`,
		);
		const group = entriesByType.get(layer.type) ?? [];
		if (group.some((entry) => entry.leaf === leaf)) {
			invalid(
				`Layer type "${layer.type}" lists texture "${namespace}:${leaf}" twice.`,
				{
					field: `layers[${index}].texture`,
					layerType: layer.type,
					value: leaf,
				},
			);
		}
		group.push({
			type: layer.type,
			leaf,
			output: {
				texture: `${namespace}:${leaf}`,
				...(layer.dyeable === undefined
					? {}
					: { dyeable: dyeableOutput(layer.dyeable, layer.type) }),
				...(layer.usePlayerTexture === true
					? { use_player_texture: true as const }
					: {}),
			},
		});
		entriesByType.set(layer.type, group);
	}

	// Layer types are a map, so their order is not meaningful and byte order
	// keeps the document stable; entries inside a type keep the caller's
	// order because that order is the draw order.
	const types = [...entriesByType.keys()].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	const layers: Record<string, EquipmentLayerOutput[]> = {};
	const ordered: PlannedEntry[] = [];
	for (const type of types) {
		const group = entriesByType.get(type) as PlannedEntry[];
		layers[type] = group.map((entry) => entry.output);
		ordered.push(...group);
	}

	const directory = equipmentDefinitionDirectory(packFormat);
	const json = { layers };
	const definition: EquipmentDefinitionOutput = {
		relativePath: equipmentDefinitionRelativePath(namespace, id, packFormat),
		directory,
		json,
		text: `${JSON.stringify(json, null, 2)}\n`,
	};

	const textures: EquipmentTextureOutput[] = [];
	if (request.template !== false) {
		const fill = request.fill !== false;
		for (const entry of ordered) {
			const layoutDocument = getEquipmentLayout(entry.type);
			if (layoutDocument === undefined) {
				invalid(
					`Layer type "${entry.type}" has no verified texture layout, so it has no template; templates exist for ${EQUIPMENT_TEMPLATE_LAYER_TYPES.join(", ")}. Generate the definition alone instead.`,
					{
						field: "layers",
						layerType: entry.type,
						supported: EQUIPMENT_TEMPLATE_LAYER_TYPES,
					},
				);
			}
			const layout = resolveEntityLayout(layoutDocument);
			const template = buildEntityTemplate(layout, { fill });
			textures.push({
				layerType: entry.type,
				texture: entry.output.texture,
				relativePath: equipmentTextureRelativePath(
					namespace,
					entry.type,
					entry.leaf,
				),
				layoutId: layout.id,
				width: layout.texture.width,
				height: layout.texture.height,
				regions: template.regions,
				png: encodePng(template.canvas),
				mcpxText: serializeMcpx(template.canvas),
			});
		}
	}

	return { namespace, id, packFormat, definition, textures };
}
