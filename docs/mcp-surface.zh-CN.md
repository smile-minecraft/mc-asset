# MCP 接口（已冻结）

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

入口：`mc-asset mcp` 会启动 stdio MCP 服务器。stdout 只输出 MCP JSON-RPC，诊断信息走 stderr，stdin 关闭时进程正常退出。服务器直接挂在 Core 上，不重新实现任何图像逻辑。

工具名称已冻结。早期草稿把批处理编辑工具称为 `edit_asset`，冻结后的名称是 `apply_asset_operations`。

Minecraft 目标版本涵盖 `1.19.3` 到 `26.3`。工具中，有十二个（`import_asset` 到 `validate_pack_asset`）是为了与 CLI 完全对等而设。各版本的变更记录在 [`CHANGELOG.md`](../CHANGELOG.md)。

能力基础：与 CLI 完全对等——素材输入与源码构建、空间变换、调色板与减色、确定性像素化管线、程序化生成、平铺与预览、动画 sprite sheet，以及单个资产与整个资源包的验证。

像素工作不需要成百上千次逐像素的工具调用：像素级的创作，通过 ASCII Grid 文档、批处理操作数组，或内联返回的可编辑 `.mcpx` 源码来完成。刻意不提供 `set_pixel` 工具。

## 工具

| 工具 | 读取 | 写入 | 结果 |
|---|---|---|---|
| `analyze_asset` | 位图（PNG、JPEG、WebP） | 无 | 只读报告：尺寸、调色板、预测的 alpha 分类（从不代表实际结果）、像素画特征、建议 |
| `pixelize_asset` | 参考位图（PNG、JPEG、WebP；不接受 `.mcpx`） | 可选的显式 PNG／`.mcpx` 路径 | 确定性管线输出：PNG 字节和／或可编辑源码 |
| `render_pixel_asset` | ASCII Grid：内联 `gridText` 或 `gridPath` 文件，两者恰好择一，另可加批处理 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `apply_asset_operations` | 可编辑的 `.mcpx` 源码加操作数组 | 可选的显式 PNG／`.mcpx` 路径 | 已应用的数量与各操作的状态；默认为原子（第一个失败就全部回滚） |
| `recolor_asset` | 可编辑的 `.mcpx` 源码或扁平 PNG、内置材质 id 或家族 id、可选的区域 id、选择范围、风格 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或重新着色后的源码，附更改计数 |
| `create_variants` | 可编辑的 `.mcpx` 源码或扁平 PNG、内置材质 id 数组和／或家族 id 数组、选择范围、区域、文件名模板 | 必须显式指定的输出目录 | 各项 `<stem>_<name>.png` 加 `.mcpx`，均由原始源码生成 |
| `validate_asset` | 资产文件（PNG）、可选的显式 `.mcmeta` 路径（原样使用） | 无 | 附发现项的只读判定 |
| `import_asset` | 位图（PNG、JPEG、WebP）加可选的批处理 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `build_asset` | 可编辑的 `.mcpx` 源码加可选的批处理 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或构建后的源码 |
| `transform_asset` | 位图或 `.mcpx`、一个几何标志（搭配选择范围会报告 `ARGUMENT_CONFLICT`） | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `scale_gui_asset` | 位图或 `.mcpx`、可选的显式 `.mcmeta` 路径 | 可选的显式 PNG 路径 | 缩放后的 PNG（显式路径或内嵌字节），附解析出的缩放摘要 |
| `quantize_asset` | 位图或 `.mcpx`、颜色数 `colors` 或 `palette`（内置材质名或 `.mcpx` 路径）恰选其一、可选的 `keepColors`（RGBA 对象）、可选的选择范围 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `cleanup_asset` | 位图或 `.mcpx`、可选的修复类别、可选的选择范围 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `palette_asset` | 图像、一种 `mode`（`extract`／`inspect`） | 无 | 只读报告：不重复颜色，或分布、角色与对比度 |
| `material_asset` | 无（`list`）或内置材质名（`show` 用 `mode` 加 `name`） | 无 | 只读报告：材质列表或色彩渐变 |
| `tile_asset` | 位图或 `.mcpx`、可选的预览网格与匹配轴向 | 可选的显式 PNG 路径 | 接缝与边缘报告，或预览 PNG |
| `generate_asset` | 无（图案加尺寸加调色板加种子） | 可选的显式 PNG／`.mcpx` 路径 | 确定性的程序化 PNG 字节和／或可编辑源码 |
| `preview_asset` | 位图或 `.mcpx`、一种 `mode`（`ascii`／`palette-map`／`scale`／`nine-slice`） | 可选的显式 PNG 路径（`scale`、`nine-slice`） | 只读报告或预览 PNG |
| `animate_asset` | 帧目录或 sprite sheet、一种 `mode`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`） | 显式的 PNG 路径（`pack`）或输出目录（`unpack`、`reorder`、`resize`） | Sheet PNG、帧或只读报告 |
| `validate_pack_asset` | 资源包根目录，外加可选的原版资源树与依赖根目录 | 无 | 附发现项与 coverage 对象的只读判定 |
| `inspect_asset` | 可编辑的 `.mcpx` 源码或位图（位图视为单一 base 图层）、一种 `mode`（`structure`／`view`），view 另有 `crop` 与 `scale` | 无 | 只读报告（structure），或合成 PNG 的 image block 加 metadata（view） |
| `optimize_asset` | PNG 文件（1 至 256 个显式路径）或目录（`inputDir`，最多 4096 个 PNG，可选 `recursive`） | 可选的显式 PNG 输出路径（限单个显式输入），或已有的输出目录 | 逐文件报告（源与结果大小、模式、候选编码、块、警告）加总计；只有一个输入且没有输出时内嵌 PNG 字节 |
| `model_asset` | Java 方块／物品模型 JSON、一种 `mode`（`inspect`／`validate`／`create`／`apply`／`export`／`preview`），可选的资源包、原版与依赖根目录 | 可选的显式 `.json` 路径（模型、物品定义、blockstate），或显式的 `.png` 路径（`preview`） | 只读报告（`inspect`、`validate`），模型文档与生成的 binding（`create`、`apply`、`export`），或诊断三视图 PNG（`preview`） |
| `mcmeta_asset` | PNG 精灵图集（`animation`）或设计精灵图（`gui`）、各模式参数、版本字段 | 可选的显式 `.mcmeta` 输出路径（`force`、`mkdir`） | 生成的 `.mcmeta` 文本与元数据摘要（仅在提供 `outputPath` 时写文件） |
| `compare_assets` | 两张同尺寸 PNG、`image`（`none`／`diff`）、`scale`（1–16） | 可选的显式 PNG 输出路径（`force`、`mkdir`；仅限 `image: "diff"`） | 比对报告（尺寸、原始与可见差异数、边界框）及可选的标准 PNG 图像块（仅在提供 `outputPath` 时写文件） |
| `style_asset` | 内置风格预设与 `.style.json` 来源、一种 `mode`（`list`／`show`／`export-palette`／`create`） | 可选的显式 `.mcpx` 路径（`export-palette`）或 `.style.json` 路径（`create`） | 预设列表、解析后的风格、调色板 `.mcpx` 文本或文件，或已写出的风格文件 |
| `pack_asset` | 无；一种 `mode`（`init`），加上项目目录、命名空间与发布版本 | 只创建新的项目目录 | 已创建骨架的报告，或带冲突路径的拒绝 |

## 输入语义

- 每个文件路径都要显式指定。会产生文件的工具不会自行决定文件名，只读工具则绝不写入。
- `profile` 为 `generic`、`minecraft:item`、`minecraft:block`、`minecraft:gui`、`minecraft:particle` 之一；省略时视为 `generic`。
- `minecraftVersion`／`resourcePackVersion`（analyze、validate、validate-pack）用于选择兼容性行为，接受 release 版本 `1.19.3` 到 `26.3`（例如 `1.19.3`、`1.21.4`、`26.3`），以及资源包版本 `N` 或 `N.M`（例如 `84`、`97.1`），会规范化为 `major.minor`。省略时使用引擎默认值。
- 子命令工具把 CLI 模式合并为 `mode` 字段：`palette_asset`（`extract`／`inspect`）、`material_asset`（`list`／`show`）、`style_asset`（`list`／`show`／`export-palette`／`create`）、`pack_asset`（`init`）、`preview_asset`（`ascii`／`palette-map`／`scale`／`nine-slice`）、`animate_asset`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`）。
- `style_asset` 内置四个预设（`vanilla`、`soft`、`fairy-flat`、`dark-frame`），每个预设含十二个家族与六个角色（`outline`、`shadow`、`dark`、`base`、`light`、`highlight`）。`list` 报告预设，并可给 `paths` 一并报告能加载的自定义 `.style.json`；`paths` 中无法加载的文件会让整个调用以 `STYLE_INVALID` 失败。`show` 取 `style`（内置 id 或 `.style.json` 路径），返回解析后的文档与 `extendsChain`。`export-palette` 取 `style` 与 `family`（家族 id 或 `all`）：没有 `outputMcpxPath` 时返回调色板 `.mcpx` 文本，给了路径则写文件（`force` 可覆盖）。`create` 取 `outputPath` 与 `id`，另有可选的 `name`（默认为 id）、`extends`（默认 `vanilla`）、合并进文档的 `overrides`、`force` 与 `mkdir`。风格文件以严格模式读取：未知字段、枚举外的值，或不是 `#RRGGBB` 的颜色都是带字段路径的 `STYLE_INVALID`；其余还有查不到的 id（`STYLE_NOT_FOUND`）、`extends` 循环（`STYLE_INHERITANCE_CYCLE`）、版本过高（`STYLE_UNSUPPORTED_VERSION`）与家族不存在（`STYLE_FAMILY_NOT_FOUND`）。工具不会改写自己没有创建的风格文件。
- `pack_asset` 创建一个资源包项目。`init` 需要 `projectDir`、`namespace` 与 `minecraftVersion`，另有可选的 `name`（默认取自目录名）、`description`（默认取自项目名）、`style`（默认 `vanilla`）与 `resourcePackVersion`（覆盖发布版本对应的资源包格式，发布版本本身仍留在项目文件里），使用 `namespace: minecraft` 时还需要 `allowMinecraftNamespace`。一次预检后整批写出 `mc-asset.pack.json`、`pack/pack.mcmeta`、64x64 的 `pack/pack.png` 占位图标与资源包目录，报告固定的格式号以及写出的每个文件与目录。根 metadata 按目标版本选择：资源包格式 65.0 起声明该目标的 `min_format` 与 `max_format` 且不写旧式 `pack_format`，更早的版本只写单一旧式格式号，生成的文件在写入前会先在内存内检查。未知的发布版本，或命名空间不符合 `[a-z][a-z0-9_.-]{0,63}`，都是 `INVALID_ARGUMENT`。已有路径会让整批拒绝并返回 `PACK_INIT_CONFLICT` 与列出所有已存在相对路径的 `conflicts`；符号链接是 `FILESYSTEM_ERROR` 且永远不会穿过链接写入；这个工具没有 `force` 也没有 `mkdir`。项目文件由后续命令以严格模式读取：未知字段或指向项目根之外的路径是带字段路径的 `PACK_PROJECT_INVALID`，读不到是 `PACK_PROJECT_NOT_FOUND`，`formatVersion` 更新是 `PACK_PROJECT_UNSUPPORTED_VERSION`。
- `apply_asset_operations` 接收操作对象数组，每个对象都有一个 `type`（Core 批处理词汇：九个像素操作 `setPixel`、`clearPixel`、`drawLine`、`drawRect`、`fillRect`、`floodFill`、`ellipse`、`polygonFill`、`strokeMask`，另有图层与区域操作、`stampRect`、`regionFromSelection` 等），再加该类型的参数。`atomic` 默认为 true；设为 false 时会跑完每个操作，以各操作的 applied／failed 状态报告，不再回滚。像素操作可附可选的 `selection` 表达式；空匹配以 `EMPTY_SELECTION` 拒绝写入并回滚整批。
- `outline` 是第二十六种操作 `type`。它为单个 `layerId` 上非全透明的像素描边，可画在本体边缘（`inside`，默认）或贴着本体的空像素（`outside`），共五种模式：`tinted`（以整数 HSL 调暗相邻本体色）、`selective`（光源在左上，只画背光面）、`uniform`（必填的 `#RRGGBB` 颜色）、`black` 与 `strip`（把已有外框换成相邻内部色）。其他模式给 `color` 是 `INVALID_ARGUMENT`；`family` 只接受十二个内建家族，`snapFamilies` 为 true 时把推导出的外框色对齐内建原版色阶中更接近的 `outline` 或 `shadow`，其余家族 id 是 `INVALID_ARGUMENT`。`luminanceDropPermille`（默认 120）、`saturationRatioPermille`（默认 1000）、`maxHueOffsetDegrees`（默认 5）都是整数，最后一项只记录给风格检查，不改变输出。它同样接受可选的 `selection`；分类型参数表在 `docs/cli-surface.zh-CN.md`。
- `apply_asset_operations` 另接受可选的 `feedback` 对象（`image`：`none`／`full`／`changed`；`scale`：整数 1–16；`crop`：选择表达式；`diff`：`none`／`summary`）。不给 `feedback` 时，输出字段与字节与过去完全相同。给了 `feedback` 时，结果携带 `feedback` 对象（`image`、`imageIncluded`、可选的 `noVisibleChange`、可选的 `diff`，含 `raw`／`composited`／`structural`／`outsideSelectionUnchanged`），且绝不内嵌 `pngBase64`：附带的图以标准 image content block（`type: "image"`、`mimeType: "image/png"`）传送，文本区块不重复携带字节。`changed` 渲染合成后的变更边界（忽略 crop），可见范围没有变化时以 `noVisibleChange` 代替图片报告；参考线像素（网格线、棋盘格）绝不写入作品字节。`crop` 配 `none` 为 `INVALID_ARGUMENT`。
- `inspect_asset` 接收 `inputPath` 加 `mode`：`structure` 返回图层（边界、面积、可见性、原始 RGBA 颜色用量）、区域（标识、边界，只报面积）与重叠；`view` 以 image block 返回合成 PNG 加六键 metadata，crop／scale／1024px 边界规则与顶层 `inspect` 命令相同。view 的 scale 默认为 1；长边自动缩放只适用于 `apply_asset_operations` 的 feedback 图。
- `recolor_asset` 必须提供 `material` 或 `family` 之一（两者都缺为 `INVALID_ARGUMENT`，两者都给为 `ARGUMENT_CONFLICT`）。`style` 默认为 `vanilla`。`selection` 限定作用范围，未选中像素原样还原。
- `create_variants` 必须至少提供 `materials` 或 `families` 之一（两者都缺为 `INVALID_ARGUMENT`；两者可并存产出并集，产出文件名若重复则报错 `ARGUMENT_CONFLICT`）。`nameTemplate` 支持 `{stem}` 与 `{name}`（默认为 `{stem}_{name}`）。
- 材质路径下，扁平 PNG 像素按整数明度分段映射到目标材质调色板（96 以下为暗部、96 到 159 为中间、160 以上为亮部）。调色板家族路径下（`family`／`families`），带 role 来源按同名 role 直接对应（`outline`、`shadow`、`dark`、`base`、`light`、`highlight`），`accent` 与 `custom` 按六段整数明度分段处理；平面 PNG 按六段整数明度分段对应（<43 outline、43–85 shadow、86–127 dark、128–170 base、171–213 light、≥214 highlight）；外框像素（相邻透明或画布边缘）一律强制改写为目标家族的 `outline` 色；全透明像素保持字节不变，包含隐藏 RGB；半透明像素强制覆写为完全不透明调色板色。缺失区域沿用既有的 `REGION_NOT_FOUND` 错误。每个变体都从同一个原始来源独立生成；JPEG 与 WebP 仍会被拒绝。
- 完整的操作参数表见 [CLI Surface](cli-surface.zh-CN.md)的「批处理操作规范」节；两个接口共用同一种 JSON 形状。`polygonFill` 最多 4096 个点，自交的环为 `SELF_INTERSECTING_POLYGON`，孔洞不支持。
- 选择表达式可写原子（`all`、`rect:x,y,w,h`、`region:id`、`alpha[:layer]`、`color[:layer]:r,g,b,a`、`connected[:layer]:x,y`）或 JSON AST 对象（`op` 为 `union`／`intersect`／`subtract`／`invert`，加 `operands [...]`），深度上限 32、节点上限 1024。
- `scale_gui_asset` 接收 `size`（`N` 或 `WxH`）、可选的 `mcmetaPath`（省略即为 `stretch`）与可选的版本字段；输出只有 PNG。
- `optimize_asset` 接收 `inputPaths`（1 至 256 个显式的 PNG 文件）或 `inputDir`（包含 PNG 的目录，最多 4096 个 PNG，可选 `recursive` 且默认为 false）二选一。两者都提供报告 `ARGUMENT_CONFLICT`，都没提供报告 `INVALID_ARGUMENT`。在目录模式下：
  - 相对路径严格按 UTF-8 字节顺序遍历，并在 `outputDir` 下保留相对目录结构。
  - 绝不跟随符号链接：扫描范围内任何符号链接报告 `FILESYSTEM_ERROR`（`symlink-not-supported`）。
  - 源目录与输出目录必须互不相交，不得相互包含或为别名（`ARGUMENT_CONFLICT`）。
  - 写入前检查资源预算：最多 4096 个 PNG、总源文件 ≤ 256 MiB、总解码像素 ≤ 16,777,216，超限报告 `RESOURCE_LIMIT_EXCEEDED`。
  - 一般非 PNG 文件（`.mcmeta` 等）自动跳过，不复制；目录内无任何 PNG 文件报告 `INVALID_ARGUMENT`。
  - 目录模式只接受已有的 `outputDir`（MCP 绝不创建新目录）或 `dryRun: true`；拒绝单文件 `outputPath` 或内嵌输出。
- `optimize_asset` 其他字段：可选的 `mode`（默认 `auto`，或 `rgba`、`rgb`、`grayscale`、`grayscale-alpha`、`indexed`）、`ancillary`（默认 `preserve`，或 `strip`）、`dryRun`、`outputPath`（只能用于单个显式输入）与 `outputDir`（已有目录）。清单模式下，多个输入需要 `outputDir` 或 `dryRun`，否则报告 `INVALID_ARGUMENT`。强制的 `mode` 无法精确表示像素时是 `OPTIMIZE_MODE_NOT_EXACT`。
- `model_asset` 接收 `mode` 加上该模式需要的字段：`inputPath`（`inspect`、`validate`、`apply`、`export`、`preview`）、`spec`（`create`）、`operations`（`apply`，1 至 1000 个）、`binding`（`export`）、`packPath`／`vanillaPath`／`dependencyPaths`（`inspect`、`validate`、`preview`；`export` 另可用 `packPath`）、`outputPath`、`itemOutputPath`、`blockstateOutputPath`。该模式不接受的字段会报告 `INVALID_ARGUMENT`，并点名字段与模式。模型支持范围只含长方体 `elements`。
- `preview` 模式的 `model_asset` 以 `size`（64、128 或 256，默认 64）与选用的 `outputPngPath` 画出固定的诊断图。PNG 为三个正方形面板横向排列（`front` 是从北方看北面，右侧面板是从东方看东面，`top` 是从上方看上面且北方在上）。没有 `outputPngPath` 时不写文件，图片以标准图片块返回；给了 `outputPngPath` 时写出文件，文字部分只返回报告。第一版限制与 CLI 相同（轴对齐长方体、精确 1/256 坐标、既有 UV 与 0/90/180/270 面旋转、缺贴图用固定棋盘格、元素旋转与半透明面及无法解析的贴图列为 partial；`display` 与游戏光照不应用）。
- `validate_pack_asset` 接收可选的 `vanillaPath` 与可选的有序 `dependencyPaths`（排前者优先）。
- `transform_asset`／`animate_asset` 的 `resizeMode` 接受 `nearest`／`box`／`pixel-aware`。
- 省略输出路径时，产物会内嵌在工具结果中（PNG 字节、`.mcpx` 文本），不写入磁盘。

## 输出语义

- 只读工具（`analyze_asset`、`validate_asset`、`palette_asset`、`material_asset`、`validate_pack_asset`）返回报告；`validate_asset` 以 `fail` 加发现项表示失败，不会抛出错误。
- 验证类报告带 `coverage: {status, skipped}`；`partial` 会逐项列出跳过的检查及其种类与原因，且不改变状态码。
- 混合工具（`tile_asset`、`preview_asset`、`animate_asset`、`style_asset`）在只读模式返回报告，在写入模式只写入显式指定的输出路径或目录。`style_asset` 的 `list` 与 `show` 为只读，`export-palette` 与 `create` 只写入显式指定的输出路径，它们读取的风格来源文件不会被改写。`pack_asset` 只创建一次新的项目目录，之后不会改写它。
- 会产生文件的工具返回已应用的数量、各操作的状态、警告，以及实际写出的显式路径或内嵌的产物。
- `optimize_asset` 与 `model_asset` 不接受 `force`、`mkdir` 或原地覆盖：输出已存在是 `OUTPUT_EXISTS`，缺少父目录是 `FILESYSTEM_ERROR`。第一个字节写出之前，所有目标都已检查完毕；与输入互为别名、符号链接目标，以及父目录是符号链接的情况都会被拒绝。多文件写入为逐文件原子提交，非跨文件事务：写入中途失败时已写入的文件保留，错误 details 报告 `completed`、`failedTarget` 与 `notStarted`。没有输出路径时，结果内嵌产物（`pngBase64`、`modelText`、`itemText`、`blockstateText`）。
- `optimize_asset` 与 `model_asset` 只报告像素是否相同、结构与引用是否有效。没有游戏客户端渲染过结果，所以外观与游戏内行为都未验证。`preview` 模式的 `model_asset` 是诊断视图，不是游戏渲染器。

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

指定 `mode`（`animation` 或 `gui`）与 `inputPath`（PNG）。 `animation`: `frameSize`, `frametime`, `frames`, `interpolate`; `gui`: `type`, `border`, `stretchInner`. 指定版本可用 `minecraftVersion` 或 `resourcePackVersion`。另一种模式的字段（即使为 false）会返回 `INVALID_ARGUMENT`。`outputPath` 明确指定 `.mcmeta`，另可用 `force`、`mkdir`；省略路径则返回 `mcmetaText`，不写文件。`force`、`mkdir` 必须搭配路径。结果含 `mode`、`width`、`height`、`versionChecked`、`version`、`target`、`warnings`，以及 `output` 或 `mcmetaText`。

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
