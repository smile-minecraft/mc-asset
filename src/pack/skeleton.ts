import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { encodePng } from "../io/png.ts";
import {
	ITEM_MODEL_DEFINITIONS_FACT,
	isFactActive,
} from "../profiles/versions.ts";
import { PACK_ICON_SIZE } from "./types.ts";

/**
 * The skeleton `pack init` creates beside the project document: the resource
 * pack directory chain below the output directory, and the placeholder icon.
 * Every path is relative to the project root, every ordering is byte order,
 * and the icon is painted from integer geometry so one request always
 * produces the same bytes on every runtime.
 */

/** Directory chain of the resource pack, below the output directory. */
export const PACK_ASSET_DIRECTORIES: ReadonlyArray<string> = [
	"assets/{namespace}/textures/item",
	"assets/{namespace}/textures/block",
	"assets/{namespace}/models/item",
];

/**
 * `assets/<namespace>/items/` holds the item model definitions, which the
 * game reads from resource pack format 46.0 on. An older target gets the
 * skeleton without it, because the game would ignore the directory.
 */
export const PACK_ITEMS_DIRECTORY = "assets/{namespace}/items";

/** Recipe directory beside the output directory, from the same skeleton. */
export const PACK_RECIPE_DIRECTORY = "recipes";

/** Placeholder icon colors: field, border, mark, plate. */
const ICON_FIELD_EVEN: readonly [number, number, number] = [0x3c, 0x3f, 0x4b];
const ICON_FIELD_ODD: readonly [number, number, number] = [0x34, 0x37, 0x43];
const ICON_INK: readonly [number, number, number] = [0x23, 0x24, 0x2b];
const ICON_ACCENT: readonly [number, number, number] = [0xc0, 0x80, 0x4a];
const ICON_PAPER: readonly [number, number, number] = [0xe8, 0xe6, 0xdf];

/** Checker field block edge, in pixels. */
const ICON_FIELD_BLOCK = 8;

/** Plate bounds, in pixels: a 40x40 square centered in the icon. */
const ICON_PLATE_FROM = 12;
const ICON_PLATE_TO = 52;
const ICON_PLATE_BORDER = 2;

/** Mark radii, doubled, around the center between pixels 31 and 32. */
const ICON_MARK_OUTER = 20;
const ICON_MARK_INNER = 8;
const ICON_CENTER = PACK_ICON_SIZE - 1;

function absolute(value: number): number {
	return value < 0 ? -value : value;
}

/**
 * Directories a successful init leaves behind, relative to the project root
 * and in byte order. Each leaf contributes its whole chain, so a report and
 * a conflict list name every path the run creates.
 */
export function planSkeletonDirectories(
	namespace: string,
	outputDir: string,
	packFormat: string,
): ReadonlyArray<string> {
	const leaves = [...PACK_ASSET_DIRECTORIES];
	if (isFactActive(ITEM_MODEL_DEFINITIONS_FACT, packFormat)) {
		leaves.push(PACK_ITEMS_DIRECTORY);
	}
	const paths = new Set<string>([outputDir, PACK_RECIPE_DIRECTORY]);
	for (const leaf of leaves) {
		const segments = leaf
			.split("/")
			.map((segment) => segment.replace("{namespace}", namespace));
		for (let depth = 1; depth <= segments.length; depth += 1) {
			paths.add([outputDir, ...segments.slice(0, depth)].join("/"));
		}
	}
	return [...paths].sort(compareCodeUnits);
}

/** Byte order, not locale order. */
export function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One pixel of the placeholder icon. The motif is original: an 8px checker
 * field, a plate with a 2px border, and a diamond mark measured by Manhattan
 * distance. The mark center sits between two pixels, so the geometry
 * doubles the offsets instead of dividing them.
 */
export function placeholderIconColor(
	x: number,
	y: number,
): readonly [number, number, number] {
	const outside =
		x < ICON_PLATE_FROM ||
		y < ICON_PLATE_FROM ||
		x >= ICON_PLATE_TO ||
		y >= ICON_PLATE_TO;
	if (outside) {
		const block =
			Math.trunc(x / ICON_FIELD_BLOCK) + Math.trunc(y / ICON_FIELD_BLOCK);
		return block % 2 === 0 ? ICON_FIELD_EVEN : ICON_FIELD_ODD;
	}
	const onBorder =
		x < ICON_PLATE_FROM + ICON_PLATE_BORDER ||
		y < ICON_PLATE_FROM + ICON_PLATE_BORDER ||
		x >= ICON_PLATE_TO - ICON_PLATE_BORDER ||
		y >= ICON_PLATE_TO - ICON_PLATE_BORDER;
	if (onBorder) {
		return ICON_INK;
	}
	const distance =
		absolute(2 * x - ICON_CENTER) + absolute(2 * y - ICON_CENTER);
	if (distance <= ICON_MARK_INNER) {
		return ICON_INK;
	}
	if (distance <= ICON_MARK_OUTER) {
		return ICON_ACCENT;
	}
	return ICON_PAPER;
}

/**
 * Encode the placeholder icon at `PACK_ICON_SIZE` square. Fixed geometry and
 * fixed colors keep the bytes identical for every request and both runtimes.
 */
export function buildPlaceholderIcon(): Uint8Array {
	const canvas = createCanvas(PACK_ICON_SIZE, PACK_ICON_SIZE);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(PACK_ICON_SIZE * PACK_ICON_SIZE * 4);
	for (let y = 0; y < PACK_ICON_SIZE; y += 1) {
		for (let x = 0; x < PACK_ICON_SIZE; x += 1) {
			const [red, green, blue] = placeholderIconColor(x, y);
			const offset = (y * PACK_ICON_SIZE + x) * 4;
			pixels[offset] = red;
			pixels[offset + 1] = green;
			pixels[offset + 2] = blue;
			pixels[offset + 3] = 0xff;
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}
