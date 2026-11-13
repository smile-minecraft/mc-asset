import { resolve } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { CANVAS_MAX_EDGE } from "../core/validate.ts";
import { validateResourceLocation } from "../validate/resource-location.ts";

/**
 * Font icon spec document: the icon list plus the one provider geometry the
 * atlas is built from. Parsing is strict and side-effect free: every field
 * is checked here, so a rejected document never reaches the layout or the
 * write phase. The parsed value is the invariant the planner trusts: icons
 * are sorted by name, every explicit code point is unique and inside the
 * BMP private use area, and `ascent` never exceeds `height`.
 */

/** The only spec format this build reads. */
export const FONT_SPEC_FORMAT_VERSION = 1;

/** First code point of the BMP private use area (the default auto start). */
export const FONT_PUA_FIRST = 0xe000;

/** Last code point of the BMP private use area. */
export const FONT_PUA_LAST = 0xf8ff;

/** Icons per atlas row when the spec names no column count. */
export const FONT_DEFAULT_COLUMNS = 16;

/** Ordinary space, the default `space` provider character. */
const SPACE_CODE_POINT = 0x20;

const TOP_FIELDS = new Set([
	"formatVersion",
	"namespace",
	"id",
	"height",
	"ascent",
	"start",
	"columns",
	"texture",
	"reference",
	"space",
	"icons",
]);

const ICON_FIELDS = new Set(["name", "path", "codePoint"]);
const SPACE_FIELDS = new Set(["advance", "codePoint"]);

const NAMESPACE_PATTERN = /^[a-z0-9_.-]+$/;
const ID_PATTERN = /^[a-z0-9._-]+$/;
const SCALAR_LAST = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

/** One icon: the mapping key, its image path, and an optional fixed code point. */
export interface FontSpecIcon {
	readonly name: string;
	/** Image path; a relative path resolves against the spec file's directory. */
	readonly path: string;
	readonly codePoint?: number | undefined;
}

/** Optional `space` provider: one character with a fixed advance. */
export interface FontSpace {
	readonly advance: number;
	/** Defaults to U+0020, the ordinary space. */
	readonly codePoint: number;
}

/** A parsed spec, with every default already applied. */
export interface FontSpec {
	readonly formatVersion: typeof FONT_SPEC_FORMAT_VERSION;
	readonly namespace: string;
	readonly id: string;
	/** Bitmap provider height in pixels; also the atlas cell height. */
	readonly height: number;
	/** Bitmap provider ascent in pixels, at most `height`. */
	readonly ascent: number;
	/** First code point the automatic allocation may use. */
	readonly start: number;
	/** Fixed column count; omitted means `min(icon count, 16)`. */
	readonly columns?: number | undefined;
	/** Bitmap `file` resource location, `.png` included. */
	readonly texture: string;
	/** Optional `reference` provider target font id. */
	readonly reference?: string | undefined;
	readonly space?: FontSpace | undefined;
	/** Icons sorted by name in UTF-16 code-unit order. */
	readonly icons: readonly FontSpecIcon[];
}

export interface FontSpecParseOptions {
	/** Directory a relative icon path resolves against. */
	readonly baseDir: string;
	/** Spec path or a stand-in such as "<inline spec>", used in messages. */
	readonly source: string;
}

type FontSpecErrorCode = "FONT_INVALID" | "FONT_UNSUPPORTED_VERSION";

function fail(
	code: FontSpecErrorCode,
	options: FontSpecParseOptions,
	field: string,
	message: string,
	extra: Record<string, unknown> = {},
): never {
	throw new McAssetError(code, message, {
		path: options.source,
		field,
		...extra,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON rendering of a rejected value for the message; long values are cut. */
function describeValue(value: unknown): string {
	const text = JSON.stringify(value) ?? "undefined";
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function requireRecord(
	value: unknown,
	options: FontSpecParseOptions,
	field: string,
	what: string,
): Record<string, unknown> {
	if (!isRecord(value)) {
		fail(
			"FONT_INVALID",
			options,
			field,
			`"${options.source}" ${what} must be a JSON object; got ${describeValue(value)}.`,
		);
	}
	return value;
}

function checkFields(
	record: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	options: FontSpecParseOptions,
	field: string,
): void {
	for (const key of Object.keys(record).sort()) {
		if (!allowed.has(key)) {
			fail(
				"FONT_INVALID",
				options,
				field === "" ? key : `${field}.${key}`,
				`"${options.source}" has an unknown field "${key}"${field === "" ? "" : ` in "${field}"`}.`,
			);
		}
	}
}

function requireString(
	value: unknown,
	options: FontSpecParseOptions,
	field: string,
): string {
	if (typeof value !== "string" || value === "") {
		fail(
			"FONT_INVALID",
			options,
			field,
			`"${options.source}" field "${field}" must be a non-empty string; got ${describeValue(value)}.`,
		);
	}
	return value;
}

function requireInteger(
	value: unknown,
	options: FontSpecParseOptions,
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
		fail(
			"FONT_INVALID",
			options,
			field,
			`"${options.source}" field "${field}" must be an integer in [${min}, ${max}]; got ${describeValue(value)}.`,
		);
	}
	return value;
}

/** A Unicode scalar value: 0..10FFFF outside the surrogate block. */
function scalarValue(
	value: number,
	options: FontSpecParseOptions,
	field: string,
): number {
	if (
		value > SCALAR_LAST ||
		(value >= SURROGATE_FIRST && value <= SURROGATE_LAST)
	) {
		fail(
			"FONT_INVALID",
			options,
			field,
			`"${options.source}" field "${field}" is not a Unicode scalar value: ${describeValue(value)}.`,
		);
	}
	return value;
}

/** A code point given as an integer or as a one-character string. */
function requireCodePoint(
	value: unknown,
	options: FontSpecParseOptions,
	field: string,
): number {
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 0) {
			fail(
				"FONT_INVALID",
				options,
				field,
				`"${options.source}" field "${field}" must be a code point integer; got ${describeValue(value)}.`,
			);
		}
		return scalarValue(value, options, field);
	}
	if (typeof value === "string") {
		const characters = Array.from(value);
		if (characters.length !== 1) {
			fail(
				"FONT_INVALID",
				options,
				field,
				`"${options.source}" field "${field}" must be exactly one character; got ${describeValue(value)}.`,
			);
		}
		return (characters[0] as string).codePointAt(0) as number;
	}
	fail(
		"FONT_INVALID",
		options,
		field,
		`"${options.source}" field "${field}" must be a code point integer or a one-character string; got ${describeValue(value)}.`,
	);
}

/** The BMP private use area: where every icon code point must live. */
function requireIconCodePoint(
	value: unknown,
	options: FontSpecParseOptions,
	field: string,
): number {
	const codePoint = requireCodePoint(value, options, field);
	if (codePoint < FONT_PUA_FIRST || codePoint > FONT_PUA_LAST) {
		fail(
			"FONT_INVALID",
			options,
			field,
			`"${options.source}" field "${field}" must be in the private use area U+E000 to U+F8FF; got U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}.`,
		);
	}
	return codePoint;
}

/** A resource location with no unresolved shape problem of its own. */
function requireResourceLocation(
	value: unknown,
	options: FontSpecParseOptions,
	field: string,
): string {
	const location = requireString(value, options, field);
	const problems = validateResourceLocation(location).filter(
		(finding) => finding.level === "error",
	);
	const first = problems[0];
	if (first !== undefined) {
		fail(
			"FONT_INVALID",
			options,
			field,
			`"${options.source}" field "${field}" is not a usable resource location: ${first.message}`,
		);
	}
	return location;
}

function parseIcon(
	value: unknown,
	options: FontSpecParseOptions,
	index: number,
): FontSpecIcon {
	const field = `icons[${index}]`;
	const record = requireRecord(value, options, field, "icon entry");
	checkFields(record, ICON_FIELDS, options, field);
	const name = requireString(record.name, options, `${field}.name`);
	const path = requireString(record.path, options, `${field}.path`);
	const codePoint =
		record.codePoint === undefined
			? undefined
			: requireIconCodePoint(record.codePoint, options, `${field}.codePoint`);
	return {
		name,
		path: resolve(options.baseDir, path),
		...(codePoint === undefined ? {} : { codePoint }),
	};
}

function parseSpace(value: unknown, options: FontSpecParseOptions): FontSpace {
	const record = requireRecord(value, options, "space", "space provider");
	checkFields(record, SPACE_FIELDS, options, "space");
	const advance = requireInteger(
		record.advance,
		options,
		"space.advance",
		0,
		CANVAS_MAX_EDGE,
	);
	const codePoint =
		record.codePoint === undefined
			? SPACE_CODE_POINT
			: requireCodePoint(record.codePoint, options, "space.codePoint");
	return { advance, codePoint };
}

/** Claim one code point; a second owner is a conflict naming both. */
function claimCodePoint(
	claimed: Map<number, string>,
	codePoint: number,
	owner: string,
	options: FontSpecParseOptions,
): void {
	const prior = claimed.get(codePoint);
	if (prior !== undefined) {
		const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
		throw new McAssetError(
			"FONT_CODEPOINT_CONFLICT",
			`"${options.source}" assigns ${label} to both "${prior}" and "${owner}".`,
			{
				path: options.source,
				field: "icons",
				codePoint,
				owners: [prior, owner],
			},
		);
	}
	claimed.set(codePoint, owner);
}

/**
 * Read one spec document. Field checks run in a fixed order so the same
 * document always reports the same first problem; icons are sorted before
 * any collision is named, so the message does not depend on input order.
 */
export function parseFontSpec(
	value: unknown,
	options: FontSpecParseOptions,
): FontSpec {
	const record = requireRecord(value, options, "", "spec");
	checkFields(record, TOP_FIELDS, options, "");

	const rawVersion: unknown = record.formatVersion;
	if (
		typeof rawVersion === "number" &&
		Number.isInteger(rawVersion) &&
		rawVersion > FONT_SPEC_FORMAT_VERSION
	) {
		fail(
			"FONT_UNSUPPORTED_VERSION",
			options,
			"formatVersion",
			`"${options.source}" uses spec formatVersion ${rawVersion}; this build reads ${FONT_SPEC_FORMAT_VERSION}.`,
			{ formatVersion: rawVersion },
		);
	}
	if (rawVersion !== FONT_SPEC_FORMAT_VERSION) {
		fail(
			"FONT_INVALID",
			options,
			"formatVersion",
			`"${options.source}" field "formatVersion" must be ${FONT_SPEC_FORMAT_VERSION}; got ${describeValue(rawVersion)}.`,
		);
	}

	const namespace = requireString(record.namespace, options, "namespace");
	if (!NAMESPACE_PATTERN.test(namespace)) {
		fail(
			"FONT_INVALID",
			options,
			"namespace",
			`"${options.source}" field "namespace" must match [a-z0-9_.-]; got "${namespace}".`,
		);
	}
	const id = requireString(record.id, options, "id");
	if (!ID_PATTERN.test(id) || id === "." || id === "..") {
		fail(
			"FONT_INVALID",
			options,
			"id",
			`"${options.source}" field "id" must match [a-z0-9._-]; got "${id}".`,
		);
	}
	const height = requireInteger(
		record.height,
		options,
		"height",
		1,
		CANVAS_MAX_EDGE,
	);
	const ascent = requireInteger(record.ascent, options, "ascent", 0, height);
	const start =
		record.start === undefined
			? FONT_PUA_FIRST
			: requireIconCodePoint(record.start, options, "start");

	const texture =
		record.texture === undefined
			? `${namespace}:font/${id}.png`
			: requireResourceLocation(record.texture, options, "texture");
	if (!texture.toLowerCase().endsWith(".png")) {
		fail(
			"FONT_INVALID",
			options,
			"texture",
			`"${options.source}" field "texture" must name a .png texture; got "${texture}".`,
		);
	}
	const reference =
		record.reference === undefined
			? undefined
			: requireResourceLocation(record.reference, options, "reference");
	if (
		reference !== undefined &&
		(reference.toLowerCase().endsWith(".png") ||
			reference.toLowerCase().endsWith(".json"))
	) {
		fail(
			"FONT_INVALID",
			options,
			"reference",
			`"${options.source}" field "reference" names a font id without an extension; got "${reference}".`,
		);
	}
	const space =
		record.space === undefined ? undefined : parseSpace(record.space, options);

	const rawIcons: unknown = record.icons;
	if (!Array.isArray(rawIcons) || rawIcons.length === 0) {
		fail(
			"FONT_INVALID",
			options,
			"icons",
			`"${options.source}" field "icons" must be a non-empty array; got ${describeValue(rawIcons)}.`,
		);
	}
	const icons = rawIcons
		.map((entry, index) => parseIcon(entry, options, index))
		.sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		);
	for (let index = 1; index < icons.length; index += 1) {
		const prior = icons[index - 1] as FontSpecIcon;
		const icon = icons[index] as FontSpecIcon;
		if (prior.name === icon.name) {
			fail(
				"FONT_INVALID",
				options,
				"icons",
				`"${options.source}" names the icon "${icon.name}" more than once.`,
				{ name: icon.name },
			);
		}
	}

	const claimed = new Map<number, string>();
	if (space !== undefined) {
		claimCodePoint(claimed, space.codePoint, "space", options);
	}
	for (const icon of icons) {
		if (icon.codePoint !== undefined) {
			claimCodePoint(claimed, icon.codePoint, icon.name, options);
		}
	}

	const columns =
		record.columns === undefined
			? undefined
			: requireInteger(record.columns, options, "columns", 1, CANVAS_MAX_EDGE);
	if (columns !== undefined && columns > icons.length) {
		fail(
			"FONT_INVALID",
			options,
			"columns",
			`"${options.source}" field "columns" is ${columns} but there ${icons.length === 1 ? "is" : "are"} only ${icons.length} icon${icons.length === 1 ? "" : "s"}; a row cannot have empty cells.`,
			{ columns, icons: icons.length },
		);
	}

	return {
		formatVersion: FONT_SPEC_FORMAT_VERSION,
		namespace,
		id,
		height,
		ascent,
		start,
		...(columns === undefined ? {} : { columns }),
		texture,
		...(reference === undefined ? {} : { reference }),
		...(space === undefined ? {} : { space }),
		icons,
	};
}
