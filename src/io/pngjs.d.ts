/** Minimal ambient types for the pngjs pure-JS codec (no bundled types). */
declare module "pngjs" {
	interface PngIoOptions {
		width?: number;
		height?: number;
		bitDepth?: 8 | 16;
		colorType?: number;
		inputColorType?: number;
		inputHasAlpha?: boolean;
		filterType?: number;
		deflateLevel?: number;
		deflateStrategy?: number;
		skipRescale?: boolean;
		checkCRC?: boolean;
	}

	interface PngImage {
		width: number;
		height: number;
		data: Uint8Array;
		gamma: number;
		depth?: number;
		colorType?: number;
		interlace?: boolean;
	}

	class PNG {
		width: number;
		height: number;
		data: Uint8Array;
		gamma: number;
		constructor(options?: PngIoOptions);
		static sync: {
			read(buffer: Uint8Array, options?: PngIoOptions): PngImage;
			write(
				image: { width: number; height: number; data: Uint8Array },
				options?: PngIoOptions,
			): Uint8Array;
		};
	}
}
