/**
 * Frozen expectations for the resource-pack project cases: the skeleton a
 * `pack init` call must leave behind, the project document it must write,
 * the root metadata it must generate per target format, and the placeholder
 * icon it must paint. Every value here is derived from the documented
 * skeleton, the version facts, and the placeholder geometry below, so the
 * shipped constants cannot move the target with them.
 */

/** Placeholder icon geometry: 64x64, a bordered plate with a diamond mark. */
export const ICON_SIZE = 64;

/**
 * The five colors the placeholder may use, in byte order. The motif is
 * original: an 8px checker field, a 40x40 plate with a 2px border, and a
 * Manhattan-distance diamond centered between pixels 31 and 32.
 */
export const ICON_COLORS: ReadonlyArray<string> = [
	"#23242B", // ink: plate border and diamond core
	"#343743", // field, odd block
	"#3C3F4B", // field, even block
	"#C0804A", // accent: diamond ring
	"#E8E6DF", // paper: plate interior
];

/** Probes that pin the motif without depending on the encoder. */
export const ICON_PROBES: ReadonlyArray<{
	x: number;
	y: number;
	hex: string;
}> = [
	{ x: 0, y: 0, hex: "#3C3F4B" }, // field block (0,0) is even
	{ x: 8, y: 0, hex: "#343743" }, // field block (1,0) is odd
	{ x: 6, y: 10, hex: "#343743" }, // field block (0,1) is odd
	{ x: 63, y: 63, hex: "#3C3F4B" }, // field block (7,7) is even
	{ x: 13, y: 13, hex: "#23242B" }, // plate border
	{ x: 20, y: 20, hex: "#E8E6DF" }, // plate interior, off the mark
	{ x: 31, y: 31, hex: "#23242B" }, // diamond core
	{ x: 32, y: 32, hex: "#23242B" }, // diamond core, mirrored
	{ x: 27, y: 31, hex: "#C0804A" }, // diamond ring
	{ x: 31, y: 25, hex: "#C0804A" }, // diamond ring, vertical
];

/** Files a successful init writes, relative to the project root. */
export const INIT_FILES: ReadonlyArray<string> = [
	"mc-asset.pack.json",
	"pack/pack.mcmeta",
	"pack/pack.png",
];

/**
 * Directories a successful init leaves behind, relative to the project root
 * and in byte order, intermediates included. `items/` arrives with resource
 * pack format 46.0, so the caller picks the matching list.
 */
export function expectedInitDirectories(
	namespace: string,
	withItems: boolean,
): ReadonlyArray<string> {
	const assets = `pack/assets/${namespace}`;
	const directories = [
		"pack",
		"pack/assets",
		assets,
		`${assets}/models`,
		`${assets}/models/item`,
		`${assets}/textures`,
		`${assets}/textures/block`,
		`${assets}/textures/item`,
		"recipes",
	];
	if (withItems) {
		directories.push(`${assets}/items`);
	}
	return directories.sort(compareCodeUnits);
}

/** Byte order, not locale order, for every ordered expectation. */
export function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The project document a default call writes: the pinned format, the
 * default style and directories, and the vanilla source left unset.
 */
export function expectedProjectDocument(
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	return {
		allowMinecraftNamespace: false,
		description: "aurelian-forge",
		formatVersion: 1,
		minecraftVersion: "1.21.9",
		name: "aurelian-forge",
		namespace: "aurelian",
		outputDir: "pack",
		recipeDir: "recipes",
		resourcePackVersion: "69.0",
		style: "vanilla",
		vanillaSource: null,
		...overrides,
	};
}

/**
 * Root metadata per target. From resource pack format 65.0 the range is
 * pinned with `min_format` / `max_format` pairs and the legacy field is
 * left out; below it the document carries the single legacy major.
 */
export const EXPECTED_ROOT_METADATA: ReadonlyArray<{
	minecraftVersion: string;
	packFormat: string;
	pack: Record<string, unknown>;
}> = [
	{
		minecraftVersion: "1.20.4",
		packFormat: "22.0",
		pack: { description: "aurelian-forge", pack_format: 22 },
	},
	{
		minecraftVersion: "1.21.8",
		packFormat: "64.0",
		pack: { description: "aurelian-forge", pack_format: 64 },
	},
	{
		minecraftVersion: "1.21.9",
		packFormat: "69.0",
		pack: {
			description: "aurelian-forge",
			max_format: [69, 0],
			min_format: [69, 0],
		},
	},
	{
		minecraftVersion: "26.2",
		packFormat: "88.0",
		pack: {
			description: "aurelian-forge",
			max_format: [88, 0],
			min_format: [88, 0],
		},
	},
	{
		minecraftVersion: "26.3",
		packFormat: "97.1",
		pack: {
			description: "aurelian-forge",
			max_format: [97, 1],
			min_format: [97, 1],
		},
	},
];
