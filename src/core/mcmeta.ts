import { McAssetError } from "./errors.ts";

/**
 * Minecraft `.mcmeta` texture-scaling section: the GUI `stretch` / `tile` /
 * `nine_slice` understanding plus the nine-slice border geometry and border
 * guide paint used by `preview --nine-slice`.
 *
 * The scaling lookup is name-based: `gui.scaling` first, then a top-level
 * `scaling` fallback. The exact key path stays with the compatibility layer
 * for verification, so both spellings are accepted here and the parsed
 * names (`stretch`, `tile`, `nine_slice`, `border`, `stretch_inner`) are
 * what the reports carry.
 *
 * Extension point for animation / mipmap work: add new section readers
 * beside `extractGuiScaling` (for example `extractAnimation` and
 * `extractMipmap`) that share `parseMcmetaText` and its INVALID_MCMETA
 * contract. Nothing in this module applies behavior: `stretch_inner` is
 * parsed and reported verbatim but never affects geometry or pixels.
 *
 * All pixel work stays integer; no randomness, no transcendental functions.
 * Same input plus same options always yields the same bytes.
 */

export interface NineSliceBorder {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export type GuiScaling =
	| { kind: "none" }
	| { kind: "stretch" }
	| { kind: "tile" }
	| { kind: "nine_slice"; border: NineSliceBorder; stretchInner: boolean };

export interface NineSliceRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface NineSliceRegions {
	topLeft: NineSliceRegion;
	top: NineSliceRegion;
	topRight: NineSliceRegion;
	left: NineSliceRegion;
	center: NineSliceRegion;
	right: NineSliceRegion;
	bottomLeft: NineSliceRegion;
	bottom: NineSliceRegion;
	bottomRight: NineSliceRegion;
}

export type NineSliceFindingLevel = "warning" | "error";

export interface NineSliceFinding {
	level: NineSliceFindingLevel;
	code: string;
	message: string;
}

/** Frozen border guide color for the nine-slice preview PNG. */
export const NINE_SLICE_GUIDE = { r: 255, g: 0, b: 255, a: 255 } as const;

function invalidMcmeta(message: string, details?: unknown): McAssetError {
	return new McAssetError("INVALID_MCMETA", message, details);
}

/**
 * Parse raw `.mcmeta` text into a plain document. JSON syntax errors and
 * non-object roots are INVALID_MCMETA; unreadable files never reach here
 * (the caller reports FILESYSTEM_ERROR when reading).
 */
export function parseMcmetaText(text: string, source?: string): unknown {
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch {
		throw invalidMcmeta(
			`Cannot parse mcmeta JSON${source === undefined ? "" : `: ${source}`}.`,
			source === undefined ? undefined : { path: source },
		);
	}
	if (
		typeof document !== "object" ||
		document === null ||
		Array.isArray(document)
	) {
		throw invalidMcmeta("mcmeta root must be a JSON object.", {
			path: source,
		});
	}
	return document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBorderSide(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseBorder(value: unknown): NineSliceBorder {
	if (!isRecord(value)) {
		throw invalidMcmeta("nine_slice border must be an object.", {
			border: value,
		});
	}
	for (const side of ["left", "top", "right", "bottom"] as const) {
		if (!isBorderSide(value[side])) {
			throw invalidMcmeta(
				`nine_slice border.${side} must be a non-negative integer.`,
				{ border: value },
			);
		}
	}
	return {
		left: value.left as number,
		top: value.top as number,
		right: value.right as number,
		bottom: value.bottom as number,
	};
}

/**
 * Read the GUI texture-scaling section of a parsed `.mcmeta` document.
 * Absent scaling reports `none`; `stretch` / `tile` report their kind;
 * `nine_slice` carries its border and the verbatim `stretch_inner` flag.
 * Structural problems (unknown type, missing type, bad border, non-boolean
 * `stretch_inner`) are INVALID_MCMETA.
 */
export function extractGuiScaling(document: unknown): GuiScaling {
	if (!isRecord(document)) {
		throw invalidMcmeta("mcmeta root must be a JSON object.", {
			document,
		});
	}
	const gui = document.gui;
	const scaling =
		isRecord(gui) && gui.scaling !== undefined ? gui.scaling : document.scaling;
	if (scaling === undefined) {
		return { kind: "none" };
	}
	if (!isRecord(scaling)) {
		throw invalidMcmeta("scaling section must be an object.", { scaling });
	}
	const type = scaling.type;
	if (type === "stretch" || type === "tile") {
		return { kind: type };
	}
	if (type !== "nine_slice") {
		throw invalidMcmeta(
			`Unknown scaling type ${JSON.stringify(type) ?? "missing"}; expected stretch, tile, or nine_slice.`,
			{ type: type ?? null },
		);
	}
	if (scaling.border === undefined) {
		throw invalidMcmeta("nine_slice scaling needs a border object.", {
			scaling,
		});
	}
	const border = parseBorder(scaling.border);
	const stretchInner = scaling.stretch_inner ?? false;
	if (typeof stretchInner !== "boolean") {
		throw invalidMcmeta("stretch_inner must be a boolean when present.", {
			stretchInner,
		});
	}
	return { kind: "nine_slice", border, stretchInner };
}

/**
 * Derive the nine regions by insetting the sprite bounds with the border:
 * the four sides keep the border width, the middle column and row take the
 * remainder. Callers MUST check `nineSliceGeometryError` first; a negative
 * remainder here means the border overflows the sprite.
 */
export function deriveNineSliceRegions(
	width: number,
	height: number,
	border: NineSliceBorder,
): NineSliceRegions {
	const middleWidth = width - border.left - border.right;
	const middleHeight = height - border.top - border.bottom;
	const rightX = width - border.right;
	const bottomY = height - border.bottom;
	return {
		topLeft: { x: 0, y: 0, width: border.left, height: border.top },
		top: { x: border.left, y: 0, width: middleWidth, height: border.top },
		topRight: { x: rightX, y: 0, width: border.right, height: border.top },
		left: { x: 0, y: border.top, width: border.left, height: middleHeight },
		center: {
			x: border.left,
			y: border.top,
			width: middleWidth,
			height: middleHeight,
		},
		right: {
			x: rightX,
			y: border.top,
			width: border.right,
			height: middleHeight,
		},
		bottomLeft: { x: 0, y: bottomY, width: border.left, height: border.bottom },
		bottom: {
			x: border.left,
			y: bottomY,
			width: middleWidth,
			height: border.bottom,
		},
		bottomRight: {
			x: rightX,
			y: bottomY,
			width: border.right,
			height: border.bottom,
		},
	};
}

/**
 * Border geometry check: `left + right <= width` and
 * `top + bottom <= height`. Returns the finding message, or undefined when
 * the border fits. Equality is allowed: the middle column or row may be
 * empty, it just must not go negative.
 */
export function nineSliceGeometryError(
	width: number,
	height: number,
	border: NineSliceBorder,
): string | undefined {
	if (border.left + border.right > width) {
		return (
			`nine_slice border overflows the sprite: left (${border.left}) + right ` +
			`(${border.right}) exceeds width ${width}.`
		);
	}
	if (border.top + border.bottom > height) {
		return (
			`nine_slice border overflows the sprite: top (${border.top}) + bottom ` +
			`(${border.bottom}) exceeds height ${height}.`
		);
	}
	return undefined;
}

/**
 * Paint the four 1px border guides over flat RGBA bytes in place:
 * `x = left` and `x = width - right` run the full height,
 * `y = top` and `y = height - bottom` run the full width.
 * Guide pixels become opaque; every other byte stays untouched.
 * Out-of-range lines are skipped, never wrapped or clamped.
 */
export function paintNineSliceGuides(
	pixels: Uint8Array,
	width: number,
	height: number,
	border: NineSliceBorder,
): void {
	const guideX = [border.left, width - border.right];
	const guideY = [border.top, height - border.bottom];
	for (const x of guideX) {
		if (x < 0 || x >= width) {
			continue;
		}
		for (let y = 0; y < height; y += 1) {
			const offset = (y * width + x) * 4;
			pixels[offset] = NINE_SLICE_GUIDE.r;
			pixels[offset + 1] = NINE_SLICE_GUIDE.g;
			pixels[offset + 2] = NINE_SLICE_GUIDE.b;
			pixels[offset + 3] = NINE_SLICE_GUIDE.a;
		}
	}
	for (const y of guideY) {
		if (y < 0 || y >= height) {
			continue;
		}
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			pixels[offset] = NINE_SLICE_GUIDE.r;
			pixels[offset + 1] = NINE_SLICE_GUIDE.g;
			pixels[offset + 2] = NINE_SLICE_GUIDE.b;
			pixels[offset + 3] = NINE_SLICE_GUIDE.a;
		}
	}
}
