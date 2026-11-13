import {
	applyMat3,
	divRound,
	type FixedVec3,
	type Mat3,
	multiplyMat3,
	type ProjectedPoint,
	rotationMatrix,
	TRIG_ONE,
} from "../geometry/index.ts";
import type { Direction, Vec3 } from "../types.ts";

/**
 * The display slots the preview simulates.
 *
 * The left-hand slots are deliberately absent: the game mirrors the
 * right-hand transform for them (`ItemTransform.apply` negates the x
 * translation and the y / z rotations), and this diagnostic preview only
 * models the right-hand case. `on_shelf` is absent too because it has no
 * fixed item transform of its own in the versions this project targets.
 */
export const PREVIEW_DISPLAY_SLOTS = [
	"gui",
	"firstperson_righthand",
	"thirdperson_righthand",
	"head",
	"ground",
	"fixed",
] as const;

export type PreviewDisplaySlot = (typeof PREVIEW_DISPLAY_SLOTS)[number];

/**
 * Every supported slot is viewed from the same diagnostic camera: looking
 * along -z with +x to the right and +y up, which is the camera the game's
 * GUI item renderer uses (`GuiGraphics.renderItem` translates to the slot
 * centre, applies `scaling(1, -1, 1)` and `scale(16, 16, 16)` before
 * `ItemRenderer.render` applies the display transform). Held-item and
 * head/frame slots are rendered in camera space too, but the game also
 * applies a hardcoded hand, head, item-frame or dropped-item pose that this
 * preview does not model; the report lists that gap in `unapplied`.
 */
export const DISPLAY_CAMERA = "south" as const;

/**
 * The model centre the display transform rotates and scales around.
 *
 * `ItemRenderer` applies the transform first and then translates by
 * (-0.5, -0.5, -0.5) blocks, so the transform's origin is the centre of the
 * 0..16 model space: 8 model units, or 2048 on the 1/256 grid.
 */
export const DISPLAY_PIVOT = 8 * 256;

/**
 * Fixed per-direction shade factors, in thousandths, used as a diagnostic
 * stand-in for the GUI item lighting.
 *
 * The values are the block-face coefficients from the vanilla client. In the
 * 1.21.4 client jar (Mojang mappings, `ClientLevel.java` 758:776),
 * `ClientLevel.getShade(Direction, boolean)` returns DOWN 0.5, UP 1.0,
 * NORTH / SOUTH 0.8, WEST / EAST 0.6 for the Overworld
 * (`DimensionSpecialEffects.constantAmbientLight()` is false); the Nether,
 * whose effects set that flag, uses 0.9 for DOWN / UP instead, and this
 * preview always uses the Overworld values.
 * `ModelBlockRenderer.renderModelFaceFlat` (line 219) applies them to a baked
 * quad with the quad's own direction and `isShade` flag. The 26.3 client jar
 * carries the same six values as `net.minecraft.world.level.CardinalLighting
 * .DEFAULT`, read by `BlockModelLighter.getDirectionalBrightness` through
 * `CardinalLighting.byFace`.
 *
 * GUI items are not drawn through that block path: in 1.21.4,
 * `GuiGraphics.renderItem(LivingEntity, Level, ItemStack, int, int, int, int)`
 * (lines 487:520) switches to `Lighting.setupForFlatItems()` for models whose
 * `gui_light` is `front` and restores `Lighting.setupFor3DItems()` afterwards;
 * both feed the fixed diffuse light directions `Lighting.DIFFUSE_LIGHT_0`
 * (`normalize(0.2, 1, -0.7)`) and `DIFFUSE_LIGHT_1`
 * (`normalize(-0.2, 1, 0.7)`) to the item shader, and 26.3 selects
 * `Lighting.Entry.ITEMS_FLAT` / `ITEMS_3D` in `GuiItemAtlas.drawToSlot`.
 * These factors are therefore the block-face coefficients applied to the
 * dominant axis of the transformed face normal, not a measurement of the GUI
 * item shader: the actual GUI item lighting was not verified face by face, and
 * the report lists that gap as `gui-item-shader-lighting` in `unapplied`.
 */
export const SHADE_SCALE = 1000;
export const FACE_SHADE: Readonly<Record<Direction, number>> = {
	down: 500,
	up: 1000,
	north: 800,
	south: 800,
	west: 600,
	east: 600,
};

/**
 * `gui_light: "front"` means the model is shaded like a flat item, so every
 * face gets full brightness here. `gui_light: "side"` means block-like
 * directional shading, which uses {@link FACE_SHADE}. The default is
 * `"side"` (`BlockModel.getGuiLight`).
 */
export type LightingMode = "flat" | "directional";

export function shadeForDirection(direction: Direction): number {
	return FACE_SHADE[direction];
}

/**
 * The dominant axis of a normal, in a fixed tie-break order, so a normal
 * lying exactly between two axes always picks the same one.
 */
const DOMINANT_ORDER: readonly Direction[] = [
	"up",
	"down",
	"east",
	"west",
	"north",
	"south",
];

export function dominantDirection(normal: FixedVec3): Direction | undefined {
	const [x, y, z] = normal;
	const values: Readonly<Record<Direction, number>> = {
		up: y,
		down: -y,
		east: x,
		west: -x,
		south: z,
		north: -z,
	};
	let best: Direction | undefined;
	let bestValue = 0;
	for (const direction of DOMINANT_ORDER) {
		const value = values[direction];
		if (value > bestValue) {
			best = direction;
			bestValue = value;
		}
	}
	return bestValue === 0 ? undefined : best;
}

/** Resolve a normal to a shade factor in thousandths. */
export function shadeForNormal(normal: FixedVec3, mode: LightingMode): number {
	if (mode === "flat") return SHADE_SCALE;
	const direction = dominantDirection(normal);
	return direction === undefined ? SHADE_SCALE : FACE_SHADE[direction];
}

/** A tint colour, one channel per entry, 0..255. */
export type RgbTint = readonly [number, number, number];

/** Parse `#rrggbb` or `rrggbb`; returns undefined for anything else. */
export function parseTintColor(value: string): RgbTint | undefined {
	const match = /^#?([0-9a-fA-F]{6})$/.exec(value);
	if (match === null) return undefined;
	const hex = match[1] as string;
	return [
		Number.parseInt(hex.slice(0, 2), 16),
		Number.parseInt(hex.slice(2, 4), 16),
		Number.parseInt(hex.slice(4, 6), 16),
	];
}

/** The canonical `#rrggbb` form used in reports. */
export function formatTintColor(tint: RgbTint): string {
	const channel = (value: number): string =>
		value.toString(16).padStart(2, "0");
	return `#${channel(tint[0])}${channel(tint[1])}${channel(tint[2])}`;
}

/** One display transform resolved from the inspection report. */
export interface DisplayTransform {
	readonly slot: PreviewDisplaySlot;
	/** The rotation as authored (or the game's default, all zeroes). */
	readonly rotation: Vec3;
	/** The translation as authored (or the game's default, all zeroes). */
	readonly translation: Vec3;
	/** The scale as authored (or the game's default, all ones). */
	readonly scale: Vec3;
	/** Rotation matrix in Q16, applied as `Rx * Ry * Rz`. */
	readonly matrix: Mat3;
	/** Translation in 1/256 model units, after the game's clamp. */
	readonly translationFixed: FixedVec3;
	/** Scale factors in Q16, after the game's clamp. */
	readonly scaleFixed: FixedVec3;
	/** True when the game's clamp changed a translation or scale value. */
	readonly clamped: boolean;
}

/** The part of one `display[slot]` entry the resolver needs. */
export interface DisplayTransformSource {
	readonly rotation?: Vec3;
	readonly translation?: Vec3;
	readonly scale?: Vec3;
}

interface BuiltinPreviewModel {
	readonly guiLight: "front" | "side";
	readonly parent?: string;
	readonly display: Readonly<
		Partial<Record<PreviewDisplaySlot, DisplayTransformSource>>
	>;
}

/**
 * The builtin template models the preview may inherit from.
 *
 * `inspectModel` stops at a builtin template because there is no file to
 * parse (`src/profiles/builtin-models.ts`), so the display transforms and
 * `gui_light` the template ids carry are repeated here (`builtin/entity` has
 * neither, and `builtin/generated` only terminates the chain). Values are
 * from the 1.21.4 vanilla assets mirror:
 * https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.21.4/assets/minecraft/models/item/generated.json
 * (and `handheld.json`, `handheld_rod.json` beside it). Only the supported
 * right-hand slots are listed; the left-hand entries are the game's mirror of
 * the right-hand transform and stay in `unapplied` as `left-hand-mirroring`.
 */
const BUILTIN_PREVIEW_MODELS: Readonly<Record<string, BuiltinPreviewModel>> = {
	"minecraft:builtin/generated": { guiLight: "side", display: {} },
	"minecraft:item/generated": {
		guiLight: "front",
		parent: "minecraft:builtin/generated",
		display: {
			ground: {
				rotation: [0, 0, 0],
				translation: [0, 2, 0],
				scale: [0.5, 0.5, 0.5],
			},
			head: {
				rotation: [0, 180, 0],
				translation: [0, 13, 7],
				scale: [1, 1, 1],
			},
			thirdperson_righthand: {
				rotation: [0, 0, 0],
				translation: [0, 3, 1],
				scale: [0.55, 0.55, 0.55],
			},
			firstperson_righthand: {
				rotation: [0, -90, 25],
				translation: [1.13, 3.2, 1.13],
				scale: [0.68, 0.68, 0.68],
			},
			fixed: { rotation: [0, 180, 0], scale: [1, 1, 1] },
		},
	},
	"minecraft:item/handheld": {
		guiLight: "front",
		parent: "minecraft:item/generated",
		display: {
			thirdperson_righthand: {
				rotation: [0, -90, 55],
				translation: [0, 4, 0.5],
				scale: [0.85, 0.85, 0.85],
			},
			firstperson_righthand: {
				rotation: [0, -90, 25],
				translation: [1.13, 3.2, 1.13],
				scale: [0.68, 0.68, 0.68],
			},
		},
	},
	"minecraft:item/handheld_rod": {
		guiLight: "front",
		parent: "minecraft:item/handheld",
		display: {
			thirdperson_righthand: {
				rotation: [0, 90, 55],
				translation: [0, 4, 2.5],
				scale: [0.85, 0.85, 0.85],
			},
			firstperson_righthand: {
				rotation: [0, 90, 25],
				translation: [0, 1.6, 0.8],
				scale: [0.68, 0.68, 0.68],
			},
		},
	},
};

/**
 * Resolve a slot from a builtin template chain, or undefined when the chain
 * does not define it (or the id is not in the table).
 */
export function builtinDisplaySource(
	modelId: string,
	slot: PreviewDisplaySlot,
):
	| { readonly source: DisplayTransformSource; readonly from: string }
	| undefined {
	const seen = new Set<string>();
	let id: string | undefined = modelId;
	while (id !== undefined && !seen.has(id)) {
		seen.add(id);
		const model: BuiltinPreviewModel | undefined =
			BUILTIN_PREVIEW_MODELS[id as string];
		if (model === undefined) return undefined;
		const source = model.display[slot];
		if (source !== undefined) return { source, from: id };
		id = model.parent;
	}
	return undefined;
}

/**
 * Resolve `gui_light` from a builtin template chain. Every table entry states
 * the final value, so the first lookup is the answer.
 */
export function builtinGuiLight(modelId: string): "front" | "side" | undefined {
	return BUILTIN_PREVIEW_MODELS[modelId]?.guiLight;
}

interface DisplayTransformResult extends DisplayTransform {
	readonly from?: string;
}

/**
 * Resolve one slot's transform from the inspection report.
 *
 * The inspection report already implements the game's inheritance rule
 * (`BlockModel.getTransform`): the first model in the own -> parent chain
 * that defines the slot wins, and a slot that exists with only some fields
 * uses the game's defaults for the rest instead of inheriting them from the
 * parent. `ItemTransform.Deserializer` multiplies translation by 1/16 block
 * (one model unit) and clamps it to +-5 blocks, clamps scale to +-4, and
 * builds the rotation with JOML's `rotationXYZ`, which is
 * `rotationX(x).rotateY(y).rotateZ(z)`; applied to a column vector that is
 * `Rx * Ry * Rz`, so the z rotation acts first, then y, then x.
 */
export function displayTransformFor(
	slot: PreviewDisplaySlot,
	source: DisplayTransformSource | undefined,
	from?: string,
): DisplayTransformResult {
	const rotation = source?.rotation ?? [0, 0, 0];
	const translation = source?.translation ?? [0, 0, 0];
	const scale = source?.scale ?? [1, 1, 1];

	let clamped = false;
	for (const value of translation) {
		if (Math.abs(value) > 80) clamped = true;
	}
	for (const value of scale) {
		if (Math.abs(value) > 4) clamped = true;
	}

	const rotationMatrix3 = ((): Mat3 => {
		const x = rotationMatrix("x", Math.round(rotation[0] * 1000));
		const y = rotationMatrix("y", Math.round(rotation[1] * 1000));
		const z = rotationMatrix("z", Math.round(rotation[2] * 1000));
		return multiplyMat3(x, multiplyMat3(y, z));
	})();

	const translationFixed: FixedVec3 = [
		Math.round(Math.min(80, Math.max(-80, translation[0])) * 256),
		Math.round(Math.min(80, Math.max(-80, translation[1])) * 256),
		Math.round(Math.min(80, Math.max(-80, translation[2])) * 256),
	];
	const scaleFixed: FixedVec3 = [
		Math.round(Math.min(4, Math.max(-4, scale[0])) * TRIG_ONE),
		Math.round(Math.min(4, Math.max(-4, scale[1])) * TRIG_ONE),
		Math.round(Math.min(4, Math.max(-4, scale[2])) * TRIG_ONE),
	];

	return {
		slot,
		rotation,
		translation,
		scale,
		matrix: rotationMatrix3,
		translationFixed,
		scaleFixed,
		clamped,
		...(from === undefined ? {} : { from }),
	};
}

/** Apply one display transform to a point in 1/256 model units. */
export function applyDisplayTransform(
	point: FixedVec3,
	transform: DisplayTransform,
): FixedVec3 {
	const local: FixedVec3 = [
		(point[0] as number) - DISPLAY_PIVOT,
		(point[1] as number) - DISPLAY_PIVOT,
		(point[2] as number) - DISPLAY_PIVOT,
	];
	const scaled: FixedVec3 = [
		divRound(local[0] * (transform.scaleFixed[0] as number), TRIG_ONE),
		divRound(local[1] * (transform.scaleFixed[1] as number), TRIG_ONE),
		divRound(local[2] * (transform.scaleFixed[2] as number), TRIG_ONE),
	];
	const rotated = applyMat3(transform.matrix, scaled);
	return [
		(rotated[0] as number) + (transform.translationFixed[0] as number),
		(rotated[1] as number) + (transform.translationFixed[1] as number),
		(rotated[2] as number) + (transform.translationFixed[2] as number),
	];
}

function nz(value: number): number {
	return value === 0 ? 0 : value;
}

/**
 * True when the display scale mirrors the model, which reverses the winding
 * of every transformed face. The normal used for shading must be reversed
 * too: a mirrored up face points down after the mirror, and the game
 * transforms its baked normal with the inverse-transpose, not with the
 * flipped winding.
 */
export function displayMirrorsFaces(transform: DisplayTransform): boolean {
	const sign = (value: number): number => (value < 0 ? -1 : value > 0 ? 1 : 0);
	return (
		sign(transform.scaleFixed[0] as number) *
			sign(transform.scaleFixed[1] as number) *
			sign(transform.scaleFixed[2] as number) <
		0
	);
}

/**
 * The display camera: +x right, +y up, +z toward the viewer, with the origin
 * at the model centre. This is the GUI item camera (`GuiGraphics` scales y by
 * -1 before rendering, so a model's +y goes up the screen); unlike
 * `projectOrthographic("front")`, which looks from the north, it sees the
 * model's south face, which is the face `item/generated` puts toward the
 * inventory camera. `applyDisplayTransform` already returns points relative
 * to the model centre (the pivot cancels), so this projection keeps the
 * translation visible inside a fixed panel instead of letting a
 * fit-to-content camera cancel it.
 */
export function projectDisplay(point: FixedVec3): ProjectedPoint {
	return {
		x: nz(point[0]),
		y: nz(-(point[1] as number)),
		depth: nz(point[2]),
	};
}

/**
 * A shade-and-tint copy of one texture. Shading is integer
 * `divRound(channel * shade, SHADE_SCALE)` and tinting is
 * `divRound(channel * tintChannel, 255)`, in that order; alpha is untouched.
 * The original object is returned unchanged when no work is needed, so the
 * default preview path keeps its exact bytes and does not allocate.
 */
export function shadeAndTintTexture(
	texture: {
		readonly width: number;
		readonly height: number;
		readonly pixels: Uint8Array;
	},
	tint: RgbTint | undefined,
	shade: number,
): {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
} {
	if (shade === SHADE_SCALE && tint === undefined) return texture;
	const pixels = new Uint8Array(texture.pixels.length);
	for (let index = 0; index < pixels.length; index += 4) {
		for (let channel = 0; channel < 3; channel += 1) {
			let value = texture.pixels[index + channel] as number;
			if (shade !== SHADE_SCALE) {
				value = divRound(value * shade, SHADE_SCALE);
			}
			if (tint !== undefined) {
				value = divRound(value * (tint[channel] as number), 255);
			}
			pixels[index + channel] = value;
		}
		pixels[index + 3] = texture.pixels[index + 3] as number;
	}
	return { width: texture.width, height: texture.height, pixels };
}
