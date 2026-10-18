# MCP 服务器指南（mc-asset）

[English](mcp-guide.md) | [繁體中文](mcp-guide.zh-TW.md) | [简体中文](mcp-guide.zh-CN.md)

## 目录

- [安装与注册服务器](#安装与注册服务器)
- [工具](#工具)
- [失败时如何返回](#失败时如何返回)
- [限制与缺口](#限制与缺口)

---

`mc-asset mcp` 会启动 stdio MCP 服务器：stdout 只输出 MCP JSON-RPC，诊断信息走 stderr，stdin 关闭时进程退出。已冻结的接口（二十七个工具名称、各自的输入，以及读写契约）记录在 `docs/mcp-surface.zh-CN.md`，输入字段则冻结在 `src/mcp/schema.ts`。本指南涵盖注册方式、每个工具一份捕获（图片字节在注明处截短显示，不作原样引用）、错误模型与限制。

服务器直接挂在 Core 上，所以每个工具都跑与 CLI 命令相同的引擎。像素级的创作，通过 ASCII Grid 文档、批处理操作数组，或内联返回的可编辑 `.mcpx` 源码来完成；刻意不提供 `set_pixel` 工具。

## 安装与注册服务器

先安装包，再让 MCP 客户端指向 `npx -y mc-asset mcp`。三种安装路径都可以：

- **npm（推荐）**：直接从 registry 运行 `npx -y mc-asset mcp`，或全局安装 CLI：`npm install -g mc-asset`。
- **Homebrew（macOS / Linux）**：`brew tap smile-minecraft/tap && brew install smile-minecraft/tap/mc-asset`，之后使用 `mc-asset` 命令。
- **源码**：`bun install --frozen-lockfile && bun run build`，然后运行 `./bin/mc-asset.js mcp`。

无论用哪种方式安装，服务器命令固定是 `npx -y mc-asset mcp`。各客户端的配置文件名称不同，也可能随版本调整；不确定时，请查阅该客户端自己的文档。以下注册示例均为 stdio。

**Claude Code**

```sh
claude mcp add mc-asset -- npx -y mc-asset mcp
```

**Claude Desktop** — `claude_desktop_config.json`：

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

**Cursor** — `.cursor/mcp.json`：

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

**VS Code** — `.vscode/mcp.json`：

```json
{
  "servers": {
    "mc-asset": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mc-asset", "mcp"]
    }
  }
}
```

**Cline** — `cline_mcp_settings.json`：

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

**OpenCode** — `~/.config/opencode/opencode.jsonc`：

```jsonc
"mc-asset": {
  "type": "local",
  "command": ["npx", "-y", "mc-asset", "mcp"],
  "enabled": true
}
```

然后完整重启客户端。MCP 服务器在启动时加载，配置改了却没重启，什么都证明不了。要回滚时，移除该条目（或还原配置备份）并再重启一次。

以下捕获通过 MCP 客户端 SDK 在一个演示工作目录中执行，其中所有路径都相对于该目录，只有 `inspect_asset` 的结构捕获直接指向仓库内的 fixture `tests/cli/fixtures/sword.mcpx`。原有七个工具的捕获取自已安装的版本，后续新增的工具则取自本地源码服务器——两者执行的是同一份服务器代码。

## 工具

| 工具索引 | | |
|---|---|---|
| [`analyze_asset`](#analyze_asset) | [`pixelize_asset`](#pixelize_asset) | [`render_pixel_asset`](#render_pixel_asset) |
| [`apply_asset_operations`](#apply_asset_operations) | [`recolor_asset`](#recolor_asset) | [`create_variants`](#create_variants) |
| [`validate_asset`](#validate_asset) | [`import_asset`](#import_asset) | [`build_asset`](#build_asset) |
| [`transform_asset`](#transform_asset) | [`quantize_asset`](#quantize_asset) | [`cleanup_asset`](#cleanup_asset) |
| [`palette_asset`](#palette_asset) | [`material_asset`](#material_asset) | [`tile_asset`](#tile_asset) |
| [`generate_asset`](#generate_asset) | [`preview_asset`](#preview_asset) | [`scale_gui_asset`](#scale_gui_asset) |
| [`animate_asset`](#animate_asset) | [`validate_pack_asset`](#validate_pack_asset) | [`inspect_asset`](#inspect_asset) |
| [`optimize_asset`](#optimize_asset) | [`model_asset`](#model_asset) | [`mcmeta_asset`](#mcmeta_asset) |
| [`compare_assets`](#compare_assets) | [`style_asset`](#style_asset) | [`pack_asset`](#pack_asset) |

### analyze_asset

针对位图的只读报告，绝不写入。调用时带 `path`，另可选带 `profile`、`minecraftVersion` 或 `resourcePackVersion`。

调用：

```json
{"path":"px-8x8.png"}
```

结果（原样；`dominantColors` 数组在 8 个条目中只保留第一个，其余每项都是 `count` 1、`ratio` "0.0156"）：

```text
{"dimensions":{"width":8,"height":8},"totalPixels":64,"colorCount":64,"alpha":{"predictedClassification":"translucent","opaquePixels":62,"transparentPixels":1,"partialAlphaPixels":1,"partialAlphaValues":[128],"opaqueRatio":"0.9688","transparentRatio":"0.0156","partialAlphaRatio":"0.0156","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"dominantColors":[{"hex":"#03ED20FF","r":3,"g":237,"b":32,"a":255,"count":1,"ratio":"0.0156"} … 7 more entries, each count 1 / ratio "0.0156" …]}
```

分类只依据 PNG 字节预测，从不代表游戏内的实际渲染结果，这与 CLI 的提示相同。

### pixelize_asset

让参考位图跑过确定性的像素化管线。输入必须是 PNG、JPEG 或 WebP，不能是 `.mcpx`。调用必须带 `size`（`16`、`32`、`64`、`128` 或 `WxH`），省略会报告 `INVALID_ARGUMENT`。`preset` 为可选。

调用：

```json
{"inputPath":"px-8x8.png","size":"16","preset":"item","outputPngPath":"out/pixelize16.png"}
```

结果（原样；只给了 PNG 路径，所以 `.mcpx` 文本内联返回，调色板块与结尾已截短）：

```text
{"profile":"generic","preset":"item","presetDetail":"preset=item colors=16 edge=128 cluster=8 cleanup=outlier (item: tight 16-color budget with crop, background, subject, edge 128, cluster 8, outlier cleanup)","width":16,"height":16,"colors":16,"colorCount":16,"stages":[{"stage":"decode","status":"applied","reason":"decoded by the caller"},{"stage":"crop","status":"not-needed","reason":"content fills the full frame"},{"stage":"background","status":"not-needed","reason":"outer ring has no opaque majority at 90 percent coverage"},{"stage":"subject","status":"not-needed","reason":"subject already centered"},{"stage":"resize","status":"applied","reason":"nearest resize to 16x16"},{"stage":"edge","status":"applied","reason":"hardened 4 edge pixels at threshold 128"},{"stage":"quantize","status":"applied","reason":"median-cut at 16 colors, 16 kept"},{"stage":"cluster","status":"not-needed","reason":"no colors merged"},{"stage":"cleanup","status":"applied","reason":"cleanup outlier"},{"stage":"preset","status":"applied","reason":"recorded preset item"},{"stage":"output","status":"applied","reason":"encoded by the caller"}],"warnings":[],"output":"out/pixelize16.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n0 = #175754FF\n… 15 more palette entries (1–F); the last is F = #DDA5DEFF …\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[gr… (truncated) …"}
```

### render_pixel_asset

将手写的 ASCII Grid 渲染为 PNG 字节和／或 `.mcpx`。`gridText`（内联文档）与 `gridPath`（`.grid` 文件）恰好传一个；两个都传是 `ARGUMENT_CONFLICT`，都不传是 `INVALID_ARGUMENT`。可选的 `operations` JSON 字符串会在 grid 解析完成后应用。

调用：

```json
{"gridText":"[palette]\n. = transparent\nS = #ADB7C0FF\n\n[grid]\n.SS.\nSSSS\nSSSS\n.SS.\n","outputPngPath":"out/render.png"}
```

结果（原样；没有给 `.mcpx` 路径，所以内联 `mcpxText`）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"width":4,"height":4,"output":"out/render.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nS = #ADB7C0FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.SS.\nSSSS\nSSSS\n.SS.\n"}
```

### apply_asset_operations

一次调用，把一批 Core 像素／图层／区域操作应用到 `.mcpx` 源码。`sourcePath` 必须以 `.mcpx` 结尾；`atomic` 默认为 true，所以第一个失败就会回滚整批。

调用：

```json
{"sourcePath":"sword.mcpx","operations":[{"type":"setPixel","x":0,"y":0,"color":"#FF0000FF"},{"type":"fillRect","rect":{"x":1,"y":1,"width":2,"height":2},"color":"#00FF00FF"}],"outputMcpxPath":"out/applied.mcpx","outputPngPath":"out/applied.png"}
```

结果（原样；两个输出路径都给了，所以两种产物都不内联）：

```text
{"applied":2,"failed":0,"operations":[{"index":0,"status":"applied"},{"index":1,"status":"applied"}],"warnings":[],"output":"out/applied.png","source":"out/applied.mcpx"}
```

不带 `feedback` 时，上面的形状是冻结的：`applied`、`failed`、逐个操作的 `operations` 数组、`warnings`，再加上 PNG 与源码产物（显式路径，或内联的 `pngBase64`／`mcpxText`）。`feedback` 是可选的，只会往上叠加内容——不传 `feedback`，输出字段与字节就和以前完全一致。

`feedback` 有四个字段：`image`（`none`／`full`／`changed`）、`scale`（整数 1–16）、`crop`（选择表达式）、`diff`（`none`／`summary`）：

- `image: "none"`（默认）只返回标志，不带图。`"full"` 渲染整个裁剪范围；`"changed"` 忽略 `crop`，只渲染合成后发生变化的外框，画面完全没动时改报 `noVisibleChange: true`，不附图。`crop` 配 `none` 是 `INVALID_ARGUMENT`。
- 附图永远不会以 `pngBase64` 内联：它以第二个标准图片内容块发出（`type: "image"`、`mimeType: "image/png"`），文本块里不会留一份重复字节。
- 省略 `scale` 时，只按缩放前的长边自动放大：长边不足 128 才向 128 放大，上限 16。输出边长超过 1024px 会以 `RESOURCE_LIMIT_EXCEEDED` 拒绝，不会悄悄缩图。辅助像素（网格、棋盘格）永远不会混入作品字节。
- `diff: "summary"` 会追加 `raw`／`composited`／`structural`，以及 `outsideSelectionUnchanged`——选择范围外的每个像素都逐字节保留（含 alpha 0 之下隐藏的 RGB）时为 true。
- `atomic: false` 会跑完每个操作、保留成功的部分：结果照常逐个报告成功／失败（例如 `applied: 1, failed: 1`），不会整体回滚，配 `changed` 图片或 diff 摘要也一样。

像素操作都可以带可选的 `selection`：只有选中的像素会被写入，其余全部逐字节还原。选择可以写原子——`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`——或 JSON AST 对象（`{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`），深度上限 32、节点上限 1024。选择落空时以 `EMPTY_SELECTION` 拒绝写入并回滚整批。

像素词汇共九个操作，新增的三个形状是：`ellipse`（`rect` 的内切椭圆；`mode` 必填，`fill` 或 `outline`）、`polygonFill`（填充 `points` 指定的多边形）、`strokeMask`（沿 `layerId` 上 `source` 选择范围的读取轮廓描边，不涂抹范围本身）。`polygonFill` 最多 4096 个点，超出是 `RESOURCE_LIMIT_EXCEEDED`；自交的环是 `SELF_INTERSECTING_POLYGON`，不支持挖洞。

`outline` 是第二十六种操作：它为单个 `layerId` 上非全透明的像素描边，可画在本体边缘（`inside`，默认）或贴着本体的空像素（`outside`），共五种模式——`tinted` 在整数 HSL 空间调暗相邻本体色、`selective` 只画背光面（光源在左上）、`uniform` 用必填的 `#RRGGBB` 颜色填满、`black` 填满不透明纯黑、`strip` 把已有外框换成相邻内部色而不改变本体大小。`color` 只属于 `uniform`；`family` 指定十二个内建家族之一，在 `snapFamilies` 为 true 时把推导色对齐内建原版色阶。它接受同样的可选 `selection`；完整的分类型参数表在 `docs/cli-surface.zh-CN.md` 的批处理操作规格节。

附图示例——一个变化像素加摘要（截短显示，非原样引用；图片数据省略）：

调用：

```json
{"sourcePath":"sword.mcpx","operations":[{"type":"setPixel","layerId":"base","x":0,"y":0,"color":"#FF0000FF"}],"feedback":{"image":"changed","diff":"summary"}}
```

结果：文本块带 `applied: 1, failed: 0`，raw 与合成各一个变化像素，`outsideSelectionUnchanged: true`；图片以第二个 `type: "image"`、`mimeType: "image/png"` 块送达：

```text
{"applied":1,"failed":0,"operations":[{"index":0,"status":"applied"}],"warnings":[],"feedback":{"image":"changed","imageIncluded":true,"diff":{"raw":{"changedPixels":1 …},"composited":{"changedPixels":1 …},"structural":…,"outsideSelectionUnchanged":true}},"mcpxText":"mcpx 1\n… (truncated) …"}
[second block: {"type":"image","mimeType":"image/png","data":"… (omitted) …"}]
```

### recolor_asset

用一个内置材质 id 或调色板家族 id，给 `.mcpx` 源码的每个图层重新着色，或以同样方式重映射扁平 PNG；可选的 `region` 可把写入限定在单个区域。`material` 与 `family` 恰好传一个（都不传报告 `INVALID_ARGUMENT`，都传是 `ARGUMENT_CONFLICT`）。`style` 默认为 `vanilla`，可选的 `selection` 限定写入范围。材质路径下，PNG 按整数明度分段映射到目标调色板（96 以下为暗部、96 到 159 为中间、160 以上为亮部）。家族路径下（`family`），带 role 的来源按同名 role 直接对应，`accent` 与 `custom` 按六段整数明度分段处理；平面 PNG 按六段整数明度分段对应（<43 outline、43–85 shadow、86–127 dark、128–170 base、171–213 light、≥214 highlight）；外框像素一律强制改写为目标家族的 `outline` 色；全透明像素保持字节不变，包含隐藏 RGB；半透明像素强制覆写为完全不透明调色板色。JPEG 与 WebP 仍会被拒绝（`INVALID_ARGUMENT`），缺失区域沿用既有的 `REGION_NOT_FOUND` 错误。

调用：

```json
{"sourcePath":"sword.mcpx","material":"iron","outputPngPath":"out/sword_iron.png"}
```

结果（原样；只给了 PNG 路径，所以重新着色后的 `.mcpx` 文本内联返回）：

```text
{"profile":"generic","material":"iron","pixelsChanged":12,"warnings":[],"output":"out/sword_iron.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n0 = #5A6068FF\n1 = #9AA1A9FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.00.\n0110\n0110\n.00.\n"}
```

### create_variants

把一份 `.mcpx` 源码或扁平 PNG 展开到显式指定的 `outputDir` 下，每种材质或家族生成一份 PNG 加一份 `.mcpx`，每份都从原始源码开始，因此顺序不影响结果。`materials` 与 `families` 至少要给一个（都不传报告 `INVALID_ARGUMENT`）；两者可并存产出并集，产出文件名若冲突会报告 `ARGUMENT_CONFLICT`。`nameTemplate` 支持 `{stem}` 与 `{name}`（默认为 `{stem}_{name}`）。`selection` 与 `region` 的作用方式与 `recolor_asset` 相同。

调用：

```json
{"sourcePath":"sword.mcpx","materials":["iron","copper"],"outputDir":"variants-out"}
```

结果（原样）：

```text
{"profile":"generic","materials":["iron","copper"],"outputDir":"variants-out","files":[{"material":"iron","png":"variants-out/sword_iron.png","mcpx":"variants-out/sword_iron.mcpx","pixelsChanged":12},{"material":"copper","png":"variants-out/sword_copper.png","mcpx":"variants-out/sword_copper.mcpx","pixelsChanged":12}],"warnings":[]}
```

### validate_asset

返回附发现项的只读判定，绝不写入。`path` 是 PNG，可选的 `mcmetaPath` 会原样使用（不会自行推导同名的相邻文件）。`fail` 判定是正常结果，不是错误。

调用：

```json
{"path":"px-8x8.png"}
```

结果（原样）：

```text
{"verdict":"pass","profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"dimensions":{"width":8,"height":8},"totalPixels":64,"colorCount":64,"alpha":{"predictedClassification":"translucent","opaquePixels":62,"transparentPixels":1,"partialAlphaPixels":1,"partialAlphaValues":[128],"opaqueRatio":"0.9688","transparentRatio":"0.0156","partialAlphaRatio":"0.0156","predictedNote":"predicted classification from PNG bytes only; not the final in-game render result."},"findings":[{"code":"PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING","level":"warning","message":"predicted translucent: 1 partial-alpha pixel(s) use the translucent render pass; left as-is with no auto-fix."}],"version":{},"target":"default (engine defaults)","coverage":{"status":"complete","skipped":[]}}
```

### import_asset

把位图导入引擎：输入 PNG、JPEG 或 WebP，另可加一批操作。没有给输出路径时，PNG 字节与 `.mcpx` 文本都会内联在结果中。

调用：

```json
{"inputPath":"px-8x8.png"}
```

结果（原样；`pngBase64` 与 `.mcpx` 的调色板和网格已截短，完整调色板包含全部 64 色，`0`–`T0002`）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAI… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 8\nheight = 8\n\n[palette]\n0 = #03ED20FF\n… 63 more palette entries (1–T0002) …\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid tokens]\no 7 F N V d l u\n… 7 more grid rows …"}
```

### build_asset

把可编辑的 `.mcpx` 源码重建成 PNG 字节和／或构建后的源码。`sourcePath` 必须以 `.mcpx` 结尾，传位图会报告 `INVALID_ARGUMENT`。可选的批处理会先执行。

调用：

```json
{"sourcePath":"sword.mcpx"}
```

结果（原样；`pngBase64` 已截短）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n"}
```

### transform_asset

对位图或 `.mcpx` 应用一个几何操作（`flip`、`rotate` 等）；选择范围不能与几何操作并用（`ARGUMENT_CONFLICT`）。几何标志恰好只能给一个：给两个是 `ARGUMENT_CONFLICT`，都不给是 `INVALID_ARGUMENT`。

调用：

```json
{"inputPath":"sword.mcpx","flip":"h"}
```

结果（原样；`pngBase64` 已截短）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"geometry":"flip:h","width":4,"height":4,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n"}
```

### quantize_asset

把位图或 `.mcpx` 减色到指定的颜色数（`colors`），或映射到指定调色板 `palette`（内置材质名或 `.mcpx` 路径）；两者恰给一个（并用是 `ARGUMENT_CONFLICT`，都没给是 `INVALID_ARGUMENT`）。`keepColors`（RGBA 对象）保持不变；配合 `palette` 时必须是调色板中的项，配合 `colors` 时每层只把选择范围内实际出现的不重复保留色计入预算。可选的选择范围会把处理限制在选中像素。调色板文件不会被任何输出路径覆盖。结果会报告 `colors` 或 `palette`、`colorCount`、`modifiedPixels` 与规范化后的 `keepColors`；写出的 `.mcpx` 沿用画布原有的板，而非输入声明的板。输出路径和以往一样可用任何扩展名。所有输出目标会在第一次写入前一起检查：输入或调色板文件的别名、符号链接目标、符号链接父目录、已存在的文件，都会让整个调用被拒绝（过去会跟随符号链接）。写入本身是逐文件原子写入，不是事务；磁盘中途失败时，先前的输出可能已经写好。

调用：

```json
{"inputPath":"px-8x8.png","colors":4}
```

结果（原样；`pngBase64` 已截短）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"colors":4,"colorCount":4,"modifiedPixels":64,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAI… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 8\nheight = 8\n\n[palette]\n0 = #2A6353E7\n1 = #5D8787FF\n2 = #B9417FFF\n3 = #C0C0B0FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n20002222\n00002222\n00011233\n00111333\n01113333\n11133330\n11333320\n11322220\n"}
```

### cleanup_asset

检测位图或 `.mcpx` 的像素缺陷，并可选择修复。不带 `fix` 类别时是纯检测：`modifiedPixels` 为 0，不改变任何像素。`fix` 类别若缺少渲染通道授权，会报告 `INVALID_ARGUMENT`。

调用：

```json
{"inputPath":"sword.mcpx"}
```

结果（原样；`pngBase64` 已截短）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"detected":{"isolated":0,"noise":0,"cluster":0,"fringe":0,"outlier":0,"hole":0,"aa":0},"fixed":{"isolated":0,"noise":0,"cluster":0,"fringe":0,"outlier":0,"hole":0,"aa":0},"modifiedPixels":0,"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n"}
```

### palette_asset

针对图像的只读颜色报告。`extract` 列出不重复颜色，`inspect` 报告分布、角色与对比度。`mode` 为必填。

调用：

```json
{"mode":"extract","inputPath":"sword.mcpx"}
```

结果（原样）：

```text
{"mode":"extract","profile":"generic","colorCount":3,"entries":[{"id":"color-0","color":"#00000000"},{"id":"color-1","color":"#FF0000FF"},{"id":"color-2","color":"#00FF00FF"}]}
```

### material_asset

内置材质的只读报告。`list` 列出所有材质，`show` 加 `name` 返回单个材质定义与其色彩渐变。未知名称会报告 `INVALID_ARGUMENT`。

调用：

```json
{"mode":"list"}
```

结果（原样）：

```text
{"mode":"list","profile":"generic","materials":["iron","copper","oxidized_copper","gold","diamond","netherite","wood","stone","crystal"]}
```

### tile_asset

针对位图或 `.mcpx` 的接缝与边缘报告，另可指定匹配轴向。带 `preview`（例如 `2x2`）时，平铺预览 PNG 会以 `pngBase64` 内联。

调用：

```json
{"inputPath":"px-8x8.png","preview":"2x2"}
```

结果（原样；`pngBase64` 已截短）：

```text
{"profile":"generic","width":8,"height":8,"preview":"2x2","seam":{"horizontal":{"raw":422822,"pairs":8,"score":"0.203202"},"vertical":{"raw":494206,"pairs":8,"score":"0.237508"},"corner":{"raw":100918,"pairs":2,"score":"0.193998"}},"repeat":{"score":"0.930164","periodX":1,"periodY":1},"corrections":[],"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ… (truncated) …"}
```

### generate_asset

以 `pattern` 加尺寸加调色板加种子，合成确定性的程序化纹理；不需要输入文件。没有给输出路径时，PNG 字节与 `.mcpx` 文本都会内联。

调用：

```json
{"pattern":"checker","size":"16","palette":"iron","seed":7}
```

结果（原样；`pngBase64` 与网格已截短，完整的 `.mcpx` 是双色调色板加全部 16 行网格）：

```text
{"profile":"generic","applied":0,"operations":[],"warnings":[],"pattern":"checker","seed":7,"width":16,"height":16,"palette":"iron","pngBase64":"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ… (truncated) …","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n0 = #1A1D21FF\n1 = #EEF2F6FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n1110001110001110\n1110001110001110\n1110001110001110\n… 13 more grid rows …"}
```

### preview_asset

用一种 `mode` 做只读预览：`ascii` 与 `palette-map` 返回报告，`scale` 与 `nine-slice` 可把 PNG 写到显式路径。以下调用是 `sword.mcpx` 的 `ascii` 报告。

调用：

```json
{"inputPath":"sword.mcpx","mode":"ascii"}
```

结果（原样）：

```text
{"mode":"ascii","profile":"generic","width":4,"height":4,"ascii":["[palette]",". = #00000000","R = #FF0000FF","G = #00FF00FF","","[grid]",".RR.","RGGR","RGGR",".RR."],"palette":{".":"#00000000","R":"#FF0000FF","G":"#00FF00FF"},"warnings":[]}
```

### scale_gui_asset

以 mcmeta 的 `stretch`／`tile`／`nine_slice` 映射，把 GUI 精灵图缩放到明确的目标尺寸；`.mcmeta` 路径原样使用，省略即为 `stretch`。可选的版本目标决定 `stretch_inner` 是否生效；输出只有 PNG——给显式的 `outputPngPath` 即写文件，否则字节以 `pngBase64` 内联。

调用：

```json
{"inputPath":"px-8x8.png","size":"16x16"}
```

结果（原样；`pngBase64` 已截短）：

```text
{"size":"16x16","width":16,"height":16,"scaling":{"type":"stretch"},"version":{},"target":"default (engine defaults)","warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ… (truncated) …"}
```

### animate_asset

用一种 `mode` 处理动画 sprite sheet：`pack` 从帧目录建 sheet，`unpack`／`reorder`／`resize` 把帧写到显式的输出目录，`validate`／`preview` 为只读。没有给输出路径时，打包好的 sheet 以 `pngBase64` 内联。

调用：

```json
{"mode":"pack","framesDir":"v04-anim-frames","layout":"vertical"}
```

结果（原样；`pngBase64` 已截短）：

```text
{"mode":"pack","profile":"generic","frameCount":2,"frameWidth":4,"frameHeight":4,"layout":"vertical","width":4,"height":8,"warnings":[],"pngBase64":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAI… (truncated) …"}
```

`sweep` 把一张静态图变成一条扫过它的反光带：`inputPath` 加上可选的 `angle`（45、90、135、180，默认 135）、`width`（1 到 8）、`color`（`#RRGGBB`）、`frames`（含未改动的第 0 帧）、`frametime` 与 `holdTicks`，输出可选的 `outputPngPath` 与 `outputMcmetaPath`。第 0 帧是原图，只有完全不透明的像素会被覆盖，轮廓与透明度平面都不会移动；没给的参数取内置默认风格的动画预设值。`unpack` 可给 `format`（默认 `mcpx`，或 `png`）；`preview` 给了 `outputPngPath` 就写出图集图片，没给时只有报告。

调用：

```json
{"mode":"sweep","inputPath":"gem.png","angle":45,"width":2,"frames":8,"outputPngPath":"gem_sweep.png","outputMcmetaPath":"gem_sweep.png.mcmeta"}
```

### validate_pack_asset

针对整个资源包根目录的只读判定，绝不写入。可选的 `resourcePackVersion` 可选择兼容性目标。`fail` 判定是正常结果，不是错误。可选的 `vanillaPath` 提供原版资源树，`dependencyPaths`（有序，排前者优先）加入依赖根目录；报告带 `coverage` 对象，提供原版树后，原本会跳过的 atlas 检查即可完成。

调用：

```json
{"packPath":"clean-pack","resourcePackVersion":"75"}
```

结果（原样）：

```text
{"command":"validate-pack","path":"clean-pack","target":"resource-pack 75.0","verdict":"pass","findings":[{"code":"PACK_COVERAGE_SKIPPED","level":"warning","message":"atlas \"items\" for sprite \"minecraft:item/sword\" in \"assets/minecraft/models/item/sword.json\" cannot be completed without the vanilla resource tree; coverage recorded as skipped.","path":"assets/minecraft/models/item/sword.json"}],"coverage":{"status":"partial","skipped":[{"kind":"atlas-source","reason":"vanilla-not-provided","target":"items","detail":"sprite \"minecraft:item/sword\" needs the vanilla atlas sources"}]},"version":{"resourcePackVersion":"75.0"}}
```

### inspect_asset

针对 `.mcpx` 源码或位图的只读检查——位图会被读成单个 base 图层——绝不写入。调用带 `inputPath` 加 `mode`（`structure`／`view`）；`crop` 与 `scale` 只有 `view` 能用，`structure` 带任一个都是 `INVALID_ARGUMENT`。

调用：

```json
{"inputPath":"tests/cli/fixtures/sword.mcpx","mode":"structure"}
```

结果（该 fixture 的本地 MCP 文本块响应实况）：

```text
{"mode":"structure","width":4,"height":4,"layers":[{"id":"base","name":"base","index":0,"bounds":{"x":0,"y":0,"width":4,"height":4},"area":12,"visible":true,"opacity":1,"blendMode":"normal","colorUsage":{"uniqueColors":3,"transparentPixels":4,"topColors":[{"rgba":"#FF0000FF","count":8},{"rgba":"#00000000","count":4},{"rgba":"#00FF00FF","count":4}],"truncated":false}}],"regions":[],"overlaps":{"layerBounds":[],"regionPixels":[]}}
```

`structure` 报告图层（范围、面积、可见性、原始 RGBA 用色）、区域（仅含标识、范围、面积）与重叠。`view` 则把合成像素以标准图片块返回，外加六键元数据（`mode`、`sourceDimensions`、`crop`、`scale`、`outputDimensions`、`colorFormat`）——裁剪／缩放／1024px 边长规则与顶层 `inspect` 命令一致，图片字节不会另存一份 `pngBase64`。`view` 的 `scale` 是整数 1–16，默认 1；长边自动放大（缩放前长边不足 128 才向 128 放大）只适用于 `apply_asset_operations` 的附图，不适用于 `view`。`crop` 是与批处理 `selection` 同语法的选择表达式，落空时以 `EMPTY_SELECTION` 拒绝；输出边长超过 1024px 时以 `RESOURCE_LIMIT_EXCEEDED` 加裁剪提示拒绝。

### optimize_asset

无损地把显式指定的 PNG 文件或 PNG 目录重新编码成能精确表示像素的最小编码；没有更小的编码时保留源字节。它接受显式的 `inputPaths`（1 至 256 个文件）或 `inputDir`（最多 4096 个 PNG，可选 `recursive`）二选一。它只读输入、绝不改写输入，只写入显式指定的新 `outputPath`（单个显式输入）或已有的 `outputDir`。在目录模式下，按 UTF-8 字节顺序遍历相对路径并在 `outputDir` 下保留相对结构，严格检查预算上限（256 MiB 源文件大小、16,777,216 解码像素），拒绝符号链接与互含／别名目录，并跳过非 PNG 文件（不复制 `.mcmeta` 等）。`dryRun` 会算出完整报告但不写任何文件。只有一个显式输入且没给输出字段时，结果会内嵌 `pngBase64`。`mode` 默认 `auto`；指定模式会强制该编码，无法精确表示像素时报告 `OPTIMIZE_MODE_NOT_EXACT`。`ancillary` 默认 `preserve`；`strip` 会丢弃所有元数据块并列出它们。多文件写入为逐文件原子提交而非跨文件事务：写入中途失败时已写入的文件保留，错误 details 报告 `completed`、`failedTarget` 与 `notStarted`。

调用：

```json
{"inputPaths":["px-8x8.png"],"dryRun":true}
```

结果（本地 MCP 文本块的实际响应）：

```text
{"command":"optimize","dryRun":true,"mode":"auto","ancillary":"preserve","engine":"pako@3.0.2 level=9 memLevel=9 windowBits=15 legacyHash=false","files":[{"input":"px-8x8.png","output":null,"status":"optimized","source":{"bytes":184,"width":8,"height":8,"bitDepth":8,"colorType":6,"interlaced":false},"result":{"bytes":102,"mode":"rgba","bitDepth":8,"colorType":6,"paletteSize":0},"savedBytes":82,"savedPermille":445,"candidates":[{"mode":"rgba","applicable":true,"bytes":102,"selected":true},{"mode":"rgb","applicable":false,"unavailableReason":"not-opaque","selected":false},{"mode":"grayscale-alpha","applicable":false,"unavailableReason":"not-gray","selected":false},{"mode":"grayscale","applicable":false,"unavailableReason":"not-opaque","selected":false},{"mode":"indexed","applicable":true,"bytes":296,"selected":false}],"preservedChunks":[],"strippedChunks":[],"interlaceRemoved":false,"warnings":[]}],"totals":{"files":1,"sourceBytes":184,"resultBytes":102,"savedBytes":82,"optimized":1,"unchanged":0,"converted":0}}
```

`candidates` 列出每一种尝试过的编码，以及其他编码为什么不适用。批量在计算阶段是全有或全无：任何一个输入失败就不写任何文件，错误会列出 `processed` 与 `notProcessed`。

### model_asset

检查、验证、创建、编辑或导出 Java 方块／物品模型 JSON（只支持长方体 `elements`）。`inspect` 与 `validate` 只读；`create`、`apply`、`export` 只写入显式指定的新路径，`export` 还能依 `binding` 生成物品定义与 blockstate。它报告的是结构与引用是否有效，不是渲染后的外观。

调用（create，把模型写进资源包）：

```json
{"mode":"create","spec":{"textures":{"all":"mypack:block/ruby"},"elements":[{"from":[0,0,0],"to":[16,16,16],"faces":{"north":{"texture":"#all","uv":[0,0,16,16]},"up":{"texture":"#all"}}}]},"outputPath":"pack/assets/mypack/models/block/ruby.json","resourcePackVersion":"75"}
```

结果（本地 MCP 文本块的实际响应）：

```text
{"command":"model","mode":"create","version":{"packFormat":"75.0","rules":"verified","rulesReason":"verified-release"},"changed":true,"warnings":[],"preservedUnknown":[],"output":"pack/assets/mypack/models/block/ruby.json"}
```

调用（对资源包验证该模型）：

```json
{"mode":"validate","inputPath":"pack/assets/mypack/models/block/ruby.json","packPath":"pack","resourcePackVersion":"75"}
```

结果（本地 MCP 文本块的实际响应；资源包内放了被引用的贴图 `pack/assets/mypack/textures/block/ruby.png`）：

```text
{"command":"model","mode":"validate","path":"assets/mypack/models/block/ruby.json","target":"mypack:block/ruby","version":{"packFormat":"75.0","rules":"verified","rulesReason":"verified-release"},"verdict":"pass","findings":[],"coverage":{"status":"complete","skipped":[]}}
```

`apply` 接收类型化的 `operations`，全部应用成功或一个都不应用。`export` 使用 `binding.item` 时需要明确的版本，且资源包格式在 46.0 以上（否则报告 `MODEL_UNSUPPORTED_VERSION`）。没有提供原版资源树时，`minecraft` 命名空间的引用会记为跳过的 coverage，而不是被解析。

调用（把该模型预览为诊断三视图 PNG）：

```json
{"mode":"preview","inputPath":"pack/assets/mypack/models/block/ruby.json","packPath":"pack","size":64,"resourcePackVersion":"75"}
```

结果（本机 MCP 文本块的实际响应；资源包内没有该贴图，所以各面以固定棋盘格呈现，coverage 为 `partial`）：

```text
{"command":"model","mode":"preview","path":"assets/mypack/models/block/ruby.json","size":64,"version":{"packFormat":"75.0","rules":"verified","rulesReason":"verified-release"},"image":{"width":192,"height":64},"panels":[{"name":"front","x":0,"y":0,"width":64,"height":64},{"name":"right","x":64,"y":0,"width":64,"height":64},{"name":"top","x":128,"y":0,"width":64,"height":64}],"range":{"min":[0,0,0],"max":[16,16,16],"pixelsPerUnit":3},"coverage":{"status":"partial","skipped":[{"kind":"texture","reason":"missing","target":"mypack:block/ruby"}]},"warnings":[{"code":"MODEL_PREVIEW_TEXTURE_MISSING","level":"warning","message":"Texture mypack:block/ruby could not be resolved (missing).","target":"mypack:block/ruby"}],"unapplied":["display","lighting"]}
```

没有 `outputPngPath` 时，PNG 以标准图片块附在该报告旁返回。有 `outputPngPath` 时写出文件，文字部分只返回报告。预览图输出路径字段名为 `outputPngPath`，与其他会输出 PNG 的工具一致；模型的 `.json` 输出仍用既有的 `outputPath`。三个面板固定是 `front`（北面）、右侧（东面）与 `top`（上面，北方在上）；每个面板边长为 `size`。只画轴对齐的长方体且坐标为精确 1/256 倍数；`size` 只接受 64、128 或 256（默认 64）。这是诊断视图：`display` 变换与游戏光照不会应用，游戏客户端也没有验证过外观。

## 失败时如何返回

工具失败时会设置 `isError: true`，内容是放在 `content[0].text` 中的 JSON 字符串：

```text
isError: true
{"code":"INVALID_ARGUMENT","message":"Rect must be an object with x, y, width, and height.","details":{"path":"operations[1].rect"}}
```

这份捕获来自 `apply_asset_operations`，其中第二个操作的 `fillRect` 没有 `rect` 对象。

- `code` 是与 CLI 共用的注册表错误码（`INVALID_ARGUMENT`、`ARGUMENT_CONFLICT`、`FILESYSTEM_ERROR`、`OUTPUT_EXISTS` 等）；不是 `McAssetError` 的失败会变成 `INTERNAL_ERROR`。
- `message` 是 CLI 消息去掉开头 `[CODE] ` 前缀后的内容。
- `details` 只在错误带有上下文时才出现，例如出错的操作路径。
- `validate_asset` 以 `fail` 加发现项报告，而不是抛出错误，所以有问题的资产仍是正常结果。

可预期的文件规则失败：

- 显式指定的输出路径已存在 → `OUTPUT_EXISTS`。
- 缺少上级目录 → `FILESYSTEM_ERROR`。
- `apply_asset_operations`、`recolor_asset`、`create_variants` 收到非 `.mcpx` 的源码 → `INVALID_ARGUMENT`。
- `create_variants` 的 `outputDir` 不存在或不是目录 → `FILESYSTEM_ERROR`。
- `render_pixel_asset` 同时给 `gridPath` 与 `gridText` → `ARGUMENT_CONFLICT`；两者都没给 → `INVALID_ARGUMENT`。

## 限制与缺口

- **没有逐像素工具。** 不存在 `set_pixel`；像素工作要通过 ASCII Grid、批处理操作数组或内联的 `.mcpx` 文本来做。
- **只接受显式路径，不覆盖，不建目录。** 目标已存在是 `OUTPUT_EXISTS`，缺少上级目录是 `FILESYSTEM_ERROR`。MCP 不接受 `--force` 与 `--mkdir`，请改用新路径，或自行创建目录。
- **省略输出路径会内联产物。** 没有输出路径时，结果会带 `pngBase64`（PNG）或 `mcpxText`（`.mcpx`），而不写入文件。这是逐个产物决定的：只给 `outputPngPath` 会写出 PNG，并仍在结果中内联 `.mcpx` 文本。
- **与 CLI 完全对等。** 二十五个工具覆盖素材输入与源码构建、空间变换、调色板与减色、确定性像素化管线、程序化生成、平铺与预览、动画 sprite sheet，以及单个资产与整个资源包的验证（含依赖／原版解析与 GUI 精灵图缩放）；版本目标设置通过 `analyze_asset`、`validate_asset`、`validate_pack_asset` 的 `minecraftVersion`／`resourcePackVersion` 传入。
- **查看与附图都是图片块，不另存副本。** `inspect_asset` 的 `view` 与 `apply_asset_operations` 的附图都不会再以 `pngBase64` 重复一份 PNG；字节走标准的 `type: "image"`、`mimeType: "image/png"` 块。查看缩放默认 1；长边自动放大（缩放前不足 128 才向 128 放大，上限 16）只适用于附图。超过 1024px 边长一律是 `RESOURCE_LIMIT_EXCEEDED`，不会默默缩图。
- **模型只检查结构与引用，不检查外观。** `model_asset` 与 `validate_pack_asset` 验证 JSON 结构、UV 与旋转范围、display 变换，以及被引用的模型与贴图是否存在。没有任何 Minecraft 客户端渲染过模型，所以模型在游戏里的外观与行为都未验证。只支持长方体 `elements`。`preview` 模式的 `model_asset` 是诊断视图，不是游戏渲染器。
- **`optimize_asset` 以像素比对确认无损。** 结果解码后的像素与源文件相同，字节则不同。结果在游戏客户端里的外观未经检查。
- **`validate_asset` 只检查单个 PNG。** 资源包级与图集感知的验证，请用 `validate_pack_asset`。
- **确定性只验证过演示输入。** 相同输入加相同参数，对演示用的 `px-8x8.png`／`sword.mcpx`／`v04-anim-frames/` 与一个干净的资源包产生了相同结果。其他输入与选项（WebP、`WxH` 尺寸、`region`、`atomic: false`、`animate` 的 `resize`）也演练过，但没有重跑确认输出是否一致。
- **运行时。** MCP 路径只使用 `node:` 导入，所以打包后的 `dist` 可在纯 Node 下运行；CI 的 `node` job 使用 Node 22。需要 Node.js 22 或更新，`engines` 字段已声明 `>=22`。
- **尚未实测**：`mcmetaPath`、JPEG 输入、没有捕获的 `mode` 分支（`palette` 的 `inspect`、`material` 的 `show`、`preview` 的 `palette-map`／`scale`／`nine-slice`、`animate` 的 `unpack`／`reorder`／`validate`／`preview`），以及捕获的 `INVALID_ARGUMENT` 与已演练的 `OUTPUT_EXISTS`／`FILESYSTEM_ERROR` 之外的任何错误路径。

## 生成 mcmeta 设置

从 PNG 生成动画或 GUI 缩放设置：

```sh
mc-asset mcmeta animation sheet.png --frame-size 16 --frametime 2 --frames '[0,{"index":1,"time":4},0]' --minecraft-version 1.21.2 --output sheet.png.mcmeta
mc-asset mcmeta gui panel.png --type nine_slice --border 4 --stretch-inner --resource-pack-version 42 --stdout
```

动画必须指定 `--frame-size <N|WxH>`，帧只支持单排或单列，尺寸必须整除 PNG；不接受网格。`frametime` 默认 1，`frames` 接受索引或 `{index,time}` 对象，可重复或只播放部分帧；省略时依序播放全部帧。时間必须是正整数，索引不得越界；`--interpolate` 启用插值。GUI 必须指定 `--type <stretch|tile|nine_slice>`，tile 与 nine_slice 以 PNG 尺寸作设计尺寸。nine_slice 必须指定 `--border <N|json>`，四边 left、top、right、bottom 为非负整数，中央必须保留正面积；只有 nine_slice 接受 `--stretch-inner`。

CLI 必须明确选择 `--output <path.mcmeta>` 或 `--stdout` 其中之一，不猜同名路径。已存在的目标需要 `--force`，它会整个文件替换，不保留其他区段；`--mkdir` 允许建立缺少的父目录。来源 PNG 与无关的同名设置不变，输入别名与符号链接会被拒绝。输出只含指定区段，以固定键顺序的紧凑 JSON 加一个结尾换行生成。

版本选项 `--minecraft-version` 与 `--resource-pack-version` 只能选一个。GUI scaling 需要 pack format 16.0，stretch_inner 需要 42.0；不相容会在输出前回报 `ARGUMENT_CONFLICT`。未指定版本，或版本在 12.0 到 97.1 之外，会回报 `versionChecked: false` 与 `VERSION_NOT_CHECKED`，但不会跳过 GUI 最低版本限制。动画依据文档格式及历史在表内标示已检查，并非逐版本游戏客户端实测。来源见[材质动画与历史](https://minecraft.wiki/w/Resource_pack#Texture_animation)（interpolate 在 14w25a 加入，早于支持表）、[GUI scaling](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w31a) 与 [pack format](https://minecraft.wiki/w/Pack_format)。这些检查确认设置结构与已知版本相容性，不代表已验证游戏内外观或行为。

### mcmeta_asset

指定 `mode`（`animation` 或 `gui`）与 `inputPath`（PNG）。 `animation`: `frameSize`, `frametime`, `frames`, `preset`, `holdTicks`, `interpolate`; `preset`（`hold-and-sweep`、`ping-pong` 或 `pulse`）以具名时间轴展开 `frames`，不能与 `frames` 同时指定； `gui`: `type`, `border`, `stretchInner`. 指定版本可用 `minecraftVersion` 或 `resourcePackVersion`。另一种模式的字段（即使为 false）会返回 `INVALID_ARGUMENT`。`outputPath` 明确指定 `.mcmeta`，另可用 `force`、`mkdir`；省略路径则返回 `mcmetaText`，不写文件。`force`、`mkdir` 必须搭配路径。结果含 `mode`、`width`、`height`、`versionChecked`、`version`、`target`、`warnings`，以及 `output` 或 `mcmetaText`。

```json
{"mode":"gui","inputPath":"panel.png","type":"nine_slice","border":4,"stretchInner":true,"resourcePackVersion":"42"}
```

## 比较 PNG 的变化

```sh
mc-asset compare before.png after.png --json
mc-asset compare before.png after.png --output diff.png --scale 4
mc-asset compare before.png after.png --stdout --json > diff.png
```

只接受尺寸相同的 PNG；尺寸不同返回 `INVALID_ARGUMENT`。未指定 `--output` 或 `--stdout` 时只返回报告，不写文件。使用 `--stdout` 时，PNG 字节写入 stdout，报告写入 stderr。`--output` 与 `--stdout` 不能同时使用。

报告包含 `width`、`height`、`totalPixels`、`rawChangedPixels`、`visibleChangedPixels`、`rawBounds`、`visibleBounds`。原始差异逐一比较解码后的 RGBA 通道，包括 alpha 为零时隐藏的 RGB。可见差异采用现有 flatten 合成规则，但双方 alpha 都为零时忽略 RGB。差异框采用原图坐标，以从零开始的 `{x,y,width,height}` 表示，包含最后一个变化像素；没有差异时为 `null`。

诊断 PNG 用洋红色（`255,0,255,255`）标记可见差异，用青色（`0,255,255,255`）标记仅有原始差异的像素，未变像素为透明（`0,0,0,0`）。该图是诊断标记，不是修改后的素材。`--scale` 接受 1 到 16 的整数，默认为 1，通过 nearest 放大标记图，不改变报告统计。图像放大后的长边不得超过 1024 像素，超限返回 `RESOURCE_LIMIT_EXCEEDED`，不会自动缩小。仅报告模式沿用现有 PNG 解码器限制。

两个源文件都不会被改写。显式输出路径必须以 `.png` 结尾；源文件别名、符号链接目标或父目录都会被拒绝。覆盖现有目标需要 `--force`，创建缺少的父目录需要 `--mkdir`；这两个选项都需要文件输出路径。所有输出先通过检查，才写入文件或发送 stdout 图像字节。

### compare_assets

通过 `beforePath`、`afterPath` 指定两张同尺寸 PNG。`image` 为 `none`（默认，仅报告）或 `diff`；`scale` 是 1 到 16 的整数，默认为 1。只有 `image: "diff"` 可使用 `outputPath`，将图像写入显式 `.png` 路径，可搭配 `force`、`mkdir`。diff 模式未提供 `outputPath` 时，返回 JSON 报告与标准 `image/png` 图像块，不在文本中重复 Base64。`force`、`mkdir` 均需要 `outputPath`。

报告、标记颜色、原图坐标差异框、放大后 1024 像素限制、源文件保护与错误均遵循上面的 PNG 比较规则。源文件不会被改写。

```json
{"beforePath":"before.png","afterPath":"after.png","image":"diff","scale":4}
```

### style_asset

风格预设与调色板库。`list` 报告四个内置预设（`vanilla`、`soft`、`fairy-flat`、`dark-frame`），每个预设含十二个家族与六个角色；加上 `paths` 会一并报告能加载的自定义 `.style.json`，其中一个加载不进来就让整个调用以 `STYLE_INVALID` 失败。`show` 把内置 id 或 `.style.json` 路径沿 `extends` 链（最多八层）解析，返回整份文档与该链。`export-palette` 把单个家族或全部家族的调色板写成 `.mcpx`，未提供 `outputMcpxPath` 时返回文本。`create` 写出新的 `.style.json` 文档。

调用：

```json
{"mode":"export-palette","style":"vanilla","family":"iron"}
```

调色板是一份 `.mcpx` 文档：每行一个家族、每列一个角色，`[palette]` 按家族再按角色排序、`.` 排在最前对应 `#00000000`，并带 `kind = palette`，可直接当成调色板文件喂给 `quantize` 或 `generate`。

```json
{"mode":"create","outputPath":"styles/iron-tide.style.json","id":"iron-tide","name":"铁潮","extends":"vanilla","overrides":{"limits":{"maxColors":12}}}
```

风格文件以严格模式读取：未知字段、枚举外的值，或不是 `#RRGGBB` 的颜色都是带字段路径的 `STYLE_INVALID`（`palettes.stone.base: expected #RRGGBB, got "#12345"`）。其余错误码为 `STYLE_NOT_FOUND`（查不到的 id）、`STYLE_INHERITANCE_CYCLE`、`STYLE_UNSUPPORTED_VERSION` 与 `STYLE_FAMILY_NOT_FOUND`（解析后不存在的家族）。只有 `export-palette` 与 `create` 会写入，且只写显式指定的输出路径；`force` 覆盖该文件，`mkdir` 创建缺少的父目录。

`lint` 会度量一张图片并对照一个风格，返回冻结的报告：

```json
{"mode":"lint","inputPath":"assets/pack/textures/item/ruby_sword.png","style":"vanilla","category":"sword"}
```

结果带 `path`、`style`、`category`、`metrics`（与 `analyze_asset` 的 `styleMetrics` 同一组字段）、`findings`、`skipped` 与 `verdict`（`pass`、`warnings`、`fail`）。每条 finding 带 `code`、`level`、`measured`、`threshold`、`message` 与 `suggestion`；除 `STYLE_COLOR_BUDGET` 外都是 warning。没有可比较对象的指标只在 `skipped` 说明原因，`category` 会套用该分类的阈值覆盖，动画竖条只度量第一帧（`firstFrameOnly: true`）。`analyze_asset` 也会在 `styleMetrics` 返回同一组度量，其余字段不变。

### pack_asset

创建一个资源包项目。`init` 需要 `projectDir`、`namespace` 与 `minecraftVersion`，另有可选的 `name`、`description`、`style` 与 `resourcePackVersion`；使用 `namespace: minecraft` 时还需要 `allowMinecraftNamespace`。

调用：

```json
{"mode":"init","projectDir":"packs/aurelian-forge","namespace":"aurelian","minecraftVersion":"1.21.9","style":"soft"}
```

一次预检后整批写出 `mc-asset.pack.json`、`pack/pack.mcmeta`、64x64 的 `pack/pack.png` 占位图标，以及资源包目录（`recipes/` 加上 `pack/assets/aurelian/...`，资源包格式 46.0 起还有 `items/`）。结果会报告固定的格式号与创建的每个路径：

```json
{"mode":"init","projectDir":"/abs/packs/aurelian-forge","minecraftVersion":"1.21.9","packFormat":"69.0","resourcePackVersion":"69.0","files":["mc-asset.pack.json","pack/pack.mcmeta","pack/pack.png"],"directories":["pack","pack/assets","pack/assets/aurelian","pack/assets/aurelian/items","pack/assets/aurelian/models","pack/assets/aurelian/models/item","pack/assets/aurelian/textures","pack/assets/aurelian/textures/block","pack/assets/aurelian/textures/item","recipes"]}
```

`resourcePackVersion` 覆盖发布版本对应的资源包格式，但发布版本本身仍留在项目文件里。根 metadata 按目标版本选择写法：资源包格式 65.0 起声明该目标的 `min_format` 与 `max_format` 且不写旧式 `pack_format`，更早的版本只写单一旧式格式号。生成的文件在写入前会先在内存内套用与 `validate-pack` 相同的根 metadata 规则检查。

不会覆盖任何东西。已经存在的路径会让整批拒绝：

```json
{"code":"PACK_INIT_CONFLICT","message":"pack init found 2 paths it would create.","details":{"path":"/abs/packs/aurelian-forge","minecraftVersion":"1.21.9","conflicts":["pack","pack/pack.mcmeta"]}}
```

项目目录本身或其下任何位置是符号链接时是 `FILESYSTEM_ERROR`，而且永远不会穿过链接写入；未知的发布版本或非法命名空间是 `INVALID_ARGUMENT`。这个工具没有 `force` 也没有 `mkdir`；它写出的项目文件由后续命令以严格模式读取（`PACK_PROJECT_INVALID` 带字段路径、`PACK_PROJECT_NOT_FOUND`、`PACK_PROJECT_UNSUPPORTED_VERSION`）。

`build` 按配方将素材构建到资源包目录结构中，并以 `mc-asset.lock.json` 追踪产物。需要 `projectPath`（必填，指向 `mc-asset.pack.json`），另有可选的 `recipe`（单个配方文件；省略时按文件名字节序读取 `recipeDir` 下所有 `*.recipe.json`）与可选的 `dryRun`。

调用：

```json
{"mode":"build","projectPath":"packs/aurelian-forge/mc-asset.pack.json","dryRun":true}
```

构建采用三段式执行：
1. *解析与计划*：读取项目文件、配方、风格、lock 文件（`mc-asset.lock.json`）与源文件；在内存中完成变量展开、调色板映射与全部校验，不写入任何字节。
2. *分类*：将每个预定产物比对 lock 文件与磁盘现况，划入四类：
   - `new`：未记录且磁盘无文件（预定写入）。
   - `own-clean`：已记录且输出哈希相符（输入未变则跳过，输入变更则预定重写）。
   - `own-modified`：已记录但磁盘文件被修改（用户修改冲突）。
   - `foreign`：未记录但磁盘已有文件（外部文件冲突）。
3. *写入*：先对全部目标执行 safe-output 预检；全部通过后才原子写入各文件，最后再原子更新 `mc-asset.lock.json`。

若有任何产物属于 `own-modified` 或 `foreign`，整批以 `PACK_BUILD_CONFLICT`（code 4）拒绝，在 `details.conflicts` 完整列出冲突路径，一个字节都不写且 lock 文件保持原样：

```json
{"code":"PACK_BUILD_CONFLICT","message":"pack build found conflicting outputs.","details":{"recipeId":"tool-matrix","conflicts":[{"path":"pack/assets/aurelian/textures/item/iron_sword.png","reason":"foreign"}]}}
```

结果：

```json
{"mode":"build","recipeId":"tool-matrix","outputs":35,"completed":[],"dryRun":true}
```

未带 `dryRun` 时，`completed` 会列出实际写入的每个路径，并在 `mc-asset.lock.json` 记录输出哈希，确保后续重跑幂等且不重复写入。

配方 `model` 步骤写出 `assets/<namespace>/models/item/<item>.json`（父模型预设或自定义 modelSpec），`itemDefinition` 步骤写出 `assets/<namespace>/items/<item>.json`（默认 simple 或 select／condition／range_dispatch 模板），因此一个目标可同时产出贴图与多个 JSON 文档，并以 `kind: model`／`kind: itemDefinition` 的 lock 条目追踪。物品定义需资源包格式 46.0 及以上（`RECIPE_VERSION_UNSUPPORTED`，带 `targetId` 与实际格式）；引用不存在模型时返回 `PACK_BROKEN_REFERENCE`；`minecraft` 命名空间需 `override: true`，否则返回 `RECIPE_INVALID`。

`catalog` 列出调用方给定原版资源树（含 `assets/`）下的 PNG 贴图：

```json
{"mode":"catalog","vanillaPath":"/abs/vanilla-1.21","includeFamilies":true}
```

每条报告路径、分类、解码尺寸、动画标记（同名 `.mcmeta` 或高宽比为整数倍且高大于宽）与遮罩家族键。结果报告 `total` 与当页条数（`page` 从 1 起算，`pageSize` 每页至多 1000 条，`category` 精确匹配）。缺 `assets/` 或超出扫描预算报 `PACK_CATALOG_INVALID`。

`extract` 只取出调用方指定 jar 内的 `assets/` 条目到 `outputDir`：

```json
{"mode":"extract","jarPath":"/abs/client.jar","outputDir":"/abs/vanilla"}
```

`jarPath` 与 `outputDir` 必填，另有可选的 `force` 与 `mkdir`。绝对路径、`..` 片段与加密条目报 `PACK_ARCHIVE_INVALID`，中央目录损坏亦同。结果报告取出文件数与字节总计。
