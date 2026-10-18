import { McAssetError } from "../core/errors.ts";
import type { PixelCanvas } from "../core/types.ts";

/**
 * Silhouette family audit across a texture group: per-pair mask overlap
 * (per mille), palette overlap (per mille), size drift, and the ordered
 * findings the caller surfaces. Thresholds freeze here: silhouette 800,
 * palette 500.
 */

export interface FamilyAuditInput {
	readonly inputs: readonly PixelCanvas[];
	readonly names: readonly string[];
	readonly baselinePath?: string | undefined;
}

export interface FamilyPairOverlap {
	readonly left: string;
	readonly right: string;
	readonly overlapPermille: number;
	readonly paletteOverlapPermille: number;
}

export interface FamilyAuditReport {
	readonly baseline: string;
	readonly sizes: Readonly<Record<string, { width: number; height: number }>>;
	readonly sizeDrift: readonly string[];
	readonly pairs: readonly FamilyPairOverlap[];
	readonly minOverlapPermille: number;
	readonly minPaletteOverlapPermille: number;
	readonly commonColors: readonly string[];
	readonly findings: readonly { code: string; message: string }[];
}

const SILHOUETTE_THRESHOLD_PERMILLE = 800;
const PALETTE_THRESHOLD_PERMILLE = 500;

function hexByte(n: number): string {
	return n.toString(16).padStart(2, "0").toUpperCase();
}

function hexColor(r: number, g: number, b: number): string {
	return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
}

/** Collect distinct opaque `#RRGGBB` colors from a canvas. */
function collectOpaqueColors(canvas: PixelCanvas): Set<string> {
	const colors = new Set<string>();
	const pixels = canvas.layers[0]?.pixels;
	if (pixels === undefined) {
		return colors;
	}
	for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
		const a = pixels[offset + 3] as number;
		if (a === 255) {
			const r = pixels[offset] as number;
			const g = pixels[offset + 1] as number;
			const b = pixels[offset + 2] as number;
			colors.add(hexColor(r, g, b));
		}
	}
	return colors;
}

/** Audit one texture group; sizes, masks, and palettes all compare. */
export function auditTextureFamily(input: FamilyAuditInput): FamilyAuditReport {
	const { inputs, names } = input;
	if (inputs.length < 2) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Family audit requires at least two inputs.",
		);
	}
	if (inputs.length > 256) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Family audit accepts at most 256 inputs.",
		);
	}
	const baseline = input.baselinePath ?? names[0] ?? "";
	const baseIndex = names.indexOf(baseline);
	if (baseIndex < 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Baseline "${baseline}" must be one of the inputs.`,
			{ baseline },
		);
	}

	const baseCanvas = inputs[baseIndex] as PixelCanvas;
	const baseW = baseCanvas.width;
	const baseH = baseCanvas.height;

	const sizes: Record<string, { width: number; height: number }> = {};
	const sizeDrift: string[] = [];

	for (let i = 0; i < inputs.length; i += 1) {
		const canvas = inputs[i] as PixelCanvas;
		const name = names[i] as string;
		sizes[name] = { width: canvas.width, height: canvas.height };
		if (canvas.width !== baseW || canvas.height !== baseH) {
			sizeDrift.push(name);
		}
	}

	const opaqueSets: Set<string>[] = inputs.map(collectOpaqueColors);

	// Common colors across all inputs
	let commonSet: Set<string> | undefined;
	for (const set of opaqueSets) {
		if (commonSet === undefined) {
			commonSet = new Set(set);
		} else {
			for (const color of commonSet) {
				if (!set.has(color)) {
					commonSet.delete(color);
				}
			}
		}
	}
	const commonColors = [...(commonSet ?? [])].sort();

	const pairs: FamilyPairOverlap[] = [];

	for (let i = 0; i < inputs.length; i += 1) {
		const leftCanvas = inputs[i] as PixelCanvas;
		const leftName = names[i] as string;
		const leftPixels = leftCanvas.layers[0]?.pixels;
		const leftColors = opaqueSets[i] as Set<string>;

		for (let j = i + 1; j < inputs.length; j += 1) {
			const rightCanvas = inputs[j] as PixelCanvas;
			const rightName = names[j] as string;
			const rightPixels = rightCanvas.layers[0]?.pixels;
			const rightColors = opaqueSets[j] as Set<string>;

			// Silhouette overlap
			let overlapPermille = 0;
			if (
				leftCanvas.width === rightCanvas.width &&
				leftCanvas.height === rightCanvas.height &&
				leftPixels !== undefined &&
				rightPixels !== undefined
			) {
				let intersection = 0;
				let union = 0;
				for (let offset = 3; offset < leftPixels.length; offset += 4) {
					const leftOpaque = (leftPixels[offset] as number) === 255;
					const rightOpaque = (rightPixels[offset] as number) === 255;
					if (leftOpaque && rightOpaque) intersection += 1;
					if (leftOpaque || rightOpaque) union += 1;
				}
				overlapPermille =
					union === 0 ? 1000 : Math.floor((intersection * 1000) / union);
			}

			// Palette overlap
			let colorIntersection = 0;
			for (const c of leftColors) {
				if (rightColors.has(c)) colorIntersection += 1;
			}
			const colorUnion = leftColors.size + rightColors.size - colorIntersection;
			const paletteOverlapPermille =
				colorUnion === 0
					? 1000
					: Math.floor((colorIntersection * 1000) / colorUnion);

			pairs.push({
				left: leftName,
				right: rightName,
				overlapPermille,
				paletteOverlapPermille,
			});
		}
	}

	let minOverlapPermille = 1000;
	let minPaletteOverlapPermille = 1000;
	for (const p of pairs) {
		if (p.overlapPermille < minOverlapPermille) {
			minOverlapPermille = p.overlapPermille;
		}
		if (p.paletteOverlapPermille < minPaletteOverlapPermille) {
			minPaletteOverlapPermille = p.paletteOverlapPermille;
		}
	}

	const findings: { code: string; message: string }[] = [];
	if (sizeDrift.length > 0) {
		findings.push({
			code: "STYLE_FAMILY_SIZE_DRIFT",
			message: `Inputs differ in dimensions from baseline (${baseW}x${baseH}): ${sizeDrift.join(", ")}.`,
		});
	}
	if (minOverlapPermille < SILHOUETTE_THRESHOLD_PERMILLE) {
		findings.push({
			code: "STYLE_FAMILY_SILHOUETTE_DRIFT",
			message: `Minimum silhouette overlap (${minOverlapPermille}‰) is below the ${SILHOUETTE_THRESHOLD_PERMILLE}‰ threshold.`,
		});
	}
	if (minPaletteOverlapPermille < PALETTE_THRESHOLD_PERMILLE) {
		findings.push({
			code: "STYLE_FAMILY_PALETTE_DRIFT",
			message: `Minimum palette overlap (${minPaletteOverlapPermille}‰) is below the ${PALETTE_THRESHOLD_PERMILLE}‰ threshold.`,
		});
	}

	return {
		baseline,
		sizes,
		sizeDrift,
		pairs,
		minOverlapPermille,
		minPaletteOverlapPermille,
		commonColors,
		findings,
	};
}
