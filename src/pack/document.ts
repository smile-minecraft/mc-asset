import { McAssetError } from "../core/errors.ts";
import { STYLE_FILE_SUFFIX, STYLE_PRESET_IDS } from "../style/types.ts";
import { compareCodeUnits } from "./skeleton.ts";

/**
 * Project-document rules shared by the planner and the strict reader: the
 * canonical JSON rendering every written document uses, the relative path
 * rule for the directories a document names, the style reference a document
 * may hold, and the refusal shape both sides attach. Keeping one helper for
 * each rule keeps the reader exactly as strict as the writer.
 */

/** Builtin style ids a project may name without a file path. */
const BUILTIN_STYLE_IDS: ReadonlySet<string> = new Set(STYLE_PRESET_IDS);

/** Where a refusal points: the document path and the release version, if read. */
export interface ProjectDocumentContext {
	readonly path: string;
	readonly minecraftVersion: string | undefined;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical document text: byte-ordered keys, two-space indent, trailing newline. */
export function canonicalDocumentText(value: unknown): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sortKeys(entry));
	}
	if (isJsonObject(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort(compareCodeUnits)) {
			sorted[key] = sortKeys(value[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * The relative path rule every document path obeys: slash-separated, not
 * absolute, no backslash, no empty segment, no `..` segment, and no
 * trailing slash. A path that passes stays inside the project root.
 */
export function isRelativeProjectPath(value: string): boolean {
	if (value.startsWith("/") || value.includes("\\")) {
		return false;
	}
	return value
		.split("/")
		.every((segment) => segment !== "" && segment !== "..");
}

/**
 * A style reference in the shape the single-asset tools resolve: a builtin
 * preset id, or a `.style.json` path relative to the project root. Whether
 * a custom file exists is checked when it is read, not when it is recorded.
 */
export function isKnownStyleReference(value: string): boolean {
	if (BUILTIN_STYLE_IDS.has(value)) {
		return true;
	}
	return value.endsWith(STYLE_FILE_SUFFIX) && isRelativeProjectPath(value);
}

/** JSON rendering of a rejected value; undefined names a missing field. */
export function formatValue(value: unknown): string {
	const text = JSON.stringify(value);
	return text === undefined ? "undefined" : text;
}

/**
 * The refusal shape every project-document error carries: the document
 * path, the field path a caller localizes on, and the release version once
 * the document names one.
 */
export function projectDocumentFailure(
	code: "PACK_PROJECT_INVALID" | "PACK_PROJECT_UNSUPPORTED_VERSION",
	context: ProjectDocumentContext,
	field: string,
	message: string,
): McAssetError {
	return new McAssetError(code, message, {
		path: context.path,
		field,
		...(context.minecraftVersion === undefined
			? {}
			: { minecraftVersion: context.minecraftVersion }),
	});
}
