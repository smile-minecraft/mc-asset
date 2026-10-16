import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import type { PixelCanvas } from "../../src/core/types.ts";
import { checkResourceLimits } from "../../src/core/validate.ts";
import { DEFLATE_ENGINE_ID, deflateZlib } from "../../src/io/deflate.ts";
import { decodePng, encodePng, flattenCanvas } from "../../src/io/png.ts";
import {
	applyRowFilters,
	assemblePng,
	compressScanlines,
	crc32,
	encodeIhdr,
	type PngTrial,
	trialsFor,
} from "../../src/io/png-chunks.ts";
import { type CaseCheck, PNG_VECTORS, type PngCase } from "./png-cases.ts";

interface Input {
	width: number;
	height: number;
	pixels: Uint8Array;
}

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

function image(
	width: number,
	height: number,
	pixel: (x: number, y: number) => ArrayLike<number>,
): Input {
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			pixels.set(pixel(x, y), (y * width + x) * 4);
		}
	}
	return { width, height, pixels };
}

function noise(
	width: number,
	height: number,
	seed: number,
	opaque = false,
): Input {
	const next = rng(seed);
	return image(width, height, () => {
		const v = next();
		return [
			v & 255,
			(v >>> 8) & 255,
			(v >>> 16) & 255,
			opaque ? 255 : (v >>> 24) & 255,
		];
	});
}

// Six fixed recipes; SHA literals come from the independent reference writer.
export const COMPRESSION_INPUTS: Record<string, () => Input> = {
	flat: () => image(32, 32, () => [70, 80, 90, 255]),
	noise: () => noise(256, 256, 41),
	gradient: () =>
		image(128, 128, (x, y) => {
			const v = (x * 2 + y) & 255;
			return [v, v, v, 255];
		}),
	semitransparent: () =>
		image(64, 64, (x, y) => [90, 140, 200, ((y * 64 + x) >>> 4) & 255]),
	hidden: () => {
		const next = rng(5);
		return image(32, 32, (x, y) => {
			const v = next();
			return (y * 32 + x) % 4 === 0
				? [200, 100, 50, 255]
				: [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, 0];
		});
	},
	upscaled: () => {
		const next = rng(51);
		const palette = Array.from({ length: 14 }, (_, i) => {
			const v = next();
			return [
				v & 255,
				(v >>> 8) & 255,
				(v >>> 16) & 255,
				i % 3 === 0 ? 128 + (i % 100) : 255,
			];
		});
		const source = image(64, 64, () => palette[next() % 14] as number[]);
		return image(1024, 1024, (x, y) => {
			const start = ((y >>> 4) * 64 + (x >>> 4)) * 4;
			return source.pixels.subarray(start, start + 4);
		});
	},
};

const ENCODE_SHA256: Record<string, string> = {
	flat: "ec3028c3564753073cddec0beb8c3651dd2e809c29415f9c6b95a2554ab9bac1",
	noise: "a457be7c96af35651de6c50af6ba45037b406bafb73caa2bad974289e14766eb",
	gradient: "66c2ab5af37f0adfc12146b8793083b4ace152f83ed96f84e07fd27e15cdd991",
	semitransparent:
		"268d67e54be6d465ba77a3427f47084857541f0c69ab959afbc3bb653e4d79d5",
	hidden: "2f9dd7471ba6e9179f1d8d315992380e5fcdfee045e350b9193ef9463e68b5df",
	upscaled: "aa8ae62ebb1de0d2f6f9fcdfc4a5dcd9c8839d2a61fcbc80f8cf48b2dc0e6165",
};
const DEFLATE_SHA256 =
	"c6580a1ec5f5ce99a00f14cecc72e39e8bdbc05d2e7c81496f63b4092c5a1b0e";
export const DEFLATE_INPUT = Uint8Array.from(
	{ length: 8192 },
	(_, i) => (i * 7 + (i >>> 5)) & 255,
);

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canvasFor(input: Input): PixelCanvas {
	const canvas = createCanvas(input.width, input.height);
	const layer = addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, layer.id, input.pixels);
	return canvas;
}

function roundTrip(check: CaseCheck, input: Input): Uint8Array {
	const canvas = canvasFor(input);
	const before = input.pixels.slice();
	const encoded = encodePng(canvas);
	const decoded = decodePng(encoded).canvas;
	check.equal(decoded.width, input.width, "round-trip width");
	check.equal(decoded.height, input.height, "round-trip height");
	check.deepEqual(
		decoded.layers[0]?.pixels,
		before,
		"all RGBA bytes, including hidden RGB, survive",
	);
	check.deepEqual(input.pixels, before, "input pixels are read-only");
	return encoded;
}

function chunks(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
	const result: { type: string; data: Uint8Array }[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let offset = 8; offset < bytes.length; ) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
		result.push({
			type,
			data: bytes.subarray(offset + 8, offset + 8 + length),
		});
		offset += length + 12;
	}
	return result;
}

const docsAssets = fileURLToPath(
	new URL("../../docs/assets/", import.meta.url),
);
const showcasePaths = readdirSync(docsAssets, {
	recursive: true,
	encoding: "utf8",
})
	.filter((path) => path.endsWith(".png"))
	.sort();

/** Size of an RGBA8 PNG whose IDAT uses stored (uncompressed) deflate blocks. */
function storedEncodingSize(width: number, height: number): number {
	const raw = height * (1 + width * 4);
	const blocks = Math.max(1, Math.ceil(raw / 65_535));
	const zlibStream = 2 + blocks * 5 + raw + 4;
	return 8 + 25 + (12 + zlibStream) + 12;
}

const noneDefault: PngTrial = { filter: "none", strategy: "default" };
const standardSmall: readonly PngTrial[] = [
	noneDefault,
	{ filter: "none", strategy: "filtered" },
	{ filter: "adaptive", strategy: "default" },
	{ filter: "adaptive", strategy: "filtered" },
];

export const PNG_COMPRESS_CASES: PngCase[] = [
	...Object.entries(COMPRESSION_INPUTS).flatMap(([name, make]) => [
		{
			name: `encode SHA-256: ${name}`,
			run: (check: CaseCheck) =>
				check.equal(
					sha256(encodePng(canvasFor(make()))),
					ENCODE_SHA256[name],
					"pinned compressed PNG SHA-256",
				),
		},
		{
			name: `round-trip: ${name}`,
			run: (check: CaseCheck) => {
				roundTrip(check, make());
			},
		},
	]),
	{
		name: "deflate SHA-256 pins engine parameters",
		run: (check) => {
			check.equal(
				DEFLATE_ENGINE_ID,
				"pako@3.0.2 level=9 memLevel=9 windowBits=15 legacyHash=false",
			);
			check.equal(
				sha256(deflateZlib(DEFLATE_INPUT, "default")),
				DEFLATE_SHA256,
				"pinned zlib SHA-256",
			);
		},
	},
	...(["default", "filtered", "rle"] as const).map((strategy) => ({
		name: `zlib round-trip, repeat and no mutation: ${strategy}`,
		run: (check: CaseCheck) => {
			const before = DEFLATE_INPUT.slice();
			const encoded = deflateZlib(DEFLATE_INPUT, strategy);
			check.ok(
				encoded.length > 6,
				"zlib stream must include framing and deflate payload",
			);
			check.deepEqual(
				new Uint8Array(inflateSync(encoded)),
				before,
				"independent zlib decoder restores input",
			);
			check.deepEqual(
				encoded,
				deflateZlib(DEFLATE_INPUT, strategy),
				"repeated deflate bytes match",
			);
			check.deepEqual(DEFLATE_INPUT, before, "deflate input untouched");
		},
	})),
	...[
		[1, 1, 0],
		[1, 1, 255],
		[1, 4096, 255],
		[4096, 1, 255],
	].map(([width, height, alpha]) => ({
		name: `empty and small: ${width}x${height} alpha ${alpha}`,
		run: (check: CaseCheck) => {
			const input = image(width, height, (x, y) => [
				x & 255,
				y & 255,
				7,
				alpha,
			]);
			const encoded = roundTrip(check, input);
			check.equal(
				new DataView(encoded.buffer, encoded.byteOffset).getUint32(16),
				width,
				"IHDR width",
			);
			check.equal(
				new DataView(encoded.buffer, encoded.byteOffset).getUint32(20),
				height,
				"IHDR height",
			);
		},
	})),
	// 1024 bytes cover fixed zlib framing and chunk headers while still catching output-size regressions.
	...[256, 512].map((size) => ({
		name: `high entropy size bound: ${size}x${size}`,
		run: (check: CaseCheck) => {
			const input = noise(
				size,
				size,
				41 + (size === 512 ? 1 : 0),
				size === 512,
			);
			const encoded = roundTrip(check, input);
			check.ok(
				encoded.length <=
					input.pixels.length + Math.floor(input.pixels.length / 1000) + 1024,
				"PNG stays within RGBA + 0.1% + 1024 bytes",
			);
		},
	})),
	{
		name: "repeated encodes are byte-identical",
		run: (check) => {
			const canvas = canvasFor(COMPRESSION_INPUTS.hidden());
			check.deepEqual(
				encodePng(canvas),
				encodePng(canvas),
				"repeat encode bytes match",
			);
		},
	},
	{
		name: "output has only IHDR, one IDAT, IEND and noninterlaced RGBA8",
		run: (check) => {
			const encoded = encodePng(canvasFor(noise(512, 512, 42)));
			check.deepEqual(
				chunks(encoded).map((chunk) => chunk.type),
				["IHDR", "IDAT", "IEND"],
				"exact output chunk list",
			);
			check.deepEqual(
				Array.from(encoded.subarray(24, 29)),
				[8, 6, 0, 0, 0],
				"RGBA8, compression 0, filter 0, no interlace",
			);
		},
	},
	...showcasePaths.map((path) => ({
		name: `showcase re-encodes with identical pixels and never exceeds stored size: ${path}`,
		run: (check: CaseCheck) => {
			const source = new Uint8Array(readFileSync(`${docsAssets}${path}`));
			const canvas = decodePng(source).canvas;
			const encoded = encodePng(canvas);
			check.deepEqual(
				decodePng(encoded).canvas.layers[0]?.pixels,
				canvas.layers[0]?.pixels,
				"showcase pixels unchanged",
			);
			check.ok(
				encoded.length <= storedEncodingSize(canvas.width, canvas.height),
				"each showcase PNG stays within the uncompressed encoding size",
			);
		},
	})),
	{
		// The showcase files are already optimized (palette or grayscale
		// storage), while encodePng always writes RGBA8, so a re-encode is
		// expected to be larger than the file itself. The bound is the
		// stored (uncompressed) encoding size instead: it catches a
		// regression that inflates output without pinning the corpus size.
		name: "showcase re-encodes stay within 20 percent of the stored corpus size",
		run: (check) => {
			check.ok(showcasePaths.length > 0, "showcase corpus is not empty");
			let encodedBytes = 0;
			let storedBytes = 0;
			for (const path of showcasePaths) {
				const source = new Uint8Array(readFileSync(`${docsAssets}${path}`));
				const canvas = decodePng(source).canvas;
				encodedBytes += encodePng(canvas).length;
				storedBytes += storedEncodingSize(canvas.width, canvas.height);
			}
			check.ok(
				encodedBytes * 5 <= storedBytes,
				`showcase total ${encodedBytes} must be <= 20% of stored ${storedBytes}`,
			);
		},
	},
	{
		name: "resource gates keep dimension and memory error codes",
		run: (check) => {
			const canvas = canvasFor(image(1, 1, () => [0, 0, 0, 0]));
			check.throwsCode(
				() => encodePng({ ...canvas, width: 4097 }),
				"INVALID_DIMENSION",
			);
			check.throwsCode(
				() => encodePng({ ...canvas, height: 4097 }),
				"INVALID_DIMENSION",
			);
			check.throwsCode(
				() => checkResourceLimits(4096, 4096, 9, 0),
				"RESOURCE_LIMIT_EXCEEDED",
				"memory estimate exceeds 512 MiB before allocation",
			);
			checkResourceLimits(4096, 4096, 8, 0);
		},
	},
	{
		name: "CRC and PNG assembly match independent literal vector",
		run: (check) => {
			check.equal(
				crc32(Buffer.from("123456789"), 0, 9),
				0xcbf43926,
				"standard CRC32 check vector",
			);
			check.equal(
				crc32(Buffer.from("x123456789y"), 1, 10),
				0xcbf43926,
				"CRC obeys start/end offsets",
			);
			check.deepEqual(
				Array.from(encodeIhdr(1, 1, 8, 6)),
				[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0],
				"IHDR layout",
			);
			const vector = new Uint8Array(
				Buffer.from(PNG_VECTORS.V75_1X1_TRANSPARENT_RED, "base64"),
			);
			check.deepEqual(
				assemblePng(chunks(vector)),
				vector,
				"signature, chunk lengths and CRC match independent source",
			);
		},
	},
	{
		name: "row filters use signed residuals and lowest filter on ties",
		run: (check) => {
			const raw = Uint8Array.of(0, 255, 254, 0, 255, 254);
			check.deepEqual(
				Array.from(applyRowFilters(raw, 3, 2, 1, "none")),
				[0, 0, 255, 254, 0, 0, 255, 254],
			);
			check.deepEqual(
				Array.from(applyRowFilters(raw, 3, 2, 1, "adaptive")),
				[1, 0, 255, 255, 2, 0, 0, 0],
				"signed score picks Sub, then Up",
			);
			check.deepEqual(
				Array.from(applyRowFilters(new Uint8Array(8), 4, 2, 4, "adaptive")),
				new Array(10).fill(0),
				"all-zero scores tie to filter 0",
			);
		},
	},
	{
		name: "trial ladder obeys size boundaries and filter-major order",
		run: (check) => {
			const maximumSmall: readonly PngTrial[] = [
				...standardSmall.slice(0, 2),
				{ filter: "none", strategy: "rle" },
				...standardSmall.slice(2),
				{ filter: "adaptive", strategy: "rle" },
			];
			for (const size of [1, 1048576]) {
				check.deepEqual(
					trialsFor(size, 8, 6, "standard"),
					standardSmall,
					"standard S trials",
				);
				check.deepEqual(
					trialsFor(size, 8, 6, "maximum"),
					maximumSmall,
					"maximum S trials",
				);
				check.deepEqual(
					trialsFor(size, 2, 0, "standard"),
					standardSmall.slice(0, 2),
					"packed samples only try none",
				);
			}
			for (const size of [1048577, 16777216]) {
				check.deepEqual(trialsFor(size, 8, 6, "standard"), [
					{ filter: "adaptive", strategy: "filtered" },
				]);
				check.deepEqual(trialsFor(size, 8, 6, "maximum"), standardSmall);
				check.deepEqual(
					trialsFor(size, 4, 0, "maximum"),
					standardSmall.slice(0, 2),
				);
			}
			for (const effort of ["standard", "maximum"] as const) {
				check.deepEqual(trialsFor(16777217, 8, 6, effort), [
					{ filter: "adaptive", strategy: "filtered" },
				]);
				check.deepEqual(trialsFor(16777217, 8, 3, effort), [noneDefault]);
				check.deepEqual(trialsFor(16777217, 1, 0, effort), [noneDefault]);
			}
		},
	},
	{
		name: "compressScanlines picks minimum IDAT, retains first equal trial",
		run: (check) => {
			const input = COMPRESSION_INPUTS.gradient();
			const compressed = compressScanlines(
				input.pixels,
				input.width * 4,
				input.height,
				4,
				8,
				6,
				"standard",
			);
			check.ok(
				compressed.idat.length > 6,
				"compressed scanlines are a zlib stream",
			);
			const attempts = standardSmall.map((trial) => ({
				trial,
				idat: deflateZlib(
					applyRowFilters(
						input.pixels,
						input.width * 4,
						input.height,
						4,
						trial.filter,
					),
					trial.strategy,
				),
			}));
			let best = attempts[0];
			for (const candidate of attempts.slice(1)) {
				if (candidate.idat.length < best.idat.length) best = candidate;
			}
			check.deepEqual(compressed, best, "smallest stream, not last trial");
			const zeros = new Uint8Array(4);
			const tie = compressScanlines(zeros, 4, 1, 4, 8, 6, "standard");
			check.ok(tie.idat.length > 6);
			check.deepEqual(
				tie.trial,
				noneDefault,
				"zeros give identical filters, earliest trial wins",
			);
		},
	},
	{
		name: "flattened pixels remain identical to raw single-layer input",
		run: (check) => {
			const input = COMPRESSION_INPUTS.hidden();
			check.deepEqual(flattenCanvas(canvasFor(input)), input.pixels);
		},
	},
];
