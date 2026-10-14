import { validateDimension } from "../core/validate.ts";
import { type DeflateStrategy, deflateZlib } from "./deflate.ts";

export interface PngChunk {
	readonly type: string;
	readonly data: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.of(
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a,
);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let value = 0; value < table.length; value += 1) {
		let crc = value;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		}
		table[value] = crc >>> 0;
	}
	return table;
})();

function writeUInt32BE(
	output: Uint8Array,
	offset: number,
	value: number,
): void {
	output[offset] = (value >>> 24) & 0xff;
	output[offset + 1] = (value >>> 16) & 0xff;
	output[offset + 2] = (value >>> 8) & 0xff;
	output[offset + 3] = value & 0xff;
}

export function crc32(bytes: Uint8Array, start: number, end: number): number {
	let crc = 0xffffffff;
	for (let index = start; index < end; index += 1) {
		crc =
			(CRC_TABLE[(crc ^ (bytes[index] as number)) & 0xff] as number) ^
			(crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export function assemblePng(chunks: readonly PngChunk[]): Uint8Array {
	let totalLength = PNG_SIGNATURE.length;
	for (const chunk of chunks) {
		totalLength += 12 + chunk.data.length;
	}
	const output = new Uint8Array(totalLength);
	output.set(PNG_SIGNATURE);
	let offset = PNG_SIGNATURE.length;
	for (const chunk of chunks) {
		writeUInt32BE(output, offset, chunk.data.length);
		for (let index = 0; index < 4; index += 1) {
			output[offset + 4 + index] = chunk.type.charCodeAt(index);
		}
		output.set(chunk.data, offset + 8);
		const crcEnd = offset + 8 + chunk.data.length;
		writeUInt32BE(output, crcEnd, crc32(output, offset + 4, crcEnd));
		offset += 12 + chunk.data.length;
	}
	return output;
}

export function encodeIhdr(
	width: number,
	height: number,
	bitDepth: 1 | 2 | 4 | 8,
	colorType: 0 | 2 | 3 | 4 | 6,
): Uint8Array {
	validateDimension(width);
	validateDimension(height);
	const data = new Uint8Array(13);
	writeUInt32BE(data, 0, width);
	writeUInt32BE(data, 4, height);
	data[8] = bitDepth;
	data[9] = colorType;
	return data;
}

export type PngFilterStrategy = "none" | "adaptive";

function absoluteSignedByte(value: number): number {
	const signed = value < 128 ? value : value - 256;
	return signed < 0 ? -signed : signed;
}

function absoluteInteger(value: number): number {
	return value < 0 ? -value : value;
}

function paethPredictor(
	left: number,
	above: number,
	upperLeft: number,
): number {
	const estimate = left + above - upperLeft;
	const leftDistance = absoluteInteger(estimate - left);
	const aboveDistance = absoluteInteger(estimate - above);
	const upperLeftDistance = absoluteInteger(estimate - upperLeft);
	if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
		return left;
	}
	if (aboveDistance <= upperLeftDistance) {
		return above;
	}
	return upperLeft;
}

export function applyRowFilters(
	raw: Uint8Array,
	rowBytes: number,
	height: number,
	bytesPerPixel: number,
	strategy: PngFilterStrategy,
): Uint8Array {
	const stride = rowBytes + 1;
	const output = new Uint8Array(stride * height);
	if (strategy === "none") {
		for (let row = 0; row < height; row += 1) {
			const rawStart = row * rowBytes;
			const outputStart = row * stride;
			output[outputStart] = 0;
			output.set(raw.subarray(rawStart, rawStart + rowBytes), outputStart + 1);
		}
		return output;
	}

	const candidates = Array.from({ length: 5 }, () => new Uint8Array(rowBytes));
	for (let row = 0; row < height; row += 1) {
		const rowStart = row * rowBytes;
		const aboveStart = rowStart - rowBytes;
		const scores = [0, 0, 0, 0, 0];
		for (let column = 0; column < rowBytes; column += 1) {
			const value = raw[rowStart + column] as number;
			const left =
				column >= bytesPerPixel
					? (raw[rowStart + column - bytesPerPixel] as number)
					: 0;
			const above = row > 0 ? (raw[aboveStart + column] as number) : 0;
			const upperLeft =
				row > 0 && column >= bytesPerPixel
					? (raw[aboveStart + column - bytesPerPixel] as number)
					: 0;
			const residuals = [
				value,
				(value - left) & 0xff,
				(value - above) & 0xff,
				(value - Math.floor((left + above) / 2)) & 0xff,
				(value - paethPredictor(left, above, upperLeft)) & 0xff,
			];
			for (let filter = 0; filter < residuals.length; filter += 1) {
				const residual = residuals[filter] as number;
				(candidates[filter] as Uint8Array)[column] = residual;
				(scores[filter] as number) += absoluteSignedByte(residual);
			}
		}

		let bestFilter = 0;
		for (let filter = 1; filter < scores.length; filter += 1) {
			if ((scores[filter] as number) < (scores[bestFilter] as number)) {
				bestFilter = filter;
			}
		}
		const outputStart = row * stride;
		output[outputStart] = bestFilter;
		output.set(candidates[bestFilter] as Uint8Array, outputStart + 1);
	}
	return output;
}

export type PngEffort = "standard" | "maximum";

export interface PngTrial {
	readonly filter: PngFilterStrategy;
	readonly strategy: DeflateStrategy;
}

export function trialsFor(
	rawBytes: number,
	bitDepth: 1 | 2 | 4 | 8,
	colorType: 0 | 2 | 3 | 4 | 6,
	effort: PngEffort,
): readonly PngTrial[] {
	const lowBitDepth = bitDepth < 8;
	if (
		rawBytes > 1_048_576 &&
		(effort === "standard" || rawBytes > 16_777_216)
	) {
		return [
			{
				filter: lowBitDepth || colorType === 3 ? "none" : "adaptive",
				strategy: lowBitDepth || colorType === 3 ? "default" : "filtered",
			},
		];
	}
	const filters: readonly PngFilterStrategy[] = lowBitDepth
		? ["none"]
		: ["none", "adaptive"];
	const strategies: readonly DeflateStrategy[] =
		effort === "maximum" && rawBytes <= 1_048_576
			? ["default", "filtered", "rle"]
			: ["default", "filtered"];
	return filters.flatMap((filter) =>
		strategies.map((strategy) => ({ filter, strategy })),
	);
}

export interface CompressedScanlines {
	readonly idat: Uint8Array;
	readonly trial: PngTrial;
}

export function compressScanlines(
	raw: Uint8Array,
	rowBytes: number,
	height: number,
	bytesPerPixel: number,
	bitDepth: 1 | 2 | 4 | 8,
	colorType: 0 | 2 | 3 | 4 | 6,
	effort: PngEffort,
): CompressedScanlines {
	const trials = trialsFor(
		height * (rowBytes + 1),
		bitDepth,
		colorType,
		effort,
	);
	let best: CompressedScanlines | undefined;
	for (const trial of trials) {
		const filtered = applyRowFilters(
			raw,
			rowBytes,
			height,
			bytesPerPixel,
			trial.filter,
		);
		const idat = deflateZlib(filtered, trial.strategy);
		if (best === undefined || idat.length < best.idat.length) {
			best = { idat, trial };
		}
	}
	if (best === undefined) {
		throw new Error("PNG compression requires at least one trial.");
	}
	return best;
}
