/** Ambient types for the jpeg-js pure-JS codec (no bundled types). */
declare module "jpeg-js" {
	interface JpegDecoded {
		width: number;
		height: number;
		data: Uint8Array;
	}

	interface JpegDecodeOptions {
		useTArray?: boolean;
		maxMemoryUsageInMB?: number;
		maxResolutionInMP?: number;
	}

	interface JpegEncoded {
		width: number;
		height: number;
		data: Uint8Array;
	}

	interface JpegEncodeOptions {
		format?: "asBuffer" | unknown;
		quality?: number;
	}

	export function decode(
		data: Uint8Array,
		options?: JpegDecodeOptions,
	): JpegDecoded;
	export function encode(
		image: { width: number; height: number; data: Uint8Array },
		quality?: number,
	): JpegEncoded;
}
