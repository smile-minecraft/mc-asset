# MCP 介面（已凍結）

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

進入點：`mc-asset mcp` 會啟動 stdio MCP 伺服器。stdout 只輸出 MCP JSON-RPC，診斷訊息走 stderr，stdin 關閉時行程正常結束。伺服器直接掛在 Core 上，不重新實作任何影像邏輯。

工具名稱已凍結。早期草稿把批次編輯工具稱為 `edit_asset`，凍結後的名稱是 `apply_asset_operations`。

Minecraft 目標版本涵蓋 `1.19.3` 到 `26.3`。工具中，有十二個（`import_asset` 到 `validate_pack_asset`）是為了與 CLI 完全對等而設。各版本的變更記錄在 [`CHANGELOG.md`](../CHANGELOG.md)。

能力基礎：與 CLI 完全對等——素材輸入與來源建置、空間變換、調色盤與減色、確定性像素化管線、程序化生成、磁磚與預覽、動畫 sprite sheet，以及單一素材與整個資源包的驗證。

像素工作不需要成百上千次逐像素的工具呼叫：像素層級的創作，透過 ASCII Grid 文件、批次操作陣列，或內嵌回傳的可編輯 `.mcpx` 來源來完成。刻意不提供 `set_pixel` 工具。

## 工具

| 工具 | 讀取 | 寫入 | 結果 |
|---|---|---|---|
| `analyze_asset` | 點陣圖（PNG、JPEG、WebP） | 無 | 唯讀報告：尺寸、調色盤、預測的 alpha 分類（從不代表實際結果）、像素畫特徵、建議 |
| `pixelize_asset` | 參考點陣圖（PNG、JPEG、WebP；不接受 `.mcpx`） | 選用的明確 PNG／`.mcpx` 路徑 | 確定性管線輸出：PNG 位元組和／或可編輯來源 |
| `render_pixel_asset` | ASCII Grid：內嵌 `gridText` 或 `gridPath` 檔案，兩者恰好擇一，另可加批次 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `apply_asset_operations` | 可編輯的 `.mcpx` 來源加操作陣列 | 選用的明確 PNG／`.mcpx` 路徑 | 已套用的數量與各操作的狀態；預設為原子（第一個失敗就全部回復） |
| `recolor_asset` | 可編輯的 `.mcpx` 來源或扁平 PNG、內建材質 id、選用的區域 id | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或重新上色後的來源，附變更計數 |
| `create_variants` | 可編輯的 `.mcpx` 來源或扁平 PNG、一個以上的內建材質 id | 必須明確指定的輸出目錄 | 每種材質各一份 `<stem>_<material>.png` 加 `.mcpx`，皆由原始來源產生 |
| `validate_asset` | 素材檔（PNG）、選用的明確 `.mcmeta` 路徑（原樣使用） | 無 | 附發現項目的唯讀判定 |
| `import_asset` | 點陣圖（PNG、JPEG、WebP）加選用的批次 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `build_asset` | 可編輯的 `.mcpx` 來源加選用的批次 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或建置後的來源 |
| `transform_asset` | 點陣圖或 `.mcpx`、一個幾何旗標（搭配選取範圍會回報 `ARGUMENT_CONFLICT`） | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `scale_gui_asset` | 點陣圖或 `.mcpx`、選用的明確 `.mcmeta` 路徑 | 選用的明確 PNG 路徑 | 縮放後的 PNG（明確路徑或內嵌位元組），附解析出的縮放摘要 |
| `quantize_asset` | 點陣圖或 `.mcpx`、色彩數 `colors` 或 `palette`（內建材質名或 `.mcpx` 路徑）恰選其一、選用的 `keepColors`（RGBA 物件）、選用的選取範圍 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `cleanup_asset` | 點陣圖或 `.mcpx`、選用的修復類別、選用的選取範圍 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `palette_asset` | 圖片、一種 `mode`（`extract`／`inspect`） | 無 | 唯讀報告：不重複色彩，或分佈、角色與對比 |
| `material_asset` | 無（`list`）或內建材質名稱（`show` 用 `mode` 加 `name`） | 無 | 唯讀報告：材質清單或色彩漸層 |
| `tile_asset` | 點陣圖或 `.mcpx`、選用的預覽網格與比對軸向 | 選用的明確 PNG 路徑 | 接縫與邊緣報告，或預覽 PNG |
| `generate_asset` | 無（圖樣加尺寸加調色盤加種子） | 選用的明確 PNG／`.mcpx` 路徑 | 確定性的程序化 PNG 位元組和／或可編輯來源 |
| `preview_asset` | 點陣圖或 `.mcpx`、一種 `mode`（`ascii`／`palette-map`／`scale`／`nine-slice`） | 選用的明確 PNG 路徑（`scale`、`nine-slice`） | 唯讀報告或預覽 PNG |
| `animate_asset` | 影格目錄或 sprite sheet、一種 `mode`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`） | 明確的 PNG 路徑（`pack`）或輸出目錄（`unpack`、`reorder`、`resize`） | Sheet PNG、影格或唯讀報告 |
| `validate_pack_asset` | 資源包根目錄，外加選用的原版資源樹與依賴根目錄 | 無 | 附發現項目與 coverage 物件的唯讀判定 |
| `inspect_asset` | 可編輯的 `.mcpx` 來源或點陣圖（點陣圖視為單一 base 圖層）、一種 `mode`（`structure`／`view`），view 另有 `crop` 與 `scale` | 無 | 唯讀報告（structure），或合成 PNG 的 image block 加 metadata（view） |
| `optimize_asset` | PNG 檔案（1 至 256 個明確路徑）或目錄（`inputDir`，最多 4096 個 PNG，可選 `recursive`） | 選用的明確 PNG 輸出路徑（限單一明確輸入），或既有的輸出目錄 | 逐檔報告（來源與結果大小、模式、候選編碼、區塊、警告）加總計；只有一個輸入且沒有輸出時內嵌 PNG 位元組 |
| `model_asset` | Java 方塊／物品模型 JSON、一種 `mode`（`inspect`／`validate`／`create`／`apply`／`export`／`preview`），可選的資源包、原版與依賴根目錄 | 選用的明確 `.json` 路徑（模型、物品定義、blockstate），或明確的 `.png` 路徑（`preview`） | 唯讀報告（`inspect`、`validate`），模型文件與產生的 binding（`create`、`apply`、`export`），或診斷三視圖 PNG（`preview`） |
| `mcmeta_asset` | PNG 精靈圖集（`animation`）或設計精靈圖（`gui`）、各模式參數、版本欄位 | 選用的明確 `.mcmeta` 輸出路徑（`force`、`mkdir`） | 產生的 `.mcmeta` 文字與中繼資料摘要（僅在有 `outputPath` 時寫檔） |
| `compare_assets` | 兩張同尺寸 PNG、`image`（`none`／`diff`）、`scale`（1–16） | 選用的明確 PNG 輸出路徑（`force`、`mkdir`；僅限 `image: "diff"`） | 比對報告（尺寸、原始與可見差異數、邊界框）及選用的標準 PNG 影像區塊（僅在有 `outputPath` 時寫檔） |
| `style_asset` | 內建風格預設與 `.style.json` 來源、一個 `mode`（`list`／`show`／`export-palette`／`create`） | 選用的明確 `.mcpx` 路徑（`export-palette`）或 `.style.json` 路徑（`create`） | 預設清單、解析後的風格、調色盤 `.mcpx` 文字或檔案，或已寫出的風格檔 |

## 輸入語意

- 每個檔案路徑都要明確指定。會產生檔案的工具不會自行決定檔名，唯讀工具則絕不寫入。
- `profile` 為 `generic`、`minecraft:item`、`minecraft:block`、`minecraft:gui`、`minecraft:particle` 其中之一；省略時視為 `generic`。
- `minecraftVersion`／`resourcePackVersion`（analyze、validate、validate-pack）用來選擇相容性行為，接受 release 版本 `1.19.3` 到 `26.3`（例如 `1.19.3`、`1.21.4`、`26.3`），以及資源包版本 `N` 或 `N.M`（例如 `84`、`97.1`），會正規化為 `major.minor`。省略時使用引擎預設值。
- 子命令工具把 CLI 模式合併為 `mode` 欄位：`palette_asset`（`extract`／`inspect`）、`material_asset`（`list`／`show`）、`style_asset`（`list`／`show`／`export-palette`／`create`）、`preview_asset`（`ascii`／`palette-map`／`scale`／`nine-slice`）、`animate_asset`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`）。
- `style_asset` 內建四個預設（`vanilla`、`soft`、`fairy-flat`、`dark-frame`），每個預設含十二家族與六角色（`outline`、`shadow`、`dark`、`base`、`light`、`highlight`）。`list` 回報預設，並可給 `paths` 一併回報能載入的自訂 `.style.json`；`paths` 中無法載入的檔案會讓整個呼叫以 `STYLE_INVALID` 失敗。`show` 取 `style`（內建 id 或 `.style.json` 路徑），回傳解析後的文件與 `extendsChain`。`export-palette` 取 `style` 與 `family`（家族 id 或 `all`）：沒有 `outputMcpxPath` 時回傳調色盤 `.mcpx` 文字，給了路徑則寫檔（`force` 可覆寫）。`create` 取 `outputPath` 與 `id`，另有選用的 `name`（預設為 id）、`extends`（預設 `vanilla`）、合併進文件的 `overrides`、`force` 與 `mkdir`。風格檔以嚴格模式讀取：未知欄位、列舉外的值，或不是 `#RRGGBB` 的顏色都是帶欄位路徑的 `STYLE_INVALID`；其餘另有查不到的 id（`STYLE_NOT_FOUND`）、`extends` 循環（`STYLE_INHERITANCE_CYCLE`）、版本過高（`STYLE_UNSUPPORTED_VERSION`）與家族不存在（`STYLE_FAMILY_NOT_FOUND`）。工具不會改寫自己沒有建立的風格檔。
- `apply_asset_operations` 接收操作物件陣列，每個物件都有一個 `type`（Core 批次詞彙：九個像素操作 `setPixel`、`clearPixel`、`drawLine`、`drawRect`、`fillRect`、`floodFill`、`ellipse`、`polygonFill`、`strokeMask`，另有圖層與區域操作、`stampRect`、`regionFromSelection` 等），再加該類型的參數。`atomic` 預設為 true；設為 false 時會跑完每個操作，以各操作的 applied／failed 狀態回報，不再回復。像素操作可附選用的 `selection` 表示式；空匹配以 `EMPTY_SELECTION` 拒絕寫入並回復整批。
- `apply_asset_operations` 另接受選用的 `feedback` 物件（`image`：`none`／`full`／`changed`；`scale`：整數 1–16；`crop`：選取範圍表示式；`diff`：`none`／`summary`）。不給 `feedback` 時，輸出欄位與位元組與過去完全相同。給了 `feedback` 時，結果攜帶 `feedback` 物件（`image`、`imageIncluded`、選用的 `noVisibleChange`、選用的 `diff`，含 `raw`／`composited`／`structural`／`outsideSelectionUnchanged`），且絕不內嵌 `pngBase64`：附帶的圖以標準 image content block（`type: "image"`、`mimeType: "image/png"`）傳送，文字區塊不重複攜帶位元組。`changed` 算繪合成後的變更邊界（忽略 crop），可見範圍沒有變化時以 `noVisibleChange` 代替圖片回報；參考線像素（格線、棋盤格）絕不寫入作品位元組。`crop` 配 `none` 為 `INVALID_ARGUMENT`。
- `inspect_asset` 接收 `inputPath` 加 `mode`：`structure` 回傳圖層（邊界、面積、可見性、原始 RGBA 色彩用量）、區域（識別、邊界，只報面積）與重疊；`view` 以 image block 回傳合成 PNG 加六鍵 metadata，crop／scale／1024px 邊界規則與頂層 `inspect` 指令相同。view 的 scale 預設為 1；長邊自動縮放只適用於 `apply_asset_operations` 的 feedback 圖。
- 扁平 PNG 來源給 `recolor_asset`／`create_variants` 時沒有調色盤角色資訊，像素依整數明度分段對應到目標材質調色盤（96 以下為暗部、96 到 159 為中間、160 以上為亮部），不會虛構圖層角色。全透明像素保持位元組不變，包含隱藏 RGB。缺少區域沿用既有的 `REGION_NOT_FOUND` 錯誤。每個變體都從同一個原始來源獨立產生，材質順序不影響結果；檔名為 `<stem>_<material>.png` 加 `<stem>_<material>.mcpx`。JPEG 與 WebP 仍會被拒絕。
- 完整的操作參數表見 [CLI Surface](cli-surface.zh-TW.md)的「批次操作規格」節；兩個介面共用同一種 JSON 形狀。`polygonFill` 最多 4096 個點，自交的環為 `SELF_INTERSECTING_POLYGON`，孔洞不支援。
- 選取範圍表示式可寫原子（`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`）或 JSON AST 物件（`op` 為 `union`／`intersect`／`subtract`／`invert`，加 `operands [...]`），深度上限 32、節點上限 1024。
- `scale_gui_asset` 接收 `size`（`N` 或 `WxH`）、選用的 `mcmetaPath`（省略即為 `stretch`）與選用的版本欄位；輸出只有 PNG。
- `optimize_asset` 接收 `inputPaths`（1 至 256 個明確的 PNG 檔案）或 `inputDir`（包含 PNG 的目錄，最多 4096 個 PNG，可選 `recursive` 且預設為 false）二擇一。兩者都給回報 `ARGUMENT_CONFLICT`，都沒給回報 `INVALID_ARGUMENT`。在目錄模式下：
  - 相對路徑嚴格按 UTF-8 位元組順序遍歷，並在 `outputDir` 下保留相對目錄結構。
  - 絕不跟隨符號連結：掃描範圍內任何符號連結回報 `FILESYSTEM_ERROR`（`symlink-not-supported`）。
  - 來源目錄與輸出目錄必須互不相交，不得互相包含或為別名（`ARGUMENT_CONFLICT`）。
  - 寫入前檢查資源預算：最多 4096 個 PNG、總來源 ≤ 256 MiB、總解碼像素 ≤ 16,777,216，超限回報 `RESOURCE_LIMIT_EXCEEDED`。
  - 一般非 PNG 檔案（`.mcmeta` 等）自動略過，不複製；目錄內無任何 PNG 檔案回報 `INVALID_ARGUMENT`。
  - 目錄模式只接受既有的 `outputDir`（MCP 絕不建立新目錄）或 `dryRun: true`；拒絕單檔 `outputPath` 或內嵌輸出。
- `optimize_asset` 其他欄位：選用的 `mode`（預設 `auto`，或 `rgba`、`rgb`、`grayscale`、`grayscale-alpha`、`indexed`）、`ancillary`（預設 `preserve`，或 `strip`）、`dryRun`、`outputPath`（只能用於單一明確輸入）與 `outputDir`（既有目錄）。清單模式下，多個輸入需要 `outputDir` 或 `dryRun`，否則回報 `INVALID_ARGUMENT`。強制的 `mode` 無法精確表示像素時是 `OPTIMIZE_MODE_NOT_EXACT`。
- `model_asset` 接收 `mode` 加上該模式需要的欄位：`inputPath`（`inspect`、`validate`、`apply`、`export`、`preview`）、`spec`（`create`）、`operations`（`apply`，1 至 1000 個）、`binding`（`export`）、`packPath`／`vanillaPath`／`dependencyPaths`（`inspect`、`validate`、`preview`；`export` 另可用 `packPath`）、`outputPath`、`itemOutputPath`、`blockstateOutputPath`。該模式不接受的欄位會回報 `INVALID_ARGUMENT`，並點名欄位與模式。模型支援範圍只含長方體 `elements`。
- `preview` 模式的 `model_asset` 以 `size`（64、128 或 256，預設 64）與選用的 `outputPngPath` 畫出固定的診斷圖。PNG 為三個正方形面板橫向排列（`front` 是從北方看北面，右側面板是從東方看東面，`top` 是從上方看上面且北方在上）。沒有 `outputPngPath` 時不寫檔，圖片以標準圖片塊回傳；給了 `outputPngPath` 時寫出檔案，文字部分只回傳報告。第一版限制與 CLI 相同（軸對齊長方體、精確 1/256 座標、既有 UV 與 0/90/180/270 面旋轉、缺貼圖用固定棋盤格、元素旋轉與半透明面及無法解析的貼圖列為 partial；`display` 與遊戲光照不套用）。
- `validate_pack_asset` 接收選用的 `vanillaPath` 與選用的有序 `dependencyPaths`（排前者優先）。
- `transform_asset`／`animate_asset` 的 `resizeMode` 接受 `nearest`／`box`／`pixel-aware`。
- 省略輸出路徑時，成品會內嵌在工具結果中（PNG 位元組、`.mcpx` 文字），不寫入磁碟。

## 輸出語意

- 唯讀工具（`analyze_asset`、`validate_asset`、`palette_asset`、`material_asset`、`validate_pack_asset`、`inspect_asset`）回傳報告；`validate_asset` 以 `fail` 加發現項目表示失敗，不會拋出錯誤。
- 驗證類報告帶 `coverage: {status, skipped}`；`partial` 會逐項列出略過的檢查及其種類與原因，且不改變狀態碼。
- 混合工具（`tile_asset`、`preview_asset`、`animate_asset`、`style_asset`）在唯讀模式回傳報告，在寫入模式只寫入明確指定的輸出路徑或目錄。`style_asset` 的 `list` 與 `show` 為唯讀，`export-palette` 與 `create` 只寫入明確指定的輸出路徑，它們讀取的風格來源檔不會被改寫。
- 會產生檔案的工具回傳已套用的數量、各操作的狀態、警告，以及實際寫出的明確路徑或內嵌的成品。
- `optimize_asset` 與 `model_asset` 不接受 `force`、`mkdir` 或原地覆寫：輸出已存在是 `OUTPUT_EXISTS`，缺少父目錄是 `FILESYSTEM_ERROR`。第一個位元組寫出之前，所有目標都已檢查完畢；與輸入互為別名、符號連結目標，以及父目錄是符號連結的情況都會被拒絕。多檔案寫入為逐檔原子提交，非跨檔交易：寫入中途失敗時已寫入的檔案保留，錯誤 details 回報 `completed`、`failedTarget` 與 `notStarted`。沒有輸出路徑時，結果內嵌成品（`pngBase64`、`modelText`、`itemText`、`blockstateText`）。
- `optimize_asset` 與 `model_asset` 只回報像素是否相同、結構與引用是否有效。沒有遊戲用戶端渲染過結果，所以外觀與遊戲內行為都未驗證。`preview` 模式的 `model_asset` 是診斷視圖，不是遊戲渲染器。

## 產生 mcmeta 設定

從 PNG 產生動畫或 GUI 縮放設定：

```sh
mc-asset mcmeta animation sheet.png --frame-size 16 --frametime 2 --frames '[0,{"index":1,"time":4},0]' --minecraft-version 1.21.2 --output sheet.png.mcmeta
mc-asset mcmeta gui panel.png --type nine_slice --border 4 --stretch-inner --resource-pack-version 42 --stdout
```

動畫必須指定 `--frame-size <N|WxH>`，影格只支援單排或單列，尺寸必須整除 PNG；不接受網格。`frametime` 預設 1，`frames` 接受索引或 `{index,time}` 物件，可重複或只播放部分影格；省略時依序播放全部影格。時間必須是正整數，索引不得越界；`--interpolate` 啟用插值。GUI 必須指定 `--type <stretch|tile|nine_slice>`，tile 與 nine_slice 以 PNG 尺寸作設計尺寸。nine_slice 必須指定 `--border <N|json>`，四邊 left、top、right、bottom 為非負整數，中央必須保留正面積；只有 nine_slice 接受 `--stretch-inner`。

CLI 必須明確選擇 `--output <path.mcmeta>` 或 `--stdout` 其中之一，不猜同名路徑。已存在的目標需要 `--force`，它會整檔替換，不保留其他區段；`--mkdir` 允許建立缺少的父目錄。來源 PNG 與無關的同名設定不變，輸入別名與符號連結會被拒絕。輸出只含指定區段，以固定鍵順序的緊湊 JSON 加一個結尾換行產生。

版本選項 `--minecraft-version` 與 `--resource-pack-version` 只能選一個。GUI scaling 需要 pack format 16.0，stretch_inner 需要 42.0；不相容會在輸出前回報 `ARGUMENT_CONFLICT`。未指定版本，或版本在 12.0 到 97.1 之外，會回報 `versionChecked: false` 與 `VERSION_NOT_CHECKED`，但不會跳過 GUI 最低版本限制。動畫依文件格式及歷史在表內標示已檢查，並非逐版遊戲用戶端實測。來源見[材質動畫與歷史](https://minecraft.wiki/w/Resource_pack#Texture_animation)（interpolate 在 14w25a 加入，早於支援表）、[GUI scaling](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w31a) 與 [pack format](https://minecraft.wiki/w/Pack_format)。這些檢查確認設定結構與已知版本相容性，不代表已驗證遊戲內外觀或行為。

### mcmeta_asset

指定 `mode`（`animation` 或 `gui`）與 `inputPath`（PNG）。 `animation`: `frameSize`, `frametime`, `frames`, `interpolate`; `gui`: `type`, `border`, `stretchInner`. 指定版本可用 `minecraftVersion` 或 `resourcePackVersion`。另一種模式的欄位（即使為 false）會回報 `INVALID_ARGUMENT`。`outputPath` 明確指定 `.mcmeta`，另可用 `force`、`mkdir`；省略路徑則回傳 `mcmetaText`，不寫檔。`force`、`mkdir` 必須搭配路徑。結果含 `mode`、`width`、`height`、`versionChecked`、`version`、`target`、`warnings`，以及 `output` 或 `mcmetaText`。

```json
{"mode":"gui","inputPath":"panel.png","type":"nine_slice","border":4,"stretchInner":true,"resourcePackVersion":"42"}
```

## 比較 PNG 的變動

```sh
mc-asset compare before.png after.png --json
mc-asset compare before.png after.png --output diff.png --scale 4
mc-asset compare before.png after.png --stdout --json > diff.png
```

只接受尺寸相同的 PNG；尺寸不同會回報 `INVALID_ARGUMENT`。沒有 `--output` 或 `--stdout` 時只回報告，不寫檔。使用 `--stdout` 時，PNG 位元組送到 stdout，報告送到 stderr。`--output` 與 `--stdout` 不能並用。

報告包含 `width`、`height`、`totalPixels`、`rawChangedPixels`、`visibleChangedPixels`、`rawBounds`、`visibleBounds`。原始差異逐一比較解碼後的 RGBA 通道，包含 alpha 為零時隱藏的 RGB。可見差異沿用既有 flatten 合成規則，但雙方 alpha 都是零時忽略 RGB。差異框以原圖座標表示為從零起算的 `{x,y,width,height}`，包含最後一個變動像素；沒有差異時為 `null`。

診斷 PNG 用洋紅色（`255,0,255,255`）標示可見差異，用青色（`0,255,255,255`）標示只有原始差異的像素，未變像素為透明（`0,0,0,0`）。這張圖是診斷標記，不是修改後的素材。`--scale` 接受 1 到 16 的整數，預設 1，只以 nearest 放大標記圖，不改報告統計。影像含放大後的長邊不得超過 1024 像素，超限回報 `RESOURCE_LIMIT_EXCEEDED`，不會自動縮圖。只回報告時沿用既有 PNG 解碼器限制。

兩個來源都不會改寫。明確輸出路徑必須以 `.png` 結尾；來源別名、符號連結目標或父目錄都會被拒絕。覆寫既有目標需要 `--force`，建立缺少的父目錄需要 `--mkdir`；這兩個旗標都需要檔案輸出路徑。所有輸出都會先通過預檢，才寫入檔案或送出 stdout 影像位元組。

### compare_assets

以 `beforePath`、`afterPath` 指定兩張同尺寸 PNG。`image` 為 `none`（預設，只回報告）或 `diff`；`scale` 是 1 到 16 的整數，預設 1。只有 `image: "diff"` 可使用 `outputPath`，將影像寫到明確的 `.png` 路徑，並可搭配 `force`、`mkdir`。diff 模式未給 `outputPath` 時，回傳 JSON 報告與標準 `image/png` 影像區塊，不在文字重複 Base64。`force`、`mkdir` 都需要 `outputPath`。

報告、標示色、原圖座標差異框、放大後 1024 像素限制、來源保護與錯誤，皆遵守上面的 PNG 比較規則。來源檔案不會改寫。

```json
{"beforePath":"before.png","afterPath":"after.png","image":"diff","scale":4}
```
