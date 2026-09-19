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

## 待決清單

以下無法從規格推定，列出但不自行填補。其中前四項會直接影響對外行為，需要決策後才適合定案。

| 項目 | 為什麼無法推定 | 需要什麼 |
|---|---|---|
| `resize`／`crop` 是否保留為 top-level 命令 | §48 的 command tree 可簡化，但這兩個是公開名稱；本凍結改由 `transform` 承載 | 決定是否保留別名 |
| `pixel-aware` resize 的演算法 | §38 只列名稱 | 演算法定義或延後宣告 |
| Pixelize preset 的具體數值 | §30 只有方向（剪影、可平鋪、無 heuristic），沒有數字 | 各 preset 的參數值 |
| `pixelArtCharacteristics.tileFriendly` 的判斷規則 | §62 未定義 | 規則或門檻 |
| `moveLayer` 與 `reorderLayer` 的命名區分 | §28 只有 `reorderLayer`；`move` 的語意未定義 | 確認 move 指平移或改堆疊位置 |
| `outline`／`accent`／`custom` 的 recolor 目標 role | §68 只列 shadow／base／highlight | 是否要為其定義映射 |
| material 第二批（`steel`／`leather`／`cloth`） | 只在 docs §32 出現，未進 §67 | 是否納入 |
| `--colors` 上限 4096 是否合適 | 本凍結對齊 §97 的 tokenized 容量，非規格明定 | 確認上限 |
| 目標材料不存在時要用哪個 error code | §99 的固定表中沒有專屬項 | 沿用 `INVALID_ARGUMENT` 或新增碼 |
| geometry 操作是否進 `--operations` 批次詞彙 | §29 的批次只描述像素操作 | 是否要擴充批次 |

## 後續實作的共同義務

- 任何規範性語句若在本文件找不到出處或「本凍結」標記，一律視為需要回頭補規格，不得直接實作。
- 每個「應測點」都要有對應測試；MUST 級敘述沒有測試涵蓋即為 bug（§1.1）。
- 發現本文件與 `project-detail.md` 或 `project-docs.md` 不一致時，以 `project-detail.md` 為準，並回頭更新本文件與 `docs/cli-surface.md`。
