import {
	addLayer,
	addRegion,
	createAuthoringPalette,
	createCanvas,
	replaceLayerPixels,
	replaceRegionMask,
} from "../core/canvas.ts";
import type { PixelCanvas } from "../core/types.ts";
import { checkResourceLimits } from "../core/validate.ts";
import { mcpxError } from "./errors.ts";
import type { ValidDocument } from "./validator.ts";

/**
 * Builder stage: turns a validated document into a PixelCanvas using only the
 * public core API. Dimensions were range-checked by the validator, and the
 * resource gate below runs before any pixel buffer is allocated.
 */
export function buildCanvas(doc: ValidDocument): PixelCanvas {
	checkResourceLimits(
		doc.width,
		doc.height,
		doc.layers.length,
		doc.regions.length,
	);

	const canvas = createCanvas(doc.width, doc.height, {
		metadata: { ...doc.metadata },
		...(doc.palette.length > 0
			? {
					palette: createAuthoringPalette(
						doc.palette.map((entry) => ({
							id: entry.symbol,
							color: { ...entry.color },
							...(entry.role !== undefined ? { role: entry.role } : {}),
						})),
					),
				}
			: {}),
	});

	const colorOf = new Map(
		doc.palette.map((entry) => [entry.symbol, entry.color]),
	);
	for (const layer of doc.layers) {
		const handle = addLayer(canvas, {
			id: layer.id,
			visible: layer.visible,
			opacity: layer.opacity,
			...(layer.name !== undefined ? { name: layer.name } : {}),
		});
		const pixels = new Uint8Array(doc.width * doc.height * 4);
		for (let y = 0; y < doc.height; y += 1) {
			const row = layer.cells[y] as string[];
			for (let x = 0; x < doc.width; x += 1) {
				const color = colorOf.get(row[x] as string);
				if (color === undefined) {
					throw mcpxError(
						"MCPX_SEMANTIC_ERROR",
						`Grid symbol "${row[x]}" is missing from [palette].`,
						{ line: layer.gridLine, section: `layer ${layer.id}` },
					);
				}
				const offset = (y * doc.width + x) * 4;
				pixels[offset] = color.r;
				pixels[offset + 1] = color.g;
				pixels[offset + 2] = color.b;
				pixels[offset + 3] = color.a;
			}
		}
		replaceLayerPixels(canvas, handle.id, pixels);
	}

	for (const region of doc.regions) {
		const handle = addRegion(canvas, {
			id: region.id,
			...(region.name !== undefined ? { name: region.name } : {}),
		});
		const mask = new Uint8Array(doc.width * doc.height);
		for (let y = 0; y < doc.height; y += 1) {
			const row = region.cells[y] as number[];
			for (let x = 0; x < doc.width; x += 1) {
				mask[y * doc.width + x] = row[x] as number;
			}
		}
		replaceRegionMask(canvas, handle.id, mask);
	}

	return canvas;
}
