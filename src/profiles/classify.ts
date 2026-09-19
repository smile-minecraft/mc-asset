import { getPixel } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import type { PixelCanvas } from "../core/types.ts";
import { assertValidCanvas } from "../core/validate.ts";
import type {
	AlphaHistogram,
	PredictedAlphaClassification,
	PredictedAlphaReport,
	ProfileWarning,
} from "./types.ts";

const RECOMMENDED_RESOLUTIONS = [16, 32, 64, 128];

function isChannel(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * Pure alpha histogram over raw alpha bytes. Unique partial values are
 * emitted in ascending order via a fixed 256-slot seen table, so the order
 * is a full order without relying on unstable sorts.
 */
export function summarizeAlphaFromValues(
	alphas: ArrayLike<number>,
): AlphaHistogram {
	let opaquePixels = 0;
	let transparentPixels = 0;
	let partialAlphaPixels = 0;
	const seen = new Uint8Array(256);
	for (let i = 0; i < alphas.length; i += 1) {
		const a = alphas[i] as number;
		if (!isChannel(a)) {
			throw new McAssetError(
				"INVALID_COLOR",
				"Alpha values must be integers in [0, 255].",
				{ index: i, alpha: a },
			);
		}
		if (a === 255) {
			opaquePixels += 1;
		} else if (a === 0) {
			transparentPixels += 1;
		} else {
			partialAlphaPixels += 1;
			seen[a] = 1;
		}
	}
	const partialAlphaValues: number[] = [];
	for (let a = 1; a < 255; a += 1) {
		if (seen[a] === 1) {
			partialAlphaValues.push(a);
		}
	}
	return {
		opaquePixels,
		transparentPixels,
		partialAlphaPixels,
		partialAlphaValues,
	};
}

/**
 * Read-only canvas walk (row-major, y-outer). Never writes: partial alpha
 * is reported, not normalized or fixed.
 */
export function summarizeCanvasAlpha(
	canvas: PixelCanvas,
	layerId: string,
): AlphaHistogram {
	assertValidCanvas(canvas);
	let opaquePixels = 0;
	let transparentPixels = 0;
	let partialAlphaPixels = 0;
	const seen = new Uint8Array(256);
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			const pixel = getPixel(canvas, layerId, x, y);
			const a = pixel.a;
			if (a === 255) {
				opaquePixels += 1;
			} else if (a === 0) {
				transparentPixels += 1;
			} else {
				partialAlphaPixels += 1;
				seen[a] = 1;
			}
		}
	}
	const partialAlphaValues: number[] = [];
	for (let a = 1; a < 255; a += 1) {
		if (seen[a] === 1) {
			partialAlphaValues.push(a);
		}
	}
	return {
		opaquePixels,
		transparentPixels,
		partialAlphaPixels,
		partialAlphaValues,
	};
}

/** §78 rule: any 0<A<255 wins over the all-opaque / cutout cases. */
export function classifyPredictedClassification(
	histogram: AlphaHistogram,
): PredictedAlphaClassification {
	if (histogram.partialAlphaPixels > 0) {
		return "translucent";
	}
	if (histogram.transparentPixels > 0) {
		return "cutout";
	}
	return "solid";
}

export function collectPartialAlphaWarnings(
	histogram: AlphaHistogram,
): ProfileWarning[] {
	if (histogram.partialAlphaPixels <= 0) {
		return [];
	}
	return [
		{
			code: "PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING",
			level: "warning",
			message: `predicted translucent: ${histogram.partialAlphaPixels} partial-alpha pixel(s) use the translucent render pass; left as-is with no auto-fix.`,
		},
	];
}

/**
 * §39 / §45: block sizes are recommendations, never errors. Anything outside
 * the recommended square set only warns.
 */
export function checkBlockResolutionWarnings(
	width: number,
	height: number,
): ProfileWarning[] {
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Resolution must be positive integers.",
			{ width, height },
		);
	}
	let recommended = false;
	if (width === height) {
		for (const edge of RECOMMENDED_RESOLUTIONS) {
			if (width === edge) {
				recommended = true;
			}
		}
	}
	if (recommended) {
		return [];
	}
	return [
		{
			code: "NON_STANDARD_RESOLUTION",
			level: "warning",
			message: `non-standard resolution ${width}x${height} for minecraft:block; recommendation only, the texture remains loadable.`,
		},
	];
}

/** Single-PNG analysis: predicted classification plus counts. */
export function analyzeCanvasAlphaPredicted(
	canvas: PixelCanvas,
	layerId: string,
): PredictedAlphaReport {
	const histogram = summarizeCanvasAlpha(canvas, layerId);
	return {
		predictedClassification: classifyPredictedClassification(histogram),
		opaquePixels: histogram.opaquePixels,
		transparentPixels: histogram.transparentPixels,
		partialAlphaPixels: histogram.partialAlphaPixels,
		partialAlphaValues: [...histogram.partialAlphaValues],
		predictedNote:
			"predicted classification from PNG bytes only; not the final in-game render result.",
	};
}
