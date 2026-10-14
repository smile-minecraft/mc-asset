export type ModelFeature =
	| "lightEmission"
	| "itemDefinitions"
	| "oversizedInGui"
	| "rotationAnyAngle"
	| "displayOnShelf"
	| "rotationXyz"
	| "blockstateZRotation"
	| "swapAnimationScale"
	| "texturesObjectForm"
	| "itemTransformation"
	| "shadeDirectionOverride";

/** Pack format at which each feature starts (inclusive). Sources in the version matrix of the spec. */
export const MODEL_FEATURE_SINCE: Readonly<Record<ModelFeature, string>> = {
	lightEmission: "42.0",
	itemDefinitions: "46.0",
	oversizedInGui: "63.0",
	rotationAnyAngle: "63.0",
	displayOnShelf: "69.0",
	rotationXyz: "75.0",
	blockstateZRotation: "75.0",
	swapAnimationScale: "75.0",
	texturesObjectForm: "84.0",
	itemTransformation: "84.0",
	shadeDirectionOverride: "97.1",
};

export type ModelRuleStatus = "verified" | "inferred" | "undetermined";

export type ModelRuleReason =
	| "verified-release"
	| "legacy-before-item-definitions"
	| "not-a-listed-release"
	| "beyond-verified-range"
	| "below-supported-range"
	| "version-not-determined";

export interface ModelRules {
	readonly packFormat: string | undefined;
	readonly status: ModelRuleStatus;
	readonly reason: ModelRuleReason;
	readonly rotationAngle:
		| "multiples-of-22.5"
		| "within-45"
		| "unrestricted"
		| "unknown";
	readonly shadeField: "shade" | "shade_direction_override" | "unknown";
	has(feature: ModelFeature): boolean | undefined;
}

const listedReleases = new Set([
	"12.0",
	"13.0",
	"15.0",
	"18.0",
	"22.0",
	"32.0",
	"34.0",
	"42.0",
	"46.0",
	"55.0",
	"63.0",
	"64.0",
	"69.0",
	"75.0",
	"84.0",
	"88.0",
	"97.1",
]);

function parsePackFormat(value: string): readonly [number, number] | undefined {
	const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
	if (!match) return undefined;
	const majorText = match[1];
	const minorText = match[2];
	if (majorText === undefined || minorText === undefined) return undefined;
	const major = Number(majorText);
	const minor = Number(minorText);
	if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor))
		return undefined;
	return [major, minor];
}

function comparePackFormats(left: string, right: string): number {
	const a = parsePackFormat(left);
	const b = parsePackFormat(right);
	if (a === undefined || b === undefined) return Number.NaN;
	return a[0] === b[0] ? a[1] - b[1] : a[0] - b[0];
}

export function resolveModelRules(packFormat: string | undefined): ModelRules {
	if (packFormat === undefined) {
		return {
			packFormat,
			status: "undetermined",
			reason: "version-not-determined",
			rotationAngle: "unknown",
			shadeField: "unknown",
			has: () => undefined,
		};
	}

	const parsed = parsePackFormat(packFormat);
	if (parsed === undefined) {
		return {
			packFormat,
			status: "undetermined",
			reason: "beyond-verified-range",
			rotationAngle: "unknown",
			shadeField: "unknown",
			has: () => undefined,
		};
	}

	const belowRange = comparePackFormats(packFormat, "12.0") < 0;
	const beyondRange = comparePackFormats(packFormat, "97.1") > 0;
	if (belowRange || beyondRange) {
		return {
			packFormat,
			status: "undetermined",
			reason: belowRange ? "below-supported-range" : "beyond-verified-range",
			rotationAngle: "unknown",
			shadeField: "unknown",
			has: () => undefined,
		};
	}

	const listed = listedReleases.has(packFormat);
	const legacy = comparePackFormats(packFormat, "46.0") < 0;
	const status: ModelRuleStatus = listed && !legacy ? "verified" : "inferred";
	const reason: ModelRuleReason = !listed
		? "not-a-listed-release"
		: legacy
			? "legacy-before-item-definitions"
			: "verified-release";
	const angleOrder = comparePackFormats(packFormat, "63.0");
	const xyzOrder = comparePackFormats(packFormat, "75.0");
	const shadeOrder = comparePackFormats(packFormat, "97.1");

	return {
		packFormat,
		status,
		reason,
		rotationAngle:
			angleOrder < 0
				? "multiples-of-22.5"
				: xyzOrder < 0
					? "within-45"
					: "unrestricted",
		shadeField: shadeOrder < 0 ? "shade" : "shade_direction_override",
		has(feature) {
			return comparePackFormats(packFormat, MODEL_FEATURE_SINCE[feature]) >= 0;
		},
	};
}

/** Minecraft versions the shared model tests must exercise (see the test matrix). */
export const MODEL_TESTED_MINECRAFT_VERSIONS: readonly string[] = [
	"1.20.1",
	"1.21.3",
	"1.21.4",
	"1.21.5",
	"1.21.6",
	"1.21.9",
	"1.21.11",
	"26.1",
	"26.2",
	"26.3",
];
