# CLI 介面規格

[English](cli-surface.md) | [繁體中文](cli-surface.zh-TW.md) | [简体中文](cli-surface.zh-CN.md)

進入點：`mc-asset`（本機開發時可用 `bun src/cli/index.ts`）。

全域行為遵循確定性標準：通道分工、`OUTPUT_EXISTS`／`--force`／`--mkdir`、原子寫入，以及 `--force` 與 `--in-place` 互斥。狀態碼由 `src/core/errors.ts` 的錯誤碼註冊表統一定義。

---

## 全域旗標

```text
--json       將結構化 JSON 信封輸出至 stdout（若成品要走 stdout，則改輸出至 stderr）
--help       顯示說明並結束（狀態碼 0）
--version    顯示工具鏈版本（狀態碼 0）
```

---

## 通用檔案旗標（會產生檔案的指令）

所有會產生或修改檔案的指令，都遵守下列路徑與安全規則：

```text
--output <path>   明確指定輸出檔路徑（不會自動產生檔名）
--stdout          將成品位元組寫入 stdout（信封與日誌改走 stderr）
--force           允許覆寫既有目標（否則為 OUTPUT_EXISTS，狀態碼 4）
--mkdir           建立缺少的上層目錄（否則為 FILESYSTEM_ERROR，狀態碼 4）
--in-place        直接以輸入路徑為目標（與 --force 互斥）
--input <path>    未以位置引數提供輸入時，作為 --in-place 的輸入路徑
--profile <name>  素材設定檔：generic | minecraft:item | minecraft:block | minecraft:gui | minecraft:particle
```

### 安全與檔案系統保證

- **必須明確指定目標**：會產生檔案的指令若沒有 `--output`、`--stdout`、`--source` 或 `--in-place`，會回報 `OUTPUT_REQUIRED`（狀態碼 2），且不建立任何檔案。
- **正規化路徑比對**：目標路徑會先解析成絕對路徑，並做 Unicode NFC 與大小寫摺疊。輸出路徑與輸入別名衝突而未加 `--in-place`，或有重複的輸出目標，會在寫入任何位元組前回報 `ARGUMENT_CONFLICT`（狀態碼 2）。
- **逐檔原子提交**：每個輸出檔先寫入目標目錄中以 `O_EXCL` 建立的暫存檔，再以原子重新命名提交。寫入失敗不會留下不完整的成品。
- **Minecraft 設定檔限制**：Minecraft 材質設定檔（`minecraft:item`、`minecraft:block`、`minecraft:gui`、`minecraft:particle`）只接受 `.png` 輸出。副檔名不是 PNG 時，會以 `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT`（狀態碼 5）失敗。

---

## 指令參考

### 1. 匯入、編寫與來源建置

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `import <image>` | 點陣圖檔（PNG、JPEG、WebP） | PNG 和／或 `.mcpx` | 將點陣圖格式解碼成像素畫布。 |
| `render <grid>` | ASCII Grid 檔（`.grid`） | PNG 和／或 `.mcpx` | 編譯由人或 Agent 撰寫的 ASCII Grid。 |
| `build [source]` | `.mcpx` 來源檔或 stdin（`--stdin`） | PNG 和／或 `.mcpx` | 將可編輯的來源檔建置成材質，或重新序列化來源。 |

```text
import <image> [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
render <grid>  [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
build  [source] [--stdin] [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
```

- `--source <path>` 會儲存可編輯的 `.mcpx` 文字來源。
- `--in-place` 直接改寫輸入檔（對該目標等同 force）。
- `build --stdin` 與 `--operations -` 同時使用會回報 `ARGUMENT_CONFLICT`。

---

### 2. 空間與幾何變換

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `transform <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 空間變換：翻轉、旋轉、裁切、填補、縮放、平移。 |

```text
transform <input> [--flip <h|v>] [--rotate <90|180|270>] [--crop <x,y,w,h>]
                  [--pad <l,t,r,b>] [--pad-color <hex|transparent>]
                  [--resize <WxH>] [--resize-mode <nearest|box|pixel-aware>]
                  [--translate <dx,dy>] [--selection <scope>] <file flags>
```

- 每次呼叫只能使用**一個**幾何旗標，同時使用多個會回報 `ARGUMENT_CONFLICT`。
- `--selection` 將操作限定在 `rect:x,y,w,h` 或 `region:id`。幾何操作與 `--selection` 併用會回報 `ARGUMENT_CONFLICT`。

---

### 3. 調色盤、量化與清理

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `quantize <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 將相異顏色數量縮減到目標值。 |
| `cleanup <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 偵測或消除孤立點、雜訊與離群像素。 |
| `palette extract <image>` | PNG、JPEG、WebP、`.mcpx` | 僅報告 | 擷取圖像中不重複的 RGBA 顏色。 |
| `palette inspect <image>` | PNG、JPEG、WebP、`.mcpx` | 僅報告 | 分析調色盤分布、角色與對比。 |
| `material list` | 無 | 僅報告 | 列出可用的內建材質定義。 |
| `material show <name>` | 無 | 僅報告 | 檢視某個材質的色階與定義。 |
| `recolor <source>` | `.mcpx` | PNG 和／或 `.mcpx` | 將顏色重新對應到內建材質調色盤。 |
| `variant <source>` | `.mcpx` | `--output-dir` 下的多個檔案 | 產生材質變體（例如 iron、copper、gold）。 |

```text
quantize <input> --colors <N> [--selection <scope>] <file flags>
cleanup  <input> [--fix <classes>] [--allow-render-pass-change] [--selection <scope>] <file flags>
recolor  <source> --material <name> [--region <id>] <file flags>
variant  <source> --materials <a,b,...> --output-dir <dir> [--mkdir] [--force] [--profile <p>]
```

- `cleanup --fix <classes>`：以逗號分隔的類別清單（`isolated`、`noise`、`cluster`、`fringe`、`outlier`、`hole`、`aa`）。修改會影響 alpha 的類別時，必須加 `--allow-render-pass-change`。
- `palette` 與 `material` 子指令只輸出報告，收到檔案寫入旗標會被拒絕（`INVALID_ARGUMENT`）。

---

### 4. 像素畫管線

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `pixelize <image>` | PNG、JPEG、WebP | PNG 和／或 `.mcpx` | 確定性的 11 階段「點陣圖轉像素畫」管線。 |

```text
pixelize <image> --size <N|WxH> [--preset <item|block|gui|particle|generic>] <file flags>
```

- 必須指定目標 `--size`（Minecraft 常見的正方形尺寸 16、32、64、128，或自訂 `WxH`）。
- 預設集（preset）決定該用途的色彩預算、清理啟發，以及會啟用哪些管線階段。`item` 預設會啟用 crop、background、subject、edge、cluster；其餘預設維持既有輸出，位元不變。輸入是單一張點陣圖（不接受 `.mcpx`）；五個階段都在這一個圖層上執行。

---

### 5. 程序化生成、平鋪與預覽

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `tile <input>` | PNG、JPEG、WebP、`.mcpx` | 僅報告，或 PNG | 接縫分析、邊緣重複分析，或平鋪修復與預覽。 |
| `generate <pattern>` | 無 | PNG 和／或 `.mcpx` | 確定性的程序化材質產生器。 |
| `preview <input>` | PNG、JPEG、WebP、`.mcpx` | 僅報告，或 PNG | ASCII 預覽、調色盤對照、九宮格參考線，或最近鄰放大。 |
| `gui-scale <input>` | PNG、JPEG、WebP、`.mcpx` | PNG | 以 mcmeta 的 stretch／tile／nine_slice 映射，把 GUI 精靈圖縮放到明確的目標尺寸。 |

```text
tile     <input> [--preview <2x2|4x4|8x8>] [--edge-match <axis>] [--brightness-match <axis>]
                  [--output <png>] [--stdout] <file flags>
generate <pattern> --size <N|WxH> --palette <name|path> --seed <int>
                  [--output <png>] [--source <mcpx>] [--stdout] <file flags>
preview  <input> --ascii | --palette-map | --scale <N> | --nine-slice --mcmeta <path>
                  [--output <png>] [--stdout] <file flags>
gui-scale <input> --size <N|WxH> [--mcmeta <path>]
                  [--minecraft-version <v>|--resource-pack-version <f>]
                  [--output <png>] [--stdout] <file flags>
```

- `generate` 支援的確定性圖樣有 `noise`、`clustered-noise`、`stripes`、`checker`、`gradient`、`brick`、`spots`、`veins`、`cracks`、`grain`，並以 `--seed`（整數 0–4294967295）決定種子。
- `preview` 必須恰好指定一個模式旗標：
  - `--ascii`：輸出可與 `.grid` 互通的純 ASCII 文字。
  - `--palette-map`：輸出 JSON 調色盤索引。
  - `--scale <N>`：以最近鄰法放大並輸出 PNG。
  - `--nine-slice`：依 `.mcmeta` 評估 GUI 九宮格邊界，並附視覺參考線。
- `gui-scale` 以 `.mcmeta` 的 `gui.scaling`（stretch／tile／nine_slice）規則，把 GUI 精靈圖對應到明確的目標尺寸：
  - `--mcmeta` 必須是明確路徑，絕不推導同名檔；省略即為 `stretch`。
  - 輸出只有 PNG。
  - 九宮格邊框不合法為 `INVALID_MCMETA`（狀態碼 2）。
  - 目標版本早於 `stretch_inner`（資源包格式 42）且該欄位為 true 時，忽略該欄位並回報 `STRETCH_INNER_IGNORED` warning。
  - 既有的 `preview --nine-slice` 維持 guide preview 語意，兩者是不同入口。

---

### 6. 動畫與精靈圖集

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `animate pack` | 影格目錄（`.mcpx`） | PNG 精靈圖集 | 將單張影格合併成精靈圖集。 |
| `animate unpack <sheet>` | PNG 精靈圖集 | 影格目錄（`.mcpx`） | 將動畫圖集切成單張影格。 |
| `animate reorder` | 影格目錄 | 影格目錄 | 依索引清單重新排列動畫影格。 |
| `animate resize` | 影格目錄 | 影格目錄 | 縮放動畫組內的所有影格。 |
| `animate validate` | 影格目錄（加 `.mcmeta`） | 僅報告 | 依 `.mcmeta` 驗證影格尺寸、播放序列索引與每步時間；重複或部分的播放序列合法。 |
| `animate preview` | 影格目錄 | 報告或 ASCII 預覽 | 預覽動畫序列。 |

```text
animate pack     --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns <N>]
                 [--output <png>] [--stdout] <file flags>
animate unpack   <sheet.png> --layout <vertical|horizontal|grid> --frame-size <N|WxH>
                 [--columns <N>] [--mcmeta <path>] --output-dir <dir> <file flags>
animate reorder  --frames-dir <dir> --order <i,j,...> --output-dir <dir> <file flags>
animate resize   --frames-dir <dir> --frame-size <N|WxH> [--resize-mode <nearest|box|pixel-aware>]
                 --output-dir <dir> <file flags>
animate validate --frames-dir <dir> [--mcmeta <path>] [--profile <name>] [--json]
animate preview  --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns <N>]
                 [--ascii] [--profile <name>] [--json]
```

---

### 7. 檢查、驗證與資源包核對

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `analyze <image>` | PNG、JPEG、WebP | 僅報告 | 結構與色彩指標（預測分類）。 |
| `validate <asset>` | 素材檔（PNG） | 僅報告（有缺陷時狀態碼 3） | 驗證單一素材材質與選用的 `.mcmeta`。 |
| `validate-pack <path>` | 資源包根目錄 | 僅報告（有缺陷時狀態碼 3） | 完整掃描資源包的完整性、命名空間、模型、材質與圖集。 |

```text
analyze       <image> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
validate      <asset> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--mcmeta <path>] [--json]
validate-pack <path>  [--minecraft-version <v>] [--resource-pack-version <n>]
                       [--vanilla <path>] [--dependency <path>]... [--json]
```

- 驗證的狀態碼：通過為 0；驗證檢查失敗為 3（`VALIDATION_FAILED`）；呼叫語法錯誤為 2；檔案系統錯誤為 4。
- 版本指定：`--minecraft-version` 接受 release 版本 `1.19.3` 到 `26.3`（例如 `1.19.3`、`1.21.4`、`26.3`；每個 release 對應其資源包格式）；`--resource-pack-version` 接受 `N` 或 `N.M`（例如 `84`、`97.1`），會正規化為 `major.minor`。兩個旗標互斥，都不給則維持引擎預設。
- 版本回顯：人類可讀報告印出 `target: minecraft <v> / resource-pack <f>`、`target: resource-pack <f>` 或 `target: default (engine defaults)`；`--json` 攜帶 `version: { minecraftVersion?, resourcePackVersion? }`，皆為正規化後的 dotted 字串。
- 無旗標時的解析：不帶版本旗標的 `validate-pack` 會讀取根目錄 `pack.mcmeta`，依序取 `pack.max_format`、`pack.min_format`、舊制 `pack.pack_format`（整數、`[major, minor]` 陣列或 dotted 字串，皆正規化為 `major.minor`）；解析出的目標印為 `pack.mcmeta resource-pack <f>`。`supported_formats` 不參與目標選擇；沒有可用值時只警告一次（`PACK_VERSION_UNDETERMINED`），不套用任何預設。
- `--vanilla`：呼叫端提供的原版資源樹（pack 根目錄形狀，含 `assets/`）。提供後 `minecraft` 命名空間的參照會在該樹中確認；未提供時回報 `PACK_UNRESOLVED_EXTERNAL` warning 並記入 coverage，不再直接判為缺失。
- `--dependency`：依賴資源包的根目錄，可重複；第一個優先序最高。
- coverage：`validate` 與 `validate-pack` 的報告都帶 `coverage: {status, skipped}`；`partial` 表示有檢查因故略過（例如 `vanilla-not-provided`、`unsupported-source-type`、`unsupported-regex`、`unknown-node-type`、`renderer-fields-not-interpreted`、`version-undetermined`、`model-documents-not-loaded`），每個 skip 都帶 `kind`／`reason`／`target`。coverage 不改變狀態碼（通過仍為 0、失敗仍為 3）。texture variable 的解析只讀當前包的模型文件；超出該範圍的變數以 `model-documents-not-loaded` coverage 回報，不跨依賴或原版包解析。

---

### 8. Model Context Protocol（MCP）伺服器

```text
mc-asset mcp
```

啟動原生 Model Context Protocol（MCP）stdio 伺服器，供 LLM Agent 整合，提供 20 個原生工具，不需要另外啟動子行程：
- `analyze_asset`
- `pixelize_asset`
- `render_pixel_asset`
- `apply_asset_operations`
- `recolor_asset`
- `create_variants`
- `validate_asset`
- `import_asset`
- `build_asset`
- `transform_asset`
- `quantize_asset`
- `cleanup_asset`
- `palette_asset`
- `material_asset`
- `tile_asset`
- `generate_asset`
- `preview_asset`
- `animate_asset`
- `validate_pack_asset`
- `scale_gui_asset`

---

## 批次操作規格（`--operations`）

`import`、`render` 與 `build` 可透過 `--operations <path>` 或 `--operations -`（stdin）套用批次像素編輯。

格式為操作物件組成的 JSON 陣列：
```json
[
  { "type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF" },
  { "type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF" },
  { "type": "drawRect", "rect": { "x": 2, "y": 2, "width": 4, "height": 4 }, "color": "#0000FFFF" },
  { "type": "fillRect", "rect": { "x": 8, "y": 8, "width": 4, "height": 4 }, "color": "#FFFF00FF" },
  { "type": "floodFill", "x": 3, "y": 3, "color": "#FF00FFFF" },
  { "type": "clearPixel", "x": 0, "y": 0 }
]
```

同樣的 JSON 形狀也適用於 MCP 的 `apply_asset_operations`：可使用裸陣列或 `{"operations": [...]}` 包裹；空陣列是合法的無操作。每個操作都可附選用的字串 `id`（同一批次內不可重複）。單圖層畫布可省略 `layerId`（預設為唯一圖層）；多圖層畫布必須明確指定。色彩為 `transparent`、`#RRGGBB` 或 `#RRGGBBAA`；座標皆為整數，不做四捨五入。

| `type` | 必填鍵 | 選填鍵 | 範例 |
|---|---|---|---|
| `setPixel` | `x`、`y`、`color` | `layerId`、`id` | `{"type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF"}` |
| `clearPixel` | `x`、`y` | `layerId`、`id` | `{"type": "clearPixel", "x": 0, "y": 0}` |
| `drawLine` | `from`、`to`、`color` | `layerId`、`id` | `{"type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF"}` |
| `drawRect` | `rect`、`color` | `layerId`、`id` | `{"type": "drawRect", "rect": {"x": 2, "y": 2, "width": 4, "height": 4}, "color": "#0000FFFF"}` |
| `fillRect` | `rect`、`color` | `layerId`、`id` | `{"type": "fillRect", "rect": {"x": 8, "y": 8, "width": 4, "height": 4}, "color": "#FFFF00FF"}` |
| `floodFill` | `x`、`y`、`color` | `layerId`、`id` | `{"type": "floodFill", "x": 3, "y": 3, "color": "#FF00FFFF"}` |
| `createLayer` | （無） | `layerId`（新 id）、`name`、`id` | `{"type": "createLayer", "layerId": "shade"}` |
| `removeLayer` | `layerId` | `id` | `{"type": "removeLayer", "layerId": "shade"}` |
| `renameLayer` | `layerId`、`name` | `id` | `{"type": "renameLayer", "layerId": "shade", "name": "shadow"}` |
| `reorderLayer` | `layerId`、`toIndex` | `id` | `{"type": "reorderLayer", "layerId": "shade", "toIndex": 0}` |
| `duplicateLayer` | `layerId` | `newLayerId`、`name`、`id` | `{"type": "duplicateLayer", "layerId": "shade", "newLayerId": "shade-copy"}` |
| `mergeLayer` | `sourceId`、`targetId` | `id` | `{"type": "mergeLayer", "sourceId": "shade", "targetId": "base"}` |
| `clearLayer` | `layerId` | `id` | `{"type": "clearLayer", "layerId": "shade"}` |
| `fillLayer` | `layerId`、`color` | `id` | `{"type": "fillLayer", "layerId": "shade", "color": "#0000FFFF"}` |
| `moveLayer` | `layerId`、`dx`、`dy` | `id` | `{"type": "moveLayer", "layerId": "shade", "dx": 1, "dy": -1}` |
| `createRegion` | （無） | `regionId`（新 id）、`name`、`id` | `{"type": "createRegion", "regionId": "mask"}` |
| `removeRegion` | `regionId` | `id` | `{"type": "removeRegion", "regionId": "mask"}` |
| `renameRegion` | `regionId`、`name` | `id` | `{"type": "renameRegion", "regionId": "mask", "name": "cutout"}` |
| `reorderRegion` | `regionId`、`toIndex` | `id` | `{"type": "reorderRegion", "regionId": "mask", "toIndex": 0}` |
| `setRegionPixel` | `regionId`、`x`、`y`、`value` | `id` | `{"type": "setRegionPixel", "regionId": "mask", "x": 1, "y": 2, "value": 1}` |

`from`／`to` 為 `[x, y]` 整數對；`rect` 為 `{x, y, width, height}`，寬高至少為 1；`toIndex` 為 0 或正整數；`value` 為 `0`（外部）或 `1`（內部）。未知的 `type` 為 `INVALID_ARGUMENT`；重複的 `id` 為 `DUPLICATE_OPERATION_ID`。

批次執行是原子的：只要有一個操作無效，就會回復所有變更。

---

## 狀態碼註冊表

| 狀態碼 | 類別 | 說明 | 範例 |
|---|---|---|---|
| **0** | 成功 | 指令順利完成。 | 驗證全數通過、成功渲染。 |
| **1** | 內部錯誤 | 未處理的引擎缺陷（`INTERNAL_ERROR`）。 | 引擎發生非預期失敗。 |
| **2** | 無效呼叫 | 語法錯誤、旗標衝突、缺少必要參數。 | 缺少 `--output`、同時使用 `--force --in-place`。 |
| **3** | 素材驗證失敗 | 引擎執行正常，但素材或資源包未通過驗證。 | `VALIDATION_FAILED`、材質損壞、`.mcmeta` 有誤。 |
| **4** | 檔案系統拒絕 | 檔案已存在且未加 `--force`，或缺少目錄且未加 `--mkdir`。 | `OUTPUT_EXISTS`、`FILESYSTEM_ERROR`。 |
| **5** | 不支援／資源上限 | 輸入格式不支援，或超出畫布上限。 | 圖檔標頭損毀、`UNSUPPORTED_IMAGE_FORMAT`。 |
