import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputStreams } from "../../src/cli/channels.ts";
import { runEntity } from "../../src/cli/cmd-entity.ts";
import { parseProfile } from "../../src/cli/profiles.ts";
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
import {
	buildEntityTemplate,
	ENTITY_FACE_COLORS,
} from "../../src/entity/template.ts";
import type { EntityLayout } from "../../src/entity/types.ts";
import { validateEntityTexture } from "../../src/entity/validate.ts";
import { encodePng, flattenCanvas } from "../../src/io/png.ts";
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
	top: { rect: [36, 48, 4, 4], uv: [36, 52, 40, 48] },
	bottom: { rect: [40, 48, 4, 4], uv: [40, 48, 44, 52] },
	right: { rect: [40, 52, 4, 12], uv: [44, 52, 40, 64] },
	front: { rect: [36, 52, 4, 12], uv: [40, 52, 36, 64] },
	left: { rect: [32, 52, 4, 12], uv: [36, 52, 32, 64] },
	back: { rect: [44, 52, 4, 12], uv: [48, 52, 44, 64] },
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
	top: { rect: [20, 48, 4, 4], uv: [20, 52, 24, 48] },
	bottom: { rect: [24, 48, 4, 4], uv: [24, 48, 28, 52] },
	right: { rect: [24, 52, 4, 12], uv: [28, 52, 24, 64] },
	front: { rect: [20, 52, 4, 12], uv: [24, 52, 20, 64] },
	left: { rect: [16, 52, 4, 12], uv: [20, 52, 16, 64] },
	back: { rect: [28, 52, 4, 12], uv: [32, 52, 28, 64] },
};

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
						? "6fd551434f061a8cac2e80226fa7d78eb8a72e0f1735604af16f26459775f46d"
						: "03899d354ad1c36525a3e75e2f50e44692f5c33d464c15c7583822293b139fae",
					`${layoutId} PNG`,
				);
				check.equal(
					sha256(serializeMcpx(template.canvas)),
					layoutId === "player_wide"
						? "f5d1e66e6fbc1880fb32e21b4368a96eaac7abc9cd2e760d0598ce709085e23d"
						: "d10e09f37942405527e07b9f670bda9ba90bc361b1827ae44f35b22afd5e1f43",
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
];
