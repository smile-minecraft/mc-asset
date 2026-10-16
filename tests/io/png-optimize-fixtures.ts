import { deflateSync } from "node:zlib";

export interface Raster {
	width: number;
	height: number;
	pixels: Uint8Array;
}
export interface Chunk {
	type: string;
	data: Uint8Array;
}
export function raster(
	width: number,
	height: number,
	pixel: (x: number, y: number) => readonly number[],
): Raster {
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1)
			pixels.set(pixel(x, y), (y * width + x) * 4);
	}
	return { width, height, pixels };
}
export function noise(width: number, height: number, seed = 41): Raster {
	let state = seed >>> 0;
	return raster(width, height, () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return [
			state & 255,
			(state >>> 8) & 255,
			(state >>> 16) & 255,
			state >>> 24,
		];
	});
}
export function u32(value: number): Uint8Array {
	return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}
export function concat(...parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
// Deliberately independent of the production chunk writer and CRC table.
export function png(chunks: readonly Chunk[]): Uint8Array {
	return concat(
		Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
		...chunks.map(({ type, data }) => {
			const body = concat(
				Uint8Array.from(type, (c) => c.charCodeAt(0)),
				data,
			);
			let crc = 0xffffffff;
			for (const byte of body) {
				crc ^= byte;
				for (let bit = 0; bit < 8; bit += 1)
					crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
			}
			return concat(u32(data.length), body, u32((crc ^ 0xffffffff) >>> 0));
		}),
	);
}
export function chunks(bytes: Uint8Array): Chunk[] {
	const out: Chunk[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let offset = 8; offset < bytes.length; ) {
		const size = view.getUint32(offset);
		out.push({
			type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
			data: bytes.slice(offset + 8, offset + 8 + size),
		});
		offset += size + 12;
	}
	return out;
}
export interface SourceOptions {
	colorType?: number;
	depth?: number;
	interlaced?: boolean;
	key?: Uint8Array;
	level?: number;
}
const ADAM7 = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
] as const;
export function source(input: Raster, options: SourceOptions = {}): Uint8Array {
	const { width, height, pixels } = input;
	const { colorType = 6, depth = 8, interlaced = false, level = 0 } = options;
	const ihdr = concat(
		u32(width),
		u32(height),
		Uint8Array.of(depth, colorType, 0, 0, interlaced ? 1 : 0),
	);
	const palette: number[][] = [];
	if (colorType === 3) {
		for (let p = 0; p < pixels.length; p += 4) {
			const rgba = Array.from(pixels.subarray(p, p + 4));
			if (!palette.some((entry) => entry.every((v, c) => v === rgba[c])))
				palette.push(rgba);
		}
	}
	const rows: Uint8Array[] = [];
	for (const [sx, sy, dx, dy] of interlaced ? ADAM7 : [[0, 0, 1, 1]]) {
		if (sx >= width || sy >= height) continue;
		for (let y = sy; y < height; y += dy) {
			const samples: number[] = [];
			for (let x = sx; x < width; x += dx) {
				const p = (y * width + x) * 4;
				const rgba = Array.from(pixels.subarray(p, p + 4));
				const channels =
					colorType === 6
						? rgba
						: colorType === 2
							? rgba.slice(0, 3)
							: colorType === 4
								? [rgba[0], rgba[3]]
								: colorType === 0
									? [rgba[0]]
									: [
											palette.findIndex((entry) =>
												entry.every((v, c) => v === rgba[c]),
											),
										];
				for (const value of channels) {
					if (depth === 16) samples.push(value, value);
					else
						samples.push(
							colorType === 0 && depth < 8
								? value / (255 / ((1 << depth) - 1))
								: value,
						);
				}
			}
			if (depth < 8) {
				const packed = new Uint8Array(Math.ceil((samples.length * depth) / 8));
				for (let i = 0; i < samples.length; i += 1)
					packed[(i * depth) >>> 3] |=
						samples[i] << (8 - depth - ((i * depth) % 8));
				rows.push(concat(Uint8Array.of(0), packed));
			} else rows.push(Uint8Array.of(0, ...samples));
		}
	}
	const extra: Chunk[] = [];
	if (colorType === 3) {
		extra.push({
			type: "PLTE",
			data: Uint8Array.from(palette.flatMap((p) => p.slice(0, 3))),
		});
		extra.push({
			type: "tRNS",
			data: Uint8Array.from(palette.map((p) => p[3])),
		});
	}
	if (options.key) extra.push({ type: "tRNS", data: options.key });
	return png([
		{ type: "IHDR", data: ihdr },
		...extra,
		{
			type: "IDAT",
			data: new Uint8Array(deflateSync(concat(...rows), { level })),
		},
		{ type: "IEND", data: new Uint8Array() },
	]);
}
export const OPTIMIZE_INPUTS = {
	flat: () => raster(32, 32, () => [70, 80, 90, 255]),
	gradient: () =>
		raster(128, 128, (x, y) => {
			const g = (x * 2 + y) & 255;
			return [g, g, g, 255];
		}),
	hidden: () => {
		const n = noise(32, 32, 5);
		for (let i = 3; i < n.pixels.length; i += 4) n.pixels[i] = 0;
		return n;
	},
	alpha: () => raster(64, 4, (x, y) => [90, 140, 200, y * 64 + x]),
	opaque: () => raster(32, 32, (x, y) => [x * 7, y * 7, (x + y) * 3, 255]),
	upscaled: () =>
		raster(128, 128, (x, y) => [
			((x >>> 3) % 3) * 80,
			((y >>> 3) % 3) * 80,
			20,
			((x + y) >>> 4) % 2 ? 128 : 255,
		]),
};

function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}
function paletteNoise(
	width: number,
	height: number,
	seed: number,
	colors: number,
	alpha: boolean,
): Raster {
	const next = seeded(seed);
	const palette = Array.from({ length: colors }, (_, i) => {
		const v = next();
		return [
			v & 255,
			(v >>> 8) & 255,
			(v >>> 16) & 255,
			alpha && i % 3 === 0 ? 128 + (i % 100) : 255,
		];
	});
	return raster(width, height, () => palette[next() % colors]);
}
function smooth(
	width: number,
	height: number,
	seed: number,
	lattice: number,
	grain: number,
	opaque: boolean,
): Raster {
	const next = seeded(seed);
	const gw = lattice + 1;
	const grid = Array.from({ length: 4 }, () =>
		Int32Array.from({ length: gw * gw }, () => next() & 255),
	);
	return raster(width, height, (x, y) => {
		const fx = Math.trunc((x * lattice * 256) / width);
		const fy = Math.trunc((y * lattice * 256) / height);
		const x0 = fx >>> 8;
		const y0 = fy >>> 8;
		const tx = fx & 255;
		const ty = fy & 255;
		const out = [0, 0, 0, 255];
		for (let c = 0; c < (opaque ? 3 : 4); c += 1) {
			const g = grid[c];
			const a = g[y0 * gw + x0];
			const b = g[y0 * gw + x0 + 1];
			const cc = g[(y0 + 1) * gw + x0];
			const d = g[(y0 + 1) * gw + x0 + 1];
			const top = a * (256 - tx) + b * tx;
			const bottom = cc * (256 - tx) + d * tx;
			const v =
				((top * (256 - ty) + bottom * ty) >> 16) +
				(next() % (2 * grain + 1)) -
				grain;
			out[c] = v < 0 ? 0 : v > 255 ? 255 : v;
		}
		return out;
	});
}
export const OPTIMIZE_CORPUS: Record<string, () => Raster> = {
	"transparent-1x1": () => raster(1, 1, () => [0, 0, 0, 0]),
	"opaque-1x1": () => raster(1, 1, () => [12, 34, 56, 255]),
	"vertical-1x4096": () =>
		raster(1, 4096, (_x, y) => [y & 255, (y >>> 4) & 255, 7, 255]),
	"horizontal-4096x1": () =>
		raster(4096, 1, (x) => [x & 255, (x >>> 4) & 255, 7, 255]),
	"twelve-colors": () => paletteNoise(16, 16, 11, 12, false),
	"twelve-colors-alpha": () => paletteNoise(16, 16, 12, 12, true),
	"exactly-256-colors": () =>
		raster(64, 64, (x, y) => {
			const k = (y * 64 + x) & 255;
			return [k, (k * 7) & 255, (k * 13) & 255, 255];
		}),
	"exactly-257-colors": () =>
		raster(257, 4, (x) => [x & 255, (x >>> 8) * 255, (x * 3) & 255, 255]),
	"hidden-distinct": () => {
		const n = seeded(5);
		return raster(32, 32, (x, y) => {
			const v = n();
			return (y * 32 + x) % 4 === 0
				? [200, 100, 50, 255]
				: [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, 0];
		});
	},
	"hidden-uniform": () =>
		raster(32, 32, (x, y) =>
			(y * 32 + x) % 4 === 0 ? [200, 100, 50, 255] : [9, 8, 7, 0],
		),
	"alpha-gradient": () =>
		raster(64, 64, (x, y) => [90, 140, 200, ((y * 64 + x) >>> 4) & 255]),
	"gray-gradient": OPTIMIZE_INPUTS.gradient,
	"gray-two-bit": () => {
		const n = seeded(21);
		return raster(64, 64, () => {
			const g = (n() & 3) * 85;
			return [g, g, g, 255];
		});
	},
	"gray-alpha-noise": () => {
		const n = seeded(22);
		return raster(64, 64, () => {
			const v = n();
			return [v & 255, v & 255, v & 255, (v >>> 8) & 255];
		});
	},
	"smooth-opaque": () => smooth(256, 256, 31, 8, 3, true),
	"smooth-alpha": () => smooth(256, 256, 32, 8, 3, false),
	entropy: () => noise(256, 256, 41),
	"entropy-opaque": () => {
		const r = noise(512, 512, 42);
		for (let i = 3; i < r.pixels.length; i += 4) r.pixels[i] = 255;
		return r;
	},
	"large-flat": () => raster(512, 512, () => [70, 80, 90, 255]),
	"large-transparent": () => raster(512, 512, () => [0, 0, 0, 0]),
	"large-smooth": () => smooth(512, 512, 33, 16, 2, true),
	"large-entropy": () => noise(512, 512, 43),
	"large-upscaled": () => {
		const s = paletteNoise(64, 64, 51, 14, true);
		return raster(512, 512, (x, y) =>
			Array.from(
				s.pixels.subarray(
					((y >>> 3) * 64 + (x >>> 3)) * 4,
					((y >>> 3) * 64 + (x >>> 3)) * 4 + 4,
				),
			),
		);
	},
};

function adam7Pass(x: number, y: number): number {
	for (let pass = ADAM7.length - 1; pass > 0; pass -= 1) {
		const [startX, startY, stepX, stepY] = ADAM7[pass] ?? [0, 0, 1, 1];
		if (
			x >= startX &&
			y >= startY &&
			(x - startX) % stepX === 0 &&
			(y - startY) % stepY === 0
		)
			return pass;
	}
	return 0;
}
/**
 * One flat translucent color per Adam7 pass. Each interlaced pass row is constant while the
 * raster-order rows alternate colors, so a deflate stream over the interlaced rows can come
 * out no larger than any non-interlaced re-encoding of the same pixels.
 */
export function adam7Bands(width: number, height: number): Raster {
	return raster(width, height, (x, y) => {
		const pass = adam7Pass(x, y);
		return [30 * pass + 7, 200 - 20 * pass, 60 + 9 * pass, 100 + 10 * pass];
	});
}
/** An RGBA 8-bit source whose IDAT payload is `idat`, split at the given offsets (may repeat). */
export function sourceWithIdat(
	input: Raster,
	idat: Uint8Array,
	splits: readonly number[] = [],
): Uint8Array {
	const bounds = [0, ...splits, idat.length];
	const parts: Chunk[] = [];
	for (let index = 0; index + 1 < bounds.length; index += 1)
		parts.push({
			type: "IDAT",
			data: idat.slice(bounds[index], bounds[index + 1]),
		});
	return png([
		{
			type: "IHDR",
			data: concat(
				u32(input.width),
				u32(input.height),
				Uint8Array.of(8, 6, 0, 0, 0),
			),
		},
		...parts,
		{ type: "IEND", data: new Uint8Array() },
	]);
}
/** Unfiltered RGBA scanlines (filter byte 0 per row) for `input`. */
export function rgbaScanlines(input: Raster): Uint8Array {
	const rowBytes = input.width * 4;
	const out = new Uint8Array(input.height * (rowBytes + 1));
	for (let y = 0; y < input.height; y += 1)
		out.set(
			input.pixels.subarray(y * rowBytes, (y + 1) * rowBytes),
			y * (rowBytes + 1) + 1,
		);
	return out;
}
