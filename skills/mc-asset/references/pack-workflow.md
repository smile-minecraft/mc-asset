# Resource Pack Authoring Workflow

Complete end-to-end guide for creating, building, checking, and packaging
Minecraft Java Edition resource packs with `mc-asset`.

---

## The 8-Step Pack Lifecycle

```text
1. Initialize ──> 2. Pick Style ──> 3. Catalog & Reference ──> 4. Author Recipes
                                                                     │
8. Package <── 7. Contact Sheet <── 6. Check & Audit <── 5. Build <──┘
```

---

## 1. Initialize the Project

Create the project configuration, pinned root metadata, placeholder icon, and
skeleton directories in one preflighted batch.

### CLI

```sh
mc-asset pack init ./AurelianPack \
  --namespace aurelian \
  --minecraft-version 1.21.9 \
  --style vanilla
```

### MCP

```json
{
  "mode": "init",
  "projectDir": "./AurelianPack",
  "namespace": "aurelian",
  "minecraftVersion": "1.21.9",
  "style": "vanilla"
}
```

### Success Outcome
- `AurelianPack/mc-asset.pack.json` created with project configuration.
- `AurelianPack/pack/pack.mcmeta` pinned with correct `pack_format` or `min_format`/`max_format`.
- `AurelianPack/pack/pack.png` generated 64×64 placeholder icon.
- Skeleton folders created: `recipes/`, `pack/assets/aurelian/textures/item`, `pack/assets/aurelian/textures/block`, `pack/assets/aurelian/models/item`, and `pack/assets/aurelian/items/` (format 46.0+).

### Common Errors & Recovery
- `PACK_INIT_CONFLICT` (exit 4): Target path or subdirectories already exist. Clean the directory or pick a new path.
- `INVALID_ARGUMENT` (exit 2): Namespace has illegal characters (must match `[a-z][a-z0-9_.-]{0,63}`) or unsupported release version.
- `PACK_PROJECT_INVALID` (exit 2): Using reserved `minecraft` namespace without `--allow-minecraft-namespace`.

---

## 2. Pick or Author a Style

A style defines 12 material palette families (`iron`, `gold`, `diamond`,
`netherite`, `copper`, `wood`, `stone`, `emerald`, `amethyst`, `redstone`,
`lapis`, `quartz`), lighting, outline rules, color limits, and animation presets.

### CLI

```sh
mc-asset style list                                # inspect builtin presets
mc-asset style show vanilla                        # inspect resolved rules
mc-asset style create --output ./AurelianPack/recipes/custom.style.json \
  --id custom-pack --extends vanilla \
  --overrides '{"limits":{"maxColors":12}}'
```

### Builtin Presets
1. `vanilla`: Jappa-style authentic palette ramps and outline contrast.
2. `soft`: Gentle lighting, pastel ramps, reduced dynamic range.
3. `fairy-flat`: Vibrant flat color bands with minimal dithering.
4. `dark-frame`: Heavy dark outlines and pronounced form shadows.

### Common Errors & Recovery
- `STYLE_NOT_FOUND` (exit 2): Non-existent builtin preset or invalid file path.
- `STYLE_INHERITANCE_CYCLE` (exit 2): Custom style file inherits from itself or forms a loop.
- `STYLE_INVALID` (exit 2): Unrecognized field or invalid `#RRGGBB` color format.

---

## 3. Catalog & Reference Vanilla Assets

Inspect vanilla texture dimensions, animation flags, categories, and mask
families without unpacking the entire vanilla jar manually.

### CLI

```sh
# Catalog an existing vanilla tree
mc-asset pack catalog --vanilla ./vanilla-assets --category item --include-families

# Or extract clean assets from a client jar directly
mc-asset pack extract --jar ~/.minecraft/versions/1.21.9/1.21.9.jar \
  --output-dir ./vanilla-assets --mkdir
```

### Success Outcome
- Reports all PNG textures, widths, heights, animation status (`.mcmeta` sidecar or vertical ratio), and mask family keys.
- Extraction copies only `assets/` entries; dot-files, `..`, and absolute paths are automatically rejected.

### Common Errors & Recovery
- `PACK_CATALOG_INVALID` (exit 4): Provided path lacks an `assets/` subfolder.
- `PACK_ARCHIVE_INVALID` (exit 2): Corrupted client jar, encrypted entry, or path traversal detected.

---

## 4. Author Declarative Recipes

Recipes (`recipes/*.recipe.json`) describe batch transformations from character
grids or base assets into final textures, models, and item definitions.

> **Path Convention**: In every source declaration, `path` is resolved
> **relative to the recipe file itself** (conventionally inside `recipes/sources/`).
> For example, `recipes/tools.recipe.json` resolves `"path": "sources/sword.grid"`
> to `recipes/sources/sword.grid`.

### Important Step Rules

1. **Family Recolor Semantics (`type: "recolor", family: "..."`)**:
   - The six primary roles (`outline`, `shadow`, `dark`, `base`, `light`, `highlight`)
     map directly to the target family's ramp colors.
   - Silhouette outline pixels (touching transparency or canvas edge) are
     geometrically detected and forced to the family's `outline` color.
   - `accent` and `custom` are **not** preserved automatically: they are remapped
     across the six luminance bands (<43 outline, 43–85 shadow, 86–127 dark,
     128–170 base, 171–213 light, ≥214 highlight).
   - **Preserving non-metal parts**: To keep a wooden handle or gem inlay unchanged,
     you **must** specify `preserveRoles: ["custom"]` or use `preserveRegions` /
     `selection`.
2. **Tinted Outline Step (`type: "outline", mode: "tinted"`)**:
   - Derives outline colors from the adjacent interior body pixels in integer HSL.
   - When `family` is provided and `snapFamilies: true`, the derived color snaps
     to the closer of `outline` or `shadow` on the target family ramp.

### Example A: Tool Matrix (5 Tools × 7 Materials = 35 Textures)

Place in `recipes/tools.recipe.json`:

```json
{
  "formatVersion": 1,
  "id": "tool-matrix",
  "style": "vanilla",
  "variables": {
    "tool": ["sword", "pickaxe", "axe", "shovel", "hoe"],
    "material": ["iron", "gold", "diamond", "netherite", "copper", "wood", "stone"]
  },
  "sources": {
    "sword_grid": { "kind": "grid", "path": "sources/sword.grid" },
    "pickaxe_grid": { "kind": "grid", "path": "sources/pickaxe.grid" },
    "axe_grid": { "kind": "grid", "path": "sources/axe.grid" },
    "shovel_grid": { "kind": "grid", "path": "sources/shovel.grid" },
    "hoe_grid": { "kind": "grid", "path": "sources/hoe.grid" }
  },
  "targets": [
    {
      "id": "{material}_{tool}",
      "category": "{tool}",
      "source": "{tool}_grid",
      "output": "assets/{namespace}/textures/item/{material}_{tool}.png",
      "steps": [
        { "type": "recolor", "family": "{material}" },
        { "type": "outline", "mode": "tinted", "position": "inside" }
      ]
    }
  ]
}
```

### Example B: Gem Shimmer Animation (Sweep Band + .mcmeta)

Place in `recipes/gems.recipe.json`:

```json
{
  "formatVersion": 1,
  "id": "gem-shimmer",
  "sources": {
    "gem_grid": { "kind": "grid", "path": "sources/gem.grid" }
  },
  "targets": [
    {
      "id": "ruby",
      "category": "item",
      "source": "gem_grid",
      "output": "assets/{namespace}/textures/item/ruby.png",
      "steps": [
        { "type": "recolor", "family": "redstone" },
        {
          "type": "sweep",
          "angle": 135,
          "width": 2,
          "frames": 8,
          "holdTicks": 40,
          "frametime": 2,
          "mcmetaOutput": "assets/{namespace}/textures/item/ruby.png.mcmeta"
        }
      ]
    }
  ]
}
```

### Example C: Dual-Form Item (2D GUI Sprite + 3D In-Hand Model)

Place in `recipes/dual-sword.recipe.json`:

```json
{
  "formatVersion": 1,
  "id": "dual-sword",
  "sources": {
    "sword_grid": { "kind": "grid", "path": "sources/sword.grid" }
  },
  "targets": [
    {
      "id": "relic_sword",
      "category": "sword",
      "source": "sword_grid",
      "output": "assets/{namespace}/textures/item/relic_sword.png",
      "steps": [
        { "type": "recolor", "family": "amethyst" },
        { "type": "model", "parent": "handheld" },
        {
          "type": "model",
          "item": "relic_sword_3d",
          "modelSpec": {
            "ambientocclusion": false,
            "textures": { "layer0": "{namespace}:item/relic_sword" },
            "elements": [
              {
                "from": [0, 0, 6],
                "to": [16, 16, 10],
                "faces": { "north": { "uv": [0, 0, 16, 16], "texture": "#layer0" } }
              }
            ]
          }
        },
        {
          "type": "itemDefinition",
          "model": "{namespace}:item/relic_sword",
          "definition": {
            "type": "select",
            "property": "minecraft:display_context",
            "cases": [
              { "when": ["gui", "fixed"], "model": "{namespace}:item/relic_sword" },
              { "when": ["ground", "thirdperson_righthand", "thirdperson_lefthand"], "model": "{namespace}:item/relic_sword_3d" }
            ],
            "fallback": "{namespace}:item/relic_sword"
          }
        }
      ]
    }
  ]
}
```

### Common Errors & Recovery
- `RECIPE_INVALID` (exit 2): A variable was declared but unused, a placeholder `{xyz}` is undefined, or `minecraft` namespace is used without `override: true`.
- `RECIPE_OUTPUT_CONFLICT` (exit 2): Multiple targets expand to the exact same output path. Ensure variable axes or target ids disambiguate files.
- `RECIPE_SOURCE_MISSING` (exit 4): A source grid or texture path does not exist.

---

## 5. Build the Pack

Build executes in three safe stages:
1. **Parse & Plan**: Memory-only validation of all inputs, variable expansion, and model graphs.
2. **Classify**: Checks each output against `mc-asset.lock.json` and disk state (`new`, `own-clean`, `own-modified`, `foreign`). If any output is user-modified or foreign, execution stops before writing.
3. **Write**: Preflights targets (rejecting collisions and symlinks), executes atomic writes, and updates `mc-asset.lock.json`.

### CLI

```sh
# Dry run first to verify planned outputs
mc-asset pack build --project ./AurelianPack/mc-asset.pack.json --dry-run

# Execute full atomic build
mc-asset pack build --project ./AurelianPack/mc-asset.pack.json
```

### Common Errors & Recovery
- `PACK_BUILD_CONFLICT` (exit 4): An output file on disk was modified or untracked. Remove or back up conflicting files, or revert edits to lockfile-tracked state.
- `PACK_BROKEN_REFERENCE` (exit 3): An `itemDefinition` references a model that does not exist in the project, the plan, or the vanilla tree.
- `RECIPE_VERSION_UNSUPPORTED` (exit 2): Item definitions (`items/*.json`) used on a pack format below 46.0.

---

## 6. Check & Audit Quality

Verify whole-pack integrity and ensure textures adhere to palette and silhouette
consistency rules.

### Whole-Pack Health Check

```sh
mc-asset pack check --project ./AurelianPack/mc-asset.pack.json
```
Produces an ordered fix list:
1. `error` level issues first (missing models, broken JSON).
2. Ranked by descending failure count.
3. Sorted by code unit name.

### Family Silhouette & Palette Audit

```sh
mc-asset style audit ./AurelianPack/pack/assets/aurelian/textures/item/*_sword.png
```
- Checks that all swords share the exact same dimensions (`STYLE_FAMILY_SIZE_DRIFT`).
- Verifies mask overlap is at least 800‰ (`STYLE_FAMILY_SILHOUETTE_DRIFT`).
- Verifies common palette overlap is at least 500‰ (`STYLE_FAMILY_PALETTE_DRIFT`).

### Style Compliance Tips

- **High Contrast & Dynamic Range**: Styles like `vanilla` require dynamic range ≥ 450‰ (`STYLE_DYNAMIC_RANGE`). Darker material ramps (such as netherite, stone, or dark wood) must include a pure white (`#FFFFFF`) or near-white specular highlight plus a light buffer pixel to meet the dynamic range and highlight ratio thresholds.
- **Cool Family × Warm Wood Handle Strategy**: When pairing cool-colored heads (diamond, amethyst, iron) with a warm wooden handle (brown), keep handle colors near the outline below 38 saturation in integer HSL: pixels with saturation < 38 are excluded from hue drift metrics, preventing false `STYLE_OUTLINE_TINT` warnings.

---

## 7. Generate Overview Contact Sheets

Inspect all authored sprites at a glance.

```sh
mc-asset preview contact-sheet \
  --inputs ./AurelianPack/pack/assets/aurelian/textures/item/*.png \
  --columns 8 \
  --background dark \
  --output ./AurelianPack/overview-{page}.png
```
- Uses built-in 5×7 pixel font to display clean label bands below each image.
- Automatically paginates when the grid exceeds 1024×1024, writing `overview-1.png`, `overview-2.png`, etc.
- Set `--pair-mode sequential` to compare base vs variant sprites side-by-side.

---

## 8. Package for Delivery

Produce a clean, deterministic, byte-reproducible zip file ready to drop into
Minecraft's `resourcepacks/` directory.

### CLI

```sh
mc-asset pack package \
  --project ./AurelianPack/mc-asset.pack.json \
  --output ./AurelianPack.zip --force
```

### Invariants Guaranteed
- **Root is `pack.mcmeta`**: Never nests an extra parent directory.
- **Zero Artifact Leaks**: `.DS_Store`, `Thumbs.db`, `.git`, `__MACOSX`, `mc-asset.pack.json`, `mc-asset.lock.json`, and `recipes/` are strictly excluded.
- **Byte Reproducibility**: Files are sorted by UTF-8 byte order and written with fixed DOS timestamps (0x0021, 0x0000) using Deflate level 6. Packaging the same directory twice produces bit-identical zip files across Bun and Node.
