/** Public shapes of the Blockbench (.bbmodel) exchange. */

import type { ModelSpec } from "../types.ts";

export interface ImportOptions {
	/** Target resource-pack format; overrides the .bbmodel's java_block_version. */
	readonly packFormat?: string;
}

/** A note about a conversion that kept the input usable but changed its shape. */
export interface BbmodelWarning {
	readonly code: string;
	readonly message: string;
}

/** One texture carried by a .bbmodel project, mapped onto a Java texture variable. */
export interface BbmodelTexture {
	/** Java model `textures` key. */
	readonly key: string;
	/** Sprite resource location; starts with "#" for an alias variable. */
	readonly sprite: string;
	readonly name: string;
	readonly namespace: string;
	readonly folder?: string;
	/** Pack-relative PNG path; absent for alias variables and non-embedded textures. */
	readonly relativePath?: string;
	/** Embedded PNG bytes, verbatim; absent when the variable is an alias or a link. */
	readonly png?: Uint8Array;
	readonly width?: number;
	readonly height?: number;
	readonly forceTranslucent: boolean;
	readonly particle: boolean;
}

export interface BbmodelImportResult {
	/** Canonical Java model JSON text. */
	readonly modelText: string;
	readonly spec: ModelSpec;
	readonly textures: readonly BbmodelTexture[];
	readonly formatVersion: string;
	readonly resolution: Readonly<{ width: number; height: number }>;
	readonly packFormat?: string;
	readonly warnings: readonly BbmodelWarning[];
}

export interface BbmodelExportResult {
	/** Canonical .bbmodel JSON text. */
	readonly text: string;
	readonly formatVersion: string;
	readonly elementCount: number;
	readonly textureCount: number;
	readonly warnings: readonly BbmodelWarning[];
}
