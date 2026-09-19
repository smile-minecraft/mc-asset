/** PNG codec: decode to PixelCanvas, flatten, encode. Pure JS via pngjs. */

import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import type { PixelCanvas } from "../core/types.ts";
import {
	assertValidCanvas,
	checkResourceLimits,
	validateDimension,
	validateLayerPixelsSize,
} from "../core/validate.ts";

/** Fixed output parameters (§101.3): every encode of the same canvas is byte-identical. */
const OUTPUT_BIT_DEPTH = 8;
const OUTPUT_COLOR_TYPE = 6;
const OUTPUT_FILTER_TYPE = 0;
// Stored (uncompressed) deflate: compressed levels emit different bytes in
// Bun vs Node zlib builds for identical input, which would break the
// cross-runtime byte-identical guarantee (§100.4). Level 0 framing is
// canonical and encodes identically on both runtimes; size is traded for
// determinism. Strategy stays fixed (a no-op at level 0) to pin the set.
const OUTPUT_DEFLATE_LEVEL = 0;
const OUTPUT_DEFLATE_STRATEGY = 3;

/** decodePng always produces a single-layer canvas under this id. */
const DECODE_LAYER_ID = "base";

export type PngWarningCode = "GAMMA_IGNORED" | "ICCP_IGNORED";

export interface PngWarning {
	code: PngWarningCode;
	message: string;
}

export interface DecodePngResult {
	canvas: PixelCanvas;
	/**
	 * Normalization notes for the analyze step to surface (for example
	 * gAMA / iCCP chunks that were read but deliberately not applied).
	 * Empty when the input needed no such notes.
	 */
	warnings: PngWarning[];
}

const PNG_SIGNATURE: ReadonlyArray<number> = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
];

function unsupported(message: string, details?: unknown): McAssetError {
	return new McAssetError("UNSUPPORTED_IMAGE_FORMAT", message, details);
}

function readUInt32BE(input: Uint8Array, offset: number): number {
	return (
		(input[offset] as number) * 0x1000000 +
		((input[offset + 1] as number) << 16) +
		((input[offset + 2] as number) << 8) +
		(input[offset + 3] as number)
	);
}

function readAscii(input: Uint8Array, offset: number): string {
	return String.fromCharCode(
		input[offset] as number,
		input[offset + 1] as number,
		input[offset + 2] as number,
		input[offset + 3] as number,
	);
}

interface PngScan {
	width: number;
	height: number;
	hasGamma: boolean;
	hasIccp: boolean;
}

/**
 * Read IHDR dimensions and note gAMA / iCCP presence without decoding pixels.
 * Dimensions are validated before any pixel buffer exists (§102). Anything
 * structurally wrong surfaces as UNSUPPORTED_IMAGE_FORMAT; only the numeric
 * range check reports INVALID_DIMENSION.
 */
function scanPng(input: Uint8Array): PngScan {
	if (input.length < 8 + 8 + 13 + 4) {
		throw unsupported("Input is too short to be a PNG.", {
			length: input.length,
		});
	}
	for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
		if (input[i] !== PNG_SIGNATURE[i]) {
			throw unsupported("Input does not start with the PNG signature.", {});
		}
	}
	if (readAscii(input, 12) !== "IHDR" || readUInt32BE(input, 8) !== 13) {
		throw unsupported("First chunk must be a 13-byte IHDR.", {});
	}
	const width = readUInt32BE(input, 16);
	const height = readUInt32BE(input, 20);
	validateDimension(width);
	validateDimension(height);
	checkResourceLimits(width, height, 1, 0);
	let hasGamma = false;
	let hasIccp = false;
	let offset = 8;
	for (;;) {
		if (offset + 8 > input.length) {
			throw unsupported("Truncated PNG chunk header.", { offset });
		}
		const length = readUInt32BE(input, offset);
		const type = readAscii(input, offset + 4);
		if (offset + 12 + length > input.length) {
			throw unsupported("Truncated PNG chunk body.", { offset, type });
		}
		if (type === "gAMA") {
			hasGamma = true;
		} else if (type === "iCCP") {
			hasIccp = true;
		} else if (type === "IEND") {
			break;
		}
		offset += 12 + length;
	}
	return { width, height, hasGamma, hasIccp };
}

/**
 * Decode PNG bytes into a single-layer canvas. Pixel bytes are stored
 * verbatim: no premultiply, no transparent-RGB normalization, no resize.
 * 16-bit samples keep their high 8 bits (§101.2); palette, tRNS, grayscale,
 * and interlace inputs all normalize to RGBA8; gAMA / iCCP chunks are read
 * but deliberately not applied and reported through warnings. The input
 * buffer is only read, never written.
 */
export function decodePng(input: Uint8Array): DecodePngResult {
	const scan = scanPng(input);
	let image: {
		width: number;
		height: number;
		data: Uint8Array;
		depth?: number;
	};
	try {
		image = PNG.sync.read(Buffer.from(input), { skipRescale: true });
	} catch (error) {
		throw unsupported("Input bytes are not a decodable PNG.", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
	const { width, height } = image;
	validateDimension(width);
	validateDimension(height);
	const count = width * height * 4;
	let pixels: Uint8Array;
	if (image.depth === 16) {
		// skipRescale keeps raw 16-bit samples: take the high 8 bits exactly.
		const raw = image.data as unknown as Uint16Array;
		if (!(raw instanceof Uint16Array) || raw.length !== count) {
			throw new McAssetError(
				"INVALID_DIMENSION",
				"Decoded 16-bit buffer size must match canvas dimensions.",
				{ width, height, actual: (raw as Uint16Array).length },
			);
		}
		pixels = new Uint8Array(count);
		for (let i = 0; i < count; i += 1) {
			pixels[i] = raw[i] >> 8;
		}
	} else {
		pixels = new Uint8Array(image.data);
	}
	validateLayerPixelsSize(width, height, pixels);
	if (width !== scan.width || height !== scan.height) {
		throw new McAssetError(
			"INVALID_DIMENSION",
			"Decoded dimensions must match the IHDR header.",
			{ header: { width: scan.width, height: scan.height }, width, height },
		);
	}
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: DECODE_LAYER_ID });
	replaceLayerPixels(canvas, layer.id, pixels);
	const warnings: PngWarning[] = [];
	if (scan.hasGamma) {
		warnings.push({
			code: "GAMMA_IGNORED",
			message:
				"gAMA chunk ignored: pixels are used verbatim without gamma correction.",
		});
	}
	if (scan.hasIccp) {
		warnings.push({
			code: "ICCP_IGNORED",
			message: "iCCP chunk ignored: the embedded color profile is not applied.",
		});
	}
	return { canvas, warnings };
}

/**
 * Composite every visible layer bottom-to-top with src-over in
 * straight-alpha space, using only integer-rounded arithmetic so the result
 * is identical across runtimes. Hidden layers and zero-opacity layers
 * contribute nothing; nothing else is normalized, resized, or quantized.
 * A fully transparent result keeps the topmost hidden RGB verbatim instead
 * of being cleared to black.
 */
export function flattenCanvas(canvas: PixelCanvas): Uint8Array {
	assertValidCanvas(canvas);
	const out = new Uint8Array(canvas.width * canvas.height * 4);
	for (const layer of canvas.layers) {
		if (!layer.visible) {
			continue;
		}
		const opacity = layer.opacity;
		if (!(opacity > 0)) {
			continue;
		}
		const effective = opacity >= 1 ? 1 : opacity;
		validateLayerPixelsSize(canvas.width, canvas.height, layer.pixels);
		const src = layer.pixels;
		for (let i = 0; i < out.length; i += 4) {
			const srcAlpha = Math.round((src[i + 3] as number) * effective);
			if (srcAlpha <= 0) {
				if (out[i + 3] === 0) {
					out[i] = src[i] as number;
					out[i + 1] = src[i + 1] as number;
					out[i + 2] = src[i + 2] as number;
				}
				continue;
			}
			const dstAlpha = out[i + 3] as number;
			const inverse = 255 - srcAlpha;
			const outAlpha = srcAlpha + Math.round((dstAlpha * inverse) / 255);
			const dstCoverage = ((dstAlpha * inverse) / 255) as number;
			out[i] = Math.round(
				(((src[i] as number) * srcAlpha +
					(out[i] as number) * dstCoverage) as number) / outAlpha,
			);
			out[i + 1] = Math.round(
				(((src[i + 1] as number) * srcAlpha +
					(out[i + 1] as number) * dstCoverage) as number) / outAlpha,
			);
			out[i + 2] = Math.round(
				(((src[i + 2] as number) * srcAlpha +
					(out[i + 2] as number) * dstCoverage) as number) / outAlpha,
			);
			out[i + 3] = outAlpha;
		}
	}
	return out;
}

/**
 * Flatten the canvas and encode RGBA8 with fixed parameters (bit depth 8,
 * color type 6, no interlace, fixed compression and filter, no variable
 * chunks), so the same canvas always encodes to identical bytes (§101.3).
 */
export function encodePng(canvas: PixelCanvas): Uint8Array {
	assertValidCanvas(canvas);
	const flat = flattenCanvas(canvas);
	try {
		const encoded = PNG.sync.write(
			{ width: canvas.width, height: canvas.height, data: Buffer.from(flat) },
			{
				colorType: OUTPUT_COLOR_TYPE,
				bitDepth: OUTPUT_BIT_DEPTH,
				inputColorType: OUTPUT_COLOR_TYPE,
				filterType: OUTPUT_FILTER_TYPE,
				deflateLevel: OUTPUT_DEFLATE_LEVEL,
				deflateStrategy: OUTPUT_DEFLATE_STRATEGY,
			},
		);
		return new Uint8Array(encoded);
	} catch (error) {
		throw new McAssetError("INTERNAL_ERROR", "PNG encoding failed.", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}
