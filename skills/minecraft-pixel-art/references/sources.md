# Sources

The rules in this skill are distilled from these references, plus direct
measurement of current vanilla textures (color counts, outline colors, ramps)
with `mc-asset analyze` and `mc-asset preview --ascii`.

## Minecraft style

- [Blockbench — Minecraft Style Guide](https://blockbench.net/wiki/guides/minecraft-style-guide/)
  — the primary rulebook: 16px logic, no mixels, ramps, shading artifacts,
  item / block / entity texture processes, top-left light.
- [Planet Minecraft — How to create a Java resource pack](https://www.planetminecraft.com/blog/how-to-create-a-texture-pack-4425239/)
  — the Jappa-style workflow: palettes of 5/7/9 colors, base fill with the 4th
  color, dark seams bottom and right, early tile checks, item borders darker
  on the bottom side.
- [Resource Pack Creator — Minecraft GUI textures](https://resourcepackcreator.com/guide/minecraft-gui-textures)
  — GUI sprite layout, sizes, nine-slice.
- [Microsoft Learn — Create an animated block texture](https://learn.microsoft.com/en-us/minecraft/creator/documents/createanimatedblocktexture)
  — flipbook strips and frame timing (Bedrock; the strip layout matches Java).
- [Microsoft Learn — Entity modeling and animation](https://learn.microsoft.com/en-us/minecraft/creator/documents/entitymodelingandanimation)
  and [Blockbench — Bedrock modeling](https://blockbench.net/wiki/guides/bedrock-modeling/)
  — box UV, templates; entity faces brighter on top and front.
- [Microsoft Learn — Minecraft Item Wizard](https://learn.microsoft.com/en-us/minecraft/creator/documents/minecraftitemwizard)
  — 2D icon versus 3D held model.
- [Microsoft Learn — PBR overview](https://learn.microsoft.com/en-us/minecraft/creator/documents/vibrantvisuals/pbroverview)
  — MERS maps for Vibrant Visuals; outside vanilla 16px style, but the base
  color texture still follows these rules.

## Pixel-art fundamentals

- [Pixel Joint — Pixel Art Tutorial](https://pixeljoint.com/forum/forum_posts.asp?TID=11299)
  — clusters, AA, jaggies, dithering, banding, pillow shading, noise,
  sel-out, palettes, hue shifting.
- [Lospec — Pixel art tutorials](https://lospec.com/pixel-art-tutorials)
  — searchable index by topic (shading, palettes, hue shifting, tiles,
  animation).
- [Slynyrd — Pixelblog 1: Color palettes](https://www.slynyrd.com/blog/2018/1/10/pixelblog-1-color-palettes)
  — ramp construction with hue, saturation, and brightness curves.
- [Saint11 (Pedro Medeiros) — Pixel art tutorials](https://saint11.art/blog/pixel-art-tutorials/)
  — illustrated guides to materials (metal, wood, rock, gems, water, fire),
  shading, outlines, and nine-slice UI.
