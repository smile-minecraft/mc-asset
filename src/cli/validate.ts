import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McAssetError } from "../core/errors.ts";
import {
	checkAnimationFrameIndices,
	deriveAnimationGeometry,
	extractAnimationSection,
	extractGuiScaling,
	extractTextureSection,
	mipmapCutoutMeanWarning,
	nineSliceGeometryError,
	parseMcmetaText,
} from "../core/mcmeta.ts";
import { decodePng } from "../io/png.ts";
import {
	type ValidateFinding,
	type ValidateReport,
	validateCanvas,
} from "../validate/checks.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { errorEnvelope, successEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import { parseProfile } from "./profiles.ts";
import {
	formatVersionTarget,
	resolveVersionTarget,
	versionReportShape,
} from "./version-options.ts";

export interface ValidateCommandOptions {
	profile?: string | undefined;
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
	mcmeta?: string | undefined;
}

export interface ValidateMcmetaSection {
	path: string;
	texture: {
		present: boolean;
		mipmapStrategy?: string | undefined;
		alphaCutoffBias?: number | undefined;
	};
	animation: {
		present: boolean;
		frametime?: number | undefined;
		interpolate?: boolean | undefined;
		width?: number | undefined;
		height?: number | undefined;
		frameCount?: number | undefined;
		frameWidth?: number | undefined;
		frameHeight?: number | undefined;
		layout?: string | undefined;
		frameIndices?: number[] | undefined;
	};
	mipmap: {
		predictedClassification: string;
		strategy?: string | undefined;
		bias?: number | undefined;
	};
}

export interface ValidateResult extends ValidateReport {
	version: {
		minecraftVersion?: string | undefined;
		resourcePackVersion?: string | undefined;
	};
	target: string;
	mcmeta?: ValidateMcmetaSection | undefined;
	/**
	 * Single-file coverage is always complete: one raster plus its
	 * explicit mcmeta carry no external references, atlas sources, or
	 * version-gated checks, so there is nothing to skip. The field
	 * exists so validate-family reports share one machine-readable
	 * shape with validate-pack.
	 */
	coverage: { status: "complete"; skipped: [] };
}

/** Minimal human verdict: the JSON envelope is the primary output. */
export function formatHumanReport(
	report: ValidateReport,
	mcmeta?: ValidateMcmetaSection | undefined,
): string {
	const lines = [
		`verdict: ${report.verdict}`,
		`coverage: complete`,
		`dimensions: ${report.dimensions.width}x${report.dimensions.height}`,
		`colors: ${report.colorCount}`,
		`alpha: predicted ${report.alpha.predictedClassification} (opaque=${report.alpha.opaquePixels} transparent=${report.alpha.transparentPixels} partial=${report.alpha.partialAlphaPixels})`,
		`profile: ${report.profile.predictedDescription}`,
	];
	if (mcmeta !== undefined) {
		lines.push(
			`mcmeta: ${mcmeta.path} texture(strategy=${mcmeta.texture.mipmapStrategy ?? "none"} bias=${mcmeta.texture.alphaCutoffBias ?? "none"} predicted=${mcmeta.mipmap.predictedClassification})` +
				(mcmeta.animation.present
					? ` animation(frames=${mcmeta.animation.frameCount ?? 0} size=${mcmeta.animation.frameWidth ?? 0}x${mcmeta.animation.frameHeight ?? 0} layout=${mcmeta.animation.layout ?? "none"})`
					: " animation(none)"),
		);
		lines.push(
			`mipmap: strategy=${mcmeta.mipmap.strategy ?? "none"} bias=${mcmeta.mipmap.bias ?? "none"} predicted=${mcmeta.mipmap.predictedClassification}`,
		);
	}
	for (const finding of report.findings) {
		lines.push(`${finding.level} [${finding.code}] ${finding.message}`);
	}
	return lines.join("\n");
}

function summarize(report: ValidateReport): string {
	let errors = 0;
	let warnings = 0;
	for (const finding of report.findings) {
		if (finding.level === "error") {
			errors += 1;
		} else {
			warnings += 1;
		}
	}
	return `validation failed: ${errors} error(s), ${warnings} warning(s).`;
}

/**
 * Explicit `--mcmeta` wiring: read-only from start to finish. The mcmeta
 * path is used verbatim — a sibling file is never derived — and neither
 * the PNG nor the mcmeta bytes are written. Structural problems throw
 * INVALID_MCMETA / INVALID_ANIMATION_FRAME (exit 2); a declared frame
 * count that disagrees with the sheet becomes an error finding so the
 * verdict fails (exit 3). Mipmap notes are warning-only and never block.
 */
async function applyMcmetaOption(
	mcmetaPath: string,
	report: ValidateReport,
): Promise<{ mcmeta: ValidateMcmetaSection; findings: ValidateFinding[] }> {
	let text: string;
	try {
		text = new TextDecoder("utf-8").decode(await readFile(mcmetaPath));
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read mcmeta: ${mcmetaPath}.`,
			{ path: mcmetaPath },
		);
	}
	const document = parseMcmetaText(text, mcmetaPath);
	const texture = extractTextureSection(document);
	const animation = extractAnimationSection(document);
	const section: ValidateMcmetaSection = {
		path: basename(mcmetaPath),
		texture: {
			present: texture.present,
			...(texture.mipmapStrategy !== undefined
				? { mipmapStrategy: texture.mipmapStrategy }
				: {}),
			...(texture.alphaCutoffBias !== undefined
				? { alphaCutoffBias: texture.alphaCutoffBias }
				: {}),
		},
		animation: { present: animation.present },
		mipmap: {
			predictedClassification: report.alpha.predictedClassification,
			...(texture.mipmapStrategy !== undefined
				? { strategy: texture.mipmapStrategy }
				: {}),
			...(texture.alphaCutoffBias !== undefined
				? { bias: texture.alphaCutoffBias }
				: {}),
		},
	};
	const findings: ValidateFinding[] = [];
	const mipmapWarning = mipmapCutoutMeanWarning(
		report.alpha.predictedClassification,
		texture,
	);
	if (mipmapWarning !== undefined) {
		findings.push({ ...mipmapWarning });
	}
	if (animation.present) {
		const geometry = deriveAnimationGeometry(
			report.dimensions.width,
			report.dimensions.height,
			animation,
		);
		checkAnimationFrameIndices(animation, geometry.frameCount);
		section.animation = {
			present: true,
			...(animation.frametime !== undefined
				? { frametime: animation.frametime }
				: {}),
			...(animation.interpolate !== undefined
				? { interpolate: animation.interpolate }
				: {}),
			...(animation.width !== undefined ? { width: animation.width } : {}),
			...(animation.height !== undefined ? { height: animation.height } : {}),
			frameCount: geometry.frameCount,
			frameWidth: geometry.frameWidth,
			frameHeight: geometry.frameHeight,
			layout: geometry.layout,
			frameIndices: animation.frames.map((frame) => frame.index),
		};
		// Playback-sequence length is independent of the physical frame count:
		// repeated or partial indices are legal; only out-of-range indices
		// fail via checkAnimationFrameIndices above.
	}
	const scaling = extractGuiScaling(document);
	if (scaling.kind === "nine_slice") {
		// The border is judged against the declared design dimensions, and
		// structural scaling problems throw INVALID_MCMETA above (exit 2).
		const geometry = nineSliceGeometryError(
			scaling.width,
			scaling.height,
			scaling.border,
		);
		if (geometry !== undefined) {
			findings.push({
				code: "PACK_GUI_SCALING_BORDER",
				level: "error",
				message: geometry,
			});
		}
	}
	return { mcmeta: section, findings };
}

/**
 * Read-only verdict command: reads the input file, runs the pure engine,
 * prints the report. Exit 3 (VALIDATION_FAILED) means the tool worked but
 * the asset failed; every tool failure keeps its own exit code. The input
 * file is only read, never written.
 */
export async function runValidate(
	asset: string | undefined,
	options: ValidateCommandOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	let failed: ValidateResult | undefined;
	try {
		if (asset === undefined || asset === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"validate needs an asset path argument.",
			);
		}
		const profile = parseProfile(options.profile);
		const target = resolveVersionTarget({
			minecraftVersion: options.minecraftVersion,
			resourcePackVersion: options.resourcePackVersion,
		});
		let input: Uint8Array;
		try {
			input = new Uint8Array(await readFile(asset));
		} catch {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot read input: ${asset}.`,
			);
		}
		const decoded = decodePng(input);
		const version = versionReportShape(target);
		const targetSummary = formatVersionTarget(target);
		const base: ValidateReport = validateCanvas(decoded.canvas, {
			profile,
			packFormat: target.packFormat,
			sourceWarnings: decoded.warnings,
			filename: asset,
		});
		let report: ValidateReport = base;
		let mcmeta: ValidateMcmetaSection | undefined;
		if (options.mcmeta !== undefined && options.mcmeta !== "") {
			const wired = await applyMcmetaOption(options.mcmeta, base);
			mcmeta = wired.mcmeta;
			const findings = [...base.findings, ...wired.findings];
			const verdict = findings.some((finding) => finding.level === "error")
				? "fail"
				: base.verdict;
			report = { ...base, findings, verdict };
		}
		const result: ValidateResult = {
			...report,
			version,
			target: targetSummary,
			coverage: { status: "complete", skipped: [] },
			...(mcmeta !== undefined ? { mcmeta } : {}),
		};
		if (report.verdict === "fail") {
			failed = result;
			throw new McAssetError("VALIDATION_FAILED", summarize(report));
		}
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`${formatHumanReport(report, mcmeta)}\ntarget: ${targetSummary}`,
				streams,
				route,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof McAssetError) {
			const message = error.message.replace(/^\[[A-Z_]+\] /, "");
			if (globalJson) {
				emitEnvelope(
					error.code === "VALIDATION_FAILED" && failed !== undefined
						? errorEnvelope(error.code, message, undefined, failed)
						: errorEnvelope(error.code, message, error.details),
					streams,
					route,
				);
			} else {
				if (error.code === "VALIDATION_FAILED" && failed !== undefined) {
					const targetLine =
						"target" in failed && typeof failed.target === "string"
							? `\ntarget: ${failed.target}`
							: "";
					emitLog(
						`${formatHumanReport(failed, failed.mcmeta)}${targetLine}\nerror [VALIDATION_FAILED] ${message}`,
						streams,
						route,
					);
				} else {
					emitLog(`error [${error.code}] ${message}`, streams, route);
				}
			}
			return exitCodeForMcAssetError(error);
		}
		if (error instanceof Error) {
			if (globalJson) {
				emitEnvelope(
					errorEnvelope("INTERNAL_ERROR", error.message),
					streams,
					route,
				);
			} else {
				emitLog(`error [INTERNAL_ERROR] ${error.message}`, streams, route);
			}
			return 1;
		}
		const message = String(error);
		if (globalJson) {
			emitEnvelope(errorEnvelope("INTERNAL_ERROR", message), streams, route);
		} else {
			emitLog(`error [INTERNAL_ERROR] ${message}`, streams, route);
		}
		return 1;
	}
}
