# mc-asset

[![CI](https://img.shields.io/github/actions/workflow/status/smile-minecraft/mc-asset/ci.yml?branch=main)](https://github.com/smile-minecraft/mc-asset/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/releases)
[![License](https://img.shields.io/github/license/smile-minecraft/mc-asset)](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/mc-asset)](https://www.npmjs.com/package/mc-asset)

[English](https://github.com/smile-minecraft/mc-asset/blob/main/README.md) | [繁體中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-TW.md) | [简体中文](https://github.com/smile-minecraft/mc-asset/blob/main/README.zh-CN.md)

![mc-asset banner](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/banner.png)

`mc-asset` 是 Minecraft Java 版资源包的贴图工具，提供命令行（CLI）和 MCP 两种用法，创作者和 AI 助手都能直接使用。

语言模型没法用眼睛摆像素，所以 `mc-asset` 把做贴图这件事变成文本和命令：用字符网格画图、把参考图缩成像素风、生成可平铺的纹理、打包动画图集、预览方块模型、检查整个资源包。这些都能在终端里完成，也能通过 MCP 调用。相同的输入和种子，生成的文件内容完全相同。

![剑、镐、苹果、药水、蓝宝石与钥匙，每个都是原版风格的 16×16 像素图](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/items.png)

*六个 16×16 物品，每个都写成文本网格，再由 `mc-asset render` 绘制（×6 显示），画法遵循 [`minecraft-pixel-art`](https://github.com/smile-minecraft/mc-asset/tree/main/skills/minecraft-pixel-art) skill 的原版风格规则。网格源文件在 [`docs/assets/showcase/items/`](https://github.com/smile-minecraft/mc-asset/tree/main/docs/assets/showcase/items)。*

---

## 目录

- [功能一览](#功能一览)
- [核心特性](#核心特性)
- [成果展示](#成果展示)
- [安装指南](#安装指南)
- [面向 AI 助手](#面向-ai-助手)
- [快速上手](#快速上手)
- [常用操作实践](#常用操作实践)
- [MCP 服务器](#mcp-服务器)
- [CLI 命令一览表](#cli-命令一览表)
- [批量像素修改（`--operations`）](#批量像素修改--operations)
- [系统架构与可靠性保证](#系统架构与可靠性保证)
- [开发者命令](#开发者命令)
- [开源许可](#开源许可)

---

## 功能一览

- 用文本网格画贴图（`render`）
- 把参考图缩成像素风（`pixelize`）、减少颜色（`quantize`）
- 一键换材质变体（`variant`）
- 生成可平铺的纹理（`generate`、`tile`）
- 打包动画图集、生成 `.mcmeta`（`animate`、`mcmeta`）
- 界面贴图缩放（`gui-scale`）
- 比对两张图的差异（`compare`）
- 检查单张贴图或整个资源包（`validate`、`validate-pack`）
- 无损压缩 PNG（`optimize`）
- 创建、检查、预览 Java 方块模型（`model`）
- 以 MCP 服务器提供给 AI 助手使用（`mcp`）

---

## 核心特性

- **文本进，贴图出。** 贴图可以写成字符网格（`.grid`）或可编辑的多图层源文件（`.mcpx`），再转成 PNG。格式见 [`docs/mcpx-format.zh-CN.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcpx-format.zh-CN.md)。
- **输出完全一致。** 不使用未指定种子的随机数，颜色合成只用整数运算，因此每次运行、以及在 Bun 和 Node 之间，生成的 PNG 与 `.mcpx` 内容都完全相同。
- **一个核心，两种用法。** CLI 和 stdio MCP 服务器共用同一个核心，AI 助手拿到的结果和 shell 脚本完全一样。
- **统一的返回格式。** `--json` 一律返回 `{ success, result, error }` 与固定的错误码，日志不会混进 stdout 的数据。
- **不会意外改文件。** 输出路径都要显式指定，覆盖已有文件要加 `--force`；每个文件都先写入临时文件，完成后再改成正式文件名。

---

## 成果展示

以下图片全部由 `mc-asset` 本身产出，程序生成的纹理均使用固定种子，整组皆可复现。对应命令见 [`docs/assets/showcase/README.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/assets/showcase/README.md)。

| 像素化（Pixelize） | 减少颜色（Quantize） |
|---|---|
| ![pixelize 前](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-before.png) → ![pixelize 后](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/pixelize-after.png) | ![quantize 前](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-before.png) → ![quantize 后](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quantize-after.png) |
| 高细节参考图（128px，×2 显示）缩到 16px（×16 显示）：颗粒变粗，形状收敛成整齐的像素格。 | 64 色渐变压到 8 色（均为 ×4 显示）：颜色数变少，出现清晰的色阶。 |

**材质变体**：把本页开头那把剑展开成全部七种内置材质（`copper`、`crystal`、`gold`、`iron`、`oxidized_copper`、`stone`、`wood`，×5 显示）。调色板为每个颜色标注了角色，所以剑身和护手换上新色阶，最深的轮廓、白色高光、木质握柄和护手上的宝石保持原色：

![换成七种材质的剑](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/variants.png)

**程序生成的纹理**：每种 `generate` 图案各一张 16px 样本，使用固定种子（×4 显示）：

| `noise` | `clustered-noise` | `stripes` | `checker` | `gradient` |
|:-:|:-:|:-:|:-:|:-:|
| ![noise](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/noise.png) | ![clustered-noise](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/clustered-noise.png) | ![stripes](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/stripes.png) | ![checker](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/checker.png) | ![gradient](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/gradient.png) |
| `brick` | `spots` | `veins` | `cracks` | `grain` |
| ![brick](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/brick.png) | ![spots](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/spots.png) | ![veins](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/veins.png) | ![cracks](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/cracks.png) | ![grain](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/patterns/grain.png) |

**无缝平铺**：一张 16px 的砖块方块贴图（左，×8 显示）与它铺成的 4×4 墙面（右，×4 显示）；砖缝在每条边上都接得上：

![平铺来源](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-pattern.png) ![4x4 平铺墙面](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/tile-preview.png)

**方块贴图**：石头、泥土、橡木木板三张 16×16 贴图（×8 显示），四边都能无缝衔接。右边是木板铺成的 4×4 墙面（×4 显示）：

![三张方块贴图](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/blocks.png) ![4x4 木板墙面](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/blocks-wall.png)

**动画图集**：发光矿石方块的四帧，打包成一条竖向图集（×4 显示），也就是 Minecraft 配合 `.mcmeta` 动画读取的排列方式：

![动画图集](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/anim-sheet.png)

**药水变体与比对**：把药水换成 `crystal`、`gold`、`iron` 三种材质（×5 显示），玻璃瓶身保持原色、只有瓶内药水跟着换色。用 `compare` 比对铁与金版本，找出瓶内 72 个变化的药水像素，在诊断图上以品红色标出（×8 显示）：

![换成三种材质的药水](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/potion-variants.png) ![两个药水变体的对比诊断图](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/compare-diff.png)

**按钮九宫格**：一张 16px 的按钮外框（左，×4 显示），放大到 48×16 的九宫格结果（中，×4 显示）与直接拉伸的结果（右，×4 显示）；九宫格的边角和斜面保持清晰，直接拉伸则会变糊：

![按钮原图](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/button.png) ![按钮九宫格结果](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/button-nine-slice.png) ![按钮拉伸结果](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/button-stretch.png)

**Java 模型三视图预览**：由五个长方体组成的阶梯祭坛方块模型（[`model-shrine.json`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/assets/showcase/model-shrine.json)），使用上方展示过的砖块、木板、石头和发光矿石贴图。通过 `mc-asset model preview --size 128` 从三个方向各看一次：正面（北，`front`）、侧面（东，`right`）、上方（`top`）：

![Java 方块模型的三视图预览](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/model-preview.png)

---

## 安装指南

### 通过 npm 安装（推荐）

直接从 registry 运行服务器，无需先在本机安装：

```sh
npx -y mc-asset mcp
```

若要在 PATH 上获得 `mc-asset` 命令，可全局安装 CLI：

```sh
npm install -g mc-asset
mc-asset --version
```

### 通过 Homebrew 安装（macOS / Linux）

```sh
brew tap smile-minecraft/tap
brew install smile-minecraft/tap/mc-asset
mc-asset --version
```

### 通过源码安装（Bun 或 Node.js）

```sh
git clone https://github.com/smile-minecraft/mc-asset.git
cd mc-asset
bun install --frozen-lockfile
bun run build
./bin/mc-asset.js --version
```

*系统环境需求*：已在 [Node.js](https://nodejs.org) 22 与 [Bun](https://bun.sh) 1.3 上测试。`bun run build` 需要 Bun，`./bin/mc-asset.js` 需要 Node.js；只有 Bun 时，改为运行 `bun ./bin/mc-asset.js`。

---

## 面向 AI 助手

- [`llms.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms.txt)：给 AI 助手的项目精简索引。
- [`llms-full.txt`](https://github.com/smile-minecraft/mc-asset/blob/main/llms-full.txt)：同一份信息的单文件版本，涵盖安装、25 个 MCP 工具、批量操作、错误模型与限制。
- [`docs/cli-surface.zh-CN.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/cli-surface.zh-CN.md)：已冻结的 CLI 命令、批量操作规范与状态码对照表。
- [`docs/mcpx-format.zh-CN.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcpx-format.zh-CN.md)：可编辑的多图层 `.mcpx` 与 `.grid` 格式语法与规范。
- [`docs/mcp-guide.zh-CN.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-guide.zh-CN.md)：注册方式、每个 MCP 工具的实际调用记录，以及错误模型。
- [`docs/mcp-surface.zh-CN.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-surface.zh-CN.md)：已冻结的 MCP 接口——工具名称、输入参数与读写规则。
- [`AGENTS.md`](https://github.com/smile-minecraft/mc-asset/blob/main/AGENTS.md)：修改本仓库时必须遵守的规则。

### Agent Skills

本项目在 [`skills/`](https://github.com/smile-minecraft/mc-asset/tree/main/skills) 附带两个供 AI 助手使用的 [Agent Skill](https://skills.sh/)，可以用 skills CLI 安装：

```sh
npx skills add smile-minecraft/mc-asset
```

- [`mc-asset`](https://github.com/smile-minecraft/mc-asset/tree/main/skills/mc-asset)：用这套工具画图的流程（编写 → 绘制 → 预览 → 测量 → 校验）、CLI 与 MCP 的命令对照，以及调色板角色如何决定换色结果。
- [`minecraft-pixel-art`](https://github.com/smile-minecraft/mc-asset/tree/main/skills/minecraft-pixel-art)：物品、方块、GUI 与动画的原版风格规则，包括调色板与色相偏移色阶、按材质着色的轮廓、左上光源、平铺，以及一份常见错误的检查清单。

只想装其中一个时，加上 `--skill mc-asset` 或 `--skill minecraft-pixel-art`。

---

## 快速上手

### 从文本网格到校验通过的贴图

用字符网格画一颗 16×16 的宝石，一个字符就是一个像素：

```sh
mkdir -p /tmp/mc-asset-demo
cat << 'EOF' > /tmp/mc-asset-demo/gem.grid
[palette]
. = transparent
o = #0E1846FF
s = #1E3A8CFF
D = #2448A8FF
m = #3569D0FF
l = #5A92EEFF
t = #7FB2F6FF
T = #A9D2FFFF
W = #FFFFFFFF

[grid]
................
................
......sssss.....
.....sTTTTTo....
....sTTWWTTto...
...sTTWWTTttto..
..slllTTTtttmmo.
..slllllmmmmmDo.
..slllllmmmmmDo.
..slllllmmmmDDo.
...olllmmmmDDo..
....ollmmmDDo...
.....olmmmDo....
......ommDo.....
.......ooo......
................
EOF
```

把文本网格转成 PNG 贴图，并同时存一份可重复编辑的 `.mcpx` 源文件：

```sh
mc-asset render /tmp/mc-asset-demo/gem.grid \
  --output /tmp/mc-asset-demo/gem.png \
  --source /tmp/mc-asset-demo/gem.mcpx
# ok render profile=generic applied=0 output=/tmp/mc-asset-demo/gem.png source=/tmp/mc-asset-demo/gem.mcpx
```

绘制出来的 `gem.png`（×8 显示）：

![绘制出的宝石](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quickstart-gem.png)

检查它的颜色和透明度：

```sh
mc-asset analyze /tmp/mc-asset-demo/gem.png
# dimensions: 16x16
# colors: 9
# alpha: predicted cutout (opaque=119 transparent=137 partial=0)
# dominant: #00000000 x137 (0.5352), #3569D0FF x28 (0.1094), #5A92EEFF x24 (0.0938), #0E1846FF x18 (0.0703), #A9D2FFFF x16 (0.0625), #1E3A8CFF x12 (0.0469), #2448A8FF x10 (0.0391), #7FB2F6FF x7 (0.0273)
# profile: predicted profile generic has no Minecraft-specific restrictions.
# palette: colorCount=9 alphaLevels=2 transparent=137 partial=0
# pixel-art: 16x16 aspect=1:1 isolated=0 semiTransparent=0 tileFriendly=true
# recommended: quantize.colors=16 cleanup=none resize=nearest
```

按 Minecraft 物品贴图的规范检查它：

```sh
mc-asset validate /tmp/mc-asset-demo/gem.png --profile minecraft:item
# verdict: pass
# dimensions: 16x16
# colors: 9
# alpha: predicted cutout (opaque=119 transparent=137 partial=0)
# profile: predicted profile minecraft:item prefers the items atlas without mipmaps.
```

---

## 常用操作实践

### 实践 1：把参考图缩成像素风（`pixelize`）

把高分辨率参考图转成 16×16 的物品贴图。同一张图、同一个预设，永远得到同样的像素：

```sh
mc-asset pixelize reference.png \
  --size 16 \
  --preset item \
  --profile minecraft:item \
  --output item_texture.png
```

- `--preset item` 设定 16 色上限，并启用裁剪、去背、主体、边缘与色块整理阶段。
- 其他预设：`block`、`gui`、`particle`、`generic`。

### 实践 2：生成纹理与无缝平铺（`generate` 与 `tile`）

用固定种子生成石材纹理，再检查它能不能无缝平铺：

```sh
mc-asset generate noise \
  --size 16 \
  --palette stone \
  --seed 42 \
  --output stone.png

# 接缝分数：水平、垂直、角落（越低越平顺）
mc-asset tile stone.png
# ok tile profile=generic seam=h:0.065196 v:0.096051 c:0.003604 repeat=0.908038

# 对齐相对两边的边缘像素，并预览 4x4 平铺
mc-asset tile stone.png \
  --edge-match both \
  --preview 4x4 \
  --output stone_preview.png
```

### 实践 3：减少颜色与清理噪点（`quantize` 与 `cleanup`）

把贴图减到 8 色，再清掉减色后留下的零星像素：

```sh
mc-asset quantize sprite.png --colors 8 --output quantized.png

mc-asset cleanup quantized.png \
  --fix isolated,noise \
  --allow-render-pass-change \
  --output clean.png
```

这两类修正可能改变透明度，进而改变贴图需要的渲染阶段（render pass），所以不加 `--allow-render-pass-change` 时 `cleanup` 会拒绝执行。

### 实践 4：换材质变体（`variant` 与 `recolor`）

把一份源文件展开成多种材质，或整份改成单一材质。输入可以是可编辑的 `.mcpx`，也可以是一般 PNG（PNG 没有调色板角色信息，像素会按整数明度分段对应，不会凭空猜测图层角色）：

```sh
mc-asset variant sword.mcpx \
  --materials iron,copper,gold \
  --output-dir ./dist_variants \
  --mkdir
# 生成 sword_iron.png、sword_iron.mcpx、sword_copper.png 等

mc-asset recolor sword.mcpx --material gold --output sword_gold.png
```

### 实践 5：动画图集打包（`animate`）

把整个文件夹的帧打包成竖向图集，再对照它的 `.mcmeta` 检查：

```sh
mc-asset animate pack \
  --frames-dir ./textures/fire_frames \
  --layout vertical \
  --output ./textures/fire.png

mc-asset validate ./textures/fire.png --mcmeta ./textures/fire.png.mcmeta
```

### 实践 6：检查整个资源包（`validate-pack`）

扫描整个资源包：缺失的贴图、错误的命名空间、未被引用的贴图、损坏的模型引用，以及循环引用。`--minecraft-version` 决定对照哪一版的资源包格式：

```sh
mc-asset validate-pack ./MyResourcePack \
  --minecraft-version 26.3 \
  --json
```

### 实践 7：批量编辑与视觉反馈（`build` 与 `apply_asset_operations`）

用一批操作修改快速上手做出的宝石：画一个 4×4 的金色方块，外面框一圈 6×6 的黑边。CLI 应用整批操作后输出 PNG：

```sh
cat << 'EOF' > /tmp/mc-asset-demo/ops.json
[
  { "type": "fillRect", "rect": { "x": 6, "y": 6, "width": 4, "height": 4 }, "color": "#FFD700FF" },
  { "type": "drawRect", "rect": { "x": 5, "y": 5, "width": 6, "height": 6 }, "color": "#000000FF" }
]
EOF

mc-asset build /tmp/mc-asset-demo/gem.mcpx \
  --operations /tmp/mc-asset-demo/ops.json \
  --output /tmp/mc-asset-demo/gem_modified.png
# ok build profile=generic applied=2 output=/tmp/mc-asset-demo/gem_modified.png
```

应用这批操作前后（均为 ×8 显示）：

![应用前的宝石](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/quickstart-gem.png) → ![应用后的宝石](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/batch-edit-gem.png)

通过 MCP，`apply_asset_operations` 会跑同一批操作，还能把改动的部分画出来返回：

```json
{
  "sourcePath": "/tmp/mc-asset-demo/gem.mcpx",
  "operations": [
    { "type": "fillRect", "rect": { "x": 6, "y": 6, "width": 4, "height": 4 }, "color": "#FFD700FF" },
    { "type": "drawRect", "rect": { "x": 5, "y": 5, "width": 6, "height": 6 }, "color": "#000000FF" }
  ],
  "outputPngPath": "/tmp/mc-asset-demo/gem_feedback.png",
  "feedback": { "image": "changed", "scale": 8, "diff": "summary" }
}
```

带上 `feedback` 后，返回结果除了原本的字段，还会多一个 PNG 图像块（裁剪到改动范围，按 `scale` 放大 1–16 倍），以及 `diff` 摘要（`raw`、`composited`、`structural`、`outsideSelectionUnchanged`）。如果编辑没有产生可见变化，则返回 `noVisibleChange` 而不附图像。AI 助手不用取回整张画布就能看到自己改了什么。这里的输出路径和 CLI 不同，是因为 MCP 工具不会覆盖已有文件。

### 实践 8：GUI 九宫格缩放（`gui-scale`）

放大 GUI 外框而不把边框拉糊。使用 `nine_slice` 时，四个角 1:1 复制，边和中央以平铺填满（设 `stretch_inner: true` 则改为拉伸）。16×16 的 `dialog.png` 在 `dialog.png.mcmeta` 里声明 4px 边框：

```json
{ "gui": { "scaling": { "type": "nine_slice", "width": 16, "height": 16, "border": 4 } } }
```

```sh
mc-asset gui-scale ./textures/gui/dialog.png \
  --mcmeta ./textures/gui/dialog.png.mcmeta \
  --size 48x32 \
  --output ./textures/gui/dialog_large.png
# ok gui-scale profile=generic size=48x32 scaling=nine_slice output=./textures/gui/dialog_large.png
```

`gui-scale` 不会自己去找同名的 `.mcmeta`；没给 `--mcmeta` 时会把整张图直接拉伸。

| 原图 16×16 | `nine_slice`，48×32 | 不给 `--mcmeta`（拉伸），48×32 |
|:-:|:-:|:-:|
| ![dialog 原图](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/dialog.png) | ![九宫格结果](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/nine-slice.png) | ![拉伸结果](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/gui/stretch.png) |

三张均为 ×4 显示。有 mcmeta 时，切角和 2px 斜面 1:1 复制，宽度不变；直接拉伸会让斜面粗细不一，切角也会糊掉。

### 实践 9：无损压缩 PNG 与 Java 方块模型（`optimize` 与 `model`）

`optimize` 把 PNG 重新编码成像素完全相同但文件最小的结果；如果没有更小的编码，就保留原文件。可传入明确的 PNG 路径清单（最多 256 个文件）或整个目录（`--input-dir`，最多 4096 个文件，可加 `--recursive` 保留相对目录结构）。它不会改写输入文件，输出方式从 `--output`、`--output-dir`、`--stdout`、`--dry-run` 择一。

```sh
mc-asset optimize ./gem.png --dry-run
# ok optimize input=./gem.png output=- status=optimized source=184 result=102 mode=rgba
mc-asset optimize ./gem.png ./sword.png --output-dir ./optimized --mkdir
mc-asset optimize --input-dir ./textures --recursive --output-dir ./optimized --mkdir
```

`model` 用来处理 Java 方块与物品模型 JSON（支持长方体 `elements`）。创建模型、用类型化操作修改，再对资源包检查：

```sh
mc-asset model create --spec ./docs/assets/showcase/model-shrine.json \
  --output ./pack/assets/mypack/models/block/shrine.json --mkdir --resource-pack-version 75
mc-asset model validate ./pack/assets/mypack/models/block/shrine.json \
  --pack ./pack --resource-pack-version 75
mc-asset validate-pack ./pack --resource-pack-version 75
```

`model apply` 接收 `--operations`，整批应用成功或全部不应用；`model export` 会输出模型文件，加上 `--binding` 时还会在对应路径一并写出物品定义与 blockstate。检查范围是 JSON 结构与贴图引用是否有效，不会启动 Minecraft 客户端，因此不涵盖游戏内的实际打光与动态行为。

`model preview` 从长方体 `elements` 绘制固定的诊断图：三个正方形面板横向排列（`front` 是北面、`right` 是东面、`top` 是顶面且北方朝上），每个面板边长为 `--size`（64、128 或 256，默认 64）：

```sh
mc-asset model preview ./pack/assets/mypack/models/block/shrine.json \
  --pack ./pack --size 128 --output ./shrine-preview.png --resource-pack-version 75
```

![Java 方块模型的三视图预览](https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/docs/assets/showcase/model-preview.png)

`--output` 与 `--stdout` 必须二选一。报告包含面板名称与坐标、输入范围、`coverage` 与 `warnings`。找不到贴图时会画成固定棋盘格并发出警告；元素旋转、非 1/256 坐标、半透明面与无法解析的贴图会列为 `partial`。`display` 变换与游戏内光照不会应用，这张图是结构诊断视图，不是游戏画面。

---

## MCP 服务器

`mc-asset mcp` 会启动一个 stdio MCP 服务器，底层和 CLI 共用同一个核心，因此 AI 助手调用工具和在终端运行命令会得到相同结果。服务器共提供 25 个工具。

### 提供的 MCP 工具

| 工具名称 | 功能说明 |
|---|---|
| `analyze_asset` | 只读分析：尺寸、调色板分布、透明度分类与像素画指标。 |
| `pixelize_asset` | 把位图（PNG/JPEG/WebP）缩成像素风，返回 PNG 或 `.mcpx` 源文件。 |
| `render_pixel_asset` | 绘制内联 ASCII 网格或 `.grid` 文件，可同时应用批量修改。 |
| `apply_asset_operations`| 对 `.mcpx` 源文件整批修改像素、图层与区域。 |
| `recolor_asset` | 将贴图换成内置材质色阶（如 `iron`、`gold`、`stone` 等）。 |
| `create_variants` | 将单一素材一次展开成多种材质变体并写入目录。 |
| `validate_asset` | 检查单张贴图与 `.mcmeta` 是否符合 Minecraft 规范。 |
| `import_asset` | 将位图（PNG/JPEG/WebP）读入像素画布，可同时应用批量修改。 |
| `build_asset` | 将 `.mcpx` 源文件转成 PNG 或重新序列化的 `.mcpx`，可同时应用批量修改。 |
| `transform_asset` | 对位图或 `.mcpx` 应用单一几何操作（flip、rotate、crop、pad、resize、translate）。 |
| `scale_gui_asset` | 按 mcmeta 的 stretch/tile/nine_slice 规则缩放 GUI 贴图，输出 PNG。 |
| `quantize_asset` | 将颜色数减到指定数量或对齐指定调色板，并可保留指定的 RGBA 颜色。 |
| `cleanup_asset` | 检测或清除像素瑕疵（`isolated`、`noise`、`cluster`、`fringe`、`outlier`、`hole`、`aa`）。 |
| `palette_asset` | 只读调色板 `extract`/`inspect` 报告（颜色列表、分布、角色、明暗对比）。 |
| `material_asset` | 只读列出（`list`）或查看（`show`）内置材质色阶。 |
| `tile_asset` | 接缝、边缘重复与亮度分析，可选输出平铺预览 PNG。 |
| `generate_asset` | 用固定种子生成程序生成的纹理（pattern、size、palette、seed）。 |
| `preview_asset` | `ascii`/`palette-map` 文本报告，以及 `scale` 与 `nine-slice` 辅助预览 PNG。 |
| `mcmeta_asset` | 按 PNG 尺寸生成动画或 GUI 缩放设置。 |
| `animate_asset` | 对动画帧组执行 `pack`、`unpack`、`reorder`、`resize`、`validate`、`preview`。 |
| `validate_pack_asset` | 只读扫描整个资源包：命名空间、模型、贴图、图集与目标版本。 |
| `inspect_asset` | 只读 `structure`（图层、区域、颜色用量、重叠）或 `view`（合成 PNG 图块加摘要信息）；输入为 `inputPath`。 |
| `optimize_asset` | 无损压缩 PNG（若无更小编码则保留原文件）；支持单文件、多文件、目录扫描（`inputDir`、`recursive`，上限 4096 个文件）与 `dryRun`。 |
| `model_asset` | Java 方块／物品模型 JSON：`inspect`、`validate`、`create`、`apply`、`export`（含物品定义与 blockstate），以及 `preview`（生成三视图诊断 PNG）。 |
| `compare_assets` | 比对两张同尺寸 PNG；返回原始 RGBA 与可见差异像素数、差异范围框，并可输出诊断标记图。 |

`inspect_asset` 有两种模式：`structure` 报告图层、区域、颜色用量与重叠；`view` 把合成后的画布以 PNG 图像块返回，可选 `crop` 与 `scale`（1–16）。边长超过 1024px 的 view 会被拒绝并提示改用裁剪，不会自动缩小。`apply_asset_operations` 可以带可选的 `feedback` 对象（见[实践 7](#实践-7批量编辑与视觉反馈build-与-apply_asset_operations)）；不带时结果完全不变。[`docs/mcp-guide.zh-CN.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/mcp-guide.zh-CN.md) 收录了每个工具实际调用的输入与返回示例。

### 配置方式

每个客户端运行的都是同一个 stdio 命令：`npx -y mc-asset mcp`。各客户端的配置文件位置可能随版本调整，找不到时请查阅该客户端的文档。

#### Claude Code

```sh
claude mcp add mc-asset -- npx -y mc-asset mcp
```

#### Claude Desktop

在 `~/Library/Application Support/Claude/claude_desktop_config.json` 中加入：

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

#### Cursor

在 `.cursor/mcp.json` 中加入：

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

#### OpenCode

在 `opencode.json` 或 `opencode.jsonc` 中加入：

```jsonc
{
  "mcp": {
    "mc-asset": {
      "type": "local",
      "command": ["npx", "-y", "mc-asset", "mcp"],
      "enabled": true
    }
  }
}
```

---

## CLI 命令一览表

| 分类 | 命令 | 说明 |
|---|---|---|
| **输入与构建** | `import <image>` | 读取 PNG/JPEG/WebP 并转成 PNG 或 `.mcpx`。 |
| | `render <grid>` | 将字符网格（`.grid`）绘制成 PNG 或 `.mcpx`。 |
| | `build [source]` | 将 `.mcpx` 源文件或标准输入（`--stdin`）转成 PNG。 |
| **几何变换** | `transform <input>` | 几何操作：`--flip`、`--rotate`、`--crop`、`--pad`、`--resize`、`--translate`。 |
| **色彩与清理** | `quantize <input>` | 把颜色减到指定数量（`--colors <N>`）或对齐调色板（`--palette`），可用 `--keep-color` 保留指定色。 |
| | `cleanup <input>` | 清除孤立与噪点像素（`--fix isolated,noise,outlier`）。 |
| | `palette extract` | 从图片提取调色板。 |
| | `palette inspect` | 分析调色板分布、角色与明暗对比。 |
| | `material list` | 列出内置的 Minecraft 材质。 |
| | `material show` | 查看特定材质的色阶定义。 |
| | `recolor <source>` | 按内置材质重新上色。 |
| | `variant <source>` | 一次衍生多种材质变体到 `--output-dir`。 |
| **纹理生成与平铺** | `generate <pattern>` | 用固定种子（`--seed <int>`）生成程序生成的纹理。 |
| | `tile <input>` | 检查接缝分数与自动修补边缘。 |
| | `preview <input>` | 多模式预览：`--ascii`、`--palette-map`、`--scale <N>`、`--nine-slice`。 |
| | `gui-scale <input>` | 按 mcmeta stretch/tile/nine_slice 规则把 GUI 贴图缩放到 `--size <N\|WxH>`。 |
| **动画与图集** | `animate pack` | 将帧文件夹打包成动画图集。 |
| | `animate unpack` | 将动画图集拆成单张帧文件。 |
| | `animate reorder` | 调整帧播放顺序。 |
| | `animate resize` | 批量缩放帧尺寸。 |
| | `animate validate`| 对照 `.mcmeta` 检查帧数与排列方式。 |
| | `animate preview` | 预览动画序列。 |
| | `mcmeta animation\|gui` | 按 PNG 尺寸生成 `.mcmeta` 动画或 GUI 缩放配置（`--output`、`--stdout`）。 |
| **检查与比对** | `analyze <image>` | 只读分析尺寸、颜色分布与透明度。 |
| | `inspect <input>` | 只读结构报告或合成视图（`--mode structure\|view`、`--crop`、`--scale`）。 |
| | `validate <asset>` | 检查单张贴图与 `.mcmeta` 是否合规。 |
| | `validate-pack <path>`| 检查整个资源包目录的引用与结构。 |
| | `compare <before> <after>` | 比对两张同尺寸 PNG；返回原始 RGBA 与可见差异像素数，并可输出诊断 PNG（`--output`、`--stdout`、`--scale`）。 |
| **压缩与模型** | `optimize <input...>` 或 `--input-dir <dir>` | 无损压缩 PNG（若无更小编码则保留原文件；支持 `--output`、`--output-dir`、`--stdout`、`--dry-run`、`--mode`、`--ancillary`、`--recursive`）。 |
| | `model inspect\|validate <file>` | 只读检查 Java 方块／物品模型 JSON（结构、UV、旋转、display、贴图引用）。 |
| | `model create\|apply\|export` | 创建、修改或导出 Java 模型（长方体 `elements`）及其物品定义与 blockstate。 |
| | `model preview <file>` | 绘制三视图诊断 PNG（`front`、`right`、`top` 面板，`--size 64\|128\|256`，`--output` 或 `--stdout`）。 |
| **AI 助手接口** | `mcp` | 启动 stdio MCP 服务器。 |

### 生成动画与 GUI 设置（`mcmeta`）

从 PNG 生成动画或 GUI 缩放设置：

```sh
mc-asset mcmeta animation sheet.png --frame-size 16 --frametime 2 --frames '[0,{"index":1,"time":4},0]' --minecraft-version 1.21.2 --output sheet.png.mcmeta
mc-asset mcmeta gui panel.png --type nine_slice --border 4 --stretch-inner --resource-pack-version 42 --stdout
```

- **动画（`animation`）**
  - 必填：`--frame-size <N|WxH>`。帧只支持单排或单列，且尺寸必须整除 PNG（不接受网格排列）。
  - 选填：`--frametime <int>`（默认 `1`）、`--frames <json>`（接受整数索引或 `{index,time}` 对象；省略时依序播放全部帧，时间须为正整数且索引不得越界）、`--interpolate`（启用补间插值）。
- **GUI（`gui`）**
  - 必填：`--type <stretch|tile|nine_slice>`。`tile` 与 `nine_slice` 以 PNG 尺寸为设计尺寸；选 `nine_slice` 时还必须指定 `--border <N|json>`（`left`、`top`、`right`、`bottom` 为非负整数，中央区域须保留正面积）。
  - 选填：`--stretch-inner`（仅 `nine_slice` 可用）。
- **输出与版本检查**
  - 输出必须从 `--output <path.mcmeta>` 与 `--stdout` 二选一；覆盖已有文件需加 `--force`（会替换整个文件），创建父目录需加 `--mkdir`。
  - `--minecraft-version` 与 `--resource-pack-version` 二选一：GUI 缩放需要 pack format `16.0`、`stretch_inner` 需要 `42.0`，版本不符时返回 `ARGUMENT_CONFLICT`。未指定版本或超出 `12.0`–`97.1` 会返回 `versionChecked: false`（`VERSION_NOT_CHECKED`），但仍会检查 GUI 最低版本限制（参考：[Texture animation](https://minecraft.wiki/w/Resource_pack#Texture_animation)、[GUI scaling](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w31a)、[Pack format](https://minecraft.wiki/w/Pack_format)）。

### 比对 PNG 差异（`compare`）

```sh
mc-asset compare before.png after.png --json
mc-asset compare before.png after.png --output diff.png --scale 4
mc-asset compare before.png after.png --stdout --json > diff.png
```

比对两张同尺寸的 PNG（尺寸不同会返回 `INVALID_ARGUMENT`）。不加 `--output` 或 `--stdout` 时只返回报告、不写文件；加上 `--output <path.png>` 或 `--stdout`（两者二选一）时会输出诊断标记图，用洋红色（`255,0,255,255`）标示可见差异、青色（`0,255,255,255`）标示透明像素下隐藏的 RGB 差异，未变动的像素则保持透明（`0,0,0,0`）。`--scale`（`1`–`16`，默认 `1`）可用最近邻放大标记图，放大后长边若超过 1024px 会返回 `RESOURCE_LIMIT_EXCEEDED`。

报告包含 `width`、`height`、`totalPixels`、`rawChangedPixels`、`visibleChangedPixels`、`rawBounds` 与 `visibleBounds`（从 0 开始的 `{x,y,width,height}`，无差异时为 `null`）。两个源文件都不会被改写；覆盖已有目标需加 `--force`，创建父目录需加 `--mkdir`。

---

## 批量像素修改（`--operations`）

在 `import`、`render` 与 `build` 命令中，可通过 `--operations <path>` 或 `--operations -`（stdin）传入批量修改操作：

```json
[
  { "type": "setPixel", "x": 0, "y": 0, "color": "#FF0000FF" },
  { "type": "drawLine", "from": [0, 0], "to": [15, 15], "color": "#00FF00FF" },
  { "type": "fillRect", "rect": { "x": 2, "y": 2, "width": 4, "height": 4 }, "color": "#FFFF00FF" },
  { "type": "floodFill", "x": 5, "y": 5, "color": "#0000FFFF" },
  { "type": "clearPixel", "x": 0, "y": 0 }
]
```

- **整批成功或整批复原**：批量中只要有任何一项操作失败（例如坐标超出画布），整批修改都会复原，不会留下改一半的结果。
- **颜色写法**：支持 `transparent`、`#RRGGBB` 或 `#RRGGBBAA`。
- **操作种类**：共 25 种，包含 9 个像素操作（`setPixel`、`clearPixel`、`drawLine`、`drawRect`、`fillRect`、`floodFill`、`ellipse`、`polygonFill`、`strokeMask`），以及图层、区域、`stampRect` 与 `regionFromSelection`。完整参数表见 [`docs/cli-surface.zh-CN.md`](https://github.com/smile-minecraft/mc-asset/blob/main/docs/cli-surface.zh-CN.md)。
- **几何绘图**：`ellipse` 接受 `rect`、`color` 与 `mode`（`fill`／`outline`）；`polygonFill` 接受整数 `[x, y]` 的 `points` 与 `color`（最多 4096 点，超过返回 `RESOURCE_LIMIT_EXCEEDED`；不支持自交与镂空，自交多边形返回 `SELF_INTERSECTING_POLYGON`）；`strokeMask` 接受 `layerId`、`source` 选择范围与 `color`，也可搭配 `selection` 限制写入范围。
- **选择范围**：像素操作可带选填的 `selection`；若选择结果为空集合，会以 `EMPTY_SELECTION` 拒绝写入并复原整批操作。

---

## 系统架构与可靠性保证

```text
                  ┌─────────────────────────────────┐
                  │          mc-asset Core          │
                  │  PixelCanvas • IO • Algorithms  │
                  └───────────────┬─────────────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
     ┌───────────▼───────────┐         ┌───────────▼───────────┐
     │     CLI Interface     │         │   Native MCP Server   │
     │  (终端命令行与自动化)    │         │    (AI 助手桥接接口)   │
     └───────────────────────┘         └───────────────────────┘
```

### 为什么每次运行结果都一样

1. **固定的 PNG 编码**：使用固定的 deflate 压缩参数与滤波策略（`src/io/png.ts`），颜色合成全部使用整数运算，且文件内不写入系统时间戳或主机信息。
2. **固定种子的随机数**：程序生成的纹理全部使用整数 `xorshift32` 随机数发生器，由 `--seed` 初始化。
3. **Bun 与 Node 输出一致**：在 Bun 与 Node.js 下运行时，`scripts/compare-runtime.mjs` 测试覆盖的所有命令都会产出内容完全相同的文件。

### 文件写入与输出通道安全

- **安全写文件**：写入时会先在目标目录创建临时文件（`.tmp-<pid>-<counter>-<randomhex>-<原文件名>`），写完后再改成正式文件名，中途失败也不会留下损坏的半成品。
- **防止误覆盖源文件**：所有路径都会先展开并统一大小写与 Unicode NFC 格式。若输出路径指向输入文件本身（且未加 `--in-place`），或同时指定了重复的输出路径，会在写入任何数据前直接中止。
- **stdout 与 stderr 分流**：
  - 未加 `--stdout` 时：普通信息输出到 stdout；加上 `--json` 时，JSON 结果输出到 stdout，普通信息改送到 stderr。
  - 加上 `--stdout` 时：产出的二进制文件内容独占 stdout，JSON 结果与普通信息都送到 stderr。

### 退出状态码表（Exit Codes）

| 状态码 | 类别 | 说明 |
|---|---|---|
| **0** | Success | 操作顺利完成。 |
| **1** | Internal Error | 未预期的内部错误（`INTERNAL_ERROR`）。 |
| **2** | Invalid Invocation | 语法错误、选项冲突或缺少必填参数（`INVALID_ARGUMENT`）。 |
| **3** | Validation Failure | 工具运行成功，但贴图或资源包未通过 Minecraft 规范检查（`VALIDATION_FAILED`）。 |
| **4** | Filesystem Error | 输出文件已存在且未加 `--force`、目录不存在且未加 `--mkdir`，或无法读取输入文件。 |
| **5** | Unsupported / Limit | 不支持的文件格式，或超过尺寸与资源上限。 |

---

## 开发者命令

```sh
# 运行完整测试套件
bun test

# 运行 TypeScript 类型检查
bun run test:typecheck

# 运行代码规范检查（Linter）
bun run lint

# 打包 Node 发行文件
bun run build

# 检查 Bun 与 Node 产出的文件内容是否完全一致
node scripts/compare-runtime.mjs

# 检查文档链接、锚点与多余的版本号
bun run check:docs
```

---

## 开源许可

[MIT](https://github.com/smile-minecraft/mc-asset/blob/main/LICENSE) © 2026 Smile Minecraft Project
