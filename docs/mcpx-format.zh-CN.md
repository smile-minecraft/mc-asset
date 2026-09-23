# .mcpx 与 .grid 格式规范

[English](mcpx-format.md) | [繁體中文](mcpx-format.zh-TW.md) | [简体中文](mcpx-format.zh-CN.md)

本文档定义 `mc-asset` 读取的两种纯文本格式的语法、小节与约束：`.mcpx`（可编辑的多图层像素画布）与 `.grid`（轻量的单图层草稿）。解析器位于 `src/mcpx/`；`.grid` 读取器位于 `src/cli/grid.ts`，沿用同一条解析管线。

## 目录

- [1. 两种格式](#1-两种格式)
- [2. 文件级规则](#2-文件级规则)
- [3. `.mcpx` 文档结构](#3-mcpx-文档结构)
- [4. 各小节规范](#4-各小节规范)
- [5. 轻量 `.grid` 格式](#5-轻量-grid-格式)
- [6. 完整示例](#6-完整示例)
- [7. 错误代码](#7-错误代码)
- [相关文档](#相关文档)

---

## 1. 两种格式

- **`.grid`**：只有调色板和一张字符网格。手写草稿或让模型画贴图时，从这里开始。
- **`.mcpx`**：对应 `PixelCanvas` 的完整版本化格式（`mcpx 1`），包含多图层（可见性与不透明度）、具名区域掩码、元数据与调色板角色。需要第二个图层、区域或元数据时再换成它；`render --source` 可以直接把 `.grid` 转过来。

解析是确定性的：同一份文本永远得到同一张画布、同样的 PNG 字节。输出是规范化的：`build --source`（以及所有会输出 `.mcpx` 的命令）会把画布序列化为逐字节稳定的文本——固定的小节顺序、大写 `#RRGGBBAA` 颜色、三位小数的不透明度。

---

## 2. 文件级规则

所有 `.mcpx` 与 `.grid` 文件都遵守以下词法规则：

- **编码**：UTF-8，不得带 BOM。开头有 BOM 会报 `MCPX_SYNTAX_ERROR`。
- **换行**：只接受 LF（`\n`）。出现任何 CR（`\r`）都会报 `MCPX_SYNTAX_ERROR`。
- **注释**：第一个非空白字符为 `;` 的行是注释。注释只能独占一整行——写在小节标头或数值后面的 `;` 不算注释，会让该行无效。`[grid]`／`[mask]` 数据内也不允许注释。
- **空行**：小节与条目之间的空行会被忽略。在网格或掩码数据内，行之后的第一个空行即结束该数据块；所有行必须连续成一个块。
- **行尾空白**：每行行尾的空格与 Tab 会在解析前去除，因此不会影响网格宽度。

---

## 3. `.mcpx` 文档结构

`.mcpx` 文档以版本文件头开始，然后按规范顺序列出各小节：

```text
mcpx 1

[canvas]
...

[metadata]
...

[palette]
...

[layer <id>]
...

[grid]
...

[region <id>]
...

[mask]
...
```

### 3.1 文件头

第一个非空白、非注释的行必须是：

```text
mcpx 1
```

缺少文件头或版本号不是整数，报 `MCPX_SYNTAX_ERROR`；版本号是 `1` 以外的整数，报 `MCPX_UNSUPPORTED_VERSION`。

### 3.2 规范小节顺序

1. `[canvas]`：必填，必须是第一个小节，只能出现一次。
2. `[metadata]`：可选，最多一次，紧接在 `[canvas]` 之后。
3. `[palette]`：语法上可选，最多一次，位于 `[canvas]`／`[metadata]` 之后。网格用到的每个符号都必须在此定义，所以实际上只要有图层就需要它。
4. `[layer <id>]`：零个或多个（最多 64 个）。每个图层先列属性，再接恰好一个 `[grid]` 或 `[grid tokens]`。
5. `[region <id>]`：零个或多个（最多 256 个），全部位于最后一个图层之后。每个区域先列属性，再接恰好一个 `[mask]`。

小节顺序错误、未知小节、图层缺少 `[grid]` 或区域缺少 `[mask]`，均报 `MCPX_SYNTAX_ERROR`。图层或区域数量超过上限（或超出 512 MB 内存预算）报 `RESOURCE_LIMIT_EXCEEDED`。

---

## 4. 各小节规范

每个小节由 `key = value` 行组成。键名需匹配 `^[a-z][a-z0-9_]*$`；重复或未知的键报 `MCPX_SCHEMA_ERROR`。v1 不支持引号，因此任何值都不能含空白。

### 4.1 `[canvas]`

```text
[canvas]
width = 16
height = 16
```

- `width` 与 `height` 均必填，也是仅有的两个键。
- 两者都是不带正负号、不带前导零的十进制整数，范围 `1` 到 `4096`。任一边超过 512 仍然合法，但序列化时会发出 `MCPX_LARGE_CANVAS` 警告，因为 diff 会变得很大。

### 4.2 `[metadata]`（可选）

随素材携带的自由键值对。

```text
[metadata]
author = Steve
profile = minecraft:item
```

- 值不得含空白。序列化时键名按排序输出。

### 4.3 `[palette]`

把符号映射到 32 位 RGBA 颜色。

```text
[palette]
. = transparent
R = #E74C3CFF
D = #C0392BFF role=shadow
W = #FFFFFF
```

- **条目格式**：`<symbol> = <color>`，可在后面加上 ` role=<role>`。
- **符号**：任何不含空白与 `=` 的 token（例如 `c01`、`gold_edge`）。单字符符号必须是 `[.0-9A-Za-z]` 之一。符号重复报 `MCPX_SCHEMA_ERROR`。
- **颜色**：`transparent`（等同 `#00000000`）、`#RRGGBB`（alpha 为 `FF`）或 `#RRGGBBAA`。序列化一律输出大写 `#RRGGBBAA`，所以 `transparent` 会变成 `#00000000`。
- **保留的透明符号**：`.` 只能对应 `#00000000`，而 `#00000000` 只能用 `.`。违反任一条报 `MCPX_SCHEMA_ERROR`。
- **角色**（可选）：`outline`、`shadow`、`dark`、`base`、`light`、`highlight`、`accent`、`custom`。`role` 是 v1 唯一定义的调色板属性。

### 4.4 `[layer <id>]` 与其网格

图层自下而上合成：文件中的第一个图层位于堆栈最底层，之后的每个图层依次叠在上方。

- **图层 ID**：匹配 `^[A-Za-z0-9_.-]+$`（例如 `base`、`shade`、`overlay.1`）。ID 重复报 `MCPX_SEMANTIC_ERROR`。
- **属性**（顺序不限；序列化时按 `visible`、`opacity`、`name` 输出）：
  - `visible = true | false`：默认 `true`。
  - `opacity = <小数>`：范围 `0` 到 `1`，写作 `0`、`0.<数字>`、`1` 或 `1.0…`（不接受指数表示法，也不接受以 `.` 开头）；默认 `1`。序列化时固定输出三位小数，需要更多位数的值会被拒绝。
  - `name = <文本>`：可选的显示名称，不得含空白。
  - 其他任何键（包括 `blendMode`）都报 `MCPX_SCHEMA_ERROR`：v1 文本格式不携带混合模式。

属性之后是该图层的像素数据，有两种写法。

#### 紧凑网格：`[grid]`

每个字符就是一个符号，所以用到的符号都必须是单字符。紧凑调色板最多容纳 63 色（`.`、`0-9`、`A-Z`、`a-z`）。

```text
[layer base]
visible = true
opacity = 1.000

[grid]
.RR.
RWWR
RWWR
.RR.
```

- 恰好 `height` 行，每行恰好 `width` 个字符，中间不加分隔。
- 行长或行数不符报 `INVALID_GRID_SIZE`；符号未在 `[palette]` 定义报 `MCPX_SEMANTIC_ERROR`。

#### 标记网格：`[grid tokens]`

用于调色板含多字符符号，或颜色超过 63 色（最多 4096 色）的情况。

```text
[palette]
. = transparent
c01 = #5A6068FF
c02 = #9AA1A9FF

[layer base]

[grid tokens]
. c01 c01 .
c01 c02 c02 c01
c01 c02 c02 c01
. c01 c01 .
```

- token 之间以恰好一个空格分隔；出现连续两个空格报 `MCPX_SYNTAX_ERROR`。
- 恰好 `height` 行，每行恰好 `width` 个 token。
- 序列化时，若所有调色板符号都是单字符就输出 `[grid]`，否则输出 `[grid tokens]`。画布颜色数超过所选写法的容量时报 `MCPX_PALETTE_OVERFLOW`，此时请改存 PNG。

### 4.5 `[region <id>]` 与其掩码（可选）

区域是挂在画布上的具名选择掩码，与图层像素无关。选择表达式以 `region:<id>` 引用它们。

- **区域 ID**：匹配 `^[A-Za-z0-9_.-]+$`。ID 重复报 `MCPX_SEMANTIC_ERROR`。
- **属性**：只有 `name = <文本>`（可选，不得含空白）。
- **`[mask]`**：恰好 `height` 行，每行恰好 `width` 格；`.` 表示区域外，`#` 表示区域内。

```text
[region handle]
name = sword_grip

[mask]
....
.##.
.##.
....
```

- 行长或行数不符报 `INVALID_MASK_SIZE`；出现 `.`、`#` 以外的字符报 `MCPX_SYNTAX_ERROR`。

---

## 5. 轻量 `.grid` 格式

`.grid` 文件是单图层草稿：

```text
[palette]
. = transparent
R = #E74C3CFF
W = #FFFFFFFF

[grid]
.RR.
RWWR
.RR.
....
```

- 不需要 `mcpx 1` 文件头，也没有 `[canvas]`：宽度取自第一行，高度取自行数，每一行都必须一致（否则报 `INVALID_GRID_SIZE`）。
- 恰好一个 `[palette]`，后接恰好一个 `[grid]` 或 `[grid tokens]`，除此之外不含其他内容。
- 像素会落在名为 `base` 的单一图层。元数据、额外图层与区域请改用 `.mcpx`。
- 上述调色板与网格规则完全适用，错误报告的行号对应 `.grid` 文件本身。
- 用 `mc-asset render <file.grid>` 编译（`--output` 输出 PNG，`--source` 输出 `.mcpx` 源码），或使用 MCP 工具 `render_pixel_asset`（`gridPath` 或 `gridText`）。

---

## 6. 完整示例

一份含区域掩码的双图层 `.mcpx`，采用规范格式：

```text
mcpx 1

[canvas]
width = 4
height = 4

[palette]
. = #00000000
B = #2C3E50FF role=outline
R = #E74C3CFF role=base
H = #EC7063FF role=highlight

[layer base]
visible = true
opacity = 1.000
name = sword_blade

[grid]
.BB.
BRRB
BRRB
.BB.

[layer shine]
visible = true
opacity = 0.500
name = specular

[grid]
....
.HH.
....
....

[region blade_tip]
name = tip_bounds

[mask]
.##.
####
....
....
```

---

## 7. 错误代码

每个错误都带有 `details.line`（从 1 开始计数），适用时另带 `details.section`。

| 错误代码 | 状态码 | 触发条件 |
|---|---|---|
| `MCPX_SYNTAX_ERROR` | 2 | BOM 或 `\r`；缺少文件头或版本号非整数；缺少 `[canvas]`；未知或顺序错误的小节；图层缺少 `[grid]` 或区域缺少 `[mask]`；键值行缺少 `=` 或不在任何小节内；网格／掩码数据内出现注释或键值行；标记网格的 token 未以单个空格分隔；掩码格不是 `.`／`#`。 |
| `MCPX_SCHEMA_ERROR` | 2 | 键名无效、重复或未知；`width`／`height` 格式错误或超出范围；颜色无效；`.` 不是透明色，或透明色未使用 `.`；未知的角色或调色板属性；`visible`／`opacity` 无效；值或名称含空白；ID 含 `[A-Za-z0-9_.-]` 以外的字符。 |
| `MCPX_SEMANTIC_ERROR` | 2 | 图层或区域 ID 重复；网格符号未在 `[palette]` 定义。 |
| `INVALID_GRID_SIZE` | 2 | 网格行长与 `width` 不符，或行数与 `height` 不符。 |
| `INVALID_MASK_SIZE` | 2 | 掩码行长与 `width` 不符，或行数与 `height` 不符。 |
| `MCPX_PALETTE_OVERFLOW` | 2 | 序列化时画布颜色数超过网格写法的容量（紧凑 63 色、标记 4096 色）。 |
| `MCPX_UNSUPPORTED_VERSION` | 5 | 文件头的版本号是 `1` 以外的整数。 |
| `RESOURCE_LIMIT_EXCEEDED` | 5 | 图层超过 64 个或区域超过 256 个，或画布超出 512 MB 内存预算。 |

---

## 相关文档

- [CLI 接口](cli-surface.zh-CN.md)：读写 `.mcpx` 与 `.grid` 的命令（`render`、`build`、`import`、`transform`、`recolor`、`variant` 等）。
- [MCP 指南](mcp-guide.zh-CN.md)：配合 `apply_asset_operations` 与 `build_asset` 使用 `.mcpx`，以及用 `render_pixel_asset` 编写 `.grid` 草稿。
- [MCP 接口](mcp-surface.zh-CN.md)：已冻结的 MCP 工具输入与批处理操作内容。
