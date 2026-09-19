# PENDING_TAG_RECHECK: the sha256 below was recomputed locally from
# `bun run build` plus `node scripts/release-artifacts.mjs --dry-run --out <dir>`
# (tarball 019a240cedbd50dc4076312eb19dffaca5054111d0ff90a68dcca7741a832dd7).
# The release owner re-verifies it against the real v0.1.0 tag tarball
# (`shasum -a 256 mc-asset-0.1.0.tar.gz`) before publishing the tap update.
class McAsset < Formula
  desc "Pixel-native Minecraft asset toolchain"
  homepage "https://github.com/smile-minecraft/mc-asset"
  url "https://github.com/smile-minecraft/mc-asset/releases/download/v0.1.0/mc-asset-0.1.0.tar.gz"
  sha256 "019a240cedbd50dc4076312eb19dffaca5054111d0ff90a68dcca7741a832dd7"
  license "MIT"

  depends_on "node"

  def install
    # Keep the "bin" and "dist" directories intact: bin/mc-asset.js hands off
    # to ../dist/mc-asset.js, so installing the launcher file on its own
    # would break the relative import.
    libexec.install "bin", "dist", "LICENSE", "THIRD_PARTY_NOTICES.md"
    bin.write_exec_script libexec/"bin/mc-asset.js"
  end

  test do
    (testpath/"tiny.grid").write <<~EOS
      ; Hand-authored ASCII grid: 4x4 mark.
      [palette]
      . = transparent
      S = #ADB7C0FF

      [grid]
      .SS.
      SSSS
      SSSS
      .SS.
    EOS
    system bin/"mc-asset", "render", testpath/"tiny.grid", "--output", testpath/"tiny.png"
    assert_predicate testpath/"tiny.png", :exist?
    system bin/"mc-asset", "analyze", testpath/"tiny.png"
    system bin/"mc-asset", "validate", testpath/"tiny.png"
  end
end
