import { McAssetError } from "../core/errors.ts";
import { type EntityLayoutSummary, entityLayoutSummary } from "./inspect.ts";
import type { EntityLayout } from "./types.ts";

/** Cap the coordinate list so a fully painted image cannot flood the report. */
export const MAX_REPORTED_UNMAPPED_PIXELS = 64;

export interface EntityTextureInput {
	readonly width: number;
	readonly height: number;
	/** Straight-alpha RGBA8, row-major, exactly width * height * 4 bytes. */
	readonly pixels: Uint8Array;
}

export interface EntitySizeMismatchFinding {
	readonly code: "ENTITY_TEXTURE_SIZE_MISMATCH";
	readonly level: "error";
	readonly message: string;
	readonly expected: { readonly width: number; readonly height: number };
	readonly actual: { readonly width: number; readonly height: number };
}

export interface EntityUnmappedPixelFinding {
	readonly code: "ENTITY_UNMAPPED_PIXEL";
	readonly level: "warning";
	readonly message: string;
	readonly count: number;
	readonly positions: readonly { readonly x: number; readonly y: number }[];
	readonly truncated: boolean;
}

export type EntityFinding =
	| EntitySizeMismatchFinding
	| EntityUnmappedPixelFinding;

export interface EntityValidateReport {
	readonly command: "entity";
	readonly mode: "validate";
	readonly layout: EntityLayoutSummary;
	readonly texture: { readonly width: number; readonly height: number };
	readonly verdict: "pass" | "fail";
	readonly findings: readonly EntityFinding[];
	readonly coverage: {
		readonly mappedPixels: number;
		readonly totalPixels: number;
		readonly unmappedPixels: number;
	};
}

function assertTexture(input: EntityTextureInput): void {
	if (
		!Number.isInteger(input.width) ||
		input.width < 1 ||
		!Number.isInteger(input.height) ||
		input.height < 1
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Texture width and height must be positive integers.",
			{ width: input.width, height: input.height },
		);
	}
	if (input.pixels.length !== input.width * input.height * 4) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Texture pixels must hold exactly width * height * 4 bytes.",
			{
				width: input.width,
				height: input.height,
				actual: input.pixels.length,
			},
		);
	}
}

/**
 * Validate one texture against a layout: the size must match, and every
 * non-transparent pixel must land inside a face. Unmapped pixels are
 * warnings (a stray pixel is usually a painting mistake, not a load
 * failure); a size mismatch is an error.
 */
export function validateEntityTexture(
	layout: EntityLayout,
	input: EntityTextureInput,
): EntityValidateReport {
	assertTexture(input);
	const summary = entityLayoutSummary(layout);
	const coverage = {
		mappedPixels: layout.mappedPixels,
		totalPixels: layout.totalPixels,
		unmappedPixels: layout.unmappedPixels,
	};
	if (
		input.width !== layout.texture.width ||
		input.height !== layout.texture.height
	) {
		return {
			command: "entity",
			mode: "validate",
			layout: summary,
			texture: { width: input.width, height: input.height },
			verdict: "fail",
			findings: [
				{
					code: "ENTITY_TEXTURE_SIZE_MISMATCH",
					level: "error",
					message: `Texture is ${input.width}x${input.height} but layout "${layout.id}" expects ${layout.texture.width}x${layout.texture.height}.`,
					expected: { ...layout.texture },
					actual: { width: input.width, height: input.height },
				},
			],
			coverage,
		};
	}

	const mask = new Uint8Array(input.width * input.height);
	for (const face of layout.faces) {
		for (let y = face.rect.y; y < face.rect.y + face.rect.height; y += 1) {
			const row = y * input.width;
			for (let x = face.rect.x; x < face.rect.x + face.rect.width; x += 1) {
				mask[row + x] = 1;
			}
		}
	}

	const positions: { x: number; y: number }[] = [];
	let count = 0;
	for (let y = 0; y < input.height; y += 1) {
		const row = y * input.width;
		for (let x = 0; x < input.width; x += 1) {
			if (mask[row + x] === 1) continue;
			if (input.pixels[(row + x) * 4 + 3] === 0) continue;
			count += 1;
			if (positions.length < MAX_REPORTED_UNMAPPED_PIXELS) {
				positions.push({ x, y });
			}
		}
	}

	const findings: EntityFinding[] =
		count === 0
			? []
			: [
					{
						code: "ENTITY_UNMAPPED_PIXEL",
						level: "warning",
						message: `${count} non-transparent pixel${count === 1 ? " lies" : "s lie"} outside every face.`,
						count,
						positions,
						truncated: count > positions.length,
					},
				];
	return {
		command: "entity",
		mode: "validate",
		layout: summary,
		texture: { width: input.width, height: input.height },
		verdict: "pass",
		findings,
		coverage,
	};
}
