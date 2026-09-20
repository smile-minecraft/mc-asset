# V0.5 設計凍結：Pack 驗證規則、Resource Location 與版本事實來源

V0.5 加入 Atlas-aware Resource Pack Validator、Resource Location Validator 與 Version-aware Compatibility Layer（§88），對外新增一個命令 `validate-pack`，並把 resource location 規則與版本事實資料化。這份文件把這批功能的判斷固定下來，讓後續四棒實作（t02 validate-pack 引擎與命令、t03 Resource Location Validator、t04 Atlas 感知驗證、t05 版本感知相容層）不必在錯誤碼、exit 分界、字元集與版本對應上各自猜測；命令表面（名稱、旗標、輸入輸出、exit code）以 `docs/cli-surface.md` 的「V0.5 commands (frozen)」為準，規範性結論記於 `project-detail.md` §108。

服務對象是要驗證一整個 Resource Pack、要確認引用與 atlas 關係，以及要以版本參數切換相容行為的工程師與 Agent。

規格只給了檢查清單與少數例子（§42、§55、§73、§88、§95；docs §41、§42），沒有給錯誤碼名稱、exit 分界、resource location 的字元集與長度，以及 26.1 與 1.21.11 的 packFormat 值。因此這份文件把多數細節標成「（本凍結）」，並在文末列出無法推定的「（待決）」項目。

## 位階與來源標記

規範條文以 `.project-doc/project-detail.md` 為準（§1.2），命令表面（名稱、旗標、輸入輸出、exit code）以 `docs/cli-surface.md` 為準。這份文件承載兩者之間的語意、錯誤碼命名與取捨理由，衝突時先比對技術規格書，再更新這份文件。

```text
§n         project-detail.md 第 n 節（規範）
docs §n    project-docs.md 第 n 節（產品規格書，非規範）
refs §n    mc-asset-development-references.md 第 n 節（參考資料，非規範）
（本凍結）  規格未給定、由這份凍結決定；附理由與應測點
（實作判讀） 實作實況；權威來源是每項列出的程式與測試，本文件只記錄
（待決）    規格無法推定，列入文末清單，不自行填補
```

規範強度依 §1.1：MUST／不得＝必須有測試涵蓋，違反即為 bug；SHOULD／建議＝可附理由偏離，偏離要記錄；MAY／可＝實作自由。

範圍歸屬的一條硬界線：§4 明列 Pixel Canvas Core MUST NOT 知道 namespace、resource location、atlas、`pack.mcmeta`。V0.5 的全部新邏輯因此落在 Minecraft Compatibility Layer（`src/profiles/`、`src/validate/`、`src/cli/`），MUST NOT 進 `src/core/`（純像素運算除外）。

## 凍結摘要

| 主題 | 凍結結論 | 出處 | 應測點 |
|---|---|---|---|
| 命令表面 | 只新增 `validate-pack <path>`；唯讀、零檔案旗標；`--json` 與版本旗標 | §88、§73、docs §42、§56 | 未知旗標與任何檔案旗標都是 exit 2；不產生任何檔案 |
| §42 掃描清單 | 逐項對應一批 `PACK_*` finding 碼，另加 §53 的 atlas 兩種錯誤 | §42、§53、§54 | 每一項都有可觸發的 fixture，且只有對應的那個碼 |
| exit 分界 | 0／2／3／4／5；呼叫端輸入 2、素材缺陷 3、讀不到 pack 根目錄 4、工具上限 5 | §99、§45、§102 | 單一檔案缺陷不打斷整趟掃描；重跑完全相同 |
| 待補出處紀律 | 只有「texture 僅 .png」是待補出處項，且只能是 warning | §95 | 非 `.png` 永不使 verdict fail |
| Resource Location | `<namespace>:<path>`；保守字元集；大寫為 error；長度不拒絕 | §55、§52、docs §41 | `MySword.PNG` 被檢出；超長名稱不被拒 |
| 版本事實資料 | 8 條事實用 §95 的 `{fact, since:{packFormat}, value}` 表達，只在相容層 | §95、§73、§4 | 事實不得散落 Core；無出處項不作為 error |
| 未指定版本的處理 | 讀 `pack.mcmeta` 的 `pack.pack_format`；讀不到只 warning，絕不硬編碼 | §73、§95 | 不得出現硬編碼 97.1 的預設路徑 |
| validate 整合 | 單檔只驗 filename 層級；namespace／path 屬 `validate-pack`；不新增旗標 | §55、§56、docs §41 | `validate` 不新增命令面 |
| 共同約束 | 唯讀、不重寫 Minecraft JSON、確定性、跨 runtime byte-identical | §42、§56、§100 | 掃描前後 pack 零位元改動 |

---

## 命令表面

V0.5 只新增一個命令 `validate-pack`。這個名稱已出現在兩處：`docs/cli-surface.md` 的 V0.1 保留清單（Deferred: `validate-pack` (V0.5)）與產品規格書 docs §42 的範例命令，因此不是新造名稱，也不與 `src/cli/program.ts` 既有命令（`stub`、`analyze`、`validate`、`import`、`render`、`transform`、`quantize`、`cleanup`、`palette`、`material`、`recolor`、`build`、`pixelize`、`variant`、`tile`、`generate`、`preview`、`animate`）同名。

```text
validate-pack <path> [--minecraft-version <v> | --resource-pack-version <n>] [--json]
```

| 表面 | 種類 | 一句話語意 | 出處 |
|---|---|---|---|
| `validate-pack <path>` | 新命令 | 掃描一個 Resource Pack 根目錄，回報結構與引用問題 | §88、§42、docs §42 |
| `--minecraft-version`／`--resource-pack-version` | 既有旗標新掛點 | 指定相容目標版本 | §73 |
| `--json` | 既有全域旗標 | JSON envelope 走 stdout，其餘訊息走 stderr | §98.1 |

`<path>` 是 pack 的根目錄，不是單一檔案。§56 說檔案位置由使用者決定、`mc-asset` 不需要知道，唯一的例外正是 `validate-pack` 正在驗證完整 Resource Pack；因此只有這個命令會讀取 pack 的目錄佈局。

唯讀與無檔案旗標（MUST，沿用 §42 的「不自動重寫 Minecraft JSON」）：

```text
輸出          validate-pack 不產生任何檔案；報告走 stdout（--json 走 envelope）
檔案旗標      --output／--stdout／--source／--force／--mkdir／--in-place／--input
              MUST NOT 被宣告；出現即 INVALID_ARGUMENT（exit 2）
--profile     MUST NOT 被宣告（本凍結）：profile 是「單一素材在 Minecraft 裡是什麼」的
              概念（§37），pack 內同時含多種素材，不由呼叫端用一個 profile 概括
JSON          MUST NOT 生成、修改或格式化 pack 內任何 JSON（§42）
```

`--profile` 之所以不宣告而不是忽略：忽略會讓呼叫端以為過濾生效，而「不開同義入口、也不開沒有語意的入口」是 §104.1 的原則（本凍結）。

Exit code（本凍結；沿用 §99 的 registry，不建本地表）：

```text
0   執行完成且 verdict pass（無 error 級 finding）
2   呼叫端輸入不成立：未知命令／旗標、非法的旗標組合、版本解析失敗
3   執行完成但 verdict fail（至少一筆 error 級 finding）→ VALIDATION_FAILED
4   工具無法取得素材：pack 根目錄不存在、不是目錄、不可讀 → FILESYSTEM_ERROR
5   工具自身上限：§102 的記憶體守衛觸發 → RESOURCE_LIMIT_EXCEEDED
```

正常輸入下可觀察到的是 0／2／3／4；`exit 5` 只在 §102 的守衛觸發時出現，仍屬凍結集合的一部分。

應測點：`validate-pack` 對任何檔案旗標回 INVALID_ARGUMENT 且零檔案；`--profile` 是未知選項（exit 2）；非目錄路徑是 exit 4；verdict fail 是 exit 3 而非 2。

---

## Pack 驗證掃描與錯誤碼

§42 列出 `validate-pack` 的主要檢查，但不給錯誤碼。本節把每一項固定成一個 finding 碼，並定出 exit 分界。

### exit 分界（本凍結）

§99 把 exit 3 定義成「工具正常運作，但素材不合格」，exit 2 是「呼叫端輸入不成立」。這個區分決定誰是 finding、誰是 thrown error：

```text
呼叫端輸入不成立（引數、旗標組合、版本解析）      → throw，exit 2
受檢素材的缺陷（含 pack 內 JSON 無法解析）        → finding；error 級 → verdict fail → exit 3
工具讀不到 pack 根目錄                            → throw FILESYSTEM_ERROR，exit 4
工具自身上限（§102 記憶體守衛）                    → throw RESOURCE_LIMIT_EXCEEDED，exit 5
```

一條由此推出的行為要求：`validate-pack` MUST NOT 因為單一檔案的缺陷中止掃描，MUST 把整棵樹掃完再給 verdict。一個 pack 裡壞掉的 model 不該讓 validator 停止回報其餘問題。

這條分界的已知張力：§42 把 invalid JSON 列為主要檢查，而 invalid JSON 讀起來像「結構性」錯誤。本凍結依 §99 的分類把它歸為 finding（verdict fail、exit 3），因為那顆 JSON 是受檢素材的一部分，不是驗證器自己的輸入。它與 `validate --mcmeta` 的 `INVALID_MCMETA`（throw、exit 2）不同：在那裡，`.mcmeta` 是呼叫端顯式指定的驗證器輸入。改判這個歸類會同時影響 t02 與 t03，列入待決清單標明。

### §42 掃描清單對照表

finding 的形狀沿用既有 `ValidateFinding{code, level, message}`（`src/validate/checks.ts`，實作判讀）。V0.5 對它多加一個選填的 `path`（相對於 pack 根目錄）用來指出位置；這是對既有形狀的擴充，由 t02 落地，既有 `validate` 的 finding 欄位不受影響。

| §42 檢查 | finding code | level | 一句話語意 |
|---|---|---|---|
| invalid JSON | `PACK_INVALID_JSON` | error | pack 內某個 JSON 文件無法解析 |
| missing referenced texture | `PACK_MISSING_TEXTURE` | error | 被引用的 texture 不存在 |
| missing referenced asset | `PACK_MISSING_ASSET` | error | 被引用的非 texture 素材不存在 |
| wrong path | `PACK_WRONG_PATH` | error | 檔案的實際位置與其 resource location 不符 |
| namespace problem | `PACK_NAMESPACE_PROBLEM` | error | namespace 缺失或不在允許字元集內 |
| case mismatch | `PACK_CASE_MISMATCH` | error | 引用與實際檔名只有大小寫不同，或出現大寫 |
| orphan texture | `PACK_ORPHAN_TEXTURE` | warning | texture 未被任何引用觸及 |
| invalid animation sheet | `PACK_INVALID_ANIMATION_SHEET` | error | 動畫 sheet 與其 `.mcmeta` 無法構成合法動畫 |
| invalid image dimension | `PACK_INVALID_IMAGE_DIMENSION` | error | 圖片尺寸越界或與宣告不符 |
| broken reference | `PACK_BROKEN_REFERENCE` | error | 引用本身不成立（目標無法解析或型別不符） |
| （§53 第一種錯誤） | `PACK_TEXTURE_NOT_IN_ATLAS` | error | texture 檔案存在，但沒有進入正確的 atlas |
| （§42 無對應項，本凍結） | `PACK_INVALID_IMAGE_DATA` | error | 圖檔存在，但無法解碼成 RGBA PNG |
| （filename 層級，本凍結） | `PACK_INVALID_FILENAME` | error | 檔名為空或含允許字元集以外的字元 |
| （§95 待補出處） | `PENDING_SOURCE_PNG_ONLY` | warning | 非 `.png` 副檔名；沿用既有碼，永不為 error |
| （版本未定） | `PACK_VERSION_UNDETERMINED` | warning | 版本目標無法判定，版本相依檢查已跳過 |

命名與收斂的四個決定（本凍結）：

- **§53 的兩種錯誤分成兩個碼。** §53 明言「texture 存在但未進正確 atlas」與「texture 根本不存在」是兩種不同錯誤，因此 `PACK_TEXTURE_NOT_IN_ATLAS` 與 `PACK_MISSING_TEXTURE` 各自獨立，MUST NOT 合併成一個碼。
- **`PACK_TEXTURE_MISSING` 不另立。** 它與 §42 的 missing referenced texture 是同一條件，統一叫 `PACK_MISSING_TEXTURE`；同義碼會違反 §104.1，不新增。
- **`TEXTURE_NOT_IN_REQUIRED_ATLAS` 不作為 finding 名。** §61 已把 `ATLAS_REFERENCE_ERROR` 與 `TEXTURE_NOT_IN_REQUIRED_ATLAS` 登記為 exit 3 的 error code（已在 `src/core/errors.ts`，實作判讀）。V0.5 的 finding 名以 `PACK_TEXTURE_NOT_IN_ATLAS` 為準；`ATLAS_REFERENCE_ERROR` 保留給「atlas 定義本身損壞、無法解析或解析後無法成立」的 thrown error；`TEXTURE_NOT_IN_REQUIRED_ATLAS` 維持登記、不另立第二個 finding 名。t02 在登記新碼時一併記錄這層關係。
- **`PACK_INVALID_FILENAME` 與 `PACK_CASE_MISMATCH` 分開。** 大小寫是 §55 唯獨點名的類別，單獨成碼；檔名的一般字元與結構問題另立一碼，避免一個碼承載兩種處置。

### 等級的依據

- 判為 error 的項目都以 §42／§53 的措辭為依據（「problem」「mismatch」「broken」在 §42 是待檢查的缺陷），或 §53 明言的「兩種不同錯誤」。
- `PACK_ORPHAN_TEXTURE` 判為 warning（本凍結）：§42 把它列為主要檢查，但一個未被引用的 texture 不使 pack 無法載入，把它當 error 會拒絕大量合法的 pack。這是「檢查得到」與「不合格」的區分。
- `PACK_INVALID_IMAGE_DIMENSION` 的判準用 §102 的 canvas 範圍 1–4096（本凍結）。Minecraft 自身的圖片尺寸規則在規格裡沒有出處，V0.5 MUST NOT 用未查證的規則拒絕素材；這條列入待決。
- `PENDING_SOURCE_PNG_ONLY` 是本表中唯一的 §95 待補出處項。§95 明定「待補出處的項目 MUST NOT 作為 Error 的依據，只能作為 Warning」，因此非 `.png` 的 texture 永遠只是 warning，不影響 verdict。

### 確定性與掃描順序

```text
目錄列舉      MUST 先排序（§100.3）；順序為相對路徑 byte 升冪
finding 順序  先依檔案（相對路徑 byte 升冪），再依檔內固定的檢查順序
報告內容      MUST NOT 含時間戳；同一 pack 重跑 MUST 得到相同報告
```

應測點：每張表的每一列都有對應 fixture，且觸發時只出現該碼（例如缺 texture 只給 `PACK_MISSING_TEXTURE`，不順帶給 `PACK_BROKEN_REFERENCE`）；`orphan` 只給 warning 且 verdict 仍 pass；同一 pack 重跑報告 byte-identical；一個壞掉的 model 不阻止其餘問題被回報。

### 錯誤碼的登記

§99 的 registry 是 exit 對照的唯一權威。本凍結只定名稱、level 與語意；把這些碼登記進 `src/core/errors.ts`（含 exit 3 的對照）屬 t02 的實作範圍，不在此凍結為既成事實。

---

## Resource Location 規則

§55 要求驗證 namespace、path、case、filename、extension 五類，並說這些不是 Pixel Canvas Core 的事。§42 把 namespace problem、case mismatch、wrong path 列為 pack 檢查。規格沒有給字元集與長度，因此在有出處的部分照寫，沒有的部分給保守版並標（本凍結）。

```text
形式          <namespace>:<path>
namespace     省略 ":" 時預設為 minecraft（§95 的 minecraft:items 為證）
分隔          ":" 至多一次；namespace 不含 "/"；path 不以 "/" 開頭或結尾，且不含 "//"
允許字元（本凍結，保守集）
              namespace  [a-z0-9_.-]
              path       [a-z0-9/._-]
大小寫        全部小寫
長度          無出處 → 待決；MUST NOT 以長度拒絕
```

對應到檢查碼：

```text
大寫出現                              → PACK_CASE_MISMATCH（error，§55）
namespace 為空或含集合外字元          → PACK_NAMESPACE_PROBLEM（error，§42）
path 為空、有前後斜線、空段或集合外字元 → PACK_WRONG_PATH（error，§42）
檔名為空或含集合外字元（非大寫）       → PACK_INVALID_FILENAME（error，本凍結）
檔名與引用的大小寫不一致              → PACK_CASE_MISMATCH（error，§42、§55）
副檔名不是 .png                       → PENDING_SOURCE_PNG_ONLY（warning，§95）
```

- **filename** 在這個凍結的意義是：resource location 的最後一段 MUST 與磁碟上的檔名 case-exact 相符；docs §41 也把 filename 列在 `validate` 的檢查清單內。
- **extension** 是唯一待補出處項，因此只能是 warning；判準只看副檔名，不看內容格式。
- 保守字元集（本凍結）的理由：§55 只給類別、不給字元集，而 §4 不允許 Core 知道 resource location。這組集合是「足以檢查 §55 的五類、且不引入任何版本特定假設」的最小集合。已知殘留風險：若官方字元集更寬，保守集可能誤拒；列入待決。

### pack 內的檔案佈局（有出處的部分）

```text
pack 根目錄    <path>
atlas 定義     assets/<namespace>/atlases/*.json           （§52）
texture        assets/<namespace>/textures/<path>.png
               出處：docs §7 的 ./my-pack/assets/example/textures/item/sword.png、
                     §95 表的 textures/ 路徑
```

- `PACK_WRONG_PATH` 的判準是「引用解析出的位置」與「實際檔案所在位置」不一致，以這兩條有出處的佈局為準。
- 其他 asset 型別的目錄名（model、blockstate、gui、particle 等）在規格中沒有完整對應，V0.5 MUST NOT 用未列出的目錄名拒絕檔案；完整佈局列入待決。

應測點：`MySword.PNG`（§55 的範例）被檢出；全大寫 namespace 被檢出；超長名稱不被拒；`assets/example/textures/item/sword.png` 不被判 wrong path；副檔名為 `.webp` 只給 warning。

---

## 版本事實與資料結構

§95 的查證日期是 2026-09-19，並規定這些事實 MUST 附出處、MUST 在 Compatibility Layer 中以資料表達，不得散落在 Core。資料形狀是：

```ts
{
  fact: "items-atlas-separated",
  since: { packFormat: 75 },
  value: { atlas: "items", mipmapped: false }
}
```

既有實作的型別是這個形狀的超集，另帶 `status`、`source`、`checkedAt` 三個後設欄位（`src/profiles/types.ts`，實作判讀）。V0.5 凍結這三個欄位只是後設資料，MUST NOT 改變行為，唯一的例外是 `status: "pending-source"` 的閘門。

### 八條事實與版本↔packFormat 對應（逐條出處）

| # | fact | 事實 | 文件版本 | since.packFormat | 狀態 | 出處 |
|---|---|---|---|---|---|---|
| 1 | resource-pack-format | Resource Pack Format `97.1` | Java Edition 26.3 | 待決（97.1 是 RP Format 標籤，非 packFormat 整數） | 已查證 | §95；Minecraft Wiki `Template:Resource pack format` |
| 2 | trim-palette-location | trim palette 由 `textures/trim/color_palettes/` 移至 `textures/palettes/trim/` | 26.3 / RP 97.1 | 待決（同上） | 已查證 | §95；同上 |
| 3 | items-atlas-separated | item texture 自 blocks atlas 分離為獨立 `minecraft:items`，且該 atlas 無 mipmap | 1.21.11 | 75（§95 的範例值，非版本對應出處） | 已查證 | §95；1.21.11 release notes |
| 4 | item-same-atlas / block-blocks-atlas | 同一 item model 的所有 texture 來自同一 atlas；block model 的 texture 來自 blocks atlas | 1.21.11 | 75（§95 範例） | 已查證 | §95；同上 |
| 5 | texture-mipmap-fields | `.mcmeta` texture section 新增 `mipmap_strategy` 與 `alpha_cutoff_bias` | 1.21.11 | 75（§95 範例） | 已查證 | §95；同上 |
| 6 | block-render-pass-auto | block model 的 render pass 依 sprite 內容自動決定 | 26.1 | 待決（規格無 26.1 的 packFormat 值） | 已查證 | §95；26.1 release notes |
| 7 | block-force-translucent | block model 的 texture entry 可用物件形式指定 `force_translucent` | 26.1 | 待決（同上） | 已查證 | §95；同上 |
| 8 | texture-png-only | Resource Pack texture 僅支援 `.png` | 起始 pack format 未確認 | 待決 | 待補出處 | §95 |

三條對應規則（本凍結）：

- **97.1 是 Resource Pack Format 的標籤，不是 `packFormat` 整數。** MUST NOT 把它寫進 `since.packFormat`，也 MUST NOT 讓它成為未指定版本時的隱含目標（§73 的「不得永遠硬編碼 97.1」）。
- **75 的來源是 §95 的結構範例。** 範例示範的是資料形狀，不是「1.21.11 等於 75」的版本對應。V0.5 照寫 75 並註明它是範例值；把它當成已查證的版本界線，或據此新增更多版本對應，都在禁止之列。
- **`since.packFormat` 無法填的事實，不得作為 error。** §95 的待補出處紀律是「MUST NOT 作為 Error 的依據，只能作為 Warning」；本凍結把同一紀律延伸到「版本對應未知」：一個事實的啟動點不明時，套用它就是在猜版本，因此它只能是 warning，不能使 verdict fail。這讓 26.1 的兩條事實與第 8 條落在同一種處置。

### 對行為的要求

```text
資料表達     八條事實 MUST 以 §95 的形狀存在於 Compatibility Layer（§4、§95）
不得散落     Core MUST NOT 引用 atlas、namespace、resource location、pack.mcmeta（§4）
啟動條件     fact 生效 = since.packFormat ≤ 目標 packFormat（既有 isFactActive，實作判讀）
warning 閘門  status: "pending-source" 或 since.packFormat 未定者，永不進入 error 路徑
出處         每條事實 MUST 帶得出處與查證日期（§95）
```

實作現況（實作判讀；權威來源是 `src/profiles/versions.ts` 的 `COMPAT_FACTS`）：八條事實都已以資料表達；`since.packFormat` 未定者以 `since:{}` 表達、永不生效，只走 warning 閘門。補齊細節見「實作補充（實作波）」的版本事實層。

應測點：8 條事實逐條有出處欄位；`pending-source` 與 `since` 未定者只產生 warning；把 `packFormat` 傳小於某 fact 的 `since` 時該 fact 不生效；grep 層級確認 Core 不含 atlas／resource location／pack.mcmeta 字樣。

---

## 版本旗標語意

§73 要求 Validator API SHOULD 接受 `--minecraft-version` 或 `--resource-pack-version`，範例是 `mc-asset validate-pack ./pack --minecraft-version 26.3`；未指定時未來可以讀 `pack.mcmeta` 決定 target；且不得永遠硬編碼 `97.1`。

```text
--minecraft-version <version>      目標 Minecraft 版本
--resource-pack-version <n>        目標 packFormat，正整數
```

沿用 V0.1 已凍結的解析規則（`docs/cli-surface.md` 的 Version flags、`src/cli/version-options.ts`，實作判讀）：

```text
至多一個      兩個同時出現 → INVALID_ARGUMENT（exit 2）
未知版本      --minecraft-version 不在可解析集合 → INVALID_ARGUMENT（exit 2）
非整數        --resource-pack-version 非正整數（含 "97.1" 這種點號版本）→ INVALID_ARGUMENT
```

未指定時的行為（本凍結）：

```text
1  讀 pack 根目錄的 pack.mcmeta，取 `pack.pack_format` 作為目標 packFormat
   （鍵路徑是 Minecraft 的標準形狀，但規格未載出處，故標（本凍結）；見待決）
2  讀不到、或無法解析 pack.mcmeta 時，版本相依檢查跳過，附 PACK_VERSION_UNDETERMINED warning
3  MUST NOT 套用任何硬編碼的預設版本（§73）
4  pack.mcmeta 本身無法解析時，另給 PACK_INVALID_JSON finding（見掃描清單）
```

- 本凍結只定「讀 `pack.pack_format`」這一層；鍵路徑與還要讀哪些欄位（`supported_formats`、overlays 等）在規格中都沒有出處，因此列為待決，避免把未查證的 schema 假設寫成行為。實作在讀不到該鍵時走「版本未定」路徑（warning），不得改讀其他欄位或套用預設。
- `pack.mcmeta` 的解析 MUST 只讀；`validate-pack` 不寫入、不重寫、不格式化（§42）。
- 可解析的 `--minecraft-version` 集合在 packFormat 對應定案之前維持既有（26.3 → packFormat 75，實作判讀）；新增任何版本值 MUST 先有出處，不得為了讓旗標「看起來支援」而填入未查證的數字。
- `97.1` 的顯示回音只綁在解析出的目標版本上（既有行為），MUST NOT 成為未指定版本時的替代值。

應測點：兩個版本旗標同時出現是 exit 2；未指定且無 `pack.mcmeta` 時只給 warning 且不套用任何版本事實；`pack.mcmeta` 含 `pack_format` 時版本相依判定依該值；報告中不出現硬編碼的 97.1 作為預設。

---

## validate 的 resource location 整合

t03 會把 resource location 的檢查整合進既有的單檔 `validate`。單檔沒有 pack 根目錄，因此可驗的只有與檔案自身路徑有關的部分（§56 的原則不變：檔案位置由呼叫端決定）。

```text
可驗   filename：最後一段的字元集與大小寫、以及副檔名
不可驗 namespace、path：單檔沒有 pack 根目錄，無法判定資源位置所在的樹
旗標   MUST NOT 新增（本凍結）；要驗 namespace／path 用 validate-pack
```

- 既有 `FILENAME_EXTENSION_NOT_PNG`（§34 的 Minecraft profile 只輸出 PNG，屬 error）維持不變，不由 §95 的待補出處項重新推導。
- 新增的是 stem 層級：大寫 → `PACK_CASE_MISMATCH`（error）；字元集外字元 → `PACK_INVALID_FILENAME`（error）。
- 這是行為變更：既有資產若檔名含大寫，V0.5 後會由 pass 變 fail（exit 3）。t03 MUST 在回歸基線中明列這個差異，MUST NOT 靜默改變既有 fixture 的預期。
- 檢查對象仍限定 Minecraft profile（`generic` 依 §44 沒有 Minecraft 專屬限制）；是否放寬到全部 profile 列入待決。

應測點：`validate Sword.png` 在 minecraft profile 下 verdict fail 且 finding 為 `PACK_CASE_MISMATCH`；`validate sword.png` 不受影響；`generic` profile 不因檔名大寫而 fail；`validate` 未新增任何旗標。

---

## 共同約束（§42、§56、§98、§100）

V0.5 的新表面是唯讀的，因此 §57 與 §98.2–§98.4 的寫入守衛不適用；適用的是不產生隱式輸出、通道分工與確定性。

```text
零檔案        MUST NOT 建立任何檔案或目錄；§57 在唯讀命令上等於「沒有輸出旗標可給」
通道          --json 與 stdout 的分工依 §98.1；stdout 同時只承載一種載荷
不重寫 JSON   MUST NOT 生成、修改或格式化 pack 內任何 JSON（§42）
不改輸入      pack 內檔案在掃描前後 byte-identical（§56 的例外只關於「讀懂佈局」）
只讀解析      pack.mcmeta、model、atlas、blockstate 一律只讀
全序排序      目錄列舉先排序；不得依賴物件鍵序或不穩定排序（§100.3）
無時間戳      報告 MUST NOT 含時間戳（§100.3）
報告浮點      以固定小數位序列化（§100.3）
跨 runtime    同 pack／同參數／同版本，跨 macOS／Linux 與 Bun／Node byte-identical（§100.4、§100.5）
```

`--json` 的結果形狀沿用既有 report 慣例（success envelope ＋ `result`），`result` 內至少含 `command`、`path`、`target`、`verdict`、`findings`；`findings` 的每一項是 `{ code, level, message, path? }`。既有 `validate` 的欄位不因 V0.5 改變。

應測點：掃描前後 pack 樹的檔案雜湊不變；`--json` 與人類報告對同一 pack 給出相同 verdict 與相同 finding 集合；跨 Bun／Node 的報告 byte-identical。

---

## 實作補充（實作波）

這一節把 V0.5 實作時確認、但前面章節未寫定的判讀補上。體例同 `docs/v03-design.md` 的「實作補充（實作波）」：標 `（實作判讀）` 的是實作實況，權威來源是每項列出的程式與測試，本節只記錄、不重新凍結。

### validate-pack 掃描引擎（實作判讀）

掃描範圍是 starter：引用解析只認 `assets/<namespace>/models/**/*.json` 的 `parent`（解析成 model 檔）與 `textures` 的值（解析成 `textures/<path>.png`），其他 asset 型別不發明 schema。extension 檢查只對磁碟上的實檔發出（引用字串不噴 warning 洪流，主代理裁決），因此引用慣例上省略副檔名不會造成誤報。

`PACK_BROKEN_REFERENCE` 的 starter 界線同樣收窄：非字串或空白的引用、`textures` 不是物件、texture 指到 `.json`、`parent` 指到 `.png`。單一壞檔不中止掃描，一顆壞掉的 model 不阻止其餘問題被回報；finding 依相對路徑 byte 升冪、再依 `FINDING_ORDER` 的固定檢查順序排序。

出處：`src/validate/pack.ts` 的 `scanPack`、`checkSingleFile`、`checkDiskName`、`checkModelReferences`、`checkParentReference`、`checkTextureReference`、`checkAnimationSheet`、`collectPackFiles`、`FINDING_ORDER`。

測試：`tests/validate/pack-cases.ts`（`pass: clean pack has no error findings`、`fail: missing referenced texture`、`fail: missing referenced parent asset`、`fail: non-string texture reference is broken`、`fail: one bad model never blocks the rest of the report`、`deterministic: reruns are byte-identical and findings sort by path`）、`tests/validate/pack.test.ts`（`clean pack passes as JSON without touching inputs`、`failing pack exits 3 with VALIDATION_FAILED and keeps every finding`、`file flags are unknown options (exit 2) and create nothing`、`--profile is an unknown option (exit 2)`、`missing root is exit 4, never exit 3`、`no flags without pack.mcmeta warns only and never defaults`、`no flags reads pack.mcmeta pack_format and reports it`）。

### Resource Location 引擎（實作判讀）

引擎是唯一實作點：單檔 `validate` 的檔名檢查與 `validate-pack` 的引用與磁碟檔名檢查都匯入同一份 `src/validate/resource-location.ts`，沒有第二份字元集。大寫由 `PACK_CASE_MISMATCH` 獨占：字元集檢查先小寫化，所以同一個「大寫」成因只給一個碼，不會同時噴 namespace／path 的集合違規。長度不拒絕。

`validate` 的整合只驗 filename 層級：從 basename 取最後一個點之前的 stem，驗大小寫與字元集；大寫 extension 仍由既有 `FILENAME_EXTENSION_NOT_PNG` 處理，不重複回報。閘門沿用既有 Minecraft profile 清單（`minecraft:item`／`minecraft:block`），`generic` 不觸發；gui／particle 刻意不含，避免讓原本通過的資產變成 fail。

出處：`src/validate/resource-location.ts` 的 `parseResourceLocation`、`validateResourceLocation`、`validateDiskFilename`；`src/validate/checks.ts` 的 `checkFilename`、`checkResourceFilename`、`validateReport`。

測試：`tests/validate/resource-location-cases.ts`（`fail: freeze witness MySword.PNG is a case mismatch`、`fail: uppercase namespace is a case mismatch, not a namespace problem`、`pass: length never rejects`、`warning: webp extension is pending-source warning only`、`filename: Sword.png stem uppercase is a case mismatch`、`validate: minecraft item fails Sword.png with PACK_CASE_MISMATCH`、`validate: generic ignores uppercase stems`）、`tests/validate/resource-location.test.ts`。

### Atlas 感知判定（實作判讀）

atlas sources 只解析 `directory` 與 `single`；`filter`、`paletted_permutations` 等未知型別（含缺 `type` 或 `source`）一律跳過，該 atlas 標 `complete: false`，查詢回 `unknown`，呼叫端跳過不妄判。required atlas 與版本閘門都取自事實資料（`ITEMS_ATLAS_FACT`／`ITEM_ATLAS_PLACEMENT_FACT`；block→`blocks`、item→`items` 的值），不在引擎內硬編碼。§54 的同 atlas 約束以 required membership 等價執法；跨 namespace 的同名 atlas 以 union 看待（僅可能漏報）。`ATLAS_REFERENCE_ERROR` 保留在 registry 未拋：壞掉的 atlas JSON 走 `PACK_INVALID_JSON` finding 並跳過。

出處：`src/validate/atlas.ts` 的 `parseAtlasDefinitions`、`atlasCoverageFor`、`requiredAtlasForModel`、`normalizeDirectorySource`；`src/validate/pack.ts` 的 `checkAtlasCoverage`。

測試：`tests/validate/atlas-cases.ts`（`directory source covers its subtree only`、`single source covers exactly its resource`、`unknown source types are reported and never accuse`、`missing atlas answers unknown, never not-covered`、`unusable atlas documents skip without inventing members`、`required atlas follows the model kind through the policy`）、`tests/validate/pack-cases.ts`（`fail: existing texture absent from the required atlas`、`pass: packFormat below the atlas split skips atlas verdicts`、`pass: unknown atlas source types never accuse`）。

### 版本事實層（實作判讀）

八條事實都以資料表達，每條帶 `source` 與 `checkedAt`（2026-09-19）。`since.packFormat` 未定者以 `since:{}` 表達，`isFactActive` 永不成立，因此永不生效；pending-source 與 since 未定共用同一道 warning 閘門，永不進入 error 路徑，`validate`／`analyze` 報告會出現 `VERSION_FACT_UNDETERMINED`（以及尚未查證項目的 `PENDING_SOURCE_PNG_ONLY`）等 warning。75 只是 §95 的結構範例值並已註記，不當成版本界線；`97.1` 是 RP Format 標籤，不進 `since`，報告也不用它作預設。未指定版本時，`validate-pack` 只讀 pack 根目錄 `pack.mcmeta` 的 `pack.pack_format`（唯讀；鍵路徑本凍結未變），讀不到就只給 `PACK_VERSION_UNDETERMINED` warning、不套預設。

出處：`src/profiles/versions.ts` 的 `COMPAT_FACTS`（八條）、`isFactActive`、`resolveVersionedFact`、`pendingSourceWarnings`；`src/validate/pack.ts` 的 `packFormatFromMcmeta`；`src/cli/version-options.ts` 的 `resolveVersionTarget`、`formatVersionTarget`。

測試：`tests/validate/pack-cases.ts`（`warning: undetermined version without a flag`、`undetermined version report never hardcodes 97.1`、`pack.mcmeta pack.pack_format becomes the target with no flag`、`pack.mcmeta without a usable pack_format warns and skips with no default`）；`tests/cli/version.test.ts`、`tests/profiles/profile-cases.ts`。

### 跨 runtime 與符合性（實作判讀）

`scripts/compare-runtime.mjs` 的 V0.5 區塊比對 Bun（跑 source CLI）與 Node（跑 bundle）的輸出：clean pack 與 defect pack 兩個 `validate-pack --json` 情境（皆帶 `--resource-pack-version 75`）都 identical，全樹 28 個比對項目全部 OK。defect pack 的不可解析 JSON 由腳本以固定字串寫入，不進 repo 的 fixture。`tests/conformance/cli-conformance.test.ts` 的 V0.5 章節涵蓋檔案旗標守衛、版本與路徑守衛、verdict 與 determinism；CI run 35499155465 的 `bun` 與 `node` 兩個 job 都成功。

出處：`scripts/compare-runtime.mjs` 的 V0.5 區塊；`tests/conformance/cli-conformance.test.ts` 的 `conformance: V0.5 validate-pack file-flag guards`、`conformance: V0.5 validate-pack version and path guards`、`conformance: V0.5 validate-pack verdict and determinism`。

### 未驗證與風險（實作判讀）

- `exit 5`（`RESOURCE_LIMIT_EXCEEDED`）的記憶體守衛沒有活體的大包測試，只由 `MAX_PACK_FILES` 上限的程式路徑存在。
- atlas 保守跳過的召回率取捨：未定義或只解析一半的 atlas 一律跳過，代價是可能漏報。
- `--minecraft-version 26.3`（走 packFormat 75 的單群組）未進 `compare-runtime` 矩陣，V0.5 只比對 `--resource-pack-version 75`。
- Windows 路徑分隔符未測：`basenameOf` 同時處理 `\` 與 `/`，但沒有跨平台測試。
- resource location 的保守字元集可能誤拒（見待決清單第一列）。

## 待決清單

以下無法從規格推定，列出但不自行填補。標「影響對外行為」的項目在定案前會直接改變命令表面或 verdict。

| 項目 | 為什麼無法推定 | 需要什麼 | 現況 | 影響 |
|---|---|---|---|---|
| resource location 的完整字元集 | §55 只列類別，沒有字元集 | 官方字元集出處 | 保守集已落地（`src/validate/resource-location.ts`）；可能誤拒（實作判讀；待複核） | 影響對外行為：誤判 verdict |
| resource location 的長度上限 | 規格無出處 | 官方上限 | 不拒絕（實作判讀） | 目前不影響 |
| texture 僅 `.png` 的起始 pack format | §95 標待補出處 | 官方出處 | warning only（§95）；非 `.png` 永不使 verdict fail（實作判讀） | 影響對外行為：非 `.png` 的等級 |
| 26.1 兩條事實的 packFormat | §95 沒有值 | 版本↔packFormat 對應出處 | `since:{}` 表達、永不生效，只走 warning；不新增可解析版本（實作判讀） | 影響對外行為：t05 無法切換 26.1 |
| 1.21.11 的 packFormat（75 只是 §95 範例） | 範例不是版本對應出處 | 同上 | 75 僅作 §95 範例值註記，不當版本界線（實作判讀） | 影響對外行為：版本切換精度 |
| Java 26.3 的 packFormat 整數（表只給 97.1 標籤） | 97.1 不是整數 | 同上 | 97.1 為標籤、不入 `since`；報告不以它作預設（實作判讀） | 影響對外行為：同上 |
| `pack.mcmeta` 的鍵路徑與讀取深度 | §73 只說「讀 pack.mcmeta」，沒有欄位或鍵路徑 | 官方 schema 出處（`pack.pack_format`、`supported_formats` 等） | 只讀 `pack.pack_format`（本凍結；鍵路徑未證）；已落地為唯讀讀取（實作判讀） | 影響對外行為：未指定版本時的 target |
| `PACK_INVALID_JSON` 的 exit 歸類 | §42 的「主要檢查」與 §99 的分類有張力 | 決策 | finding／exit 3 已落地，含 `pack.mcmeta` 的 `PACK_INVALID_JSON`（實作判讀） | 影響對外行為：改判會同時動 t02、t03 |
| `validate-pack` 是否提供 profile 過濾 | 規格未定 | 是否要 | 不宣告（本凍結）；傳入即未知選項 exit 2（實作判讀） | 影響對外行為：命令表面 |
| `validate` 是否需要 resource location 旗標 | 單檔沒有 pack 根目錄 | 是否要 `--resource-location` | 不新增；檢查掛在既有 `validate`（實作判讀） | 影響對外行為：t03 的表面 |
| 各 asset 型別的完整目錄佈局 | 只有 atlases 與 textures 有出處 | 完整佈局出處 | 只驗 `textures/` 與 `atlases/` 等有出處者（實作判讀） | 影響對外行為：`PACK_WRONG_PATH` 的覆蓋率 |
| Minecraft 自身的圖片尺寸規則 | 規格無出處 | 官方出處 | 沿用 §102 的 1–4096 判準（實作判讀） | 影響對外行為：`PACK_INVALID_IMAGE_DIMENSION` |
| `orphan texture` 的等級 | §42 只列檢查 | 是否視為不合格 | warning 已落地；verdict 仍 pass（實作判讀） | 影響對外行為：verdict |
| §61 既有 atlas 碼與 `PACK_*` 的收斂 | 兩套命名在同一概念上重疊 | 是否合併 | 已登記關係：finding 名為 `PACK_TEXTURE_NOT_IN_ATLAS`，`ATLAS_REFERENCE_ERROR` 留在 registry 未拋（實作判讀） | 影響對外行為：t02 的登記 |
| `validate` 的檔名檢查是否擴及全部 profile | §44 只說 generic 沒有 Minecraft 限制 | 是否放寬 | 限定 `minecraft:item`／`minecraft:block`；gui／particle 刻意不含、`generic` 不觸發（實作判讀；t03 刻意） | 影響對外行為：generic 的 verdict |

「現況」一欄只記實作實況，不代表任何項目已定案；未提到的細節仍以各節敘述為準。

---

## 實作交接

後續實作這批功能時，可直接沿用的既有接縫（權威來源是各檔案）：

```text
錯誤碼與 exit        src/core/errors.ts（ERROR_EXIT_CODE、resolveExitCode；新 PACK_* 的登記屬 t02；
                     ATLAS_REFERENCE_ERROR／TEXTURE_NOT_IN_REQUIRED_ATLAS 已存在並對應 exit 3）
finding 形狀與 verdict src/validate/checks.ts（ValidateFinding{code,level,message}、
                     validateReport 只在有 error 級 finding 時 fail）
版本旗標解析         src/cli/version-options.ts（resolveVersionTarget／versionReportShape／
                     formatVersionTarget；V0.1 的互斥與整數規則）
版本事實資料         src/profiles/versions.ts（VersionedFact、isFactActive、resolveVersionedFact、
                     pendingSourceWarnings）、src/profiles/types.ts（VersionSince、FactStatus）
profile 註冊         src/cli/profiles.ts（SUPPORTED_PROFILES、parseProfile）、
                     src/profiles/profiles.ts（getAssetProfile、describeAssetProfilePredicted）
單檔驗證命令         src/cli/validate.ts（runValidate；--mcmeta 的只讀前例、verdict fail → VALIDATION_FAILED）
解碼與 PNG           src/io/decode.ts（decodeImage）、src/io/png.ts（decodePng、flattenCanvas）
資源上限             src/core/validate.ts（validateDimension、checkResourceLimits）
通道與 envelope      src/cli/channels.ts、src/cli/envelope.ts
CLI 骨架             src/cli/program.ts（掛 validate-pack；唯讀命令掛既有模式）
```

模組切分的交接要點（給 t02／t03／t04／t05）：

```text
t02  validate-pack 引擎與命令
     純引擎：pack 掃描、引用解析、finding 折疊（不碰 CLI 接線）
     接線：validate-pack 掛進 program.ts；唯讀、無檔案旗標
     登記：PACK_* 進 src/core/errors.ts（含 exit 3 對照）與本文件表的對應
     碰 program.ts：是（新命令）

t03  Resource Location Validator
     純引擎：resource location 解析與字元集／大小寫／檔名檢查（單一實作點，供 t02 與 validate 共用）
     接線：validate 的檔名層級檢查；MUST NOT 新增旗標
     碰 program.ts：否（沿用既有 validate）

t04  Atlas 感知驗證
     純引擎：texture → sprite reference → resource location → required atlas → atlas sources → actual texture
             的解析鏈，兩種錯誤以 PACK_TEXTURE_NOT_IN_ATLAS／PACK_MISSING_TEXTURE 區分
     依賴：§54 的同 atlas 約束用 t05 的事實資料判定版本
     碰 program.ts：否（掛在 t02 的 validate-pack 內）

t05  版本感知相容層
     純引擎：8 條事實資料化、since 判定、pending-source 與 since 未定的 warning 閘門
     接線：--minecraft-version／--resource-pack-version 的解析擴充與 pack.mcmeta 讀取
     碰 program.ts：可能（版本轉譯與 validate-pack 的旗標掛點）
```

- 序列化注意（給主代理）：t02 與 t05 都可能碰 `src/cli/program.ts`，依 §105.10 的接線權責 MUST 依序執行、MUST NOT 並行；t03、t04 的純引擎可先落地。
- t03 的 resource location 引擎 MUST 是唯一實作點：`validate` 與 `validate-pack` 共用，避免兩處各自維護字元集。
- t04 的 atlas 判定 MUST 走 t05 的事實資料（§4、§95），MUST NOT 在 Core 或 t04 內硬編碼 atlas 名稱與版本。
- t02 MUST NOT 刪除 §61 既有的 atlas 碼；新舊關係見「Pack 驗證掃描與錯誤碼」的命名決定。
- t05 MUST NOT 為了讓旗標「支援更多版本」而填入未查證的 packFormat；缺出處者照待決清單處置。

## 後續實作的共同義務

- 任何規範性語句若在本文件找不到出處或「（本凍結）」標記，一律視為需要回頭補規格，不得直接實作。
- 每個「應測點」都要有對應測試；MUST 級敘述沒有測試涵蓋即為 bug（§1.1）。
- 發現本文件與 `project-detail.md` 或 `project-docs.md` 不一致時，以 `project-detail.md` 為準，並回頭更新本文件與 `docs/cli-surface.md`。
- 標「（待決）」的項目在定案前 MUST NOT 被當成已凍結的行為；實作若必須先動，採最小、可測、確定性的 starter 並在回報標明。
- 版本事實若補上官方出處，MUST 一併更新 §95 的表格、本文件的對應欄位與 `src/profiles/versions.ts` 的資料；三者不得各說各話。
