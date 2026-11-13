import { McAssetError } from "../core/errors.ts";
import {
	CANVAS_MAX_EDGE,
	CANVAS_MIN_EDGE,
	MAX_REGION_COUNT,
} from "../core/validate.ts";
import { boxUvFaces, ENTITY_FACE_NAMES } from "./box-uv.ts";
import type {
	EntityFace,
	EntityLayout,
	EntityLayoutDocument,
	EntityPart,
	EntityPartDocument,
} from "./types.ts";

export const ENTITY_LAYOUT_FORMAT = "mc-asset/entity-layout";
export const ENTITY_LAYOUT_VERSION = 1;
/** Absolute cap; the region cap (one region per face) binds first. */
export const MAX_ENTITY_PARTS = 512;
/** Largest outward growth one part may declare, in model units. */
export const MAX_ENTITY_INFLATE = 256;

const PART_ID = /^[A-Za-z0-9_.-]+$/;
const LAYOUT_ID = /^[A-Za-z0-9_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, details: Record<string, unknown>): never {
	throw new McAssetError("ENTITY_LAYOUT_INVALID", message, {
		reason: "invalid-layout",
		...details,
	});
}

function integerTuple(
	value: unknown,
	length: number,
	field: string,
	minimum: number,
	maximum: number,
): readonly number[] {
	if (!Array.isArray(value) || value.length !== length) {
		invalid(`${field} must be an array of ${length} integers.`, { field });
	}
	const out: number[] = [];
	for (let index = 0; index < length; index += 1) {
		const entry = value[index];
		if (
			typeof entry !== "number" ||
			!Number.isInteger(entry) ||
			entry < minimum ||
			entry > maximum
		) {
			invalid(
				`${field}[${index}] must be an integer in [${minimum}, ${maximum}].`,
				{ field: `${field}/${index}`, value: entry },
			);
		}
		out.push(entry);
	}
	return out;
}

function numberTuple(
	value: unknown,
	length: number,
	field: string,
): readonly [number, number, number] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length !== length) {
		invalid(`${field} must be an array of ${length} numbers.`, { field });
	}
	const out: number[] = [];
	for (let index = 0; index < length; index += 1) {
		const entry = value[index];
		if (typeof entry !== "number" || !Number.isFinite(entry)) {
			invalid(`${field}[${index}] must be a finite number.`, {
				field: `${field}/${index}`,
				value: entry,
			});
		}
		out.push(entry);
	}
	return [out[0] as number, out[1] as number, out[2] as number];
}

/**
 * A model distance that the integer preview can represent exactly: a multiple
 * of 1/256 model units (0.5 and 0.25 both are). Rejecting other values here
 * keeps the preview from silently rounding a document that claims an exact
 * size.
 */
function fixedUnitNumber(
	value: unknown,
	field: string,
	minimum: number,
	maximum: number,
): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value * 256) ||
		value < minimum ||
		value > maximum
	) {
		invalid(
			`${field} must be a multiple of 1/256 in [${minimum}, ${maximum}].`,
			{ field, value },
		);
	}
	return value;
}

function parsePart(value: unknown, index: number): EntityPartDocument {
	if (!isRecord(value)) {
		invalid(`parts[${index}] must be an object.`, { field: `parts/${index}` });
	}
	const id = value.id;
	if (typeof id !== "string" || id.length === 0 || !PART_ID.test(id)) {
		invalid(
			`parts[${index}].id must be a non-empty string using [A-Za-z0-9_.-].`,
			{ field: `parts/${index}/id`, value: id },
		);
	}
	const size = integerTuple(
		value.size,
		3,
		`parts[${index}].size`,
		1,
		CANVAS_MAX_EDGE,
	) as readonly [number, number, number];
	const uv = integerTuple(
		value.uv,
		2,
		`parts[${index}].uv`,
		0,
		CANVAS_MAX_EDGE,
	) as readonly [number, number];
	if (value.mirror !== undefined && typeof value.mirror !== "boolean") {
		invalid(`parts[${index}].mirror must be a boolean.`, {
			field: `parts/${index}/mirror`,
			value: value.mirror,
		});
	}
	const layer = value.layer;
	if (layer !== undefined && layer !== "base" && layer !== "overlay") {
		invalid(`parts[${index}].layer must be "base" or "overlay".`, {
			field: `parts/${index}/layer`,
			value: layer,
		});
	}
	const origin = numberTuple(value.origin, 3, `parts[${index}].origin`);
	const pivot = numberTuple(value.pivot, 3, `parts[${index}].pivot`);
	const rotation = numberTuple(value.rotation, 3, `parts[${index}].rotation`);
	const inflate = fixedUnitNumber(
		value.inflate,
		`parts[${index}].inflate`,
		-MAX_ENTITY_INFLATE,
		MAX_ENTITY_INFLATE,
	);
	return {
		id,
		size,
		uv,
		...(value.mirror === true ? { mirror: true } : {}),
		...(layer === "overlay" ? { layer: "overlay" } : {}),
		...(origin === undefined ? {} : { origin }),
		...(pivot === undefined ? {} : { pivot }),
		...(rotation === undefined ? {} : { rotation }),
		...(inflate === undefined ? {} : { inflate }),
	};
}

/**
 * Structural validation of a caller-supplied layout document. Unknown keys
 * are ignored so a Blockbench export can grow fields without breaking here;
 * every field this engine reads is checked.
 */
export function parseEntityLayoutDocument(
	value: unknown,
): EntityLayoutDocument {
	if (!isRecord(value)) {
		invalid("Entity layout must be a JSON object.", { field: "" });
	}
	if (value.format !== ENTITY_LAYOUT_FORMAT) {
		invalid(`Entity layout format must be "${ENTITY_LAYOUT_FORMAT}".`, {
			field: "format",
			value: value.format,
		});
	}
	const version = value.version;
	if (typeof version !== "number" || !Number.isInteger(version)) {
		invalid("Entity layout version must be an integer.", {
			field: "version",
			value: version,
		});
	}
	if (version > ENTITY_LAYOUT_VERSION) {
		throw new McAssetError(
			"ENTITY_LAYOUT_UNSUPPORTED_VERSION",
			`Entity layout version ${version} is newer than ${ENTITY_LAYOUT_VERSION}.`,
			{ version, supported: ENTITY_LAYOUT_VERSION },
		);
	}
	if (version !== ENTITY_LAYOUT_VERSION) {
		invalid(`Entity layout version must be ${ENTITY_LAYOUT_VERSION}.`, {
			field: "version",
			value: version,
		});
	}
	const id = value.id;
	if (typeof id !== "string" || id.length === 0 || !LAYOUT_ID.test(id)) {
		invalid(
			"Entity layout id must be a non-empty string using [A-Za-z0-9_.-].",
			{ field: "id", value: id },
		);
	}
	if (!isRecord(value.texture)) {
		invalid("Entity layout texture must be an object.", { field: "texture" });
	}
	const texture = integerTuple(
		[value.texture.width, value.texture.height],
		2,
		"texture",
		CANVAS_MIN_EDGE,
		CANVAS_MAX_EDGE,
	) as readonly [number, number];
	if (!Array.isArray(value.parts)) {
		invalid("Entity layout parts must be an array.", { field: "parts" });
	}
	if (value.parts.length === 0) {
		invalid("Entity layout needs at least one part.", { field: "parts" });
	}
	if (value.parts.length > MAX_ENTITY_PARTS) {
		invalid(
			`Entity layout holds ${value.parts.length} parts; the limit is ${MAX_ENTITY_PARTS}.`,
			{ field: "parts", limit: MAX_ENTITY_PARTS },
		);
	}
	// One region per face, and the canvas region limit is lower than the part
	// limit, so a layout that passes the part cap can still be unrenderable.
	// Refuse it here instead of letting `template` fail later.
	const regionCount = value.parts.length * ENTITY_FACE_NAMES.length;
	if (regionCount > MAX_REGION_COUNT) {
		invalid(
			`Entity layout has ${value.parts.length} parts and needs ${regionCount} regions (one per face); the canvas limit is ${MAX_REGION_COUNT}.`,
			{ field: "parts", requiredRegions: regionCount, limit: MAX_REGION_COUNT },
		);
	}
	const seen = new Set<string>();
	const parts: EntityPartDocument[] = [];
	for (let index = 0; index < value.parts.length; index += 1) {
		const part = parsePart(value.parts[index], index);
		if (seen.has(part.id)) {
			invalid(`Duplicate part id "${part.id}".`, {
				field: `parts/${index}/id`,
				id: part.id,
			});
		}
		seen.add(part.id);
		parts.push(part);
	}
	return {
		format: ENTITY_LAYOUT_FORMAT,
		version: ENTITY_LAYOUT_VERSION,
		id,
		texture: { width: texture[0], height: texture[1] },
		parts,
	};
}

function faceRef(face: EntityFace): Record<string, unknown> {
	return {
		part: face.partId,
		face: face.face,
		rect: { ...face.rect },
	};
}

function assertFacesInsideTexture(
	layout: EntityLayoutDocument,
	faces: readonly EntityFace[],
): void {
	for (const face of faces) {
		const { rect } = face;
		if (
			rect.x < 0 ||
			rect.y < 0 ||
			rect.x + rect.width > layout.texture.width ||
			rect.y + rect.height > layout.texture.height
		) {
			throw new McAssetError(
				"ENTITY_LAYOUT_INVALID",
				`Face ${face.partId}.${face.face} at (${rect.x},${rect.y}) ${rect.width}x${rect.height} falls outside the ${layout.texture.width}x${layout.texture.height} texture.`,
				{
					reason: "face-out-of-bounds",
					...faceRef(face),
					texture: { ...layout.texture },
				},
			);
		}
	}
}

/**
 * Reject any two face rectangles that share at least one pixel. Faces that
 * merely touch at an edge are fine; the whole layout is refused on the
 * first overlap with both faces named, sorted deterministically.
 */
function assertNoFaceOverlap(faces: readonly EntityFace[]): void {
	const ordered = faces
		.map((face, index) => ({ face, index }))
		.sort(
			(a, b) =>
				a.face.rect.y - b.face.rect.y ||
				a.face.rect.x - b.face.rect.x ||
				a.index - b.index,
		);
	for (let i = 0; i < ordered.length; i += 1) {
		const first = ordered[i] as { face: EntityFace; index: number };
		const a = first.face.rect;
		for (let j = i + 1; j < ordered.length; j += 1) {
			const second = ordered[j] as { face: EntityFace; index: number };
			const b = second.face.rect;
			if (b.y >= a.y + a.height) break;
			if (b.x >= a.x + a.width || a.x >= b.x + b.width) continue;
			const overlap = {
				x: Math.max(a.x, b.x),
				y: Math.max(a.y, b.y),
				width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
				height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
			};
			throw new McAssetError(
				"ENTITY_LAYOUT_OVERLAP",
				`Faces overlap: ${first.face.partId}.${first.face.face} and ${second.face.partId}.${second.face.face}.`,
				{
					first: faceRef(first.face),
					second: faceRef(second.face),
					overlap,
				},
			);
		}
	}
}

/** Geometry resolution: compute every face, then enforce bounds and overlap. */
export function resolveEntityLayout(
	layout: EntityLayoutDocument,
): EntityLayout {
	const parts: EntityPart[] = [];
	const faces: EntityFace[] = [];
	let mappedPixels = 0;
	for (const part of layout.parts) {
		const mirror = part.mirror === true;
		const layer = part.layer === "overlay" ? "overlay" : "base";
		const partFaces = boxUvFaces(part.id, layer, part.size, part.uv, mirror);
		faces.push(...partFaces);
		for (const face of partFaces) {
			mappedPixels += face.rect.width * face.rect.height;
		}
		parts.push({
			id: part.id,
			layer,
			size: part.size,
			uv: part.uv,
			mirror,
			...(part.origin === undefined ? {} : { origin: part.origin }),
			...(part.pivot === undefined ? {} : { pivot: part.pivot }),
			...(part.rotation === undefined ? {} : { rotation: part.rotation }),
			...(part.inflate === undefined ? {} : { inflate: part.inflate }),
			faces: partFaces,
		});
	}
	assertFacesInsideTexture(layout, faces);
	assertNoFaceOverlap(faces);
	const totalPixels = layout.texture.width * layout.texture.height;
	return {
		id: layout.id,
		texture: { ...layout.texture },
		parts,
		faces,
		mappedPixels,
		totalPixels,
		unmappedPixels: totalPixels - mappedPixels,
	};
}

/** Parse a caller-supplied document, then resolve and check its geometry. */
export function resolveEntityLayoutDocument(value: unknown): EntityLayout {
	return resolveEntityLayout(parseEntityLayoutDocument(value));
}
