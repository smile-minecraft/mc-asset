import { McAssetError } from "../core/errors.ts";
import { checkResourceLimits, validateDimension } from "../core/validate.ts";
import { crc32 } from "./png-chunks.ts";

export type AncillaryPolicy = "preserve" | "strip";

/** Where an ancillary chunk sat in the source stream. */
export type PngChunkSegment = "before-plte" | "after-plte" | "after-idat";

export interface PngSourceChunk {
	readonly type: string;
	readonly data: Uint8Array;
	readonly segment: PngChunkSegment;
}

export interface PngSourceInfo {
	readonly width: number;
	readonly height: number;
	readonly bitDepth: 1 | 2 | 4 | 8;
	readonly colorType: 0 | 2 | 3 | 4 | 6;
	readonly interlaced: boolean;
	readonly chunkCount: number;
}

export interface PngSourcePlan {
	readonly info: PngSourceInfo;
	/** Ancillary chunks to copy verbatim, in source order. Empty under "strip". */
	readonly preserved: readonly PngSourceChunk[];
	/** Ancillary chunk types dropped (only under "strip"), in source order, with repeats kept. */
	readonly stripped: readonly string[];
}

export const PNG_SOURCE_LIMITS: {
	readonly maxInputBytes: 134217728;
	readonly maxChunks: 10000;
} = { maxInputBytes: 134217728, maxChunks: 10000 };

/** details.reason values thrown with UNSUPPORTED_IMAGE_FORMAT by planPngSource. */
export type PngSourceRejectReason =
	| "not-png"
	| "truncated"
	| "bad-crc"
	| "trailing-data"
	| "chunk-order"
	| "invalid-ihdr"
	| "invalid-chunk"
	| "animated-png"
	| "bit-depth-16"
	| "color-key-transparency"
	| "unknown-critical-chunk"
	| "ancillary-needs-strip"
	| "decode-failed";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const COLOR_TYPES = new Set([0, 2, 3, 4, 6]);
const SAFE_KNOWN_ANCILLARY = new Set([
	"gAMA",
	"cHRM",
	"sRGB",
	"iCCP",
	"cICP",
	"mDCv",
	"cLLI",
	"pHYs",
	"sPLT",
	"tIME",
	"tEXt",
	"zTXt",
	"iTXt",
	"eXIf",
]);
const NEEDS_STRIP_ANCILLARY = new Set(["sBIT", "bKGD", "hIST"]);

function readUInt32BE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] as number) * 0x1000000 +
		((bytes[offset + 1] as number) << 16) +
		((bytes[offset + 2] as number) << 8) +
		(bytes[offset + 3] as number)
	);
}

function readAscii(bytes: Uint8Array, offset: number): string {
	return String.fromCharCode(
		bytes[offset] as number,
		bytes[offset + 1] as number,
		bytes[offset + 2] as number,
		bytes[offset + 3] as number,
	);
}

function reject(
	reason: PngSourceRejectReason,
	message: string,
	details: Record<string, unknown> = {},
): never {
	throw new McAssetError("UNSUPPORTED_IMAGE_FORMAT", message, {
		reason,
		...details,
	});
}

function validBitDepth(colorType: number, bitDepth: number): boolean {
	switch (colorType) {
		case 0:
			return [1, 2, 4, 8, 16].includes(bitDepth);
		case 2:
		case 4:
		case 6:
			return bitDepth === 8 || bitDepth === 16;
		case 3:
			return [1, 2, 4, 8].includes(bitDepth);
		default:
			return false;
	}
}

function isAsciiLetter(value: number): boolean {
	return (value >= 65 && value <= 90) || (value >= 97 && value <= 122);
}

function isAncillary(type: string): boolean {
	return type.charCodeAt(0) >= 97 && type.charCodeAt(0) <= 122;
}

function isUnknownCritical(type: string): boolean {
	return (
		!isAncillary(type) &&
		type !== "IHDR" &&
		type !== "PLTE" &&
		type !== "IDAT" &&
		type !== "IEND"
	);
}

function chunkError(type: string, ancillary: AncillaryPolicy): void {
	if (type === "acTL" || type === "fcTL" || type === "fdAT")
		reject("animated-png", "Animated PNG input is not supported.", {
			chunk: type,
		});
	if (!isAncillary(type))
		reject("unknown-critical-chunk", "Unknown critical PNG chunk.", {
			chunk: type,
		});
	if (ancillary === "preserve")
		reject("ancillary-needs-strip", "PNG chunk requires the strip policy.", {
			chunk: type,
		});
	return;
}

/**
 * Chunk-level walk of the source with the policy in the "source chunk table". Never decodes
 * pixels. Throws McAssetError("UNSUPPORTED_IMAGE_FORMAT", message, { reason, chunk?, chunks? })
 * for every PngSourceRejectReason; throws RESOURCE_LIMIT_EXCEEDED when input exceeds
 * PNG_SOURCE_LIMITS or the IHDR dimensions exceed the canvas limits (same gate as decodePng).
 */
export function planPngSource(
	bytes: Uint8Array,
	ancillary: AncillaryPolicy,
): PngSourcePlan {
	const inputLength = bytes.byteLength;
	if (inputLength > PNG_SOURCE_LIMITS.maxInputBytes) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"PNG input exceeds the byte limit.",
			{ limit: PNG_SOURCE_LIMITS.maxInputBytes, actual: inputLength },
		);
	}
	if (inputLength < PNG_SIGNATURE.length)
		reject("not-png", "PNG signature is missing.");
	for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
		if (bytes[index] !== PNG_SIGNATURE[index])
			reject("not-png", "PNG signature is missing.");
	}

	let offset: number = PNG_SIGNATURE.length;
	let chunkCount = 0;
	let width = 0;
	let height = 0;
	let bitDepth: number = 8;
	let colorType: number = 6;
	let interlaced = false;
	let sawIhdr = false;
	let sawPlte = false;
	let sawIdat = false;
	let endedIdat = false;
	let sawIend = false;
	let sawTrns = false;
	let paletteEntries = 0;
	let segment: PngChunkSegment = "before-plte";
	const preserved: PngSourceChunk[] = [];
	const stripped: string[] = [];

	while (offset < inputLength) {
		if (inputLength - offset < 8)
			reject("truncated", "PNG chunk header is truncated.");
		chunkCount += 1;
		if (chunkCount > PNG_SOURCE_LIMITS.maxChunks) {
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				"PNG chunk count exceeds the limit.",
				{ limit: PNG_SOURCE_LIMITS.maxChunks, actual: chunkCount },
			);
		}

		const length = readUInt32BE(bytes, offset);
		const type = readAscii(bytes, offset + 4);
		if (
			!isAsciiLetter(bytes[offset + 4] as number) ||
			!isAsciiLetter(bytes[offset + 5] as number) ||
			!isAsciiLetter(bytes[offset + 6] as number) ||
			!isAsciiLetter(bytes[offset + 7] as number) ||
			(bytes[offset + 6] as number) >= 97
		) {
			reject("invalid-chunk", "PNG chunk type is invalid.", { chunk: type });
		}
		if (length > inputLength - offset - 12)
			reject("truncated", "PNG chunk data is truncated.", { chunk: type });
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		const chunkEnd = dataEnd + 4;
		const expectedCrc = readUInt32BE(bytes, dataEnd);
		if (crc32(bytes, offset + 4, dataEnd) !== expectedCrc)
			reject("bad-crc", "PNG chunk CRC does not match.", { chunk: type });

		if (!sawIhdr && type !== "IHDR") {
			// Apple's CgBI variant puts its own critical chunk ahead of IHDR.
			if (isUnknownCritical(type)) chunkError(type, ancillary);
			reject("chunk-order", "IHDR must be the first PNG chunk.", {
				chunk: type,
			});
		}
		if (sawIend) reject("trailing-data", "Data follows the IEND chunk.");
		if (sawIhdr && type === "IHDR")
			reject("chunk-order", "PNG may contain only one IHDR chunk.", {
				chunk: type,
			});

		if (type === "IHDR") {
			if (chunkCount !== 1 || length !== 13)
				reject("invalid-ihdr", "PNG must start with one 13-byte IHDR.");
			sawIhdr = true;
			width = readUInt32BE(bytes, dataStart);
			height = readUInt32BE(bytes, dataStart + 4);
			validateDimension(width);
			validateDimension(height);
			checkResourceLimits(width, height, 1, 0);
			bitDepth = bytes[dataStart + 8] as number;
			colorType = bytes[dataStart + 9] as number;
			if (
				!COLOR_TYPES.has(colorType) ||
				!validBitDepth(colorType, bitDepth) ||
				bytes[dataStart + 10] !== 0 ||
				bytes[dataStart + 11] !== 0 ||
				(bytes[dataStart + 12] !== 0 && bytes[dataStart + 12] !== 1)
			)
				reject("invalid-ihdr", "PNG IHDR fields are not supported.");
			if (bitDepth === 16)
				reject("bit-depth-16", "16-bit PNG input is not supported.");
			interlaced = bytes[dataStart + 12] === 1;
		} else if (type === "PLTE") {
			if (
				sawPlte ||
				sawIdat ||
				length === 0 ||
				length % 3 !== 0 ||
				length > 768
			)
				reject("chunk-order", "PLTE is duplicated, misplaced, or malformed.", {
					chunk: type,
				});
			if (colorType === 0 || colorType === 4)
				reject("invalid-chunk", "PLTE is not allowed for this color type.", {
					chunk: type,
				});
			sawPlte = true;
			paletteEntries = length / 3;
			segment = "after-plte";
			if (colorType !== 3) {
				if (ancillary === "preserve")
					reject(
						"ancillary-needs-strip",
						"Suggested PLTE requires the strip policy.",
						{
							chunk: type,
						},
					);
				stripped.push(type);
			}
		} else if (type === "IDAT") {
			if (endedIdat)
				reject("chunk-order", "IDAT chunks must be contiguous.", {
					chunk: type,
				});
			if (colorType === 3 && !sawPlte)
				reject("chunk-order", "Indexed PNG requires PLTE before IDAT.", {
					chunk: type,
				});
			sawIdat = true;
		} else if (type === "IEND") {
			if (!sawIdat || length !== 0)
				reject("chunk-order", "IEND must follow image data and be empty.", {
					chunk: type,
				});
			sawIend = true;
		} else if (type === "tRNS") {
			if (sawTrns || sawIdat)
				reject("chunk-order", "tRNS is duplicated or follows IDAT.", {
					chunk: type,
				});
			sawTrns = true;
			if (colorType === 0 || colorType === 2)
				reject(
					"color-key-transparency",
					"Color-key transparency cannot be preserved.",
					{
						chunk: type,
					},
				);
			if (colorType === 3 && (!sawPlte || length > paletteEntries))
				reject("invalid-chunk", "Palette transparency does not match PLTE.", {
					chunk: type,
				});
			if (colorType !== 3)
				reject("invalid-chunk", "tRNS is not valid for this color type.", {
					chunk: type,
				});
		} else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
			chunkError(type, ancillary);
		} else {
			if (sawIdat) {
				endedIdat = true;
				segment = "after-idat";
			} else if (sawPlte) {
				segment = "after-plte";
			}

			if (NEEDS_STRIP_ANCILLARY.has(type)) {
				if (ancillary === "preserve")
					reject(
						"ancillary-needs-strip",
						"PNG chunk is tied to its source color layout.",
						{
							chunk: type,
						},
					);
				stripped.push(type);
			} else if (SAFE_KNOWN_ANCILLARY.has(type)) {
				if (ancillary === "strip") stripped.push(type);
				else
					preserved.push({
						type,
						data: bytes.subarray(dataStart, dataEnd),
						segment,
					});
			} else if (isAncillary(type)) {
				if (type.charCodeAt(3) >= 97) {
					if (ancillary === "strip") stripped.push(type);
					else
						preserved.push({
							type,
							data: bytes.subarray(dataStart, dataEnd),
							segment,
						});
				} else {
					chunkError(type, ancillary);
					stripped.push(type);
				}
			} else {
				chunkError(type, ancillary);
			}
		}

		offset = chunkEnd;
		if (sawIend) {
			if (offset !== inputLength)
				reject("trailing-data", "Data follows the IEND chunk.");
			break;
		}
	}

	if (!sawIend) reject("truncated", "PNG is missing its IEND chunk.");
	if (!sawIdat || (colorType === 3 && !sawPlte))
		reject("chunk-order", "PNG is missing required image chunks.");

	return {
		info: {
			width,
			height,
			bitDepth: bitDepth as 1 | 2 | 4 | 8,
			colorType: colorType as 0 | 2 | 3 | 4 | 6,
			interlaced,
			chunkCount,
		},
		preserved,
		stripped,
	};
}
