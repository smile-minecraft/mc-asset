import {
	addLayer,
	addRegion,
	createCanvas,
	replaceLayerPixels,
	replaceRegionMask,
} from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import type { GuiScaling, NineSliceBorder } from "./mcmeta.ts";
import { resize } from "./transform.ts";
import type { PixelCanvas } from "./types.ts";
import { assertValidCanvas, validateDimension } from "./validate.ts";

/**
 * GUI scaling: the deterministic sprite-to-target mapping behind the
 * `gui-scale` command and the `scale_gui_asset` tool.
 *
 * Every entry takes the source sprite plus the parsed `gui.scaling`
 * section and a target size, and returns a fresh canvas; the input is
 * never modified. All arithmetic stays integer; no randomness, no
 * transcendental functions. Same inputs always yield the same bytes.
 *
 * Shared rules: a target equal to the sprite size copies verbatim for all
 * three kinds. `stretch` (and a missing scaling section) nearest-maps the
 * whole sprite to the target. `tile` repeats the design canvas 1:1 from
 * the top-left, cropping the overflowing right and bottom repeats.
 * `nine_slice` clamps each border side to half the target edge, draws the
 * four corners 1:1 from the outer source edges, and fills edges and center
 * by 1:1 tiling (`stretch_inner: false`) or nearest stretching
 * (`stretch_inner: true`).
 *
 * When the sprite size differs from the declared design size, the sprite
 * is nearest-mapped onto a design canvas first (identity when equal) and
 * the tiling or nine-slice layout runs over that canvas. Layers and
 * region masks share one layout; masks stay binary because every write
 * is a verbatim copy.
 *
 * Callers MUST check `nineSliceGeometryError` against the declared design
 * dimensions before scaling a nine_slice sprite; a zero or negative
 * source middle band has no defined mapping here.
 */

/** One pixel plane: a layer buffer (4 bytes per pixel) or a mask (1 byte). */
interface ScalePlane {
	src: Uint8Array;
	dst: Uint8Array;
	bytesPerPixel: 1 | 4;
}

/**
 * Parse a GUI target size: `N` means NxN, `WxH` a rectangle. A missing
 * value or a non-positive integer is INVALID_ARGUMENT; an edge outside
 * the canvas range is INVALID_DIMENSION.
 */
export function parseGuiSize(raw: string | undefined): {
	width: number;
	height: number;
} {
	if (raw === undefined || raw === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"gui-scale needs --size N or WxH with positive integers.",
			{ size: raw },
		);
	}
	const parts = raw.trim().split("x");
	let width: number;
	let height: number;
	if (parts.length === 1) {
		width = parseSizeEdge(parts[0] as string, raw);
		height = width;
	} else if (parts.length === 2) {
		width = parseSizeEdge(parts[0] as string, raw);
		height = parseSizeEdge(parts[1] as string, raw);
	} else {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--size must be N or WxH with positive integers, got "${raw}".`,
			{ size: raw },
		);
	}
	validateDimension(width);
	validateDimension(height);
	return { width, height };
}

function parseSizeEdge(text: string, raw: string): number {
	if (!/^\d+$/.test(text)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--size must be N or WxH with positive integers, got "${raw}".`,
			{ size: raw },
		);
	}
	const value = Number.parseInt(text, 10);
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--size must be N or WxH with positive integers, got "${raw}".`,
			{ size: raw },
		);
	}
	return value;
}

/** Deep structural copy: layers, regions, palette, and metadata. */
function cloneCanvas(canvas: PixelCanvas): PixelCanvas {
	const out = createCanvas(canvas.width, canvas.height, {
		...(canvas.palette !== undefined
			? {
					palette: {
						entries: canvas.palette.entries.map((entry) => ({
							...entry,
							color: { ...entry.color },
							...(entry.metadata !== undefined
								? { metadata: { ...entry.metadata } }
								: {}),
						})),
					},
				}
			: {}),
		metadata: { ...canvas.metadata },
	});
	for (const layer of canvas.layers) {
		const next = addLayer(out, {
			id: layer.id,
			...(layer.name !== undefined ? { name: layer.name } : {}),
			visible: layer.visible,
			opacity: layer.opacity,
			blendMode: layer.blendMode,
			...(layer.metadata !== undefined
				? { metadata: { ...layer.metadata } }
				: {}),
		});
		replaceLayerPixels(out, next.id, layer.pixels.slice());
	}
	for (const region of canvas.regions) {
		const next = addRegion(out, {
			id: region.id,
			...(region.name !== undefined ? { name: region.name } : {}),
			...(region.metadata !== undefined
				? { metadata: { ...region.metadata } }
				: {}),
		});
		replaceRegionMask(out, next.id, region.mask.slice());
	}
	return out;
}

/** Fresh target canvas carrying the source structure with empty buffers. */
function blankCanvasLike(
	canvas: PixelCanvas,
	width: number,
	height: number,
): PixelCanvas {
	const out = createCanvas(width, height, {
		...(canvas.palette !== undefined
			? {
					palette: {
						entries: canvas.palette.entries.map((entry) => ({
							...entry,
							color: { ...entry.color },
							...(entry.metadata !== undefined
								? { metadata: { ...entry.metadata } }
								: {}),
						})),
					},
				}
			: {}),
		metadata: { ...canvas.metadata },
	});
	for (const layer of canvas.layers) {
		addLayer(out, {
			id: layer.id,
			...(layer.name !== undefined ? { name: layer.name } : {}),
			visible: layer.visible,
			opacity: layer.opacity,
			blendMode: layer.blendMode,
			...(layer.metadata !== undefined
				? { metadata: { ...layer.metadata } }
				: {}),
		});
	}
	for (const region of canvas.regions) {
		addRegion(out, {
			id: region.id,
			...(region.name !== undefined ? { name: region.name } : {}),
			...(region.metadata !== undefined
				? { metadata: { ...region.metadata } }
				: {}),
		});
	}
	return out;
}

function planesOf(src: PixelCanvas, dst: PixelCanvas): ScalePlane[] {
	const planes: ScalePlane[] = [];
	for (let i = 0; i < src.layers.length; i += 1) {
		planes.push({
			src: (src.layers[i] as { pixels: Uint8Array }).pixels,
			dst: (dst.layers[i] as { pixels: Uint8Array }).pixels,
			bytesPerPixel: 4,
		});
	}
	for (let i = 0; i < src.regions.length; i += 1) {
		planes.push({
			src: (src.regions[i] as { mask: Uint8Array }).mask,
			dst: (dst.regions[i] as { mask: Uint8Array }).mask,
			bytesPerPixel: 1,
		});
	}
	return planes;
}

/**
 * Fill one target rectangle from one source rectangle. `tile` repeats the
 * source 1:1 with cropping; `stretch` nearest-maps it across the target.
 * Source bands are guaranteed non-empty by the caller contract, and an
 * empty target rectangle is a no-op.
 */
function fillRect(
	planes: ScalePlane[],
	srcWidth: number,
	dstWidth: number,
	dstX: number,
	dstY: number,
	targetWidth: number,
	targetHeight: number,
	srcX: number,
	srcY: number,
	sourceWidth: number,
	sourceHeight: number,
	stretch: boolean,
): void {
	if (targetWidth < 1 || targetHeight < 1) {
		return;
	}
	for (const plane of planes) {
		const bpp = plane.bytesPerPixel;
		for (let dy = 0; dy < targetHeight; dy += 1) {
			const sy = stretch
				? srcY + Math.floor((dy * sourceHeight) / targetHeight)
				: srcY + (dy % sourceHeight);
			for (let dx = 0; dx < targetWidth; dx += 1) {
				const sx = stretch
					? srcX + Math.floor((dx * sourceWidth) / targetWidth)
					: srcX + (dx % sourceWidth);
				const from = (sy * srcWidth + sx) * bpp;
				const to = ((dstY + dy) * dstWidth + (dstX + dx)) * bpp;
				for (let b = 0; b < bpp; b += 1) {
					plane.dst[to + b] = plane.src[from + b] as number;
				}
			}
		}
	}
}

/** Nearest-map the sprite onto its declared design canvas (or clone when equal). */
function designCanvas(
	canvas: PixelCanvas,
	designWidth: number,
	designHeight: number,
): PixelCanvas {
	if (canvas.width === designWidth && canvas.height === designHeight) {
		return cloneCanvas(canvas);
	}
	const base = cloneCanvas(canvas);
	resize(base, designWidth, designHeight, "nearest");
	return base;
}

function scaleTiled(
	canvas: PixelCanvas,
	designWidth: number,
	designHeight: number,
	targetWidth: number,
	targetHeight: number,
): PixelCanvas {
	const base = designCanvas(canvas, designWidth, designHeight);
	const out = blankCanvasLike(canvas, targetWidth, targetHeight);
	fillRect(
		planesOf(base, out),
		base.width,
		out.width,
		0,
		0,
		targetWidth,
		targetHeight,
		0,
		0,
		base.width,
		base.height,
		false,
	);
	return out;
}

function scaleNineSlice(
	canvas: PixelCanvas,
	designWidth: number,
	designHeight: number,
	border: NineSliceBorder,
	stretchInner: boolean,
	targetWidth: number,
	targetHeight: number,
): PixelCanvas {
	const base = designCanvas(canvas, designWidth, designHeight);
	const sourceWidth = base.width;
	const sourceHeight = base.height;
	// Border clamp against the target: each side keeps at most half the edge.
	const left =
		border.left < Math.floor(targetWidth / 2)
			? border.left
			: Math.floor(targetWidth / 2);
	const right =
		border.right < Math.floor(targetWidth / 2)
			? border.right
			: Math.floor(targetWidth / 2);
	const top =
		border.top < Math.floor(targetHeight / 2)
			? border.top
			: Math.floor(targetHeight / 2);
	const bottom =
		border.bottom < Math.floor(targetHeight / 2)
			? border.bottom
			: Math.floor(targetHeight / 2);
	const middleWidth = targetWidth - left - right;
	const middleHeight = targetHeight - top - bottom;
	const out = blankCanvasLike(canvas, targetWidth, targetHeight);
	const planes = planesOf(base, out);
	// Corners copy 1:1 from the outer source edges. Every source anchor
	// uses the clamped border values, matching the target layout exactly.
	fillRect(
		planes,
		sourceWidth,
		out.width,
		0,
		0,
		left,
		top,
		0,
		0,
		left,
		top,
		false,
	);
	fillRect(
		planes,
		sourceWidth,
		out.width,
		targetWidth - right,
		0,
		right,
		top,
		sourceWidth - right,
		0,
		right,
		top,
		false,
	);
	fillRect(
		planes,
		sourceWidth,
		out.width,
		0,
		targetHeight - bottom,
		left,
		bottom,
		0,
		sourceHeight - bottom,
		left,
		bottom,
		false,
	);
	fillRect(
		planes,
		sourceWidth,
		out.width,
		targetWidth - right,
		targetHeight - bottom,
		right,
		bottom,
		sourceWidth - right,
		sourceHeight - bottom,
		right,
		bottom,
		false,
	);
	// Edges and center tile or stretch the inner source bands, anchored on
	// the clamped borders: columns [left, W - right), rows [top, H - bottom).
	const innerWidth = sourceWidth - left - right;
	const innerHeight = sourceHeight - top - bottom;
	fillRect(
		planes,
		sourceWidth,
		out.width,
		left,
		0,
		middleWidth,
		top,
		left,
		0,
		innerWidth,
		top,
		stretchInner,
	);
	fillRect(
		planes,
		sourceWidth,
		out.width,
		left,
		targetHeight - bottom,
		middleWidth,
		bottom,
		left,
		sourceHeight - bottom,
		innerWidth,
		bottom,
		stretchInner,
	);
	fillRect(
		planes,
		sourceWidth,
		out.width,
		0,
		top,
		left,
		middleHeight,
		0,
		top,
		left,
		innerHeight,
		stretchInner,
	);
	fillRect(
		planes,
		sourceWidth,
		out.width,
		targetWidth - right,
		top,
		right,
		middleHeight,
		sourceWidth - right,
		top,
		right,
		innerHeight,
		stretchInner,
	);
	fillRect(
		planes,
		sourceWidth,
		out.width,
		left,
		top,
		middleWidth,
		middleHeight,
		left,
		top,
		innerWidth,
		innerHeight,
		stretchInner,
	);
	return out;
}

/**
 * Scale a sprite canvas to the target size under the parsed GUI scaling.
 * Returns a fresh canvas; the input is never modified. A target equal to
 * the sprite size copies verbatim for every kind, including nine_slice.
 */
export function scaleGuiCanvas(
	canvas: PixelCanvas,
	scaling: GuiScaling,
	targetWidth: number,
	targetHeight: number,
): PixelCanvas {
	assertValidCanvas(canvas);
	validateDimension(targetWidth);
	validateDimension(targetHeight);
	if (canvas.width === targetWidth && canvas.height === targetHeight) {
		return cloneCanvas(canvas);
	}
	if (scaling.kind === "nine_slice") {
		return scaleNineSlice(
			canvas,
			scaling.width,
			scaling.height,
			scaling.border,
			scaling.stretchInner,
			targetWidth,
			targetHeight,
		);
	}
	if (scaling.kind === "tile") {
		return scaleTiled(
			canvas,
			scaling.width,
			scaling.height,
			targetWidth,
			targetHeight,
		);
	}
	const out = cloneCanvas(canvas);
	resize(out, targetWidth, targetHeight, "nearest");
	return out;
}
