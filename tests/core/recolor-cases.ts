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
	luminanceOf,
	mapRoleToBand,
	recolorColor,
	recolorLayer,
} from "../../src/core/recolor.ts";
import type {
	AuthoringPalette,
	PixelCanvas,
	RGBA,
} from "../../src/core/types.ts";
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
];
