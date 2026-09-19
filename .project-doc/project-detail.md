# mc-asset 技術規格書 v0.3

## 1. 文件目的

本文件定義 `mc-asset` 的核心技術架構，包含：

1. Pixel Canvas Core
2. `.mcpx` 可編輯來源格式
3. Pixel Operation API
4. Asset Processing Engine
5. Minecraft Asset Profile
6. Animation FrameSet
7. Minecraft Texture Export
8. Resource Pack Asset Validation
9. CLI 與未來 MCP 的介面邊界

本規格以 Minecraft Java Edition 現代 Resource Pack 系統為設計基準。

截至 Minecraft Java Edition 26.3，目前 Resource Pack Version 為 `97.1`。本專案不應把 97.1 的所有規則直接寫死在 Pixel Canvas Core，而應透過 Minecraft Compatibility Layer 與 Asset Profile 管理版本相關行為。版本事實的出處與查證日期見 §95。

---

## 1.1 規範用語

本文件中的：

```text
MUST / MUST NOT
SHOULD / SHOULD NOT
MAY
```

依 RFC 2119 / RFC 8174 解讀。

中文的「必須」「不得」等同 MUST / MUST NOT；「建議」「應」等同 SHOULD；「可以」「可」等同 MAY。

實作時：

```text
MUST   → 必須有測試涵蓋，違反即為 bug
SHOULD → 可依理由偏離，但偏離需記錄在決策紀錄
MAY    → 實作自由
```

---

## 1.2 文件位階

`mc-asset` 的文件分工如下：

```text
project-docs.md              產品規格書（定位、範圍、對外說明）
project-detail.md            技術規格書（規範文件）
mc-asset-development-references.md   參考資料（非規範）
```

發生衝突時：

```text
project-detail.md 為準
```

產品規格書的技術敘述若與本文件不一致，視為產品規格書待更新。

版本路線圖以本文件 §84–§90 為唯一來源。

---

# 2. 核心設計原則

`mc-asset` 採用下列技術原則：

```text
CLI First
Agent First
Pixel Native
Deterministic
Non-destructive
Explicit File Paths
Minecraft-aware but Minecraft-decoupled Core
```

其中最重要的架構原則是：

```text
Pixel Canvas Core
≠
Minecraft Resource Pack Rules
```

Pixel Canvas Core 是通用 Pixel Raster Engine。

Minecraft 規則由其上方的 Asset Profile 與 Validator 負責。

---

# 3. 整體架構

系統分成六個主要層級：

```text
Input / Source
│
├── PNG
├── JPEG
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
├── Layer
├── Region
├── Palette
├── Selection
└── Pixel Operations
│
▼
Asset Processing Engine
│
├── Pixelize
├── Quantize
├── Cleanup
├── Recolor
├── Transform
├── Tile
├── Procedural
└── Variant
│
▼
Asset Profile Layer
│
├── generic
├── minecraft:item
├── minecraft:block
├── minecraft:gui
├── minecraft:particle
└── future profiles
│
▼
Minecraft Compatibility Layer
│
├── Texture Rules
├── Alpha Classification
├── Atlas Rules
├── mcmeta Validation
└── Resource Location Validation
│
▼
Output
├── PNG
├── mcpx
├── stdout
├── Preview
└── Validation Report
```

Animation 則透過獨立的 `FrameSet` abstraction 使用多個 Pixel Canvas。

---

# 4. Core 與 Minecraft Compatibility 必須分離

Pixel Canvas Core MUST NOT 知道：

```text
Minecraft item atlas
Minecraft blocks atlas
Resource Pack Version
GUI nine-slice
block render pass
.mcmeta
namespace
resource location
pack.mcmeta
```

Core 只需要理解：

```text
Pixel
Canvas
Layer
Region
Palette
Transform
Operations
```

Minecraft-specific 行為全部放在：

```text
Minecraft Compatibility Layer
```

這使 `mc-asset` 未來可以支援不同 Minecraft Resource Pack Version，而不需要改動 Pixel Engine。

---

# 5. Pixel Canvas 資料模型

基本資料模型：

```ts
interface PixelCanvas {
  version: number
  width: number
  height: number

  layers: PixelLayer[]
  regions: PixelRegion[]

  palette?: AuthoringPalette
  metadata: CanvasMetadata
}
```

V1：

```text
version = 1
```

Canvas width / height MUST：

```text
positive integer
```

初期安全上限建議：

```text
1 <= width <= 4096
1 <= height <= 4096
```

上限是防止惡意或錯誤輸入造成異常記憶體配置，不代表 Minecraft Texture 的格式限制。

---

# 6. Pixel 格式

Pixel Canvas Core 固定使用：

```text
RGBA8
```

也就是：

```ts
interface RGBA {
  r: number
  g: number
  b: number
  a: number
}
```

每個 channel：

```text
0–255 integer
```

---

# 7. 透明 Pixel 必須完整保留 RGBA

這是強制規格。

Pixel Canvas MUST preserve：

```text
R
G
B
A
```

四個 channel。

即使：

```text
A = 0
```

也不得自動把：

```text
#FF000000
```

改成：

```text
#00000000
```

完全透明 Pixel 中隱藏的 RGB 值仍屬於 source raster data。

尤其 Minecraft Block Texture 現在具有可設定的 mipmap strategy，而部分 mipmap 生成會處理 color 與 alpha，因此 Core 不應自行破壞透明 Pixel 的 RGB。

只有明確的圖片操作，例如：

```text
normalize-transparent-rgb
```

才能改寫這些值。

---

# 8. `transparent` Shortcut

`.mcpx` 可以提供：

```text
transparent
```

作為方便表示法。

它明確代表：

```text
#00000000
```

但：

```text
#FF000000
```

即使 Alpha 也是 0，也 MUST NOT serializer 成：

```text
transparent
```

否則會造成資料遺失。

---

# 9. Pixel Storage

內部建議使用：

```ts
Uint8Array
```

layout：

```text
R G B A | R G B A | R G B A ...
```

Pixel offset：

```text
offset = (y * width + x) * 4
```

Public API MUST NOT 依賴這個實作細節。

未來可以改成 WASM、Rust-backed buffer 或其他 storage，而不破壞 API。

---

# 10. 座標系統

固定：

```text
左上角 = (0,0)

(0,0) ─────────────→ +x
  │
  │
  ▼
 +y
```

合法 Pixel：

```text
0 <= x < width
0 <= y < height
```

所有 Pixel Coordinate MUST 是 integer。

浮點座標：

```text
5.2
```

必須：

```text
INVALID_COORDINATE
```

不得自動 round。

---

# 11. Rectangle

所有 rectangle API 使用：

```ts
interface Rect {
  x: number
  y: number
  width: number
  height: number
}
```

不得使用：

```text
x1 y1 x2 y2
```

作為主要表示法，以避免 inclusive / exclusive boundary ambiguity。

---

# 12. Layer

Layer：

```ts
interface PixelLayer {
  id: string
  name?: string

  pixels: Uint8Array

  visible: boolean
  opacity: number
  blendMode: "normal"

  metadata?: Record<string, unknown>
}
```

Layer 的：

```text
width
height
```

由 Canvas 決定。

V1 所有 Layer MUST 與 Canvas 同尺寸。

Opacity：

```text
0.0–1.0
```

V1 只要求：

```text
normal
```

blend mode。

Layer bottom-to-top compositing order 由：

```text
layers[]
```

陣列順序決定。

---

# 13. Region

Region 是 semantic mask，而不是 rendering layer。

```ts
interface PixelRegion {
  id: string
  name?: string

  mask: Uint8Array

  metadata?: Record<string, unknown>
}
```

mask：

```text
0 = outside
1 = inside
```

例如：

```text
blade
handle
guard
gem
outline
metal
wood
```

Region MAY overlap。

同一 Pixel 可以同時：

```text
Region blade
Region metal
Region highlight-area
```

---

# 14. Region 不得依賴顏色推導

以下設計禁止作為 Region source of truth：

```text
blade = 所有 #AAAAAA Pixel
```

因為 recolor 後會失去語意。

Region 必須保存自己的 mask。

這使：

```text
recolor(blade, copper)
```

完成後：

```text
blade region
```

仍保持不變。

---

# 15. Authoring Palette

`mc-asset` 內部的 Palette 應正式稱為：

```text
AuthoringPalette
```

避免與 Minecraft 本身的 Palette Texture 概念混淆。

Minecraft 26.3 已正式使用 Palette Texture ID 來處理部分 Armor Trim 色彩映射，因此這兩種概念需要清楚分離。

資料結構：

```ts
interface AuthoringPalette {
  entries: AuthoringPaletteEntry[]
}

interface AuthoringPaletteEntry {
  id: string
  color: RGBA

  role?: PaletteRole

  metadata?: Record<string, unknown>
}
```

Palette Role：

```text
outline
shadow
dark
base
light
highlight
accent
custom
```

---

# 16. Pixel 不依賴 Palette

Pixel 的 source of truth 永遠是：

```text
RGBA
```

不是：

```text
palette index
```

Palette 只提供：

```text
semantic mapping
recolor assistance
Agent readability
mcpx readability
variant generation
```

因此刪除 Palette Entry 不應造成 Pixel 消失。

---

# 17. `.mcpx` 的定位

`.mcpx` 是：

**Minecraft Pixel Asset Editable Source Format**

它是：

```text
optional
```

而不是 mandatory intermediate format。

合法：

```text
PNG
→ PixelCanvas
→ PNG
```

合法：

```text
PNG
→ PixelCanvas
→ mcpx
```

合法：

```text
mcpx
→ PixelCanvas
→ PNG
```

合法：

```text
ASCII Pixel Spec
→ PixelCanvas
→ PNG
```

Agent 可以依任務決定要不要保存 `.mcpx`。

---

# 18. `.mcpx` 不管理檔案位置

`.mcpx` MUST NOT 保存：

```text
input_path
output_path
resource_pack_path
project_root
export_directory
```

所有檔案位置由：

```text
User
Agent
CLI Caller
```

決定。

`mc-asset` 不自行建立：

```text
output/
generated/
assets/
textures/
.mc-asset/
```

等預設資料夾。

---

# 19. `.mcpx` 設計目標

`.mcpx` MUST：

```text
UTF-8
Human-readable
Agent-readable
Git-friendly
Diff-friendly
Deterministic
Round-trip safe
Self-contained
```

`.mcpx` V1 MUST NOT：

```text
執行程式碼
include 外部檔案
讀取 URL
展開環境變數
引用其他 mcpx
引用外部 palette
```

---

# 20. `.mcpx` Header

固定：

```text
mcpx 1
```

代表：

```text
format = mcpx
major version = 1
```

不支援的 major version：

```text
MCPX_UNSUPPORTED_VERSION
```

不得 fallback 猜測。

---

# 21. `.mcpx` Canonical Example

```text
mcpx 1

[canvas]
width = 16
height = 16

[metadata]
name = iron_sword
type = item

[palette]
. = transparent
O = #25282BFF role=outline
D = #707A84FF role=shadow
S = #ADB7C0FF role=base
H = #E1E7EAFF role=highlight
W = #6F4730FF

[layer base]
visible = true
opacity = 1

[grid]
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

[region blade]
name = Blade

[mask]
................
.......#........
.......##.......
......###.......
......###.......
.....###........
.....###........
....###.........
....###.........
...###..........
................
................
................
................
................
................
```

---

# 22. `.mcpx` Canvas 不應有 destructive background semantics

`.mcpx` 不應使用 Canvas Background 去代替透明 Pixel。

Layer 中沒有內容的位置必須真的保存為：

```text
RGBA alpha = 0
```

Background 如果未來保留，只應屬於：

```text
preview/export option
```

而不是 Raster Source of Truth。

V1 最簡單的方案是 Canvas 不保存 persistent background color。

---

# 23. Grid

Compact Grid：

```text
[grid]
..ABBCD..
```

一個 symbol 代表一個 Palette Entry。

每列 logical symbol count：

```text
== canvas.width
```

row count：

```text
== canvas.height
```

---

# 24. Tokenized Grid

大量顏色時可使用：

```text
[grid tokens]
T T C01 C02 C02 C03 T T
```

Palette：

```text
[palette]
T = transparent
C01 = #213548FF
C02 = #416A82FF
C03 = #A2D1E8FF
```

Serializer SHOULD：

```text
能安全使用 Compact → Compact
否則 → Tokenized
```

---

# 25. `.mcpx` Region Mask

固定：

```text
# = member
. = not member
```

例如（以下為節錄，實際檔案必須寫滿 canvas 高度）：

```text
[region blade]

[mask]
.......#........
.......##.......
......###.......
................
```

Mask width / height MUST 與 Canvas 完全一致。

完整且與 grid 對位正確的範例見 §21。

---

# 26. `.mcpx` Canonical Serialization

Serializer MUST：

```text
同 PixelCanvas
+
同 serializer version
=
byte-for-byte 相同 mcpx
```

固定：

```text
UTF-8
No BOM
LF newline
Canonical section order
Canonical color format
Stable palette order
Stable layer order
Stable region order
```

Hex Color canonical format：

```text
#RRGGBBAA
```

使用 uppercase。

Parser 可以接受：

```text
#RRGGBB
#RRGGBBAA
uppercase
lowercase
```

但 Serializer 一律正規化。

---

# 27. Parser Pipeline

`.mcpx` Parser：

```text
Tokenizer
↓
Syntax Parser
↓
Schema Validator
↓
Semantic Validator
↓
PixelCanvas Builder
```

需要區分：

```text
Syntax Error
Schema Error
Semantic Error
```

例如：

```text
width = abc
```

是 schema error。

而：

```text
width = 16
但 grid row = 15 pixels
```

是 semantic error。

---

# 28. Pixel Operation API

核心至少提供：

```text
getPixel
setPixel
clearPixel

drawLine
drawRect
fillRect
floodFill

createLayer
removeLayer
renameLayer
reorderLayer

createRegion
removeRegion
setRegionPixel

flipHorizontal
flipVertical
rotate90
rotate180
rotate270
translate
crop
pad
resize
```

後續可以加入：

```text
ellipse
polygon
advanced selection
```

---

# 29. Batch Operations

Agent 不應需要呼叫：

```text
setPixel
setPixel
setPixel
```

數百次。

因此核心提供：

```ts
applyOperations(
  canvas,
  operations,
  options
)
```

例如：

```json
{
  "operations": [
    {
      "id": "blade-tip",
      "type": "setPixel",
      "x": 7,
      "y": 2,
      "color": "#FFFFFFFF"
    },
    {
      "id": "blade-edge",
      "type": "drawLine",
      "from": [7, 3],
      "to": [11, 8],
      "color": "#ADB7C0FF"
    }
  ]
}
```

---

# 30. Transaction

Agent-facing Batch 預設：

```text
atomic = true
```

若 operation 1–19 成功，但 20 失敗：

```text
全部 rollback
```

Canvas 必須保持執行前狀態。

可選：

```text
atomic = false
```

只供特殊 bulk repair / debugging 使用。

---

# 31. Bounds Policy

預設：

```text
strict
```

超出 Canvas：

```text
OUT_OF_BOUNDS
```

禁止 silent clipping。

未來可加入：

```text
bounds = clip
```

但必須 explicit。

---

# 32. Deterministic Drawing

Pixel Primitive 必須由 `mc-asset` 自己控制 rasterization。

例如 Line：

```text
Bresenham
```

或其他固定演算法。

不能依賴不同 OS 圖形 API。

相同 operation 在：

```text
macOS
Linux
Node
Bun
```

應產生完全相同 Pixel。

---

# 33. 圖片輸入格式

Asset Creation Engine 可以接受：

```text
PNG
JPEG
WebP
```

等一般圖片作為 source。

這些只是：

```text
Input Format
```

而不是 Minecraft Runtime Texture Format。

---

# 34. Minecraft Texture 輸出格式

Minecraft Java Resource Pack 現行支援的 texture format 為：

```text
PNG
```

現行 Resource Pack 的 texture 一律為 `.png`。（此限制的確切起始 pack format 尚待補上官方出處，見 §95；但「Minecraft Profile 只輸出 PNG」這條規則不受影響。）

因此：

```text
JPEG → import
WebP → import
```

合法。

Minecraft Profile Export 僅限：

```text
→ PNG
```


例如：

```bash
mc-asset pixelize sword.webp \
  --profile minecraft:item \
  --output sword.png
```

合法。

如果：

```bash
--profile minecraft:item
--output sword.webp
```

應：

```text
UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT
```

---

# 35. PNG Round-trip

PNG：

```text
decode
→ PixelCanvas
→ encode
```

不要求檔案 bytes 相同。

但未修改情況下：

```text
decoded RGBA pixels
```

SHOULD 相同。

其中包括：

```text
alpha = 0 Pixel 的 RGB
```

也必須保持。

---

# 36. PNG Export

PNG Export 流程：

```text
PixelCanvas
↓
Flatten visible Layers
↓
RGBA Buffer
↓
PNG Encoder
```

不得偷偷：

```text
remove alpha
normalize transparent RGB
resize
quantize
```

除非 Export Options 明確要求。

---

# 37. Minecraft Asset Profile

原本的 `preset` 概念正式拆成：

```text
Processing Preset
```

與：

```text
Asset Profile
```

Processing Preset 決定：

```text
怎麼處理圖片
```

Asset Profile 決定：

```text
這張圖片在 Minecraft 裡是什麼
以及有哪些相容性規則
```

---

# 38. minecraft:item Profile

`minecraft:item` 應理解：

```text
Minecraft item texture
items atlas
no item atlas mipmaps
silhouette-oriented authoring
alpha supported
```

Minecraft 1.21.11 已將 Item Texture 從 blocks atlas 分離到新的 items atlas，而且 items atlas 沒有 mipmap。所有同一 item model 使用的 textures 必須來自相同 atlas。

因此 Profile metadata 可以包含：

```ts
{
  id: "minecraft:item",
  preferredAtlas: "items",
  mipmapped: false
}
```

---

# 39. minecraft:block Profile

`minecraft:block`：

```text
blocks atlas
mipmap-aware
alpha-classification-aware
tile analysis optional
```

Minecraft Block Model 使用的 texture 必須來自 blocks atlas。

Block Texture 不應硬性要求：

```text
16×16
32×32
64×64
power of two
square
```

這些可以是 recommendation。

只有真正由 Minecraft 格式要求的尺寸條件才能是 Error。

---

# 40. Block Alpha Classification

Block Profile 必須支援 Alpha Classification。

自 Minecraft 26.1 起，Block Model Rendering 會根據 sprite 內容決定 render pass：

```text
全部 opaque
→ solid

存在 fully transparent pixels
→ cutout

存在 partially transparent pixels
→ translucent
```

如果存在 partial alpha，該 sprite 會進入 translucent render pass。

但這個推導**可以被 model 覆寫**。

自 26.1 起，block model 的 texture entry 可以寫成物件形式並帶上：

```text
force_translucent = true
```

此時不論 sprite 內容為何，該 quad 一律進入 translucent pass。典型用途是 sprite 沒有 partial alpha、但使用 `mean` mipmap strategy 的方塊。

因此 `mc-asset` MUST 把這個欄位當成分類的一部分：

```text
mc-asset 只看 PNG
→ 得到 predicted classification

要得到 effective classification
→ 必須同時讀 block model 的 force_translucent
```

`analyze` 只看單張 PNG 時，輸出的 `classification` 是 **predicted**，MUST NOT 宣稱為最終渲染結果。

只有 `validate-pack`（V0.5）同時看得到 model JSON，才能輸出 effective classification。

因此：

```bash
mc-asset analyze block.png \
  --profile minecraft:block
```

應能輸出：

```json
{
  "alpha": {
    "classification": "translucent",
    "opaquePixels": 181,
    "transparentPixels": 73,
    "partialAlphaPixels": 2,
    "partialAlphaValues": [128, 254]
  }
}
```

---

# 41. Alpha Warning

如果 Texture 只有極少量 partial alpha：

```text
alpha = 254
```

Validator SHOULD 提醒：

```text
PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING
```

但 MUST NOT 自動修正。

因為這可能是使用者刻意設計。

反向情況同樣要提醒：如果 texture 完全沒有 partial alpha，但 model 設了 `force_translucent`，該素材仍會進 translucent pass。此時 sprite 層級的 analyze 結果與實際渲染不一致，這是 V0.5 pack validator 的檢查項，不是 V0.1 analyze 的責任。

---

# 42. minecraft:gui Profile

GUI Profile 應理解：

```text
gui atlas
exact sprite bounds
alpha
stretch
tile
nine_slice
```

Minecraft GUI Sprite 的 `.mcmeta` 可指定：

```text
stretch
tile
nine_slice
```

nine-slice 可進一步指定 border，後續版本還加入 `stretch_inner`。

因此 GUI Profile 未來可以提供：

```text
nine-slice preview
tile preview
stretch preview
border visualization
```

---

# 43. minecraft:particle Profile

Particle Profile 應重視：

```text
alpha
small-size readability
frame consistency
atlas reference
```

但不應把所有 Particle 強迫限制成相同尺寸。

Particle JSON 仍由 Agent 產生。

`mc-asset` 只負責圖片及引用驗證。

---

# 44. Generic Profile

`generic`：

```text
無 Minecraft-specific restriction
```

適合：

```text
Pixel Art
普通圖片
中間素材
參考圖
```

---

# 45. Resolution Policy

`mc-asset` MUST 區分：

```text
Invalid
```

與：

```text
Non-standard
```

例如：

```text
24×24 Block Texture
```

如果 Minecraft 能載入：

不得：

```text
INVALID_DIMENSION
```

可：

```text
NON_STANDARD_RESOLUTION
```

Warning。

16、32、64、128 可以作為：

```text
recommended pixel-art resolutions
```

不是 Core validation rule。

---

# 46. Texture Metadata `.png.mcmeta`

`mc-asset` 不負責替 Agent 自動設計 `.mcmeta`。

但 Resource Pack Validator SHOULD 理解它。

Minecraft Texture Metadata 現在不只 animation，texture section 還包含 mipmap-related behavior，例如 `mipmap_strategy` 和 `alpha_cutoff_bias`。

Validator 應能檢查：

```text
PNG dimensions
frame dimensions
animation layout
texture metadata compatibility
GUI scaling
palette metadata
```

---

# 47. Mipmap Validation

Block Profile 可分析：

```text
Texture alpha
mipmap strategy
alpha cutoff
```

例如：

```text
cutout texture
+
mean mipmap
```

可能需要 warning。

Validator 不必替 Agent決定最佳設定，但可以提供結構化資訊。

---

# 48. FrameSet

Animation 不應直接塞入 PixelCanvas。

建立：

```ts
interface FrameSet {
  frames: PixelCanvas[]

  frameWidth: number
  frameHeight: number

  metadata?: FrameSetMetadata
}
```

每個 Frame 本身就是一個 PixelCanvas。

---

# 49. Animation Engine

Animation Engine：

```text
FrameSet
↓
Pack
↓
Sprite Sheet
```

以及：

```text
Sprite Sheet
↓
Unpack
↓
FrameSet
```

支援 layout：

```text
vertical
horizontal
grid
```

`vertical` 是常見 Minecraft workflow，但不是 Engine 的唯一 layout。

---

# 50. Animation `.mcmeta`

Agent 仍自行生成：

```text
texture.png.mcmeta
```

但 Validator 可以：

```text
讀 PNG
讀 .mcmeta
推導 frame geometry
驗證 frame index
驗證 frame dimensions
驗證 frame count
```

---

# 51. `.mcpx` V1 不保存 Animation

`.mcpx` V1 一個檔案代表：

```text
一個 PixelCanvas
```

不代表：

```text
FrameSet
```

Animation Source Format 暫時不納入 `.mcpx v1`。

這避免 `.mcpx` 過早膨脹。

---

# 52. Atlas Awareness

Minecraft 使用 Atlas 系統管理 Sprite。

Atlas configuration 位於：

```text
assets/<namespace>/atlases/*.json
```

Minecraft 自 1.19.3 起已允許 Resource Pack 自訂 Atlas sources。

因此 Resource Pack Validator 後續必須具備：

```text
Atlas Awareness
```

---

# 53. Atlas Validation

高階 Validate Pack 流程：

```text
Model / Definition
↓
Sprite Reference
↓
Resource Location
↓
Required Atlas
↓
Atlas Sources
↓
Actual Texture
```

Validator 應能辨識：

```text
Texture file exists
但沒有進入正確 Atlas
```

與：

```text
Texture 根本不存在
```

是兩種不同錯誤。

---

# 54. Item / Block Atlas Constraint

Validator 應理解目前規則：

```text
Block Model
→ blocks atlas only

Item Model
→ textures must come from same atlas
```

Item texture 預設主要進：

```text
items atlas
```

這個規則從 1.21.11 開始具有重要差異。

---

# 55. Resource Location Validation

Minecraft Validator 應驗證：

```text
namespace
path
case
filename
extension
```

Pixel Canvas Core 不處理這些。

也就是：

```text
MySword.PNG
```

是否適合作為 Resource Pack asset 是 Compatibility Validator 的問題，不是 Raster Engine 的問題。

---

# 56. File Location Responsibility

所有檔案位置仍由使用者或 Agent 決定。

例如：

```bash
mc-asset pixelize ./reference.png \
  --profile minecraft:item \
  --output ./whatever/path/sword.png
```

`mc-asset` 不需要知道：

```text
為什麼圖片放這裡
```

除非：

```text
validate-pack
```

正在驗證完整 Resource Pack。

---

# 57. 無隱式輸出

會產生檔案的 Command：

MUST 使用：

```text
--output <path>
```

或：

```text
--stdout
```

例如：

```bash
mc-asset pixelize reference.png
```

如果沒有 output：

```text
OUTPUT_REQUIRED
```

不得自動生成：

```text
reference_pixelized.png
```

---

# 58. `.mcpx` 保存也是顯式行為

例如：

直接輸出 PNG：

```bash
mc-asset render sword.grid \
  --output sword.png
```

同時保存 Source：

```bash
mc-asset render sword.grid \
  --source sword.mcpx \
  --output sword.png
```

只保存：

```bash
mc-asset render sword.grid \
  --source sword.mcpx
```

此處的 `sword.grid` 代表 ASCII Grid 輸入。實際命令名稱（`render` 與 `build` 的分工）與 ASCII Grid / Pixel Spec 的副檔名尚未凍結，見 §104。

Agent 自己決定是否需要 `.mcpx`。

---

# 59. 非破壞性修改

所有修改 Input File 的 command 預設：

```text
不覆寫 input
```

例如：

```bash
mc-asset cleanup sword.png \
  --output sword-clean.png
```

若要原地修改，必須 explicit。

建議統一使用：

```text
--in-place
```

避免同時存在：

```text
--overwrite
--in-place
```

兩種重複語意。

---

# 60. Machine-readable CLI

所有核心 command SHOULD 支援：

```text
--json
```

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
    "code": "OUT_OF_BOUNDS",
    "message": "Pixel coordinate is outside canvas.",
    "details": {
      "x": 18,
      "y": 4,
      "width": 16,
      "height": 16
    }
  }
}
```

Agent 不應解析自然語言 error message 來判斷錯誤類型。

---

# 61. Error Codes

初期至少：

```text
INVALID_DIMENSION
INVALID_COORDINATE
OUT_OF_BOUNDS
INVALID_COLOR

LAYER_NOT_FOUND
REGION_NOT_FOUND
DUPLICATE_LAYER_ID
DUPLICATE_REGION_ID

INVALID_MASK_SIZE
INVALID_GRID_SIZE
UNKNOWN_PALETTE_SYMBOL

MCPX_SYNTAX_ERROR
MCPX_SCHEMA_ERROR
MCPX_SEMANTIC_ERROR
MCPX_UNSUPPORTED_VERSION

UNSUPPORTED_IMAGE_FORMAT
UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT

INVALID_ANIMATION_FRAME
INVALID_MCMETA

ATLAS_REFERENCE_ERROR
TEXTURE_NOT_IN_REQUIRED_ATLAS

TRANSACTION_FAILED
OUTPUT_REQUIRED
FILESYSTEM_ERROR
```

---

# 62. Analyze API

`analyze` 不修改圖片。

基本分析：

```text
dimensions
color count
alpha distribution
dominant colors
palette
pixel-art characteristics
```

Minecraft Profile Analysis 可加入：

```text
atlas expectation
alpha render classification
mipmap relevance
frame geometry
GUI scaling compatibility
```

---

# 63. Cleanup Engine

Cleanup 可分析與處理：

```text
isolated pixel
single-pixel noise
broken cluster
anti-aliasing
semi-transparent fringe
palette outlier
tiny hole
```

但所有可能改變 Minecraft rendering semantics 的操作不得預設執行。

例如：

```text
alpha 254 → 255
```

可能改變 Block Render Pass，因此：

```text
MUST require explicit option
```

---

# 64. Pixelize Engine

Pixelize：

```text
Decode
↓
Crop
↓
Subject / Texture Processing
↓
Resize
↓
Quantization
↓
Pixel Clustering
↓
Cleanup
↓
Asset Profile Analysis
↓
Output
```

Pixelize MUST 能直接：

```text
PixelCanvas → PNG
```

不要求 `.mcpx`。

---

# 65. Block Processing

Block Processing 可以額外提供：

```text
seam analysis
tile generation
tile preview
brightness normalization
cluster analysis
repeat detection
```

這些是：

```text
authoring tools
```

不是 Minecraft format requirement。

---

# 66. Item Processing

Item Processing 可以偏重：

```text
silhouette preservation
edge readability
transparent background
limited palette
cluster clarity
```

這些也是 authoring heuristic，而不是 Minecraft validation rule。

---

# 67. Material System

Material System 建立在：

```text
AuthoringPalette
+
Texture Processing
```

之上。

例如：

```text
iron
copper
oxidized_copper
gold
wood
stone
crystal
```

Material MAY 定義：

```text
Palette
contrast
noise
cluster characteristics
highlight behavior
```

但不能與 Minecraft Palette Texture API 混為一談。

---

# 68. Recolor

Recolor 應支援：

```text
Region-aware
Palette Role-aware
Luminance-aware
```

而不是只有：

```text
Hue Shift
```

例如：

```text
shadow → copper shadow
base → copper base
highlight → copper highlight
```

---

# 69. Security

`.mcpx` Parser MUST NOT：

```text
執行 shell
讀 arbitrary filesystem
讀 URL
展開 environment variable
執行 script
執行 plugin
```

`.mcpx` V1 self-contained。

未知巨大 Canvas 必須先：

```text
validate dimensions
```

再配置 Buffer。

---

# 70. No Hidden Persistent State

Core operation 不得依賴：

```text
~/.mc-asset/
.mc-asset/state
global project registry
```

才能得到正確結果。

Cache MAY 存在，但：

```text
cache hit
cache miss
```

不能改變 semantic output。

---

# 71. Determinism

對 deterministic operation：

```text
same input
same parameters
same seed
same engine version
=
same Pixel result
```

Procedural Generator 必須要求或允許：

```text
seed
```

---

# 72. Versioning

`mc-asset` 自己使用 Semantic Versioning。

例如：

```text
mc-asset 0.4.2
```

`.mcpx` 使用獨立 format version：

```text
mcpx 1
```

Minecraft Resource Pack Compatibility 使用：

```text
Minecraft version
Resource Pack version
```

三個 version domain 必須分開。

---

# 73. Minecraft Compatibility Target

Validator API SHOULD 接受：

```text
--minecraft-version
```

或：

```text
--resource-pack-version
```

例如：

```bash
mc-asset validate-pack ./pack \
  --minecraft-version 26.3
```

如果沒有指定，未來可以：

```text
讀 pack.mcmeta
```

決定 target。

不得永遠硬編碼：

```text
97.1
```

---

# 74. Testing Strategy

必須包含：

```text
Unit Tests
Golden Pixel Tests
Golden PNG Tests
mcpx Round-trip Tests
Parser Invalid Fixture Tests
Transaction Tests
Asset Profile Tests
Minecraft Compatibility Tests
CLI Integration Tests
Determinism Tests
Filesystem Behavior Tests
```

---

# 75. RGBA Preservation Test

必測：

Input：

```text
#FF000000
```

PNG → PixelCanvas → PNG。

Output Pixel MUST：

```text
#FF000000
```

不得：

```text
#00000000
```

---

# 76. `.mcpx` Round-trip Test

```text
mcpx
↓
parse
↓
PixelCanvas
↓
serialize
↓
mcpx
```

Canonical serialize 再 parse/serialize：

```text
bytes MUST remain stable
```

---

# 77. Transaction Test

16×16 Canvas：

```text
operation 1 valid
operation 2 valid
operation 3 x=20
```

atomic：

```text
Canvas MUST remain unchanged
```

---

# 78. Minecraft Block Alpha Test

測試：

Case A：

```text
所有 A=255
→ solid
```

Case B：

```text
A=0 + A=255
→ cutout
```

Case C：

```text
任何 0<A<255
→ translucent
```

依目前 Minecraft Block rendering classification 驗證。

---

# 79. Item Atlas Test

驗證：

```text
minecraft:item profile
```

知道：

```text
preferred atlas = items
mipmaps = false
```

並能在 Resource Pack Validator 中辨認錯誤 Atlas reference。

---

# 80. GUI Validation Test

準備：

```text
GUI sprite
+
nine_slice mcmeta
```

測試：

```text
border geometry
texture dimensions
scaling metadata
```

並能產生 Nine-Slice Preview。

---

# 81. Animation Test

Sprite Sheet：

```text
32×128
frame = 32×32
```

應識別：

```text
4 frames
```

錯誤 frame index：

```text
INVALID_ANIMATION_FRAME
```

---

# 82. Atlas Test

驗證：

```text
Texture exists
但 Atlas sources 不包含
```

應與：

```text
Texture file missing
```

回傳不同錯誤。

---

# 83. File Behavior Test

必須證明：

```text
沒有 --output
→ 不建立任何輸出檔案
```

```text
預設不建立 output/
```

```text
預設不覆寫 source
```

```text
指定 --in-place
→ 才允許修改 source
```

---

# 84. V0.1 實作範圍

第一階段：

```text
PixelCanvas
RGBA preservation
Base Layer
Region
AuthoringPalette

Pixel Read / Write
Basic Drawing
Batch Operation
Atomic Transaction

PNG Decode / Encode

mcpx Parse / Serialize
ASCII Grid
Canonical Serialization

Generic Profile
minecraft:item Profile
minecraft:block Profile

Basic Analyze
Alpha Classification
Basic Validate

CLI
--json
explicit output
```

---

# 85. V0.2

加入：

```text
Advanced Layer Operations
Transform
Selection

Recolor
Variant
Material

Pixelizer
Cleanup
Quantizer
```

---

# 86. V0.3

加入：

```text
Tile Engine
Block Texture Workflow
Procedural Generator
Tile Preview
Seam Analysis
```

---

# 87. V0.4

加入：

```text
FrameSet
Animation Engine

minecraft:gui
minecraft:particle

mcmeta Validation
Nine-Slice Preview
Animation Validation
```

---

# 88. V0.5

加入：

```text
Atlas-aware Resource Pack Validator
Resource Location Validator
Version-aware Compatibility Layer
```

---

# 89. V0.6

加入：

```text
MCP Server
```

MCP 直接呼叫 Core。

不得重新實作圖片處理邏輯。

---

# 90. MCP Interface 原則

MCP 應提供高階功能：

```text
analyze_asset
pixelize_asset
render_pixel_asset
apply_asset_operations
recolor_asset
create_variants
validate_asset
```

不應要求：

```text
256 次 set_pixel MCP call
```

逐像素創作應透過：

```text
ASCII Grid
Batch Operations
Pixel Spec
```

完成。

---

# 91. 非目標

本規格不要求 `mc-asset`：

```text
自動生成 Resource Pack JSON
設計 Item Model
設計 Block Model
生成 Blockstate
生成 lang
生成 Shader
生成音效
生成 3D Model
使用 AI Image Generation
管理 Resource Pack 專案結構
自行決定檔案位置
```

這些由 Agent 或其他工具負責。

---

# 92. 最終責任邊界

Pixel Canvas Core：

```text
Raster Data
Pixel
Layer
Region
Palette
Operations
Transaction
```

Processing Engine：

```text
Pixelize
Cleanup
Quantize
Recolor
Tile
Transform
Procedural
```

Asset Profile：

```text
Asset Semantic Type
Minecraft-specific expectations
Processing recommendations
Validation context
```

Minecraft Compatibility Layer：

```text
Resource Pack Version
PNG requirement
Atlas
Alpha Render Classification
mcmeta
Resource Location
Minecraft-specific validation
```

`.mcpx`：

```text
Editable Pixel Source
Agent Editing
Human Editing
Git Diff
Round-trip Persistence
```

CLI：

```text
Filesystem
Explicit Paths
stdin/stdout
Argument Parsing
JSON Output
Human Output
```

Agent / User：

```text
Asset Design
Whether mcpx is saved
File Locations
Resource Pack Structure
Minecraft JSON
```

---

# 93. 核心資料流

一次性素材：

```text
Input Image
↓
Decode
↓
PixelCanvas
↓
Processing
↓
Asset Profile
↓
Minecraft Validation
↓
PNG
```

Agent 從零畫：

```text
Pixel Spec
↓
PixelCanvas
↓
Batch Operations
↓
Asset Profile
↓
PNG
```

需要長期修改：

```text
PixelCanvas
↓
mcpx
↓
Agent Edit
↓
PixelCanvas
↓
PNG
```

Animation：

```text
PixelCanvas[]
↓
FrameSet
↓
Animation Engine
↓
PNG Sprite Sheet
↓
mcmeta Validation
```

完整 Resource Pack：

```text
PNG Assets
+
Agent-generated JSON / mcmeta
↓
Resource Pack Validator
↓
Atlas / Reference / Profile / Format Validation
```

---

# 94. 最終技術定義

`PixelCanvas` 是 `mc-asset` 唯一的核心 Raster Data Model。

`.mcpx` 是 PixelCanvas 的可選 editable serialization。

`FrameSet` 是多 PixelCanvas 動畫的 runtime abstraction。

`Asset Profile` 描述素材用途。

`Minecraft Compatibility Layer` 描述 Minecraft Resource Pack 規則。

PNG 是目前 Minecraft Java Edition Resource Pack 的主要 Texture Runtime Format。

最終關係為：

```text
                        ┌── mcpx
                        │
                        ├── PNG
                        │
PixelCanvas ────────────┼── Processing Engine
      │                 │
      │                 └── Preview
      │
      └── FrameSet
              │
              └── Animation Sprite Sheet

PixelCanvas
      ↓
Asset Profile
      ↓
Minecraft Compatibility Layer
      ↓
Resource Pack Asset
```

整個 `mc-asset` 的核心原則維持不變：

**Agent 決定要創作什麼以及檔案放在哪裡，`mc-asset` 負責可靠地操作 Pixel、處理圖片並確認素材符合 Minecraft 的實際需求。**

---

# 95. Minecraft 相容基準與查證紀錄

本文件的 Minecraft-specific 規則都對應到特定版本事實。這些事實 MUST 附出處，並在 Compatibility Layer 中以資料表達，不得散落在 Core。

查證日期：2026-09-19

| 事實 | 版本 | 狀態 | 出處 |
|---|---|---|---|
| Resource Pack Format `97.1` | Java Edition 26.3 | 已查證 | Minecraft Wiki `Template:Resource pack format` |
| Trim color palette 由 `textures/trim/color_palettes/` 移至 `textures/palettes/trim/` | 26.3 / RP 97.1 | 已查證 | 同上 |
| Item texture 自 blocks atlas 分離為獨立 `minecraft:items` atlas，且該 atlas 無 mipmap | 1.21.11 | 已查證 | Minecraft Java Edition 1.21.11 release notes |
| 同一 item model 的所有 texture 必須來自同一 atlas；block model 的 texture 必須來自 blocks atlas | 1.21.11 | 已查證 | 同上 |
| `.mcmeta` 的 texture section 新增 `mipmap_strategy` 與 `alpha_cutoff_bias` | 1.21.11 | 已查證 | 同上 |
| Block model 的 render pass 依 sprite 內容自動決定（solid / cutout / translucent） | 26.1 | 已查證 | Minecraft 26.1 release notes |
| Block model 的 texture entry 可用物件形式指定 `force_translucent`，強制進 translucent pass | 26.1 | 已查證 | 同上 |
| Resource Pack texture 僅支援 `.png` | 起始 pack format 未確認 | 待補出處 | — |

「待補出處」的項目 MUST NOT 作為 Error 的依據，只能作為 Warning，直到補上官方出處為止。

Compatibility Layer 的實作 MUST 把上表表達成版本區間資料，例如：

```ts
{
  fact: "items-atlas-separated",
  since: { packFormat: 75 },
  value: { atlas: "items", mipmapped: false }
}
```

這樣 `--minecraft-version` / `--resource-pack-version`（§73）才能真正切換行為，而不是只印在報告裡。

---

# 96. `.mcpx` Canonical Grammar

§26 要求 canonical serialization 達到 byte-for-byte 穩定。要做到這件事，以下規則 MUST 全部固定。

## 96.1 Section 順序

固定為：

```text
mcpx 1
[canvas]
[metadata]
[palette]
[layer <id>] + [grid] / [grid tokens]   （依 layers[] 順序，bottom-to-top）
[region <id>] + [mask]                  （依 regions[] 順序）
```

`[grid]` / `[mask]` MUST 緊接在其所屬的 `[layer]` / `[region]` 之後，中間只允許該 section 自己的 key-value 行。Parser MUST NOT 接受沒有前導 `[layer]` 的孤立 `[grid]`。

## 96.2 行與空白

```text
編碼            UTF-8，無 BOM
換行            LF
行尾空白        MUST NOT 出現
section 之間    恰好一個空行
檔案結尾        恰好一個 LF
縮排            MUST NOT 使用
```

## 96.3 Key-Value 行

```text
<key> = <value>
```

`=` 前後各恰好一個空格。key 為 `[a-z][a-z0-9_]*`。

## 96.4 數值格式

```text
整數        十進位，無前導零，無正號
opacity     固定三位小數，例如 1.000 / 0.500
布林        true / false
```

浮點數 MUST 以固定小數位序列化，MUST NOT 使用指數表示法或依賴 runtime 的預設 `toString`。

## 96.5 顏色格式

```text
Serializer 輸出   #RRGGBBAA，十六進位大寫
Parser 接受       #RRGGBB / #RRGGBBAA，大小寫皆可
```

`transparent` 僅代表 `#00000000`，且僅 parser 接受；serializer 的規則見 §8。

## 96.6 Palette 符號字元集

合法符號字元：

```text
.
0-9
A-Z
a-z
```

共 63 個。以下字元 MUST NOT 作為符號：空白、`=`、`#`、`[`、`]`、`;`。

`.` 為保留符號：若 canvas 含有 `#00000000`，該顏色 MUST 指派為 `.`；否則 `.` 不出現在 palette 中。

符號指派規則：

```text
1. canvas 既有 palette 的符號指派 MUST 原樣保留
2. 新出現的顏色依 RGBA 32-bit 鍵值升冪排序
3. 依序指派尚未使用的符號，順序為 . 0-9 A-Z a-z
4. [palette] 的輸出順序 = 符號在上述字元集中的順序
```

保留既有指派是為了讓 git diff 只反映真正改動的像素，而不是整張圖的符號重排。

## 96.7 Palette 行內屬性

```text
<symbol> = <color> [<k>=<v>]...
```

屬性以單一空格分隔，`=` 前後不得有空格，value MUST NOT 含空白。V1 不支援引號與跳脫。

V1 唯一定義的屬性是 `role`，合法值見 §15。未知屬性 MUST 回報 `MCPX_SCHEMA_ERROR`，不得靜默忽略。

## 96.8 Grid

```text
[grid]         compact，一個符號一個像素
[grid tokens]  tokenized，token 以單一空格分隔
```

兩者每列的符號／token 數 MUST == `canvas.width`，列數 MUST == `canvas.height`。

Serializer 選擇規則：

```text
所有顏色都能以單字元符號表示 → [grid]
否則                          → [grid tokens]
```

tokenized 模式的符號字元集不受 §96.6 限制，但仍 MUST NOT 含空白與 `=`。

## 96.9 註解

```text
; 開頭的整行為註解
```

使用 `;` 而非 `#`，是為了避免與 hex color 及 mask 的 `#` 混淆。

註解 MUST NOT 出現在 `[grid]` / `[mask]` 內部。

Parser MUST 接受並忽略註解；Serializer MUST NOT 輸出註解。也就是說：

```text
手寫 mcpx（含註解）
→ parse
→ serialize
→ 註解消失
```

這是預期行為。§19 的「Round-trip safe」指的是 **像素與語意**的 round-trip，不是註解與排版的保留。

## 96.10 指派與 serializer 接縫釐清

- Serializer 永不重排既有 palette：輸出順序即 canvas 既有順序；新符號依字元集順序取號後附加在後。單一像素改動只產生單像素 diff。
- `.` 永不發給非 transparent；transparent 在任何模式一律拿 `.`；無 transparent 時 `.` 不出現在 palette 中。
- 容量：不含 transparent 的 compact 上限 62（含 transparent 總量 63）；tokenized 上限 4096 色不變（`.` 不佔 `T0001`… 命名空間）。自動指派超過 compact 範圍時，新符號為 tokenized 形 `T0001` 起（4 位零填充，跳過已佔用）。
- Serializer 較 parser 嚴格（parser 維持寬容，文法凍結）：檢查 palette 符號（空白、`=`、`#`、`[`、`]`、`;`、單字元字集外、`.` 保留、重複）、palette role／metadata、metadata key、layer／region id——非法 canvas 明確報錯，不輸出壞檔。
- opacity：serializer 僅接受可精確表為 3 位小數的值，否則 `MCPX_SCHEMA_ERROR`（拒絕靜默正規化：`0.9999` 報錯，不輸出 `1.000`）；二進位浮點 dust 容差 `1e-9`。
- `MCPX_PALETTE_OVERFLOW` 的 details 為 `{ colorCount, limit, suggestion }`；計數對象為像素實際使用的相異色數。
- `width > 512 || height > 512` 的 canvas 存成 mcpx 時發出 `MCPX_LARGE_CANVAS`（不阻擋輸出）。
- 文法裁決索引（決策背景見計畫文件，只列程式對應）：寬容解析／嚴格序列化→`parseMcpx`／`serializeMcpx`；§96.7 取值→`validatePalette` role 檢查；id 字集→`OBJECT_ID`／`assertObjectId`；順序嚴格→`parseDocument` phase 順序；永不輸出 transparent→`hexOf`；保序優先→`assignSymbols` 既有保留；`[...]` 歧義指引→`tokenize` `SECTION_INNER`。

---

# 97. `.mcpx` 的表達範圍

`.mcpx` 以 palette symbol 表示像素，因此它 MUST NOT 被當成任意 raster 的通用容器。

限制：

```text
compact grid    ≤ 63 色
tokenized grid  ≤ 4096 色
超過            MCPX_PALETTE_OVERFLOW
```

`MCPX_PALETTE_OVERFLOW` 的 error details MUST 包含實際色數，並建議改存 PNG。

compact 的 63 個符號含保留的 `.`：不含 transparent 時可用上限為 62（含 transparent 總量 63），見 §96.10。

這對 §17 的流程有一個限定：

```text
PNG → PixelCanvas → mcpx
```

合法，但**僅限色數在上述上限內**。照片或未量化的高清圖 MUST 先經過 quantize（V0.2）才能存成 `.mcpx`。

規格上的定位是：

```text
PNG    任意 raster 的保存格式
mcpx   低色數、可編輯、可 diff 的創作來源格式
```

---

# 98. CLI 全域約定

以下規則適用於所有會讀寫檔案的 command。

## 98.1 輸出通道

stdout 同一時間 MUST 只承載一種載荷：

```text
預設            人類可讀輸出 → stdout
--json          JSON envelope → stdout，其餘訊息 → stderr
--stdout        產物 bytes    → stdout，其餘訊息 → stderr
--json --stdout 產物 bytes    → stdout，JSON envelope → stderr
```

因此 `--json` 與 `--stdout` 並用是合法的，且是 Agent pipeline 的建議用法：Agent 讀 stderr 取得結構化結果，同時把 PNG bytes 導向下游。

進度、警告與診斷訊息 MUST NOT 寫入 stdout。

## 98.2 輸出檔已存在

```text
預設                  OUTPUT_EXISTS，且不寫入任何位元組
--force               允許覆寫
--in-place            等同對 input 指定 --output 與 --force
```

此政策為已裁決事項：即使目標檔是呼叫端顯式指定的輸出路徑，覆寫既有檔案仍是不可逆副作用，必須由呼叫端明確授權。Agent 重跑同一條 pipeline 時應顯式帶上 `--force`。

`--force` 與 `--in-place` MUST NOT 同時出現在同一個 command（`ARGUMENT_CONFLICT`）。

## 98.3 父目錄不存在

```text
預設     FILESYSTEM_ERROR，不建立任何目錄
--mkdir  建立缺少的父目錄
```

這是 §18「不自行建立目錄」原則的延伸：即使路徑是呼叫端顯式給的，建立目錄本身仍是一個副作用，必須由呼叫端明確授權。

## 98.4 寫入原子性

所有檔案輸出 MUST 先寫入同目錄的暫存檔再 rename。失敗時 MUST NOT 留下半寫入的目標檔或暫存檔。

這是 §83「沒有 --output 就不建立任何檔案」的實作前提。

---

# 99. Error Code 與 Exit Code 對照

§45 定義 exit code 分類，§61 定義 error code。兩者的對照 MUST 固定如下。

| Exit | 分類 | Error Code |
|---|---|---|
| 0 | success | — |
| 1 | general | `INTERNAL_ERROR` |
| 2 | invalid input | `INVALID_ARGUMENT` `ARGUMENT_CONFLICT` `INVALID_DIMENSION` `INVALID_COORDINATE` `OUT_OF_BOUNDS` `INVALID_COLOR` `INVALID_MASK_SIZE` `INVALID_GRID_SIZE` `UNKNOWN_PALETTE_SYMBOL` `UNKNOWN_OPERATION` `DUPLICATE_OPERATION_ID` `LAYER_NOT_FOUND` `REGION_NOT_FOUND` `DUPLICATE_LAYER_ID` `DUPLICATE_REGION_ID` `INVALID_PROFILE` `MCPX_SYNTAX_ERROR` `MCPX_SCHEMA_ERROR` `MCPX_SEMANTIC_ERROR` `MCPX_PALETTE_OVERFLOW` `INVALID_ANIMATION_FRAME` `INVALID_MCMETA` `OUTPUT_REQUIRED` |
| 3 | validation failed | `VALIDATION_FAILED` `ATLAS_REFERENCE_ERROR` `TEXTURE_NOT_IN_REQUIRED_ATLAS` |
| 4 | filesystem | `FILESYSTEM_ERROR` `OUTPUT_EXISTS` |
| 5 | unsupported | `MCPX_UNSUPPORTED_VERSION` `UNSUPPORTED_IMAGE_FORMAT` `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT` `RESOURCE_LIMIT_EXCEEDED` |

補充說明：

```text
OUTPUT_REQUIRED    屬於 exit 2：這是呼叫端少給參數
TRANSACTION_FAILED 不是獨立 exit：以造成 rollback 的原始 error code 回報
VALIDATION_FAILED  validate 的結果不合格，與工具本身出錯區分
```

`exit 3` 專指「工具正常運作，但素材不合格」。Agent MUST 能靠 exit code 區分「工具壞了」與「素材有問題」。

§61 的清單在此基礎上新增：

```text
INVALID_ARGUMENT
ARGUMENT_CONFLICT
OUTPUT_EXISTS
UNKNOWN_OPERATION
DUPLICATE_OPERATION_ID
INVALID_PROFILE
MCPX_PALETTE_OVERFLOW
RESOURCE_LIMIT_EXCEEDED
VALIDATION_FAILED
INTERNAL_ERROR
```

---

# 100. Determinism 的保證範圍

§32 要求跨 OS 與 runtime 的像素一致。這個承諾 MUST 以實作紀律支撐，否則做不到。

## 100.1 整數優先

V0.1 的全部核心運算（primitives、transform、grid、mcpx、PNG 編碼）MUST 為純整數運算。這類運算跨平台 byte-identical 是可保證的。

## 100.2 浮點與超越函式

`Math.cbrt` / `pow` / `exp` / `sin` 等超越函式在不同 JavaScript 引擎（V8 與 JavaScriptCore）之間**不保證最後一位一致**。色彩量化中，這足以讓落在分界上的像素被分到不同的 palette entry。

因此：

```text
任何影響輸出像素的計算
MUST NOT 直接依賴 Math 的超越函式
```

需要 OKLab、色差、k-means 等演算法時（V0.2 起），MUST 採下列之一：

```text
自備固定實作（明確定義的多項式／查表）
定點數運算
整數 LUT
```

並以 golden test 鎖定。

## 100.3 其他決定性要求

```text
排序      MUST 為全序，不得依賴不穩定排序或物件鍵序
目錄列舉  MUST 先排序再使用
時間      輸出內容 MUST NOT 含時間戳
亂數      MUST 由顯式 seed 導出，MUST NOT 使用 Math.random
報告浮點  MUST 以固定小數位序列化
```

## 100.4 保證範圍宣告

V0.1 的 determinism 保證為：

```text
同 input + 同參數 + 同 mc-asset 版本
→ 跨 macOS / Linux、跨 Bun / Node
→ 輸出檔 byte-identical
```

若某演算法無法提供此保證，MUST 在文件標記，MUST NOT 讓它靜默進入預設路徑。

V0.1 的開發與執行 runtime 為 Bun，但上述保證 MUST 經 CI 實際驗證，不得只是宣告。

## 100.5 跨 runtime 驗證與 Bun 依賴限制

CI MUST 同時在 Bun 與 Node 上執行下列測試子集，並比對輸出：

```text
golden pixel / golden PNG 測試
mcpx canonical serialization 測試
determinism 測試
```

兩個 runtime 的輸出檔 MUST byte-identical。此比對本身 MUST 是 CI 的失敗條件，而不是僅記錄差異。

由此產生兩項實作限制：

```text
1. src/core、src/mcpx、src/io、src/cli
   MUST NOT 依賴 Bun 專有 API
   （檔案 I/O 等一律走 node: 前綴的標準模組）

2. 上述測試子集 MUST 能在兩種 runtime 下執行
   因此不得只依賴 bun:test 專有 API
   需提供可在 node:test 下執行的對等進入點
```

Bun 專有 API MAY 出現在開發腳本與純開發工具中，MUST NOT 出現在會被 V0.6 MCP 層呼叫的 Core 路徑上（§89）。

由於 §100.1 要求 V0.1 全整數運算，跨 runtime 一致在 V0.1 幾乎是免費的；真正的風險從 V0.2 的色彩運算開始，屆時這組 CI 比對就是防線。

---

# 101. PNG Codec 限制

PNG 的讀寫直接決定 §7 與 §75 能不能成立，因此對 codec 有硬性限制。

## 101.1 禁止 premultiplied alpha

Codec 與其後的任何處理 MUST NOT 對像素做 premultiply。

這排除了一整類以 libvips / Skia 為基礎的影像函式庫（包含 `sharp`）出現在 pixel-critical 路徑上：它們的 resize 與 composite 多半在 premultiplied 空間進行，會把 `A = 0` 像素的 RGB 歸零，直接違反 §7。

```text
sharp MUST NOT 用於 decode / encode / resize / composite
若要用於非 pixel-critical 用途，須在決策紀錄中說明
```

V0.1 的 codec 選型以純 JavaScript 實作（例如 `pngjs`）為起點，並 MUST 以 `#FF000000` fixture 實證通過後才定案。

## 101.2 輸入正規化

```text
16-bit → 8-bit    取高 8 bits
palette PNG       依 PLTE / tRNS 展開為 RGBA8
grayscale         展開為 RGBA8
交錯 (interlace)  接受，解碼後視為一般 RGBA8
gAMA / iCCP       忽略，但 SHOULD 於 analyze 回報 warning
```

## 101.3 輸出參數固定

```text
bit depth     8
color type    6 (RGBA)
interlace     none
壓縮等級      固定
filter 策略   固定
輔助 chunk    MUST NOT 寫入時間戳或其他會變動的內容
```

固定這些參數，`mc-asset` 的 PNG 輸出才能 byte-stable（§100.4）。

---

# 102. 資源上限

§69 要求先驗證尺寸再配置 buffer。具體上限如下。

```text
canvas width / height   1 – 4096
layer 數                ≤ 64
region 數               ≤ 256
```

總記憶體估算：

```text
bytes ≈ width × height × (4 × layerCount + regionCount)
```

超過 512 MB MUST 回報：

```text
RESOURCE_LIMIT_EXCEEDED
```

且 MUST 在配置前判斷。

`.mcpx` 另有實務限制：4096×4096 的 grid 會產生約 1,700 萬字元的文字檔，已失去 diff 與人類可讀的意義。因此：

```text
canvas > 512×512 存成 mcpx
→ SHOULD 發出 warning
```

上限本身不是 Minecraft 的格式限制，只是防護性的工程上限（§5）。

---

# 103. Batch Operation 結果格式

§29 的 operation 帶有 `id`，§60 的 JSON envelope 未定義如何回報個別 operation。補充如下。

`id` MAY 省略；若提供，在同一次 batch 中 MUST 唯一，否則回報 `DUPLICATE_OPERATION_ID`。

成功：

```json
{
  "success": true,
  "result": {
    "applied": 3,
    "operations": [
      { "index": 0, "id": "blade-tip", "status": "applied" },
      { "index": 1, "id": "blade-edge", "status": "applied" },
      { "index": 2, "status": "applied" }
    ]
  }
}
```

失敗（atomic = true）：

```json
{
  "success": false,
  "error": {
    "code": "OUT_OF_BOUNDS",
    "message": "Pixel coordinate is outside canvas.",
    "details": {
      "operationIndex": 2,
      "operationId": "guard",
      "x": 18,
      "y": 4,
      "width": 16,
      "height": 16
    }
  },
  "result": {
    "applied": 0,
    "rolledBack": true
  }
}
```

失敗時的 error code MUST 為造成失敗的原始錯誤（此例為 `OUT_OF_BOUNDS`），`details` MUST 指出 `operationIndex`，有 id 時一併帶上 `operationId`。

`atomic = false` 時 MUST 回報每個 operation 的 status，並以 `applied` / `failed` 統計，此時 exit code 取第一個失敗的分類。

---

# 104. 待凍結項目（V0.1 已凍結）

以下項目已在 V0.1 的 CLI 骨架任務中凍結。凍結的命令分工與旗標以 `docs/cli-surface.md` 為準，本節記錄裁決結論。

## 104.1 命令語意（已凍結）

| 命令 | 輸入 | 輸出 | 與相鄰命令的差異 |
|---|---|---|---|
| `import <image>` | Raster 檔（PNG/JPEG/WebP） | PNG 和/或 `.mcpx` | 唯一解碼二進位圖片的入口；文字來源不得走此命令 |
| `render <grid>` | ASCII Grid 檔（`.grid`） | PNG 和/或 `.mcpx` | 唯一讀取手寫/ Agent 創作文字 grid 的入口 |
| `build <source.mcpx>`（亦接受 stdin） | `.mcpx` 來源 | PNG 和/或 `.mcpx` | 唯一以可編輯來源格式本身為輸入的命令 |
| `analyze` | 圖片檔 | 唯讀報告（人類/JSON），無產物檔 | 輸出為 predicted 分類，永不宣稱 effective（§40） |
| `validate` | 素材檔 | 唯讀報告；素材不合格時 exit 3 | exit 3 表「工具正常、素材有問題」，與工具錯誤區分 |

`compose` 不設為 V0.1 命令：無法給出與 layer / batch operations 的清楚差異，依規併除，不保留同義詞。`pixelize` / `quantize` / `cleanup` 留待 V0.2，`validate-pack` 留待 V0.5，`mcp` 留待 V0.6，名稱僅保留。

## 104.2 ASCII Grid / Pixel Spec（已凍結）

- ASCII Grid 副檔名為 `.grid`；`[grid]` compact 與 `[grid tokens]` tokenized 的區分依 §96.8。
- 「Pixel Spec」即 batch operations JSON 本體（§29/§103，`id` 可省略，存在時當次唯一）；不設獨立副檔名，經 `--operations <path>` / stdin 或各命令的輸入 payload 傳遞（由實作命令的任務接線）。
- `.pixel` MUST NOT 作為副檔名出現在任何文件與實作中。

## 104.3 Processing Preset 與 Asset Profile（已凍結，V0.1）

V0.1 只實作 `--profile`，合法值為 `generic` / `minecraft:item` / `minecraft:block`。不設 `--preset` flag；其是否作為獨立 flag 存在延至 V0.2（Pixelizer 進場時）決定。V0.2 的決議見 §105：`pixelize` 加入 `--preset`，值為 `item` / `block` / `generic`。

## 104.4 授權（已凍結）

`mc-asset` 授權為 MIT（`LICENSE` 已建立）。第三方依賴為 `commander` / `pngjs`（`package.json` 已宣告）。開始閱讀任何第三方原始碼之前，MUST 先完成授權相容性評估；本任務未閱讀第三方原始碼。

---

# 105. V0.2 語意與介面凍結

V0.2 的範圍見 §85。命令表面（名稱、旗標、輸入輸出、exit code）以 `docs/cli-surface.md` 為準；語意、演算法與取捨理由的細節以 `docs/v02-design.md` 為準。本節記錄規範性結論，三者衝突時以本節為準。

`--preset` 的存在與否在 §104.3 延至 V0.2 決定：V0.2 在 `pixelize` 上加入 `--preset`，值為 `item` / `block` / `generic`；`gui` / `particle` 隨其 profile 留待 V0.4（§87）。

## 105.1 命令表面

V0.2 新增九個命令：

| 命令 | 輸入 | 輸出 | exit code |
|---|---|---|---|
| `transform <input>` | PNG/JPEG/WebP/`.mcpx` | PNG 和/或 `.mcpx` | 0/2/4/5 |
| `quantize <input>` | PNG/JPEG/WebP/`.mcpx` | PNG 和/或 `.mcpx` | 0/2/4/5 |
| `cleanup <input>` | PNG/JPEG/WebP/`.mcpx` | PNG 和/或 `.mcpx` | 0/2/4/5 |
| `pixelize <image>` | PNG/JPEG/WebP | PNG 和/或 `.mcpx`；Minecraft profile 僅 PNG | 0/2/4/5 |
| `palette extract` / `palette inspect` | PNG/JPEG/WebP/`.mcpx` | 唯讀報告 | 0/2/4/5 |
| `material list` / `material show` | — | 唯讀報告 | 0/2 |
| `recolor <source>` | `.mcpx` | PNG 和/或 `.mcpx` | 0/2/4/5 |
| `variant <source>` | `.mcpx` | `--output-dir` 下的多個 PNG 和/或 `.mcpx` | 0/2/4/5 |
| `analyze <image>`（擴充） | PNG/JPEG/WebP | 唯讀報告 | 0/2/5 |

`pixelize` / `quantize` / `cleanup` / `recolor` / `variant` / `transform` 的名稱在 §104.1 保留給 V0.2，本節正式啟用（§104.1 的「留待 V0.2」即指此）。所有新命令 MUST 遵守 §57、§98：顯式輸出、預設 `OUTPUT_EXISTS`、`--mkdir` 才建父目錄、同目錄暫存加 rename、不得推導檔名或建立預設目錄。

`resize` 與 `crop` 不設為獨立命令，由 `transform` 承載。§48 明言 command tree 可在 CLI 設計階段簡化，此為該簡化的一部分。

## 105.2 Selection

Selection MUST 以矩形或 region mask 表示（§13、§14）。實作 MUST 遵守：

```text
未給 selection            作用範圍為整個 canvas
selection 外像素          操作後 MUST byte-identical，含 A = 0 的 hidden RGB（§7）
selection                  MUST NOT 改變 canvas 尺寸
selection 解析             在第一次改動像素之前完成，單次呼叫共用一個 selection
selection                  MUST NOT 序列化進 .mcpx；跨檔語意一律用 Region
region:<id>                來源需具備 region；id 不存在為 REGION_NOT_FOUND
rect 超出 canvas           OUT_OF_BOUNDS，不得靜默裁切（§31）
```

`--selection` 與 `transform` 的幾何旗標同時出現 MUST 以 `ARGUMENT_CONFLICT` 拒絕，因為幾何操作會改變尺寸。

## 105.3 Transform

`transform` 涵蓋 §28 與 §38 的 `flipHorizontal` / `flipVertical` / `rotate90` / `rotate180` / `rotate270` / `crop` / `pad` / `resize` / `translate`。

```text
一次呼叫         MUST 只帶一個幾何操作；兩個以上為 ARGUMENT_CONFLICT
座標與尺寸       MUST 為整數（§10）；浮點為 INVALID_COORDINATE，不得自動取整
越界             OUT_OF_BOUNDS（§31）
resize 預設      nearest；MUST NOT 預設產生 anti-aliasing（§38）
resize 模式      MUST 為整數運算，不得依賴平台圖形 API（§32）
rotate90 ×4      MUST 回到原圖且 byte-identical
rotate90/270     互為反操作；rotate180 自反
pad 填充         預設 transparent（#00000000，§8）
```

`pixel-aware` 是 §38 列出的名稱，但規格未定義其演算法；V0.2 MUST NOT 讓它以預設身分執行，也 MUST NOT 以其他模式冒充（§100.4、§105.11）。

## 105.4 Quantizer

V0.2 只實作整數 median-cut，切割、比較與平均皆以整數完成。理由與 §100.1 一致，並避免 §100.2 所禁的超越函式依賴。

```text
--colors        必填；整數 1–4096；缺為 INVALID_ARGUMENT
tie-break       MUST 為全序，不得依賴不穩定排序或物件鍵序（§100.3）
色數 >= 實際色數 MUST NOT 改變任何像素
.mcpx 目標      量化後色數超出 §97 容量為 MCPX_PALETTE_OVERFLOW
```

若將來加入 OKLab、色差或 k-means 方法，MUST 以自備固定實作、定點數或整數 LUT 提供，MUST NOT 直接呼叫 `Math.cbrt` / `pow` / `exp`（§100.2），並以 golden test 鎖定。

## 105.5 Cleanup

Cleanup 處理 §35、§63 的七類：`isolated` / `noise` / `cluster` / `fringe` / `outlier` / `hole` / `aa`。

```text
未帶 --fix             只偵測與報告，像素零變動
未帶 --allow-render-pass-change
                       任何會改變 alpha 語意的類別 MUST NOT 套用，且 MUST NOT 寫入任何位元組
outlier                只改 RGB 不動 alpha，不需額外授權
--json                 MUST 回報實際修改統計（§35）
分析結果               MUST 確定性；無時間戳（§100.3）
```

依 §63，所有可能改變 Minecraft rendering semantics 的操作不得預設執行。依 §40，block 的 render pass 由 fully／partially transparent 像素決定，因此動到 alpha 的類別一律需要顯式授權。

## 105.6 Pixelize

管線順序 MUST 固定為下列十一階段，MUST NOT 由旗標改變：

```text
Decode → Crop → Background → Subject → Resize → Edge
→ Quantize → Cluster → Cleanup → Preset → Output
```

```text
--size                   16 / 32 / 64 / 128 或 WxH（§28）
非標準尺寸               MAY 為 NON_STANDARD_RESOLUTION warning，不得為 INVALID_DIMENSION（§45）
--preset                 Processing Preset，決定怎麼處理圖片（§37）
--profile                Asset Profile，決定素材用途；兩者不得互相取代
preset                    MUST 是顯式、具名、可列印的參數組，不得是隱藏啟發式
Minecraft profile 輸出   僅 PNG；其他副檔名為 UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT（§34）
三種輸出模式             PNG / PNG+mcpx / 僅 mcpx（§29）；缺輸出為 OUTPUT_REQUIRED（§57）
```

## 105.7 解碼器選型

V0.2 起接受 §33 的 PNG / JPEG / WebP 輸入。選型 MUST 遵守：

```text
1  支援 PNG / JPEG / WebP 解碼
2  MUST NOT premultiply alpha（§101.1）；A = 0 的 RGB 必須保留（§7、§75）
3  MUST NOT 使用 sharp / libvips / Skia 系（§101.1）
4  MUST 在 Bun 與 Node 皆可執行（§100.5）
5  同輸入在兩 runtime 解出相同 RGBA（§100.4）
6  授權 MUST 與 MIT 相容；評估 MUST 早於閱讀其原始碼（§104.4）
7  輸出 MUST NOT 含時間戳（§100.3、§101.3）
```

`pngjs` 的 PNG 路徑維持不變（§101.1）。JPEG / WebP 的候選名單與評估軸記於 `docs/v02-design.md`；在實證完成前，這兩個輸入 MUST NOT 被宣告可用。

## 105.8 Material 與 Recolor

Material 是 Palette 之上的語意層（§67），MUST NOT 與 Minecraft Palette Texture API 混為一談。

首批內建材料 MUST 為同時出現在 §67 與產品規格書 §32 的七項：`iron` / `copper` / `oxidized_copper` / `gold` / `wood` / `stone` / `crystal`。Palette role 沿用 §15 的字集。

Recolor MUST 支援 Region-aware、Palette Role-aware、Luminance-aware（§68）：

```text
role shadow / dark       → 目標材料 shadow
role base                → 目標材料 base
role light / highlight   → 目標材料 highlight
無 role                  → 以整數 luminance 分三帶映射
outline / accent / custom 保持原樣
```

Luminance MUST 以整數計算（`(299r + 587g + 114b) / 1000` 取整），不得使用浮點或超越函式（§100.1、§100.2）。Recolor MUST NOT 改寫 Region 的 mask（§14），且 region 外的像素 MUST byte-identical。

## 105.9 Analyze 擴充

`analyze` 不修改檔案（§62）。V0.2 在既有欄位上新增 `paletteCharacteristics` / `pixelArtCharacteristics` / `recommended`，舊欄位 MUST NOT 改名或移除。完整 JSON 形狀以 `docs/v02-design.md` 為準。

```text
recommended    MUST 由確定性規則導出，不得來自機器學習或外部服務
數字           整數；比率以固定小數位字串表示（§100.3）
classification MUST 維持 predicted，不得宣稱 effective（§40）
```

## 105.10 接線權責

`src/cli/program.ts`、`src/cli/operations-json.ts` 與 core 的 batch 詞彙是共用接縫，同時修改會互相覆蓋。因此：

```text
純引擎模組   MUST NOT 觸碰上述接縫；各自在模組與單元測試中完成
命令與批次詞彙整合   集中於單一階段，不分散
pixelize → variant → analyze
             共用 program.ts，MUST 依序執行，MUST NOT 並行
```

V0.1 已凍結的行為（`docs/cli-surface.md`）MUST NOT 因 V0.2 接線而改變；新命令沿用既有 CLI helper，不另建一套。

## 105.11 Variant

```text
--output-dir    MUST 顯式；缺為 OUTPUT_REQUIRED，且零檔案（§34、§57、§98）
--output        在 variant 上為 ARGUMENT_CONFLICT
命名規則        <basename>_<material>.<ext>，固定不變
重跑            同材料與同參數 MUST byte-identical
每個檔案        個別套用 OUTPUT_EXISTS、--mkdir 與原子寫入（§98）
```

## 105.12 待決項目

規格無法推定、且會影響對外行為的細節，列於 `docs/v02-design.md` 的待決清單，不在此自行補齊。其中直接影響命令表面或預設行為的有：`resize` / `crop` 是否保留 top-level 別名、`pixel-aware` resize 的演算法、Pixelize preset 的具體數值、`tileFriendly` 的判斷規則、`moveLayer` 的語意、`outline` / `accent` / `custom` 的 recolor 映射、`--colors` 上限、目標材料不存在的 error code，以及 geometry 是否進 `--operations` 批次詞彙。
