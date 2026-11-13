import {
	addLayer,
	addRegion,
	createAuthoringPalette,
	createCanvas,
	replaceLayerPixels,
	replaceRegionMask,
} from "../core/canvas.ts";
import type { PixelCanvas, RGBA } from "../core/types.ts";
import { ENTITY_FACE_NAMES } from "./box-uv.ts";
import type {
	EntityFace,
	EntityFaceName,
	EntityLayer,
	EntityLayout,
	EntityRect,
} from "./types.ts";

/**
 * Template face colors: one opaque color per face direction, so a painter
 * can tell a top from a front by fill alone. Region ids stay deterministic:
 * `<part>.<face>`.
 */
export const ENTITY_FACE_COLORS: Readonly<Record<EntityFaceName, RGBA>> = {
	top: { r: 0x5b, g: 0x9b, b: 0xd5, a: 255 },
	bottom: { r: 0x3b, g: 0x5a, b: 0x8c, a: 255 },
	right: { r: 0x6a, g: 0xb0, b: 0x6a, a: 255 },
	front: { r: 0xd9, g: 0x9b, b: 0x4a, a: 255 },
	left: { r: 0xc9, g: 0x6a, b: 0x6a, a: 255 },
	back: { r: 0x9b, g: 0x7f, b: 0xc9, a: 255 },
};

/** Compact one-character palette symbols for the six faces. */
export const ENTITY_FACE_SYMBOLS: Readonly<Record<EntityFaceName, string>> = {
	top: "u",
	bottom: "d",
	right: "e",
	front: "n",
	left: "w",
	back: "s",
};

export interface EntityTemplateOptions {
	/** Fill every face with its face color. Default true. */
	readonly fill?: boolean | undefined;
}

export interface EntityTemplateRegion {
	readonly id: string;
	readonly partId: string;
	readonly face: EntityFaceName;
	readonly layer: EntityLayer;
	readonly rect: EntityRect;
}

export interface EntityTemplate {
	readonly canvas: PixelCanvas;
	readonly regions: readonly EntityTemplateRegion[];
}

function fillRect(
	pixels: Uint8Array,
	width: number,
	rect: EntityRect,
	color: RGBA,
): void {
	for (let y = rect.y; y < rect.y + rect.height; y += 1) {
		for (let x = rect.x; x < rect.x + rect.width; x += 1) {
			const offset = (y * width + x) * 4;
			pixels[offset] = color.r;
			pixels[offset + 1] = color.g;
			pixels[offset + 2] = color.b;
			pixels[offset + 3] = color.a;
		}
	}
}

function faceMask(width: number, height: number, rect: EntityRect): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = rect.y; y < rect.y + rect.height; y += 1) {
		const row = y * width;
		for (let x = rect.x; x < rect.x + rect.width; x += 1) {
			mask[row + x] = 1;
		}
	}
	return mask;
}

/**
 * Build the editable template: every face is one named region, optionally
 * filled with its direction color. The same canvas feeds both the PNG and
 * the .mcpx, so the two artifacts always describe identical pixels.
 */
export function buildEntityTemplate(
	layout: EntityLayout,
	options?: EntityTemplateOptions,
): EntityTemplate {
	const fill = options?.fill !== false;
	const paletteEntries = [
		{ id: ".", color: { r: 0, g: 0, b: 0, a: 0 } },
		...(fill
			? ENTITY_FACE_NAMES.map((face) => ({
					id: ENTITY_FACE_SYMBOLS[face],
					color: ENTITY_FACE_COLORS[face],
				}))
			: []),
	];
	const canvas = createCanvas(layout.texture.width, layout.texture.height, {
		metadata: { entity_layout: layout.id },
		palette: createAuthoringPalette(paletteEntries),
	});
	const layer = addLayer(canvas, { id: "template", name: "template" });
	const pixels = new Uint8Array(layout.totalPixels * 4);
	if (fill) {
		for (const face of layout.faces) {
			fillRect(
				pixels,
				layout.texture.width,
				face.rect,
				ENTITY_FACE_COLORS[face.face],
			);
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);

	const regions: EntityTemplateRegion[] = [];
	for (const face of layout.faces) {
		const id = `${face.partId}.${face.face}`;
		const region = addRegion(canvas, { id, name: id });
		replaceRegionMask(
			canvas,
			region.id,
			faceMask(layout.texture.width, layout.texture.height, face.rect),
		);
		regions.push({
			id,
			partId: face.partId,
			face: face.face,
			layer: face.layer,
			rect: face.rect,
		});
	}
	return { canvas, regions };
}

/** Region id for one face; shared by the template and inspect reports. */
export function entityRegionId(face: EntityFace): string {
	return `${face.partId}.${face.face}`;
}
