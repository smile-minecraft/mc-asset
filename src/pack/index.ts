/**
 * Resource-pack projects: the frozen `mc-asset.pack.json` data model, the
 * skeleton `pack init` creates, the initialization plan and its batch write,
 * and the strict reader for a project document. The CLI group and the MCP
 * tool both drive this module, so both surfaces observe the same files.
 */

export {
	initializePackProject,
	planPackInit,
	resolvePackInitVersion,
} from "./init.ts";
export { loadPackProject, parsePackProjectText } from "./load.ts";
export {
	buildPlaceholderIcon,
	compareCodeUnits,
	PACK_ASSET_DIRECTORIES,
	PACK_ITEMS_DIRECTORY,
	PACK_RECIPE_DIRECTORY,
	placeholderIconColor,
	planSkeletonDirectories,
} from "./skeleton.ts";
export {
	PACK_DEFAULT_OUTPUT_DIR,
	PACK_DEFAULT_RECIPE_DIR,
	PACK_DEFAULT_STYLE,
	PACK_DESCRIPTION_MAX_LENGTH,
	PACK_DESCRIPTION_MIN_LENGTH,
	PACK_ICON_FILE_NAME,
	PACK_ICON_SIZE,
	PACK_IDENTIFIER_PATTERN,
	PACK_MINECRAFT_NAMESPACE,
	PACK_MINECRAFT_VERSION_PATTERN,
	PACK_NAMESPACE_PATTERN,
	PACK_PROJECT_FILE_NAME,
	PACK_PROJECT_FORMAT_VERSION,
	PACK_ROOT_METADATA_FILE_NAME,
	type PackInitFile,
	type PackInitPlan,
	type PackInitRequest,
	type PackInitResult,
	type PackInitVersion,
	type PackProjectDocument,
	type PackVanillaSource,
	type PackVanillaSourceKind,
} from "./types.ts";
