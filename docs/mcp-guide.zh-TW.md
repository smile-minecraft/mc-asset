# MCP 伺服器指南（mc-asset）

[English](mcp-guide.md) | [繁體中文](mcp-guide.zh-TW.md) | [简体中文](mcp-guide.zh-CN.md)

`mc-asset mcp` 會啟動 stdio MCP 伺服器：stdout 只輸出 MCP JSON-RPC，診斷訊息走 stderr，stdin 關閉時行程結束。已凍結的介面（七個工具名稱、各自的輸入，以及讀寫契約）記載於 `docs/mcp-surface.zh-TW.md`，輸入欄位則凍結在 `src/mcp/schema.ts`。本指南涵蓋註冊方式、每個工具一份原樣擷取、錯誤模型與限制。

伺服器直接掛在 Core 上，所以每個工具都跑與 CLI 指令相同的引擎。像素層級的創作，透過 ASCII Grid 文件、批次操作陣列，或內嵌回傳的可編輯 `.mcpx` 來源來完成；刻意不提供 `set_pixel` 工具。

## 安裝與註冊伺服器

伺服器內建在透過 Homebrew 安裝的 `mc-asset` 執行檔中，請先安裝（Homebrew tap 的做法見 README 的「安裝指南」段落）。

接著在全域 OpenCode 設定（`~/.config/opencode/opencode.jsonc`）中，把 `mc-asset` 加為 MCP 伺服器：

```jsonc
"mc-asset": {
  "type": "local",
  "command": ["/opt/homebrew/bin/mc-asset", "mcp"],
  "enabled": true
}
```

`command` 指向已安裝的執行檔（`/opt/homebrew/bin/mc-asset` 是這台機器上 Homebrew 的安裝位置）。

然後完整重新啟動 OpenCode。MCP 伺服器在啟動時載入，設定改了卻沒重啟，什麼都證明不了。要回復時，移除該項目（或還原設定備份）並再重啟一次。

以下擷取取自已安裝的版本，透過 MCP 用戶端 SDK 在一個示範工作目錄中執行，其中所有路徑都相對於該目錄。

## 七個工具

### analyze_asset

針對點陣圖的唯讀報告，絕不寫入。呼叫時帶 `path`，另可選帶 `profile`、`minecraftVersion` 或 `resourcePackVersion`。

呼叫：

```json
{"path":"px-8x8.png"}
```

結果（原樣；`dominantColors` 陣列在 8 個項目中只留第一個，其餘每項都是 `count` 1、`ratio` "0.0156"）：

```text
{"dimensions":{"width":8,"height":8},"totalPixels":64,"colorCount":64,"alpha":{"predictedClassification":"translucent","opaquePixels":62,"transparentPixels":1,"partialAlphaPixels":1,"partialAlphaValues":[128],"opaqueRatio":"0.9688","transparentRatio":"0.0156","partialAlphaRatio":"0.0156","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"dominantColors":[{"hex":"#03ED20FF","r":3,"g":237,"b":32,"a":255,"count":1,"ratio":"0.0156"} … 7 more entries, each count 1 / ratio "0.0156" …]}
```

分類只依 PNG 位元組預測，從不代表遊戲內的實際渲染結果，這與 CLI 的提醒相同。

### pixelize_asset

讓參考點陣圖跑過確定性的像素化管線。輸入必須是 PNG、JPEG 或 WebP，不能是 `.mcpx`。呼叫必須帶 `size`（`16`、`32`、`64`、`128` 或 `WxH`），省略會回報 `INVALID_ARGUMENT`。`preset` 為選用。

呼叫：

```json
{"inputPath":"px-8x8.png","size":"16","preset":"item","outputPngPath":"out/pixelize16.png"}
```

結果（原樣；只給了 PNG 路徑，所以 `.mcpx` 文字內嵌回傳，調色盤區塊與結尾已截短）：

```text
{"profile":"generic","preset":"item","presetDetail":"preset=item colors=16 edge=0 cluster=0 cleanup=outlier pending-review (item: tight 16-color budget, outlier cleanup, no heuristics)","width":16,"height":16,"colors":16,"colorCount":16,"stages":["decode","crop","background","subject","resize","edge","quantize","cluster","cleanup","preset","output"],"warnings":[],"output":"out/pixelize16.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n0 = #124B44FF\n… 15 more palette entries (1–F); the last is F = #DDA5DEFF …\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[gr… (truncated) …"}
```

### render_pixel_asset

將手寫的 ASCII Grid 渲染成 PNG 位元組和／或 `.mcpx`。`gridText`（內嵌文件）與 `gridPath`（`.grid` 檔）恰好傳一個；兩個都傳是 `ARGUMENT_CONFLICT`，都不傳是 `INVALID_ARGUMENT`。選用的 `operations` JSON 字串會在 grid 解析完成後套用。

呼叫：

```json
{"gridText":"[palette]\n. = transparent\nS = #ADB7C0FF\n\n[grid]\n.SS.\nSSSS\nSSSS\n.SS.\n","outputPngPath":"out/render.png"}
```

結果（原樣；沒有給 `.mcpx` 路徑，所以內嵌 `mcpxText`）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"width":4,"height":4,"output":"out/render.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nS = #ADB7C0FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.SS.\nSSSS\nSSSS\n.SS.\n"}
```

### apply_asset_operations

一次呼叫，把一批 Core 像素／圖層／區域操作套用到 `.mcpx` 來源。`sourcePath` 必須以 `.mcpx` 結尾；`atomic` 預設為 true，所以第一個失敗就會回復整批。

呼叫：

```json
{"sourcePath":"sword.mcpx","operations":[{"type":"setPixel","x":0,"y":0,"color":"#FF0000FF"},{"type":"fillRect","rect":{"x":1,"y":1,"width":2,"height":2},"color":"#00FF00FF"}],"outputMcpxPath":"out/applied.mcpx","outputPngPath":"out/applied.png"}
```

結果（原樣；兩個輸出路徑都給了，所以兩種成品都不內嵌）：

```text
{"applied":2,"failed":0,"operations":[{"index":0,"status":"applied"},{"index":1,"status":"applied"}],"warnings":[],"output":"out/applied.png","source":"out/applied.mcpx"}
```

### recolor_asset

用一個內建材質 id，替 `.mcpx` 來源的每個圖層重新上色；選用的 `region` 可把寫入限定在單一區域。`material` 為必填。

呼叫：

```json
{"sourcePath":"sword.mcpx","material":"iron","outputPngPath":"out/sword_iron.png"}
```

結果（原樣；只給了 PNG 路徑，所以重新上色後的 `.mcpx` 文字內嵌回傳）：

```text
{"profile":"generic","material":"iron","pixelsChanged":12,"warnings":[],"output":"out/sword_iron.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n0 = #5A6068FF\n1 = #9AA1A9FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.00.\n0110\n0110\n.00.\n"}
```

### create_variants

把一份 `.mcpx` 來源展開到明確指定的 `outputDir` 下，每種材質產生一份 PNG 加一份 `.mcpx`，每份都從原始來源開始。同一次呼叫中重複列出同一材質，會回報 `ARGUMENT_CONFLICT`。

呼叫：

```json
{"sourcePath":"sword.mcpx","materials":["iron","copper"],"outputDir":"variants-out"}
```

結果（原樣）：

```text
{"profile":"generic","materials":["iron","copper"],"outputDir":"variants-out","files":[{"material":"iron","png":"variants-out/sword_iron.png","mcpx":"variants-out/sword_iron.mcpx","pixelsChanged":12},{"material":"copper","png":"variants-out/sword_copper.png","mcpx":"variants-out/sword_copper.mcpx","pixelsChanged":12}],"warnings":[]}
```

### validate_asset

回傳附發現項目的唯讀判定，絕不寫入。`path` 是 PNG，選用的 `mcmetaPath` 會原樣使用（不會自行推導同名的相鄰檔案）。`fail` 判定是正常結果，不是錯誤。

呼叫：

```json
{"path":"px-8x8.png"}
```

結果（原樣；第二個發現項目的訊息已截短）：

```text
{"verdict":"pass","profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"dimensions":{"width":8,"height":8},"totalPixels":64,"colorCount":64,"findings":[{"code":"PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING","level":"warning","message":"predicted translucent: 1 partial-alpha pixel(s) use the translucent render pass; left as-is with no auto-fix."},{"code":"VERSION_FACT_UNDETERMINED","level":"warning","message":"Com… (truncated) …"}]}
```

## 失敗時如何回傳

工具失敗時會設定 `isError: true`，內容是放在 `content[0].text` 的 JSON 字串：

```text
isError: true
{"code":"INVALID_ARGUMENT","message":"Rect must be an object with x, y, width, and height.","details":{"path":"operations[1].rect"}}
```

這份擷取來自 `apply_asset_operations`，其中第二個操作的 `fillRect` 沒有 `rect` 物件。

- `code` 是與 CLI 共用的註冊表錯誤碼（`INVALID_ARGUMENT`、`ARGUMENT_CONFLICT`、`FILESYSTEM_ERROR`、`OUTPUT_EXISTS` 等）；不是 `McAssetError` 的失敗會變成 `INTERNAL_ERROR`。
- `message` 是 CLI 訊息去掉開頭 `[CODE] ` 前綴後的內容。
- `details` 只在錯誤帶有脈絡時才出現，例如出錯的操作路徑。
- `validate_asset` 以 `fail` 加發現項目回報，而不是拋出錯誤，所以有問題的素材仍是正常結果。

可預期的檔案規則失敗：

- 明確指定的輸出路徑已存在 → `OUTPUT_EXISTS`。
- 缺少上層目錄 → `FILESYSTEM_ERROR`。
- `apply_asset_operations`、`recolor_asset`、`create_variants` 收到非 `.mcpx` 的來源 → `INVALID_ARGUMENT`。
- `create_variants` 的 `outputDir` 不存在或不是目錄 → `FILESYSTEM_ERROR`。
- `render_pixel_asset` 同時給 `gridPath` 與 `gridText` → `ARGUMENT_CONFLICT`；兩者都沒給 → `INVALID_ARGUMENT`。

## 限制與缺口

- **沒有逐像素工具。** 不存在 `set_pixel`；像素工作要透過 ASCII Grid、批次操作陣列或內嵌的 `.mcpx` 文字來做。
- **只接受明確路徑，不覆寫，不建目錄。** 目標已存在是 `OUTPUT_EXISTS`，缺少上層目錄是 `FILESYSTEM_ERROR`。錯誤訊息仍會提到 `--force`／`--mkdir`，但透過 MCP 無法傳入這兩個旗標，請改用新路徑，或自行建立目錄。
- **省略輸出路徑會內嵌成品。** 沒有輸出路徑時，結果會帶 `pngBase64`（PNG）或 `mcpxText`（`.mcpx`），而不寫入檔案。這是逐個成品決定的：只給 `outputPngPath` 會寫出 PNG，並仍在結果中內嵌 `.mcpx` 文字。
- **介面只涵蓋核心引擎工具。** `tile`、`generate`、`preview`、`animate`、`validate-pack` 與版本目標設定，目前仍只在 CLI 提供。
- **`validate_asset` 只檢查單一 PNG。** 資源包層級與圖集感知的驗證，在 CLI 的 `validate-pack`。
- **確定性只驗證過示範輸入。** 相同輸入加相同參數產生了相同結果；只跑過示範用的 `px-8x8.png`／`sword.mcpx`，其他格式尚未驗證。
- **執行環境。** MCP 路徑只使用 `node:` 匯入，所以打包後的 `dist` 可在純 Node 下執行；CI 的 `node` job 使用 Node 22。未宣告最低 Node 版本（沒有 `engines` 欄位）。
- **尚未實測**：`mcmetaPath`、`region`、`atomic: false`、JPEG／WebP 輸入、`WxH` 尺寸，以及上面擷取之外的任何錯誤路徑。
