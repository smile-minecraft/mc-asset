/**
 * `equipment <id>`: generate one equipment definition plus an armor or elytra
 * texture template per layer entry.
 *
 * Every output is planned and built in memory before the first byte is
 * written. An occupied target refuses the whole batch with OUTPUT_EXISTS
 * (unless --force), so a refusal never leaves a half-written definition or
 * template set behind.
 */

import { Buffer } from "node:buffer";
import { join as joinPath } from "node:path";
import { McAssetError } from "../core/errors.ts";
import type { EntityTemplateRegion } from "../entity/template.ts";
import {
	type EquipmentDefinitionDirectory,
	type EquipmentLayerRequest,
	type EquipmentLayers,
	planEquipmentAsset,
} from "../equipment/index.ts";
import { emitCommandFailure } from "./artifacts.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import {
	type OutputTarget,
	planOutputTargets,
	writePlannedTargets,
} from "./safe-output.ts";
import {
	resolveVersionTarget,
	type VersionReportShape,
	versionReportShape,
} from "./version-options.ts";

export interface EquipmentCliOptions {
	namespace?: string | undefined;
	outputDir?: string | undefined;
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
	/** Repeatable `type` or `type=texture` layer entries. */
	layer?: readonly string[] | undefined;
	/** Repeatable `type` or `type=#RRGGBB` dyeable marks. */
	dyeable?: readonly string[] | undefined;
	/** Repeatable layer types that set `use_player_texture`. */
	playerTexture?: readonly string[] | undefined;
	template?: boolean | undefined;
	fill?: boolean | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
}

export interface EquipmentRequest {
	readonly namespace: string;
	readonly id: string;
	readonly packFormat: string;
	readonly layers: readonly EquipmentLayerRequest[];
	readonly template: boolean;
	readonly fill: boolean;
	/** Resource pack root receiving `assets/`; omitted embeds every artifact. */
	readonly outputDir?: string | undefined;
	readonly force: boolean;
	readonly mkdir: boolean;
	/** CLI true: a pack root is required. MCP false: artifacts embed. */
	readonly requireOutput: boolean;
	readonly version: VersionReportShape;
}

/** One template in the run report. */
export interface EquipmentTextureReport {
	readonly layerType: string;
	/** Resource location the definition writes, e.g. `demo:gear`. */
	readonly texture: string;
	/** Pack-relative PNG path. */
	readonly path: string;
	readonly layout: string;
	readonly width: number;
	readonly height: number;
	readonly regions: readonly EntityTemplateRegion[];
	/** Written path; absent when the image was embedded instead. */
	readonly output?: string | undefined;
	/** The artifact itself when no pack root was given. */
	readonly pngBase64?: string | undefined;
	/** The editable `.mcpx` source when no pack root was given. */
	readonly sourceText?: string | undefined;
}

/** The run report shared by the CLI envelope and the MCP result. */
export interface EquipmentReport {
	readonly command: "equipment";
	readonly id: string;
	readonly namespace: string;
	readonly packFormat: string;
	readonly definitionDirectory: EquipmentDefinitionDirectory;
	/** Pack-relative definition path. */
	readonly definition: string;
	/** The document's `layers` object, byte-ordered by layer type. */
	readonly layers: EquipmentLayers;
	readonly textures: readonly EquipmentTextureReport[];
	/** Pack-relative paths, definition first, then templates. */
	readonly files: readonly string[];
	/** The pack root the files were written under. */
	readonly outputDir?: string | undefined;
	/** The definition text when no pack root was given. */
	readonly definitionText?: string | undefined;
	readonly version: VersionReportShape;
}

export interface EquipmentOutcome {
	readonly result: EquipmentReport;
	/** Embedded template PNGs, in report order, for MCP image blocks. */
	readonly pngs: readonly Uint8Array[];
}

function defined(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
}

/**
 * `#RRGGBB` onto the signed ARGB integer the document stores: the client
 * treats `color_when_undyed` as an opaque color, so alpha is always 0xFF.
 */
export function undyedColorFromHex(value: string): number {
	const match = /^#([0-9a-fA-F]{6})$/.exec(value);
	if (match === null) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`dyeable color must be #RRGGBB; got "${value}".`,
			{ field: "dyeable", value },
		);
	}
	// Bitwise OR keeps the result in int32, which is exactly the stored form.
	return (0xff << 24) | Number.parseInt(match[1] as string, 16);
}

/** Split `type` and `type=value`; the value may never contain `=`. */
function splitLayerSpec(
	spec: string,
	flag: string,
): [string, string | undefined] {
	const cut = spec.indexOf("=");
	const type = cut < 0 ? spec : spec.slice(0, cut);
	const value = cut < 0 ? undefined : spec.slice(cut + 1);
	if (type === "" || value === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${flag} takes "type" or "type=value"; got "${spec}".`,
			{ field: flag.replace(/^--/, ""), value: spec },
		);
	}
	return [type, value];
}

/** Bad JSON is EQUIPMENT_INVALID only through the planner; this only shapes CLI flags. */
export function equipmentLayersFromFlags(
	options: EquipmentCliOptions,
): readonly EquipmentLayerRequest[] {
	const specs = options.layer ?? [];
	if (specs.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"equipment needs at least one --layer (for example --layer humanoid).",
		);
	}
	const dyeable = new Map<string, number | undefined>();
	for (const spec of options.dyeable ?? []) {
		const [type, color] = splitLayerSpec(spec, "--dyeable");
		if (dyeable.has(type)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`--dyeable for layer type "${type}" is given twice.`,
				{ field: "dyeable", layerType: type },
			);
		}
		dyeable.set(
			type,
			color === undefined ? undefined : undyedColorFromHex(color),
		);
	}
	const playerTexture = new Set(options.playerTexture ?? []);
	const types = new Set<string>();
	const layers: EquipmentLayerRequest[] = [];
	for (const spec of specs) {
		const [type, texture] = splitLayerSpec(spec, "--layer");
		types.add(type);
		layers.push({
			type,
			...(texture === undefined ? {} : { texture }),
			...(dyeable.has(type)
				? {
						dyeable: {
							...(dyeable.get(type) === undefined
								? {}
								: { colorWhenUndyed: dyeable.get(type) }),
						},
					}
				: {}),
			...(playerTexture.has(type) ? { usePlayerTexture: true } : {}),
		});
	}
	for (const type of [...dyeable.keys(), ...playerTexture]) {
		if (!types.has(type)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`--dyeable / --player-texture names layer type "${type}", which no --layer uses.`,
				{ field: "layer", layerType: type, layers: [...types] },
			);
		}
	}
	return layers;
}

function diskPath(outputDir: string, relativePath: string): string {
	return joinPath(outputDir, ...relativePath.split("/"));
}

/**
 * Plan, preflight, and write one equipment asset. All payloads exist in
 * memory before the first write; `planOutputTargets` refuses the whole batch
 * when any target already exists without force or lands outside the pack
 * root.
 */
export async function runEquipmentRequest(
	request: EquipmentRequest,
): Promise<EquipmentOutcome> {
	const outputDir = defined(request.outputDir);
	if (request.requireOutput && outputDir === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"equipment needs --output-dir (the resource pack root).",
		);
	}
	const plan = planEquipmentAsset({
		namespace: request.namespace,
		id: request.id,
		packFormat: request.packFormat,
		layers: request.layers,
		template: request.template,
		fill: request.fill,
	});
	const embed = outputDir === undefined;
	if (outputDir !== undefined) {
		const targets: OutputTarget[] = [
			{
				path: diskPath(outputDir, plan.definition.relativePath),
				extension: ".json",
				allowOverwrite: request.force,
			},
		];
		const payloads = new Map<string, Uint8Array | string>();
		payloads.set(targets[0]?.path as string, plan.definition.text);
		for (const texture of plan.textures) {
			const path = diskPath(outputDir, texture.relativePath);
			targets.push({
				path,
				extension: ".png",
				allowOverwrite: request.force,
			});
			payloads.set(path, texture.png);
		}
		const planned = await planOutputTargets(targets, {
			inputs: [],
			mkdir: request.mkdir,
			allowedRoot: outputDir,
		});
		await writePlannedTargets(planned, payloads, { mkdir: request.mkdir });
	}
	const textures: EquipmentTextureReport[] = plan.textures.map((texture) => ({
		layerType: texture.layerType,
		texture: texture.texture,
		path: texture.relativePath,
		layout: texture.layoutId,
		width: texture.width,
		height: texture.height,
		regions: texture.regions,
		...(outputDir === undefined
			? {}
			: { output: diskPath(outputDir, texture.relativePath) }),
		...(embed
			? {
					pngBase64: Buffer.from(texture.png).toString("base64"),
					sourceText: texture.mcpxText,
				}
			: {}),
	}));
	return {
		result: {
			command: "equipment",
			id: plan.id,
			namespace: plan.namespace,
			packFormat: plan.packFormat,
			definitionDirectory: plan.definition.directory,
			definition: plan.definition.relativePath,
			layers: plan.definition.json.layers,
			textures,
			files: [
				plan.definition.relativePath,
				...plan.textures.map((texture) => texture.relativePath),
			],
			...(outputDir === undefined ? {} : { outputDir }),
			...(embed ? { definitionText: plan.definition.text } : {}),
			version: request.version,
		},
		pngs: embed ? plan.textures.map((texture) => texture.png) : [],
	};
}

function requiredOption(
	value: string | undefined,
	flag: string,
	what: string,
): string {
	if (value === undefined || value === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`equipment needs --${flag} ${what}.`,
		);
	}
	return value;
}

export async function runEquipment(
	id: string | undefined,
	options: EquipmentCliOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		if (id === undefined || id === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"equipment needs a definition id.",
			);
		}
		const namespace = requiredOption(
			options.namespace,
			"namespace",
			"the asset namespace",
		);
		const outputDir = requiredOption(
			options.outputDir,
			"output-dir",
			"the resource pack root",
		);
		const target = resolveVersionTarget({
			minecraftVersion: options.minecraftVersion,
			resourcePackVersion: options.resourcePackVersion,
		});
		if (target.packFormat === undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"equipment needs --minecraft-version or --resource-pack-version, because the definition path depends on the target format.",
			);
		}
		const report = await runEquipmentRequest({
			namespace,
			id,
			packFormat: target.packFormat,
			layers: equipmentLayersFromFlags(options),
			template: options.template !== false,
			fill: options.fill !== false,
			outputDir,
			force: options.force === true,
			mkdir: options.mkdir === true,
			requireOutput: true,
			version: versionReportShape(target),
		});
		if (globalJson) {
			emitEnvelope(successEnvelope(report.result), streams, route);
		} else {
			for (const line of reportLines(report.result)) {
				emitLog(line, streams, route);
			}
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}

function reportLines(report: EquipmentReport): string[] {
	const lines = [
		`ok equipment id=${report.id} namespace=${report.namespace} packFormat=${report.packFormat} definition=${report.definition} textures=${report.textures.length}`,
	];
	for (const texture of report.textures) {
		const where =
			texture.output === undefined ? "" : ` output=${texture.output}`;
		lines.push(
			`layer ${texture.layerType} ${texture.texture} ${texture.width}x${texture.height} layout=${texture.layout} regions=${texture.regions.length}${where}`,
		);
	}
	return lines;
}
