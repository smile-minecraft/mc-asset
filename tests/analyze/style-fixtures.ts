import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";

/**
 * Original fixtures for the style metric and lint cases. Every sprite is
 * drawn from this project's own color tables so no external artwork and no
 * measured palette value enters the suite; each builder returns a canvas
 * whose geometry the reference implementation in `style-metrics-reference.ts`
 * can measure.
 */

export function rgba(hex: string, alpha = 255): RGBA {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
		a: alpha,
	};
}

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

/** A 16x16 canvas from a `get(x, y)` painter. */
export function paintedCanvas(
	width: number,
	height: number,
	paint: (x: number, y: number) => RGBA,
): PixelCanvas {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const color = paint(x, y);
			const offset = (y * width + x) * 4;
			pixels[offset] = color.r;
			pixels[offset + 1] = color.g;
			pixels[offset + 2] = color.b;
			pixels[offset + 3] = color.a;
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return canvas;
}

/** Flattens one layer so a case can hand pixels to the reference. */
export function pixelsOf(canvas: PixelCanvas): RGBA[] {
	const flat = canvas.layers[0]?.pixels;
	const out: RGBA[] = [];
	if (flat === undefined) {
		return out;
	}
	for (let offset = 0; offset + 3 < flat.length; offset += 4) {
		out.push({
			r: flat[offset] as number,
			g: flat[offset + 1] as number,
			b: flat[offset + 2] as number,
			a: flat[offset + 3] as number,
		});
	}
	return out;
}

export interface SwordOptions {
	/** Where the brightest pair sits; the rest of the blade mirrors it. */
	readonly highlightCorner?: "top-left" | "bottom-right" | undefined;
	/** Transparent border width; 2 keeps every side at two pixels. */
	readonly margin?: number | undefined;
	/** Outline color; a colored outline moves the hue bins apart. */
	readonly outlineHex?: string | undefined;
}

const OUTLINE_DEFAULT = "#181818";
const BUFFER = "#F0F0F0";
const HIGHLIGHT = "#FFFFFF";
const BANDS = ["#BEBEBE", "#969696", "#6B6B6B", "#444444"];

/**
 * A vertical blade inside a one-pixel outline: four lightness bands, one
 * highlight pair next to a buffer pixel, and a transparent margin. The
 * top-left variant lights the top of the blade, the bottom-right variant
 * lights the bottom, so the TL-BR direction flips sign.
 */
export function swordCanvas(options: SwordOptions = {}): PixelCanvas {
	const highlightCorner = options.highlightCorner ?? "top-left";
	const margin = options.margin ?? 2;
	const outline = rgba(options.outlineHex ?? OUTLINE_DEFAULT);
	const buffer = rgba(BUFFER);
	const highlight = rgba(HIGHLIGHT);
	const bands = BANDS.map((hex) => rgba(hex));
	const size = 16;
	const left = margin;
	const right = size - 1 - margin;
	const top = margin;
	const bottom = size - 1 - margin;
	const innerTop = top + 1;
	const innerBottom = bottom - 1;
	const innerLeft = left + 1;
	const innerRight = right - 1;
	const rows = innerBottom - innerTop + 1;
	const bandAt = (row: number): number => {
		const index = Math.min(
			BANDS.length - 1,
			Math.trunc((row * BANDS.length) / rows),
		);
		return highlightCorner === "top-left" ? index : BANDS.length - 1 - index;
	};
	const highlightX =
		highlightCorner === "top-left" ? innerLeft : innerRight - 1;
	const highlightY =
		highlightCorner === "top-left" ? innerTop : innerBottom - 1;
	return paintedCanvas(size, size, (x, y) => {
		if (x < left || x > right || y < top || y > bottom) {
			return TRANSPARENT;
		}
		if (x === left || x === right || y === top || y === bottom) {
			return outline;
		}
		const row = y - innerTop;
		if (x === highlightX && (y === highlightY || y === highlightY + 1)) {
			return highlight;
		}
		if (x === highlightX + 1 && y === highlightY) {
			return buffer;
		}
		return bands[bandAt(row)] as RGBA;
	});
}

/** A fully transparent canvas of the given size. */
export function blankCanvas(width = 16, height = 16): PixelCanvas {
	return paintedCanvas(width, height, () => TRANSPARENT);
}

/** One flat color covering every pixel. */
export function solidCanvas(hex: string, width = 16, height = 16): PixelCanvas {
	const color = rgba(hex);
	return paintedCanvas(width, height, () => color);
}

/** A one-pixel canvas, the smallest measurable asset. */
export function singlePixelCanvas(hex = "#7A7A7A"): PixelCanvas {
	return solidCanvas(hex, 1, 1);
}

/**
 * A 2x2 checkerboard in two near-equal tones: every window counts as a
 * dither window, so the dither rule has something to catch.
 */
export function checkerCanvas(
	first = "#606060",
	second = "#696969",
	size = 16,
): PixelCanvas {
	const a = rgba(first);
	const b = rgba(second);
	return paintedCanvas(size, size, (x, y) => ((x + y) % 2 === 0 ? a : b));
}

/**
 * A gem body in one hue, ringed by its own dark outline; `outlineHex` picks
 * the outline color, so a pure black outline moves the outline hue bin away
 * from the body hue.
 */
export function gemCanvas(outlineHex = "#0A1A36"): PixelCanvas {
	const outline = rgba(outlineHex);
	const bodyLight = rgba("#8FB8E8");
	const bodyMid = rgba("#4C74B4");
	const bodyDark = rgba("#243C68");
	const inside = (x: number, y: number): boolean =>
		Math.abs(x - 7.5) + Math.abs(y - 7.5) <= 6.5;
	return paintedCanvas(16, 16, (x, y) => {
		if (!inside(x, y)) {
			return TRANSPARENT;
		}
		const onEdge =
			!inside(x - 1, y) ||
			!inside(x + 1, y) ||
			!inside(x, y - 1) ||
			!inside(x, y + 1);
		if (onEdge) {
			return outline;
		}
		if (y < 6) {
			return bodyLight;
		}
		if (y < 10) {
			return bodyMid;
		}
		return bodyDark;
	});
}

/**
 * An ingot-shaped bar carrying `levels` distinct lightness steps, so the
 * level-count rule has a fixture just under and just over a threshold.
 */
export function ingotCanvas(levels = 5): PixelCanvas {
	const steps: RGBA[] = [];
	for (let index = 0; index < levels; index += 1) {
		const value = 40 + Math.trunc((index * 160) / Math.max(1, levels - 1));
		steps.push(rgba(`#${value.toString(16).padStart(2, "0").repeat(3)}`));
	}
	return paintedCanvas(16, 16, (x, y) => {
		if (y < 4 || y > 11 || x < 2 || x > 13) {
			return TRANSPARENT;
		}
		if (y === 4 || y === 11 || x === 2 || x === 13) {
			return steps[0] as RGBA;
		}
		const cell = (y - 5) * 10 + (x - 3);
		const band = Math.min(
			steps.length - 1,
			Math.trunc((cell * steps.length) / 60),
		);
		return steps[band] as RGBA;
	});
}

/** A tall animation strip of `frames` stacked copies of one frame. */
export function animationStripCanvas(
	frame: PixelCanvas,
	frames = 3,
): PixelCanvas {
	const source = pixelsOf(frame);
	return paintedCanvas(
		16,
		16 * frames,
		(x, y) => source[(y % 16) * 16 + x] ?? TRANSPARENT,
	);
}
