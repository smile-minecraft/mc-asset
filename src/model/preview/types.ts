import type { ModelResolutionContext } from "../context.ts";
import type { IsometricDirection } from "../geometry/index.ts";
import type { ModelCoverage, ModelVersionInfo } from "../inspect.ts";
import type { Vec3 } from "../types.ts";

/** Panel edge sizes `model preview` accepts; the three-view image is size*3 wide and size high. */
export type ModelPreviewSize = 64 | 128 | 256;

/** Square panels of the output image; panels are laid out horizontally in order. */
export type ModelPreviewPanelName = "front" | "right" | "top" | "isometric";

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
	| { readonly kind: "isometric"; readonly direction: IsometricDirection };

export type ModelPreviewWarningCode =
	| "MODEL_PREVIEW_TEXTURE_MISSING"
	| "MODEL_PREVIEW_TEXTURE_UNRESOLVED"
	| "MODEL_PREVIEW_TEXTURE_UNDECODABLE";

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
}

export interface ModelPreviewResult {
	readonly report: ModelPreviewReport;
	readonly png: Uint8Array;
}
