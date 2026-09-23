---
name: mc-asset
description: Author, render, inspect, and validate Minecraft Java Edition resource-pack textures with the mc-asset CLI or its MCP server — text-grid sprites (.grid), editable multi-layer sources (.mcpx), procedural block textures, material recolors and variants, tiling checks, animation strips, nine-slice GUI scaling, and whole-pack validation. Use when you need to produce or edit a pixel texture as text, check a texture or resource pack, or batch-edit pixels without a paint program. For how the art should look, also load the minecraft-pixel-art skill.
---

# mc-asset

mc-asset turns texture work into text and commands. You write a sprite as a
character grid, render it to PNG, look at an upscaled preview, measure it, and
iterate. The same inputs always produce the same bytes. Every command exists
both as a CLI subcommand and as an MCP tool (`mc-asset mcp`); this skill shows
the CLI form, and `references/commands.md` maps each one to its MCP tool.

**Art direction lives in the `minecraft-pixel-art` skill.** Load it before you
draw anything that should look like Minecraft; this skill only covers the tool.

## Getting the tool

```sh
npx -y mc-asset --version        # run without installing
npm install -g mc-asset          # or install the CLI
```

Node.js 22 or newer. In a checkout of the mc-asset repository, use
`node bin/mc-asset.js` after `bun run build`.

## The drawing loop

1. **Write the grid.** One character per pixel; the palette maps symbols to
   colors and, optionally, roles. `references/grid-format.md` has the rules.

   ```text
   [palette]
   . = transparent
   O = #3A2418FF role=outline
   D = #6B452CFF role=shadow
   B = #8F5C2AFF role=base
   L = #C08A4EFF role=highlight

   [grid]
   ....
   .OO.
   OLBO
   ODDO
   ```

2. **Render** to a PNG and keep the editable source:

   ```sh
   mc-asset render item.grid --output item.png --source item.mcpx
   ```

3. **Look at it.** Upscale with nearest neighbour and view the image (a 16px
   sprite is unreadable at 1×):

   ```sh
   mc-asset preview item.png --scale 12 --output item-x12.png
   ```

   Over MCP, `inspect_asset` with `mode: "view"` and `scale` returns the image
   directly, and `apply_asset_operations` with `feedback` returns a picture of
   each edit.

4. **Measure it.**

   ```sh
   mc-asset analyze item.png                         # size, color count, alpha, dominant colors
   mc-asset --json palette inspect item.png          # full color distribution
   mc-asset --json cleanup item.png --output tmp.png # detected: isolated / noise / aa counts
   mc-asset preview item.png --ascii                 # the PNG back as a .grid
   ```

5. **Review** against the minecraft-pixel-art checklist, edit the grid, and
   render again. Keep going until the checklist passes at 1× and at ×8.

6. **Validate** for its destination:

   ```sh
   mc-asset validate item.png --profile minecraft:item
   ```

## Common tasks

| Task | Command |
| --- | --- |
| Reference image → pixel art | `pixelize ref.png --size 16 --preset item --output out.png` |
| Procedural block texture | `generate noise --size 16 --palette stone --seed 42 --output stone.png` |
| Tiling check / wall preview | `tile stone.png`, then `tile stone.png --preview 4x4 --output wall.png` |
| One material recolor | `recolor sword.mcpx --material gold --output sword_gold.png` |
| All material variants | `variant sword.mcpx --materials iron,gold,copper --output-dir out --mkdir` |
| Reduce colors | `quantize in.png --colors 8 --output out.png` |
| Fix stray pixels | `cleanup in.png --fix isolated,noise --allow-render-pass-change --output out.png` |
| Pixel edits in a batch | `build src.mcpx --operations ops.json --output out.png` |
| Flip / rotate / crop / pad | `transform in.png --flip h --output out.png` |
| Animation strip | `animate pack --frames-dir frames --layout vertical --output anim.png` |
| Contact sheet of sprites | `animate pack --frames-dir sprites --layout horizontal --output sheet.png` |
| Nine-slice GUI scaling | `gui-scale panel.png --mcmeta panel.png.mcmeta --size 48x32 --output big.png` |
| Whole resource pack | `validate-pack ./MyPack --minecraft-version 26.3` |

`references/commands.md` explains each one, its MCP twin, and the gotchas.

## Rules the tool enforces

- **Explicit outputs.** Every write needs `--output`, `--source`, or `--stdout`;
  existing files need `--force`; missing folders need `--mkdir`. MCP tools
  never overwrite and never create folders.
- **Deterministic.** Procedural commands take a `--seed`; the same seed gives
  the same bytes.
- **Machine-readable.** `--json` puts a `{ success, result, error }` envelope
  on stdout. Exit codes: 0 ok, 2 bad invocation, 3 validation failed,
  4 filesystem refusal, 5 unsupported or over a limit.

## Recolor and variants: plan the roles

`recolor` and `variant` map colors into a target material by **role**, or by
luminance when a color has no role:

- `shadow` and `dark` → the material's shadow color;
- `base` → its base color;
- `light` and `highlight` → its highlight color;
- `outline`, `accent`, and `custom` stay exactly as drawn.

So a recolored ramp collapses to three tones plus whatever you keep. To make a
sprite that survives recoloring and still looks right:

- tag the material's lit-edge outline and deep shades `shadow`/`dark`, its
  midtones `base`, and its lights `highlight`;
- tag the darkest outline `outline` and pick a near-neutral dark that suits
  every target material;
- tag a white specular `accent` so it stays white;
- tag parts that must not change (a wooden grip, a gem inlay) `custom`.

## Gotchas

- `preview --scale` and `transform --resize-mode nearest` are the only upscales
  to use for pixel art; other resize modes blend colors.
- `animate pack` reads only the `.mcpx` files in a folder, in file-name order,
  and warns about anything else. Prefix names (`1-sword.mcpx`) to fix the
  order. All frames must share one size.
- `tile --preview` accepts `2x2`, `4x4`, or `8x8`.
- `.grid` symbols are single characters from `[.0-9A-Za-z]`; `.` is always
  transparent. Past 63 colors, switch to `[grid tokens]`.
- A shell variable holding a command with spaces (`M="node bin/mc-asset.js"`)
  does not word-split in zsh; use a shell function instead.
- `gui-scale` never reads a sibling `.mcmeta` by itself; pass `--mcmeta`.
