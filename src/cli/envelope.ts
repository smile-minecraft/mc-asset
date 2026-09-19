import type { ErrorCode } from "../core/errors.ts";

export interface SuccessEnvelope<T = unknown> {
	success: true;
	result: T;
}

export interface ErrorEnvelopeDetails {
	code: ErrorCode;
	message: string;
	details?: unknown;
}

export interface ErrorEnvelope<T = unknown> {
	success: false;
	error: ErrorEnvelopeDetails;
	result?: T;
}

export type CliEnvelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope<T>;

/** Success envelope per section 60: { success: true, result }. */
export function successEnvelope<T>(result: T): SuccessEnvelope<T> {
	return { success: true, result };
}

/**
 * Failure envelope per sections 60/103. Details omitted when undefined so
 * the shape stays exactly { code, message }; batch failures attach the
 * rollback summary as `result`.
 */
export function errorEnvelope<T>(
	code: ErrorCode,
	message: string,
	details?: unknown,
	result?: T,
): ErrorEnvelope<T> {
	const envelope: ErrorEnvelope<T> = {
		success: false,
		error:
			details === undefined ? { code, message } : { code, message, details },
	};
	if (result !== undefined) {
		envelope.result = result;
	}
	return envelope;
}
