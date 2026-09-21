import { McAssetError } from "./errors.ts";

/**
 * Minecraft `.mcmeta` texture-scaling section: the GUI `stretch` / `tile` /
 * `nine_slice` understanding plus the nine-slice border geometry and border
 * guide paint used by `preview --nine-slice`.
 *
 * The scaling lookup is name-based: `gui.scaling` first, then a top-level
 * `scaling` fallback. The exact key path stays with the compatibility layer
 * for verification, so both spellings are accepted here and the parsed
 * names (`stretch`, `tile`, `nine_slice`, `border`, `stretch_inner`) are
 * what the reports carry.
 *
 * The animation and mipmap readers below share `parseMcmetaText` and its
 * INVALID_MCMETA contract. Nothing in this module applies behavior:
 * `stretch_inner`, `mipmap_strategy`, `alpha_cutoff_bias`, `frametime`, and
 * `interpolate` are parsed and reported verbatim but never affect geometry
 * or pixels. Only `animation.width` / `animation.height` feed the frame
 * geometry derivation, and the value domain of the mipmap fields is
 * intentionally unconfirmed: out-of-range values warn at the report layer,
 * never error here beyond their JSON type.
 *
 * All pixel work stays integer; no randomness, no transcendental functions.
 * Same input plus same options always yields the same bytes. Section reads
 * visit their keys in a fixed order, so key order in the JSON never changes
 * the result.
 */

export interface NineSliceBorder {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export type GuiScaling =
	| { kind: "none" }
	| { kind: "stretch" }
	| { kind: "tile"; width: number; height: number }
	| {
			kind: "nine_slice";
			width: number;
			height: number;
			border: NineSliceBorder;
			stretchInner: boolean;
	  };

export interface NineSliceRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface NineSliceRegions {
	topLeft: NineSliceRegion;
	top: NineSliceRegion;
	topRight: NineSliceRegion;
	left: NineSliceRegion;
	center: NineSliceRegion;
	right: NineSliceRegion;
	bottomLeft: NineSliceRegion;
	bottom: NineSliceRegion;
	bottomRight: NineSliceRegion;
}

export type NineSliceFindingLevel = "warning" | "error";

export interface NineSliceFinding {
	level: NineSliceFindingLevel;
	code: string;
	message: string;
}

/** Frozen border guide color for the nine-slice preview PNG. */
export const NINE_SLICE_GUIDE = { r: 255, g: 0, b: 255, a: 255 } as const;

function invalidMcmeta(message: string, details?: unknown): McAssetError {
	return new McAssetError("INVALID_MCMETA", message, details);
}

/**
 * Parse raw `.mcmeta` text into a plain document. JSON syntax errors and
 * non-object roots are INVALID_MCMETA; unreadable files never reach here
 * (the caller reports FILESYSTEM_ERROR when reading).
 */
export function parseMcmetaText(text: string, source?: string): unknown {
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch {
		throw invalidMcmeta(
			`Cannot parse mcmeta JSON${source === undefined ? "" : `: ${source}`}.`,
			source === undefined ? undefined : { path: source },
		);
	}
	if (
		typeof document !== "object" ||
		document === null ||
		Array.isArray(document)
	) {
		throw invalidMcmeta("mcmeta root must be a JSON object.", {
			path: source,
		});
	}
	return document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBorderSide(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseBorder(value: unknown): NineSliceBorder {
	if (isBorderSide(value)) {
		return { left: value, top: value, right: value, bottom: value };
	}
	if (!isRecord(value)) {
		throw invalidMcmeta(
			"nine_slice border must be a non-negative integer or an object.",
			{ border: value },
		);
	}
	for (const side of ["left", "top", "right", "bottom"] as const) {
		if (!isBorderSide(value[side])) {
			throw invalidMcmeta(
				`nine_slice border.${side} must be a non-negative integer.`,
				{ border: value },
			);
		}
	}
	return {
		left: value.left as number,
		top: value.top as number,
		right: value.right as number,
		bottom: value.bottom as number,
	};
}

/**
 * Read the GUI texture-scaling section of a parsed `.mcmeta` document.
 * Absent scaling reports `none`; `stretch` reports its kind; `tile` and
 * `nine_slice` carry their declared design dimensions (`width` / `height`,
 * both required positive integers) and `nine_slice` additionally carries
 * its border (an integer for four equal sides, or a per-side object) and
 * the verbatim `stretch_inner` flag. Structural problems (unknown type,
 * missing type, missing or non-positive design dimensions, bad border,
 * non-boolean `stretch_inner`) are INVALID_MCMETA.
 */
export function extractGuiScaling(document: unknown): GuiScaling {
	if (!isRecord(document)) {
		throw invalidMcmeta("mcmeta root must be a JSON object.", {
			document,
		});
	}
	const gui = document.gui;
	const scaling =
		isRecord(gui) && gui.scaling !== undefined ? gui.scaling : document.scaling;
	if (scaling === undefined) {
		return { kind: "none" };
	}
	if (!isRecord(scaling)) {
		throw invalidMcmeta("scaling section must be an object.", { scaling });
	}
	const type = scaling.type;
	if (type === "stretch") {
		return { kind: type };
	}
	if (type !== "tile" && type !== "nine_slice") {
		throw invalidMcmeta(
			`Unknown scaling type ${JSON.stringify(type) ?? "missing"}; expected stretch, tile, or nine_slice.`,
			{ type: type ?? null },
		);
	}
	const width = scaling.width;
	const height = scaling.height;
	if (!isPositiveInt(width) || !isPositiveInt(height)) {
		throw invalidMcmeta(
			`${type} scaling needs positive integer width and height design dimensions.`,
			{ width, height },
		);
	}
	if (type === "tile") {
		return { kind: type, width, height };
	}
	if (scaling.border === undefined) {
		throw invalidMcmeta("nine_slice scaling needs a border.", {
			scaling,
		});
	}
	const border = parseBorder(scaling.border);
	const stretchInner = scaling.stretch_inner ?? false;
	if (typeof stretchInner !== "boolean") {
		throw invalidMcmeta("stretch_inner must be a boolean when present.", {
			stretchInner,
		});
	}
	return { kind: "nine_slice", width, height, border, stretchInner };
}

/**
 * Derive the nine regions by insetting the sprite bounds with the border:
 * the four sides keep the border width, the middle column and row take the
 * remainder. Callers MUST check `nineSliceGeometryError` first, which
 * rejects both overflow and equality, so a zero or negative remainder
 * here always means an unchecked border.
 */
export function deriveNineSliceRegions(
	width: number,
	height: number,
	border: NineSliceBorder,
): NineSliceRegions {
	const middleWidth = width - border.left - border.right;
	const middleHeight = height - border.top - border.bottom;
	const rightX = width - border.right;
	const bottomY = height - border.bottom;
	return {
		topLeft: { x: 0, y: 0, width: border.left, height: border.top },
		top: { x: border.left, y: 0, width: middleWidth, height: border.top },
		topRight: { x: rightX, y: 0, width: border.right, height: border.top },
		left: { x: 0, y: border.top, width: border.left, height: middleHeight },
		center: {
			x: border.left,
			y: border.top,
			width: middleWidth,
			height: middleHeight,
		},
		right: {
			x: rightX,
			y: border.top,
			width: border.right,
			height: middleHeight,
		},
		bottomLeft: { x: 0, y: bottomY, width: border.left, height: border.bottom },
		bottom: {
			x: border.left,
			y: bottomY,
			width: middleWidth,
			height: border.bottom,
		},
		bottomRight: {
			x: rightX,
			y: bottomY,
			width: border.right,
			height: border.bottom,
		},
	};
}

/**
 * Border geometry check against the declared design dimensions:
 * `left + right < width` and `top + bottom < height`. Returns the finding
 * message, or undefined when the border fits. Equality is an error: a
 * zero-width middle column or row has no defined mapping, so the check
 * is strict on both axes.
 */
export function nineSliceGeometryError(
	width: number,
	height: number,
	border: NineSliceBorder,
): string | undefined {
	if (border.left + border.right >= width) {
		return (
			`nine_slice border overflows the sprite: left (${border.left}) + right ` +
			`(${border.right}) meets or exceeds width ${width}.`
		);
	}
	if (border.top + border.bottom >= height) {
		return (
			`nine_slice border overflows the sprite: top (${border.top}) + bottom ` +
			`(${border.bottom}) meets or exceeds height ${height}.`
		);
	}
	return undefined;
}

/**
 * Paint the four 1px border guides over flat RGBA bytes in place:
 * `x = left` and `x = width - right` run the full height,
 * `y = top` and `y = height - bottom` run the full width.
 * Guide pixels become opaque; every other byte stays untouched.
 * Out-of-range lines are skipped, never wrapped or clamped.
 */
export function paintNineSliceGuides(
	pixels: Uint8Array,
	width: number,
	height: number,
	border: NineSliceBorder,
): void {
	const guideX = [border.left, width - border.right];
	const guideY = [border.top, height - border.bottom];
	for (const x of guideX) {
		if (x < 0 || x >= width) {
			continue;
		}
		for (let y = 0; y < height; y += 1) {
			const offset = (y * width + x) * 4;
			pixels[offset] = NINE_SLICE_GUIDE.r;
			pixels[offset + 1] = NINE_SLICE_GUIDE.g;
			pixels[offset + 2] = NINE_SLICE_GUIDE.b;
			pixels[offset + 3] = NINE_SLICE_GUIDE.a;
		}
	}
	for (const y of guideY) {
		if (y < 0 || y >= height) {
			continue;
		}
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			pixels[offset] = NINE_SLICE_GUIDE.r;
			pixels[offset + 1] = NINE_SLICE_GUIDE.g;
			pixels[offset + 2] = NINE_SLICE_GUIDE.b;
			pixels[offset + 3] = NINE_SLICE_GUIDE.a;
		}
	}
}

/** Verbatim `texture` section: strategy stays a string, bias a number. */
export interface McmetaTextureInfo {
	present: boolean;
	mipmapStrategy?: string | undefined;
	alphaCutoffBias?: number | undefined;
}

/** One normalized animation frame: bare integers become `{ index }`. */
export interface McmetaAnimationFrame {
	index: number;
	time?: number | undefined;
}

/** Verbatim `animation` section with both frames element forms accepted. */
export interface McmetaAnimationInfo {
	present: boolean;
	frametime?: number | undefined;
	interpolate?: boolean | undefined;
	width?: number | undefined;
	height?: number | undefined;
	frames: McmetaAnimationFrame[];
	hasExplicitFrames: boolean;
}

export type McmetaAnimationLayout = "vertical" | "horizontal";

/** Frame geometry derived from the sheet plus the declared frame size. */
export interface McmetaAnimationGeometry {
	frameWidth: number;
	frameHeight: number;
	frameCount: number;
	layout: McmetaAnimationLayout;
}

/** Warning-only mipmap note: classification is predicted, never effective. */
export interface McmetaMipmapWarning {
	level: "warning";
	code: string;
	message: string;
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function texturePath(path: string, details?: Record<string, unknown>) {
	return invalidMcmeta(`Invalid texture section: ${path}.`, {
		path,
		...details,
	});
}

function animationPath(path: string, details?: Record<string, unknown>) {
	return invalidMcmeta(`Invalid animation section: ${path}.`, {
		path,
		...details,
	});
}

/**
 * Read the `texture` section of a parsed `.mcmeta` document. Absent texture
 * reports `present: false`; `mipmap_strategy` stays a verbatim string and
 * `alpha_cutoff_bias` a verbatim number. The two keys are visited in fixed
 * order and every other key is ignored, so JSON key order never matters.
 * Non-object sections or mistyped fields are INVALID_MCMETA; unconfirmed
 * value domains never error here, they warn at the report layer.
 */
export function extractTextureSection(document: unknown): McmetaTextureInfo {
	if (!isRecord(document)) {
		throw invalidMcmeta("mcmeta root must be a JSON object.", {
			document,
		});
	}
	const texture = document.texture;
	if (texture === undefined) {
		return { present: false };
	}
	if (!isRecord(texture)) {
		throw texturePath("texture", { texture });
	}
	const info: McmetaTextureInfo = { present: true };
	const strategy = texture.mipmap_strategy;
	if (strategy !== undefined) {
		if (typeof strategy !== "string") {
			throw texturePath("texture.mipmap_strategy", {
				mipmap_strategy: strategy,
			});
		}
		info.mipmapStrategy = strategy;
	}
	const bias = texture.alpha_cutoff_bias;
	if (bias !== undefined) {
		if (typeof bias !== "number") {
			throw texturePath("texture.alpha_cutoff_bias", {
				alpha_cutoff_bias: bias,
			});
		}
		info.alphaCutoffBias = bias;
	}
	return info;
}

function parseAnimationFrame(
	element: unknown,
	position: number,
): McmetaAnimationFrame {
	const path =
		typeof element === "number"
			? `animation.frames[${position}]`
			: `animation.frames[${position}].index`;
	if (typeof element === "number") {
		if (!Number.isInteger(element) || element < 0) {
			throw animationPath(path, { index: element });
		}
		return { index: element };
	}
	if (!isRecord(element)) {
		throw animationPath(`animation.frames[${position}]`, {
			frame: element,
		});
	}
	const index = element.index;
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
		throw animationPath(path, { index });
	}
	const frame: McmetaAnimationFrame = { index };
	const time = element.time;
	if (time !== undefined) {
		if (!isPositiveInt(time)) {
			throw animationPath(`animation.frames[${position}].time`, { time });
		}
		frame.time = time;
	}
	return frame;
}

/**
 * Read the `animation` section of a parsed `.mcmeta` document. Absent
 * animation reports `present: false` with no frames; `frametime` /
 * `interpolate` / `width` / `height` stay verbatim and `frames[]` accepts
 * bare integers and `{ index, time }` objects side by side. Fields are
 * visited in the fixed order frametime, interpolate, width, height,
 * frames, so JSON key order never matters. Structural problems are
 * INVALID_MCMETA with the field location in `details.path`.
 */
export function extractAnimationSection(
	document: unknown,
): McmetaAnimationInfo {
	if (!isRecord(document)) {
		throw invalidMcmeta("mcmeta root must be a JSON object.", {
			document,
		});
	}
	const animation = document.animation;
	if (animation === undefined) {
		return { present: false, frames: [], hasExplicitFrames: false };
	}
	if (!isRecord(animation)) {
		throw animationPath("animation", { animation });
	}
	const info: McmetaAnimationInfo = {
		present: true,
		frames: [],
		hasExplicitFrames: false,
	};
	const frametime = animation.frametime;
	if (frametime !== undefined) {
		if (!isPositiveInt(frametime)) {
			throw animationPath("animation.frametime", { frametime });
		}
		info.frametime = frametime;
	}
	const interpolate = animation.interpolate;
	if (interpolate !== undefined) {
		if (typeof interpolate !== "boolean") {
			throw animationPath("animation.interpolate", { interpolate });
		}
		info.interpolate = interpolate;
	}
	const width = animation.width;
	if (width !== undefined) {
		if (!isPositiveInt(width)) {
			throw animationPath("animation.width", { width });
		}
		info.width = width;
	}
	const height = animation.height;
	if (height !== undefined) {
		if (!isPositiveInt(height)) {
			throw animationPath("animation.height", { height });
		}
		info.height = height;
	}
	const frames = animation.frames;
	if (frames === undefined) {
		return info;
	}
	if (!Array.isArray(frames)) {
		throw animationPath("animation.frames", { frames });
	}
	info.hasExplicitFrames = true;
	info.frames = frames.map((element, position) =>
		parseAnimationFrame(element, position),
	);
	return info;
}

/**
 * Derive the animation frame geometry from a sheet plus the declared frame
 * size. Undeclared width falls back to the sheet width (a vertical strip);
 * undeclared height falls back to the frame width (square frames). A sheet
 * that is a vertical stack reports `vertical` with
 * `frameCount = sheetHeight / frameHeight`; a horizontal strip reports
 * `horizontal` with `frameCount = sheetWidth / frameWidth` — the same
 * integer formulas as the frameset sheet math. Anything else is
 * INVALID_ANIMATION_FRAME with the sheet and frame dimensions in details.
 */
export function deriveAnimationGeometry(
	sheetWidth: number,
	sheetHeight: number,
	animation: McmetaAnimationInfo,
): McmetaAnimationGeometry {
	const frameWidth = animation.width ?? sheetWidth;
	const frameHeight = animation.height ?? frameWidth;
	if (
		!Number.isInteger(frameWidth) ||
		frameWidth < 1 ||
		!Number.isInteger(frameHeight) ||
		frameHeight < 1
	) {
		throw new McAssetError(
			"INVALID_ANIMATION_FRAME",
			`Animation frame size ${String(frameWidth)}x${String(frameHeight)} must be positive integers.`,
			{ sheetWidth, sheetHeight, frameWidth, frameHeight },
		);
	}
	if (sheetWidth === frameWidth && sheetHeight % frameHeight === 0) {
		const frameCount = sheetHeight / frameHeight;
		if (frameCount >= 1) {
			return { frameWidth, frameHeight, frameCount, layout: "vertical" };
		}
	}
	if (sheetHeight === frameHeight && sheetWidth % frameWidth === 0) {
		const frameCount = sheetWidth / frameWidth;
		if (frameCount >= 1) {
			return { frameWidth, frameHeight, frameCount, layout: "horizontal" };
		}
	}
	throw new McAssetError(
		"INVALID_ANIMATION_FRAME",
		`Sheet ${sheetWidth}x${sheetHeight} cannot hold ${frameWidth}x${frameHeight} animation frames.`,
		{ layout: "vertical", sheetWidth, sheetHeight, frameWidth, frameHeight },
	);
}

/**
 * Check every declared frame index against `frameCount`: each index must
 * land in `[0, frameCount)`. The first breach is INVALID_ANIMATION_FRAME
 * with the element location in `details.path`
 * (`animation.frames[i].index` for objects, `animation.frames[i]` for bare
 * integers) plus the offending index and the frame count.
 */
export function checkAnimationFrameIndices(
	animation: McmetaAnimationInfo,
	frameCount: number,
): void {
	for (let position = 0; position < animation.frames.length; position += 1) {
		const frame = animation.frames[position] as McmetaAnimationFrame;
		if (
			!Number.isInteger(frame.index) ||
			frame.index < 0 ||
			frame.index >= frameCount
		) {
			throw new McAssetError(
				"INVALID_ANIMATION_FRAME",
				`Animation frame index ${frame.index} is out of range [0, ${frameCount}).`,
				{
					path: `animation.frames[${position}].index`,
					index: frame.index,
					frameIndex: frame.index,
					frameCount,
				},
			);
		}
	}
}

/**
 * Cutout plus mean mipmap note, warning-only by construction. The predicted
 * classification comes from PNG bytes only, and the strategy value domain
 * is unconfirmed, so this never errors: a predicted-cutout texture paired
 * with a verbatim `mean` strategy warns, everything else stays quiet, and
 * the warning MUST NOT block output.
 */
export function mipmapCutoutMeanWarning(
	predictedClassification: string,
	texture: McmetaTextureInfo,
): McmetaMipmapWarning | undefined {
	if (
		predictedClassification === "cutout" &&
		texture.present &&
		texture.mipmapStrategy === "mean"
	) {
		return {
			level: "warning",
			code: "MIPMAP_CUTOUT_MEAN",
			message:
				"predicted cutout with mipmap_strategy mean: mipmaps may blend transparent edges; left as-is with no auto-fix.",
		};
	}
	return undefined;
}
