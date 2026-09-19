/**
 * Multi-format raster decode: PNG / JPEG / WebP into a single-layer canvas.
 *
 * Selection record (`.project-doc/decoder-selection.md`):
 * - JPEG: jpeg-js@0.4.4, pure JS, bundled inline, no glue needed.
 * - WebP: @jsquash/webp@1.5.0 (libwebp) with `init({ instantiateWasm })`
 *   glue; the wasm binary is base64-embedded (see webp-wasm-b64.ts) so the
 *   single-file dist bundle needs no sidecar and no node_modules.
 * - Fallback if the embedded strategy ever breaks: webp-wasm@1.0.6
 *   (explicit `load()`, exact-ArrayBuffer inputs). Not installed; this file
 *   documents the switch point (ensureWebp below).
 *
 * All three paths keep A = 0 pixels verbatim (no premultiply) and never
 * mutate the input bytes. Structural failures surface as
 * UNSUPPORTED_IMAGE_FORMAT; numeric range failures as INVALID_DIMENSION.
 */

import { Buffer } from "node:buffer";
import {
	default as decodeWebp,
	init as initWebp,
} from "@jsquash/webp/decode.js";
import { decode as decodeJpeg } from "jpeg-js";
import { McAssetError } from "../core/errors.ts";
import {
	checkResourceLimits,
	validateDimension,
	validateLayerPixelsSize,
} from "../core/validate.ts";
import { decodePng } from "./png.ts";
import {
	WEBP_DEC_WASM_BASE64,
	WEBP_DEC_WASM_BYTE_LENGTH,
} from "./webp-wasm-b64.ts";

/** Raster formats accepted on the pixelize path. */
export type DecodedImageFormat = "png" | "jpeg" | "webp";

export interface DecodedImage {
	format: DecodedImageFormat;
	width: number;
	height: number;
	/** Straight-alpha RGBA bytes; A = 0 pixels are kept verbatim. */
	pixels: Uint8Array;
	warnings: Array<{ code: string; message: string }>;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function unsupported(message: string, details?: unknown): McAssetError {
	return new McAssetError("UNSUPPORTED_IMAGE_FORMAT", message, details);
}

/** Magic-byte dispatch. Short inputs are unknown, never a crash. */
export function detectImageFormat(
	input: Uint8Array,
): DecodedImageFormat | "unknown" {
	if (input.length >= 8) {
		let png = true;
		for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
			if (input[i] !== PNG_SIGNATURE[i]) {
				png = false;
				break;
			}
		}
		if (png) {
			return "png";
		}
	}
	if (
		input.length >= 3 &&
		input[0] === 0xff &&
		input[1] === 0xd8 &&
		input[2] === 0xff
	) {
		return "jpeg";
	}
	if (
		input.length >= 12 &&
		input[0] === 0x52 &&
		input[1] === 0x49 &&
		input[2] === 0x46 &&
		input[3] === 0x46 &&
		input[8] === 0x57 &&
		input[9] === 0x45 &&
		input[10] === 0x42 &&
		input[11] === 0x50
	) {
		return "webp";
	}
	return "unknown";
}

/** Defensive copy: pooled-Buffer backings must never reach the wasm glue. */
function exactCopy(input: Uint8Array): Uint8Array {
	return Uint8Array.from(input);
}

/** Fresh exact ArrayBuffer copy for the wasm entry (never a pool slice). */
function exactBuffer(input: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(input.length);
	out.set(input);
	return out.buffer as ArrayBuffer;
}

function checkDecodedPixels(
	width: number,
	height: number,
	pixels: Uint8Array,
): void {
	validateDimension(width);
	validateDimension(height);
	checkResourceLimits(width, height, 1, 0);
	validateLayerPixelsSize(width, height, pixels);
}

function decodeJpegImage(input: Uint8Array): DecodedImage {
	let decoded: { width: number; height: number; data: Uint8Array };
	try {
		decoded = decodeJpeg(exactCopy(input), { useTArray: true });
	} catch (error) {
		throw unsupported("Input bytes are not a decodable JPEG.", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
	const { width, height } = decoded;
	const pixels = new Uint8Array(decoded.data);
	if (pixels.length !== width * height * 4) {
		throw unsupported("Decoded JPEG buffer size must match dimensions.", {
			width,
			height,
			actual: pixels.length,
		});
	}
	checkDecodedPixels(width, height, pixels);
	return {
		format: "jpeg",
		width,
		height,
		pixels,
		warnings: [],
	};
}

let webpReady: Promise<void> | undefined;

/**
 * One-time wasm setup from the embedded bytes. The emscripten glue would
 * otherwise `fetch` the .wasm file, which fails inside the bundled dist;
 * manual instantiation keeps Bun source and the Node bundle identical.
 */
function ensureWebp(): Promise<void> {
	if (webpReady === undefined) {
		webpReady = (async () => {
			const bytes = new Uint8Array(
				Buffer.from(WEBP_DEC_WASM_BASE64.join(""), "base64"),
			);
			if (bytes.length !== WEBP_DEC_WASM_BYTE_LENGTH) {
				throw new McAssetError(
					"INTERNAL_ERROR",
					"Embedded WebP decoder payload length mismatch.",
					{ actual: bytes.length, expected: WEBP_DEC_WASM_BYTE_LENGTH },
				);
			}
			const module = new WebAssembly.Module(bytes.buffer);
			// The package glue type names lib members outside this repo's
			// lib set, so the options object crosses as never; the shape is
			// pinned by the decode tests on both runtimes instead.
			type InstanceImports = ConstructorParameters<
				typeof WebAssembly.Instance
			>[1];
			const glue = {
				instantiateWasm(
					imports: InstanceImports,
					callback: (instance: WebAssembly.Instance) => void,
				): Record<string, object> {
					const instance = new WebAssembly.Instance(module, imports);
					callback(instance);
					return instance.exports as Record<string, object>;
				},
			} as never;
			await initWebp(glue);
		})();
	}
	return webpReady;
}

async function decodeWebpImage(input: Uint8Array): Promise<DecodedImage> {
	await ensureWebp();
	const copy = exactCopy(input);
	let decoded: { width: number; height: number; data: Uint8Array };
	try {
		const image = await decodeWebp(exactBuffer(copy));
		if (image === null || image === undefined) {
			throw unsupported("Input bytes are not a decodable WebP.", {});
		}
		decoded = {
			width: image.width,
			height: image.height,
			data: new Uint8Array(image.data),
		};
	} catch (error) {
		if (error instanceof McAssetError) {
			throw error;
		}
		throw unsupported("Input bytes are not a decodable WebP.", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
	const { width, height } = decoded;
	if (decoded.data.length !== width * height * 4) {
		throw unsupported("Decoded WebP buffer size must match dimensions.", {
			width,
			height,
			actual: decoded.data.length,
		});
	}
	checkDecodedPixels(width, height, decoded.data);
	return {
		format: "webp",
		width,
		height,
		pixels: decoded.data,
		warnings: [],
	};
}

/**
 * Decode PNG, JPEG, or WebP bytes into straight-alpha RGBA. The input
 * buffer is only read, never written. Unknown or corrupt inputs are
 * UNSUPPORTED_IMAGE_FORMAT.
 */
export async function decodeImage(input: Uint8Array): Promise<DecodedImage> {
	const format = detectImageFormat(input);
	if (format === "png") {
		const decoded = decodePng(input);
		const layer = decoded.canvas.layers[0];
		if (layer === undefined) {
			throw unsupported("Decoded PNG carries no layer.", {});
		}
		return {
			format,
			width: decoded.canvas.width,
			height: decoded.canvas.height,
			pixels: layer.pixels.slice(),
			warnings: decoded.warnings.map((warning) => ({ ...warning })),
		};
	}
	if (format === "jpeg") {
		return decodeJpegImage(input);
	}
	if (format === "webp") {
		return decodeWebpImage(input);
	}
	throw unsupported("Input is not a supported raster image.", {
		length: input.length,
	});
}
