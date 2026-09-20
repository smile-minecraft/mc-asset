import { McAssetError } from "./errors.ts";
import type { RGBA } from "./types.ts";
import { validateDimension } from "./validate.ts";

/**
 * Procedural generator starter (pending art-direction review).
 *
 * Ten CLI patterns synthesize a new swatch from an explicit palette plus a
 * required seed. Every pixel written is a member of the resolved palette
 * (taken in a fixed total order) or transparent; no intermediate colors are
 * ever invented. All arithmetic is integer, the only randomness is the
 * frozen xorshift32 stream derived from --seed, and output carries no
 * timestamps, so the same pattern/size/palette/seed/version is
 * byte-identical on every runtime. This module uses no Math.random and no
 * transcendental functions.
 */

/** Frozen CLI pattern names (docs §37 names map 1:1; blank becomes hyphen). */
export const GENERATE_PATTERNS = [
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
] as const;

export type GeneratePatternName = (typeof GENERATE_PATTERNS)[number];

/** --seed bounds (frozen): unsigned 32-bit integer. */
export const GENERATE_SEED_MIN = 0;
export const GENERATE_SEED_MAX = 4294967295;

/** Seed mixing constant from the frozen PRNG definition. */
const XORSHIFT_SEED_XOR = 0x9e3779b9;

/** Transparent pixel marker: allowed alongside palette members. */
const TRANSPARENT_INTENSITY = -1;

function isPatternName(value: unknown): value is GeneratePatternName {
	return (
		typeof value === "string" &&
		(GENERATE_PATTERNS as readonly string[]).includes(value)
	);
}

/** Unknown pattern names are INVALID_ARGUMENT with the offending name. */
export function parseGeneratePattern(raw: unknown): GeneratePatternName {
	if (isPatternName(raw)) {
		return raw;
	}
	throw new McAssetError(
		"INVALID_ARGUMENT",
		`Unknown pattern "${String(raw)}". Generate patterns: ${GENERATE_PATTERNS.join(", ")}.`,
		{ pattern: raw },
	);
}

/**
 * Parse --seed: required unsigned 32-bit integer. Missing, non-integer, or
 * out-of-range values are INVALID_ARGUMENT (never a silent default).
 */
export function parseGenerateSeed(raw: string | undefined): number {
	if (raw === undefined || raw === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--seed is required (an integer in [0, 4294967295]).",
			{ seed: raw },
		);
	}
	if (!/^[0-9]+$/.test(raw)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--seed must be an integer in [0, 4294967295], got "${raw}".`,
			{ seed: raw },
		);
	}
	const parsed = Number(raw);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < GENERATE_SEED_MIN ||
		parsed > GENERATE_SEED_MAX
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--seed must be an integer in [0, 4294967295], got "${raw}".`,
			{ seed: raw },
		);
	}
	return parsed;
}

/**
 * Frozen starter PRNG: 32-bit xorshift seeded with (seed ^ 0x9E3779B9).
 * Each draw applies x ^= x << 13; x ^= x >>> 17; x ^= x << 5 (masked to
 * 32 bits) and returns the unsigned state. Same seed always yields the
 * same draw sequence on every runtime.
 */
export function createXorshift32(seed: number): () => number {
	let state = (seed ^ XORSHIFT_SEED_XOR) >>> 0;
	return (): number => {
		state = (state ^ (state << 13)) >>> 0;
		state = (state ^ (state >>> 17)) >>> 0;
		state = (state ^ (state << 5)) >>> 0;
		return state;
	};
}

function luminanceKey(color: RGBA): number {
	return 299 * color.r + 587 * color.g + 114 * color.b;
}

function compareColor(a: RGBA, b: RGBA): number {
	const lum = luminanceKey(a) - luminanceKey(b);
	if (lum !== 0) {
		return lum < 0 ? -1 : 1;
	}
	if (a.r !== b.r) {
		return a.r < b.r ? -1 : 1;
	}
	if (a.g !== b.g) {
		return a.g < b.g ? -1 : 1;
	}
	if (a.b !== b.b) {
		return a.b < b.b ? -1 : 1;
	}
	if (a.a !== b.a) {
		return a.a < b.a ? -1 : 1;
	}
	return 0;
}

/**
 * Fixed total order for palette lookup: luminance ascending (integer
 * 299/587/114 weights, no division), ties broken by r, g, b, a. Patterns
 * map intensity bands onto this order, so the same palette always yields
 * the same index assignment regardless of entry order.
 */
export function orderPaletteColors(colors: RGBA[]): RGBA[] {
	const copy = colors.map((color) => ({ ...color }));
	copy.sort(compareColor);
	return copy;
}

export interface GenerateProceduralOptions {
	width: number;
	height: number;
	seed: number;
	palette: RGBA[];
}

export interface GenerateProceduralResult {
	pixels: Uint8Array;
	width: number;
	height: number;
}

/** Map an integer intensity in [0, 255] onto the ordered palette. */
function indexForIntensity(intensity: number, count: number): number {
	const clamped = intensity < 0 ? 0 : intensity > 255 ? 255 : intensity;
	return (((clamped * count) / 256) | 0) >= count
		? count - 1
		: ((clamped * count) / 256) | 0;
}

function paintIntensities(
	ordered: RGBA[],
	intensities: Int32Array,
): Uint8Array {
	const pixels = new Uint8Array(intensities.length * 4);
	for (let i = 0; i < intensities.length; i += 1) {
		const intensity = intensities[i] as number;
		const offset = i * 4;
		if (intensity === TRANSPARENT_INTENSITY) {
			pixels[offset] = 0;
			pixels[offset + 1] = 0;
			pixels[offset + 2] = 0;
			pixels[offset + 3] = 0;
			continue;
		}
		const color = ordered[indexForIntensity(intensity, ordered.length)] as RGBA;
		pixels[offset] = color.r;
		pixels[offset + 1] = color.g;
		pixels[offset + 2] = color.b;
		pixels[offset + 3] = color.a;
	}
	return pixels;
}

function paintSlots(ordered: RGBA[], slots: Int32Array): Uint8Array {
	const pixels = new Uint8Array(slots.length * 4);
	for (let i = 0; i < slots.length; i += 1) {
		const slot = slots[i] as number;
		const color = ordered[
			slot < 0 ? 0 : slot >= ordered.length ? ordered.length - 1 : slot
		] as RGBA;
		const offset = i * 4;
		pixels[offset] = color.r;
		pixels[offset + 1] = color.g;
		pixels[offset + 2] = color.b;
		pixels[offset + 3] = color.a;
	}
	return pixels;
}

/**
 * Starter sampler per pattern: one value per pixel in row-major order.
 * Noise entries are palette slots; every other pattern yields an
 * intensity in [0, 255] (TRANSPARENT_INTENSITY writes #00000000).
 * All branches are integer; the stream is consumed in a fixed order.
 */
function samplePattern(
	pattern: GeneratePatternName,
	width: number,
	height: number,
	paletteSize: number,
	next: () => number,
): Int32Array {
	const count = width * height;
	const out = new Int32Array(count);
	switch (pattern) {
		case "noise": {
			// Noise picks palette slots directly from the stream; the
			// caller paints slots (not intensities) for this pattern.
			for (let i = 0; i < count; i += 1) {
				out[i] = next() % paletteSize;
			}
			break;
		}
		case "clustered-noise": {
			const cell = 4;
			const cellsX = ((width + cell - 1) / cell) | 0;
			const cellsY = ((height + cell - 1) / cell) | 0;
			const values = new Int32Array(cellsX * cellsY);
			for (let i = 0; i < values.length; i += 1) {
				values[i] = next() % 256;
			}
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const cx = (x / cell) | 0;
					const cy = (y / cell) | 0;
					const nx = cx + 1 < cellsX ? cx + 1 : cx;
					const ny = cy + 1 < cellsY ? cy + 1 : cy;
					const own = values[cy * cellsX + cx] as number;
					const right = values[cy * cellsX + nx] as number;
					const down = values[ny * cellsX + cx] as number;
					const diag = values[ny * cellsX + nx] as number;
					out[y * width + x] = ((3 * own + right + down + diag) / 6) | 0;
				}
			}
			break;
		}
		case "stripes": {
			const period = 2 + ((next() % 4) as number);
			const horizontal = (next() % 2) as number;
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const pos = horizontal === 1 ? y : x;
					out[y * width + x] = ((pos / period) | 0) % 2 === 0 ? 255 : 0;
				}
			}
			break;
		}
		case "checker": {
			const size = 2 + ((next() % 3) as number);
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const odd = ((((x / size) | 0) + ((y / size) | 0)) % 2) as number;
					out[y * width + x] = odd === 0 ? 255 : 0;
				}
			}
			break;
		}
		case "gradient": {
			const vertical = (next() % 2) as number;
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					if (vertical === 1) {
						out[y * width + x] =
							height > 1 ? ((y * 255) / (height - 1)) | 0 : 128;
					} else {
						out[y * width + x] =
							width > 1 ? ((x * 255) / (width - 1)) | 0 : 128;
					}
				}
			}
			break;
		}
		case "brick": {
			const courseH = 3;
			const brickW = 4;
			const shift = (next() % brickW) as number;
			for (let y = 0; y < height; y += 1) {
				const course = (y / courseH) | 0;
				for (let x = 0; x < width; x += 1) {
					if (y % courseH === courseH - 1) {
						out[y * width + x] = 0;
						continue;
					}
					const shifted = x + (course % 2 === 0 ? 0 : shift);
					if (shifted % brickW === brickW - 1) {
						out[y * width + x] = 0;
						continue;
					}
					const col = (shifted / brickW) | 0;
					out[y * width + x] = (course + col) % 2 === 0 ? 255 : 170;
				}
			}
			break;
		}
		case "spots": {
			const blobs = 3 + ((next() % 4) as number);
			const cx = new Int32Array(blobs);
			const cy = new Int32Array(blobs);
			const rr = new Int32Array(blobs);
			const shade = new Int32Array(blobs);
			for (let i = 0; i < blobs; i += 1) {
				cx[i] = next() % width;
				cy[i] = next() % height;
				rr[i] = 1 + ((next() % 3) as number);
				shade[i] = 255 - ((i * 53) % 156);
			}
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					let hit = TRANSPARENT_INTENSITY;
					for (let i = 0; i < blobs; i += 1) {
						const dx = x - (cx[i] as number);
						const dy = y - (cy[i] as number);
						const r = rr[i] as number;
						if (dx * dx + dy * dy <= r * r) {
							hit = shade[i] as number;
						}
					}
					out[y * width + x] = hit;
				}
			}
			break;
		}
		case "veins": {
			out.fill(0);
			const walkers = 2 + ((next() % 2) as number);
			const steps = width * height;
			for (let v = 0; v < walkers; v += 1) {
				let x = next() % width;
				let y = next() % height;
				for (let s = 0; s < steps; s += 1) {
					out[y * width + x] = 255;
					const dir = next() % 4;
					if (dir === 0) {
						x = x + 1 < width ? x + 1 : x;
					} else if (dir === 1) {
						x = x - 1 >= 0 ? x - 1 : x;
					} else if (dir === 2) {
						y = y + 1 < height ? y + 1 : y;
					} else {
						y = y - 1 >= 0 ? y - 1 : y;
					}
				}
			}
			break;
		}
		case "cracks": {
			out.fill(128);
			const walkers = 1 + ((next() % 2) as number);
			const steps = ((width * height) / 2) | 0;
			for (let v = 0; v < walkers; v += 1) {
				let x = next() % width;
				let y = next() % height;
				for (let s = 0; s < steps; s += 1) {
					out[y * width + x] = 0;
					const dir = next() % 4;
					if (dir === 0) {
						x = x + 1 < width ? x + 1 : 0;
						y = y + 1 < height ? y + 1 : 0;
					} else if (dir === 1) {
						x = x + 1 < width ? x + 1 : 0;
						y = y - 1 >= 0 ? y - 1 : height - 1;
					} else if (dir === 2) {
						x = x - 1 >= 0 ? x - 1 : width - 1;
						y = y + 1 < height ? y + 1 : 0;
					} else {
						x = x - 1 >= 0 ? x - 1 : width - 1;
						y = y - 1 >= 0 ? y - 1 : height - 1;
					}
				}
			}
			break;
		}
		case "grain": {
			const base = new Int32Array(width);
			for (let x = 0; x < width; x += 1) {
				base[x] = next() % 256;
			}
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					out[y * width + x] = ((base[x] as number) + y * 13) % 256;
				}
			}
			break;
		}
	}
	return out;
}

/**
 * Synthesize a width x height swatch for the pattern. The palette is read
 * but never reordered by the caller: lookup always goes through the fixed
 * total order, so entry order cannot affect output.
 */
export function generateProcedural(
	pattern: GeneratePatternName,
	options: GenerateProceduralOptions,
): GenerateProceduralResult {
	const { width, height, seed, palette } = options;
	validateDimension(width);
	validateDimension(height);
	if (
		!Number.isSafeInteger(seed) ||
		seed < GENERATE_SEED_MIN ||
		seed > GENERATE_SEED_MAX
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--seed must be an integer in [${GENERATE_SEED_MIN}, ${GENERATE_SEED_MAX}].`,
			{ seed },
		);
	}
	if (palette.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Generate needs at least one palette color.",
		);
	}
	const ordered = orderPaletteColors(palette);
	const next = createXorshift32(seed);
	const sampled = samplePattern(pattern, width, height, ordered.length, next);
	const pixels =
		pattern === "noise"
			? paintSlots(ordered, sampled)
			: paintIntensities(ordered, sampled);
	return {
		pixels,
		width,
		height,
	};
}
