export type PngColorMode =
	| "rgba"
	| "rgb"
	| "grayscale"
	| "grayscale-alpha"
	| "indexed";

/** Fixed candidate evaluation order and tie order for auto mode. */
export const PNG_COLOR_MODE_ORDER: readonly PngColorMode[] = [
	"rgba",
	"rgb",
	"grayscale-alpha",
	"grayscale",
	"indexed",
];

export interface PaletteEntry {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
}

export interface PixelAnalysis {
	readonly width: number;
	readonly height: number;
	/** Every alpha is 255. */
	readonly opaque: boolean;
	/** Every pixel has r === g && g === b (alpha and hidden RGB included). */
	readonly gray: boolean;
	/** Exact distinct RGBA count up to 256; 257 means "more than 256". */
	readonly distinctColors: number;
	/**
	 * Present only when distinctColors <= 256. Order: entries with alpha < 255 first, then opaque
	 * entries; inside each group, first appearance in row-major scan order. Distinct hidden RGB
	 * under alpha 0 stay distinct entries.
	 */
	readonly palette: readonly PaletteEntry[] | undefined;
	/** Smallest depth in {1,2,4,8} that stores every gray value exactly (values are multiples of 255/(2^d-1)). */
	readonly grayBitDepth: 1 | 2 | 4 | 8;
}

/** One pass; stops growing the palette after the 257th distinct color but still finishes opaque/gray flags. */
export function analyzePixels(
	pixels: Uint8Array,
	width: number,
	height: number,
): PixelAnalysis {
	let opaque = true;
	let gray = true;
	let gray1 = true;
	let gray2 = true;
	let gray4 = true;
	let distinctColors = 0;
	const colors = new Map<number, PaletteEntry>();
	const translucent: PaletteEntry[] = [];
	const opaqueEntries: PaletteEntry[] = [];

	for (let offset = 0; offset < pixels.length; offset += 4) {
		const r = pixels[offset] as number;
		const g = pixels[offset + 1] as number;
		const b = pixels[offset + 2] as number;
		const a = pixels[offset + 3] as number;
		if (a !== 255) opaque = false;
		if (r !== g || g !== b) {
			gray = false;
		} else {
			if (r !== 0 && r !== 255) gray1 = false;
			if (r % 85 !== 0) gray2 = false;
			if (r % 17 !== 0) gray4 = false;
		}

		if (distinctColors === 257) continue;
		const key = ((r * 256 + g) * 256 + b) * 256 + a;
		if (colors.has(key)) continue;
		if (distinctColors === 256) {
			distinctColors = 257;
			colors.clear();
			translucent.length = 0;
			opaqueEntries.length = 0;
			continue;
		}
		const entry = { r, g, b, a };
		colors.set(key, entry);
		if (a < 255) translucent.push(entry);
		else opaqueEntries.push(entry);
		distinctColors += 1;
	}

	const palette =
		distinctColors > 256 ? undefined : [...translucent, ...opaqueEntries];
	const grayBitDepth: 1 | 2 | 4 | 8 = gray1 ? 1 : gray2 ? 2 : gray4 ? 4 : 8;

	return {
		width,
		height,
		opaque,
		gray,
		distinctColors,
		palette,
		grayBitDepth,
	};
}

export type ModeUnavailableReason =
	| "not-opaque"
	| "not-gray"
	| "more-than-256-colors";

export interface ModeEncoding {
	readonly mode: PngColorMode;
	readonly bitDepth: 1 | 2 | 4 | 8;
	readonly colorType: 0 | 2 | 3 | 4 | 6;
	/** 0 unless mode is "indexed". */
	readonly paletteSize: number;
	readonly rowBytes: number;
	readonly bytesPerPixel: number;
	/** Unfiltered packed scanline samples, rowBytes * height bytes. */
	readonly raw: Uint8Array;
	/** PLTE payload (indexed only). */
	readonly plte: Uint8Array | undefined;
	/** tRNS payload, trimmed after the last non-opaque entry (indexed only; undefined when all opaque). */
	readonly trns: Uint8Array | undefined;
}

export type ModeEncodingResult =
	| { readonly ok: true; readonly encoding: ModeEncoding }
	| { readonly ok: false; readonly reason: ModeUnavailableReason };

function rowByteLength(width: number, bitsPerPixel: number): number {
	return Math.floor((width * bitsPerPixel + 7) / 8);
}

function packSample(
	raw: Uint8Array,
	rowOffset: number,
	column: number,
	bitDepth: 1 | 2 | 4 | 8,
	sample: number,
): void {
	if (bitDepth === 8) {
		raw[rowOffset + column] = sample;
		return;
	}
	const bitOffset = column * bitDepth;
	const byteOffset = rowOffset + Math.floor(bitOffset / 8);
	const shift = 8 - bitDepth - (bitOffset % 8);
	raw[byteOffset] = (raw[byteOffset] as number) | (sample << shift);
}

function pixelKey(pixels: Uint8Array, offset: number): number {
	return (
		(((pixels[offset] as number) * 256 + (pixels[offset + 1] as number)) * 256 +
			(pixels[offset + 2] as number)) *
			256 +
		(pixels[offset + 3] as number)
	);
}

function available(encoding: ModeEncoding): ModeEncodingResult {
	return { ok: true, encoding };
}

function unavailable(reason: ModeUnavailableReason): ModeEncodingResult {
	return { ok: false, reason };
}

/**
 * Applicability: rgba always; rgb needs opaque; grayscale needs gray && opaque (depth =
 * analysis.grayBitDepth); grayscale-alpha needs gray; indexed needs distinctColors <= 256 with
 * bit depth 1 (<=2 entries), 2 (<=4), 4 (<=16), otherwise 8.
 */
export function buildModeEncoding(
	mode: PngColorMode,
	pixels: Uint8Array,
	analysis: PixelAnalysis,
): ModeEncodingResult {
	if (mode === "rgb" && !analysis.opaque) return unavailable("not-opaque");
	if (mode === "grayscale" && !analysis.opaque)
		return unavailable("not-opaque");
	if ((mode === "grayscale" || mode === "grayscale-alpha") && !analysis.gray)
		return unavailable("not-gray");
	if (mode === "indexed" && analysis.distinctColors > 256)
		return unavailable("more-than-256-colors");

	const width = analysis.width;
	const height = analysis.height;
	let bitDepth: 1 | 2 | 4 | 8 = 8;
	let colorType: 0 | 2 | 3 | 4 | 6;
	let channels: number;
	let paletteSize = 0;
	let plte: Uint8Array | undefined;
	let trns: Uint8Array | undefined;

	switch (mode) {
		case "rgba":
			colorType = 6;
			channels = 4;
			break;
		case "rgb":
			colorType = 2;
			channels = 3;
			break;
		case "grayscale-alpha":
			colorType = 4;
			channels = 2;
			break;
		case "grayscale":
			colorType = 0;
			channels = 1;
			bitDepth = analysis.grayBitDepth;
			break;
		case "indexed": {
			const palette = analysis.palette;
			if (palette === undefined) return unavailable("more-than-256-colors");
			colorType = 3;
			channels = 1;
			paletteSize = palette.length;
			bitDepth =
				paletteSize <= 2 ? 1 : paletteSize <= 4 ? 2 : paletteSize <= 16 ? 4 : 8;
			plte = new Uint8Array(paletteSize * 3);
			const indexByColor = new Map<number, number>();
			let transparentCount = 0;
			for (let index = 0; index < palette.length; index += 1) {
				const entry = palette[index] as PaletteEntry;
				plte[index * 3] = entry.r;
				plte[index * 3 + 1] = entry.g;
				plte[index * 3 + 2] = entry.b;
				if (entry.a < 255) transparentCount += 1;
				indexByColor.set(
					((entry.r * 256 + entry.g) * 256 + entry.b) * 256 + entry.a,
					index,
				);
			}
			if (transparentCount > 0) {
				trns = new Uint8Array(transparentCount);
				for (let index = 0; index < transparentCount; index += 1)
					trns[index] = (palette[index] as PaletteEntry).a;
			}
			const rowBytes = rowByteLength(width, bitDepth);
			const raw = new Uint8Array(rowBytes * height);
			for (let y = 0; y < height; y += 1) {
				const rowOffset = y * rowBytes;
				for (let x = 0; x < width; x += 1) {
					const offset = (y * width + x) * 4;
					const index = indexByColor.get(pixelKey(pixels, offset));
					if (index === undefined)
						throw new Error(
							"Pixel palette does not match the analyzed colors.",
						);
					packSample(raw, rowOffset, x, bitDepth, index);
				}
			}
			return available({
				mode,
				bitDepth,
				colorType,
				paletteSize,
				rowBytes,
				bytesPerPixel: 1,
				raw,
				plte,
				trns,
			});
		}
	}

	const bitsPerPixel = channels * bitDepth;
	const rowBytes = rowByteLength(width, bitsPerPixel);
	const raw = new Uint8Array(rowBytes * height);
	if (mode === "rgba") {
		raw.set(pixels);
	} else {
		const grayScale =
			bitDepth === 1 ? 255 : bitDepth === 2 ? 85 : bitDepth === 4 ? 17 : 1;
		for (let y = 0; y < height; y += 1) {
			const rowOffset = y * rowBytes;
			for (let x = 0; x < width; x += 1) {
				const offset = (y * width + x) * 4;
				switch (mode) {
					case "rgb": {
						const outputOffset = rowOffset + x * 3;
						raw[outputOffset] = pixels[offset] as number;
						raw[outputOffset + 1] = pixels[offset + 1] as number;
						raw[outputOffset + 2] = pixels[offset + 2] as number;
						break;
					}
					case "grayscale":
						packSample(
							raw,
							rowOffset,
							x,
							bitDepth,
							(pixels[offset] as number) / grayScale,
						);
						break;
					case "grayscale-alpha": {
						const outputOffset = rowOffset + x * 2;
						raw[outputOffset] = pixels[offset] as number;
						raw[outputOffset + 1] = pixels[offset + 3] as number;
						break;
					}
				}
			}
		}
	}

	return available({
		mode,
		bitDepth,
		colorType,
		paletteSize,
		rowBytes,
		bytesPerPixel: Math.max(1, Math.floor((bitsPerPixel + 7) / 8)),
		raw,
		plte,
		trns,
	});
}
