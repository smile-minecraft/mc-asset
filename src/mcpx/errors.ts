import { McAssetError } from "../core/errors.ts";

/** Error codes the mcpx grammar layer may raise. */
export type McpxErrorCode =
	| "MCPX_SYNTAX_ERROR"
	| "MCPX_SCHEMA_ERROR"
	| "MCPX_SEMANTIC_ERROR"
	| "MCPX_UNSUPPORTED_VERSION"
	| "INVALID_GRID_SIZE"
	| "INVALID_MASK_SIZE";

export interface McpxErrorDetails {
	line?: number;
	section?: string;
	[key: string]: unknown;
}

export function mcpxError(
	code: McpxErrorCode,
	message: string,
	details?: McpxErrorDetails,
): McAssetError {
	return new McAssetError(code, message, details ?? {});
}
