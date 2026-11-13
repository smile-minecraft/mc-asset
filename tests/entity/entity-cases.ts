import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputStreams } from "../../src/cli/channels.ts";
import { runEntity } from "../../src/cli/cmd-entity.ts";
import { parseProfile } from "../../src/cli/profiles.ts";
import { buildProgram } from "../../src/cli/program.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
	setPixel,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { EntityPartReport } from "../../src/entity/inspect.ts";
import { inspectEntityLayout } from "../../src/entity/inspect.ts";
import { resolveEntityLayoutDocument } from "../../src/entity/layout.ts";
import {
	getEntityLayoutDocument,
	listEntityLayoutIds,
} from "../../src/entity/layouts.ts";
import { renderEntityPreview } from "../../src/entity/preview.ts";
import {
	buildEntityTemplate,
	ENTITY_FACE_COLORS,
} from "../../src/entity/template.ts";
import type { EntityFaceName, EntityLayout } from "../../src/entity/types.ts";
import { validateEntityTexture } from "../../src/entity/validate.ts";
import { decodePng, encodePng, flattenCanvas } from "../../src/io/png.ts";
import { handleEntityAsset } from "../../src/mcp/handlers-entity.ts";
import { TOOL_INPUT_SCHEMAS } from "../../src/mcp/schema.ts";
import { parseMcpx, serializeMcpx } from "../../src/mcpx/index.ts";
import {
	describeAssetProfilePredicted,
	getAssetProfile,
	listAssetProfileIds,
} from "../../src/profiles/index.ts";

export interface EntityCaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface EntityCase {
	readonly name: string;
	run(check: EntityCaseCheck): void | Promise<void>;
}

interface ExpectedFace {
	readonly rect: readonly [number, number, number, number];
	readonly uv: readonly [number, number, number, number];
}

type ExpectedPart = Readonly<Record<string, ExpectedFace>>;

function faceMap(part: EntityPartReport): Record<string, ExpectedFace> {
	const out: Record<string, ExpectedFace> = {};
	for (const face of part.faces) {
		out[face.face] = {
			rect: [face.rect.x, face.rect.y, face.rect.width, face.rect.height],
			uv: face.uv,
		};
	}
	return out;
}

function partOf(layout: EntityLayout, id: string): EntityPartReport {
	const report = inspectEntityLayout(layout);
	const part = report.parts.find((candidate) => candidate.id === id);
	if (part === undefined) {
		throw new Error(`Missing part: ${id}.`);
	}
	return part;
}

function errorOf(run: () => unknown): McAssetError {
	try {
		run();
	} catch (error) {
		if (error instanceof McAssetError) return error;
		throw error;
	}
	throw new Error("Expected a McAssetError.");
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const HEAD: ExpectedPart = {
	top: { rect: [8, 0, 8, 8], uv: [16, 8, 8, 0] },
	bottom: { rect: [16, 0, 8, 8], uv: [24, 0, 16, 8] },
	right: { rect: [0, 8, 8, 8], uv: [0, 8, 8, 16] },
	front: { rect: [8, 8, 8, 8], uv: [8, 8, 16, 16] },
	left: { rect: [16, 8, 8, 8], uv: [16, 8, 24, 16] },
	back: { rect: [24, 8, 8, 8], uv: [24, 8, 32, 16] },
};

const BODY: ExpectedPart = {
	top: { rect: [20, 16, 8, 4], uv: [28, 20, 20, 16] },
	bottom: { rect: [28, 16, 8, 4], uv: [36, 16, 28, 20] },
	right: { rect: [16, 20, 4, 12], uv: [16, 20, 20, 32] },
	front: { rect: [20, 20, 8, 12], uv: [20, 20, 28, 32] },
	left: { rect: [28, 20, 4, 12], uv: [28, 20, 32, 32] },
	back: { rect: [32, 20, 8, 12], uv: [32, 20, 40, 32] },
};

const RIGHT_ARM: ExpectedPart = {
	top: { rect: [44, 16, 4, 4], uv: [48, 20, 44, 16] },
	bottom: { rect: [48, 16, 4, 4], uv: [52, 16, 48, 20] },
	right: { rect: [40, 20, 4, 12], uv: [40, 20, 44, 32] },
	front: { rect: [44, 20, 4, 12], uv: [44, 20, 48, 32] },
	left: { rect: [48, 20, 4, 12], uv: [48, 20, 52, 32] },
	back: { rect: [52, 20, 4, 12], uv: [52, 20, 56, 32] },
};

const LEFT_ARM: ExpectedPart = {
	top: { rect: [36, 48, 4, 4], uv: [40, 52, 36, 48] },
	bottom: { rect: [40, 48, 4, 4], uv: [44, 48, 40, 52] },
	right: { rect: [32, 52, 4, 12], uv: [32, 52, 36, 64] },
	front: { rect: [36, 52, 4, 12], uv: [36, 52, 40, 64] },
	left: { rect: [40, 52, 4, 12], uv: [40, 52, 44, 64] },
	back: { rect: [44, 52, 4, 12], uv: [44, 52, 48, 64] },
};

const LEFT_ARM_OVERLAY: ExpectedPart = {
	top: { rect: [52, 48, 4, 4], uv: [56, 52, 52, 48] },
	bottom: { rect: [56, 48, 4, 4], uv: [60, 48, 56, 52] },
	right: { rect: [48, 52, 4, 12], uv: [48, 52, 52, 64] },
	front: { rect: [52, 52, 4, 12], uv: [52, 52, 56, 64] },
	left: { rect: [56, 52, 4, 12], uv: [56, 52, 60, 64] },
	back: { rect: [60, 52, 4, 12], uv: [60, 52, 64, 64] },
};

const RIGHT_LEG: ExpectedPart = {
	top: { rect: [4, 16, 4, 4], uv: [8, 20, 4, 16] },
	bottom: { rect: [8, 16, 4, 4], uv: [12, 16, 8, 20] },
	right: { rect: [0, 20, 4, 12], uv: [0, 20, 4, 32] },
	front: { rect: [4, 20, 4, 12], uv: [4, 20, 8, 32] },
	left: { rect: [8, 20, 4, 12], uv: [8, 20, 12, 32] },
	back: { rect: [12, 20, 4, 12], uv: [12, 20, 16, 32] },
};

const LEFT_LEG: ExpectedPart = {
	top: { rect: [20, 48, 4, 4], uv: [24, 52, 20, 48] },
	bottom: { rect: [24, 48, 4, 4], uv: [28, 48, 24, 52] },
	right: { rect: [16, 52, 4, 12], uv: [16, 52, 20, 64] },
	front: { rect: [20, 52, 4, 12], uv: [20, 52, 24, 64] },
	left: { rect: [24, 52, 4, 12], uv: [24, 52, 28, 64] },
	back: { rect: [28, 52, 4, 12], uv: [28, 52, 32, 64] },
};

const LEFT_LEG_OVERLAY: ExpectedPart = {
	top: { rect: [4, 48, 4, 4], uv: [8, 52, 4, 48] },
	bottom: { rect: [8, 48, 4, 4], uv: [12, 48, 8, 52] },
	right: { rect: [0, 52, 4, 12], uv: [0, 52, 4, 64] },
	front: { rect: [4, 52, 4, 12], uv: [4, 52, 8, 64] },
	left: { rect: [8, 52, 4, 12], uv: [8, 52, 12, 64] },
	back: { rect: [12, 52, 4, 12], uv: [12, 52, 16, 64] },
};

/** The slim left arm keeps the same 32,48 origin but is 3 wide. */
const SLIM_LEFT_ARM: ExpectedPart = {
	top: { rect: [36, 48, 3, 4], uv: [39, 52, 36, 48] },
	bottom: { rect: [39, 48, 3, 4], uv: [42, 48, 39, 52] },
	right: { rect: [32, 52, 4, 12], uv: [32, 52, 36, 64] },
	front: { rect: [36, 52, 3, 12], uv: [36, 52, 39, 64] },
	left: { rect: [39, 52, 4, 12], uv: [39, 52, 43, 64] },
	back: { rect: [43, 52, 3, 12], uv: [43, 52, 46, 64] },
};

const SLIM_LEFT_ARM_OVERLAY: ExpectedPart = {
	top: { rect: [52, 48, 3, 4], uv: [55, 52, 52, 48] },
	bottom: { rect: [55, 48, 3, 4], uv: [58, 48, 55, 52] },
	right: { rect: [48, 52, 4, 12], uv: [48, 52, 52, 64] },
	front: { rect: [52, 52, 3, 12], uv: [52, 52, 55, 64] },
	left: { rect: [55, 52, 4, 12], uv: [55, 52, 59, 64] },
	back: { rect: [59, 52, 3, 12], uv: [59, 52, 62, 64] },
};

const RIGHT_ARM_OVERLAY: ExpectedPart = {
	top: { rect: [44, 32, 4, 4], uv: [48, 36, 44, 32] },
	bottom: { rect: [48, 32, 4, 4], uv: [52, 32, 48, 36] },
	right: { rect: [40, 36, 4, 12], uv: [40, 36, 44, 48] },
	front: { rect: [44, 36, 4, 12], uv: [44, 36, 48, 48] },
	left: { rect: [48, 36, 4, 12], uv: [48, 36, 52, 48] },
	back: { rect: [52, 36, 4, 12], uv: [52, 36, 56, 48] },
};

const RIGHT_LEG_OVERLAY: ExpectedPart = {
	top: { rect: [4, 32, 4, 4], uv: [8, 36, 4, 32] },
	bottom: { rect: [8, 32, 4, 4], uv: [12, 32, 8, 36] },
	right: { rect: [0, 36, 4, 12], uv: [0, 36, 4, 48] },
	front: { rect: [4, 36, 4, 12], uv: [4, 36, 8, 48] },
	left: { rect: [8, 36, 4, 12], uv: [8, 36, 12, 48] },
	back: { rect: [12, 36, 4, 12], uv: [12, 36, 16, 48] },
};

const FACE_NAMES = ["top", "bottom", "right", "front", "left", "back"] as const;

function assertNotMirror(
	check: EntityCaseCheck,
	right: ExpectedPart,
	left: ExpectedPart,
	label: string,
): void {
	for (const face of FACE_NAMES) {
		const rightFace = right[face] as ExpectedFace;
		const leftFace = left[face] as ExpectedFace;
		check.ok(
			rightFace.rect.join(",") !== leftFace.rect.join(","),
			`${label}.${face} rectangle differs between the right and left limb`,
		);
	}
}

const BASE_PARTS: ReadonlyArray<readonly [string, ExpectedPart]> = [
	["head", HEAD],
	["body", BODY],
	["right_arm", RIGHT_ARM],
	["left_arm", LEFT_ARM],
	["right_leg", RIGHT_LEG],
	["left_leg", LEFT_LEG],
];

function emptyPixels(width: number, height: number): Uint8Array {
	return new Uint8Array(width * height * 4);
}

function captureStreams(): {
	streams: OutputStreams;
	stdout(): Uint8Array;
	stderrText(): string;
} {
	const out: Array<string | Uint8Array> = [];
	const err: Array<string | Uint8Array> = [];
	const collect =
		(into: Array<string | Uint8Array>) =>
		(chunk: string | Uint8Array): void => {
			into.push(chunk);
		};
	const join = (chunks: Array<string | Uint8Array>): Uint8Array =>
		new Uint8Array(
			Buffer.concat(
				chunks.map((chunk) =>
					typeof chunk === "string"
						? Buffer.from(chunk, "utf8")
						: Buffer.from(chunk),
				),
			),
		);
	return {
		streams: {
			stdout: { write: collect(out) },
			stderr: { write: collect(err) },
		},
		stdout: () => join(out),
		stderrText: () => new TextDecoder().decode(join(err)),
	};
}

function textOf(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	const block = result.content.find((entry) => entry.type === "text");
	if (block === undefined || block.text === undefined) {
		throw new Error("MCP result has no text block.");
	}
	return block.text;
}

/** Byte-for-byte `mc-asset build --help` from the main baseline. */
const BUILD_HELP_BASELINE = `Usage: mc-asset build [options] [source]

Build a .mcpx source file (or stdin) into PNG and/or .mcpx.

Options:
  --stdin              Read the .mcpx source from stdin.
  --output <path>      Explicit PNG output file path.
  --stdout             Write PNG bytes to stdout.
  --source <path>      Write the re-serialized .mcpx source file.
  --force              Allow overwriting an existing output file.
  --mkdir              Create missing parent directories.
  --in-place           Rewrite the input .mcpx with the new source (implies
                       force for that target).
  --input <path>       Input path used with --in-place.
  --profile <name>     Asset profile (generic, minecraft:item, minecraft:block,
                       minecraft:gui, minecraft:particle).
  --operations <path>  Batch operations JSON file ("-" reads stdin).
  -h, --help           display help for command
`;

/** Fixed sha256 of the 128-px four-view render of the player_wide face-color template. */
const PLAYER_PREVIEW_SHA256 =
	"b6f76a9b8f4b05f606601f759677e7efc2f5a6b9f58bb1a617021bbd8a0da66d";

/** One face's cell color: the template's face colors are the probe for face assignment. */
const FACE_COLOR_KEY: Readonly<Record<EntityFaceName, string>> = {
	top: "91,155,213",
	bottom: "59,90,140",
	right: "106,176,106",
	front: "217,155,74",
	left: "201,106,106",
	back: "155,127,201",
};

function playerTemplate(id: "player_wide" | "player_slim"): {
	readonly layout: EntityLayout;
	readonly texture: {
		readonly width: number;
		readonly height: number;
		readonly pixels: Uint8Array;
	};
} {
	const layout = resolveEntityLayoutDocument(getEntityLayoutDocument(id));
	const template = buildEntityTemplate(layout, { fill: true });
	return {
		layout,
		texture: {
			width: template.canvas.width,
			height: template.canvas.height,
			pixels: flattenCanvas(template.canvas),
		},
	};
}

function decodedImage(png: Uint8Array): {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
} {
	const decoded = decodePng(png);
	return {
		width: decoded.canvas.width,
		height: decoded.canvas.height,
		pixels: flattenCanvas(decoded.canvas),
	};
}

/** The face names whose template color appears in each panel, in face-name order. */
function panelFaceNames(
	png: Uint8Array,
	size: number,
): ReadonlyArray<readonly EntityFaceName[]> {
	const image = decodedImage(png);
	return [0, 1, 2, 3].map((panel) => {
		const found = new Set<EntityFaceName>();
		for (let y = 0; y < size; y += 1) {
			for (let x = 0; x < size; x += 1) {
				const offset = (y * image.width + panel * size + x) * 4;
				if (image.pixels[offset + 3] !== 255) continue;
				const key = `${image.pixels[offset]},${image.pixels[offset + 1]},${image.pixels[offset + 2]}`;
				for (const face of FACE_NAMES) {
					if (FACE_COLOR_KEY[face] === key) found.add(face);
				}
			}
		}
		return FACE_NAMES.filter((face) => found.has(face)).sort();
	});
}

function colorCountInPanels(
	png: Uint8Array,
	size: number,
	panels: readonly number[],
	color: readonly [number, number, number],
): number {
	let count = 0;
	for (const panel of panels) {
		count += colorCountInBand(png, size, panel, 0, size, color);
	}
	return count;
}

/** Count one probe color inside a horizontal band of one panel. */
function colorCountInBand(
	png: Uint8Array,
	size: number,
	panel: number,
	fromX: number,
	toX: number,
	color: readonly [number, number, number],
): number {
	const image = decodedImage(png);
	let count = 0;
	for (let y = 0; y < size; y += 1) {
		for (let x = fromX; x < toX; x += 1) {
			const offset = (y * image.width + panel * size + x) * 4;
			if (
				image.pixels[offset] === color[0] &&
				image.pixels[offset + 1] === color[1] &&
				image.pixels[offset + 2] === color[2] &&
				image.pixels[offset + 3] === 255
			) {
				count += 1;
			}
		}
	}
	return count;
}

function fillTextureRect(
	pixels: Uint8Array,
	width: number,
	rect: readonly [number, number, number, number],
	color: readonly [number, number, number, number],
): void {
	const [x, y, w, h] = rect;
	for (let row = y; row < y + h; row += 1) {
		for (let column = x; column < x + w; column += 1) {
			const offset = (row * width + column) * 4;
			pixels[offset] = color[0];
			pixels[offset + 1] = color[1];
			pixels[offset + 2] = color[2];
			pixels[offset + 3] = color[3];
		}
	}
}

/** A solid 16x16 texture whose right cell is red and left cell green, for a 4x4x4 box. */
function sideCellTexture(): {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
} {
	const pixels = new Uint8Array(16 * 16 * 4);
	// Opaque black everywhere, so the transparent cells cannot let the back faces
	// show through; only the two side cells carry a probe color.
	for (let offset = 3; offset < pixels.length; offset += 4) {
		pixels[offset] = 255;
	}
	fillTextureRect(pixels, 16, [0, 4, 4, 4], [255, 0, 0, 255]);
	fillTextureRect(pixels, 16, [8, 4, 4, 4], [0, 255, 0, 255]);
	return { width: 16, height: 16, pixels };
}

/**
 * Both side cells split red on the cell's left half and green on its right
 * half. Both cells carry the same pattern, so a cell swap alone cannot change
 * the picture; only the mirrored U axis can.
 */
function splitSideCellTexture(): {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
} {
	const pixels = new Uint8Array(16 * 16 * 4);
	for (let offset = 3; offset < pixels.length; offset += 4) {
		pixels[offset] = 255;
	}
	for (const x of [0, 8]) {
		fillTextureRect(pixels, 16, [x, 4, 2, 4], [255, 0, 0, 255]);
		fillTextureRect(pixels, 16, [x + 2, 4, 2, 4], [0, 255, 0, 255]);
	}
	return { width: 16, height: 16, pixels };
}

function mirrorProbeLayout(mirror: boolean): EntityLayout {
	return resolveEntityLayoutDocument({
		format: "mc-asset/entity-layout",
		version: 1,
		id: mirror ? "mirror-probe" : "plain-probe",
		texture: { width: 16, height: 16 },
		parts: [
			{
				id: "box",
				size: [4, 4, 4],
				uv: [0, 0],
				origin: [0, 0, 0],
				...(mirror ? { mirror: true } : {}),
			},
		],
	});
}

export const ENTITY_CASES: readonly EntityCase[] = [
	{
		name: "player wide base parts pin every face rectangle and UV direction",
		run(check) {
			const layout = resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_wide"),
			);
			for (const [id, expected] of BASE_PARTS) {
				check.deepEqual(faceMap(partOf(layout, id)), expected, id);
			}
			check.deepEqual(
				{
					partCount: layout.parts.length,
					faceCount: layout.faces.length,
					mappedPixels: layout.mappedPixels,
					totalPixels: layout.totalPixels,
					unmappedPixels: layout.unmappedPixels,
				},
				{
					partCount: 12,
					faceCount: 72,
					mappedPixels: 3264,
					totalPixels: 4096,
					unmappedPixels: 832,
				},
				"coverage",
			);
		},
	},
	{
		name: "player left limbs keep their own vanilla UV regions instead of mirroring the right limbs",
		run(check) {
			const wide = resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_wide"),
			);
			check.deepEqual(faceMap(partOf(wide, "left_arm")), LEFT_ARM, "left arm");
			check.deepEqual(
				faceMap(partOf(wide, "left_arm_overlay")),
				LEFT_ARM_OVERLAY,
				"left sleeve",
			);
			check.deepEqual(faceMap(partOf(wide, "left_leg")), LEFT_LEG, "left leg");
			check.deepEqual(
				faceMap(partOf(wide, "left_leg_overlay")),
				LEFT_LEG_OVERLAY,
				"left pants",
			);
			check.deepEqual(
				faceMap(partOf(wide, "right_arm_overlay")),
				RIGHT_ARM_OVERLAY,
				"right sleeve",
			);
			check.deepEqual(
				faceMap(partOf(wide, "right_leg_overlay")),
				RIGHT_LEG_OVERLAY,
				"right pants",
			);
			for (const id of [
				"left_arm",
				"left_arm_overlay",
				"left_leg",
				"left_leg_overlay",
			]) {
				check.equal(partOf(wide, id).mirror, false, `${id} mirror flag`);
			}
			assertNotMirror(
				check,
				faceMap(partOf(wide, "right_arm")),
				faceMap(partOf(wide, "left_arm")),
				"arm",
			);
			assertNotMirror(
				check,
				faceMap(partOf(wide, "right_leg")),
				faceMap(partOf(wide, "left_leg")),
				"leg",
			);

			const slim = resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_slim"),
			);
			check.deepEqual(
				faceMap(partOf(slim, "left_arm")),
				SLIM_LEFT_ARM,
				"slim left arm",
			);
			check.deepEqual(
				faceMap(partOf(slim, "left_arm_overlay")),
				SLIM_LEFT_ARM_OVERLAY,
				"slim left sleeve",
			);
			check.equal(partOf(slim, "left_arm").mirror, false, "slim mirror flag");
			assertNotMirror(
				check,
				faceMap(partOf(slim, "right_arm")),
				faceMap(partOf(slim, "left_arm")),
				"slim arm",
			);
		},
	},
	{
		name: "a layout that needs more regions than the canvas allows is refused before any template",
		run(check) {
			const parts = Array.from({ length: 43 }, (_unused, index) => ({
				id: `p${index}`,
				size: [4, 4, 4],
				uv: [0, 0],
			}));
			const error = errorOf(() =>
				resolveEntityLayoutDocument({
					format: "mc-asset/entity-layout",
					version: 1,
					id: "too-many-regions",
					texture: { width: 64, height: 64 },
					parts,
				}),
			);
			check.equal(error.code, "ENTITY_LAYOUT_INVALID", "code");
			check.equal(
				(error.details as { reason?: string }).reason,
				"invalid-layout",
				"reason",
			);
			check.equal(
				(error.details as { requiredRegions?: number }).requiredRegions,
				258,
				"required regions",
			);
			check.equal(
				(error.details as { limit?: number }).limit,
				256,
				"region limit",
			);
			check.ok(error.message.includes("258"), "message names the need");
			// 42 parts need 252 regions and pass the region gate; these probes
			// overlap, so the next rejection is the geometry check.
			const fits = Array.from({ length: 42 }, (_unused, index) => ({
				id: `p${index}`,
				size: [4, 4, 4],
				uv: [0, 0],
			}));
			const overlap = errorOf(() =>
				resolveEntityLayoutDocument({
					format: "mc-asset/entity-layout",
					version: 1,
					id: "still-overlaps",
					texture: { width: 64, height: 64 },
					parts: fits,
				}),
			);
			check.equal(
				overlap.code,
				"ENTITY_LAYOUT_OVERLAP",
				"42 parts pass the gate",
			);
		},
	},
	{
		name: "template regions use the hand-written head, body, and limb rectangles",
		run(check) {
			const layout = resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_wide"),
			);
			const template = buildEntityTemplate(layout, { fill: true });
			check.equal(template.canvas.width, 64, "width");
			check.equal(template.canvas.height, 64, "height");
			check.equal(template.regions.length, 72, "region count");
			for (const [id, expected] of BASE_PARTS) {
				for (const [face, faceExpected] of Object.entries(expected)) {
					const region = template.regions.find(
						(candidate) => candidate.id === `${id}.${face}`,
					);
					check.ok(region !== undefined, `region ${id}.${face}`);
					check.deepEqual(
						[
							region?.rect.x,
							region?.rect.y,
							region?.rect.width,
							region?.rect.height,
						],
						faceExpected.rect,
						`region ${id}.${face}`,
					);
				}
			}
			check.ok(
				template.regions.some((region) => region.id === "head_overlay.top"),
				"overlay region present",
			);
		},
	},
	{
		name: "a mirrored 4x12x4 part swaps right and left and flips every face",
		run(check) {
			const mirrored = resolveEntityLayoutDocument({
				format: "mc-asset/entity-layout",
				version: 1,
				id: "mirror-probe",
				texture: { width: 32, height: 32 },
				parts: [{ id: "box", size: [4, 12, 4], uv: [0, 0], mirror: true }],
			});
			check.deepEqual(
				faceMap(partOf(mirrored, "box")),
				{
					top: { rect: [4, 0, 4, 4], uv: [4, 4, 8, 0] },
					bottom: { rect: [8, 0, 4, 4], uv: [8, 0, 12, 4] },
					right: { rect: [8, 4, 4, 12], uv: [12, 4, 8, 16] },
					front: { rect: [4, 4, 4, 12], uv: [8, 4, 4, 16] },
					left: { rect: [0, 4, 4, 12], uv: [4, 4, 0, 16] },
					back: { rect: [12, 4, 4, 12], uv: [16, 4, 12, 16] },
				},
				"mirrored faces",
			);
			const plain = resolveEntityLayoutDocument({
				format: "mc-asset/entity-layout",
				version: 1,
				id: "plain-probe",
				texture: { width: 32, height: 32 },
				parts: [{ id: "box", size: [4, 12, 4], uv: [0, 0] }],
			});
			check.deepEqual(
				faceMap(partOf(plain, "box")),
				{
					top: { rect: [4, 0, 4, 4], uv: [8, 4, 4, 0] },
					bottom: { rect: [8, 0, 4, 4], uv: [12, 0, 8, 4] },
					right: { rect: [0, 4, 4, 12], uv: [0, 4, 4, 16] },
					front: { rect: [4, 4, 4, 12], uv: [4, 4, 8, 16] },
					left: { rect: [8, 4, 4, 12], uv: [8, 4, 12, 16] },
					back: { rect: [12, 4, 4, 12], uv: [12, 4, 16, 16] },
				},
				"plain faces",
			);
		},
	},
	{
		name: "overlapping faces refuse the layout and name both faces",
		run(check) {
			const error = errorOf(() =>
				resolveEntityLayoutDocument({
					format: "mc-asset/entity-layout",
					version: 1,
					id: "overlap",
					texture: { width: 16, height: 16 },
					parts: [
						{ id: "a", size: [4, 4, 4], uv: [0, 0] },
						{ id: "b", size: [4, 4, 4], uv: [0, 0] },
					],
				}),
			);
			check.equal(error.code, "ENTITY_LAYOUT_OVERLAP", "code");
			check.ok(error.message.includes("a.top"), "first face named");
			check.ok(error.message.includes("b.top"), "second face named");
			const details = error.details as {
				first: { part: string; face: string };
				second: { part: string; face: string };
			};
			check.equal(details.first.part, "a", "first part");
			check.equal(details.second.part, "b", "second part");
		},
	},
	{
		name: "a face outside the texture refuses the layout",
		run(check) {
			const error = errorOf(() =>
				resolveEntityLayoutDocument({
					format: "mc-asset/entity-layout",
					version: 1,
					id: "outside",
					texture: { width: 64, height: 64 },
					parts: [{ id: "box", size: [4, 12, 4], uv: [60, 60] }],
				}),
			);
			check.equal(error.code, "ENTITY_LAYOUT_INVALID", "code");
			check.equal(
				(error.details as { reason?: string }).reason,
				"face-out-of-bounds",
				"reason",
			);
		},
	},
	{
		name: "layout documents carry origin, pivot, and rotation into the report",
		run(check) {
			const layout = resolveEntityLayoutDocument({
				format: "mc-asset/entity-layout",
				version: 1,
				id: "carried",
				texture: { width: 32, height: 32 },
				parts: [
					{
						id: "bone",
						size: [4, 4, 4],
						uv: [0, 0],
						origin: [-2, 10, -2],
						pivot: [0, 12, 0],
						rotation: [0, 45, 0],
						future_field: "ignored",
					},
				],
			});
			const part = partOf(layout, "bone");
			check.deepEqual(part.origin, [-2, 10, -2], "origin");
			check.deepEqual(part.pivot, [0, 12, 0], "pivot");
			check.deepEqual(part.rotation, [0, 45, 0], "rotation");
		},
	},
	{
		name: "a newer layout version is refused without guessing",
		run(check) {
			const error = errorOf(() =>
				resolveEntityLayoutDocument({
					format: "mc-asset/entity-layout",
					version: 2,
					id: "future",
					texture: { width: 16, height: 16 },
					parts: [{ id: "box", size: [4, 4, 4], uv: [0, 0] }],
				}),
			);
			check.equal(error.code, "ENTITY_LAYOUT_UNSUPPORTED_VERSION", "code");
		},
	},
	{
		name: "the template fills each face with its direction color and clears the rest",
		run(check) {
			const layout = resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_wide"),
			);
			const template = buildEntityTemplate(layout, { fill: true });
			const pixels = template.canvas.layers[0]?.pixels as Uint8Array;
			const headTop = ENTITY_FACE_COLORS.top;
			check.deepEqual(
				[
					pixels[(0 * 64 + 8) * 4],
					pixels[(0 * 64 + 8) * 4 + 1],
					pixels[(0 * 64 + 8) * 4 + 2],
					pixels[(0 * 64 + 8) * 4 + 3],
				],
				[headTop.r, headTop.g, headTop.b, headTop.a],
				"head top color",
			);
			// (24,0) is a gap between the head back and the hat; it stays clear.
			check.equal(pixels[(0 * 64 + 24) * 4 + 3], 0, "gap stays transparent");
			for (const region of template.regions) {
				let filled = 0;
				const mask = template.canvas.regions.find(
					(candidate) => candidate.id === region.id,
				)?.mask as Uint8Array;
				for (const value of mask) filled += value;
				check.equal(
					filled,
					region.rect.width * region.rect.height,
					`${region.id} mask area`,
				);
			}
			const clear = buildEntityTemplate(layout, { fill: false });
			const clearPixels = clear.canvas.layers[0]?.pixels as Uint8Array;
			for (let offset = 3; offset < clearPixels.length; offset += 4) {
				check.equal(clearPixels[offset], 0, "clear template alpha");
				if (clearPixels[offset] !== 0) break;
			}
		},
	},
	{
		name: "mcpx round-trip rebuilds the exact template PNG bytes",
		run(check) {
			const layout = resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_wide"),
			);
			const template = buildEntityTemplate(layout, { fill: true });
			const text = serializeMcpx(template.canvas);
			const direct = encodePng(template.canvas);
			const rebuilt = encodePng(parseMcpx(text));
			check.equal(direct.length, rebuilt.length, "PNG length");
			let same = true;
			for (let index = 0; index < direct.length; index += 1) {
				if (direct[index] !== rebuilt[index]) {
					same = false;
					break;
				}
			}
			check.ok(same, "PNG bytes identical");
			check.equal(
				serializeMcpx(parseMcpx(text)),
				text,
				"mcpx text is canonical",
			);
		},
	},
	{
		name: "validate reports an opaque pixel outside every face and a size mismatch",
		run(check) {
			const layout = resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_wide"),
			);
			const stray = emptyPixels(64, 64);
			stray[(0 * 64 + 24) * 4 + 3] = 255;
			const strayReport = validateEntityTexture(layout, {
				width: 64,
				height: 64,
				pixels: stray,
			});
			check.equal(strayReport.verdict, "pass", "warning does not fail");
			check.equal(strayReport.findings.length, 1, "one finding");
			const warning = strayReport.findings[0];
			check.equal(warning.code, "ENTITY_UNMAPPED_PIXEL", "warning code");
			check.equal(warning.level, "warning", "warning level");
			check.deepEqual(
				warning.code === "ENTITY_UNMAPPED_PIXEL" ? warning.positions : [],
				[{ x: 24, y: 0 }],
				"pixel coordinate",
			);
			const mismatch = validateEntityTexture(layout, {
				width: 32,
				height: 32,
				pixels: emptyPixels(32, 32),
			});
			check.equal(mismatch.verdict, "fail", "mismatch fails");
			check.equal(
				mismatch.findings[0]?.code,
				"ENTITY_TEXTURE_SIZE_MISMATCH",
				"mismatch code",
			);
		},
	},
	{
		name: "the filled template has no unmapped opaque pixels",
		run(check) {
			const layout = resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_wide"),
			);
			const template = buildEntityTemplate(layout, { fill: true });
			const report = validateEntityTexture(layout, {
				width: template.canvas.width,
				height: template.canvas.height,
				pixels: flattenCanvas(template.canvas),
			});
			check.equal(report.verdict, "pass", "verdict");
			check.equal(report.findings.length, 0, "no findings");
		},
	},
	{
		name: "the player slim layout narrows both arms and keeps them inside 64x64",
		run(check) {
			const layout = resolveEntityLayoutDocument(
				getEntityLayoutDocument("player_slim"),
			);
			const rightArm = faceMap(partOf(layout, "right_arm"));
			const leftArm = faceMap(partOf(layout, "left_arm"));
			check.deepEqual(
				rightArm.front?.rect,
				[44, 20, 3, 12],
				"right arm front width",
			);
			check.deepEqual(rightArm.back?.rect, [51, 20, 3, 12], "right arm back");
			check.deepEqual(leftArm.front?.rect, [36, 52, 3, 12], "left arm front");
			check.deepEqual(leftArm.back?.rect, [43, 52, 3, 12], "left arm back");
			check.equal(layout.mappedPixels, 3136, "slim mapped pixels");
			check.equal(layout.unmappedPixels, 960, "slim unmapped pixels");
		},
	},
	{
		name: "minecraft:entity is a registered profile and the CLI accepts it",
		run(check) {
			check.ok(
				listEntityLayoutIds().includes("player_wide"),
				"wide layout listed",
			);
			check.ok(
				listEntityLayoutIds().includes("player_slim"),
				"slim layout listed",
			);
			check.ok(
				listAssetProfileIds().includes("minecraft:entity"),
				"profile listed",
			);
			check.equal(
				getAssetProfile("minecraft:entity").id,
				"minecraft:entity",
				"profile id",
			);
			const description = describeAssetProfilePredicted("minecraft:entity");
			check.ok(description.includes("predicted"), "predicted tone");
			check.ok(description.includes("minecraft:entity"), "profile named");
			check.equal(
				parseProfile("minecraft:entity"),
				"minecraft:entity",
				"CLI profile",
			);
			const mcpProfile =
				TOOL_INPUT_SCHEMAS.validate_asset.profile?.safeParse(
					"minecraft:entity",
				);
			check.ok(mcpProfile?.success === true, "MCP profile enum");
		},
	},
	{
		name: "wizard-style golden hashes pin Bun and Node template bytes",
		run(check) {
			for (const layoutId of ["player_wide", "player_slim"] as const) {
				const layout = resolveEntityLayoutDocument(
					getEntityLayoutDocument(layoutId),
				);
				const template = buildEntityTemplate(layout, { fill: true });
				check.equal(
					sha256(encodePng(template.canvas)),
					layoutId === "player_wide"
						? "7495aa84add52936a3f32ec1653caa8b4974a1b8e43320da70b52adf6d15aadb"
						: "cf775a4911c3b9ab3b98cade3644d0055b7d8301839189c745f0f03d848c37e7",
					`${layoutId} PNG`,
				);
				check.equal(
					sha256(serializeMcpx(template.canvas)),
					layoutId === "player_wide"
						? "58cde6921efc3443ed3e8059cf0a60b8fb6e818f2addff472c7dd164ef9b6c17"
						: "e350315239a690576e7c44ae995090b88f10e09935774859d7a8893f61070f0f",
					`${layoutId} mcpx`,
				);
			}
		},
	},
	{
		name: "CLI and MCP write identical template files",
		async run(check) {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-entity-"));
			try {
				const cliPng = join(dir, "cli.png");
				const cliMcpx = join(dir, "cli.mcpx");
				const mcpPng = join(dir, "mcp.png");
				const mcpMcpx = join(dir, "mcp.mcpx");
				const captured = captureStreams();
				const exit = await runEntity(
					"template",
					undefined,
					{
						layout: "player_wide",
						output: cliPng,
						source: cliMcpx,
						fill: true,
						mkdir: true,
					},
					true,
					captured.streams,
				);
				check.equal(exit, 0, "CLI exit");
				const mcp = await handleEntityAsset({
					mode: "template",
					layout: "player_wide",
					fill: true,
					outputPngPath: mcpPng,
					outputMcpxPath: mcpMcpx,
				});
				check.equal(mcp.isError, undefined, "MCP has no error");
				const cliPngBytes = new Uint8Array(await readFile(cliPng));
				const mcpPngBytes = new Uint8Array(await readFile(mcpPng));
				const cliMcpxText = await readFile(cliMcpx, "utf8");
				const mcpMcpxText = await readFile(mcpMcpx, "utf8");
				check.equal(sha256(cliPngBytes), sha256(mcpPngBytes), "PNG bytes");
				check.equal(cliMcpxText, mcpMcpxText, "mcpx bytes");
				const cliEnvelope = JSON.parse(
					new TextDecoder().decode(captured.stdout()),
				) as { success: boolean; result: { regions: unknown[] } };
				check.equal(cliEnvelope.success, true, "CLI envelope");
				check.equal(cliEnvelope.result.regions.length, 72, "CLI regions");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "CLI and MCP inspect and validate reports agree",
		async run(check) {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-entity-"));
			try {
				const inspectStreams = captureStreams();
				const inspectExit = await runEntity(
					"inspect",
					undefined,
					{ layout: "player_wide" },
					true,
					inspectStreams.streams,
				);
				check.equal(inspectExit, 0, "inspect exit");
				const cliInspect = JSON.parse(
					new TextDecoder().decode(inspectStreams.stdout()),
				) as { result: unknown };
				const mcpInspect = JSON.parse(
					textOf(
						await handleEntityAsset({
							mode: "inspect",
							layout: "player_wide",
						}),
					),
				) as unknown;
				check.deepEqual(cliInspect.result, mcpInspect, "inspect reports");

				const texture = createCanvas(64, 64);
				const base = addLayer(texture, { id: "base" });
				replaceLayerPixels(texture, base.id, emptyPixels(64, 64));
				setPixel(texture, base.id, 24, 0, { r: 255, g: 0, b: 0, a: 255 });
				const texturePath = join(dir, "stray.png");
				await writeFile(texturePath, encodePng(texture));

				const validateStreams = captureStreams();
				const validateExit = await runEntity(
					"validate",
					texturePath,
					{ layout: "player_wide" },
					true,
					validateStreams.streams,
				);
				check.equal(validateExit, 0, "warning-only validate exit");
				const cliValidate = JSON.parse(
					new TextDecoder().decode(validateStreams.stdout()),
				) as { result: unknown };
				const mcpValidate = JSON.parse(
					textOf(
						await handleEntityAsset({
							mode: "validate",
							layout: "player_wide",
							inputPath: texturePath,
						}),
					),
				) as unknown;
				check.deepEqual(cliValidate.result, mcpValidate, "validate reports");
				const finding = (
					cliValidate.result as {
						findings: Array<{ code: string; positions: unknown }>;
					}
				).findings[0];
				check.equal(finding?.code, "ENTITY_UNMAPPED_PIXEL", "warning code");
				check.deepEqual(finding?.positions, [{ x: 24, y: 0 }], "coordinate");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "text mode lists every face rectangle and keeps warning coordinates",
		async run(check) {
			const inspectStreams = captureStreams();
			const inspectExit = await runEntity(
				"inspect",
				undefined,
				{ layout: "player_wide" },
				false,
				inspectStreams.streams,
			);
			check.equal(inspectExit, 0, "inspect exit");
			const inspectText = new TextDecoder().decode(inspectStreams.stdout());
			for (const fragment of [
				"layout: player_wide",
				"parts: 12 faces: 72",
				"head.top 8,0,8,8 uv=16,8,8,0 mirror=false layer=base",
				"left_arm.front 36,52,4,12 uv=36,52,40,64 mirror=false layer=base",
				"left_arm_overlay.front 52,52,4,12 uv=52,52,56,64 mirror=false layer=overlay",
				"left_leg.back 28,52,4,12 uv=28,52,32,64 mirror=false layer=base",
			]) {
				check.ok(inspectText.includes(fragment), `inspect text: ${fragment}`);
			}
			check.equal(
				inspectText.trim().split("\n").length,
				3 + 72,
				"one line per face",
			);

			const dir = await mkdtemp(join(tmpdir(), "mc-asset-entity-text-"));
			try {
				const texture = createCanvas(64, 64);
				const base = addLayer(texture, { id: "base" });
				replaceLayerPixels(texture, base.id, emptyPixels(64, 64));
				setPixel(texture, base.id, 24, 0, { r: 255, g: 0, b: 0, a: 255 });
				const texturePath = join(dir, "stray.png");
				await writeFile(texturePath, encodePng(texture));
				const validateStreams = captureStreams();
				const validateExit = await runEntity(
					"validate",
					texturePath,
					{ layout: "player_wide" },
					false,
					validateStreams.streams,
				);
				check.equal(validateExit, 0, "warning-only exit");
				const validateText = new TextDecoder().decode(validateStreams.stdout());
				check.ok(
					validateText.includes("verdict: pass"),
					"validate verdict line",
				);
				check.ok(
					validateText.includes(
						"warning [ENTITY_UNMAPPED_PIXEL] 1 non-transparent pixel lies outside every face. positions: 24,0",
					),
					"warning carries the coordinate",
				);

				const layoutPath = join(dir, "overlap.json");
				await writeFile(
					layoutPath,
					JSON.stringify({
						format: "mc-asset/entity-layout",
						version: 1,
						id: "overlap",
						texture: { width: 16, height: 16 },
						parts: [
							{ id: "a", size: [4, 4, 4], uv: [0, 0] },
							{ id: "b", size: [4, 4, 4], uv: [0, 0] },
						],
					}),
				);
				const overlapStreams = captureStreams();
				const overlapExit = await runEntity(
					"inspect",
					undefined,
					{ layout: layoutPath },
					false,
					overlapStreams.streams,
				);
				check.equal(overlapExit, 2, "overlap exit");
				const overlapText = new TextDecoder().decode(overlapStreams.stdout());
				check.ok(
					overlapText.includes("ENTITY_LAYOUT_OVERLAP"),
					"overlap code named",
				);
				check.ok(overlapText.includes("a.top"), "first face named");
				check.ok(overlapText.includes("b.top"), "second face named");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "template outputs go through the standard overwrite, alias, extension, and symlink guards",
		async run(check) {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-entity-guard-"));
			try {
				const existing = join(dir, "taken.png");
				await writeFile(existing, new Uint8Array([1, 2, 3]));
				const refused = captureStreams();
				const refusedExit = await runEntity(
					"template",
					undefined,
					{ layout: "player_wide", output: existing },
					false,
					refused.streams,
				);
				check.equal(refusedExit, 4, "existing output exit");
				check.ok(
					new TextDecoder().decode(refused.stdout()).includes("OUTPUT_EXISTS"),
					"OUTPUT_EXISTS named",
				);
				check.deepEqual(
					[...(await readFile(existing))],
					[1, 2, 3],
					"refused output untouched",
				);

				const forced = await runEntity(
					"template",
					undefined,
					{ layout: "player_wide", output: existing, force: true },
					false,
					captureStreams().streams,
				);
				check.equal(forced, 0, "--force overwrites");
				check.ok((await readFile(existing)).length > 3, "PNG rewritten");

				const badOutput = await runEntity(
					"template",
					undefined,
					{ layout: "player_wide", output: join(dir, "template.txt") },
					false,
					captureStreams().streams,
				);
				check.equal(badOutput, 2, "PNG extension guard");
				const badSource = await runEntity(
					"template",
					undefined,
					{ layout: "player_wide", source: join(dir, "source.png") },
					false,
					captureStreams().streams,
				);
				check.equal(badSource, 2, "mcpx extension guard");

				const layoutPath = join(dir, "layout.mcpx");
				const layoutText = JSON.stringify({
					format: "mc-asset/entity-layout",
					version: 1,
					id: "guard",
					texture: { width: 16, height: 16 },
					parts: [{ id: "box", size: [4, 4, 4], uv: [0, 0] }],
				});
				await writeFile(layoutPath, layoutText);
				const alias = captureStreams();
				const aliasExit = await runEntity(
					"template",
					undefined,
					{ layout: layoutPath, source: layoutPath, force: true },
					false,
					alias.streams,
				);
				check.equal(aliasExit, 2, "output aliasing the layout input");
				check.ok(
					new TextDecoder()
						.decode(alias.stdout())
						.includes("ARGUMENT_CONFLICT"),
					"ARGUMENT_CONFLICT named",
				);
				check.equal(
					await readFile(layoutPath, "utf8"),
					layoutText,
					"layout kept",
				);

				const realTarget = join(dir, "real.png");
				await writeFile(realTarget, new Uint8Array([9]));
				const link = join(dir, "link.png");
				await symlink(realTarget, link);
				const symlinked = await runEntity(
					"template",
					undefined,
					{ layout: "player_wide", output: link, force: true },
					false,
					captureStreams().streams,
				);
				check.equal(symlinked, 4, "symlink target exit");
				check.deepEqual(
					[...(await readFile(realTarget))],
					[9],
					"symlink target untouched",
				);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "build --help and the INVALID_PROFILE text match the main baseline byte for byte",
		run(check) {
			const program = buildProgram();
			const build = program.commands.find(
				(command) => command.name() === "build",
			);
			check.ok(build !== undefined, "build command registered");
			check.equal(
				build?.helpInformation(),
				BUILD_HELP_BASELINE,
				"build help bytes",
			);
			const error = errorOf(() => parseProfile("typo"));
			check.equal(error.code, "INVALID_PROFILE", "profile error code");
			check.equal(
				error.message,
				'[INVALID_PROFILE] Unknown profile "typo". Supported: generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle.',
				"profile error bytes",
			);
			check.equal(
				parseProfile("minecraft:entity"),
				"minecraft:entity",
				"entity profile still accepted",
			);
		},
	},
	{
		name: "the builtin player layout carries the vanilla standing pose and outer-layer dilation",
		run(check) {
			const { layout, texture } = playerTemplate("player_wide");
			const part = (id: string) => {
				const found = layout.parts.find((entry) => entry.id === id);
				if (found === undefined) throw new Error(`Missing part: ${id}.`);
				return found;
			};
			check.deepEqual(part("head").origin, [-4, 24, -4], "head origin");
			check.deepEqual(part("head").pivot, [0, 24, 0], "head pivot");
			check.deepEqual(part("body").origin, [-4, 12, -2], "body origin");
			check.deepEqual(
				part("right_arm").origin,
				[-8, 12, -2],
				"right arm origin",
			);
			check.deepEqual(part("right_arm").pivot, [-5, 22, 0], "right arm pivot");
			check.deepEqual(part("left_arm").origin, [4, 12, -2], "left arm origin");
			check.deepEqual(part("left_leg").pivot, [2, 12, 0], "left leg pivot");
			check.equal(part("head").inflate, undefined, "base box has no dilation");
			check.equal(part("head_overlay").inflate, 0.5, "hat dilation");
			for (const id of [
				"body_overlay",
				"right_arm_overlay",
				"left_arm_overlay",
				"right_leg_overlay",
				"left_leg_overlay",
			]) {
				check.equal(part(id).inflate, 0.25, `${id} dilation`);
			}
			// The inspect report is the old contract: the new preview-only field
			// must not appear there, so existing JSON bytes stay identical.
			check.equal(
				"inflate" in partOf(layout, "head_overlay"),
				false,
				"inspect report unchanged",
			);
			const rendered = renderEntityPreview(layout, texture, {
				texturePath: "player.png",
				size: 128,
			});
			check.deepEqual(
				rendered.report.range.min,
				[-8.25, -0.25, -4.5],
				"preview min includes the sleeve and hat dilation",
			);
			check.deepEqual(
				rendered.report.range.max,
				[8.25, 32.5, 4.5],
				"preview max includes the hat dilation",
			);
		},
	},
	{
		name: "an inflate must be an exact 1/256 multiple and is carried into the resolved part",
		run(check) {
			const document = (inflate: unknown) => ({
				format: "mc-asset/entity-layout",
				version: 1,
				id: "inflate-probe",
				texture: { width: 16, height: 16 },
				parts: [
					{
						id: "box",
						size: [4, 4, 4],
						uv: [0, 0],
						origin: [0, 0, 0],
						inflate,
					},
				],
			});
			const resolved = resolveEntityLayoutDocument(document(0.5));
			check.equal(resolved.parts[0]?.inflate, 0.5, "inflate carried");
			for (const bad of [0.1, 300, "0.5"]) {
				const error = errorOf(() => resolveEntityLayoutDocument(document(bad)));
				check.equal(error.code, "ENTITY_LAYOUT_INVALID", `${String(bad)} code`);
				check.equal(
					(error.details as { reason?: string }).reason,
					"invalid-layout",
					`${String(bad)} reason`,
				);
			}
		},
	},
	{
		name: "the four isometric panels show the front, back, left, and right face cells in place",
		run(check) {
			const { layout, texture } = playerTemplate("player_wide");
			const rendered = renderEntityPreview(layout, texture, {
				texturePath: "player.png",
				size: 128,
			});
			check.equal(
				sha256(rendered.png),
				PLAYER_PREVIEW_SHA256,
				"fixed four-view hash",
			);
			check.equal(rendered.report.image.width, 512, "image width");
			check.equal(rendered.report.image.height, 140, "image height");
			check.deepEqual(
				rendered.report.panels.map((panel) => panel.name),
				["south-east", "north-east", "north-west", "south-west"],
				"panel order",
			);
			check.equal(
				rendered.report.coverage.status,
				"complete",
				"coverage complete",
			);
			// The camera directions and the layout's world orientation (front
			// +z, right -x) fix which two side cells each panel can see.
			check.deepEqual(
				panelFaceNames(rendered.png, 128),
				[
					["front", "left", "top"],
					["back", "left", "top"],
					["back", "right", "top"],
					["front", "right", "top"],
				],
				"face cells per panel",
			);
		},
	},
	{
		name: "a mirrored box shows the other side cell on each left and right face",
		run(check) {
			const texture = sideCellTexture();
			const plain = renderEntityPreview(mirrorProbeLayout(false), texture, {
				texturePath: "side.png",
				size: 64,
			});
			const mirrored = renderEntityPreview(mirrorProbeLayout(true), texture, {
				texturePath: "side.png",
				size: 64,
			});
			const west = [2, 3];
			const east = [0, 1];
			check.ok(
				colorCountInPanels(plain.png, 64, west, [255, 0, 0]) > 0,
				"plain right cell is red on the west side",
			);
			check.equal(
				colorCountInPanels(plain.png, 64, west, [0, 255, 0]),
				0,
				"plain west side has no green",
			);
			check.ok(
				colorCountInPanels(mirrored.png, 64, west, [0, 255, 0]) > 0,
				"mirrored right face samples the left cell",
			);
			check.equal(
				colorCountInPanels(mirrored.png, 64, west, [255, 0, 0]),
				0,
				"mirrored west side has no red",
			);
			check.ok(
				colorCountInPanels(mirrored.png, 64, east, [255, 0, 0]) > 0,
				"mirrored left face samples the right cell",
			);
			// Same side cells on both sides, so only the U flip can move the
			// colors: on the south-west panel the box's back edge is the left
			// band and its front edge the next band.
			const split = splitSideCellTexture();
			const plainSplit = renderEntityPreview(mirrorProbeLayout(false), split, {
				texturePath: "split.png",
				size: 64,
			});
			const mirroredSplit = renderEntityPreview(
				mirrorProbeLayout(true),
				split,
				{ texturePath: "split.png", size: 64 },
			);
			const backBand = [0, 16] as const;
			const frontBand = [16, 32] as const;
			check.ok(
				colorCountInBand(plainSplit.png, 64, 3, ...backBand, [255, 0, 0]) > 0,
				"plain back band is red",
			);
			check.equal(
				colorCountInBand(plainSplit.png, 64, 3, ...backBand, [0, 255, 0]),
				0,
				"plain back band has no green",
			);
			check.ok(
				colorCountInBand(mirroredSplit.png, 64, 3, ...backBand, [0, 255, 0]) >
					0,
				"mirrored back band is green",
			);
			check.equal(
				colorCountInBand(mirroredSplit.png, 64, 3, ...backBand, [255, 0, 0]),
				0,
				"mirrored back band has no red",
			);
			check.ok(
				colorCountInBand(plainSplit.png, 64, 3, ...frontBand, [0, 255, 0]) >
					colorCountInBand(plainSplit.png, 64, 3, ...frontBand, [255, 0, 0]),
				"plain front band is mostly green",
			);
			check.ok(
				colorCountInBand(mirroredSplit.png, 64, 3, ...frontBand, [255, 0, 0]) >
					colorCountInBand(mirroredSplit.png, 64, 3, ...frontBand, [0, 255, 0]),
				"mirrored front band is mostly red",
			);
		},
	},
	{
		name: "preview refuses a texture whose size differs from the layout before writing a file",
		async run(check) {
			const { layout } = playerTemplate("player_wide");
			const small = {
				width: 32,
				height: 32,
				pixels: emptyPixels(32, 32),
			};
			const error = errorOf(() =>
				renderEntityPreview(layout, small, {
					texturePath: "small.png",
					size: 128,
				}),
			);
			check.equal(error.code, "ENTITY_TEXTURE_SIZE_MISMATCH", "core code");
			check.deepEqual(
				error.details,
				{
					expected: { width: 64, height: 64 },
					actual: { width: 32, height: 32 },
				},
				"core details",
			);
			const dir = await mkdtemp(
				join(tmpdir(), "mc-asset-entity-preview-size-"),
			);
			try {
				const canvas = createCanvas(32, 32);
				const layer = addLayer(canvas, { id: "base" });
				replaceLayerPixels(canvas, layer.id, emptyPixels(32, 32));
				const texturePath = join(dir, "small.png");
				await writeFile(texturePath, encodePng(canvas));
				const output = join(dir, "preview.png");
				const streams = captureStreams();
				const exit = await runEntity(
					"preview",
					texturePath,
					{ layout: "player_wide", output, size: "128" },
					true,
					streams.streams,
				);
				check.equal(exit, 3, "size mismatch exit");
				const envelope = JSON.parse(
					new TextDecoder().decode(streams.stdout()),
				) as { error: { code: string } };
				check.equal(
					envelope.error.code,
					"ENTITY_TEXTURE_SIZE_MISMATCH",
					"CLI error code",
				);
				let wrote = true;
				try {
					await readFile(output);
				} catch {
					wrote = false;
				}
				check.equal(wrote, false, "no image written");
				const mcp = await handleEntityAsset({
					mode: "preview",
					layout: "player_wide",
					inputPath: texturePath,
				});
				check.equal(mcp.isError, true, "MCP refuses");
				check.equal(
					(JSON.parse(textOf(mcp)) as { code: string }).code,
					"ENTITY_TEXTURE_SIZE_MISMATCH",
					"MCP error code",
				);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "preview refuses parts with no origin, or a rotated part with no pivot",
		run(check) {
			const texture = sideCellTexture();
			const noOrigin = resolveEntityLayoutDocument({
				format: "mc-asset/entity-layout",
				version: 1,
				id: "no-origin",
				texture: { width: 16, height: 16 },
				parts: [{ id: "box", size: [4, 4, 4], uv: [0, 0] }],
			});
			const originError = errorOf(() =>
				renderEntityPreview(noOrigin, texture, {
					texturePath: "side.png",
					size: 64,
				}),
			);
			check.equal(originError.code, "ENTITY_LAYOUT_INVALID", "origin code");
			check.deepEqual(
				(originError.details as { reason: string; parts: string[] }).parts,
				["box"],
				"origin parts",
			);
			const noPivot = resolveEntityLayoutDocument({
				format: "mc-asset/entity-layout",
				version: 1,
				id: "no-pivot",
				texture: { width: 16, height: 16 },
				parts: [
					{
						id: "box",
						size: [4, 4, 4],
						uv: [0, 0],
						origin: [0, 0, 0],
						rotation: [0, 45, 0],
					},
				],
			});
			const pivotError = errorOf(() =>
				renderEntityPreview(noPivot, texture, {
					texturePath: "side.png",
					size: 64,
				}),
			);
			check.equal(pivotError.code, "ENTITY_LAYOUT_INVALID", "pivot code");
			check.equal(
				(pivotError.details as { reason: string }).reason,
				"missing-pivot",
				"pivot reason",
			);
		},
	},
	{
		name: "preview applies a part rotation around its pivot and inflation in the reported range",
		run(check) {
			const texture = sideCellTexture();
			const rotated = resolveEntityLayoutDocument({
				format: "mc-asset/entity-layout",
				version: 1,
				id: "rotated",
				texture: { width: 16, height: 16 },
				parts: [
					{
						id: "box",
						size: [2, 4, 2],
						uv: [0, 0],
						origin: [0, 0, 0],
						pivot: [0, 0, 0],
						rotation: [0, 0, 90],
					},
				],
			});
			const rotatedRender = renderEntityPreview(rotated, texture, {
				texturePath: "side.png",
				size: 64,
			});
			check.deepEqual(
				rotatedRender.report.range.min,
				[-4, 0, 0],
				"rotated min",
			);
			check.deepEqual(rotatedRender.report.range.max, [0, 2, 2], "rotated max");
			const inflated = resolveEntityLayoutDocument({
				format: "mc-asset/entity-layout",
				version: 1,
				id: "inflated",
				texture: { width: 16, height: 16 },
				parts: [
					{
						id: "box",
						size: [2, 4, 2],
						uv: [0, 0],
						origin: [0, 0, 0],
						inflate: 0.5,
					},
				],
			});
			const inflatedRender = renderEntityPreview(inflated, texture, {
				texturePath: "side.png",
				size: 64,
			});
			check.deepEqual(
				inflatedRender.report.range.min,
				[-0.5, -0.5, -0.5],
				"inflated min",
			);
			check.deepEqual(
				inflatedRender.report.range.max,
				[2.5, 4.5, 2.5],
				"inflated max",
			);
		},
	},
	{
		name: "CLI and MCP preview share the same four-view PNG and report",
		async run(check) {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-entity-preview-"));
			try {
				const { texture } = playerTemplate("player_wide");
				const canvas = createCanvas(64, 64);
				const layer = addLayer(canvas, { id: "base" });
				replaceLayerPixels(canvas, layer.id, texture.pixels);
				const skinPath = join(dir, "skin.png");
				await writeFile(skinPath, encodePng(canvas));
				const output = join(dir, "preview.png");
				const cli = captureStreams();
				const exit = await runEntity(
					"preview",
					skinPath,
					{ layout: "player_wide", output, size: "128" },
					true,
					cli.streams,
				);
				check.equal(exit, 0, "CLI exit");
				const cliPng = new Uint8Array(await readFile(output));
				check.equal(sha256(cliPng), PLAYER_PREVIEW_SHA256, "CLI hash");
				const envelope = JSON.parse(new TextDecoder().decode(cli.stdout())) as {
					success: boolean;
					result: Record<string, unknown>;
				};
				check.equal(envelope.success, true, "CLI envelope");
				check.equal(envelope.result.mode, "preview", "CLI mode");
				check.equal(envelope.result.output, output, "CLI output path");
				check.equal(
					(envelope.result.layout as { id: string }).id,
					"player_wide",
					"CLI layout",
				);

				const mcp = await handleEntityAsset({
					mode: "preview",
					layout: "player_wide",
					inputPath: skinPath,
					size: 128,
				});
				check.equal(mcp.isError, undefined, "MCP has no error");
				const mcpReport = JSON.parse(textOf(mcp)) as Record<string, unknown>;
				const image = mcp.content.find((entry) => entry.type === "image") as
					| { data: string }
					| undefined;
				check.ok(image !== undefined, "MCP embeds the PNG");
				check.equal(
					sha256(new Uint8Array(Buffer.from(image?.data ?? "", "base64"))),
					PLAYER_PREVIEW_SHA256,
					"MCP hash",
				);
				const withoutOutput = (value: Record<string, unknown>) => {
					const copy = { ...value };
					delete copy.output;
					return copy;
				};
				check.deepEqual(
					withoutOutput(envelope.result),
					withoutOutput(mcpReport),
					"CLI and MCP reports agree",
				);

				const stdoutRun = captureStreams();
				const stdoutExit = await runEntity(
					"preview",
					skinPath,
					{ layout: "player_wide", stdout: true, size: "128" },
					false,
					stdoutRun.streams,
				);
				check.equal(stdoutExit, 0, "stdout exit");
				check.equal(
					sha256(stdoutRun.stdout()),
					PLAYER_PREVIEW_SHA256,
					"stdout bytes",
				);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "preview needs an output, refuses unused fields, and rejects an unsupported size",
		async run(check) {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-entity-preview-out-"));
			try {
				const { texture } = playerTemplate("player_wide");
				const canvas = createCanvas(64, 64);
				const layer = addLayer(canvas, { id: "base" });
				replaceLayerPixels(canvas, layer.id, texture.pixels);
				const skinPath = join(dir, "skin.png");
				await writeFile(skinPath, encodePng(canvas));
				const missing = captureStreams();
				const missingExit = await runEntity(
					"preview",
					skinPath,
					{ layout: "player_wide" },
					false,
					missing.streams,
				);
				check.equal(missingExit, 2, "missing output exit");
				check.ok(
					new TextDecoder()
						.decode(missing.stdout())
						.includes("OUTPUT_REQUIRED"),
					"OUTPUT_REQUIRED named",
				);
				const refused = captureStreams();
				const refusedExit = await runEntity(
					"preview",
					skinPath,
					{
						layout: "player_wide",
						output: join(dir, "preview.png"),
						fill: true,
					},
					true,
					refused.streams,
				);
				check.equal(refusedExit, 2, "refused field exit");
				check.equal(
					(
						JSON.parse(new TextDecoder().decode(refused.stdout())) as {
							error: { code: string };
						}
					).error.code,
					"INVALID_ARGUMENT",
					"refused field code",
				);
				const badSize = await handleEntityAsset({
					mode: "preview",
					layout: "player_wide",
					inputPath: skinPath,
					size: 100,
				});
				check.equal(badSize.isError, true, "bad size is refused");
				check.equal(
					(JSON.parse(textOf(badSize)) as { code: string }).code,
					"INVALID_ARGUMENT",
					"bad size code",
				);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
];
