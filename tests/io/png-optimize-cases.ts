import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { McAssetError } from "../../src/core/errors.ts";
import { DEFLATE_ENGINE_ID } from "../../src/io/deflate.ts";
import { decodePng, flattenCanvas } from "../../src/io/png.ts";
import {
	analyzePixels,
	buildModeEncoding,
	PNG_COLOR_MODE_ORDER,
	type PngColorMode,
} from "../../src/io/png-modes.ts";
import { type OptimizeMode, optimizePng } from "../../src/io/png-optimize.ts";
import { PNG_SOURCE_LIMITS, planPngSource } from "../../src/io/png-source.ts";
import type { CaseCheck, PngCase } from "./png-cases.ts";
import {
	adam7Bands,
	type Chunk,
	chunks,
	concat,
	noise,
	OPTIMIZE_CORPUS,
	OPTIMIZE_INPUTS,
	png,
	type Raster,
	raster,
	rgbaScanlines,
	source,
	sourceWithIdat,
	u32,
} from "./png-optimize-fixtures.ts";

export const PNG_OPTIMIZE_CASES: PngCase[] = [];
function add(
	name: string,
	run: (check: CaseCheck) => void,
	timeoutMs?: number,
): void {
	PNG_OPTIMIZE_CASES.push(
		timeoutMs === undefined ? { name, run } : { name, run, timeoutMs },
	);
}

// The candidate search on a 1024x1024 raster takes several seconds, which is
// over Bun's default 5 second test timeout when the machine is under load.
const LARGE_CORPUS_TIMEOUT_MS = 60_000;
function sha(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function rgba(bytes: Uint8Array): Uint8Array {
	return flattenCanvas(decodePng(bytes).canvas);
}
function rejected(
	check: CaseCheck,
	fn: () => unknown,
	code: string,
	details: Record<string, unknown>,
): void {
	let caught: unknown;
	try {
		fn();
	} catch (error) {
		caught = error;
	}
	check.ok(
		caught instanceof McAssetError,
		`expected ${code}, got ${String(caught)}`,
	);
	if (!(caught instanceof McAssetError)) return;
	check.equal(caught.code, code);
	for (const [key, value] of Object.entries(details))
		check.deepEqual(
			(caught.details as Record<string, unknown>)?.[key],
			value,
			`error details.${key}`,
		);
}
function roundTrip(
	check: CaseCheck,
	input: Raster,
	mode: OptimizeMode = "auto",
): ReturnType<typeof optimizePng> {
	const before = source(input);
	const result = optimizePng(before, { mode });
	check.ok(result.bytes.length > 0, "optimizer returns a PNG");
	check.deepEqual(rgba(result.bytes), input.pixels, "all RGBA bytes survive");
	check.equal(result.report.engine, DEFLATE_ENGINE_ID);
	check.equal(result.report.effort, "maximum");
	check.equal(result.report.mode, mode);
	check.equal(result.report.ancillary, "preserve");
	check.equal(result.report.source.width, input.width);
	check.equal(result.report.source.height, input.height);
	check.equal(result.report.source.bytes, before.length);
	check.equal(result.report.result.bytes, result.bytes.length);
	const ihdr = chunks(result.bytes)[0]?.data;
	check.equal(result.report.result.bitDepth, ihdr?.[8]);
	check.equal(result.report.result.colorType, ihdr?.[9]);
	const selected = result.report.candidates.filter(
		(candidate) => candidate.selected,
	);
	check.equal(selected.length, result.report.status === "unchanged" ? 0 : 1);
	if (selected[0]) {
		check.equal(selected[0].mode, result.report.result.mode);
		check.equal(selected[0].bytes, result.bytes.length);
		check.equal(selected[0].paletteSize, result.report.result.paletteSize);
	}
	for (const candidate of result.report.candidates) {
		if (candidate.applicable) {
			check.ok(typeof candidate.bytes === "number" && candidate.bytes > 0);
			check.ok(["none", "adaptive"].includes(candidate.filter ?? ""));
			check.ok(
				["default", "filtered", "rle"].includes(candidate.strategy ?? ""),
			);
		} else {
			check.equal(candidate.bytes, undefined);
			check.equal(candidate.selected, false);
		}
	}
	check.equal(result.report.savedBytes, before.length - result.bytes.length);
	check.equal(
		result.report.savedPermille,
		Math.trunc(((before.length - result.bytes.length) * 1000) / before.length),
	);
	if (mode !== "auto") {
		check.equal(result.report.status, "converted");
		check.equal(result.report.result.mode, mode);
	}
	return result;
}
function modeResult(check: CaseCheck, input: Raster, mode: PngColorMode) {
	const result = buildModeEncoding(
		mode,
		input.pixels,
		analyzePixels(input.pixels, input.width, input.height),
	);
	check.equal(result.ok, true, `${mode} exactly represents input`);
	return result.ok ? result.encoding : undefined;
}
function countColors(count: number): Raster {
	return raster(count, 1, (x) => [x & 255, x >>> 8, 3, 255]);
}

add("mode/order is fixed", (check) =>
	check.deepEqual(PNG_COLOR_MODE_ORDER, [
		"rgba",
		"rgb",
		"grayscale-alpha",
		"grayscale",
		"indexed",
	]),
);
for (const count of [1, 2, 3, 4, 5, 16, 17, 256, 257]) {
	add(`mode/indexed boundary ${count}`, (check) => {
		const input = countColors(count);
		const analysis = analyzePixels(input.pixels, input.width, input.height);
		check.equal(analysis.distinctColors, count);
		check.equal(analysis.opaque, true);
		const result = buildModeEncoding("indexed", input.pixels, analysis);
		check.equal(result.ok, count <= 256);
		if (result.ok) {
			check.equal(result.encoding.paletteSize, count);
			check.equal(
				result.encoding.bitDepth,
				count <= 2 ? 1 : count <= 4 ? 2 : count <= 16 ? 4 : 8,
			);
		} else check.equal(result.reason, "more-than-256-colors");
		const report = roundTrip(check, input).report;
		check.deepEqual(
			report.candidates.map((c) => c.mode),
			PNG_COLOR_MODE_ORDER,
		);
		const indexed = report.candidates.find((c) => c.mode === "indexed");
		check.equal(indexed?.applicable, count <= 256);
		if (count > 256) {
			check.equal(analysis.palette, undefined);
			check.equal(indexed?.unavailableReason, "more-than-256-colors");
			check.equal(indexed?.bytes, undefined);
		}
	});
}
for (const alpha of [255, 254])
	for (const delta of [0, 1]) {
		add(`mode/opaque gray boundary alpha=${alpha} delta=${delta}`, (check) => {
			const input = raster(8, 2, (x, y) =>
				x === 7 && y === 1 ? [85, 85 + delta, 85, alpha] : [0, 0, 0, 255],
			);
			const a = analyzePixels(input.pixels, 8, 2);
			check.equal(a.opaque, alpha === 255);
			check.equal(a.gray, delta === 0);
			for (const mode of ["rgb", "grayscale-alpha", "grayscale"] as const) {
				const result = buildModeEncoding(mode, input.pixels, a);
				const applicable =
					mode === "rgb"
						? alpha === 255
						: mode === "grayscale-alpha"
							? delta === 0
							: delta === 0 && alpha === 255;
				check.equal(result.ok, applicable);
				if (!result.ok) {
					if (mode === "rgb" || delta === 0)
						check.equal(result.reason, "not-opaque");
					else if (mode === "grayscale-alpha" || alpha === 255)
						check.equal(result.reason, "not-gray");
					else check.ok(["not-opaque", "not-gray"].includes(result.reason));
				}
			}
			const report = roundTrip(check, input).report;
			for (const mode of ["rgb", "grayscale-alpha", "grayscale"] as const) {
				const candidate = report.candidates.find((c) => c.mode === mode);
				check.equal(
					candidate?.applicable,
					mode === "rgb"
						? alpha === 255
						: mode === "grayscale-alpha"
							? delta === 0
							: delta === 0 && alpha === 255,
				);
			}
		});
	}
add("mode/analysis flags continue after palette overflow", (check) => {
	const input = raster(258, 1, (x) =>
		x === 257 ? [1, 2, 1, 254] : [x & 255, x >>> 8, 3, 255],
	);
	const a = analyzePixels(input.pixels, 258, 1);
	check.equal(a.distinctColors, 257);
	check.equal(a.palette, undefined);
	check.equal(a.opaque, false);
	check.equal(a.gray, false);
});
for (const [depth, values, packed] of [
	[1, [0, 255, 0, 255, 255], [88]],
	[2, [0, 85, 170, 255, 85], [27, 64]],
	[4, [0, 17, 34, 255, 51], [1, 47, 48]],
	[8, [0, 1, 127, 255, 13], [0, 1, 127, 255, 13]],
] as const) {
	add(`mode/grayscale depth ${depth} row padding`, (check) => {
		const input = raster(5, 2, (x) => [values[x], values[x], values[x], 255]);
		const analysis = analyzePixels(input.pixels, 5, 2);
		check.equal(analysis.grayBitDepth, depth);
		const enc = modeResult(check, input, "grayscale");
		check.equal(enc?.bitDepth, depth);
		check.equal(enc?.colorType, 0);
		check.equal(enc?.bytesPerPixel, 1);
		check.equal(enc?.rowBytes, packed.length);
		check.deepEqual(enc?.raw, Uint8Array.from([...packed, ...packed]));
		roundTrip(check, input, "grayscale");
	});
}
for (const gray of [false, true])
	for (const mode of ["rgba", "indexed", "grayscale-alpha"] as const) {
		if (!gray && mode === "grayscale-alpha") continue;
		add(`hidden/${mode} gray=${gray}`, (check) => {
			const input = raster(32, 8, (x) =>
				gray ? [x, x, x, 0] : [x, 255 - x, 30, 0],
			);
			const a = analyzePixels(input.pixels, 32, 8);
			check.equal(a.distinctColors, 32);
			check.equal(a.opaque, false);
			check.deepEqual(buildModeEncoding("rgb", input.pixels, a), {
				ok: false,
				reason: "not-opaque",
			});
			roundTrip(check, input, mode);
		});
	}
add(
	"alpha/palette distinguishes alpha and orders translucent entries first",
	(check) => {
		const input = raster(
			5,
			1,
			(x) =>
				[
					[10, 20, 30, 255],
					[10, 20, 30, 0],
					[10, 20, 30, 128],
					[9, 8, 7, 255],
					[10, 20, 30, 0],
				][x],
		);
		const a = analyzePixels(input.pixels, 5, 1);
		check.equal(a.distinctColors, 4);
		check.deepEqual(a.palette, [
			{ r: 10, g: 20, b: 30, a: 0 },
			{ r: 10, g: 20, b: 30, a: 128 },
			{ r: 10, g: 20, b: 30, a: 255 },
			{ r: 9, g: 8, b: 7, a: 255 },
		]);
		const enc = modeResult(check, input, "indexed");
		check.deepEqual(enc?.trns, Uint8Array.of(0, 128));
		check.deepEqual(
			enc?.plte,
			Uint8Array.of(10, 20, 30, 10, 20, 30, 10, 20, 30, 9, 8, 7),
		);
		check.deepEqual(enc?.raw, Uint8Array.of(0x87, 0));
		roundTrip(check, input, "indexed");
	},
);
add("alpha/opaque palette omits tRNS", (check) =>
	check.equal(modeResult(check, countColors(3), "indexed")?.trns, undefined),
);
for (const different of [false, true])
	add(`transparent/all pixels different=${different}`, (check) => {
		const input = different
			? noise(32, 32)
			: raster(32, 32, () => [70, 80, 90, 0]);
		for (let i = 3; i < input.pixels.length; i += 4) input.pixels[i] = 0;
		const result = roundTrip(check, input);
		check.equal(result.report.result.mode, different ? "rgba" : "indexed");
	});
add("tie/rgb precedes grayscale for black 1x1", (check) => {
	const result = roundTrip(
		check,
		raster(1, 1, () => [0, 0, 0, 255]),
	);
	const rgb = result.report.candidates.find((c) => c.mode === "rgb");
	const gray = result.report.candidates.find((c) => c.mode === "grayscale");
	check.equal(rgb?.bytes, 67);
	check.equal(gray?.bytes, 67);
	check.equal(result.report.result.mode, "rgb");
});
for (const [mode, input, reason] of [
	["rgb", raster(2, 1, () => [1, 2, 3, 254]), "not-opaque"],
	["grayscale", raster(2, 1, () => [1, 1, 1, 254]), "not-opaque"],
	["grayscale", raster(2, 1, () => [1, 2, 1, 255]), "not-gray"],
	["grayscale-alpha", raster(2, 1, () => [1, 2, 1, 0]), "not-gray"],
	["indexed", countColors(257), "more-than-256-colors"],
] as const)
	add(`forced/reject ${mode} ${reason}`, (check) => {
		const details: Record<string, unknown> = { mode, reason };
		if (mode === "indexed") details.distinctColors = 257;
		rejected(
			check,
			() => optimizePng(source(input), { mode }),
			"OPTIMIZE_MODE_NOT_EXACT",
			details,
		);
	});
for (const mode of [
	"rgba",
	"rgb",
	"grayscale-alpha",
	"grayscale",
	"indexed",
] as const)
	add(`forced/converted ${mode}`, (check) => {
		const result = roundTrip(
			check,
			raster(8, 8, (x, y) => [
				((x + y) % 2) * 255,
				((x + y) % 2) * 255,
				((x + y) % 2) * 255,
				255,
			]),
			mode,
		);
		check.equal(result.report.candidates.length, 1);
		check.equal(result.report.candidates[0]?.selected, true);
	});
add("forced/may grow and reports negative savings", (check) => {
	const input = raster(32, 32, () => [70, 80, 90, 255]);
	const compact = optimizePng(source(input)).bytes;
	check.ok(compact.length > 0);
	const result = optimizePng(compact, { mode: "rgba" });
	check.equal(result.report.status, "converted");
	check.ok(result.bytes.length > compact.length);
	check.ok(result.report.savedBytes < 0);
	check.equal(
		result.report.savedPermille,
		Math.trunc((result.report.savedBytes * 1000) / compact.length),
	);
});
add(
	"unchanged/equal candidate keeps exact source bytes and none selected",
	(check) => {
		const first = roundTrip(check, OPTIMIZE_INPUTS.flat());
		const second = optimizePng(first.bytes);
		check.equal(second.report.status, "unchanged");
		check.deepEqual(second.bytes, first.bytes);
		check.equal(second.report.result.mode, "source");
		check.equal(second.report.savedBytes, 0);
		check.equal(second.report.savedPermille, 0);
		check.ok(second.report.candidates.every((c) => !c.selected));
	},
);
for (const level of [1, 9])
	add(`compressed/external zlib level ${level} never grows`, (check) => {
		const input = OPTIMIZE_INPUTS.opaque();
		const before = source(input, { colorType: 2, level });
		const after = optimizePng(before);
		check.ok(after.bytes.length > 0);
		check.ok(after.bytes.length <= before.length);
		check.deepEqual(rgba(after.bytes), input.pixels);
		check.equal(optimizePng(after.bytes).report.status, "unchanged");
	});

const FORMS = [
	[6, 8],
	[2, 8],
	[4, 8],
	[0, 8],
	[0, 1],
	[0, 2],
	[0, 4],
	[3, 1],
	[3, 2],
	[3, 4],
	[3, 8],
] as const;
function formInput(type: number, depth: number): Raster {
	return raster(9, 9, (x, y) => {
		const v =
			type === 0
				? (((x + y) % (1 << depth)) * 255) / ((1 << depth) - 1)
				: ((x + y) % 2) * 255;
		return type === 0
			? [v, v, v, 255]
			: type === 4
				? [v, v, v, (x * 17 + y * 7) & 255]
				: type === 2
					? [x * 17, y * 13, 70, 255]
					: type === 3
						? [((x + y) % 2) * 70, 20, 30, (x + y) % 2 ? 128 : 255]
						: [x * 17, y * 13, 70, (x * 17 + y * 7) & 255];
	});
}
for (const [type, depth] of FORMS)
	for (const interlaced of [false, true]) {
		add(
			`writer/source type=${type} depth=${depth} Adam7=${interlaced}`,
			(check) => {
				const input = formInput(type, depth);
				check.deepEqual(
					rgba(source(input, { colorType: type, depth, interlaced })),
					input.pixels,
				);
			},
		);
		add(
			`source/accept type=${type} depth=${depth} Adam7=${interlaced}`,
			(check) => {
				const input = formInput(type, depth);
				const bytes = source(input, { colorType: type, depth, interlaced });
				const plan = planPngSource(bytes, "preserve");
				check.equal(plan.info.width, 9);
				check.equal(plan.info.height, 9);
				check.equal(plan.info.bitDepth, depth);
				check.equal(plan.info.colorType, type);
				check.equal(plan.info.interlaced, interlaced);
				check.equal(plan.info.chunkCount, chunks(bytes).length);
				const result = optimizePng(bytes, { mode: "rgba" });
				check.ok(result.bytes.length > 0);
				check.deepEqual(rgba(result.bytes), input.pixels);
				check.equal(result.report.source.interlaced, interlaced);
				check.equal(result.report.interlaceRemoved, interlaced);
				check.equal(chunks(result.bytes)[0]?.data[12], 0);
			},
		);
	}
for (const type of [0, 2, 4, 6])
	for (const interlaced of [false, true])
		add(`source/reject 16bit type=${type} Adam7=${interlaced}`, (check) =>
			rejected(
				check,
				() =>
					optimizePng(
						source(formInput(type, 8), {
							colorType: type,
							depth: 16,
							interlaced,
						}),
					),
				"UNSUPPORTED_IMAGE_FORMAT",
				{ reason: "bit-depth-16" },
			),
		);
for (const type of [0, 2])
	for (const interlaced of [false, true])
		add(`source/reject color key type=${type} Adam7=${interlaced}`, (check) =>
			rejected(
				check,
				() =>
					optimizePng(
						source(formInput(type, 8), {
							colorType: type,
							interlaced,
							key: type === 0 ? Uint8Array.of(0, 0) : new Uint8Array(6),
						}),
					),
				"UNSUPPORTED_IMAGE_FORMAT",
				{ reason: "color-key-transparency" },
			),
		);

const base = () => chunks(source(raster(8, 8, () => [1, 2, 3, 255])));
function withChunk(
	type: string,
	data: Uint8Array = Uint8Array.of(1, 2, 3),
): Uint8Array {
	const c = base();
	c.splice(1, 0, { type, data });
	return png(c);
}
const COPY_CHUNKS: Chunk[] = [
	{ type: "gAMA", data: u32(45455) },
	{ type: "cHRM", data: new Uint8Array(32) },
	{ type: "sRGB", data: Uint8Array.of(0) },
	{ type: "iCCP", data: Uint8Array.of(120, 0, 0, 120, 156, 3, 0, 0, 0, 0, 1) },
	{ type: "cICP", data: Uint8Array.of(1, 13, 0, 1) },
	{ type: "mDCv", data: new Uint8Array(24) },
	{ type: "cLLI", data: new Uint8Array(8) },
	{ type: "pHYs", data: concat(u32(1000), u32(1000), Uint8Array.of(1)) },
	{ type: "sPLT", data: Uint8Array.of(112, 0, 8, 1, 2, 3, 255, 0, 1) },
	{ type: "tIME", data: Uint8Array.of(7, 234, 10, 14, 1, 2, 3) },
	{ type: "tEXt", data: Uint8Array.of(75, 0, 86) },
	{ type: "zTXt", data: Uint8Array.of(75, 0, 0, 120, 156, 3, 0, 0, 0, 0, 1) },
	{ type: "iTXt", data: Uint8Array.of(75, 0, 0, 0, 0, 0, 86) },
	{ type: "eXIf", data: Uint8Array.of(73, 73, 42, 0, 8, 0, 0, 0, 0, 0) },
	{ type: "teSt", data: Uint8Array.of(1, 2, 3) },
];
for (const chunk of COPY_CHUNKS) {
	add(`writer/ancillary ${chunk.type} decodes exactly`, (check) => {
		check.deepEqual(
			rgba(withChunk(chunk.type, chunk.data)),
			raster(8, 8, () => [1, 2, 3, 255]).pixels,
		);
	});
}
for (const chunk of COPY_CHUNKS)
	for (const policy of ["preserve", "strip"] as const)
		add(`chunks/${policy} ${chunk.type}`, (check) => {
			const bytes = withChunk(chunk.type, chunk.data);
			const plan = planPngSource(bytes, policy);
			if (policy === "preserve")
				check.deepEqual(plan.preserved, [{ ...chunk, segment: "before-plte" }]);
			else check.deepEqual(plan.stripped, [chunk.type]);
			const result = optimizePng(bytes, { mode: "rgba", ancillary: policy });
			check.ok(result.bytes.length > 0);
			check.deepEqual(
				chunks(result.bytes).filter((c) => c.type === chunk.type),
				policy === "preserve" ? [chunk] : [],
			);
			check.deepEqual(
				result.report.preservedChunks,
				policy === "preserve" ? [chunk.type] : [],
			);
			check.deepEqual(
				result.report.strippedChunks,
				policy === "strip" ? [chunk.type] : [],
			);
			check.deepEqual(rgba(result.bytes), rgba(bytes));
		});
for (const type of ["sBIT", "bKGD", "hIST", "teST", "iDOT", "PLTE"])
	for (const policy of ["preserve", "strip"] as const)
		add(`chunks/${policy} needs strip ${type}`, (check) => {
			const data =
				type === "sBIT"
					? Uint8Array.of(8, 8, 8, 8)
					: type === "bKGD"
						? new Uint8Array(6)
						: Uint8Array.of(1, 2, 3);
			let bytes = withChunk(type, data);
			if (type === "hIST") {
				const indexed = chunks(
					source(formInput(3, 2), { colorType: 3, depth: 2 }),
				);
				indexed.splice(2, 0, { type: "hIST", data: Uint8Array.of(0, 1, 0, 1) });
				bytes = png(indexed);
			}
			if (policy === "preserve")
				rejected(
					check,
					() => planPngSource(bytes, policy),
					"UNSUPPORTED_IMAGE_FORMAT",
					{ reason: "ancillary-needs-strip" },
				);
			else {
				const plan = planPngSource(bytes, policy);
				check.deepEqual(plan.stripped, [type]);
				const r = optimizePng(bytes, { mode: "rgba", ancillary: policy });
				check.ok(r.bytes.length > 0);
				check.deepEqual(r.report.strippedChunks, [type]);
				check.ok(!chunks(r.bytes).some((c) => c.type === type));
			}
		});
for (const type of ["acTL", "fcTL", "fdAT", "ZZZZ", "CgBI", "tesT", "t1St"])
	for (const policy of ["preserve", "strip"] as const)
		add(`chunks/${policy} reject ${type}`, (check) => {
			const reason = ["acTL", "fcTL", "fdAT"].includes(type)
				? "animated-png"
				: ["ZZZZ", "CgBI"].includes(type)
					? "unknown-critical-chunk"
					: "invalid-chunk";
			rejected(
				check,
				() => optimizePng(withChunk(type), { ancillary: policy }),
				"UNSUPPORTED_IMAGE_FORMAT",
				{ reason },
			);
		});
for (const policy of ["preserve", "strip"] as const)
	add(`chunks/${policy} indexed PLTE tRNS regenerated`, (check) => {
		const input = formInput(3, 2);
		const bytes = source(input, { colorType: 3, depth: 2 });
		const result = optimizePng(bytes, { mode: "indexed", ancillary: policy });
		check.ok(result.bytes.length > 0);
		check.deepEqual(rgba(result.bytes), input.pixels);
		check.deepEqual(result.report.strippedChunks, []);
		check.deepEqual(
			chunks(result.bytes).map((c) => c.type),
			["IHDR", "PLTE", "tRNS", "IDAT", "IEND"],
		);
	});
for (const policy of ["preserve", "strip"] as const)
	for (const mode of ["rgba", "indexed"] as const)
		add(`chunks/${policy} segments and duplicate order to ${mode}`, (check) => {
			const c = chunks(source(formInput(3, 2), { colorType: 3, depth: 2 }));
			c.splice(1, 0, { type: "teSt", data: Uint8Array.of(1) });
			c.splice(3, 0, { type: "teSt", data: Uint8Array.of(2) });
			c.splice(c.length - 1, 0, { type: "teSt", data: Uint8Array.of(3) });
			const bytes = png(c);
			const plan = planPngSource(bytes, policy);
			check.deepEqual(
				plan.preserved.map((p) => p.segment),
				policy === "preserve"
					? ["before-plte", "after-plte", "after-idat"]
					: [],
			);
			check.deepEqual(
				plan.stripped,
				policy === "strip" ? ["teSt", "teSt", "teSt"] : [],
			);
			const result = optimizePng(bytes, { mode, ancillary: policy });
			check.ok(result.bytes.length > 0);
			const out = chunks(result.bytes);
			check.deepEqual(
				out.filter((p) => p.type === "teSt").map((p) => Array.from(p.data)),
				policy === "preserve" ? [[1], [2], [3]] : [],
			);
			check.deepEqual(
				out.map((p) => p.type),
				policy === "strip"
					? mode === "rgba"
						? ["IHDR", "IDAT", "IEND"]
						: ["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]
					: mode === "rgba"
						? ["IHDR", "teSt", "teSt", "IDAT", "teSt", "IEND"]
						: ["IHDR", "teSt", "PLTE", "tRNS", "teSt", "IDAT", "teSt", "IEND"],
			);
		});

const MALFORMED: Record<string, () => Uint8Array> = {
	"not-png": () => new Uint8Array(40),
	"bad-crc": () => {
		const b = png(base());
		b[29] ^= 1;
		return b;
	},
	"trailing-data": () => concat(png(base()), Uint8Array.of(0)),
	truncated: () => png(base()).slice(0, -1),
	"chunk-order/noncontiguous-idat": () => {
		const c = base();
		const idat = c[1].data;
		return png([
			c[0],
			{ type: "IDAT", data: idat.slice(0, 2) },
			{ type: "tEXt", data: Uint8Array.of(75, 0, 86) },
			{ type: "IDAT", data: idat.slice(2) },
			c[2],
		]);
	},
	"chunk-order/late-plte": () => {
		const c = base();
		c.splice(2, 0, { type: "PLTE", data: Uint8Array.of(1, 2, 3) });
		return png(c);
	},
	"chunk-order/duplicate-ihdr": () => {
		const c = base();
		c.splice(1, 0, c[0]);
		return png(c);
	},
	"chunk-order/missing-idat": () => png([base()[0], base()[2]]),
	"truncated/missing-iend": () => png(base().slice(0, 2)),
	"invalid-ihdr/compression": () => {
		const c = base();
		c[0].data[10] = 1;
		return png(c);
	},
	"invalid-ihdr/filter": () => {
		const c = base();
		c[0].data[11] = 1;
		return png(c);
	},
	"invalid-ihdr/interlace": () => {
		const c = base();
		c[0].data[12] = 2;
		return png(c);
	},
	"invalid-ihdr/depth-type": () => {
		const c = base();
		c[0].data[8] = 4;
		return png(c);
	},
	"truncated/oversized-length": () => {
		const b = png(base());
		b.set(u32(0x7fffffff), 33);
		return b;
	},
};
for (const [name, make] of Object.entries(MALFORMED))
	add(`structure/${name}`, (check) =>
		rejected(check, () => optimizePng(make()), "UNSUPPORTED_IMAGE_FORMAT", {
			reason: name.split("/")[0],
		}),
	);
add("structure/decode failure maps to explicit reason", (check) => {
	const c = base();
	c[1].data = Uint8Array.of(1, 2, 3);
	rejected(check, () => optimizePng(png(c)), "UNSUPPORTED_IMAGE_FORMAT", {
		reason: "decode-failed",
	});
});
add("structure/multiple contiguous IDAT accepted", (check) => {
	const c = base();
	const d = c[1].data;
	const b = png([
		c[0],
		{ type: "IDAT", data: d.slice(0, 2) },
		{ type: "IDAT", data: d.slice(2) },
		c[2],
	]);
	const r = optimizePng(b, { mode: "rgba" });
	check.ok(r.bytes.length > 0);
	check.deepEqual(rgba(r.bytes), rgba(b));
	check.equal(chunks(r.bytes).filter((c) => c.type === "IDAT").length, 1);
});

const STREAM_INPUT = raster(8, 8, (x, y) => [x * 9, y * 11, 3, 255]);
const STREAM_RAW = rgbaScanlines(STREAM_INPUT);
const BROKEN_STREAMS: Record<string, () => Uint8Array> = {
	"missing adler32": () => new Uint8Array(deflateSync(STREAM_RAW)).slice(0, -4),
	"wrong adler32": () => {
		const stream = new Uint8Array(deflateSync(STREAM_RAW));
		stream[stream.length - 1] ^= 1;
		return stream;
	},
	"inflates one byte short": () =>
		new Uint8Array(deflateSync(STREAM_RAW.slice(0, -1))),
};
for (const [name, make] of Object.entries(BROKEN_STREAMS))
	add(`structure/broken zlib stream rejected: ${name}`, (check) => {
		const bytes = sourceWithIdat(STREAM_INPUT, make());
		for (const mode of ["auto", "rgba"] as const)
			rejected(
				check,
				() => optimizePng(bytes, { mode }),
				"UNSUPPORTED_IMAGE_FORMAT",
				{ reason: "decode-failed" },
			);
	});
for (const [name, splits] of [
	["two parts", [7]],
	["five parts", [3, 9, 20, 41]],
	["empty parts between", [0, 5, 5, 12, 12]],
] as const)
	add(`structure/valid IDAT split accepted: ${name}`, (check) => {
		const idat = new Uint8Array(deflateSync(STREAM_RAW));
		const whole = sourceWithIdat(STREAM_INPUT, idat);
		const bytes = sourceWithIdat(STREAM_INPUT, idat, splits);
		check.equal(
			chunks(bytes).filter((c) => c.type === "IDAT").length,
			splits.length + 1,
		);
		for (const mode of ["auto", "rgba"] as const) {
			const result = optimizePng(bytes, { mode });
			check.deepEqual(rgba(result.bytes), STREAM_INPUT.pixels);
			check.deepEqual(
				result.bytes,
				optimizePng(whole, { mode }).bytes,
				"splitting IDAT does not change the result",
			);
		}
	});

add("interlace/auto unchanged keeps an Adam7 source byte for byte", (check) => {
	const input = adam7Bands(2, 5);
	const bytes = source(input, { interlaced: true, level: 9 });
	const result = optimizePng(bytes);
	check.equal(result.report.status, "unchanged");
	check.deepEqual(result.bytes, bytes);
	check.equal(result.report.source.interlaced, true);
	check.equal(result.report.interlaceRemoved, false);
	check.equal(result.report.result.mode, "source");
	check.equal(result.report.result.bytes, bytes.length);
	check.deepEqual(rgba(result.bytes), input.pixels);
});
add("interlace/auto never rejects a valid Adam7 source", (check) => {
	let unchanged = 0;
	for (let width = 1; width <= 9; width += 1)
		for (let height = 1; height <= 9; height += 1) {
			const input = adam7Bands(width, height);
			const bytes = source(input, { interlaced: true, level: 9 });
			const result = optimizePng(bytes);
			check.deepEqual(rgba(result.bytes), input.pixels, `${width}x${height}`);
			if (result.report.status === "unchanged") {
				unchanged += 1;
				check.deepEqual(result.bytes, bytes, `${width}x${height}`);
			}
		}
	check.ok(unchanged > 0, "sweep reaches the unchanged path");
});

for (const [name, lead, reason] of [
	["unknown critical", "CgBI", "unknown-critical-chunk"],
	["another unknown critical", "ZZZZ", "unknown-critical-chunk"],
	["ancillary", "tEXt", "chunk-order"],
	["known critical", "IDAT", "chunk-order"],
] as const)
	add(`structure/${name} chunk before IHDR`, (check) => {
		const bytes = png([
			{ type: lead, data: Uint8Array.of(1, 2, 3, 4) },
			...base(),
		]);
		for (const policy of ["preserve", "strip"] as const)
			rejected(
				check,
				() => optimizePng(bytes, { ancillary: policy }),
				"UNSUPPORTED_IMAGE_FORMAT",
				{ reason, chunk: lead },
			);
	});

const GOLDENS: readonly [keyof typeof OPTIMIZE_INPUTS, OptimizeMode, string][] =
	[
		[
			"flat",
			"auto",
			"64c0f67a22a526417a65b702a1d4526f1287050b2d1f2d35fc128d0b3d4b11c1",
		],
		[
			"gradient",
			"auto",
			"3231d1dae60dd785ba096da9e53c928703456629d08367e21f7aa77a879321d8",
		],
		[
			"hidden",
			"auto",
			"63cdbc50f2a7631aca29b6a827b75a13bf817cecd8f1de2da623d02733239e82",
		],
		[
			"alpha",
			"indexed",
			"fa523b21f68b0dd24a691a4dd7b161b172c74f5a32ca01644a8c259493901249",
		],
		[
			"opaque",
			"rgb",
			"158251040896db869f090c50ff0f1b66a912e26e181de0c7f60272c604355cac",
		],
		[
			"upscaled",
			"indexed",
			"a2c7529226b7156f742743ac1f64448beb3c3bbf5173d3d9c56d02ec30b78b70",
		],
	];
for (const [name, mode, hash] of GOLDENS)
	add(`bytes/${name} ${mode} SHA256`, (check) => {
		const input = OPTIMIZE_INPUTS[name]();
		const result = optimizePng(source(input), { mode });
		check.equal(sha(result.bytes), hash);
		check.deepEqual(rgba(result.bytes), input.pixels);
	});
add("entropy/256x256 never grows and stays exact", (check) => {
	const input = noise(256, 256);
	const before = source(input, { level: 9 });
	const r = optimizePng(before);
	check.ok(r.bytes.length > 0);
	check.ok(r.bytes.length <= before.length);
	check.deepEqual(rgba(r.bytes), input.pixels);
});
add("limits/constants", (check) =>
	check.deepEqual(PNG_SOURCE_LIMITS, {
		maxInputBytes: 134217728,
		maxChunks: 10000,
	}),
);
add("limits/input byte length checked before read or allocation", (check) => {
	const input = new Proxy(new Uint8Array(), {
		get(_target, key) {
			if (key === "length" || key === "byteLength") return 134217729;
			throw new Error(`buffer read before size gate: ${String(key)}`);
		},
	});
	rejected(
		check,
		() => planPngSource(input, "preserve"),
		"RESOURCE_LIMIT_EXCEEDED",
		{ limit: 134217728, actual: 134217729 },
	);
});
for (const count of [10000, 10001])
	add(`limits/chunk count ${count}`, (check) => {
		const c = base();
		const filler = Array.from({ length: count - 3 }, () => ({
			type: "teSt",
			data: new Uint8Array(),
		}));
		const bytes = png([c[0], ...filler, c[1], c[2]]);
		if (count === 10001)
			rejected(
				check,
				() => planPngSource(bytes, "strip"),
				"RESOURCE_LIMIT_EXCEEDED",
				{ limit: 10000, actual: 10001 },
			);
		else check.equal(planPngSource(bytes, "strip").info.chunkCount, 10000);
	});
for (const dimension of [0, 4097])
	add(`limits/invalid dimension ${dimension}`, (check) => {
		const c = base();
		c[0].data.set(u32(dimension));
		rejected(check, () => optimizePng(png(c)), "INVALID_DIMENSION", {});
	});
for (const policy of ["preserve", "strip"] as const)
	add(`input/read-only ${policy}`, (check) => {
		const input = withChunk("teSt");
		const before = input.slice();
		const hash = sha(input);
		const result = optimizePng(input, { ancillary: policy });
		check.ok(result.bytes.length > 0);
		check.equal(sha(input), hash);
		check.deepEqual(input, before);
		const pixels = OPTIMIZE_INPUTS.flat();
		const pixelBefore = pixels.pixels.slice();
		const analysis = analyzePixels(pixels.pixels, pixels.width, pixels.height);
		for (const mode of PNG_COLOR_MODE_ORDER)
			buildModeEncoding(mode, pixels.pixels, analysis);
		check.deepEqual(pixels.pixels, pixelBefore);
	});
add("self-check/corrupt candidate never returns bytes", (check) => {
	const modesUrl = new URL("../../src/io/png-modes.ts", import.meta.url).href;
	const optimizeUrl = new URL("../../src/io/png-optimize.ts", import.meta.url)
		.href;
	const fixtureUrl = new URL("./png-optimize-fixtures.ts", import.meta.url)
		.href;
	const bun = Boolean(process.versions.bun);
	const script = `
		import { mock } from ${JSON.stringify(bun ? "bun:test" : "node:test")};
		const real=await import(${JSON.stringify(modesUrl)});
		const build=real.buildModeEncoding;
		const corrupt=(...args)=>{const r=build(...args);if(!r.ok)return r;const raw=r.encoding.raw.slice();raw[0]^=255;return {...r,encoding:{...r.encoding,raw}};};
		${bun ? `mock.module(${JSON.stringify(modesUrl)},()=>({...real,buildModeEncoding:corrupt}));` : `mock.module(${JSON.stringify(modesUrl)},{namedExports:{...real,buildModeEncoding:corrupt}});`}
		const {optimizePng}=await import(${JSON.stringify(optimizeUrl)});
		const {source,raster}=await import(${JSON.stringify(fixtureUrl)});
		try{optimizePng(source(raster(4,4,()=>[20,30,40,255])),{mode:"rgba"});console.log("RETURNED_BYTES");}
		catch(error){console.log(JSON.stringify({code:error.code,details:error.details}));}
	`;
	const child = spawnSync(
		process.execPath,
		bun
			? ["--eval", script]
			: [
					"--experimental-test-module-mocks",
					"--input-type=module",
					"--eval",
					script,
				],
		{ encoding: "utf8" },
	);
	check.equal(child.status, 0, child.stderr);
	check.equal(
		child.stdout.trim(),
		JSON.stringify({
			code: "INTERNAL_ERROR",
			details: { stage: "self-check" },
		}),
	);
});

for (const [name, recipe] of Object.entries(OPTIMIZE_CORPUS))
	add(
		`corpus/${name} exact never grows and idempotent`,
		(check) => {
			const input = recipe();
			const before = source(input);
			const result = optimizePng(before);
			check.ok(result.bytes.length > 0);
			check.ok(result.bytes.length <= before.length);
			check.deepEqual(rgba(result.bytes), input.pixels);
			check.equal(optimizePng(result.bytes).report.status, "unchanged");
		},
		name.startsWith("large-") ? LARGE_CORPUS_TIMEOUT_MS : undefined,
	);
add(
	"candidate/palette is not preferred just because 256 colors fit",
	(check) => {
		const input = raster(64, 64, (x, y) => {
			const k = (y * 64 + x) & 255;
			return [k, (k * 7) & 255, (k * 13) & 255, 255];
		});
		const result = roundTrip(check, input);
		const rgb = result.report.candidates.find((c) => c.mode === "rgb");
		const indexed = result.report.candidates.find((c) => c.mode === "indexed");
		check.ok((rgb?.bytes ?? 0) < (indexed?.bytes ?? 0));
		check.equal(result.report.result.mode, "rgb");
	},
);
add("candidate/256 alpha values can favor rgba", (check) => {
	const input = raster(64, 64, (x, y) => [
		90,
		140,
		200,
		((y * 64 + x) >>> 4) & 255,
	]);
	const result = roundTrip(check, input);
	check.equal(result.report.result.mode, "rgba");
});
add("candidate/size includes preserved chunk overhead", (check) => {
	const before = withChunk("teSt", new Uint8Array(128));
	const keep = optimizePng(before, { mode: "rgba" });
	const strip = optimizePng(before, { mode: "rgba", ancillary: "strip" });
	check.ok(keep.bytes.length > 0);
	check.equal(keep.bytes.length - strip.bytes.length, 140);
	check.equal(keep.report.candidates[0]?.bytes, keep.bytes.length);
});
add("input/rejected source remains byte-identical", (check) => {
	const before = withChunk("iDOT");
	const copy = before.slice();
	rejected(check, () => optimizePng(before), "UNSUPPORTED_IMAGE_FORMAT", {
		reason: "ancillary-needs-strip",
	});
	check.deepEqual(before, copy);
});
