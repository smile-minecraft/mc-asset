import type {
	AuthoringPaletteEntry,
	PixelCanvas,
	RGBA,
} from "../core/types.ts";
import { assertValidCanvas } from "../core/validate.ts";
import { mcpxError } from "./errors.ts";

/**
 * Canonical serializer: the same PixelCanvas always yields byte-for-byte the
 * same mcpx text (UTF-8, LF, fixed section order, uppercase #RRGGBBAA).
 * Existing palette assignments are preserved verbatim and never reordered;
 * new color-to-symbol assignment belongs to a later task, which can reuse
 * buildSymbolMap as its seam.
 */

/** Exact per-channel key: integer channels joined, no float formatting. */
export function colorKeyOf(color: RGBA): string {
	return `${color.r},${color.g},${color.b},${color.a}`;
}

export interface SymbolMapping {
	/** First palette entry wins when two symbols share one color. */
	symbolForColor: Map<string, string>;
	colorForSymbol: Map<string, RGBA>;
	/** True when every symbol is one character, so [grid] suffices. */
	compact: boolean;
}

export function buildSymbolMap(
	entries: ReadonlyArray<Pick<AuthoringPaletteEntry, "id" | "color">>,
): SymbolMapping {
	const symbolForColor = new Map<string, string>();
	const colorForSymbol = new Map<string, RGBA>();
	let compact = true;
	for (const entry of entries) {
		const key = colorKeyOf(entry.color);
		if (!symbolForColor.has(key)) {
			symbolForColor.set(key, entry.id);
		}
		if (!colorForSymbol.has(entry.id)) {
			colorForSymbol.set(entry.id, entry.color);
		}
		if (entry.id.length !== 1) {
			compact = false;
		}
	}
	return { symbolForColor, colorForSymbol, compact };
}

const HEXD = "0123456789ABCDEF";

function hexByte(value: number): string {
	return `${HEXD[(value >> 4) & 15]}${HEXD[value & 15]}`;
}

function hexOf(color: RGBA): string {
	return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}${hexByte(color.a)}`;
}

function compareCodeUnits(a: string, b: string): number {
	const end = a.length < b.length ? a.length : b.length;
	for (let i = 0; i < end; i += 1) {
		const left = a.charCodeAt(i);
		const right = b.charCodeAt(i);
		if (left !== right) {
			return left < right ? -1 : 1;
		}
	}
	if (a.length === b.length) {
		return 0;
	}
	return a.length < b.length ? -1 : 1;
}

function formatOpacity(opacity: number): string {
	if (
		typeof opacity !== "number" ||
		Number.isNaN(opacity) ||
		opacity < 0 ||
		opacity > 1
	) {
		throw mcpxError(
			"MCPX_SCHEMA_ERROR",
			"Layer opacity must be within [0, 1].",
			{
				opacity,
			},
		);
	}
	return opacity.toFixed(3);
}

function formatMetadataValue(key: string, value: unknown): string {
	if (typeof value === "string") {
		if (value === "" || /\s/.test(value)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Metadata "${key}" cannot be represented in v1 (no blanks or quoting).`,
				{ key },
			);
		}
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Metadata "${key}" is not a finite number.`,
				{ key },
			);
		}
		return String(value);
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	throw mcpxError(
		"MCPX_SCHEMA_ERROR",
		`Metadata "${key}" has an unrepresentable type in v1.`,
		{ key },
	);
}

export function serializeMcpx(canvas: PixelCanvas): string {
	if (canvas === null || typeof canvas !== "object") {
		throw mcpxError(
			"MCPX_SCHEMA_ERROR",
			"serializeMcpx needs a PixelCanvas.",
			{},
		);
	}
	assertValidCanvas(canvas);
	for (const layer of canvas.layers) {
		if (
			layer.metadata !== undefined &&
			Object.keys(layer.metadata).length > 0
		) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Layer "${layer.id}" metadata has no v1 text form.`,
				{ section: `layer ${layer.id}` },
			);
		}
	}
	for (const region of canvas.regions) {
		if (
			region.metadata !== undefined &&
			Object.keys(region.metadata).length > 0
		) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Region "${region.id}" metadata has no v1 text form.`,
				{ section: `region ${region.id}` },
			);
		}
	}

	const entries = canvas.palette?.entries ?? [];
	const mapping = buildSymbolMap(entries);
	const out: string[] = [
		"mcpx 1",
		"",
		"[canvas]",
		`width = ${canvas.width}`,
		`height = ${canvas.height}`,
		"",
	];

	const metaKeys = Object.keys(canvas.metadata).sort(compareCodeUnits);
	if (metaKeys.length > 0) {
		out.push("[metadata]");
		for (const key of metaKeys) {
			out.push(`${key} = ${formatMetadataValue(key, canvas.metadata[key])}`);
		}
		out.push("");
	}

	if (entries.length > 0) {
		out.push("[palette]");
		for (const entry of entries) {
			const role = entry.role === undefined ? "" : ` role=${entry.role}`;
			out.push(`${entry.id} = ${hexOf(entry.color)}${role}`);
		}
		out.push("");
	}

	const gridHeader = mapping.compact ? "[grid]" : "[grid tokens]";
	for (const layer of canvas.layers) {
		out.push(`[layer ${layer.id}]`);
		out.push(`visible = ${layer.visible ? "true" : "false"}`);
		out.push(`opacity = ${formatOpacity(layer.opacity)}`);
		if (layer.name !== undefined) {
			if (layer.name === "" || /\s/.test(layer.name)) {
				throw mcpxError(
					"MCPX_SCHEMA_ERROR",
					`Layer "${layer.id}" name has no v1 text form.`,
					{ section: `layer ${layer.id}` },
				);
			}
			out.push(`name = ${layer.name}`);
		}
		out.push("", gridHeader);
		for (let y = 0; y < canvas.height; y += 1) {
			const cells: string[] = [];
			for (let x = 0; x < canvas.width; x += 1) {
				const offset = (y * canvas.width + x) * 4;
				const color: RGBA = {
					r: layer.pixels[offset] as number,
					g: layer.pixels[offset + 1] as number,
					b: layer.pixels[offset + 2] as number,
					a: layer.pixels[offset + 3] as number,
				};
				const symbol = mapping.symbolForColor.get(colorKeyOf(color));
				if (symbol === undefined) {
					throw mcpxError(
						"MCPX_SEMANTIC_ERROR",
						`Pixel (${x},${y}) on layer "${layer.id}" has no palette symbol; assign one before serializing.`,
						{ section: `layer ${layer.id}`, x, y },
					);
				}
				cells.push(symbol);
			}
			out.push(mapping.compact ? cells.join("") : cells.join(" "));
		}
		out.push("");
	}

	for (const region of canvas.regions) {
		out.push(`[region ${region.id}]`);
		if (region.name !== undefined) {
			if (region.name === "" || /\s/.test(region.name)) {
				throw mcpxError(
					"MCPX_SCHEMA_ERROR",
					`Region "${region.id}" name has no v1 text form.`,
					{ section: `region ${region.id}` },
				);
			}
			out.push(`name = ${region.name}`);
		}
		out.push("", "[mask]");
		for (let y = 0; y < canvas.height; y += 1) {
			let row = "";
			for (let x = 0; x < canvas.width; x += 1) {
				const value = region.mask[y * canvas.width + x] as number;
				if (value === 0) {
					row += ".";
				} else if (value === 1) {
					row += "#";
				} else {
					throw mcpxError(
						"MCPX_SCHEMA_ERROR",
						`Region "${region.id}" mask value at (${x},${y}) is not 0 or 1.`,
						{ section: `region ${region.id}`, x, y },
					);
				}
			}
			out.push(row);
		}
		out.push("");
	}

	return out.join("\n");
}
