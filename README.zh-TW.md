# mc-asset

[![CI](https://img.shields.io/github/actions/workflow/status/smile-minecraft/mc-asset/ci.yml?branch=main)](https://github.com/smile-minecraft/mc-asset/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/releases)
[![License](https://img.shields.io/github/license/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/mc-asset)](https://www.npmjs.com/package/mc-asset)

[English](https://github.com/smile-minecraft/mc-asset/blob/main/README.md) | [繁體中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-TW.md) | [简体中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-CN.md)

![mc-asset banner](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/banner.png)

專為 Minecraft Java Edition 資源包打造的像素原生（Pixel-native）2D 素材製作引擎、CLI 工具鏈與原生 MCP 伺服器，面向人類創作者與 AI Coding Agent。

`mc-asset` 解決了大型語言模型難以直接精確控制像素視覺內容的痛點。本工具提供確定性的圖元編輯、程序化紋理生成、無縫貼圖接縫分析與修復、動畫圖集打包、調色盤色彩量化與清理，以及完整的資源包相容性驗證。

---

## 核心特點

- **像素原生引擎（Pixel-Native Engine）**：無論是點陣圖（PNG/JPEG/WebP）或純文字規格（`.grid`/`.mcpx`），載入後均統一轉為記憶體內的 `PixelCanvas`，以整數坐標與明確的圖層/區域範圍進行處理。
- **嚴格確定性（Strict Determinism）**：消滅未給定種子的隨機狀態與浮點數進位誤差。在相同輸入與種子下，重複執行產出的 PNG 與 `.mcpx` 檔案位元組完全一致（Byte-identical），並保證 Bun 與 Node 跨執行環境一致。
- **Agent 友善設計（Agent-First Architecture）**：標準輸出（stdout）與診斷日誌（stderr）嚴格隔離。所有核心指令皆支援 `--json` 結構化信封格式，並具備統一的錯誤碼與狀態碼規範。
- **雙重介面（CLI 與原生 MCP）**：同一套 Core 引擎同時驅動 CLI 與標準 Model Context Protocol（MCP）伺服器，可直接串接 Claude Desktop、Cursor、OpenCode 等 AI 開發環境，無須透過外部行程包裝。
- **檔案系統安全防禦（Filesystem Safety）**：拒絕未明確宣告的隱式輸出檔名。所有寫入操作均採用同目錄暫存檔（`O_EXCL`）與原子替換（Atomic rename），並透過 Unicode NFC 與大小寫摺疊進行衝突偵測，徹底杜絕誤覆寫。

---

## 成果展示

以下圖片全部由 mc-asset 本身產出，程序化來源都使用固定 seed，整組可重現。對應指令見 [`docs/assets/showcase/README.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/assets/showcase/README.md)。

| 像素化（Pixelize） | 色彩量化（Quantize） |
|---|---|
| ![pixelize 前](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-before.png) → ![pixelize 後](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-after.png) | ![quantize 前](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-before.png) → ![quantize 後](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-after.png) |
| 高細節參考圖（128px，×2 顯示）縮到 16px（×16 顯示）：顆粒變粗，形狀收斂成整齊的像素格。 | 64 色漸層壓到 8 色（皆為 ×4 顯示）：顏色數變少，出現明顯的色階。 |

**材質變體**：同一份來源展開為四種材質階級（`iron`、`gold`、`wood`、`crystal`）；形狀不變，只換調色盤：

![variant iron](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variant-iron.png) ![variant gold](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variant-gold.png) ![variant wood](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variant-wood.png) ![variant crystal](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variant-crystal.png)

**無縫平鋪**：單一 32px 無縫磚（左，×4 顯示）與它的 2×2 重複（右，×4 顯示）；邊緣接得起來，看不到接縫：

![tile pattern](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-pattern.png) ![2x2 平鋪預覽](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-preview-2x2.png)

**動畫圖集**，由單張影格打包而成：

![動畫圖集](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/anim-sheet.png)

---

## 安裝指南

### 透過 npm 安裝（建議）

直接從 registry 執行伺服器，不必先在本機安裝：

```sh
npx -y mc-asset mcp
```

若要在 PATH 上取得 `mc-asset` 指令，可全域安裝 CLI：

```sh
npm install -g mc-asset
mc-asset --version
# 0.3.1
```

### 透過 Homebrew 安裝（macOS / Linux）

```sh
brew tap smile-minecraft/tap
brew install smile-minecraft/tap/mc-asset
mc-asset --version
# 0.3.1
```

### 透過原始碼安裝（Bun 或 Node.js）

```sh
git clone https://github.com/smile-minecraft/mc-asset.git
cd mc-asset
bun install --frozen-lockfile
bun run build
./bin/mc-asset.js --version
# 0.3.1
```

*系統需求*：已用 [Node.js](https://nodejs.org) 22 與 [Bun](https://bun.sh) 1.3 測試。`bun run build` 需要 Bun，`./bin/mc-asset.js` 需要 Node.js；只有 Bun 時，改執行 `bun ./bin/mc-asset.js`。

---

## 給 AI Agent

- [`llms.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms.txt)：給 Agent 的專案精簡索引。
- [`llms-full.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms-full.txt)：同一份資訊的單檔版本，涵蓋安裝、二十個 MCP 工具、批次操作、錯誤模型與限制。
- [`docs/mcp-guide.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-guide.md)：註冊方式、每個 MCP 工具一份原樣擷取，以及錯誤模型。
- [`docs/mcp-surface.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-surface.md)：已凍結的 MCP 介面——工具名稱、輸入與讀寫契約。
- [`AGENTS.md`](https://github.com/smile-minecraft/mc-asset/blob/main/AGENTS.md)：修改本專案時必須遵守的規則。

---

## 快速上手

### 1. 從 ASCII 網格到驗證通過的 Minecraft 材質

建立一個可由人類或 Agent 編輯的 16×16 純文字網格檔：

```sh
mkdir -p /tmp/mc-asset-demo
cat << 'EOF' > /tmp/mc-asset-demo/gem.grid
[palette]
. = transparent
R = #E74C3CFF
D = #C0392BFF
L = #F1948AFF
W = #FFFFFFFF

[grid]
................
......LLLL......
.....LRRRRD.....
....LRRRRRRD....
...LRRRWWRRRD...
...LRRWWWRRRD...
..LRRRWWWRRRRD..
..LRRRRRRRRRRD..
..LRRRRRRRRRRD..
..LRRRRRRRRRRD..
...DRRRRRRRRD...
...DRRRRRRRRD...
....DRRRRRRD....
.....DRRRRD.....
......DDDD......
................
EOF
```

將文字網格算繪為 PNG 材質，並同步儲存可重複編輯的 `.mcpx` 原始檔：

```sh
mc-asset render /tmp/mc-asset-demo/gem.grid \
  --output /tmp/mc-asset-demo/gem.png \
  --source /tmp/mc-asset-demo/gem.mcpx
# ok render profile=generic applied=0 output=/tmp/mc-asset-demo/gem.png source=/tmp/mc-asset-demo/gem.mcpx
```

分析色彩指標與透明度分布：

```sh
mc-asset analyze /tmp/mc-asset-demo/gem.png
# dimensions: 16x16
# colors: 5
# alpha: predicted cutout (opaque=124 transparent=132 partial=0)
# dominant: #00000000 x132 (0.5156), #E74C3CFF x84 (0.3281), #C0392BFF x20 (0.0781), #F1948AFF x12 (0.0469), #FFFFFFFF x8 (0.0313)
# profile: predicted profile generic has no Minecraft-specific restrictions.
# palette: colorCount=5 alphaLevels=2 transparent=132 partial=0
# pixel-art: 16x16 aspect=1:1 isolated=0 semiTransparent=0 tileFriendly=true
# recommended: quantize.colors=8 cleanup=none resize=nearest
```

驗證該素材是否符合 Minecraft 資源包規格：

```sh
mc-asset validate /tmp/mc-asset-demo/gem.png --profile minecraft:item
# verdict: pass
# dimensions: 16x16
# colors: 5
# alpha: predicted cutout (opaque=124 transparent=132 partial=0)
# profile: predicted profile minecraft:item prefers the items atlas without mipmaps.
```

---

## 常用操作實務

### 實務 1：參考圖像素化（`pixelize`）

將高解析度圖片降採樣為符合 Minecraft 風格的像素圖案，具備確定性的色彩縮減與輪廓處理：

```sh
mc-asset pixelize reference.png \
  --size 16 \
  --preset item \
  --profile minecraft:item \
  --output item_texture.png
```

- `--preset item`：套用 16 色調色盤限制，保留物品邊緣清晰度並清除多餘雜訊。
- 支援預設範本：`item`、`block`、`gui`、`particle`、`generic`。

### 實務 2：程序化材質生成與接縫處理（`generate` 與 `tile`）

生成程序化石材紋理，並進行平鋪接縫檢測：

```sh
# 使用內建的 stone 調色盤生成 16x16 雜訊紋理
mc-asset generate noise \
  --size 16 \
  --palette stone \
  --seed 42 \
  --output stone.png

# 量測水平、垂直與角落接縫的不連續程度
mc-asset tile stone.png
# ok tile profile=generic seam=h:0.065196 v:0.096051 c:0.003604 repeat=0.908038

# 自動修復接縫瑕疵並預覽 4x4 平鋪效果
mc-asset tile stone.png \
  --edge-match both \
  --preview 4x4 \
  --output stone_preview.png
```

### 實務 3：色彩量化與像素清理（`quantize` 與 `cleanup`）

清理外部修圖軟體產生的邊緣半透明雜訊與零星像素：

```sh
# 將色彩量化至 8 色
mc-asset quantize sprite.png --colors 8 --output quantized.png

# 移除孤立噪點與離群像素
mc-asset cleanup quantized.png \
  --fix isolated,noise \
  --allow-render-pass-change \
  --output clean.png
```

### 實務 4：材質階級衍生（`variant` 與 `recolor`）

將單一來源素材延伸為多種金屬/材質階級：

```sh
mc-asset variant sword.mcpx \
  --materials iron,copper,gold \
  --output-dir ./dist_variants \
  --mkdir
# 產出 sword_iron.png, sword_iron.mcpx, sword_copper.png, sword_gold.png 等
```

### 實務 5：動畫圖集打包（`animate`）

將各幀單獨的圖檔組裝成符合 Minecraft 規範的垂直連續圖集：

```sh
mc-asset animate pack \
  --frames-dir ./textures/fire_frames \
  --layout vertical \
  --output ./textures/fire.png

# 比對對應的 .mcmeta 檔案進行動畫規格驗證
mc-asset validate ./textures/fire.png --mcmeta ./textures/fire.png.mcmeta
```

### 實務 6：資源包完整性校驗（`validate-pack`）

掃描整個資源包目錄，檢查缺漏貼圖、無效命名空間、未註冊素材與模型 JSON 參照錯誤：

```sh
mc-asset validate-pack ./MyResourcePack \
  --minecraft-version 26.3 \
  --json
```

---

## MCP 伺服器整合（供 AI Agent 調用）

`mc-asset` 內建以標準輸入輸出（stdio）運作的 Model Context Protocol 伺服器。AI 代理可直接呼叫結構化工具操作核心引擎，無需透過子行程繁複解析 CLI 字串。

### 提供之 MCP 工具

| 工具名稱 | 功能說明 |
|---|---|
| `analyze_asset` | 唯讀分析：尺寸、調色盤分布、預測透明度類別、像素畫特徵啟發式指標。 |
| `pixelize_asset` | 將點陣圖（PNG/JPEG/WebP）降採樣為像素圖案，回傳 PNG 位元組或 `.mcpx` 原始碼。 |
| `render_pixel_asset` | 算繪內嵌 ASCII 網格或 `.grid` 檔案，支援套用批次修訂操作。 |
| `apply_asset_operations`| 對 `.mcpx` 原始碼進行原子批次像素/圖層/區域修訂。 |
| `recolor_asset` | 將材質套用至內建材質階梯（如 `iron`、`gold`、`stone` 等）。 |
| `create_variants` | 依多種材質將單一素材批量衍生至指定目錄中。 |
| `validate_asset` | 比對單一材質與 `.mcmeta` 是否符合 Minecraft 規範。 |
| `import_asset` | 將點陣圖輸入（PNG/JPEG/WebP）解碼至像素畫布，可選擇套用批次修訂操作。 |
| `build_asset` | 將 `.mcpx` 原始碼建置為 PNG 位元組或重新序列化的原始碼，可選擇套用批次修訂操作。 |
| `transform_asset` | 對點陣圖或 `.mcpx` 輸入套用單一幾何操作（flip、rotate、crop、pad、resize、translate）。 |
| `quantize_asset` | 將相異色彩數縮減至指定數量。 |
| `cleanup_asset` | 偵測或修復像素瑕疵（`isolated`、`noise`、`cluster`、`fringe`、`outlier`、`hole`、`aa`）。 |
| `palette_asset` | 唯讀調色盤 `extract`/`inspect` 報告（相異色彩、分布、角色、對比）。 |
| `material_asset` | 對內建材質集提供唯讀 `list`/`show` 報告。 |
| `tile_asset` | 接縫、邊緣重複與亮度分析，可選擇輸出平鋪預覽 PNG。 |
| `generate_asset` | 決定性程序化材質生成（pattern、size、palette、seed）。 |
| `preview_asset` | `ascii`/`palette-map` 報告，以及 `scale` 與 `nine-slice` 輔助 PNG。 |
| `animate_asset` | 對動畫幀組提供 `pack`/`unpack`/`reorder`/`resize`/`validate`/`preview`。 |
| `validate_pack_asset` | 唯讀整包掃描：命名空間、模型、材質、圖集、版本對應。 |

### 設定方式

#### Claude Desktop

在 `~/Library/Application Support/Claude/claude_desktop_config.json` 中加入：

```json
{
  "mcpServers": {
    "mc-asset": {
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

#### OpenCode

在 `opencode.json` 或 `opencode.jsonc` 中加入：

```jsonc
{
  "mcp": {
    "mc-asset": {
      "type": "local",
      "command": ["npx", "-y", "mc-asset", "mcp"],
      "enabled": true
    }
  }
}
```

#### Cursor

在您的 MCP 設定檔中加入：

```json
{
  "mcpServers": {
    "mc-asset": {
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

---

## CLI 指令一覽表

| 分類 | 指令 | 說明 |
|---|---|---|
| **來源輸入與建置** | `import <image>` | 解碼 PNG/JPEG/WebP 並寫入 PNG 或 `.mcpx`。 |
| | `render <grid>` | 將 ASCII 網格（`.grid`）編譯為 PNG 或 `.mcpx`。 |
| | `build [source]` | 編譯 `.mcpx` 原始檔或標準輸入（`--stdin`）為 PNG。 |
| **空間幾何變形** | `transform <input>` | 幾何操作：`--flip`、`--rotate`、`--crop`、`--pad`、`--resize`、`--translate`。 |
| **色彩與像素清理** | `quantize <input>` | 顏色縮減至指定數量（`--colors <N>`）。 |
| | `cleanup <input>` | 清理多餘雜訊像素（`--fix isolated,noise,outlier`）。 |
| | `palette extract` | 從圖中擷取調色盤。 |
| | `palette inspect` | 調色盤分布與明暗對比深入分析。 |
| | `material list` | 列出系統內建 Minecraft 材質。 |
| | `material show` | 檢視特定材質的色階定義。 |
| | `recolor <source>` | 依內建材質重新上色。 |
| | `variant <source>` | 衍生多材質變體至 `--output-dir`。 |
| **程序生成與平鋪** | `generate <pattern>` | 確定性程序化紋理生成（支援 `--seed <int>`）。 |
| | `tile <input>` | 接縫瑕疵檢測與自動無縫化修正。 |
| | `preview <input>` | 多模式預覽：`--ascii`、`--palette-map`、`--scale <N>`、`--nine-slice`。 |
| **動畫與圖集** | `animate pack` | 將各影格目錄打包為連續貼圖集。 |
| | `animate unpack` | 將動畫連續貼圖拆解為單格圖檔。 |
| | `animate reorder` | 重排影格播放順序。 |
| | `animate resize` | 批次縮放影格尺寸。 |
| | `animate validate`| 依 `.mcmeta` 檢查影格數與排版規格。 |
| | `animate preview` | 預覽動畫播放效果。 |
| **檢查與校驗** | `analyze <image>` | 唯讀結構與色彩數值報告。 |
| | `validate <asset>` | 單一檔案素材規範檢核（可附加 `.mcmeta`）。 |
| | `validate-pack <path>`| 資源包全目錄關聯與結構檢查。 |
| **Agent 介面** | `mcp` | 啟動 stdio MCP 伺服器。 |

---

## 批次像素修訂操作（`--operations`）

在 `import`、`render` 與 `build` 指令中，可透過 `--operations <path>` 或 `--operations -`（stdin）傳入批次像素操作：

```json
[
  { "type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF" },
  { "type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF" },
  { "type": "fillRect", "rect": { "x": 2, "y": 2, "width": 4, "height": 4 }, "color": "#FFFF00FF" },
  { "type": "floodFill", "x": 5, "y": 5, "color": "#0000FFFF" },
  { "type": "clearPixel", "x": 0, "y": 0 }
]
```

- **原子性保證**：全有或全無。批次中任一項操作失敗（例如坐標超出畫布），所有變更均會自動回滾（Rollback）。
- **顏色表示法**：支援 `transparent`、`#RRGGBB` 或 `#RRGGBBAA`。

---

## 系統架構與可靠性保證

```text
                  ┌─────────────────────────────────┐
                  │          mc-asset Core          │
                  │  PixelCanvas • IO • Algorithms  │
                  └───────────────┬─────────────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
     ┌───────────▼───────────┐         ┌───────────▼───────────┐
     │     CLI Interface     │         │   Native MCP Server   │
     │  (終端命令列與自動化)    │         │     (AI Agent 橋接)   │
     └───────────────────────┘         └───────────────────────┘
```

### 確定性保證機制

1. **位元組層級一致的 PNG 編碼**：採用固定的 deflate 壓縮等級與濾波策略（`src/io/png.ts`），搭配純整數顏色合成計算。檔案絕不包含系統時間戳記或主機環境中繼資料。
2. **種子約束的虛擬亂數生成器**：程序化紋理生成完全依賴整數 xorshift32 PRNG，並由 `--seed` 嚴格初始化。
3. **跨執行環境一致性**：在 Bun 與 Node.js 環境下執行時，產生的二進位位元組在 `scripts/compare-runtime.mjs` 比對矩陣所涵蓋的命令上，均能達成逐位元組（Byte-for-byte）完全吻合。

### 檔案系統與 I/O 通道安全

- **原子寫入**：寫入時先在目標目錄建立專屬暫存檔（`.tmp-<pid>-<counter>-<randomhex>-<原檔名>`），完成後以原子置換（Rename）提交，絕不殘留半寫入的壞檔。
- **路徑衝突防護**：路徑皆經過正規化、Unicode NFC 及大小寫摺疊比對。若輸出路徑與輸入別名衝突且未宣告 `--in-place`，或存在重複的目標路徑，系統會在寫入任何位元組前立即中斷。
- **通道分工隔離**：
  - 未使用 `--stdout` 時：人類可讀日誌輸出至 stdout。加上 `--json` 時，標準 JSON 信封輸出至 stdout，日誌則轉移至 stderr。
  - 使用 `--stdout` 時：產出的成品檔案二進位位元組獨佔 stdout，JSON 信封與日誌強制轉移至 stderr。

### 狀態碼對照表（Exit Codes）

| 代碼 | 類別 | 意義說明 |
|---|---|---|
| **0** | Success | 操作順利完成。 |
| **1** | Internal Error | 引擎未預期之內部例外（`INTERNAL_ERROR`）。 |
| **2** | Invalid Invocation | 語法錯誤、參數互斥、缺少必填引數（`INVALID_ARGUMENT`）。 |
| **3** | Validation Failure | 工具執行正常，但素材或資源包未通過 Minecraft 規格檢核（`VALIDATION_FAILED`）。 |
| **4** | Filesystem Error | 輸出檔案已存在且未宣告 `--force`，或目錄不存在且未宣告 `--mkdir`。 |
| **5** | Unsupported Format | 不支援的圖片格式或畫布尺寸超出系統限制。 |

---

## 開發者指令

```sh
# 執行完整測試套件
bun test

# 執行 TypeScript 型別檢查
bun run test:typecheck

# 執行程式碼檢查（Linter）
bun run lint

# 打包 Node 發行成品
bun run build

# 驗證 Bun 與 Node 跨執行環境二進位位元組一致性
node scripts/compare-runtime.mjs
```

---

## 授權條款

[MIT](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE) © 2026 Smile Minecraft Project
