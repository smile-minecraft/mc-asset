import { McAssetError } from "../core/errors.ts";
import { getMaterial, listMaterialIds } from "../core/material.ts";
import { emitCommandFailure } from "./artifacts.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import { parseProfile } from "./profiles.ts";

export interface MaterialOptions {
	output?: string | undefined;
	stdout?: boolean | undefined;
	source?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	inPlace?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
}

function rejectFileFlags(options: MaterialOptions, command: string): void {
	if (
		(options.output !== undefined && options.output !== "") ||
		options.stdout === true ||
		(options.source !== undefined && options.source !== "") ||
		options.force === true ||
		options.mkdir === true ||
		options.inPlace === true ||
		(options.input !== undefined && options.input !== "")
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${command} produces a report only and takes no file flags.`,
		);
	}
}

function toHex(color: { r: number; g: number; b: number; a: number }): string {
	const byte = (value: number): string => value.toString(16).padStart(2, "0");
	return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${byte(color.a)}`.toUpperCase();
}

/**
 * Read-only material queries: `material list` names the seven frozen
 * builtins in registry order, `material show <name>` prints one
 * definition. Unknown ids are INVALID_ARGUMENT via the material registry.
 * Both refuse every file flag and never write artifact files.
 */
export async function runMaterial(
	mode: string,
	name: string | undefined,
	options: MaterialOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		const profile = parseProfile(options.profile);
		if (mode === "list") {
			rejectFileFlags(options, "material list");
			if (name !== undefined && name !== "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"material list takes no name argument.",
					{ name },
				);
			}
			const materials = listMaterialIds();
			const result = { command: "material", mode: "list", profile, materials };
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok material list profile=${profile} count=${materials.length}`,
					streams,
					route,
				);
				for (const id of materials) {
					emitLog(`material ${id}`, streams, route);
				}
			}
			return 0;
		}
		if (mode === "show") {
			rejectFileFlags(options, "material show");
			if (name === undefined || name === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"material show needs a material name.",
				);
			}
			const definition = getMaterial(name);
			const result = {
				command: "material",
				mode: "show",
				profile,
				id: definition.id,
				characteristics: definition.characteristics,
				palette: definition.palette.entries.map((entry) => ({
					id: entry.id,
					color: toHex(entry.color),
					...(entry.role !== undefined ? { role: entry.role } : {}),
				})),
			};
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok material show profile=${profile} id=${definition.id}`,
					streams,
					route,
				);
				for (const entry of result.palette) {
					emitLog(`color ${entry.id} ${entry.color}`, streams, route);
				}
			}
			return 0;
		}
		throw new McAssetError("INVALID_ARGUMENT", "material takes list or show.", {
			mode,
		});
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
