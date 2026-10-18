import { readFile } from "node:fs/promises";
import { McAssetError } from "../core/errors.ts";
import { normalizePackFormat } from "../profiles/versions.ts";
import {
	formatValue,
	isJsonObject,
	isKnownStyleReference,
	isRelativeProjectPath,
	type ProjectDocumentContext,
	projectDocumentFailure,
} from "./document.ts";
import {
	PACK_DEFAULT_OUTPUT_DIR,
	PACK_DEFAULT_RECIPE_DIR,
	PACK_DEFAULT_STYLE,
	PACK_DESCRIPTION_MAX_LENGTH,
	PACK_DESCRIPTION_MIN_LENGTH,
	PACK_IDENTIFIER_PATTERN,
	PACK_MINECRAFT_NAMESPACE,
	PACK_MINECRAFT_VERSION_PATTERN,
	PACK_NAMESPACE_PATTERN,
	PACK_PROJECT_FORMAT_VERSION,
	type PackProjectDocument,
	type PackVanillaSource,
} from "./types.ts";
import { releasePackFormat } from "./versions.ts";

/**
 * Reading a project document back. The document is read in strict mode: the
 * field set is closed, every value is checked against the documented shape,
 * and a refusal names the field path it rejected so a caller can fix exactly
 * one field. A document that declares a newer format version is refused
 * instead of guessed at.
 */

/** The closed field set of one project document; any other key is refused. */
const PROJECT_DOCUMENT_FIELDS: ReadonlySet<string> = new Set([
	"formatVersion",
	"name",
	"description",
	"namespace",
	"allowMinecraftNamespace",
	"minecraftVersion",
	"resourcePackVersion",
	"style",
	"outputDir",
	"recipeDir",
	"vanillaSource",
]);

/** Resource-pack format as the document accepts it: N or N.M. */
const RESOURCE_PACK_VERSION_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Validate one parsed project document and return it with defaults filled in.
 * Unknown fields, wrong types, values outside their enumeration, and paths
 * that leave the project root are `PACK_PROJECT_INVALID`; a `formatVersion`
 * above the supported one is `PACK_PROJECT_UNSUPPORTED_VERSION`. Every
 * refusal carries the document path, the field path, and the release version
 * once the document names one. The release version itself must be one the
 * version table knows: it is a target, and the resource-pack format the
 * document defaults to is derived from it.
 */
export function parsePackProjectText(
	text: string,
	path: string,
): PackProjectDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		throw new McAssetError(
			"PACK_PROJECT_INVALID",
			`Project document is not valid JSON: ${path}.`,
			{ path, field: "" },
		);
	}
	if (!isJsonObject(parsed)) {
		throw new McAssetError(
			"PACK_PROJECT_INVALID",
			`Project document is not a JSON object: ${path}.`,
			{ path, field: "" },
		);
	}
	const context: ProjectDocumentContext = {
		path,
		minecraftVersion:
			typeof parsed.minecraftVersion === "string"
				? parsed.minecraftVersion
				: undefined,
	};

	const formatVersion = parsed.formatVersion;
	if (
		typeof formatVersion !== "number" ||
		!Number.isInteger(formatVersion) ||
		formatVersion < 1
	) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"formatVersion",
			`formatVersion: expected the integer ${PACK_PROJECT_FORMAT_VERSION}, got ${formatValue(formatVersion)}.`,
		);
	}
	if (formatVersion !== PACK_PROJECT_FORMAT_VERSION) {
		throw projectDocumentFailure(
			"PACK_PROJECT_UNSUPPORTED_VERSION",
			context,
			"formatVersion",
			`formatVersion: ${formatVersion} is newer than the supported ${PACK_PROJECT_FORMAT_VERSION}; a newer document is refused instead of guessed at.`,
		);
	}
	for (const key of Object.keys(parsed)) {
		if (!PROJECT_DOCUMENT_FIELDS.has(key)) {
			throw projectDocumentFailure(
				"PACK_PROJECT_INVALID",
				context,
				key,
				`${key}: unknown field; the project document has a closed field set.`,
			);
		}
	}

	const name = parsed.name;
	if (typeof name !== "string" || !PACK_IDENTIFIER_PATTERN.test(name)) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"name",
			`name: expected an identifier, got ${formatValue(name)}.`,
		);
	}

	const rawDescription = parsed.description;
	let description: string;
	if (rawDescription === undefined) {
		description = name;
	} else if (
		typeof rawDescription !== "string" ||
		rawDescription.length < PACK_DESCRIPTION_MIN_LENGTH ||
		rawDescription.length > PACK_DESCRIPTION_MAX_LENGTH
	) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"description",
			`description: expected a string of ${PACK_DESCRIPTION_MIN_LENGTH} to ${PACK_DESCRIPTION_MAX_LENGTH} characters, got ${formatValue(rawDescription)}.`,
		);
	} else {
		description = rawDescription;
	}

	const namespace = parsed.namespace;
	if (
		typeof namespace !== "string" ||
		!PACK_NAMESPACE_PATTERN.test(namespace)
	) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"namespace",
			`namespace: expected lowercase letters, digits, "_", ".", or "-", got ${formatValue(namespace)}.`,
		);
	}
	const rawAllow = parsed.allowMinecraftNamespace;
	if (rawAllow !== undefined && typeof rawAllow !== "boolean") {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"allowMinecraftNamespace",
			`allowMinecraftNamespace: expected a boolean, got ${formatValue(rawAllow)}.`,
		);
	}
	const allowMinecraftNamespace = rawAllow === true;
	if (namespace === PACK_MINECRAFT_NAMESPACE && !allowMinecraftNamespace) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"namespace",
			`namespace: "minecraft" is reserved and overrides the game; set allowMinecraftNamespace to true to use it.`,
		);
	}

	const minecraftVersion = parsed.minecraftVersion;
	if (
		typeof minecraftVersion !== "string" ||
		!PACK_MINECRAFT_VERSION_PATTERN.test(minecraftVersion)
	) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"minecraftVersion",
			`minecraftVersion: expected a release version like "1.21.9", got ${formatValue(minecraftVersion)}.`,
		);
	}
	const derivedFormat = releasePackFormat(minecraftVersion);
	if (derivedFormat === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unsupported minecraftVersion "${minecraftVersion}"; the toolchain has no resource-pack facts for that release.`,
			{ path, field: "minecraftVersion", minecraftVersion },
		);
	}

	const rawResourcePackVersion = parsed.resourcePackVersion;
	let resourcePackVersion: string;
	if (rawResourcePackVersion === undefined) {
		resourcePackVersion = derivedFormat;
	} else if (
		typeof rawResourcePackVersion !== "string" ||
		!RESOURCE_PACK_VERSION_PATTERN.test(rawResourcePackVersion)
	) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"resourcePackVersion",
			`resourcePackVersion: expected N or N.M, got ${formatValue(rawResourcePackVersion)}.`,
		);
	} else {
		try {
			resourcePackVersion = normalizePackFormat(rawResourcePackVersion);
		} catch {
			throw projectDocumentFailure(
				"PACK_PROJECT_INVALID",
				context,
				"resourcePackVersion",
				`resourcePackVersion: expected N or N.M with a major of at least 1, got ${formatValue(rawResourcePackVersion)}.`,
			);
		}
	}

	const rawStyle = parsed.style;
	let style: string;
	if (rawStyle === undefined) {
		style = PACK_DEFAULT_STYLE;
	} else if (typeof rawStyle !== "string" || !isKnownStyleReference(rawStyle)) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"style",
			`style: expected a builtin preset id or a .style.json path, got ${formatValue(rawStyle)}.`,
		);
	} else {
		style = rawStyle;
	}

	const rawOutputDir = parsed.outputDir;
	let outputDir: string;
	if (rawOutputDir === undefined) {
		outputDir = PACK_DEFAULT_OUTPUT_DIR;
	} else if (
		typeof rawOutputDir !== "string" ||
		!isRelativeProjectPath(rawOutputDir)
	) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"outputDir",
			`outputDir: expected a path inside the project root, got ${formatValue(rawOutputDir)}.`,
		);
	} else {
		outputDir = rawOutputDir;
	}

	const rawRecipeDir = parsed.recipeDir;
	let recipeDir: string;
	if (rawRecipeDir === undefined) {
		recipeDir = PACK_DEFAULT_RECIPE_DIR;
	} else if (
		typeof rawRecipeDir !== "string" ||
		!isRelativeProjectPath(rawRecipeDir)
	) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"recipeDir",
			`recipeDir: expected a path inside the project root, got ${formatValue(rawRecipeDir)}.`,
		);
	} else {
		recipeDir = rawRecipeDir;
	}

	const rawVanillaSource = parsed.vanillaSource;
	let vanillaSource: PackVanillaSource | null = null;
	if (rawVanillaSource !== undefined && rawVanillaSource !== null) {
		if (!isJsonObject(rawVanillaSource)) {
			throw projectDocumentFailure(
				"PACK_PROJECT_INVALID",
				context,
				"vanillaSource",
				`vanillaSource: expected an object or null, got ${formatValue(rawVanillaSource)}.`,
			);
		}
		for (const key of Object.keys(rawVanillaSource)) {
			if (key !== "kind" && key !== "path") {
				throw projectDocumentFailure(
					"PACK_PROJECT_INVALID",
					context,
					`vanillaSource.${key}`,
					`vanillaSource.${key}: unknown field; the source has a closed field set.`,
				);
			}
		}
		const rawKind = rawVanillaSource.kind;
		const kind =
			rawKind === "assets-dir" || rawKind === "client-jar"
				? rawKind
				: undefined;
		if (kind === undefined) {
			throw projectDocumentFailure(
				"PACK_PROJECT_INVALID",
				context,
				"vanillaSource.kind",
				`vanillaSource.kind: expected "assets-dir" or "client-jar", got ${formatValue(rawKind)}.`,
			);
		}
		const sourcePath = rawVanillaSource.path;
		if (typeof sourcePath !== "string" || !isRelativeProjectPath(sourcePath)) {
			throw projectDocumentFailure(
				"PACK_PROJECT_INVALID",
				context,
				"vanillaSource.path",
				`vanillaSource.path: expected a path inside the project root, got ${formatValue(sourcePath)}.`,
			);
		}
		vanillaSource = { kind, path: sourcePath };
	}

	return {
		formatVersion: PACK_PROJECT_FORMAT_VERSION,
		name,
		description,
		namespace,
		allowMinecraftNamespace,
		minecraftVersion,
		resourcePackVersion,
		style,
		outputDir,
		recipeDir,
		vanillaSource,
	};
}

/**
 * Read and validate one project document at an explicit path. Nothing is
 * searched: an unreadable path is `PACK_PROJECT_NOT_FOUND`, because every
 * command that reads a project document is given the path.
 */
export async function loadPackProject(
	path: string,
): Promise<PackProjectDocument> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new McAssetError(
			"PACK_PROJECT_NOT_FOUND",
			`Cannot read the project document: ${path}`,
			{ path },
		);
	}
	return parsePackProjectText(text, path);
}
