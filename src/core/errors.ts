/** Error code registry and error-code to exit-code mapping. */

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export type ErrorCode =
	| "INTERNAL_ERROR"
	| "INVALID_ARGUMENT"
	| "ARGUMENT_CONFLICT"
	| "INVALID_DIMENSION"
	| "INVALID_COORDINATE"
	| "OUT_OF_BOUNDS"
	| "INVALID_COLOR"
	| "INVALID_MASK_SIZE"
	| "INVALID_GRID_SIZE"
	| "UNKNOWN_PALETTE_SYMBOL"
	| "UNKNOWN_OPERATION"
	| "DUPLICATE_OPERATION_ID"
	| "LAYER_NOT_FOUND"
	| "REGION_NOT_FOUND"
	| "DUPLICATE_LAYER_ID"
	| "DUPLICATE_REGION_ID"
	| "INVALID_PROFILE"
	| "MCPX_SYNTAX_ERROR"
	| "MCPX_SCHEMA_ERROR"
	| "MCPX_SEMANTIC_ERROR"
	| "MCPX_PALETTE_OVERFLOW"
	| "INVALID_ANIMATION_FRAME"
	| "INVALID_MCMETA"
	| "OUTPUT_REQUIRED"
	| "VALIDATION_FAILED"
	| "ATLAS_REFERENCE_ERROR"
	| "TEXTURE_NOT_IN_REQUIRED_ATLAS"
	| "FILESYSTEM_ERROR"
	| "OUTPUT_EXISTS"
	| "MCPX_UNSUPPORTED_VERSION"
	| "UNSUPPORTED_IMAGE_FORMAT"
	| "UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT"
	| "RESOURCE_LIMIT_EXCEEDED"
	| "PACK_INVALID_JSON"
	| "PACK_MISSING_TEXTURE"
	| "PACK_MISSING_ASSET"
	| "PACK_WRONG_PATH"
	| "PACK_NAMESPACE_PROBLEM"
	| "PACK_CASE_MISMATCH"
	| "PACK_ORPHAN_TEXTURE"
	| "PACK_INVALID_ANIMATION_SHEET"
	| "PACK_INVALID_IMAGE_DIMENSION"
	| "PACK_BROKEN_REFERENCE"
	| "PACK_TEXTURE_NOT_IN_ATLAS"
	| "PACK_INVALID_IMAGE_DATA"
	| "PACK_INVALID_FILENAME"
	| "PACK_VERSION_UNDETERMINED"
	| "PACK_GUI_SCALING_BORDER"
	| "PACK_UNRESOLVED_EXTERNAL"
	| "PACK_COVERAGE_SKIPPED"
	| "TRANSACTION_FAILED";

export type FixedErrorCode = Exclude<ErrorCode, "TRANSACTION_FAILED">;

/** Single source of truth for the error-code to exit-code mapping. */
export const ERROR_EXIT_CODE: Record<FixedErrorCode, ExitCode> = {
	INTERNAL_ERROR: 1,
	INVALID_ARGUMENT: 2,
	ARGUMENT_CONFLICT: 2,
	INVALID_DIMENSION: 2,
	INVALID_COORDINATE: 2,
	OUT_OF_BOUNDS: 2,
	INVALID_COLOR: 2,
	INVALID_MASK_SIZE: 2,
	INVALID_GRID_SIZE: 2,
	UNKNOWN_PALETTE_SYMBOL: 2,
	UNKNOWN_OPERATION: 2,
	DUPLICATE_OPERATION_ID: 2,
	LAYER_NOT_FOUND: 2,
	REGION_NOT_FOUND: 2,
	DUPLICATE_LAYER_ID: 2,
	DUPLICATE_REGION_ID: 2,
	INVALID_PROFILE: 2,
	MCPX_SYNTAX_ERROR: 2,
	MCPX_SCHEMA_ERROR: 2,
	MCPX_SEMANTIC_ERROR: 2,
	MCPX_PALETTE_OVERFLOW: 2,
	INVALID_ANIMATION_FRAME: 2,
	INVALID_MCMETA: 2,
	OUTPUT_REQUIRED: 2,
	VALIDATION_FAILED: 3,
	ATLAS_REFERENCE_ERROR: 3,
	TEXTURE_NOT_IN_REQUIRED_ATLAS: 3,
	FILESYSTEM_ERROR: 4,
	OUTPUT_EXISTS: 4,
	MCPX_UNSUPPORTED_VERSION: 5,
	UNSUPPORTED_IMAGE_FORMAT: 5,
	UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT: 5,
	RESOURCE_LIMIT_EXCEEDED: 5,
	// Pack findings. These codes travel inside
	// the validate-pack report; a failing verdict throws VALIDATION_FAILED.
	// They are registered here so the §99 registry stays the single exit
	// authority. PACK_TEXTURE_NOT_IN_ATLAS is reserved for the atlas
	// check that lands separately; the warning-level codes never fail.
	PACK_INVALID_JSON: 3,
	PACK_MISSING_TEXTURE: 3,
	PACK_MISSING_ASSET: 3,
	PACK_WRONG_PATH: 3,
	PACK_NAMESPACE_PROBLEM: 3,
	PACK_CASE_MISMATCH: 3,
	PACK_ORPHAN_TEXTURE: 3,
	PACK_INVALID_ANIMATION_SHEET: 3,
	PACK_INVALID_IMAGE_DIMENSION: 3,
	PACK_BROKEN_REFERENCE: 3,
	PACK_TEXTURE_NOT_IN_ATLAS: 3,
	PACK_INVALID_IMAGE_DATA: 3,
	PACK_INVALID_FILENAME: 3,
	PACK_VERSION_UNDETERMINED: 3,
	PACK_GUI_SCALING_BORDER: 3,
	PACK_UNRESOLVED_EXTERNAL: 3,
	// Coverage gaps that stay warnings: the verdict only covers what was
	// checked, and the coverage list carries what was skipped.
	PACK_COVERAGE_SKIPPED: 3,
};

export function isErrorCode(value: unknown): value is ErrorCode {
	return (
		typeof value === "string" &&
		(value === "TRANSACTION_FAILED" || value in ERROR_EXIT_CODE)
	);
}

/** Exit code for a fixed error code. */
export function exitCodeForError(code: FixedErrorCode): ExitCode {
	return ERROR_EXIT_CODE[code];
}

/**
 * Exit code for any error code. TRANSACTION_FAILED carries no fixed exit:
 * the error that caused the rollback decides. Without a cause it falls
 * back to the general exit.
 */
export function resolveExitCode(code: ErrorCode, cause?: ErrorCode): ExitCode {
	if (code === "TRANSACTION_FAILED") {
		if (cause === undefined || cause === "TRANSACTION_FAILED") {
			return 1;
		}
		return resolveExitCode(cause);
	}
	return ERROR_EXIT_CODE[code];
}

export class McAssetError extends Error {
	readonly code: ErrorCode;
	readonly details?: unknown;

	constructor(code: ErrorCode, message?: string, details?: unknown) {
		super(message === undefined ? `[${code}]` : `[${code}] ${message}`);
		this.name = "McAssetError";
		this.code = code;
		this.details = details;
	}
}
