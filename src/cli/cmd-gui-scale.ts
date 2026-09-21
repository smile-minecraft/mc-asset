import { basename } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { parseGuiSize, scaleGuiCanvas } from "../core/gui-scaling.ts";
import {
	extractGuiScaling,
	type GuiScaling,
	nineSliceGeometryError,
	parseMcmetaText,
} from "../core/mcmeta.ts";
import { encodePng } from "../io/png.ts";
import { GUI_STRETCH_INNER_FACT, isFactActive } from "../profiles/versions.ts";
import {
	assertMinecraftOutputPath,
	emitCommandFailure,
	preflightArtifactTargets,
	readInputText,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import { loadEditableCanvas } from "./canvas-input.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import { parseProfile } from "./profiles.ts";
import {
	formatVersionTarget,
	resolveVersionTarget,
	versionReportShape,
} from "./version-options.ts";

export interface GuiScaleOptions {
	size?: string | undefined;
	mcmeta?: string | undefined;
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
}

/**
 * Scale a GUI sprite to an explicit target size. The `.mcmeta` path is
 * used verbatim and never derived; a missing --mcmeta means stretch.
 * A nine_slice border that is illegal against the declared design
 * dimensions is INVALID_MCMETA (exit 2). When the version target predates
 * stretch_inner, a declared true is ignored and reported as
 * STRETCH_INNER_IGNORED; an undetermined or newer target applies it as
 * declared.
 * Output is PNG only: --output or --stdout, never a .mcpx source.
 */
export async function runGuiScale(
	input: string | undefined,
	options: GuiScaleOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const size = parseGuiSize(options.size);
		const target = resolveVersionTarget({
			minecraftVersion: options.minecraftVersion,
			resourcePackVersion: options.resourcePackVersion,
		});
		// PNG-only entry: no --source or --in-place is declared, so only
		// the PNG channel can carry the result.
		const targets = resolveArtifactTargets({
			command: "import",
			output: options.output,
			stdout: options.stdout,
			source: undefined,
			force: options.force,
			inPlace: undefined,
			inputPath: undefined,
		});
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		const inputPath = resolveInputPath(input, options.input, "gui-scale");
		const loaded = await loadEditableCanvas(inputPath);
		const warnings: WarningNote[] = [...loaded.warnings];
		const canvas = loaded.canvas;
		let scaling: GuiScaling = { kind: "stretch" };
		let mcmetaName: string | undefined;
		if (options.mcmeta !== undefined && options.mcmeta !== "") {
			mcmetaName = basename(options.mcmeta);
			scaling = extractGuiScaling(
				parseMcmetaText(
					await readInputText(options.mcmeta, "mcmeta"),
					options.mcmeta,
				),
			);
		}
		if (scaling.kind === "nine_slice") {
			const overflow = nineSliceGeometryError(
				scaling.width,
				scaling.height,
				scaling.border,
			);
			if (overflow !== undefined) {
				throw new McAssetError("INVALID_MCMETA", overflow, {
					mcmeta: options.mcmeta,
					width: scaling.width,
					height: scaling.height,
					border: scaling.border,
				});
			}
			if (
				scaling.stretchInner &&
				target.packFormat !== undefined &&
				!isFactActive(GUI_STRETCH_INNER_FACT, target.packFormat)
			) {
				scaling = { ...scaling, stretchInner: false };
				warnings.push({
					code: "STRETCH_INNER_IGNORED",
					message: `stretch_inner needs resource-pack format 42.0 or newer; target ${target.packFormat} predates it, so the inner bands tile.`,
				});
			}
		}
		const out = scaleGuiCanvas(canvas, scaling, size.width, size.height);
		const pngBytes = encodePng(out);
		// File-target preflight runs before any stdout artifact byte, so a
		// refusal keeps stdout empty (same TOCTOU note as the tile path).
		await preflightArtifactTargets(targets, {
			inputPath,
			inPlace: undefined,
			mkdir: options.mkdir,
		});
		if (targets.pngStdout) {
			emitArtifact(pngBytes, streams, route);
		}
		await writeArtifactPayloads(
			targets.pngFiles.length > 0
				? [{ targets: targets.pngFiles, data: pngBytes }]
				: [],
			options.mkdir,
		);
		const result: Record<string, unknown> = {
			command: "gui-scale",
			profile,
			width: size.width,
			height: size.height,
			size: `${size.width}x${size.height}`,
			scaling: { type: scaling.kind },
			...(scaling.kind === "nine_slice"
				? { stretchInner: scaling.stretchInner }
				: {}),
			version: versionReportShape(target),
			target: formatVersionTarget(target),
			warnings,
			...(targets.pngFiles[0] !== undefined
				? { output: targets.pngFiles[0].path }
				: {}),
			...(targets.pngStdout ? { stdout: true as const } : {}),
		};
		if (mcmetaName !== undefined) {
			result.mcmeta = mcmetaName;
		}
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			const parts = [
				`ok gui-scale profile=${profile} size=${size.width}x${size.height} scaling=${scaling.kind}`,
			];
			if (typeof result.output === "string") {
				parts.push(`output=${result.output}`);
			}
			if (result.stdout === true) {
				parts.push("stdout=true");
			}
			emitLog(parts.join(" "), streams, route);
			for (const warning of warnings) {
				emitLog(`warning [${warning.code}] ${warning.message}`, streams, route);
			}
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
