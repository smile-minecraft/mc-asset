/**
 * Writes tests/model/fixtures/bbmodel/synthetic.bbmodel.
 *
 * This is a synthetic fixture: it follows the Java Block/Item .bbmodel shape
 * saved by Blockbench (JannisX11/blockbench, master
 * ec0b2827104d0799c153bfb5f867579c0c44652f), but no Blockbench application
 * wrote it. The real application save used by the tests is
 * `seed_analyzer_journal.bbmodel`; see README.md in this directory for both
 * provenances. Run from the repository root:
 *
 *   bun tests/model/fixtures/bbmodel/make-fixture.ts
 *
 * The output is deterministic: regenerating must produce identical bytes.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../../../src/core/canvas.ts";
import { encodePng } from "../../../../src/io/png.ts";

const WIDTH = 48;
const HEIGHT = 32;

function textureDataUrl(): string {
	const canvas = createCanvas(WIDTH, HEIGHT);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
	for (let y = 0; y < HEIGHT; y += 1) {
		for (let x = 0; x < WIDTH; x += 1) {
			const index = (y * WIDTH + x) * 4;
			pixels[index] = (x * 5) & 255;
			pixels[index + 1] = (y * 7) & 255;
			pixels[index + 2] = ((x + y) * 3) & 255;
			pixels[index + 3] = (x + y) % 7 === 0 ? 96 : 255;
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return `data:image/png;base64,${Buffer.from(encodePng(canvas)).toString("base64")}`;
}

const faces = (texture: number) => ({
	north: { uv: [0, 0, 16, 12], texture },
	east: { uv: [16, 0, 24, 12], texture },
	south: { uv: [24, 0, 40, 12], texture },
	west: { uv: [40, 0, 48, 12], texture },
	up: { uv: [0, 12, 16, 20], texture },
	down: { uv: [16, 12, 32, 20], texture },
});

const model = {
	meta: { format_version: "5.0", model_format: "java_block", box_uv: false },
	name: "synthetic",
	parent: "",
	ambientocclusion: true,
	front_gui_light: false,
	java_block_version: "26.3",
	resolution: { width: WIDTH, height: HEIGHT },
	elements: [
		{
			name: "rotated",
			box_uv: false,
			rescale: false,
			from: [0, 0, 0],
			to: [16, 12, 8],
			autouv: 0,
			origin: [8, 6, 4],
			rotation: [0, 22.5, 0],
			faces: faces(0),
			type: "cube",
			uuid: "11111111-2222-4333-8444-555555555555",
		},
		{
			name: "plain",
			box_uv: false,
			rescale: false,
			from: [0, 12, 0],
			to: [16, 16, 8],
			autouv: 0,
			origin: [0, 0, 0],
			faces: faces(0),
			type: "cube",
			uuid: "66666666-7777-4888-8999-aaaaaaaaaaaa",
		},
	],
	outliner: [
		"11111111-2222-4333-8444-555555555555",
		"66666666-7777-4888-8999-aaaaaaaaaaaa",
	],
	textures: [
		{
			path: "",
			name: "fixture",
			folder: "block",
			namespace: "",
			id: "all",
			width: WIDTH,
			height: HEIGHT,
			uv_width: WIDTH,
			uv_height: HEIGHT,
			particle: false,
			use_as_default: false,
			render_mode: "default",
			visible: true,
			internal: true,
			saved: false,
			uuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
			source: textureDataUrl(),
		},
	],
	display: {
		gui: {
			rotation: [30, 45, 0],
			translation: [1, 2, 3],
			scale: [1.5, 1.5, 1.5],
		},
	},
};

const target = fileURLToPath(new URL("./synthetic.bbmodel", import.meta.url));
writeFileSync(target, JSON.stringify(model));
