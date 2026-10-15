import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import type { PixelCanvas } from "../core/types.ts";
import { flattenCanvas } from "../io/png.ts";

export interface CompareBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface CompareReport {
	width: number;
	height: number;
	totalPixels: number;
	rawChangedPixels: number;
	visibleChangedPixels: number;
	rawBounds: CompareBounds | null;
	visibleBounds: CompareBounds | null;
}
export interface CompareResult {
	report: CompareReport;
	image?: PixelCanvas;
}

function getCompositeBuffer(canvas: PixelCanvas): Uint8Array {
	if (canvas.layers.length === 1) {
		const single = canvas.layers[0];
		if (single?.visible && single.opacity >= 1) {
			return single.pixels;
		}
	}
	return flattenCanvas(canvas);
}

export function comparePngCanvases(
	before: PixelCanvas,
	after: PixelCanvas,
	image = false,
	scale = 1,
): CompareResult {
	if (!Number.isInteger(scale) || scale < 1 || scale > 16) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"scale must be an integer from 1 to 16.",
		);
	}
	if (before.width !== after.width || before.height !== after.height) {
		throw new McAssetError("INVALID_ARGUMENT", "PNG dimensions must match.");
	}
	if (image && Math.max(before.width, before.height) * scale > 1024) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"Diff image longest edge must not exceed 1024 pixels.",
		);
	}

	const width = before.width;
	const height = before.height;
	const totalPixels = width * height;

	const beforeRaw = getCompositeBuffer(before);
	const afterRaw = getCompositeBuffer(after);

	const beforeFlat = flattenCanvas(before);
	const afterFlat = flattenCanvas(after);

	let rawChangedPixels = 0;
	let visibleChangedPixels = 0;

	let rawMinX = width;
	let rawMaxX = -1;
	let rawMinY = height;
	let rawMaxY = -1;

	let visMinX = width;
	let visMaxX = -1;
	let visMinY = height;
	let visMaxY = -1;

	// 0: unchanged, 1: raw-only, 2: visible
	const diffStatus = image ? new Uint8Array(totalPixels) : null;

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const idx = y * width + x;
			const offset = idx * 4;

			const br = beforeRaw[offset] as number;
			const bg = beforeRaw[offset + 1] as number;
			const bb = beforeRaw[offset + 2] as number;
			const ba = beforeRaw[offset + 3] as number;

			const ar = afterRaw[offset] as number;
			const ag = afterRaw[offset + 1] as number;
			const ab = afterRaw[offset + 2] as number;
			const aa = afterRaw[offset + 3] as number;

			const rawDifferent = br !== ar || bg !== ag || bb !== ab || ba !== aa;

			const vba = beforeFlat[offset + 3] as number;
			const vaa = afterFlat[offset + 3] as number;

			let visibleDifferent = false;
			if (vba === 0 && vaa === 0) {
				visibleDifferent = false;
			} else {
				const vbr = beforeFlat[offset] as number;
				const vbg = beforeFlat[offset + 1] as number;
				const vbb = beforeFlat[offset + 2] as number;

				const varColor = afterFlat[offset] as number;
				const vagColor = afterFlat[offset + 1] as number;
				const vabColor = afterFlat[offset + 2] as number;

				visibleDifferent =
					vbr !== varColor ||
					vbg !== vagColor ||
					vbb !== vabColor ||
					vba !== vaa;
			}

			if (rawDifferent) {
				rawChangedPixels += 1;
				if (x < rawMinX) rawMinX = x;
				if (x > rawMaxX) rawMaxX = x;
				if (y < rawMinY) rawMinY = y;
				if (y > rawMaxY) rawMaxY = y;
			}

			if (visibleDifferent) {
				visibleChangedPixels += 1;
				if (x < visMinX) visMinX = x;
				if (x > visMaxX) visMaxX = x;
				if (y < visMinY) visMinY = y;
				if (y > visMaxY) visMaxY = y;
			}

			if (diffStatus !== null) {
				if (visibleDifferent) {
					diffStatus[idx] = 2;
				} else if (rawDifferent) {
					diffStatus[idx] = 1;
				}
			}
		}
	}

	const rawBounds: CompareBounds | null =
		rawChangedPixels > 0
			? {
					x: rawMinX,
					y: rawMinY,
					width: rawMaxX - rawMinX + 1,
					height: rawMaxY - rawMinY + 1,
				}
			: null;

	const visibleBounds: CompareBounds | null =
		visibleChangedPixels > 0
			? {
					x: visMinX,
					y: visMinY,
					width: visMaxX - visMinX + 1,
					height: visMaxY - visMinY + 1,
				}
			: null;

	let diffImage: PixelCanvas | undefined;
	if (image && diffStatus !== null) {
		const outWidth = width * scale;
		const outHeight = height * scale;
		const outPixels = new Uint8Array(outWidth * outHeight * 4);

		for (let outY = 0; outY < outHeight; outY += 1) {
			const srcY = (outY - (outY % scale)) / scale;
			for (let outX = 0; outX < outWidth; outX += 1) {
				const srcX = (outX - (outX % scale)) / scale;
				const status = diffStatus[srcY * width + srcX] as number;
				const outOffset = (outY * outWidth + outX) * 4;

				if (status === 2) {
					// visible change: magenta (255, 0, 255, 255)
					outPixels[outOffset] = 255;
					outPixels[outOffset + 1] = 0;
					outPixels[outOffset + 2] = 255;
					outPixels[outOffset + 3] = 255;
				} else if (status === 1) {
					// raw-only change: cyan (0, 255, 255, 255)
					outPixels[outOffset] = 0;
					outPixels[outOffset + 1] = 255;
					outPixels[outOffset + 2] = 255;
					outPixels[outOffset + 3] = 255;
				}
				// unchanged: 0, 0, 0, 0
			}
		}

		diffImage = createCanvas(outWidth, outHeight);
		const layer = addLayer(diffImage, { id: "base" });
		replaceLayerPixels(diffImage, layer.id, outPixels);
	}

	return {
		report: {
			width,
			height,
			totalPixels,
			rawChangedPixels,
			visibleChangedPixels,
			rawBounds,
			visibleBounds,
		},
		...(diffImage !== undefined ? { image: diffImage } : {}),
	};
}
