# mc-asset

[![CI](https://img.shields.io/github/actions/workflow/status/smile-minecraft/mc-asset/ci.yml?branch=main)](https://github.com/smile-minecraft/mc-asset/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/releases)
[![License](https://img.shields.io/github/license/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/mc-asset)](https://www.npmjs.com/package/mc-asset)

[English](https://github.com/smile-minecraft/mc-asset/blob/main/README.md) | [繁體中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-TW.md) | [简体中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-CN.md)

![mc-asset banner](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/banner.png)

`mc-asset` 是 Minecraft Java 版資源包的貼圖工具，提供命令列（CLI）和 MCP 兩種用法，創作者和 AI 助手都能直接使用。

語言模型沒辦法用眼睛擺像素，所以 `mc-asset` 把做貼圖這件事變成文字和指令：用字元網格畫圖、把參考圖縮成像素風、產生可平鋪的紋理、打包動畫圖集、預覽方塊模型、檢查整個資源包。這些都能在終端機裡做，也能透過 MCP 呼叫。相同的輸入和種子，產生的檔案內容完全相同。

![劍、鎬、蘋果、藥水、藍寶石與鑰匙，每個都是原版風格的 16×16 像素圖](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/items.png)

*六個 16×16 物品，每個都寫成文字網格，再由 `mc-asset render` 繪製（×6 顯示），畫法依照 [`minecraft-pixel-art`](https://github.com/smile-minecraft/mc-asset/tree/main/skills/minecraft-pixel-art) skill 的原版風格規則。網格原始檔在 [`docs/assets/showcase/items/`](https://github.com/smile-minecraft/mc-asset/tree/main/docs/assets/showcase/items)。*

---

## 目錄

- [功能一覽](#功能一覽)
- [核心特點](#核心特點)
- [成果展示](#成果展示)
- [安裝指南](#安裝指南)
- [給 AI 助手](#給-ai-助手)
- [快速上手](#快速上手)
- [常用操作實務](#常用操作實務)
- [MCP 伺服器](#mcp-伺服器)
- [CLI 指令一覽表](#cli-指令一覽表)
- [批次像素修改（`--operations`）](#批次像素修改--operations)
- [系統架構與可靠性保證](#系統架構與可靠性保證)
- [開發者指令](#開發者指令)
- [授權條款](#授權條款)

---

## 功能一覽

- 用文字網格畫貼圖（`render`）
- 把參考圖縮成像素風（`pixelize`）、減少顏色（`quantize`）
- 一鍵換材質變體（`variant`）
- 產生可平鋪的紋理（`generate`、`tile`）
- 打包動畫圖集、產生 `.mcmeta`（`animate`、`mcmeta`）
- 介面貼圖縮放（`gui-scale`）
- 比對兩張圖的差異（`compare`）
- 檢查單張貼圖或整個資源包（`validate`、`validate-pack`）
- 無損壓縮 PNG（`optimize`）
- 建立、檢查、預覽 Java 方塊模型（`model`）
- 依宣告式配方製作完整資源包、稽核風格、盤點原版素材與匯出可重現 zip（`pack`、`style`）
- 以 MCP 伺服器提供給 AI 助手使用（`mcp`）

---

## 核心特點

- **文字進，貼圖出。** 貼圖可以寫成字元網格（`.grid`）或可編輯的多圖層原始檔（`.mcpx`），再轉成 PNG。格式見 [`docs/mcpx-format.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcpx-format.zh-TW.md)。
- **輸出完全一致。** 不使用未指定種子的隨機數，顏色合成只用整數運算，因此每次執行、以及在 Bun 和 Node 之間，產出的 PNG 與 `.mcpx` 內容都完全相同。
- **一個核心，兩種用法。** CLI 和 stdio MCP 伺服器共用同一個核心，AI 助手拿到的結果和 shell 腳本完全一樣。
- **統一的回傳格式。** `--json` 一律回傳 `{ success, result, error }` 與固定的錯誤碼，日誌不會混進 stdout 的資料。
- **不會意外改檔。** 輸出路徑都要明確指定，覆寫既有檔案要加 `--force`；每個檔案都先寫入暫存檔，完成後再改成正式檔名。

---

## 成果展示

以下圖片全部由 `mc-asset` 本身產出，程式生成的紋理都使用固定種子，整組皆可重現。對應指令見 [`docs/assets/showcase/README.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/assets/showcase/README.md)。

| 像素化（Pixelize） | 減少顏色（Quantize） |
|---|---|
| ![pixelize 前](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-before.png) → ![pixelize 後](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-after.png) | ![quantize 前](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-before.png) → ![quantize 後](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-after.png) |
| 高細節參考圖（128px，×2 顯示）縮到 16px（×16 顯示）：顆粒變粗，形狀收斂成整齊的像素格。 | 64 色漸層壓到 8 色（皆為 ×4 顯示）：顏色數變少，出現清楚的色階。 |

**材質變體**：把本頁開頭那把劍展開成全部七種內建材質（`copper`、`crystal`、`gold`、`iron`、`oxidized_copper`、`stone`、`wood`，×5 顯示）。調色盤替每個顏色標了角色，所以劍身和護手換上新色階，最深的外框、白色反光、木頭握柄和護手上的寶石維持原色：

![換成七種材質的劍](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variants.png)

**程式生成的紋理**：每種 `generate` 圖樣各一張 16px 樣本，使用固定種子（×4 顯示）：

| `noise` | `clustered-noise` | `stripes` | `checker` | `gradient` |
|:-:|:-:|:-:|:-:|:-:|
| ![noise](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/noise.png) | ![clustered-noise](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/clustered-noise.png) | ![stripes](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/stripes.png) | ![checker](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/checker.png) | ![gradient](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/gradient.png) |
| `brick` | `spots` | `veins` | `cracks` | `grain` |
| ![brick](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/brick.png) | ![spots](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/spots.png) | ![veins](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/veins.png) | ![cracks](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/cracks.png) | ![grain](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/grain.png) |

**無縫平鋪**：一張 16px 的磚塊方塊貼圖（左，×8 顯示）與它鋪成的 4×4 牆面（右，×4 顯示）；磚縫在每條邊上都接得起來：

![平鋪來源](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-pattern.png) ![4x4 平鋪牆面](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-preview.png)

**方塊貼圖**：石頭、泥土、橡木木板三張 16×16 貼圖（×8 顯示），四邊都能無縫銜接。右邊是木板鋪成的 4×4 牆面（×4 顯示）：

![三張方塊貼圖](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/blocks.png) ![4x4 木板牆面](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/blocks-wall.png)

**動畫圖集**：發光礦石方塊的四張影格，打包成一條直向圖集（×4 顯示），也就是 Minecraft 搭配 `.mcmeta` 動畫讀取的排列方式：

![動畫圖集](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/anim-sheet.png)

**藥水變體與比對**：把藥水換成 `crystal`、`gold`、`iron` 三種材質（×5 顯示），玻璃瓶身維持原色、只有瓶內藥水跟著換色。用 `compare` 比對鐵與金版本，找出瓶內 72 個變動的藥水像素，在診斷圖上以洋紅色標出（×8 顯示）：

![換成三種材質的藥水](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/potion-variants.png) ![兩個藥水變體的比對診斷圖](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/compare-diff.png)

**按鈕九宮格**：一張 16px 的按鈕外框（左，×4 顯示），放大到 48×16 的九宮格結果（中，×4 顯示）與直接拉伸的結果（右，×4 顯示）；九宮格的角落和斜面保持俐落，直接拉伸則會糊掉：

![按鈕原圖](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/button.png) ![按鈕九宮格結果](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/button-nine-slice.png) ![按鈕拉伸結果](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/button-stretch.png)

**Java 模型三視圖預覽**：由五個長方體組成的階梯祭壇方塊模型（[`model-shrine.json`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/assets/showcase/model-shrine.json)），使用上方展示過的磚塊、木板、石頭和發光礦石貼圖。透過 `mc-asset model preview --size 128` 從三個方向各看一次：正面（北，`front`）、側面（東，`right`）、上方（`top`）：

![Java 方塊模型的三視圖預覽](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/model-preview.png)

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

## 給 AI 助手

- [`llms.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms.txt)：給 AI 助手的專案精簡索引。
- [`llms-full.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms-full.txt)：同一份資訊的單檔版本，涵蓋安裝、27 個 MCP 工具、批次操作、錯誤模型與限制。
- [`docs/cli-surface.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/cli-surface.zh-TW.md)：已凍結的 CLI 指令、批次操作規格與狀態碼對照表。
- [`docs/mcpx-format.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcpx-format.zh-TW.md)：可編輯的多圖層 `.mcpx` 與 `.grid` 格式語法與規範。
- [`docs/mcp-guide.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-guide.zh-TW.md)：註冊方式、每個 MCP 工具的實際呼叫紀錄，以及錯誤模型。
- [`docs/mcp-surface.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-surface.zh-TW.md)：已凍結的 MCP 介面——工具名稱、輸入參數與讀寫規則。
- [`AGENTS.md`](https://github.com/smile-minecraft/mc-asset/blob/main/AGENTS.md)：修改本專案時必須遵守的規則。

### Agent Skills

本專案在 [`skills/`](https://github.com/smile-minecraft/mc-asset/tree/main/skills) 附上兩個給 AI 助手使用的 [Agent Skill](https://skills.sh/)，可以用 skills CLI 安裝：

```sh
npx skills add smile-minecraft/mc-asset
```

- [`mc-asset`](https://github.com/smile-minecraft/mc-asset/tree/main/skills/mc-asset)：用這套工具畫圖的流程（撰寫 → 繪製 → 預覽 → 量測 → 驗證）、CLI 與 MCP 的指令對照，以及調色盤角色如何決定換色結果。
- [`minecraft-pixel-art`](https://github.com/smile-minecraft/mc-asset/tree/main/skills/minecraft-pixel-art)：物品、方塊、GUI 與動畫的原版風格規則，包括調色盤與色相偏移色階、依材質上色的外框、左上光源、平鋪，以及一份常見錯誤的檢查清單。

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

把文字網格轉成 PNG 貼圖，並同時存一份可重複編輯的 `.mcpx` 原始檔：

```sh
mc-asset render /tmp/mc-asset-demo/gem.grid \
  --output /tmp/mc-asset-demo/gem.png \
  --source /tmp/mc-asset-demo/gem.mcpx
# ok render profile=generic applied=0 output=/tmp/mc-asset-demo/gem.png source=/tmp/mc-asset-demo/gem.mcpx
```

繪製出來的 `gem.png`（×8 顯示）：

![繪製出的寶石](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quickstart-gem.png)

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

### 實務 1：把參考圖縮成像素風（`pixelize`）

把高解析度參考圖轉成 16×16 的物品貼圖。同一張圖、同一個預設，永遠得到同樣的像素：

```sh
mc-asset pixelize reference.png \
  --size 16 \
  --preset item \
  --profile minecraft:item \
  --output item_texture.png
```

- `--preset item` 設定 16 色上限，並啟用裁切、去背、主體、邊緣與色塊整理階段。
- 其他預設：`block`、`gui`、`particle`、`generic`。

### 實務 2：生成紋理與無縫平鋪（`generate` 與 `tile`）

用固定種子產生石材紋理，再檢查它能不能無縫平鋪：

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

### 實務 3：減少顏色與清理雜訊（`quantize` 與 `cleanup`）

把貼圖減到 8 色，再清掉減色後留下的零星像素：

```sh
mc-asset quantize sprite.png --colors 8 --output quantized.png

mc-asset cleanup quantized.png \
  --fix isolated,noise \
  --allow-render-pass-change \
  --output clean.png
```

這兩類修正可能改變透明度，連帶改變貼圖需要的渲染階段（render pass），所以沒加 `--allow-render-pass-change` 時 `cleanup` 會拒絕執行。

### 實務 4：換材質變體（`variant` 與 `recolor`）

把一份原始檔展開成多種材質，或整份改成單一材質。輸入可以是可編輯的 `.mcpx`，也可以是一般 PNG（PNG 沒有調色盤角色資訊，像素會按整數明度分段對應，不會憑空猜測圖層角色）：

```sh
mc-asset variant sword.mcpx \
  --materials iron,copper,gold \
  --output-dir ./dist_variants \
  --mkdir
# 產出 sword_iron.png、sword_iron.mcpx、sword_copper.png 等

mc-asset recolor sword.mcpx --material gold --output sword_gold.png
```

### 實務 5：動畫圖集打包（`animate`）

把一整個資料夾的影格打包成直向圖集，再對照它的 `.mcmeta` 檢查：

```sh
mc-asset animate pack \
  --frames-dir ./textures/fire_frames \
  --layout vertical \
  --output ./textures/fire.png

mc-asset validate ./textures/fire.png --mcmeta ./textures/fire.png.mcmeta
```

### 實務 6：檢查整個資源包（`validate-pack`）

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

透過 MCP，`apply_asset_operations` 會跑同一批操作，還能把改動的部分畫出來回傳：

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

帶上 `feedback` 後，回傳結果除了原本的欄位，還會多一個 PNG 圖片區塊（裁切到改動範圍，依 `scale` 放大 1–16 倍），以及 `diff` 摘要（`raw`、`composited`、`structural`、`outsideSelectionUnchanged`）。若編輯沒有造成可見變化，則回傳 `noVisibleChange` 而不附圖片。AI 助手不必取回整張畫布就能看到自己改了什麼。這裡的輸出路徑和 CLI 不同，是因為 MCP 工具不會覆寫既有檔案。

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

### 實務 9：無損壓縮 PNG 與 Java 方塊模型（`optimize` 與 `model`）

`optimize` 把 PNG 重新編碼成像素完全相同但檔案最小的結果；若沒有更小的編碼，就保留原檔。可傳入明確的 PNG 路徑清單（最多 256 檔）或整個目錄（`--input-dir`，最多 4096 檔，可加 `--recursive` 保留相對目錄結構）。它不會改寫輸入檔，輸出方式從 `--output`、`--output-dir`、`--stdout`、`--dry-run` 擇一。

```sh
mc-asset optimize ./gem.png --dry-run
# ok optimize input=./gem.png output=- status=optimized source=184 result=102 mode=rgba
mc-asset optimize ./gem.png ./sword.png --output-dir ./optimized --mkdir
mc-asset optimize --input-dir ./textures --recursive --output-dir ./optimized --mkdir
```

`model` 用來處理 Java 方塊與物品模型 JSON（支援長方體 `elements`）。建立模型、用型別化操作修改，再對資源包檢查：

```sh
mc-asset model create --spec ./docs/assets/showcase/model-shrine.json \
  --output ./pack/assets/mypack/models/block/shrine.json --mkdir --resource-pack-version 75
mc-asset model validate ./pack/assets/mypack/models/block/shrine.json \
  --pack ./pack --resource-pack-version 75
mc-asset validate-pack ./pack --resource-pack-version 75
```

`model apply` 接收 `--operations`，整批套用成功或全部不套用；`model export` 會輸出模型檔，加上 `--binding` 時還會在對應路徑一併寫出物品定義與 blockstate。檢查範圍是 JSON 結構與貼圖參照是否有效，不會啟動 Minecraft 用戶端，因此不涵蓋遊戲內的實際打光與動態行為。

`model preview` 從長方體 `elements` 繪製固定的診斷圖：三個正方形面板橫向排列（`front` 是北面、`right` 是東面、`top` 是頂面且北方朝上），每個面板邊長為 `--size`（64、128 或 256，預設 64）：

```sh
mc-asset model preview ./pack/assets/mypack/models/block/shrine.json \
  --pack ./pack --size 128 --output ./shrine-preview.png --resource-pack-version 75
```

![Java 方塊模型的三視圖預覽](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/model-preview.png)

`--output` 與 `--stdout` 必須二選一。報告包含面板名稱與座標、輸入範圍、`coverage` 與 `warnings`。找不到貼圖時會畫成固定棋盤格並發出警告；元素旋轉、非 1/256 座標、半透明面與無法解析的貼圖會列為 `partial`。`display` 變換與遊戲內光照不會套用，這張圖是結構診斷視圖，不是遊戲畫面。

---

## MCP 伺服器

`mc-asset mcp` 會啟動一個 stdio MCP 伺服器，底層和 CLI 共用同一個核心，因此 AI 助手呼叫工具和在終端機執行指令會得到相同結果。伺服器共提供 27 個工具。

### 提供的 MCP 工具

| 工具名稱 | 功能說明 |
|---|---|
| `analyze_asset` | 唯讀分析：尺寸、調色盤分布、透明度分類與像素畫指標。 |
| `pixelize_asset` | 把點陣圖（PNG/JPEG/WebP）縮成像素風，回傳 PNG 或 `.mcpx` 原始檔。 |
| `render_pixel_asset` | 繪製內嵌 ASCII 網格或 `.grid` 檔案，可同時套用批次修改。 |
| `apply_asset_operations`| 對 `.mcpx` 原始檔整批修改像素、圖層與區域。 |
| `recolor_asset` | 將貼圖換成內建材質色階（如 `iron`、`gold`、`stone` 等）。 |
| `create_variants` | 將單一素材一次展開成多種材質變體並寫入目錄。 |
| `validate_asset` | 檢查單張貼圖與 `.mcmeta` 是否符合 Minecraft 規範。 |
| `import_asset` | 將點陣圖（PNG/JPEG/WebP）讀入像素畫布，可同時套用批次修改。 |
| `build_asset` | 將 `.mcpx` 原始檔轉成 PNG 或重新序列化的 `.mcpx`，可同時套用批次修改。 |
| `transform_asset` | 對點陣圖或 `.mcpx` 套用單一幾何操作（flip、rotate、crop、pad、resize、translate）。 |
| `scale_gui_asset` | 依 mcmeta 的 stretch/tile/nine_slice 規則縮放 GUI 貼圖，輸出 PNG。 |
| `quantize_asset` | 將顏色數減到指定數量或對齊指定調色盤，並可保留指定的 RGBA 顏色。 |
| `cleanup_asset` | 偵測或清除像素瑕疵（`isolated`、`noise`、`cluster`、`fringe`、`outlier`、`hole`、`aa`）。 |
| `palette_asset` | 唯讀調色盤 `extract`/`inspect` 報告（顏色清單、分布、角色、明暗對比）。 |
| `material_asset` | 唯讀列出（`list`）或檢視（`show`）內建材質色階。 |
| `tile_asset` | 接縫、邊緣重複與亮度分析，可選擇輸出平鋪預覽 PNG。 |
| `generate_asset` | 用固定種子產生程式生成的紋理（pattern、size、palette、seed）。 |
| `preview_asset` | `ascii`/`palette-map` 文字報告，以及 `scale` 與 `nine-slice` 輔助預覽 PNG。 |
| `mcmeta_asset` | 依 PNG 尺寸產生動畫或 GUI 縮放設定。 |
| `animate_asset` | 對動畫影格組執行 `pack`、`unpack`、`reorder`、`resize`、`validate`、`preview`。 |
| `validate_pack_asset` | 唯讀掃描整個資源包：命名空間、模型、貼圖、圖集與目標版本。 |
| `inspect_asset` | 唯讀 `structure`（圖層、區域、顏色用量、重疊）或 `view`（合成 PNG 圖塊加摘要資訊）；輸入為 `inputPath`。 |
| `optimize_asset` | 無損壓縮 PNG（若無更小編碼則保留原檔）；支援單檔、多檔、目錄掃描（`inputDir`、`recursive`，上限 4096 檔）與 `dryRun`。 |
| `model_asset` | Java 方塊／物品模型 JSON：`inspect`、`validate`、`create`、`apply`、`export`（含物品定義與 blockstate），以及 `preview`（產生三視圖診斷 PNG）。 |
| `compare_assets` | 比對兩張同尺寸 PNG；回報原始 RGBA 與可見差異像素數、差異範圍框，並可輸出診斷標記圖。 |
| `style_asset` | 風格預設、自訂風格撰寫、調色盤匯出、風格檢查與家族稽核。 |
| `pack_asset` | 資源包專案管理：建立骨架（`init`）、配方批次建置（`build`）、貼圖盤點（`catalog`）、素材抽出（`extract`）、排序修正清單（`check`）與可重現 zip 打包（`package`）。 |

`inspect_asset` 有兩種模式：`structure` 回報圖層、區域、顏色用量與重疊；`view` 把合成後的畫布以 PNG 圖片區塊回傳，可選 `crop` 與 `scale`（1–16）。邊長超過 1024px 的 view 會被拒絕並提示改用裁切，不會自動縮小。`apply_asset_operations` 可以帶選填的 `feedback` 物件（見[實務 7](#實務-7批次編輯與視覺回饋build-與-apply_asset_operations)）；不帶時結果完全不變。[`docs/mcp-guide.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-guide.zh-TW.md) 收錄了每個工具實際呼叫的輸入與回傳範例。

### 設定方式

每個用戶端執行的都是同一個 stdio 指令：`npx -y mc-asset mcp`。各用戶端的設定檔位置可能隨版本調整，找不到時請查閱該用戶端的文件。

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
| **來源輸入與建置** | `import <image>` | 讀取 PNG/JPEG/WebP 並轉成 PNG 或 `.mcpx`。 |
| | `render <grid>` | 將字元網格（`.grid`）繪製成 PNG 或 `.mcpx`。 |
| | `build [source]` | 將 `.mcpx` 原始檔或標準輸入（`--stdin`）轉成 PNG。 |
| **幾何變形** | `transform <input>` | 幾何操作：`--flip`、`--rotate`、`--crop`、`--pad`、`--resize`、`--translate`。 |
| **色彩與清理** | `quantize <input>` | 把顏色減到指定數量（`--colors <N>`）或對齊調色盤（`--palette`），可用 `--keep-color` 保留指定色。 |
| | `cleanup <input>` | 清除孤立與雜訊像素（`--fix isolated,noise,outlier`）。 |
| | `palette extract` | 從圖片擷取調色盤。 |
| | `palette inspect` | 分析調色盤分布、角色與明暗對比。 |
| | `material list` | 列出內建的 Minecraft 材質。 |
| | `material show` | 檢視特定材質的色階定義。 |
| | `recolor <source>` | 依內建材質重新上色。 |
| | `variant <source>` | 一次衍生多種材質變體到 `--output-dir`。 |
| **紋理生成與平鋪** | `generate <pattern>` | 用固定種子（`--seed <int>`）產生程式生成的紋理。 |
| | `tile <input>` | 檢查接縫分數與自動修補邊緣。 |
| | `preview <input>` | 多模式預覽：`--ascii`、`--palette-map`、`--scale <N>`、`--nine-slice`。 |
| | `gui-scale <input>` | 依 mcmeta stretch/tile/nine_slice 規則把 GUI 貼圖縮放到 `--size <N\|WxH>`。 |
| **動畫與圖集** | `animate pack` | 將影格資料夾打包成動畫圖集。 |
| | `animate unpack` | 將動畫圖集拆成單張影格。 |
| | `animate reorder` | 調整影格播放順序。 |
| | `animate resize` | 批次縮放影格尺寸。 |
| | `animate validate`| 對照 `.mcmeta` 檢查影格數與排列方式。 |
| | `animate preview` | 預覽動畫序列。 |
| | `mcmeta animation\|gui` | 依 PNG 尺寸產生 `.mcmeta` 動畫或 GUI 縮放設定（`--output`、`--stdout`）。 |
| **檢查與比對** | `analyze <image>` | 唯讀分析尺寸、顏色分布與透明度。 |
| | `inspect <input>` | 唯讀結構報告或合成檢視（`--mode structure\|view`、`--crop`、`--scale`）。 |
| | `validate <asset>` | 檢查單張貼圖與 `.mcmeta` 是否合規。 |
| | `validate-pack <path>`| 檢查整個資源包目錄的參照與結構。 |
| | `compare <before> <after>` | 比對兩張同尺寸 PNG；回報原始 RGBA 與可見差異像素數，並可輸出診斷 PNG（`--output`、`--stdout`、`--scale`）。 |
| **壓縮與模型** | `optimize <input...>` 或 `--input-dir <dir>` | 無損壓縮 PNG（若無更小編碼則保留原檔；支援 `--output`、`--output-dir`、`--stdout`、`--dry-run`、`--mode`、`--ancillary`、`--recursive`）。 |
| | `model inspect\|validate <file>` | 唯讀檢查 Java 方塊／物品模型 JSON（結構、UV、旋轉、display、貼圖參照）。 |
| | `model create\|apply\|export` | 建立、修改或匯出 Java 模型（長方體 `elements`）及其物品定義與 blockstate。 |
| | `model preview <file>` | 繪製三視圖診斷 PNG（`front`、`right`、`top` 面板，`--size 64\|128\|256`，`--output` 或 `--stdout`）。 |
| **AI 助手介面** | `mcp` | 啟動 stdio MCP 伺服器。 |

### 產生動畫與 GUI 設定（`mcmeta`）

從 PNG 產生動畫或 GUI 縮放設定：

```sh
mc-asset mcmeta animation sheet.png --frame-size 16 --frametime 2 --frames '[0,{"index":1,"time":4},0]' --minecraft-version 1.21.2 --output sheet.png.mcmeta
mc-asset mcmeta gui panel.png --type nine_slice --border 4 --stretch-inner --resource-pack-version 42 --stdout
```

- **動畫（`animation`）**
  - 必填：`--frame-size <N|WxH>`。影格只支援單排或單列，且尺寸必須整除 PNG（不接受網格排列）。
  - 選填：`--frametime <int>`（預設 `1`）、`--frames <json>`（接受整數索引或 `{index,time}` 物件；省略時依序播放全部影格，時間須為正整數且索引不得越界）、`--interpolate`（啟用補間插值）。
- **GUI（`gui`）**
  - 必填：`--type <stretch|tile|nine_slice>`。`tile` 與 `nine_slice` 以 PNG 尺寸為設計尺寸；選 `nine_slice` 時還必須指定 `--border <N|json>`（`left`、`top`、`right`、`bottom` 為非負整數，中央區域須保留正面積）。
  - 選填：`--stretch-inner`（僅 `nine_slice` 可用）。
- **輸出與版本檢查**
  - 輸出必須從 `--output <path.mcmeta>` 與 `--stdout` 二選一；覆寫既有檔案需加 `--force`（會替換整個檔案），建立父目錄需加 `--mkdir`。
  - `--minecraft-version` 與 `--resource-pack-version` 二選一：GUI 縮放需要 pack format `16.0`、`stretch_inner` 需要 `42.0`，版本不符時回報 `ARGUMENT_CONFLICT`。未指定版本或超出 `12.0`–`97.1` 會回報 `versionChecked: false`（`VERSION_NOT_CHECKED`），但仍會檢查 GUI 最低版本限制（參考：[Texture animation](https://minecraft.wiki/w/Resource_pack#Texture_animation)、[GUI scaling](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w31a)、[Pack format](https://minecraft.wiki/w/Pack_format)）。

### 比對 PNG 差異（`compare`）

```sh
mc-asset compare before.png after.png --json
mc-asset compare before.png after.png --output diff.png --scale 4
mc-asset compare before.png after.png --stdout --json > diff.png
```

比對兩張同尺寸的 PNG（尺寸不同會回報 `INVALID_ARGUMENT`）。不加 `--output` 或 `--stdout` 時只回傳報告、不寫檔；加上 `--output <path.png>` 或 `--stdout`（兩者二選一）時會輸出診斷標記圖，用洋紅色（`255,0,255,255`）標示可見差異、青色（`0,255,255,255`）標示透明像素下隱藏的 RGB 差異，未變動的像素則保持透明（`0,0,0,0`）。`--scale`（`1`–`16`，預設 `1`）可用最近鄰放大標記圖，放大後長邊若超過 1024px 會回報 `RESOURCE_LIMIT_EXCEEDED`。

報告包含 `width`、`height`、`totalPixels`、`rawChangedPixels`、`visibleChangedPixels`、`rawBounds` 與 `visibleBounds`（從 0 起算的 `{x,y,width,height}`，無差異時為 `null`）。兩個來源檔都不會被改寫；覆寫既有目標需加 `--force`，建立父目錄需加 `--mkdir`。

---

## 批次像素修改（`--operations`）

在 `import`、`render` 與 `build` 指令中，可透過 `--operations <path>` 或 `--operations -`（stdin）傳入批次修改操作：

```json
[
  { "type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF" },
  { "type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF" },
  { "type": "fillRect", "rect": { "x": 2, "y": 2, "width": 4, "height": 4 }, "color": "#FFFF00FF" },
  { "type": "floodFill", "x": 5, "y": 5, "color": "#0000FFFF" },
  { "type": "clearPixel", "x": 0, "y": 0 }
]
```

- **整批成功或整批復原**：批次中只要有任何一項操作失敗（例如座標超出畫布），整批修改都會復原，不會留下改一半的結果。
- **顏色寫法**：支援 `transparent`、`#RRGGBB` 或 `#RRGGBBAA`。
- **操作種類**：共 25 種，包含 9 個像素操作（`setPixel`、`clearPixel`、`drawLine`、`drawRect`、`fillRect`、`floodFill`、`ellipse`、`polygonFill`、`strokeMask`），以及圖層、區域、`stampRect` 與 `regionFromSelection`。完整參數表見 [`docs/cli-surface.zh-TW.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/cli-surface.zh-TW.md)。
- **幾何繪圖**：`ellipse` 接受 `rect`、`color` 與 `mode`（`fill`／`outline`）；`polygonFill` 接受整數 `[x, y]` 的 `points` 與 `color`（最多 4096 點，超過回報 `RESOURCE_LIMIT_EXCEEDED`；不支援自交與鏤空，自交多邊形回報 `SELF_INTERSECTING_POLYGON`）；`strokeMask` 接受 `layerId`、`source` 選取範圍與 `color`，也可搭配 `selection` 限制寫入範圍。
- **選取範圍**：像素操作可帶選填的 `selection`；若選取結果為空集合，會以 `EMPTY_SELECTION` 拒絕寫入並復原整批操作。

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
     │  (終端命令列與自動化)    │         │    (AI 助手橋接介面)   │
     └───────────────────────┘         └───────────────────────┘
```

### 為什麼每次執行結果都一樣

1. **固定的 PNG 編碼**：使用固定的 deflate 壓縮參數與濾波策略（`src/io/png.ts`），顏色合成全部使用整數運算，且檔案內不寫入系統時間戳記或主機資訊。
2. **固定種子的亂數**：程式生成的紋理全部使用整數 `xorshift32` 亂數產生器，由 `--seed` 初始化。
3. **Bun 與 Node 輸出一致**：在 Bun 與 Node.js 下執行時，`scripts/compare-runtime.mjs` 測試涵蓋的所有指令都會產出內容完全相同的檔案。

### 檔案寫入與輸出通道安全

- **安全寫檔**：寫入時會先在目標目錄建立暫存檔（`.tmp-<pid>-<counter>-<randomhex>-<原檔名>`），寫完後再改成正式檔名，中途失敗也不會留下損壞的半成品。
- **防止誤蓋來源檔**：所有路徑都會先展開並統一大小寫與 Unicode NFC 格式。若輸出路徑指到輸入檔本身（且未加 `--in-place`），或同時指定了重複的輸出路徑，會在寫入任何資料前直接中止。
- **stdout 與 stderr 分流**：
  - 未加 `--stdout` 時：一般訊息輸出到 stdout；加上 `--json` 時，JSON 結果輸出到 stdout，一般訊息改送到 stderr。
  - 加上 `--stdout` 時：產出的二進位檔案內容獨佔 stdout，JSON 結果與一般訊息都送到 stderr。

### 狀態碼對照表（Exit Codes）

| 代碼 | 類別 | 說明 |
|---|---|---|
| **0** | Success | 操作順利完成。 |
| **1** | Internal Error | 未預期的內部錯誤（`INTERNAL_ERROR`）。 |
| **2** | Invalid Invocation | 語法錯誤、選項衝突或缺少必填參數（`INVALID_ARGUMENT`）。 |
| **3** | Validation Failure | 工具執行成功，但貼圖或資源包未通過 Minecraft 規範檢查（`VALIDATION_FAILED`）。 |
| **4** | Filesystem Error | 輸出檔案已存在且未加 `--force`、目錄不存在且未加 `--mkdir`，或無法讀取輸入檔。 |
| **5** | Unsupported / Limit | 不支援的檔案格式，或超過尺寸與資源上限。 |

---

## 開發者指令

```sh
# 執行完整測試套件
bun test

# 執行 TypeScript 型別檢查
bun run test:typecheck

# 執行程式碼檢查（Linter）
bun run lint

# 打包 Node 發行檔案
bun run build

# 檢查 Bun 與 Node 產出的檔案內容是否完全一致
node scripts/compare-runtime.mjs

# 檢查文件連結、錨點與多餘的版本號
bun run check:docs
```

---

## 授權條款

[MIT](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE) © 2026 Smile Minecraft Project
