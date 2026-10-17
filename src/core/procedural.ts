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
 * byte-identical on every runtime. This module draws no ambient randomness
 * and calls no transcendental functions.
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

/**
 * Non-negative modulo, the one wrap rule every tiling pattern shares:
 * neighbour cells, walker steps, and blob distances all index the canvas as a
 * torus, so both edges of a canvas sample the same field a tile boundary
 * would show when the canvas repeats.
 */
function torusIndex(value: number, limit: number): number {
	const wrapped = value % limit;
	return wrapped < 0 ? wrapped + limit : wrapped;
}

/**
 * Nearest-image distance around one axis: the distance to the nearest copy
 * of a position in a field that repeats every `limit` pixels, so a blob
 * near one edge reaches the opposite edge exactly like it reaches an
 * interior neighbour.
 */
function torusDistance(value: number, limit: number): number {
	const wrapped = value % limit;
	const magnitude = wrapped < 0 ? -wrapped : wrapped;
	const other = limit - magnitude;
	return magnitude < other ? magnitude : other;
}

/**
 * Phase that puts an alternating 0/1 run sequence of `run`-wide runs inside
 * a run at the axis boundary instead of on a run edge, so the first and the
 * last sample of the axis carry the same value. Searching shifts of the
 * frozen stream keeps the choice deterministic. Returns -1 when no shift
 * closes the axis, in which case the caller repeats the first sample.
 */
function closedRunPhase(
	length: number,
	run: number,
	seedPhase: number,
): number {
	for (let attempt = 0; attempt < run; attempt += 1) {
		const phase = (seedPhase + attempt) % run;
		const first = ((phase / run) | 0) % 2;
		const last = (((length - 1 + phase) / run) | 0) % 2;
		if (first === last) {
			return phase;
		}
	}
	return -1;
}

/** Closed 0/1 run sequence along one axis; see closedRunPhase. */
function closedRuns(
	length: number,
	run: number,
	seedPhase: number,
): Int32Array {
	const out = new Int32Array(length);
	const phase = closedRunPhase(length, run, seedPhase);
	const shift = phase < 0 ? 0 : phase;
	for (let i = 0; i < length; i += 1) {
		out[i] = (((i + shift) / run) | 0) % 2 === 0 ? 1 : 0;
	}
	if (phase < 0) {
		out[length - 1] = out[0] as number;
	}
	return out;
}

/**
 * Brick course geometry for one axis. A course height whose repeat divides
 * the axis leaves the boundary rows inside the same run of courses, so both
 * edge rows read the same course parity and neither one is a mortar row.
 * Search order is the preferred course first, then wider courses.
 */
function closedCourse(
	length: number,
	preferred: number,
): { course: number; phase: number } {
	const widest = preferred > 12 ? preferred : 12;
	const limit = length < widest ? length : widest;
	for (let course = preferred; course <= limit; course += 1) {
		for (let phase = 0; phase < course; phase += 1) {
			const firstMortar = phase % course === course - 1;
			const lastMortar = (length - 1 + phase) % course === course - 1;
			if (firstMortar || lastMortar) {
				continue;
			}
			const first = (phase / course) | 0;
			const last = ((length - 1 + phase) / course) | 0;
			if (last % 2 === first % 2) {
				return { course, phase };
			}
		}
	}
	return { course: preferred, phase: 0 };
}

/**
 * Brick geometry along one axis: brick width plus the phase of the straight
 * course and of the half-bond course. Both offsets have to place the
 * boundary column inside a brick and keep its brick index parity, so the
 * left and the right edge read the same colour in either course parity.
 */
function closedBond(
	length: number,
	preferred: number,
	seedShift: number,
): { brick: number; phase: number; shift: number } {
	const widest = preferred > 12 ? preferred : 12;
	const limit = length < widest ? length : widest;
	for (let brick = preferred; brick <= limit; brick += 1) {
		for (let phase = 0; phase < brick; phase += 1) {
			for (let step = 0; step < brick; step += 1) {
				const shift = (seedShift + step) % brick;
				if (
					brickEdgeCloses(length, brick, phase) &&
					brickEdgeCloses(length, brick, phase + shift)
				) {
					return { brick, phase, shift };
				}
			}
		}
	}
	return { brick: preferred, phase: 0, shift: seedShift % preferred };
}

/** True when the axis boundary lands on a brick face of the same parity. */
function brickEdgeCloses(
	length: number,
	brick: number,
	offset: number,
): boolean {
	const edge = (offset + length - 1) % brick;
	const start = offset % brick;
	if (edge === brick - 1 || start === brick - 1) {
		return false;
	}
	const edgeIndex = ((offset + length - 1) / brick) | 0;
	const startIndex = (offset / brick) | 0;
	return edgeIndex % 2 === startIndex % 2;
}

/**
 * Repeat the first canvas column into the last one and the first canvas row
 * into the last one. A pattern that stops at an edge — a blob rim, the tail
 * of a random walk — would cut the tile in half; repeating the origin sample
 * joins it instead, and the repeated pixel reads as one more step of the same
 * feature rather than as a border.
 */
function closeEdges(out: Int32Array, width: number, height: number): void {
	for (let y = 0; y < height; y += 1) {
		out[y * width + width - 1] = out[y * width] as number;
	}
	for (let x = 0; x < width; x += 1) {
		out[(height - 1) * width + x] = out[x] as number;
	}
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
			// Cluster cells wrap: the neighbour of the last column of cells is
			// the first one, so the field a tile boundary shows matches the
			// field an interior cell boundary shows.
			const cell = 4;
			const cellsX = ((width + cell - 1) / cell) | 0;
			const cellsY = ((height + cell - 1) / cell) | 0;
			const values = new Int32Array(cellsX * cellsY);
			for (let i = 0; i < values.length; i += 1) {
				values[i] = next() % 256;
			}
			const cluster = new Int32Array(cellsX * cellsY);
			for (let cy = 0; cy < cellsY; cy += 1) {
				const ny = (cy + 1) % cellsY;
				for (let cx = 0; cx < cellsX; cx += 1) {
					const nx = (cx + 1) % cellsX;
					const own = values[cy * cellsX + cx] as number;
					const right = values[cy * cellsX + nx] as number;
					const down = values[ny * cellsX + cx] as number;
					const diag = values[ny * cellsX + nx] as number;
					cluster[cy * cellsX + cx] = ((3 * own + right + down + diag) / 6) | 0;
				}
			}
			// Close the field: the last cell column repeats the first and the
			// last cell row repeats the first, so both canvas edges read the
			// same cluster value. A repeated cluster is the tile version of a
			// cluster that continues past the canvas edge.
			for (let cy = 0; cy < cellsY; cy += 1) {
				cluster[cy * cellsX + cellsX - 1] = cluster[cy * cellsX] as number;
			}
			for (let cx = 0; cx < cellsX; cx += 1) {
				cluster[(cellsY - 1) * cellsX + cx] = cluster[cx] as number;
			}
			for (let y = 0; y < height; y += 1) {
				const cy = (y / cell) | 0;
				for (let x = 0; x < width; x += 1) {
					out[y * width + x] = cluster[
						cy * cellsX + ((x / cell) | 0)
					] as number;
				}
			}
			break;
		}
		case "stripes": {
			const run = 2 + ((next() % 4) as number);
			const horizontal = (next() % 2) as number;
			const runs = closedRuns(horizontal === 1 ? height : width, run, run - 1);
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					out[y * width + x] =
						(horizontal === 1 ? (runs[y] as number) : (runs[x] as number)) === 1
							? 255
							: 0;
				}
			}
			break;
		}
		case "checker": {
			// Both axes carry a closed run sequence, so the checkerboard meets
			// itself on the left/right and the top/bottom edge as well.
			const run = 2 + ((next() % 3) as number);
			const columns = closedRuns(width, run, run - 1);
			const rows = closedRuns(height, run, run - 1);
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const odd = (((columns[x] as number) + (rows[y] as number)) %
						2) as number;
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
			// Courses and bricks are measured per canvas so both edges fall on a
			// brick face-free run; see closedCourse and closedBond.
			const seedShift = next();
			const course = closedCourse(height, 3);
			const bond = closedBond(width, 4, seedShift);
			for (let y = 0; y < height; y += 1) {
				if ((y + course.phase) % course.course === course.course - 1) {
					for (let x = 0; x < width; x += 1) {
						out[y * width + x] = 0;
					}
					continue;
				}
				const courseIndex = ((y + course.phase) / course.course) | 0;
				const offset = bond.phase + (courseIndex % 2 === 0 ? 0 : bond.shift);
				for (let x = 0; x < width; x += 1) {
					if ((x + offset) % bond.brick === bond.brick - 1) {
						out[y * width + x] = 0;
						continue;
					}
					const col = ((x + offset) / bond.brick) | 0;
					out[y * width + x] = (courseIndex + col) % 2 === 0 ? 255 : 170;
				}
			}
			break;
		}
		case "spots": {
			// Blob distance is measured on the canvas as a torus, so a blob
			// that sits against an edge continues on the opposite edge.
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
						const dx = torusDistance(x - (cx[i] as number), width);
						const dy = torusDistance(y - (cy[i] as number), height);
						const r = rr[i] as number;
						if (dx * dx + dy * dy <= r * r) {
							hit = shade[i] as number;
						}
					}
					out[y * width + x] = hit;
				}
			}
			closeEdges(out, width, height);
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
						x = torusIndex(x + 1, width);
					} else if (dir === 1) {
						x = torusIndex(x - 1, width);
					} else if (dir === 2) {
						y = torusIndex(y + 1, height);
					} else {
						y = torusIndex(y - 1, height);
					}
				}
			}
			closeEdges(out, width, height);
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
			// Two closed fields: each repeats the first sample at the far end so
			// the horizontal and the vertical edge both join their own origin.
			const base = new Int32Array(width);
			for (let x = 0; x + 1 < width; x += 1) {
				base[x] = next() % 256;
			}
			base[width - 1] = base[0] as number;
			const rows = new Int32Array(height);
			for (let y = 0; y + 1 < height; y += 1) {
				rows[y] = (y * 13) % 256;
			}
			rows[height - 1] = rows[0] as number;
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					out[y * width + x] =
						((base[x] as number) + (rows[y] as number)) % 256;
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
