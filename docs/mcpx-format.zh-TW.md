# .mcpx 與 .grid 格式規格

[English](mcpx-format.md) | [繁體中文](mcpx-format.zh-TW.md) | [简体中文](mcpx-format.zh-CN.md)

本文件定義 `mc-asset` 讀取的兩種純文字格式的語法、節區與約束：`.mcpx`（可編輯的多圖層像素畫布）與 `.grid`（輕量的單圖層草稿）。解析器位於 `src/mcpx/`；`.grid` 讀取器位於 `src/cli/grid.ts`，沿用同一條解析管線。

## 目錄

- [1. 兩種格式](#1-兩種格式)
- [2. 檔案層級規則](#2-檔案層級規則)
- [3. `.mcpx` 文件結構](#3-mcpx-文件結構)
- [4. 各節區規格](#4-各節區規格)
- [5. 輕量 `.grid` 格式](#5-輕量-grid-格式)
- [6. 完整範例](#6-完整範例)
- [7. 錯誤代碼](#7-錯誤代碼)
- [相關文件](#相關文件)

---

## 1. 兩種格式

- **`.grid`**：只有調色盤和一張字元網格。手寫草稿或請模型畫貼圖時，從這裡開始。
- **`.mcpx`**：對應 `PixelCanvas` 的完整版本化格式（`mcpx 1`），包含多圖層（可見性與不透明度）、具名區域遮罩、中繼資料與調色盤角色。需要第二個圖層、區域或中繼資料時再換成它；`render --source` 可以直接把 `.grid` 轉過來。

解析是確定性的：同一份文字永遠得到同一張畫布、同樣的 PNG 位元組。輸出是正規化的：`build --source`（以及所有會輸出 `.mcpx` 的指令）會把畫布序列化為逐位元組穩定的文字——固定的節區順序、大寫 `#RRGGBBAA` 顏色、三位小數的不透明度。

---

## 2. 檔案層級規則

所有 `.mcpx` 與 `.grid` 檔案都遵守以下詞法規則：

- **編碼**：UTF-8，不得帶 BOM。開頭有 BOM 會回報 `MCPX_SYNTAX_ERROR`。
- **換行**：只接受 LF（`\n`）。出現任何 CR（`\r`）都會回報 `MCPX_SYNTAX_ERROR`。
- **註解**：第一個非空白字元為 `;` 的行是註解。註解只能獨占一整行——寫在節區標頭或數值後面的 `;` 不算註解，會讓該行無效。`[grid]`／`[mask]` 資料內也不允許註解。
- **空白行**：節區與項目之間的空白行會被略過。在網格或遮罩資料內，列之後的第一個空白行即結束該區塊；所有列必須連續成一個區塊。
- **行尾空白**：每行行尾的空格與 Tab 會在解析前清除，因此不會影響網格寬度。

---

## 3. `.mcpx` 文件結構

`.mcpx` 文件以版本檔頭開始，接著依正規順序列出各節區：

```text
mcpx 1

[canvas]
...

[metadata]
...

[palette]
...

[layer <id>]
...

[grid]
...

[region <id>]
...

[mask]
...
```

### 3.1 檔頭

第一個非空白、非註解的行必須是：

```text
mcpx 1
```

缺少檔頭或版本號不是整數，回報 `MCPX_SYNTAX_ERROR`；版本號是 `1` 以外的整數，回報 `MCPX_UNSUPPORTED_VERSION`。

### 3.2 正規節區順序

1. `[canvas]`：必填，必須是第一個節區，僅能出現一次。
2. `[metadata]`：選填，最多一次，緊接在 `[canvas]` 之後。
3. `[palette]`：語法上選填，最多一次，位於 `[canvas]`／`[metadata]` 之後。網格用到的每個符號都必須在此定義，所以實務上只要有圖層就需要它。
4. `[layer <id>]`：零個以上（最多 64 個）。每個圖層先列屬性，再接恰好一個 `[grid]` 或 `[grid tokens]`。
5. `[region <id>]`：零個以上（最多 256 個），全部位於最後一個圖層之後。每個區域先列屬性，再接恰好一個 `[mask]`。

節區順序錯誤、未知節區、圖層缺少 `[grid]` 或區域缺少 `[mask]`，皆回報 `MCPX_SYNTAX_ERROR`。圖層或區域數量超過上限（或超出 512 MB 記憶體預算）回報 `RESOURCE_LIMIT_EXCEEDED`。

---

## 4. 各節區規格

每個節區由 `key = value` 行組成。鍵名需符合 `^[a-z][a-z0-9_]*$`；重複或未知的鍵回報 `MCPX_SCHEMA_ERROR`。v1 不支援引號，因此任何值都不能含空白。

### 4.1 `[canvas]`

```text
[canvas]
width = 16
height = 16
```

- `width` 與 `height` 皆必填，也是唯二允許的鍵。
- 兩者都是不帶正負號、不帶前導零的十進位整數，範圍 `1` 到 `4096`。任一邊超過 512 仍然合法，但序列化時會發出 `MCPX_LARGE_CANVAS` 警告，因為 diff 會變得很大。

### 4.2 `[metadata]`（選填）

隨素材攜帶的自由鍵值對。

```text
[metadata]
author = Steve
profile = minecraft:item
```

- 值不得含空白。序列化時鍵名會依排序輸出。

### 4.3 `[palette]`

把符號對應到 32 位元 RGBA 顏色。

```text
[palette]
. = transparent
R = #E74C3CFF
D = #C0392BFF role=shadow
W = #FFFFFF
```

- **項目格式**：`<symbol> = <color>`，可選擇在後面加上 ` role=<role>`。
- **符號**：任何不含空白與 `=` 的 token（例如 `c01`、`gold_edge`）。單字元符號必須是 `[.0-9A-Za-z]` 之一。符號重複回報 `MCPX_SCHEMA_ERROR`。
- **顏色**：`transparent`（等同 `#00000000`）、`#RRGGBB`（alpha 為 `FF`）或 `#RRGGBBAA`。序列化一律輸出大寫 `#RRGGBBAA`，所以 `transparent` 會變成 `#00000000`。
- **保留的透明符號**：`.` 只能對應 `#00000000`，而 `#00000000` 只能用 `.`。違反任一條回報 `MCPX_SCHEMA_ERROR`。
- **角色**（選填）：`outline`、`shadow`、`dark`、`base`、`light`、`highlight`、`accent`、`custom`。`role` 是 v1 唯一定義的調色盤屬性。

### 4.4 `[layer <id>]` 與其網格

圖層由下往上合成：檔案中的第一個圖層位於堆疊最底層，之後的每個圖層依序疊在上方。

- **圖層 ID**：符合 `^[A-Za-z0-9_.-]+$`（例如 `base`、`shade`、`overlay.1`）。ID 重複回報 `MCPX_SEMANTIC_ERROR`。
- **屬性**（順序不拘；序列化時依 `visible`、`opacity`、`name` 輸出）：
  - `visible = true | false`：預設 `true`。
  - `opacity = <小數>`：範圍 `0` 到 `1`，寫作 `0`、`0.<數字>`、`1` 或 `1.0…`（不接受指數表示法，也不接受以 `.` 開頭）；預設 `1`。序列化時固定輸出三位小數，需要更多位數的值會被拒絕。
  - `name = <文字>`：選填的顯示名稱，不得含空白。
  - 其他任何鍵（包括 `blendMode`）都回報 `MCPX_SCHEMA_ERROR`：v1 文字格式不攜帶混合模式。

屬性之後是該圖層的像素資料，有兩種寫法。

#### 緊湊網格：`[grid]`

每個字元就是一個符號，所以用到的符號都必須是單字元。緊湊調色盤最多容納 63 色（`.`、`0-9`、`A-Z`、`a-z`）。

```text
[layer base]
visible = true
opacity = 1.000

[grid]
.RR.
RWWR
RWWR
.RR.
```

- 恰好 `height` 列，每列恰好 `width` 個字元，中間不加分隔。
- 列長或列數不符回報 `INVALID_GRID_SIZE`；符號未在 `[palette]` 定義回報 `MCPX_SEMANTIC_ERROR`。

#### 標記網格：`[grid tokens]`

用於調色盤含多字元符號，或顏色超過 63 色（最多 4096 色）的情況。

```text
[palette]
. = transparent
c01 = #5A6068FF
c02 = #9AA1A9FF

[layer base]

[grid tokens]
. c01 c01 .
c01 c02 c02 c01
c01 c02 c02 c01
. c01 c01 .
```

- token 之間以恰好一個空格分隔；出現連續兩個空格回報 `MCPX_SYNTAX_ERROR`。
- 恰好 `height` 列，每列恰好 `width` 個 token。
- 序列化時，若所有調色盤符號都是單字元就輸出 `[grid]`，否則輸出 `[grid tokens]`。畫布顏色數超過所選寫法的容量時回報 `MCPX_PALETTE_OVERFLOW`，此時請改存 PNG。

### 4.5 `[region <id>]` 與其遮罩（選填）

區域是掛在畫布上的具名選取遮罩，與圖層像素無關。選取表達式以 `region:<id>` 引用它們。

- **區域 ID**：符合 `^[A-Za-z0-9_.-]+$`。ID 重複回報 `MCPX_SEMANTIC_ERROR`。
- **屬性**：只有 `name = <文字>`（選填，不得含空白）。
- **`[mask]`**：恰好 `height` 列，每列恰好 `width` 格；`.` 表示區域外，`#` 表示區域內。

```text
[region handle]
name = sword_grip

[mask]
....
.##.
.##.
....
```

- 列長或列數不符回報 `INVALID_MASK_SIZE`；出現 `.`、`#` 以外的字元回報 `MCPX_SYNTAX_ERROR`。

---

## 5. 輕量 `.grid` 格式

`.grid` 檔是單圖層草稿：

```text
[palette]
. = transparent
R = #E74C3CFF
W = #FFFFFFFF

[grid]
.RR.
RWWR
.RR.
....
```

- 不需要 `mcpx 1` 檔頭，也沒有 `[canvas]`：寬度取自第一列，高度取自列數，每一列都必須一致（否則回報 `INVALID_GRID_SIZE`）。
- 恰好一個 `[palette]`，後接恰好一個 `[grid]` 或 `[grid tokens]`，除此之外不含其他內容。
- 像素會落在名為 `base` 的單一圖層。中繼資料、額外圖層與區域請改用 `.mcpx`。
- 上述調色盤與網格規則完全適用，錯誤回報的行號對應 `.grid` 檔本身。
- 以 `mc-asset render <file.grid>` 編譯（`--output` 輸出 PNG，`--source` 輸出 `.mcpx` 來源），或使用 MCP 工具 `render_pixel_asset`（`gridPath` 或 `gridText`）。

---

## 6. 完整範例

一份含區域遮罩的雙圖層 `.mcpx`，採正規格式：

```text
mcpx 1

[canvas]
width = 4
height = 4

[palette]
. = #00000000
B = #2C3E50FF role=outline
R = #E74C3CFF role=base
H = #EC7063FF role=highlight

[layer base]
visible = true
opacity = 1.000
name = sword_blade

[grid]
.BB.
BRRB
BRRB
.BB.

[layer shine]
visible = true
opacity = 0.500
name = specular

[grid]
....
.HH.
....
....

[region blade_tip]
name = tip_bounds

[mask]
.##.
####
....
....
```

---

## 7. 錯誤代碼

每個錯誤都帶有 `details.line`（從 1 起算），適用時另帶 `details.section`。

| 錯誤代碼 | 狀態碼 | 觸發條件 |
|---|---|---|
| `MCPX_SYNTAX_ERROR` | 2 | BOM 或 `\r`；缺少檔頭或版本號非整數；缺少 `[canvas]`；未知或順序錯誤的節區；圖層缺少 `[grid]` 或區域缺少 `[mask]`；鍵值行缺少 `=` 或不在任何節區內；網格／遮罩資料內出現註解或鍵值行；標記網格的 token 未以單一空格分隔；遮罩格不是 `.`／`#`。 |
| `MCPX_SCHEMA_ERROR` | 2 | 鍵名無效、重複或未知；`width`／`height` 格式錯誤或超出範圍；顏色無效；`.` 不是透明色，或透明色未使用 `.`；未知的角色或調色盤屬性；`visible`／`opacity` 無效；值或名稱含空白；ID 含 `[A-Za-z0-9_.-]` 以外的字元。 |
| `MCPX_SEMANTIC_ERROR` | 2 | 圖層或區域 ID 重複；網格符號未在 `[palette]` 定義。 |
| `INVALID_GRID_SIZE` | 2 | 網格列長與 `width` 不符，或列數與 `height` 不符。 |
| `INVALID_MASK_SIZE` | 2 | 遮罩列長與 `width` 不符，或列數與 `height` 不符。 |
| `MCPX_PALETTE_OVERFLOW` | 2 | 序列化時畫布顏色數超過網格寫法的容量（緊湊 63 色、標記 4096 色）。 |
| `MCPX_UNSUPPORTED_VERSION` | 5 | 檔頭的版本號是 `1` 以外的整數。 |
| `RESOURCE_LIMIT_EXCEEDED` | 5 | 圖層超過 64 個或區域超過 256 個，或畫布超出 512 MB 記憶體預算。 |

---

## 相關文件

- [CLI 介面](cli-surface.zh-TW.md)：讀寫 `.mcpx` 與 `.grid` 的指令（`render`、`build`、`import`、`transform`、`recolor`、`variant` 等）。
- [MCP 指南](mcp-guide.zh-TW.md)：搭配 `apply_asset_operations` 與 `build_asset` 使用 `.mcpx`，以及用 `render_pixel_asset` 撰寫 `.grid` 草稿。
- [MCP 介面](mcp-surface.zh-TW.md)：已凍結的 MCP 工具輸入與批次操作內容。
