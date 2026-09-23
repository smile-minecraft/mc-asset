# CLI 接口规范

[English](cli-surface.md) | [繁體中文](cli-surface.zh-TW.md) | [简体中文](cli-surface.zh-CN.md)

入口：`mc-asset`（本地开发时可用 `bun src/cli/index.ts`）。

全局行为遵循确定性标准：通道分工、`OUTPUT_EXISTS`／`--force`／`--mkdir`、原子写入，以及 `--force` 与 `--in-place` 互斥。退出状态码由 `src/core/errors.ts` 的错误码注册表统一定义。

最新发布版本仍是 `v0.3.1`。当前源码树多出的 CLI 内容——顶层 `inspect` 指令（`structure`／`view`）、`gui-scale` 指令、选择范围的 JSON AST 写法、`ellipse`／`polygonFill`／`strokeMask`／`stampRect`／`regionFromSelection` 批处理操作，以及 `feedback` 相关说明——都尚未发布，`v0.3.1` 不包含它们。

---

## 全局标志

```text
--json       将结构化 JSON 信封输出到 stdout（若产物要走 stdout，则改为输出到 stderr）
--help       显示帮助并退出（状态码 0）
--version    显示工具链版本（状态码 0）
```

---

## 通用文件标志（会产生文件的命令）

所有会产生或修改文件的命令，都遵守下列路径与安全规则：

```text
--output <path>   显式指定输出文件路径（不会自动生成文件名）
--stdout          将产物字节写入 stdout（信封与日志改走 stderr）
--force           允许覆盖已有目标（否则为 OUTPUT_EXISTS，状态码 4）
--mkdir           创建缺失的上级目录（否则为 FILESYSTEM_ERROR，状态码 4）
--in-place        直接以输入路径为目标（与 --force 互斥）
--input <path>    未以位置参数提供输入时，作为 --in-place 的输入路径
--profile <name>  资产配置：generic | minecraft:item | minecraft:block | minecraft:gui | minecraft:particle
```

### 安全与文件系统保证

- **必须显式指定目标**：会产生文件的命令若没有 `--output`、`--stdout`、`--source` 或 `--in-place`，会报告 `OUTPUT_REQUIRED`（状态码 2），且不创建任何文件。
- **规范化路径比对**：目标路径会先解析为绝对路径，并做 Unicode NFC 与大小写折叠。输出路径与输入别名冲突而未加 `--in-place`，或存在重复的输出目标，会在写入任何字节前报告 `ARGUMENT_CONFLICT`（状态码 2）。
- **逐文件原子提交**：每个输出文件先写入目标目录中以 `O_EXCL` 创建的临时文件，再通过原子重命名提交。写入失败不会留下不完整的产物。
- **Minecraft 配置限制**：Minecraft 贴图配置（`minecraft:item`、`minecraft:block`、`minecraft:gui`、`minecraft:particle`）只接受 `.png` 输出。扩展名不是 PNG 时，会以 `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT`（状态码 5）失败。

---

## 命令参考

### 1. 导入、编写与源码构建

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `import <image>` | 位图文件（PNG、JPEG、WebP） | PNG 和／或 `.mcpx` | 将位图格式解码为像素画布。 |
| `render <grid>` | ASCII Grid 文件（`.grid`） | PNG 和／或 `.mcpx` | 编译由人或 Agent 编写的 ASCII Grid。 |
| `build [source]` | `.mcpx` 源文件或 stdin（`--stdin`） | PNG 和／或 `.mcpx` | 将可编辑的源文件构建为贴图，或重新序列化源码。 |

```text
import <image> [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
render <grid>  [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
build  [source] [--stdin] [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
```

- `--source <path>` 会保存可编辑的 `.mcpx` 文本源码。
- `--in-place` 直接改写输入文件（对该目标等同 force）。
- `build --stdin` 与 `--operations -` 同时使用会报告 `ARGUMENT_CONFLICT`。

---

### 2. 空间与几何变换

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `transform <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 空间变换：翻转、旋转、裁剪、填充、缩放、平移。 |

```text
transform <input> [--flip <h|v>] [--rotate <90|180|270>] [--crop <x,y,w,h>]
                  [--pad <l,t,r,b>] [--pad-color <hex|transparent>]
                  [--resize <WxH>] [--resize-mode <nearest|box|pixel-aware>]
                  [--translate <dx,dy>] [--selection <scope>] <file flags>
```

- 每次调用只能使用**一个**几何标志，同时使用多个会报告 `ARGUMENT_CONFLICT`。
- `--selection` 将操作限定在选择表达式：`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`，或 JSON 表达式对象 `{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`（以 `{` 开头走 JSON 路径，其余解析为原子）。JSON 表达式写法尚未发布，`v0.3.1` 不包含。几何操作与 `--selection` 并用会报告 `ARGUMENT_CONFLICT`。

---

### 3. 调色板、量化与清理

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `quantize <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 将不同颜色的数量缩减到目标值。 |
| `cleanup <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 检测或消除孤立点、噪点与离群像素。 |
| `palette extract <image>` | PNG、JPEG、WebP、`.mcpx` | 仅报告 | 提取图像中不重复的 RGBA 颜色。 |
| `palette inspect <image>` | PNG、JPEG、WebP、`.mcpx` | 仅报告 | 分析调色板分布、角色与对比度。 |
| `material list` | 无 | 仅报告 | 列出可用的内置材质定义。 |
| `material show <name>` | 无 | 仅报告 | 查看某个材质的色阶与定义。 |
| `recolor <source>` | `.mcpx` | PNG 和／或 `.mcpx` | 将颜色重新映射到内置材质调色板。 |
| `variant <source>` | `.mcpx` | `--output-dir` 下的多个文件 | 生成材质变体（例如 iron、copper、gold）。 |

```text
quantize <input> --colors <N> [--selection <scope>] <file flags>
cleanup  <input> [--fix <classes>] [--allow-render-pass-change] [--selection <scope>] <file flags>
recolor  <source> --material <name> [--region <id>] <file flags>
variant  <source> --materials <a,b,...> --output-dir <dir> [--mkdir] [--force] [--profile <p>]
```

- `cleanup --fix <classes>`：以逗号分隔的类别列表（`isolated`、`noise`、`cluster`、`fringe`、`outlier`、`hole`、`aa`）。修改会影响 alpha 的类别时，必须加 `--allow-render-pass-change`。
- `palette` 与 `material` 子命令只输出报告，收到文件写入标志会被拒绝（`INVALID_ARGUMENT`）。

---

### 4. 像素画管线

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `pixelize <image>` | PNG、JPEG、WebP | PNG 和／或 `.mcpx` | 确定性的 11 阶段「位图转像素画」管线。 |

```text
pixelize <image> --size <N|WxH> [--preset <item|block|gui|particle|generic>] <file flags>
```

- 必须指定目标 `--size`（Minecraft 常见的正方形尺寸 16、32、64、128，或自定义 `WxH`）。
- 预设（preset）决定该用途的色彩预算、清理启发，以及会启用哪些管线阶段。`item` 预设会启用 crop、background、subject、edge、cluster；其余预设保持既有输出，按位不变。输入是单一张位图（不接受 `.mcpx`）；五个阶段都在这一个图层上执行。

---

### 5. 程序化生成、平铺与预览

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `tile <input>` | PNG、JPEG、WebP、`.mcpx` | 仅报告，或 PNG | 接缝分析、边缘重复分析，或平铺修复与预览。 |
| `generate <pattern>` | 无 | PNG 和／或 `.mcpx` | 确定性的程序化贴图生成器。 |
| `preview <input>` | PNG、JPEG、WebP、`.mcpx` | 仅报告，或 PNG | ASCII 预览、调色板映射、九宫格参考线，或最近邻放大。 |
| `gui-scale <input>` | PNG、JPEG、WebP、`.mcpx` | PNG | 以 mcmeta 的 stretch／tile／nine_slice 映射，把 GUI 精灵图缩放到明确的目标尺寸（尚未发布，`v0.3.1` 不包含）。 |

```text
tile     <input> [--preview <2x2|4x4|8x8>] [--edge-match <axis>] [--brightness-match <axis>]
                  [--output <png>] [--stdout] <file flags>
generate <pattern> --size <N|WxH> --palette <name|path> --seed <int>
                  [--output <png>] [--source <mcpx>] [--stdout] <file flags>
preview  <input> --ascii | --palette-map | --scale <N> | --nine-slice --mcmeta <path>
                  [--output <png>] [--stdout] <file flags>
gui-scale <input> --size <N|WxH> [--mcmeta <path>]
                  [--minecraft-version <v>|--resource-pack-version <f>]
                  [--output <png>] [--stdout] <file flags>
```

- `generate` 支持的确定性图样有 `noise`、`clustered-noise`、`stripes`、`checker`、`gradient`、`brick`、`spots`、`veins`、`cracks`、`grain`，并以 `--seed`（整数 0–4294967295）决定种子。
- `preview` 必须恰好指定一个模式标志：
  - `--ascii`：输出可与 `.grid` 互通的纯 ASCII 文本。
  - `--palette-map`：输出 JSON 调色板索引。
  - `--scale <N>`：以最近邻法放大并输出 PNG。
  - `--nine-slice`：按 `.mcmeta` 评估 GUI 九宫格边界，并附视觉参考线。
- `gui-scale`（尚未发布，`v0.3.1` 不包含）以 `.mcmeta` 的 `gui.scaling`（stretch／tile／nine_slice）规则，把 GUI 精灵图映射到明确的目标尺寸：
  - `--mcmeta` 必须是显式路径，绝不推导同名文件；省略即为 `stretch`。
  - 输出只有 PNG。
  - 九宫格边框不合法为 `INVALID_MCMETA`（状态码 2）。
  - 目标版本早于 `stretch_inner`（资源包格式 42）且该字段为 true 时，忽略该字段并报告 `STRETCH_INNER_IGNORED` warning。
  - 既有的 `preview --nine-slice` 保持 guide preview 语义，两者是不同入口。

---

### 6. 动画与精灵图集

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `animate pack` | 帧目录（`.mcpx`） | PNG 精灵图集 | 将单张帧合并为精灵图集。 |
| `animate unpack <sheet>` | PNG 精灵图集 | 帧目录（`.mcpx`） | 将动画图集切分为单张帧。 |
| `animate reorder` | 帧目录 | 帧目录 | 按索引列表重新排列动画帧。 |
| `animate resize` | 帧目录 | 帧目录 | 缩放动画组内的所有帧。 |
| `animate validate` | 帧目录（加 `.mcmeta`） | 仅报告 | 按 `.mcmeta` 验证帧尺寸、播放序列索引与每步时间；重复或部分播放序列合法。 |
| `animate preview` | 帧目录 | 报告或 ASCII 预览 | 预览动画序列。 |

```text
animate pack     --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns <N>]
                 [--output <png>] [--stdout] <file flags>
animate unpack   <sheet.png> --layout <vertical|horizontal|grid> --frame-size <N|WxH>
                 [--columns <N>] [--mcmeta <path>] --output-dir <dir> <file flags>
animate reorder  --frames-dir <dir> --order <i,j,...> --output-dir <dir> <file flags>
animate resize   --frames-dir <dir> --frame-size <N|WxH> [--resize-mode <nearest|box|pixel-aware>]
                 --output-dir <dir> <file flags>
animate validate --frames-dir <dir> [--mcmeta <path>] [--profile <name>] [--json]
animate preview  --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns <N>]
                 [--ascii] [--profile <name>] [--json]
```

---

### 7. 检查、验证与资源包核对

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `analyze <image>` | PNG、JPEG、WebP | 仅报告 | 结构与色彩指标（预测分类）。 |
| `inspect <input>` | PNG、JPEG、WebP、`.mcpx` | 仅报告（`--json` 的 view 另附 PNG 字节） | 冻结的结构报告或合成后的 view（只读；尚未发布，`v0.3.1` 不包含）。 |
| `validate <asset>` | 资产文件（PNG） | 仅报告（有缺陷时状态码 3） | 验证单个资产贴图与可选的 `.mcmeta`。 |
| `validate-pack <path>` | 资源包根目录 | 仅报告（有缺陷时状态码 3） | 完整扫描资源包的完整性、命名空间、模型、贴图与图集。 |

```text
analyze       <image> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
inspect       <input> --mode <structure|view> [--crop <scope>] [--scale <N>] [--json]
validate      <asset> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--mcmeta <path>] [--json]
validate-pack <path>  [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--vanilla <path>] [--dependency <path>]... [--json]
```

- 验证的状态码：通过为 0；验证检查失败为 3（`VALIDATION_FAILED`）；调用语法错误为 2；文件系统错误为 4。
- 版本指定：`--minecraft-version` 接受 release 版本 `1.19.3` 到 `26.3`（例如 `1.19.3`、`1.21.4`、`26.3`；每个 release 对应其资源包格式）；`--resource-pack-version` 接受 `N` 或 `N.M`（例如 `84`、`97.1`），会规范化为 `major.minor`。两个标志互斥，都不给则保持引擎默认。
- 版本回显：人类可读报告打印 `target: minecraft <v> / resource-pack <f>`、`target: resource-pack <f>` 或 `target: default (engine defaults)`；`--json` 携带 `version: { minecraftVersion?, resourcePackVersion? }`，均为规范化后的 dotted 字符串。
- 无标志时的解析：不带版本标志的 `validate-pack` 会读取根目录 `pack.mcmeta`，依次取 `pack.max_format`、`pack.min_format`、旧制 `pack.pack_format`（整数、`[major, minor]` 数组或 dotted 字符串，均规范化为 `major.minor`）；解析出的目标打印为 `pack.mcmeta resource-pack <f>`。`supported_formats` 不参与目标选择；没有可用值时只警告一次（`PACK_VERSION_UNDETERMINED`），不套用任何默认。
- `--vanilla`：调用端提供的原版资源树（pack 根目录形状，含 `assets/`）。提供后 `minecraft` 命名空间的引用会在该树中确认；未提供时报告 `PACK_UNRESOLVED_EXTERNAL` warning 并记入 coverage，不再直接判为缺失。
- `--dependency`：依赖资源包的根目录，可重复；第一个优先级最高。
- coverage：`validate` 与 `validate-pack` 的报告都带 `coverage: {status, skipped}`；`partial` 表示有检查因故跳过（例如 `vanilla-not-provided`、`unsupported-source-type`、`unsupported-regex`、`unknown-node-type`、`renderer-fields-not-interpreted`、`version-undetermined`、`model-documents-not-loaded`），每个 skip 都带 `kind`／`reason`／`target`。coverage 不改变状态码（通过仍为 0、失败仍为 3）。texture variable 的解析只读当前包的模型文件；超出该范围的变量以 `model-documents-not-loaded` coverage 报告，不跨依赖或原版包解析。
- `inspect` 尚未发布（`v0.3.1` 不包含），为只读，不接受文件标志（`INVALID_ARGUMENT`）：`--mode structure`（默认）报告图层（id、名称、索引、原始 alpha 边界、面积、可见性、不透明度、混合模式、原始 RGBA 颜色用量，含 alpha 为 0 下隐藏的颜色，截断至稳定的前 16 色）、区域（id、名称、索引、边界，只报面积）与重叠（图层方框交集加实际区域遮罩交集）；`--mode view` 以 `--crop <scope>`（选择表达式；空匹配为 `EMPTY_SELECTION`）与 `--scale <N>`（整数 1–16，最近邻；默认 1）渲染合成像素，在 `--json` 下返回六键 metadata（`mode`、`sourceDimensions`、`crop`、`scale`、`outputDimensions`、`colorFormat`）加 `pngBase64`。长边自动缩放（缩放前长边低于 128 时往 128 补整数倍，上限 16）只适用于尚未发布的 `apply_asset_operations` `feedback` 图像，不适用于 `inspect view`。输出任一边超过 1024px 时以 `RESOURCE_LIMIT_EXCEEDED` 拒绝并提示改用更小的 crop，不会静默缩小。顶层 `inspect` 与 `palette inspect`（调色板特征）是不同入口，不要混淆。

---

### 8. Model Context Protocol（MCP）服务器

```text
mc-asset mcp
```

启动原生 Model Context Protocol（MCP）stdio 服务器，供 LLM Agent 集成，提供 21 个原生工具，无需另起子进程：
- `analyze_asset`
- `pixelize_asset`
- `render_pixel_asset`
- `apply_asset_operations`
- `recolor_asset`
- `create_variants`
- `validate_asset`
- `import_asset`
- `build_asset`
- `transform_asset`
- `quantize_asset`
- `cleanup_asset`
- `palette_asset`
- `material_asset`
- `tile_asset`
- `generate_asset`
- `preview_asset`
- `animate_asset`
- `validate_pack_asset`
- `scale_gui_asset`
- `inspect_asset`

---

## 批处理操作规范（`--operations`）

`import`、`render` 与 `build` 可通过 `--operations <path>` 或 `--operations -`（stdin）应用批处理像素编辑。

格式为操作对象组成的 JSON 数组：
```json
[
  { "type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF" },
  { "type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF" },
  { "type": "drawRect", "rect": { "x": 2, "y": 2, "width": 4, "height": 4 }, "color": "#0000FFFF" },
  { "type": "fillRect", "rect": { "x": 8, "y": 8, "width": 4, "height": 4 }, "color": "#FFFF00FF" },
  { "type": "floodFill", "x": 3, "y": 3, "color": "#FF00FFFF" },
  { "type": "clearPixel", "x": 0, "y": 0 },
  { "type": "ellipse", "rect": { "x": 1, "y": 1, "width": 6, "height": 4 }, "color": "#FF0000FF", "mode": "fill" },
  { "type": "polygonFill", "points": [[0, 0], [4, 0], [2, 3]], "color": "#00FF00FF" },
  { "type": "strokeMask", "layerId": "base", "source": "alpha:base", "color": "#FFFFFFFF" }
]
```

同样的 JSON 形状也适用于 MCP 的 `apply_asset_operations`：可使用裸数组或 `{"operations": [...]}` 包裹；空数组是合法的无操作。每个操作都可附可选的字符串 `id`（同一批次内不可重复）。单图层画布可省略 `layerId`（默认为唯一图层）；多图层画布必须显式指定（`regionFromSelection`、`mergeLayer` 与区域操作不接受 `layerId`）。颜色为 `transparent`、`#RRGGBB` 或 `#RRGGBBAA`；坐标均为整数，不做四舍五入。

九个像素操作都可附可选的 `selection`（选择表达式的原子字符串或对象，语法与 `--selection` 相同）。只有被选中的像素会写入；未被选中的原始字节原样保留，含 alpha 为 0 下隐藏的 RGB。`fillRect` 在有 `selection` 时可省略 `rect`（填充范围取选择表达式的边界框，再以选择表达式裁剪）。新形状遵守冻结的整数几何与选择裁剪（三者皆尚未发布，`v0.3.1` 不包含）：`ellipse` 沿 `rect` 内接的椭圆填充或描边（`mode` 必填，`fill` 或 `outline`）；`polygonFill` 填充 `points` 围出的多边形；`strokeMask` 在 `layerId` 上描出 `source` 选择读取范围的轮廓，不绘制范围本身。选择表达式一个像素都没命中时，以 `EMPTY_SELECTION` 拒绝写入并回滚整批；`quantize`／`cleanup`／`recolor` 的 `--selection` 路径维持既有的还原行为。

选择表达式可写原子（`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`）或 JSON AST 对象（`{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`），深度上限 32、节点上限 1024。JSON AST 对象写法尚未发布，`v0.3.1` 不包含。

| `type` | 必填键 | 选填键 | 示例 |
|---|---|---|---|
| `setPixel` | `x`、`y`、`color` | `layerId`、`selection`、`id` | `{"type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF"}` |
| `clearPixel` | `x`、`y` | `layerId`、`selection`、`id` | `{"type": "clearPixel", "x": 0, "y": 0}` |
| `drawLine` | `from`、`to`、`color` | `layerId`、`selection`、`id` | `{"type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF"}` |
| `drawRect` | `rect`、`color` | `layerId`、`selection`、`id` | `{"type": "drawRect", "rect": {"x": 2, "y": 2, "width": 4, "height": 4}, "color": "#0000FFFF"}` |
| `fillRect` | `color`（有 `selection` 时可省略 `rect`） | `layerId`、`rect`、`selection`、`id` | `{"type": "fillRect", "rect": {"x": 8, "y": 8, "width": 4, "height": 4}, "color": "#FFFF00FF"}` |
| `floodFill` | `x`、`y`、`color` | `layerId`、`selection`、`id` | `{"type": "floodFill", "x": 3, "y": 3, "color": "#FF00FFFF"}` |
| `ellipse`（尚未发布） | `rect`、`color`、`mode`（`fill`／`outline`） | `layerId`、`selection`、`id` | `{"type": "ellipse", "rect": {"x": 1, "y": 1, "width": 6, "height": 4}, "color": "#FF0000FF", "mode": "fill"}` |
| `polygonFill`（尚未发布） | `points`（`[x, y]` 整数对数组）、`color` | `layerId`、`selection`、`id` | `{"type": "polygonFill", "points": [[0, 0], [4, 0], [2, 3]], "color": "#00FF00FF"}` |
| `strokeMask`（尚未发布） | `layerId`、`source`（选择表达式）、`color` | `selection`、`id` | `{"type": "strokeMask", "layerId": "base", "source": "alpha:base", "color": "#FFFFFFFF"}` |
| `createLayer` | （无） | `layerId`（新 id）、`name`、`id` | `{"type": "createLayer", "layerId": "shade"}` |
| `removeLayer` | `layerId` | `id` | `{"type": "removeLayer", "layerId": "shade"}` |
| `renameLayer` | `layerId`、`name` | `id` | `{"type": "renameLayer", "layerId": "shade", "name": "shadow"}` |
| `reorderLayer` | `layerId`、`toIndex` | `id` | `{"type": "reorderLayer", "layerId": "shade", "toIndex": 0}` |
| `duplicateLayer` | `layerId` | `newLayerId`、`name`、`id` | `{"type": "duplicateLayer", "layerId": "shade", "newLayerId": "shade-copy"}` |
| `mergeLayer` | `sourceId`、`targetId` | `id` | `{"type": "mergeLayer", "sourceId": "shade", "targetId": "base"}` |
| `clearLayer` | `layerId` | `id` | `{"type": "clearLayer", "layerId": "shade"}` |
| `fillLayer` | `layerId`、`color` | `id` | `{"type": "fillLayer", "layerId": "shade", "color": "#0000FFFF"}` |
| `moveLayer` | `layerId`、`dx`、`dy` | `id` | `{"type": "moveLayer", "layerId": "shade", "dx": 1, "dy": -1}` |
| `createRegion` | （无） | `regionId`（新 id）、`name`、`id` | `{"type": "createRegion", "regionId": "mask"}` |
| `removeRegion` | `regionId` | `id` | `{"type": "removeRegion", "regionId": "mask"}` |
| `renameRegion` | `regionId`、`name` | `id` | `{"type": "renameRegion", "regionId": "mask", "name": "cutout"}` |
| `reorderRegion` | `regionId`、`toIndex` | `id` | `{"type": "reorderRegion", "regionId": "mask", "toIndex": 0}` |
| `setRegionPixel` | `regionId`、`x`、`y`、`value` | `id` | `{"type": "setRegionPixel", "regionId": "mask", "x": 1, "y": 2, "value": 1}` |
| `stampRect`（尚未发布） | `layerId`、`source`、`to`／`offset` 择一 | `transform`（`flip`：`h`／`v`；`rotate`：`0`／`90`／`180`／`270`）、`merge`（默认 `replace`／`source-over`）、`carryRegions`（默认 false）、`selection`、`id` | `{"type": "stampRect", "layerId": "base", "source": "rect:8,8,8,8", "offset": {"dx": 0, "dy": 8}}` |
| `regionFromSelection`（尚未发布） | `selection`、`mode`（`create`／`update`） | `regionId`、`name`、`id` | `{"type": "regionFromSelection", "selection": "alpha:base", "mode": "create", "regionId": "body"}` |

`from`／`to` 为 `[x, y]` 整数对；`rect` 为 `{x, y, width, height}`，宽高至少为 1；`toIndex` 为 0 或正整数；`value` 为 `0`（外部）或 `1`（内部）。`polygonFill` 最多 4096 个点，超过为 `RESOURCE_LIMIT_EXCEEDED`；自交的环为 `SELF_INTERSECTING_POLYGON`，孔洞不支持（嵌套的环会被视为各自独立的轮廓）。`stampRect` 复制 `source` 读取范围而不清空它（`source` 决定读什么，`selection` 只裁剪写入；`to` 固定变换后输出的左上角，`offset` 相对来源边界平移，两者并存为 `ARGUMENT_CONFLICT`）。未知的 `type` 为 `INVALID_ARGUMENT`；重复的 `id` 为 `DUPLICATE_OPERATION_ID`。

批处理执行是原子的：只要有一个操作无效，就会回滚所有更改。（MCP 的 `apply_asset_operations` 另接受 `atomic: false`，此时会跑完每个操作，以各操作的 applied／failed 状态报告，不再回滚。）

---

## 退出状态码注册表

| 状态码 | 类别 | 说明 | 示例 |
|---|---|---|---|
| **0** | 成功 | 命令顺利完成。 | 验证全部通过、成功渲染。 |
| **1** | 内部错误 | 未处理的引擎缺陷（`INTERNAL_ERROR`）。 | 引擎发生非预期失败。 |
| **2** | 无效调用 | 语法错误、标志冲突、缺少必要参数。 | 缺少 `--output`、同时使用 `--force --in-place`。 |
| **3** | 资产验证失败 | 引擎运行正常，但资产或资源包未通过验证。 | `VALIDATION_FAILED`、贴图损坏、`.mcmeta` 有误。 |
| **4** | 文件系统拒绝 | 文件已存在且未加 `--force`，或缺少目录且未加 `--mkdir`。 | `OUTPUT_EXISTS`、`FILESYSTEM_ERROR`。 |
| **5** | 不支持／资源上限 | 输入格式不支持，或超出画布上限。 | 图像头损坏、`UNSUPPORTED_IMAGE_FORMAT`。 |
