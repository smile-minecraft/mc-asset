import { getLayer, replaceLayerPixels } from "../core/canvas.ts";
import {
	quantizePixelsWithPalette,
	quantizePixelsWithReservedColors,
	resolveQuantizeRequest,
} from "../core/quantize-palette.ts";
import { quantizePixels } from "../core/quantizer.ts";
import {
	forEachSelectedPixel,
	type ResolvedSelection,
} from "../core/selection.ts";
import type { PixelCanvas, RGBA } from "../core/types.ts";

/**
 * Shared per-layer quantize wiring for the CLI and MCP entries.
 *
 * - Without reserved colors, a colors budget keeps the frozen whole-layer
 *   quantizePixels path. The caller restores unselected pixels afterwards.
 * - Every other scope (a palette, or a colors budget with reserved colors)
 *   quantizes only the selected pixels of each layer and writes only those
 *   back. Unselected bytes never count toward the budget, the averages, or
 *   the palette.
 */

export type LayerQuantizeScope =
	| { kind: "colors"; colors: number; keepColors: RGBA[] }
	| { kind: "palette"; palette: RGBA[]; keepColors: RGBA[] };

/** Validate the quantize source once; every layer shares the result. */
export function resolveLayerQuantizeScope(options: {
	colors?: number | undefined;
	palette?: readonly RGBA[] | undefined;
	keepColors: readonly RGBA[];
}): LayerQuantizeScope {
	const request = resolveQuantizeRequest(options);
	if (request.kind === "palette") {
		return {
			kind: "palette",
			palette: request.palette,
			keepColors: request.keepColors,
		};
	}
	return {
		kind: "colors",
		colors: request.colors,
		keepColors: request.keepColors,
	};
}

/** Row-major pixel positions the selection covers. */
function selectedPositions(
	canvas: PixelCanvas,
	selection: ResolvedSelection,
): number[] {
	const positions: number[] = [];
	forEachSelectedPixel(selection, canvas, (x, y) => {
		positions.push(y * canvas.width + x);
	});
	return positions;
}

/** Copy the pixels at the given positions into a dense buffer. */
function gatherPixels(
	pixels: Uint8Array,
	positions: readonly number[],
): Uint8Array {
	const dense = new Uint8Array(positions.length * 4);
	for (let i = 0; i < positions.length; i += 1) {
		const from = (positions[i] as number) * 4;
		dense.set(pixels.subarray(from, from + 4), i * 4);
	}
	return dense;
}

/** Write a dense buffer back to the given positions of a full layer. */
function scatterPixels(
	target: Uint8Array,
	positions: readonly number[],
	dense: Uint8Array,
): void {
	for (let i = 0; i < positions.length; i += 1) {
		const to = (positions[i] as number) * 4;
		target.set(dense.subarray(i * 4, i * 4 + 4), to);
	}
}

function quantizeWholeLayer(
	canvas: PixelCanvas,
	layerId: string,
	colors: number,
): number {
	const result = quantizePixels(getLayer(canvas, layerId).pixels, colors);
	replaceLayerPixels(canvas, layerId, result.pixels);
	return result.colorCount;
}

function quantizeSelectedLayer(
	canvas: PixelCanvas,
	layerId: string,
	selection: ResolvedSelection,
	scope: LayerQuantizeScope,
): number {
	const source = getLayer(canvas, layerId).pixels;
	const positions =
		selection.kind === "all" ? undefined : selectedPositions(canvas, selection);
	const buffer =
		positions === undefined ? source.slice() : gatherPixels(source, positions);
	if (buffer.length === 0) {
		return 0;
	}
	const result =
		scope.kind === "palette"
			? quantizePixelsWithPalette(buffer, scope.palette, scope.keepColors)
			: quantizePixelsWithReservedColors(
					buffer,
					scope.colors,
					scope.keepColors,
				);
	if (positions === undefined) {
		replaceLayerPixels(canvas, layerId, result.pixels);
	} else {
		const next = source.slice();
		scatterPixels(next, positions, result.pixels);
		replaceLayerPixels(canvas, layerId, next);
	}
	return result.colorCount;
}

/**
 * Quantize every layer under one scope and return the largest per-layer
 * color count. Pixels outside the selection never add to that count.
 */
export function quantizeCanvasScope(
	canvas: PixelCanvas,
	selection: ResolvedSelection,
	scope: LayerQuantizeScope,
): number {
	let colorCount = 0;
	for (const layer of canvas.layers) {
		const layerCount =
			scope.kind === "colors" && scope.keepColors.length === 0
				? quantizeWholeLayer(canvas, layer.id, scope.colors)
				: quantizeSelectedLayer(canvas, layer.id, selection, scope);
		if (layerCount > colorCount) {
			colorCount = layerCount;
		}
	}
	return colorCount;
}
