# 解碼器選型決策紀錄（JPEG／WebP，發布封裝情境）

- 任務：v02 解碼器選型實證（spike；不含完整解碼器實作）
- 準則來源：`docs/v02-design.md`「解碼器選型準則」節（MUST 1–7）
- 實驗地點：repo 外暫存目錄（decoder-spike；repo 內僅新增本檔案）
- 工具版本：Bun 1.3.10、Node v26.9.0、cwebp／dwebp 1.6.0（libsharpyuv 0.4.2）
- 本紀錄所有「已實測」結論皆有下述指令與輸出為證；未實測者標示為未知。

## Fixture（來源皆有記錄，無不明素材）

| 檔案 | 產生方式 | 大小 | sha256（前 16 碼） |
|---|---|---|---|
| `fixture-rgba.png` | 自製：`gen-png.mjs`（pngjs 7.0.0）4×4 RGBA，(0,0)=`200,10,90,0` 隱藏 RGB 探針，(3,3)=`30,60,120,128` 半透明探針 | 115 B | — |
| `fixture-q90.jpg` | 自製：`gen-jpg.mjs`（jpeg-js 0.4.4 編碼，quality 90；先按 straight alpha 合成到黑底，因 JPEG 無 alpha） | 711 B | `d20301bd…` |
| `fixture-lossless-exact.webp` | 公開工具：`cwebp -lossless -exact fixture-rgba.png`（libwebp 1.6.0） | 112 B | `5ed2061b…` |
| `fixture-lossy-q80.webp` | 公開工具：`cwebp -q 80 fixture-rgba.png`（libwebp 1.6.0） | 142 B | `9774fec8…` |

參考基準：`dwebp -pam` 解碼（原生 libwebp），PAM 檔頭後 raw RGBA 取 sha256：

- lossless 參考：`60cd7f43…93bb0d1d`，探針像素 `200,10,90,0`（隱藏 RGB 完整）
- lossy 參考：`dc4adc13…846d11f035`

限制：JPEG fixture 由 jpeg-js 自行編碼（self-hosted；僅能驗證解碼決定性，不能驗證相對參考實作的正確性）。漸進式 JPEG、動畫 WebP 未備 fixture，仍為未知。

## 候選×評估軸結果

版本 pin（精確）與 registry metadata（`npm view`，2026-09-19 查得）：

| 候選 | 版本 pin | license（npm／codec） | unpacked／已安裝 | 維護（time.modified） |
|---|---|---|---|---|
| jpeg-js | 0.4.4 | BSD-3-Clause／同左 | 76 KB／100 KB | 2022-10-31（停滯，但純 JS 穩定） |
| @jsquash/jpeg | 1.6.0 | Apache-2.0／libjpeg-turbo（IJG＋BSD-3＋zlib，均 permissive） | 530 KB／576 KB（含 `mozjpeg_dec.wasm` 162.6 KB） | 2025-05-12 |
| @jsquash/webp | 1.5.0 | Apache-2.0／libwebp BSD-style（Google） | 914 KB／972 KB（含 `webp_dec.wasm` 134.7 KB；另依賴 `wasm-feature-detect`） | 2025-08-11 |
| webp-wasm | 1.0.6 | MIT／Squoosh wasm（Apache-2.0） | 537 KB／548 KB（含 `webp_node_dec.wasm` 145.2 KB、`webp_node_enc.wasm` 291.3 KB） | 2024-07-09（緩慢） |

完整性（`dist.integrity`，供 v02-t07 落地 pin 用）：

- jpeg-js@0.4.4：`sha512-WZzeDOEtTOBK4Mdsar0IqEU5sMr3vSV2RqkAIzUEV2BHnUfKGyswWFPFwK5EeDo93K3FohSHbLAjj0s1Wzd+dg==`
- @jsquash/jpeg@1.6.0：`sha512-zwN46Awh1VM6gXlIcALwb5WzqK5H2e6+Awcs1QP8AvS8ohsK/sbE4esvmH4jhlhW7+CgiUUww66vg0aTnlSIMA==`
- @jsquash/webp@1.5.0：`sha512-KggLoj2MnRSfIqTeKe1EmbljTX2vuV7mh79k89PCL1pyqiDULcPM1L47twxXt0hkb68F70bXiL31MxsuoZtKFw==`

授權結論：四候選皆為 permissive（BSD-3／Apache-2.0／MIT），與專案 MIT 相容；`@jsquash/*` 另帶 codec 授權檔（libjpeg-turbo 三授權、libwebp BSD-style），再發布時需保留其 copyright notice（BSD 條款要求）。注意：本評估僅止於 license metadata 與授權檔頭，未閱讀第三方原始碼（§104.4）。

### 發布封裝情境實測（`bun build --target node`，Bun 跑 source、Node 跑 bundle）

| 候選 | Bun source | Node bundle（預設打包） | Node 相容條件 | Bun／Node 一致 | 對參考實作 |
|---|---|---|---|---|---|
| jpeg-js | `d1bc9a2f…15c`（q90） | 同左 `d1bc9a2f…15c` ✅ | 無，開箱即用；bundle 60.4 KB 自含 | ✅ byte-identical | 未知（self-hosted fixture；且 jpeg-js 與 mozjpeg 解碼本就不同：同檔 mozjpeg 解出 `3f4bacda…`，屬實現間 IDCT 差異，非 bug） |
| @jsquash/jpeg | `3f4bacda…b03b`（q90） | ❌ 預設失敗：emscripten glue 用 `fetch` 載 wasm，Node 丟 `TypeError: fetch failed`（`not implemented... yet...`） | 需 `init({ instantiateWasm })` 手動具現化（已驗證：Node 下解出 `3f4bacda…b03b`，與 Bun 一致 ✅） | ⚠️ 需 glue 才一致 | 未驗證（無 djpeg 對照） |
| @jsquash/webp | lossless `60cd7f43…`、lossy `dc4adc13…`（Bun） | ❌ 同上 fetch 失敗 | 同上 `init` glue（已驗證；且把 glue 包進 bundle 後 Node bundle 解出參考值 ✅，見下） | ✅（glue 版）三方一致：Bun source＝Node bundle＝dwebp | ✅ 與 dwebp byte-identical（lossless＋lossy） |
| webp-wasm | lossless `60cd7f43…`、lossy `dc4adc13…`（Bun／Node source 一致 ✅） | ✅（bundle 0.71 KB，外部 require；Node bundle 解出 `60cd7f43…`／`dc4adc13…`，與 Bun source 一致） | 需先 `await load()`（Bun 首次呼叫自動載入會掩蓋此事）；**必須傳精確 ArrayBuffer 切片**，Node pooled Buffer 的 `.buffer` 是整個 8K pool，會靜默回傳 null | ✅ byte-identical | ✅ 與 dwebp byte-identical（lossless＋lossy） |

Premultiply（A=0／RGB≠0）實測：lossless-exact WebP 經 @jsquash/webp 與 webp-wasm 解碼，探針像素皆為 `200,10,90,0`，與 dwebp 參考一致——**兩者皆不 premultiply** ✅。JPEG 無 alpha，不適用。Repo 實驗環境全程未引入 sharp／libvips／Skia（`node_modules` 僅上述四候選＋pngjs；cwebp／dwebp 為系統工具，僅產參考值，未進依賴）。

體積影響（`bun build --target node --format esm`，decode-only 腳本）：jpeg-js 自含 60.4 KB；@jsquash/webp（glue 版）51.4 KB JS＋外部 `webp_dec.wasm` 134.7 KB；@jsquash/jpeg 51 KB JS＋外部 `mozjpeg_dec.wasm` 162.6 KB；webp-wasm 0.71 KB＋外部整個套件（含編碼器 wasm 291.3 KB，用不到也得跟著裝）。

## 建議採用的候選與 pin（供 v02-t07）

- **JPEG：jpeg-js@0.4.4**（開箱跨 runtime 一致、自含 bundle、授權單純）。接受其代價：專案停滯（2022）、解碼輸出與 mozjpeg/libjpeg-turbo 有實現間差異（lossy IDCT 非 bit-exact；決定性只保證「同候選跨 runtime 一致」，不保證跨實現一致）。
- **WebP：@jsquash/webp@1.5.0＋`init({ instantiateWasm })` glue**（與 dwebp 參考 byte-identical、lossless／lossy／alpha 皆驗、維護較活躍）。代價：v02-t07 必須實作並測試 wasm 檔的發布策略（二選一：隨包安裝由 `require.resolve` 定位；或 base64 內嵌進 bundle——後者未實測）。
- **Fallback：webp-wasm@1.0.6**（Node＋Bun 皆通、與參考一致），切換條件：若 `@jsquash/webp` 的 wasm 發布策略在 v02-t07 受阻（例如單檔 dist 要求），或其 Node glue 出現維護斷裂。注意其 API 足具：`load()` 必顯式呼叫、傳參必為精確 ArrayBuffer；且套件含用不到的編碼器 wasm（291 KB）。
- JPEG 若將來需要與 mozjpeg bit-exact：切換到 @jsquash/jpeg@1.6.0＋同式 glue（Node 一致性已驗；但相對參考實作的正確性仍未知）。

## 風險

1. `@jsquash/*` 預設打包在 Node 下直接失效（fetch 載 wasm），是 v02-t07 的必處理項，非可選優化。
2. 單檔 dist（無 node_modules 隨行）情境下，WASM 候選的 `.wasm` 檔如何跟著走，本次未實測（spike 內 node_modules 存在）。
3. JPEG 跨實現非 bit-exact：若未來 golden  fixtures 用 mozjpeg 系產生，jpeg-js 會對不上；反之亦然。v02-t07 應把 JPEG golden 鎖在「同一候選」上。
4. jpeg-js 停滯多年：無 CVE 處理預期；僅解碼用途風險低，但應記錄。
5. webp-wasm 靜默 null（pooled Buffer）是整合時易踩坑，採用時必須在 decode 入口斷言輸入為精確 ArrayBuffer。

## 未完成／未驗證清單

- [ ] 漸進式 JPEG 解碼（無 fixture；候選皆未測）
- [ ] 無損／有損以外 WebP 變體：動畫 WebP、ICC／EXIF 附帶資料（未測）
- [ ] JPEG 相對獨立參考實作（djpeg）的正確性（僅 self-hosted 一致性）
- [ ] 損壞／截斷輸入的錯誤行為（error code 對應屬 v02-t07 範圍）
- [ ] 單檔 dist 無 node_modules 時的 wasm 跟隨策略（base64 內嵌未實測）
- [ ] 大圖效能／記憶體（本次 4×4 fixture 不具代表性）
- [ ] `wasm-feature-detect`（@jsquash 依賴）在 bundle 下的行為（本次未觸發問題，但未顯式驗證）

## 原始指令摘要（皆於 decoder-spike 執行）

```text
npm view <pkg> version license dist.unpackedSize [/ dependencies / dist.integrity / time.modified]
npm install --no-audit --no-fund jpeg-js@0.4.4 @jsquash/jpeg@1.6.0 @jsquash/webp@1.5.0 webp-wasm@1.0.6 pngjs@7.0.0
node gen-png.mjs fixture-rgba.png / node gen-jpg.mjs fixture-rgba.png 90 fixture-q90.jpg
cwebp -lossless -exact fixture-rgba.png -o fixture-lossless-exact.webp
cwebp -q 80 fixture-rgba.png -o fixture-lossy-q80.webp
dwebp <fixture> -pam -o ref-*.pam（PAM 檔頭後 payload 取 sha256）
bun decode-*.mjs <fixture> out-bun-* / node decode-*.mjs <fixture> out-nodeSRC-*
bun build decode-*.mjs --outfile dist-spike/*.bundle.mjs --target node --format esm
node dist-spike/*.bundle.mjs <fixture> out-node-*
```

關鍵輸出：上表各 sha256；失敗原樣：`TypeError: fetch failed [cause]: not implemented... yet...`（@jsquash 預設 bundle／Node source）；`TypeError: Cannot read properties of null (reading 'data')`（webp-wasm 未 load／pooled Buffer）。
