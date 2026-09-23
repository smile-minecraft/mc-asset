# mc-asset

[![CI](https://img.shields.io/github/actions/workflow/status/smile-minecraft/mc-asset/ci.yml?branch=main)](https://github.com/smile-minecraft/mc-asset/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/releases)
[![License](https://img.shields.io/github/license/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/mc-asset)](https://www.npmjs.com/package/mc-asset)

[English](https://github.com/smile-minecraft/mc-asset/blob/main/README.md) | [繁體中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-TW.md) | [简体中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-CN.md)

![mc-asset banner](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/banner.png)

專為 Minecraft Java Edition 資源包打造的像素原生 2D 素材引擎與確定性 CLI／MCP 工具鏈，給人類創作者和 AI Coding Agent 使用。

語言模型沒辦法用眼睛擺像素，所以 `mc-asset` 把做貼圖這件事變成文字和指令：用字元網格畫圖、把參考圖像素化、生成可平鋪的紋理、打包動畫圖集、驗證整個資源包。這些都能在終端機裡做，也能透過 MCP 呼叫。相同的輸入和種子，永遠得到相同的位元組。

![劍、鎬、蘋果、藥水、藍寶石與鑰匙，每個都是原版風格的 16×16 像素圖](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/items.png)

*六個 16×16 物品，每個都寫成文字網格，再由 `mc-asset render` 算繪（×6 顯示），畫法依照 [`minecraft-pixel-art`](https://github.com/smile-minecraft/mc-asset/tree/main/skills/minecraft-pixel-art) skill 的原版風格規則。網格原始檔在 [`docs/assets/showcase/items/`](https://github.com/smile-minecraft/mc-asset/tree/main/docs/assets/showcase/items)。*

---

## 目錄

- [核心特點](#核心特點)
- [成果展示](#成果展示)
- [安裝指南](#安裝指南)
- [給 AI Agent](#給-ai-agent)
- [快速上手](#快速上手)
- [常用操作實務](#常用操作實務)
- [MCP 伺服器](#mcp-伺服器)
- [CLI 指令一覽表](#cli-指令一覽表)
- [批次像素修訂操作（`--operations`）](#批次像素修訂操作--operations)
- [系統架構與可靠性保證](#系統架構與可靠性保證)
- [開發者指令](#開發者指令)
- [授權條款](#授權條款)

---

## 核心特點

- **文字進，貼圖出。** 貼圖可以寫成字元網格（`.grid`）或可編輯的多圖層來源（`.mcpx`），再建置成 PNG。格式見 [`docs/mcpx-format.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcpx-format.zh-TW.md)。
- **位元組可重現。** 沒有未給種子的隨機，顏色合成只用整數，所以每次執行、以及 Bun 和 Node 之間，產出的 PNG 與 `.mcpx` 都完全相同。
- **一個引擎，兩種入口。** CLI 和 stdio MCP 伺服器呼叫同一個核心，Agent 拿到的結果和 shell 腳本完全一樣。
- **輸出可以直接解析。** `--json` 一律回傳 `{ success, result, error }` 信封並附上穩定的錯誤碼，日誌不會混進 stdout 的資料。
- **不會意外寫檔。** 輸出路徑都要明確指定，覆寫既有檔案要加 `--force`，每個檔案都先寫暫存檔再原子改名。

---

## 成果展示

以下圖片全部由 mc-asset 本身產出，程序化來源都使用固定 seed，整組可重現。對應指令見 [`docs/assets/showcase/README.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/assets/showcase/README.md)。

| 像素化（Pixelize） | 色彩量化（Quantize） |
|---|---|
| ![pixelize 前](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-before.png) → ![pixelize 後](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-after.png) | ![quantize 前](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-before.png) → ![quantize 後](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-after.png) |
| 高細節參考圖（128px，×2 顯示）縮到 16px（×16 顯示）：顆粒變粗，形狀收斂成整齊的像素格。 | 64 色漸層壓到 8 色（皆為 ×4 顯示）：顏色數變少，出現明顯的色階。 |

**材質變體**：把本頁開頭那把劍展開成全部七種內建材質（`copper`、`crystal`、`gold`、`iron`、`oxidized_copper`、`stone`、`wood`，×5 顯示）。它的調色盤替每個顏色標了角色，所以劍身和護手換上新色階，最深的外框、白色反光、木頭握柄和護手上的寶石維持原色：

![換成七種材質的劍](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variants.png)

**程序化紋理**：每種 `generate` 圖樣各一張 16px 樣本，使用固定 seed（×4 顯示）：

| `noise` | `clustered-noise` | `stripes` | `checker` | `gradient` |
|:-:|:-:|:-:|:-:|:-:|
| ![noise](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/noise.png) | ![clustered-noise](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/clustered-noise.png) | ![stripes](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/stripes.png) | ![checker](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/checker.png) | ![gradient](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/gradient.png) |
| `brick` | `spots` | `veins` | `cracks` | `grain` |
| ![brick](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/brick.png) | ![spots](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/spots.png) | ![veins](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/veins.png) | ![cracks](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/cracks.png) | ![grain](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/grain.png) |

**無縫平鋪**：一張 16px 的磚塊方塊貼圖（左，×8 顯示）與它鋪成的 4×4 牆面（右，×4 顯示）；灰縫在每條邊上都接得起來：

![平鋪來源](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-pattern.png) ![4x4 平鋪牆面](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-preview.png)

**動畫圖集**：發光礦石方塊的四張影格，打包成一條直向圖集（×4 顯示），也就是 Minecraft 搭配 `.mcmeta` 動畫讀取的排列方式：

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
```

### 透過 Homebrew 安裝（macOS / Linux）

```sh
brew tap smile-minecraft/tap
brew install smile-minecraft/tap/mc-asset
mc-asset --version
```

### 透過原始碼安裝（Bun 或 Node.js）

```sh
git clone https://github.com/smile-minecraft/mc-asset.git
cd mc-asset
bun install --frozen-lockfile
bun run build
./bin/mc-asset.js --version
```

*系統需求*：已用 [Node.js](https://nodejs.org) 22 與 [Bun](https://bun.sh) 1.3 測試。`bun run build` 需要 Bun，`./bin/mc-asset.js` 需要 Node.js；只有 Bun 時，改執行 `bun ./bin/mc-asset.js`。

---

## 給 AI Agent

- [`llms.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms.txt)：給 Agent 的專案精簡索引。
- [`llms-full.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms-full.txt)：同一份資訊的單檔版本，涵蓋安裝、二十一個 MCP 工具、批次操作、錯誤模型與限制。
- [`docs/cli-surface.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/cli-surface.zh-TW.md)：已凍結的 CLI 指令、批次操作規格與狀態碼註冊表。
- [`docs/mcpx-format.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcpx-format.zh-TW.md)：可編輯的多圖層 `.mcpx` 與 `.grid` 格式語法與規範。
- [`docs/mcp-guide.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-guide.zh-TW.md)：註冊方式、每個 MCP 工具一份原樣擷取，以及錯誤模型。
- [`docs/mcp-surface.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-surface.zh-TW.md)：已凍結的 MCP 介面——工具名稱、輸入與讀寫契約。
- [`AGENTS.md`](https://github.com/smile-minecraft/mc-asset/blob/main/AGENTS.md)：修改本專案時必須遵守的規則。

### Agent Skills

本專案在 [`skills/`](https://github.com/smile-minecraft/mc-asset/tree/main/skills) 附上兩個 [Agent Skill](https://skills.sh/)，可以用 skills CLI 安裝：

```sh
npx skills add smile-minecraft/mc-asset
```

- [`mc-asset`](https://github.com/smile-minecraft/mc-asset/tree/main/skills/mc-asset)：用這套工具畫圖的流程（撰寫 → 算繪 → 預覽 → 量測 → 驗證）、CLI 與 MCP 的指令對照，以及調色盤角色如何決定換色結果。
- [`minecraft-pixel-art`](https://github.com/smile-minecraft/mc-asset/tree/main/skills/minecraft-pixel-art)：物品、方塊、GUI 與動畫的原版風格規則，包括調色盤與色相偏移色階、依材質上色的外框、左上光源、平鋪，以及一份常見錯誤的審查清單。

只想裝其中一個時，加上 `--skill mc-asset` 或 `--skill minecraft-pixel-art`。

---

## 快速上手

### 從文字網格到驗證通過的貼圖

用字元網格畫一顆 16×16 的寶石，一個字元就是一個像素：

```sh
mkdir -p /tmp/mc-asset-demo
cat << 'EOF' > /tmp/mc-asset-demo/gem.grid
[palette]
. = transparent
o = #0E1846FF
s = #1E3A8CFF
D = #2448A8FF
m = #3569D0FF
l = #5A92EEFF
t = #7FB2F6FF
T = #A9D2FFFF
W = #FFFFFFFF

[grid]
................
................
......sssss.....
.....sTTTTTo....
....sTTWWTTto...
...sTTWWTTttto..
..slllTTTtttmmo.
..slllllmmmmmDo.
..slllllmmmmmDo.
..slllllmmmmDDo.
...olllmmmmDDo..
....ollmmmDDo...
.....olmmmDo....
......ommDo.....
.......ooo......
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

算繪出來的 `gem.png`（×8 顯示）：

![算繪出的寶石](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quickstart-gem.png)

檢查它的顏色和透明度：

```sh
mc-asset analyze /tmp/mc-asset-demo/gem.png
# dimensions: 16x16
# colors: 9
# alpha: predicted cutout (opaque=119 transparent=137 partial=0)
# dominant: #00000000 x137 (0.5352), #3569D0FF x28 (0.1094), #5A92EEFF x24 (0.0938), #0E1846FF x18 (0.0703), #A9D2FFFF x16 (0.0625), #1E3A8CFF x12 (0.0469), #2448A8FF x10 (0.0391), #7FB2F6FF x7 (0.0273)
# profile: predicted profile generic has no Minecraft-specific restrictions.
# palette: colorCount=9 alphaLevels=2 transparent=137 partial=0
# pixel-art: 16x16 aspect=1:1 isolated=0 semiTransparent=0 tileFriendly=true
# recommended: quantize.colors=16 cleanup=none resize=nearest
```

以 Minecraft 物品貼圖的規格驗證它：

```sh
mc-asset validate /tmp/mc-asset-demo/gem.png --profile minecraft:item
# verdict: pass
# dimensions: 16x16
# colors: 9
# alpha: predicted cutout (opaque=119 transparent=137 partial=0)
# profile: predicted profile minecraft:item prefers the items atlas without mipmaps.
```

---

## 常用操作實務

### 實務 1：參考圖像素化（`pixelize`）

把高解析度參考圖轉成 16×16 的物品貼圖。同一張圖、同一個預設，永遠得到同樣的像素：

```sh
mc-asset pixelize reference.png \
  --size 16 \
  --preset item \
  --profile minecraft:item \
  --output item_texture.png
```

- `--preset item` 設定 16 色上限，並啟用裁切、背景、主體、邊緣與色塊（cluster）階段。
- 其他預設：`block`、`gui`、`particle`、`generic`。

### 實務 2：程序化材質生成與接縫處理（`generate` 與 `tile`）

用固定種子生成石材紋理，再檢查它能不能無縫平鋪：

```sh
mc-asset generate noise \
  --size 16 \
  --palette stone \
  --seed 42 \
  --output stone.png

# 接縫分數：水平、垂直、角落（越低越平順）
mc-asset tile stone.png
# ok tile profile=generic seam=h:0.065196 v:0.096051 c:0.003604 repeat=0.908038

# 對齊相對兩邊的邊緣像素，並預覽 4x4 平鋪
mc-asset tile stone.png \
  --edge-match both \
  --preview 4x4 \
  --output stone_preview.png
```

### 實務 3：色彩量化與像素清理（`quantize` 與 `cleanup`）

把貼圖減到 8 色，再清掉減色後留下的零星像素：

```sh
mc-asset quantize sprite.png --colors 8 --output quantized.png

mc-asset cleanup quantized.png \
  --fix isolated,noise \
  --allow-render-pass-change \
  --output clean.png
```

這兩類修正可能改變透明度，連帶改變貼圖需要的渲染階段（render pass），所以沒加 `--allow-render-pass-change` 時 `cleanup` 會拒絕執行。

### 實務 4：材質階級衍生（`variant` 與 `recolor`）

把一份來源展開成多種材質，或整份改成單一材質：

```sh
mc-asset variant sword.mcpx \
  --materials iron,copper,gold \
  --output-dir ./dist_variants \
  --mkdir
# 產出 sword_iron.png、sword_iron.mcpx、sword_copper.png 等

mc-asset recolor sword.mcpx --material gold --output sword_gold.png
```

### 實務 5：動畫圖集打包（`animate`）

把一整個資料夾的影格打包成垂直圖集，再對照它的 `.mcmeta` 檢查：

```sh
mc-asset animate pack \
  --frames-dir ./textures/fire_frames \
  --layout vertical \
  --output ./textures/fire.png

mc-asset validate ./textures/fire.png --mcmeta ./textures/fire.png.mcmeta
```

### 實務 6：資源包完整性校驗（`validate-pack`）

掃描整個資源包：缺少的貼圖、錯誤的命名空間、沒被引用的貼圖、損壞的模型參照，以及循環參照。`--minecraft-version` 決定要對照哪一版的資源包格式：

```sh
mc-asset validate-pack ./MyResourcePack \
  --minecraft-version 26.3 \
  --json
```

### 實務 7：批次編輯與視覺回饋（`build` 與 `apply_asset_operations`）

用一批操作修改快速上手做出的寶石：畫一個 4×4 的金色方塊，外面框一圈 6×6 的黑邊。CLI 套用整批操作後輸出 PNG：

```sh
cat << 'EOF' > /tmp/mc-asset-demo/ops.json
[
  { "type": "fillRect", "rect": { "x": 6, "y": 6, "width": 4, "height": 4 }, "color": "#FFD700FF" },
  { "type": "drawRect", "rect": { "x": 5, "y": 5, "width": 6, "height": 6 }, "color": "#000000FF" }
]
EOF

mc-asset build /tmp/mc-asset-demo/gem.mcpx \
  --operations /tmp/mc-asset-demo/ops.json \
  --output /tmp/mc-asset-demo/gem_modified.png
# ok build profile=generic applied=2 output=/tmp/mc-asset-demo/gem_modified.png
```

套用這批操作前後（皆為 ×8 顯示）：

![套用前的寶石](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quickstart-gem.png) → ![套用後的寶石](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/batch-edit-gem.png)

透過 MCP，`apply_asset_operations` 會跑同一批操作，還能把改動的部分畫給你看：

```json
{
  "sourcePath": "/tmp/mc-asset-demo/gem.mcpx",
  "operations": [
    { "type": "fillRect", "rect": { "x": 6, "y": 6, "width": 4, "height": 4 }, "color": "#FFD700FF" },
    { "type": "drawRect", "rect": { "x": 5, "y": 5, "width": 6, "height": 6 }, "color": "#000000FF" }
  ],
  "outputPngPath": "/tmp/mc-asset-demo/gem_feedback.png",
  "feedback": { "image": "changed", "scale": 8, "diff": "summary" }
}
```

帶上 `feedback` 後，結果維持原有欄位，另外附上一個 PNG 圖片區塊（裁切到改動範圍，依 `scale` 放大 1–16 倍），以及 `diff` 摘要（`raw`、`composited`、`structural`、`outsideSelectionUnchanged`）。編輯若沒有造成可見變化，會回傳 `noVisibleChange` 而不附圖片。Agent 不必取回整張畫布就能看到自己改了什麼。輸出路徑和 CLI 那次不同，因為 MCP 工具從不覆寫既有檔案。

### 實務 8：GUI 九宮格縮放（`gui-scale`）

放大 GUI 外框而不糊掉邊框。使用 `nine_slice` 時，四個角 1:1 複製，邊與中央以平鋪填滿（設 `stretch_inner: true` 則改為拉伸）。16×16 的 `dialog.png` 在 `dialog.png.mcmeta` 宣告 4px 邊框：

```json
{ "gui": { "scaling": { "type": "nine_slice", "width": 16, "height": 16, "border": 4 } } }
```

```sh
mc-asset gui-scale ./textures/gui/dialog.png \
  --mcmeta ./textures/gui/dialog.png.mcmeta \
  --size 48x32 \
  --output ./textures/gui/dialog_large.png
# ok gui-scale profile=generic size=48x32 scaling=nine_slice output=./textures/gui/dialog_large.png
```

`gui-scale` 不會自己去找同名的 `.mcmeta`；沒給 `--mcmeta` 時會把整張圖直接拉伸。

| 原圖 16×16 | `nine_slice`，48×32 | 不給 `--mcmeta`（拉伸），48×32 |
|:-:|:-:|:-:|
| ![dialog 原圖](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/dialog.png) | ![九宮格結果](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/nine-slice.png) | ![拉伸結果](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/stretch.png) |

三張皆為 ×4 顯示。有 mcmeta 時，切角和 2px 斜面 1:1 複製，寬度不變；直接拉伸則會讓斜面粗細不一，切角也糊掉。

---

## MCP 伺服器

`mc-asset mcp` 會啟動一個 stdio MCP 伺服器，底層和 CLI 是同一個核心，所以呼叫工具和執行對應指令會得到相同結果。它提供 21 個工具。

### 提供的 MCP 工具

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
| `scale_gui_asset` | 依 mcmeta 的 stretch/tile/nine_slice 規則縮放 GUI 貼圖；只輸出 PNG。 |
| `quantize_asset` | 將相異色彩數縮減至指定數量。 |
| `cleanup_asset` | 偵測或修復像素瑕疵（`isolated`、`noise`、`cluster`、`fringe`、`outlier`、`hole`、`aa`）。 |
| `palette_asset` | 唯讀調色盤 `extract`/`inspect` 報告（相異色彩、分布、角色、對比）。 |
| `material_asset` | 對內建材質集提供唯讀 `list`/`show` 報告。 |
| `tile_asset` | 接縫、邊緣重複與亮度分析，可選擇輸出平鋪預覽 PNG。 |
| `generate_asset` | 決定性程序化材質生成（pattern、size、palette、seed）。 |
| `preview_asset` | `ascii`/`palette-map` 報告，以及 `scale` 與 `nine-slice` 輔助 PNG。 |
| `animate_asset` | 對動畫幀組提供 `pack`/`unpack`/`reorder`/`resize`/`validate`/`preview`。 |
| `validate_pack_asset` | 唯讀整包掃描：命名空間、模型、材質、圖集、版本對應。 |
| `inspect_asset` | 唯讀 `structure`（圖層、區域、色彩用量、重疊）或 `view`（合成 PNG 圖塊加 metadata）；輸入為 `inputPath`。 |

`inspect_asset` 有兩種模式：`structure` 回報圖層、區域、色彩用量與重疊；`view` 把合成後的畫布以 PNG 圖片區塊回傳，可選 `crop` 與 `scale`（1–16）。邊長超過 1024px 的 view 會被拒絕並提示改用裁切，不會自動縮小。`apply_asset_operations` 可以帶選填的 `feedback` 物件（見[實務 7](#實務-7批次編輯與視覺回饋build-與-apply_asset_operations)）；不帶時結果完全不變。[`docs/mcp-guide.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-guide.zh-TW.md) 為每個工具附上一次實際呼叫的擷取。

### 設定方式

每個用戶端執行的都是同一個 stdio 指令：`npx -y mc-asset mcp`。各用戶端的設定檔位置可能隨版本改變，找不到時請查該用戶端的文件。

#### Claude Code

```sh
claude mcp add mc-asset -- npx -y mc-asset mcp
```

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

#### Cursor

在 `.cursor/mcp.json` 中加入：

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
| | `gui-scale <input>` | 依 mcmeta stretch/tile/nine_slice 規則縮放 GUI 貼圖至 `--size <N\|WxH>`。 |
| **動畫與圖集** | `animate pack` | 將各影格目錄打包為連續貼圖集。 |
| | `animate unpack` | 將動畫連續貼圖拆解為單格圖檔。 |
| | `animate reorder` | 重排影格播放順序。 |
| | `animate resize` | 批次縮放影格尺寸。 |
| | `animate validate`| 依 `.mcmeta` 檢查影格數與排版規格。 |
| | `animate preview` | 預覽動畫播放效果。 |
| **檢查與校驗** | `analyze <image>` | 唯讀結構與色彩數值報告。 |
| | `inspect <input>` | 唯讀結構報告或合成檢視（`--mode structure\|view`、`--crop`、`--scale`）。 |
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

- **原子性保證**：全有或全無。批次中任一項操作失敗（例如座標超出畫布），所有變更均會自動回滾（Rollback）。
- **顏色表示法**：支援 `transparent`、`#RRGGBB` 或 `#RRGGBBAA`。
- **操作種類**：共 25 種，除了 9 個像素操作（`setPixel`、`clearPixel`、`drawLine`、`drawRect`、`fillRect`、`floodFill`、`ellipse`、`polygonFill`、`strokeMask`），還有圖層、區域、`stampRect` 與 `regionFromSelection`。完整參數表見 [`docs/cli-surface.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/cli-surface.zh-TW.md)。
- **精簡繪圖形狀**：`ellipse` 吃 `rect` 加 `color` 加 `mode`（`fill`／`outline`）；`polygonFill` 吃整數 `[x, y]` 的 `points` 加 `color`，最多 4096 點，不收自交、不收孔洞；`strokeMask` 吃 `layerId` 加 `source` 選取加 `color`，另可拿 `selection` 當寫入裁剪。4097 點會在座標映射前以 `RESOURCE_LIMIT_EXCEEDED` 退回；自交環會以 `SELF_INTERSECTING_POLYGON` 退回。
- **選取範圍**：像素操作可帶選填的 `selection`；選到空集合會以 `EMPTY_SELECTION` 拒絕寫入並整批回滾。

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
| **4** | Filesystem Error | 輸出檔案已存在且未加 `--force`、目錄不存在且未加 `--mkdir`，或無法讀取輸入檔。 |
| **5** | Unsupported / Limit | 不支援的檔案類型，或超出尺寸與資源上限。 |

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

# 檢查文件連結、錨點與多餘的版本號
bun run check:docs
```

---

## 授權條款

[MIT](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE) © 2026 Smile Minecraft Project
