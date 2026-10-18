# CLI 介面規格

[English](cli-surface.md) | [繁體中文](cli-surface.zh-TW.md) | [简体中文](cli-surface.zh-CN.md)

## 目錄

- [全域旗標](#全域旗標)
- [通用檔案旗標（會產生檔案的指令）](#通用檔案旗標會產生檔案的指令)
  - [安全與檔案系統保證](#安全與檔案系統保證)
- [指令參考](#指令參考)
  - [1. 匯入、編寫與來源建置](#1-匯入編寫與來源建置)
  - [2. 空間與幾何變換](#2-空間與幾何變換)
  - [3. 調色盤、量化與清理](#3-調色盤量化與清理)
  - [4. 像素畫管線](#4-像素畫管線)
  - [5. 程序化生成、平鋪與預覽](#5-程序化生成平鋪與預覽)
  - [6. 動畫與精靈圖集](#6-動畫與精靈圖集)
  - [7. 檢查、驗證與資源包核對](#7-檢查驗證與資源包核對)
  - [8. Model Context Protocol（MCP）伺服器](#8-model-context-protocolmcp伺服器)
  - [9. PNG 最佳化與 Java 模型](#9-png-最佳化與-java-模型)
- [批次操作規格（`--operations`）](#批次操作規格--operations)
- [狀態碼註冊表](#狀態碼註冊表)
- [常見錯誤排查指南（Troubleshooting）](#常見錯誤排查指南troubleshooting)

---

進入點：`mc-asset`（本機開發時可用 `bun src/cli/index.ts`）。

全域行為遵循確定性標準：通道分工、`OUTPUT_EXISTS`／`--force`／`--mkdir`、原子寫入，以及 `--force` 與 `--in-place` 互斥。狀態碼由 `src/core/errors.ts` 的錯誤碼註冊表統一定義。

各版本的變更（包括每個指令與操作何時加入）記錄在 [`CHANGELOG.md`](../CHANGELOG.md)。

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
| `pack init <dir>` | 無 | 專案骨架 | 產生專案檔、資源包根 metadata、佔位圖示與資源包目錄。 |
| `pack build` | 專案檔（`mc-asset.pack.json`）、配方 | 資源包材質、物品定義與 lock 檔 | 依配方建置資源包專案，並以 lock 檔追蹤產物。 |

```text
import <image> [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
render <grid>  [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
build  [source] [--stdin] [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
pack init <dir> --namespace <ns> --minecraft-version <version> [--name <name>] [--description <text>]
       [--style <id|path>] [--resource-pack-version <N>] [--allow-minecraft-namespace]
pack build [--project <file>] [--recipe <file>] [--dry-run] [--json]
```

- `pack init <dir>` 一次預檢後整批寫出骨架：專案根目錄的專案檔 `mc-asset.pack.json`、依目標版本產生的 `pack/pack.mcmeta`、64x64 的 `pack/pack.png` 佔位圖示，以及目錄 `recipes/`、`pack/assets/<ns>/textures/item`、`pack/assets/<ns>/textures/block`、`pack/assets/<ns>/models/item`，資源包格式 46.0 起再多了 `pack/assets/<ns>/items/`。`--namespace` 與 `--minecraft-version` 必填，其餘設定都有預設值（專案名取自目錄名、說明取自專案名、風格為 `vanilla`、輸出目錄為 `pack`、配方目錄為 `recipes`）。
- 專案檔記錄 `formatVersion`、`name`、`description`、`namespace`、`allowMinecraftNamespace`、`minecraftVersion`、`resourcePackVersion`、`style`、`outputDir`、`recipeDir` 與 `vanillaSource`，並以嚴格模式讀取：未知欄位、不符合型別的值，或跑出專案根的路徑都是 `PACK_PROJECT_INVALID` 並帶欄位路徑；讀不到檔案是 `PACK_PROJECT_NOT_FOUND`；`formatVersion` 較新是 `PACK_PROJECT_UNSUPPORTED_VERSION`。`--resource-pack-version` 會覆寫版本對應的資源包格式，但發布版本號仍會留在專案檔裡；建立之後沒有任何指令會改寫這個檔案。
- 根 metadata 依目標版本選擇寫法：資源包格式 65.0 起只宣告該目標的 `min_format` 與 `max_format`，不寫舊式的 `pack_format`；更早的版本只寫單一舊式格式號。產生的文件會先在記憶體內跑一遍與 `validate-pack` 相同的根 metadata 規則，有問題就不寫檔。版本不在 `1.19.3` 到 `26.3` 之間是 `INVALID_ARGUMENT` 並帶上版本號，而且不會寫任何檔案。
- 每個預定路徑都會在寫入第一個位元組前先讀過。已經存在的路徑會讓整批拒絕，回 `PACK_INIT_CONFLICT` 並附上 `conflicts` 清單（列出所有已存在的相對路徑），所以重跑不會只覆寫一半；專案目錄本身或其下任何位置是符號連結時是 `FILESYSTEM_ERROR`，而且永遠不會寫穿連結。`init` 沒有 `--force` 也沒有 `--mkdir`：專案只建立一次。
- `namespace: minecraft` 會覆寫遊戲本身的素材，因此需要 `--allow-minecraft-namespace`；沒給時是 `PACK_PROJECT_INVALID`，欄位指向 `namespace`。
- 佔位圖示是原創的 64x64 圖樣，用整數幾何畫出（棋盤底、帶外框的方板、菱形標記），因此同一次請求永遠寫出相同的位元組。
- `pack build [--project <file>] [--recipe <file>] [--dry-run]` 依配方建置資源包專案。`--project` 指定專案檔，省略時預設為目前目錄的 `./mc-asset.pack.json`（這是工具鏈中唯一允許的隱含路徑，其餘仍要求明確路徑）。`--recipe` 指定單一配方檔；省略時依檔名字元組序讀取 `recipeDir` 下的所有 `*.recipe.json`。
- 建置採三段式執行：
  1. *解析與計畫*：讀取專案檔、配方、解析後的風格、lock 檔（`mc-asset.lock.json`）與來源檔；在記憶體完成變數展開、調色盤映射與所有驗證，不寫入任何位元組。
  2. *分類*：將每個預定產物比對 lock 檔與磁碟現況，劃入四個分類：`new`（未記錄且不存在；預定寫入）、`own-clean`（已記錄且輸出雜湊相符；輸入未變則跳過，輸入變更則預定重寫）、`own-modified`（已記錄但磁碟檔案遭修改；使用者修改衝突）、`foreign`（未記錄但磁碟已有檔案；外部檔案衝突）。若有任何產物為 `own-modified` 或 `foreign`，整批以 `PACK_BUILD_CONFLICT`（exit 4）拒絕，一個位元組都不寫，並在 `details.conflicts` 完整列出衝突路徑。
  3. *寫入*：先對全部目標進行 safe-output 唯讀預檢（拒絕符號連結、路徑別名與目錄衝突）；全部通過後才以暫存檔加 rename 原子寫入各檔案，最後再原子更新 `mc-asset.lock.json`。
- `--dry-run` 執行至分類階段為止，不寫入任何檔案與 lock 檔，僅回報分類統計與預定輸出清單。
- 建置錯誤碼：`RECIPE_INVALID`（語法、欄位、變數未用或佔位符錯誤；exit 2）、`RECIPE_UNSUPPORTED_VERSION`（配方檔版本過新；exit 5）、`RECIPE_OUTPUT_CONFLICT`（展開後輸出路徑重複；exit 2）、`RECIPE_VERSION_UNSUPPORTED`（目標格式不支援產物，如 46.0 前的物品定義；exit 2）、`RECIPE_SOURCE_MISSING`（來源檔或原版素材目錄不存在；exit 4）、`PACK_BUILD_CONFLICT`（產物分類衝突；exit 4）、`PACK_LOCK_INVALID`（lock 檔損壞；exit 4）、`PACK_LOCK_UNSUPPORTED_VERSION`（lock 檔版本過新；exit 5）。資源預算上限（單次建置輸出最多 4096 檔、來源總計 256 MiB、解碼像素 16M）觸發 `RESOURCE_LIMIT_EXCEEDED`（exit 5）。

- `--source <path>` 會儲存可編輯的 `.mcpx` 文字來源。
- `--in-place` 直接改寫輸入檔（對該目標等同 force）。
- `build --stdin` 與 `--operations -` 同時使用會回報 `ARGUMENT_CONFLICT`。
- 關於可編輯的 `.mcpx` v1 與 `.grid` 語法、規範段落順序、精簡／標記網格規則及錯誤碼，請參閱 [`docs/mcpx-format.zh-TW.md`](mcpx-format.zh-TW.md)。

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
- `--selection` 將操作限定在選取範圍表示式：`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`，或 JSON 表示式物件 `{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`（以 `{` 開頭走 JSON 路徑，其餘解析為原子）。幾何操作與 `--selection` 併用會回報 `ARGUMENT_CONFLICT`。

---

### 3. 調色盤、量化與清理

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `quantize <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 將相異顏色數量縮減到目標值，或對應到指定調色盤；保留色維持不變。 |
| `cleanup <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 偵測或消除孤立點、雜訊與離群像素。 |
| `palette extract <image>` | PNG、JPEG、WebP、`.mcpx` | 僅報告 | 擷取圖像中不重複的 RGBA 顏色。 |
| `palette inspect <image>` | PNG、JPEG、WebP、`.mcpx` | 僅報告 | 分析調色盤分布、角色與對比。 |
| `material list` | 無 | 僅報告 | 列出可用的內建材質定義。 |
| `material show <name>` | 無 | 僅報告 | 檢視某個材質的色階與定義。 |
| `recolor <source>` | `.mcpx`、PNG | PNG 和／或 `.mcpx` | 將顏色重新對應到內建材質調色盤。 |
| `variant <source>` | `.mcpx`、PNG | `--output-dir` 下的多個檔案 | 產生材質變體（例如 iron、copper、gold）。 |
| `style list` | 無 | 僅報告 | 列出內建風格預設。 |
| `style show <style>` | 無 | 僅報告 | 把某個風格（內建 id 或 `.style.json` 路徑）解析成完整 JSON。 |
| `style export-palette <style>` | 無 | `.mcpx` 調色盤檔 | 把單一家族或全部家族的調色盤寫成 `.mcpx`。 |
| `style create` | 無 | `.style.json` 檔 | 寫出新的風格檔。 |
| `style lint <path>` | PNG、JPEG、WebP、`.mcpx` | 僅報告 | 量測一張圖並對照風格回報 findings。 |

```text
quantize <input> (--colors <N> | --palette <name|path>) [--keep-color <r,g,b,a> ...] [--selection <scope>] <file flags>
cleanup  <input> [--fix <classes>] [--allow-render-pass-change] [--selection <scope>] <file flags>
recolor  <source> (--material <name> | --family <name>) [--style <id|path>] [--region <id>] [--selection <scope>] <file flags>
variant  <source> (--materials <a,b,...> | --families <a,b,...>) [--style <id|path>] [--output-dir <dir>] [--selection <scope>] [--region <id>] [--name-template <tmpl>] [--mkdir] [--force] [--profile <p>]
style list
style show <style>
style export-palette <style> --family <id|all> --output <file.mcpx> [--force] [--mkdir]
style create --output <file.style.json> --id <id> [--name <name>] [--extends <id|path>] [--force] [--mkdir]
style lint <path> [--style <id|path>] [--category <name>] [--json]
```

- `quantize` 必須恰好給 `--colors` 或 `--palette` 其中之一：兩者並用是 `ARGUMENT_CONFLICT`，都沒給是 `INVALID_ARGUMENT`。`--palette` 接受內建材質名或 `.mcpx` 路徑（最多 4096 色，依宣告順序，含未使用項目）。每個像素依整數 RGBA 平方距離對應到最近的項目；距離相同取較前項，alpha 為 0 的隱藏 RGB 也參與。
- `--keep-color <r,g,b,a>`（可重複）讓該 RGBA 完全不變。搭配 `--palette` 時，保留色必須是盤中項目（否則 `INVALID_ARGUMENT`）。搭配 `--colors` 時，每層只把選取範圍內實際出現的不重複保留色計入預算，其餘選取像素用剩餘預算量化；預算用完則映射到保留色，保留色多於預算會在寫入前回 `INVALID_ARGUMENT`。使用 `--keep-color` 或 `--palette` 時，`--selection` 會把預算與映射限制在選取像素，範圍外位元組不變。
- 盤色檔是唯讀輸入，任何輸出旗標（含 `--force`、`--in-place`）都不能覆寫它。量化用的盤色可能與寫出的 `.mcpx` 宣告盤不同，後者沿用畫布原有的盤。`--json` 結果在使用時會多出 `palette` 與 `keepColors`（RGBA 物件）；`colorCount` 是各層量化盤色數的最大值。
- `cleanup --fix <classes>`：以逗號分隔的類別清單（`isolated`、`noise`、`cluster`、`fringe`、`outlier`、`hole`、`aa`）。修改會影響 alpha 的類別時，必須加 `--allow-render-pass-change`。
- `palette` 與 `material` 子指令只輸出報告，收到檔案寫入旗標會被拒絕（`INVALID_ARGUMENT`）。
- `recolor` 與 `variant` 接受可編輯的 `.mcpx` 來源或扁平 PNG。`recolor` 必須指定 `--material <name>` 或 `--family <name>` 二擇一（都缺為 `INVALID_ARGUMENT`，都給為 `ARGUMENT_CONFLICT`）。`variant` 必須至少給 `--materials <list>` 或 `--families <list>` 其中之一（都缺為 `INVALID_ARGUMENT`；兩者可並存產出聯集，產出檔名若重複則回報 `ARGUMENT_CONFLICT`）。`--name-template <tmpl>` 支援 `{stem}` 與 `{name}`（預設為 `{stem}_{name}`）。既有材質路徑下，PNG 像素依整數明度分段對應目標材質調色盤（96 以下為暗部、96 到 159 為中間、160 以上為亮部）。配色盤家族路徑下（`--family`／`--families`，可帶 `--style` 或預設 `vanilla`），帶 role 來源的 role 直接對應家族同名 role（`outline`、`shadow`、`dark`、`base`、`light`、`highlight`），`accent` 與 `custom` 依六段整數明度分段處理；平面 PNG 依六段整數明度分段對應（<43 outline、43–85 shadow、86–127 dark、128–170 base、171–213 light、≥214 highlight）；外框像素（四鄰貼透明或邊界）一律強制改寫為目標家族的 `outline` 色；全透明像素（alpha 為 0）保持位元組不變，包含隱藏 RGB；半透明像素強制覆寫為完全不透明色盤色。`--region` 限定作用區域（區域外像素原樣還原，找不到區域回報 `REGION_NOT_FOUND`）；`--selection` 限定寫回範圍，未選取像素原樣還原。JPEG 與 WebP 仍會被拒絕（`INVALID_ARGUMENT`）。`variant` 的每個變體都從同一個原始來源獨立產生；輸入檔不會被修改；所有檔案目標會在寫入前先做聯合預檢。
- `style` 有四個內建預設：`vanilla`、`soft`、`fairy-flat`、`dark-frame`。每個預設都含十二家族（`iron`、`gold`、`diamond`、`netherite`、`copper`、`wood`、`stone`、`emerald`、`amethyst`、`redstone`、`lapis`、`quartz`），每家族六個角色（`outline`、`shadow`、`dark`、`base`、`light`、`highlight`），以及外框、光向、明暗階數、高光、抖動與動畫規則。風格來源可以是內建 id，也可以是 `.style.json` 路徑；自訂檔透過 `extends` 繼承一個來源（最多八層），可覆寫單一欄位、整個家族或分類門檻。
- `style list` 與 `style show` 只輸出報告，不寫任何檔案。`style show` 印出解析後的文件：`formatVersion`、`id`、`name`、`description`、`palettes`、`outline`、`light`、`limits`、`highlight`、`dither`、`animation`、`categoryOverrides`，以及從所求來源一路走到基底所走的 `extendsChain`。
- `style export-palette --family <id|all> --output <file.mcpx>` 寫出調色盤文件：每列一個家族、每欄一個角色，`[palette]` 依家族再角色排序、`.` 排在最前對應 `#00000000`，並帶 `kind = palette`。輸出可直接餵給 `quantize --palette` 與 `generate --palette`。指定解析後不存在的家族是 `STYLE_FAMILY_NOT_FOUND`；沒給 `--output` 則是 `OUTPUT_REQUIRED`。
- `style create` 先讓文件通過驗證，再寫出 `{formatVersion, id, name, extends}`（`extends` 預設為 `vanilla`），寫入同樣走共用輸出保護：目標必須以 `.style.json` 結尾、既有檔案需要 `--force`、父目錄不存在需要 `--mkdir`，而且目標不得是它所繼承的來源。工具不會改寫自己沒有建立的風格檔，其他指令也不會寫風格檔。
- `style lint <path>` 會量測一張圖並對照指定風格（預設 `vanilla`）。報告先給 `metrics`（不透明像素數、相異顏色數、明度階數、動態範圍、TL-BR 光向、覆蓋率、最小邊距、內側外框像素數、外框明度差與色相差、色相箱、高光像素數與比例、緩衝率、抖動比例、主軸與其二階矩、`firstFrameOnly`），再給 `findings`。每筆 finding 都帶 `code`、`level`、`measured`、`threshold`、`message` 與 `suggestion`。除 `STYLE_COLOR_BUDGET` 外全部是 warning，而它也是唯一能讓這次執行失敗的碼；判定為 `pass`、`warnings` 或 `fail`，`fail` 的離開碼與驗證失敗相同（3）。沒有可比較對象的指標不產生 finding，只在 `skipped` 加一筆（`no-opaque-pixels`、`animation-first-frame-only`）。`--category` 會套用該類別的門檻覆寫；未指定時，類別層級的規則（例如主軸角度）不檢查。動畫直條只量第一格，並以 `firstFrameOnly` 標示。
- 風格檔以嚴格模式讀取：未知欄位、列舉外的值，或不是 `#RRGGBB` 的顏色都是 `STYLE_INVALID`，並帶欄位路徑（例如 `palettes.stone.base: expected #RRGGBB, got "#12345"`）。讀不到或解析失敗的檔案、版本高於支援範圍的 `formatVersion`（`STYLE_UNSUPPORTED_VERSION`）、`extends` 循環（`STYLE_INHERITANCE_CYCLE`）、`id` 撞到內建預設名稱，以及查不到的內建 id（`STYLE_NOT_FOUND`），都會帶上檔案路徑、欄位路徑與解析鏈。

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
- `gui-scale`以 `.mcmeta` 的 `gui.scaling`（stretch／tile／nine_slice）規則，把 GUI 精靈圖對應到明確的目標尺寸：
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
| `animate sweep <image>` | PNG 靜態圖 | 垂直精靈圖集 PNG（可另加 `.mcmeta`） | 讓一條反光帶掃過一張靜態圖，第 0 格是原圖。 |
| `animate unpack <sheet>` | PNG 精靈圖集 | 影格目錄（`.mcpx`，`--format png` 時每格一張 PNG） | 將動畫圖集切成單張影格。 |
| `animate reorder` | 影格目錄 | 影格目錄 | 依索引清單重新排列動畫影格。 |
| `animate resize` | 影格目錄 | 影格目錄 | 縮放動畫組內的所有影格。 |
| `animate validate` | 影格目錄（加 `.mcmeta`） | 僅報告 | 依 `.mcmeta` 驗證影格尺寸、播放序列索引與每步時間；重複或部分的播放序列合法。 |
| `animate preview` | 影格目錄 | 報告或 ASCII 預覽，`--output` 另寫出圖集 PNG | 預覽動畫序列。 |
| `mcmeta animation` | PNG 精靈圖集（單行或單列，不接受 `.mcpx`） | `.mcmeta` 文字（不接受 `.json`） | 依 PNG 尺寸產生 `animation` 區段，或以時間軸預設展開 `frames`。只讀取 PNG。 |
| `mcmeta gui` | PNG 設計圖 | `.mcmeta` 文字（不接受 `.json`） | 依設計尺寸產生 `gui.scaling`。只讀取 PNG。 |

```text
animate pack     --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns <N>]
                 [--output <png>] [--stdout] <file flags>
animate sweep    <image.png> [--angle <45|90|135|180>] [--width <N>] [--color <#RRGGBB>]
                 [--frames <N>] [--frametime <N>] [--hold-ticks <N>] [--style <id|path>]
                 [--output <png>] [--stdout] [--output-mcmeta <path>] <file flags>
animate unpack   <sheet.png> --layout <vertical|horizontal|grid> --frame-size <N|WxH>
                 [--columns <N>] [--format <mcpx|png>] [--mcmeta <path>] --output-dir <dir> <file flags>
animate reorder  --frames-dir <dir> --order <i,j,...> --output-dir <dir> <file flags>
animate resize   --frames-dir <dir> --frame-size <N|WxH> [--resize-mode <nearest|box|pixel-aware>]
                 --output-dir <dir> <file flags>
animate validate --frames-dir <dir> [--mcmeta <path>] [--profile <name>] [--json]
animate preview  --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns <N>]
                 [--output <png>] [--ascii] [--profile <name>] [--json]
```

- `animate sweep` 輸出一張垂直圖集：第 0 格是原圖，之後每一格把反光帶往下一個位置推進。`--angle` 只接受 45、90、135、180，其餘角度直接拒絕；條帶座標在 135 度是 `x - y`、45 度是 `x + y`、90 度是 `x`、180 度是 `y`，兩個對角角度每格前進兩個座標單位，水平與垂直每格前進一個。`--width` 是條帶寬度像素數（1 到 8），`--color` 是一個不透明的 `#RRGGBB`，`--frames` 是含第 0 格的總格數（1 到 64）。只有完全不透明的來源像素會被覆蓋，所以整張圖集的輪廓、透明度平面與 alpha 0 底下的隱藏色維持逐位元組相同。`--style` 指定內建預設 id 或 `.style.json` 檔案（預設 `vanilla`）以取得動畫預設值，單一旗標只覆蓋其中一項。`--output-mcmeta` 另外寫出同伴文件，其中的 `frames` 依解析後風格的時間軸預設展開。`--output` 與 `--stdout` 至少要有一個。
- `mcmeta animation` 的 `--preset` 用具名時間軸展開 `frames`，取代手寫清單：`hold-and-sweep` 讓第 0 格停留 `--hold-ticks`（預設 100）拍再往前播，`ping-pong` 去程與回程不重複兩端，`pulse` 在去程與回程於兩端各停一拍。`--preset` 與 `--frames` 互斥（`ARGUMENT_CONFLICT`）；單格或兩格的圖集展開時不會重複端點；清單中的裸索引維持原樣，由 `--frametime` 決定它們的停留時間。
- `animate unpack --format png` 在 `--output-dir` 下每格寫出一張 PNG；預設仍是 `.mcpx`，其他值一律 `INVALID_ARGUMENT`。檔名沿用既有的補零規則（`frame_0.png` 到 `frame_9.png`）。`animate preview --output <png>` 依報告描述的同一種版面寫出圖集圖片；不帶 `--output` 時不寫任何檔案，報告內容完全不變。

---

### 7. 檢查、驗證與資源包核對

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `analyze <image>` | PNG、JPEG、WebP | 僅報告 | 結構與色彩指標（預測分類）。 |
| `inspect <input>` | PNG、JPEG、WebP、`.mcpx` | 僅報告（`--json` 的 view 另附 PNG 位元組） | 凍結的結構報告或合成後的 view（唯讀）。 |
| `validate <asset>` | 素材檔（PNG） | 僅報告（有缺陷時狀態碼 3） | 驗證單一素材材質與選用的 `.mcmeta`。 |
| `validate-pack <path>` | 資源包根目錄 | 僅報告（有缺陷時狀態碼 3） | 完整掃描資源包的完整性、命名空間、模型、材質與圖集。 |
| `compare <before> <after>` | 兩張同尺寸 PNG | 僅報告或診斷 PNG（`--output`、`--stdout`） | 比較兩張同尺寸 PNG，回報原始 RGBA 與可見差異像素數及差異框。 |

```text
analyze       <image> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
inspect       <input> --mode <structure|view> [--crop <scope>] [--scale <N>] [--json]
validate      <asset> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--mcmeta <path>] [--json]
validate-pack <path>  [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--vanilla <path>] [--dependency <path>]... [--json]
compare       <before> <after> [--output <path>] [--stdout] [--scale <N>] [--force] [--mkdir] [--json]
```

- 驗證的狀態碼：通過為 0；驗證檢查失敗為 3（`VALIDATION_FAILED`）；呼叫語法錯誤為 2；檔案系統錯誤為 4。
- 版本指定：`--minecraft-version` 接受 release 版本 `1.19.3` 到 `26.3`（例如 `1.19.3`、`1.21.4`、`26.3`；每個 release 對應其資源包格式）；`--resource-pack-version` 接受 `N` 或 `N.M`（例如 `84`、`97.1`），會正規化為 `major.minor`。兩個旗標互斥，都不給則維持引擎預設。
- 版本回顯：人類可讀報告印出 `target: minecraft <v> / resource-pack <f>`、`target: resource-pack <f>` 或 `target: default (engine defaults)`；`--json` 攜帶 `version: { minecraftVersion?, resourcePackVersion? }`，皆為正規化後的 dotted 字串。
- 無旗標時的解析：不帶版本旗標的 `validate-pack` 會讀取根目錄 `pack.mcmeta`，依序取 `pack.max_format`、`pack.min_format`、舊制 `pack.pack_format`（整數、`[major, minor]` 陣列或 dotted 字串，皆正規化為 `major.minor`）；解析出的目標印為 `pack.mcmeta resource-pack <f>`。`supported_formats` 不參與目標選擇；沒有可用值時只警告一次（`PACK_VERSION_UNDETERMINED`），不套用任何預設。
- `pack.mcmeta` 結構：`validate-pack` 把解析出的根目錄 `pack.mcmeta` 拿去對遊戲行為。`PACK_MCMETA_INVALID`（錯誤，會讓掃描失敗）處理遊戲拒絕載入的寫法：缺少 `pack` 區段或 `pack.description`、`min_format`／`max_format` 只寫一半、負值或上下顛倒的範圍、與宣告範圍不一致的 `supported_formats`（含 `min_format` 在 65 之後仍保留該欄位）、落在宣告 major 之外的舊制 `pack_format`、字元超出 `[-_a-zA-Z0-9.]` 的 overlay 目錄名，以及違反舊格式規則的 overlay `formats` 欄位（任一條目低於 65 時每條都要寫，無人低於 65 時一律不得寫）。`PACK_MCMETA_SUSPICIOUS`（警告，本身不會讓掃描失敗）處理載入正常但疑似失誤的寫法：pack 根目錄沒有的 overlay 目錄、完全沒寫版本欄位的 overlay 條目、落在宣告範圍外的掃描目標。遊戲接受的值一律不報：超過已知版本的 `max_format`，以及語法不涵蓋的寫法——掃描只報它能證明的缺陷，不能證明的就安靜。
- overlay 覆蓋率：版本範圍涵蓋掃描目標的 overlay 不解讀，記一筆 `overlay`／`overlay-not-interpreted` skip 加一則 `PACK_COVERAGE_SKIPPED` 警告，契約與其他 skip 相同（coverage 本身不改變 verdict）。宣告了但根目錄沒有的目錄只警告不記 skip；沒有解析出目標時不記任何 skip。
- `--vanilla`：呼叫端提供的原版資源樹（pack 根目錄形狀，含 `assets/`）。提供後 `minecraft` 命名空間的參照會在該樹中確認；未提供時回報 `PACK_UNRESOLVED_EXTERNAL` warning 並記入 coverage，不再直接判為缺失。
- `--dependency`：依賴資源包的根目錄，可重複；第一個優先序最高。
- coverage：`validate` 與 `validate-pack` 的報告都帶 `coverage: {status, skipped}`；`partial` 表示有檢查因故略過（例如 `vanilla-not-provided`、`unsupported-source-type`、`unsupported-regex`、`unknown-node-type`、`renderer-fields-not-interpreted`、`version-undetermined`、`model-documents-not-loaded`、`resource-type-not-interpreted: <類型>`、`trim-overrides-not-interpreted`、`particle-atlas-customized`、`internal-reference`、`pattern-reference`、`provider-not-interpreted`、`version-not-determined`、`feature-version-unknown`、`feature-not-in-version`、`unexpected-shape`、`overlay-not-interpreted`），每個 skip 都帶 `kind`／`reason`／`target`。每個 skip 也會同時以一則 `PACK_COVERAGE_SKIPPED` 警告回報。coverage 本身不改變狀態碼也不改變 verdict（通過仍為 0、失敗仍為 3）。texture variable 的解析只讀當前包的模型文件；超出該範圍的變數以 `model-documents-not-loaded` coverage 回報，不跨依賴或原版包解析。在 `assets/<命名空間>/` 之下，掃描會讀取 `textures`、`models`、`blockstates`、`items`、`atlases`、`equipment`、`particles`、`font`；`lang` 為惰性，不讀也不損失；其他頂層類型一律未解讀，會讓 coverage 變 `partial`，每個類型一筆 `uninterpreted-resource` skip（`resource-type-not-interpreted: <類型>`）加一則警告。裝備 `layers.<部位型別>[].texture` 解析到 `textures/entity/equipment/<部位型別>/<路徑>.png`（`models/equipment/` 只在 pack format 42.0 視為裝備定義；`equipment/` 在 46.0 之後讀取）；粒子 `textures[]` 解析到 `textures/particle/<路徑>.png`；字型 `bitmap.file` 解析到 `textures/` 之下、`reference.id` 解析到另一個 `font/*.json`（pack format 15.0 之後讀取）、`ttf.file` 解析到 `font/` 之下。在 item 定義不可用的 46.0 以前版本，舊式模型 `overrides[].model` 會解析，缺模型時為 `PACK_BROKEN_REFERENCE` 錯誤；46.0 之後完全不動。限制：包或依賴自帶 `atlases/particles.json` 時粒子缺檔退成 skip，不檢查粒子貼圖；`trim_overrides[].texture` 只記 skip、不解析；字型 `reference` 的 15.0 界線與粒子 `#` 內部參照規則是未經證實的推論；三個型別的最早版本未查證，舊但已知的版本仍可能報錯；惰性清單目前只有 `lang`，含其他未解讀類型的包會看到 `partial`；本工具沒有在遊戲用戶端載入驗證過。
- 貼圖引用：模型貼圖 ID 中的點保留為名稱的一部分（`item/foo.v2` 解析到 `textures/item/foo.v2.png`），結尾明確帶 `.png` 的輸入仍相容。字型 `bitmap.file` 是明確檔案路徑，直接使用原值。裝備、粒子與字型的非法資源位置保留 `PACK_WRONG_PATH`、`PACK_NAMESPACE_PROBLEM`、`PACK_INVALID_FILENAME` 或 `PACK_CASE_MISMATCH`，不再改成 `PACK_BROKEN_REFERENCE`；空字串維持 `PACK_BROKEN_REFERENCE`。確定缺檔與形狀不符的 skip 維持原有分類。
- 系統檔忽略：`assets/` 下的作業系統中繼資料檔案與封存映像（`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*` AppleDouble 檔案與 `__MACOSX` 目錄）在資源包掃描時直接忽略，不產生任何 finding、不記錄 coverage skip，也不改變 verdict。
- 未解讀資源目錄：位於 `assets/<命名空間>/<未解讀類型>/` 目錄內的檔案跳過所有逐檔檢查（檔名、JSON 語法、圖檔解碼與錯位檢查皆不再回報）；每個（命名空間，類型）保留一筆 `uninterpreted-resource` coverage skip 與一則 `PACK_COVERAGE_SKIPPED` 警告。直接位於命名空間目錄底下的檔案、`assets/` 根目錄的命名空間層級問題，以及已解讀類型（例如 `models/`）內放錯位置的檔案，皆維持原本的代碼與嚴重性層級回報。
- 原版貼圖覆蓋：提供 `--vanilla` 且原版樹存在同路徑貼圖時，覆蓋原版的貼圖不再觸發 `PACK_ORPHAN_TEXTURE`；未提供 `--vanilla` 時維持原樣，且原版樹中不存在的新自訂貼圖仍會收到警告。
- 模板模型與貼圖變數：被 `blockstates` 或 `items` 定義直接當作最終模型使用、且整條父模型鏈都無法解析的貼圖變數，仍會回報 `PACK_BROKEN_REFERENCE` 錯誤；只當作父模型使用、且子模型有在 `textures` 中提供該變數的模板模型，不產生任何 finding；未被任何定義或子模型使用且變數未解析的模型，以及單檔 `model validate`／`model inspect` 無從得知子模型時，回報 `PACK_UNRESOLVED_VARIABLE` 警告（狀態碼 0，不影響掃描判定結果）。提供 `--vanilla` 時，原版 `blockstates` 或 `items` 定義引用的被覆蓋模型亦視為最終模型。
- 圖集執行期貼圖：模型引用的貼圖若無對應檔案，但可由資源包內或原版 atlas 的 `paletted_permutations` 項目在執行期產生時，不再回報 `PACK_MISSING_TEXTURE`；沒有任何 atlas 能產生時維持原有的錯誤代碼與嚴重性層級；缺少 atlas 資訊時則維持現行行為。
- `inspect` 為唯讀，不接受檔案旗標（`INVALID_ARGUMENT`）：`--mode structure`（預設）回報圖層（id、名稱、索引、原始 alpha 邊界、面積、可見性、不透明度、混合模式、原始 RGBA 色彩用量，含 alpha 為 0 下隱藏的色彩，截斷至穩定的前 16 色）、區域（id、名稱、索引、邊界，只報面積）與重疊（圖層方框交集加實際區域遮罩交集）；`--mode view` 以 `--crop <scope>`（選取範圍表示式；空匹配為 `EMPTY_SELECTION`）與 `--scale <N>`（整數 1–16，最近鄰；預設 1）算繪合成像素，在 `--json` 下回傳六鍵 metadata（`mode`、`sourceDimensions`、`crop`、`scale`、`outputDimensions`、`colorFormat`）加 `pngBase64`。長邊自動縮放（縮放前長邊低於 128 時往 128 補整數倍，上限 16）只適用於 `apply_asset_operations` `feedback` 圖，不適用 `inspect view`。輸出任一邊超過 1024px 時以 `RESOURCE_LIMIT_EXCEEDED` 拒絕並提示改用較小的 crop，不會靜默縮小。頂層 `inspect` 與 `palette inspect`（調色盤特徵）是不同入口，不要混淆。

---

### 8. Model Context Protocol（MCP）伺服器

```text
mc-asset mcp
```

啟動原生 Model Context Protocol（MCP）stdio 伺服器，供 LLM Agent 整合，提供原生工具，不需要另外啟動子行程：
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
- `inspect_asset`
- `optimize_asset`
- `model_asset`
- `mcmeta_asset`
- `compare_assets`

---

### 9. PNG 最佳化與 Java 模型

| 指令 | 輸入 | 輸出 | 說明 |
|---|---|---|---|
| `optimize <input...>` | 1 至 256 個明確的 PNG 檔案 | 寫到明確新路徑的 PNG，或只出報告（`--dry-run`） | 無損重新編碼成能精確表示像素的最小編碼；沒有更小的就保留來源位元組。 |
| `optimize --input-dir <dir>` | 包含 PNG 的目錄（最多 4096 個 PNG，`--recursive`） | 保留相對目錄結構寫到 `--output-dir`，或只出報告（`--dry-run`） | 依 UTF-8 位元組順序掃描 PNG，檢查預算上限（256 MiB 來源、16,777,216 解碼像素），無損重新編碼各檔案。 |
| `model inspect <file>` | Java 方塊／物品模型 JSON | 只出報告 | 描述 parent、textures、elements、display 變換與解析後的引用。 |
| `model validate <file>` | Java 方塊／物品模型 JSON | 只出報告（有缺陷時退出碼 3） | 檢查結構、UV、旋轉、display 變換與引用是否有效。 |
| `model create` | 模型描述（`--spec`） | 模型 JSON | 依明確的描述建立模型文件。 |
| `model apply <file>` | 模型 JSON 加型別化操作（`--operations`） | 模型 JSON | 全部操作成功才寫出新文件，否則一個都不套用。 |
| `model export <file>` | 模型 JSON，可選 binding（`--binding`） | 模型 JSON、物品定義、blockstate | 把模型放進資源包，並在旁邊產生物品定義與 blockstate。 |
| `model preview <file>` | Java 方塊／物品模型 JSON | 診斷 PNG（正面、右側、上面） | 從長方體 `elements` 畫出固定的三視圖診斷圖。 |

```text
optimize     <input...> (--output <png> | --output-dir <dir> | --stdout | --dry-run)
                        [--mode <auto|rgba|rgb|grayscale|grayscale-alpha|indexed>]
                        [--ancillary <preserve|strip>] [--force] [--mkdir] [--json]
optimize     --input-dir <dir> [--recursive] (--output-dir <dir> | --dry-run)
                        [--mode <auto|rgba|rgb|grayscale|grayscale-alpha|indexed>]
                        [--ancillary <preserve|strip>] [--force] [--mkdir] [--json]
model inspect  <file> [--pack <dir>] [--vanilla <dir>] [--dependency <dir>]...
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model validate <file> [--pack <dir>] [--vanilla <dir>] [--dependency <dir>]...
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model create   --spec <file|-> (--output <json> | --stdout) [--force] [--mkdir]
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model apply    <file> --operations <file|-> (--output <json> | --stdout) [--force] [--mkdir]
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model export   <file> [--output <json>] [--binding <file|->] [--item-output <json>]
                      [--blockstate-output <json>] [--pack <dir>] [--force] [--mkdir]
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model preview  <file> [--pack <dir>] [--vanilla <dir>] [--dependency <dir>]...
                      [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--size <64|128|256>] (--output <png> | --stdout) [--force] [--mkdir] [--json]
```

- `optimize` 的輸入：可傳入明確的 PNG 路徑清單（1 至 256 個檔案；不展開萬用字元、不走目錄），或傳入 `--input-dir <dir>`（可選 `--recursive`，最多 4096 個 PNG）。兩者都給會回報 `ARGUMENT_CONFLICT`；都沒給回報 `INVALID_ARGUMENT`。未指定 `--input-dir` 卻給 `--recursive` 回報 `ARGUMENT_CONFLICT`。
- 清單模式下，格式依簽名判斷，不是 PNG 的檔案會回報 `UNSUPPORTED_IMAGE_FORMAT`。同一個檔案出現兩次，或兩個輸入在 `--output-dir` 下檔名相同，會回報 `ARGUMENT_CONFLICT`。
- 目錄模式（`--input-dir`）：
  - 按 UTF-8 位元組順序遍歷相對路徑，輸出目錄保留原目錄結構。建立中間輸出目錄需明確帶 `--mkdir`。
  - 絕不跟隨符號連結：掃描範圍內任何符號連結（含來源根目錄）或讀取失敗一律回報 `FILESYSTEM_ERROR`（`symlink-not-supported`）。
  - 來源與輸出根目錄必須互不相交：兩者不得為別名（含大小寫別名），也不得互相包含，違者回報 `ARGUMENT_CONFLICT`。
  - 寫入前檢查資源預算：最多 4096 個 PNG、總來源大小上限 256 MiB（268,435,456 位元組）、總解碼像素上限 16,777,216，並沿用單圖大小限制。任一超限皆回報 `RESOURCE_LIMIT_EXCEEDED` 且不自動分批。
  - 一般非 PNG 檔案（如 `.mcmeta`、`.txt`、`.json`）自動略過，不複製也不修改；目錄內無任何 PNG 檔案回報 `INVALID_ARGUMENT`。
  - 目錄模式只接受 `--output-dir` 或 `--dry-run`；單檔輸出（`--output`）或 `--stdout` 會回報 `ARGUMENT_CONFLICT`。
  - 在 `--dry-run` 下，不建立目錄、不寫檔案，也不碰非 PNG 檔案（`.mcmeta` 等），直接回傳所有 PNG 的計算報告。
- `optimize` 的輸出：清單模式下 `--output`（單一輸入）、`--output-dir`（每個輸入寫成 `<dir>/<輸入檔名>`）、`--stdout`（單一輸入）、`--dry-run`（只算報告、不寫檔）必須恰好一個。都沒給是 `OUTPUT_REQUIRED`，多於一個是 `ARGUMENT_CONFLICT`。沒有 `--in-place`：輸入檔永遠不會被改寫。
- `--mode auto`（預設）選出能精確表示像素的最小編碼，或保留來源位元組；指定模式會強制該編碼，若無法精確表示像素則回報 `OPTIMIZE_MODE_NOT_EXACT`（退出碼 5）。`--ancillary preserve`（預設）複製中繼資料區塊，並拒絕區塊內容依賴色彩配置的來源；`strip` 會丟棄所有輔助區塊並列出被丟棄的項目。
- `optimize` 分三個階段：先整批預檢所有輸出路徑，再於記憶體內算完所有輸入，最後才寫檔。任何一個輸入算失敗，就整批都不寫，錯誤的 `details` 列出 `processed` 與 `notProcessed`。寫檔中途失敗時，已寫入的檔案保留（多檔寫入為單檔原子提交，非跨檔交易），`details` 列出 `completed`、`failedTarget` 與 `notStarted`。無法縮小的檔案（`unchanged`）仍會以來源位元組寫出，`--dry-run` 除外。
- 人類可讀輸出每個檔案一行：`ok optimize input=<p> output=<p|-> status=<s> source=<bytes> result=<bytes> mode=<mode>`；警告另起一行 `warning [CODE] message`。`--json` 帶相同的結果，另含每個檔案的 `candidates`、`preservedChunks`、`strippedChunks` 與 `totals`。
- `model inspect` 與 `model validate` 唯讀，不接受輸出旗標。`inspect` 一律退出 0；`validate` 在判定為 `fail` 時退出 3。給了 `--pack` 時，`<file>` 必須位於 `<pack>/assets/<命名空間>/models/` 之下；沒給版本旗標時，版本依 `pack.mcmeta` 推定（沒有可用的值就視為版本不明，不套預設）。
- `model create`／`model apply` 從檔案或 `-`（stdin；每個指令最多一個 `-`）讀 JSON，並且 `--output` 與 `--stdout` 必須恰好一個。它們只檢查文件本身，不接受 `--pack`、`--vanilla`、`--dependency`。模型支援範圍只含長方體 `elements`。
- `model export` 至少要有 `--output`、`--item-output`、`--blockstate-output` 其中之一。`--item-output` 需要 `binding.item`（反過來也一樣），`--blockstate-output` 需要 `binding.blockstate`。`binding.item` 需要明確的版本且資源包格式在 46.0 以上，否則回報 `MODEL_UNSUPPORTED_VERSION`（退出碼 5）。`--pack` 會加上佈局與邊界檢查。`--force` 不適用於 `--item-output`、`--blockstate-output`，這兩個檔案永遠不會被覆寫。
- `model preview` 畫出固定的診斷圖：三個正方形面板橫向排列（`front`、右側、`top`），每個面板邊長為 `--size`（64、128 或 256，預設 64），所以 PNG 寬為 `size * 3`、高為 `size`。`front` 是從北方看北面，右側面板是從東方看東面，`top` 是從上方看上面且北方在上。只畫軸對齊的長方體 `elements`、既有 UV 與 0/90/180/270 的面旋轉，使用整數投影加深度緩衝；座標必須是精確的 1/256 倍數。父鏈與貼圖變數沿用既有的解析脈絡。缺失的貼圖以固定棋盤格填滿該矩形並發出警告；元素旋轉、非 1/256 座標、半透明面與無法解析的貼圖會列在 `coverage.skipped`（`partial`），不會默默畫錯。`display` 變換與遊戲光照不會套用。`--output` 與 `--stdout` 必須恰好一個（都沒給是 `OUTPUT_REQUIRED`，兩個都給是 `ARGUMENT_CONFLICT`）；`size` 不是 64/128/256 是 `INVALID_ARGUMENT`。模型與貼圖只會被讀取，不會被改寫。
- 共用的寫入保護（`optimize` 與 `model`）：第一個位元組寫出之前，所有目標都已檢查完畢。與輸入或其他輸出互為別名、目標是目錄、目標是符號連結（含懸空的，帶 `--force` 也一樣）、直接父目錄是符號連結，以及 `model export` 時位於 `--pack` 之外的路徑，都會被拒絕。已存在的檔案除非 `--force` 適用，否則回報 `OUTPUT_EXISTS`。每個檔案仍以原子改名提交。
- 報告只驗證結構與引用是否有效。沒有任何東西在遊戲用戶端裡渲染過模型，所以外觀、光照與遊戲內行為都未驗證。`model preview` 是診斷視圖，不是遊戲渲染器。

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
  { "type": "clearPixel", "x": 0, "y": 0 },
  { "type": "ellipse", "rect": { "x": 1, "y": 1, "width": 6, "height": 4 }, "color": "#FF0000FF", "mode": "fill" },
  { "type": "polygonFill", "points": [[0, 0], [4, 0], [2, 3]], "color": "#00FF00FF" },
  { "type": "strokeMask", "layerId": "base", "source": "alpha:base", "color": "#FFFFFFFF" },
  { "type": "outline", "layerId": "base", "mode": "tinted", "family": "gold" }
]
```

同樣的 JSON 形狀也適用於 MCP 的 `apply_asset_operations`：可使用裸陣列或 `{"operations": [...]}` 包裹；空陣列是合法的無操作。每個操作都可附選用的字串 `id`（同一批次內不可重複）。單圖層畫布可省略 `layerId`（預設為唯一圖層）；多圖層畫布必須明確指定（`regionFromSelection`、`mergeLayer` 與區域操作不接受 `layerId`）。色彩為 `transparent`、`#RRGGBB` 或 `#RRGGBBAA`；座標皆為整數，不做四捨五入。

九個像素操作都可附選用的 `selection`（選取範圍表示式的原子字串或物件，文法與 `--selection` 相同）。只有被選中的像素會寫入；未被選中的原始位元組原樣保留，含 alpha 為 0 下隱藏的 RGB。`fillRect` 在有 `selection` 時可省略 `rect`（填滿範圍取選取範圍的邊界框，再以選取範圍裁剪）。這三種形狀遵守凍結的整數幾何與選取裁剪：`ellipse` 沿 `rect` 內接的橢圓填滿或描邊（`mode` 必填，`fill` 或 `outline`）；`polygonFill` 填滿 `points` 圍出的多邊形；`strokeMask` 在 `layerId` 上描出 `source` 選取讀取範圍的輪廓，不繪製範圍本身。`outline` 也接受同樣的選用 `selection`，且只畫被選中的外框格。選取範圍一個像素都沒命中時，以 `EMPTY_SELECTION` 拒絕寫入並回復整批；`quantize`／`cleanup`／`recolor` 的 `--selection` 路徑維持既有的還原行為。

選取範圍表示式可寫原子（`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`）或 JSON AST 物件（`{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`），深度上限 32、節點上限 1024。

| `type` | 必填鍵 | 選填鍵 | 範例 |
|---|---|---|---|
| `setPixel` | `x`、`y`、`color` | `layerId`、`selection`、`id` | `{"type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF"}` |
| `clearPixel` | `x`、`y` | `layerId`、`selection`、`id` | `{"type": "clearPixel", "x": 0, "y": 0}` |
| `drawLine` | `from`、`to`、`color` | `layerId`、`selection`、`id` | `{"type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF"}` |
| `drawRect` | `rect`、`color` | `layerId`、`selection`、`id` | `{"type": "drawRect", "rect": {"x": 2, "y": 2, "width": 4, "height": 4}, "color": "#0000FFFF"}` |
| `fillRect` | `color`（有 `selection` 時可省略 `rect`） | `layerId`、`rect`、`selection`、`id` | `{"type": "fillRect", "rect": {"x": 8, "y": 8, "width": 4, "height": 4}, "color": "#FFFF00FF"}` |
| `floodFill` | `x`、`y`、`color` | `layerId`、`selection`、`id` | `{"type": "floodFill", "x": 3, "y": 3, "color": "#FF00FFFF"}` |
| `ellipse` | `rect`、`color`、`mode`（`fill`／`outline`） | `layerId`、`selection`、`id` | `{"type": "ellipse", "rect": {"x": 1, "y": 1, "width": 6, "height": 4}, "color": "#FF0000FF", "mode": "fill"}` |
| `polygonFill` | `points`（`[x, y]` 整數對陣列）、`color` | `layerId`、`selection`、`id` | `{"type": "polygonFill", "points": [[0, 0], [4, 0], [2, 3]], "color": "#00FF00FF"}` |
| `strokeMask` | `layerId`、`source`（選取範圍表示式）、`color` | `selection`、`id` | `{"type": "strokeMask", "layerId": "base", "source": "alpha:base", "color": "#FFFFFFFF"}` |
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
| `stampRect` | `layerId`、`source`、`to`／`offset` 擇一 | `transform`（`flip`：`h`／`v`；`rotate`：`0`／`90`／`180`／`270`）、`merge`（預設 `replace`／`source-over`）、`carryRegions`（預設 false）、`selection`、`id` | `{"type": "stampRect", "layerId": "base", "source": "rect:8,8,8,8", "offset": {"dx": 0, "dy": 8}}` |
| `regionFromSelection` | `selection`、`mode`（`create`／`update`） | `regionId`、`name`、`id` | `{"type": "regionFromSelection", "selection": "alpha:base", "mode": "create", "regionId": "body"}` |
| `outline` | `layerId`；`mode` 為 `uniform` 時須有 `color`（`#RRGGBB`） | `mode`（預設 `tinted`／`selective`／`uniform`／`black`／`strip`）、`position`（預設 `inside`／`outside`）、`family`、`luminanceDropPermille`（預設 120，0..400）、`saturationRatioPermille`（預設 1000，0..2000）、`maxHueOffsetDegrees`（預設 5，0..180）、`snapFamilies`（預設 true）、`selection`、`id` | `{"type": "outline", "layerId": "base", "mode": "tinted", "family": "gold"}` |

`outline` 替 `layerId` 上非全透明的像素畫外框：`inside`（預設）改寫本體邊緣的像素，`outside` 則畫在貼著本體的空像素上，範圍與外側描邊相同。`tinted`（預設）在整數 HSL 空間把相鄰本體色調暗，明度依 `luminanceDropPermille` 下降、飽和度依 `saturationRatioPermille` 縮放；`selective` 只在背光面使用同一個推導色，光源在左上時也就是 `x >= cx` 或 `y >= cy`，其中 `cx`、`cy` 是本體座標的整數平均；`uniform` 用 `color` 填滿外框，此模式必填 `color`，其他模式給了會被視為錯誤；`black` 填滿不透明純黑；`strip` 把每個本體邊緣像素換成最暗的相鄰內部像素，藉此移除既有的外框，不透明像素的數量完全不變，空像素的隱藏位元組也原樣保留。每個外框格讀取的是這次不會被改寫的本體像素——`inside` 讀內部像素，`outside` 讀相鄰的本體像素——讀不到就維持原色。`family` 接受十二個內建家族之一（`iron`、`gold`、`diamond`、`netherite`、`copper`、`wood`、`stone`、`emerald`、`amethyst`、`redstone`、`lapis`、`quartz`）；`snapFamilies` 為 true 時，推導出的外框色會對齊該家族在內建原版色階中較接近的 `outline` 或 `shadow`，其他家族 id 一律 `INVALID_ARGUMENT`。`maxHueOffsetDegrees` 只記錄給風格檢查，不改變輸出。全部運算都是整數，因此相同的輸入位元組一定得到相同的輸出位元組。

`drawLine` 的 `from`／`to` 為 `[x, y]` 整數對；`stampRect` 的 `to` 為 `{x, y}`，`offset` 為 `{dx, dy}`。`rect` 一律是 `{x, y, width, height}`，寬高至少為 1；`toIndex` 為 0 或正整數；`value` 為 `0`（外部）或 `1`（內部）。`polygonFill` 最多 4096 個點，超過為 `RESOURCE_LIMIT_EXCEEDED`；自交的環為 `SELF_INTERSECTING_POLYGON`，孔洞不支援（巢狀的環會被視為各自獨立的輪廓）。`stampRect` 複製 `source` 讀取範圍而不清空它（`source` 決定讀什麼，`selection` 只裁剪寫入；`to` 固定變換後輸出的左上角，`offset` 相對來源邊界平移，兩者並存為 `ARGUMENT_CONFLICT`）。未知的 `type` 為 `INVALID_ARGUMENT`；重複的 `id` 為 `DUPLICATE_OPERATION_ID`。

批次執行是原子的：只要有一個操作無效，就會回復所有變更。（MCP 的 `apply_asset_operations` 另接受 `atomic: false`，此時會跑完每個操作，以各操作的 applied／failed 狀態回報，不再回復。）

---

## 狀態碼註冊表

| 狀態碼 | 類別 | 說明 | 範例 |
|---|---|---|---|
| **0** | 成功 | 指令順利完成。 | 驗證全數通過、成功渲染。 |
| **1** | 內部錯誤 | 未處理的引擎缺陷（`INTERNAL_ERROR`）。 | 引擎發生非預期失敗。 |
| **2** | 無效呼叫 | 語法錯誤、旗標衝突、缺少必要參數。 | 缺少 `--output`、同時使用 `--force --in-place`、`MODEL_INVALID_JSON`、`MODEL_INVALID_OPERATION`。 |
| **3** | 素材驗證失敗 | 引擎執行正常，但素材或資源包未通過驗證。 | `VALIDATION_FAILED`、材質損壞、`.mcmeta` 有誤、模型發現項（`MODEL_INVALID_STRUCTURE`、`MODEL_INVALID_UV`、`MODEL_INVALID_ROTATION`、`MODEL_INVALID_DISPLAY`、`MODEL_VERSION_FEATURE`、`MODEL_SUSPICIOUS_VALUE`）。 |
| **4** | 檔案系統拒絕 | 檔案已存在且未加 `--force`，或缺少目錄且未加 `--mkdir`。 | `OUTPUT_EXISTS`、`FILESYSTEM_ERROR`。 |
| **5** | 不支援／資源上限 | 輸入格式不支援，或超出畫布上限。 | 圖檔標頭損毀、`UNSUPPORTED_IMAGE_FORMAT`、`OPTIMIZE_MODE_NOT_EXACT`、`MODEL_UNSUPPORTED_VERSION`。 |

---

## 常見錯誤排查指南（Troubleshooting）

| 錯誤代碼 | 狀態碼 | 觸發原因 | 建議排查與修復方式 |
|---|---|---|---|
| `EMPTY_SELECTION` | 2 | 批次操作的 `selection`，或 `inspect --mode view` 的 `--crop`，沒有選到任何像素。 | 用 `inspect --mode structure` 確認圖層與區域範圍，再放寬選取表達式。 |
| `ARGUMENT_CONFLICT` | 2 | 同時傳入互斥選項（如 `--force` 與 `--in-place`、多個幾何旗標、`--selection` 搭配幾何旗標、`stampRect` 同時給予 `to` 與 `offset`）。 | 拿掉其中一個衝突的選項。 |
| `OUTPUT_EXISTS` | 4 | 輸出檔案已存在，但未加上 `--force` 旗標。 | 加入 `--force` 確認覆寫，或指定新的 `--output` 路徑。 |
| `FILESYSTEM_ERROR` | 4 | 無法讀取輸入檔，或輸出的上層目錄不存在且未加上 `--mkdir`。 | 確認輸入路徑，或加上 `--mkdir` 自動建立缺少的目錄。 |
| `PACK_UNRESOLVED_EXTERNAL` | 0（警告） | `minecraft` 命名空間的引用（模型 parent、材質、模型，或裝備、粒子、字型的引用）在沒有原版資源樹時無法解析。以警告加上 `vanilla-not-provided` 覆蓋率條目回報，本身不會讓掃描失敗。 | 加上 `--vanilla <path>` 指定解包後之原版資源根目錄以供比對。 |
| `PACK_REFERENCE_CYCLE` | 3 | 模型的 `parent` 鏈或材質變數繞回自己（如 `#a -> #b -> #a`）。 | 在 model JSON 的 `parent` 或 `textures` 中切斷循環。 |
| `INVALID_MCMETA` | 2 | `.mcmeta` 格式有誤；對 `gui-scale` 而言，也包括九宮格邊框吃掉整個中段（`left + right >= width` 或 `top + bottom >= height`）。 | 保持 `left + right < width` 且 `top + bottom < height`。 |
| `STYLE_INVALID` | 2 | `.style.json` 有未知欄位、列舉外的值，或不是 `#RRGGBB` 的顏色；也包括讀不到或解析失敗的風格檔，以及載入不到的 `extends` 來源。 | 依訊息中的欄位路徑修正（`palettes.stone.base: expected #RRGGBB, got "#12345"`）；整個檔案的失敗會帶上路徑。 |
| `STYLE_NOT_FOUND` | 2 | `style show` 或 `style export-palette` 給的 id 不是四個內建預設之一。 | 改用 `vanilla`、`soft`、`fairy-flat`、`dark-frame`，或 `.style.json` 路徑。 |
| `STYLE_INHERITANCE_CYCLE` | 2 | `extends` 鏈回到已經走過的風格（最多八層）。 | 移除循環；訊息會列出重複的那段鏈。 |
| `STYLE_FAMILY_NOT_FOUND` | 2 | `--family` 指定的家族不在解析後的風格裡（例如文件用 `null` 刪掉之後）。 | 從 `style show <style>` 的結果挑一個家族，或不要刪除它。 |
| `STYLE_UNSUPPORTED_VERSION` | 5 | `.style.json` 的 `formatVersion` 高於工具支援的版本。 | 把 `formatVersion` 設為 1，並依這個版本調整文件內容。 |
| `PACK_INIT_CONFLICT` | 4 | `pack init` 發現預定要建立的路徑已經存在（檔案或骨架目錄）。 | 看 `conflicts` 清單，把這些路徑刪掉或改名後再跑一次；這次沒有寫任何檔案。 |
| `PACK_PROJECT_INVALID` | 2 | 專案檔欄位未知、不符合型別，或指向跑出專案根的路徑；`pack init` 沒加 `--allow-minecraft-namespace` 卻使用 `minecraft` 命名空間也是這個碼。 | 依訊息中的欄位路徑修正該欄位；`namespace` 的情況則是換一個命名空間，或加上這個明確同意的旗標。 |
| `PACK_PROJECT_NOT_FOUND` | 2 | 明確指定路徑的專案檔讀不到。 | 檢查路徑；指令不會往父目錄搜尋專案檔。 |
| `PACK_PROJECT_UNSUPPORTED_VERSION` | 5 | 專案檔的 `formatVersion` 高於工具支援的版本。 | 把 `formatVersion` 設為 1，並依這個版本調整專案檔內容。 |
| `RECIPE_INVALID` | 2 | 配方檔欄位無效、未知欄位、變數未被任何目標使用，或佔位符語法錯誤。 | 依訊息修正配方 JSON 欄位或移除未使用的變數。 |
| `RECIPE_UNSUPPORTED_VERSION` | 5 | 配方檔宣告的 `formatVersion` 高於目前支援的版本。 | 將 `formatVersion` 設為 1 並調整為此版本格式。 |
| `RECIPE_OUTPUT_CONFLICT` | 2 | 配方目標展開後產生重複的輸出路徑。 | 確保所有目標與變數展開後輸出路徑各自唯一。 |
| `RECIPE_VERSION_UNSUPPORTED` | 2 | 配方步驟產出目標資源包格式不支援的項目（例如 46.0 前的 `items/` 物品定義）。 | 改為相容的目標版本，或為舊版本移除該步驟。 |
| `RECIPE_SOURCE_MISSING` | 4 | 配方來源檔不存在，或使用 `vanilla` 來源但專案檔未設定 `vanillaSource`。 | 檢查來源路徑，或於 `mc-asset.pack.json` 設定 `vanillaSource`。 |
| `PACK_BUILD_CONFLICT` | 4 | `pack build` 發現預定輸出遭使用者手動修改（`own-modified`）或未經 lock 記錄而已存在於磁碟（`foreign`）。 | 檢查 details 中的 `conflicts` 清單；將衝突檔案移除或移開後重跑。本次未寫入任何檔案。 |
| `PACK_LOCK_INVALID` | 4 | `mc-asset.lock.json` 格式錯誤、無法解析，或條目雜湊無效。 | 修復 lock 檔語法，或將其刪除以重新乾淨建置。 |
| `PACK_LOCK_UNSUPPORTED_VERSION` | 5 | lock 檔宣告的 `formatVersion` 高於目前支援的版本。 | 將 `formatVersion` 設為 1 並調整為此版本格式。 |
| `PACK_GUI_SCALING_BORDER` | 3 | `validate-pack` 發現某個 GUI 貼圖的九宮格邊框沒有留下中段（判斷方式同 `INVALID_MCMETA`）。 | 縮小該貼圖 `.mcmeta` 裡的邊框。 |
| `PACK_MCMETA_INVALID` | 3 | 根目錄 `pack.mcmeta` 寫了遊戲拒絕載入的內容：缺少 `pack` 區段或 `pack.description`、`min_format`／`max_format` 只寫一半、負值或上下顛倒的範圍、與宣告範圍不一致的 `supported_formats`、落在宣告 major 之外的舊制 `pack_format`、不合法的 overlay 目錄名，或違反舊格式規則的 overlay `formats` 欄位。 | 把指出的欄位修好（範圍兩端都要能讀、宣告的 major 要一致），或拿掉規則不准寫的舊欄位。 |
| `PACK_MCMETA_SUSPICIOUS` | 0（警告） | 包照常載入，但寫法疑似失誤：pack 根目錄沒有的 overlay 目錄、完全沒寫版本欄位的 overlay 條目，或落在宣告範圍外的掃描目標。以警告回報，本身不會讓掃描失敗。 | 補上缺少的 overlay 目錄、給該條目一個版本範圍，或把掃描目標改回宣告範圍內。 |
| `PACK_UNRESOLVED_VARIABLE` | 0（警告） | 模型貼圖變數在父模型鏈中均未解析，且該模型既未被 blockstate 或 items 定義直接當作最終模型使用，亦無子模型在 `textures` 中提供該變數（或單檔 `model validate`／`model inspect` 無從得知子模型）。以警告回報，本身不會讓掃描失敗。 | 在繼承該模板的子模型中提供缺少的變數，或在不再使用的模型中移除陳舊的變數引用。 |
| `RESOURCE_LIMIT_EXCEEDED` | 5 | 超過硬性上限：多邊形超過 4096 點、選取 AST 深度超過 32 或節點超過 1024、`inspect view` 輸出邊長超過 1024px，或畫布尺寸與記憶體上限。 | 減少頂點或簡化選取表達式；大圖用 `--crop` 分塊檢視。 |
| `OPTIMIZE_MODE_NOT_EXACT` | 5 | `optimize --mode <名稱>` 強制的編碼無法精確表示像素（例如對帶透明度的來源指定 `rgb`）。 | 改用 `--mode auto`，或選一個能容納所有像素的模式。 |
| `MODEL_UNSUPPORTED_VERSION` | 5 | 目標版本無法表示所要求的特性，或 `model export` 使用 `binding.item` 時沒有明確的 46.0 以上資源包版本。 | 傳入支援該特性的 `--minecraft-version` 或 `--resource-pack-version`。 |
| `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT` | 5 | 使用 `minecraft:*` 素材設定檔，但輸出路徑不是 `.png`。 | Minecraft 材質一律輸出 `.png`。 |

## 產生 mcmeta 設定

從 PNG 產生動畫或 GUI 縮放設定：

```sh
mc-asset mcmeta animation sheet.png --frame-size 16 --frametime 2 --frames '[0,{"index":1,"time":4},0]' --minecraft-version 1.21.2 --output sheet.png.mcmeta
mc-asset mcmeta gui panel.png --type nine_slice --border 4 --stretch-inner --resource-pack-version 42 --stdout
```

動畫必須指定 `--frame-size <N|WxH>`，影格只支援單排或單列，尺寸必須整除 PNG；不接受網格。`frametime` 預設 1，`frames` 接受索引或 `{index,time}` 物件，可重複或只播放部分影格；省略時依序播放全部影格。時間必須是正整數，索引不得越界；`--interpolate` 啟用插值。`--preset <hold-and-sweep|ping-pong|pulse>` 以具名時間軸展開播放順序，取代手寫 `frames`，並在兩端或首格停留 `--hold-ticks`，不能與 `--frames` 同時使用。GUI 必須指定 `--type <stretch|tile|nine_slice>`，tile 與 nine_slice 以 PNG 尺寸作設計尺寸。nine_slice 必須指定 `--border <N|json>`，四邊 left、top、right、bottom 為非負整數，中央必須保留正面積；只有 nine_slice 接受 `--stretch-inner`。

CLI 必須明確選擇 `--output <path.mcmeta>` 或 `--stdout` 其中之一，不猜同名路徑。已存在的目標需要 `--force`，它會整檔替換，不保留其他區段；`--mkdir` 允許建立缺少的父目錄。來源 PNG 與無關的同名設定不變，輸入別名與符號連結會被拒絕。輸出只含指定區段，以固定鍵順序的緊湊 JSON 加一個結尾換行產生。

版本選項 `--minecraft-version` 與 `--resource-pack-version` 只能選一個。GUI scaling 需要 pack format 16.0，stretch_inner 需要 42.0；不相容會在輸出前回報 `ARGUMENT_CONFLICT`。未指定版本，或版本在 12.0 到 97.1 之外，會回報 `versionChecked: false` 與 `VERSION_NOT_CHECKED`，但不會跳過 GUI 最低版本限制。動畫依文件格式及歷史在表內標示已檢查，並非逐版遊戲用戶端實測。來源見[材質動畫與歷史](https://minecraft.wiki/w/Resource_pack#Texture_animation)（interpolate 在 14w25a 加入，早於支援表）、[GUI scaling](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w31a) 與 [pack format](https://minecraft.wiki/w/Pack_format)。這些檢查確認設定結構與已知版本相容性，不代表已驗證遊戲內外觀或行為。

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
