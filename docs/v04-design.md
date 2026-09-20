# V0.4 設計凍結：FrameSet、Animation、GUI／Particle Profile 與 mcmeta 驗證

V0.4 加入 FrameSet、Animation Engine、minecraft:gui、minecraft:particle、mcmeta Validation、Nine-Slice Preview 與 Animation Validation（§87）。這份文件把這批功能的判斷固定下來，讓後續實作不必在語意、layout、旗標與 preview 形狀上各自猜測；命令表面（名稱、旗標、輸入輸出、exit code）以 `docs/cli-surface.md` 的「V0.4 commands (frozen)」為準，規範性結論記於 `project-detail.md` §107。

服務對象是要動 `animate`、以 `--profile minecraft:gui`／`minecraft:particle` 處理素材，以及用 `validate` 讀 `.png.mcmeta` 的工程師與 Agent。

規格只給了介面骨架與少數例子（§48、§49、§50；docs §39），沒有給 layout 之外的 pack／unpack 行為、frame resize 規則、preview 形狀，或 mcmeta 欄位的值域。因此這份文件把多數細節標成「（本凍結）」，並在文末列出無法推定的「（待決）」項目。

## 位階與來源標記

規範條文以 `.project-doc/project-detail.md` 為準（§1.2），命令表面（名稱、旗標、輸入輸出、exit code）以 `docs/cli-surface.md` 為準。這份文件承載兩者之間的語意、演算法選型與取捨理由，衝突時先比對技術規格書，再更新這份文件。

```text
§n         project-detail.md 第 n 節（規範）
docs §n    project-docs.md 第 n 節（產品規格書，非規範）
refs §n    mc-asset-development-references.md 第 n 節（參考資料，非規範）
（本凍結）  規格未給定、由這份凍結決定；附理由與應測點
（實作判讀） 實作實況；權威來源是每項列出的程式與測試，本文件只記錄
（待決）    規格無法推定，列入文末清單，不自行填補
```

規範強度依 §1.1：MUST／不得＝必須有測試涵蓋，違反即為 bug；SHOULD／建議＝可附理由偏離，偏離要記錄；MAY／可＝實作自由。

## 凍結摘要

| 主題 | 凍結結論 | 出處 | 應測點 |
|---|---|---|---|
| 命令表面 | 只新增一個命令 `animate`；其餘掛既有命令（`preview --nine-slice`、`validate --mcmeta`、`--profile`／`--preset` 加值） | §87、docs §48、docs §39、§104.1 | 無同義入口；名稱不與既有命令衝突 |
| FrameSet 介面 | `frames: PixelCanvas[]`、`frameWidth`、`frameHeight`、`metadata?`；每 frame 是一個 PixelCanvas；animation 不進 `.mcpx` | §48、§51 | frame 尺寸不一致時被拒 |
| 檔案系統上的 FrameSet | frames 目錄，每 frame 一個 `.mcpx`（單一 PixelCanvas），順序由檔名 byte 升冪決定 | §48、§51、§100.3（本凍結） | 目錄列舉先排序；重跑同序 |
| Animation Engine | pack／unpack／reorder／resize／validate／preview；layout vertical／horizontal／grid | §49、docs §39 | 三 layout 進出 sheet byte-identical |
| Sprite sheet 尺寸 | vertical／horizontal／grid 的固定公式；grid 需顯式 `--columns`；空 cell 為 transparent | §49（本凍結） | 尺寸公式 golden |
| Frame resize | 顯式目標 WxH；預設 nearest、box 可、pixel-aware 拒絕 | §38、§105.3（本凍結） | 未帶 resize 時 frame byte 不變 |
| mcmeta 讀取 | `validate --mcmeta` 顯式；只讀不寫；涵蓋 texture metadata 與 animation metadata | §46、§50（本凍結） | 不修改 JSON；錯誤附位置 |
| Animation 驗證 | frame geometry／index／dimensions／count；錯誤附位置 | §50、§81 | 32×128＋frame 32×32 → 4 frames；壞 index 被拒 |
| GUI profile | 理解 gui atlas／sprite bounds／alpha／stretch／tile／nine_slice；nine-slice preview 與 border guide；stretch_inner 排除 | §42、§87 | nine_slice 檢出並產出 preview |
| Particle profile | alpha／small-size readability／frame consistency／atlas reference；MUST NOT 強制統一尺寸 | §43 | 不同尺寸不被拒 |
| pixelize preset | 新增 `gui`／`particle`；顯式、可列印的參數組 | docs §30、§87（本凍結） | preset 名稱可解析；參數可列印 |
| 共同約束 | §57、§98、§100 全套；寫檔命令 exit 0/2/4/5，validate 家族為 0/2/3/4/5 | §57、§98、§100 | 缺輸出零檔案；跨 runtime byte-identical |

---

## 命令表面

V0.4 只新增一個命令 `animate`。這個名稱已經出現兩次：`docs/cli-surface.md` 的 V0.1 保留清單（Deferred: `animate`）與產品規格書 docs §48 的 command tree，因此不是新造名稱，也不與 `src/cli/program.ts` 既有命令（`stub`、`analyze`、`validate`、`import`、`render`、`transform`、`quantize`、`cleanup`、`palette`、`material`、`recolor`、`build`、`pixelize`、`variant`、`tile`、`generate`、`preview`）同名。

其餘能力一律掛在既有命令上，不開同義入口（§104.1）：

| 表面 | 種類 | 一句話語意 | 出處 |
|---|---|---|---|
| `animate <mode>` | 新命令 | FrameSet 與 sprite sheet 互轉、重排、縮放、驗證、預覽 | §48、§49、§87、docs §39、docs §48 |
| `preview --nine-slice` | 既有命令新模式 | 讀 GUI sprite 與其 mcmeta，報告或視覺化 nine_slice | §42、§87 |
| `validate --mcmeta <path>` | 既有命令新旗標 | 讀 texture／animation mcmeta 並驗證 | §46、§50 |
| `--profile minecraft:gui` | 既有旗標新值 | GUI sprite profile | §42、§87 |
| `--profile minecraft:particle` | 既有旗標新值 | particle profile | §43、§87 |
| `pixelize --preset gui` | 既有旗標新值 | GUI 處理 preset | docs §30、§87 |
| `pixelize --preset particle` | 既有旗標新值 | particle 處理 preset | docs §30、§87 |

`animate` 之所以是新命令而不是既有命令的延伸：docs §39 把 pack／unpack／reorder／resize／validate／preview frames 列為 Animation Engine 的獨立職責，而 FrameSet 不是 PixelCanvas、也不是 `.mcpx`（§48、§51），既有的 `transform`／`preview` 都以單一 canvas 為輸入，沒有可承載 FrameSet 的操作族（本凍結）。

共同約束（全部為 MUST，沿用 §57、§98）：

```text
產生檔案的命令       缺 --output／--stdout／--output-dir 時 OUTPUT_REQUIRED，且不建立任何檔案（§57）
輸出檔已存在          預設 OUTPUT_EXISTS，--force 才允許覆寫（§98.2）
父目錄不存在          預設 FILESYSTEM_ERROR，--mkdir 才建立（§98.3）
寫入                  同目錄暫存檔加 rename；失敗不留半寫入產物（§98.4）
路徑                  全部由呼叫端指定；不得推導檔名、不得建立預設目錄（§18、docs §7、docs §8）
通道                  --json 與 --stdout 的分工依 §98.1
輸入 intake           animate 的 frame 是 `.mcpx`，sheet 是 PNG（本凍結）
```

`animate` 寫多個 frame 時，比照 `variant`：每個輸出檔個別套用 OUTPUT_EXISTS、`--mkdir` 與原子寫入；缺 `--output-dir` 是 OUTPUT_REQUIRED 且零檔案。

應測點：`animate` 各 mode 缺輸出時都不產生任何檔案；`--force`／`--mkdir` 與 §98 一致；`animate` 的名稱不與既有命令衝突；沒有第二個命令或旗標做同一件事。

### `animate <mode>`

六個 mode，分別對應 docs §39 的六項職責：

| Mode | 一句話語意 | 產物 |
|---|---|---|
| `pack` | FrameSet（frames 目錄）→ sprite sheet PNG | 是（PNG） |
| `unpack` | sprite sheet PNG → FrameSet（frames 目錄） | 是（多個 `.mcpx`） |
| `reorder` | 以顯式排列重排 FrameSet 的 frame | 是（多個 `.mcpx`） |
| `resize` | 以顯式尺寸與模式縮放全部 frame | 是（多個 `.mcpx`） |
| `validate` | 唯讀檢查 FrameSet 幾何與（可選）mcmeta 對應 | 否 |
| `preview` | 唯讀預覽動畫結構；`--ascii` 時輸出整張 sheet 的 `.grid` 文件 | 否（`--ascii` 走 stdout） |

```text
animate pack     --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns N]
                 [--output <png>] [--stdout]
animate unpack   <sheet.png> --layout <vertical|horizontal|grid> --frame-size WxH [--columns N]
                 [--mcmeta <path>] --output-dir <dir>
animate reorder  --frames-dir <dir> --order <i,j,...> --output-dir <dir>
animate resize   --frames-dir <dir> --frame-size WxH [--resize-mode nearest|box]
                 --output-dir <dir>
animate validate --frames-dir <dir> [--mcmeta <path>]
animate preview  --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns N] [--ascii]
```

共同旗標收斂：

```text
pack      --frames-dir / --layout / --columns / --output / --stdout / --force / --mkdir / --profile / --json
unpack    --layout / --frame-size / --columns / --mcmeta / --output-dir / --force / --mkdir / --profile / --json
reorder   --frames-dir / --order / --output-dir / --force / --mkdir / --profile / --json
resize    --frames-dir / --frame-size / --resize-mode / --output-dir / --force / --mkdir / --profile / --json
validate  --frames-dir / --mcmeta / --profile / --json
preview   --frames-dir / --layout / --columns / --ascii / --profile / --json
```

- `animate` 不宣告 `--source` 與 `--in-place`：animation 不進 `.mcpx`（§51），而 FrameSet 的輸出是 frames 目錄，原地改寫沒有定義。用到這兩個旗標是未知選項（exit 2）。
- `--layout`（本凍結）：pack／unpack／preview MUST 顯式，沒有預設值。§49 明言 vertical 是常見 workflow 但不是唯一 layout，替它設預設會把一個未定案的偏好寫成行為。未帶 `--layout` 是 `INVALID_ARGUMENT`。
- `--columns N`（本凍結）：grid layout 的欄數，正整數；`--layout grid` 未帶 `--columns` 是 `INVALID_ARGUMENT`。§49 沒有定義 grid 的排列，交由呼叫端決定以避免隱式自動排版。
- `--frame-size WxH`（本凍結）：解析與 `pixelize --size` 相同（單邊 `N` 等於 NxN）；非整數是 `INVALID_ARGUMENT`，維度越界（< 1 或 > §102 的 4096）是 `INVALID_DIMENSION`。
- `--order <i,j,...>`（本凍結）：0 基索引的逗號序列，MUST 是 `[0, count)` 的一個排列；長度不符、重複或越界是 `INVALID_ARGUMENT`，details 帶出錯的索引。
- `--resize-mode nearest|box`（本凍結）：預設 `nearest`；`pixel-aware` 沿用 §105.3 拒絕（`INVALID_ARGUMENT`），未知模式同樣拒絕。
- `--mcmeta <path>`（本凍結）：顯式路徑；`animate` 不自動尋找 `frames-dir` 內或 sheet 旁的同名 mcmeta。

### 檔案系統上的 FrameSet 表示（本凍結）

§51 規定 `.mcpx` v1 一個檔案等於一個 PixelCanvas，不代表 FrameSet，因此 FrameSet 沒有單一檔案格式。CLI 需要一個可讀寫的表示，決定如下：

```text
frames 目錄          一個目錄，內含 count 個 `.mcpx`，每個檔案恰是一個 PixelCanvas
frame 順序           目錄內 `*.mcpx` 直接子項（不遞迴），依檔名 byte 升冪排序（§100.3）
frameWidth/Height    所有 frame 共同的寬高；等於每個 frame 的 canvas 尺寸
frame 命名（輸出）    frame_<n>.mcpx；<n> 補零到 (count-1) 的位數寬度，至少 1 位
```

理由：

- 每個 frame 是一個 PixelCanvas（§48），而 `.mcpx` 是 PixelCanvas 的可編輯來源格式（§17、§51）；一個 `.mcpx` 一個 PixelCanvas 正好對上一個 frame，不動用規格未定義的容器格式。
- 以目錄列舉取得 frame 時 MUST 先排序（§100.3），檔名 byte 升冪是唯一不依賴檔案系統順序的全序。
- 補零命名讓字典序等於索引序，重新讀入時順序穩定；寬度隨 count 決定，不是固定常數。
- 輸出目錄本身由呼叫端以 `--output-dir` 顯式指定，檔名只在該目錄內固定，比照 `variant` 的 `<basename>_<material>` 命名；不推導輸出目錄，也不建立預設目錄。
- 多層 `.mcpx` frame 在 pack 前先 flatten 成單一 RGBA 緩衝（與 `tile`／`preview` 的 flatten 規則一致）；unpack 寫出的 frame 是單層。

應測點：同一組 frames 重跑 pack 得到 byte-identical sheet；unpack 後再 pack 的 sheet 與原 sheet byte-identical；frame 檔名補零寬度隨 count 改變；目錄內非 `.mcpx` 檔被忽略或被拒（見待決清單）。

---

## FrameSet 模型

§48 的介面照抄，不動：

```ts
interface FrameSet {
  frames: PixelCanvas[]

  frameWidth: number
  frameHeight: number

  metadata?: FrameSetMetadata
}
```

- 每個 Frame 本身就是一個 PixelCanvas（§48）。
- Animation MUST NOT 被塞進單一 PixelCanvas（§48）。
- `metadata` 是選填（§48）；其內容規格未定義，V0.4 只允許原樣保留與回報，不解析成行為（待決清單）。
- V0.4 的 FrameSet 是記憶體模型；`.mcpx` v1 不保存 animation（§51），CLI 的持久表示是 frames 目錄（見上節）。

不變條件（本凍結）：

```text
count ≥ 1             空 FrameSet 是 INVALID_ANIMATION_FRAME
尺寸一致              每個 frame 的 canvas 尺寸 MUST 等於 frameWidth × frameHeight
不一致的處理          以 INVALID_ANIMATION_FRAME 拒絕，details 帶 frameIndex／expected／actual
frameWidth/Height     為正整數，且 MUST ≤ §102 的 4096
```

尺寸不一致之所以拒絕而不是默默縮放：§48 把 `frameWidth`／`frameHeight` 放在 FrameSet 層級，暗示 cell 是均一的；要在不同尺寸間轉換，`animate resize` 是顯式入口，符合 §63 的顯式授權原則。要放寬的話由呼叫端先 resize。

應測點：`frames` 有兩個不同尺寸的 canvas 時 `INVALID_ANIMATION_FRAME`；details 指出是哪一個 index；`frameWidth × frameHeight` 與 frame 不符時同樣被拒；空 FrameSet 被拒。

---

## Animation Engine

依 §49，Engine 的兩個方向：

```text
FrameSet ──Pack──▶ Sprite Sheet
Sprite Sheet ──Unpack──▶ FrameSet
```

支援 layout：`vertical`、`horizontal`、`grid`（§49）。`vertical` 是常見 Minecraft workflow，但不是唯一 layout（§49），所以 V0.4 三種都 MUST 支援，且沒有預設。

### pack 與 unpack 的 layout

```text
vertical    依序由上往下堆疊；每列一個 frame
horizontal  依序由左往右排列；每行一個 frame
grid        依列優先（row-major）填入 columns 欄；最後一列可留空 cell
```

- frame 在 sheet 內的位置由索引與 layout 唯一決定，MUST NOT 依賴任何其他排序（§100.3）。
- unpack 的 frame 順序沿用同一套列優先規則，因此 `pack → unpack → pack` 對 sheet 的像素是 identity。

### Sprite sheet 尺寸推導（本凍結）

```text
count = frames.length
vertical    width  = frameWidth
            height = frameHeight × count
horizontal  width  = frameWidth × count
            height = frameHeight
grid        rows   = ceil(count / columns)
            width  = frameWidth × columns
            height = frameHeight × rows
```

- grid 未填滿的 cell MUST 為 `transparent`（`#00000000`，§8）。
- sheet 寬或高超出 §102 的 1–4096 是 `INVALID_DIMENSION`；估算記憶體超出 §102 的 512 MB 是 `RESOURCE_LIMIT_EXCEEDED`（沿用既有守衛，在配置前判斷）。
- pack MUST NOT 縮放 frame：frame 以 1:1 貼入 cell。需要不同 cell 尺寸時先 `animate resize`。

錯誤：unpack 時 sheet 維度與 layout／`--frame-size` 不相容是 `INVALID_ANIMATION_FRAME`（details 帶 layout、sheet 尺寸、frame 尺寸）：

```text
vertical    sheetHeight % frameHeight ≠ 0
horizontal  sheetWidth  % frameWidth  ≠ 0
grid        sheetWidth  % columns ≠ 0；cell 尺寸 = (sheetWidth/columns) × frameHeight
```

應測點：vertical／horizontal／grid 的 sheet 尺寸逐值鎖定；grid 空 cell 為 `#00000000`；grid 未帶 `--columns` 被拒；unpack 的三種不可整除各被拒；sheet 超出 4096 為 `INVALID_DIMENSION`。

### frame resize（本凍結）

`animate resize` 是唯一改變 frame 尺寸的入口：

```text
目標尺寸     --frame-size WxH 必填
模式         預設 nearest；可選 box；pixel-aware 以 INVALID_ARGUMENT 拒絕（§105.3）
運算         與 transform --resize 相同的整數實作（§32、§38、§100.1）
alpha 保留   A = 0 的 hidden RGB 視為資料（§7），不得被歸零
後置          完成後每個 frame 的尺寸等於新目標，frameWidth/Height 隨之更新
```

- `nearest` 與 `box` 的餘數分配沿用 `transform` 的凍結規則，不在這裡另立一套。
- resize MUST 是整數運算，MUST NOT 依賴平台圖形 API（§32），MUST NOT 使用超越函式（§100.2）。

應測點：resize 後每個 frame 尺寸等於目標；`nearest` 不產生新顏色；`box` 的區塊平均與 transform 一致；`pixel-aware` 被拒且零寫入；未帶 resize 的 pack／reorder 不改變 frame 像素。

### reorder（本凍結）

`animate reorder --order <perm>` 以顯式排列重建 frames 目錄：

```text
--order 0,2,1   新序列的第 i 個 frame 是原序列的 order[i]
輸出            寫入 output-dir，frame 像素不變、只有順序改變
```

- `--order` MUST 是 `[0, count)` 的全排列；缺漏、重複、越界都是 `INVALID_ARGUMENT`。
- reorder MUST NOT 改變任何 frame 的像素（只有順序與檔名隨新索引變）。

應測點：`--order 2,0,1` 後新索引 0 的像素等於原索引 2；非排列被拒；reorder 前後每個 frame 的 byte 不變。

### frame validate

```text
輸入        frames 目錄；可選 --mcmeta
輸出        唯讀報告（人類或 --json），零檔案
檢查        frame 幾何（尺寸一致、frameWidth/Height 相符、count ≥ 1）
            mcmeta 的 frame index／dimensions／count 對應（有 --mcmeta 時，見下節）
exit        報告判定不合格時 3（VALIDATION_FAILED）；結構性錯誤 2
```

- 尺寸不一致等結構問題依上節是 `INVALID_ANIMATION_FRAME`（exit 2）；判定式的不合格（例如 mcmeta 的 frame 數與 frames 目錄不符）以 findings 回報並在 `verdict: fail` 時走 exit 3。
- 報告 MUST 是確定性的（§100.3）：同輸入同順序、無時間戳。

應測點：尺寸不一致 exit 2 且 details 有 index；count 與 mcmeta 不符時 verdict fail、exit 3；重跑報告相同。

### animation preview

§39 把「preview animation」列為 Animation Engine 職責，但沒有定義輸出。

```text
animate preview --frames-dir <dir> --layout L [--columns N]
  無 --ascii    唯讀報告（人類或 --json）：frame count、frame 尺寸、layout、每個 frame 的索引
  --ascii       在記憶體 pack 成 sheet，輸出 .grid 相容 ASCII 文件（stdout；--json 時放 result.ascii）
```

- `--ascii` 走與 `preview --ascii` 相同的序列化（§96.6／§96.8 的符號指派與 `[grid]`／`[grid tokens]` 選擇）；尺寸上限與 token 成本政策沿用該模式。
- `animate preview` MUST NOT 寫出 PNG；要 sheet PNG 用 `animate pack`，要看單一 frame 的放大圖用 `preview <frame.mcpx>` 或 `transform --resize`。這樣三個入口各司其職，不互為同義詞（§104.1）。
- 較豐富的動畫預覽（filmstrip、時間軸）見待決清單。

應測點：無 `--ascii` 時零檔案；`--ascii` 的輸出能被 `render` 讀回且像素一致；`animate preview` 不寫 PNG。

---

## Animation mcmeta 與驗證

§50：Agent 自行生成 `texture.png.mcmeta`，Validator 可以讀 PNG、讀 `.mcmeta`、推導 frame geometry、驗證 frame index／frame dimensions／frame count。§81 的 Animation Test 給了一個 worked example：

```text
Sprite Sheet  32×128
frame         32×32
應識別        4 frames
錯誤 frame index → INVALID_ANIMATION_FRAME
```

驗證接在 `validate` 上，不另開命令（本凍結）：

```text
validate <asset> [--mcmeta <path>]
  --mcmeta 顯式給路徑；缺省時不做任何 mcmeta 檢查，也不自動尋找同名 `.mcmeta`
  讀 PNG 與 .mcmeta，推導 frame geometry
  frameCount = sheetHeight / frameHeight（vertical）或 sheetWidth / frameWidth（horizontal）
  grid 的 frameCount 由 grid 尺寸與 sheet 尺寸推導
  逐一檢查 mcmeta 的每個 frame index ∈ [0, frameCount)
  檢查 mcmeta 宣告的 width／height（若有）與推導出的 frame 尺寸一致
  MUST NOT 寫入或改寫任何 JSON
```

錯誤回報（本凍結）：

```text
結構性錯誤    INVALID_MCMETA（無法解析、型別不符）或 INVALID_ANIMATION_FRAME（index 越界）→ exit 2
位置          error.details.path，例如 animation.frames[2].index
判定不合格    findings 內以 code／level／message 呈現，verdict fail → exit 3
```

- 一個 frame index 越界即 `INVALID_ANIMATION_FRAME`（§81、§99），不是 warning。
- `validate` 仍不寫入、不修改檔案；`.mcmeta` 全程只讀（§39、§46、§50）。
- `--mcmeta` 只掛在 `validate`；`animate validate` 的 `--mcmeta` 只做 frame 幾何對應，mcmeta 欄位語意的完整檢查留在 `validate`。

應測點：32×128 sheet 推導出 4 frames；`animation.frames` 指到 index 4 時 `INVALID_ANIMATION_FRAME` 且 details.path 指出該元素；無法解析的 mcmeta 為 `INVALID_MCMETA`；validate 執行後 `.mcmeta` 與 PNG bytes 不變。

---

## mcmeta 讀取範圍

§46 說 mc-asset 不負責替 Agent 自動設計 `.mcmeta`，但 Resource Pack Validator SHOULD 理解它；texture section 現在包含 `mipmap_strategy` 與 `alpha_cutoff_bias`。§50 補上 animation 的讀取。V0.4 的讀取範圍固定如下（本凍結）：

```text
texture metadata     mipmap_strategy（原樣字串）、alpha_cutoff_bias（原樣數值）
animation metadata   frametime、interpolate、width、height、frames[]
frames[] 元素        裸整數 index，或帶 index／time 的物件（兩種常見形式）
```

- 這些欄位名是 Minecraft 格式事實；`mipmap_strategy` 與 `alpha_cutoff_bias` 作為 26.3／RP 97.1 的查證項記於 §95（出處：1.21.11 release notes）。規格沒有列出這兩個欄位的值域與組合語意，因此 V0.4 把**值域解讀**列為待決，無法確認的組合一律只給 warning，不當 error（§95 的「待補出處只能作為 Warning」原則）。
- `frames[]` 的元素形式（裸整數或帶 `index`／`time` 的物件）與 GUI scaling 的鍵路徑同理，精確 schema 以相容層查證為準；V0.4 的讀取 MUST 同時接受這兩種形式，避免因未查證的 schema 假設而拒絕合法輸入。
- mcmeta 的解析 MUST 是確定性的（§100.3）：欄位遍歷順序固定，不得依賴物件鍵序。
- mc-asset MUST NOT 生成、修改或格式化 `.mcmeta`（§39、§46、§50）。`validate` 只讀。

### Validator 應能檢查的六項（§46）

```text
PNG dimensions              解碼後的寬高
frame dimensions            推導出的 frame 尺寸（與 mcmeta 宣告比對）
animation layout            sheet 與 frame 尺寸推導出的 frame 數與排列
texture metadata compatibility   mipmap_strategy／alpha_cutoff_bias 與 profile 的相容性
GUI scaling                 GUI sprite 的 scaling 設定（見 GUI profile）
palette metadata            `.mcmeta` 的 palette 區段（規格未細列，見待決）
```

### mipmap 的結構化資訊（§47）

Block profile 的 analyze／validate 提供結構化資訊，不替 Agent 決定最佳設定（§47）：

```text
texture alpha            沿用 §40 的 predicted classification：solid／cutout／translucent
mipmap_strategy          mcmeta 的原樣值
alpha_cutoff_bias        mcmeta 的原樣值
```

- 已知需要 warning 的組合之一：cutout texture + mean mipmap（§47 的唯一例子）。V0.4 將它列為 warning 規則；其他組合的判斷見待決清單。
- 這些欄位 MUST 只作為結構化資訊與 warning 呈現，MUST NOT 阻止輸出，MUST NOT 被讀成 effective（§40、§47）。

應測點：cutout＋mean mipmap 觸發 warning 且不改變 verdict；`mipmap_strategy`／`alpha_cutoff_bias` 原樣回報；無法辨識的值仍原樣回報並只給 warning。

---

## minecraft:gui Profile（§42）

§42 要求 GUI Profile 理解：

```text
gui atlas
exact sprite bounds
alpha
stretch
tile
nine_slice
```

Sprite 的 `.mcmeta` 可指定 `stretch`／`tile`／`nine_slice`；nine-slice 可進一步指定 border；`stretch_inner` 是後續版本才加入的（§42）。

V0.4 的範圍（本凍結）：

```text
stretch／tile／nine_slice    理解並回報；三者互斥（同一 sprite 只會有一種 scaling）
border                       解析 nine_slice 的 border { left, top, right, bottom }
stretch_inner                MAY 被解析並回報，但 MUST NOT 套用；明確排除在 V0.4 外（§42）
```

- `--profile minecraft:gui` 只影響報告與驗證的判斷，輸出仍只有 PNG；非 `.png` 的 `--output` 是 `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT`（§34）。
- GUI scaling 的 mcmeta 鍵路徑與值域是 Minecraft 格式事實，規格未記錄於 §95；V0.4 以 `stretch`／`tile`／`nine_slice`／`border`／`stretch_inner` 這些名稱定位欄位，精確鍵路徑待相容層查證（待決清單）。
- 「exact sprite bounds」在 V0.4 的意義是：報告 sprite 的實際像素邊界與尺寸，MUST NOT 對 GUI sprite 做任何自動裁切或補邊。

### nine-slice preview 與 border visualization（本凍結）

`preview --nine-slice` 是 `preview` 的第四種模式，輸入是 sprite PNG 加上顯式 `--mcmeta`：

```text
preview <sprite.png> --nine-slice --mcmeta <path> [--output <png>] [--stdout]
```

- 無 `--output`／`--stdout` 時是唯讀報告，零檔案；有輸出時寫出 preview PNG。
- 模式旗標仍是一次剛好一種（`--ascii`／`--palette-map`／`--scale`／`--nine-slice`）；兩種以上是 `ARGUMENT_CONFLICT`，都不帶是 `INVALID_ARGUMENT`。V0.4 的 `--nine-slice` MUST 帶 `--mcmeta`，否則 `INVALID_ARGUMENT`。
- 這一條是對 §106.6「preview 的模式固定是 ASCII／palette map／scale」的**版本延伸**：§106.6 描述的是 V0.3 不把 tile preview 併入 `preview`；V0.4 依 §87 新增 Nine-Slice Preview，於此把 `--nine-slice` 加入模式集合，以 §107 為後續版本之準（本凍結）。

報告形狀（本凍結）：

```json
{
  "success": true,
  "result": {
    "command": "preview",
    "mode": "nine-slice",
    "profile": "generic",
    "width": 16,
    "height": 16,
    "mcmeta": "panel.png.mcmeta",
    "scaling": { "type": "nine_slice" },
    "nineSlice": {
      "border": { "left": 4, "top": 4, "right": 4, "bottom": 4 },
      "stretchInner": false
    },
    "regions": {
      "topLeft":     { "x": 0,  "y": 0,  "width": 4, "height": 4 },
      "top":         { "x": 4,  "y": 0,  "width": 8, "height": 4 },
      "topRight":    { "x": 12, "y": 0,  "width": 4, "height": 4 },
      "left":        { "x": 0,  "y": 4,  "width": 4, "height": 8 },
      "center":      { "x": 4,  "y": 4,  "width": 8, "height": 8 },
      "right":       { "x": 12, "y": 4,  "width": 4, "height": 8 },
      "bottomLeft":  { "x": 0,  "y": 12, "width": 4, "height": 4 },
      "bottom":      { "x": 4,  "y": 12, "width": 8, "height": 4 },
      "bottomRight": { "x": 12, "y": 12, "width": 4, "height": 4 }
    },
    "findings": []
  }
}
```

- 九個 region 由 border 內縮推導：`left`／`right`／`top`／`bottom` 是四條邊的寬度，中欄與中列由剩餘寬高組成。
- border 幾何檢查（對應 §80 的 border geometry／texture dimensions／scaling metadata）：`left + right ≤ width` 且 `top + bottom ≤ height`，否則 finding 為 error。border 負值或非整數是 `INVALID_MCMETA`。
- `stretchInner` 原樣回報但不套用；出現 `true` 時附一則 warning，說明 V0.4 不套用（§42）。
- `--nine-slice` 也可以用在 `--profile minecraft:gui`，但 profile 不改變報告欄位；模式本身不強制 profile。

preview PNG（border visualization，本凍結）：

```text
尺寸        與 sprite 相同（1:1，無縮放）
內容        sprite 像素原樣，另在 border 邊界畫四條 1px 線
線的位置    x = left、x = width - right、y = top、y = height - bottom 的整條線
線的顏色    #FF00FFFF（本凍結的固定 guide 色）
alpha       線覆蓋處設為不透明，其餘像素與輸入 byte-identical
```

- preview PNG 是**視覺化產物**，不是素材本體；MUST NOT 被寫回輸入，輸入 MUST NOT 被修改（§59）。
- 同一輸入重跑 byte-identical；guide 色與 1px 線寬是固定常數，不依賴環境。
- `--nine-slice` 的 PNG 放大（是否讓 `--scale` 併用）見待決清單；V0.4 固定 1:1。
- `stretch preview` 與 `tile preview`（§42 的未來清單）不在 V0.4；本版本只有 nine-slice preview 與其 border visualization。

應測點：nine_slice 的 mcmeta 被檢出且九個 region 逐值鎖定；border 超出尺寸時 finding 為 error；`stretch_inner: true` 只給 warning；preview PNG 的 sprite 像素等於輸入、四個邊界有 guide 色；`--nine-slice` 缺 `--mcmeta` 被拒；`--nine-slice --ascii` 是 `ARGUMENT_CONFLICT`。

---

## minecraft:particle Profile（§43）

§43 要求 Particle Profile 重視 alpha、small-size readability、frame consistency、atlas reference，且**不應**把所有 Particle 強迫限制成相同尺寸；Particle JSON 由 Agent 產生，mc-asset 只負責圖片及引用驗證。

V0.4 的凍結：

```text
尺寸         MUST NOT 強制所有 particle 相同尺寸；任何尺寸一致性檢查 MUST NOT 以「不一致」為由拒絕
alpha        沿用 §40 的 predicted classification 回報
small-size readability   以結構化資訊呈現（規則見待決清單）
frame consistency       animated particle texture 的 frame 幾何一致性（沿用 Animation 驗證）
atlas reference         於報告標示為 predicted／未驗證；完整 atlas 驗證屬 V0.5（§88）
Particle JSON           mc-asset MUST NOT 生成、修改或驗證其 schema（§43）
```

- `--profile minecraft:particle` 用途是報告與驗證的判斷；輸出仍只有 PNG（§34）。
- 「不強制統一尺寸」是 MUST NOT 級的界線：`pixelize --preset particle` 也 MUST NOT 因此把輸出鎖進某個固定尺寸，尺寸一律由 `--size` 決定（§28）。

應測點：兩個不同尺寸的 particle 素材各自驗證都不因尺寸被拒；particle 的 alpha 報告沿用 §40；atlas reference 欄位標示 predicted；particle preset 不引入固定尺寸。

---

## pixelize 的 gui／particle preset（docs §30、§87）

§87 把 `minecraft:gui` 與 `minecraft:particle` 列入 V0.4，docs §30 給的是兩者的方向而非數值：GUI 重 exact dimensions／hard edges／alpha precision／border preservation／flat colors；Particle 重 alpha／center of mass／small-scale readability／frame consistency。

掛接方式（本凍結）：

```text
--preset 合法值        於既有 item／block／generic 之外新增 gui／particle
PIXELIZE_PRESETS       新增兩個顯式參數組，與既有三組同構
可列印                 describePixelizePreset 對 gui／particle 也 MUST 回可列印摘要
管線順序               不變，仍是 §105.6 的十一階段；preset 只填參數，不跳階段
--profile 與 --preset  gui／particle 兩個名字在兩者都出現，但角色不同（§37）：
                       --preset 決定怎麼處理圖片，--profile 決定素材在 Minecraft 裡是什麼
```

- 具體數值（colors、cleanup classes 等）是 art-direction 決定，V0.4 先以 starter 落地並標明 pending art-direction review，與 V0.2 的三個 preset 同策略（§105.12 的待決延續）。
- gui preset MUST NOT 自動加上 nine_slice；nine_slice 來自素材自帶的 mcmeta，preset 不生成 metadata。
- particle preset MUST NOT 固定輸出尺寸（見 particle profile）。
- profile 的既有輸出規則不變：`minecraft:gui`／`minecraft:particle` 的輸出一律只有 PNG，其他副檔名是 `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT`（§34）。

應測點：`--preset gui`／`--preset particle` 可解析且可列印；未知 preset 被拒；兩 preset 重跑 byte-identical；gui／particle profile 的非 PNG 輸出被拒；preset 不改動管線階段順序。

---

## 共同約束（§57、§98、§100）

V0.4 的全部新表面適用 §57 與 §98；`animate` 另適用 §100 的 determinism 要求。

```text
無隱式輸出    缺輸出時 OUTPUT_REQUIRED，且零檔案（§57）
覆寫政策      OUTPUT_EXISTS／--force（§98.2）
父目錄        FILESYSTEM_ERROR／--mkdir（§98.3）
原子寫入      同目錄暫存加 rename；失敗不留半寫入產物（§98.4）
通道分工      --json 與 --stdout 依 §98.1，stdout 同時只承載一種載荷
整數優先      影響像素的運算以整數完成（§100.1）
禁超越函式    MUST NOT 用 Math.cbrt／pow／exp／sin 於影響像素的計算（§100.2）
禁隨機        V0.4 預設路徑不含亂數；若有亂數 MUST 由顯式 seed 導出，MUST NOT 用 Math.random（§100.3）
全序排序      不得依賴不穩定排序或物件鍵序；目錄列舉先排序（§100.3）
無時間戳      輸出內容 MUST NOT 含時間戳（§100.3）
報告浮點      以固定小數位序列化（§100.3）
跨 runtime    同 input／參數／版本，跨 macOS／Linux 與 Bun／Node byte-identical（§100.4、§100.5）
```

Exit code（本凍結；沿用 §99 的 registry，不建本地表）：

```text
animate pack／unpack／reorder／resize   0 / 2 / 4 / 5
animate validate                        0 / 2 / 3 / 4 / 5（3 為判定不合格）
animate preview                         0 / 2 / 4 / 5
preview --nine-slice                    0 / 2 / 4 / 5
validate（含 --mcmeta）                 0 / 2 / 3 / 4 / 5
```

`exit 3` 仍只由 validate 家族使用（§99）：`animate validate` 的判定不合格走 3，結構性錯誤（`INVALID_ANIMATION_FRAME`／`INVALID_MCMETA`）走 2。`exit 5` 涵蓋 `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT` 與 `RESOURCE_LIMIT_EXCEEDED`；`INVALID_DIMENSION` 為 exit 2。跨 runtime 比對 MUST 進 CI，比對失敗即失敗（§100.5）；V0.4 新增引擎 MUST NOT 依賴 Bun 專有 API（§100.5）。

應測點：`animate` 各 mode 的 §98 守衛矩陣（缺輸出、OUTPUT_EXISTS／`--force`、缺父目錄／`--mkdir`、別名或等同輸入）；三 layout 的 sheet 跨 Bun／Node byte-identical；`--nine-slice` 報告與 preview PNG 重跑相同；grep 層級檢查無 `Math.random` 與超越函式落在 pixel-critical 路徑。

---

## 待決清單

以下無法從規格推定，列出但不自行填補。前三項直接影響對外行為，需要決策後才適合定案。

| 項目 | 為什麼無法推定 | 需要什麼 | 現況 |
|---|---|---|---|
| frames 目錄接受 `.png` frame 嗎 | §48 只說 frame 是 PixelCanvas，§51 只排除 animation 進 `.mcpx` | 是否接受 PNG 作為 frame 輸入 | V0.4 凍結為只讀寫 `.mcpx` frame |
| frames 目錄內非 `.mcpx` 檔的處置 | 規格未提 | 忽略或拒絕 | V0.4 未定；待決 |
| mcmeta 欄位的值域與組合語意 | §46 只列欄位名，沒有值域；§47 只給一個例子 | 各欄位的合法值與 warning 組合 | V0.4 原樣回報、只給 warning；值域解讀待決 |
| GUI scaling 的 mcmeta 鍵路徑 | §42 只給 `stretch`／`tile`／`nine_slice`／`border` 名稱 | 精確 key path 與型別 | 以名稱定位；鍵路徑待相容層查證（§95） |
| 是否自動偵測同名 `.mcmeta` | §50 例子是 `texture.png.mcmeta`，但 §18 要求顯式路徑 | 是否允許推導 sibling | V0.4 一律顯式 `--mcmeta`；自動偵測待決 |
| grid layout 的預設欄數或自動排版 | §49 只列 layout 名稱 | 是否提供自動 grid | V0.4 強制顯式 `--columns`；維持或改動待決 |
| nine-slice preview 的放大方式 | §42 未定 preview 形狀 | 是否讓 `--scale` 併用 | V0.4 固定 1:1 |
| preview guide 的顏色與線寬 | 規格未定 | 是否固定色或可配置 | 凍結為 `#FF00FFFF` 1px；是否可配置待決 |
| `stretch preview`／`tile preview` | §42 列為「未來」 | 是否屬 V0.4 | 明確不在 V0.4 |
| `stretch_inner` 的行為 | §42 說「後續版本」 | 何時實作與語意 | 明確排除在 V0.4 外；只解析回報 |
| particle small-size readability 規則 | §43 只有方向 | 可測的規則或門檻 | V0.4 只呈現結構化資訊；規則待決 |
| particle frame consistency 規則 | §43 只有名稱 | 一致性判準 | 沿用 Animation 幾何驗證；專屬規則待決 |
| GUI scaling 驗證規則 | §46 只列「GUI scaling」 | 判準與門檻 | V0.4 只做 border 幾何；scaling 判準待決 |
| palette metadata 檢查 | §46 只列名稱 | 要檢查什麼 | 未定義；待決 |
| atlas reference 驗證 | §43 列為 particle 重點，但 atlas 屬 V0.5（§88） | 何時做 | V0.4 只標 predicted；V0.5 實作 |
| `pixelize` gui／particle preset 的數值 | docs §30 只有方向 | 各 preset 的參數值 | 先以 starter 落地並標 pending art-direction review |
| `animate preview` 的豐富形式 | §39 只有「preview animation」 | filmstrip／時間軸等輸出 | V0.4 只有結構報告與 sheet ASCII |
| `animate` 用 subcommand 或旗標 | 規格未定 CLI 形狀 | 命令形狀 | 凍結為 subcommand；維持或改動待決 |
| unpack 輸出 frame 的格式 | §48 未定 frame 的檔形式 | `.mcpx` 或 PNG | V0.4 凍結為 `.mcpx` |
| `FrameSetMetadata` 的內容 | §48 只給型別名 | 有哪些欄位、是否影響行為 | V0.4 原樣保留、不解析 |
| `animate preview --ascii` 的尺寸上限 | 規格未定；token 成本是實務問題 | 上限值或降級策略 | 沿用 `preview --ascii` 的政策；上限待決 |

「現況」一欄只記本凍結的判定，不代表任何項目已定案；未提到的細節仍以各節敘述為準。

---

## 實作交接

後續實作這批功能時，可直接沿用的既有接縫（權威來源是各檔案）：

```text
輸出守衛與原子寫入   src/cli/artifacts.ts（resolveArtifactTargets、preflightArtifactTargets、
                     writeArtifactPayloads、emitCommandSuccess/Failure）、src/cli/filesystem.ts
                     minecraft profile 的 PNG-only 閘門是 assertMinecraftOutputPath，目前只認
                     minecraft:item／minecraft:block；t03 併入 gui／particle 時需同步這個閘門
通道分工             src/cli/channels.ts（routeStreams／emitArtifact／emitEnvelope／emitLog）
輸入 intake          src/cli/canvas-input.ts（loadEditableCanvas）、src/io/decode.ts（decodeImage）
flatten 與 PNG       src/io/png.ts（flattenCanvas、encodePng）
單邊／WxH 尺寸解析    src/core/pixelize.ts（parsePixelizeSize、PIXELIZE_PRESETS、describePixelizePreset）
nearest／box 縮放     src/core/transform.ts（resize，模式 nearest／box；pixel-aware 拒絕）
尺寸上限             src/core/validate.ts（validateDimension、checkResourceLimits）
符號指派             src/mcpx/assign.ts（assignSymbols、collectCanvasColors）
`.grid` 讀寫相容     src/cli/grid.ts（parseGridFile；preview --ascii 的輸出以此格式為準）
profile 註冊         src/cli/profiles.ts（SUPPORTED_PROFILES、parseProfile）、src/profiles/profiles.ts
                     （getAssetProfile、describeAssetProfilePredicted）、src/profiles/types.ts（AssetProfileId）
驗證引擎             src/validate/checks.ts（validateCanvas）、src/cli/validate.ts（runValidate）
錯誤碼與 exit        src/core/errors.ts（ERROR_EXIT_CODE；INVALID_ANIMATION_FRAME／INVALID_MCMETA 已存在）
```

模組切分的交接要點（給 t02／t03／t04）：

```text
t02  animate 引擎與命令
     純引擎：FrameSet 模型與 pack／unpack／reorder／resize（不碰 CLI 接線）
     接線：animate subcommand 掛進 program.ts；輸出守衛走既有 artifacts／filesystem
     碰 program.ts：是（新增 animate 命令）

t03  gui／particle profile 與 nine-slice preview
     純引擎：profile 註冊（profiles.ts／cli/profiles.ts 的 id 集合）與 nine-slice 幾何推導
     接線：--profile 值、--preset 值、preview --nine-slice 模式
     碰 program.ts：是（--profile／--preset 值集合與 preview 新模式）

t04  mcmeta 讀取與 mipmap 驗證整合
     純引擎：mcmeta parser（只讀）＋ frame geometry／index／count 驗證＋ mipmap 結構化資訊
     接線：validate --mcmeta；與 t02 的 frame 幾何驗證共用 helper
     碰 program.ts：是（validate 新旗標）
```

- 序列化注意（給主代理）：t02、t03、t04 都可能碰 `src/cli/program.ts`（新命令、旗標、值集合與新 validate 旗標），依 §105.10 的接線權責 MUST 依序執行、MUST NOT 並行；純引擎模組各自獨立，可先落地。
- t03 若同時改 `src/cli/profiles.ts` 的 `SUPPORTED_PROFILES` 與 `src/profiles/types.ts` 的 `AssetProfileId`，兩處的值集合 MUST 同步；既有 `generic`／`minecraft:item`／`minecraft:block` 不得更動。
- t04 的 mcmeta parser MUST 只讀；`INVALID_ANIMATION_FRAME`／`INVALID_MCMETA` 已在 `src/core/errors.ts` 註冊為 exit 2，不需新增錯誤碼。
- t02 的 sheet 尺寸推導、t04 的 frame 幾何推導 MUST 用同一份整數公式，避免兩處各自實作。

## 後續實作的共同義務

- 任何規範性語句若在本文件找不到出處或「（本凍結）」標記，一律視為需要回頭補規格，不得直接實作。
- 每個「應測點」都要有對應測試；MUST 級敘述沒有測試涵蓋即為 bug（§1.1）。
- 發現本文件與 `project-detail.md` 或 `project-docs.md` 不一致時，以 `project-detail.md` 為準，並回頭更新本文件與 `docs/cli-surface.md`。
- 標「（待決）」的項目在定案前 MUST NOT 被當成已凍結的行為；實作若必須先動，採最小、可測、確定性的 starter 並在回報標明。

