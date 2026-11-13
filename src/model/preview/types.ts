import type { ModelResolutionContext } from "../context.ts";
import type { IsometricDirection } from "../geometry/index.ts";
import type { ModelCoverage, ModelVersionInfo } from "../inspect.ts";
import type { Vec3 } from "../types.ts";
import type { LightingMode, PreviewDisplaySlot, RgbTint } from "./display.ts";

/** Panel edge sizes `model preview` accepts; the three-view image is size*3 wide and size high. */
export type ModelPreviewSize = 64 | 128 | 256;

/** Square panels of the output image; panels are laid out horizontally in order. */
export type ModelPreviewPanelName =
	| "front"
	| "right"
	| "top"
	| "isometric"
	| "display";

/** One square panel of the output image. */
export interface ModelPreviewPanel {
	readonly name: ModelPreviewPanelName;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** The model-space box every panel fits, plus the shared scale. */
export interface ModelPreviewRange {
	readonly min: Vec3;
	readonly max: Vec3;
	/**
	 * Pixels per model unit; every panel uses the same value. The three-view
	 * uses an integer, the isometric view a subpixel-exact value (a multiple
	 * of 1/16) so the 2:1 projection still fills the panel.
	 */
	readonly pixelsPerUnit: number;
}

/** Which view the caller asked for. `undefined` in options is the three-view. */
export type ModelPreviewView =
	| { readonly kind: "three-view" }
	| { readonly kind: "isometric"; readonly direction: IsometricDirection }
	| { readonly kind: "display"; readonly slot: PreviewDisplaySlot };

export type ModelPreviewWarningCode =
	| "MODEL_PREVIEW_TEXTURE_MISSING"
	| "MODEL_PREVIEW_TEXTURE_UNRESOLVED"
	| "MODEL_PREVIEW_TEXTURE_UNDECODABLE"
	| "MODEL_PREVIEW_TINT_UNUSED";

export interface ModelPreviewWarning {
	readonly code: ModelPreviewWarningCode;
	readonly level: "warning";
	readonly message: string;
	/** The face texture reference (or its resolved location) the warning is about. */
	readonly target: string;
}

export interface ModelPreviewReport {
	readonly command: "model";
	readonly mode: "preview";
	readonly path: string;
	readonly modelId?: string;
	readonly size: ModelPreviewSize;
	readonly version: ModelVersionInfo;
	readonly image: { readonly width: number; readonly height: number };
	readonly panels: readonly ModelPreviewPanel[];
	readonly range: ModelPreviewRange;
	readonly coverage: ModelCoverage;
	readonly warnings: readonly ModelPreviewWarning[];
	/** Render steps this diagnostic view deliberately does not apply. */
	readonly unapplied: readonly string[];
	/** Present only for the isometric view, so the default report keeps its existing shape. */
	readonly view?: {
		readonly kind: "isometric";
		readonly direction: IsometricDirection;
	};
	/** Present only when `--display` / `display` picked a slot. */
	readonly display?: {
		readonly slot: PreviewDisplaySlot;
		readonly from?: string;
		readonly rotation: Vec3;
		readonly translation: Vec3;
		readonly scale: Vec3;
		/** False when no model in the parent chain defines the slot; identity was used. */
		readonly applied: boolean;
		/** True when the game's clamp changed the authored translation or scale. */
		readonly clamped: boolean;
	};
	/** Present only when lighting was requested. */
	readonly lighting?: {
		readonly mode: LightingMode;
		readonly guiLight: "front" | "side";
	};
	/** Present only when a tint colour was requested. */
	readonly tint?: {
		readonly color?: string;
		readonly tints?: Readonly<Record<string, string>>;
		readonly appliedFaces: number;
		readonly uncoloredFaces: number;
	};
}

export interface ModelPreviewOptions {
	readonly path: string;
	readonly modelId?: string | undefined;
	readonly packFormat?: string | undefined;
	readonly minecraftVersion?: string | undefined;
	readonly context?: ModelResolutionContext | undefined;
	readonly size: ModelPreviewSize;
	/** Undefined keeps the three-view; its output is unchanged. */
	readonly view?: ModelPreviewView | undefined;
	/** Apply one game display slot and view the model through its camera. */
	readonly display?: PreviewDisplaySlot | undefined;
	/** Apply the fixed per-face shade factors selected by `gui_light`. */
	readonly lighting?: boolean | undefined;
	/** One colour for every face that declares `tintindex`. */
	readonly tint?: RgbTint | undefined;
	/** Explicit colour per `tintindex`; indices without an entry stay untinted. */
	readonly tints?: Readonly<Record<string, RgbTint>> | undefined;
}

export interface ModelPreviewResult {
	readonly report: ModelPreviewReport;
	readonly png: Uint8Array;
}
