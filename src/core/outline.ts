import { VANILLA_PALETTE } from "../style/palette.ts";
import { getLayer } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import { strokeOutlineCells } from "./ops.ts";
import type { PixelCanvas, RGBA } from "./types.ts";

/**
 * Outline pass over one layer: five frame modes at an inside or outside
 * position.
 *
 * The body is every pixel whose alpha is not zero, so a partly transparent
 * pixel still belongs to the shape and only alpha 0 counts as empty. Inside
 * frame cells are body pixels with at least one transparent or out-of-canvas
 * 4-neighbour. Outside frame cells are empty cells with at least one body
 * 4-neighbour, which is the same footprint as the existing stroke mask. The
 * position only selects which set is written; every colour rule below is
 * shared.
 *
 * Tinted and selective derive one colour per frame cell from the adjacent
 * body pixels the pass does not rewrite: the interior body pixels for an
 * inside pass, every adjacent body pixel for an outside pass. The reference
 * is the lowest HSL lightness among them (ties: lowest saturation, then
 * lowest hue, grey first); its HSL lightness drops by
 * `luminanceDropPermille` and its saturation scales by
 * `saturationRatioPermille` with integer arithmetic, preserving hue and
 * keeping the result opaque. A cell with no reference in the 4-neighbourhood
 * widens the search to the 8-neighbourhood, and a cell that still has none
 * keeps its current bytes. Selective paints only cells on the backlit side:
 * with the light at the top left, a cell is backlit when `x >= cx` or
 * `y >= cy`, where the centre is the integer mean of the body coordinates.
 *
 * `family` names one of the twelve builtin families and, while
 * `snapFamilies` is true, snaps the derived colour to the closer of that
 * family's `outline` and `shadow` ramp entries on the builtin vanilla ramp,
 * by integer Manhattan distance with the darker entry winning a tie.
 *
 * `strip` removes the inside frame instead of painting it: each inside frame
 * pixel is replaced by the darkest adjacent interior pixel, copied byte for
 * byte, so the body never grows or shrinks and empty pixels stay untouched.
 * Position does not change that target set.
 *
 * All arithmetic is integer-only and every decision is deterministic, so
 * identical input bytes always produce identical output bytes.
 */

export type OutlineMode =
	| "tinted"
	| "selective"
	| "uniform"
	| "black"
	| "strip";
export type OutlinePosition = "inside" | "outside";

/** The five modes in frozen order, for callers that validate input. */
export const OUTLINE_MODES: readonly OutlineMode[] = [
	"tinted",
	"selective",
	"uniform",
	"black",
	"strip",
];

/** The two write positions in frozen order. */
export const OUTLINE_POSITIONS: readonly OutlinePosition[] = [
	"inside",
	"outside",
];

/** Op-level defaults when the caller omits a field. */
export const OUTLINE_DEFAULTS = {
	luminanceDropPermille: 120,
	saturationRatioPermille: 1000,
	maxHueOffsetDegrees: 5,
	snapFamilies: true,
} as const;

/** Family ids the batch op may align to: the twelve builtin families. */
export const OUTLINE_FAMILY_IDS: readonly string[] =
	Object.keys(VANILLA_PALETTE);

export interface OutlineOptions {
	/** Frame mode; defaults to `tinted`. */
	mode?: OutlineMode;
	/** Write position; defaults to `inside`. */
	position?: OutlinePosition;
	/** Required for `uniform` and refused otherwise; must be opaque. */
	color?: RGBA;
	/** Builtin family id used to snap the derived colour. */
	family?: string;
	/** HSL lightness drop in permille, 0..400. */
	luminanceDropPermille?: number;
	/** Saturation ratio in permille, 0..2000. */
	saturationRatioPermille?: number;
	/** Hue bound for style checks, 0..180; never changes the output. */
	maxHueOffsetDegrees?: number;
	/** Snap the derived colour onto the family ramp; defaults to true. */
	snapFamilies?: boolean;
}

function truncDiv(a: number, b: number): number {
	return Math.trunc(a / b);
}

function clampByte(value: number): number {
	if (value < 0) {
		return 0;
	}
	if (value > 255) {
		return 255;
	}
	return value;
}

interface Hsl {
	l255: number;
	s255: number;
	h: number;
	delta: number;
}

function hslOf(color: RGBA): Hsl {
	const max = Math.max(color.r, color.g, color.b);
	const min = Math.min(color.r, color.g, color.b);
	const delta = max - min;
	const l255 = truncDiv(max + min, 2);
	if (delta === 0) {
		return { l255, s255: 0, h: -1, delta: 0 };
	}
	const s255 = Math.min(
		255,
		truncDiv(delta * 255, 255 - Math.abs(2 * l255 - 255)),
	);
	let h: number;
	if (max === color.r) {
		h = truncDiv(60 * (color.g - color.b), delta);
	} else if (max === color.g) {
		h = 120 + truncDiv(60 * (color.b - color.r), delta);
	} else {
		h = 240 + truncDiv(60 * (color.r - color.g), delta);
	}
	h = ((h % 360) + 360) % 360;
	return { l255, s255, h, delta };
}

function parseHex(hex: string): RGBA {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
		a: 255,
	};
}

function colorDistance(a: RGBA, b: RGBA): number {
	return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

function luminancePermille(color: RGBA): number {
	return truncDiv(2126 * color.r + 7152 * color.g + 722 * color.b, 2550);
}

function snapToFamily(color: RGBA, family: string): RGBA {
	const ramp = (
		VANILLA_PALETTE as Record<string, { outline: string; shadow: string }>
	)[family];
	if (ramp === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unknown outline family: ${family}.`,
			{ family },
		);
	}
	const outline = parseHex(ramp.outline);
	const shadow = parseHex(ramp.shadow);
	const distanceOutline = colorDistance(color, outline);
	const distanceShadow = colorDistance(color, shadow);
	if (
		distanceOutline < distanceShadow ||
		(distanceOutline === distanceShadow &&
			luminancePermille(outline) <= luminancePermille(shadow))
	) {
		return outline;
	}
	return shadow;
}

function deriveOutlineColor(reference: RGBA, options: OutlineOptions): RGBA {
	const drop =
		options.luminanceDropPermille ?? OUTLINE_DEFAULTS.luminanceDropPermille;
	const ratio =
		options.saturationRatioPermille ?? OUTLINE_DEFAULTS.saturationRatioPermille;
	const hsl = hslOf(reference);
	const l255 = clampByte(truncDiv(hsl.l255 * (1000 - drop), 1000));
	const s255 = Math.min(255, truncDiv(hsl.s255 * ratio, 1000));
	let derived: RGBA;
	if (hsl.delta === 0) {
		derived = { r: l255, g: l255, b: l255, a: 255 };
	} else {
		const delta = truncDiv(s255 * (255 - Math.abs(2 * l255 - 255)), 255);
		derived = {
			r: clampByte(
				l255 + truncDiv((reference.r - hsl.l255) * delta, hsl.delta),
			),
			g: clampByte(
				l255 + truncDiv((reference.g - hsl.l255) * delta, hsl.delta),
			),
			b: clampByte(
				l255 + truncDiv((reference.b - hsl.l255) * delta, hsl.delta),
			),
			a: 255,
		};
	}
	if (
		options.family === undefined ||
		!(options.snapFamilies ?? OUTLINE_DEFAULTS.snapFamilies)
	) {
		return derived;
	}
	return snapToFamily(derived, options.family);
}

function findReferenceColor(
	pixels: Uint8Array,
	width: number,
	height: number,
	body: Uint8Array,
	inside: Uint8Array,
	x: number,
	y: number,
	position: OutlinePosition,
): RGBA | undefined {
	const candidates: RGBA[] = [];
	const collect = (diagonals: boolean): void => {
		for (let dy = -1; dy <= 1; dy += 1) {
			for (let dx = -1; dx <= 1; dx += 1) {
				if (dx === 0 && dy === 0) {
					continue;
				}
				if (!diagonals && dx !== 0 && dy !== 0) {
					continue;
				}
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
					continue;
				}
				const index = ny * width + nx;
				if (body[index] !== 1) {
					continue;
				}
				if (position === "inside" && inside[index] === 1) {
					continue;
				}
				const offset = index * 4;
				candidates.push({
					r: pixels[offset] as number,
					g: pixels[offset + 1] as number,
					b: pixels[offset + 2] as number,
					a: pixels[offset + 3] as number,
				});
			}
		}
	};
	collect(false);
	if (candidates.length === 0) {
		collect(true);
	}
	if (candidates.length === 0) {
		return undefined;
	}
	let best = candidates[0] as RGBA;
	let bestHsl = hslOf(best);
	for (let i = 1; i < candidates.length; i += 1) {
		const candidate = candidates[i] as RGBA;
		const candidateHsl = hslOf(candidate);
		if (
			candidateHsl.l255 < bestHsl.l255 ||
			(candidateHsl.l255 === bestHsl.l255 &&
				(candidateHsl.s255 < bestHsl.s255 ||
					(candidateHsl.s255 === bestHsl.s255 && candidateHsl.h < bestHsl.h)))
		) {
			best = candidate;
			bestHsl = candidateHsl;
		}
	}
	return best;
}

/** Body mask: 1 for every pixel whose alpha is not 0. */
export function bodyMaskOf(
	pixels: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let index = 0; index < mask.length; index += 1) {
		if (pixels[index * 4 + 3] !== 0) {
			mask[index] = 1;
		}
	}
	return mask;
}

/** Inside frame cells: body pixels with at least one empty or canvas-edge 4-neighbour. */
export function insideOutlineCells(
	body: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			if (body[index] !== 1) {
				continue;
			}
			if (
				x === 0 ||
				body[index - 1] === 0 ||
				x + 1 === width ||
				body[index + 1] === 0 ||
				y === 0 ||
				body[index - width] === 0 ||
				y + 1 === height ||
				body[index + width] === 0
			) {
				mask[index] = 1;
			}
		}
	}
	return mask;
}

/** Outside frame cells: empty cells with at least one body 4-neighbour. */
export function outsideOutlineCells(
	body: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	return strokeOutlineCells(body, width, height);
}

/**
 * Run one outline pass over a layer. Selection scoping, including
 * EMPTY_SELECTION and the batch rollback, belongs to the batch entry; this
 * function writes every frame cell it decides on.
 */
export function applyOutline(
	canvas: PixelCanvas,
	layerId: string,
	options: OutlineOptions,
): void {
	const mode = options.mode ?? "tinted";
	if (!OUTLINE_MODES.includes(mode)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unknown outline mode: ${String(mode)}.`,
			{ mode },
		);
	}
	const position = options.position ?? "inside";
	if (!OUTLINE_POSITIONS.includes(position)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unknown outline position: ${String(position)}.`,
			{ position },
		);
	}
	if (options.luminanceDropPermille !== undefined) {
		if (
			!Number.isInteger(options.luminanceDropPermille) ||
			options.luminanceDropPermille < 0 ||
			options.luminanceDropPermille > 400
		) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Outline luminanceDropPermille must be an integer between 0 and 400.",
				{ luminanceDropPermille: options.luminanceDropPermille },
			);
		}
	}
	if (options.saturationRatioPermille !== undefined) {
		if (
			!Number.isInteger(options.saturationRatioPermille) ||
			options.saturationRatioPermille < 0 ||
			options.saturationRatioPermille > 2000
		) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Outline saturationRatioPermille must be an integer between 0 and 2000.",
				{ saturationRatioPermille: options.saturationRatioPermille },
			);
		}
	}
	if (options.maxHueOffsetDegrees !== undefined) {
		if (
			!Number.isInteger(options.maxHueOffsetDegrees) ||
			options.maxHueOffsetDegrees < 0 ||
			options.maxHueOffsetDegrees > 180
		) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Outline maxHueOffsetDegrees must be an integer between 0 and 180.",
				{ maxHueOffsetDegrees: options.maxHueOffsetDegrees },
			);
		}
	}
	if (
		options.snapFamilies !== undefined &&
		typeof options.snapFamilies !== "boolean"
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Outline snapFamilies must be a boolean.",
			{ snapFamilies: options.snapFamilies },
		);
	}
	if (options.family !== undefined) {
		if (
			typeof options.family !== "string" ||
			!OUTLINE_FAMILY_IDS.includes(options.family)
		) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`Unknown outline family: ${String(options.family)}.`,
				{ family: options.family },
			);
		}
	}
	if (mode === "uniform") {
		if (options.color === undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				'Outline mode "uniform" requires color.',
				{ path: "color" },
			);
		}
		if (
			typeof options.color !== "object" ||
			options.color === null ||
			typeof options.color.r !== "number" ||
			typeof options.color.g !== "number" ||
			typeof options.color.b !== "number" ||
			typeof options.color.a !== "number"
		) {
			throw new McAssetError("INVALID_ARGUMENT", "Invalid outline color.", {
				color: options.color,
			});
		}
		if (options.color.a !== 255) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Outline uniform color must be fully opaque.",
				{ color: options.color },
			);
		}
	} else {
		if (options.color !== undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				'Outline color is only allowed when mode is "uniform".',
				{ color: options.color },
			);
		}
	}

	const layer = getLayer(canvas, layerId);
	const { width, height } = canvas;
	const source = layer.pixels.slice();
	const body = bodyMaskOf(source, width, height);
	const inside = insideOutlineCells(body, width, height);
	const targets =
		mode === "strip"
			? inside
			: position === "inside"
				? inside
				: outsideOutlineCells(body, width, height);

	let centreX = 0;
	let centreY = 0;
	if (mode === "selective") {
		let sumX = 0;
		let sumY = 0;
		let count = 0;
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				if (body[y * width + x] === 1) {
					sumX += x;
					sumY += y;
					count += 1;
				}
			}
		}
		centreX = count === 0 ? 0 : truncDiv(sumX, count);
		centreY = count === 0 ? 0 : truncDiv(sumY, count);
	}

	const pixels = layer.pixels;
	const blackColor: RGBA = { r: 0, g: 0, b: 0, a: 255 };

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			if (targets[index] !== 1) {
				continue;
			}
			let next: RGBA | undefined;
			if (mode === "uniform") {
				next = options.color;
			} else if (mode === "black") {
				next = blackColor;
			} else if (mode === "strip") {
				next = findReferenceColor(
					source,
					width,
					height,
					body,
					inside,
					x,
					y,
					"inside",
				);
			} else {
				if (mode === "selective" && x < centreX && y < centreY) {
					continue;
				}
				const reference = findReferenceColor(
					source,
					width,
					height,
					body,
					inside,
					x,
					y,
					position,
				);
				if (reference !== undefined) {
					next = deriveOutlineColor(reference, options);
				}
			}
			if (next === undefined) {
				continue;
			}
			const offset = index * 4;
			pixels[offset] = next.r;
			pixels[offset + 1] = next.g;
			pixels[offset + 2] = next.b;
			pixels[offset + 3] = next.a;
		}
	}
}
