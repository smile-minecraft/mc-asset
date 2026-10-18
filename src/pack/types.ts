/**
 * Resource-pack project data model: the frozen vocabulary of
 * `mc-asset.pack.json` (field names, defaults, format version) plus the
 * shapes `pack init` plans and reports. Planning, the skeleton, and reading
 * the document back live in the sibling modules.
 */

/** Format version this toolchain writes and accepts. */
export const PACK_PROJECT_FORMAT_VERSION = 1;

/** Fixed project file name, held in the project root. */
export const PACK_PROJECT_FILE_NAME = "mc-asset.pack.json";

/** Pack root metadata file, inside the resource-pack output directory. */
export const PACK_ROOT_METADATA_FILE_NAME = "pack.mcmeta";

/** Pack icon file, inside the resource-pack output directory. */
export const PACK_ICON_FILE_NAME = "pack.png";

/** Placeholder icon edge length in pixels. */
export const PACK_ICON_SIZE = 64;

/** Default resource-pack output directory, relative to the project root. */
export const PACK_DEFAULT_OUTPUT_DIR = "pack";

/** Default recipe directory, relative to the project root. */
export const PACK_DEFAULT_RECIPE_DIR = "recipes";

/** Default style source, resolved with the same rules as the image tools. */
export const PACK_DEFAULT_STYLE = "vanilla";

/** Longest project name and namespace. */
export const PACK_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Namespace of a resource location: lowercase, and only the characters a
 * resource pack path may carry. A dot and a dash are allowed inside; the
 * first character is a letter, so the name never reads as a version.
 */
export const PACK_NAMESPACE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

/** Namespace that needs the explicit opt-in, because it overrides the game. */
export const PACK_MINECRAFT_NAMESPACE = "minecraft";

/** Description length bounds carried into the root metadata. */
export const PACK_DESCRIPTION_MIN_LENGTH = 1;
export const PACK_DESCRIPTION_MAX_LENGTH = 128;

/** Release version shape accepted in the project document. */
export const PACK_MINECRAFT_VERSION_PATTERN = /^\d+(\.\d+)*$/;

/** Where a vanilla source tree comes from. */
export type PackVanillaSourceKind = "assets-dir" | "client-jar";

/** Vanilla source reference, always relative to the project root. */
export interface PackVanillaSource {
	readonly kind: PackVanillaSourceKind;
	readonly path: string;
}

/** One project document, after defaults are filled in. */
export interface PackProjectDocument {
	readonly formatVersion: number;
	readonly name: string;
	readonly description: string;
	readonly namespace: string;
	readonly allowMinecraftNamespace: boolean;
	readonly minecraftVersion: string;
	readonly resourcePackVersion: string;
	readonly style: string;
	readonly outputDir: string;
	readonly recipeDir: string;
	readonly vanillaSource: PackVanillaSource | null;
}

/** What `pack init` needs; every field beyond the target comes from defaults. */
export interface PackInitRequest {
	readonly projectDir: string;
	readonly namespace: string;
	readonly minecraftVersion: string;
	readonly name?: string | undefined;
	readonly description?: string | undefined;
	readonly style?: string | undefined;
	readonly resourcePackVersion?: string | undefined;
	readonly allowMinecraftNamespace?: boolean | undefined;
}

/** The version a request pinned, after both version fields are read. */
export interface PackInitVersion {
	readonly minecraftVersion: string;
	readonly packFormat: string;
	/** The resource-pack format the project document records. */
	readonly resourcePackVersion: string;
}

/** One file the plan writes, with its bytes fixed before the first write. */
export interface PackInitFile {
	/** Absolute path. */
	readonly path: string;
	/** Path relative to the project root, in byte order across the plan. */
	readonly relativePath: string;
	readonly data: Uint8Array | string;
}

/** Everything a successful init writes, decided before any byte is written. */
export interface PackInitPlan {
	readonly projectDir: string;
	readonly version: PackInitVersion;
	readonly project: PackProjectDocument;
	readonly files: readonly PackInitFile[];
	/**
	 * Directories the plan creates, relative to the project root in byte
	 * order with every intermediate listed, so a report names each path.
	 */
	readonly directories: readonly string[];
}

/** What `pack init` reports after the whole batch landed. */
export interface PackInitResult {
	/** Absolute project directory. */
	readonly projectDir: string;
	/** Absolute path of the project document. */
	readonly projectPath: string;
	readonly minecraftVersion: string;
	readonly packFormat: string;
	readonly resourcePackVersion: string;
	/** Written files, relative to the project root in byte order. */
	readonly files: readonly string[];
	/** Created directories, relative to the project root in byte order. */
	readonly directories: readonly string[];
}
