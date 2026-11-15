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

## Box UV and mirrored parts

For a box of width `w`, height `h`, and depth `d`, the UV footprint is
`2 * (w + d)` by `d + h`. The top row contains top and bottom; the row below
contains right, front, left, and back. Faces carry oriented UV corners, so use
`entity inspect` or a generated template rather than assuming each face reads
left to right. A mirrored part flips each face horizontally and swaps the right
and left cells. Some limbs share mirrored cells; the wide and slim player
layouts instead give left limbs their own regions.

The player layouts distinguish `base` and `overlay` parts. Paint the base
first and keep unused overlay pixels transparent; the overlay is a separate
surface outside the base. The editable `.mcpx` template has a single `template`
layer and named `<part>.<face>` regions, not separate authoring layers for base
and overlay. Add layers as needed when painting.

## Armor and equipment

`equipment` produces definitions and face-colored templates for `humanoid`,
`humanoid_leggings`, and `wings`. These templates are 64×32. The humanoid sheet
includes a head, hat overlay, body, arm and leg; leggings use the body and leg
regions. Left limbs share mirrored right-limb cells. Other equipment layer types
may have definitions but do not have generated templates. Choose the target
pack format so the tool writes the definition in the appropriate directory.

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
4. Run `entity preview` on the painted texture and its layout. Its four
   isometric panels show front, back, sides and top; inspect the bottom face
   separately. The image is a diagnostic preview with unapplied rendering steps.
5. Run `entity validate` with the same layout. A size mismatch is an error;
   non-transparent pixels outside all mapped faces produce a warning. A pass
   does not check artistic quality or whether every face was painted.
6. For armor, generate the equipment templates and paint each sheet using its
   own face regions. Inspect shared mirrored cells on both limbs. Review hidden
   faces that animation may reveal, and check the result in the game.
