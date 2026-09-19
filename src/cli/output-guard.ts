import { McAssetError } from "../core/errors.ts";

export interface OutputRequest {
	output?: string | undefined;
	stdout?: boolean | undefined;
	inPlace?: boolean | undefined;
	force?: boolean | undefined;
	input?: string | undefined;
}

export type ResolvedOutput =
	| { mode: "file"; path: string }
	| { mode: "stdout" };

/**
 * Output target policy per sections 57/98.2. Missing --output/--stdout
 * (and no --in-place) is OUTPUT_REQUIRED; --force with --in-place is
 * ARGUMENT_CONFLICT; --in-place without an input path is INVALID_ARGUMENT.
 */
export function resolveOutputTarget(request: OutputRequest): ResolvedOutput {
	if (request.force === true && request.inPlace === true) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"--force and --in-place must not be combined.",
		);
	}
	if (request.inPlace === true) {
		if (request.input === undefined || request.input === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"--in-place needs an input path to derive the output.",
			);
		}
		return { mode: "file", path: request.input };
	}
	if (request.output !== undefined && request.output !== "") {
		return { mode: "file", path: request.output };
	}
	if (request.stdout === true) {
		return { mode: "stdout" };
	}
	throw new McAssetError(
		"OUTPUT_REQUIRED",
		"One of --output, --stdout, or --in-place is required.",
	);
}
