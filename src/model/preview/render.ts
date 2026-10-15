import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../core/canvas.ts";
import { McAssetError } from "../../core/errors.ts";
import { decodePng, encodePng, flattenCanvas } from "../../io/png.ts";
import type { ModelResolutionContext } from "../context.ts";
import {
	inspectModel,
	type ModelCoverage,
	type ModelVersionInfo,
} from "../inspect.ts";
import { textureResourcePath } from "../references.ts";
import { DIRECTIONS, type Direction, type Vec3 } from "../types.ts";

/**
 * The three-view diagnostic renderer for Java models.
 *
 * One call turns model JSON plus an optional resolution context into a report
 * and one PNG. The layout is fixed: three square panels side by side, `front`
 * (the north face seen from the north), `right` (the east face seen from the
 * east) and `top` (the up face seen from above, north at the top). Each panel
 * is `size` x `size`, the image is `size * 3` x `size`, and the background is
 * fully transparent.
 *
 * Projection: all panels share one integer scale so the three views stay
 * comparable. `pixelsPerUnit` = max(1, floor(available * 256 / extent)), with
 * `available` = size - 2 * margin, `margin` = max(1, floor(size / 16)) and
 * `extent` the largest bounding-box edge of the drawn elements in 1/256 units.
 * Each panel centers its own projected span. A value maps to
 * floor((maxFixed - valueFixed) * pixelsPerUnit / 256) + offset for the
 * flipped axes (front X and Y, right Z and Y) and to
 * floor((valueFixed - minFixed) * pixelsPerUnit / 256) + offset for the top
 * panel axes. Only axis-aligned cuboids are drawn; each panel shows only the
 * faces whose normal points at its camera (front: north, right: east, top:
 * up), so other faces, cullface and back faces need no handling. Depth is the
 * near plane of the face (front: -z, right: +x, top: +y); the nearer face
 * wins, an equal depth belongs to the later element in document order (higher
 * element index), and the face order inside one element follows DIRECTIONS,
 * so nothing depends on sort stability.
 *
 * Texture sampling: a face without `uv` uses the vanilla auto-UV of its element
 * position: north mirrors x from 16-x2 to 16-x1, east mirrors z from 16-z2 to 16-z1,
 * south/west use x/z directly, up uses x and z, side v flips with 16-y; values outside [0, 16] clamp
 * to the texture edge. `rotation` 90/180/270 rotates the sampled texture
 * clockwise as seen on the panel (270 counterclockwise), matching the
 * documented face-rotation direction. Every pixel samples the texture at its
 * center and copies RGBA verbatim: no lighting, no tint, no blending. A face
 * whose texture cannot be resolved or decoded fills its rectangle with the
 * fixed checkerboard (8 px cells, magenta first, anchored at the image
 * origin) instead.
 *
 * The report stays honest: anything not faithfully rendered is listed in
 * `coverage.skipped` (element rotation, coordinates that are not exact
 * 1/256 multiples, untextured or translucent faces, texture problems), every
 * texture problem also raises a warning, and `unapplied` always states that
 * display transforms and game lighting are not applied. This is a diagnostic
 * view, not a game renderer, and it never rewrites the model.
 */

/** Panel edge sizes `model preview` accepts; the image is size*3 wide and size high. */
export type ModelPreviewSize = 64 | 128 | 256;

export type ModelPreviewPanelName = "front" | "right" | "top";

/** One square panel of the output image; panels are laid out horizontally in order. */
export interface ModelPreviewPanel {
	readonly name: ModelPreviewPanelName;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** The model-space box every panel fits, plus the shared integer scale. */
export interface ModelPreviewRange {
	readonly min: Vec3;
	readonly max: Vec3;
	/** Integer pixels per model unit; every panel uses the same value. */
	readonly pixelsPerUnit: number;
}

export type ModelPreviewWarningCode =
	| "MODEL_PREVIEW_TEXTURE_MISSING"
	| "MODEL_PREVIEW_TEXTURE_UNRESOLVED"
	| "MODEL_PREVIEW_TEXTURE_UNDECODABLE";

export interface ModelPreviewWarning {
	readonly code: ModelPreviewWarningCode;
	readonly level: "warning";
	readonly message: string;
	/** The face texture reference (or its resolved location) the warning is about. */
	readonly target: string;
}

export interface ModelPreviewReport {
	readonly command: "model";
	readonly mode: "preview";
	readonly path: string;
	readonly modelId?: string;
	readonly size: ModelPreviewSize;
	readonly version: ModelVersionInfo;
	readonly image: { readonly width: number; readonly height: number };
	readonly panels: readonly ModelPreviewPanel[];
	readonly range: ModelPreviewRange;
	readonly coverage: ModelCoverage;
	readonly warnings: readonly ModelPreviewWarning[];
	/** Render steps this diagnostic view deliberately does not apply. */
	readonly unapplied: readonly string[];
}

export interface ModelPreviewOptions {
	readonly path: string;
	readonly modelId?: string | undefined;
	readonly packFormat?: string | undefined;
	readonly minecraftVersion?: string | undefined;
	readonly context?: ModelResolutionContext | undefined;
	readonly size: ModelPreviewSize;
}

export interface ModelPreviewResult {
	readonly report: ModelPreviewReport;
	readonly png: Uint8Array;
}

function previewImageSize(size: ModelPreviewSize): {
	readonly width: number;
	readonly height: number;
} {
	return { width: size * 3, height: size };
}

function previewPanels(size: ModelPreviewSize): readonly ModelPreviewPanel[] {
	return (["front", "right", "top"] as const).map((name, index) => ({
		name,
		x: index * size,
		y: 0,
		width: size,
		height: size,
	}));
}

function isSupportedSize(value: unknown): value is ModelPreviewSize {
	return value === 64 || value === 128 || value === 256;
}

function isFixedMultiple(value: number): boolean {
	return Number.isInteger(value * 256);
}

function toFixed(value: number): number {
	return Math.round(value * 256);
}

function addSkip(
	skipped: { kind: string; reason: string; target: string; detail?: string }[],
	kind: string,
	reason: string,
	target: string,
	detail?: string,
): void {
	if (
		skipped.some(
			(entry) =>
				entry.kind === kind &&
				entry.reason === reason &&
				entry.target === target &&
				entry.detail === detail,
		)
	) {
		return;
	}
	skipped.push(
		detail === undefined
			? { kind, reason, target }
			: { kind, reason, target, detail },
	);
}

function addPreviewWarning(
	warnings: ModelPreviewWarning[],
	code: ModelPreviewWarningCode,
	target: string,
	message: string,
): void {
	if (
		warnings.some((entry) => entry.code === code && entry.target === target)
	) {
		return;
	}
	warnings.push({ code, level: "warning", message, target });
}

interface DecodedTexture {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
}

function checkerColor(
	x: number,
	y: number,
): readonly [number, number, number, number] {
	const cx = Math.floor(x / 8);
	const cy = Math.floor(y / 8);
	return (cx + cy) % 2 === 0 ? [255, 0, 255, 255] : [0, 0, 0, 255];
}

function clampToEdge(value: number): number {
	if (value < 0) return 0;
	if (value > 16) return 16;
	return value;
}

function sampleTexture(
	decoded: DecodedTexture,
	u: number,
	v: number,
): readonly [number, number, number, number] {
	const cu = clampToEdge(u);
	const cv = clampToEdge(v);
	let tx = Math.floor((cu * decoded.width) / 16);
	let ty = Math.floor((cv * decoded.height) / 16);
	if (tx < 0) tx = 0;
	if (ty < 0) ty = 0;
	if (tx >= decoded.width) tx = decoded.width - 1;
	if (ty >= decoded.height) ty = decoded.height - 1;
	const o = (ty * decoded.width + tx) * 4;
	return [
		decoded.pixels[o] as number,
		decoded.pixels[o + 1] as number,
		decoded.pixels[o + 2] as number,
		decoded.pixels[o + 3] as number,
	];
}

function rotateFaceCoords(
	fx: number,
	fy: number,
	rotation: 0 | 90 | 180 | 270,
): readonly [number, number] {
	if (rotation === 90) return [fy, 1 - fx];
	if (rotation === 180) return [1 - fx, 1 - fy];
	if (rotation === 270) return [1 - fy, fx];
	return [fx, fy];
}

function autoUv(
	face: Direction,
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
): readonly [number, number, number, number] {
	if (face === "north") {
		return [16 - maxX, 16 - maxY, 16 - minX, 16 - minY];
	}
	if (face === "south") {
		return [minX, 16 - maxY, maxX, 16 - minY];
	}
	if (face === "east") {
		return [16 - maxZ, 16 - maxY, 16 - minZ, 16 - minY];
	}
	if (face === "west") {
		return [minZ, 16 - maxY, maxZ, 16 - minY];
	}
	if (face === "down") {
		return [minX, 16 - maxZ, maxX, 16 - minZ];
	}
	return [minX, minZ, maxX, maxZ];
}

/**
 * Render the three-view diagnostic PNG plus its report. The projection, depth
 * buffer, UV mapping and texture sampling run on top of the shared inspection
 * result; anything not faithfully rendered is reported as partial coverage.
 */
export async function renderModelPreview(
	text: string,
	options: ModelPreviewOptions,
): Promise<ModelPreviewResult> {
	if (!isSupportedSize(options.size)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`preview size must be one of 64, 128, or 256: ${String(options.size)}.`,
			{ field: "size", size: options.size },
		);
	}
	const size = options.size;
	const inspection = await inspectModel(text, {
		path: options.path,
		...(options.modelId === undefined ? {} : { modelId: options.modelId }),
		...(options.packFormat === undefined
			? {}
			: { packFormat: options.packFormat }),
		...(options.minecraftVersion === undefined
			? {}
			: { minecraftVersion: options.minecraftVersion }),
		...(options.context === undefined ? {} : { context: options.context }),
	});

	const skipped: {
		kind: string;
		reason: string;
		target: string;
		detail?: string;
	}[] = [];
	const warnings: ModelPreviewWarning[] = [];

	const translucentVars = new Set<string>();
	for (const entry of inspection.textures) {
		if (entry.forceTranslucent === true) translucentVars.add(entry.name);
	}
	const isTranslucentFace = (
		texture: string,
		via: readonly string[],
	): boolean => {
		if (via.length > 0) {
			for (const ref of via) {
				if (ref.startsWith("#") && translucentVars.has(ref.slice(1)))
					return true;
			}
			return false;
		}
		if (texture.startsWith("#")) return translucentVars.has(texture.slice(1));
		return false;
	};

	interface DrawnElement {
		readonly index: number;
		readonly minX: number;
		readonly minY: number;
		readonly minZ: number;
		readonly maxX: number;
		readonly maxY: number;
		readonly maxZ: number;
		readonly minXFixed: number;
		readonly minYFixed: number;
		readonly minZFixed: number;
		readonly maxXFixed: number;
		readonly maxYFixed: number;
		readonly maxZFixed: number;
		readonly element: (typeof inspection.elements)[number];
	}

	const drawn: DrawnElement[] = [];
	for (const element of inspection.elements) {
		const target = `elements[${element.index}]`;
		if (element.rotation !== undefined) {
			addSkip(skipped, "element-rotation", "rotation-not-rendered", target);
			continue;
		}
		const coords = [
			element.from[0],
			element.from[1],
			element.from[2],
			element.to[0],
			element.to[1],
			element.to[2],
		];
		if (!coords.every(isFixedMultiple)) {
			addSkip(skipped, "element-coordinate", "not-1-256-multiple", target);
			continue;
		}
		const minX = Math.min(element.from[0], element.to[0]);
		const maxX = Math.max(element.from[0], element.to[0]);
		const minY = Math.min(element.from[1], element.to[1]);
		const maxY = Math.max(element.from[1], element.to[1]);
		const minZ = Math.min(element.from[2], element.to[2]);
		const maxZ = Math.max(element.from[2], element.to[2]);
		drawn.push({
			index: element.index,
			minX,
			minY,
			minZ,
			maxX,
			maxY,
			maxZ,
			minXFixed: toFixed(minX),
			minYFixed: toFixed(minY),
			minZFixed: toFixed(minZ),
			maxXFixed: toFixed(maxX),
			maxYFixed: toFixed(maxY),
			maxZFixed: toFixed(maxZ),
			element,
		});
	}

	let rangeMin: Vec3 = [0, 0, 0];
	let rangeMax: Vec3 = [0, 0, 0];
	let pixelsPerUnit = 1;
	let frontSpanX = 0;
	let frontSpanY = 0;
	let frontOffsetX = Math.floor(size / 2);
	let frontOffsetY = Math.floor(size / 2);
	let rightSpanX = 0;
	let rightSpanY = 0;
	let rightOffsetX = Math.floor(size / 2);
	let rightOffsetY = Math.floor(size / 2);
	let topSpanX = 0;
	let topSpanY = 0;
	let topOffsetX = Math.floor(size / 2);
	let topOffsetY = Math.floor(size / 2);
	let globalMinXFixed = 0;
	let globalMinZFixed = 0;
	let globalMaxXFixed = 0;
	let globalMaxYFixed = 0;
	let globalMaxZFixed = 0;

	if (drawn.length > 0) {
		let minX = drawn[0]?.minX ?? 0;
		let minY = drawn[0]?.minY ?? 0;
		let minZ = drawn[0]?.minZ ?? 0;
		let maxX = drawn[0]?.maxX ?? 0;
		let maxY = drawn[0]?.maxY ?? 0;
		let maxZ = drawn[0]?.maxZ ?? 0;
		let minXFixed = drawn[0]?.minXFixed ?? 0;
		let minYFixed = drawn[0]?.minYFixed ?? 0;
		let minZFixed = drawn[0]?.minZFixed ?? 0;
		let maxXFixed = drawn[0]?.maxXFixed ?? 0;
		let maxYFixed = drawn[0]?.maxYFixed ?? 0;
		let maxZFixed = drawn[0]?.maxZFixed ?? 0;
		for (const entry of drawn) {
			if (entry.minX < minX) minX = entry.minX;
			if (entry.minY < minY) minY = entry.minY;
			if (entry.minZ < minZ) minZ = entry.minZ;
			if (entry.maxX > maxX) maxX = entry.maxX;
			if (entry.maxY > maxY) maxY = entry.maxY;
			if (entry.maxZ > maxZ) maxZ = entry.maxZ;
			if (entry.minXFixed < minXFixed) minXFixed = entry.minXFixed;
			if (entry.minYFixed < minYFixed) minYFixed = entry.minYFixed;
			if (entry.minZFixed < minZFixed) minZFixed = entry.minZFixed;
			if (entry.maxXFixed > maxXFixed) maxXFixed = entry.maxXFixed;
			if (entry.maxYFixed > maxYFixed) maxYFixed = entry.maxYFixed;
			if (entry.maxZFixed > maxZFixed) maxZFixed = entry.maxZFixed;
		}
		rangeMin = [minX, minY, minZ];
		rangeMax = [maxX, maxY, maxZ];
		globalMinXFixed = minXFixed;
		globalMinZFixed = minZFixed;
		globalMaxXFixed = maxXFixed;
		globalMaxYFixed = maxYFixed;
		globalMaxZFixed = maxZFixed;
		const dx = maxXFixed - minXFixed;
		const dy = maxYFixed - minYFixed;
		const dz = maxZFixed - minZFixed;
		const extent = Math.max(dx, dy, dz);
		const margin = Math.max(1, Math.floor(size / 16));
		const available = size - 2 * margin;
		pixelsPerUnit =
			extent > 0 ? Math.max(1, Math.floor((available * 256) / extent)) : 1;
		frontSpanX = Math.floor((dx * pixelsPerUnit) / 256);
		frontSpanY = Math.floor((dy * pixelsPerUnit) / 256);
		frontOffsetX = Math.floor((size - frontSpanX) / 2);
		frontOffsetY = Math.floor((size - frontSpanY) / 2);
		rightSpanX = Math.floor((dz * pixelsPerUnit) / 256);
		rightSpanY = frontSpanY;
		rightOffsetX = Math.floor((size - rightSpanX) / 2);
		rightOffsetY = Math.floor((size - rightSpanY) / 2);
		topSpanX = frontSpanX;
		topSpanY = rightSpanX;
		topOffsetX = Math.floor((size - topSpanX) / 2);
		topOffsetY = Math.floor((size - topSpanY) / 2);
	}

	const imageWidth = size * 3;
	const imageHeight = size;
	const flat = new Uint8Array(imageWidth * imageHeight * 4);
	const depthFront = new Array<number>(size * size).fill(
		Number.NEGATIVE_INFINITY,
	);
	const depthRight = new Array<number>(size * size).fill(
		Number.NEGATIVE_INFINITY,
	);
	const depthTop = new Array<number>(size * size).fill(
		Number.NEGATIVE_INFINITY,
	);

	const context = options.context;
	const textureCache = new Map<string, DecodedTexture | undefined>();

	async function decodedTexture(
		rel: string,
	): Promise<DecodedTexture | undefined> {
		if (textureCache.has(rel)) return textureCache.get(rel);
		let bytes: Uint8Array | undefined;
		if (context !== undefined) {
			for (const layer of context.layers) {
				if (!layer.has(rel)) continue;
				try {
					const read = await layer.read(rel);
					if (read !== undefined) {
						bytes = read;
						break;
					}
				} catch {
					bytes = undefined;
				}
			}
		}
		if (bytes === undefined) {
			textureCache.set(rel, undefined);
			return undefined;
		}
		try {
			const decoded = decodePng(bytes);
			const pixels = flattenCanvas(decoded.canvas);
			const result: DecodedTexture = {
				width: decoded.canvas.width,
				height: decoded.canvas.height,
				pixels,
			};
			textureCache.set(rel, result);
			return result;
		} catch {
			textureCache.set(rel, undefined);
			return undefined;
		}
	}

	const faceFor = (
		element: (typeof inspection.elements)[number],
		face: Direction,
	) => element.faces.find((entry) => entry.face === face);

	const warningTargetFor = (
		texture: string,
		resolvedTo: string | undefined,
	): string => resolvedTo ?? texture;

	for (const entry of drawn) {
		const faceTargetBase = `elements[${entry.index}]`;
		for (const faceName of DIRECTIONS) {
			if (faceName !== "north" && faceName !== "east" && faceName !== "up") {
				continue;
			}
			const faceView = faceFor(entry.element, faceName);
			if (faceView === undefined) continue;
			const faceTarget = `${faceTargetBase}/faces/${faceName}`;
			if (isTranslucentFace(faceView.texture, faceView.textureResolution.via)) {
				addSkip(
					skipped,
					"face-translucent",
					"translucent-not-rendered",
					faceTarget,
				);
				continue;
			}
			const status = faceView.textureResolution.status;
			if (status !== "resolved") {
				const target = warningTargetFor(
					faceView.texture,
					faceView.textureResolution.resolvedTo,
				);
				const code =
					status === "unresolved" || status === "external"
						? "MODEL_PREVIEW_TEXTURE_UNRESOLVED"
						: "MODEL_PREVIEW_TEXTURE_MISSING";
				addPreviewWarning(
					warnings,
					code,
					target,
					`Texture ${target} could not be resolved (${status}).`,
				);
				addSkip(skipped, "texture", status, target);
			}
		}
	}

	for (const entry of drawn) {
		const orderedFaces = [...entry.element.faces].sort(
			(a, b) => DIRECTIONS.indexOf(a.face) - DIRECTIONS.indexOf(b.face),
		);
		for (const faceView of orderedFaces) {
			const faceName = faceView.face;
			let panelIndex = -1;
			let localX0 = 0;
			let localX1 = -1;
			let localY0 = 0;
			let localY1 = -1;
			let depth = Number.NEGATIVE_INFINITY;
			if (faceName === "north") {
				panelIndex = 0;
				localX0 =
					Math.floor(
						((globalMaxXFixed - entry.maxXFixed) * pixelsPerUnit) / 256,
					) + frontOffsetX;
				localX1 =
					Math.floor(
						((globalMaxXFixed - entry.minXFixed) * pixelsPerUnit) / 256,
					) + frontOffsetX;
				localY0 =
					Math.floor(
						((globalMaxYFixed - entry.maxYFixed) * pixelsPerUnit) / 256,
					) + frontOffsetY;
				localY1 =
					Math.floor(
						((globalMaxYFixed - entry.minYFixed) * pixelsPerUnit) / 256,
					) + frontOffsetY;
				depth = -entry.minZFixed;
			} else if (faceName === "east") {
				panelIndex = 1;
				localX0 =
					Math.floor(
						((globalMaxZFixed - entry.maxZFixed) * pixelsPerUnit) / 256,
					) + rightOffsetX;
				localX1 =
					Math.floor(
						((globalMaxZFixed - entry.minZFixed) * pixelsPerUnit) / 256,
					) + rightOffsetX;
				localY0 =
					Math.floor(
						((globalMaxYFixed - entry.maxYFixed) * pixelsPerUnit) / 256,
					) + rightOffsetY;
				localY1 =
					Math.floor(
						((globalMaxYFixed - entry.minYFixed) * pixelsPerUnit) / 256,
					) + rightOffsetY;
				depth = entry.maxXFixed;
			} else if (faceName === "up") {
				panelIndex = 2;
				localX0 =
					Math.floor(
						((entry.minXFixed - globalMinXFixed) * pixelsPerUnit) / 256,
					) + topOffsetX;
				localX1 =
					Math.floor(
						((entry.maxXFixed - globalMinXFixed) * pixelsPerUnit) / 256,
					) + topOffsetX;
				localY0 =
					Math.floor(
						((entry.minZFixed - globalMinZFixed) * pixelsPerUnit) / 256,
					) + topOffsetY;
				localY1 =
					Math.floor(
						((entry.maxZFixed - globalMinZFixed) * pixelsPerUnit) / 256,
					) + topOffsetY;
				depth = entry.maxYFixed;
			} else {
				continue;
			}
			if (isTranslucentFace(faceView.texture, faceView.textureResolution.via)) {
				continue;
			}
			const status = faceView.textureResolution.status;
			let decoded: DecodedTexture | undefined;
			let useChecker = status !== "resolved";
			if (!useChecker) {
				const resolvedTo =
					faceView.textureResolution.resolvedTo ?? faceView.texture;
				const rel = textureResourcePath(resolvedTo);
				decoded = await decodedTexture(rel);
				if (decoded === undefined) {
					const target = warningTargetFor(faceView.texture, resolvedTo);
					addPreviewWarning(
						warnings,
						"MODEL_PREVIEW_TEXTURE_UNDECODABLE",
						target,
						`Texture ${target} could not be decoded.`,
					);
					addSkip(skipped, "texture", "undecodable", target);
					useChecker = true;
				}
			}
			const uv =
				faceView.uv ??
				autoUv(
					faceName,
					entry.minX,
					entry.minY,
					entry.minZ,
					entry.maxX,
					entry.maxY,
					entry.maxZ,
				);
			const u1 = uv[0];
			const v1 = uv[1];
			const u2 = uv[2];
			const v2 = uv[3];
			const rotation = faceView.rotation;
			const clippedX0 = Math.max(0, Math.min(localX0, localX1));
			const clippedX1 = Math.min(size - 1, Math.max(localX0, localX1));
			const clippedY0 = Math.max(0, Math.min(localY0, localY1));
			const clippedY1 = Math.min(size - 1, Math.max(localY0, localY1));
			if (clippedX1 < clippedX0 || clippedY1 < clippedY0) continue;
			const rectW = Math.max(localX0, localX1) - Math.min(localX0, localX1) + 1;
			const rectH = Math.max(localY0, localY1) - Math.min(localY0, localY1) + 1;
			const rectMinX = Math.min(localX0, localX1);
			const rectMinY = Math.min(localY0, localY1);
			const depthBuffer =
				panelIndex === 0
					? depthFront
					: panelIndex === 1
						? depthRight
						: depthTop;
			const panelOriginX = panelIndex * size;
			for (let ly = clippedY0; ly <= clippedY1; ly += 1) {
				for (let lx = clippedX0; lx <= clippedX1; lx += 1) {
					const depthIndex = ly * size + lx;
					const stored = depthBuffer[depthIndex] as number;
					if (depth < stored) continue;
					const globalX = panelOriginX + lx;
					const globalY = ly;
					let rgba: readonly [number, number, number, number];
					if (useChecker) {
						rgba = checkerColor(globalX, globalY);
					} else {
						const view = decoded as DecodedTexture;
						const u = lx - rectMinX;
						const v = ly - rectMinY;
						const fx = (u + 0.5) / rectW;
						const fy = (v + 0.5) / rectH;
						const [tx, ty] = rotateFaceCoords(fx, fy, rotation);
						const sampleU = u1 + tx * (u2 - u1);
						const sampleV = v1 + ty * (v2 - v1);
						rgba = sampleTexture(view, sampleU, sampleV);
					}
					const o = (globalY * imageWidth + globalX) * 4;
					flat[o] = rgba[0];
					flat[o + 1] = rgba[1];
					flat[o + 2] = rgba[2];
					flat[o + 3] = rgba[3];
					depthBuffer[depthIndex] = depth;
				}
			}
		}
	}

	skipped.sort(
		(a, b) =>
			(a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
			(a.target < b.target ? -1 : a.target > b.target ? 1 : 0) ||
			(a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
	);
	warnings.sort((a, b) =>
		a.code === b.code
			? a.target < b.target
				? -1
				: a.target > b.target
					? 1
					: 0
			: a.code < b.code
				? -1
				: 1,
	);
	const coverage: ModelCoverage = {
		status: skipped.length === 0 ? "complete" : "partial",
		skipped,
	};

	const canvas = createCanvas(imageWidth, imageHeight);
	addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, "base", flat);

	return {
		report: {
			command: "model",
			mode: "preview",
			path: options.path,
			...(options.modelId === undefined ? {} : { modelId: options.modelId }),
			size,
			version: inspection.version,
			image: previewImageSize(size),
			panels: previewPanels(size),
			range: { min: rangeMin, max: rangeMax, pixelsPerUnit },
			coverage,
			warnings,
			unapplied: ["display", "lighting"],
		},
		png: encodePng(canvas),
	};
}
