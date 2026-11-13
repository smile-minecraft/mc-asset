import type {
	EntityFace,
	EntityFaceName,
	EntityLayer,
	EntityLayout,
	EntityRect,
} from "./types.ts";

export interface EntityFaceReport {
	readonly face: EntityFaceName;
	readonly rect: EntityRect;
	readonly uv: readonly [number, number, number, number];
	readonly mirror: boolean;
}

export interface EntityPartReport {
	readonly id: string;
	readonly layer: EntityLayer;
	readonly size: readonly [number, number, number];
	readonly uv: readonly [number, number];
	readonly mirror: boolean;
	readonly origin?: readonly [number, number, number] | undefined;
	readonly pivot?: readonly [number, number, number] | undefined;
	readonly rotation?: readonly [number, number, number] | undefined;
	readonly faces: readonly EntityFaceReport[];
}

export interface EntityLayoutSummary {
	readonly id: string;
	readonly texture: { readonly width: number; readonly height: number };
	readonly partCount: number;
	readonly faceCount: number;
	readonly mappedPixels: number;
	readonly totalPixels: number;
	readonly unmappedPixels: number;
}

export interface EntityInspectReport {
	readonly command: "entity";
	readonly mode: "inspect";
	readonly layout: EntityLayoutSummary;
	readonly parts: readonly EntityPartReport[];
}

export function entityLayoutSummary(layout: EntityLayout): EntityLayoutSummary {
	return {
		id: layout.id,
		texture: { ...layout.texture },
		partCount: layout.parts.length,
		faceCount: layout.faces.length,
		mappedPixels: layout.mappedPixels,
		totalPixels: layout.totalPixels,
		unmappedPixels: layout.unmappedPixels,
	};
}

function faceReport(face: EntityFace): EntityFaceReport {
	return {
		face: face.face,
		rect: { ...face.rect },
		uv: face.uv,
		mirror: face.mirror,
	};
}

/** Read-only report: every part and every face rectangle in part order. */
export function inspectEntityLayout(layout: EntityLayout): EntityInspectReport {
	return {
		command: "entity",
		mode: "inspect",
		layout: entityLayoutSummary(layout),
		parts: layout.parts.map((part) => ({
			id: part.id,
			layer: part.layer,
			size: part.size,
			uv: part.uv,
			mirror: part.mirror,
			...(part.origin === undefined ? {} : { origin: part.origin }),
			...(part.pivot === undefined ? {} : { pivot: part.pivot }),
			...(part.rotation === undefined ? {} : { rotation: part.rotation }),
			faces: part.faces.map(faceReport),
		})),
	};
}
