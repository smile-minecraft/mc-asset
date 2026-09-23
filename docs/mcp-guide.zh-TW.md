# MCP 伺服器指南（mc-asset）

[English](mcp-guide.md) | [繁體中文](mcp-guide.zh-TW.md) | [简体中文](mcp-guide.zh-CN.md)

`mc-asset mcp` 會啟動 stdio MCP 伺服器：stdout 只輸出 MCP JSON-RPC，診斷訊息走 stderr，stdin 關閉時行程結束。已凍結的介面（二十一個工具名稱、各自的輸入，以及讀寫契約）記載於 `docs/mcp-surface.zh-TW.md`，輸入欄位則凍結在 `src/mcp/schema.ts`。本指南涵蓋註冊方式、每個工具一份擷取（圖片位元組在有註明處截短顯示，不作原樣引用）、錯誤模型與限制。最新發布版本為 `v0.3.2`（2026-09-23）；源碼樹上的 `scale_gui_asset` 與創作新增功能（`inspect_asset`、`apply_asset_operations` 的 `feedback` 物件，以及 `ellipse`／`polygonFill`／`strokeMask` 操作）皆隨 `v0.3.2` 發布。由目前源碼建置的伺服器提供全部二十一個工具。

伺服器直接掛在 Core 上，所以每個工具都跑與 CLI 指令相同的引擎。像素層級的創作，透過 ASCII Grid 文件、批次操作陣列，或內嵌回傳的可編輯 `.mcpx` 來源來完成；刻意不提供 `set_pixel` 工具。

## 安裝與註冊伺服器

先安裝套件，再讓 MCP 用戶端指向 `npx -y mc-asset mcp`。三種安裝路徑都可以：

- **npm（建議）**：直接從 registry 執行 `npx -y mc-asset mcp`，或全域安裝 CLI：`npm install -g mc-asset`。
- **Homebrew（macOS / Linux）**：`brew tap smile-minecraft/tap && brew install smile-minecraft/tap/mc-asset`，之後使用 `mc-asset` 指令。
- **原始碼**：`bun install --frozen-lockfile && bun run build`，然後執行 `./bin/mc-asset.js mcp`。

不論用哪一種方式安裝，伺服器指令固定是 `npx -y mc-asset mcp`。各用戶端的設定檔名不同，也可能隨版本調整；不確定時，請查該用戶端自己的文件。以下註冊範例皆為 stdio。

**Claude Code**

```sh
claude mcp add mc-asset -- npx -y mc-asset mcp
```

**Claude Desktop** — `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "mc-asset": {
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "mc-asset": {
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

**VS Code** — `.vscode/mcp.json`：

```json
{
  "servers": {
    "mc-asset": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

**Cline** — `cline_mcp_settings.json`：

```json
{
  "mcpServers": {
    "mc-asset": {
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

**OpenCode** — `~/.config/opencode/opencode.jsonc`：

```jsonc
"mc-asset": {
  "type": "local",
  "command": ["npx", "-y", "mc-asset", "mcp"],
  "enabled": true
}
```

然後完整重新啟動用戶端。MCP 伺服器在啟動時載入，設定改了卻沒重啟，什麼都證明不了。要回復時，移除該項目（或還原設定備份）並再重啟一次。

以下擷取透過 MCP 用戶端 SDK 在一個示範工作目錄中執行，其中所有路徑都相對於該目錄，只有 `inspect_asset` 的結構擷取直接指向 repo 內的 fixture `tests/cli/fixtures/sword.mcpx`。原有七個工具的擷取取自已安裝的版本，後續新增的工具則取自本地源碼伺服器——兩者執行的是同一份伺服器程式碼。

## 二十一個工具

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
{"profile":"generic","preset":"item","presetDetail":"preset=item colors=16 edge=128 cluster=8 cleanup=outlier (item: tight 16-color budget with crop, background, subject, edge 128, cluster 8, outlier cleanup)","width":16,"height":16,"colors":16,"colorCount":16,"stages":[{"stage":"decode","status":"applied","reason":"decoded by the caller"},{"stage":"crop","status":"not-needed","reason":"content fills the full frame"},{"stage":"background","status":"not-needed","reason":"outer ring has no opaque majority at 90 percent coverage"},{"stage":"subject","status":"not-needed","reason":"subject already centered"},{"stage":"resize","status":"applied","reason":"nearest resize to 16x16"},{"stage":"edge","status":"applied","reason":"hardened 4 edge pixels at threshold 128"},{"stage":"quantize","status":"applied","reason":"median-cut at 16 colors, 16 kept"},{"stage":"cluster","status":"not-needed","reason":"no colors merged"},{"stage":"cleanup","status":"applied","reason":"cleanup outlier"},{"stage":"preset","status":"applied","reason":"recorded preset item"},{"stage":"output","status":"applied","reason":"encoded by the caller"}],"warnings":[],"output":"out/pixelize16.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n0 = #175754FF\n… 15 more palette entries (1–F); the last is F = #DDA5DEFF …\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[gr… (truncated) …"}
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

不帶 `feedback` 時，上面的形狀是凍結的：`applied`、`failed`、逐個操作的 `operations` 陣列、`warnings`，再來是 PNG 與來源成品（明確路徑，或內嵌的 `pngBase64`／`mcpxText`）。`feedback` 是選用的，只會往上加東西——沒傳 `feedback`，輸出欄位與位元組就跟以前一模一樣。

`feedback` 有四個欄位：`image`（`none`／`full`／`changed`）、`scale`（整數 1–16）、`crop`（選取表達式）、`diff`（`none`／`summary`）：

- `image: "none"`（預設）只回傳旗標，不帶圖。`"full"` 渲染整個裁切範圍；`"changed"` 無視 `crop`，只渲染合成後有變動的外框，畫面完全沒動時改回 `noVisibleChange: true`，不附圖。`crop` 配 `none` 是 `INVALID_ARGUMENT`。
- 附圖永遠不會以 `pngBase64` 內嵌：它會以第二個標準圖片內容塊送出（`type: "image"`、`mimeType: "image/png"`），文字塊裡不會留一份重複的位元組。
- 省略 `scale` 時，只看縮放前的長邊自動放大：長邊不到 128 才往 128 放，上限 16。輸出邊長超過 1024px 會以 `RESOURCE_LIMIT_EXCEEDED` 拒絕，不會偷偷縮圖。輔助像素（格線、棋盤格）永遠不會混進作品位元組。
- `diff: "summary"` 會加上 `raw`／`composited`／`structural`，以及 `outsideSelectionUnchanged`——選取範圍外的每個像素都原樣保留（含 alpha 0 之下藏起來的 RGB）時為 true。
- `atomic: false` 會跑完每個操作、留下成功的部分：結果照樣逐個回報成功／失敗（例如 `applied: 1, failed: 1`），不會整批回復，配 `changed` 圖片或 diff 摘要也一樣。

像素操作都可以帶選用的 `selection`：只有選中的像素會寫入，其餘全部原樣還原。選取可以寫原子——`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`——或 JSON AST 物件（`{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`），深度上限 32、節點上限 1024。選取落空時以 `EMPTY_SELECTION` 拒絕寫入並回復整批。

像素詞彙共九個操作，新增的三個形狀是：`ellipse`（`rect` 的內切橢圓；`mode` 必填，`fill` 或 `outline`）、`polygonFill`（填滿 `points` 指定的多邊形）、`strokeMask`（沿 `layerId` 上 `source` 選取範圍的讀取輪廓描邊，不把範圍本身塗掉）。`polygonFill` 最多 4096 個點，超過是 `RESOURCE_LIMIT_EXCEEDED`；自交的環是 `SELF_INTERSECTING_POLYGON`，不支援挖洞。完整的逐型參數表在 `docs/cli-surface.zh-TW.md` 的批次操作規格節。

附圖範例——一個變動像素加摘要（截短顯示，非原樣引用；圖片資料省略）：

呼叫：

```json
{"sourcePath":"sword.mcpx","operations":[{"type":"setPixel","layerId":"base","x":0,"y":0,"color":"#FF0000FF"}],"feedback":{"image":"changed","diff":"summary"}}
```

結果：文字塊帶 `applied: 1, failed: 0`，raw 與合成各一個變動像素，`outsideSelectionUnchanged: true`；圖片以第二個 `type: "image"`、`mimeType: "image/png"` 塊送達：

```text
{"applied":1,"failed":0,"operations":[{"index":0,"status":"applied"}],"warnings":[],"feedback":{"image":"changed","imageIncluded":true,"diff":{"raw":{"changedPixels":1 …},"composited":{"changedPixels":1 …},"structural":…,"outsideSelectionUnchanged":true}},"mcpxText":"mcpx 1\n… (truncated) …"}
[second block: {"type":"image","mimeType":"image/png","data":"… (omitted) …"}]
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

結果（原樣）：

```text
{"verdict":"pass","profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"dimensions":{"width":8,"height":8},"totalPixels":64,"colorCount":64,"alpha":{"predictedClassification":"translucent","opaquePixels":62,"transparentPixels":1,"partialAlphaPixels":1,"partialAlphaValues":[128],"opaqueRatio":"0.9688","transparentRatio":"0.0156","partialAlphaRatio":"0.0156","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"findings":[{"code":"PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING","level":"warning","message":"predicted translucent: 1 partial-alpha pixel(s) use the translucent render pass; left as-is with no auto-fix."}],"version":{},"target":"default (engine defaults)","coverage":{"status":"complete","skipped":[]}}
```

### import_asset

把點陣圖匯入引擎：輸入 PNG、JPEG 或 WebP，另可加一批操作。沒有給輸出路徑時，PNG 位元組與 `.mcpx` 文字都會內嵌在結果中。

呼叫：

```json
{"inputPath":"px-8x8.png"}
```

結果（原樣；`pngBase64` 與 `.mcpx` 的調色盤和網格已截短，完整調色盤包含全部 64 色，`0`–`T0002`）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAI… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 8\nheight = 8\n\n[palette]\n0 = #03ED20FF\n… 63 more palette entries (1–T0002) …\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid tokens]\no 7 F N V d l u\n… 7 more grid rows …"}
```

### build_asset

把可編輯的 `.mcpx` 來源重建成 PNG 位元組和／或建置後的來源。`sourcePath` 必須以 `.mcpx` 結尾，傳點陣圖會回報 `INVALID_ARGUMENT`。選用的批次會先執行。

呼叫：

```json
{"sourcePath":"sword.mcpx"}
```

結果（原樣；`pngBase64` 已截短）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n"}
```

### transform_asset

對點陣圖或 `.mcpx` 套用一個幾何操作（`flip`、`rotate` 等）；選取範圍不能與幾何操作併用（`ARGUMENT_CONFLICT`）。幾何旗標恰好只能給一個：給兩個是 `ARGUMENT_CONFLICT`，都不給是 `INVALID_ARGUMENT`。

呼叫：

```json
{"inputPath":"sword.mcpx","flip":"h"}
```

結果（原樣；`pngBase64` 已截短）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"geometry":"flip:h","width":4,"height":4,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n"}
```

### quantize_asset

把點陣圖或 `.mcpx` 減色到指定的色彩數，另可指定選取範圍。結果會回報 `colors`、`colorCount` 與 `modifiedPixels`。

呼叫：

```json
{"inputPath":"px-8x8.png","colors":4}
```

結果（原樣；`pngBase64` 已截短）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"colors":4,"colorCount":4,"modifiedPixels":64,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAI… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 8\nheight = 8\n\n[palette]\n0 = #2A6353E7\n1 = #5D8787FF\n2 = #B9417FFF\n3 = #C0C0B0FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n20002222\n00002222\n00011233\n00111333\n01113333\n11133330\n11333320\n11322220\n"}
```

### cleanup_asset

偵測點陣圖或 `.mcpx` 的像素缺陷，並可選擇修復。不帶 `fix` 類別時是純偵測：`modifiedPixels` 為 0，不改變任何像素。`fix` 類別若缺少渲染通道授權，會回報 `INVALID_ARGUMENT`。

呼叫：

```json
{"inputPath":"sword.mcpx"}
```

結果（原樣；`pngBase64` 已截短）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"detected":{"isolated":0,"noise":0,"cluster":0,"fringe":0,"outlier":0,"hole":0,"aa":0},"fixed":{"isolated":0,"noise":0,"cluster":0,"fringe":0,"outlier":0,"hole":0,"aa":0},"modifiedPixels":0,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n"}
```

### palette_asset

針對圖片的唯讀色彩報告。`extract` 列出不重複色彩，`inspect` 回報分佈、角色與對比。`mode` 為必填。

呼叫：

```json
{"mode":"extract","inputPath":"sword.mcpx"}
```

結果（原樣）：

```text
{"mode":"extract","profile":"generic","colorCount":3,"entries":[{"id":"color-0","color":"#00000000"},{"id":"color-1","color":"#FF0000FF"},{"id":"color-2","color":"#00FF00FF"}]}
```

### material_asset

內建材質的唯讀報告。`list` 列出所有材質，`show` 加 `name` 回傳單一材質定義與其色彩漸層。未知名稱會回報 `INVALID_ARGUMENT`。

呼叫：

```json
{"mode":"list"}
```

結果（原樣）：

```text
{"mode":"list","profile":"generic","materials":["iron","copper","oxidized_copper","gold","wood","stone","crystal"]}
```

### tile_asset

針對點陣圖或 `.mcpx` 的接縫與邊緣報告，另可指定比對軸向。帶 `preview`（例如 `2x2`）時，磁磚預覽 PNG 會以 `pngBase64` 內嵌。

呼叫：

```json
{"inputPath":"px-8x8.png","preview":"2x2"}
```

結果（原樣；`pngBase64` 已截短）：

```text
{"profile":"generic","width":8,"height":8,"preview":"2x2","seam":{"horizontal":{"raw":422822,"pairs":8,"score":"0.203202"},"vertical":{"raw":494206,"pairs":8,"score":"0.237508"},"corner":{"raw":100918,"pairs":2,"score":"0.193998"}},"repeat":{"score":"0.930164","periodX":1,"periodY":1},"corrections":[],"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ… (truncated) …"}
```

### generate_asset

以 `pattern` 加尺寸加調色盤加種子，合成確定性的程序化材質；不需要輸入檔。沒有給輸出路徑時，PNG 位元組與 `.mcpx` 文字都會內嵌。

呼叫：

```json
{"pattern":"checker","size":"16","palette":"iron","seed":7}
```

結果（原樣；`pngBase64` 與網格已截短，完整的 `.mcpx` 是雙色調色盤加全部 16 列網格）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"pattern":"checker","seed":7,"width":16,"height":16,"palette":"iron","pngBase64":"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n0 = #1A1D21FF\n1 = #EEF2F6FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n1110001110001110\n1110001110001110\n1110001110001110\n… 13 more grid rows …"}
```

### preview_asset

用一種 `mode` 做唯讀預覽：`ascii` 與 `palette-map` 回傳報告，`scale` 與 `nine-slice` 可把 PNG 寫到明確路徑。以下呼叫是 `sword.mcpx` 的 `ascii` 報告。

呼叫：

```json
{"inputPath":"sword.mcpx","mode":"ascii"}
```

結果（原樣）：

```text
{"mode":"ascii","profile":"generic","width":4,"height":4,"ascii":["[palette]",". = #00000000","R = #FF0000FF","G = #00FF00FF","","[grid]",".RR.","RGGR","RGGR",".RR."],"palette":{".":"#00000000","R":"#FF0000FF","G":"#00FF00FF"},"warnings":[]}
```

### scale_gui_asset

以 mcmeta 的 `stretch`／`tile`／`nine_slice` 映射，把 GUI 精靈圖縮放到明確的目標尺寸；`.mcmeta` 路徑原樣使用，省略即為 `stretch`。選用的版本目標決定 `stretch_inner` 是否生效；輸出只有 PNG——給明確的 `outputPngPath` 即寫檔，否則位元組以 `pngBase64` 內嵌。

呼叫：

```json
{"inputPath":"px-8x8.png","size":"16x16"}
```

結果（原樣；`pngBase64` 已截短）：

```text
{"size":"16x16","width":16,"height":16,"scaling":{"type":"stretch"},"version":{},"target":"default (engine defaults)","warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ… (truncated) …"}
```

### animate_asset

用一種 `mode` 處理動畫 sprite sheet：`pack` 從影格目錄建 sheet，`unpack`／`reorder`／`resize` 把影格寫到明確的輸出目錄，`validate`／`preview` 為唯讀。沒有給輸出路徑時，打包好的 sheet 以 `pngBase64` 內嵌。

呼叫：

```json
{"mode":"pack","framesDir":"v04-anim-frames","layout":"vertical"}
```

結果（原樣；`pngBase64` 已截短）：

```text
{"mode":"pack","profile":"generic","frameCount":2,"frameWidth":4,"frameHeight":4,"layout":"vertical","width":4,"height":8,"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAI… (truncated) …"}
```

### validate_pack_asset

針對整個資源包根目錄的唯讀判定，絕不寫入。選用的 `resourcePackVersion` 可選擇相容性目標。`fail` 判定是正常結果，不是錯誤。選用的 `vanillaPath` 提供原版資源樹，`dependencyPaths`（有序，排前者優先）加入依賴根目錄；報告帶 `coverage` 物件，提供原版樹後，原本會略過的 atlas 檢查即可完成。

呼叫：

```json
{"packPath":"clean-pack","resourcePackVersion":"75"}
```

結果（原樣）：

```text
{"command":"validate-pack","path":"clean-pack","target":"resource-pack 75.0","verdict":"pass","findings":[{"code":"PACK_COVERAGE_SKIPPED","level":"warning","message":"atlas \"items\" for sprite \"minecraft:item/sword\" in \"assets/minecraft/models/item/sword.json\" cannot be completed without the vanilla resource tree; coverage recorded as skipped.","path":"assets/minecraft/models/item/sword.json"}],"coverage":{"status":"partial","skipped":[{"kind":"atlas-source","reason":"vanilla-not-provided","target":"items","detail":"sprite \"minecraft:item/sword\" needs the vanilla atlas sources"}]},"version":{"resourcePackVersion":"75.0"}}
```

### inspect_asset

針對 `.mcpx` 來源或點陣圖的唯讀檢查——點陣圖會讀成單一 base 圖層——絕不寫入。呼叫帶 `inputPath` 加 `mode`（`structure`／`view`）；`crop` 與 `scale` 只有 `view` 能用，`structure` 帶任一個都是 `INVALID_ARGUMENT`。

呼叫：

```json
{"inputPath":"tests/cli/fixtures/sword.mcpx","mode":"structure"}
```

結果（該 fixture 的本地 MCP 文字塊回應實況）：

```text
{"mode":"structure","width":4,"height":4,"layers":[{"id":"base","name":"base","index":0,"bounds":{"x":0,"y":0,"width":4,"height":4},"area":12,"visible":true,"opacity":1,"blendMode":"normal","colorUsage":{"uniqueColors":3,"transparentPixels":4,"topColors":[{"rgba":"#FF0000FF","count":8},{"rgba":"#00000000","count":4},{"rgba":"#00FF00FF","count":4}],"truncated":false}}],"regions":[],"overlaps":{"layerBounds":[],"regionPixels":[]}}
```

`structure` 回報圖層（範圍、面積、可見性、原始 RGBA 用色）、區域（只含識別、範圍、面積）與重疊。`view` 則把合成像素以標準圖片塊回傳，外加六鍵詮釋資料（`mode`、`sourceDimensions`、`crop`、`scale`、`outputDimensions`、`colorFormat`）——裁切／縮放／1024px 邊長規則與頂層 `inspect` 指令相同，圖片位元組不會另存一份 `pngBase64`。`view` 的 `scale` 是整數 1–16，預設 1；長邊自動放大（縮放前長邊不到 128 才往 128 放）只適用於 `apply_asset_operations` 的附圖，不適用 `view`。`crop` 是與批次 `selection` 同文法的選取表達式，落空時以 `EMPTY_SELECTION` 拒絕；輸出邊長超過 1024px 時以 `RESOURCE_LIMIT_EXCEEDED` 加裁切提示拒絕。

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
- **與 CLI 完全對等。** 二十一個工具涵蓋素材輸入與來源建置、空間變換、調色盤與減色、確定性像素化管線、程序化生成、磁磚與預覽、動畫 sprite sheet，以及單一素材與整個資源包的驗證（含依賴／原版解析與 GUI 精靈圖縮放）；版本目標設定透過 `analyze_asset`、`validate_asset`、`validate_pack_asset` 的 `minecraftVersion`／`resourcePackVersion` 傳入。
- **檢視與附圖都是圖片塊，不另存副本。** `inspect_asset` 的 `view` 與 `apply_asset_operations` 的附圖都不會再以 `pngBase64` 重複一份 PNG；位元組走標準的 `type: "image"`、`mimeType: "image/png"` 塊。檢視縮放預設 1；長邊自動放大（縮放前不到 128 才往 128 放，上限 16）只適用於附圖。超過 1024px 邊長一律是 `RESOURCE_LIMIT_EXCEEDED`，不會默默縮圖。
- **`validate_asset` 只檢查單一 PNG。** 資源包層級與圖集感知的驗證，請用 `validate_pack_asset`。
- **確定性只驗證過示範輸入。** 相同輸入加相同參數，對示範用的 `px-8x8.png`／`sword.mcpx`／`v04-anim-frames/` 與一個乾淨的資源包產生了相同結果。其他輸入與選項（WebP、`WxH` 尺寸、`region`、`atomic: false`、`animate` 的 `resize`）也演練過，但沒有重跑確認輸出是否一致。
- **執行環境。** MCP 路徑只使用 `node:` 匯入，所以打包後的 `dist` 可在純 Node 下執行；CI 的 `node` job 使用 Node 22。需要 Node.js 22 或更新，`engines` 欄位已宣告 `>=22`。
- **尚未實測**：`mcmetaPath`、JPEG 輸入、沒有擷取的 `mode` 分支（`palette` 的 `inspect`、`material` 的 `show`、`preview` 的 `palette-map`／`scale`／`nine-slice`、`animate` 的 `unpack`／`reorder`／`validate`／`preview`），以及擷取的 `INVALID_ARGUMENT` 與已演練的 `OUTPUT_EXISTS`／`FILESYSTEM_ERROR` 之外的任何錯誤路徑。
