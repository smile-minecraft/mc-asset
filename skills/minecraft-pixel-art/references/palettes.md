# Palettes and color ramps

## Vocabulary

- **Hue**: the color family, 0–360°. **Saturation**: how strong the hue is.
  **Value**: brightness.
- **Ramp**: all shades of one material, ordered dark to light.
- **Palette**: every ramp used by one texture.
- **Shifting**: changing hue, saturation, or value from one shade to the next.
  The steps between shades should be balanced.
- **Straight ramp**: only value changes. Easy and often dull; right for neutral
  materials such as iron and stone.

## Building a ramp

1. Start from the **midtone** — the color the object "is".
2. Add **one shadow and one highlight** and shade the texture with just those
   three. Only then add more shades.
3. Extend to 4–7 shades for a material in an item, about 7 for a block.
4. Shift hue along the ramp for anything that is not a neutral metal or stone:
   darks lean toward red / brown / purple, lights lean toward yellow (warm
   materials) or toward cyan / white (cool materials and gems).
5. Saturation peaks in the midtones and drops toward both ends; never combine
   maximum saturation with maximum brightness (it burns). Brightness steps get
   smaller toward the light end.
6. Check neighbours: every step should be clearly visible at 1×. Two colors
   that look the same at 1× are one color — merge them.

Slynyrd's reference numbers for a general-purpose ramp: about +20° of hue per
step, saturation highest in the middle and never 0 or 100, brightness rising
every step and never starting at 0 unless you want black. Minecraft ramps are
shorter (4–7 shades) and use gentler hue shifts, but the shape is the same.

## Measured vanilla ramps

Use these as calibration for contrast, saturation, and hue drift — not as
colors to copy wholesale.

| Material | Dark → light |
| --- | --- |
| Iron (sword) | `#181818` `#444444` `#6B6B6B` `#969696` `#BEBEBE` `#D8D8D8` `#FFFFFF` (straight gray) |
| Stick / oak handle | `#281E0B` `#493615` `#684E1E` `#896727` |
| Apple red | `#54090E` `#9C1017` `#B4131E` `#DD1725` `#FF1C2B` `#FF5E69` `#FF969D` |
| Diamond | `#145E53` `#11727A` `#1C919A` `#1AAAA7` `#20C5B5` `#2CE0D8` `#4AEDD9` `#A1FBE8` `#D5FFF6` `#FFFFFF` |
| Bread crust | `#3F2E0E` `#4C3811` `#574114` `#654B17` `#8C661E` `#A27924` `#BC8927` |
| Cobblestone | `#525252` `#616161` `#6E6D6D` `#888788` `#A6A6A6` `#B5B5B5` |
| Oak planks | `#67502C` `#7E6237` `#967441` `#9F844D` `#AF8F55` `#B8945F` `#C29D62` |
| Stone bricks | `#5A595A` `#636363` `#6A6D6A` `#787678` `#7F7F7F` `#8B898B` `#9C999C` |

What the table shows:

- Item ramps span nearly the whole value range (near black to white); block
  ramps span a narrow band (cobblestone `#52` to `#B5`, stone bricks `#5A` to
  `#9C`).
- The apple's darkest red turns maroon and its highlight turns pink; the
  diamond's darks turn toward green-teal; wood darks turn toward deep brown.
  That is hue shifting at Minecraft scale.
- Metals keep their ramp neutral and add a pure-white specular.

## Materials cheat sheet

| Material | Ramp character | Specular |
| --- | --- | --- |
| Iron, stone | straight neutral gray | white (iron), none (stone) |
| Gold | darks toward orange-brown, lights toward pale yellow | pale yellow-white |
| Copper | darks toward red-brown, lights toward peach | warm white, sparse |
| Wood | darks deep brown (hue ~35–40°), lights tan; saturated midtones | none |
| Gems | saturated midtones, darks hue-shifted (cyan → teal, red → maroon) | large white |
| Glass | pale desaturated blue edge, mostly transparent | white glints |
| Organics (food, leaves) | saturated mids, hue-shifted darks, no neutral grays | small, soft |

## Palette discipline

- Share colors between ramps where you can (the darkest wood can double as a
  seam color); it unifies the texture and keeps the count down.
- Count colors after every pass. A texture that crept past the budget usually
  has near-duplicates to merge.
- Avoid pure black `#000000` in item and block art. The GUI is the exception:
  vanilla GUI outlines are pure black (see `gui.md`).
