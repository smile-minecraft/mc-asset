# MCP 接口（已冻结）

[English](mcp-surface.md) | [繁體中文](mcp-surface.zh-TW.md) | [简体中文](mcp-surface.zh-CN.md)

入口：`mc-asset mcp` 会启动 stdio MCP 服务器。stdout 只输出 MCP JSON-RPC，诊断信息走 stderr，stdin 关闭时进程正常退出。服务器直接挂在 Core 上，不重新实现任何图像逻辑。

工具名称已冻结。早期草稿把批处理编辑工具称为 `edit_asset`，冻结后的名称是 `apply_asset_operations`。

能力基础：分析、带预设的像素化、ASCII Grid 渲染、具原子事务的批处理操作、材质重新着色、变体展开，以及可显式指定 `--mcmeta` 的验证。

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

## 输入语义

- 每个文件路径都要显式指定。会产生文件的工具不会自行决定文件名，只读工具则绝不写入。
- `profile` 为 `generic`、`minecraft:item`、`minecraft:block`、`minecraft:gui`、`minecraft:particle` 之一；省略时视为 `generic`。
- `minecraftVersion`／`resourcePackVersion`（analyze、validate）用于选择兼容性行为，接受 `26.3` 与 packFormat `75`。
- `apply_asset_operations` 接收操作对象数组，每个对象都有一个 `type`（Core 批处理词汇：`setPixel`、`drawLine`、`fillRect`、`floodFill`、图层与区域操作等），再加该类型的参数。`atomic` 默认为 true。
- 省略输出路径时，产物会内嵌在工具结果中（PNG 字节、`.mcpx` 文本），不写入磁盘。

## 输出语义

- 只读工具（`analyze_asset`、`validate_asset`）返回报告；`validate_asset` 以 `fail` 加发现项表示失败，不会抛出错误。
- 会产生文件的工具返回已应用的数量、各操作的状态、警告，以及实际写出的显式路径或内嵌的产物。
