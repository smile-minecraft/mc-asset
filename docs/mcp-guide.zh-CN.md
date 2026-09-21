# MCP 服务器指南（mc-asset）

[English](mcp-guide.md) | [繁體中文](mcp-guide.zh-TW.md) | [简体中文](mcp-guide.zh-CN.md)

`mc-asset mcp` 会启动 stdio MCP 服务器：stdout 只输出 MCP JSON-RPC，诊断信息走 stderr，stdin 关闭时进程退出。已冻结的接口（十九个工具名称、各自的输入，以及读写契约）记录在 `docs/mcp-surface.zh-CN.md`，输入字段则冻结在 `src/mcp/schema.ts`。本指南涵盖注册方式、每个工具一份原样捕获、错误模型与限制。

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

以下捕获通过 MCP 客户端 SDK 在一个演示工作目录中执行，其中所有路径都相对于该目录。原有七个工具的捕获取自已安装的版本，本次新增的十二个工具则取自本地源码服务器——两者执行的是同一份服务器代码。

## 十九个工具

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
{"profile":"generic","preset":"item","presetDetail":"preset=item colors=16 edge=0 cluster=0 cleanup=outlier pending-review (item: tight 16-color budget, outlier cleanup, no heuristics)","width":16,"height":16,"colors":16,"colorCount":16,"stages":["decode","crop","background","subject","resize","edge","quantize","cluster","cleanup","preset","output"],"warnings":[],"output":"out/pixelize16.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n0 = #124B44FF\n… 15 more palette entries (1–F); the last is F = #DDA5DEFF …\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[gr… (truncated) …"}
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

### recolor_asset

用一个内置材质 id，给 `.mcpx` 源码的每个图层重新着色；可选的 `region` 可把写入限定在单个区域。`material` 为必填。

调用：

```json
{"sourcePath":"sword.mcpx","material":"iron","outputPngPath":"out/sword_iron.png"}
```

结果（原样；只给了 PNG 路径，所以重新着色后的 `.mcpx` 文本内联返回）：

```text
{"profile":"generic","material":"iron","pixelsChanged":12,"warnings":[],"output":"out/sword_iron.png","mcpxText":"mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n0 = #5A6068FF\n1 = #9AA1A9FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n.00.\n0110\n0110\n.00.\n"}
```

### create_variants

把一份 `.mcpx` 源码展开到显式指定的 `outputDir` 下，每种材质生成一份 PNG 加一份 `.mcpx`，每份都从原始源码开始。同一次调用中重复列出同一材质，会报告 `ARGUMENT_CONFLICT`。

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
{"verdict":"pass","profile":{"id":"generic","predictedDescription":"predicted profile generic has no Minecraft-specific restrictions."},"dimensions":{"width":8,"height":8},"totalPixels":64,"colorCount":64,"findings":[{"code":"PARTIAL_ALPHA_CAUSES_TRANSLUCENT_RENDERING","level":"warning","message":"predicted translucent: 1 partial-alpha pixel(s) use the translucent render pass; left as-is with no auto-fix."}]}
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

把位图或 `.mcpx` 减色到指定的颜色数，另可指定选择范围。结果会报告 `colors`、`colorCount` 与 `modifiedPixels`。

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
{"mode":"list","profile":"generic","materials":["iron","copper","oxidized_copper","gold","wood","stone","crystal"]}
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

### validate_pack_asset

针对整个资源包根目录的只读判定，绝不写入。可选的 `resourcePackVersion` 可选择兼容性目标。`fail` 判定是正常结果，不是错误。

调用：

```json
{"packPath":"clean-pack","resourcePackVersion":"75"}
```

结果（原样）：

```text
{"command":"validate-pack","path":"clean-pack","target":"resource-pack 75.0","verdict":"pass","findings":[],"version":{"resourcePackVersion":"75.0"}}
```

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
- **只接受显式路径，不覆盖，不建目录。** 目标已存在是 `OUTPUT_EXISTS`，缺少上级目录是 `FILESYSTEM_ERROR`。错误消息仍会提到 `--force`／`--mkdir`，但通过 MCP 无法传入这两个标志，请改用新路径，或自行创建目录。
- **省略输出路径会内联产物。** 没有输出路径时，结果会带 `pngBase64`（PNG）或 `mcpxText`（`.mcpx`），而不写入文件。这是逐个产物决定的：只给 `outputPngPath` 会写出 PNG，并仍在结果中内联 `.mcpx` 文本。
- **与 CLI 完全对等。** 十九个工具覆盖素材输入与源码构建、空间变换、调色板与减色、确定性像素化管线、程序化生成、平铺与预览、动画 sprite sheet，以及单个资产与整个资源包的验证；版本目标设置通过 `analyze_asset`、`validate_asset`、`validate_pack_asset` 的 `minecraftVersion`／`resourcePackVersion` 传入。
- **`validate_asset` 只检查单个 PNG。** 资源包级与图集感知的验证，请用 `validate_pack_asset`。
- **确定性只验证过演示输入。** 相同输入加相同参数，对演示用的 `px-8x8.png`／`sword.mcpx`／`v04-anim-frames/` 与一个干净的资源包产生了相同结果。其他输入与选项（WebP、`WxH` 尺寸、`region`、`atomic: false`、`animate` 的 `resize`）也演练过，但没有重跑确认输出是否一致。
- **运行时。** MCP 路径只使用 `node:` 导入，所以打包后的 `dist` 可在纯 Node 下运行；CI 的 `node` job 使用 Node 22。需要 Node.js 22 或更新，`engines` 字段已声明 `>=22`。
- **尚未实测**：`mcmetaPath`、JPEG 输入、没有捕获的 `mode` 分支（`palette` 的 `inspect`、`material` 的 `show`、`preview` 的 `palette-map`／`scale`／`nine-slice`、`animate` 的 `unpack`／`reorder`／`validate`／`preview`），以及捕获的 `INVALID_ARGUMENT` 与已演练的 `OUTPUT_EXISTS`／`FILESYSTEM_ERROR` 之外的任何错误路径。
