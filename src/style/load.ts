import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import process from "node:process";
import { McAssetError } from "../core/errors.ts";
import {
	clamp255,
	formatHexColor,
	hsl255,
	isHexColor,
	parseHexColor,
	truncatedDiv,
	withLightnessSaturation,
} from "./color.ts";
import { cloneJsonValue, isJsonObject, type JsonObject } from "./json.ts";
import { isPresetId, presetDocument } from "./presets.ts";
import {
	CATEGORY_IDS,
	DEFAULT_ANIMATION,
	DEFAULT_DITHER,
	DEFAULT_HIGHLIGHT,
	DEFAULT_LIGHT,
	DEFAULT_LIMITS,
	DEFAULT_OUTLINE,
	FAMILY_ID_PATTERN,
	FAMILY_ROLES,
	type FamilyRamp,
	type FamilyRole,
	type ResolvedStyle,
	STYLE_CHAIN_LIMIT,
	STYLE_FILE_SUFFIX,
	STYLE_FORMAT_VERSION,
	STYLE_ID_PATTERN,
	STYLE_PRESET_IDS,
	type StyleAnimationRules,
	type StyleCategoryOverride,
	type StyleCreateInput,
	type StyleDitherRules,
	type StyleHighlightRules,
	type StyleLightRules,
	type StyleLimitRules,
	type StyleOutlineRules,
} from "./types.ts";

/**
 * Style file reading: strict validation, `extends` resolution, and the
 * merge that turns a chain of sources into one resolved style. Every
 * rejected value names its field path, and every error carries the path
 * of the document plus the chain that was walked to reach it.
 */

export interface ResolveStyleOptions {
	/** Directory the source path and relative `extends` targets resolve against. */
	readonly baseDir?: string | undefined;
}

export interface StyleCreateOptions extends ResolveStyleOptions {}

/** A source naming a builtin preset id or a `.style.json` file. */
export function isStyleSource(value: string): boolean {
	return value.endsWith(STYLE_FILE_SUFFIX);
}

/** Longest accepted `extends` chain, entry source included. */
export const MAX_STYLE_CHAIN = STYLE_CHAIN_LIMIT;

/**
 * Empty resolved style: every section carries its schema default and the
 * family map is empty, so a consumer can read the shape without guards.
 */
export function emptyResolvedStyle(): ResolvedStyle {
	return {
		formatVersion: STYLE_FORMAT_VERSION,
		id: "",
		name: "",
		description: "",
		palettes: {},
		outline: { ...DEFAULT_OUTLINE },
		light: { ...DEFAULT_LIGHT },
		limits: { ...DEFAULT_LIMITS },
		highlight: { ...DEFAULT_HIGHLIGHT },
		dither: { ...DEFAULT_DITHER },
		animation: { ...DEFAULT_ANIMATION },
		categoryOverrides: {},
		extendsChain: [],
	};
}

/** One loaded source and the identity fields it declared. */
interface ChainDocument {
	readonly doc: JsonObject;
	readonly path: string;
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** Validated `extends` target: a builtin preset id or a `.style.json` path. */
	readonly extendsTarget: string | undefined;
}

/** The requested source plus every source its `extends` chain reached. */
interface WalkedChain {
	readonly entry: ChainDocument;
	readonly base: readonly ChainDocument[];
	readonly chain: readonly string[];
}

/** The document an error is reported against, plus the chain walked. */
interface DocContext {
	readonly path: string;
	readonly chain: readonly string[];
}

/**
 * Resolve a style source into one document: a builtin preset id, or a
 * `.style.json` path whose `extends` chain is merged from the innermost
 * source out. An unknown id is STYLE_NOT_FOUND, an unreadable or invalid
 * file is STYLE_INVALID, and a repeated source in the chain is
 * STYLE_INHERITANCE_CYCLE.
 */
export async function resolveStyle(
	source: string,
	options?: ResolveStyleOptions,
): Promise<ResolvedStyle> {
	if (isPresetId(source)) {
		return resolveChainDocuments(
			await walkChain(source, presetDocument(source), true),
		);
	}
	if (!isStyleSource(source)) {
		throw new McAssetError(
			"STYLE_NOT_FOUND",
			`style: expected a builtin preset id or a ${STYLE_FILE_SUFFIX} path, got ${formatValue(source)}`,
			{ path: source, field: "style", extendsChain: [] },
		);
	}
	const entryPath = resolvePath(options?.baseDir ?? process.cwd(), source);
	return resolveChainDocuments(await walkChain(entryPath));
}

/** One builtin preset resolved, or undefined when the id is unknown. */
export function getBuiltinStyle(id: string): ResolvedStyle | undefined {
	if (!isPresetId(id)) {
		return undefined;
	}
	return resolveChainDocuments({
		entry: chainDocument(presetDocument(id), id, [id], true),
		base: [],
		chain: [id],
	});
}

/**
 * Validate a `style create` request and return the `.style.json` text it
 * writes: `{formatVersion, id, name, extends}` plus the merged overrides,
 * with object keys emitted in byte order and a trailing newline.
 */
export async function buildStyleFileText(
	input: StyleCreateInput,
	options?: StyleCreateOptions,
): Promise<string> {
	const overrides = input.overrides ?? {};
	for (const key of Object.keys(overrides)) {
		if (FIXED_DOCUMENT_KEYS.includes(key)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`overrides must not carry the document field ${key}.`,
				{ field: key },
			);
		}
	}
	const document: JsonObject = {
		formatVersion: STYLE_FORMAT_VERSION,
		id: input.id,
		name: input.name ?? input.id,
		extends: input.extends ?? "vanilla",
	};
	for (const [key, value] of Object.entries(overrides)) {
		document[key] = cloneJsonValue(value);
	}
	const entryPath = resolvePath(
		options?.baseDir ?? process.cwd(),
		`${input.id}${STYLE_FILE_SUFFIX}`,
	);
	// The chain walk reads the base sources; the merged result is the
	// document validation, so a bad override never reaches the disk.
	await resolveChainDocuments(await walkChain(entryPath, document));
	return canonicalJson(document);
}

/* ------------------------------------------------------------------ */
/* Chain walking                                                       */
/* ------------------------------------------------------------------ */

/**
 * Walk a source and its `extends` targets: read each file, refuse a
 * repeated normalized path, and stop at the builtin base (or a source
 * without `extends`). `entryDoc` skips the read for an in-memory document.
 */
async function walkChain(
	entryPath: string,
	entryDoc?: JsonObject,
	entryIsBuiltinPreset = false,
): Promise<WalkedChain> {
	const chain: string[] = [];
	const seen = new Set<string>();
	let currentPath = entryPath;
	seen.add(`file:${currentPath}`);
	pushChain(chain, currentPath);
	let current = chainDocument(
		entryDoc ?? (await readStyleDocument(entryPath, chain)),
		currentPath,
		chain,
		entryIsBuiltinPreset,
	);
	const entry = current;
	const base: ChainDocument[] = [];
	for (;;) {
		const next = current.extendsTarget;
		if (next === undefined) {
			break;
		}
		if (isPresetId(next)) {
			pushChain(chain, next);
			base.push(chainDocument(presetDocument(next), next, chain, true));
			break;
		}
		currentPath = resolvePath(dirname(currentPath), next);
		const key = `file:${currentPath}`;
		if (seen.has(key)) {
			throw new McAssetError(
				"STYLE_INHERITANCE_CYCLE",
				`extends: expected no repeated source, got ${formatValue(currentPath)}`,
				{
					path: currentPath,
					field: "extends",
					extendsChain: [...chain, currentPath],
				},
			);
		}
		seen.add(key);
		pushChain(chain, currentPath);
		current = chainDocument(
			await readStyleDocument(currentPath, chain),
			currentPath,
			chain,
		);
		base.push(current);
	}
	return { entry, base, chain };
}

function pushChain(chain: string[], display: string): void {
	if (chain.length === MAX_STYLE_CHAIN) {
		throw new McAssetError(
			"STYLE_INVALID",
			`extends: expected at most ${MAX_STYLE_CHAIN} sources in the chain, got ${chain.length + 1}`,
			{
				path: display,
				field: "extends",
				extendsChain: [...chain, display],
			},
		);
	}
	chain.push(display);
}

/** Read a style file as a JSON object; a bad file is a `read` refusal. */
async function readStyleDocument(
	path: string,
	chain: readonly string[],
): Promise<JsonObject> {
	const failure = (): McAssetError =>
		new McAssetError(
			"STYLE_INVALID",
			`expected a readable style document, got ${formatValue(path)}`,
			{ path, field: "", reason: "read", extendsChain: [...chain] },
		);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw failure();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		throw failure();
	}
	if (!isJsonObject(parsed)) {
		throw failure();
	}
	return parsed;
}

/**
 * Validate one source's identity fields and freeze them for assembly.
 * A builtin preset document carries its own preset id, so only a style
 * file may be refused for reusing one.
 */
function chainDocument(
	doc: JsonObject,
	path: string,
	chain: readonly string[],
	isBuiltinPreset = false,
): ChainDocument {
	const context: DocContext = { path, chain };
	expectKnownKeys(doc, TOP_LEVEL_KEYS, context, "");
	const version = doc.formatVersion;
	if (typeof version !== "number" || !Number.isInteger(version)) {
		invalidField(context, "formatVersion", "the integer 1", version);
	}
	if (version > STYLE_FORMAT_VERSION) {
		throw new McAssetError(
			"STYLE_UNSUPPORTED_VERSION",
			`formatVersion: expected 1, got ${formatValue(version)}`,
			{
				path,
				field: "formatVersion",
				extendsChain: [...chain],
			},
		);
	}
	if (version !== STYLE_FORMAT_VERSION) {
		invalidField(context, "formatVersion", "the integer 1", version);
	}
	const id = doc.id;
	if (typeof id !== "string" || !STYLE_ID_PATTERN.test(id)) {
		invalidField(
			context,
			"id",
			"a style id matching [a-z][a-z0-9_-]{0,63}",
			id,
		);
	}
	if (
		!isBuiltinPreset &&
		(STYLE_PRESET_IDS as readonly string[]).includes(id)
	) {
		invalidField(context, "id", "an id other than a builtin preset id", id);
	}
	const name = doc.name;
	if (typeof name !== "string" || name.length < 1 || name.length > 64) {
		invalidField(context, "name", "a string of 1 to 64 characters", name);
	}
	const description = doc.description ?? "";
	if (typeof description !== "string" || description.length > 200) {
		invalidField(
			context,
			"description",
			"a string of at most 200 characters",
			description,
		);
	}
	const source = doc.extends;
	let extendsTarget: string | undefined;
	if (source === undefined) {
		extendsTarget = undefined;
	} else if (
		typeof source !== "string" ||
		source === "" ||
		(!isPresetId(source) && !isStyleSource(source))
	) {
		invalidField(
			context,
			"extends",
			`a builtin preset id or a ${STYLE_FILE_SUFFIX} path`,
			source,
		);
	} else {
		extendsTarget = source;
	}
	return { doc, path, id, name, description, extendsTarget };
}

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

const IDENTITY_KEYS = [
	"formatVersion",
	"id",
	"name",
	"description",
	"extends",
] as const;

const BODY_KEYS = [
	"palettes",
	"outline",
	"light",
	"limits",
	"highlight",
	"dither",
	"animation",
	"categoryOverrides",
] as const;

const TOP_LEVEL_KEYS = [...IDENTITY_KEYS, ...BODY_KEYS];

/** Create request fields an `overrides` object may not replace. */
const FIXED_DOCUMENT_KEYS = ["formatVersion", "id", "name", "extends"];

/** Schema defaults as the innermost source of every chain. */
function defaultBody(): JsonObject {
	return {
		palettes: {},
		outline: { ...DEFAULT_OUTLINE },
		light: { ...DEFAULT_LIGHT },
		limits: {
			...DEFAULT_LIMITS,
			axisCheckCategories: [...DEFAULT_LIMITS.axisCheckCategories],
		},
		highlight: { ...DEFAULT_HIGHLIGHT },
		dither: { ...DEFAULT_DITHER },
		animation: { ...DEFAULT_ANIMATION },
		categoryOverrides: {},
	};
}

function bodyOf(doc: JsonObject): JsonObject {
	const body: JsonObject = {};
	for (const key of BODY_KEYS) {
		if (key in doc) {
			body[key] = doc[key];
		}
	}
	return body;
}

/**
 * Deep-merge one body over another, child wins: sections merge key by key,
 * `null` in a family or category map deletes the entry, and a value that is
 * not an object replaces what was there (validation then names the field).
 */
function mergeBody(parent: JsonObject, child: JsonObject): JsonObject {
	const merged: JsonObject = { ...parent };
	for (const key of BODY_KEYS) {
		if (!(key in child)) {
			continue;
		}
		const value = child[key];
		if (key === "palettes") {
			merged[key] = mergeEntryMap(parent[key], value, mergeSection);
		} else if (key === "categoryOverrides") {
			merged[key] = mergeEntryMap(parent[key], value, mergeCategoryOverride);
		} else {
			merged[key] = mergeSection(parent[key], value);
		}
	}
	return merged;
}

function mergeEntryMap(
	parent: unknown,
	child: unknown,
	mergeEntry: (parent: unknown, child: unknown) => unknown,
): unknown {
	if (!isJsonObject(parent) || !isJsonObject(child)) {
		return child;
	}
	const merged: JsonObject = { ...parent };
	for (const [key, value] of Object.entries(child)) {
		if (value === null) {
			delete merged[key];
		} else {
			merged[key] = mergeEntry(merged[key], value);
		}
	}
	return merged;
}

function mergeSection(parent: unknown, child: unknown): unknown {
	return isJsonObject(parent) && isJsonObject(child)
		? { ...parent, ...child }
		: child;
}

function mergeCategoryOverride(parent: unknown, child: unknown): unknown {
	if (!isJsonObject(parent) || !isJsonObject(child)) {
		return child;
	}
	const merged: JsonObject = { ...parent };
	for (const [section, value] of Object.entries(child)) {
		merged[section] = mergeSection(merged[section], value);
	}
	return merged;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/** Merge a walked chain from its base out and assemble the resolved style. */
function resolveChainDocuments(walked: WalkedChain): ResolvedStyle {
	const { entry, base, chain } = walked;
	const context: DocContext = { path: entry.path, chain };
	let body = defaultBody();
	for (const document of [...base].reverse()) {
		body = mergeBody(body, bodyOf(document.doc));
	}
	body = mergeBody(body, bodyOf(entry.doc));
	return {
		formatVersion: STYLE_FORMAT_VERSION,
		id: entry.id,
		name: entry.name,
		description: entry.description,
		palettes: completePalettes(readPalettes(body.palettes, context), context),
		outline: readOutline(body.outline, context),
		light: readLight(body.light, context),
		limits: readLimits(body.limits, context),
		highlight: readHighlight(body.highlight, context),
		dither: readDither(body.dither, context),
		animation: readAnimation(body.animation, context),
		categoryOverrides: readCategoryOverrides(body.categoryOverrides, context),
		extendsChain: [...chain],
	};
}

/* ------------------------------------------------------------------ */
/* Field validation                                                    */
/* ------------------------------------------------------------------ */

type FieldReader = (
	value: unknown,
	context: DocContext,
	field: string,
) => unknown;

const OUTLINE_FIELDS: Record<string, FieldReader> = {
	mode: (value, context, field) =>
		expectChoice(value, context, field, [
			"tinted",
			"selective",
			"uniform",
			"black",
			"strip",
		]),
	position: (value, context, field) =>
		expectChoice(value, context, field, ["inside", "outside"]),
	color: (value, context, field) => expectNullableColor(value, context, field),
	luminanceDropPermille: (value, context, field) =>
		expectInteger(value, context, field, 0, 400),
	saturationRatioPermille: (value, context, field) =>
		expectInteger(value, context, field, 0, 2000),
	maxHueOffsetDegrees: (value, context, field) =>
		expectInteger(value, context, field, 0, 180),
	darknessGapPermille: (value, context, field) =>
		expectInteger(value, context, field, 0, 500),
	snapFamilies: (value, context, field) => expectBoolean(value, context, field),
};

const LIGHT_FIELDS: Record<string, FieldReader> = {
	direction: (value, context, field) =>
		expectChoice(value, context, field, ["top-left"]),
	minTlBrPermille: (value, context, field) =>
		expectInteger(value, context, field, -1000, 1000),
};

const LIMITS_FIELDS: Record<string, FieldReader> = {
	maxColors: (value, context, field) =>
		expectInteger(value, context, field, 1, 256),
	minLevels: (value, context, field) =>
		expectInteger(value, context, field, 1, 64),
	maxLevels: (value, context, field) =>
		expectInteger(value, context, field, 1, 64),
	dynamicRangeMinPermille: (value, context, field) =>
		expectInteger(value, context, field, 0, 1000),
	requireMargin: (value, context, field) =>
		expectBoolean(value, context, field),
	axisCheckCategories: (value, context, field) =>
		expectCategoryIds(value, context, field),
};

const HIGHLIGHT_FIELDS: Record<string, FieldReader> = {
	minPixels: (value, context, field) =>
		expectInteger(value, context, field, 0, 4096),
	maxPixels: (value, context, field) =>
		expectInteger(value, context, field, 0, 4096),
	minRatioPermille: (value, context, field) =>
		expectInteger(value, context, field, 0, 1000),
	maxRatioPermille: (value, context, field) =>
		expectInteger(value, context, field, 0, 1000),
	bufferMinRatioPermille: (value, context, field) =>
		expectInteger(value, context, field, 0, 1000),
};

const DITHER_FIELDS: Record<string, FieldReader> = {
	mode: (value, context, field) =>
		expectChoice(value, context, field, ["allow", "discourage", "forbid"]),
	maxRatioPermille: (value, context, field) =>
		expectInteger(value, context, field, 0, 1000),
};

const ANIMATION_FIELDS: Record<string, FieldReader> = {
	timelinePreset: (value, context, field) =>
		expectChoice(value, context, field, [
			"hold-and-sweep",
			"ping-pong",
			"pulse",
		]),
	frametime: (value, context, field) =>
		expectInteger(value, context, field, 1, 1000),
	holdTicks: (value, context, field) =>
		expectInteger(value, context, field, 1, 1000),
	sweepFrames: (value, context, field) =>
		expectInteger(value, context, field, 1, 64),
	sweepAngleDegrees: (value, context, field) =>
		expectNumberChoice(value, context, field, [45, 90, 135, 180]),
	sweepWidthPixels: (value, context, field) =>
		expectInteger(value, context, field, 1, 8),
	sweepColor: (value, context, field) => expectColor(value, context, field),
	interpolate: (value, context, field) => expectBoolean(value, context, field),
};

const CATEGORY_SECTIONS: Record<string, Record<string, FieldReader>> = {
	outline: OUTLINE_FIELDS,
	light: LIGHT_FIELDS,
	limits: LIMITS_FIELDS,
	highlight: HIGHLIGHT_FIELDS,
	dither: DITHER_FIELDS,
};

function readOutline(value: unknown, context: DocContext): StyleOutlineRules {
	const outline = readSection<StyleOutlineRules>(
		value,
		context,
		"outline",
		OUTLINE_FIELDS,
	);
	if (outline.mode === "uniform") {
		if (outline.color === null) {
			invalidField(
				context,
				"outline.color",
				"#RRGGBB when the outline mode is uniform",
				outline.color,
			);
		}
	} else if (outline.color !== null) {
		invalidField(
			context,
			"outline.color",
			"null unless the outline mode is uniform",
			outline.color,
		);
	}
	return outline;
}

function readLight(value: unknown, context: DocContext): StyleLightRules {
	return readSection<StyleLightRules>(value, context, "light", LIGHT_FIELDS);
}

function readLimits(value: unknown, context: DocContext): StyleLimitRules {
	return readSection<StyleLimitRules>(value, context, "limits", LIMITS_FIELDS);
}

function readHighlight(
	value: unknown,
	context: DocContext,
): StyleHighlightRules {
	return readSection<StyleHighlightRules>(
		value,
		context,
		"highlight",
		HIGHLIGHT_FIELDS,
	);
}

function readDither(value: unknown, context: DocContext): StyleDitherRules {
	return readSection<StyleDitherRules>(value, context, "dither", DITHER_FIELDS);
}

function readAnimation(
	value: unknown,
	context: DocContext,
): StyleAnimationRules {
	return readSection<StyleAnimationRules>(
		value,
		context,
		"animation",
		ANIMATION_FIELDS,
	);
}

/** Read a section's known fields; keys the call does not carry are skipped. */
function readSection<T>(
	value: unknown,
	context: DocContext,
	base: string,
	fields: Record<string, FieldReader>,
): T {
	const section = expectObject(value, context, base);
	expectKnownKeys(section, Object.keys(fields), context, base);
	const out: JsonObject = {};
	for (const [key, reader] of Object.entries(fields)) {
		if (key in section) {
			out[key] = reader(section[key], context, `${base}.${key}`);
		}
	}
	return out as T;
}

function readPalettes(
	value: unknown,
	context: DocContext,
): Record<string, Partial<Record<FamilyRole, string>>> {
	const palettes = expectObject(value, context, "palettes");
	const out: Record<string, Partial<Record<FamilyRole, string>>> = {};
	for (const [family, ramp] of Object.entries(palettes)) {
		if (!FAMILY_ID_PATTERN.test(family)) {
			invalidField(
				context,
				`palettes.${family}`,
				"a family id matching [a-z][a-z0-9_-]{0,31}",
				family,
			);
		}
		const roles = expectObject(ramp, context, `palettes.${family}`);
		const outRamp: Partial<Record<FamilyRole, string>> = {};
		for (const [role, color] of Object.entries(roles)) {
			if (!(FAMILY_ROLES as readonly string[]).includes(role)) {
				invalidField(
					context,
					`palettes.${family}.${role}`,
					`one of ${FAMILY_ROLES.join(" | ")}`,
					color,
				);
			}
			outRamp[role as FamilyRole] = expectColor(
				color,
				context,
				`palettes.${family}.${role}`,
			);
		}
		out[family] = outRamp;
	}
	return out;
}

function readCategoryOverrides(
	value: unknown,
	context: DocContext,
): Record<string, StyleCategoryOverride> {
	const overrides = expectObject(value, context, "categoryOverrides");
	const out: Record<string, StyleCategoryOverride> = {};
	for (const [category, override] of Object.entries(overrides)) {
		if (!(CATEGORY_IDS as readonly string[]).includes(category)) {
			invalidField(
				context,
				`categoryOverrides.${category}`,
				`one of ${CATEGORY_IDS.join(" | ")}`,
				category,
			);
		}
		const sections = expectObject(
			override,
			context,
			`categoryOverrides.${category}`,
		);
		const outOverride: JsonObject = {};
		for (const [section, sectionValue] of Object.entries(sections)) {
			const fields = CATEGORY_SECTIONS[section];
			if (fields === undefined) {
				invalidField(
					context,
					`categoryOverrides.${category}.${section}`,
					`one of ${Object.keys(CATEGORY_SECTIONS).join(" | ")}`,
					sectionValue,
				);
			}
			outOverride[section] = readSection(
				sectionValue,
				context,
				`categoryOverrides.${category}.${section}`,
				fields,
			);
		}
		out[category] = outOverride as StyleCategoryOverride;
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Role completion (§3.4)                                              */
/* ------------------------------------------------------------------ */

/** Fill every missing role of every family, in the frozen rule order. */
function completePalettes(
	palettes: Record<string, Partial<Record<FamilyRole, string>>>,
	context: DocContext,
): Record<string, FamilyRamp> {
	const out: Record<string, FamilyRamp> = {};
	for (const [family, ramp] of Object.entries(palettes)) {
		out[family] = completeRamp(ramp, context, family);
	}
	return out;
}

function completeRamp(
	ramp: Partial<Record<FamilyRole, string>>,
	context: DocContext,
	family: string,
): FamilyRamp {
	const roles = { ...ramp };
	if (Object.keys(roles).length === 0) {
		invalidField(
			context,
			`palettes.${family}`,
			"at least one role to derive the missing roles from",
			{},
		);
	}
	const outline = roles.outline ?? deriveOutline(roles, context, family);
	const shadow = roles.shadow ?? deriveShadow(roles, outline, context, family);
	const base = roles.base ?? requireRole(roles, "base", context, family);
	const dark = roles.dark ?? deriveFromRole(base, 80, undefined);
	const light = roles.light ?? deriveFromRole(base, 120, undefined);
	const highlight = roles.highlight ?? deriveFromRole(light, 130, 600);
	return { outline, shadow, dark, base, light, highlight };
}

/** Rule 1: the darkest existing role, 60% lightness and 94% saturation. */
function deriveOutline(
	roles: Partial<Record<FamilyRole, string>>,
	context: DocContext,
	family: string,
): string {
	let darkest: string | undefined;
	let darkestLightness = Number.POSITIVE_INFINITY;
	for (const role of FAMILY_ROLES) {
		const value = roles[role];
		if (value === undefined) {
			continue;
		}
		const lightness = hsl255(parseHexColor(value)).lightness;
		if (lightness < darkestLightness) {
			darkest = value;
			darkestLightness = lightness;
		}
	}
	if (darkest === undefined) {
		invalidField(
			context,
			`palettes.${family}`,
			"at least one role to derive the outline from",
			{},
		);
	}
	const source = parseHexColor(darkest);
	const { lightness, saturation } = hsl255(source);
	return formatHexColor(
		withLightnessSaturation(
			source,
			clamp255(truncatedDiv(lightness * 60, 100)),
			Math.min(255, truncatedDiv(saturation * 940, 1000)),
		),
	);
}

/** Rule 2: the reference role keeps its hue and saturation; lightness is
 * the truncated midpoint of the outline and the reference. */
function deriveShadow(
	roles: Partial<Record<FamilyRole, string>>,
	outline: string,
	context: DocContext,
	family: string,
): string {
	const referenceRole: FamilyRole = roles.dark !== undefined ? "dark" : "base";
	const reference = parseHexColor(
		requireRole(roles, referenceRole, context, family),
	);
	const referenceLightness = hsl255(reference).lightness;
	const targetLightness = clamp255(
		truncatedDiv(
			hsl255(parseHexColor(outline)).lightness + referenceLightness,
			2,
		),
	);
	return formatHexColor(
		withLightnessSaturation(
			reference,
			targetLightness,
			hsl255(reference).saturation,
		),
	);
}

/** Rules 3 to 5: scale one role's lightness (percent) and saturation. */
function deriveFromRole(
	sourceHex: string,
	lightnessPercent: number,
	saturationPermille: number | undefined,
): string {
	const source = parseHexColor(sourceHex);
	const { lightness, saturation } = hsl255(source);
	const targetLightness = clamp255(
		truncatedDiv(lightness * lightnessPercent, 100),
	);
	const targetSaturation =
		saturationPermille === undefined
			? saturation
			: Math.min(255, truncatedDiv(saturation * saturationPermille, 1000));
	return formatHexColor(
		withLightnessSaturation(source, targetLightness, targetSaturation),
	);
}

function requireRole(
	roles: Partial<Record<FamilyRole, string>>,
	role: FamilyRole,
	context: DocContext,
	family: string,
): string {
	const value = roles[role];
	if (value === undefined) {
		invalidField(
			context,
			`palettes.${family}.${role}`,
			`a ${role} color to derive the missing roles`,
			undefined,
		);
	}
	return value;
}

/* ------------------------------------------------------------------ */
/* Strict field readers                                                */
/* ------------------------------------------------------------------ */

function expectObject(
	value: unknown,
	context: DocContext,
	field: string,
): JsonObject {
	if (!isJsonObject(value)) {
		invalidField(context, field, "an object", value);
	}
	return value;
}

function expectKnownKeys(
	value: JsonObject,
	known: readonly string[],
	context: DocContext,
	base: string,
): void {
	for (const key of Object.keys(value)) {
		if (!known.includes(key)) {
			invalidField(
				context,
				base === "" ? key : `${base}.${key}`,
				"a known field",
				value[key],
			);
		}
	}
}

function expectInteger(
	value: unknown,
	context: DocContext,
	field: string,
	min: number,
	max: number,
): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	) {
		invalidField(context, field, `an integer in [${min}, ${max}]`, value);
	}
	return value;
}

function expectBoolean(
	value: unknown,
	context: DocContext,
	field: string,
): boolean {
	if (typeof value !== "boolean") {
		invalidField(context, field, "a boolean", value);
	}
	return value;
}

function expectChoice(
	value: unknown,
	context: DocContext,
	field: string,
	choices: readonly string[],
): string {
	if (typeof value !== "string" || !choices.includes(value)) {
		invalidField(context, field, choices.join(" | "), value);
	}
	return value;
}

function expectNumberChoice(
	value: unknown,
	context: DocContext,
	field: string,
	choices: readonly number[],
): number {
	if (typeof value !== "number" || !choices.includes(value)) {
		invalidField(context, field, `one of ${choices.join(", ")}`, value);
	}
	return value;
}

function expectColor(
	value: unknown,
	context: DocContext,
	field: string,
): string {
	if (!isHexColor(value)) {
		invalidField(context, field, "#RRGGBB", value);
	}
	return value;
}

function expectNullableColor(
	value: unknown,
	context: DocContext,
	field: string,
): string | null {
	if (value === null) {
		return null;
	}
	return expectColor(value, context, field);
}

function expectCategoryIds(
	value: unknown,
	context: DocContext,
	field: string,
): string[] {
	if (!Array.isArray(value)) {
		invalidField(context, field, "an array of category ids", value);
	}
	const out: string[] = [];
	for (const [index, entry] of value.entries()) {
		if (
			typeof entry !== "string" ||
			!(CATEGORY_IDS as readonly string[]).includes(entry)
		) {
			invalidField(
				context,
				`${field}[${index}]`,
				CATEGORY_IDS.join(" | "),
				entry,
			);
		}
		out.push(entry);
	}
	return out;
}

function invalidField(
	context: DocContext,
	field: string,
	expected: string,
	got: unknown,
): never {
	throw new McAssetError(
		"STYLE_INVALID",
		`${field}: expected ${expected}, got ${formatValue(got)}`,
		{
			path: context.path,
			field,
			extendsChain: [...context.chain],
		},
	);
}

/** JSON rendering of a rejected value; undefined names the missing field. */
function formatValue(value: unknown): string {
	const text = JSON.stringify(value);
	return text === undefined ? "undefined" : text;
}

/* ------------------------------------------------------------------ */
/* Canonical document text                                             */
/* ------------------------------------------------------------------ */

/** Byte-ordered keys, two-space indent, trailing newline (§11.3). */
function canonicalJson(value: unknown): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sortKeys(entry));
	}
	if (isJsonObject(value)) {
		const sorted: JsonObject = {};
		for (const key of Object.keys(value).sort(compareCodeUnits)) {
			sorted[key] = sortKeys(value[key]);
		}
		return sorted;
	}
	return value;
}

function compareCodeUnits(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}
