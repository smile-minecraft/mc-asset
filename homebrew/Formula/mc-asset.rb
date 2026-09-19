# v0.1.0 published asset: sha256 below matches the GitHub Release
# tarball `mc-asset-0.1.0.tar.gz` (digest verified against the published
# asset and its `.sha256` companion). Re-verify with
# `shasum -a 256 mc-asset-0.1.0.tar.gz` before any tap update.
class McAsset < Formula
  desc "Pixel-native Minecraft asset toolchain"
  homepage "https://github.com/smile-minecraft/mc-asset"
  url "https://github.com/smile-minecraft/mc-asset/releases/download/v0.1.0/mc-asset-0.1.0.tar.gz"
  sha256 "bdc941bce9eff148732398bb767d4b73f05c20a6ff4d6718b82a4317dba98881"
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
