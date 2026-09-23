# Entity textures

Entity (mob) textures wrap a cube model through box UV mapping. The pixel rules
are the same as for items and blocks; what changes is how light is distributed
across the faces of each cube.

## Density and UV

- Keep one texel per model unit: a 16-unit cube face is 16×16 texels. Mixing
  densities (a 16-unit face with 32 texels) is a mixel.
- Cube sizes must be whole numbers so box UV does not round and stretch faces.
- Generate a texture template (Blockbench: create texture → Template) so every
  cube face has its own space, then paint over it.

## Shading across faces

- **Top and front faces are brighter than bottom and back faces.** This holds
  inside each face (lighter toward the top) and between faces (the whole top
  face is lighter than the side, the side lighter than the bottom).
- Paint base colors per cube first, then add one shadow and one highlight,
  then extend the palette, then define the material by moving clusters —
  the same order as items.
- Remove banding where faces meet: shade transitions should not line up
  exactly with face edges on every cube.

## Workflow

1. Template, base color per cube (fill tool in "cube" mode).
2. Sketch the color distribution and the top/front light.
3. Add shades; keep each material's ramp at 4–7 colors.
4. Check the model from several angles; hidden faces that animations reveal
   must be painted too.
