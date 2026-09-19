# mc-asset Development References

## 1. 文件目的

本文件整理 `mc-asset` 開發 Agent 可參考的像素繪製工具、開源專案、演算法、像素畫教學與美術規則。

`mc-asset` 的目標不是單純做圖片縮放，而是建立一套 Agent 可操作的 Minecraft 2D Asset Creation Engine，因此參考資料分為兩大方向：

1. **工程與演算法參考**：Pixel Canvas、CLI、Palette、Dithering、Scaling、Rotation、Animation、Tile、Validation。
2. **像素美術規則參考**：Pixel Cluster、Banding、Anti-aliasing、Palette、Hue Shifting、Shading、Outline、Tile、Silhouette 等。

開發時應優先理解概念與演算法，再依專案授權條款決定是否能直接參考或整合程式碼。

> **前置條件**：`mc-asset` 自身的授權尚未選定。在閱讀任何第三方原始碼之前，必須先決定本專案授權並建立 `LICENSE`，否則沒有判斷相容性的基準（見 `project-detail.md` §104.4）。
>
> 本文件所有連結於 2026-09-19 查證可達，唯一修正為 Pixelorama 文件網址。

---

# 2. 第一優先：直接影響 mc-asset 架構的工具

## 2.1 DataPixels.js

Repository:

https://github.com/gmattie/Data-Pixels

用途：

- 研究用二維矩陣描述 Pixel Image 的方法
- 研究 RGBA Pixel representation
- 研究 programmatic pixel authoring
- 可作為 `PixelCanvas` 與 ASCII/Grid authoring 的最小概念參考

DataPixels 的核心概念與 `mc-asset` 很接近：

```text
Pixel Matrix
↓
Canvas / Image
```

而 `mc-asset` 會進一步擴展成：

```text
PixelCanvas
├── Layer
├── Region
├── AuthoringPalette
├── Batch Operations
└── Minecraft Asset Profile
```

建議開發 Agent 優先閱讀。

---

## 2.2 Pixelorama

Repository:

https://github.com/Orama-Interactive/Pixelorama

Documentation:

https://orama-interactive.github.io/Pixelorama-Docs/

重點研究：

- Pixel-perfect drawing
- Pixel-perfect line
- Pixel Art rotation
- Pixel Art scaling
- Tile workflow
- Palette
- Layer
- Posterize
- Dithering
- Offset wrap-around
- Pixel-specific image transformation

特別值得搜尋的實作：

```text
cleanEdge
OmniScale
rotxel
pixel perfect
tile mode
posterize
palette
```

Pixelorama 支援多種 Pixel-Art-specific transformation，例如：

```text
Nearest Neighbor
Rotxel
Rotxel with Smear
cleanEdge
OmniScale
Upscale → Rotate → Downscale
```

這些非常適合用來設計：

```text
mc-asset transform rotate
mc-asset resize --mode pixel-aware
mc-asset tile
```

Pixelorama 是 `mc-asset` 最值得深入閱讀原始碼的專案之一。

---

## 2.3 pixelize

Repository:

https://github.com/noelruault/pixelize

用途：

- Reference Image → Pixel Art
- Palette extraction
- Color quantization
- RGB / OKLab color matching
- Floyd-Steinberg dithering
- Terminal preview
- JSON statistics
- CLI / Core Library 分離

值得研究的 pipeline：

```text
Image
↓
Resize
↓
Palette Extraction
↓
PCA-divisive initialization
↓
Weighted K-means
↓
RGB / OKLab Color Matching
↓
Dithering
↓
Pixel Output
```

特別適合作為：

```text
mc-asset pixelize
mc-asset quantize
mc-asset palette extract
```

的演算法參考。

需要保持 deterministic output。

---

## 2.4 Piskel

Repository:

https://github.com/piskelapp/piskel

用途：

- JavaScript Pixel Editor 架構
- Frame
- Animation
- Sprite Sheet
- Canvas
- Timeline
- Browser-based pixel editing

對 `mc-asset` 最值得研究：

```text
Frame abstraction
Sprite sheet packing
Animation workflow
Canvas operations
```

未來 `FrameSet` 與 Animation Engine 可以參考其資料模型。

---

## 2.5 LibreSprite

Repository:

https://github.com/LibreSprite/LibreSprite

重點：

- Layers
- Frames
- Palette
- Tiled drawing
- Filled contour
- Polygon
- Shading mode
- Pixel drawing primitives

用途：

作為傳統 Pixel Editor 的功能與 UI / API 行為參考。

注意其授權為 GPLv2。若要直接整合程式碼，需要先確認授權相容性。

---

## 2.6 GrafX2

Repository:

https://github.com/miniupnp/grafx2

用途：

- Low-color graphics
- Palette-driven workflow
- Pixel Art editing
- Traditional indexed-color workflow

適合研究：

```text
Indexed palette
Low-color image representation
Palette manipulation
Classic pixel-art drawing operations
```

---

# 3. Aseprite

Official Repository:

https://github.com/aseprite/aseprite

Image API:

https://www.aseprite.org/api/image

CLI Documentation:

https://www.aseprite.org/docs/cli/

Tiled Mode:

https://www.aseprite.org/docs/tiled-mode/

Rotation:

https://www.aseprite.org/docs/rotate/

RotSprite implementation:

https://github.com/aseprite/aseprite/blob/main/src/doc/algorithm/rotsprite.cpp

Aseprite 是成熟 Pixel Editor 的重要設計參考。

值得研究：

```text
drawPixel
getPixel
pixels()
drawImage
resize
palette replacement
indexed color
ordered dithering
Bayer dithering
sprite sheet
layers
tile mode
RotSprite
```

對 `mc-asset` 可參考：

```text
Pixel Canvas API
CLI command design
Palette handling
Sprite sheet export
Tile workflow
Pixel-aware rotation
```

注意：

Aseprite 主 repository 使用其自己的 EULA。不要直接大量複製原始碼。

只有明確標示為 MIT 或其他相容授權的檔案，才可依其授權條件考慮使用。

開發 Agent 應優先研究：

```text
API design
CLI behavior
algorithm concepts
documentation
```

而不是直接搬運程式碼。

---

# 4. Image → Pixel Art 的其他演算法參考

## 4.1 pixel-artist

Repository:

https://github.com/alexpnt/pixel-artist

簡單 pipeline：

```text
Image
↓
切成固定區塊
↓
計算平均顏色
↓
Palette Mapping
↓
Pixel Art
```

支援 RGB / Lab。

適合作為 `mc-asset pixelize` 最基本 baseline。

可以先實作簡單版本，再與進階 quantizer 比較。

---

## 4.2 dither-cli

Repository:

https://github.com/ReScienceLab/dither-cli

注意：dithering 演算法在 V0.2 的 Quantizer 才會進場，且任何涉及色彩空間轉換的實作都必須遵守 `project-detail.md` §100.2 的浮點政策（不得直接依賴 `Math` 的超越函式）。

研究：

```text
Ordered dithering
Error diffusion
Threshold dithering
Random dithering
Palette comparison
```

適合建立 `mc-asset` Dithering Engine。

---

# 5. 像素畫教學入口

## 5.1 Lospec Pixel Art Tutorials

https://lospec.com/pixel-art-tutorials

Lospec 是 Pixel Art 教學索引，包含大量不同作者的教學。

開發 Agent 不需要全部讀完，應集中在以下主題：

```text
clusters
banding
anti-aliasing
selective outlining
dithering
palette
hue shifting
shading
tiles
texture
silhouette
```

---

# 6. Pixel Cluster

Lospec Cluster Tutorials:

https://lospec.com/pixel-art-tutorials/tags/clusters

核心概念：

好的 Pixel Art 通常不是大量隨機獨立 Pixel，而是由有意義的 Pixel Cluster 組成。

Agent 應理解：

```text
single pixel noise
connected clusters
cluster size
cluster shape
cluster readability
```

未來可轉成：

```text
isolated_pixel_count
cluster_count
average_cluster_size
single_pixel_cluster_ratio
```

這些值應作為 analysis signal，而不是絕對品質分數。

---

# 7. Banding

Lospec:

https://lospec.com/pixel-art-tutorials/tags/banding

Banding 通常指兩條或多條 Pixel Edge 不自然地平行排列，使圖像產生階梯狀或條帶感。

未來可以研究：

```text
parallel edge detection
repeated staircase pattern
adjacent contour alignment
```

並建立：

```text
banding_score
```

但應以 Warning / Analysis Signal 呈現，不應自動修改。

---

# 8. Anti-aliasing

Lospec:

https://lospec.com/pixel-art-tutorials/anti-aliasing-by-st0ven

Pixel Art 的 Anti-aliasing 和一般 Raster Anti-aliasing 不完全相同。

需要區分：

```text
intentional pixel-art AA
automatic blurry AA
semi-transparent fringe
subpixel smoothing artifact
```

`mc-asset cleanup` 不應把所有 Anti-alias Pixel 都視為錯誤。

尤其 Minecraft Texture 的 Alpha 可能直接影響渲染行為。

可分析：

```text
anti_alias_pixel_count
semi_transparent_edge_count
```

---

# 9. Selective Outlining

Lospec:

https://lospec.com/pixel-art-tutorials/tags/selectiveoutlining

研究：

```text
silhouette outline
internal outline
colored outline
selective outline
light-facing edge
shadow-facing edge
```

可轉成：

```text
outline detector
outline recolor
silhouette enhancement
```

對 Minecraft Item Texture 特別有用。

---

# 10. Dithering

Lospec:

https://lospec.com/pixel-art-tutorials/tags/dithering

研究：

```text
checker dithering
ordered dithering
Bayer matrix
Floyd-Steinberg
density
pattern regularity
```

`mc-asset` 可以提供：

```text
none
ordered
bayer2
bayer4
bayer8
floyd-steinberg
```

Analysis 可以提供：

```text
dither_density
dither_regularity
```

但不要把 dithering 多寡直接當成品質好壞。

---

# 11. Palette

Lospec:

https://lospec.com/pixel-art-tutorials/tags/palette

研究：

```text
limited palette
value separation
color relationship
accent color
shadow / base / highlight roles
```

這直接對應 `AuthoringPalette`：

```text
outline
shadow
dark
base
light
highlight
accent
```

可支援：

```text
palette extraction
palette reduction
palette role assignment
palette distance analysis
```

---

# 12. Hue Shifting

Lospec:

https://lospec.com/pixel-art-tutorials/tags/hueshifting

重要概念：

Pixel Art 的 Shadow / Highlight 不應只做：

```text
RGB - 20
RGB + 20
```

更自然的方式通常會同時調整：

```text
Hue
Saturation
Lightness / Value
```

因此 Material System 應支援：

```text
shadow hue
base hue
highlight hue
```

Recolor Engine 應避免只使用 Hue Shift 或 Brightness Shift。

---

# 13. Shading

Lospec:

https://lospec.com/pixel-art-tutorials/tags/shading

研究：

```text
light direction
form shading
material response
cluster-based shading
highlight placement
shadow shape
```

Material System 可以包含：

```text
light direction
contrast
highlight strength
shadow bias
cluster size
```

例如：

```text
metal
wood
stone
cloth
crystal
```

應有不同 shading rule。

---

# 14. Seamless Tile

Pedro Medeiros / Lospec:

https://lospec.com/pixel-art-tutorials/making-tiles-by-pedro-medeiros

對 Minecraft Block Texture 特別重要。

研究：

```text
edge continuity
corner continuity
large feature repetition
pattern repetition
visual seams
```

`mc-asset Tile Engine` 可提供：

```text
horizontal_seam_score
vertical_seam_score
corner_seam_score
repetition_score
```

以及：

```text
2x2 preview
4x4 preview
8x8 preview
```

工具應能支援 Wrap-around editing / offset preview。

---

# 15. UI / Nine-Slice

Lospec Tiles:

https://lospec.com/pixel-art-tutorials/tags/tiles

Minecraft GUI 現代資源格式支援 Nine-Slice。

Pixel Art UI 研究應包含：

```text
corner preservation
edge repeat
center stretch
border thickness
pixel consistency
```

未來可以提供：

```text
mc-asset gui preview
```

用於模擬：

```text
stretch
tile
nine-slice
```

---

# 16. Saint11 / Pedro Medeiros

Official:

https://saint11.org/blog/pixel-art-tutorials/

這組教學非常適合轉成 Agent 美術規則。

重點主題：

```text
Shading
Outlines
Tiles
Animation
Fabric
Effects
Characters
1-bit art
```

開發 Agent 應嘗試把教學轉換為可執行 heuristic，而不是只記住圖例。

例如：

```text
Avoid isolated pixels unless intentional.

Prefer coherent clusters over random noise.

Highlights should reinforce form instead of tracing every edge.

Low-resolution assets should prioritize silhouette readability
over small internal details.

Large tile features should not terminate abruptly at tile edges.

Shadow and highlight colors may hue-shift instead of only changing brightness.
```

這些規則可以成為 `analyze` 或 Agent prompt 的基礎。

---

# 17. 建議的 mc-asset Analysis Metrics

以下是值得研究的分析訊號。

## Pixel / Cluster

```text
isolated_pixel_count
cluster_count
average_cluster_size
median_cluster_size
single_pixel_cluster_ratio
largest_cluster_ratio
```

## Palette

```text
palette_size
dominant_color_count
palette_role_distribution
nearest_palette_distance
color_entropy
```

## Edge

```text
edge_jaggedness
banding_score
anti_alias_pixel_count
semi_transparent_edge_count
```

## Silhouette

```text
silhouette_connectivity
silhouette_fill_ratio
silhouette_fragment_count
bounding_box_fill_ratio
```

## Tile

```text
horizontal_seam_score
vertical_seam_score
corner_seam_score
repetition_score
```

## Contrast

```text
local_contrast
global_contrast
value_range
```

## Dithering

```text
dither_density
dither_regularity
```

## Alpha

```text
opaque_pixel_count
transparent_pixel_count
partial_alpha_count
partial_alpha_values
```

這些數值應是：

```text
Analysis Signals
```

而不是單純：

```text
Good / Bad Score
```

---

# 18. Minecraft-specific Pixel Art 參考

16×16 Minecraft Texture Guide:

https://www.mctoolhub.com/en/blog/minecraft-texture-16x16-pixel-art-guide

可以參考：

```text
native resolution drawing
limited palette
pixel clusters
transparency
seamless texture
in-game testing
```

但不要使用這類第三方文章定義 Minecraft 格式規則。

格式與相容性規則仍應以 Mojang 官方 release notes / technical changes 為準。

---

# 19. 舊 Minecraft Texture Guide

Minecraft Forum:

https://www.minecraftforum.net/forums/mapping-and-modding-java-edition/resource-packs/resource-pack-discussion/1256366-the-all-inclusive-updated-guide-to-texturing

這份資料年代較舊。

適合參考：

```text
Texture composition
16×16 design thinking
Visual readability
Block texture style
```

不適合拿來決定：

```text
modern atlas behavior
resource pack version
current JSON format
modern item definitions
modern GUI metadata
```

---

# 20. 開發 Agent 建議閱讀順序

## Phase 1：Pixel Canvas 基礎

第一個閱讀：

```text
DataPixels.js
```

目標：

理解：

```text
Pixel Matrix
RGBA
Programmatic Pixel Drawing
```

---

## Phase 2：Pixel Editor 演算法

閱讀：

```text
Pixelorama
```

目標：

```text
Pixel-perfect line
Pixel-aware resize
Rotation
Tile
Palette
Layer
```

---

## Phase 3：Reference Image → Pixel Art

閱讀：

```text
pixelize
pixel-artist
dither-cli
```

目標：

```text
Color Quantization
Palette Extraction
OKLab
Dithering
Downsampling
Determinism
```

---

## Phase 4：成熟 Pixel Editor API

閱讀：

```text
Aseprite API
Aseprite CLI
Aseprite Tiled Mode
Aseprite RotSprite
```

目標：

```text
API design
CLI ergonomics
Layer workflows
Sprite sheet workflows
Tile editing
```

注意授權。

---

## Phase 5：Animation

閱讀：

```text
Piskel
```

目標：

```text
Frame abstraction
FrameSet
Sprite sheet
Animation timeline
```

---

## Phase 6：Pixel Art 美術規則

閱讀：

```text
Lospec
Saint11 / Pedro Medeiros
```

優先主題：

```text
Clusters
Banding
Anti-aliasing
Palette
Hue Shifting
Shading
Selective Outlining
Tiles
```

---

# 21. 建議開發 Agent 不要做的事情

不要因為某個 Pixel Editor 有大量功能，就試圖全部複製。

`mc-asset` 不是：

```text
Aseprite replacement
Pixelorama replacement
Photoshop replacement
```

應聚焦：

```text
Agent-controllable Pixel Asset Creation Engine
```

核心需求優先順序：

```text
PixelCanvas
Pixel Operations
ASCII / Batch Authoring
Reference Pixelization
Palette
Cleanup
Tile
Recolor
Minecraft Asset Profile
Validation
```

---

# 22. 授權注意事項

開發 Agent 在參考原始碼前必須確認 License。

大致原則：

```text
MIT / BSD / Apache
→ 通常適合研究與依授權整合

GPL
→ 可以研究，但直接整合可能影響整體授權

Aseprite EULA
→ 不要直接大量複製程式碼
```

已知授權：

| 專案 | 授權 | 可否整合程式碼 |
|---|---|---|
| Pixelorama | MIT | 依授權可整合 |
| Piskel | Apache-2.0 | 依授權可整合 |
| pixelize | MIT | 依授權可整合 |
| pixel-artist | MIT | 依授權可整合 |
| dither-cli | MIT | 依授權可整合 |
| LibreSprite | GPL-2.0 | 僅研究，整合會傳染授權 |
| GrafX2 | GPL-2.0 | 僅研究 |
| DataPixels.js | 未在 GitHub metadata 標示 | 引用前必須先確認 repo 內的授權聲明 |
| Aseprite | 自有 EULA | 僅研究概念與 API 設計 |

授權資料查證日期 2026-09-19，來源為各 repository 的 GitHub metadata。實際引用前仍必須覆核該專案當下的 LICENSE 檔案。

任何第三方演算法或程式碼若直接採用，都應保留必要的：

```text
License
Copyright
Attribution
```

並確認與 `mc-asset` 預定授權相容。

---

# 23. 參考資料總表

## 工程 / 原始碼

DataPixels.js  
https://github.com/gmattie/Data-Pixels

Pixelorama  
https://github.com/Orama-Interactive/Pixelorama

Pixelorama Documentation  
https://orama-interactive.github.io/Pixelorama-Docs/

pixelize  
https://github.com/noelruault/pixelize

Piskel  
https://github.com/piskelapp/piskel

LibreSprite  
https://github.com/LibreSprite/LibreSprite

GrafX2  
https://github.com/miniupnp/grafx2

pixel-artist  
https://github.com/alexpnt/pixel-artist

dither-cli  
https://github.com/ReScienceLab/dither-cli

Aseprite  
https://github.com/aseprite/aseprite

Aseprite Image API  
https://www.aseprite.org/api/image

Aseprite CLI  
https://www.aseprite.org/docs/cli/

Aseprite Tiled Mode  
https://www.aseprite.org/docs/tiled-mode/

Aseprite Rotation  
https://www.aseprite.org/docs/rotate/

Aseprite RotSprite  
https://github.com/aseprite/aseprite/blob/main/src/doc/algorithm/rotsprite.cpp

## Pixel Art 教學

Lospec Tutorials  
https://lospec.com/pixel-art-tutorials

Clusters  
https://lospec.com/pixel-art-tutorials/tags/clusters

Banding  
https://lospec.com/pixel-art-tutorials/tags/banding

Anti-aliasing  
https://lospec.com/pixel-art-tutorials/anti-aliasing-by-st0ven

Selective Outlining  
https://lospec.com/pixel-art-tutorials/tags/selectiveoutlining

Dithering  
https://lospec.com/pixel-art-tutorials/tags/dithering

Palette  
https://lospec.com/pixel-art-tutorials/tags/palette

Hue Shifting  
https://lospec.com/pixel-art-tutorials/tags/hueshifting

Shading  
https://lospec.com/pixel-art-tutorials/tags/shading

Making Tiles  
https://lospec.com/pixel-art-tutorials/making-tiles-by-pedro-medeiros

Saint11 Pixel Art Tutorials  
https://saint11.org/blog/pixel-art-tutorials/

## Minecraft 補充

Minecraft 16×16 Texture Guide  
https://www.mctoolhub.com/en/blog/minecraft-texture-16x16-pixel-art-guide

Older Minecraft Texture Guide  
https://www.minecraftforum.net/forums/mapping-and-modding-java-edition/resource-packs/resource-pack-discussion/1256366-the-all-inclusive-updated-guide-to-texturing

---

# 24. 開發原則總結

開發 Agent 應從現有專案吸收：

```text
演算法
API abstraction
資料模型
CLI ergonomics
Pixel Art principles
```

而不是直接把多個 Pixel Editor 拼成 `mc-asset`。

`mc-asset` 最重要的差異仍然是：

```text
Agent-first
+
Pixel-native
+
Minecraft-aware
+
Deterministic
+
CLI-first
```

最終目標不是讓 Agent「呼叫一個圖片濾鏡」。

而是讓 Agent 能夠：

```text
看懂 Pixel
建立 Pixel
修改 Pixel
分析 Pixel
從 Reference 取得 Pixel
理解 Minecraft Texture 的用途
驗證輸出的 Asset
```

並以最少的工具呼叫完成完整 Minecraft 2D Asset workflow。
