import { McAssetError } from "../../src/core/errors.ts";
import {
	BUILTIN_MATERIAL_IDS,
	getMaterial,
	getMaterialPalette,
	isBuiltinMaterialId,
	listMaterialIds,
} from "../../src/core/material.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface MaterialCase {
	name: string;
	run(check: CaseCheck): void;
}

function throwsCode(check: CaseCheck, fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError && error.code === code) {
			return;
		}
		check.fail(
			`expected McAssetError(${code}) but got ${error instanceof McAssetError ? error.code : String(error)}`,
		);
	}
	check.fail(`expected McAssetError(${code}) but nothing was thrown`);
}

const EXPECTED_IDS = [
	"iron",
	"copper",
	"oxidized_copper",
	"gold",
	"wood",
	"stone",
	"crystal",
];

export const MATERIAL_CASES: MaterialCase[] = [
	{
		name: "builtin material ids match the frozen seven",
		run: (check) => {
			check.deepEqual(listMaterialIds(), EXPECTED_IDS, "seven ids in order");
			check.deepEqual(
				[...BUILTIN_MATERIAL_IDS],
				EXPECTED_IDS,
				"constant matches",
			);
			for (const id of EXPECTED_IDS) {
				check.ok(isBuiltinMaterialId(id), `${id} is builtin`);
			}
			check.ok(!isBuiltinMaterialId("steel"), "steel is not builtin yet");
			check.ok(!isBuiltinMaterialId(""), "empty is not builtin");
		},
	},
	{
		name: "each material palette has shadow, base, and highlight roles",
		run: (check) => {
			for (const id of EXPECTED_IDS) {
				const palette = getMaterialPalette(id);
				const roles = new Set(
					palette.entries
						.map((entry) => entry.role)
						.filter((role) => role !== undefined),
				);
				check.ok(roles.has("shadow"), `${id} has shadow`);
				check.ok(roles.has("base"), `${id} has base`);
				check.ok(roles.has("highlight"), `${id} has highlight`);
			}
		},
	},
	{
		name: "palette entries have unique ids, valid roles, and byte colors",
		run: (check) => {
			const knownRoles = new Set([
				"outline",
				"shadow",
				"dark",
				"base",
				"light",
				"highlight",
				"accent",
				"custom",
			]);
			for (const id of EXPECTED_IDS) {
				const palette = getMaterialPalette(id);
				const seen = new Set<string>();
				for (const entry of palette.entries) {
					check.ok(
						typeof entry.id === "string" && entry.id.length > 0,
						`${id} entry id non-empty`,
					);
					check.ok(!seen.has(entry.id), `${id} entry id unique: ${entry.id}`);
					seen.add(entry.id);
					if (entry.role !== undefined) {
						check.ok(
							knownRoles.has(entry.role),
							`${id} entry ${entry.id} has known role`,
						);
					}
					for (const channel of [
						entry.color.r,
						entry.color.g,
						entry.color.b,
						entry.color.a,
					]) {
						check.ok(
							Number.isInteger(channel) && channel >= 0 && channel <= 255,
							`${id} entry ${entry.id} channel in byte range`,
						);
					}
				}
			}
		},
	},
	{
		name: "starter base colors are distinct per material",
		run: (check) => {
			const bases = EXPECTED_IDS.map((id) => {
				const material = getMaterial(id);
				const base = material.palette.entries.find(
					(entry) => entry.role === "base",
				);
				check.ok(base !== undefined, `${id} has a base entry`);
				return `${base?.color.r},${base?.color.g},${base?.color.b}`;
			});
			check.equal(
				new Set(bases).size,
				EXPECTED_IDS.length,
				"every material has its own base color",
			);
		},
	},
	{
		name: "materials expose palette plus characteristics",
		run: (check) => {
			for (const id of EXPECTED_IDS) {
				const material = getMaterial(id);
				check.equal(material.id, id, `${id} keeps its id`);
				check.ok(
					material.palette.entries.length >= 3,
					`${id} has at least three entries`,
				);
				check.ok(
					Number.isInteger(material.characteristics.contrast),
					`${id} contrast is an integer`,
				);
				check.ok(
					Number.isInteger(material.characteristics.noise),
					`${id} noise is an integer`,
				);
				check.ok(
					typeof material.characteristics.cluster === "string" &&
						material.characteristics.cluster.length > 0,
					`${id} cluster described`,
				);
				check.ok(
					typeof material.characteristics.highlightBehavior === "string" &&
						material.characteristics.highlightBehavior.length > 0,
					`${id} highlight behavior described`,
				);
			}
		},
	},
	{
		name: "same material twice is deep-equal and mutation-safe",
		run: (check) => {
			const first = getMaterial("iron");
			const second = getMaterial("iron");
			check.deepEqual(first, second, "repeat reads agree");
			first.palette.entries[0].color.r = 1;
			first.palette.entries.push({
				id: "injected",
				color: { r: 0, g: 0, b: 0, a: 255 },
			});
			const third = getMaterial("iron");
			check.deepEqual(third, second, "caller mutation does not leak back");
			const paletteA = getMaterialPalette("gold");
			const paletteB = getMaterialPalette("gold");
			check.deepEqual(paletteA, paletteB, "palette reads agree");
			paletteA.entries.length = 0;
			check.ok(
				getMaterialPalette("gold").entries.length > 0,
				"palette mutation does not leak back",
			);
		},
	},
	{
		name: "unknown material id is INVALID_ARGUMENT",
		run: (check) => {
			throwsCode(check, () => getMaterial("steel"), "INVALID_ARGUMENT");
			throwsCode(check, () => getMaterial("neon"), "INVALID_ARGUMENT");
			throwsCode(check, () => getMaterial(""), "INVALID_ARGUMENT");
			throwsCode(check, () => getMaterialPalette("cloth"), "INVALID_ARGUMENT");
		},
	},
];
