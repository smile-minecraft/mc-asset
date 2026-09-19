import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import {
	isPixelSelected,
	type ResolvedSelection,
	resolveSelection,
} from "../core/selection.ts";
import type { PixelCanvas } from "../core/types.ts";
import { decodeImage } from "../io/decode.ts";
import { parseMcpx } from "../mcpx/index.ts";
import { readInputFile, readInputText, type WarningNote } from "./artifacts.ts";

/**
 * Shared canvas intake for the wave1 pixel commands (transform, quantize,
 * cleanup, palette, recolor). `.mcpx` sources parse as text; anything else
 * goes through the shared multi-format raster decoder (PNG, JPEG, WebP),
 * the same decode source as the raster intake below. No filenames are
 * derived here; callers pass explicit input and output paths.
 */

export interface LoadedCanvas {
	canvas: PixelCanvas;
	warnings: WarningNote[];
}

export async function loadEditableCanvas(
	inputPath: string,
): Promise<LoadedCanvas> {
	if (inputPath.toLowerCase().endsWith(".mcpx")) {
		return {
			canvas: parseMcpx(await readInputText(inputPath, "canvas input")),
			warnings: [],
		};
	}
	const decoded = await decodeImage(await readInputFile(inputPath, "image"));
	const canvas = createCanvas(decoded.width, decoded.height);
	const layer = addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, layer.id, decoded.pixels);
	return {
		canvas,
		warnings: decoded.warnings.map((warning) => ({
			code: warning.code,
			message: warning.message,
		})),
	};
}

/**
 * Raster intake for pixelize: PNG, JPEG, and WebP all decode through the
 * shared multi-format entry. The .mcpx source format is rejected here so
 * the raster-only contract lives in one place. The editable intake above
 * shares the same decode source and canvas assembly.
 */
export async function loadRasterCanvas(
	inputPath: string,
): Promise<LoadedCanvas> {
	if (inputPath.toLowerCase().endsWith(".mcpx")) {
		throw new McAssetError(
			"UNSUPPORTED_IMAGE_FORMAT",
			"Raster input required: .mcpx sources cannot enter here.",
			{ inputPath },
		);
	}
	const decoded = await decodeImage(await readInputFile(inputPath, "image"));
	const canvas = createCanvas(decoded.width, decoded.height);
	const layer = addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, layer.id, decoded.pixels);
	return {
		canvas,
		warnings: decoded.warnings.map((warning) => ({
			code: warning.code,
			message: warning.message,
		})),
	};
}

/**
 * Resolve `--selection` once before the first pixel write, per the frozen
 * selection contract. Geometry plus selection is ARGUMENT_CONFLICT; the
 * caller passes hasGeometry=true for transform so the rejection lives in
 * one place.
 */
export function resolveCommandSelection(
	canvas: PixelCanvas,
	raw: string | undefined,
	hasGeometry: boolean,
): ResolvedSelection {
	if (raw !== undefined && raw !== "" && hasGeometry) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"--selection cannot be combined with geometry operations.",
		);
	}
	return resolveSelection(
		canvas,
		raw === undefined || raw === "" ? undefined : raw,
	);
}

/** Snapshot every layer's bytes so unselected pixels can be restored verbatim. */
export function snapshotLayerBytes(canvas: PixelCanvas): Uint8Array[] {
	return canvas.layers.map((layer) => layer.pixels.slice());
}

/**
 * Restore every unselected pixel to its pre-operation bytes, including
 * hidden RGB under A = 0. Returns the count of pixels that still differ
 * from the snapshot, so reports describe what was actually written under
 * the selection rather than the unscoped engine pass.
 */
export function restoreUnselectedPixels(
	canvas: PixelCanvas,
	before: Uint8Array[],
	selection: ResolvedSelection,
): number {
	if (selection.kind === "all") {
		let changed = 0;
		for (let li = 0; li < canvas.layers.length; li += 1) {
			const layer = canvas.layers[li] as { pixels: Uint8Array };
			const prev = before[li] as Uint8Array;
			for (let i = 0; i < layer.pixels.length; i += 4) {
				if (
					layer.pixels[i] !== prev[i] ||
					layer.pixels[i + 1] !== prev[i + 1] ||
					layer.pixels[i + 2] !== prev[i + 2] ||
					layer.pixels[i + 3] !== prev[i + 3]
				) {
					changed += 1;
				}
			}
		}
		return changed;
	}
	for (let li = 0; li < canvas.layers.length; li += 1) {
		const layer = canvas.layers[li] as { pixels: Uint8Array };
		const prev = before[li] as Uint8Array;
		for (let y = 0; y < canvas.height; y += 1) {
			for (let x = 0; x < canvas.width; x += 1) {
				if (isPixelSelected(selection, canvas, x, y)) {
					continue;
				}
				const offset = (y * canvas.width + x) * 4;
				layer.pixels[offset] = prev[offset] as number;
				layer.pixels[offset + 1] = prev[offset + 1] as number;
				layer.pixels[offset + 2] = prev[offset + 2] as number;
				layer.pixels[offset + 3] = prev[offset + 3] as number;
			}
		}
	}
	let changed = 0;
	for (let li = 0; li < canvas.layers.length; li += 1) {
		const layer = canvas.layers[li] as { pixels: Uint8Array };
		const prev = before[li] as Uint8Array;
		for (let i = 0; i < layer.pixels.length; i += 4) {
			if (
				layer.pixels[i] !== prev[i] ||
				layer.pixels[i + 1] !== prev[i + 1] ||
				layer.pixels[i + 2] !== prev[i + 2] ||
				layer.pixels[i + 3] !== prev[i + 3]
			) {
				changed += 1;
			}
		}
	}
	return changed;
}
