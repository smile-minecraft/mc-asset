import {
	addLayer,
	addRegion,
	createAuthoringPalette,
	createCanvas,
	getLayer,
	getPixel,
	setPixel,
	setRegionValue,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import { getMaterialPalette } from "../../src/core/material.ts";
import {
	bandForLuminance,
	familyRoleForLuminance,
	luminanceOf,
	mapRoleToBand,
	recolorColor,
	recolorLayer,
	recolorLayerByFamily,
	recolorRolelessCanvasByFamily,
} from "../../src/core/recolor.ts";
import type {
	AuthoringPalette,
	PaletteRole,
	PixelCanvas,
	RGBA,
} from "../../src/core/types.ts";
import { VANILLA_PALETTE } from "../../src/style/palette.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface RecolorCase {
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

function gray(value: number): RGBA {
	return { r: value, g: value, b: value, a: 255 };
}

function key(color: RGBA): string {
	return `${color.r},${color.g},${color.b},${color.a}`;
}

function targetColor(materialId: string, role: string): RGBA {
	const entry = getMaterialPalette(materialId).entries.find(
		(candidate) => candidate.role === role,
	);
	if (entry === undefined) {
		throw new Error(`target ${materialId} misses role ${role}`);
	}
	return { ...entry.color };
}

const SOURCE_ROLES: AuthoringPalette = createAuthoringPalette([
	{
		id: "src-outline",
		color: { r: 10, g: 10, b: 10, a: 255 },
		role: "outline",
	},
	{ id: "src-shadow", color: { r: 40, g: 40, b: 40, a: 255 }, role: "shadow" },
	{ id: "src-dark", color: { r: 70, g: 70, b: 70, a: 255 }, role: "dark" },
	{ id: "src-base", color: { r: 130, g: 130, b: 130, a: 255 }, role: "base" },
	{ id: "src-light", color: { r: 190, g: 190, b: 190, a: 255 }, role: "light" },
	{
		id: "src-highlight",
		color: { r: 230, g: 230, b: 230, a: 255 },
		role: "highlight",
	},
	{ id: "src-accent", color: { r: 200, g: 20, b: 20, a: 255 }, role: "accent" },
	{ id: "src-custom", color: { r: 20, g: 200, b: 20, a: 255 }, role: "custom" },
]);

function roleCanvas(): { canvas: PixelCanvas; layerId: string } {
	const canvas = createCanvas(8, 1, { palette: SOURCE_ROLES });
	const layer = addLayer(canvas, { id: "paint" });
	const order = [
		"src-outline",
		"src-shadow",
		"src-dark",
		"src-base",
		"src-light",
		"src-highlight",
		"src-accent",
		"src-custom",
	];
	order.forEach((id, x) => {
		const entry = SOURCE_ROLES.entries.find((candidate) => candidate.id === id);
		if (entry !== undefined) {
			setPixel(canvas, layer.id, x, 0, entry.color);
		}
	});
	return { canvas, layerId: layer.id };
}

function snapshot(canvas: PixelCanvas, layerId: string): Uint8Array {
	return getLayer(canvas, layerId).pixels.slice();
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

export const RECOLOR_CASES: RecolorCase[] = [
	{
		name: "luminance uses integer weights without float drift",
		run: (check) => {
			check.equal(luminanceOf({ r: 0, g: 0, b: 0, a: 255 }), 0, "black is 0");
			check.equal(
				luminanceOf({ r: 255, g: 255, b: 255, a: 255 }),
				255,
				"white is 255",
			);
			check.equal(
				luminanceOf({ r: 255, g: 0, b: 0, a: 255 }),
				76,
				"pure red is 76",
			);
			check.equal(
				luminanceOf({ r: 0, g: 255, b: 0, a: 255 }),
				149,
				"pure green is 149",
			);
			check.equal(
				luminanceOf({ r: 0, g: 0, b: 255, a: 255 }),
				29,
				"pure blue is 29",
			);
			check.equal(luminanceOf(gray(95)), 95, "gray keeps its level");
		},
	},
	{
		name: "luminance bands split at 96 and 160",
		run: (check) => {
			check.equal(bandForLuminance(0), "shadow", "0 is shadow");
			check.equal(bandForLuminance(95), "shadow", "95 is shadow");
			check.equal(bandForLuminance(96), "base", "96 is base");
			check.equal(bandForLuminance(159), "base", "159 is base");
			check.equal(bandForLuminance(160), "highlight", "160 is highlight");
			check.equal(bandForLuminance(255), "highlight", "255 is highlight");
		},
	},
	{
		name: "role mapping golden: shadow and dark share the shadow band",
		run: (check) => {
			check.equal(mapRoleToBand("shadow"), "shadow", "shadow maps to shadow");
			check.equal(mapRoleToBand("dark"), "shadow", "dark maps to shadow");
			check.equal(mapRoleToBand("base"), "base", "base maps to base");
			check.equal(mapRoleToBand("light"), "highlight", "light maps high");
			check.equal(
				mapRoleToBand("highlight"),
				"highlight",
				"highlight maps high",
			);
			check.equal(mapRoleToBand("outline"), "keep", "outline is kept");
			check.equal(mapRoleToBand("accent"), "keep", "accent is kept");
			check.equal(mapRoleToBand("custom"), "keep", "custom is kept");
		},
	},
	{
		name: "role-aware recolor maps every band to the target palette",
		run: (check) => {
			const { canvas, layerId } = roleCanvas();
			const report = recolorLayer(canvas, layerId, "gold");
			const goldShadow = targetColor("gold", "shadow");
			const goldBase = targetColor("gold", "base");
			const goldHighlight = targetColor("gold", "highlight");
			check.deepEqual(getPixel(canvas, layerId, 1, 0), goldShadow, "shadow");
			check.deepEqual(getPixel(canvas, layerId, 2, 0), goldShadow, "dark");
			check.deepEqual(getPixel(canvas, layerId, 3, 0), goldBase, "base");
			check.deepEqual(getPixel(canvas, layerId, 4, 0), goldHighlight, "light");
			check.deepEqual(
				getPixel(canvas, layerId, 5, 0),
				goldHighlight,
				"highlight",
			);
			check.equal(report.pixelsChanged, 5, "five band pixels changed");
		},
	},
	{
		name: "outline, accent, and custom pixels are kept verbatim",
		run: (check) => {
			const { canvas, layerId } = roleCanvas();
			recolorLayer(canvas, layerId, "gold");
			const outline = SOURCE_ROLES.entries.find(
				(entry) => entry.id === "src-outline",
			);
			const accent = SOURCE_ROLES.entries.find(
				(entry) => entry.id === "src-accent",
			);
			const custom = SOURCE_ROLES.entries.find(
				(entry) => entry.id === "src-custom",
			);
			check.deepEqual(
				getPixel(canvas, layerId, 0, 0),
				outline?.color,
				"outline",
			);
			check.deepEqual(getPixel(canvas, layerId, 6, 0), accent?.color, "accent");
			check.deepEqual(getPixel(canvas, layerId, 7, 0), custom?.color, "custom");
		},
	},
	{
		name: "luminance fallback honors the 95/96 and 159/160 edges",
		run: (check) => {
			const canvas = createCanvas(4, 1);
			const layer = addLayer(canvas, { id: "paint" });
			setPixel(canvas, layer.id, 0, 0, gray(95));
			setPixel(canvas, layer.id, 1, 0, gray(96));
			setPixel(canvas, layer.id, 2, 0, gray(159));
			setPixel(canvas, layer.id, 3, 0, gray(160));
			recolorLayer(canvas, layer.id, "iron");
			check.deepEqual(
				getPixel(canvas, layer.id, 0, 0),
				targetColor("iron", "shadow"),
				"95 lands in shadow",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 1, 0),
				targetColor("iron", "base"),
				"96 lands in base",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 2, 0),
				targetColor("iron", "base"),
				"159 lands in base",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 3, 0),
				targetColor("iron", "highlight"),
				"160 lands in highlight",
			);
		},
	},
	{
		name: "luminance fallback also covers non-gray primaries",
		run: (check) => {
			const canvas = createCanvas(3, 1);
			const layer = addLayer(canvas, { id: "paint" });
			setPixel(canvas, layer.id, 0, 0, { r: 255, g: 0, b: 0, a: 255 });
			setPixel(canvas, layer.id, 1, 0, { r: 0, g: 255, b: 0, a: 255 });
			setPixel(canvas, layer.id, 2, 0, { r: 255, g: 255, b: 255, a: 255 });
			recolorLayer(canvas, layer.id, "stone");
			check.deepEqual(
				getPixel(canvas, layer.id, 0, 0),
				targetColor("stone", "shadow"),
				"red at 76 is shadow",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 1, 0),
				targetColor("stone", "base"),
				"green at 149 is base",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 2, 0),
				targetColor("stone", "highlight"),
				"white is highlight",
			);
		},
	},
	{
		name: "region-aware recolor leaves outside bytes and the mask alone",
		run: (check) => {
			const canvas = createCanvas(4, 1);
			const layer = addLayer(canvas, { id: "paint" });
			const region = addRegion(canvas, { id: "blade" });
			setPixel(canvas, layer.id, 0, 0, gray(20));
			setPixel(canvas, layer.id, 1, 0, gray(20));
			setPixel(canvas, layer.id, 2, 0, gray(200));
			setPixel(canvas, layer.id, 3, 0, gray(200));
			setRegionValue(canvas, region.id, 1, 0, 1);
			setRegionValue(canvas, region.id, 2, 0, 1);
			const maskBefore = region.mask.slice();
			const beforeOutside0 = getPixel(canvas, layer.id, 0, 0);
			const beforeOutside3 = getPixel(canvas, layer.id, 3, 0);
			recolorLayer(canvas, layer.id, "crystal", { regionId: region.id });
			check.deepEqual(
				getPixel(canvas, layer.id, 0, 0),
				beforeOutside0,
				"outside pixel 0 untouched",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 3, 0),
				beforeOutside3,
				"outside pixel 3 untouched",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 1, 0),
				targetColor("crystal", "shadow"),
				"inside dark pixel recolored",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 2, 0),
				targetColor("crystal", "highlight"),
				"inside bright pixel recolored",
			);
			check.ok(
				buffersEqual(region.mask, maskBefore),
				"region mask bytes unchanged",
			);
		},
	},
	{
		name: "every output pixel is a member of the target palette",
		run: (check) => {
			const canvas = createCanvas(16, 4);
			const layer = addLayer(canvas, { id: "paint" });
			let seed = 0x9e3779b9;
			const next = (): number => {
				seed = (seed * 1664525 + 1013904223) >>> 0;
				return (seed >>> 24) & 0xff;
			};
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 16; x += 1) {
					setPixel(canvas, layer.id, x, y, {
						r: next(),
						g: next(),
						b: next(),
						a: 255,
					});
				}
			}
			recolorLayer(canvas, layer.id, "wood");
			const members = new Set(
				getMaterialPalette("wood").entries.map((entry) => key(entry.color)),
			);
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 16; x += 1) {
					const pixel = getPixel(canvas, layer.id, x, y);
					check.ok(
						members.has(key(pixel)),
						`pixel (${x},${y}) is a wood palette member`,
					);
				}
			}
		},
	},
	{
		name: "pure recolor helper is deterministic and palette-bound",
		run: (check) => {
			const first = recolorColor(gray(10), undefined, "copper");
			const second = recolorColor(gray(10), undefined, "copper");
			check.deepEqual(first, second, "same input gives same output");
			check.deepEqual(
				first,
				targetColor("copper", "shadow"),
				"dark gray lands in copper shadow",
			);
			check.deepEqual(
				recolorColor(gray(10), "base", "copper"),
				targetColor("copper", "base"),
				"explicit role wins over luminance",
			);
			check.deepEqual(
				recolorColor({ r: 200, g: 20, b: 20, a: 255 }, "accent", "copper"),
				{ r: 200, g: 20, b: 20, a: 255 },
				"accent role keeps the source color",
			);
		},
	},
	{
		name: "same recolor script twice is byte-identical",
		run: (check) => {
			const paint = (canvas: PixelCanvas, layerId: string): void => {
				setPixel(canvas, layerId, 0, 0, gray(30));
				setPixel(canvas, layerId, 1, 0, gray(120));
				setPixel(canvas, layerId, 2, 0, gray(210));
				setPixel(canvas, layerId, 3, 0, { r: 255, g: 0, b: 0, a: 255 });
				recolorLayer(canvas, layerId, "oxidized_copper");
			};
			const firstCanvas = createCanvas(4, 1);
			const firstLayer = addLayer(firstCanvas, { id: "paint" });
			paint(firstCanvas, firstLayer.id);
			const secondCanvas = createCanvas(4, 1);
			const secondLayer = addLayer(secondCanvas, { id: "paint" });
			paint(secondCanvas, secondLayer.id);
			check.ok(
				buffersEqual(
					snapshot(firstCanvas, firstLayer.id),
					snapshot(secondCanvas, secondLayer.id),
				),
				"two runs produce identical bytes",
			);
		},
	},
	{
		name: "unknown material, layer, and region ids are rejected",
		run: (check) => {
			const canvas = createCanvas(2, 1);
			const layer = addLayer(canvas, { id: "paint" });
			setPixel(canvas, layer.id, 0, 0, gray(100));
			throwsCode(
				check,
				() => recolorLayer(canvas, layer.id, "steel"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => recolorLayer(canvas, "ghost", "iron"),
				"LAYER_NOT_FOUND",
			);
			throwsCode(
				check,
				() => recolorLayer(canvas, layer.id, "iron", { regionId: "ghost" }),
				"REGION_NOT_FOUND",
			);
			const before = snapshot(canvas, layer.id);
			try {
				recolorLayer(canvas, layer.id, "steel");
			} catch {
				// Expected: the failed recolor must leave pixels alone.
			}
			check.ok(
				buffersEqual(before, snapshot(canvas, layer.id)),
				"failed recolor writes nothing",
			);
		},
	},
	{
		name: "fully transparent pixels stay byte-identical on full-layer recolor",
		run: (check) => {
			const canvas = createCanvas(4, 1);
			const layer = addLayer(canvas, { id: "paint" });
			setPixel(canvas, layer.id, 0, 0, { r: 0, g: 0, b: 0, a: 0 });
			setPixel(canvas, layer.id, 1, 0, { r: 17, g: 34, b: 51, a: 0 });
			setPixel(canvas, layer.id, 2, 0, gray(120));
			setPixel(canvas, layer.id, 3, 0, { r: 255, g: 0, b: 0, a: 128 });
			const report = recolorLayer(canvas, layer.id, "iron");
			check.deepEqual(
				getPixel(canvas, layer.id, 0, 0),
				{ r: 0, g: 0, b: 0, a: 0 },
				"clear pixel untouched",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 1, 0),
				{ r: 17, g: 34, b: 51, a: 0 },
				"hidden RGB under A=0 untouched",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 2, 0),
				targetColor("iron", "base"),
				"opaque pixel still recolored",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 3, 0),
				targetColor("iron", "shadow"),
				"partial alpha still recolored",
			);
			check.equal(report.pixelsChanged, 2, "skipped pixels are not counted");
		},
	},
	{
		name: "transparent pixels inside a region are skipped too",
		run: (check) => {
			const canvas = createCanvas(3, 1);
			const layer = addLayer(canvas, { id: "paint" });
			const region = addRegion(canvas, { id: "blade" });
			setPixel(canvas, layer.id, 0, 0, { r: 9, g: 8, b: 7, a: 0 });
			setPixel(canvas, layer.id, 1, 0, gray(200));
			setPixel(canvas, layer.id, 2, 0, gray(200));
			setRegionValue(canvas, region.id, 0, 0, 1);
			setRegionValue(canvas, region.id, 1, 0, 1);
			const maskBefore = region.mask.slice();
			const report = recolorLayer(canvas, layer.id, "gold", {
				regionId: region.id,
			});
			check.deepEqual(
				getPixel(canvas, layer.id, 0, 0),
				{ r: 9, g: 8, b: 7, a: 0 },
				"transparent pixel inside region untouched",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 1, 0),
				targetColor("gold", "highlight"),
				"opaque pixel inside region recolored",
			);
			check.deepEqual(
				getPixel(canvas, layer.id, 2, 0),
				gray(200),
				"outside pixel untouched",
			);
			check.ok(
				buffersEqual(region.mask, maskBefore),
				"region mask bytes unchanged",
			);
			check.equal(report.pixelsChanged, 1, "only the opaque pixel counted");
		},
	},
	{
		name: "pure helper keeps fully transparent colors unchanged",
		run: (check) => {
			const hidden = { r: 10, g: 20, b: 30, a: 0 };
			check.deepEqual(
				recolorColor(hidden, undefined, "gold"),
				hidden,
				"luminance path skips A=0",
			);
			check.deepEqual(
				recolorColor(hidden, "base", "gold"),
				hidden,
				"role path skips A=0",
			);
		},
	},
	{
		name: "six-band integer luminance splits for palette family path",
		run: (check) => {
			check.equal(familyRoleForLuminance(0), "outline");
			check.equal(familyRoleForLuminance(42), "outline");
			check.equal(familyRoleForLuminance(43), "shadow");
			check.equal(familyRoleForLuminance(85), "shadow");
			check.equal(familyRoleForLuminance(86), "dark");
			check.equal(familyRoleForLuminance(127), "dark");
			check.equal(familyRoleForLuminance(128), "base");
			check.equal(familyRoleForLuminance(170), "base");
			check.equal(familyRoleForLuminance(171), "light");
			check.equal(familyRoleForLuminance(213), "light");
			check.equal(familyRoleForLuminance(214), "highlight");
			check.equal(familyRoleForLuminance(255), "highlight");
		},
	},
	{
		name: "sword .mcpx recolored to gold family: hilt preserved, blade outline becomes gold outline, blade interior maps to gold ramp",
		run: (check) => {
			const { canvas, layerId, regionId, bladeOutline, bladeInterior, hilt } =
				createSwordCanvas();
			const before = snapshot(canvas, layerId);
			const report = recolorLayerByFamily(canvas, layerId, "gold", {
				preserveRegions: [regionId],
			});
			check.ok(report.pixelsChanged > 0, "pixels were changed");
			for (const [hx, hy] of hilt) {
				check.deepEqual(
					getPixel(canvas, layerId, hx, hy),
					getPixelAtBytes(before, canvas.width, hx, hy),
					"hilt pixel unchanged",
				);
			}
			for (const [ox, oy] of bladeOutline) {
				check.deepEqual(
					getPixel(canvas, layerId, ox, oy),
					GOLD_RAMP.outline,
					"blade outline is gold outline",
				);
			}
			for (const p of bladeInterior) {
				check.deepEqual(
					getPixel(canvas, layerId, p.x, p.y),
					p.expectedGold,
					`blade interior ${p.role} is gold ${p.role}`,
				);
			}
		},
	},
	{
		name: "sword .mcpx recolored to emerald family: hilt preserved, blade outline becomes emerald outline, blade interior maps to emerald ramp",
		run: (check) => {
			const { canvas, layerId, regionId, bladeOutline, bladeInterior, hilt } =
				createSwordCanvas();
			const before = snapshot(canvas, layerId);
			const report = recolorLayerByFamily(canvas, layerId, "emerald", {
				preserveRegions: [regionId],
			});
			check.ok(report.pixelsChanged > 0, "pixels were changed");
			for (const [hx, hy] of hilt) {
				check.deepEqual(
					getPixel(canvas, layerId, hx, hy),
					getPixelAtBytes(before, canvas.width, hx, hy),
					"hilt pixel unchanged",
				);
			}
			for (const [ox, oy] of bladeOutline) {
				check.deepEqual(
					getPixel(canvas, layerId, ox, oy),
					EMERALD_RAMP.outline,
					"blade outline is emerald outline",
				);
			}
			for (const p of bladeInterior) {
				check.deepEqual(
					getPixel(canvas, layerId, p.x, p.y),
					p.expectedEmerald,
					`blade interior ${p.role} is emerald ${p.role}`,
				);
			}
		},
	},
	{
		name: "sword flat PNG recolored to gold family: hilt preserved, outer outline forced to gold outline, interior uses six bands",
		run: (check) => {
			const { canvas, layerId, regionId, bladeOutline, bladeInterior, hilt } =
				createSwordPngCanvas();
			const before = snapshot(canvas, layerId);
			const report = recolorRolelessCanvasByFamily(canvas, "gold", {
				preserveRegions: [regionId],
			});
			check.ok(report.pixelsChanged > 0, "pixels were changed");
			for (const [hx, hy] of hilt) {
				check.deepEqual(
					getPixel(canvas, layerId, hx, hy),
					getPixelAtBytes(before, canvas.width, hx, hy),
					"hilt pixel unchanged",
				);
			}
			for (const [ox, oy] of bladeOutline) {
				check.deepEqual(
					getPixel(canvas, layerId, ox, oy),
					GOLD_RAMP.outline,
					"outer outline pixel forced to gold outline",
				);
			}
			for (const p of bladeInterior) {
				check.deepEqual(
					getPixel(canvas, layerId, p.x, p.y),
					p.expectedGold,
					"interior pixel mapped by luminance to gold ramp",
				);
			}
		},
	},
	{
		name: "sword flat PNG recolored to emerald family: hilt preserved, outer outline forced to emerald outline, interior uses six bands",
		run: (check) => {
			const { canvas, layerId, regionId, bladeOutline, bladeInterior, hilt } =
				createSwordPngCanvas();
			const before = snapshot(canvas, layerId);
			const report = recolorRolelessCanvasByFamily(canvas, "emerald", {
				preserveRegions: [regionId],
			});
			check.ok(report.pixelsChanged > 0, "pixels were changed");
			for (const [hx, hy] of hilt) {
				check.deepEqual(
					getPixel(canvas, layerId, hx, hy),
					getPixelAtBytes(before, canvas.width, hx, hy),
					"hilt pixel unchanged",
				);
			}
			for (const [ox, oy] of bladeOutline) {
				check.deepEqual(
					getPixel(canvas, layerId, ox, oy),
					EMERALD_RAMP.outline,
					"outer outline pixel forced to emerald outline",
				);
			}
			for (const p of bladeInterior) {
				check.deepEqual(
					getPixel(canvas, layerId, p.x, p.y),
					p.expectedEmerald,
					"interior pixel mapped by luminance to emerald ramp",
				);
			}
		},
	},
	{
		name: "family recolor selection scoping: pixels outside selection are restored verbatim",
		run: (check) => {
			const { canvas, layerId } = createSwordCanvas();
			const before = snapshot(canvas, layerId);
			const report = recolorLayerByFamily(canvas, layerId, "gold", {
				selection: "rect:0,0,16,6",
			});
			check.ok(report.pixelsChanged > 0, "pixels were changed");
			check.deepEqual(
				getPixel(canvas, layerId, 7, 1),
				GOLD_RAMP.outline,
				"selected tip is gold outline",
			);
			check.deepEqual(
				getPixel(canvas, layerId, 7, 7),
				getPixelAtBytes(before, canvas.width, 7, 7),
				"unselected blade base unchanged",
			);
		},
	},
	{
		name: "family recolor region scoping: only specified region is modified",
		run: (check) => {
			const { canvas, layerId, regionId } = createSwordCanvas();
			const before = snapshot(canvas, layerId);
			const report = recolorLayerByFamily(canvas, layerId, "gold", {
				regionId,
			});
			check.ok(report.pixelsChanged > 0, "pixels were changed");
			check.deepEqual(
				getPixel(canvas, layerId, 7, 1),
				getPixelAtBytes(before, canvas.width, 7, 1),
				"blade outside region untouched",
			);
		},
	},
	{
		name: "family recolor preserves hidden RGB on A=0 pixels",
		run: (check) => {
			const { canvas, layerId } = createSwordCanvas();
			const hiddenColor: RGBA = { r: 12, g: 34, b: 56, a: 0 };
			setPixel(canvas, layerId, 0, 0, hiddenColor);
			const report = recolorLayerByFamily(canvas, layerId, "gold");
			check.ok(report.pixelsChanged > 0, "pixels were changed");
			check.deepEqual(
				getPixel(canvas, layerId, 0, 0),
				hiddenColor,
				"A=0 pixel keeps hidden RGB",
			);
		},
	},
	{
		name: "family recolor forces translucent pixels to fully opaque family color",
		run: (check) => {
			const { canvas, layerId } = createSwordCanvas();
			setPixel(canvas, layerId, 7, 4, { r: 150, g: 155, b: 175, a: 128 });
			const report = recolorLayerByFamily(canvas, layerId, "gold");
			check.ok(report.pixelsChanged > 0, "pixels were changed");
			check.deepEqual(
				getPixel(canvas, layerId, 7, 4),
				GOLD_RAMP.base,
				"translucent pixel forced to fully opaque base",
			);
		},
	},
	{
		name: "family recolor completes missing roles per spec",
		run: (check) => {
			const { canvas, layerId } = createSwordCanvas();
			const customRamp = {
				base: "#808080",
				outline: "#202020",
			};
			const report = recolorLayerByFamily(canvas, layerId, "custom", {
				ramp: customRamp,
			});
			check.ok(report.pixelsChanged > 0, "pixels were changed");
			const darkPixel = getPixel(canvas, layerId, 7, 5);
			check.equal(darkPixel.r, darkPixel.g, "neutral dark red equals green");
			check.equal(darkPixel.g, darkPixel.b, "neutral dark green equals blue");
			check.ok(
				darkPixel.r < 128 && darkPixel.r > 32,
				"derived dark role has expected luminance",
			);
		},
	},
	{
		name: "family recolor empty selection modifies 0 pixels and preserves canvas",
		run: (check) => {
			const { canvas, layerId } = createSwordCanvas();
			const before = snapshot(canvas, layerId);
			const report = recolorLayerByFamily(canvas, layerId, "gold", {
				selection: {
					op: "intersect",
					operands: ["rect:0,0,1,1", "rect:15,15,1,1"],
				},
			});
			check.equal(report.pixelsChanged, 0, "empty selection reports 0 changed");
			check.ok(
				buffersEqual(snapshot(canvas, layerId), before),
				"all bytes preserved",
			);
			const reportNonEmpty = recolorLayerByFamily(canvas, layerId, "gold", {
				selection: "all",
			});
			check.ok(
				reportNonEmpty.pixelsChanged > 0,
				"non-empty selection reports changes",
			);
		},
	},
	{
		name: "family recolor rejects non-existent region with REGION_NOT_FOUND",
		run: (check) => {
			const { canvas, layerId } = createSwordCanvas();
			throwsCode(
				check,
				() => {
					recolorLayerByFamily(canvas, layerId, "gold", {
						regionId: "missing_region",
					});
				},
				"REGION_NOT_FOUND",
			);
		},
	},
];

function parseHexColor(hex: string): RGBA {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
		a: 255,
	};
}

const GOLD_RAMP = {
	outline: parseHexColor(VANILLA_PALETTE.gold.outline),
	shadow: parseHexColor(VANILLA_PALETTE.gold.shadow),
	dark: parseHexColor(VANILLA_PALETTE.gold.dark),
	base: parseHexColor(VANILLA_PALETTE.gold.base),
	light: parseHexColor(VANILLA_PALETTE.gold.light),
	highlight: parseHexColor(VANILLA_PALETTE.gold.highlight),
};

const EMERALD_RAMP = {
	outline: parseHexColor(VANILLA_PALETTE.emerald.outline),
	shadow: parseHexColor(VANILLA_PALETTE.emerald.shadow),
	dark: parseHexColor(VANILLA_PALETTE.emerald.dark),
	base: parseHexColor(VANILLA_PALETTE.emerald.base),
	light: parseHexColor(VANILLA_PALETTE.emerald.light),
	highlight: parseHexColor(VANILLA_PALETTE.emerald.highlight),
};

function getPixelAtBytes(
	bytes: Uint8Array,
	width: number,
	x: number,
	y: number,
): RGBA {
	const offset = (y * width + x) * 4;
	return {
		r: bytes[offset] as number,
		g: bytes[offset + 1] as number,
		b: bytes[offset + 2] as number,
		a: bytes[offset + 3] as number,
	};
}

const SWORD_SOURCE_PALETTE: AuthoringPalette = createAuthoringPalette([
	{ id: "sw-outline", color: { r: 10, g: 10, b: 10, a: 255 }, role: "outline" },
	{ id: "sw-shadow", color: { r: 60, g: 60, b: 60, a: 255 }, role: "shadow" },
	{ id: "sw-dark", color: { r: 105, g: 105, b: 105, a: 255 }, role: "dark" },
	{ id: "sw-base", color: { r: 150, g: 150, b: 150, a: 255 }, role: "base" },
	{ id: "sw-light", color: { r: 190, g: 190, b: 190, a: 255 }, role: "light" },
	{
		id: "sw-highlight",
		color: { r: 235, g: 235, b: 235, a: 255 },
		role: "highlight",
	},
	{ id: "sw-guard", color: { r: 110, g: 60, b: 25, a: 255 }, role: "custom" },
	{ id: "sw-grip", color: { r: 75, g: 40, b: 15, a: 255 }, role: "accent" },
]);

function createSwordCanvas(): {
	canvas: PixelCanvas;
	layerId: string;
	regionId: string;
	bladeOutline: Array<[number, number]>;
	bladeInterior: Array<{
		x: number;
		y: number;
		role: PaletteRole;
		expectedGold: RGBA;
		expectedEmerald: RGBA;
	}>;
	hilt: Array<[number, number]>;
} {
	const canvas = createCanvas(16, 16, { palette: SWORD_SOURCE_PALETTE });
	const layer = addLayer(canvas, { id: "main" });
	const region = addRegion(canvas, { id: "hilt", name: "Hilt" });

	const bladeOutline: Array<[number, number]> = [];
	const hilt: Array<[number, number]> = [];

	const outlineEntry = SWORD_SOURCE_PALETTE.entries[0];
	if (outlineEntry === undefined) {
		throw new Error("missing outline entry");
	}
	const outlineColor = outlineEntry.color;
	setPixel(canvas, layer.id, 7, 1, outlineColor);
	bladeOutline.push([7, 1]);
	for (let y = 2; y <= 7; y += 1) {
		setPixel(canvas, layer.id, 6, y, outlineColor);
		setPixel(canvas, layer.id, 8, y, outlineColor);
		bladeOutline.push([6, y]);
		bladeOutline.push([8, y]);
	}
	setPixel(canvas, layer.id, 7, 7, outlineColor);
	bladeOutline.push([7, 7]);

	const bladeInterior = [
		{
			x: 7,
			y: 2,
			role: "highlight" as PaletteRole,
			expectedGold: GOLD_RAMP.highlight,
			expectedEmerald: EMERALD_RAMP.highlight,
		},
		{
			x: 7,
			y: 3,
			role: "light" as PaletteRole,
			expectedGold: GOLD_RAMP.light,
			expectedEmerald: EMERALD_RAMP.light,
		},
		{
			x: 7,
			y: 4,
			role: "base" as PaletteRole,
			expectedGold: GOLD_RAMP.base,
			expectedEmerald: EMERALD_RAMP.base,
		},
		{
			x: 7,
			y: 5,
			role: "dark" as PaletteRole,
			expectedGold: GOLD_RAMP.dark,
			expectedEmerald: EMERALD_RAMP.dark,
		},
		{
			x: 7,
			y: 6,
			role: "shadow" as PaletteRole,
			expectedGold: GOLD_RAMP.shadow,
			expectedEmerald: EMERALD_RAMP.shadow,
		},
	];
	for (const p of bladeInterior) {
		const entry = SWORD_SOURCE_PALETTE.entries.find((c) => c.role === p.role);
		if (entry === undefined) {
			throw new Error(`missing role ${p.role}`);
		}
		setPixel(canvas, layer.id, p.x, p.y, entry.color);
	}

	const guardColor: RGBA = { r: 110, g: 60, b: 25, a: 255 };
	const gripColor: RGBA = { r: 75, g: 40, b: 15, a: 255 };
	for (let x = 4; x <= 10; x += 1) {
		setPixel(canvas, layer.id, x, 8, guardColor);
		setRegionValue(canvas, region.id, x, 8, 1);
		hilt.push([x, 8]);
	}
	for (let y = 9; y <= 11; y += 1) {
		setPixel(canvas, layer.id, 7, y, gripColor);
		setRegionValue(canvas, region.id, 7, y, 1);
		hilt.push([7, y]);
	}
	for (let x = 6; x <= 8; x += 1) {
		setPixel(canvas, layer.id, x, 12, guardColor);
		setRegionValue(canvas, region.id, x, 12, 1);
		hilt.push([x, 12]);
	}

	return {
		canvas,
		layerId: layer.id,
		regionId: region.id,
		bladeOutline,
		bladeInterior,
		hilt,
	};
}

function createSwordPngCanvas(): ReturnType<typeof createSwordCanvas> {
	const sword = createSwordCanvas();
	delete sword.canvas.palette;
	return sword;
}
