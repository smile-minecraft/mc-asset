# mc-asset Minecraft Asset Creation Engine 規格書 v0.3

> 本文件是產品規格書，描述定位、範圍與對外行為。
>
> 技術細節與規範條文以 `project-detail.md` 為準；兩者衝突時以技術規格書為準（見該文件 §1.2）。
>
> 版本路線圖的唯一來源是 `project-detail.md` §84–§90，本文件 §52 起僅作摘要。

## 1. 專案定位

`mc-asset` 是一套面向 Minecraft Java Edition 資源包製作的 2D Asset Creation Engine 與 CLI 工具。

主要使用者包括 Coding Agent、LLM Agent、自動化腳本，以及需要精確處理 Minecraft 視覺素材的資源包作者。

`mc-asset` 的主要責任是處理 Agent 單靠文字難以可靠完成的視覺素材工作，包括：

```text
像素圖建立
逐像素編輯
參考圖片像素化
調色盤處理
材質轉換
圖片清理
無縫材質處理
素材變體生成
動畫圖集處理
圖片分析
圖片驗證
```

`mc-asset` 不以完整 Resource Pack Generator 為目標。

Minecraft 中大量 JSON、文字與設定內容，例如：

```text
models/*.json
items/*.json
blockstates/*.json
lang/*.json
particles/*.json
equipment/*.json
*.png.mcmeta
```

原則上由 Agent 自行建立。

`mc-asset` 最多提供相關檔案的結構、引用與素材完整性驗證。

---

# 2. 核心產品定義

`mc-asset` 是：

**Agent-controllable Pixel Asset Creation Engine for Minecraft**

它不是單純的圖片縮放工具，也不是生成式圖片模型的包裝器。

Agent 負責：

```text
設計意圖
構圖決策
素材風格
像素修改決策
資源包 JSON
檔案組織
輸出位置
```

`mc-asset` 負責：

```text
Pixel Canvas
Image Processing
Pixel Rendering
Palette
Material
Transformation
Analysis
Validation
```

---

# 3. CLI First

`mc-asset` 採用 CLI First 架構。

所有核心功能都必須先透過 CLI 完整提供。

例如：

```bash
mc-asset pixelize ./reference.png \
  --profile minecraft:item \
  --size 16 \
  --output ./textures/sword.png
```

MCP Server 屬於後續額外提供的 Agent-native 介面。

架構應為：

```text
                 mc-asset Core
                /             \
              CLI              MCP
             /   \              |
          Human  Agent         Agent
```

CLI 與 MCP 共用同一套 Core API。

MCP 不建立第二套圖片處理實作。

MCP 正式版本不應透過 `spawn` CLI command 來完成核心操作，而應直接呼叫 Core。

---

# 4. Agent First

CLI 雖然可以由人直接使用，但主要設計對象包含 Agent。

因此所有核心 command 必須具備：

```text
穩定參數
可預測行為
結構化輸出
明確錯誤
可重現結果
批次操作能力
```

主要命令應支援：

```bash
--json
```

讓 Agent 能取得 machine-readable result。

---

# 5. Deterministic First

第一階段不得依賴：

```text
Diffusion Model
Image Generation Model
Multimodal Image Generator
其他不可穩定重現的生成式圖片系統
```

相同：

```text
input
parameters
seed
mc-asset version
```

應盡可能得到相同結果。

程序生成工具必須支援 seed。

---

# 6. Pixel-native

Pixel 是整套系統最基本的資料單位。

素材不論來自：

```text
Agent 手動畫
ASCII Pixel Grid
圖片像素化
PNG
JPG
WebP
程序生成
已有 Minecraft Texture
```

進入編輯流程後，都統一轉換成：

```text
Pixel Canvas
```

後續工具只操作 Pixel Canvas。

---

# 7. 檔案位置控制原則

所有檔案的存放位置都由使用者或呼叫端決定。

`mc-asset` 不得自行假設專案結構，也不得預設建立：

```text
./output
./generated
./assets
./textures
./mc-asset-cache
```

等輸出目錄。

例如：

```bash
mc-asset pixelize ./reference.png \
  --output ./my-pack/assets/example/textures/item/sword.png
```

輸出位置完全由呼叫端指定。

如果使用者已指定路徑，Agent 必須遵從使用者指定。

如果使用者沒有指定實際路徑，Agent 可依自身工作流程決定呼叫時所使用的位置，但該位置必須顯式傳入 `mc-asset`。

`mc-asset` 本身不得猜測。

---

# 8. 無預設輸出檔案原則

可能建立檔案的 command 原則上必須明確指定：

```bash
--output <path>
```

或：

```bash
--stdout
```

例如：

```bash
mc-asset pixelize reference.png
```

不應自動建立：

```text
reference_pixelized.png
```

比較合理的行為是回報：

```text
OUTPUT_REQUIRED
```

並要求呼叫端提供：

```bash
--output
```

或：

```bash
--stdout
```

此設計避免 Agent 在工作目錄中建立大量未知檔案。

---

# 9. mcpx 為可選格式

`.mcpx` 是 `mc-asset` 提供的可編輯 Pixel Asset Source Format。

但 `.mcpx` 不是強制中間格式。

以下流程完全合法：

```text
reference.png
↓
Pixel Canvas
↓
pixelize
↓
cleanup
↓
sword.png
```

整個過程可以完全不建立 `.mcpx`。

Agent 也可以選擇：

```text
reference.png
↓
Pixel Canvas
↓
pixelize
↓
sword.mcpx
↓
後續修改
↓
sword.png
```

或者：

```text
ASCII / Pixel Spec
↓
Pixel Canvas
↓
sword.png
```

因此 `.mcpx` 是：

```text
optional editable source format
```

而不是：

```text
mandatory intermediate format
```

---

# 10. Agent 對 mcpx 的使用決策

當使用者沒有指定輸出格式時，Agent 可以根據工作需求自行決定是否建立 `.mcpx`。

適合直接輸出 PNG 的情況：

```text
一次性素材
簡單圖片轉換
不預期後續修改
不需要 Layer
不需要 Region
不需要保存語意
```

適合保存 `.mcpx` 的情況：

```text
預期反覆修改
需要逐像素編輯
需要保存 Layer
需要保存 Region
需要建立大量 Variant
需要長期維護 source asset
```

如果使用者明確指定：

```text
只要 PNG
不要中間檔
保存 mcpx
```

則 Agent 必須遵守。

---

# 11. 系統架構

```text
Input
│
├── PNG
├── JPG
├── WebP
├── mcpx
├── ASCII Grid
├── Pixel Spec
└── stdin
│
▼
Pixel Canvas Core
│
├── Canvas
├── Pixel
├── Layer
├── Region
├── Palette
├── Selection
└── Metadata
│
▼
Processing Engines
│
├── Pixelizer
├── Quantizer
├── Cleanup
├── Transform
├── Tile
├── Recolor
├── Variant
├── Procedural
└── Animation
│
▼
Optional Presets
│
├── item
├── block
├── gui
├── particle
└── generic
│
▼
Output
│
├── PNG
├── mcpx
├── stdout
├── preview
└── report
```

---

# 12. 第一階段素材範圍

初期主要支援：

```text
Block Texture
Item Texture
GUI / UI Texture
Particle Texture
Generic Pixel Image
Animated Texture Sheet
Painting / Flat Image
Pack Icon
```

後續保留：

```text
Entity UV Texture
Equipment UV Texture
Bitmap Font / Glyph Atlas
Colormap
Armor Trim Palette
Skin / Player Texture
```

---

# 13. Pixel Canvas Core

Pixel Canvas 是所有圖片處理功能共用的記憶體資料模型。

核心概念：

```text
Canvas
├── width
├── height
├── background
├── layers
├── regions
├── palette
└── metadata
```

Pixel Canvas 本身不依賴 `.mcpx`。

例如：

```text
PNG
↓
decode
↓
Pixel Canvas
```

可以直接進行所有操作。

---

# 14. Pixel

Core 使用 RGBA 8-bit：

```text
R 0–255
G 0–255
B 0–255
A 0–255
```

Core 不限制 Alpha 只能：

```text
0
255
```

Minecraft-specific limitation 由：

```text
Preset
Validator
```

決定。

---

# 15. 座標系統

所有 API 統一使用：

```text
左上角 = (0,0)
x 向右增加
y 向下增加
```

例如：

```text
(0,0) ─────────→ x
  │
  │
  │
  ▼
  y
```

Rect API 統一使用：

```text
x
y
width
height
```

避免使用容易產生 inclusive / exclusive 歧義的：

```text
x1
y1
x2
y2
```

---

# 16. Pixel Canvas API

V1 Pixel Canvas API 應支援：

```text
Canvas lifecycle
Pixel read/write
Layer lifecycle
Region lifecycle
Palette access
Selection
Basic primitives
Transform
Batch Operations
Transaction
Import
Export
```

Pixelizer、Tile、Cleanup、Recolor 等屬於上層 Engine，不直接屬於 Canvas API。

---

# 17. Pixel Authoring

Agent 必須具備逐像素生成圖片的能力。

但不要求 Agent 每一個 pixel 都執行一次 CLI。

支援三種主要方式。

## 17.1 Single Pixel

例如：

```bash
mc-asset pixel set source.mcpx 7 4 "#FFFFFFFF" \
  --output edited.mcpx
```

原地修改必須顯式要求：

```bash
mc-asset pixel set source.mcpx 7 4 "#FFFFFFFF" \
  --in-place
```

沒有 `--output` / `--stdout` / `--in-place` 時回報 `OUTPUT_REQUIRED`，不得直接改寫輸入檔。

主要適合：

```text
debug
少量修正
人類操作
```

---

# 18. Batch Pixel Operation

Agent 可以一次提交大量操作。

例如：

```json
{
  "operations": [
    {
      "id": "blade-tip",
      "type": "pixel",
      "x": 7,
      "y": 2,
      "color": "#FFFFFFFF"
    },
    {
      "id": "blade",
      "type": "line",
      "from": [7, 3],
      "to": [11, 8],
      "color": "#ADB7C0FF"
    },
    {
      "id": "guard",
      "type": "fillRect",
      "x": 4,
      "y": 10,
      "width": 8,
      "height": 2,
      "color": "#25282BFF"
    }
  ]
}
```

Batch operation 應具備 transaction semantics：

```text
全部成功
→ commit

任一 operation 失敗
→ rollback
```

---

# 19. ASCII Pixel Grid

Agent 可以直接使用文字表示整張 Pixel Art。

例如：

```text
................
.......H........
.......SS.......
......SSD.......
......SSD.......
.....SSD........
.....SSD........
....SSD.........
....SSD.........
...SSD..........
..OOOOOOO.......
.....WW.........
.....WW.........
.....WW.........
.....OO.........
................
```

Palette：

```text
. = transparent
O = #25282BFF
D = #707A84FF
S = #ADB7C0FF
H = #E1E7EAFF
W = #6F4730FF
```

這是主要 Agent-friendly pixel authoring 方式。

---

# 20. mcpx Source Format

`.mcpx` 是 UTF-8 純文字格式。

目標是：

```text
Agent 可讀
Agent 可改
Human 可讀
Git 可 diff
容易版本控制
```

V1 建議結構：

```text
mcpx 1

[canvas]
width = 16
height = 16

[metadata]
type = item
name = sword

[palette]
. = transparent
O = #25282BFF role=outline
D = #707A84FF role=shadow
S = #ADB7C0FF role=base
H = #E1E7EAFF role=highlight
W = #6F4730FF role=wood

[layer base]
visible = true
opacity = 1

[grid]
................
.......H........
.......SS.......
......
```

---

# 21. mcpx 不保存檔案位置

`.mcpx` 不應包含：

```text
outputPath
projectPath
resourcePackPath
defaultExportDirectory
```

素材存放位置屬於：

```text
filesystem
CLI caller
Agent
User
```

的責任。

`.mcpx` 只描述 Asset 本身。

---

# 22. mcpx Canonical Data

`.mcpx` 保存目前 Pixel Canvas 的最終狀態。

它不以完整 Operation History 作為 source of truth。

也就是不採：

```text
draw line
draw rect
erase
move
rotate
```

重新 replay 才能還原圖片的模式。

而是直接保存最後：

```text
Pixel State
```

因此 `.mcpx` → build 的結果不會因繪圖演算法版本改變而產生不必要差異。

---

# 23. Palette

Palette 是一級資料結構。

除了 color，可選擇保存語意 role：

```text
outline
shadow
dark
base
light
highlight
accent
```

例如：

```text
D = #707A84FF role=shadow
S = #ADB7C0FF role=base
H = #E1E7EAFF role=highlight
```

這有利於 Recolor Engine。

---

# 24. Layer

Layer 用於描述畫面組成。

例如：

```text
outline
base
highlight
details
```

V1 至少支援：

```text
visible
opacity
normal blend
```

暫不追求完整 Photoshop blend mode。

---

# 25. Region

Region 描述素材語意。

例如：

```text
blade
guard
handle
gem
```

Region 與 Layer 是兩個不同概念。

例如某 Pixel 可以同時屬於：

```text
Layer = highlight
Region = blade
```

Region 應以 Pixel Mask 表示，而不是依照 Palette Color 推測。

---

# 26. Region Mask

例如（以下為節錄，實際檔案的 mask 必須寫滿 canvas 高度）：

```text
[region blade]

[mask]
.......#........
.......##.......
......###.......
......###.......
.....###........
.....###........
....###.........
................
```

其中：

```text
# = member
. = not member
```

這可以支援：

```bash
mc-asset recolor sword.mcpx \
  --region blade \
  --material copper
```

---

# 27. Basic Drawing Primitives

Pixel Canvas 應提供：

```text
pixel
line
rectangle
filled rectangle
ellipse
filled ellipse
polygon
fill
flood fill
selection
copy
paste
move
mirror
rotate
scale
```

所有 primitive 都必須：

```text
integer-grid aware
```

不得產生非整數 pixel coordinate。

---

# 28. Reference Image Pixelization

主要 command：

```bash
mc-asset pixelize reference.png \
  --output sword.png
```

處理流程：

```text
Decode
↓
Crop
↓
Background Handling
↓
Subject Handling
↓
Resize
↓
Edge Preservation
↓
Palette Quantization
↓
Pixel Clustering
↓
Cleanup
↓
Preset Rules
↓
Output
```

支援：

```text
16×16
32×32
64×64
128×128
custom
```

---

# 29. Pixelization Output

Pixelization 不要求建立 `.mcpx`。

直接 PNG：

```bash
mc-asset pixelize reference.png \
  --profile minecraft:item \
  --size 16 \
  --output ./sword.png
```

保存 editable source：

```bash
mc-asset pixelize reference.png \
  --profile minecraft:item \
  --size 16 \
  --source ./sword.mcpx \
  --output ./sword.png
```

只保存 editable source：

```bash
mc-asset pixelize reference.png \
  --profile minecraft:item \
  --size 16 \
  --source ./sword.mcpx
```

具體 CLI 參數名稱在 CLI Design 階段凍結（見 `project-detail.md` §104），但行為必須支援這三種模式。

---

# 30. Pixelization Presets

## Item

重點：

```text
silhouette
transparent background
edge readability
low noise
limited local palette
```

## Block

重點：

```text
texture distribution
tileability
uniform lighting
cluster quality
low seam visibility
```

## GUI

重點：

```text
exact dimensions
hard edges
alpha precision
border preservation
flat colors
```

## Particle

重點：

```text
alpha
center of mass
small-scale readability
frame consistency
```

## Generic

不加入 Minecraft-specific heuristic。

---

# 31. Palette Engine

功能：

```text
extract
apply
quantize
map
inspect
```

例如：

```bash
mc-asset palette extract image.png --json
```

```bash
mc-asset quantize image.png \
  --colors 12 \
  --output ./result.png
```

---

# 32. Material System

Material 是 Palette 之上的語意層。

例如：

```text
iron
steel
gold
copper
oxidized_copper
wood
stone
crystal
leather
cloth
```

可包含：

```text
palette
contrast
noise
highlight behavior
cluster characteristics
```

Material System 第一版不要求大量內建 preset，但 Core API 應預留。

---

# 33. Recolor Engine

Recolor 不應只是 Hue Shift。

應支援：

```text
shadow → target shadow
base → target base
highlight → target highlight
```

例如：

```bash
mc-asset recolor sword.mcpx \
  --region blade \
  --material copper \
  --output ./copper_sword.png
```

---

# 34. Variant Engine

可由一份 Source Asset 建立多個變體。

例如：

```bash
mc-asset variant sword.mcpx \
  --materials iron,gold,copper \
  --output-dir <explicit-path>
```

由於所有檔案位置必須明確指定，Variant 類批次 command 同樣不得自行選擇輸出資料夾。

---

# 35. Cleanup Engine

處理：

```text
isolated pixels
one-pixel noise
broken clusters
semi-transparent fringe
palette outlier
tiny holes
unwanted anti-aliasing
```

例如：

```bash
mc-asset cleanup input.png \
  --output cleaned.png
```

`--json` 應回報實際修改統計。

---

# 36. Tile Engine

主要服務 Block Texture。

功能：

```text
horizontal seam analysis
vertical seam analysis
corner seam analysis
edge matching
brightness matching
repeat preview
repeat scoring
```

例如：

```bash
mc-asset tile stone.png \
  --output ./stone_tile.png
```

Preview：

```bash
mc-asset tile stone.png \
  --preview 4x4 \
  --output ./stone_preview.png
```

---

# 37. Procedural Generator

第一階段不使用生成式圖片模型。

可提供 deterministic pattern：

```text
noise
clustered noise
stripes
checker
gradient
brick
spots
veins
cracks
grain
```

例如：

```bash
mc-asset generate noise \
  --size 16 \
  --palette stone \
  --seed 1234 \
  --output ./stone.png
```

---

# 38. Transform Engine

至少支援：

```text
flip horizontal
flip vertical
rotate 90
rotate 180
rotate 270
crop
pad
resize
translate
```

Pixel Art resize：

```text
nearest
box
pixel-aware
```

不預設使用會產生 anti-aliasing 的 resize。

---

# 39. Animation Engine

負責：

```text
pack frames
unpack frames
reorder frames
resize frames
validate frames
preview animation
```

但不負責自動撰寫 `.mcmeta`。

---

# 40. Analyze

例如：

```bash
mc-asset analyze texture.png --json
```

應能回報：

```text
dimensions
alpha
color count
dominant colors
transparency
palette characteristics
tile characteristics
pixel-art characteristics
recommended processing parameters
```

Analyze 本身不應修改檔案。

---

# 41. Asset Validation

例如：

```bash
mc-asset validate sword.png --profile minecraft:item
```

檢查：

```text
valid PNG
dimensions
RGBA
alpha
semi-transparent pixel
palette size
isolated pixels
anti-aliasing
filename
```

---

# 42. Resource Pack Validation

可提供：

```bash
mc-asset validate-pack <path>
```

主要檢查：

```text
invalid JSON
missing referenced texture
missing referenced asset
wrong path
namespace problem
case mismatch
orphan texture
invalid animation sheet
invalid image dimension
broken reference
```

Validator 不自動重寫 Minecraft JSON。

---

# 43. stdin / stdout

Agent workflow 應支援 stream。

例如：

```bash
cat source.mcpx | mc-asset build --stdin --stdout
```

支援 stream 的 command 應避免強迫建立暫存檔。

---

# 44. Machine-readable Interface

所有核心 command MUST 支援：

```bash
--json
```

`--json` 與 `--stdout` 的通道分工見 `project-detail.md` §98.1。

成功：

```json
{
  "success": true,
  "result": {}
}
```

失敗：

```json
{
  "success": false,
  "error": {
    "code": "OUTPUT_REQUIRED",
    "message": "Specify --output or --stdout.",
    "details": {}
  }
}
```

---

# 45. Exit Code

初步定義：

```text
0 success
1 general error
2 invalid input
3 validation failed
4 filesystem error
5 unsupported operation
```

後續可以再細分，但不可將所有錯誤都回傳 exit code 1。

error code 與 exit code 的完整對照表見 `project-detail.md` §99。其中 exit 3 專指「工具正常運作但素材不合格」，Agent 必須能靠 exit code 區分工具故障與素材問題。

---

# 46. Preview

Preview 可支援：

```text
ASCII Grid
enlarged PNG
palette map
tile preview
```

例如：

```bash
mc-asset preview sword.png --ascii
```

Agent 可以藉此重新理解素材，而不一定要依賴 Vision Model。

---

# 47. Round-trip Editing

必須支援：

```text
PNG
↓
Pixel Canvas
↓
Optional mcpx
↓
Agent edit
↓
Pixel Canvas
↓
PNG
```

也支援：

```text
PNG
↓
Pixel Canvas
↓
Agent operation
↓
PNG
```

`.mcpx` 不得成為 Round-trip 的必要條件。

---

# 48. CLI Command Tree

初步規劃：

```text
mc-asset

analyze
pixelize

import
build
render
preview

canvas
pixel
layer
region

resize
crop
transform
quantize
cleanup
recolor
variant
tile
compose

generate

animate

palette
material

validate
validate-pack

mcp
```

具體 command tree 可在 CLI API 設計階段進一步簡化。

---

# 49. MCP Layer

MCP 不屬於最初 MVP。

後續可以：

```bash
mc-asset mcp
```

啟動。

MCP 提供高階 Agent tools，例如：

```text
analyze_asset
pixelize_asset
render_pixel_asset
edit_asset
recolor_asset
create_variants
validate_asset
```

逐像素編輯則應以：

```text
batch operations
ASCII grid
pixel spec
```

完成，而不是大量 MCP `set_pixel` 呼叫。

---

# 50. 技術方向

已定案：

```text
TypeScript
Bun（開發、測試、執行）
Node（CI 交叉驗證）
```

Core 與 CLI 不得依賴 Bun 專有 API：golden、canonical 與 determinism 測試必須在 Bun 與 Node 上各跑一次並比對輸出，兩者的輸出檔必須 byte-identical（見 `project-detail.md` §100.5）。

可能使用：

```text
pngjs
zod
commander
@modelcontextprotocol/sdk
```

不得用於 pixel-critical 路徑：

```text
sharp / libvips / Skia 類函式庫
```

理由是這類函式庫的 resize 與 composite 多半在 premultiplied alpha 空間進行，會把 `A = 0` 像素的 RGB 歸零，違反透明像素必須保留 RGB 的強制規格。詳見 `project-detail.md` §101。

核心與 CLI/MCP 解耦。

---

# 51. 測試策略

Pixel Engine 應大量使用：

```text
unit tests
golden image tests
pixel diff tests
round-trip tests
CLI integration tests
deterministic tests
filesystem behavior tests
```

尤其必須驗證：

```text
工具不會偷偷建立未指定的輸出檔案
工具不會自行建立預設 output directory
工具不會覆寫 input
```

---

# 52. 版本路線圖

規範來源為 `project-detail.md` §84–§90。本節為摘要，若與技術規格書不一致，以技術規格書為準。

| 版本 | 範圍 |
|---|---|
| V0.1 | PixelCanvas Core、RGBA 保留、Layer / Region / AuthoringPalette、pixel primitives、batch + atomic transaction、PNG 讀寫、`.mcpx` parse / serialize / canonical、ASCII Grid、generic + minecraft:item + minecraft:block profile、basic analyze（含 alpha classification）、basic validate、CLI（`--json`、exit code、explicit output） |
| V0.2 | Transform、Selection、進階 Layer 操作、Recolor、Variant、Material、**Pixelizer**、Cleanup、Quantizer |
| V0.3 | Tile Engine、Block Texture 工作流、Procedural Generator、Tile Preview、Seam Analysis |
| V0.4 | FrameSet 與 Animation Engine、minecraft:gui 與 minecraft:particle profile、mcmeta 驗證、Nine-Slice Preview |
| V0.5 | Atlas-aware Resource Pack Validator、Resource Location Validator、版本感知相容層 |
| V0.6 | MCP Server（直接呼叫 Core，不重新實作圖片處理） |

本文件先前版本曾把 `pixelize` / `quantize` / `cleanup` 列入 V0.1，與技術規格書不一致。已裁定採技術規格書的切法：**V0.1 核心先行，參考圖片管線留待 V0.2**。

---

# 52.1 V0.1 驗收

V0.1 完成時必須滿足：

```text
Agent 可以從零逐像素建立 16×16 Minecraft Item Texture
Agent 可以選擇直接輸出 PNG
Agent 可以選擇保存 .mcpx
.mcpx canonical 序列化 byte-stable，round-trip 安全
alpha = 0 像素的隱藏 RGB 在 PNG round-trip 後不變
batch operation 失敗時完整 rollback
沒有 --output / --stdout 時不產生任何檔案
所有檔案位置均由呼叫端指定
同輸入重跑產生相同 bytes
```

「把高清參考圖片轉成 16×16 或 32×32」屬於 V0.2 的驗收項目，不在 V0.1 範圍內。

---

# 57. 未來方向

可考慮：

```text
Entity UV Templates
Equipment Templates
Font Glyph Generator
Armor Texture Helpers
Texture Atlas Tools
Minecraft Preview Renderer
Automatic Asset Comparison
Semantic Material Extraction
Style Extraction
Texture Family Generator
```

---

# 58. 標準工作流程

簡單一次性素材：

```text
User
↓
Agent
↓
mc-asset
↓
Pixel Canvas
↓
PNG
```

需要反覆編輯：

```text
User
↓
Agent
↓
mc-asset
↓
Pixel Canvas
↓
mcpx
↓
Agent Edit
↓
Pixel Canvas
↓
PNG
```

參考圖片工作流程：

```text
Reference Image
↓
Pixelize
↓
Pixel Canvas
├── Direct Export → PNG
└── Save Source → mcpx
                     ↓
                  Editing
                     ↓
                    PNG
```

最重要的原則是：

**Pixel Canvas 是處理核心，`.mcpx` 是可選的保存方式，PNG 是最常見的實際 Minecraft 輸出。**

檔案保存位置永遠不由 `mc-asset` 自行決定。