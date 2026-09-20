# MCP 服务器指南（mc-asset）

[English](mcp-guide.md) | [繁體中文](mcp-guide.zh-TW.md) | [简体中文](mcp-guide.zh-CN.md)

`mc-asset mcp` 会启动 stdio MCP 服务器：stdout 只输出 MCP JSON-RPC，诊断信息走 stderr，stdin 关闭时进程退出。已冻结的接口（七个工具名称、各自的输入，以及读写契约）记录在 `docs/mcp-surface.zh-CN.md`，输入字段则冻结在 `src/mcp/schema.ts`。本指南涵盖注册方式、每个工具一份原样捕获、错误模型与限制。

服务器直接挂在 Core 上，所以每个工具都跑与 CLI 命令相同的引擎。像素级的创作，通过 ASCII Grid 文档、批处理操作数组，或内联返回的可编辑 `.mcpx` 源码来完成；刻意不提供 `set_pixel` 工具。

## 安装与注册服务器

服务器内置在通过 Homebrew 安装的 `mc-asset` 可执行文件中，请先安装（Homebrew tap 的做法见 README 的「安装指南」章节）。

接着在全局 OpenCode 配置（`~/.config/opencode/opencode.jsonc`）中，把 `mc-asset` 添加为 MCP 服务器：

```jsonc
"mc-asset": {
  "type": "local",
  "command": ["/opt/homebrew/bin/mc-asset", "mcp"],
  "enabled": true
}
```

`command` 指向已安装的可执行文件（`/opt/homebrew/bin/mc-asset` 是这台机器上 Homebrew 的安装位置）。

然后完整重启 OpenCode。MCP 服务器在启动时加载，配置改了却没重启，什么都证明不了。要回滚时，移除该条目（或还原配置备份）并再重启一次。

以下捕获取自已安装的版本，通过 MCP 客户端 SDK 在一个演示工作目录中运行，其中所有路径都相对于该目录。

## 七个工具

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
- **接口只覆盖核心引擎工具。** `tile`、`generate`、`preview`、`animate`、`validate-pack` 与版本目标设置，目前仍只在 CLI 提供。
- **`validate_asset` 只检查单个 PNG。** 资源包级与图集感知的验证，在 CLI 的 `validate-pack`。
- **确定性只验证过演示输入。** 相同输入加相同参数产生了相同结果；只跑过演示用的 `px-8x8.png`／`sword.mcpx`，其他格式尚未验证。
- **运行时。** MCP 路径只使用 `node:` 导入，所以打包后的 `dist` 可在纯 Node 下运行；CI 的 `node` job 使用 Node 22。未声明最低 Node 版本（没有 `engines` 字段）。
- **尚未实测**：`mcmetaPath`、`region`、`atomic: false`、JPEG／WebP 输入、`WxH` 尺寸，以及上面捕获之外的任何错误路径。
