# V0.2 設計凍結：語意、演算法與介面

V0.2 加入 Transform、Selection、進階 Layer／Region 操作、Recolor、Variant、Material、Pixelizer、Cleanup、Quantizer（§85）。這份文件把這些功能的判斷固定下來，讓後續實作不必在語意、演算法與旗標上各自猜測。

服務對象是要動 `transform`、`quantize`、`cleanup`、`pixelize`、`palette`、`material`、`recolor`、`variant` 與 `analyze` 的工程師。

## 位階與來源標記

規範條文以 `.project-doc/project-detail.md` 為準（§1.2），命令表面（名稱、旗標、輸入輸出、exit code）以 `docs/cli-surface.md` 為準。這份文件承載兩者之間的語意、演算法選型與取捨理由，衝突時先比對技術規格書，再更新這份文件。

```text
§n         project-detail.md 第 n 節（規範）
docs §n    project-docs.md 第 n 節（產品規格書，非規範）
（本凍結）  規格未給定、由這份凍結決定；附理由與應測點
（待決）    規格無法推定，列入文末清單，不自行填補
```

規範強度依 §1.1：MUST／不得＝必須有測試涵蓋，違反即為 bug；SHOULD／建議＝可附理由偏離，偏離要記錄；MAY／可＝實作自由。

## 凍結摘要

| 主題 | 凍結結論 | 出處 | 應測點 |
|---|---|---|---|
| 命令表面 | 九個命令進場；全部遵守 explicit output、OUTPUT_EXISTS、原子寫入、不建預設目錄 | §57、§98、docs §7、docs §8 | 缺 output 時零檔案 |
| Selection | 矩形或 region mask；選取外像素 byte 不變；不進 `.mcpx` | §13、§14、§31 | 選取外 golden 不變 |
| Transform | 一次一個幾何操作；整數座標；rotate 90 ×4 byte-identical | §28、§32、§38 | 四轉回原圖 byte 相同 |
| Quantizer | 整數 median-cut；無超越函式、無隨機；全序 tie-break | §100.1、§100.2、§100.3 | 同輸入跨 runtime 同 bytes |
| Cleanup | 預設只偵測不改像素；改 alpha 語意的類別要顯式授權 | §63、§40 | 未加旗標時像素零變動 |
| Pixelize | 固定十一階段管線；preset 為顯式參數組；Minecraft profile 只出 PNG | §28、§34、§64 | 管線順序 golden |
| 解碼器 | 純 JS／WASM；禁 premultiply 與 sharp 系；準則已定、實證未做 | §101.1、§100.5、docs §50 | 跨 runtime 解碼一致 |
| Material／Recolor | Material = palette + characteristics；role-aware 優先、luminance 回退 | §67、§68、§15 | role 映射 golden |
| Analyze | 新增三組 deterministic 欄位；`--json` 形狀凍結 | §62 | 同輸入同報告 |
| 接線權責 | 引擎模組不碰 CLI 接線；整合集中一處；後段依序 | 本凍結 | 檔案歸屬檢查 |
| Variant | `--output-dir` 必須顯式；命名規則固定；重跑 byte-identical | §34、docs §34、§98 | 缺 output-dir 零檔案 |
| 浮點紀律 | 影響像素的運算禁 Math 超越函式與 Math.random | §100.2、§100.3 | 跨 Bun／Node 比對 |

---

## 命令表面

V0.2 新增九個命令。完整旗標、輸入輸出與 exit code 表在 `docs/cli-surface.md` 的「V0.2 commands (frozen)」一節；本節只固定語意。

| 命令 | 一句話語意 | 產物檔 |
|---|---|---|
| `transform <input>` | 幾何轉換，一次只做一個幾何操作 | 可 |
| `quantize <input>` | 把色彩數降到指定上限 | 可 |
| `cleanup <input>` | 偵測並（在顯式授權下）修正像素瑕疵 | 可 |
| `pixelize <image>` | 參考圖走完整管線轉成像素圖 | 可 |
| `palette extract` / `palette inspect` | 唯讀調色盤報告 | 否 |
| `material list` / `material show` | 唯讀材料查詢 | 否 |
| `recolor <source>` | 以材料或調色盤角色重上色 | 可 |
| `variant <source>` | 由一份來源建立多個材料變體 | 可（多檔） |
| `analyze <image>`（擴充） | 唯讀報告，新增三組特徵與建議參數 | 否 |

共同約束（全部為 MUST）：

```text
產生檔案的命令       缺 --output／--stdout／--source 時 OUTPUT_REQUIRED，且不建立任何檔案（§57）
輸出檔已存在          預設 OUTPUT_EXISTS，--force 才允許覆寫（§98.2）
父目錄不存在          預設 FILESYSTEM_ERROR，--mkdir 才建立（§98.3）
寫入                  同目錄暫存檔加 rename；失敗不留半寫入產物（§98.4）
路徑                  全部由呼叫端指定；不得推導檔名、不得建立預設目錄（§18、docs §7、docs §8）
通道                  --json 與 --stdout 的分工依 §98.1
```

`resize` 與 `crop` 不設為獨立命令，由 `transform` 承載（詳見下節）。`tile`、`preview`、`animate`、`generate`、`validate-pack`、`mcp` 仍不在 V0.2 範圍（§86–§89）。

應測點：每個新命令在缺 output 時都不產生任何檔案；`--force`／`--mkdir`／`--in-place` 的互斥與 §98 一致。

## Selection

### 模型

Selection 有兩種來源，對外只是一個作用範圍：

```text
--selection rect:<x>,<y>,<width>,<height>
--selection region:<id>
```

- 未給 `--selection` 時，作用範圍是整個 canvas。
- `rect` 的 `x`／`y` 可為 0 或正整數，`width`／`height` MUST ≥ 1；非整數依 §10 是 `INVALID_COORDINATE`，小於 1 是 `INVALID_ARGUMENT`。
- `rect` 超出 canvas 時是 `OUT_OF_BOUNDS`，不得靜默裁切（§31）。
- `region:<id>` 需要具備 region 的來源（`.mcpx`，§13、§97）。來源沒有 region（PNG／JPEG／WebP）時是 `INVALID_ARGUMENT`；id 不存在時是 `REGION_NOT_FOUND`（§99）。
- Selection MAY 疊在既有 Region 上，但 MUST NOT 修改該 Region 的 mask。

### 套用時機與不變條件

- Selection 在第一次改動像素之前解析一次；同一次呼叫內的所有像素寫入操作共用同一個 selection。
- 像素寫入操作（`setPixel`／`clearPixel`／`drawLine`／`drawRect`／`fillRect`／`floodFill`，以及 V0.2 的 `recolor`、`cleanup`、`quantize`）MUST 只在 selection 內生效。
- Selection 外的像素在操作完成後 MUST byte-identical：RGBA 四個 channel 都不變，包含 `A = 0` 的隱藏 RGB（§7）。這條不因操作種類而放寬。
- Selection MUST NOT 改變 canvas 尺寸。
- Geometry 操作會改變尺寸，因此 `--selection` 與 `transform` 的幾何旗標同時出現是 `ARGUMENT_CONFLICT`（本凍結）。
- Selection 是單次呼叫的暫時狀態，MUST NOT 序列化進 `.mcpx`。需要跨檔保存的語意一律用 Region（§13、§14）；Region 不得由顏色推導（§14）。
- Selection MUST NOT 讓個別操作跳過既有的邊界檢查：selection 內仍會 `OUT_OF_BOUNDS` 的操作照樣失敗（§31）。

應測點：選取內外同時繪製後，外側像素 RGBA byte 不變；`A = 0` 且 `RGB ≠ 0` 的隱藏值不被動到；rect 越界、region 不存在、selection 疊 geometry 三種拒絕各一。

## 進階 Layer／Region 操作

§28 已列出核心必須提供的層級操作，但 V0.1 的 `--operations` 只露出六種繪圖 op（見 `docs/cli-surface.md`）。V0.2 把落差補齊。

既有、V0.2 才接上 CLI 的操作（§28）：

```text
createLayer   removeLayer   renameLayer   reorderLayer
createRegion  removeRegion  setRegionPixel
```

V0.2 新增的操作（本凍結）：

```text
mergeLayer      duplicateLayer  clearLayer   fillLayer   moveLayer
renameRegion    reorderRegion
```

語意：

- `duplicateLayer` 深拷貝來源 layer 的像素與 metadata，產生新 id；不共用 buffer。
- `mergeLayer` 依 §12 的 bottom-to-top 與 `normal` blend，把來源 layer 合成到目標 layer，完成後移除來源。目標與來源相同時是 `INVALID_ARGUMENT`（本凍結）。
- `clearLayer` 把整個 layer 設為 `transparent`，即 `#00000000`（§8）；不影響其他 layer。
- `fillLayer` 以指定顏色填滿 layer；顏色語法沿用 §29 的 `transparent`／`#RRGGBB`／`#RRGGBBAA`。
- `reorderLayer` 改變 `layers[]` 中的位置，即 §12 的 bottom-to-top 順序。
- `moveLayer` 平移 layer 內容（整數 `dx`／`dy`）；移出 canvas 的部分依 §31 是 `OUT_OF_BOUNDS`，不裁切（本凍結；與 `reorderLayer` 的命名區分見待決清單）。
- `removeLayer` MUST NOT 移除最後一個 layer：canvas 在 V1 一律至少有一個 layer（§5、§12）（本凍結）。
- `renameRegion`／`reorderRegion` 對應 `renameLayer`／`reorderLayer` 的同構語意；region 之間 MAY 重疊（§13）。
- `createLayer`／`createRegion` 的 id 重複是 `DUPLICATE_LAYER_ID`／`DUPLICATE_REGION_ID`（§61、§99）。

資源上限沿用 §102：layer ≤ 64、region ≤ 256，超過在配置前回報 `RESOURCE_LIMIT_EXCEEDED`。

應測點：duplicate 後改一個 layer 不影響另一個；merge 的合成順序 golden；remove 最後一層被拒；layer／region 數量上限。

## Transform

Transform 涵蓋 §28 與 §38 的 `flipHorizontal`／`flipVertical`／`rotate90`／`rotate180`／`rotate270`／`crop`／`pad`／`resize`／`translate`。

### 一次一個幾何操作（本凍結）

一次呼叫 MUST 只帶一個幾何操作旗標。同時帶兩個以上是 `ARGUMENT_CONFLICT`。理由是規格只定義個別操作，沒有定義多操作的套用順序；把它固定成呼叫端決定的順序會引入規格沒有的語意。需要連續轉換時，呼叫端分次執行。

### 座標與邊界

- 所有座標、位移量與尺寸 MUST 是整數（§10）；浮點一律 `INVALID_COORDINATE`，不自動四捨五入。
- 超出 canvas 的結果依 §31 是 `OUT_OF_BOUNDS`。`crop` 的來源矩形、`translate` 的位移範圍都受這條約束。
- `resize` 的目標寬高 MUST ≥ 1，否則 `INVALID_DIMENSION`（§61）。
- `crop` 不改變被保留像素的 RGBA 值，只改變 canvas 邊界。
- `pad` 新增的像素預設為 `transparent`（`#00000000`，§8），可用 `--pad-color` 指定其他值；不得用會破壞既有像素的填充方式（§7）。
- `translate` 不移出 canvas 就保留原像素值；不做背景填補以外的插值。

### 旋轉與鏡射

- `rotate90`／`rotate180`／`rotate270` 為整數格點旋轉，MUST 是自身可逆的確切映射。
- `rotate90` 連續四次 MUST 回到原圖且 byte-identical（本凍結；這是 §100.1 整數優先的直接推論，也是最便宜的迴歸鎖）。
- `rotate90` 與 `rotate270` 互為反操作；`rotate180` 是自己的反操作。
- `flipHorizontal` 與 `flipVertical` 各自是對合操作，執行兩次回到原圖。
- 尺寸：`rotate90`／`rotate270` 交換寬高；`rotate180`、鏡射不變。

### Resize

三種模式（§38）：`nearest`、`box`、`pixel-aware`。

- 預設 `nearest`；MUST NOT 預設使用會產生 anti-aliasing 的模式（§38）。
- 三種模式都 MUST 是整數運算，不得依賴平台圖形 API（§32）。
- `box` 只在整除或明確定義的整數區塊平均下運作；無法整除時的行為 MUST 固定並以 golden 鎖定（本凍結：以整數累加後整除，餘數依固定像素順序分配）。
- `pixel-aware` 是 §38 列出的模式，但規格未定義其演算法。V0.2 只 MUST 接受這個名稱並可回報「尚未實作」的明確錯誤；不得以 `nearest` 冒充（本凍結，見待決清單）。

應測點：rotate 90 四次 byte-identical、rotate 90 兩次等於 rotate 180、flip 兩次回原圖；crop／pad／translate 的邊界拒絕；resize 預設無新顏色產生。

## Quantizer

### 演算法（本凍結）

V0.2 只實作一種量化法：整數 median-cut。

```text
輸入        RGBA8 像素集合
切割平面    依目前 bucket 中各 channel 的整數值域挑最寬的 channel
切點        該 channel 的中位數；總數為偶數時取固定一側（較小值那一側）
停止條件    達到 --colors 上限，或所有 bucket 無法再切
代表色      各 bucket 各 channel 的整數平均，餘數依固定規則分配
```

理由與依據：

- §100.1 要求核心運算純整數；median-cut 的切割、比較與平均都能以整數完成。
- §100.2 禁止影響像素的計算直接依賴 Math 超越函式。這條選型完全不使用 OKLab、色差或 k-means，因此不需要自備 LUT 或定點近似；將來若要加感知距離方法，MUST 以自備固定實作或整數 LUT 另外提供，MUST NOT 直接呼叫 `Math.cbrt`／`pow`／`exp`（§100.2）。
- §100.3 要求全序排序與不得依賴不穩定排序。tie-break MUST 是全序：先比 bucket 像素數（多者先），再比 `r`、`g`、`b`、最後比 bucket 內最小像素索引；任一層都不使用物件鍵序。

### `--colors` 規則

```text
必填          未給是 INVALID_ARGUMENT（這是缺必要參數，不是缺輸出）
型別          整數；非整數 INVALID_ARGUMENT
範圍          1 – 4096（本凍結；上限對齊 §97 tokenized 的可表達色數）
```

- `--colors` 大於等於實際色數時，MUST NOT 改變任何像素；輸出仍是合法產物。
- 量化是 nondestructive 的：不覆寫來源，只有在 `--in-place` 時才改寫輸入（§59）。
- 輸出為 `.mcpx` 時，量化後的色數 MUST 落在 §97 的容量內，否則 `MCPX_PALETTE_OVERFLOW`，並在 details 帶實際色數。
- 量化 MUST NOT 更動 alpha 以外的 channel 語意以外的東西；`A = 0` 像素的 hidden RGB 仍 MUST 被視為資料（§7）：若該像素被併入代表色，代表色是量化結果，這是明確操作；但未被量化涵蓋的透明像素 MUST NOT 被順手歸零。

應測點：同輸入跨 Bun／Node byte-identical；`--colors` 邊界（1、等於色數、4096、0、負數、非整數）；tie-break 在兩 bucket 同像素數時的穩定性；`.mcpx` 溢位。

## Cleanup

### 七類瑕疵

依 §35 與 §63，V0.2 的 cleanup 處理七類，識別字（本凍結，供旗標與 JSON 使用）：

```text
isolated   孤立像素
noise      單像素雜訊
cluster    破裂的群集
fringe     半透明鑲邊
outlier    調色盤離群值
hole       微小破洞
aa         不想要的 anti-aliasing
```

### 預設不改像素

§63 規定：所有可能改變 Minecraft rendering semantics 的操作不得預設執行，MUST 要求顯式選項。依 §40，block 的 render pass 由 sprite 是否含 fully transparent 與 partially transparent 像素決定，所以任何動到 alpha 的清理都可能改變分類。

因此：

```text
cleanup 不帶 --fix
  只做偵測與報告，像素零變動（--json 回報各類別計數）
cleanup --fix isolated,noise,...
  對列出的類別套用修正
alpha 相關類別（isolated／noise／cluster／fringe／hole／aa）
  另外 MUST 要求 --allow-render-pass-change，否則 INVALID_ARGUMENT
outlier（只改 RGB、不動 alpha）
  不需要額外授權
```

- `outlier` 只把像素 RGB 映射到 palette 上既有顏色，alpha 不變，因此不改變 classification。
- 其餘六類可能改變特定像素的 alpha，或把像素在「透明／部分透明／不透明」之間搬移，因此需要顯式授權。被拒絕時 MUST NOT 寫入任何位元組。
- `--fix` 的類別名稱不合法是 `INVALID_ARGUMENT`，details 帶出錯的類別字串。
- `cleanup` 的分析結果 MUST 是確定性的（§100.3）：同輸入同順序、無時間戳。
- 修正結果預設不覆寫來源；`--in-place` 才改寫輸入（§59）。
- `--json` MUST 回報實際修改統計（§35）：各類別偵測數、修正數，以及總修改像素數。

應測點：無 `--fix` 時像素零變動；缺 `--allow-render-pass-change` 時 alpha 類別被拒且零寫入；`outlier` 不需該旗標；統計數字與實際差異一致。

## Pixelize

### 管線順序（本凍結）

依 §28 與 §64，V0.2 的管線固定為十一個階段，順序 MUST NOT 由旗標改變：

```text
Decode
↓
Crop
↓
Background
↓
Subject
↓
Resize
↓
Edge
↓
Quantize
↓
Cluster
↓
Cleanup
↓
Preset
↓
Output
```

- `Quantize` 使用 Quantizer 的凍結演算法，參數由 `--size`／`--preset` 與呼叫端覆寫決定。
- `Cluster` 是像素群集整理，MUST 為整數運算；不得引入隨機（§100.3）。
- `Resize` 預設 `nearest`，不得預設產生 anti-aliasing（§38）。
- `Cleanup` 使用 Cleanup 的類別；會改 alpha 語意的類別同樣需要顯式授權（§63）。
- `Preset` 只把結果套進 preset 的參數組，不引入額外的隱藏啟發式。
- `Output` 依目標 profile 決定格式；Minecraft profile 只輸出 PNG（§34）。

### 尺寸與 preset

- `--size` 接受 `16`／`32`／`64`／`128`，或 `WxH` 自訂（§28）。四者只是可選清單，不是 Core 驗證規則（§45）。
- 非 16／32／64／128 的尺寸 MAY 產生 `NON_STANDARD_RESOLUTION` warning，但 MUST NOT 當成 `INVALID_DIMENSION`（§45）。
- `--preset` 是 Processing Preset，決定「怎麼處理圖片」；`--profile` 是 Asset Profile，決定「這張圖片在 Minecraft 裡是什麼」（§37）。兩者不是同義詞，也不互相取代。V0.2 的 preset 值為 `item`／`block`／`generic`；`gui`／`particle` 隨其 profile 留待 V0.4（§87）。
- Preset MUST 是一組顯式、具名、可列印的參數值，MUST NOT 是藏在程式碼裡的隱藏啟發式。§30 只給了各 preset 的方向（item 重剪影與邊緣可讀、block 重可平鋪與低接縫、generic 不加 Minecraft 專屬 heuristic），具體數值屬待決（見文末）。
- 不論 preset 為何，`--profile minecraft:item`／`minecraft:block` 的輸出 MUST 只有 PNG；其他副檔名是 `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT`（§34）。
- Pixelize MUST 能直接產生 PNG，不要求先有 `.mcpx`（§29、§64）。

### 三種輸出模式

依 §29，三種模式都 MUST 支援：

```text
--output png                      只出 PNG
--output png --source mcpx        PNG 加可編輯來源
--source mcpx                     只出可編輯來源
```

缺 `--output`／`--source`／`--stdout` 時是 `OUTPUT_REQUIRED`，零檔案（§57）。

應測點：管線階段順序 golden；`--size` 四種與自訂；preset 參數組可列印且同輸入同結果；Minecraft profile 遇非 PNG 副檔名被拒；三種輸出模式各自成立。

## 解碼器選型準則

V0.2 起 Pixelize 與 `analyze` 要能吃 §33 的 PNG／JPEG／WebP。選型準則先固定，實際實證留給後續的封裝情境驗證（本文件不做實證，也不宣稱任何候選已通過）。

### MUST 條件

```text
1  支援 PNG、JPEG、WebP 解碼
2  MUST NOT premultiply alpha（§101.1）：A = 0 像素的 RGB 必須原樣保留（§7、§75）
3  MUST NOT 是 sharp / libvips / Skia 系（§101.1、docs §50）
4  MUST 能在 Bun 與 Node 兩種 runtime 下執行（§100.5）
5  同一份輸入 bytes 在兩個 runtime 解出相同 RGBA（§100.4）
6  授權需與專案 MIT 相容；評估 MUST 早於閱讀其原始碼（§104.4）
7  輸出不得含時間戳或會變動的內容（§100.3、§101.3）
```

### 評估軸

每個候選都要在下列軸上留下數據，才進入定案：

```text
支援格式與版本涵蓋（含 progressive JPEG、有損／無損 WebP、alpha WebP）
解碼輸出是否等於參考實作
WASM 或純 JS 的體積，以及對 dist 打包的影響
兩 runtime 的一致性實測結果
授權條款與其相容性結論
維護狀態與相依樹
```

### 候選短名單（未實證）

以下只是待查證的候選，用來縮小後續實證範圍；本凍結不宣稱任何一項的授權、體積或決定性已確認：

```text
JPEG   jpeg-js（純 JS）
JPEG   @jsquash/jpeg（WASM）
WebP   @jsquash/webp（WASM，libwebp）
WebP   webp-wasm 類封裝
```

`pngjs` 已是 V0.1 的 PNG codec（§101.1），V0.2 不解碼 PNG 以外的路徑時維持不變。任何候選若為了效能而做 premultiply 或轉換色彩空間，直接淘汰。

尚未驗證：上列候選的授權、體積與兩 runtime 解碼一致性都還沒實證；在實證完成前，`pixelize` 的 JPEG／WebP 輸入 MUST NOT 被宣告可用。

應測點：`A = 0` 且 `RGB ≠ 0` 的 fixture 經 JPEG／WebP 解碼路徑後不被歸零；同一輸入在 Bun 與 Node 解出的 RGBA 相同。

## Material 與 Recolor

### Material 的定位

Material 是 Palette 之上的語意層（§67、docs §32）：由 `AuthoringPalette` 加上 texture processing 特性組成，不是 Minecraft 的 Palette Texture API（§67）。每個 material MAY 定義：

```text
palette（entries 與 role）
contrast
noise
cluster characteristics
highlight behavior
```

### 首批內建材料（本凍結）

只納入同時出現在技術規格書 §67 與產品規格書 docs §32 的材料：

```text
iron   copper   oxidized_copper   gold
wood   stone    crystal
```

`steel`／`leather`／`cloth` 只在 docs §32 出現，列為下一批候選，V0.2 不內建（見待決清單）。§32 與 §67 都說第一版不要求大量內建，因此這七個是可交付的最小集合，Core API 仍 MUST 預留擴充。

Palette role 沿用 §15 的字集：`outline`／`shadow`／`dark`／`base`／`light`／`highlight`／`accent`／`custom`。

### Recolor 的映射（本凍結）

Recolor MUST 支援 Region-aware、Palette Role-aware、Luminance-aware，而不是只有 hue shift（§68、docs §33）。

```text
role 存在       shadow／dark   → 目標材料的 shadow
                base           → 目標材料的 base
                light／highlight → 目標材料的 highlight
role 不存在     以整數 luminance 分三帶：< 96 shadow、96–159 base、>= 160 highlight
```

- Luminance MUST 以整數計算（`(299r + 587g + 114b) / 1000` 取整），不得使用浮點或超越函式（§100.1、§100.2）。
- `outline`／`accent`／`custom` 不在此映射內，MUST 保持原樣；是否要為它們定義目標 role 屬待決（見文末）。
- `--region <id>` 需要來源具備該 region（§13）；region 存在時只重上色 region 內的像素，選取外像素 byte 不變（同 Selection 的不變條件）。
- Recolor MUST NOT 改寫 Region 的 mask：重上色後 `blade` 仍是 `blade`（§14）。
- 目標材料不存在是 `INVALID_ARGUMENT`（§99；詳見待決清單對 error code 的說明）。
- 重上色後的像素 MUST 是目標材料 palette 的成員，不得產生 palette 外的中間色。
- 輸出預設不覆寫來源；`--in-place` 才改寫（§59）。

應測點：role 映射 golden（shadow／base／highlight 各一）；無 role 時的 luminance 分帶邊界值；region-aware 時 region 外 byte 不變；region mask 不受影響。

## Analyze 擴充

`analyze` 不修改檔案（§62）。V0.1 已有 `dimensions`／`totalPixels`／`colorCount`／`alpha`／`dominantColors`／`profile`／`warnings`；V0.2 在其上新增三組欄位，舊欄位 MUST NOT 改名或移除。

### JSON 形狀（本凍結）

```json
{
  "success": true,
  "result": {
    "paletteCharacteristics": {
      "colorCount": 0,
      "alphaLevels": 0,
      "roles": [{ "role": "base", "count": 0 }],
      "transparentPixels": 0,
      "partialAlphaPixels": 0
    },
    "pixelArtCharacteristics": {
      "resolution": { "width": 0, "height": 0 },
      "aspect": "1:1",
      "isolatedPixels": 0,
      "semiTransparentPixels": 0,
      "paletteSize": 0,
      "tileFriendly": false
    },
    "recommended": {
      "quantize": { "colors": 0 },
      "cleanup": { "classes": [] },
      "resize": { "mode": "nearest" }
    }
  }
}
```

- `recommended` 的每一項 MUST 由確定性規則導出，MUST NOT 來自機器學習或外部服務；數字是整數，比率以固定小數位字串表示（§100.3）。
- `recommended` 只是建議，MUST NOT 被當成執行結果宣告。
- `paletteCharacteristics.transparentPixels` 與 `partialAlphaPixels` 的分界依 §40：`A = 0` 為 fully transparent，`0 < A < 255` 為 partial。
- `pixelArtCharacteristics.tileFriendly` 的判斷規則 MUST 固定並以 golden 鎖定；規則細節屬待決（見文末）。
- `analyze` 的輸出仍是 predicted，不得宣稱 effective；block 的 render pass 有 `force_translucent` 覆寫（§40、§41）。
- `--json` 與 `--minecraft-version`／`--resource-pack-version` 的既有行為不變（`docs/cli-surface.md`）。

應測點：同一輸入同報告 byte-identical；舊欄位未變；`recommended` 的規則邊界值；predicted 措辭未被改成 effective。

## 浮點與 determinism 紀律

§100 的承諾從 V0.2 的色彩運算開始才真正受壓（§100.5 末段）。V0.2 全部引擎 MUST 遵守：

```text
整數優先      影響像素的運算以整數完成（§100.1）
禁超越函式    MUST NOT 直接使用 Math.cbrt / pow / exp / sin 等於影響像素的計算（§100.2）
禁隨機        MUST NOT 使用 Math.random；V0.2 預設路徑不含亂數（§100.3）
全序排序      不得依賴不穩定排序或物件鍵序（§100.3）
目錄列舉      先排序再使用（§100.3）
無時間戳      輸出內容 MUST NOT 含時間戳（§100.3）
報告浮點      以固定小數位序列化（§100.3）
```

- V0.2 沒有需要 seed 的功能；若未來引入（例如 V0.3 的 procedural pattern，§86、docs §37），seed MUST 顯式且由呼叫端提供。
- 保證範圍沿用 §100.4：同 input、同參數、同版本，跨 macOS／Linux 與跨 Bun／Node 輸出 byte-identical。
- 無法提供此保證的演算法 MUST 在文件標記，MUST NOT 靜默進入預設路徑（§100.4）。目前唯一屬此類的是 `pixel-aware` resize 的演算法未定義（見待決清單），因此 V0.2 MUST NOT 讓它以預設身分執行。
- 新增引擎的跨 runtime 比對 MUST 進 CI，且比對本身是失敗條件，不是只記錄差異（§100.5）。Core／CLI MUST NOT 依賴 Bun 專有 API（§100.5）。

應測點：每個新引擎一組 golden（pixel 與 PNG）；quantize／cleanup／recolor 的跨 runtime 比對；grep 層級的規則檢查（無 `Math.random`、無超越函式落在 pixel-critical 路徑）。

## 接線權責與整合順序

Command 接線與批次詞彙是共用檔案（`src/cli/program.ts`、`src/cli/operations-json.ts`、core 的 batch 詞彙），同時改會互相覆蓋。因此：

```text
純引擎模組（transform／selection／palette-quantizer／cleanup／material-recolor）
  MUST NOT 觸碰 src/cli/program.ts 或 src/cli/operations-json.ts，也不擴充 core batch 詞彙
  MUST 各自在自己的模組與單元測試中完成

整合階段
  才把命令、--operations 新詞彙與 CLI 旗標接上，集中在同一處，不分散

Pixelize → Variant → Analyze
  共用 program.ts，MUST 依序執行，MUST NOT 並行

解碼器實證
  以獨立路徑進行，不阻塞引擎模組
```

優先序衝突時：已凍結的 V0.1 行為（`docs/cli-surface.md`）不得因 V0.2 接線而改變；新增命令沿用既有 helper（envelope、channels、output-guard、filesystem、exit、profiles），不另建一套。

應測點：引擎模組的 diff 不含 CLI 接線檔；同一命令的前後兩次接線改動不互相覆蓋；V0.1 既有測試在整合後仍綠。

## 實作補充（引擎波）

這一節把引擎波實作時確認、但前面章節未寫定的判讀補上。標 `（本凍結）` 的是在此正式固定的語意，附理由與應測點；標 `（實作判讀）` 的是實作實況，權威來源是每項列出的程式與測試，本節只記錄、不重新凍結。多數 `（本凍結）` 項目是把前面章節已有的凍結具體化，關係寫在該項後面。

### 平移的內容判定（本凍結）

`translate` 與 `moveLayer` 共用同一個「cell 是否算內容」的判定：一個 cell 只在 RGBA 四個 byte 全為 0 時才算空。`A = 0` 但 RGB 不全為 0 的隱藏值依 §7 仍是內容，不能離開 canvas。

```text
非全空 cell 被移出 canvas   OUT_OF_BOUNDS，丟出前不寫入任何 byte
全空 cell 被移出 canvas     允許離開，不報錯
留下的 cell                 #00000000
未離開的像素                原樣搬移，不插值
```

理由：§7 把 `A = 0` 的 hidden RGB 當資料，判定因此以整個 cell 的 byte 為準，而不是只看 alpha，也不是看位移量是否為零。

這條把「進階 Layer／Region 操作」對 `moveLayer` 的 `OUT_OF_BOUNDS` 敘述具體化：移出即拒絕的判準是 cell 的內容；也因此 `translate(canvas, 0, 0)` 與 `moveLayer(canvas, id, 0, 0)` 都是 no-op（後者早退）。

出處：`src/core/transform.ts` 的 `translate`（`isClear` 逐 cell 檢查）、`src/core/layers.ts` 的 `moveLayer`。

應測點：`translate that would move content out is OUT_OF_BOUNDS without writes`、`translate shifts content, keeps values, fills vacated with transparent`、`translate by zero is the identity`、`moveLayer rejects content leaving the canvas without partial writes`、`moveLayer rejects hidden RGB leaving the canvas without partial writes`、`moveLayer carries hidden RGB verbatim within bounds`、`moveLayer lets empty margins leave freely`、`moveLayer zero shift is a no-op`。

### 旋轉方向（本凍結）

`rotate90` 是順時針，`rotate270` 是逆時針。前面「旋轉與鏡射」只寫了可逆、對合與維度交換，沒有寫方向；方向會改變輸出的 bytes，不能留給實作各自決定。

出處：`src/core/transform.ts` 的 `rotate90`（"Quarter turn clockwise"）、`rotate270`（"Quarter turn counter-clockwise"）。

應測點：`rotate90 golden pins clockwise direction and swaps dimensions`、`rotate270 golden pins counter-clockwise direction`、`rotate90 four times is byte-identical`、`rotate90 twice equals rotate180`、`rotate90 then rotate270 restores the original`。

### resize 的 box 餘數與 mask（本凍結）

`box` 的來源區塊以固定規則切：

```text
base  = floor(oldSize / newSize)
extra = oldSize - base * newSize
前 extra 個輸出 cell 各覆蓋 base + 1 個來源像素，其餘覆蓋 base 個
```

x 與 y 方向各自套同一規則；每個 cell 的 r／g／b／a 各自整數累加後 `floor(sum / count)`，`count = (x1 - x0) * (y1 - y0)`，不做進位或通道混合。

region mask 不平均：改用 nearest 映射（`floor(x * oldWidth / newWidth)`、`floor(y * oldHeight / newHeight)`，即 `nearestSource`）取來源 mask 值，維持 binary。

理由：整數平均搭配固定的餘數分配，才能讓 box 的結果在跨 runtime 時 byte-identical；mask 必須維持 binary，平均會產生非 0／1 的值，所以走 nearest。

這條把 Transform「Resize」對 `box` 的「以整數累加後整除，餘數依固定像素順序分配」具體化為「前 remainder 個 cell 各多一個來源像素」，並補上 region mask 走 nearest。

出處：`src/core/transform.ts` 的 `blockEdges`、`resizeBox`、`nearestSource`。

應測點：`resize box averages even blocks with integer division`、`resize box distributes remainder columns in fixed order`、`region masks follow crop, pad, translate, and resize`。

### pixel-aware 的拒絕語意（本凍結）

`pixel-aware` 以名稱接受，但一被選用就丟 `INVALID_ARGUMENT`，訊息為 "pixel-aware resize is not implemented; use nearest or box."，且在丟出前不寫入任何 byte；未知的模式字串同樣是 `INVALID_ARGUMENT`。

理由：Transform「Resize」要求 V0.2 接受這個名稱並可回報尚未實作的明確錯誤，這裡把「明確錯誤」釘成具體的錯誤碼，避免呼叫端把 `pixel-aware` 當成可用的模式。

出處：`src/core/transform.ts` 的 `resize` 與 `resolveResizeMode`。

應測點：`resize pixel-aware is accepted by name but explicitly refused`、`resize rejects unknown mode without writes`。

### Recolor 的透明像素（本凍結）

`A = 0` 的像素一律保留 byte-identical，包含 hidden RGB：不走 role 映射，也不走 luminance 分帶。`recolorColor` 直接回傳原值，`recolorLayer` 在該 cell 直接跳過，`report.pixelsChanged` 不計入。`A ≠ 0` 的像素仍照「Recolor 的映射（本凍結）」輸出。

理由：與 §7 及 Selection「套用時機與不變條件」對 hidden RGB 的處理一致；重上色不應該把透明背景或剪影的隱藏值改成目標 palette 的顏色。

出處：`src/core/recolor.ts` 的 `recolorColor`（`color.a === 0` 早退）、`recolorLayer`（`a === 0` 時 `continue`）。

應測點：`fully transparent pixels stay byte-identical on full-layer recolor`、`transparent pixels inside a region are skipped too`、`pure helper keeps fully transparent colors unchanged`。

### Cleanup 的七類判定與修正（實作判讀）

偵測永不寫入；修正只寫被請求的類別，且從輸入快照導出，套用順序固定為 `CLEANUP_CLASSES` 的順序，因此重疊類別的結果具確定性。`ALPHA_AFFECTING_CLASSES` 是除 `outlier` 以外的六類，缺少 `--allow-render-pass-change` 時在寫入任何 byte 前以 `INVALID_ARGUMENT` 拒絕，未知的類別名同樣拒絕。

| 類別 | 偵測（符號） | 修正 |
|---|---|---|
| `isolated` | `findIsolated`：不透明像素，4-neighbor 全為 fully transparent | 設為 `#00000000` |
| `noise` | `findNoise`：內部不透明像素，8-neighborhood 全為同一種與自身不同的顏色；邊界像素不算 | 複製北側 neighbor 的 RGBA |
| `cluster` | `findCluster`：2–4 個 4-connected 前景（`A ≠ 0`）像素，界內邊界全為背景；單像素歸 `isolated`、大片保留 | 全部設為 `#00000000` |
| `fringe` | `findFringe`：partial（`0 < A < 255`）像素，4-neighbor 全為不透明 | 保留 RGB、alpha 設 255 |
| `outlier` | `findOutlier`：`A ≠ 0` 像素，RGB 不在參考 palette；alpha 不參與判定 | 以 squared RGB 距離取最近 palette 顏色，alpha 不變 |
| `hole` | `findHole`：fully transparent 像素，四個 neighbor 都在界內且不透明 | 四鄰居 RGB 各取整數平均（整數除法，不進位）、alpha 設 255 |
| `aa` | `findAA`：partial 像素，4-neighbor 至少一個不透明、至少一個 fully transparent | 四鄰居中 opaque ≥ clear 則 alpha 設 255，否則設 0；RGB 不變 |

`fringe` 與 `aa` 互斥：partial 像素若 4-neighbor 全為不透明是 `fringe`，只要有一個 fully transparent 就是 `aa`，兩者不會同時成立。`outlier` 的參考 palette 由 `options.palette` 決定，未給時回退 canvas palette，兩者都沒有時 `outlier` 偵測為空。

出處：`src/core/cleanup.ts` 的 `CLEANUP_CLASSES`、`ALPHA_AFFECTING_CLASSES`、`findIsolated`、`findNoise`、`findCluster`、`findFringe`、`findOutlier`、`findHole`、`findAA`、`replacementFor`、`fixCleanup`。

測試：`class identifiers are frozen for flags and JSON`、`isolated golden: lone opaque pixel is flagged`、`noise golden: single spike in a uniform field is flagged`、`cluster golden: 2x2 speckle on transparency is flagged`、`fringe golden: partial pixel inside solid fill is flagged`、`fringe negative: boundary partial is aa, not fringe`、`outlier golden: color outside the palette is flagged`、`outlier falls back to the canvas palette`、`hole golden: enclosed transparent pixel is flagged`、`aa golden: partial pixel between opaque and clear is flagged`、`aa fix snaps to the majority side, ties favor opaque`、`detect-only leaves every byte untouched`、`alpha classes without authorization are rejected with zero writes`、`mixed outlier plus alpha class is rejected atomically`、`unknown class is INVALID_ARGUMENT with the bad name in details`、`same input twice gives identical bytes and stats`。

### median-cut 的取整細節（實作判讀）

```text
切割平面    對 bucket 內每個 channel 取整數值域 hi - lo，最大的當切割平面；
            掃描順序 r, g, b, a，只有嚴格更大才換（同寬時先掃到的勝）
切點        目標索引 target = (bucket.pixelCount - 1) >> 1；
            把 bin 依所選 channel 排序後累加像素數，
            第一個讓累加值 > target 的 bin 歸左側，
            但至少留一個 bin 給右側（切到最後一個 bin 時改切在它前面）
代表色      averageChannel：base = floor(sum / count)，
            remainder = sum - base * count；
            2 * remainder >= count 時回 base + 1，否則回 base
零變化      distinct 色數 <= --colors 時短路：palette 依 first-appearance 順序原樣輸出，
            像素 byte 不變
A = 0       hidden RGB 參與平均；零變化路徑原樣保留
```

bucket 與 palette 的排序共用同一個全序：像素數多者先，再比代表色 r、g、b（升），最後比 bucket 內最小像素索引（升）；切點排序在 channel 同值時用 `compareColorFull` 補完全序。兩者都不依賴排序穩定性或物件鍵序。

出處：`src/core/quantizer.ts` 的 `splitBucket`、`averageChannel`、`compareBuckets`、`compareColorFull`、`quantizePixels`。

測試：`colors 1 averages to a single integer color, remainder rounds half up`、`remainder below half rounds down`、`even-count median split takes the smaller side`、`widest channel wins the split plane`、`equal-count buckets order by r, g, b, then min pixel index`、`colors at or above the distinct count changes zero pixels`、`hidden RGB under A=0 is data, never silently zeroed`、`same input quantizes byte-identical on rerun`。

### 七材料 starter palette 待複核（實作判讀）

「首批內建材料（本凍結）」的七個 material 在 `src/core/material.ts` 落地，id 順序為 `iron`、`copper`、`oxidized_copper`、`gold`、`wood`、`stone`、`crystal`（`BUILTIN_MATERIAL_IDS` 與 `listMaterialIds()`）。每個 material 的 palette 是模組內的 hex 常數，並各自帶 characteristics（整數 `contrast`、整數 `noise`、`cluster` 與 `highlightBehavior` 字串）。

這些色值與特性是專案自訂的明示假設，不是規格推導的結果：`material.ts` 的檔頭註解寫明它們 pending art-direction review，且不引用任何官方 Minecraft 素材。art-direction 複核後若要調整，只需改 `src/core/material.ts` 的常數；現有測試鎖的是 id 集合、`shadow`／`base`／`highlight` role 齊備、base 顏色彼此相異與 byte 範圍，沒有鎖定特定 hex。

出處：`src/core/material.ts` 的 `BUILTIN_MATERIAL_IDS`、`MATERIALS`、`getMaterial`。

測試：`builtin material ids match the frozen seven`、`each material palette has shadow, base, and highlight roles`、`starter base colors are distinct per material`、`palette entries have unique ids, valid roles, and byte colors`。

以上各項都有對應測試（見各段列出的測試名）；這些測試就是本節的迴歸鎖。

## 實作補充（後續波次）

引擎波之後落地的是 Pixelize、Variant、Analyze 擴充、跨 runtime 符合性，以及 V0.1 落差的 layer／region 接線。體例同「實作補充（引擎波）」：標 `（本凍結）` 的是在此正式固定，標 `（實作判讀）` 的是實作實況，權威來源是每項列出的程式與測試，本節只記錄、不重新凍結。

### Pixelize 的 starter 階段與 preset（實作判讀）

管線照「管線順序（本凍結）」的十一階段，`PIXELIZE_STAGES` 就是那份順序，旗標無法改動它，階段會被 trace 而不是被跳過。真正做運算的是 Resize（`nearest`）、Quantize（preset 的 colors）與 Cleanup（preset 的 cleanupClasses）三階段；其餘五階段是 starter no-op：Crop 保留全幅、Background 原樣保留 alpha（不壓平成單色）、Subject 不搬動主體、Edge 強調量 0、Cluster 合併門檻 0。這五個 starter 規則都 pending art-direction review。

preset 的具體數值（對應待決清單該項）：`item` 為 colors=16、`block` 為 colors=12、`generic` 為 colors=32；三者 edge=0、cluster=0。cleanupClasses 為 `item`／`block` 的 `["outlier"]` 與 `generic` 的 `[]`（偵測-only），因此 preset 的清理只碰 `outlier`，不需要 `--allow-render-pass-change`。`--size` 接受單邊 `N`（等於 NxN）或 `WxH`；非整數是 `INVALID_ARGUMENT`，維度越界是 `INVALID_DIMENSION`，缺 `--size` 也是 `INVALID_ARGUMENT`。16／32／64／128 的正方形不加警告，其餘尺寸回 `NON_STANDARD_RESOLUTION` warning 但照樣產出（§45）。Minecraft profile 的輸出一律只有 PNG。

解碼路徑：JPEG 用 jpeg-js@0.4.4（純 JS、自含 bundle），WebP 用 @jsquash/webp@1.5.0（libwebp）配合 `init({ instantiateWasm })` glue，wasm 以 base64 內嵌（`src/io/webp-wasm-b64.ts`），讓單檔 dist 不需 sidecar。選型與未驗證清單見 `.project-doc/decoder-selection.md`：漸進 JPEG、動畫 WebP、ICC／EXIF 附帶資料與大圖效能皆未驗證，JPEG 跨實現亦非 bit-exact。

多格式 raster 入口（`decodeImage`）現同時支撐 `loadEditableCanvas` 與 `loadRasterCanvas`：`transform`／`quantize`／`cleanup`／`palette`／`pixelize`／`analyze` 都接受 PNG/JPEG/WebP；`recolor`／`variant` 維持 `.mcpx` gate（非 `.mcpx` 在進入解碼前先以 `INVALID_ARGUMENT` 拒絕），`import` 仍是 PNG-only。`docs/cli-surface.md` 的 V0.2 表已與實作一致。

出處：`src/core/pixelize.ts` 的 `PIXELIZE_STAGES`、`PIXELIZE_PRESETS`、`runPixelize`、`parsePixelizeSize`、`isStandardPixelizeSize`、`describePixelizePreset`；`src/cli/cmd-pixelize.ts` 的 `runPixelizeCommand`；`src/io/decode.ts` 的 `decodeImage`、`ensureWebp`。

測試：`tests/cli/pixelize.test.ts`（PNG／JPEG／lossless WebP／lossy WebP 解碼、三種輸出模式、三 preset 重跑 byte-identical、未知 preset 與缺 `--size` 被拒、`24x12` 非標準尺寸警告、Minecraft profile 非 PNG 被拒）、`tests/io/decode.test.ts`。

### Variant 的輸出契約（實作判讀）

`variant` 只吃 `.mcpx`。每個 `--materials` 條目各自從原始來源文字重新 parse 一次再上色，材料之間不會疊加，所以重跑 byte-identical。每個材料固定輸出兩個檔案：`<basename>_<material>.png` 與 `<basename>_<material>.mcpx`，一律寫進顯式的 `--output-dir`。缺 `--output-dir` 是 `OUTPUT_REQUIRED` 且零檔案；`--output` 與 variant 同用是 `ARGUMENT_CONFLICT`；同一份清單重複列同一材料是 `ARGUMENT_CONFLICT`（本節判讀，待複核）；未知材料、缺 `--materials`、非 `.mcpx` 來源都回 `INVALID_ARGUMENT`。`--stdout`／`--source`／`--in-place`／`--input`／`--selection` 未在 variant 宣告（`src/cli/program.ts`），使用時是未知選項。

出處：`src/cli/cmd-variant.ts` 的 `runVariant`、`parseMaterialList`；`src/cli/program.ts` 的 `variant <source>` 命令宣告。

測試：`tests/cli/variant.test.ts`（四檔命名、重跑 byte-identical、缺 output-dir 零檔案、`--output` 衝突、未知材料、缺 materials、非 mcpx 來源、缺父目錄需 `--mkdir`、既有檔需 `--force`）、`tests/conformance/cli-conformance.test.ts` 的 V0.2 variant output guards。

### Analyze 擴充的 starter 規則（實作判讀）

三組新欄位都是量測值，規則固定且確定性。`paletteCharacteristics`：`colorCount` 為 distinct RGBA 色數、`alphaLevels` 為相異 alpha 值個數、`transparentPixels` 為 `A = 0`、`partialAlphaPixels` 為 `0 < A < 255`；`roles` 由 canvas 的 authoring palette 統計，raster 來源（PNG／JPEG／WebP）一律空陣列。`pixelArtCharacteristics`：`resolution` 為 flatten 後的寬高、`aspect` 以整數 gcd 約簡成 `w:h`、`isolatedPixels` 沿用 cleanup isolated 偵測語意（不透明像素、現有 4-neighbor 全為 fully transparent）、`semiTransparentPixels` 同 `partialAlphaPixels`、`paletteSize` 為 distinct 色數、`tileFriendly` 為 starter wrap 規則：左右邊界與上下邊界逐 byte 嚴格相等，1 寬或 1 高的退化軸只與自己比。`tileFriendly` 仍待複核。

`recommended` 由確定性規則導出，是建議不是執行結果：`quantize.colors` 取不小於色數的最小 2 的冪、上限 clamp 到 4096；`cleanup.classes` 目前無規則，固定空陣列；`resize.mode` 固定 `nearest`。human 輸出在 `profile:` 之後新增 `palette:`、`pixel-art:`、`recommended:` 三行，之後才是 warning 與 `target:`；`--json` 形狀照「JSON 形狀（本凍結）」，舊欄位未改名或移除。輸出仍是 predicted，不得讀成 effective。

V0.1 的 conformance D5 gap（analyze 對 isolated 像素沉默）在 V0.2 退役：`isolatedPixels` 是 measured 欄位、規則固定且有測試；anti-aliasing 偵測仍未實作，`analyze` 對它保持沉默。

出處：`src/analyze/metrics.ts` 的 `analyzeCanvas`、`countIsolatedPixels`、`isTileFriendly`、`recommendedQuantizeColors`；`src/cli/analyze.ts` 的 `formatHumanReport`。

測試：`tests/cli/analyze.test.ts`（PNG／JPEG／lossless／lossy WebP intake、frozen shape、human 三行順序、`.mcpx` 被拒 exit 5、read-only、重跑相同）、`tests/conformance/cli-conformance.test.ts` 的 `D5 retired in V0.2`。

### 跨 runtime 符合性（實作判讀）

V0.2 的 §98 守衛矩陣（缺 output、OUTPUT_EXISTS／`--force`、缺父目錄／`--mkdir`、輸出別名或等同輸入）與重跑 determinism 都在 `tests/conformance/cli-conformance.test.ts`；`scripts/compare-runtime.mjs` 的 V0.2 情境把 Bun 跑 source CLI 與 Node 跑 bundle 的輸出一一 byte 比對：`transform`（PNG＋`.mcpx`）、`quantize`（PNG＋`.mcpx`）、`pixelize`（JPEG 與 lossless WebP，`--size 16`）、`variant`（4 檔）與 canonical `analyze` JSON。CI 的 bun 與 node 兩個 job 都跑這支腳本，任何差異即失敗。

出處：`tests/conformance/cli-conformance.test.ts`、`scripts/compare-runtime.mjs` 的 `main`（V0.2 區塊）、`.github/workflows/ci.yml`。

### V0.1 落差：layer／region 操作已接上（實作判讀）

「進階 Layer／Region 操作」列出的操作已可經 `--operations` 批次與 CLI 使用：`createLayer`／`removeLayer`／`renameLayer`／`reorderLayer`／`createRegion`／`removeRegion`／`setRegionPixel` 與 V0.2 新增的 `duplicateLayer`／`mergeLayer`／`clearLayer`／`fillLayer`／`moveLayer`／`renameRegion`／`reorderRegion` 都在批次詞彙內。`build` 可在一輪批次裡建層、改名並寫入像素。幾何操作不進批次詞彙：帶幾何 `type` 的批次是 `INVALID_ARGUMENT`（對應待決清單該項）。

出處：`src/cli/operations-json.ts` 的 `KNOWN_TYPES`、`parseOperationsJson`（幾何名稱不在此集合，於此回 `INVALID_ARGUMENT`）、`src/core/batch.ts` 的 `applyOperations` type 分派、`tests/cli/wave1.test.ts` 的 `--operations layer vocabulary runs on build` 與 `--operations rejects geometry vocabulary as INVALID_ARGUMENT`、`tests/core/batch-cases.ts`。

## 待決清單

以下無法從規格推定，列出但不自行填補。其中前四項會直接影響對外行為，需要決策後才適合定案。

| 項目 | 為什麼無法推定 | 需要什麼 | 現況（後續波次落地後；未改變任何決議） |
|---|---|---|---|
| `resize`／`crop` 是否保留為 top-level 命令 | §48 的 command tree 可簡化，但這兩個是公開名稱；本凍結改由 `transform` 承載 | 決定是否保留別名 | 仍待決；V0.2 由 `transform` 承載，未設 top-level 別名 |
| `pixel-aware` resize 的演算法 | §38 只列名稱 | 演算法定義或延後宣告 | 仍待決；實作只受理名稱並以 `INVALID_ARGUMENT` 拒絕（見「pixel-aware 的拒絕語意」） |
| Pixelize preset 的具體數值 | §30 只有方向（剪影、可平鋪、無 heuristic），沒有數字 | 各 preset 的參數值 | 已依使用者同意的 starter 路徑落地（`item` 16／`block` 12／`generic` 32）；是否定案仍待決 |
| `pixelArtCharacteristics.tileFriendly` 的判斷規則 | §62 未定義 | 規則或門檻 | starter 規則（wrap 邊界嚴格相等）已落地並有測試，仍待複核 |
| `moveLayer` 與 `reorderLayer` 的命名區分 | §28 只有 `reorderLayer`；`move` 的語意未定義 | 確認 move 指平移或改堆疊位置 | 已定：`moveLayer` 是像素平移（整數 `dx`／`dy`），`reorderLayer` 改堆疊位置；命名是否維持仍待決 |
| `outline`／`accent`／`custom` 的 recolor 目標 role | §68 只列 shadow／base／highlight | 是否要為其定義映射 | 仍待決；實作保持原樣不改寫 |
| material 第二批（`steel`／`leather`／`cloth`） | 只在 docs §32 出現，未進 §67 | 是否納入 | 仍待決；V0.2 只內建七個 starter material |
| `--colors` 上限 4096 是否合適 | 本凍結對齊 §97 的 tokenized 容量，非規格明定 | 確認上限 | 仍待決；實作照此上限 |
| 目標材料不存在時要用哪個 error code | §99 的固定表中沒有專屬項 | 沿用 `INVALID_ARGUMENT` 或新增碼 | 仍待決；實作暫用 `INVALID_ARGUMENT`（§105.12） |
| geometry 操作是否進 `--operations` 批次詞彙 | §29 的批次只描述像素操作 | 是否要擴充批次 | 仍待決；實作把幾何詞彙列為 `INVALID_ARGUMENT` |

「現況」一欄只記實作實況，不代表任何項目已定案；未提到的細節仍以各節敘述為準。

## 後續實作的共同義務

- 任何規範性語句若在本文件找不到出處或「本凍結」標記，一律視為需要回頭補規格，不得直接實作。
- 每個「應測點」都要有對應測試；MUST 級敘述沒有測試涵蓋即為 bug（§1.1）。
- 發現本文件與 `project-detail.md` 或 `project-docs.md` 不一致時，以 `project-detail.md` 為準，並回頭更新本文件與 `docs/cli-surface.md`。
