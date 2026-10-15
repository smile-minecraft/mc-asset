import { McAssetError } from "../core/errors.ts";
import {
	GUI_SCALING_FACT,
	GUI_STRETCH_INNER_FACT,
	isFactActive,
	isPackFormatInKnownRange,
} from "../profiles/versions.ts";

export interface McmetaGenerateWarning {
	code: string;
	message: string;
}

/** Check compatibility after the generator has validated the parameters. */
export function mcmetaVersionStatus(
	packFormat: string | undefined,
	request: {
		mode: "animation" | "gui";
		type?: string | undefined;
		stretchInner?: boolean | undefined;
	},
): { versionChecked: boolean; warnings: McmetaGenerateWarning[] } {
	if (packFormat !== undefined && request.mode === "gui") {
		if (!isFactActive(GUI_SCALING_FACT, packFormat)) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				`gui.scaling needs resource-pack format ${GUI_SCALING_FACT.since.packFormat} or newer; target ${packFormat} predates it.`,
				{ packFormat, type: request.type },
			);
		}
		if (
			request.stretchInner === true &&
			!isFactActive(GUI_STRETCH_INNER_FACT, packFormat)
		) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				`stretch_inner needs resource-pack format ${GUI_STRETCH_INNER_FACT.since.packFormat} or newer; target ${packFormat} predates it.`,
				{ packFormat },
			);
		}
	}
	if (packFormat !== undefined && isPackFormatInKnownRange(packFormat)) {
		return { versionChecked: true, warnings: [] };
	}
	return {
		versionChecked: false,
		warnings: [
			{
				code: "VERSION_NOT_CHECKED",
				message:
					"version was not checked; pass a release version for a checked target.",
			},
		],
	};
}
