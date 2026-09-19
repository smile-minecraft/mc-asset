import type { CliEnvelope } from "./envelope.ts";

/** Minimal writable surface: real stdio and in-memory test streams both fit. */
export interface OutputSink {
	write(chunk: string | Uint8Array): unknown;
}

export interface OutputStreams {
	stdout: OutputSink;
	stderr: OutputSink;
}

export interface RouteFlags {
	json: boolean;
	stdoutArtifact: boolean;
}

export interface StreamRoute {
	artifact: "stdout" | null;
	envelope: "stdout" | "stderr";
	log: "stdout" | "stderr";
}

/**
 * Channel plan per section 98.1. stdout carries exactly one payload at a
 * time; everything else goes to stderr once --stdout or --json is in play.
 */
export function routeStreams(flags: RouteFlags): StreamRoute {
	if (flags.stdoutArtifact) {
		return { artifact: "stdout", envelope: "stderr", log: "stderr" };
	}
	if (flags.json) {
		return { artifact: null, envelope: "stdout", log: "stderr" };
	}
	return { artifact: null, envelope: "stdout", log: "stdout" };
}

/** Human progress, warnings, and diagnostics. Never targets bare stdout when bytes own it. */
export function emitLog(
	message: string,
	streams: OutputStreams,
	route: StreamRoute,
): void {
	const sink = route.log === "stdout" ? streams.stdout : streams.stderr;
	sink.write(`${message}\n`);
}

/** JSON envelope routing per the 98.1 table. */
export function emitEnvelope(
	envelope: CliEnvelope,
	streams: OutputStreams,
	route: StreamRoute,
): void {
	const sink = route.envelope === "stdout" ? streams.stdout : streams.stderr;
	sink.write(`${JSON.stringify(envelope)}\n`);
}

/** Artifact bytes always own stdout in --stdout mode. */
export function emitArtifact(
	bytes: Uint8Array,
	streams: OutputStreams,
	_route: StreamRoute,
): void {
	streams.stdout.write(bytes);
}
