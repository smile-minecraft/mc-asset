import {
	applyMat3,
	blendFragment,
	createRasterTarget,
	divRound,
	type FixedVec3,
	IDENTITY_MAT3,
	type Mat3,
	multiplyMat3,
	type ProjectedPoint,
	projectIsometric,
	projectOrthographic,
	type RasterSource,
	type RasterVertex,
	type RgbaColor,
	type RgbaTexture,
	rasterizeQuad,
	rasterizeQuadFragments,
	rotationMatrix,
	SUBPIXEL,
	TRIG_ONE,
	toSubpixel,
} from "../geometry/index.ts";
import type { ModelElementView, ModelFaceView } from "../inspect.ts";
import type { ModelCoverageSkip } from "../structure.ts";
import { DIRECTIONS, type Direction, type FaceRotation } from "../types.ts";
import {
	autoUv,
	checkerTexture,
	type DecodedTexture,
	rotateFaceCoords,
} from "./pixels.ts";
import type {
	ModelPreviewPanel,
	ModelPreviewRange,
	ModelPreviewSize,
	ModelPreviewView,
	ModelPreviewWarning,
	ModelPreviewWarningCode,
} from "./types.ts";

/**
 * The geometry-backed preview renderer.
 *
 * Every cuboid element is turned into its eight world corners by applying the
 * element rotation (axis/angle with optional rescale, or the x / y / z form,
 * axis first) around its origin. Each declared face becomes a textured quad
 * with four world corners, the texture rectangle from `uv` or the vanilla
 * auto-UV, and the face rotation applied as a permutation of the texture
 * corners. Faces are never culled by their normal and are never culled by
 * `cullface`: an orthographic or isometric projection keeps the depth order,
 * so a z-buffer resolves hidden faces and both sides of a zero-thickness
 * plane stay visible, matching how Minecraft draws model quads.
 *
 * Opaque faces are drawn first in document order (element order, then
 * DIRECTIONS order) and win depth ties like the three-view compatibility
 * renderer. Partially transparent faces never touch the depth buffer: every
 * translucent fragment is collected, depth-tested only against the opaque
 * result, and composed into its pixel from far to near with integer
 * straight-alpha blending once every opaque face has been drawn. The
 * ordering at one pixel carries a second key that does not depend on the
 * document order of the elements (the sampled colour), so swapping the
 * `elements` array cannot change a single output byte when two translucent
 * faces are exactly coplanar. When the projected content does not fit its
 * panel at the smallest supported scale (one pixel per model unit), the panel
 * is reported as clipped in `skipped` instead of drawing a silently cut image
 * and calling it complete.
 *
 * All coordinates stay integer: corners are in 1/256 model units, the
 * projection and viewport rounding come from `src/model/geometry/`, and the
 * placement of every panel is a pure function of the transformed bounds.
 * Model coordinates are quantized to that grid (from/to and origin to 1/256
 * unit), and angles are quantized to milli-degrees, which is the resolution
 * the rotation tables carry.
 */

const UNIT = 256;

export interface PreviewSceneElement {
	readonly index: number;
	readonly element: ModelElementView;
	/** Element box in 1/256 model units, before rotation. */
	readonly min: FixedVec3;
	readonly max: FixedVec3;
}

export interface PreviewSceneOptions {
	readonly elements: readonly PreviewSceneElement[];
	readonly view: ModelPreviewView;
	readonly size: ModelPreviewSize;
	/** Resolve one texture resource path; undefined means it could not be decoded. */
	readonly loadTexture: (rel: string) => Promise<DecodedTexture | undefined>;
	/** True when the face texture variable declares `force_translucent`. */
	readonly isForceTranslucent: (face: ModelFaceView) => boolean;
}

export interface PreviewSceneResult {
	readonly pixels: Uint8Array;
	readonly width: number;
	readonly height: number;
	readonly panels: readonly ModelPreviewPanel[];
	readonly range: ModelPreviewRange;
	readonly skipped: readonly ModelCoverageSkip[];
	readonly warnings: readonly ModelPreviewWarning[];
}

type ElementRotation = NonNullable<ModelElementView["rotation"]>;
type RotationAxis = "x" | "y" | "z";

interface ElementBox {
	readonly element: ModelElementView;
	/** Element box before rotation, in 1/256 model units. */
	readonly localMin: FixedVec3;
	readonly localMax: FixedVec3;
	readonly worldCorners: readonly FixedVec3[];
	readonly matrix: Mat3 | undefined;
	readonly origin: FixedVec3;
}

interface SceneFace {
	readonly face: Direction;
	readonly corners: readonly FixedVec3[];
	/** Texture coordinates in model UV units (0..16), one per corner. */
	readonly texCoords: readonly (readonly [number, number])[];
	/** Undefined means the fixed checkerboard. */
	readonly texture: DecodedTexture | undefined;
	readonly translucent: boolean;
}

/** One translucent fragment: the pixel it covers, its depth and sampled colour. */
interface TranslucentFragment {
	readonly pixel: number;
	readonly depth: number;
	readonly color: RgbaColor;
}

/**
 * Far to near at every pixel, so the nearest fragment is composed last.
 *
 * The depth is the primary key and larger means nearer, so ascending depth is
 * far to near. Two fragments at exactly the same depth need an order that does
 * not depend on where their face sits in `elements`: a coplanar pair has no
 * physical order, so the sampled colour breaks the tie. That keeps the output
 * byte-identical when a caller swaps the elements.
 */
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

function fixedPoint(value: number): number {
	return Math.round(value * UNIT);
}

function normalizeZero(value: number): number {
	return value === 0 ? 0 : value;
}

function scaleMatrix(axis: RotationAxis, factor: number): Mat3 {
	if (axis === "x") {
		return [TRIG_ONE, 0, 0, 0, factor, 0, 0, 0, factor];
	}
	if (axis === "y") {
		return [factor, 0, 0, 0, TRIG_ONE, 0, 0, 0, factor];
	}
	return [factor, 0, 0, 0, factor, 0, 0, 0, TRIG_ONE];
}

/** The cosine on the rotation axis' own diagonal is always 1, so read a perpendicular one. */
function axisCosine(matrix: Mat3, axis: RotationAxis): number {
	return Math.abs(axis === "x" ? (matrix[4] as number) : (matrix[0] as number));
}

/**
 * `rescale` multiplies the two axes perpendicular to the rotation axis by
 * 1 / cos(angle) around the origin, after the rotation. Values are Q16 like
 * every other matrix entry; 1 / cos(22.5 degrees) becomes 70941 (1.0824).
 */
function rescaleMatrix(axis: RotationAxis, rotated: Mat3): Mat3 | "invalid" {
	const cosine = axisCosine(rotated, axis);
	if (cosine <= 0) return "invalid";
	const factor = divRound(TRIG_ONE * TRIG_ONE, cosine);
	return scaleMatrix(axis, factor);
}

function axisMilliDegrees(value: number): number {
	return Math.round(value * 1000);
}

/**
 * Build the element transform, or "invalid" when the rotation cannot be
 * represented (missing origin or axis/angle, a non-finite angle, or a
 * rescale whose angle has no cosine). When both forms are present the
 * axis/angle form wins, as the structure validator documents.
 */
function elementTransform(
	rotation: ElementRotation,
): Mat3 | undefined | "invalid" {
	if (rotation.form === "invalid") return "invalid";
	if (rotation.origin === undefined) return "invalid";
	const hasAxisAngle =
		rotation.axis !== undefined || rotation.angle !== undefined;
	if (hasAxisAngle) {
		const { axis, angle } = rotation;
		if (axis === undefined || angle === undefined || !Number.isFinite(angle)) {
			return "invalid";
		}
		const rotated = rotationMatrix(axis, axisMilliDegrees(angle));
		if (rotation.rescale !== true) return rotated;
		const scale = rescaleMatrix(axis, rotated);
		if (scale === "invalid") return "invalid";
		return multiplyMat3(scale, rotated);
	}
	const axes: readonly RotationAxis[] = ["x", "y", "z"];
	let matrix: Mat3 = IDENTITY_MAT3;
	for (const axis of axes) {
		const angle = rotation[axis];
		if (angle === undefined) continue;
		if (!Number.isFinite(angle)) return "invalid";
		if (angle === 0) continue;
		const rotated = rotationMatrix(axis, axisMilliDegrees(angle));
		matrix = multiplyMat3(rotated, matrix);
		if (rotation.rescale === true) {
			const scale = rescaleMatrix(axis, rotated);
			if (scale === "invalid") return "invalid";
			matrix = multiplyMat3(scale, matrix);
		}
	}
	return matrix;
}

function cubeCorners(min: FixedVec3, max: FixedVec3): readonly FixedVec3[] {
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

function transformPoint(
	point: FixedVec3,
	matrix: Mat3 | undefined,
	origin: FixedVec3,
): FixedVec3 {
	if (matrix === undefined) return point;
	const local: FixedVec3 = [
		(point[0] as number) - (origin[0] as number),
		(point[1] as number) - (origin[1] as number),
		(point[2] as number) - (origin[2] as number),
	];
	const rotated = applyMat3(matrix, local);
	return [
		(rotated[0] as number) + (origin[0] as number),
		(rotated[1] as number) + (origin[1] as number),
		(rotated[2] as number) + (origin[2] as number),
	];
}

interface Bounds {
	readonly min: FixedVec3;
	readonly max: FixedVec3;
}

function boundsOf(points: readonly FixedVec3[]): Bounds {
	if (points.length === 0) {
		return { min: [0, 0, 0], max: [0, 0, 0] };
	}
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		const [x, y, z] = point;
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (z < minZ) minZ = z;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
		if (z > maxZ) maxZ = z;
	}
	return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

interface FaceCorner {
	readonly point: FixedVec3;
	/** Texture-space fraction before the face rotation; 0 is the texture's left/top edge. */
	readonly fu: number;
	readonly fv: number;
}

function faceCorner(
	x: boolean,
	y: boolean,
	z: boolean,
	fu: number,
	fv: number,
	min: FixedVec3,
	max: FixedVec3,
): FaceCorner {
	return {
		point: [
			x ? (max[0] as number) : (min[0] as number),
			y ? (max[1] as number) : (min[1] as number),
			z ? (max[2] as number) : (min[2] as number),
		],
		fu,
		fv,
	};
}

/**
 * The four corners of one face with the texture fractions seen from outside
 * that face: `fu` grows along the texture's u axis and `fv` down its v axis,
 * matching the auto-UV formulas above. The order is irrelevant to coverage;
 * each corner carries its own texture coordinate.
 */
function faceCorners(
	face: Direction,
	min: FixedVec3,
	max: FixedVec3,
): readonly FaceCorner[] {
	if (face === "north") {
		return [
			faceCorner(true, true, false, 0, 0, min, max),
			faceCorner(false, true, false, 1, 0, min, max),
			faceCorner(false, false, false, 1, 1, min, max),
			faceCorner(true, false, false, 0, 1, min, max),
		];
	}
	if (face === "south") {
		return [
			faceCorner(false, true, true, 0, 0, min, max),
			faceCorner(true, true, true, 1, 0, min, max),
			faceCorner(true, false, true, 1, 1, min, max),
			faceCorner(false, false, true, 0, 1, min, max),
		];
	}
	if (face === "east") {
		return [
			faceCorner(true, true, true, 0, 0, min, max),
			faceCorner(true, true, false, 1, 0, min, max),
			faceCorner(true, false, false, 1, 1, min, max),
			faceCorner(true, false, true, 0, 1, min, max),
		];
	}
	if (face === "west") {
		return [
			faceCorner(false, true, false, 0, 0, min, max),
			faceCorner(false, true, true, 1, 0, min, max),
			faceCorner(false, false, true, 1, 1, min, max),
			faceCorner(false, false, false, 0, 1, min, max),
		];
	}
	if (face === "up") {
		return [
			faceCorner(false, true, false, 0, 0, min, max),
			faceCorner(true, true, false, 1, 0, min, max),
			faceCorner(true, true, true, 1, 1, min, max),
			faceCorner(false, true, true, 0, 1, min, max),
		];
	}
	return [
		faceCorner(false, false, true, 0, 0, min, max),
		faceCorner(true, false, true, 1, 0, min, max),
		faceCorner(true, false, false, 1, 1, min, max),
		faceCorner(false, false, false, 0, 1, min, max),
	];
}

/**
 * Face rotation turns the sampled texture clockwise on the face as seen from
 * outside. The down face is the documented exception: its rotation reads
 * counterclockwise, so it takes the opposite quarter turn.
 */
function faceRotation(face: Direction, rotation: FaceRotation): FaceRotation {
	if (face !== "down") return rotation;
	if (rotation === 90) return 270;
	if (rotation === 270) return 90;
	return rotation;
}

function projectionFor(
	view: ModelPreviewView,
	panel: ModelPreviewPanel["name"],
): (point: FixedVec3) => ProjectedPoint {
	if (view.kind === "isometric") {
		return (point) => projectIsometric(point, view.direction);
	}
	return (point) =>
		projectOrthographic(panel as "front" | "right" | "top", point);
}

function panelListFor(
	view: ModelPreviewView,
	size: ModelPreviewSize,
): ModelPreviewPanel[] {
	if (view.kind === "isometric") {
		return [{ name: "isometric", x: 0, y: 0, width: size, height: size }];
	}
	return (["front", "right", "top"] as const).map((name, index) => ({
		name,
		x: index * size,
		y: 0,
		width: size,
		height: size,
	}));
}

function imageWidthFor(view: ModelPreviewView, size: ModelPreviewSize): number {
	return view.kind === "isometric" ? size : size * 3;
}

export async function renderPreviewScene(
	options: PreviewSceneOptions,
): Promise<PreviewSceneResult> {
	const { elements, view, size } = options;
	const skipped: ModelCoverageSkip[] = [];
	const warnings: ModelPreviewWarning[] = [];

	const addSkip = (
		kind: string,
		reason: string,
		target: string,
		detail?: string,
	): void => {
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
	};

	const addWarning = (
		code: ModelPreviewWarningCode,
		target: string,
		message: string,
	): void => {
		if (
			warnings.some((entry) => entry.code === code && entry.target === target)
		) {
			return;
		}
		warnings.push({ code, level: "warning", message, target });
	};

	const boxes: ElementBox[] = [];
	for (const entry of elements) {
		const rotation = entry.element.rotation;
		const matrix =
			rotation === undefined ? undefined : elementTransform(rotation);
		if (matrix === "invalid") {
			addSkip(
				"element-rotation",
				"invalid-rotation",
				`elements[${entry.index}]`,
			);
			continue;
		}
		const origin: FixedVec3 =
			rotation?.origin === undefined
				? [0, 0, 0]
				: [
						fixedPoint(rotation.origin[0]),
						fixedPoint(rotation.origin[1]),
						fixedPoint(rotation.origin[2]),
					];
		const worldCorners = cubeCorners(entry.min, entry.max).map((corner) =>
			transformPoint(corner, matrix, origin),
		);
		boxes.push({
			element: entry.element,
			localMin: entry.min,
			localMax: entry.max,
			worldCorners,
			matrix,
			origin,
		});
	}

	const worldBounds = boundsOf(boxes.flatMap((box) => box.worldCorners));
	const worldExtent = Math.max(
		(worldBounds.max[0] as number) - (worldBounds.min[0] as number),
		(worldBounds.max[1] as number) - (worldBounds.min[1] as number),
		(worldBounds.max[2] as number) - (worldBounds.min[2] as number),
	);
	const margin = Math.max(1, Math.floor(size / 16));
	const available = size - 2 * margin;

	const faces: SceneFace[] = [];
	for (const box of boxes) {
		const element = box.element;
		const minUnits: readonly [number, number, number] = [
			(box.localMin[0] as number) / UNIT,
			(box.localMin[1] as number) / UNIT,
			(box.localMin[2] as number) / UNIT,
		];
		const maxUnits: readonly [number, number, number] = [
			(box.localMax[0] as number) / UNIT,
			(box.localMax[1] as number) / UNIT,
			(box.localMax[2] as number) / UNIT,
		];
		for (const face of DIRECTIONS) {
			const faceView = element.faces.find((entry) => entry.face === face);
			if (faceView === undefined) continue;
			const uv =
				faceView.uv ??
				autoUv(
					face,
					minUnits[0],
					minUnits[1],
					minUnits[2],
					maxUnits[0],
					maxUnits[1],
					maxUnits[2],
				);
			const rotation = faceRotation(face, faceView.rotation);
			const corners = faceCorners(face, box.localMin, box.localMax).map(
				(corner) => ({
					...corner,
					point: transformPoint(corner.point, box.matrix, box.origin),
				}),
			);

			let texture: DecodedTexture | undefined;
			const status = faceView.textureResolution.status;
			if (status !== "resolved") {
				const target =
					faceView.textureResolution.resolvedTo ?? faceView.texture;
				const code =
					status === "unresolved" || status === "external"
						? "MODEL_PREVIEW_TEXTURE_UNRESOLVED"
						: "MODEL_PREVIEW_TEXTURE_MISSING";
				addWarning(
					code,
					target,
					`Texture ${target} could not be resolved (${status}).`,
				);
				addSkip("texture", status, target);
			} else {
				const resolvedTo =
					faceView.textureResolution.resolvedTo ?? faceView.texture;
				const decoded = await options.loadTexture(resolvedTo);
				if (decoded === undefined) {
					addWarning(
						"MODEL_PREVIEW_TEXTURE_UNDECODABLE",
						resolvedTo,
						`Texture ${resolvedTo} could not be decoded.`,
					);
					addSkip("texture", "undecodable", resolvedTo);
				} else {
					texture = decoded;
				}
			}
			const translucent =
				options.isForceTranslucent(faceView) || texture?.translucent === true;
			faces.push({
				face,
				corners: corners.map((corner) => corner.point),
				texCoords: corners.map((corner) => {
					const [fu, fv] = rotateFaceCoords(corner.fu, corner.fv, rotation);
					return [
						(uv[0] as number) + fu * ((uv[2] as number) - (uv[0] as number)),
						(uv[1] as number) + fv * ((uv[3] as number) - (uv[1] as number)),
					] as const;
				}),
				texture,
				translucent,
			});
		}
	}

	const panels = panelListFor(view, size);
	const imageWidth = imageWidthFor(view, size);
	const imageHeight = size;
	const pixels = new Uint8Array(imageWidth * imageHeight * 4);
	let checker: RgbaTexture | undefined;
	const checkerFor = (): RgbaTexture => {
		checker ??= checkerTexture(imageWidth, imageHeight);
		return checker;
	};

	let pixelsPerUnit = 1;
	let isometricScale = SUBPIXEL;
	if (view.kind === "isometric") {
		const projected: ProjectedPoint[] = [];
		for (const box of boxes) {
			for (const corner of box.worldCorners) {
				projected.push(projectIsometric(corner, view.direction));
			}
		}
		const bounds = boundsOf(
			projected.map((point) => [point.x, point.y, point.depth]),
		);
		const extent = Math.max(
			(bounds.max[0] as number) - (bounds.min[0] as number),
			(bounds.max[1] as number) - (bounds.min[1] as number),
		);
		isometricScale =
			extent > 0
				? Math.max(1, Math.floor((available * SUBPIXEL * UNIT) / extent))
				: SUBPIXEL;
		pixelsPerUnit = isometricScale / SUBPIXEL;
	} else {
		pixelsPerUnit =
			worldExtent > 0
				? Math.max(1, Math.floor((available * UNIT) / worldExtent))
				: 1;
	}

	for (const panel of panels) {
		const project = projectionFor(view, panel.name);
		const projected: ProjectedPoint[] = [];
		for (const box of boxes) {
			for (const corner of box.worldCorners) {
				projected.push(project(corner));
			}
		}
		const bounds = boundsOf(
			projected.map((point) => [point.x, point.y, point.depth]),
		);
		const scale =
			view.kind === "isometric" ? isometricScale : pixelsPerUnit * SUBPIXEL;
		const spanX = Math.floor(
			(((bounds.max[0] as number) - (bounds.min[0] as number)) * scale) / UNIT,
		);
		const spanY = Math.floor(
			(((bounds.max[1] as number) - (bounds.min[1] as number)) * scale) / UNIT,
		);
		const offsetX = Math.floor((size * SUBPIXEL - spanX) / 2);
		const offsetY = Math.floor((size * SUBPIXEL - spanY) / 2);
		// The scale never drops below the one-pixel-per-unit floor, so a large
		// model can project wider than its panel. Say so instead of drawing the
		// cut image and reporting complete coverage.
		if (spanX > size * SUBPIXEL || spanY > size * SUBPIXEL) {
			addSkip(
				"content",
				"clipped",
				panel.name,
				`projected content spans ${Math.ceil(spanX / SUBPIXEL)}x${Math.ceil(spanY / SUBPIXEL)} px, the panel is ${size}x${size} px`,
			);
		}
		const viewport = {
			scale,
			offsetX,
			offsetY,
		};
		const target = createRasterTarget(size, size);

		const verticesOf = (
			face: SceneFace,
			boundsMinX: number,
			boundsMinY: number,
		): readonly RasterVertex[] =>
			face.corners.map((corner, index) => {
				const point = project(corner);
				const sub = toSubpixel(
					{
						x: point.x - boundsMinX,
						y: point.y - boundsMinY,
						depth: point.depth,
					},
					viewport,
				);
				const texCoord = face.texCoords[index] as readonly [number, number];
				const u =
					face.texture === undefined
						? (panel.x * SUBPIXEL + sub.x) * 16
						: Math.round(texCoord[0] * face.texture.width * 16);
				const v =
					face.texture === undefined
						? sub.y * 16
						: Math.round(texCoord[1] * face.texture.height * 16);
				return { x: sub.x, y: sub.y, z: sub.z, u, v };
			});

		const sourceOf = (face: SceneFace): RasterSource =>
			face.texture === undefined
				? { texture: checkerFor() }
				: { texture: face.texture };

		for (const face of faces) {
			if (face.translucent) continue;
			const vertices = verticesOf(
				face,
				bounds.min[0] as number,
				bounds.min[1] as number,
			);
			rasterizeQuad(
				target,
				vertices[0] as RasterVertex,
				vertices[1] as RasterVertex,
				vertices[2] as RasterVertex,
				vertices[3] as RasterVertex,
				sourceOf(face),
			);
		}

		// Translucent faces are collected, not drawn: two overlapping planes can
		// change their visible order from pixel to pixel, so the far-to-near
		// order has to be decided per fragment. The depth test only keeps a
		// fragment that is not hidden behind an opaque one; a translucent
		// fragment never writes the depth buffer, so it cannot hide another
		// translucent face.
		const fragments: TranslucentFragment[] = [];
		const opaqueDepth = target.depth;
		for (const face of faces) {
			if (!face.translucent) continue;
			const vertices = verticesOf(
				face,
				bounds.min[0] as number,
				bounds.min[1] as number,
			);
			rasterizeQuadFragments(
				size,
				size,
				vertices[0] as RasterVertex,
				vertices[1] as RasterVertex,
				vertices[2] as RasterVertex,
				vertices[3] as RasterVertex,
				sourceOf(face),
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

		for (let y = 0; y < size; y += 1) {
			const from = y * size * 4;
			const to = (y * imageWidth + panel.x) * 4;
			pixels.set(target.pixels.subarray(from, from + size * 4), to);
		}
	}

	return {
		pixels,
		width: imageWidth,
		height: imageHeight,
		panels,
		range: {
			min: [
				normalizeZero((worldBounds.min[0] as number) / UNIT),
				normalizeZero((worldBounds.min[1] as number) / UNIT),
				normalizeZero((worldBounds.min[2] as number) / UNIT),
			],
			max: [
				normalizeZero((worldBounds.max[0] as number) / UNIT),
				normalizeZero((worldBounds.max[1] as number) / UNIT),
				normalizeZero((worldBounds.max[2] as number) / UNIT),
			],
			pixelsPerUnit,
		},
		skipped,
		warnings,
	};
}
