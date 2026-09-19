# 規格書 v0.2 → v0.3 變更紀錄與任務修訂指示

對象：任務管理 Agent（`mc-asset-v01` 計畫與 `v01-t01`～`v01-t13` 的維護者）

日期：2026-09-19

---

## 1. 這次改了什麼

三份文件都已更新：

```text
project-docs.md                      v0.2 → v0.3   產品規格書（非規範）
project-detail.md                    v0.2 → v0.3   技術規格書（規範文件）
mc-asset-development-references.md   —             參考資料（非規範）
```

新增的文件位階規則（`project-detail.md` §1.2）：衝突時以技術規格書為準，版本路線圖的唯一來源是技術規格書 §84–§90。

---

## 2. 章節編號保證

計畫檔大量引用章節編號，因此這次**沒有重新編號任何既有章節**。

```text
project-detail.md §1–§94     編號與內容位置不變（部分內文有修正）
project-detail.md §1.1 §1.2  新增（規範用語、文件位階）
project-detail.md §95–§104   新增
```

唯一的例外在產品規格書：

```text
project-docs.md §52–§56（舊路線圖）
→ 合併為 §52（路線圖摘要表）與 §52.1（V0.1 驗收）
→ §53、§54、§55、§56 已不存在
→ §57 以後編號不變
```

### 計畫檔需要修正的引用

| 位置 | 原引用 | 改為 |
|---|---|---|
| 計畫開頭註記 | `project-docs.md §52` 把 pixelize 列入 V0.1 | 仍可保留敘述，但註明產品規格書已於 v0.3 更正，不再與技術規格書衝突 |
| 「後續」段落 | `project-docs.md §53–§57` | `project-docs.md §52` |
| 決策紀錄「CLI 工具鏈」 | pngjs「t06 實證後定案」 | 改引 §101：已是規範條文，且 sharp 已被明文禁止 |

---

## 3. 新增的規範章節（影響任務範圍）

| 章節 | 內容 | 影響任務 |
|---|---|---|
| §1.1 | RFC 2119 規範用語；MUST 必須有測試涵蓋 | 全部 |
| §1.2 | 文件位階 | 全部 |
| §95 | Minecraft 相容基準與查證紀錄（含出處與查證日期） | t09、t11 |
| §96 | `.mcpx` canonical grammar 補完（section 順序、空白、數值格式、符號字元集與指派規則、行內屬性、grid 模式、註解） | t05 |
| §97 | `.mcpx` 表達範圍與 palette 溢位 | t05 |
| §98 | CLI 全域約定（輸出通道、OUTPUT_EXISTS、父目錄、原子寫入） | t07、t08、t12 |
| §99 | Error code ↔ exit code 對照表，新增 10 個 error code | t02、t07、t11 |
| §100 | Determinism 保證範圍、浮點政策、跨 runtime CI 與 Bun 依賴限制（§100.5） | t01、t03、t12 |
| §101 | PNG codec 限制（禁止 premultiply、禁用 sharp、輸入正規化、輸出參數固定） | t06 |
| §102 | 資源上限與記憶體預算 | t02、t05 |
| §103 | Batch operation 結果回報格式 | t04 |
| §104 | 待凍結項目（命令語意、Pixel Spec、preset/profile、授權） | t01、t07 |

---

## 4. 既有章節的內容修正

| 章節 | 修正 |
|---|---|
| `detail` §21 | **canonical example 的 blade mask 原本比 grid 整體上移一列，已修正**。若已有 fixture 依該範例建立，必須重新產生。 |
| `detail` §25 | mask 範例標註為節錄，並指向 §21 的完整範例 |
| `detail` §34 | 移除誤植的希伯來文；「pack format 21 起限定 .png」的出處未能查證，已降級為待補出處 |
| `detail` §40 | **新增 `force_translucent`**：render pass 的自動推導可被 block model 覆寫；單張 PNG 的分析結果為 predicted，不是 effective |
| `detail` §41 | 新增反向警告情境（無 partial alpha 但 model 強制 translucent） |
| `detail` §58 | 移除未定義的 `sword.pixel`，改為 `sword.grid` 並指向 §104.2 |
| `docs` §17.1 | `pixel set` 範例改為非破壞性（需 `--output` 或 `--in-place`） |
| `docs` §20 | 移除 `background = transparent`（與 `detail` §22 衝突） |
| `docs` §44 | `--json` 由「應支援」改為 MUST |
| `docs` §50 | Bun 已定案；明文禁止 sharp 進入 pixel-critical 路徑 |

---

## 5. 已查證的 Minecraft 事實（`detail` §95）

這一輪實際查證了規格所依賴的版本事實，結論影響 t09 的範圍：

```text
已確認  RP format 97.1 對應 Java Edition 26.3
已確認  1.21.11 將 item texture 分離到無 mipmap 的 items atlas
已確認  同一 item model 的 texture 必須來自同一 atlas
已確認  .mcmeta texture section 的 mipmap_strategy / alpha_cutoff_bias
已確認  26.1 起 render pass 依 sprite 內容自動決定
新發現  26.1 起 texture entry 可用 force_translucent 強制覆寫
待補出處 「texture 僅限 .png」的起始 pack format
```

「待補出處」的事實 MUST NOT 作為 Error 依據，只能是 Warning。

---

## 6. 逐任務修訂指示

### v01-t01 專案 scaffold

新增範圍：

- 決定並建立 `LICENSE`（§104.4）。**這件事必須在任何人開始閱讀第三方原始碼之前完成**，否則沒有判斷授權相容性的基準。
- 加入依賴守門：CI 檢查 `sharp` / libvips / Skia 類函式庫不得出現在相依樹的 pixel-critical 路徑（§101.1）。
- **CI 必須同時跑 Bun 與 Node**（已裁決，§100.5）。golden、mcpx canonical、determinism 三組測試在兩個 runtime 各跑一次並比對，輸出必須 byte-identical，比對失敗即 CI 失敗。
- 連帶的實作限制：`src/core`、`src/mcpx`、`src/io`、`src/cli` 不得依賴 Bun 專有 API（檔案 I/O 走 `node:` 標準模組）；跨 runtime 測試子集不得只依賴 `bun:test`，需提供可在 `node:test` 下執行的對等進入點。這會影響 scaffold 的測試框架選型，**t01 決定時就要考慮，不要等到 t12 才發現測試跑不到 Node 上**。
- 加入 lint 規則或測試，禁止在核心路徑直接使用 `Math.random` 與 `Math` 的超越函式（§100.2、§100.3）。

### v01-t02 PixelCanvas 核心模型

新增範圍：

- 實作 §102 的資源上限與記憶體預算，且 MUST 在配置 buffer 之前判斷。
- 錯誤碼清單改以 §99 為準（新增 `INVALID_ARGUMENT`、`ARGUMENT_CONFLICT`、`OUTPUT_EXISTS`、`UNKNOWN_OPERATION`、`DUPLICATE_OPERATION_ID`、`INVALID_PROFILE`、`MCPX_PALETTE_OVERFLOW`、`RESOURCE_LIMIT_EXCEEDED`、`VALIDATION_FAILED`、`INTERNAL_ERROR`）。
- error code 與 exit code 的對照 MUST 以資料表實作，並有測試逐條覆蓋，不得散落在各命令。

### v01-t03 Pixel primitives

新增範圍：

- 明確要求全整數運算（§100.1），並在測試中鎖定遍歷順序。

### v01-t04 批次操作與原子交易

新增範圍：

- 實作 §103 的結果回報格式：成功時逐 operation 回報 `index` / `id` / `status`；失敗時 error details 必須帶 `operationIndex`，有 id 時帶 `operationId`。
- `id` 在單次 batch 中唯一，重複回報 `DUPLICATE_OPERATION_ID`。
- 失敗時的 error code 為造成失敗的原始錯誤，不是籠統的 `TRANSACTION_FAILED`。

### v01-t05 mcpx v1 —— 範圍顯著擴大，建議拆分

這個任務的規格從「建議結構」變成了完整文法（§96）加表達範圍限制（§97）。原本申報的高風險維持不變，但建議拆成兩個任務：

```text
t05a  parser / serializer / canonical 文法
      §96 全部：section 順序、空白規則、數值格式、顏色格式、
      行內屬性文法、grid 兩種模式、註解處理
      驗收：canonical 輸出 byte-stable；手寫含註解的檔案 round-trip 後註解消失
            且像素與語意不變（這是預期行為，需明確測試）

t05b  palette 指派與表達範圍
      §96.6 符號指派規則（既有指派必須保留，新顏色依 RGBA 鍵值排序指派）
      §97 上限：compact ≤ 63 色、tokenized ≤ 4096 色、超過回報
          MCPX_PALETTE_OVERFLOW
      §102 的 mcpx 尺寸 warning
      驗收：改動單一像素只在 diff 中產生單一像素的變化（符號不重排）
```

另外：§21 的 canonical example 已修正 mask 對位，任何從舊版範例抄出的 fixture 必須重新產生。

### v01-t06 PNG 讀寫與 RGBA preservation

新增範圍：

- §101.1 已把「不得使用 sharp」從建議變成規範，決策紀錄中「pngjs 為起點、t06 實證後定案」需改寫：codec 選型仍需實證，但候選已被限制在不做 premultiply 的純實作。
- 新增 §101.2 的輸入正規化規則（16-bit 取高 8 bits、palette PNG 展開、交錯、gAMA/iCCP 忽略但回報 warning）。
- 新增 §101.3 的輸出參數固定要求，這是 byte-stable 的前提。

### v01-t07 CLI 骨架與全域約定 —— 範圍擴大

新增範圍：

- 實作 §98 全部：輸出通道分工（`--json` 與 `--stdout` 並用合法，此時 JSON envelope 走 stderr）、`OUTPUT_EXISTS` 與 `--force`、`--mkdir`、`--force` 與 `--in-place` 互斥、寫入前先寫暫存檔再 rename。
- 實作 §99 的 exit code 對照。
- **交付物包含文件回寫**：§104.1（`build` / `render` / `import` / `compose` 的分工）與 §104.2（ASCII Grid / Pixel Spec 的語法與副檔名）必須在此任務凍結，並把結論寫回 `project-detail.md` §104。若無法給出清楚差異，規格要求合併命令而不是保留同義詞。
- §104.3：V0.1 只實作 `--profile`，不實作 `--preset`。

### v01-t08 CLI 命令

無範圍變更，但驗收需涵蓋 §98 的各項行為，且命令名稱以 t07 的凍結結論為準。

### v01-t09 Asset Profile 與 Alpha Classification —— 語意修正

這是本次修訂中**語意變動最大**的任務：

- 單張 PNG 的分析只能得到 **predicted classification**。輸出欄位命名與文件敘述 MUST 反映這一點，MUST NOT 宣稱為最終渲染結果（§40）。
- 原因是 block model 的 texture entry 可以帶 `force_translucent`，強制進入 translucent pass。effective classification 需要同時讀 model JSON，屬於 V0.5 的 `validate-pack`，不在 V0.1 範圍。
- §95 的相容事實 MUST 以版本區間資料表達（例如 `{ fact, since: { packFormat }, value }`），讓 `--minecraft-version` / `--resource-pack-version` 能真正切換行為，而不是只印在報告裡。V0.1 至少要把資料結構立起來，即使只有一組版本。

### v01-t10 Analyze 引擎與命令

新增範圍：

- 分類欄位改用 predicted 語意（見 t09）。
- 報告中的浮點數 MUST 以固定小數位序列化（§100.3），否則 golden test 會漂移。

### v01-t11 Validate 命令

新增範圍：

- `exit 3` / `VALIDATION_FAILED` 專指「工具正常運作但素材不合格」，與工具故障分離（§99）。這需要一個明確的測試。
- §95 中標記「待補出處」的規則只能產生 Warning，不得產生 Error。

### v01-t12 符合性測試套件

新增測試項目：

```text
Bun 與 Node 上執行 golden / canonical / determinism 子集，輸出 byte-identical
--json 與 --stdout 並用時，stdout 只有產物 bytes、stderr 只有 JSON envelope
輸出檔已存在 → OUTPUT_EXISTS 且目標檔位元組不變
--force 才覆寫
父目錄不存在 → FILESYSTEM_ERROR 且不建立任何目錄；--mkdir 才建立
寫入中途失敗 → 不留下半寫入的目標檔或暫存檔
mcpx palette 溢位 → MCPX_PALETTE_OVERFLOW，details 含實際色數
mcpx 符號指派穩定性：改一個像素只產生一個像素的 diff
canvas 超出 §102 預算 → RESOURCE_LIMIT_EXCEEDED，且在配置 buffer 前
error code → exit code 對照表逐條覆蓋
batch 失敗時 details 帶 operationIndex
```

### v01-t13 README

新增範圍：

- 說明 determinism 保證範圍，以及該保證已由 Bun / Node 雙 runtime CI 驗證（§100.5）。
- 說明 alpha classification 是 predicted 而非 effective。
- 說明覆寫政策：預設不覆寫既有輸出檔，重跑 pipeline 需帶 `--force`。

---

## 7. 計畫層級需要更新的內容

### 決策紀錄新增

| 主題 | 決策 | 依據 |
|---|---|---|
| 文件位階 | 技術規格書為規範文件，衝突時為準 | §1.2 |
| PNG codec | 禁用 sharp / libvips / Skia 於 pixel-critical 路徑 | §101.1 |
| 輸出通道 | `--json` 與 `--stdout` 並用合法，JSON 走 stderr | §98.1 |
| 覆寫政策 | 預設拒絕覆寫既有輸出檔，`--force` 才允許 | §98.2 |
| 目錄建立 | 預設不建立父目錄，`--mkdir` 才建立 | §98.3 |
| 跨 runtime 驗證 | CI 同時跑 Bun 與 Node，輸出必須 byte-identical | §100.5 |
| Bun 依賴 | Core / CLI 不得依賴 Bun 專有 API | §100.5 |
| Alpha 分類 | V0.1 只產出 predicted classification | §40 |
| mcpx 定位 | 低色數創作格式，非任意 raster 容器 | §97 |

### 風險表更新

- 移除「規格書內部不一致（build / render 命名分工；`background` 欄位）」——`background` 已解決；命名分工改列為 t07 的明確交付物。
- 新增「predicted 與 effective alpha classification 被混用」：影響是 Agent 依 V0.1 的分析結果做出錯誤的素材決策。緩解為輸出欄位命名與 README 明確區分，並在 t09 的驗收中檢查。
- 新增「mcpx 符號指派不穩定造成 diff 噪音」：緩解為 §96.6 的指派規則與 t05b 的 diff 穩定性測試。

### 計畫級驗收新增

```text
--json 與 --stdout 的通道分離
OUTPUT_EXISTS / --force / --mkdir 的行為
mcpx 單像素改動只產生單像素 diff
alpha classification 明示為 predicted
```

---

## 8. 已裁決事項

兩項原本待定的決策已由專案擁有者裁定，文件已據此更新，不再是開放選項：

1. **覆寫政策**：預設拒絕覆寫既有輸出檔，`--force` 才允許（§98.2）。Agent 重跑同一條 pipeline 時必須顯式帶 `--force`。
2. **跨 runtime 驗證**：CI 納入 Node（§100.5）。golden、mcpx canonical、determinism 三組測試在 Bun 與 Node 各跑一次並比對，輸出必須 byte-identical。連帶限制是 Core / CLI 不得依賴 Bun 專有 API，且跨 runtime 測試子集必須能在 `node:test` 下執行——這是 t01 選測試框架時就要處理的事。
