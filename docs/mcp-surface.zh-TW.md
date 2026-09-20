# MCP 介面（已凍結）

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

進入點：`mc-asset mcp` 會啟動 stdio MCP 伺服器。stdout 只輸出 MCP JSON-RPC，診斷訊息走 stderr，stdin 關閉時行程正常結束。伺服器直接掛在 Core 上，不重新實作任何影像邏輯。

工具名稱已凍結。早期草稿把批次編輯工具稱為 `edit_asset`，凍結後的名稱是 `apply_asset_operations`。

目前版本（`v0.3.0`）新增十二個工具（`import_asset` 到 `validate_pack_asset`；`palette_asset`、`material_asset`、`preview_asset`、`animate_asset` 把 CLI 子命令合併為 `mode` 欄位），達成與 CLI 完全對等。名稱與輸入形狀在此凍結；執行中的伺服器已提供全部十九個工具。

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
| `transform_asset` | 點陣圖或 `.mcpx`、一個幾何旗標、選用的選取範圍 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `quantize_asset` | 點陣圖或 `.mcpx`、必需的色彩數、選用的選取範圍 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `cleanup_asset` | 點陣圖或 `.mcpx`、選用的修復類別、選用的選取範圍 | 選用的明確 PNG／`.mcpx` 路徑 | PNG 位元組和／或可編輯來源 |
| `palette_asset` | 圖片、一種 `mode`（`extract`／`inspect`） | 無 | 唯讀報告：不重複色彩，或分佈、角色與對比 |
| `material_asset` | 無（`list`）或內建材質名稱（`show` 用 `mode` 加 `name`） | 無 | 唯讀報告：材質清單或色彩漸層 |
| `tile_asset` | 點陣圖或 `.mcpx`、選用的預覽網格與比對軸向 | 選用的明確 PNG 路徑 | 接縫與邊緣報告，或預覽 PNG |
| `generate_asset` | 無（圖樣加尺寸加調色盤加種子） | 選用的明確 PNG／`.mcpx` 路徑 | 確定性的程序化 PNG 位元組和／或可編輯來源 |
| `preview_asset` | 點陣圖或 `.mcpx`、一種 `mode`（`ascii`／`palette-map`／`scale`／`nine-slice`） | 選用的明確 PNG 路徑（`scale`、`nine-slice`） | 唯讀報告或預覽 PNG |
| `animate_asset` | 影格目錄或 sprite sheet、一種 `mode`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`） | 明確的 PNG 路徑（`pack`）或輸出目錄（`unpack`、`reorder`、`resize`） | Sheet PNG、影格或唯讀報告 |
| `validate_pack_asset` | 資源包根目錄 | 無 | 附發現項目的唯讀判定 |

## 輸入語意

- 每個檔案路徑都要明確指定。會產生檔案的工具不會自行決定檔名，唯讀工具則絕不寫入。
- `profile` 為 `generic`、`minecraft:item`、`minecraft:block`、`minecraft:gui`、`minecraft:particle` 其中之一；省略時視為 `generic`。
- `minecraftVersion`／`resourcePackVersion`（analyze、validate、validate-pack）用來選擇相容性行為，接受 `1.21.11` 到 `26.3`，以及資源包版本 `N` 或 `N.M`（例如 `84`、`97.1`），會正規化為 `major.minor`。省略時使用引擎預設值。
- 子命令工具把 CLI 模式合併為 `mode` 欄位：`palette_asset`（`extract`／`inspect`）、`material_asset`（`list`／`show`）、`preview_asset`（`ascii`／`palette-map`／`scale`／`nine-slice`）、`animate_asset`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`）。
- `apply_asset_operations` 接收操作物件陣列，每個物件都有一個 `type`（Core 批次詞彙：`setPixel`、`drawLine`、`fillRect`、`floodFill`、圖層與區域操作等），再加該類型的參數。`atomic` 預設為 true。
- 省略輸出路徑時，成品會內嵌在工具結果中（PNG 位元組、`.mcpx` 文字），不寫入磁碟。

## 輸出語意

- 唯讀工具（`analyze_asset`、`validate_asset`、`palette_asset`、`material_asset`、`validate_pack_asset`）回傳報告；`validate_asset` 以 `fail` 加發現項目表示失敗，不會拋出錯誤。
- 混合工具（`tile_asset`、`preview_asset`、`animate_asset`）在唯讀模式回傳報告，在寫入模式只寫入明確指定的輸出路徑或目錄。
- 會產生檔案的工具回傳已套用的數量、各操作的狀態、警告，以及實際寫出的明確路徑或內嵌的成品。
