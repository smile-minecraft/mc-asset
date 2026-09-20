# MCP 接口（已冻结）

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

入口：`mc-asset mcp` 会启动 stdio MCP 服务器。stdout 只输出 MCP JSON-RPC，诊断信息走 stderr，stdin 关闭时进程正常退出。服务器直接挂在 Core 上，不重新实现任何图像逻辑。

工具名称已冻结。早期草稿把批处理编辑工具称为 `edit_asset`，冻结后的名称是 `apply_asset_operations`。

v0.7 新增十二个工具（`import_asset` 到 `validate_pack_asset`；`palette_asset`、`material_asset`、`preview_asset`、`animate_asset` 把 CLI 子命令合并为 `mode` 字段），达成与 CLI 完全对等。名称与输入形状在此冻结；运行中的服务器将在下一步注册它们。

能力基础：与 CLI 完全对等——素材输入与源码构建、空间变换、调色板与减色、确定性像素化管线、程序化生成、平铺与预览、动画 sprite sheet，以及单个资产与整个资源包的验证。

像素工作不需要成百上千次逐像素的工具调用：像素级的创作，通过 ASCII Grid 文档、批处理操作数组，或内联返回的可编辑 `.mcpx` 源码来完成。刻意不提供 `set_pixel` 工具。

## 工具

| 工具 | 读取 | 写入 | 结果 |
|---|---|---|---|
| `analyze_asset` | 位图（PNG、JPEG、WebP） | 无 | 只读报告：尺寸、调色板、预测的 alpha 分类（从不代表实际结果）、像素画特征、建议 |
| `pixelize_asset` | 参考位图（PNG、JPEG、WebP；不接受 `.mcpx`） | 可选的显式 PNG／`.mcpx` 路径 | 确定性管线输出：PNG 字节和／或可编辑源码 |
| `render_pixel_asset` | ASCII Grid：内联 `gridText` 或 `gridPath` 文件，两者恰好择一，另可加批处理 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `apply_asset_operations` | 可编辑的 `.mcpx` 源码加操作数组 | 可选的显式 PNG／`.mcpx` 路径 | 已应用的数量与各操作的状态；默认为原子（第一个失败就全部回滚） |
| `recolor_asset` | 可编辑的 `.mcpx` 源码、内置材质 id、可选的区域 id | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或重新着色后的源码，附更改计数 |
| `create_variants` | 可编辑的 `.mcpx` 源码、一个以上的内置材质 id | 必须显式指定的输出目录 | 每种材质各一份 `<stem>_<material>.png` 加 `.mcpx`，均由原始源码生成 |
| `validate_asset` | 资产文件（PNG）、可选的显式 `.mcmeta` 路径（原样使用） | 无 | 附发现项的只读判定 |
| `import_asset` | 位图（PNG、JPEG、WebP）加可选的批处理 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `build_asset` | 可编辑的 `.mcpx` 源码加可选的批处理 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或构建后的源码 |
| `transform_asset` | 位图或 `.mcpx`、一个几何标志、可选的选择范围 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `quantize_asset` | 位图或 `.mcpx`、必需的颜色数、可选的选择范围 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `cleanup_asset` | 位图或 `.mcpx`、可选的修复类别、可选的选择范围 | 可选的显式 PNG／`.mcpx` 路径 | PNG 字节和／或可编辑源码 |
| `palette_asset` | 图像、一种 `mode`（`extract`／`inspect`） | 无 | 只读报告：不重复颜色，或分布、角色与对比度 |
| `material_asset` | 无（`list`）或内置材质名（`show` 用 `mode` 加 `name`） | 无 | 只读报告：材质列表或色彩渐变 |
| `tile_asset` | 位图或 `.mcpx`、可选的预览网格与匹配轴向 | 可选的显式 PNG 路径 | 接缝与边缘报告，或预览 PNG |
| `generate_asset` | 无（图案加尺寸加调色板加种子） | 可选的显式 PNG／`.mcpx` 路径 | 确定性的程序化 PNG 字节和／或可编辑源码 |
| `preview_asset` | 位图或 `.mcpx`、一种 `mode`（`ascii`／`palette-map`／`scale`／`nine-slice`） | 可选的显式 PNG 路径（`scale`、`nine-slice`） | 只读报告或预览 PNG |
| `animate_asset` | 帧目录或 sprite sheet、一种 `mode`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`） | 显式的 PNG 路径（`pack`）或输出目录（`unpack`、`reorder`、`resize`） | Sheet PNG、帧或只读报告 |
| `validate_pack_asset` | 资源包根目录 | 无 | 附发现项的只读判定 |

## 输入语义

- 每个文件路径都要显式指定。会产生文件的工具不会自行决定文件名，只读工具则绝不写入。
- `profile` 为 `generic`、`minecraft:item`、`minecraft:block`、`minecraft:gui`、`minecraft:particle` 之一；省略时视为 `generic`。
- `minecraftVersion`／`resourcePackVersion`（analyze、validate、validate-pack）用于选择兼容性行为，接受 `1.21.11` 到 `26.3`，以及资源包版本 `N` 或 `N.M`（例如 `84`、`97.1`），会规范化为 `major.minor`。省略时使用引擎默认值。
- 子命令工具把 CLI 模式合并为 `mode` 字段：`palette_asset`（`extract`／`inspect`）、`material_asset`（`list`／`show`）、`preview_asset`（`ascii`／`palette-map`／`scale`／`nine-slice`）、`animate_asset`（`pack`／`unpack`／`reorder`／`resize`／`validate`／`preview`）。
- `apply_asset_operations` 接收操作对象数组，每个对象都有一个 `type`（Core 批处理词汇：`setPixel`、`drawLine`、`fillRect`、`floodFill`、图层与区域操作等），再加该类型的参数。`atomic` 默认为 true。
- 省略输出路径时，产物会内嵌在工具结果中（PNG 字节、`.mcpx` 文本），不写入磁盘。

## 输出语义

- 只读工具（`analyze_asset`、`validate_asset`、`palette_asset`、`material_asset`、`validate_pack_asset`）返回报告；`validate_asset` 以 `fail` 加发现项表示失败，不会抛出错误。
- 混合工具（`tile_asset`、`preview_asset`、`animate_asset`）在只读模式返回报告，在写入模式只写入显式指定的输出路径或目录。
- 会产生文件的工具返回已应用的数量、各操作的状态、警告，以及实际写出的显式路径或内嵌的产物。
