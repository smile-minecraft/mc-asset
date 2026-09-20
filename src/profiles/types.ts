/** Shared profile-layer types. All classification output stays predicted. */

export type AssetProfileId =
	| "generic"
	| "minecraft:item"
	| "minecraft:block"
	| "minecraft:gui"
	| "minecraft:particle";

export type PredictedAlphaClassification = "solid" | "cutout" | "translucent";

export interface AlphaHistogram {
	opaquePixels: number;
	transparentPixels: number;
	partialAlphaPixels: number;
	partialAlphaValues: number[];
}

export interface PredictedAlphaReport {
	predictedClassification: PredictedAlphaClassification;
	opaquePixels: number;
	transparentPixels: number;
	partialAlphaPixels: number;
	partialAlphaValues: number[];
	predictedNote: string;
}

export type ProfileWarningCode =
	| "PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING"
	| "NON_STANDARD_RESOLUTION"
	| "PENDING_SOURCE_PNG_ONLY"
	| "VERSION_FACT_UNDETERMINED";

export interface ProfileWarning {
	code: ProfileWarningCode;
	level: "warning";
	message: string;
}

export interface AssetProfile {
	id: AssetProfileId;
	preferredAtlas?: string;
	mipmapped?: boolean;
	mipmapAware?: boolean;
	alphaClassificationAware?: boolean;
	description: string;
}

export interface VersionSince {
	/**
	 * Dotted resource-pack format the fact starts from (normalized
	 * major.minor, e.g. "75.0"). Absent means the starting
	 * version is undetermined: the fact never activates and only ever
	 * produces a warning, never an enforcement value.
	 */
	packFormat?: string | undefined;
}

export type FactStatus = "verified" | "pending-source";

export interface VersionedFact<Value> {
	fact: string;
	since: VersionSince;
	value: Value;
	status: FactStatus;
	source: string;
	checkedAt: string;
}
