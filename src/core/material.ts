import { McAssetError } from "./errors.ts";
import type {
	AuthoringPalette,
	AuthoringPaletteEntry,
	PaletteRole,
	RGBA,
} from "./types.ts";

/**
 * Material semantic layer: an AuthoringPalette plus texture processing
 * characteristics (contrast, noise, cluster, highlight behavior).
 *
 * The nine palettes below are project-owned deterministic values. The metal
 * and gem ramps for `diamond` and `netherite` are plain color measurements
 * taken from vanilla gear textures; they are hex constants kept inside this
 * module and do not copy any official artwork.
 */

export type BuiltinMaterialId =
	| "iron"
	| "copper"
	| "oxidized_copper"
	| "gold"
	| "diamond"
	| "netherite"
	| "wood"
	| "stone"
	| "crystal";

export const BUILTIN_MATERIAL_IDS: readonly BuiltinMaterialId[] = [
	"iron",
	"copper",
	"oxidized_copper",
	"gold",
	"diamond",
	"netherite",
	"wood",
	"stone",
	"crystal",
];

export interface MaterialCharacteristics {
	/** Integer contrast step used by texture processing. */
	contrast: number;
	/** Integer noise amount used by texture processing. */
	noise: number;
	/** Short deterministic cluster description. */
	cluster: string;
	/** Short deterministic highlight description. */
	highlightBehavior: string;
}

export interface MaterialDefinition {
	id: BuiltinMaterialId;
	palette: AuthoringPalette;
	characteristics: MaterialCharacteristics;
}

function opaque(hex: string): RGBA {
	const digits = hex.startsWith("#") ? hex.slice(1) : hex;
	const packed = Number.parseInt(digits, 16);
	return {
		r: (packed >>> 16) & 0xff,
		g: (packed >>> 8) & 0xff,
		b: packed & 0xff,
		a: 255,
	};
}

function entry(
	materialId: string,
	role: PaletteRole,
	hex: string,
): AuthoringPaletteEntry {
	return { id: `${materialId}-${role}`, color: opaque(hex), role };
}

function define(
	id: BuiltinMaterialId,
	roles: Array<{ role: PaletteRole; hex: string }>,
	characteristics: MaterialCharacteristics,
): MaterialDefinition {
	return {
		id,
		palette: {
			entries: roles.map(({ role, hex }) => entry(id, role, hex)),
		},
		characteristics: { ...characteristics },
	};
}

const MATERIALS: Record<BuiltinMaterialId, MaterialDefinition> = {
	iron: define(
		"iron",
		[
			{ role: "outline", hex: "#1a1d21" },
			{ role: "shadow", hex: "#5a6068" },
			{ role: "dark", hex: "#767d86" },
			{ role: "base", hex: "#9aa1a9" },
			{ role: "light", hex: "#b9bfc7" },
			{ role: "highlight", hex: "#d7dce2" },
			{ role: "accent", hex: "#eef2f6" },
		],
		{
			contrast: 3,
			noise: 0,
			cluster: "smooth-plate",
			highlightBehavior: "cool top-left edge",
		},
	),
	copper: define(
		"copper",
		[
			{ role: "outline", hex: "#2a140c" },
			{ role: "shadow", hex: "#7a3b1e" },
			{ role: "dark", hex: "#96502a" },
			{ role: "base", hex: "#b46a3c" },
			{ role: "light", hex: "#d18a58" },
			{ role: "highlight", hex: "#eebd8a" },
			{ role: "accent", hex: "#f6d9ae" },
		],
		{
			contrast: 3,
			noise: 1,
			cluster: "brushed-bands",
			highlightBehavior: "warm top-left edge",
		},
	),
	oxidized_copper: define(
		"oxidized_copper",
		[
			{ role: "outline", hex: "#0e211d" },
			{ role: "shadow", hex: "#2e6b5e" },
			{ role: "dark", hex: "#3d8574" },
			{ role: "base", hex: "#52a58d" },
			{ role: "light", hex: "#74c2a8" },
			{ role: "highlight", hex: "#a3dfc3" },
			{ role: "accent", hex: "#d2f0dd" },
		],
		{
			contrast: 2,
			noise: 2,
			cluster: "patina-blotches",
			highlightBehavior: "soft matte top",
		},
	),
	gold: define(
		"gold",
		[
			{ role: "outline", hex: "#2a1c05" },
			{ role: "shadow", hex: "#8a6414" },
			{ role: "dark", hex: "#a87f22" },
			{ role: "base", hex: "#cfa031" },
			{ role: "light", hex: "#e8bd4e" },
			{ role: "highlight", hex: "#f9dc7e" },
			{ role: "accent", hex: "#fdf0b3" },
		],
		{
			contrast: 4,
			noise: 0,
			cluster: "smooth-plate",
			highlightBehavior: "sharp warm glint",
		},
	),
	/**
	 * `accent` is the highlight lifted three fifths of the way to white, the
	 * same relationship every other ramp uses for its brightest tone.
	 */
	diamond: define(
		"diamond",
		[
			{ role: "outline", hex: "#082520" },
			{ role: "shadow", hex: "#0e3f36" },
			{ role: "dark", hex: "#1e8a77" },
			{ role: "base", hex: "#2bc7ac" },
			{ role: "light", hex: "#33ebcb" },
			{ role: "highlight", hex: "#a4fdf0" },
			{ role: "accent", hex: "#dafef9" },
		],
		{
			contrast: 4,
			noise: 0,
			cluster: "facets",
			highlightBehavior: "bright facet glint",
		},
	),
	/**
	 * Deep purple-grey plate, so the outline stays the near-black plum the
	 * measured darkest netherite pixels actually use.
	 */
	netherite: define(
		"netherite",
		[
			{ role: "outline", hex: "#231012" },
			{ role: "shadow", hex: "#291b24" },
			{ role: "dark", hex: "#3b2c35" },
			{ role: "base", hex: "#4f3c46" },
			{ role: "light", hex: "#63555c" },
			{ role: "highlight", hex: "#867b86" },
			{ role: "accent", hex: "#cecece" },
		],
		{
			contrast: 3,
			noise: 1,
			cluster: "smooth-plate",
			highlightBehavior: "cool top-left edge",
		},
	),
	wood: define(
		"wood",
		[
			{ role: "outline", hex: "#241207" },
			{ role: "shadow", hex: "#5e3a1c" },
			{ role: "dark", hex: "#74491f" },
			{ role: "base", hex: "#8f5c2a" },
			{ role: "light", hex: "#ad7a41" },
			{ role: "highlight", hex: "#d0a266" },
			{ role: "accent", hex: "#ecd0a0" },
		],
		{
			contrast: 3,
			noise: 2,
			cluster: "vertical-grain",
			highlightBehavior: "soft grain sheen",
		},
	),
	stone: define(
		"stone",
		[
			{ role: "outline", hex: "#17171a" },
			{ role: "shadow", hex: "#55555c" },
			{ role: "dark", hex: "#6b6b73" },
			{ role: "base", hex: "#84848c" },
			{ role: "light", hex: "#a3a3ab" },
			{ role: "highlight", hex: "#c9c9d1" },
			{ role: "accent", hex: "#e8e8ee" },
		],
		{
			contrast: 2,
			noise: 2,
			cluster: "speckle",
			highlightBehavior: "diffuse matte top",
		},
	),
	crystal: define(
		"crystal",
		[
			{ role: "outline", hex: "#141b33" },
			{ role: "shadow", hex: "#3b4f9e" },
			{ role: "dark", hex: "#4f63b8" },
			{ role: "base", hex: "#6f83d6" },
			{ role: "light", hex: "#93a3e8" },
			{ role: "highlight", hex: "#c3cdf5" },
			{ role: "accent", hex: "#e9edff" },
		],
		{
			contrast: 4,
			noise: 0,
			cluster: "facets",
			highlightBehavior: "bright facet glint",
		},
	),
};

function copyPalette(palette: AuthoringPalette): AuthoringPalette {
	return {
		entries: palette.entries.map((item) => ({
			...item,
			color: { ...item.color },
			...(item.metadata !== undefined
				? { metadata: { ...item.metadata } }
				: {}),
		})),
	};
}

export function isBuiltinMaterialId(value: string): value is BuiltinMaterialId {
	return (BUILTIN_MATERIAL_IDS as readonly string[]).includes(value);
}

export function listMaterialIds(): BuiltinMaterialId[] {
	return [...BUILTIN_MATERIAL_IDS];
}

/** Deep copy: caller-side mutation never leaks back into the registry. */
export function getMaterial(id: string): MaterialDefinition {
	if (!isBuiltinMaterialId(id)) {
		throw new McAssetError("INVALID_ARGUMENT", "Unknown material id.", {
			id,
		});
	}
	const found = MATERIALS[id];
	return {
		id: found.id,
		palette: copyPalette(found.palette),
		characteristics: { ...found.characteristics },
	};
}

/** Deep copy of one builtin palette. */
export function getMaterialPalette(id: string): AuthoringPalette {
	return getMaterial(id).palette;
}

/** First entry carrying the role, if any. */
export function findPaletteEntryByRole(
	palette: AuthoringPalette,
	role: PaletteRole,
): AuthoringPaletteEntry | undefined {
	return palette.entries.find((item) => item.role === role);
}
