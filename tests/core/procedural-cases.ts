import { McAssetError } from "../../src/core/errors.ts";
import {
	createXorshift32,
	GENERATE_PATTERNS,
	type GeneratePatternName,
	generateProcedural,
	orderPaletteColors,
	parseGeneratePattern,
	parseGenerateSeed,
} from "../../src/core/procedural.ts";
import type { RGBA } from "../../src/core/types.ts";

/** Runner-agnostic assertion surface: bun:test and node:test adapt to this. */
export interface ProceduralCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throwsCode(fn: () => unknown, code: string, message?: string): void;
	/** sha256 hex of bytes; identical on Bun and Node for golden locking. */
	sha256Hex(bytes: Uint8Array): string;
}

export interface ProceduralCase {
	name: string;
	run(check: ProceduralCheck): void;
}

function rgb(r: number, g: number, b: number, a = 255): RGBA {
	return { r, g, b, a };
}

const THREE_COLORS: RGBA[] = [rgb(200, 0, 0), rgb(0, 100, 0), rgb(10, 10, 200)];

function luminanceOf(color: RGBA): number {
	return 299 * color.r + 587 * color.g + 114 * color.b;
}

function isOrdered(palette: RGBA[]): boolean {
	for (let i = 1; i < palette.length; i += 1) {
		const prev = palette[i - 1] as RGBA;
		const next = palette[i] as RGBA;
		const dLum = luminanceOf(next) - luminanceOf(prev);
		if (dLum < 0) {
			return false;
		}
		if (dLum === 0) {
			if (
				next.r < prev.r ||
				(next.r === prev.r && next.g < prev.g) ||
				(next.r === prev.r && next.g === prev.g && next.b < prev.b) ||
				(next.r === prev.r &&
					next.g === prev.g &&
					next.b === prev.b &&
					next.a < prev.a)
			) {
				return false;
			}
		}
	}
	return true;
}

function colorKey(color: RGBA): string {
	return `${color.r},${color.g},${color.b},${color.a}`;
}

function assertPixelsInPalette(
	check: ProceduralCheck,
	pixels: Uint8Array,
	palette: RGBA[],
	what: string,
): void {
	const allowed = new Set(palette.map(colorKey));
	allowed.add("0,0,0,0");
	for (let i = 0; i < pixels.length; i += 4) {
		const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]},${pixels[i + 3]}`;
		check.ok(
			allowed.has(key),
			`${what}: pixel ${i / 4} (${key}) outside palette`,
		);
	}
}

const STONE_GOLDENS: Readonly<Record<string, string>> = {
	noise: "67a79a39b98d166e178756b89ec3649c634470cdcaca8c51754e1ca3fa207783",
	"clustered-noise":
		"ab08b4b8751288f27b03a4ddc37b5daa29988209c024e4a7a8d911f3ab82fed0",
	stripes: "23fa7475a7108d14d629a1da4444d830a84b1cb7d4158677a09c79f04ac2f01b",
	checker: "5e9e3f845b8cfad033eeeae3762c6296449ed35e571decf6d3a669ab4671fa2b",
	gradient: "1a24fff2f10aa309b5904fb0f28ce401fc739c8a25d4e76ea6491f4c9d1d2759",
	brick: "08a6a9998ddd3d2233c315bd667674d58410f60d07edc31106402fb05933b888",
	spots: "792a956595211b50bd1e48195f14893ef14842fd0b634596789b373a9e9bb9f9",
	veins: "b8521a11b10b5eae77598d4ffa30ab1b0257b212954c777d494f901aef075628",
	cracks: "7ca9b101267ed081b023e73d64bb6edd39e92bfa4bb53d8e98065ac40d5dff2f",
	grain: "567c72d63787a8c6277dda58f2731c5be0c0813c37ee1f0d8440af3bc9bc86cb",
};

/** Starter goldens below pin the 8x8 seed-7 output over the stone palette. */
const STONE_PALETTE: RGBA[] = [
	{ r: 0x17, g: 0x17, b: 0x1a, a: 255 },
	{ r: 0x55, g: 0x55, b: 0x5c, a: 255 },
	{ r: 0x6b, g: 0x6b, b: 0x73, a: 255 },
	{ r: 0x84, g: 0x84, b: 0x8c, a: 255 },
	{ r: 0xa3, g: 0xa3, b: 0xab, a: 255 },
	{ r: 0xc9, g: 0xc9, b: 0xd1, a: 255 },
	{ r: 0xe8, g: 0xe8, b: 0xee, a: 255 },
];
const XORSHIFT_ORACLE: Array<{
	seed: number;
	init: number;
	first: [number, number, number];
}> = [
	{ seed: 0, init: 2654435769, first: [1359758873, 3761132862, 2075758394] },
	{ seed: 1, init: 2654435768, first: [1359504952, 3827716927, 3866437631] },
	{
		seed: 12345,
		init: 2654423424,
		first: [2548642403, 2231655569, 3696820378],
	},
	{
		seed: 4294967295,
		init: 1640531526,
		first: [1359980038, 472492225, 251795321],
	},
];

export const PROCEDURAL_CASES: ProceduralCase[] = [
	{
		name: "all ten CLI pattern names parse",
		run(check) {
			const expected: GeneratePatternName[] = [
				"noise",
				"clustered-noise",
				"stripes",
				"checker",
				"gradient",
				"brick",
				"spots",
				"veins",
				"cracks",
				"grain",
			];
			check.deepEqual([...GENERATE_PATTERNS], expected);
			for (const name of expected) {
				check.equal(parseGeneratePattern(name), name);
			}
		},
	},
	{
		name: "unknown pattern is INVALID_ARGUMENT",
		run(check) {
			check.throwsCode(
				() => parseGeneratePattern("clouds"),
				"INVALID_ARGUMENT",
			);
			check.throwsCode(
				() => parseGeneratePattern("clustered noise"),
				"INVALID_ARGUMENT",
			);
			check.throwsCode(() => parseGeneratePattern(""), "INVALID_ARGUMENT");
			check.throwsCode(
				() => parseGeneratePattern(undefined),
				"INVALID_ARGUMENT",
			);
			check.throwsCode(() => parseGeneratePattern("NOISE"), "INVALID_ARGUMENT");
		},
	},
	{
		name: "seed parses the frozen 0-4294967295 range",
		run(check) {
			check.equal(parseGenerateSeed("0"), 0);
			check.equal(parseGenerateSeed("4294967295"), 4294967295);
			check.equal(parseGenerateSeed("12345"), 12345);
			check.throwsCode(() => parseGenerateSeed(undefined), "INVALID_ARGUMENT");
			check.throwsCode(() => parseGenerateSeed(""), "INVALID_ARGUMENT");
			check.throwsCode(() => parseGenerateSeed("abc"), "INVALID_ARGUMENT");
			check.throwsCode(() => parseGenerateSeed("-1"), "INVALID_ARGUMENT");
			check.throwsCode(
				() => parseGenerateSeed("4294967296"),
				"INVALID_ARGUMENT",
			);
			check.throwsCode(() => parseGenerateSeed("1.5"), "INVALID_ARGUMENT");
			check.throwsCode(() => parseGenerateSeed("12x"), "INVALID_ARGUMENT");
		},
	},
	{
		name: "xorshift32 matches the frozen oracle",
		run(check) {
			for (const entry of XORSHIFT_ORACLE) {
				const next = createXorshift32(entry.seed);
				check.equal(next(), entry.first[0], `seed ${entry.seed} output 1`);
				check.equal(next(), entry.first[1], `seed ${entry.seed} output 2`);
				check.equal(next(), entry.first[2], `seed ${entry.seed} output 3`);
			}
		},
	},
	{
		name: "xorshift32 is deterministic uint32",
		run(check) {
			const first = createXorshift32(7);
			const second = createXorshift32(7);
			for (let i = 0; i < 100; i += 1) {
				const a = first();
				const b = second();
				check.equal(a, b, `draw ${i} repeats`);
				check.ok(
					Number.isInteger(a) && a >= 0 && a <= 4294967295,
					`draw ${i} is uint32`,
				);
			}
			const other = createXorshift32(8);
			let differed = false;
			const rerun = createXorshift32(7);
			for (let i = 0; i < 10; i += 1) {
				if (other() !== rerun()) {
					differed = true;
				}
			}
			check.ok(differed, "different seeds diverge");
		},
	},
	{
		name: "palette ordering is a fixed total order",
		run(check) {
			const shuffled: RGBA[] = [
				rgb(10, 10, 200),
				rgb(200, 0, 0),
				rgb(0, 100, 0),
			];
			const ordered = orderPaletteColors(shuffled);
			check.equal(ordered.length, 3);
			check.ok(isOrdered(ordered), "ordered ascending");
			check.deepEqual(
				orderPaletteColors(shuffled).map(colorKey),
				ordered.map(colorKey),
				"stable across calls",
			);
			check.deepEqual(
				orderPaletteColors([...THREE_COLORS]).map(colorKey),
				ordered.map(colorKey),
				"order independent of input order",
			);
		},
	},
	...GENERATE_PATTERNS.map(
		(pattern): ProceduralCase => ({
			name: `${pattern} emits sized palette-only pixels deterministically`,
			run(check) {
				const width = 8;
				const height = 6;
				const first = generateProcedural(pattern, {
					width,
					height,
					seed: 7,
					palette: [...THREE_COLORS],
				});
				check.equal(first.width, width);
				check.equal(first.height, height);
				check.equal(first.pixels.length, width * height * 4);
				assertPixelsInPalette(
					check,
					first.pixels,
					orderPaletteColors([...THREE_COLORS]),
					pattern,
				);
				const second = generateProcedural(pattern, {
					width,
					height,
					seed: 7,
					palette: [...THREE_COLORS],
				});
				check.deepEqual(
					[...second.pixels],
					[...first.pixels],
					`${pattern} rerun identical`,
				);
			},
		}),
	),
	{
		name: "different seeds change noise output",
		run(check) {
			const a = generateProcedural("noise", {
				width: 8,
				height: 8,
				seed: 1,
				palette: [...THREE_COLORS],
			});
			const b = generateProcedural("noise", {
				width: 8,
				height: 8,
				seed: 2,
				palette: [...THREE_COLORS],
			});
			check.ok(
				[...a.pixels].join(",") !== [...b.pixels].join(","),
				"noise differs across seeds",
			);
		},
	},
	{
		name: "stone 8x8 seed-7 goldens pin every pattern",
		run(check) {
			for (const pattern of GENERATE_PATTERNS) {
				const result = generateProcedural(pattern, {
					width: 8,
					height: 8,
					seed: 7,
					palette: STONE_PALETTE.map((color) => ({ ...color })),
				});
				check.equal(
					check.sha256Hex(result.pixels),
					STONE_GOLDENS[pattern],
					`${pattern} golden drifted`,
				);
			}
		},
	},
	{
		name: "generate rejects bad geometry and empty palette",
		run(check) {
			check.throwsCode(
				() =>
					generateProcedural("noise", {
						width: 0,
						height: 4,
						seed: 1,
						palette: [...THREE_COLORS],
					}),
				"INVALID_DIMENSION",
			);
			check.throwsCode(
				() =>
					generateProcedural("noise", {
						width: 4,
						height: 5000,
						seed: 1,
						palette: [...THREE_COLORS],
					}),
				"INVALID_DIMENSION",
			);
			check.throwsCode(
				() =>
					generateProcedural("noise", {
						width: 4,
						height: 4,
						seed: 1,
						palette: [],
					}),
				"INVALID_ARGUMENT",
			);
			try {
				generateProcedural("noise", {
					width: 4,
					height: 4,
					seed: 1,
					palette: [...THREE_COLORS],
				});
			} catch {
				check.fail("valid generate must not throw");
			}
			check.ok(McAssetError !== undefined, "errors module linked");
		},
	},
];
