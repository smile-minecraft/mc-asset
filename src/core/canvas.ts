import { McAssetError } from "./errors.ts";
import type {
	AuthoringPalette,
	AuthoringPaletteEntry,
	CanvasMetadata,
	PaletteRole,
	PixelCanvas,
	PixelLayer,
	PixelRegion,
	RGBA,
} from "./types.ts";
import {
	assertPixelInBounds,
	assertValidCanvas,
	checkResourceLimits,
	validateColor,
	validateCoordinate,
	validateDimension,
	validateLayerPixelsSize,
	validateMaskValue,
	validateOpacity,
	validateRegionMaskSize,
} from "./validate.ts";

export interface CreateCanvasOptions {
	metadata?: CanvasMetadata;
	palette?: AuthoringPalette;
}

export interface AddLayerOptions {
	id?: string;
	name?: string;
	visible?: boolean;
	opacity?: number;
	blendMode?: string;
	metadata?: Record<string, unknown>;
}

export interface AddRegionOptions {
	id?: string;
	name?: string;
	metadata?: Record<string, unknown>;
}

const PALETTE_ROLES: ReadonlySet<string> = new Set([
	"outline",
	"shadow",
	"dark",
	"base",
	"light",
	"highlight",
	"accent",
	"custom",
]);

export function createAuthoringPalette(
	entries: AuthoringPaletteEntry[],
): AuthoringPalette {
	const seen = new Set<string>();
	for (const entry of entries) {
		if (typeof entry.id !== "string" || entry.id.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Palette entry id must be a non-empty string.",
				{
					id: entry.id,
				},
			);
		}
		if (seen.has(entry.id)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Palette entry id must be unique.",
				{
					id: entry.id,
				},
			);
		}
		seen.add(entry.id);
		validateColor(entry.color);
		const role: PaletteRole | undefined = entry.role;
		if (role !== undefined && !PALETTE_ROLES.has(role)) {
			throw new McAssetError("INVALID_ARGUMENT", "Unknown palette role.", {
				id: entry.id,
				role,
			});
		}
	}
	return {
		entries: entries.map((entry) => ({
			...entry,
			color: { ...entry.color },
			...(entry.metadata !== undefined
				? { metadata: { ...entry.metadata } }
				: {}),
		})),
	};
}

export function createCanvas(
	width: number,
	height: number,
	options?: CreateCanvasOptions,
): PixelCanvas {
	validateDimension(width);
	validateDimension(height);
	checkResourceLimits(width, height, 0, 0);
	// Defensive copies: later caller-side mutation must not leak into the canvas.
	const palette =
		options?.palette !== undefined
			? createAuthoringPalette(options.palette.entries)
			: undefined;
	return {
		version: 1,
		width,
		height,
		layers: [],
		regions: [],
		...(palette !== undefined ? { palette } : {}),
		...(options?.metadata !== undefined
			? { metadata: { ...options.metadata } }
			: { metadata: {} }),
	};
}

function defaultId(prefix: string, taken: (id: string) => boolean): string {
	let index = 0;
	while (taken(`${prefix}-${index}`)) {
		index += 1;
	}
	return `${prefix}-${index}`;
}

export function addLayer(
	canvas: PixelCanvas,
	options?: AddLayerOptions,
): PixelLayer {
	assertValidCanvas(canvas);
	const id =
		options?.id ??
		defaultId("layer", (candidate) =>
			canvas.layers.some((layer) => layer.id === candidate),
		);
	if (canvas.layers.some((layer) => layer.id === id)) {
		throw new McAssetError("DUPLICATE_LAYER_ID", "Layer id already exists.", {
			id,
		});
	}
	if (options?.blendMode !== undefined && options.blendMode !== "normal") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"V1 only supports the normal blend mode.",
			{
				blendMode: options.blendMode,
			},
		);
	}
	const opacity = validateOpacity(options?.opacity ?? 1);
	// Budget gate runs before the pixel buffer is allocated.
	checkResourceLimits(
		canvas.width,
		canvas.height,
		canvas.layers.length + 1,
		canvas.regions.length,
	);
	const layer: PixelLayer = {
		id,
		pixels: new Uint8Array(canvas.width * canvas.height * 4),
		visible: options?.visible ?? true,
		opacity,
		blendMode: "normal",
		...(options?.name !== undefined ? { name: options.name } : {}),
		...(options?.metadata !== undefined
			? { metadata: { ...options.metadata } }
			: {}),
	};
	canvas.layers.push(layer);
	return layer;
}

export function addRegion(
	canvas: PixelCanvas,
	options?: AddRegionOptions,
): PixelRegion {
	assertValidCanvas(canvas);
	const id =
		options?.id ??
		defaultId("region", (candidate) =>
			canvas.regions.some((region) => region.id === candidate),
		);
	if (canvas.regions.some((region) => region.id === id)) {
		throw new McAssetError("DUPLICATE_REGION_ID", "Region id already exists.", {
			id,
		});
	}
	// Budget gate runs before the mask is allocated.
	checkResourceLimits(
		canvas.width,
		canvas.height,
		canvas.layers.length,
		canvas.regions.length + 1,
	);
	const region: PixelRegion = {
		id,
		mask: new Uint8Array(canvas.width * canvas.height),
		...(options?.name !== undefined ? { name: options.name } : {}),
		...(options?.metadata !== undefined
			? { metadata: { ...options.metadata } }
			: {}),
	};
	canvas.regions.push(region);
	return region;
}

export function getLayer(canvas: PixelCanvas, id: string): PixelLayer {
	assertValidCanvas(canvas);
	const layer = canvas.layers.find((candidate) => candidate.id === id);
	if (layer === undefined) {
		throw new McAssetError("LAYER_NOT_FOUND", "Layer id does not exist.", {
			id,
		});
	}
	return layer;
}

export function getRegion(canvas: PixelCanvas, id: string): PixelRegion {
	assertValidCanvas(canvas);
	const region = canvas.regions.find((candidate) => candidate.id === id);
	if (region === undefined) {
		throw new McAssetError("REGION_NOT_FOUND", "Region id does not exist.", {
			id,
		});
	}
	return region;
}

function pixelIndex(width: number, x: number, y: number): number {
	return (y * width + x) * 4;
}

function locatePixel(
	canvas: PixelCanvas,
	layerId: string,
	x: number,
	y: number,
): { layer: PixelLayer; index: number } {
	const layer = getLayer(canvas, layerId);
	validateCoordinate(x, "x");
	validateCoordinate(y, "y");
	assertPixelInBounds(canvas.width, canvas.height, x, y);
	return { layer, index: pixelIndex(canvas.width, x, y) };
}

/** Read one pixel. All four channels are returned verbatim, even when A = 0. */
export function getPixel(
	canvas: PixelCanvas,
	layerId: string,
	x: number,
	y: number,
): RGBA {
	const { layer, index } = locatePixel(canvas, layerId, x, y);
	return {
		r: layer.pixels[index],
		g: layer.pixels[index + 1],
		b: layer.pixels[index + 2],
		a: layer.pixels[index + 3],
	};
}

/** Write one pixel. Bytes are stored verbatim: hidden RGB under A = 0 is kept. */
export function setPixel(
	canvas: PixelCanvas,
	layerId: string,
	x: number,
	y: number,
	color: RGBA,
): void {
	validateColor(color);
	const { layer, index } = locatePixel(canvas, layerId, x, y);
	layer.pixels[index] = color.r;
	layer.pixels[index + 1] = color.g;
	layer.pixels[index + 2] = color.b;
	layer.pixels[index + 3] = color.a;
}

function locateMaskCell(
	canvas: PixelCanvas,
	regionId: string,
	x: number,
	y: number,
): { region: PixelRegion; index: number } {
	const region = getRegion(canvas, regionId);
	validateCoordinate(x, "x");
	validateCoordinate(y, "y");
	assertPixelInBounds(canvas.width, canvas.height, x, y);
	return { region, index: y * canvas.width + x };
}

export function getRegionValue(
	canvas: PixelCanvas,
	regionId: string,
	x: number,
	y: number,
): number {
	const { region, index } = locateMaskCell(canvas, regionId, x, y);
	return region.mask[index] as number;
}

export function setRegionValue(
	canvas: PixelCanvas,
	regionId: string,
	x: number,
	y: number,
	value: number,
): void {
	validateMaskValue(value);
	const { region, index } = locateMaskCell(canvas, regionId, x, y);
	region.mask[index] = value;
}

/** Attach an externally produced pixel buffer after validating its size. */
export function replaceLayerPixels(
	canvas: PixelCanvas,
	layerId: string,
	pixels: Uint8Array,
): void {
	const layer = getLayer(canvas, layerId);
	validateLayerPixelsSize(canvas.width, canvas.height, pixels);
	layer.pixels = pixels;
}

/** Attach an externally produced region mask after validating its size. */
export function replaceRegionMask(
	canvas: PixelCanvas,
	regionId: string,
	mask: Uint8Array,
): void {
	const region = getRegion(canvas, regionId);
	validateRegionMaskSize(canvas.width, canvas.height, mask);
	region.mask = mask;
}
