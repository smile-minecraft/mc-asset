import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import {
	FONT_ADVANCE,
	FONT_HEIGHT,
	FONT_WIDTH,
	glyphFor,
} from "../core/pixel-font.ts";
import { encodePng } from "../io/png.ts";
import {
	applyMat3,
	blendFragment,
	createRasterTarget,
	FIXED_UNIT,
	type FixedVec3,
	IDENTITY_MAT3,
	type Mat3,
	multiplyMat3,
	type ProjectedPoint,
	projectIsometric,
	type RasterVertex,
	type RgbaColor,
	type RgbaTexture,
	rasterizeQuad,
	rasterizeQuadFragments,
	rotationMatrix,
	SUBPIXEL,
	toSubpixel,
} from "../model/geometry/index.ts";
import { type EntityLayoutSummary, entityLayoutSummary } from "./inspect.ts";
import type {
	EntityFace,
	EntityFaceName,
	EntityLayout,
	EntityPart,
} from "./types.ts";
import type { EntityTextureInput } from "./validate.ts";

/**
 * The entity texture preview: assemble a box-UV layout into its 3D parts and
 * wrap the texture around each part by the vanilla box-UV face parameterization.
 *
 * The layout uses the world orientation a player has at yaw 0: the character
 * faces south (+z), their right is west (-x), up is +y, and the feet sit at
 * y = 0. Vanilla `ModelBiped` stores the same boxes with +y down and the
 * renderer applies `scale(-1, -1, 1)` plus a 180-degree yaw, which is exactly
 * the y and z flip that turns that model space into this one.
 *
 * With that orientation the box-UV cells land like this (the `uv` array's
 * oriented `[u1, v1, u2, v2]` corners already carry the cell placement and the
 * mirror flip, so they are sampled directly):
 *
 *   front (+z)   s = x,     t = 1 - y
 *   back  (-z)   s = 1 - x, t = 1 - y
 *   right (-x)   s = z,     t = 1 - y
 *   left  (+x)   s = 1 - z, t = 1 - y
 *   top   (+y)   s = 1 - x, t = 1 - z
 *   bottom(-y)   s = 1 - x, t = z
 *
 * `s` runs from the first U corner to the second, `t` from the first V corner
 * to the second, and the cell stretches across the inflated box exactly as the
 * game dilates the hat, jacket, sleeves, and pants. This is the same face
 * parameterization OptiFine box UV uses, in a right-handed world where the
 * model faces +z; it keeps the face cells' sheet adjacency (the right cell's
 * right edge meets the front cell's left edge) and leaves every face unmirrored
 * when viewed from outside.
 *
 * Four 2:1 isometric panels are laid out left to right in the order
 * `south-east`, `north-east`, `north-west`, `south-west`, which together show
 * the front, right, back, left, and top faces. Every panel shares one scale so
 * the four views are directly comparable, and a label strip under each panel
 * names its camera direction. A texture whose size differs from the layout is
 * refused before anything is drawn, so a mismatched file never produces an
 * image that looks plausible.
 */

export const ENTITY_PREVIEW_DIRECTIONS = [
	"south-east",
	"north-east",
	"north-west",
	"south-west",
] as const;

export type EntityPreviewDirection = (typeof ENTITY_PREVIEW_DIRECTIONS)[number];

/** Panel edge sizes the preview accepts; the image is size*4 wide plus a label strip. */
export type EntityPreviewSize = 64 | 128 | 256;

export interface EntityPreviewPanel {
	readonly name: EntityPreviewDirection;
	readonly x: number;
	/** The square view starts at y = 0; the label strip is below it. */
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface EntityPreviewRange {
	readonly min: FixedVec3;
	readonly max: FixedVec3;
	readonly pixelsPerUnit: number;
}

export interface EntityPreviewSkip {
	readonly kind: "content";
	readonly reason: "clipped";
	readonly target: EntityPreviewDirection;
	readonly detail: string;
}

export interface EntityPreviewCoverage {
	readonly status: "complete" | "partial";
	readonly skipped: readonly EntityPreviewSkip[];
}

export interface EntityPreviewReport {
	readonly command: "entity";
	readonly mode: "preview";
	readonly path: string;
	readonly layout: EntityLayoutSummary;
	readonly texture: { readonly width: number; readonly height: number };
	readonly size: EntityPreviewSize;
	readonly image: { readonly width: number; readonly height: number };
	readonly panels: readonly EntityPreviewPanel[];
	readonly range: EntityPreviewRange;
	readonly coverage: EntityPreviewCoverage;
	/** Render steps this diagnostic view deliberately does not apply. */
	readonly unapplied: readonly string[];
	readonly output?: string | undefined;
}

export interface EntityPreviewOptions {
	readonly texturePath: string;
	readonly size: EntityPreviewSize;
}

export interface EntityPreviewResult {
	readonly report: EntityPreviewReport;
	readonly png: Uint8Array;
}

const UNIT = FIXED_UNIT;
/** Room for one 5x7 label under each panel, with 2 px above and 3 px below. */
const LABEL_STRIP = FONT_HEIGHT + 5;

const FACES: readonly EntityFaceName[] = [
	"top",
	"bottom",
	"right",
	"front",
	"left",
	"back",
];

type CornerBits = readonly [x: 0 | 1, y: 0 | 1, z: 0 | 1];

/**
 * The four box corners of one face in (s, t) order: (0,0), (1,0), (1,1), (0,1).
 * Bits select the minimum (0) or maximum (1) corner on each axis, matching the
 * order `cubeCorners` uses.
 *
 * Top and bottom are the two faces whose in-cell direction is easy to get
 * backwards, so both were read from the vanilla cube instead of guessed from
 * the sheet. Source: the Minecraft Java Edition 26.2 client jar (its
 * version.json reports id 26.2, build 2026-06-16; the jar is unobfuscated), in
 * particular `net.minecraft.client.model.geom.ModelPart$Cube`'s constructor
 * `(int u, int v, float x, float y, float z, float sizeX, float sizeY,
 * float sizeZ, float growX, float growY, float growZ, boolean mirror,
 * float uScale, float vScale, Set<Direction>)` and
 * `ModelPart$Polygon(Vertex[], float u1, float v1, float u2, float v2, ...)`.
 * `Polygon` maps its vertex list, in order, to the UV corners (u2,v1),
 * (u1,v1), (u1,v2), (u2,v2).
 *
 * The cube's `Direction.UP` polygon (the `maxY` side of the model, which the
 * living-entity renderer's `scale(-1, -1, 1)` turns into the world's bottom
 * face) lists its vertices as `(maxX,maxY,minZ)`, `(minX,maxY,minZ)`,
 * `(minX,maxY,maxZ)`, `(maxX,maxY,maxZ)` and passes the UV bounds
 * `(u+depth+width, v+depth, u+depth+2*width, v)`; `Polygon` remaps vertex i
 * in that order to `(uB,vA)`, `(uA,vA)`, `(uA,vB)`, `(uB,vB)` for
 * `uA = u+depth+width`, `vA = v+depth`, `uB = u+depth+2*width`, `vB = v`.
 * Through the renderer's world mapping `(x, -y, -z)` the four vertices are
 * (east,bottom,front), (west,bottom,front), (west,bottom,back),
 * (east,bottom,back). In the oriented frame the (s, t) order is
 * (right,top), (left,top), (left,bottom), (right,bottom), which reads
 * east-back, west-back, west-front, east-front: the bottom cell's left edge
 * is west and its top edge is back. The `Direction.DOWN` polygon (the world's
 * top face) gives the top cell the same left-west, top-back orientation:
 * east-front, west-front, west-back, east-back. That also puts each cell's
 * front edge on the sheet's bottom edge, so the top cell's bottom row meets
 * the front cell's top row.
 */
const FACE_CORNERS: Readonly<
	Record<
		EntityFaceName,
		readonly [CornerBits, CornerBits, CornerBits, CornerBits]
	>
> = {
	front: [
		[0, 1, 1],
		[1, 1, 1],
		[1, 0, 1],
		[0, 0, 1],
	],
	back: [
		[1, 1, 0],
		[0, 1, 0],
		[0, 0, 0],
		[1, 0, 0],
	],
	right: [
		[0, 1, 0],
		[0, 1, 1],
		[0, 0, 1],
		[0, 0, 0],
	],
	left: [
		[1, 1, 1],
		[1, 1, 0],
		[1, 0, 0],
		[1, 0, 1],
	],
	top: [
		[1, 1, 1],
		[0, 1, 1],
		[0, 1, 0],
		[1, 1, 0],
	],
	bottom: [
		[1, 0, 0],
		[0, 0, 0],
		[0, 0, 1],
		[1, 0, 1],
	],
};

interface PreviewBox {
	readonly part: EntityPart;
	/** The eight inflated box corners after the part rotation, indexed by bits. */
	readonly corners: readonly FixedVec3[];
}

interface SceneFace {
	readonly face: EntityFace;
	readonly corners: readonly [FixedVec3, FixedVec3, FixedVec3, FixedVec3];
	/** Texture coordinates in 1/256 texel, one per corner. */
	readonly texCoords: readonly [
		readonly [number, number],
		readonly [number, number],
		readonly [number, number],
		readonly [number, number],
	];
	readonly coverage: "opaque" | "translucent" | "empty";
}

interface TranslucentFragment {
	readonly pixel: number;
	readonly depth: number;
	readonly color: RgbaColor;
}

function isSupportedSize(value: unknown): value is EntityPreviewSize {
	return value === 64 || value === 128 || value === 256;
}

function fixed(value: number): number {
	return Math.round(value * UNIT);
}

function normalizeZero(value: number): number {
	return value === 0 ? 0 : value;
}

function cornerIndex(bits: CornerBits): number {
	return bits[0] | (bits[1] << 1) | (bits[2] << 2);
}

function cubeCorners(min: FixedVec3, max: FixedVec3): FixedVec3[] {
	const corners: FixedVec3[] = [];
	for (let index = 0; index < 8; index += 1) {
		corners.push([
			index & 1 ? (max[0] as number) : (min[0] as number),
			index & 2 ? (max[1] as number) : (min[1] as number),
			index & 4 ? (max[2] as number) : (min[2] as number),
		]);
	}
	return corners;
}

function rotatePoint(
	point: FixedVec3,
	matrix: Mat3 | undefined,
	pivot: FixedVec3,
): FixedVec3 {
	if (matrix === undefined) return point;
	const local: FixedVec3 = [
		(point[0] as number) - (pivot[0] as number),
		(point[1] as number) - (pivot[1] as number),
		(point[2] as number) - (pivot[2] as number),
	];
	const rotated = applyMat3(matrix, local);
	return [
		(rotated[0] as number) + (pivot[0] as number),
		(rotated[1] as number) + (pivot[1] as number),
		(rotated[2] as number) + (pivot[2] as number),
	];
}

/** Euler x, then y, then z, the same order the model preview uses. */
function partRotation(part: EntityPart): Mat3 | undefined {
	const rotation = part.rotation;
	if (rotation === undefined) return undefined;
	let matrix: Mat3 = IDENTITY_MAT3;
	const axes = ["x", "y", "z"] as const;
	for (let index = 0; index < axes.length; index += 1) {
		const degrees = rotation[index] as number;
		if (degrees === 0) continue;
		if (!Number.isFinite(degrees)) {
			throw new McAssetError(
				"ENTITY_LAYOUT_INVALID",
				`Part "${part.id}" has a non-finite rotation.`,
				{ reason: "invalid-rotation", part: part.id },
			);
		}
		matrix = multiplyMat3(
			rotationMatrix(
				axes[index] as "x" | "y" | "z",
				Math.round(degrees * 1000),
			),
			matrix,
		);
	}
	return matrix;
}

function hasRotation(part: EntityPart): boolean {
	const rotation = part.rotation;
	return (
		rotation !== undefined &&
		(rotation[0] !== 0 || rotation[1] !== 0 || rotation[2] !== 0)
	);
}

/**
 * One part's inflated box in 1/256 model units. A part without a placed
 * origin cannot be drawn, and a rotated part without a pivot would swing
 * around the model origin instead of its joint; both refuse with a named part.
 */
function assembleBoxes(layout: EntityLayout): PreviewBox[] {
	const missingOrigin: string[] = [];
	const missingPivot: string[] = [];
	for (const part of layout.parts) {
		if (part.origin === undefined) missingOrigin.push(part.id);
		else if (hasRotation(part) && part.pivot === undefined) {
			missingPivot.push(part.id);
		}
	}
	if (missingOrigin.length > 0) {
		throw new McAssetError(
			"ENTITY_LAYOUT_INVALID",
			`3D preview needs an origin for every part; missing: ${missingOrigin.join(", ")}.`,
			{ reason: "missing-placement", parts: missingOrigin },
		);
	}
	if (missingPivot.length > 0) {
		throw new McAssetError(
			"ENTITY_LAYOUT_INVALID",
			`3D preview needs a pivot for every rotated part; missing: ${missingPivot.join(", ")}.`,
			{ reason: "missing-pivot", parts: missingPivot },
		);
	}
	return layout.parts.map((part) => {
		const origin = part.origin as readonly [number, number, number];
		const inflate = part.inflate === undefined ? 0 : fixed(part.inflate);
		const min: FixedVec3 = [
			fixed(origin[0]) - inflate,
			fixed(origin[1]) - inflate,
			fixed(origin[2]) - inflate,
		];
		const max: FixedVec3 = [
			fixed(origin[0]) + part.size[0] * UNIT + inflate,
			fixed(origin[1]) + part.size[1] * UNIT + inflate,
			fixed(origin[2]) + part.size[2] * UNIT + inflate,
		];
		const matrix = partRotation(part);
		const pivot: FixedVec3 =
			part.pivot === undefined
				? [0, 0, 0]
				: [fixed(part.pivot[0]), fixed(part.pivot[1]), fixed(part.pivot[2])];
		const corners = cubeCorners(min, max).map((corner) =>
			rotatePoint(corner, matrix, pivot),
		);
		return { part, corners };
	});
}

/** 1..254 alpha inside the face cell: that face belongs to the translucent pass. */
function faceCoverage(
	face: EntityFace,
	texture: EntityTextureInput,
): SceneFace["coverage"] {
	let opaque = false;
	const { x, y, width, height } = face.rect;
	for (let row = y; row < y + height; row += 1) {
		for (let column = x; column < x + width; column += 1) {
			const alpha = texture.pixels[(row * texture.width + column) * 4 + 3];
			if (alpha === 0) continue;
			if (alpha !== 255) return "translucent";
			opaque = true;
		}
	}
	return opaque ? "opaque" : "empty";
}

function assembleFaces(
	boxes: readonly PreviewBox[],
	texture: EntityTextureInput,
): SceneFace[] {
	const faces: SceneFace[] = [];
	for (const box of boxes) {
		for (const faceName of FACES) {
			const face = box.part.faces.find((entry) => entry.face === faceName);
			if (face === undefined) continue;
			const coverage = faceCoverage(face, texture);
			if (coverage === "empty") continue;
			const cornerBits = FACE_CORNERS[faceName];
			const [u1, v1, u2, v2] = face.uv;
			const corners = cornerBits.map(
				(bits) => box.corners[cornerIndex(bits)] as FixedVec3,
			) as [FixedVec3, FixedVec3, FixedVec3, FixedVec3];
			const texCoords = [
				[u1 * UNIT, v1 * UNIT],
				[u2 * UNIT, v1 * UNIT],
				[u2 * UNIT, v2 * UNIT],
				[u1 * UNIT, v2 * UNIT],
			] as const;
			faces.push({ face, corners, texCoords, coverage });
		}
	}
	return faces;
}

function boundsOf(points: readonly ProjectedPoint[]): {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
} {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		if (point.x < minX) minX = point.x;
		if (point.y < minY) minY = point.y;
		if (point.x > maxX) maxX = point.x;
		if (point.y > maxY) maxY = point.y;
	}
	return { minX, minY, maxX, maxY };
}

function compareFragments(
	a: TranslucentFragment,
	b: TranslucentFragment,
): number {
	return (
		a.pixel - b.pixel ||
		a.depth - b.depth ||
		a.color[0] - b.color[0] ||
		a.color[1] - b.color[1] ||
		a.color[2] - b.color[2] ||
		a.color[3] - b.color[3]
	);
}

function textWidth(text: string): number {
	return text.length * FONT_ADVANCE - 1;
}

/**
 * White label with a one-pixel black shadow, so it reads on either a light or
 * a dark viewer background without painting an opaque box over the art.
 */
function drawLabel(
	pixels: Uint8Array,
	imageWidth: number,
	imageHeight: number,
	originX: number,
	originY: number,
	text: string,
): void {
	const set = (x: number, y: number, rgba: RgbaColor): void => {
		if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) return;
		const offset = (y * imageWidth + x) * 4;
		pixels[offset] = rgba[0];
		pixels[offset + 1] = rgba[1];
		pixels[offset + 2] = rgba[2];
		pixels[offset + 3] = rgba[3];
	};
	for (let index = 0; index < text.length; index += 1) {
		const glyph = glyphFor(text[index] as string);
		const glyphX = originX + index * FONT_ADVANCE;
		for (let row = 0; row < FONT_HEIGHT; row += 1) {
			const bits = glyph.rows[row] as number;
			for (let column = 0; column < FONT_WIDTH; column += 1) {
				if ((bits & (1 << (FONT_WIDTH - 1 - column))) === 0) continue;
				set(glyphX + column + 1, originY + row + 1, [0, 0, 0, 255]);
			}
		}
	}
	for (let index = 0; index < text.length; index += 1) {
		const glyph = glyphFor(text[index] as string);
		const glyphX = originX + index * FONT_ADVANCE;
		for (let row = 0; row < FONT_HEIGHT; row += 1) {
			const bits = glyph.rows[row] as number;
			for (let column = 0; column < FONT_WIDTH; column += 1) {
				if ((bits & (1 << (FONT_WIDTH - 1 - column))) === 0) continue;
				set(glyphX + column, originY + row, [255, 255, 255, 255]);
			}
		}
	}
}

function panelVertices(
	face: SceneFace,
	direction: EntityPreviewDirection,
	viewport: {
		readonly scale: number;
		readonly offsetX: number;
		readonly offsetY: number;
	},
	bounds: { readonly minX: number; readonly minY: number },
): [RasterVertex, RasterVertex, RasterVertex, RasterVertex] {
	const vertices = face.corners.map((corner, index) => {
		const point = projectIsometric(corner, direction);
		const sub = toSubpixel(
			{
				x: point.x - bounds.minX,
				y: point.y - bounds.minY,
				depth: point.depth,
			},
			viewport,
		);
		const texCoord = face.texCoords[index] as readonly [number, number];
		return { x: sub.x, y: sub.y, z: sub.z, u: texCoord[0], v: texCoord[1] };
	});
	return [
		vertices[0] as RasterVertex,
		vertices[1] as RasterVertex,
		vertices[2] as RasterVertex,
		vertices[3] as RasterVertex,
	];
}

function renderPanel(
	faces: readonly SceneFace[],
	direction: EntityPreviewDirection,
	size: EntityPreviewSize,
	scale: number,
	bounds: {
		readonly minX: number;
		readonly minY: number;
		readonly maxX: number;
		readonly maxY: number;
	},
	texture: RgbaTexture,
): { readonly pixels: Uint8Array; readonly clipped: boolean } {
	const spanX = Math.floor(((bounds.maxX - bounds.minX) * scale) / UNIT);
	const spanY = Math.floor(((bounds.maxY - bounds.minY) * scale) / UNIT);
	const offsetX = Math.floor((size * SUBPIXEL - spanX) / 2);
	const offsetY = Math.floor((size * SUBPIXEL - spanY) / 2);
	const viewport = { scale, offsetX, offsetY };
	const target = createRasterTarget(size, size);

	for (const face of faces) {
		if (face.coverage !== "opaque") continue;
		const [a, b, c, d] = panelVertices(face, direction, viewport, bounds);
		rasterizeQuad(target, a, b, c, d, { texture });
	}

	const fragments: TranslucentFragment[] = [];
	const opaqueDepth = target.depth;
	for (const face of faces) {
		if (face.coverage !== "translucent") continue;
		const [a, b, c, d] = panelVertices(face, direction, viewport, bounds);
		rasterizeQuadFragments(
			size,
			size,
			a,
			b,
			c,
			d,
			{ texture },
			(pixel, depth, color) => {
				if (depth < (opaqueDepth[pixel] as number)) return;
				fragments.push({ pixel, depth, color });
			},
		);
	}
	fragments.sort(compareFragments);
	for (const fragment of fragments) {
		blendFragment(target, fragment.pixel, fragment.color);
	}

	return {
		pixels: target.pixels,
		clipped: spanX > size * SUBPIXEL || spanY > size * SUBPIXEL,
	};
}

/** Render the four-panel PNG plus its diagnostic report. */
export function renderEntityPreview(
	layout: EntityLayout,
	texture: EntityTextureInput,
	options: EntityPreviewOptions,
): EntityPreviewResult {
	if (!isSupportedSize(options.size)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`preview size must be one of 64, 128, or 256: ${String(options.size)}.`,
			{ field: "size", size: options.size },
		);
	}
	if (texture.pixels.length !== texture.width * texture.height * 4) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Texture pixels must hold exactly width * height * 4 bytes.",
			{
				width: texture.width,
				height: texture.height,
				actual: texture.pixels.length,
			},
		);
	}
	// Refuse a mismatched size before any pixel work: a stretched preview would
	// hide exactly the mistake this mode exists to catch.
	if (
		texture.width !== layout.texture.width ||
		texture.height !== layout.texture.height
	) {
		throw new McAssetError(
			"ENTITY_TEXTURE_SIZE_MISMATCH",
			`Texture is ${texture.width}x${texture.height} but layout "${layout.id}" expects ${layout.texture.width}x${layout.texture.height}.`,
			{
				expected: { ...layout.texture },
				actual: { width: texture.width, height: texture.height },
			},
		);
	}

	const size = options.size;
	const boxes = assembleBoxes(layout);
	const faces = assembleFaces(boxes, texture);
	const rgbaTexture: RgbaTexture = {
		width: texture.width,
		height: texture.height,
		pixels: texture.pixels,
	};

	const margin = Math.max(1, Math.floor(size / 16));
	const available = size - 2 * margin;
	let widest = 0;
	const directionBounds = new Map<
		EntityPreviewDirection,
		ReturnType<typeof boundsOf>
	>();
	for (const direction of ENTITY_PREVIEW_DIRECTIONS) {
		const points = boxes.flatMap((box) =>
			box.corners.map((corner) => projectIsometric(corner, direction)),
		);
		const bounds = boundsOf(points);
		directionBounds.set(direction, bounds);
		const extent = Math.max(
			bounds.maxX - bounds.minX,
			bounds.maxY - bounds.minY,
		);
		if (extent > widest) widest = extent;
	}
	const scale =
		widest > 0
			? Math.max(SUBPIXEL, Math.floor((available * SUBPIXEL * UNIT) / widest))
			: SUBPIXEL;

	const imageWidth = size * ENTITY_PREVIEW_DIRECTIONS.length;
	const imageHeight = size + LABEL_STRIP;
	const pixels = new Uint8Array(imageWidth * imageHeight * 4);
	const panels: EntityPreviewPanel[] = [];
	const skipped: EntityPreviewSkip[] = [];

	for (let index = 0; index < ENTITY_PREVIEW_DIRECTIONS.length; index += 1) {
		const direction = ENTITY_PREVIEW_DIRECTIONS[
			index
		] as EntityPreviewDirection;
		const panelX = index * size;
		panels.push({
			name: direction,
			x: panelX,
			y: 0,
			width: size,
			height: size,
		});
		const panel = renderPanel(
			faces,
			direction,
			size,
			scale,
			directionBounds.get(direction) as ReturnType<typeof boundsOf>,
			rgbaTexture,
		);
		for (let row = 0; row < size; row += 1) {
			const from = row * size * 4;
			const to = (row * imageWidth + panelX) * 4;
			pixels.set(panel.pixels.subarray(from, from + size * 4), to);
		}
		const label = direction.toUpperCase();
		drawLabel(
			pixels,
			imageWidth,
			imageHeight,
			panelX + Math.floor((size - textWidth(label)) / 2),
			size + 2,
			label,
		);
		if (panel.clipped) {
			skipped.push({
				kind: "content",
				reason: "clipped",
				target: direction,
				detail: `projected content does not fit a ${size}x${size} panel at ${(scale / SUBPIXEL).toFixed(4)} px per unit`,
			});
		}
	}

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;
	for (const box of boxes) {
		for (const corner of box.corners) {
			if (corner[0] < minX) minX = corner[0];
			if (corner[1] < minY) minY = corner[1];
			if (corner[2] < minZ) minZ = corner[2];
			if (corner[0] > maxX) maxX = corner[0];
			if (corner[1] > maxY) maxY = corner[1];
			if (corner[2] > maxZ) maxZ = corner[2];
		}
	}

	const canvas = createCanvas(imageWidth, imageHeight);
	addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, "base", pixels);

	return {
		report: {
			command: "entity",
			mode: "preview",
			path: options.texturePath,
			layout: entityLayoutSummary(layout),
			texture: { width: texture.width, height: texture.height },
			size,
			image: { width: imageWidth, height: imageHeight },
			panels,
			range: {
				min: [
					normalizeZero(minX / UNIT),
					normalizeZero(minY / UNIT),
					normalizeZero(minZ / UNIT),
				],
				max: [
					normalizeZero(maxX / UNIT),
					normalizeZero(maxY / UNIT),
					normalizeZero(maxZ / UNIT),
				],
				pixelsPerUnit: scale / SUBPIXEL,
			},
			coverage: {
				status: skipped.length === 0 ? "complete" : "partial",
				skipped,
			},
			unapplied: ["lighting", "animation"],
		},
		png: encodePng(canvas),
	};
}
