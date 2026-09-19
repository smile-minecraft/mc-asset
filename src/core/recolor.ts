import { getLayer, getRegion } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import { findPaletteEntryByRole, getMaterial } from "./material.ts";
import type {
	AuthoringPalette,
	PaletteRole,
	PixelCanvas,
	RGBA,
} from "./types.ts";
import { assertValidCanvas } from "./validate.ts";

/**
 * Region-aware, palette role-aware, luminance-aware recolor engine.
 *
 * Role mapping (frozen): shadow/dark go to the target shadow, base goes to
 * the target base, light/highlight go to the target highlight.
 * Outline, accent, and custom pixels are kept verbatim.
 *
 * Without a source role the integer luminance band decides:
 * below 96 is shadow, 96-159 is base, 160 and above is highlight.
 * Luminance is pure integer math: (299r + 587g + 114b) / 1000 truncated.
 *
 * Every written pixel copies the target palette entry verbatim (alpha
 * included), so output pixels are always palette members and no blended
 * intermediate colors are produced. Fully transparent pixels (A = 0) are
 * never written: their bytes, including hidden RGB, stay identical, so
 * transparent backgrounds and silhouettes survive a recolor. Pixels
 * outside the region keep their bytes, and the region mask is never
 * modified. Traversal is row-major, so repeated runs are byte-identical.
 */

export type RecolorBand = "shadow" | "base" | "highlight";

export interface RecolorOptions {
	regionId?: string;
	sourcePalette?: AuthoringPalette;
}

export interface RecolorReport {
	pixelsChanged: number;
}

/** Integer luminance in [0, 255]; alpha plays no part. */
export function luminanceOf(color: RGBA): number {
	const scaled = 299 * color.r + 587 * color.g + 114 * color.b;
	return (scaled - (scaled % 1000)) / 1000;
}

export function bandForLuminance(luminance: number): RecolorBand {
	if (luminance < 96) {
		return "shadow";
	}
	if (luminance < 160) {
		return "base";
	}
	return "highlight";
}

/** Role to target band. Outline, accent, and custom resolve to keep. */
export function mapRoleToBand(role: PaletteRole): RecolorBand | "keep" {
	if (role === "shadow" || role === "dark") {
		return "shadow";
	}
	if (role === "base") {
		return "base";
	}
	if (role === "light" || role === "highlight") {
		return "highlight";
	}
	return "keep";
}

function bandColor(
	targetPalette: AuthoringPalette,
	materialId: string,
	band: RecolorBand,
): RGBA {
	const found = findPaletteEntryByRole(targetPalette, band);
	if (found === undefined) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			"Target material palette misses a band entry.",
			{ materialId, band },
		);
	}
	return { ...found.color };
}

/**
 * Pure single-pixel recolor. An explicit source role wins over luminance;
 * a keep role returns the source color unchanged. Fully transparent
 * colors are always returned unchanged.
 */
export function recolorColor(
	color: RGBA,
	sourceRole: PaletteRole | undefined,
	targetMaterialId: string,
): RGBA {
	if (color.a === 0) {
		return { ...color };
	}
	const target = getMaterial(targetMaterialId);
	if (sourceRole !== undefined) {
		const band = mapRoleToBand(sourceRole);
		if (band === "keep") {
			return { ...color };
		}
		return bandColor(target.palette, target.id, band);
	}
	return bandColor(
		target.palette,
		target.id,
		bandForLuminance(luminanceOf(color)),
	);
}

function roleIndex(
	sourcePalette: AuthoringPalette | undefined,
): Map<string, PaletteRole | undefined> {
	const index = new Map<string, PaletteRole | undefined>();
	if (sourcePalette === undefined) {
		return index;
	}
	for (const item of sourcePalette.entries) {
		const signature = `${item.color.r},${item.color.g},${item.color.b},${item.color.a}`;
		if (!index.has(signature)) {
			index.set(signature, item.role);
		}
	}
	return index;
}

export function recolorLayer(
	canvas: PixelCanvas,
	layerId: string,
	targetMaterialId: string,
	options?: RecolorOptions,
): RecolorReport {
	assertValidCanvas(canvas);
	const layer = getLayer(canvas, layerId);
	const target = getMaterial(targetMaterialId);
	const region =
		options?.regionId !== undefined
			? getRegion(canvas, options.regionId)
			: undefined;
	const roles = roleIndex(
		options?.sourcePalette !== undefined
			? options.sourcePalette
			: canvas.palette,
	);
	const shadow = bandColor(target.palette, target.id, "shadow");
	const base = bandColor(target.palette, target.id, "base");
	const highlight = bandColor(target.palette, target.id, "highlight");
	const width = canvas.width;
	const height = canvas.height;
	let pixelsChanged = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const cell = y * width + x;
			if (region !== undefined && region.mask[cell] !== 1) {
				continue;
			}
			const offset = cell * 4;
			const r = layer.pixels[offset] as number;
			const g = layer.pixels[offset + 1] as number;
			const blue = layer.pixels[offset + 2] as number;
			const a = layer.pixels[offset + 3] as number;
			if (a === 0) {
				continue;
			}
			const role = roles.get(`${r},${g},${blue},${a}`);
			let out: RGBA | undefined;
			if (role === undefined) {
				const band = bandForLuminance(luminanceOf({ r, g, b: blue, a }));
				out = band === "shadow" ? shadow : band === "base" ? base : highlight;
			} else {
				const band = mapRoleToBand(role);
				if (band === "keep") {
					continue;
				}
				out = band === "shadow" ? shadow : band === "base" ? base : highlight;
			}
			if (out.r !== r || out.g !== g || out.b !== blue || out.a !== a) {
				layer.pixels[offset] = out.r;
				layer.pixels[offset + 1] = out.g;
				layer.pixels[offset + 2] = out.b;
				layer.pixels[offset + 3] = out.a;
				pixelsChanged += 1;
			}
		}
	}
	return { pixelsChanged };
}
