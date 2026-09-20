# MCP 介面（已凍結）

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

進入點：`mc-asset mcp` 會啟動 stdio MCP 伺服器。stdout 只輸出 MCP JSON-RPC，診斷訊息走 stderr，stdin 關閉時行程正常結束。伺服器直接掛在 Core 上，不重新實作任何影像邏輯。

工具名稱已凍結。早期草稿把批次編輯工具稱為 `edit_asset`，凍結後的名稱是 `apply_asset_operations`。

能力基礎：分析、帶預設集的像素化、ASCII Grid 渲染、具原子交易的批次操作、材質重新上色、變體展開，以及可明確指定 `--mcmeta` 的驗證。

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

## 輸入語意

- 每個檔案路徑都要明確指定。會產生檔案的工具不會自行決定檔名，唯讀工具則絕不寫入。
- `profile` 為 `generic`、`minecraft:item`、`minecraft:block`、`minecraft:gui`、`minecraft:particle` 其中之一；省略時視為 `generic`。
- `minecraftVersion`／`resourcePackVersion`（analyze、validate）用來選擇相容性行為，接受 `26.3` 與 packFormat `75`。
- `apply_asset_operations` 接收操作物件陣列，每個物件都有一個 `type`（Core 批次詞彙：`setPixel`、`drawLine`、`fillRect`、`floodFill`、圖層與區域操作等），再加該類型的參數。`atomic` 預設為 true。
- 省略輸出路徑時，成品會內嵌在工具結果中（PNG 位元組、`.mcpx` 文字），不寫入磁碟。

## 輸出語意

- 唯讀工具（`analyze_asset`、`validate_asset`）回傳報告；`validate_asset` 以 `fail` 加發現項目表示失敗，不會拋出錯誤。
- 會產生檔案的工具回傳已套用的數量、各操作的狀態、警告，以及實際寫出的明確路徑或內嵌的成品。
