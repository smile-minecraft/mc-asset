import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../core/canvas.ts";
import { McAssetError } from "../../core/errors.ts";
import { decodePng, encodePng, flattenCanvas } from "../../io/png.ts";
import {
	inspectModel,
	type ModelCoverage,
	type ModelElementView,
	type ModelFaceView,
} from "../inspect.ts";
import { textureResourcePath } from "../references.ts";
import { DIRECTIONS, type Direction, type Vec3 } from "../types.ts";
import {
	builtinDisplaySource,
	builtinGuiLight,
	type DisplayTransformSource,
	displayTransformFor,
	formatTintColor,
	type LightingMode,
	PREVIEW_DISPLAY_SLOTS,
	type PreviewDisplaySlot,
	type RgbTint,
} from "./display.ts";
import {
	autoUv,
	checkerColor,
	type DecodedTexture,
	faceRectangle,
	hasTranslucentAlpha,
	sampleFacePixel,
} from "./pixels.ts";
import { renderPreviewScene } from "./scene.ts";
import type {
	ModelPreviewOptions,
	ModelPreviewPanel,
	ModelPreviewPanelName,
	ModelPreviewRange,
	ModelPreviewReport,
	ModelPreviewResult,
	ModelPreviewSize,
	ModelPreviewView,
	ModelPreviewWarning,
	ModelPreviewWarningCode,
} from "./types.ts";

export type {
	ModelPreviewOptions,
	ModelPreviewPanel,
	ModelPreviewPanelName,
	ModelPreviewRange,
	ModelPreviewReport,
	ModelPreviewResult,
	ModelPreviewSize,
	ModelPreviewView,
	ModelPreviewWarning,
	ModelPreviewWarningCode,
};

/**
 * The model preview renderer.
 *
 * A model whose three orthographic views were already rendered exactly (every
 * element axis-aligned with coordinates on the 1/256 grid, every visible face
 * opaque) goes through the compatibility renderer below and keeps its existing
 * PNG and report bytes. The compatibility renderer is a per-panel rectangle
 * filler: three square panels side by side, `front` (the north face seen from
 * the north), `right` (the east face seen from the east) and `top` (the up face
 * seen from above, north at the top); each panel is `size` x `size`, the image
 * is `size * 3` x `size`, and the background is fully transparent. A face
 * without `uv` uses the vanilla auto-UV of its element position, values outside
 * [0, 16] clamp to the texture edge, face `rotation` permutes the sampled
 * texture, and an unresolvable texture fills its rectangle with the fixed
 * checkerboard (8 px cells, magenta first, anchored at the image origin). Every
 * sample position and texel index is integer arithmetic on the 1/256 model
 * grid, so no floating-point rounding can drift between runs.
 *
 * Everything else goes through the geometry renderer in `scene.ts`: element
 * rotation (axis/angle with `rescale`, or the x / y / z form) is applied around
 * `origin`, all six faces of every cuboid are projected with the integer
 * geometry core, and partially transparent faces are composed after the opaque
 * pass, per pixel, from far to near. Without a `view` option the geometry
 * renderer also produces the three-view layout, so a rotated element shows up
 * in all three panels; with `view: { kind: "isometric" }` it renders one square
 * 2:1 isometric panel for the requested camera direction; with `display` it
 * renders one square panel through the game display slot's transform and
 * optionally applies the fixed face shading and a tint colour.
 *
 * The report stays honest: anything not faithfully rendered is listed in
 * `coverage.skipped` (including a panel the content is clipped by), every
 * texture problem also raises a warning, and `unapplied` names the steps this
 * diagnostic view still does not apply: display transforms or lighting when
 * not requested, uncoloured `tintindex` faces, ambient occlusion, world light,
 * shadows, perspective projection, the per-slot camera rig, left-hand
 * mirroring, and the hand, head, item-frame and dropped-item poses. The
 * compatibility renderer keeps its historical `display` / `lighting` list so
 * its reports stay byte-identical. This is a diagnostic view, not a game
 * renderer, and it never rewrites the model.
 */

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

/** The unapplied steps the geometry renderer has, plus tintindex when the model uses it. */
function unappliedSteps(faces: readonly ModelFaceView[]): string[] {
	const steps = ["display", "lighting"];
	if (faces.some((face) => face.tintindex !== undefined)) {
		steps.push("tintindex");
	}
	return steps;
}

/**
 * The extra pose each display slot adds in the game on top of the model
 * transform: the hand, the head, the dropped item and the item frame all
 * have their own camera or anchor that this diagnostic view does not model.
 */
const DISPLAY_POSE_UNAPPLIED: Readonly<
	Record<PreviewDisplaySlot, readonly string[]>
> = {
	gui: [],
	firstperson_righthand: ["first-person-hand-pose"],
	thirdperson_righthand: ["third-person-hand-pose"],
	head: ["head-pose"],
	ground: ["dropped-item-pose"],
	fixed: ["item-frame-pose"],
};

/**
 * The honest gap list once a display slot, lighting or a tint is requested.
 * The first two entries keep the historical meaning of the report; the rest
 * name what this diagnostic renderer still does not simulate. The strings
 * never claim the image matches the game client.
 */
function previewUnapplied(input: {
	readonly elements: readonly ModelElementView[];
	readonly display: PreviewDisplaySlot | undefined;
	readonly displayApplied: boolean;
	readonly lighting: boolean;
	readonly guiLight: "front" | "side";
	readonly uncoloredFaces: number;
}): string[] {
	const steps: string[] = [];
	if (input.display === undefined) steps.push("display");
	if (!input.lighting) steps.push("lighting");
	if (input.uncoloredFaces > 0) steps.push("tintindex");
	steps.push(
		"ambient-occlusion",
		"world-lightmap",
		"shadows",
		"perspective-projection",
	);
	if (input.display !== undefined) {
		steps.push("camera-rig", "left-hand-mirroring");
		steps.push(...DISPLAY_POSE_UNAPPLIED[input.display]);
		if (!input.displayApplied) steps.push("display-slot-missing");
	}
	if (input.lighting) {
		steps.push(
			input.guiLight === "front"
				? "flat-item-lighting-variation"
				: "dominant-axis-shading",
		);
	}
	if (
		input.elements.some(
			(element) =>
				element.shade === false || element.shadeDirectionOverride !== undefined,
		)
	) {
		steps.push("element-shade");
	}
	if (input.elements.some((element) => (element.lightEmission ?? 0) > 0)) {
		steps.push("light-emission");
	}
	return steps;
}

/** Report tint colours in index order, so object key order cannot vary. */
function sortedTints(
	tints: Readonly<Record<string, RgbTint>>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(tints).sort(
		(a, b) => Number(a) - Number(b),
	)) {
		// Keys are decimal tint indices; `Number` orders "2" before "10".

		result[key] = formatTintColor(value);
	}
	return result;
}

/**
 * Render the diagnostic preview PNG plus its report. The compatibility
 * renderer and the geometry renderer share the inspection result, the decoded
 * texture cache and the report shape; anything not faithfully rendered is
 * reported as partial coverage.
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
	if (
		options.display !== undefined &&
		!(PREVIEW_DISPLAY_SLOTS as readonly string[]).includes(options.display)
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`display must be one of ${PREVIEW_DISPLAY_SLOTS.join(", ")}: ${String(options.display)}.`,
			{ field: "display", display: options.display },
		);
	}
	if (options.display !== undefined && options.view !== undefined) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"display cannot be combined with view.",
		);
	}
	const view: ModelPreviewView =
		options.display === undefined
			? (options.view ?? { kind: "three-view" })
			: { kind: "display", slot: options.display };
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

	const builtinParent =
		inspection.parent?.status === "builtin"
			? inspection.parent.value
			: undefined;
	const inspectionDisplay =
		options.display === undefined
			? undefined
			: inspection.display.find((entry) => entry.position === options.display);
	let displaySource: DisplayTransformSource | undefined = inspectionDisplay;
	let displayFrom = inspectionDisplay?.from;
	if (
		options.display !== undefined &&
		displaySource === undefined &&
		builtinParent !== undefined
	) {
		const builtin = builtinDisplaySource(builtinParent, options.display);
		if (builtin !== undefined) {
			displaySource = builtin.source;
			displayFrom = builtin.from;
		}
	}
	const display =
		options.display === undefined
			? undefined
			: displayTransformFor(options.display, displaySource, displayFrom);
	const guiLight =
		inspection.properties.guiLight ??
		(builtinParent === undefined
			? undefined
			: builtinGuiLight(builtinParent)) ??
		"side";
	const lightingMode: LightingMode | undefined =
		options.lighting === true
			? guiLight === "front"
				? "flat"
				: "directional"
			: undefined;
	if (options.tint !== undefined && options.tints !== undefined) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Use only one of tint or tints.",
			{ field: "tints", mode: "preview" },
		);
	}
	const tintByIndex = new Map<number, RgbTint>();
	if (options.tints !== undefined) {
		for (const [key, value] of Object.entries(options.tints)) {
			const index = Number(key);
			if (!Number.isSafeInteger(index) || index < 0) {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					`tints keys must be non-negative integers: ${key}.`,
					{ field: "tints", key },
				);
			}
			if (tintByIndex.has(index)) {
				throw new McAssetError(
					"ARGUMENT_CONFLICT",
					`tints names tintindex ${index} twice.`,
					{ field: "tints", index },
				);
			}
			tintByIndex.set(index, value);
		}
	}
	const tint =
		options.tint === undefined && options.tints === undefined
			? undefined
			: {
					...(options.tint === undefined ? {} : { color: options.tint }),
					byIndex: tintByIndex,
				};

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
	const isForceTranslucent = (face: ModelFaceView): boolean =>
		isTranslucentFace(face.texture, face.textureResolution.via);

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
				translucent: hasTranslucentAlpha(pixels),
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

	// The compatibility renderer covers three axis-aligned faces per element
	// and cannot rotate a part or blend a translucent one. Any rotation, and
	// any partially transparent face that renderer would draw, switches the
	// whole model to the geometry renderer. Faces the compatibility renderer
	// never draws (south, west, down) do not change its output, so they do not
	// switch it.
	let needsGeometry =
		view.kind === "isometric" ||
		view.kind === "display" ||
		options.lighting === true ||
		options.tint !== undefined ||
		options.tints !== undefined ||
		drawn.some((entry) => entry.element.rotation !== undefined);
	if (!needsGeometry) {
		outer: for (const entry of drawn) {
			for (const faceName of ["north", "east", "up"] as const) {
				const faceView = faceFor(entry.element, faceName);
				if (faceView === undefined) continue;
				if (isForceTranslucent(faceView)) {
					needsGeometry = true;
					break outer;
				}
				const status = faceView.textureResolution.status;
				if (status !== "resolved") continue;
				const resolvedTo =
					faceView.textureResolution.resolvedTo ?? faceView.texture;
				const decoded = await decodedTexture(textureResourcePath(resolvedTo));
				if (decoded?.translucent === true) {
					needsGeometry = true;
					break outer;
				}
			}
		}
	}

	const allFaces = inspection.elements.flatMap((element) => element.faces);
	// The compatibility renderer keeps its historical report, byte for byte:
	// `tintindex` is only listed when the geometry renderer runs, which is the
	// path a new view, a rotated element or a visible translucent face takes.
	const newPreviewOptions =
		options.display !== undefined ||
		options.lighting === true ||
		options.tint !== undefined ||
		options.tints !== undefined;
	let unapplied: string[] = ["display", "lighting"];
	if (needsGeometry) {
		unapplied = newPreviewOptions ? [] : unappliedSteps(allFaces);
	}

	let image: { readonly width: number; readonly height: number };
	let panels: readonly ModelPreviewPanel[];
	let range: ModelPreviewRange;
	let flat: Uint8Array;
	let tintedFaces = 0;
	let uncoloredFaces = 0;

	if (needsGeometry) {
		const scene = await renderPreviewScene({
			elements: drawn.map((entry) => ({
				index: entry.index,
				element: entry.element,
				min: [entry.minXFixed, entry.minYFixed, entry.minZFixed],
				max: [entry.maxXFixed, entry.maxYFixed, entry.maxZFixed],
			})),
			view,
			size,
			loadTexture: (resolvedTo) =>
				decodedTexture(textureResourcePath(resolvedTo)),
			isForceTranslucent,
			...(display === undefined ? {} : { display }),
			...(lightingMode === undefined
				? {}
				: { lighting: { mode: lightingMode } }),
			...(tint === undefined ? {} : { tint }),
		});
		for (const skip of scene.skipped) {
			addSkip(skipped, skip.kind, skip.reason, skip.target, skip.detail);
		}
		for (const warning of scene.warnings) {
			addPreviewWarning(
				warnings,
				warning.code,
				warning.target,
				warning.message,
			);
		}
		if (newPreviewOptions) {
			unapplied = previewUnapplied({
				elements: inspection.elements,
				display: options.display,
				displayApplied: displaySource !== undefined,
				lighting: options.lighting === true,
				guiLight,
				uncoloredFaces: scene.uncoloredFaces,
			});
			if (
				(options.tint !== undefined || options.tints !== undefined) &&
				scene.tintedFaces === 0 &&
				scene.uncoloredFaces === 0
			) {
				addPreviewWarning(
					warnings,
					"MODEL_PREVIEW_TINT_UNUSED",
					"tintindex",
					"Tint colours were given but no face declares tintindex.",
				);
			}
		}
		image = { width: scene.width, height: scene.height };
		panels = scene.panels;
		range = scene.range;
		flat = scene.pixels;
		tintedFaces = scene.tintedFaces;
		uncoloredFaces = scene.uncoloredFaces;
	} else {
		const imageWidth = size * 3;
		const imageHeight = size;
		flat = new Uint8Array(imageWidth * imageHeight * 4);
		const depthFront = new Array<number>(size * size).fill(
			Number.NEGATIVE_INFINITY,
		);
		const depthRight = new Array<number>(size * size).fill(
			Number.NEGATIVE_INFINITY,
		);
		const depthTop = new Array<number>(size * size).fill(
			Number.NEGATIVE_INFINITY,
		);

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
				if (isForceTranslucent(faceView)) {
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
				if (isForceTranslucent(faceView)) {
					continue;
				}
				const status = faceView.textureResolution.status;
				let decodedTextureResult: DecodedTexture | undefined;
				let useChecker = status !== "resolved";
				if (!useChecker) {
					const resolvedTo =
						faceView.textureResolution.resolvedTo ?? faceView.texture;
					decodedTextureResult = await decodedTexture(
						textureResourcePath(resolvedTo),
					);
					if (decodedTextureResult === undefined) {
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
				const rectW =
					Math.max(localX0, localX1) - Math.min(localX0, localX1) + 1;
				const rectH =
					Math.max(localY0, localY1) - Math.min(localY0, localY1) + 1;
				const rectMinX = Math.min(localX0, localX1);
				const rectMinY = Math.min(localY0, localY1);
				const rect = useChecker
					? undefined
					: faceRectangle([u1, v1, u2, v2], rectW, rectH, rotation);
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
						if (rect === undefined) {
							rgba = checkerColor(globalX, globalY);
						} else {
							rgba = sampleFacePixel(
								decodedTextureResult as DecodedTexture,
								rect,
								lx - rectMinX,
								ly - rectMinY,
							);
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

		image = { width: imageWidth, height: imageHeight };
		panels = (["front", "right", "top"] as const).map((name, index) => ({
			name,
			x: index * size,
			y: 0,
			width: size,
			height: size,
		}));
		range = { min: rangeMin, max: rangeMax, pixelsPerUnit };
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

	const canvas = createCanvas(image.width, image.height);
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
			image,
			panels,
			range,
			coverage,
			warnings,
			unapplied,
			...(view.kind === "isometric"
				? { view: { kind: "isometric" as const, direction: view.direction } }
				: {}),
			...(display === undefined || options.display === undefined
				? {}
				: {
						display: {
							slot: options.display,
							...(displayFrom === undefined ? {} : { from: displayFrom }),
							rotation: display.rotation,
							translation: display.translation,
							scale: display.scale,
							applied: displaySource !== undefined,
							clamped: display.clamped,
						},
					}),
			...(lightingMode === undefined
				? {}
				: { lighting: { mode: lightingMode, guiLight } }),
			...(tint === undefined
				? {}
				: {
						tint: {
							...(options.tint === undefined
								? {}
								: { color: formatTintColor(options.tint) }),
							...(options.tints === undefined
								? {}
								: { tints: sortedTints(options.tints) }),
							appliedFaces: tintedFaces,
							uncoloredFaces,
						},
					}),
		},
		png: encodePng(canvas),
	};
}
