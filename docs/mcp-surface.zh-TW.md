# MCP 介面（已凍結）

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

進入點：`mc-asset mcp` 會啟動 stdio MCP 伺服器。stdout 只輸出 MCP JSON-RPC，診斷訊息走 stderr，stdin 關閉時行程正常結束。伺服器直接掛在 Core 上，不重新實作任何影像邏輯。

工具名稱已凍結。早期草稿把批次編輯工具稱為 `edit_asset`，凍結後的名稱是 `apply_asset_operations`。

最新發布版本為 `v0.3.2`（2026-09-23），把 Minecraft 版本支援擴大到 `1.19.3`–`26.3`。十二個工具（`import_asset` 到 `validate_pack_asset`；`palette_asset`、`material_asset`、`preview_asset`、`animate_asset` 把 CLI 子命令合併為 `mode` 欄位）是在 `v0.3.0` 為了與 CLI 完全對等而新增的，名稱與輸入形狀在此凍結。目前源碼樹多出 `scale_gui_asset`，以及 authoring 新增的 `inspect_asset`、`apply_asset_operations` 的 `feedback`、三個新批次形狀（`ellipse`、`polygonFill`、`strokeMask`）和選取範圍 JSON AST 寫法——皆於 `v0.3.2` 加入。由目前源碼建置的伺服器提供全部二十一個工具。

能力基礎：與 CLI 完全對等——素材輸入與來源建置、空間變換、調色盤與減色、確定性像素化管線、程序化生成、磁磚與預覽、動畫 sprite sheet，以及單一素材與整個資源包的驗證。

像素工作不需要成百上千次逐像素的工具呼叫：像素層級的創作，透過 ASCII Grid 文件、批次操作陣列，或內嵌回傳的可編輯 `.mcpx` 來源來完成。刻意不提供 `set_pixel` 工具。

## 工具

| 工具 | 讀取 | 寫入 | 結果 |
|---|---|---|---|
| `analyze_asset` | 點陣圖（PNG、JPEG、WebP） | 無 | 唯讀報告：尺寸、調色盤、預測的 alpha 分類（從不代表實際結果）、像素畫特徵、建議 |
| `pixelize_asset` | 參考點陣圖（PNG、JPEG、WebP；不接受 `.mcpx`） | 選用的明確 PNG／`.mcpx` 路徑 | 確定性管線輸出：PNG 位元組和／或可編輯來源 |
| `render_pixel_asset` | ASCII Grid：內嵌 `gridText` 或 `gridPath` 檔案，兩者恰好擇一，另可加批次 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `apply_asset_operations` | 可編輯的 `.mcpx` 來源加操作陣列 | 選用的明確 PNG／`.mcpx` 路徑 | 已套用的數量與各操作的狀態；預設為原子（第一個失敗就全部回復） |
| `recolor_asset` | 可編輯的 `.mcpx` 來源、內建材質 id、選用的區域 id | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或重新上色後的來源，附變更計數 |
| `create_variants` | 可編輯的 `.mcpx` 來源、一個以上的內建材質 id | 必須明確指定的輸出目錄 | 每種材質各一份 `<stem>_<material>.png` 加 `.mcpx`，皆由原始來源產生 |
| `validate_asset` | 素材檔（PNG）、選用的明確 `.mcmeta` 路徑（原樣使用） | 無 | 附發現項目的唯讀判定 |
| `import_asset` | 點陣圖（PNG、JPEG、WebP）加選用的批次 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `build_asset` | 可編輯的 `.mcpx` 來源加選用的批次 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或建置後的來源 |
| `transform_asset` | 點陣圖或 `.mcpx`、一個幾何旗標（搭配選取範圍會回報 `ARGUMENT_CONFLICT`） | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `scale_gui_asset` | 點陣圖或 `.mcpx`、選用的明確 `.mcmeta` 路徑 | 選用的明確 PNG 路徑 | 縮放後的 PNG（明確路徑或內嵌位元組），附解析出的縮放摘要 |
| `quantize_asset` | 點陣圖或 `.mcpx`、必需的色彩數、選用的選取範圍 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `cleanup_asset` | 點陣圖或 `.mcpx`、選用的修復類別、選用的選取範圍 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `palette_asset` | 圖片、一種 `mode`（`extract`／`inspect`） | 無 | 唯讀報告：不重複色彩，或分佈、角色與對比 |
| `material_asset` | 無（`list`）或內建材質名稱（`show` 用 `mode` 加 `name`） | 無 | 唯讀報告：材質清單或色彩漸層 |
| `tile_asset` | 點陣圖或 `.mcpx`、選用的預覽網格與比對軸向 | 選用的明確 PNG 路徑 | 接縫與邊緣報告，或預覽 PNG |
| `generate_asset` | 無（圖樣加尺寸加調色盤加種子） | 選用的明確 PNG／`.mcpx` 路徑 | 確定性的程序化 PNG 位元組和／或可編輯來源 |
| `preview_asset` | 點陣圖或 `.mcpx`、一種 `mode`（`ascii`／`palette-map`／`scale`／`nine-slice`） | 選用的明確 PNG 路徑（`scale`、`nine-slice`） | 唯讀報告或預覽 PNG |
| `animate_asset` | 影格目錄或 sprite sheet、一種 `mode`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`） | 明確的 PNG 路徑（`pack`）或輸出目錄（`unpack`、`reorder`、`resize`） | Sheet PNG、影格或唯讀報告 |
| `validate_pack_asset` | 資源包根目錄，外加選用的原版資源樹與依賴根目錄 | 無 | 附發現項目與 coverage 物件的唯讀判定 |
| `inspect_asset` | 可編輯的 `.mcpx` 來源或點陣圖（點陣圖視為單一 base 圖層）、一種 `mode`（`structure`／`view`），view 另有 `crop` 與 `scale` | 無 | 唯讀報告（structure），或合成 PNG 的 image block 加 metadata（view） |

## 輸入語意

- 每個檔案路徑都要明確指定。會產生檔案的工具不會自行決定檔名，唯讀工具則絕不寫入。
- `profile` 為 `generic`、`minecraft:item`、`minecraft:block`、`minecraft:gui`、`minecraft:particle` 其中之一；省略時視為 `generic`。
- `minecraftVersion`／`resourcePackVersion`（analyze、validate、validate-pack）用來選擇相容性行為，接受 release 版本 `1.19.3` 到 `26.3`（例如 `1.19.3`、`1.21.4`、`26.3`），以及資源包版本 `N` 或 `N.M`（例如 `84`、`97.1`），會正規化為 `major.minor`。省略時使用引擎預設值。
- 子命令工具把 CLI 模式合併為 `mode` 欄位：`palette_asset`（`extract`／`inspect`）、`material_asset`（`list`／`show`）、`preview_asset`（`ascii`／`palette-map`／`scale`／`nine-slice`）、`animate_asset`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`）。
- `apply_asset_operations` 接收操作物件陣列，每個物件都有一個 `type`（Core 批次詞彙：九個像素操作 `setPixel`、`clearPixel`、`drawLine`、`drawRect`、`fillRect`、`floodFill`、`ellipse`、`polygonFill`、`strokeMask`，另有圖層與區域操作、`stampRect`、`regionFromSelection` 等），再加該類型的參數。`atomic` 預設為 true；設為 false 時會跑完每個操作，以各操作的 applied／failed 狀態回報，不再回復。像素操作可附選用的 `selection` 表示式；空匹配以 `EMPTY_SELECTION` 拒絕寫入並回復整批。
- `apply_asset_operations` 另接受選用的 `feedback` 物件（`image`：`none`／`full`／`changed`；`scale`：整數 1–16；`crop`：選取範圍表示式；`diff`：`none`／`summary`）。不給 `feedback` 時，輸出欄位與位元組與過去完全相同。給了 `feedback` 時，結果攜帶 `feedback` 物件（`image`、`imageIncluded`、選用的 `noVisibleChange`、選用的 `diff`，含 `raw`／`composited`／`structural`／`outsideSelectionUnchanged`），且絕不內嵌 `pngBase64`：附帶的圖以標準 image content block（`type: "image"`、`mimeType: "image/png"`）傳送，文字區塊不重複攜帶位元組。`changed` 算繪合成後的變更邊界（忽略 crop），可見範圍沒有變化時以 `noVisibleChange` 代替圖片回報；參考線像素（格線、棋盤格）絕不寫入作品位元組。`crop` 配 `none` 為 `INVALID_ARGUMENT`。
- `inspect_asset` 接收 `inputPath` 加 `mode`：`structure` 回傳圖層（邊界、面積、可見性、原始 RGBA 色彩用量）、區域（識別、邊界，只報面積）與重疊；`view` 以 image block 回傳合成 PNG 加六鍵 metadata，crop／scale／1024px 邊界規則與頂層 `inspect` 指令相同。view 的 scale 預設為 1；長邊自動縮放只適用於 `apply_asset_operations` 的 feedback 圖。
- 完整的操作參數表見 [CLI Surface](cli-surface.zh-TW.md)的「批次操作規格」節；兩個介面共用同一種 JSON 形狀。`polygonFill` 最多 4096 個點，自交的環為 `SELF_INTERSECTING_POLYGON`，孔洞不支援。
- 選取範圍表示式可寫原子（`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`）或 JSON AST 物件（`op` 為 `union`／`intersect`／`subtract`／`invert`，加 `operands [...]`），深度上限 32、節點上限 1024。
- `scale_gui_asset` 接收 `size`（`N` 或 `WxH`）、選用的 `mcmetaPath`（省略即為 `stretch`）與選用的版本欄位；輸出只有 PNG。
- `validate_pack_asset` 接收選用的 `vanillaPath` 與選用的有序 `dependencyPaths`（排前者優先）。
- `transform_asset`／`animate_asset` 的 `resizeMode` 接受 `nearest`／`box`／`pixel-aware`。
- 省略輸出路徑時，成品會內嵌在工具結果中（PNG 位元組、`.mcpx` 文字），不寫入磁碟。

## 輸出語意

- 唯讀工具（`analyze_asset`、`validate_asset`、`palette_asset`、`material_asset`、`validate_pack_asset`、`inspect_asset`）回傳報告；`validate_asset` 以 `fail` 加發現項目表示失敗，不會拋出錯誤。
- 驗證類報告帶 `coverage: {status, skipped}`；`partial` 會逐項列出略過的檢查及其種類與原因，且不改變狀態碼。
- 混合工具（`tile_asset`、`preview_asset`、`animate_asset`）在唯讀模式回傳報告，在寫入模式只寫入明確指定的輸出路徑或目錄。
- 會產生檔案的工具回傳已套用的數量、各操作的狀態、警告，以及實際寫出的明確路徑或內嵌的成品。
