/**
 * `particle <frames>`: generate one particle definition plus its frame
 * sprites. The input is a directory of PNG/.mcpx frames or a single frame
 * file; frames are ordered by UTF-8 file-name bytes, never by readdir order.
 *
 * Every output is planned before the first byte is written. An occupied
 * target refuses the whole batch with OUTPUT_EXISTS (unless --force), so a
 * refusal never leaves a half-written definition or sprite set behind.
 */

import { join as joinPath } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { planParticleAsset } from "../particle/index.ts";
import { loadParticleFrames, type ParticleWarning } from "../particle/load.ts";
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

export interface ParticleCliOptions {
	id?: string | undefined;
	namespace?: string | undefined;
	outputDir?: string | undefined;
	texturePrefix?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
}

/** One typed particle request shared by the CLI and the MCP tool. */
export interface ParticleGenerateRequest {
	readonly inputPath: string;
	readonly outputDir: string;
	readonly namespace: string;
	readonly id: string;
	readonly texturePrefix?: string | undefined;
	readonly force: boolean;
	readonly mkdir: boolean;
}

export interface ParticleAssetReport {
	readonly command: "particle";
	readonly id: string;
	readonly namespace: string;
	readonly outputDir: string;
	readonly input: string;
	readonly inputKind: "directory" | "file";
	readonly frameCount: number;
	readonly frames: ReadonlyArray<{
		readonly input: string;
		readonly texture: string;
		readonly width: number;
		readonly height: number;
	}>;
	readonly definition: string;
	readonly textureFiles: readonly string[];
	/** Textures in frame order, then the definition last. */
	readonly files: readonly string[];
	readonly warnings: ReadonlyArray<ParticleWarning>;
}

function diskPath(outputDir: string, relativePath: string): string {
	return joinPath(outputDir, ...relativePath.split("/"));
}

/**
 * Load, plan, preflight, and write one particle asset. All payloads exist in
 * memory before the first write; planOutputTargets refuses the whole batch
 * when any target already exists without force.
 */
export async function generateParticleAsset(
	request: ParticleGenerateRequest,
): Promise<ParticleAssetReport> {
	if (request.outputDir === "") {
		throw new McAssetError("INVALID_ARGUMENT", "particle needs an outputDir.");
	}
	const loaded = await loadParticleFrames(request.inputPath);
	const plan = planParticleAsset({
		namespace: request.namespace,
		id: request.id,
		texturePrefix: request.texturePrefix,
		frames: loaded.frames,
	});
	const targets: OutputTarget[] = [];
	const payloads = new Map<string, Uint8Array | string>();
	for (const texture of plan.textures) {
		const path = diskPath(request.outputDir, texture.relativePath);
		targets.push({
			path,
			extension: ".png",
			allowOverwrite: request.force,
		});
		payloads.set(path, texture.data);
	}
	const definitionPath = diskPath(
		request.outputDir,
		plan.definition.relativePath,
	);
	targets.push({
		path: definitionPath,
		extension: ".json",
		allowOverwrite: request.force,
	});
	payloads.set(definitionPath, plan.definition.text);
	const planned = await planOutputTargets(targets, {
		inputs: [request.inputPath, ...loaded.inputFiles],
		mkdir: request.mkdir,
		allowedRoot: request.outputDir,
	});
	await writePlannedTargets(planned, payloads, { mkdir: request.mkdir });
	const textureFiles = plan.textures.map((texture) => texture.relativePath);
	return {
		command: "particle",
		id: plan.id,
		namespace: plan.namespace,
		outputDir: request.outputDir,
		input: loaded.inputPath,
		inputKind: loaded.inputKind,
		frameCount: plan.textures.length,
		frames: plan.textures.map((texture) => ({
			input: texture.frame,
			texture: texture.texture,
			width: texture.width,
			height: texture.height,
		})),
		definition: plan.definition.relativePath,
		textureFiles,
		files: [...textureFiles, plan.definition.relativePath],
		warnings: loaded.warnings,
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
			`particle needs --${flag} ${what}.`,
		);
	}
	return value;
}

export async function runParticle(
	input: string | undefined,
	options: ParticleCliOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		if (input === undefined || input === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"particle needs a frames directory or a single PNG/.mcpx frame.",
			);
		}
		const id = requiredOption(options.id, "id", "the particle definition id");
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
		const report = await generateParticleAsset({
			inputPath: input,
			outputDir,
			namespace,
			id,
			texturePrefix: options.texturePrefix,
			force: options.force === true,
			mkdir: options.mkdir === true,
		});
		if (globalJson) {
			emitEnvelope(successEnvelope(report), streams, route);
		} else {
			emitLog(
				`ok particle id=${report.id} namespace=${report.namespace} frames=${report.frameCount} outputDir=${report.outputDir}`,
				streams,
				route,
			);
			emitLog(
				`order: ${report.frames
					.map((frame) => `${frame.input} -> ${frame.texture}`)
					.join(", ")}`,
				streams,
				route,
			);
			emitLog(`definition: ${report.definition}`, streams, route);
			for (const warning of report.warnings) {
				emitLog(`warning [${warning.code}] ${warning.message}`, streams, route);
			}
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
