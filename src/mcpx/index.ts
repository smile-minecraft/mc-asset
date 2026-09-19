import type { PixelCanvas } from "../core/types.ts";
import { buildCanvas } from "./builder.ts";
import type { McpxErrorCode, McpxErrorDetails } from "./errors.ts";
import { mcpxError } from "./errors.ts";
import type { McpxDocument } from "./parser.ts";
import { parseDocument } from "./parser.ts";
import type { SymbolMapping } from "./serializer.ts";
import { buildSymbolMap, colorKeyOf, serializeMcpx } from "./serializer.ts";
import { tokenize } from "./tokenizer.ts";
import type {
	ValidDocument,
	ValidLayer,
	ValidPaletteEntry,
	ValidRegion,
} from "./validator.ts";
import { validateDocument } from "./validator.ts";

/**
 * Public mcpx grammar surface: parse (tokenize, syntax, schema, semantic,
 * build) plus canonical serialize. Both directions are pure string
 * transforms: no environment expansion, no file reads, no URLs.
 */
export function parseMcpx(text: string): PixelCanvas {
	if (typeof text !== "string") {
		throw mcpxError("MCPX_SYNTAX_ERROR", "mcpx input must be a string.", {
			line: 0,
		});
	}
	return buildCanvas(validateDocument(parseDocument(tokenize(text))));
}

export type {
	McpxDocument,
	McpxErrorCode,
	McpxErrorDetails,
	PixelCanvas,
	SymbolMapping,
	ValidDocument,
	ValidLayer,
	ValidPaletteEntry,
	ValidRegion,
};
export { buildSymbolMap, colorKeyOf, mcpxError, serializeMcpx };
