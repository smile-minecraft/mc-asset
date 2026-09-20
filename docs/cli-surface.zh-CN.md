# CLI 接口规范

[English](cli-surface.md) | [繁體中文](cli-surface.zh-TW.md) | [简体中文](cli-surface.zh-CN.md)

入口：`mc-asset`（本地开发时可用 `bun src/cli/index.ts`）。

全局行为遵循确定性标准：通道分工、`OUTPUT_EXISTS`／`--force`／`--mkdir`、原子写入，以及 `--force` 与 `--in-place` 互斥。退出状态码由 `src/core/errors.ts` 的错误码注册表统一定义。

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
                  [--resize <WxH>] [--resize-mode <nearest|box>]
                  [--translate <dx,dy>] [--selection <scope>] <file flags>
```

- 每次调用只能使用**一个**几何标志，同时使用多个会报告 `ARGUMENT_CONFLICT`。
- `--selection` 将操作限定在 `rect:x,y,w,h` 或 `region:id`。几何操作与 `--selection` 并用会报告 `ARGUMENT_CONFLICT`。

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
- 预设（preset）会按资产用途设定颜色数与清理启发式。

---

### 5. 程序化生成、平铺与预览

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `tile <input>` | PNG、JPEG、WebP、`.mcpx` | 仅报告，或 PNG | 接缝分析、边缘重复分析，或平铺修复与预览。 |
| `generate <pattern>` | 无 | PNG 和／或 `.mcpx` | 确定性的程序化贴图生成器。 |
| `preview <input>` | PNG、JPEG、WebP、`.mcpx` | 仅报告，或 PNG | ASCII 预览、调色板映射、九宫格参考线，或最近邻放大。 |

```text
tile     <input> [--preview <2x2|4x4|8x8>] [--edge-match <axis>] [--brightness-match <axis>]
                 [--output <png>] [--stdout] <file flags>
generate <pattern> --size <N|WxH> --palette <name|path> --seed <int>
                 [--output <png>] [--source <mcpx>] [--stdout] <file flags>
preview  <input> --ascii | --palette-map | --scale <N> | --nine-slice --mcmeta <path>
                 [--output <png>] [--stdout] <file flags>
```

- `generate` 支持的确定性图样有 `noise`、`clustered-noise`、`stripes`、`checker`、`gradient`、`brick`、`spots`、`veins`、`cracks`、`grain`，并以 `--seed`（整数 0–4294967295）决定种子。
- `preview` 必须恰好指定一个模式标志：
  - `--ascii`：输出可与 `.grid` 互通的纯 ASCII 文本。
  - `--palette-map`：输出 JSON 调色板索引。
  - `--scale <N>`：以最近邻法放大并输出 PNG。
  - `--nine-slice`：按 `.mcmeta` 评估 GUI 九宫格边界，并附视觉参考线。

---

### 6. 动画与精灵图集

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `animate pack` | 帧目录（`.mcpx`） | PNG 精灵图集 | 将单张帧合并为精灵图集。 |
| `animate unpack <sheet>` | PNG 精灵图集 | 帧目录（`.mcpx`） | 将动画图集切分为单张帧。 |
| `animate reorder` | 帧目录 | 帧目录 | 按索引列表重新排列动画帧。 |
| `animate resize` | 帧目录 | 帧目录 | 缩放动画组内的所有帧。 |
| `animate validate` | 帧目录（加 `.mcmeta`） | 仅报告 | 按 `.mcmeta` 验证帧尺寸与数量。 |
| `animate preview` | 帧目录 | 报告或 ASCII 预览 | 预览动画序列。 |

```text
animate pack     --frames-dir <dir> --layout <vertical|horizontal|grid> [--columns <N>]
                 [--output <png>] [--stdout] <file flags>
animate unpack   <sheet.png> --layout <vertical|horizontal|grid> --frame-size <N|WxH>
                 [--columns <N>] [--mcmeta <path>] --output-dir <dir> <file flags>
animate reorder  --frames-dir <dir> --order <i,j,...> --output-dir <dir> <file flags>
animate resize   --frames-dir <dir> --frame-size <N|WxH> [--resize-mode <nearest|box>]
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
| `validate <asset>` | 资产文件（PNG） | 仅报告（有缺陷时状态码 3） | 验证单个资产贴图与可选的 `.mcmeta`。 |
| `validate-pack <path>` | 资源包根目录 | 仅报告（有缺陷时状态码 3） | 完整扫描资源包的完整性、命名空间、模型、贴图与图集。 |

```text
analyze       <image> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
validate      <asset> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--mcmeta <path>] [--json]
validate-pack <path>  [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
```

- 验证的状态码：通过为 0；验证检查失败为 3（`VALIDATION_FAILED`）；调用语法错误为 2；文件系统错误为 4。
- 版本指定：`--minecraft-version` 接受 `1.21.11`、`26.1`、`26.1.1`、`26.1.2`、`26.2`、`26.3`（对应资源包 `75.0`、`84.0`、`84.0`、`84.0`、`88.0`、`97.1`）；`--resource-pack-version` 接受 `N` 或 `N.M`（例如 `84`、`97.1`），会规范化为 `major.minor`。两个标志互斥，都不给则保持引擎默认。
- 版本回显：人类可读报告打印 `target: minecraft <v> / resource-pack <f>`、`target: resource-pack <f>` 或 `target: default (engine defaults)`；`--json` 携带 `version: { minecraftVersion?, resourcePackVersion? }`，均为规范化后的 dotted 字符串。
- 无标志时的解析：不带版本标志的 `validate-pack` 会读取根目录 `pack.mcmeta`，依次取 `pack.max_format`、`pack.min_format`、旧制 `pack.pack_format`（整数、`[major, minor]` 数组或 dotted 字符串，均规范化为 `major.minor`）；解析出的目标打印为 `pack.mcmeta resource-pack <f>`。`supported_formats` 不参与目标选择；没有可用值时只警告一次（`PACK_VERSION_UNDETERMINED`），不套用任何默认。

---

### 8. Model Context Protocol（MCP）服务器

```text
mc-asset mcp
```

启动原生 Model Context Protocol（MCP）stdio 服务器，供 LLM Agent 集成，提供 7 个原生工具，无需另起子进程：
- `analyze_asset`
- `pixelize_asset`
- `render_pixel_asset`
- `apply_asset_operations`
- `recolor_asset`
- `create_variants`
- `validate_asset`

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
  { "type": "clearPixel", "x": 0, "y": 0 }
]
```

批处理执行是原子的：只要有一个操作无效，就会回滚所有更改。

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
