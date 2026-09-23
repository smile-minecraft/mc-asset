import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FORMULA = join(ROOT, "homebrew", "Formula", "mc-asset.rb");

function readFormula(): string {
	return readFileSync(FORMULA, "utf-8");
}

const EXPECTED_FORMULA_SHA256 =
	"77b4d471cc8683a5802328380cc0b0b3a860f909ea6125957a238946cbf96e3e";

function extractFormulaSha256(text: string): string | null {
	const match = text.match(/^\s*sha256\s+"([0-9a-f]{64})"/m);
	return match ? match[1] : null;
}

describe("homebrew formula (static contract, no build required)", () => {
	it("formula lives at the tap layout path", () => {
		assert.ok(existsSync(FORMULA), "homebrew/Formula/mc-asset.rb is missing");
	});

	it("formula pins a public tag tarball with a non-empty SHA-256", () => {
		const text = readFormula();
		assert.ok(
			text.includes("class McAsset < Formula"),
			"formula must declare class McAsset < Formula",
		);
		assert.ok(
			text.includes(
				"https://github.com/smile-minecraft/mc-asset/releases/download/v0.3.2/mc-asset-0.3.2.tar.gz",
			),
			"formula url must pin the v0.3.2 tag tarball",
		);
		assert.match(
			text,
			/sha256\s+"[0-9a-f]{64}"/,
			"formula must carry a 64-hex SHA-256",
		);
		assert.ok(
			!text.includes("main.tar.gz") && !text.includes("master.tar.gz"),
			"formula must not track a moving branch",
		);
		assert.ok(
			!text.includes("PRIVATE") && !text.includes("token"),
			"formula must not use private URLs or secrets",
		);
	});

	it("formula pins the published v0.3.2 asset digest, no pending marker", () => {
		const text = readFormula();
		assert.strictEqual(
			extractFormulaSha256(text),
			EXPECTED_FORMULA_SHA256,
			"formula sha256 field must equal the published v0.3.2 asset digest",
		);
		assert.ok(
			!text.includes("PENDING_TAG_RECHECK"),
			"formula must not carry the pending recheck marker",
		);
		assert.ok(
			!text.includes(
				"019a240cedbd50dc4076312eb19dffaca5054111d0ff90a68dcca7741a832dd7",
			),
			"formula must not carry the dry-run SHA",
		);
		assert.ok(
			!text.includes(
				"bdc941bce9eff148732398bb767d4b73f05c20a6ff4d6718b82a4317dba98881",
			),
			"formula must not carry the previous v0.1.0 asset digest",
		);
		assert.ok(
			!text.includes(
				"6e4f0c53a199be95b08aa97894d70307a0639425748f85a52238add73ac18d4c",
			),
			"formula must not carry the previous v0.3.0 asset digest",
		);
		assert.ok(
			!text.includes(
				"9a2a21c9e23402d7729633bf87bfaa277532c1b4f10b98eb8f4b6fcb4db01f76",
			),
			"formula must not carry the previous v0.3.1 asset digest",
		);
	});

	it("formula runs on Node and installs the release layout", () => {
		const text = readFormula();
		assert.match(text, /depends_on\s+"node"/, "formula needs a node runtime");
		assert.doesNotMatch(
			text,
			/depends_on\s+"bun"/i,
			"formula must not depend on Bun",
		);
		assert.doesNotMatch(
			text,
			/system\s+["']bun/i,
			"formula install/test must not shell out to Bun",
		);
		assert.match(
			text,
			/license\s+"MIT"/,
			"formula must declare the MIT license",
		);
		for (const token of [
			"libexec.install",
			'"bin"',
			'"dist"',
			"LICENSE",
			"THIRD_PARTY_NOTICES",
		]) {
			assert.ok(text.includes(token), `formula install must mention ${token}`);
		}
	});

	it("formula installs the command under the exact name mc-asset", () => {
		const text = readFormula();
		// write_exec_script names the wrapper after the source basename, so
		// passing libexec/"bin/mc-asset.js" alone would install bin/mc-asset.js
		// instead of the documented bin/mc-asset command. The install step
		// must therefore rename the entry to exactly "mc-asset".
		assert.ok(
			text.includes('=> "mc-asset"'),
			'formula install must rename the entry to exactly "mc-asset"',
		);
		assert.ok(
			text.includes('bin/"mc-asset"'),
			"formula test must exercise bin/mc-asset, not a .js filename",
		);
	});

	it("formula test exercises the render-analyze-validate chain", () => {
		const text = readFormula();
		assert.ok(text.includes("test do"), "formula must define a test block");
		for (const command of ["render", "analyze", "validate"]) {
			assert.ok(
				text.includes(command),
				`formula test must run ${command}, not only --version`,
			);
		}
	});
});
