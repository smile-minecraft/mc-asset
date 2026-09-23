# `.grid` and `.mcpx` in brief

The full specification is `docs/mcpx-format.md` in the mc-asset repository.
This is what you need to author sprites.

## `.grid` — a single-layer draft

```text
; Comments are whole lines starting with ';'
[palette]
. = transparent
O = #2A1A0EFF role=outline
S = #5E3A1CFF role=shadow
B = #8F5C2AFF role=base
H = #D0A266FF role=highlight
W = #FFFFFFFF role=accent

[grid]
................
......OOOO......
.....OHHBBO.....
```

- Exactly one `[palette]` then exactly one `[grid]` (or `[grid tokens]`).
- Width comes from the first row, height from the row count; every row must
  be the same length (`INVALID_GRID_SIZE` otherwise).
- UTF-8 without BOM, LF line endings only, trailing whitespace ignored.
- Comments are whole lines starting with `;`; not allowed inside grid data.

## Palette entries

`<symbol> = <color>` with an optional ` role=<role>`.

- **Symbol:** in a compact `[grid]`, one character from `.`, `0-9`, `A-Z`,
  `a-z` — at most 63 colors. `.` must be transparent, and transparent must be
  `.`.
- **Color:** `transparent`, `#RRGGBB` (alpha FF), or `#RRGGBBAA`.
- **Role:** `outline`, `shadow`, `dark`, `base`, `light`, `highlight`,
  `accent`, or `custom`. Roles drive `recolor` / `variant`:
  shadow+dark → shadow, base → base, light+highlight → highlight, and
  outline / accent / custom are kept.
- Roles are looked up by color: if two symbols share one color, the first
  entry's role applies to both. Give each role its own color.

## Tokenized grids

For more than 63 colors or multi-character symbols, use `[grid tokens]`:
symbols separated by exactly one space.

```text
[palette]
. = transparent
c01 = #5A6068FF
c02 = #9AA1A9FF

[grid tokens]
. c01 c01 .
c01 c02 c02 c01
```

## `.mcpx` — the full editable source

`render --source out.mcpx` converts a `.grid` for you. Reach for `.mcpx` when
you need more than one layer, named regions (selection masks such as
`region:blade`), or metadata. Layers composite bottom to top and carry
`visible` and `opacity`; regions are `[mask]` blocks of `.` and `#`.

## Drafting tips

- Keep symbols mnemonic per material and role (`O` outline, `S` shadow, `B`
  base, `H` highlight, lowercase for a second material).
- Draw on a 16-row block and count columns: a ruler comment line
  (`; 0123456789abcdef`) above the grid helps.
- After rendering, `preview --ascii` prints the PNG back as a grid, which is
  the fastest way to check what actually landed.
