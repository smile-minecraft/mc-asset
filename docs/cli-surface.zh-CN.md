# CLI 接口规范

[English](cli-surface.md) | [繁體中文](cli-surface.zh-TW.md) | [简体中文](cli-surface.zh-CN.md)

## 目录

- [全局标志](#全局标志)
- [通用文件标志（会产生文件的命令）](#通用文件标志会产生文件的命令)
  - [安全与文件系统保证](#安全与文件系统保证)
- [命令参考](#命令参考)
  - [1. 导入、编写与源码构建](#1-导入编写与源码构建)
  - [2. 空间与几何变换](#2-空间与几何变换)
  - [3. 调色板、量化与清理](#3-调色板量化与清理)
  - [4. 像素画管线](#4-像素画管线)
  - [5. 程序化生成、平铺与预览](#5-程序化生成平铺与预览)
  - [6. 动画与精灵图集](#6-动画与精灵图集)
  - [7. 检查、验证与资源包核对](#7-检查验证与资源包核对)
  - [8. Model Context Protocol（MCP）服务器](#8-model-context-protocolmcp服务器)
  - [9. PNG 优化与 Java 模型](#9-png-优化与-java-模型)
- [批处理操作规范（`--operations`）](#批处理操作规范--operations)
- [退出状态码注册表](#退出状态码注册表)
- [常见错误排查指南（Troubleshooting）](#常见错误排查指南troubleshooting)

---

入口：`mc-asset`（本地开发时可用 `bun src/cli/index.ts`）。

全局行为遵循确定性标准：通道分工、`OUTPUT_EXISTS`／`--force`／`--mkdir`、原子写入，以及 `--force` 与 `--in-place` 互斥。退出状态码由 `src/core/errors.ts` 的错误码注册表统一定义。

各版本的变更（包括每个命令与操作何时加入）记录在 [`CHANGELOG.md`](../CHANGELOG.md)。

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
| `pack init <dir>` | 无 | 项目骨架 | 生成项目文件、资源包根 metadata、占位图标与资源包目录。 |

```text
import <image> [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
render <grid>  [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
build  [source] [--stdin] [--output <png>] [--source <mcpx>] [--stdout] [--operations <path|->] <file flags>
pack init <dir> --namespace <ns> --minecraft-version <version> [--name <name>] [--description <text>]
       [--style <id|path>] [--resource-pack-version <N>] [--allow-minecraft-namespace]
```

- `pack init <dir>` 一次预检后整批写出骨架：项目根目录的项目文件 `mc-asset.pack.json`、按目标版本生成的 `pack/pack.mcmeta`、64x64 的 `pack/pack.png` 占位图标，以及目录 `recipes/`、`pack/assets/<ns>/textures/item`、`pack/assets/<ns>/textures/block`、`pack/assets/<ns>/models/item`，资源包格式 46.0 起再加上 `pack/assets/<ns>/items/`。`--namespace` 与 `--minecraft-version` 必填，其余设置都有默认值（项目名取自目录名、说明取自项目名、风格为 `vanilla`、输出目录为 `pack`、配方目录为 `recipes`）。
- 项目文件记录 `formatVersion`、`name`、`description`、`namespace`、`allowMinecraftNamespace`、`minecraftVersion`、`resourcePackVersion`、`style`、`outputDir`、`recipeDir` 与 `vanillaSource`，并以严格模式读取：未知字段、不符类型的数据，或指向项目根之外的路径都是 `PACK_PROJECT_INVALID` 并带字段路径；读不到文件是 `PACK_PROJECT_NOT_FOUND`；`formatVersion` 更新是 `PACK_PROJECT_UNSUPPORTED_VERSION`。`--resource-pack-version` 会覆盖版本对应的资源包格式，但发布版本号仍会留在项目文件里；创建之后没有任何指令会改写这个文件。
- 根 metadata 按目标版本选择写法：资源包格式 65.0 起只声明该目标的 `min_format` 与 `max_format`，不写旧式的 `pack_format`；更早的版本只写单一旧式格式号。生成的文件会先在内存内跑一遍与 `validate-pack` 相同的根 metadata 规则，有问题就不写盘。版本不在 `1.19.3` 到 `26.3` 之间是 `INVALID_ARGUMENT` 并带上版本号，而且不会写任何文件。
- 每个预定路径都会在写入第一个字节前先读一遍。已经存在的路径会让整批拒绝，返回 `PACK_INIT_CONFLICT` 并附上 `conflicts` 清单（列出所有已存在的相对路径），所以重跑不会只覆盖一半；项目目录本身或其下任何位置是符号链接时是 `FILESYSTEM_ERROR`，而且永远不穿过链接写入。`init` 没有 `--force` 也没有 `--mkdir`：项目只创建一次。
- `namespace: minecraft` 会覆盖游戏本身的素材，因此需要 `--allow-minecraft-namespace`；没给时是 `PACK_PROJECT_INVALID`，字段指向 `namespace`。
- 占位图标是原创的 64x64 图案，用整数几何画出（棋盘底、带边框的方板、菱形标记），因此同一次请求永远写出相同的字节。

- `--source <path>` 会保存可编辑的 `.mcpx` 文本源码。
- `--in-place` 直接改写输入文件（对该目标等同 force）。
- `build --stdin` 与 `--operations -` 同时使用会报告 `ARGUMENT_CONFLICT`。
- 关于可编辑的 `.mcpx` v1 与 `.grid` 语法、规范小节顺序、精简／标记网格规则及错误码，请参阅 [`docs/mcpx-format.zh-CN.md`](mcpx-format.zh-CN.md)。

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
- `--selection` 将操作限定在选择表达式：`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`，或 JSON 表达式对象 `{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`（以 `{` 开头走 JSON 路径，其余解析为原子）。几何操作与 `--selection` 并用会报告 `ARGUMENT_CONFLICT`。

---

### 3. 调色板、量化与清理

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `quantize <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 将不同颜色的数量缩减到目标值，或映射到指定调色板；保留色保持不变。 |
| `cleanup <input>` | PNG、JPEG、WebP、`.mcpx` | PNG 和／或 `.mcpx` | 检测或消除孤立点、噪点与离群像素。 |
| `palette extract <image>` | PNG、JPEG、WebP、`.mcpx` | 仅报告 | 提取图像中不重复的 RGBA 颜色。 |
| `palette inspect <image>` | PNG、JPEG、WebP、`.mcpx` | 仅报告 | 分析调色板分布、角色与对比度。 |
| `material list` | 无 | 仅报告 | 列出可用的内置材质定义。 |
| `material show <name>` | 无 | 仅报告 | 查看某个材质的色阶与定义。 |
| `recolor <source>` | `.mcpx`、PNG | PNG 和／或 `.mcpx` | 将颜色重新映射到内置材质调色板。 |
| `variant <source>` | `.mcpx`、PNG | `--output-dir` 下的多个文件 | 生成材质变体（例如 iron、copper、gold）。 |
| `style list` | 无 | 仅报告 | 列出内置风格预设。 |
| `style show <style>` | 无 | 仅报告 | 把某个风格（内置 id 或 `.style.json` 路径）解析为完整 JSON。 |
| `style export-palette <style>` | 无 | `.mcpx` 调色板文件 | 把单个家族或全部家族的调色板写成 `.mcpx`。 |
| `style create` | 无 | `.style.json` 文件 | 写出新的风格文件。 |

```text
quantize <input> (--colors <N> | --palette <name|path>) [--keep-color <r,g,b,a> ...] [--selection <scope>] <file flags>
cleanup  <input> [--fix <classes>] [--allow-render-pass-change] [--selection <scope>] <file flags>
recolor  <source> --material <name> [--region <id>] [--selection <scope>] <file flags>
variant  <source> --materials <a,b,...> --output-dir <dir> [--mkdir] [--force] [--profile <p>]
style list
style show <style>
style export-palette <style> --family <id|all> --output <file.mcpx> [--force] [--mkdir]
style create --output <file.style.json> --id <id> [--name <name>] [--extends <id|path>] [--force] [--mkdir]
```

- `quantize` 必须恰好给出 `--colors` 或 `--palette` 之一：两者并用是 `ARGUMENT_CONFLICT`，都没给是 `INVALID_ARGUMENT`。`--palette` 接受内置材质名或 `.mcpx` 路径（最多 4096 色，按声明顺序，含未使用项）。每个像素按整数 RGBA 平方距离映射到最近的项；距离相同取靠前的项，alpha 为 0 的隐藏 RGB 也参与。
- `--keep-color <r,g,b,a>`（可重复）让该 RGBA 完全不变。配合 `--palette` 时，保留色必须是调色板中的项（否则 `INVALID_ARGUMENT`）。配合 `--colors` 时，每层只把选择范围内实际出现的不重复保留色计入预算，其余选中像素用剩余预算量化；预算用完则映射到保留色，保留色多于预算会在写入前返回 `INVALID_ARGUMENT`。使用 `--keep-color` 或 `--palette` 时，`--selection` 会把预算与映射限制在选中像素，范围外字节不变。
- 调色板文件是只读输入，任何输出参数（含 `--force`、`--in-place`）都不能覆盖它。量化用的调色板可能与写出的 `.mcpx` 声明板不同，后者沿用画布原有的板。`--json` 结果在使用时会多出 `palette` 与 `keepColors`（RGBA 对象）；`colorCount` 是各层量化调色板颜色数的最大值。
- `cleanup --fix <classes>`：以逗号分隔的类别列表（`isolated`、`noise`、`cluster`、`fringe`、`outlier`、`hole`、`aa`）。修改会影响 alpha 的类别时，必须加 `--allow-render-pass-change`。
- `palette` 与 `material` 子命令只输出报告，收到文件写入标志会被拒绝（`INVALID_ARGUMENT`）。
- `recolor` 与 `variant` 接受可编辑的 `.mcpx` 来源或扁平 PNG。PNG 没有调色板角色信息，因此像素按整数明度分段映射到目标材质调色板（96 以下为暗部、96 到 159 为中间、160 以上为亮部），不会虚构图层角色。全透明像素（alpha 为 0）保持字节不变，包含隐藏 RGB，区域遮罩也不会被改写。PNG 搭配 `--region` 时，缺失区域沿用既有的 `REGION_NOT_FOUND` 错误；`--selection` 仍可限定写回范围，未选中像素会原样还原。JPEG 与 WebP 仍会被拒绝（`INVALID_ARGUMENT`）。`variant` 的每个材质都从同一个原始来源独立生成，材质顺序不影响结果；文件命名为 `<stem>_<material>.png` 加 `<stem>_<material>.mcpx`。输入文件不会被修改；所有文件目标会在写入前先做联合预检。
- `style` 有四个内置预设：`vanilla`、`soft`、`fairy-flat`、`dark-frame`。每个预设都含十二个家族（`iron`、`gold`、`diamond`、`netherite`、`copper`、`wood`、`stone`、`emerald`、`amethyst`、`redstone`、`lapis`、`quartz`），每个家族六个角色（`outline`、`shadow`、`dark`、`base`、`light`、`highlight`），以及外框、光向、明暗级数、高光、抖动与动画规则。风格来源可以是内置 id，也可以是 `.style.json` 路径；自定义文件通过 `extends` 继承一个来源（最多八层），可覆盖单个字段、整个家族或分类阈值。
- `style list` 与 `style show` 只输出报告，不写任何文件。`style show` 打印解析后的文档：`formatVersion`、`id`、`name`、`description`、`palettes`、`outline`、`light`、`limits`、`highlight`、`dither`、`animation`、`categoryOverrides`，以及从所求来源一路走到基底的 `extendsChain`。
- `style export-palette --family <id|all> --output <file.mcpx>` 写出调色板文档：每行一个家族、每列一个角色，`[palette]` 按家族再按角色排序、`.` 排在最前对应 `#00000000`，并带 `kind = palette`。输出可直接喂给 `quantize --palette` 与 `generate --palette`。指定解析后不存在的家族是 `STYLE_FAMILY_NOT_FOUND`；没给 `--output` 则是 `OUTPUT_REQUIRED`。
- `style create` 先让文档通过校验，再写出 `{formatVersion, id, name, extends}`（`extends` 默认为 `vanilla`），写入同样走共用输出保护：目标必须以 `.style.json` 结尾、已有文件需要 `--force`、父目录不存在需要 `--mkdir`，而且目标不得是它继承的来源。工具不会改写自己没有创建的风格文件，其他命令也不会写风格文件。
- 风格文件以严格模式读取：未知字段、枚举外的值，或不是 `#RRGGBB` 的颜色都是 `STYLE_INVALID`，并带字段路径（例如 `palettes.stone.base: expected #RRGGBB, got "#12345"`）。读不到或解析失败的文件、版本高于支持范围的 `formatVersion`（`STYLE_UNSUPPORTED_VERSION`）、`extends` 循环（`STYLE_INHERITANCE_CYCLE`）、`id` 撞到内置预设名称，以及查不到的内置 id（`STYLE_NOT_FOUND`），都会带上文件路径、字段路径与解析链。

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
| `gui-scale <input>` | PNG、JPEG、WebP、`.mcpx` | PNG | 以 mcmeta 的 stretch／tile／nine_slice 映射，把 GUI 精灵图缩放到明确的目标尺寸。 |

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
- `gui-scale`以 `.mcmeta` 的 `gui.scaling`（stretch／tile／nine_slice）规则，把 GUI 精灵图映射到明确的目标尺寸：
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
| `inspect <input>` | PNG、JPEG、WebP、`.mcpx` | 仅报告（`--json` 的 view 另附 PNG 字节） | 冻结的结构报告或合成后的 view（只读）。 |
| `validate <asset>` | 资产文件（PNG） | 仅报告（有缺陷时状态码 3） | 验证单个资产贴图与可选的 `.mcmeta`。 |
| `validate-pack <path>` | 资源包根目录 | 仅报告（有缺陷时状态码 3） | 完整扫描资源包的完整性、命名空间、模型、贴图与图集。 |
| `compare <before> <after>` | 两张同尺寸 PNG | 仅报告或诊断 PNG（`--output`、`--stdout`） | 比较两张同尺寸 PNG，回报原始 RGBA 与可见差异像素数及差异框。 |

```text
analyze       <image> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
inspect       <input> --mode <structure|view> [--crop <scope>] [--scale <N>] [--json]
validate      <asset> [--profile <p>] [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--mcmeta <path>] [--json]
validate-pack <path>  [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--vanilla <path>] [--dependency <path>]... [--json]
compare       <before> <after> [--output <path>] [--stdout] [--scale <N>] [--force] [--mkdir] [--json]
```

- 验证的状态码：通过为 0；验证检查失败为 3（`VALIDATION_FAILED`）；调用语法错误为 2；文件系统错误为 4。
- 版本指定：`--minecraft-version` 接受 release 版本 `1.19.3` 到 `26.3`（例如 `1.19.3`、`1.21.4`、`26.3`；每个 release 对应其资源包格式）；`--resource-pack-version` 接受 `N` 或 `N.M`（例如 `84`、`97.1`），会规范化为 `major.minor`。两个标志互斥，都不给则保持引擎默认。
- 版本回显：人类可读报告打印 `target: minecraft <v> / resource-pack <f>`、`target: resource-pack <f>` 或 `target: default (engine defaults)`；`--json` 携带 `version: { minecraftVersion?, resourcePackVersion? }`，均为规范化后的 dotted 字符串。
- 无标志时的解析：不带版本标志的 `validate-pack` 会读取根目录 `pack.mcmeta`，依次取 `pack.max_format`、`pack.min_format`、旧制 `pack.pack_format`（整数、`[major, minor]` 数组或 dotted 字符串，均规范化为 `major.minor`）；解析出的目标打印为 `pack.mcmeta resource-pack <f>`。`supported_formats` 不参与目标选择；没有可用值时只警告一次（`PACK_VERSION_UNDETERMINED`），不套用任何默认。
- `pack.mcmeta` 结构：`validate-pack` 把解析出的根目录 `pack.mcmeta` 拿去对游戏行为。`PACK_MCMETA_INVALID`（错误，会让扫描失败）处理游戏拒绝加载的写法：缺少 `pack` 区段或 `pack.description`、`min_format`／`max_format` 只写一半、负值或上下颠倒的范围、与声明范围不一致的 `supported_formats`（含 `min_format` 在 65 之后仍保留该字段）、落在声明 major 之外的旧制 `pack_format`、字符超出 `[-_a-zA-Z0-9.]` 的 overlay 目录名，以及违反旧格式规则的 overlay `formats` 字段（任一条目低于 65 时每条都要写，无人低于 65 时一律不得写）。`PACK_MCMETA_SUSPICIOUS`（警告，本身不会让扫描失败）处理加载正常但疑似失误的写法：pack 根目录没有的 overlay 目录、完全没写版本字段的 overlay 条目、落在声明范围外的扫描目标。游戏接受的值一律不报：超过已知版本的 `max_format`，以及语法不涵盖的写法——扫描只报它能证明的缺陷，不能证明的就安静。
- overlay 覆盖率：版本范围涵盖扫描目标的 overlay 不解读，记一笔 `overlay`／`overlay-not-interpreted` skip 加一则 `PACK_COVERAGE_SKIPPED` 警告，契约与其他 skip 相同（coverage 本身不改变 verdict）。声明了但根目录没有的目录只警告不记 skip；没有解析出目标时不记任何 skip。
- `--vanilla`：调用端提供的原版资源树（pack 根目录形状，含 `assets/`）。提供后 `minecraft` 命名空间的引用会在该树中确认；未提供时报告 `PACK_UNRESOLVED_EXTERNAL` warning 并记入 coverage，不再直接判为缺失。
- `--dependency`：依赖资源包的根目录，可重复；第一个优先级最高。
- coverage：`validate` 与 `validate-pack` 的报告都带 `coverage: {status, skipped}`；`partial` 表示有检查因故跳过（例如 `vanilla-not-provided`、`unsupported-source-type`、`unsupported-regex`、`unknown-node-type`、`renderer-fields-not-interpreted`、`version-undetermined`、`model-documents-not-loaded`、`resource-type-not-interpreted: <类型>`、`trim-overrides-not-interpreted`、`particle-atlas-customized`、`internal-reference`、`pattern-reference`、`provider-not-interpreted`、`version-not-determined`、`feature-version-unknown`、`feature-not-in-version`、`unexpected-shape`、`overlay-not-interpreted`），每个 skip 都带 `kind`／`reason`／`target`。每个 skip 也会同时以一则 `PACK_COVERAGE_SKIPPED` 警告报告。coverage 本身不改变状态码也不改变 verdict（通过仍为 0、失败仍为 3）。texture variable 的解析只读当前包的模型文件；超出该范围的变量以 `model-documents-not-loaded` coverage 报告，不跨依赖或原版包解析。在 `assets/<命名空间>/` 之下，扫描会读取 `textures`、`models`、`blockstates`、`items`、`atlases`、`equipment`、`particles`、`font`；`lang` 为惰性，不读也不损失；其他顶层类型一律未解读，会让 coverage 变 `partial`，每个类型一笔 `uninterpreted-resource` skip（`resource-type-not-interpreted: <类型>`）加一则警告。装备 `layers.<部位类型>[].texture` 解析到 `textures/entity/equipment/<部位类型>/<路径>.png`（`models/equipment/` 只在 pack format 42.0 视为装备定义；`equipment/` 在 46.0 之后读取）；粒子 `textures[]` 解析到 `textures/particle/<路径>.png`；字体 `bitmap.file` 解析到 `textures/` 之下、`reference.id` 解析到另一个 `font/*.json`（pack format 15.0 之后读取）、`ttf.file` 解析到 `font/` 之下。在 item 定义不可用的 46.0 以前版本，旧式模型 `overrides[].model` 会解析，缺模型时为 `PACK_BROKEN_REFERENCE` 错误；46.0 之后完全不动。限制：包或依赖自带 `atlases/particles.json` 时粒子缺文件退成 skip，不检查粒子贴图；`trim_overrides[].texture` 只记 skip、不解析；字体 `reference` 的 15.0 界线与粒子 `#` 内部引用规则是未经证实的推论；三个类型的最早版本未查证，旧但已知的版本仍可能报错；惰性清单目前只有 `lang`，含其他未解读类型的包会看到 `partial`；本工具没有在游戏客户端加载验证过。
- 贴图引用：模型贴图 ID 中的点保留为名称的一部分（`item/foo.v2` 解析到 `textures/item/foo.v2.png`），结尾明确带 `.png` 的输入仍兼容。字体 `bitmap.file` 是明确文件路径，直接使用原值。装备、粒子与字体的非法资源位置保留 `PACK_WRONG_PATH`、`PACK_NAMESPACE_PROBLEM`、`PACK_INVALID_FILENAME` 或 `PACK_CASE_MISMATCH`，不再改成 `PACK_BROKEN_REFERENCE`；空字符串维持 `PACK_BROKEN_REFERENCE`。确定缺文件与形状不符的 skip 维持原有分类。
- 系统文件忽略：`assets/` 下的操作系统元数据文件与归档镜像（`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*` AppleDouble 文件与 `__MACOSX` 目录）在资源包扫描时直接忽略，不产生任何 finding、不记录 coverage skip，也不改变 verdict。
- 未解读资源目录：位于 `assets/<命名空间>/<未解读类型>/` 目录内的文件跳过所有逐文件检查（文件名、JSON 语法、图像解码与错位检查均不再报告）；每个（命名空间，类型）保留一笔 `uninterpreted-resource` coverage skip 与一则 `PACK_COVERAGE_SKIPPED` 警告。直接位于命名空间目录底下的文件、`assets/` 根目录的命名空间层级问题，以及已解读类型（例如 `models/`）内放错位置的文件，均维持原本的代码与严重性层级报告。
- 原版贴图覆盖：提供 `--vanilla` 且原版树存在同路径贴图时，覆盖原版的贴图不再触发 `PACK_ORPHAN_TEXTURE`；未提供 `--vanilla` 时保持原样，且原版树中不存在的新自定义贴图仍会收到警告。
- 模板模型与贴图变量：被 `blockstates` 或 `items` 定义直接当作最终模型使用、且整条父模型链都无法解析的贴图变量，仍会报告 `PACK_BROKEN_REFERENCE` 错误；仅当作父模型使用、且子模型有在 `textures` 中提供该变量的模板模型，不产生任何 finding；未被任何定义或子模型使用且变量未解析的模型，以及单文件 `model validate`／`model inspect` 无从得知子模型时，报告 `PACK_UNRESOLVED_VARIABLE` 警告（状态码 0，不影响扫描判定结果）。提供 `--vanilla` 时，原版 `blockstates` 或 `items` 定义引用的被覆盖模型亦视为最终模型。
- 图集运行期贴图：模型引用的贴图若无对应文件，但可由资源包内或原版 atlas 的 `paletted_permutations` 条目在运行期生成时，不再报告 `PACK_MISSING_TEXTURE`；没有任何 atlas 能生成时维持原有的错误代码与严重性层级；缺少 atlas 信息时则维持现行行为。
- `inspect` 为只读，不接受文件标志（`INVALID_ARGUMENT`）：`--mode structure`（默认）报告图层（id、名称、索引、原始 alpha 边界、面积、可见性、不透明度、混合模式、原始 RGBA 颜色用量，含 alpha 为 0 下隐藏的颜色，截断至稳定的前 16 色）、区域（id、名称、索引、边界，只报面积）与重叠（图层方框交集加实际区域遮罩交集）；`--mode view` 以 `--crop <scope>`（选择表达式；空匹配为 `EMPTY_SELECTION`）与 `--scale <N>`（整数 1–16，最近邻；默认 1）渲染合成像素，在 `--json` 下返回六键 metadata（`mode`、`sourceDimensions`、`crop`、`scale`、`outputDimensions`、`colorFormat`）加 `pngBase64`。长边自动缩放（缩放前长边低于 128 时往 128 补整数倍，上限 16）只适用于 `apply_asset_operations` `feedback` 图像，不适用于 `inspect view`。输出任一边超过 1024px 时以 `RESOURCE_LIMIT_EXCEEDED` 拒绝并提示改用更小的 crop，不会静默缩小。顶层 `inspect` 与 `palette inspect`（调色板特征）是不同入口，不要混淆。

---

### 8. Model Context Protocol（MCP）服务器

```text
mc-asset mcp
```

启动原生 Model Context Protocol（MCP）stdio 服务器，供 LLM Agent 集成，提供原生工具，无需另起子进程：
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
- `optimize_asset`
- `model_asset`
- `mcmeta_asset`
- `compare_assets`

---

### 9. PNG 优化与 Java 模型

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `optimize <input...>` | 1 至 256 个明确的 PNG 文件 | 写到明确新路径的 PNG，或只出报告（`--dry-run`） | 无损重新编码成能精确表示像素的最小编码；没有更小的就保留源字节。 |
| `optimize --input-dir <dir>` | 包含 PNG 的目录（最多 4096 个 PNG，`--recursive`） | 保留相对目录结构写到 `--output-dir`，或只出报告（`--dry-run`） | 按 UTF-8 字节顺序扫描 PNG，检查预算上限（256 MiB 源文件、16,777,216 解码像素），无损重新编码各文件。 |
| `model inspect <file>` | Java 方块／物品模型 JSON | 只出报告 | 描述 parent、textures、elements、display 变换与解析后的引用。 |
| `model validate <file>` | Java 方块／物品模型 JSON | 只出报告（有缺陷时退出码 3） | 检查结构、UV、旋转、display 变换与引用是否有效。 |
| `model create` | 模型描述（`--spec`） | 模型 JSON | 按明确的描述创建模型文档。 |
| `model apply <file>` | 模型 JSON 加类型化操作（`--operations`） | 模型 JSON | 全部操作成功才写出新文档，否则一个都不应用。 |
| `model export <file>` | 模型 JSON，可选 binding（`--binding`） | 模型 JSON、物品定义、blockstate | 把模型放进资源包，并在旁边生成物品定义与 blockstate。 |
| `model preview <file>` | Java 方块／物品模型 JSON | 诊断 PNG（正面、右侧、上面） | 从长方体 `elements` 画出固定的三视图诊断图。 |

```text
optimize     <input...> (--output <png> | --output-dir <dir> | --stdout | --dry-run)
                        [--mode <auto|rgba|rgb|grayscale|grayscale-alpha|indexed>]
                        [--ancillary <preserve|strip>] [--force] [--mkdir] [--json]
optimize     --input-dir <dir> [--recursive] (--output-dir <dir> | --dry-run)
                        [--mode <auto|rgba|rgb|grayscale|grayscale-alpha|indexed>]
                        [--ancillary <preserve|strip>] [--force] [--mkdir] [--json]
model inspect  <file> [--pack <dir>] [--vanilla <dir>] [--dependency <dir>]...
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model validate <file> [--pack <dir>] [--vanilla <dir>] [--dependency <dir>]...
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model create   --spec <file|-> (--output <json> | --stdout) [--force] [--mkdir]
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model apply    <file> --operations <file|-> (--output <json> | --stdout) [--force] [--mkdir]
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model export   <file> [--output <json>] [--binding <file|->] [--item-output <json>]
                      [--blockstate-output <json>] [--pack <dir>] [--force] [--mkdir]
                      [--minecraft-version <v>] [--resource-pack-version <n>] [--json]
model preview  <file> [--pack <dir>] [--vanilla <dir>] [--dependency <dir>]...
                      [--minecraft-version <v>] [--resource-pack-version <n>]
                      [--size <64|128|256>] (--output <png> | --stdout) [--force] [--mkdir] [--json]
```

- `optimize` 的输入：可传入明确的 PNG 路径清单（1 至 256 个文件；不展开通配符、不遍历目录），或传入 `--input-dir <dir>`（可选 `--recursive`，最多 4096 个 PNG）。两者都提供会报告 `ARGUMENT_CONFLICT`；都没提供报告 `INVALID_ARGUMENT`。未指定 `--input-dir` 却提供 `--recursive` 报告 `ARGUMENT_CONFLICT`。
- 清单模式下，格式按签名判断，不是 PNG 的文件会报告 `UNSUPPORTED_IMAGE_FORMAT`。同一个文件出现两次，或两个输入在 `--output-dir` 下文件名相同，会报告 `ARGUMENT_CONFLICT`。
- 目录模式（`--input-dir`）：
  - 按 UTF-8 字节顺序遍历相对路径，输出目录保留原目录结构。创建中间输出目录需明确指定 `--mkdir`。
  - 绝不跟随符号链接：扫描范围内任何符号链接（含源根目录）或读取失败一律报告 `FILESYSTEM_ERROR`（`symlink-not-supported`）。
  - 源根目录与输出根目录必须互不相交：两者不得为别名（含大小写别名），也不得相互包含，违者报告 `ARGUMENT_CONFLICT`。
  - 写入前检查资源预算：最多 4096 个 PNG、总源文件大小上限 256 MiB（268,435,456 字节）、总解码像素上限 16,777,216，并沿用单图大小限制。任一超限皆报告 `RESOURCE_LIMIT_EXCEEDED` 且不自动分批。
  - 一般非 PNG 文件（如 `.mcmeta`、`.txt`、`.json`）自动跳过，不复制也不修改；目录内无任何 PNG 文件报告 `INVALID_ARGUMENT`。
  - 目录模式只接受 `--output-dir` 或 `--dry-run`；单文件输出（`--output`）或 `--stdout` 会报告 `ARGUMENT_CONFLICT`。
  - 在 `--dry-run` 下，不创建目录、不写文件，也不碰非 PNG 文件（`.mcmeta` 等），直接返回所有 PNG 的计算报告。
- `optimize` 的输出：清单模式下 `--output`（单个输入）、`--output-dir`（每个输入写成 `<dir>/<输入文件名>`）、`--stdout`（单个输入）、`--dry-run`（只算报告、不写文件）必须恰好一个。都没给是 `OUTPUT_REQUIRED`，多于一个是 `ARGUMENT_CONFLICT`。没有 `--in-place`：输入文件永远不会被改写。
- `--mode auto`（默认）选出能精确表示像素的最小编码，或保留源字节；指定模式会强制该编码，若无法精确表示像素则报告 `OPTIMIZE_MODE_NOT_EXACT`（退出码 5）。`--ancillary preserve`（默认）复制元数据块，并拒绝块内容依赖颜色布局的源文件；`strip` 会丢弃所有辅助块并列出被丢弃的项目。
- `optimize` 分三个阶段：先整批预检所有输出路径，再在内存里算完所有输入，最后才写文件。任何一个输入计算失败，就整批都不写，错误的 `details` 列出 `processed` 与 `notProcessed`。写文件中途失败时，已写入的文件保留（多文件写入为单文件原子提交，非跨文件事务），`details` 列出 `completed`、`failedTarget` 与 `notStarted`。无法缩小的文件（`unchanged`）仍会以源字节写出，`--dry-run` 除外。
- 人类可读输出每个文件一行：`ok optimize input=<p> output=<p|-> status=<s> source=<bytes> result=<bytes> mode=<mode>`；警告另起一行 `warning [CODE] message`。`--json` 带相同的结果，另含每个文件的 `candidates`、`preservedChunks`、`strippedChunks` 与 `totals`。
- `model inspect` 与 `model validate` 只读，不接受输出标志。`inspect` 一律退出 0；`validate` 在判定为 `fail` 时退出 3。给了 `--pack` 时，`<file>` 必须位于 `<pack>/assets/<命名空间>/models/` 之下；没给版本标志时，版本按 `pack.mcmeta` 推定（没有可用的值就视为版本不明，不套用默认）。
- `model create`／`model apply` 从文件或 `-`（stdin；每个命令最多一个 `-`）读 JSON，并且 `--output` 与 `--stdout` 必须恰好一个。它们只检查文档本身，不接受 `--pack`、`--vanilla`、`--dependency`。模型支持范围只含长方体 `elements`。
- `model export` 至少要有 `--output`、`--item-output`、`--blockstate-output` 之一。`--item-output` 需要 `binding.item`（反过来也一样），`--blockstate-output` 需要 `binding.blockstate`。`binding.item` 需要明确的版本且资源包格式在 46.0 以上，否则报告 `MODEL_UNSUPPORTED_VERSION`（退出码 5）。`--pack` 会加上布局与边界检查。`--force` 不适用于 `--item-output`、`--blockstate-output`，这两个文件永远不会被覆盖。
- `model preview` 画出固定的诊断图：三个正方形面板横向排列（`front`、右侧、`top`），每个面板边长为 `--size`（64、128 或 256，默认 64），所以 PNG 宽为 `size * 3`、高为 `size`。`front` 是从北方看北面，右侧面板是从东方看东面，`top` 是从上方看上面且北方在上。只画轴对齐的长方体 `elements`、既有 UV 与 0/90/180/270 的面旋转，使用整数投影加深度缓冲；坐标必须是精确的 1/256 倍数。父链与贴图变量沿用既有的解析上下文。缺失的贴图以固定棋盘格填满该矩形并发出警告；元素旋转、非 1/256 坐标、半透明面与无法解析的贴图会列在 `coverage.skipped`（`partial`），不会默默画错。`display` 变换与游戏光照不会应用。`--output` 与 `--stdout` 必须恰好一个（都没给是 `OUTPUT_REQUIRED`，两个都给是 `ARGUMENT_CONFLICT`）；`size` 不是 64/128/256 是 `INVALID_ARGUMENT`。模型与贴图只会被读取，不会被改写。
- 共用的写入保护（`optimize` 与 `model`）：第一个字节写出之前，所有目标都已检查完毕。与输入或其他输出互为别名、目标是目录、目标是符号链接（含悬空的，带 `--force` 也一样）、直接父目录是符号链接，以及 `model export` 时位于 `--pack` 之外的路径，都会被拒绝。已存在的文件除非 `--force` 适用，否则报告 `OUTPUT_EXISTS`。每个文件仍以原子重命名提交。
- 报告只验证结构与引用是否有效。没有任何东西在游戏客户端里渲染过模型，所以外观、光照与游戏内行为都未验证。`model preview` 是诊断视图，不是游戏渲染器。

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

九个像素操作都可附可选的 `selection`（选择表达式的原子字符串或对象，语法与 `--selection` 相同）。只有被选中的像素会写入；未被选中的原始字节原样保留，含 alpha 为 0 下隐藏的 RGB。`fillRect` 在有 `selection` 时可省略 `rect`（填充范围取选择表达式的边界框，再以选择表达式裁剪）。这三种形状遵守冻结的整数几何与选择裁剪：`ellipse` 沿 `rect` 内接的椭圆填充或描边（`mode` 必填，`fill` 或 `outline`）；`polygonFill` 填充 `points` 围出的多边形；`strokeMask` 在 `layerId` 上描出 `source` 选择读取范围的轮廓，不绘制范围本身。选择表达式一个像素都没命中时，以 `EMPTY_SELECTION` 拒绝写入并回滚整批；`quantize`／`cleanup`／`recolor` 的 `--selection` 路径维持既有的还原行为。

选择表达式可写原子（`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`）或 JSON AST 对象（`{"op": "union" | "intersect" | "subtract" | "invert", "operands": [...]}`），深度上限 32、节点上限 1024。

| `type` | 必填键 | 选填键 | 示例 |
|---|---|---|---|
| `setPixel` | `x`、`y`、`color` | `layerId`、`selection`、`id` | `{"type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF"}` |
| `clearPixel` | `x`、`y` | `layerId`、`selection`、`id` | `{"type": "clearPixel", "x": 0, "y": 0}` |
| `drawLine` | `from`、`to`、`color` | `layerId`、`selection`、`id` | `{"type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF"}` |
| `drawRect` | `rect`、`color` | `layerId`、`selection`、`id` | `{"type": "drawRect", "rect": {"x": 2, "y": 2, "width": 4, "height": 4}, "color": "#0000FFFF"}` |
| `fillRect` | `color`（有 `selection` 时可省略 `rect`） | `layerId`、`rect`、`selection`、`id` | `{"type": "fillRect", "rect": {"x": 8, "y": 8, "width": 4, "height": 4}, "color": "#FFFF00FF"}` |
| `floodFill` | `x`、`y`、`color` | `layerId`、`selection`、`id` | `{"type": "floodFill", "x": 3, "y": 3, "color": "#FF00FFFF"}` |
| `ellipse` | `rect`、`color`、`mode`（`fill`／`outline`） | `layerId`、`selection`、`id` | `{"type": "ellipse", "rect": {"x": 1, "y": 1, "width": 6, "height": 4}, "color": "#FF0000FF", "mode": "fill"}` |
| `polygonFill` | `points`（`[x, y]` 整数对数组）、`color` | `layerId`、`selection`、`id` | `{"type": "polygonFill", "points": [[0, 0], [4, 0], [2, 3]], "color": "#00FF00FF"}` |
| `strokeMask` | `layerId`、`source`（选择表达式）、`color` | `selection`、`id` | `{"type": "strokeMask", "layerId": "base", "source": "alpha:base", "color": "#FFFFFFFF"}` |
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
| `stampRect` | `layerId`、`source`、`to`／`offset` 择一 | `transform`（`flip`：`h`／`v`；`rotate`：`0`／`90`／`180`／`270`）、`merge`（默认 `replace`／`source-over`）、`carryRegions`（默认 false）、`selection`、`id` | `{"type": "stampRect", "layerId": "base", "source": "rect:8,8,8,8", "offset": {"dx": 0, "dy": 8}}` |
| `regionFromSelection` | `selection`、`mode`（`create`／`update`） | `regionId`、`name`、`id` | `{"type": "regionFromSelection", "selection": "alpha:base", "mode": "create", "regionId": "body"}` |

`drawLine` 的 `from`／`to` 为 `[x, y]` 整数对；`stampRect` 的 `to` 为 `{x, y}`，`offset` 为 `{dx, dy}`。`rect` 一律是 `{x, y, width, height}`，宽高至少为 1；`toIndex` 为 0 或正整数；`value` 为 `0`（外部）或 `1`（内部）。`polygonFill` 最多 4096 个点，超过为 `RESOURCE_LIMIT_EXCEEDED`；自交的环为 `SELF_INTERSECTING_POLYGON`，孔洞不支持（嵌套的环会被视为各自独立的轮廓）。`stampRect` 复制 `source` 读取范围而不清空它（`source` 决定读什么，`selection` 只裁剪写入；`to` 固定变换后输出的左上角，`offset` 相对来源边界平移，两者并存为 `ARGUMENT_CONFLICT`）。未知的 `type` 为 `INVALID_ARGUMENT`；重复的 `id` 为 `DUPLICATE_OPERATION_ID`。

批处理执行是原子的：只要有一个操作无效，就会回滚所有更改。（MCP 的 `apply_asset_operations` 另接受 `atomic: false`，此时会跑完每个操作，以各操作的 applied／failed 状态报告，不再回滚。）

---

## 退出状态码注册表

| 状态码 | 类别 | 说明 | 示例 |
|---|---|---|---|
| **0** | 成功 | 命令顺利完成。 | 验证全部通过、成功渲染。 |
| **1** | 内部错误 | 未处理的引擎缺陷（`INTERNAL_ERROR`）。 | 引擎发生非预期失败。 |
| **2** | 无效调用 | 语法错误、标志冲突、缺少必要参数。 | 缺少 `--output`、同时使用 `--force --in-place`、`MODEL_INVALID_JSON`、`MODEL_INVALID_OPERATION`。 |
| **3** | 资产验证失败 | 引擎运行正常，但资产或资源包未通过验证。 | `VALIDATION_FAILED`、贴图损坏、`.mcmeta` 有误、模型发现项（`MODEL_INVALID_STRUCTURE`、`MODEL_INVALID_UV`、`MODEL_INVALID_ROTATION`、`MODEL_INVALID_DISPLAY`、`MODEL_VERSION_FEATURE`、`MODEL_SUSPICIOUS_VALUE`）。 |
| **4** | 文件系统拒绝 | 文件已存在且未加 `--force`，或缺少目录且未加 `--mkdir`。 | `OUTPUT_EXISTS`、`FILESYSTEM_ERROR`。 |
| **5** | 不支持／资源上限 | 输入格式不支持，或超出画布上限。 | 图像头损坏、`UNSUPPORTED_IMAGE_FORMAT`、`OPTIMIZE_MODE_NOT_EXACT`、`MODEL_UNSUPPORTED_VERSION`。 |

---

## 常见错误排查指南（Troubleshooting）

| 错误代码 | 状态码 | 触发原因 | 建议排查与修复方式 |
|---|---|---|---|
| `EMPTY_SELECTION` | 2 | 批处理操作的 `selection`，或 `inspect --mode view` 的 `--crop`，没有选中任何像素。 | 用 `inspect --mode structure` 确认图层与区域范围，再放宽选择表达式。 |
| `ARGUMENT_CONFLICT` | 2 | 同时传入互斥选项（如 `--force` 与 `--in-place`、多个几何标志、`--selection` 搭配几何标志、`stampRect` 同时给出 `to` 与 `offset`）。 | 去掉其中一个冲突的选项。 |
| `OUTPUT_EXISTS` | 4 | 输出文件已存在，但未加上 `--force` 标志。 | 加上 `--force` 确认覆盖，或指定新的 `--output` 路径。 |
| `FILESYSTEM_ERROR` | 4 | 无法读取输入文件，或输出的上级目录不存在且未加上 `--mkdir`。 | 确认输入路径，或加上 `--mkdir` 自动创建缺少的目录。 |
| `PACK_UNRESOLVED_EXTERNAL` | 0（警告） | `minecraft` 命名空间的引用（模型 parent、材质、模型，或装备、粒子、字体的引用）在没有原版资源树时无法解析。以警告加上 `vanilla-not-provided` 覆盖率条目报告，本身不会让扫描失败。 | 加上 `--vanilla <path>` 指定解包后之原版资源根目录以供校验。 |
| `PACK_REFERENCE_CYCLE` | 3 | 模型的 `parent` 链或材质变量绕回自身（如 `#a -> #b -> #a`）。 | 在 model JSON 的 `parent` 或 `textures` 中切断循环。 |
| `INVALID_MCMETA` | 2 | `.mcmeta` 格式有误；对 `gui-scale` 而言，也包括九宫格边框占满整个中段（`left + right >= width` 或 `top + bottom >= height`）。 | 保持 `left + right < width` 且 `top + bottom < height`。 |
| `STYLE_INVALID` | 2 | `.style.json` 有未知字段、枚举外的值，或不是 `#RRGGBB` 的颜色；也包括读不到或解析失败的风格文件，以及加载不到的 `extends` 来源。 | 按消息中的字段路径修正（`palettes.stone.base: expected #RRGGBB, got "#12345"`）；整文件失败会带上路径。 |
| `STYLE_NOT_FOUND` | 2 | `style show` 或 `style export-palette` 给的 id 不是四个内置预设之一。 | 改用 `vanilla`、`soft`、`fairy-flat`、`dark-frame`，或 `.style.json` 路径。 |
| `STYLE_INHERITANCE_CYCLE` | 2 | `extends` 链回到已经走过的风格（最多八层）。 | 移除循环；消息会列出重复的那段链。 |
| `STYLE_FAMILY_NOT_FOUND` | 2 | `--family` 指定的家族不在解析后的风格里（例如文档用 `null` 删除之后）。 | 从 `style show <style>` 的结果选一个家族，或不要删除它。 |
| `STYLE_UNSUPPORTED_VERSION` | 5 | `.style.json` 的 `formatVersion` 高于工具支持的版本。 | 把 `formatVersion` 设为 1，并按这个版本调整文档内容。 |
| `PACK_INIT_CONFLICT` | 4 | `pack init` 发现预定要创建的路径已经存在（文件或骨架目录）。 | 看 `conflicts` 清单，把这些路径删除或改名后再跑一次；这次没有写任何文件。 |
| `PACK_PROJECT_INVALID` | 2 | 项目文件字段未知、不符类型，或指向项目根之外的路径；`pack init` 没有加 `--allow-minecraft-namespace` 却使用 `minecraft` 命名空间也是这个码。 | 按消息里的字段路径修正该字段；`namespace` 的情况则是换一个命名空间，或加上这个明确同意的开关。 |
| `PACK_PROJECT_NOT_FOUND` | 2 | 明确指定路径的项目文件读不到。 | 检查路径；指令不会往父目录搜索项目文件。 |
| `PACK_PROJECT_UNSUPPORTED_VERSION` | 5 | 项目文件的 `formatVersion` 高于工具支持的版本。 | 把 `formatVersion` 设为 1，并按这个版本调整项目文件内容。 |
| `PACK_GUI_SCALING_BORDER` | 3 | `validate-pack` 发现某个 GUI 贴图的九宫格边框没有留下中段（判断方式同 `INVALID_MCMETA`）。 | 缩小该贴图 `.mcmeta` 里的边框。 |
| `PACK_MCMETA_INVALID` | 3 | 根目录 `pack.mcmeta` 写了游戏拒绝加载的内容：缺少 `pack` 区段或 `pack.description`、`min_format`／`max_format` 只写一半、负值或上下颠倒的范围、与声明范围不一致的 `supported_formats`、落在声明 major 之外的旧制 `pack_format`、不合法的 overlay 目录名，或违反旧格式规则的 overlay `formats` 字段。 | 把指出的字段修好（范围两端都要能读、声明的 major 要一致），或拿掉规则不准写的旧字段。 |
| `PACK_MCMETA_SUSPICIOUS` | 0（警告） | 包照常加载，但写法疑似失误：pack 根目录没有的 overlay 目录、完全没写版本字段的 overlay 条目，或落在声明范围外的扫描目标。以警告报告，本身不会让扫描失败。 | 补上缺少的 overlay 目录、给该条目一个版本范围，或把扫描目标改回声明范围内。 |
| `PACK_UNRESOLVED_VARIABLE` | 0（警告） | 模型贴图变量在父模型链中均未解析，且该模型既未被 blockstate 或 items 定义直接当作最终模型使用，亦无子模型在 `textures` 中提供该变量（或单文件 `model validate`／`model inspect` 无从得知子模型）。以警告报告，本身不会让扫描失败。 | 在继承该模板的子模型中提供缺少的变量，或在不再使用的模型中移除陈旧的变量引用。 |
| `RESOURCE_LIMIT_EXCEEDED` | 5 | 超过硬性上限：多边形超过 4096 点、选择 AST 深度超过 32 或节点超过 1024、`inspect view` 输出边长超过 1024px，或画布尺寸与内存上限。 | 减少顶点或简化选择表达式；大图用 `--crop` 分块查看。 |
| `OPTIMIZE_MODE_NOT_EXACT` | 5 | `optimize --mode <名称>` 强制的编码无法精确表示像素（例如对带透明度的源文件指定 `rgb`）。 | 改用 `--mode auto`，或选一个能容纳所有像素的模式。 |
| `MODEL_UNSUPPORTED_VERSION` | 5 | 目标版本无法表示所要求的特性，或 `model export` 使用 `binding.item` 时没有明确的 46.0 以上资源包版本。 | 传入支持该特性的 `--minecraft-version` 或 `--resource-pack-version`。 |
| `UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT` | 5 | 使用 `minecraft:*` 资产配置，但输出路径不是 `.png`。 | Minecraft 贴图一律输出 `.png`。 |

## 生成 mcmeta 设置

从 PNG 生成动画或 GUI 缩放设置：

```sh
mc-asset mcmeta animation sheet.png --frame-size 16 --frametime 2 --frames '[0,{"index":1,"time":4},0]' --minecraft-version 1.21.2 --output sheet.png.mcmeta
mc-asset mcmeta gui panel.png --type nine_slice --border 4 --stretch-inner --resource-pack-version 42 --stdout
```

动画必须指定 `--frame-size <N|WxH>`，帧只支持单排或单列，尺寸必须整除 PNG；不接受网格。`frametime` 默认 1，`frames` 接受索引或 `{index,time}` 对象，可重复或只播放部分帧；省略时依序播放全部帧。时間必须是正整数，索引不得越界；`--interpolate` 启用插值。GUI 必须指定 `--type <stretch|tile|nine_slice>`，tile 与 nine_slice 以 PNG 尺寸作设计尺寸。nine_slice 必须指定 `--border <N|json>`，四边 left、top、right、bottom 为非负整数，中央必须保留正面积；只有 nine_slice 接受 `--stretch-inner`。

CLI 必须明确选择 `--output <path.mcmeta>` 或 `--stdout` 其中之一，不猜同名路径。已存在的目标需要 `--force`，它会整个文件替换，不保留其他区段；`--mkdir` 允许建立缺少的父目录。来源 PNG 与无关的同名设置不变，输入别名与符号链接会被拒绝。输出只含指定区段，以固定键顺序的紧凑 JSON 加一个结尾换行生成。

版本选项 `--minecraft-version` 与 `--resource-pack-version` 只能选一个。GUI scaling 需要 pack format 16.0，stretch_inner 需要 42.0；不相容会在输出前回报 `ARGUMENT_CONFLICT`。未指定版本，或版本在 12.0 到 97.1 之外，会回报 `versionChecked: false` 与 `VERSION_NOT_CHECKED`，但不会跳过 GUI 最低版本限制。动画依据文档格式及历史在表内标示已检查，并非逐版本游戏客户端实测。来源见[材质动画与历史](https://minecraft.wiki/w/Resource_pack#Texture_animation)（interpolate 在 14w25a 加入，早于支持表）、[GUI scaling](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w31a) 与 [pack format](https://minecraft.wiki/w/Pack_format)。这些检查确认设置结构与已知版本相容性，不代表已验证游戏内外观或行为。

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
