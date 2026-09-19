import type { ErrorCode, ExitCode, McAssetError } from "../core/errors.ts";
import { resolveExitCode } from "../core/errors.ts";

function causeCodeFromDetails(details: unknown): ErrorCode | undefined {
	if (typeof details !== "object" || details === null) {
		return undefined;
	}
	const cause = (details as { cause?: unknown }).cause;
	if (typeof cause !== "string") {
		return undefined;
	}
	if (cause === "TRANSACTION_FAILED") {
		return undefined;
	}
	// Narrow through the registry instead of a local table.
	try {
		return resolveExitCode(cause as ErrorCode) !== undefined
			? (cause as ErrorCode)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Single exit-code path: delegates to the section 99 registry in
 * core/errors. TRANSACTION_FAILED unwraps to its cause when present.
 */
export function exitCodeForMcAssetError(error: McAssetError): ExitCode {
	if (error.code === "TRANSACTION_FAILED") {
		const cause = causeCodeFromDetails(error.details);
		if (cause === undefined) {
			return resolveExitCode("TRANSACTION_FAILED");
		}
		return resolveExitCode("TRANSACTION_FAILED", cause);
	}
	return resolveExitCode(error.code);
}
