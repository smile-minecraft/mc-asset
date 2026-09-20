import { addLayer, createCanvas, setPixel } from "../../src/core/canvas.ts";
import type { PixelCanvas } from "../../src/core/types.ts";
import type { ValidateFinding } from "../../src/validate/checks.ts";
import { validateCanvas } from "../../src/validate/checks.ts";
import {
	parseResourceLocation,
	validateDiskFilename,
	validateResourceLocation,
} from "../../src/validate/resource-location.ts";
import type { CaseCheck } from "./validate-cases.ts";

export interface ResourceLocationCase {
	name: string;
	run(check: CaseCheck): void;
}

function codes(findings: ValidateFinding[]): string[] {
	return findings.map((finding) => finding.code);
}

function levels(findings: ValidateFinding[]): string[] {
	return findings.map((finding) => finding.level);
}

function makeCanvas(): PixelCanvas {
	const canvas = createCanvas(2, 2);
	const layer = addLayer(canvas, { id: "base" });
	setPixel(canvas, layer.id, 0, 0, { r: 255, g: 0, b: 0, a: 255 });
	setPixel(canvas, layer.id, 1, 0, { r: 0, g: 255, b: 0, a: 255 });
	setPixel(canvas, layer.id, 0, 1, { r: 0, g: 0, b: 255, a: 255 });
	setPixel(canvas, layer.id, 1, 1, { r: 255, g: 255, b: 0, a: 255 });
	return canvas;
}

export const RESOURCE_LOCATION_CASES: ResourceLocationCase[] = [
	{
		name: "parse: explicit namespace splits on the single colon",
		run: (check) => {
			const parsed = parseResourceLocation("example:item/sword.png");
			check.equal(parsed.namespace, "example", "namespace kept");
			check.equal(parsed.path, "item/sword.png", "path kept");
			check.equal(parsed.hasExplicitNamespace, true, "explicit flag set");
		},
	},
	{
		name: "parse: missing colon defaults to minecraft",
		run: (check) => {
			const parsed = parseResourceLocation("item/sword.png");
			check.equal(parsed.namespace, "minecraft", "default namespace");
			check.equal(parsed.path, "item/sword.png", "whole value is the path");
			check.equal(parsed.hasExplicitNamespace, false, "implicit flag unset");
		},
	},
	{
		name: "parse: extra colons stay in the path for the path rule",
		run: (check) => {
			const parsed = parseResourceLocation("a:b:c");
			check.equal(parsed.namespace, "a", "split on the first colon");
			check.equal(parsed.path, "b:c", "remainder stays in the path");
		},
	},
	{
		name: "pass: canonical minecraft location has no findings",
		run: (check) => {
			check.deepEqual(
				validateResourceLocation("minecraft:item/sword.png"),
				[],
				"clean location passes",
			);
		},
	},
	{
		name: "pass: default-namespace location has no findings",
		run: (check) => {
			check.deepEqual(
				validateResourceLocation("item/sword.png"),
				[],
				"implicit minecraft passes",
			);
		},
	},
	{
		name: "pass: freeze layout witness is clean",
		run: (check) => {
			check.deepEqual(
				validateResourceLocation("example:item/sword.png"),
				[],
				"docs layout example passes",
			);
		},
	},
	{
		name: "fail: empty namespace is a namespace problem",
		run: (check) => {
			const findings = validateResourceLocation(":sword");
			check.deepEqual(
				codes(findings),
				["PACK_NAMESPACE_PROBLEM", "PENDING_SOURCE_PNG_ONLY"],
				"namespace error plus extensionless warning",
			);
			check.equal(findings[0]?.level, "error", "error level");
		},
	},
	{
		name: "fail: namespace charset outsiders are a namespace problem",
		run: (check) => {
			const findings = validateResourceLocation("exa mple:sword");
			check.deepEqual(
				codes(findings),
				["PACK_NAMESPACE_PROBLEM", "PENDING_SOURCE_PNG_ONLY"],
				"namespace error plus extensionless warning",
			);
			check.equal(findings[0]?.level, "error", "error level");
		},
	},
	{
		name: "fail: slash in namespace is a namespace problem",
		run: (check) => {
			const findings = validateResourceLocation("a/b:sword");
			check.deepEqual(
				codes(findings),
				["PACK_NAMESPACE_PROBLEM", "PENDING_SOURCE_PNG_ONLY"],
				"namespace error plus extensionless warning",
			);
		},
	},
	{
		name: "fail: uppercase namespace is a case mismatch, not a namespace problem",
		run: (check) => {
			const findings = validateResourceLocation("Example:sword");
			check.deepEqual(
				findings.filter((f) => f.level === "error").map((f) => f.code),
				["PACK_CASE_MISMATCH"],
				"case owns uppercase at error level",
			);
			check.ok(
				codes(findings).includes("PENDING_SOURCE_PNG_ONLY"),
				"extensionless still warns",
			);
		},
	},
	{
		name: "fail: empty path is a wrong path",
		run: (check) => {
			const findings = validateResourceLocation("minecraft:");
			check.ok(
				codes(findings).includes("PACK_WRONG_PATH"),
				"empty path is wrong",
			);
			check.equal(
				findings.find((f) => f.code === "PACK_WRONG_PATH")?.level,
				"error",
				"error level",
			);
		},
	},
	{
		name: "fail: leading, trailing, and double slashes are wrong paths",
		run: (check) => {
			for (const value of [
				"minecraft:/sword",
				"minecraft:sword/",
				"minecraft:a//b",
			]) {
				const findingCodes = codes(validateResourceLocation(value));
				check.ok(
					findingCodes.includes("PACK_WRONG_PATH"),
					`${value} is a wrong path`,
				);
			}
		},
	},
	{
		name: "fail: path charset outsiders are a wrong path",
		run: (check) => {
			const findings = validateResourceLocation("minecraft:my sword");
			check.ok(codes(findings).includes("PACK_WRONG_PATH"), "space is wrong");
		},
	},
	{
		name: "fail: uppercase path is a case mismatch, not a wrong path",
		run: (check) => {
			const findings = validateResourceLocation("minecraft:Sword");
			check.deepEqual(
				findings.filter((f) => f.level === "error").map((f) => f.code),
				["PACK_CASE_MISMATCH"],
				"case owns uppercase at error level",
			);
		},
	},
	{
		name: "fail: second colon lands in the path",
		run: (check) => {
			const findings = validateResourceLocation("a:b:c");
			check.deepEqual(
				codes(findings),
				["PACK_WRONG_PATH", "PACK_INVALID_FILENAME", "PENDING_SOURCE_PNG_ONLY"],
				"colon fails path, filename, and extension rules",
			);
		},
	},
	{
		name: "fail: freeze witness MySword.PNG is a case mismatch",
		run: (check) => {
			const findings = validateResourceLocation("MySword.PNG");
			check.ok(
				codes(findings).includes("PACK_CASE_MISMATCH"),
				"uppercase detected",
			);
			check.equal(
				findings.find((f) => f.code === "PACK_CASE_MISMATCH")?.level,
				"error",
				"case mismatch is an error",
			);
			check.ok(
				codes(findings).includes("PENDING_SOURCE_PNG_ONLY"),
				"non-png extension warns",
			);
			check.equal(
				findings.find((f) => f.code === "PENDING_SOURCE_PNG_ONLY")?.level,
				"warning",
				"extension is warning-only",
			);
		},
	},
	{
		name: "fail: filename charset outsiders are invalid filenames",
		run: (check) => {
			const findings = validateResourceLocation("minecraft:item/my sword.png");
			check.ok(
				codes(findings).includes("PACK_INVALID_FILENAME"),
				"space in filename is invalid",
			);
			check.equal(
				findings.find((f) => f.code === "PACK_INVALID_FILENAME")?.level,
				"error",
				"invalid filename is an error",
			);
		},
	},
	{
		name: "warning: webp extension is pending-source warning only",
		run: (check) => {
			const findings = validateResourceLocation("minecraft:item/sword.webp");
			check.deepEqual(
				codes(findings),
				["PENDING_SOURCE_PNG_ONLY"],
				"only the extension warning",
			);
			check.deepEqual(levels(findings), ["warning"], "warning only");
		},
	},
	{
		name: "pass: length never rejects",
		run: (check) => {
			const long = `minecraft:${"a".repeat(300)}/${"b".repeat(300)}.png`;
			check.deepEqual(validateResourceLocation(long), [], "long names pass");
		},
	},
	{
		name: "deterministic: repeated runs fold identically in canonical order",
		run: (check) => {
			const first = validateResourceLocation("Example:a//b.webp");
			const second = validateResourceLocation("Example:a//b.webp");
			check.deepEqual(second, first, "byte-identical reruns");
			check.deepEqual(
				codes(first),
				["PACK_WRONG_PATH", "PACK_CASE_MISMATCH", "PENDING_SOURCE_PNG_ONLY"],
				"canonical order",
			);
		},
	},
	{
		name: "filename: Sword.png stem uppercase is a case mismatch",
		run: (check) => {
			const findings = validateDiskFilename("Sword.png");
			check.deepEqual(codes(findings), ["PACK_CASE_MISMATCH"], "one code");
			check.equal(findings[0]?.level, "error", "error level");
		},
	},
	{
		name: "filename: clean sword.png has no findings",
		run: (check) => {
			check.deepEqual(
				validateDiskFilename("sword.png"),
				[],
				"clean name passes",
			);
		},
	},
	{
		name: "filename: extension-only uppercase stays with the existing extension rule",
		run: (check) => {
			check.deepEqual(
				validateDiskFilename("sword.PNG"),
				[],
				"clean stem has no stem findings",
			);
		},
	},
	{
		name: "filename: spaces are invalid filenames",
		run: (check) => {
			const findings = validateDiskFilename("my sword.png");
			check.deepEqual(codes(findings), ["PACK_INVALID_FILENAME"], "one code");
			check.equal(findings[0]?.level, "error", "error level");
		},
	},
	{
		name: "filename: empty stem is an invalid filename",
		run: (check) => {
			check.deepEqual(
				codes(validateDiskFilename(".png")),
				["PACK_INVALID_FILENAME"],
				"dotfile stem is empty",
			);
			check.deepEqual(
				codes(validateDiskFilename("")),
				["PACK_INVALID_FILENAME"],
				"empty name is invalid",
			);
		},
	},
	{
		name: "filename: directories are stripped before the check",
		run: (check) => {
			check.deepEqual(
				codes(validateDiskFilename("some/dir/Sword.png")),
				["PACK_CASE_MISMATCH"],
				"posix dirs stripped",
			);
			check.deepEqual(
				validateDiskFilename("some\\dir\\sword.png"),
				[],
				"windows dirs stripped",
			);
		},
	},
	{
		name: "validate: minecraft item fails Sword.png with PACK_CASE_MISMATCH",
		run: (check) => {
			const report = validateCanvas(makeCanvas(), {
				profile: "minecraft:item",
				filename: "Sword.png",
			});
			check.equal(report.verdict, "fail", "uppercase stem fails");
			check.ok(
				codes(report.findings).includes("PACK_CASE_MISMATCH"),
				"case mismatch present",
			);
			check.ok(
				!codes(report.findings).includes("FILENAME_EXTENSION_NOT_PNG"),
				"lowercase .png keeps the existing extension rule quiet",
			);
		},
	},
	{
		name: "validate: minecraft item passes sword.png",
		run: (check) => {
			const report = validateCanvas(makeCanvas(), {
				profile: "minecraft:item",
				filename: "sword.png",
			});
			check.equal(report.verdict, "pass", "clean name passes");
			check.equal(
				report.findings.filter((f) => f.level === "error").length,
				0,
				"no errors",
			);
		},
	},
	{
		name: "validate: generic ignores uppercase stems",
		run: (check) => {
			const report = validateCanvas(makeCanvas(), {
				profile: "generic",
				filename: "Sword.PNG",
			});
			check.equal(report.verdict, "pass", "generic has no filename rule");
			check.equal(
				report.findings.filter((f) => f.level === "error").length,
				0,
				"no errors for generic",
			);
		},
	},
	{
		name: "validate: minecraft block flags charset outsiders",
		run: (check) => {
			const report = validateCanvas(makeCanvas(), {
				profile: "minecraft:block",
				filename: "my sword.png",
			});
			check.equal(report.verdict, "fail", "space fails");
			check.ok(
				codes(report.findings).includes("PACK_INVALID_FILENAME"),
				"invalid filename present",
			);
		},
	},
];
