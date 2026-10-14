import {
	MODEL_FEATURE_SINCE,
	MODEL_TESTED_MINECRAFT_VERSIONS,
	type ModelFeature,
	type ModelRuleReason,
	type ModelRuleStatus,
	type ModelRules,
	resolveModelRules,
} from "../../src/model/versions.ts";
import type { ModelCase } from "./json-document-cases.ts";

const features: readonly ModelFeature[] = [
	"lightEmission",
	"itemDefinitions",
	"oversizedInGui",
	"rotationAnyAngle",
	"displayOnShelf",
	"rotationXyz",
	"blockstateZRotation",
	"swapAnimationScale",
	"texturesObjectForm",
	"itemTransformation",
	"shadeDirectionOverride",
];

type VersionRow = readonly [
	string | undefined,
	ModelRuleStatus,
	ModelRuleReason,
	readonly (boolean | undefined)[],
	ModelRules["rotationAngle"],
	ModelRules["shadeField"],
];

/** Literal expectations from the approved version table, independent of feature thresholds. */
export const VERSION_ROWS: readonly VersionRow[] = [
	[
		"15.0",
		"inferred",
		"legacy-before-item-definitions",
		[
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		],
		"multiples-of-22.5",
		"shade",
	],
	[
		"42.0",
		"inferred",
		"legacy-before-item-definitions",
		[
			true,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		],
		"multiples-of-22.5",
		"shade",
	],
	[
		"46.0",
		"verified",
		"verified-release",
		[true, true, false, false, false, false, false, false, false, false, false],
		"multiples-of-22.5",
		"shade",
	],
	[
		"55.0",
		"verified",
		"verified-release",
		[true, true, false, false, false, false, false, false, false, false, false],
		"multiples-of-22.5",
		"shade",
	],
	[
		"63.0",
		"verified",
		"verified-release",
		[true, true, true, true, false, false, false, false, false, false, false],
		"within-45",
		"shade",
	],
	[
		"69.0",
		"verified",
		"verified-release",
		[true, true, true, true, true, false, false, false, false, false, false],
		"within-45",
		"shade",
	],
	[
		"75.0",
		"verified",
		"verified-release",
		[true, true, true, true, true, true, true, true, false, false, false],
		"unrestricted",
		"shade",
	],
	[
		"84.0",
		"verified",
		"verified-release",
		[true, true, true, true, true, true, true, true, true, true, false],
		"unrestricted",
		"shade",
	],
	[
		"88.0",
		"verified",
		"verified-release",
		[true, true, true, true, true, true, true, true, true, true, false],
		"unrestricted",
		"shade",
	],
	[
		"97.1",
		"verified",
		"verified-release",
		[true, true, true, true, true, true, true, true, true, true, true],
		"unrestricted",
		"shade_direction_override",
	],
	[
		undefined,
		"undetermined",
		"version-not-determined",
		[
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		],
		"unknown",
		"unknown",
	],
	[
		"98.0",
		"undetermined",
		"beyond-verified-range",
		[
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		],
		"unknown",
		"unknown",
	],
	[
		"60.0",
		"inferred",
		"not-a-listed-release",
		[true, true, false, false, false, false, false, false, false, false, false],
		"multiples-of-22.5",
		"shade",
	],
];

/** Independent rules for unit tests of structure checks; never call the resolver under test. */
export function fixtureRules(packFormat: string | undefined): ModelRules {
	const row = VERSION_ROWS.find(([version]) => version === packFormat);
	if (row === undefined)
		throw new Error(`missing literal rule fixture ${packFormat}`);
	return {
		packFormat,
		status: row[1],
		reason: row[2],
		rotationAngle: row[4],
		shadeField: row[5],
		has: (feature) => row[3][features.indexOf(feature)],
	};
}

export const VERSIONS_CASES: ModelCase[] = VERSION_ROWS.map((row) => ({
	name: `versions: literal matrix ${row[0] ?? "unspecified"}`,
	run(check) {
		const actual = resolveModelRules(row[0]);
		check.equal(actual.packFormat, row[0]);
		check.equal(actual.status, row[1]);
		check.equal(actual.reason, row[2]);
		check.deepEqual(
			features.map((feature) => actual.has(feature)),
			row[3],
		);
		check.equal(actual.rotationAngle, row[4]);
		check.equal(actual.shadeField, row[5]);
	},
}));

VERSIONS_CASES.push(
	{
		name: "versions: feature threshold constants and mandatory Minecraft versions",
		run(check) {
			check.deepEqual(MODEL_FEATURE_SINCE, {
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
			});
			check.deepEqual(MODEL_TESTED_MINECRAFT_VERSIONS, [
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
			]);
		},
	},
	{
		name: "versions: supported lower boundary and listed legacy releases",
		run(check) {
			check.equal(resolveModelRules("11.9").reason, "below-supported-range");
			check.equal(resolveModelRules("11.9").has("lightEmission"), undefined);
			for (const version of ["12.0", "13.0", "18.0", "22.0", "32.0", "34.0"]) {
				check.equal(
					resolveModelRules(version).reason,
					"legacy-before-item-definitions",
				);
				check.equal(resolveModelRules(version).status, "inferred");
			}
			check.equal(resolveModelRules("64.0").status, "verified");
			check.equal(resolveModelRules("64.0").rotationAngle, "within-45");
		},
	},
);

for (const [feature, before, at] of [
	["lightEmission", "41.9", "42.0"],
	["itemDefinitions", "45.9", "46.0"],
	["rotationAnyAngle", "62.9", "63.0"],
	["displayOnShelf", "68.9", "69.0"],
	["rotationXyz", "74.9", "75.0"],
	["texturesObjectForm", "83.9", "84.0"],
	["shadeDirectionOverride", "97.0", "97.1"],
] as const) {
	VERSIONS_CASES.push({
		name: `versions: inclusive ${feature} threshold`,
		run(check) {
			check.equal(resolveModelRules(before).has(feature), false);
			check.equal(resolveModelRules(at).has(feature), true);
		},
	});
}

for (const version of ["43.0", "45.9"]) {
	VERSIONS_CASES.push({
		name: `versions: unlisted legacy ${version} reports not-a-listed-release`,
		run(check) {
			const rules = resolveModelRules(version);
			check.equal(rules.reason, "not-a-listed-release");
			check.equal(rules.status, "inferred");
			check.equal(rules.has("itemDefinitions"), false);
		},
	});
}
