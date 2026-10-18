import { PRESET_PALETTES, VANILLA_PALETTE } from "../style/palette.ts";
import {
	FAMILY_ROLES,
	STYLE_PRESET_IDS,
	type StylePresetId,
} from "../style/types.ts";
import { getLayer, getRegion } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import { findPaletteEntryByRole, getMaterial } from "./material.ts";
import { bodyMaskOf, insideOutlineCells } from "./outline.ts";
import { evaluateSelectionExpr, type SelectionExpr } from "./selection.ts";
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

export type FamilyRole =
	| "outline"
	| "shadow"
	| "dark"
	| "base"
	| "light"
	| "highlight";

/**
 * Options of the family recolor path. `ramp` carries a caller-resolved
 * family ramp (typo-free hex strings or RGBA values) whose missing roles
 * are completed in the core; when no ramp is passed, `style` selects the
 * builtin table a family id is looked up in (vanilla by default, style
 * files stay a caller-side concern).
 */
export interface FamilyRecolorOptions {
	regionId?: string;
	selection?: SelectionExpr;
	preserveRegions?: string[];
	preserveRoles?: PaletteRole[];
	sourcePalette?: AuthoringPalette;
	ramp?: Partial<Record<FamilyRole, RGBA | string>>;
	style?: string;
}

/**
 * Six-band integer luminance mapping for the family path. Values:
 * below 43 outline, 43-85 shadow, 86-127 dark, 128-170 base, 171-213 light,
 * 214 and above highlight.
 */
export function familyRoleForLuminance(luminance: number): FamilyRole {
	if (luminance < 43) {
		return "outline";
	}
	if (luminance < 86) {
		return "shadow";
	}
	if (luminance < 128) {
		return "dark";
	}
	if (luminance < 171) {
		return "base";
	}
	if (luminance < 214) {
		return "light";
	}
	return "highlight";
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

/**
 * Role-less canvas recolor entry for flat raster sources (e.g. PNG).
 * Pure integer luminance bands (<96 shadow, 96-159 base, >=160 highlight).
 * Transparent pixels (A = 0) and their hidden RGB are strictly preserved.
 * Never invents layer roles or palette entries.
 */
export function recolorRolelessCanvas(
	canvas: PixelCanvas,
	targetMaterialId: string,
	options?: RecolorOptions,
): RecolorReport {
	assertValidCanvas(canvas);
	const target = getMaterial(targetMaterialId);
	const region =
		options?.regionId !== undefined
			? getRegion(canvas, options.regionId)
			: undefined;
	const shadow = bandColor(target.palette, target.id, "shadow");
	const base = bandColor(target.palette, target.id, "base");
	const highlight = bandColor(target.palette, target.id, "highlight");
	const width = canvas.width;
	const height = canvas.height;
	let pixelsChanged = 0;
	for (const layer of canvas.layers) {
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
				const band = bandForLuminance(luminanceOf({ r, g, b: blue, a }));
				const out =
					band === "shadow" ? shadow : band === "base" ? base : highlight;
				if (out.r !== r || out.g !== g || out.b !== blue || out.a !== a) {
					layer.pixels[offset] = out.r;
					layer.pixels[offset + 1] = out.g;
					layer.pixels[offset + 2] = out.b;
					layer.pixels[offset + 3] = out.a;
					pixelsChanged += 1;
				}
			}
		}
	}
	return { pixelsChanged };
}

/** One family ramp resolved to six opaque RGBA roles. */
type ResolvedFamilyRamp = Record<FamilyRole, RGBA>;

/** Write scope of one family call: region, selection, and preserved regions. */
interface FamilyWriteScope {
	readonly region: Uint8Array | undefined;
	readonly selection: Uint8Array | undefined;
	readonly preserved: readonly Uint8Array[];
}

const FAMILY_ROLE_SET: ReadonlySet<string> = new Set(FAMILY_ROLES);

function truncDiv(dividend: number, divisor: number): number {
	return Math.trunc(dividend / divisor);
}

function clampByte(value: number): number {
	if (value < 0) {
		return 0;
	}
	if (value > 255) {
		return 255;
	}
	return value;
}

interface RampHsl {
	readonly lightness: number;
	readonly saturation: number;
	readonly delta: number;
}

/** Integer HSL lightness, saturation, and delta of one ramp color. */
function rampColorHsl(color: RGBA): RampHsl {
	const max = Math.max(color.r, color.g, color.b);
	const min = Math.min(color.r, color.g, color.b);
	const delta = max - min;
	const lightness = truncDiv(max + min, 2);
	const saturation =
		delta === 0
			? 0
			: Math.min(
					255,
					truncDiv(delta * 255, 255 - Math.abs(2 * lightness - 255)),
				);
	return { lightness, saturation, delta };
}

/**
 * Move a color to another lightness and saturation while its channels carry
 * the hue. A neutral source (delta 0) has no hue, so every channel becomes
 * the target lightness. Integer math only, so both runtimes agree.
 */
function moveToLightnessSaturation(
	source: RGBA,
	targetLightness: number,
	targetSaturation: number,
): RGBA {
	const { lightness, delta } = rampColorHsl(source);
	if (delta === 0) {
		return {
			r: targetLightness,
			g: targetLightness,
			b: targetLightness,
			a: 255,
		};
	}
	const targetDelta = truncDiv(
		targetSaturation * (255 - Math.abs(2 * targetLightness - 255)),
		255,
	);
	const channel = (value: number): number =>
		clampByte(
			targetLightness + truncDiv((value - lightness) * targetDelta, delta),
		);
	return {
		r: channel(source.r),
		g: channel(source.g),
		b: channel(source.b),
		a: 255,
	};
}

/** One ramp entry: an RGBA value is copied, `#RRGGBB` parses to opaque. */
function parseRampColor(role: FamilyRole, value: RGBA | string): RGBA {
	if (typeof value !== "string") {
		return { ...value };
	}
	const match = /^#([0-9A-Fa-f]{6})$/.exec(value);
	if (match === null || match[1] === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Family ramp colors are #RRGGBB strings or RGBA values.",
			{ role, value },
		);
	}
	const hex = match[1];
	return {
		r: Number.parseInt(hex.slice(0, 2), 16),
		g: Number.parseInt(hex.slice(2, 4), 16),
		b: Number.parseInt(hex.slice(4, 6), 16),
		a: 255,
	};
}

/**
 * Complete a partial family ramp: rules 1 to 5 in order, each deriving from
 * the roles already present. `base` cannot be derived, so a ramp without it
 * is INVALID_ARGUMENT; a ramp with no role at all cannot derive anything.
 */
function completeFamilyRamp(
	partial: Partial<Record<FamilyRole, RGBA>>,
	family: string,
): ResolvedFamilyRamp {
	const outline = partial.outline ?? deriveRampOutline(partial, family);
	const shadow = partial.shadow ?? deriveRampShadow(partial, outline, family);
	const base = partial.base;
	if (base === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Family ramp needs a base color to complete its missing roles.",
			{ family },
		);
	}
	const dark = partial.dark ?? scaleRampRole(base, 80, undefined);
	const light = partial.light ?? scaleRampRole(base, 120, undefined);
	const highlight = partial.highlight ?? scaleRampRole(light, 130, 600);
	return { outline, shadow, dark, base, light, highlight };
}

/** Rule 1: darkest present role, 60% lightness and 94% saturation. */
function deriveRampOutline(
	partial: Partial<Record<FamilyRole, RGBA>>,
	family: string,
): RGBA {
	let darkest: RGBA | undefined;
	let darkestLightness = Number.POSITIVE_INFINITY;
	for (const role of FAMILY_ROLES) {
		const value = partial[role];
		if (value === undefined) {
			continue;
		}
		const lightness = rampColorHsl(value).lightness;
		if (lightness < darkestLightness) {
			darkest = value;
			darkestLightness = lightness;
		}
	}
	if (darkest === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Family ramp needs at least one role to derive its outline from.",
			{ family },
		);
	}
	const { lightness, saturation } = rampColorHsl(darkest);
	return moveToLightnessSaturation(
		darkest,
		clampByte(truncDiv(lightness * 60, 100)),
		Math.min(255, truncDiv(saturation * 940, 1000)),
	);
}

/** Rule 2: reference role dark (or base), midpoint lightness with the outline. */
function deriveRampShadow(
	partial: Partial<Record<FamilyRole, RGBA>>,
	outline: RGBA,
	family: string,
): RGBA {
	const reference = partial.dark ?? partial.base;
	if (reference === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Family ramp needs a base or dark color to derive its shadow.",
			{ family },
		);
	}
	const referenceHsl = rampColorHsl(reference);
	return moveToLightnessSaturation(
		reference,
		clampByte(
			truncDiv(rampColorHsl(outline).lightness + referenceHsl.lightness, 2),
		),
		referenceHsl.saturation,
	);
}

/** Rules 3 to 5: scale one role's lightness (percent) and saturation. */
function scaleRampRole(
	source: RGBA,
	lightnessPercent: number,
	saturationPermille: number | undefined,
): RGBA {
	const { lightness, saturation } = rampColorHsl(source);
	const targetSaturation =
		saturationPermille === undefined
			? saturation
			: Math.min(255, truncDiv(saturation * saturationPermille, 1000));
	return moveToLightnessSaturation(
		source,
		clampByte(truncDiv(lightness * lightnessPercent, 100)),
		targetSaturation,
	);
}

/** The builtin table a family id is looked up in when no ramp is passed. */
function defaultFamilyTable(
	style: string | undefined,
): Readonly<Record<string, Partial<Record<FamilyRole, string>> | undefined>> {
	if (style === undefined || style === "") {
		return VANILLA_PALETTE as Readonly<
			Record<string, Partial<Record<FamilyRole, string>> | undefined>
		>;
	}
	if ((STYLE_PRESET_IDS as readonly string[]).includes(style)) {
		return PRESET_PALETTES[style as StylePresetId] as Readonly<
			Record<string, Partial<Record<FamilyRole, string>> | undefined>
		>;
	}
	throw new McAssetError(
		"INVALID_ARGUMENT",
		"Family recolor resolves style sources at the caller; pass the resolved family ramp instead of a style path.",
		{ style },
	);
}

/**
 * Resolve the target family ramp. An explicit ramp wins and its missing
 * roles are completed; otherwise the style's builtin table answers, and a
 * family outside it is STYLE_FAMILY_NOT_FOUND. Style files themselves are
 * resolved by the caller, which passes the resolved ramp in.
 */
function resolveFamilyRamp(
	family: string,
	options?: FamilyRecolorOptions,
): ResolvedFamilyRamp {
	if (options?.ramp !== undefined) {
		const partial: Partial<Record<FamilyRole, RGBA>> = {};
		for (const role of FAMILY_ROLES) {
			const value = options.ramp[role];
			if (value !== undefined) {
				partial[role] = parseRampColor(role, value);
			}
		}
		return completeFamilyRamp(partial, family);
	}
	const entry = defaultFamilyTable(options?.style)[family];
	if (entry === undefined) {
		throw new McAssetError(
			"STYLE_FAMILY_NOT_FOUND",
			`Family ${family} is not defined in the resolved style.`,
			{ family },
		);
	}
	const partial: Partial<Record<FamilyRole, RGBA>> = {};
	for (const role of FAMILY_ROLES) {
		const value = entry[role];
		if (value !== undefined) {
			partial[role] = parseRampColor(role, value);
		}
	}
	return completeFamilyRamp(partial, family);
}

/**
 * Evaluate the write scope once per call: the region mask, the selection
 * mask, and every preserved-region mask. A missing region id keeps the
 * existing REGION_NOT_FOUND error; an empty selection simply matches no
 * pixel, so the call reports zero changes. Nothing here writes pixels.
 */
function familyWriteScope(
	canvas: PixelCanvas,
	options?: FamilyRecolorOptions,
): FamilyWriteScope {
	const region =
		options?.regionId !== undefined
			? getRegion(canvas, options.regionId).mask
			: undefined;
	const selection =
		options?.selection !== undefined
			? evaluateSelectionExpr(canvas, options.selection, "selection").mask
			: undefined;
	const preserved = (options?.preserveRegions ?? []).map(
		(id) => getRegion(canvas, id).mask,
	);
	return { region, selection, preserved };
}

function inWriteScope(scope: FamilyWriteScope, cell: number): boolean {
	if (scope.region !== undefined && scope.region[cell] !== 1) {
		return false;
	}
	if (scope.selection !== undefined && scope.selection[cell] !== 1) {
		return false;
	}
	for (const mask of scope.preserved) {
		if (mask[cell] === 1) {
			return false;
		}
	}
	return true;
}

/**
 * One output color of the family path: outline cells are forced to the
 * family outline color; family-role pixels map to their same-named role;
 * accent, custom, and role-less pixels follow the six-band mapping.
 */
function familyColorFor(
	ramp: ResolvedFamilyRamp,
	outlineCell: boolean,
	role: PaletteRole | undefined,
	color: RGBA,
): RGBA {
	if (outlineCell) {
		return ramp.outline;
	}
	if (role !== undefined && FAMILY_ROLE_SET.has(role)) {
		return ramp[role as FamilyRole];
	}
	return ramp[familyRoleForLuminance(luminanceOf(color))];
}

/**
 * Recolor one layer onto a palette family (§5.4). Role-aware sources map
 * their six family roles directly; outline cells (opaque pixels beside
 * transparency or the canvas edge) always take the family outline color;
 * transparent pixels (A = 0) keep their bytes including hidden RGB;
 * translucent pixels are forced to the opaque ramp color; selection,
 * preserved regions, and preserved roles stay byte-identical.
 */
export function recolorLayerByFamily(
	canvas: PixelCanvas,
	layerId: string,
	family: string,
	options?: FamilyRecolorOptions,
): RecolorReport {
	assertValidCanvas(canvas);
	const layer = getLayer(canvas, layerId);
	const ramp = resolveFamilyRamp(family, options);
	const scope = familyWriteScope(canvas, options);
	const preservedRoles = new Set<PaletteRole>(options?.preserveRoles ?? []);
	const roles = roleIndex(
		options?.sourcePalette !== undefined
			? options.sourcePalette
			: canvas.palette,
	);
	const width = canvas.width;
	const height = canvas.height;
	const outline = insideOutlineCells(
		bodyMaskOf(layer.pixels, width, height),
		width,
		height,
	);
	let pixelsChanged = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const cell = y * width + x;
			if (!inWriteScope(scope, cell)) {
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
			if (role !== undefined && preservedRoles.has(role)) {
				continue;
			}
			const out = familyColorFor(ramp, outline[cell] === 1, role, {
				r,
				g,
				b: blue,
				a,
			});
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

/**
 * Recolor flat role-less raster sources (e.g. PNG) onto a palette family.
 * Every layer maps by the six integer luminance bands; outline cells are
 * forced to the family outline color; transparent pixels (A = 0) keep
 * their bytes including hidden RGB; translucent pixels are forced to the
 * opaque ramp color; selection and preserved regions stay byte-identical.
 */
export function recolorRolelessCanvasByFamily(
	canvas: PixelCanvas,
	family: string,
	options?: FamilyRecolorOptions,
): RecolorReport {
	assertValidCanvas(canvas);
	const ramp = resolveFamilyRamp(family, options);
	const scope = familyWriteScope(canvas, options);
	const width = canvas.width;
	const height = canvas.height;
	let pixelsChanged = 0;
	for (const layer of canvas.layers) {
		const outline = insideOutlineCells(
			bodyMaskOf(layer.pixels, width, height),
			width,
			height,
		);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const cell = y * width + x;
				if (!inWriteScope(scope, cell)) {
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
				const out =
					outline[cell] === 1
						? ramp.outline
						: ramp[familyRoleForLuminance(luminanceOf({ r, g, b: blue, a }))];
				if (out.r !== r || out.g !== g || out.b !== blue || out.a !== a) {
					layer.pixels[offset] = out.r;
					layer.pixels[offset + 1] = out.g;
					layer.pixels[offset + 2] = out.b;
					layer.pixels[offset + 3] = out.a;
					pixelsChanged += 1;
				}
			}
		}
	}
	return { pixelsChanged };
}

/**
 * Unified family recolor entry: a canvas that carries a palette is
 * role-aware and recolors layer by layer; a role-less canvas (flat PNG)
 * maps every layer by the six bands.
 */
export function recolorCanvasByFamily(
	canvas: PixelCanvas,
	family: string,
	options?: FamilyRecolorOptions,
): RecolorReport {
	assertValidCanvas(canvas);
	if (canvas.palette === undefined) {
		return recolorRolelessCanvasByFamily(canvas, family, options);
	}
	let pixelsChanged = 0;
	for (const layer of canvas.layers) {
		pixelsChanged += recolorLayerByFamily(
			canvas,
			layer.id,
			family,
			options,
		).pixelsChanged;
	}
	return { pixelsChanged };
}
