/** Core data model: PixelCanvas, Layer, Region, RGBA, AuthoringPalette. */

export interface RGBA {
	r: number;
	g: number;
	b: number;
	a: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type BlendMode = "normal";

export interface PixelLayer {
	id: string;
	name?: string;
	pixels: Uint8Array;
	visible: boolean;
	opacity: number;
	blendMode: BlendMode;
	metadata?: Record<string, unknown>;
}

export interface PixelRegion {
	id: string;
	name?: string;
	mask: Uint8Array;
	metadata?: Record<string, unknown>;
}

export type PaletteRole =
	| "outline"
	| "shadow"
	| "dark"
	| "base"
	| "light"
	| "highlight"
	| "accent"
	| "custom";

export interface AuthoringPaletteEntry {
	id: string;
	color: RGBA;
	role?: PaletteRole;
	metadata?: Record<string, unknown>;
}

export interface AuthoringPalette {
	entries: AuthoringPaletteEntry[];
}

export type CanvasMetadata = Record<string, unknown>;

export interface PixelCanvas {
	version: number;
	width: number;
	height: number;
	layers: PixelLayer[];
	regions: PixelRegion[];
	palette?: AuthoringPalette;
	metadata: CanvasMetadata;
}
