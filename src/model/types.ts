export const DIRECTIONS = [
	"down",
	"up",
	"north",
	"south",
	"west",
	"east",
] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DISPLAY_POSITIONS = [
	"thirdperson_righthand",
	"thirdperson_lefthand",
	"firstperson_righthand",
	"firstperson_lefthand",
	"gui",
	"head",
	"ground",
	"fixed",
	"on_shelf",
] as const;
export type DisplayPosition = (typeof DISPLAY_POSITIONS)[number];

export type Vec3 = readonly [number, number, number];
export type Uv4 = readonly [number, number, number, number];
export type FaceRotation = 0 | 90 | 180 | 270;

/** String = texture variable value or resource location; object form needs rule texturesObjectForm. */
export type TextureEntry =
	| string
	| { readonly sprite: string; readonly forceTranslucent?: boolean };

export interface FaceSpec {
	/** "#variable" or a resource location. */
	readonly texture: string;
	readonly uv?: Uv4;
	readonly rotation?: FaceRotation;
	readonly cullface?: Direction;
	readonly tintindex?: number;
}

export type ElementRotationSpec =
	| {
			readonly origin: Vec3;
			readonly axis: "x" | "y" | "z";
			readonly angle: number;
			readonly rescale?: boolean;
	  }
	| {
			readonly origin: Vec3;
			readonly x?: number;
			readonly y?: number;
			readonly z?: number;
			readonly rescale?: boolean;
	  };

export interface ElementSpec {
	readonly name?: string;
	readonly from: Vec3;
	readonly to: Vec3;
	readonly rotation?: ElementRotationSpec;
	/** Only below pack format 97.1. */
	readonly shade?: boolean;
	/** Only from pack format 97.1. */
	readonly shadeDirectionOverride?: Direction;
	readonly lightEmission?: number;
	readonly faces: Readonly<Partial<Record<Direction, FaceSpec>>>;
}

export interface DisplayTransformSpec {
	readonly rotation?: Vec3;
	readonly translation?: Vec3;
	readonly scale?: Vec3;
}

export interface ModelSpec {
	readonly parent?: string;
	readonly ambientocclusion?: boolean;
	readonly guiLight?: "front" | "side";
	readonly textures?: Readonly<Record<string, TextureEntry>>;
	readonly elements?: readonly ElementSpec[];
	readonly display?: Readonly<
		Partial<Record<DisplayPosition, DisplayTransformSpec>>
	>;
}
