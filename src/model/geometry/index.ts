export { divRound, FIXED_UNIT, SUBPIXEL, TRIG_ONE } from "./fixed.ts";
export type { FixedVec3, Mat3 } from "./matrix.ts";
export {
	applyMat3,
	IDENTITY_MAT3,
	multiplyMat3,
} from "./matrix.ts";
export type {
	IsometricDirection,
	OrthographicView,
	ProjectedPoint,
	Viewport,
} from "./projection.ts";
export {
	ISOMETRIC_DIRECTIONS,
	isometricYawMatrix,
	projectIsometric,
	projectOrthographic,
	toSubpixel,
} from "./projection.ts";
export type {
	FragmentSink,
	RasterOptions,
	RasterSource,
	RasterTarget,
	RasterVertex,
	RgbaColor,
	RgbaTexture,
} from "./raster.ts";
export {
	blendFragment,
	createRasterTarget,
	DEPTH_EMPTY,
	rasterizeQuad,
	rasterizeQuadFragments,
	rasterizeTriangle,
} from "./raster.ts";
export type { RotationAxis } from "./rotation.ts";
export {
	arbitraryAngleMatrix,
	MILLI_DEGREES_PER_TURN,
	QUARTER_TURN_MILLI_DEGREES,
	rotationMatrix,
	SIXTEENTH_TURN_MILLI_DEGREES,
	sixteenthTurnMatrix,
} from "./rotation.ts";
