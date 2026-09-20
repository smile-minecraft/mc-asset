# V0.3 設計凍結：Tile、Procedural、Preview 的語意與介面

V0.3 加入 Tile Engine、Block Texture Workflow、Procedural Generator、Tile Preview 與 Seam Analysis（§86）。這份文件把這批功能的判斷固定下來，讓後續實作不必在語意、演算法與旗標上各自猜測；命令表面（名稱、旗標、輸入輸出、exit code）以 `docs/cli-surface.md` 的「V0.3 commands (frozen)」為準，規範性結論記於 `project-detail.md` §106。

服務對象是要動 `tile`、`generate`、`preview`，以及以 block profile 串接這三者的工程師與 Agent。

規格只給了功能名稱與少數範例（docs §36、§37、§46；§65），沒有給演算法、分數公式或旗標語意。因此這份文件把多數細節標成「（本凍結）」，並在文末列出無法推定的「（待決）」項目。

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
| 命令表面 | 三個命令進場：`tile` / `generate` / `preview`；沿用 §57、§98 全部輸出守衛 | §86、§48、§65、docs §36/§37/§46 | 缺輸出零檔案；名稱與現有命令無衝突 |
| Seam 指標 | wrap 邊界像素對的整數平方 RGBA 距離；正規化為 0（無縫）–1（最大不連續） | §65、docs §36、refs §14 | worked example 的 raw 與 score 可重現 |
| Repetition | 各軸最小週期位移的自相似度；平手取最小位移 | §65、docs §36、refs §14 | 2x2 棋盤 example；同輸入同分數 |
| 修正旗標 | `--edge-match` / `--brightness-match` 為顯式 opt-in；整數平均與整數亮度對齊 | §65、docs §36 | 未加旗標時像素零變動 |
| Block 工作流 | `tile` + `generate` + block profile 組合；不新增命令；§65 的 authoring tools 不變 format requirement | §65、§86、docs §30/§36/§37 | 分析結果只影響作者決策，不寫進 `.mcpx` |
| Preview 輸出 | `.grid` 相容 ASCII、`--scale` 整數 nearest 放大 PNG、palette map JSON | docs §46 | ASCII 輸出可被 `render` 讀回 |
| 共同約束 | §57、§98、§100 全套；exit 0/2/4/5 | §57、§98、§100 | 跨 runtime byte-identical；無 `Math.random` |
| 種子 | `generate --seed` 必填；禁 `Math.random`、禁超越函式 | §100.2、§100.3、§86 | 同 seed 同 bytes；跨 runtime 比對 |

---

## 命令表面

V0.3 新增三個命令，名稱在 `docs/cli-surface.md` 的 V0.1 保留清單（`tile`、`preview`）與 `docs §48` 的 command tree（`generate`）中都已經出現，且不與 `src/cli/program.ts` 既有命令（`stub`、`analyze`、`validate`、`import`、`render`、`transform`、`quantize`、`cleanup`、`palette`、`material`、`recolor`、`build`、`pixelize`、`variant`）同名。

| 命令 | 一句話語意 | 產物檔 |
|---|---|---|
| `tile <input>` | Block texture 的接縫與重複分析；可產生修正後單格或重複預覽 PNG | 可（PNG） |
| `generate <pattern>` | 由確定性 pattern 與 palette 產生新素材 | 可（PNG 和/或 `.mcpx`） |
| `preview <input>` | 不靠 Vision Model 重新理解素材（ASCII、放大 PNG、palette map） | 可（僅 `--scale`） |

共同約束（全部為 MUST，沿用 §57、§98）：

```text
產生檔案的命令       缺 --output／--stdout 時 OUTPUT_REQUIRED，且不建立任何檔案（§57）
輸出檔已存在          預設 OUTPUT_EXISTS，--force 才允許覆寫（§98.2）
父目錄不存在          預設 FILESYSTEM_ERROR，--mkdir 才建立（§98.3）
寫入                  同目錄暫存檔加 rename；失敗不留半寫入產物（§98.4）
路徑                  全部由呼叫端指定；不得推導檔名、不得建立預設目錄（§18、docs §7、docs §8）
通道                  --json 與 --stdout 的分工依 §98.1
輸入 intake            PNG／JPEG／WebP／.mcpx，與 transform 一致（本凍結）
```

`tile` 與 `preview` 的輸入走與 `transform` 相同的共用入口（`.mcpx` 以文字解析，其餘走多格式 raster 解碼）；多層或可見性不同的 `.mcpx` 在分析前先 flatten 成單一 RGBA 緩衝（與 `palette inspect` 一致）。`generate` 沒有輸入檔，輸入是 pattern 名稱與旗標。

應測點：每個命令在缺輸出時都不產生任何檔案；命令名稱不與既有命令衝突；`.mcpx` 與 PNG 兩種輸入都能進 `tile`／`preview`；`preview` 與 `tile` 對多層 `.mcpx` 的 flatten 結果一致。

### `tile <input>`

三種用途，由旗標決定：

```text
無 --output／--stdout        只做分析，輸出接縫與重複報告（人類或 --json），零檔案
--output <png>               寫出單格 tile PNG（可選修正後）
--preview <NxN> --output     寫出 NxN 重複預覽 PNG（N ∈ {2,4,8}）；缺 --output 為 OUTPUT_REQUIRED
```

旗標：

```text
--preview <2x2|4x4|8x8>      重複預覽尺寸；其他值是 INVALID_ARGUMENT（refs §14 的三個尺寸）
--edge-match <axis>          接縫邊緣對齊；axis ∈ horizontal|vertical|both（本凍結）
--brightness-match <axis>    接縫邊緣亮度對齊；axis ∈ horizontal|vertical|both（本凍結）
--output <png>               單格 tile 或預覽 PNG 的輸出路徑
--stdout                     PNG bytes 走 stdout
--force / --mkdir / --input <path> / --profile <name>
```

- 未帶任何修正旗標時，`--output` 寫出的單格 tile 就是輸入像素的重新編碼，像素 byte 不變（本凍結；對應 docs §36 的 `tile stone.png --output ./stone_tile.png`）。tile 的產物固定是 PNG。
- `--preview` 給定時，`--output` 的目標改成 NxN 重複預覽：把（修正後的）單格以 1:1 方式在 x、y 各貼 N 次，尺寸為 `W·N` × `H·N`，不做縮放。超過 §102 的 4096 上限是 `INVALID_DIMENSION`。
- `tile` 不宣告 `--source` 與 `--in-place`：沒有可編輯輸出，也不提供原地改寫。用到這兩個旗標是未知選項（exit 2）。
- `--profile minecraft:block` 可用；`--output` 非 `.png` 時依 §34 是 `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT`。

報告形狀（`--json`，本凍結）：

```json
{
  "success": true,
  "result": {
    "command": "tile",
    "profile": "generic",
    "width": 2,
    "height": 2,
    "seam": {
      "horizontal": { "raw": 0, "pairs": 2, "score": "0.000000" },
      "vertical": { "raw": 390150, "pairs": 2, "score": "0.750000" },
      "corner": { "raw": 390150, "pairs": 2, "score": "0.750000" }
    },
    "repeat": { "score": "0.250000", "periodX": 1, "periodY": 1 },
    "corrections": [],
    "output": "stone_tile.png"
  }
}
```

- `seam` 與 `repeat` 一律描述**載入後的輸入**（修正前）。有修正旗標時，額外帶 `corrected: { seam, repeat }`，描述實際寫出的（修正後）像素（本凍結）。
- `corrections` 是套用順序的字串陣列，例如 `["edge-match:vertical","brightness-match:both"]`；沒有修正時是空陣列。
- `output` 只在有寫檔時出現；`--stdout` 時帶 `stdout: true`；`repeat.periodX`／`periodY` 在該軸長度 ≤ 1 時是 `null`。
- `profile` 固定回報；`--json` 未使用時，人類輸出是一行 `ok tile profile=… seam=… repeat=…` 加 warning 行。

應測點：`tile fixture.png --output out.png` 在無修正旗標時輸出的像素等於輸入；`--preview 4x4 --output` 產生 `4W` × `4H`；`--preview 3x3`、`--preview` 缺 `--output`、`--source`、`--in-place` 各自被拒；`--json` 形狀凍結且重跑 byte-identical；修正旗標存在時 `corrected` 才出現。

### `generate <pattern>`

```text
generate <pattern> --size N|WxH --palette <name|path> --seed <int> [--output <png>] [--source <mcpx>] [--stdout]
```

十個 pattern 的 CLI 名稱（本凍結）：規格以空白書寫 `clustered noise`，CLI 位置參數必須是單一 token，因此固定為小寫、空白改連字號：

| CLI 名稱 | docs §37 名稱 |
|---|---|
| `noise` | noise |
| `clustered-noise` | clustered noise |
| `stripes` | stripes |
| `checker` | checker |
| `gradient` | gradient |
| `brick` | brick |
| `spots` | spots |
| `veins` | veins |
| `cracks` | cracks |
| `grain` | grain |

未知 pattern 是 `INVALID_ARGUMENT`，details 帶出錯的名稱。

旗標：

```text
--size <N|WxH>      必填；解析與 pixelize 相同（單邊 N 等於 NxN）；缺或非整數是
                    INVALID_ARGUMENT；維度越界是 INVALID_DIMENSION（本凍結）
--palette <name|path>
                    必填；內建 material 名或 palette 檔路徑（解析優先序見下）
--seed <int>        必填；整數 0 – 4294967295；缺或非整數是 INVALID_ARGUMENT
--output <png> / --source <mcpx> / --stdout
                    至少一個，否則 OUTPUT_REQUIRED 且零檔案（§57）
--force / --mkdir / --profile <name>
```

- `--palette` 的解析優先序（本凍結）：先比對內建 material id（`iron`／`copper`／`oxidized_copper`／`gold`／`wood`／`stone`／`crystal`，§67）；完全相符就用該 material 的 palette。否則視為檔案路徑，且必須是 `.mcpx`（否則 `INVALID_ARGUMENT`），取其 `[palette]` 作為可用色；檔案不存在或不可讀是 `FILESYSTEM_ERROR`，內容不符 §96 文法回對應的 `MCPX_*` 碼。規格只示範材料名形式（docs §37 的 `--palette stone`），palette 檔形式是本凍結的延伸。
- 產生的每個像素 MUST 是解析出的 palette 成員，或 `transparent`（`#00000000`）；MUST NOT 產生 palette 外的中間色（本凍結）。
- `--seed` 必填的理由是 §100.3：亂數 MUST 由顯式 seed 導出，MUST NOT 使用 `Math.random`。同 `--pattern`／`--size`／`--palette`／`--seed`／版本 MUST 產生 byte-identical 輸出。
- PRNG 是 starter（本凍結，starter）：32-bit 整數 xorshift，初始狀態 `(seed ^ 0x9E3779B9) >>> 0`，逐步 `x ^= x << 13; x ^= x >>> 17; x ^= x << 5`（每步都遮成 32-bit）。各 pattern 的取樣與上色演算法屬待決（見文末），但無論用哪個演算法都 MUST 是整數、MUST NOT 用超越函式（§100.2）。
- `--source` 寫 `.mcpx` 時，色數超出 §97 容量是 `MCPX_PALETTE_OVERFLOW`（沿用既有守衛）。
- 成功 envelope 沿用既有 write 命令形狀：`command`／`profile`／`applied: 0`／`operations: []`／`warnings`，加上 `pattern`、`seed`、`width`、`height`、`palette`（解析來源名或路徑）、`output`／`source`／`stdout`。

應測點：缺 `--size`／`--palette`／`--seed` 各自 `INVALID_ARGUMENT` 且零檔案；十個 pattern 名稱皆可解析；同 seed 重跑 byte-identical；跨 Bun／Node byte-identical；未知 pattern 與非 `.mcpx` palette 檔被拒；輸出只含 palette 色與 transparent。

### `preview <input>`

```text
preview <input> --ascii | --palette-map | --scale <N>
```

一次呼叫 MUST 剛好帶一種模式旗標（本凍結）：都不帶是 `INVALID_ARGUMENT`，帶兩種以上是 `ARGUMENT_CONFLICT`。

| 模式 | 輸出 | 檔案旗標 |
|---|---|---|
| `--ascii` | `.grid` 相容 ASCII 文件（stdout；`--json` 時在 envelope 內） | 檔旗標一律拒絕（`INVALID_ARGUMENT`） |
| `--palette-map` | palette map JSON（唯讀報告） | 檔旗標一律拒絕（`INVALID_ARGUMENT`） |
| `--scale <N>` | 整數 nearest 放大的 PNG | 需要 `--output` 或 `--stdout`，否則 `OUTPUT_REQUIRED` |

- `--scale <N>`：N 是整數且 ≥ 1；輸出尺寸 `W·N` × `H·N`，用與 `transform --resize` 相同的 `nearest`（§38）；超過 §102 上限是 `INVALID_DIMENSION`。`--scale 1` 是合法 identity。
- `--ascii` 與 `--palette-map` 是唯讀報告，比照 `palette`／`material`：`--output`／`--stdout`／`--source`／`--force`／`--mkdir`／`--in-place`／`--input` 任一出現即 `INVALID_ARGUMENT`。
- `preview` 不宣告 `--in-place` 與 `--source`。放大後原地改寫用 `transform --resize`，不由 preview 承擔。

應測點：三種模式的輸出形狀各一；零模式與多模式被拒；`--scale` 缺輸出零檔案；`--scale 2` 的像素是整數 nearest 放大；報告模式帶檔旗標被拒。

### 共同旗標收斂

```text
tile      --preview / --edge-match / --brightness-match / --output / --stdout / --force / --mkdir / --input / --profile / --json
generate  --size / --palette / --seed / --output / --source / --stdout / --force / --mkdir / --profile / --json
preview   --ascii / --palette-map / --scale / --output / --stdout / --force / --mkdir / --input / --profile / --json（依模式）
```

`--profile` 的合法值沿用 V0.1 的三個（`generic`／`minecraft:item`／`minecraft:block`）。V0.3 不新增 profile；§30 的 block preset 是 `pixelize --preset block` 的方向來源，不是新的 profile 值。

---

## Seam 指標

### Wrap 邊界像素對

Block texture 貼成平面時，右緣接左緣、下緣接上緣。因此「接縫」是**環繞相鄰**的像素對，不是圖片內部相鄰：

```text
vertical seam    （W-1, y）與（0, y），對每個 y ∈ [0, H)
horizontal seam  （x, H-1）與（x, 0），對每個 x ∈ [0, W)
corner seam      （0, 0）與（W-1, H-1），以及（W-1, 0）與（0, H-1）
```

命名沿用 refs §14（`horizontal_seam_score`／`vertical_seam_score`／`corner_seam_score`）：horizontal seam 是「上下緣之間那條橫向接縫」，vertical seam 是「左右緣之間那條縱向接縫」。軸長度為 1 的退化軸只與自己比（距離 0），與 `analyze` 的 `tileFriendly` starter 規則一致。

### 距離與分數公式（本凍結）

單對距離用與 `src/core/palette.ts` 的 `squaredDistance` 相同的整數平方 RGBA 距離：

```text
d(a, b) = (a.r-b.r)² + (a.g-b.g)² + (a.b-b.b)² + (a.a-b.a)²
```

- `raw` = 該接縫所有像素對的 `d` 總和，整數。
- `pairs` = 像素對數：vertical = H、horizontal = W、corner = 2。
- `score` = `raw / (pairs × 260100)`，`260100 = 4 × 255²` 是單對最大距離；以固定 6 位小數字串序列化（§100.3）。

值域與方向：`score` 落在 `[0, 1]`，**0 是無接縫、1 是最大不連續，數字越小越好**。三個分數分開回報，不合併成單一值。

全序 tie-break：總和順序固定為列優先（row-major），比較順序固定 `horizontal → vertical → corner`；不得依賴物件鍵序或不穩定排序（§100.3）。

### Worked example

2×2 canvas，`B = #000000FF`、`W = #FFFFFFFF`：

```text
(0,0)=B  (1,0)=W
(0,1)=B  (1,1)=W
```

`d(B, W) = 255² × 3 = 195075`；`d(B, B) = d(W, W) = 0`。

```text
vertical    y=0：d(W,B)=195075；y=1：d(W,B)=195075
            raw = 390150，pairs = 2，score = 390150 / 520200 = 0.750000
horizontal  x=0：d(B,B)=0；x=1：d(W,W)=0
            raw = 0，pairs = 2，score = 0.000000
corner      d(B,W)=195075；d(W,B)=195075
            raw = 390150，pairs = 2，score = 0.750000
```

這是一個橫向無縫、縱向有接縫的棋盤：`horizontal` 為 0，`vertical` 與 `corner` 為 0.75。

應測點：上例的三個 raw／pairs／score 逐值鎖定；1×1 與單列／單行 canvas 的退化軸為 0；`score` 以固定 6 位小數序列化；同輸入重跑同分數。

---

## Repetition scoring

`repetition_score` 衡量「這張圖在小於自身的週期上重複自己」的程度；大尺度、明顯的重複對 block texture 是缺點（§65 的 repeat detection、refs §14 的 large feature repetition）。規格只給名稱，以下是本凍結的最簡可測定義。

### 定義（本凍結）

對每個軸獨立找出最佳環繞週期位移：

```text
候選       軸長度 len 的 shift s ∈ [1, len-1]；len ≤ 1 時無候選
totalDist(s) = Σ over 全圖像素 p：d(pixel(p), pixel(p 於該軸環繞位移 s))
最佳 shift s* = totalDist(s) 最小者；平手取最小 s（全序 tie-break）
軸相似度     = 1 - totalDist(s*) / (W × H × 260100)
```

`d` 與 260100 沿用「Seam 指標」的定義。`periodX`／`periodY` 就是 `s*`，該軸無候選時為 `null`。整體分數取兩軸相似度的最大值（最明顯的重複軸）：

```text
repetition_score = max(軸相似度_x, 軸相似度_y)        ；皆無候選時為 0
```

方向：**0 表示找不到小週期重複，1 表示完美週期重複**；越低越好，與 seam 分數同向。

### Worked example

同一個 2×2 棋盤：x 軸只有 s=1，全圖四對都是 `d(B,W)=195075`，`totalDist=780300`，`W×H×260100 = 1040400`，相似度 `1 - 0.75 = 0.25`；y 軸相同。因此：

```text
repeat = { "score": "0.250000", "periodX": 1, "periodY": 1 }
```

應測點：上例的 score／period 逐值鎖定；單色圖在 s=1 的相似度為 1（分數 1.0）；1×1 canvas 的 periodX／periodY 為 `null` 且分數 0；平手時取最小 s；同輸入同分數。

### 已知成本（待決）

每個軸要試 `len-1` 個位移，每個位移掃全圖，成本約 `O(W·H·(W+H))`。對 16–128 的 block texture 沒有問題；4096 級輸入會偏重。規格沒有給複雜度上限，這一項列入待決。

---

## Edge matching 與 brightness matching

兩者都是**修正**：會改動像素，因此 MUST 顯式啟用，MUST NOT 默默修改（§63 的顯式授權原則）。兩者都只作用在環繞邊界像素，且套用後才產生 `--output` 的 tile 或預覽。

### `--edge-match <axis>`（本凍結）

把選定接縫的兩個邊界線，逐像素以整數平均對齊，讓兩線互相 byte-equal，該軸接縫距離歸零：

```text
vertical    每一 y：col0[y] 與 col(W-1)[y] 都設為 (a+b) 各 channel 的 floor 平均
horizontal  每一 x：row0[x] 與 row(H-1)[x] 都設為 floor 平均
both        先 vertical 再 horizontal，順序固定
```

理由：對稱平均不偏袒任一側，且結果兩線相同，`vertical` 或 `horizontal` 的 `raw` 變 0，是可測的整數結果。`both` 的固定順序讓角點固定：先縱後橫不會重新打開已對齊的軸（兩條線已相等，橫向平均維持相等）。

期望效果（以 worked example 檢驗）：2×2 棋盤套 `--edge-match vertical` 後，col0 的 `B` 與 col1 的 `W` 都設為整數平均 `floor((0+255)/2)=127`，即 `#7F7F7FFF`，兩線相等；`vertical` 的每對距離成為 0，`raw` 由 390150 降為 0，`score` 由 0.750000 降為 0.000000。

### `--brightness-match <axis>`（本凍結）

把選定接縫的兩個邊界線的**平均亮度**對齊：

```text
亮度        lum(p) = floor((299·r + 587·g + 114·b) / 1000)，與 recolor 的整數 luminance 一致
線平均亮度  floor(Σ lum(pixel) / 該線像素數)
delta       line1 平均亮度 − line2 平均亮度
套用        delta > 0 → line2 每個像素的 r/g/b 各加 delta；delta < 0 → line1 各加 −delta
            channel 夾在 [0, 255]；alpha 不變
both        先 vertical 再 horizontal，順序固定
```

- 亮度是整數，MUST NOT 用浮點或超越函式（§100.1、§100.2）。
- 期望效果：把接縫的**平均亮階**對齊，處理接縫的亮度落差。它**不保證**讓 seam 分數下降，因為對一條線整體加值會改變每一對的 RGB 差，可能增也可能減；夾在邊界時對齊也可能是近似的。文件與測試 MUST 這樣描述，不得宣稱一定改善。
- 兩者可同時使用；套用順序固定 `--edge-match` 先、`--brightness-match` 後（本凍結），並記進 `corrections`。

### 輸出語意

- 修正只影響寫出的 tile／預覽；輸入檔 MUST NOT 被改寫（§59），`tile` 也不提供 `--in-place`。
- 未帶修正旗標時，`--output` 寫出的像素與輸入的 flatten 結果 byte-identical（本凍結）。
- 修正後的實際分數放在報告的 `corrected`（「命令表面」已定義）。

應測點：無修正旗標時輸出像素不變；`--edge-match vertical` 後該軸 `raw` 為 0；`--edge-match both` 的結果不隨旗標書寫順序改變；亮度對齊只改 RGB 且夾在範圍內、alpha 不變；`corrections` 的內容與套用順序一致。

---

## Block Texture Workflow

V0.3 的 block 工作流是既有命令的**組合**，不新增命令（§86、§65）：

```text
generate ──▶ tile ──▶ preview ──────────▶ pixelize --preset block ──▶ 單張 PNG
  產生底材     接縫分析      放大／palette 檢視      收色、整理
              可選修正
```

- `generate` 做出確定性的底材（pattern + palette + seed），輸出 PNG 或 `.mcpx`。
- `tile` 量測接縫與重複，必要時用顯式修正旗標產生修正後的單格；`tile --preview` 產生重複預覽檢查大尺度重複。
- `preview` 讓 Agent 以 ASCII／palette map 理解素材，或以 `--scale` 放大檢視。
- `pixelize --preset block`（V0.2）負責收色與清理；其 preset 的具體數值仍依 V0.2 的待決清單。
- block profile（`--profile minecraft:block`）決定輸出契約（僅 PNG，§34）；§30 的 block 重點（tileability、low seam visibility）是作者方向，不是驗證規則。

界線（§65、§66）：seam analysis、tile generation、tile preview、brightness normalization、cluster analysis、repeat detection 都是 **authoring tools**，MUST NOT 變成 Minecraft format requirement，也 MUST NOT 寫進 `.mcpx` 當成格式語意（與 V0.2 Selection 不序列化的規則同向）。這些量測結果只出現在報告與 `--json`。

應測點：整條工作流只用既有命令完成，沒有新命令；`tile`／`preview` 的結果不回寫 `.mcpx`；`--profile minecraft:block` 的輸出一律 PNG。

---

## Preview 輸出形狀

### `--ascii`

輸出是一份 **`.grid` 相容文件**：先 `[palette]` 區段，再 `[grid]` 或 `[grid tokens]`（§96.8），因此可以直接餵給 `render` 完成「看圖 → 改圖 → 重畫」的閉環（docs §46、§104.2）。

- 符號指派沿用 §96.6：輸入是 `.mcpx` 時保留其既有符號；否則用與 `serializeMcpx` 相同的指派（transparent 固定 `.`，其餘依 RGBA 32-bit 鍵值升冪取 `. 0-9 A-Z a-z`，超過 compact 範圍改用 `T0001` 形式的 token）。
- 全為單字元符號時用 `[grid]`，否則用 `[grid tokens]`（§96.8 的 serializer 選擇規則）。
- 編碼 UTF-8、LF、行尾無空白；與 `.grid` 的解析要求一致。
- 人類模式直接印到 stdout；`--json` 時整份文件放在 `result.ascii`（行陣列），並帶 `result.palette`（符號 → `#RRGGBBAA`）與 `width`／`height`。
- `--ascii` 是對**flatten 後**的單層畫布做，多層與 region 不進入輸出。

```text
[palette]
0 = #000000FF
1 = #FFFFFFFF

[grid]
01
01
```

（此例的 2×2 棋盤不含 `#00000000`，依 §96.6 保留符號 `.` 因此不出現在 palette；若輸入含 transparent，`. = #00000000` 一定會出現且只給 transparent。）

### `--palette-map`

JSON 形狀（本凍結）：

```json
{
  "success": true,
  "result": {
    "command": "preview",
    "mode": "palette-map",
    "profile": "generic",
    "width": 2,
    "height": 2,
    "colors": [
      { "index": 0, "color": "#000000FF", "count": 2 },
      { "index": 1, "color": "#FFFFFFFF", "count": 2 }
    ],
    "rows": [[0, 1], [0, 1]]
  }
}
```

- `colors` 依**首次出現順序**（列優先掃描）編號，與 `extractPalette` 的 first-appearance 一致；`rows[y][x]` 是該像素的顏色索引。
- `count` 是該顏色的像素數；索引與 rows 的遍歷順序固定，不得依賴物件鍵序（§100.3）。

### `--scale`

- 輸出 PNG，尺寸 `W·N` × `H·N`，整數 `nearest` 放大（§38），不做插值、不產生新顏色。
- `--output`／`--stdout` 至少一個，否則 `OUTPUT_REQUIRED`；`--force`／`--mkdir` 沿用 §98。

### tile preview 與 `tile --preview` 的關係

docs §46 把「tile preview」列在 Preview 能力下，docs §36 則把 `--preview NxN` 放在 `tile`。兩者**是同一個功能**，只保留一個入口（§104.1 不保留同義詞）：重複預覽的權威入口是 `tile <input> --preview <NxN> --output <png>`（本凍結）。`preview` 不新增 tile 旗標，`preview` 的模式固定是 ASCII／palette map／scale。

應測點：`preview --ascii` 的輸出能被 `render` 讀回且像素一致；`--palette-map` 形狀凍結；`--scale 2` 的尺寸與像素正確；`tile --preview` 與 `preview` 沒有重複的 tile 旗標。

---

## 共同約束（§57、§98、§100）

V0.3 的三個命令全部適用 §57 與 §98；`generate` 另有 seed 與 PRNG 的 determinism 要求。

```text
無隱式輸出    缺輸出時 OUTPUT_REQUIRED，且零檔案（§57）
覆寫政策      OUTPUT_EXISTS／--force（§98.2）
父目錄        FILESYSTEM_ERROR／--mkdir（§98.3）
原子寫入      同目錄暫存加 rename；失敗不留半寫入產物（§98.4）
通道分工      --json 與 --stdout 依 §98.1，stdout 同時只承載一種載荷
整數優先      影響像素的運算以整數完成（§100.1）
禁超越函式    MUST NOT 用 Math.cbrt／pow／exp／sin 於影響像素的計算（§100.2）
禁隨機        generate 的亂數 MUST 由 --seed 導出；MUST NOT 用 Math.random（§100.3）
全序排序      不得依賴不穩定排序或物件鍵序（§100.3）
無時間戳      輸出內容 MUST NOT 含時間戳（§100.3）
報告浮點      以固定小數位序列化（§100.3）
跨 runtime    同 input／參數／版本，跨 macOS／Linux 與 Bun／Node byte-identical（§100.4、§100.5）
```

Exit code（本凍結；沿用 §99 的 registry，不建本地表）：

```text
tile      0 / 2 / 4 / 5
generate  0 / 2 / 4 / 5
preview   0 / 2 / 4 / 5（--scale 才可能有 4）
```

`exit 3` 仍專屬 `validate`（§99）。跨 runtime 比對 MUST 進 CI，且比對失敗即失敗（§100.5）；V0.3 新增引擎 MUST NOT 依賴 Bun 專有 API（§100.5）。

應測點：三個命令各自的 §98 守衛矩陣（缺輸出、OUTPUT_EXISTS／`--force`、缺父目錄／`--mkdir`、別名或等同輸入）；`generate` 同 seed 跨 runtime byte-identical；grep 層級檢查無 `Math.random` 與超越函式落在 pixel-critical 路徑；`tile`／`preview` 的報告重跑相同。

---

## 待決清單

以下無法從規格推定，列出但不自行填補。前四項直接影響對外行為，需要決策後才適合定案。

| 項目 | 為什麼無法推定 | 需要什麼 | 現況 |
|---|---|---|---|
| 十個 pattern 的演算法 | docs §37 只列名稱，沒有取樣、遮罩或上色規則 | 各 pattern 的整數演算法定義 | 只凍結 CLI 名稱與 determinism 約束；演算法未定 |
| PRNG 的具體選型 | §100.3 要求由顯式 seed 導出，但未指定演算法 | 確認 PRNG 或沿用 starter | starter 為 xorshift32（見「命令表面」），待複核 |
| 各 pattern 的 `--palette` 取色方式 | 未定義如何從 palette 挑色（role？明度帶？隨機？） | 取色規則 | 只凍結「輸出限於 palette 與 transparent」 |
| `tile --output`（無 `--preview`）的語意 | docs §36 只示範命令，未說單格 tile 的轉換 | 確認「產生 tile」是否等於修正後單格 | 採最小讀法：無修正時即重編碼，待確認 |
| `repetition_score` 的精確定義 | refs §14 只有名稱 | 定義或門檻 | 本凍結給最小可測定義（各軸最小週期），待複核 |
| repeat 搜尋的成本上限 | 規格沒有複雜度要求 | 是否限制候選位移或大圖門檻 | 未定；目前對每個 s 掃全圖 |
| `corner seam` 的像素對 | refs §14 只有名稱 | 對角對的定義 | 採兩組對角 wrap 對，待複核 |
| `--brightness-match` 的期望效果 | 規格只列功能 | 是否要求分數必降 | 只保證對齊平均亮階，不宣稱分數必降 |
| palette 檔的格式 | docs §37 只示範材料名 | 是否接受 `.mcpx` 的 `[palette]` | 本凍結採 `.mcpx`；另一選項是 `palette extract` 的 JSON（未採） |
| `preview --ascii` 的輸出範圍 | docs §46 只說「ASCII Grid」 | 是否輸出完整 `.grid` 或只有 grid 列 | 本凍結採完整 `.grid` 以接回 `render`，待複核 |
| `clustered-noise` 的連字號命名 | 規格以空白書寫 | 連字號或底線 | 本凍結採連字號；材料 id 用底線，屬不同命名空間 |
| 是否提供 `--in-place`／`--source` | 規格未提 | 是否要原地改寫或 `.mcpx` 輸出 | `tile`／`preview` 目前不提供，待需求出現 |

---

## 實作交接

後續實作這三個命令時，可直接沿用的既有接縫（權威來源是各檔案）：

```text
輸出守衛與原子寫入   src/cli/artifacts.ts（resolveArtifactTargets、preflightArtifactTargets、
                     writeArtifactPayloads、emitCommandSuccess/Failure）、src/cli/filesystem.ts
通道分工             src/cli/channels.ts（routeStreams／emitArtifact／emitEnvelope／emitLog）
輸入 intake          src/cli/canvas-input.ts（loadEditableCanvas）、src/io/decode.ts（decodeImage）
flatten 與 PNG       src/io/png.ts（flattenCanvas、encodePng）
單邊／WxH 尺寸解析    src/core/pixelize.ts（parsePixelizeSize）、src/core/validate.ts（validateDimension）
nearest 放大         src/core/transform.ts（resize，模式 "nearest"）
符號指派             src/mcpx/assign.ts（assignSymbols、collectCanvasColors）
`.grid` 讀取相容     src/cli/grid.ts（parseGridFile；--ascii 的輸出以此格式為準）
材料 palette         src/core/material.ts（getMaterialPalette、BUILTIN_MATERIAL_IDS）
`.mcpx` 容量守衛      src/core/quantizer.ts（assertMcpxPaletteCapacity）
```

新引擎模組 SHOULD NOT 在此階段觸碰 `src/cli/program.ts`；命令接線集中一處，避免與 V0.2 的共用接縫互相覆蓋（沿用 V0.2 的接線權責原則）。

## 後續實作的共同義務

- 任何規範性語句若在本文件找不到出處或「（本凍結）」標記，一律視為需要回頭補規格，不得直接實作。
- 每個「應測點」都要有對應測試；MUST 級敘述沒有測試涵蓋即為 bug（§1.1）。
- 發現本文件與 `project-detail.md` 或 `project-docs.md` 不一致時，以 `project-detail.md` 為準，並回頭更新本文件與 `docs/cli-surface.md`。
- 標「（待決）」的項目在定案前 MUST NOT 被當成已凍結的行為；實作若必須先動，採最小、可測、確定性的 starter 並在回報標明。
