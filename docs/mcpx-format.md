# .mcpx & .grid Format Specification

[English](mcpx-format.md) | [繁體中文](mcpx-format.zh-TW.md) | [简体中文](mcpx-format.zh-CN.md)

This document defines the grammar, sections, and constraints of the two text formats `mc-asset` reads: `.mcpx` (the editable multi-layer pixel canvas) and `.grid` (the lightweight single-layer draft). The parser lives in `src/mcpx/`; the `.grid` reader lives in `src/cli/grid.ts` and reuses the same pipeline.

## Contents

- [1. The Two Formats](#1-the-two-formats)
- [2. File-Level Rules](#2-file-level-rules)
- [3. `.mcpx` Document Structure](#3-mcpx-document-structure)
- [4. Section Specifications](#4-section-specifications)
- [5. The Lightweight `.grid` Format](#5-the-lightweight-grid-format)
- [6. Full Example](#6-full-example)
- [7. Error Codes](#7-error-codes)
- [Related Documents](#related-documents)

---

## 1. The Two Formats

- **`.grid`**: a palette and one character grid, nothing else. Start here when drafting by hand or asking a model for a sprite.
- **`.mcpx`**: the full versioned format (`mcpx 1`) for a `PixelCanvas`: multiple layers with visibility and opacity, named region masks, metadata, and palette roles. Switch to it once you need a second layer, a region, or metadata; `render --source` converts a `.grid` for you.

Parsing is deterministic: the same text always yields the same canvas and the same PNG bytes. Writing is canonical: `build --source` (and every command that emits `.mcpx`) serializes a canvas to byte-stable text with a fixed section order, uppercase `#RRGGBBAA` colors, and three-decimal opacities.

---

## 2. File-Level Rules

Every `.mcpx` and `.grid` file follows these lexical rules:

- **Encoding**: UTF-8 without a byte order mark. A leading BOM is `MCPX_SYNTAX_ERROR`.
- **Line endings**: LF (`\n`) only. Any carriage return (`\r`) is `MCPX_SYNTAX_ERROR`.
- **Comments**: a line whose first non-blank character is `;` is a comment. Comments are whole-line only — a `;` after a section header or a value is not a comment and makes the line invalid. Comments are also rejected inside `[grid]` / `[mask]` data.
- **Blank lines**: ignored between sections and entries. Inside grid or mask data, the first blank line after the rows ends the block; rows must form one contiguous block.
- **Trailing whitespace**: trailing spaces and tabs are stripped from every line before parsing, so they never shift grid widths.

---

## 3. `.mcpx` Document Structure

A `.mcpx` document starts with a version header and then lists its sections in canonical order:

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

### 3.1 Header

The first line that is neither blank nor a comment must be:

```text
mcpx 1
```

A missing header or a non-integer version is `MCPX_SYNTAX_ERROR`. An integer version other than `1` is `MCPX_UNSUPPORTED_VERSION`.

### 3.2 Canonical Section Order

1. `[canvas]` — required, first, exactly once.
2. `[metadata]` — optional, at most once, directly after `[canvas]`.
3. `[palette]` — optional in the grammar, at most once, after `[canvas]` / `[metadata]`. Every grid symbol must be defined here, so any layer needs it in practice.
4. `[layer <id>]` — zero or more (at most 64). Each layer lists its attributes and then exactly one `[grid]` or `[grid tokens]` section.
5. `[region <id>]` — zero or more (at most 256), all after the last layer. Each region lists its attributes and then exactly one `[mask]` section.

Out-of-order sections, unknown sections, and a layer or region without its `[grid]` / `[mask]` are `MCPX_SYNTAX_ERROR`. Exceeding the layer or region count (or the 512 MB memory budget) is `RESOURCE_LIMIT_EXCEEDED`.

---

## 4. Section Specifications

Every section holds `key = value` lines. Keys match `^[a-z][a-z0-9_]*$`; a duplicate or unknown key is `MCPX_SCHEMA_ERROR`. v1 has no quoting, so no value may contain whitespace.

### 4.1 `[canvas]`

```text
[canvas]
width = 16
height = 16
```

- `width` and `height` are required and are the only keys.
- Each is a decimal integer without sign or leading zeros, from `1` to `4096`. Canvases past 512 on either edge stay valid, but the serializer warns (`MCPX_LARGE_CANVAS`) because diffs get heavy.

### 4.2 `[metadata]` (optional)

Free-form key-value pairs carried with the asset.

```text
[metadata]
author = Steve
profile = minecraft:item
```

- Values must not contain whitespace. The serializer writes keys in sorted order.

### 4.3 `[palette]`

Maps symbols to 32-bit RGBA colors.

```text
[palette]
. = transparent
R = #E74C3CFF
D = #C0392BFF role=shadow
W = #FFFFFF
```

- **Entry format**: `<symbol> = <color>` with an optional ` role=<role>`.
- **Symbols**: any token without whitespace or `=` (for example `c01`, `gold_edge`). A one-character symbol must be one of `[.0-9A-Za-z]`. Duplicate symbols are `MCPX_SCHEMA_ERROR`.
- **Colors**: `transparent` (same as `#00000000`), `#RRGGBB` (alpha `FF`), or `#RRGGBBAA`. The serializer always writes uppercase `#RRGGBBAA`, so `transparent` comes back as `#00000000`.
- **Reserved transparent symbol**: `.` must map to `#00000000`, and `#00000000` must use `.`. Either violation is `MCPX_SCHEMA_ERROR`.
- **Roles** (optional): `outline`, `shadow`, `dark`, `base`, `light`, `highlight`, `accent`, `custom`. `role` is the only palette attribute v1 defines.

### 4.4 `[layer <id>]` and its grid

Layers composite bottom to top: the first layer in the file is the bottom of the stack, and each later layer is drawn over it.

- **Layer ID**: matches `^[A-Za-z0-9_.-]+$` (for example `base`, `shade`, `overlay.1`). A duplicate ID is `MCPX_SEMANTIC_ERROR`.
- **Attributes** (any order; the serializer writes `visible`, `opacity`, `name`):
  - `visible = true | false` — defaults to `true`.
  - `opacity = <decimal>` — from `0` to `1`, written as `0`, `0.<digits>`, `1`, or `1.0…` (no exponent, no leading `.`); defaults to `1`. The serializer prints exactly three decimals and refuses a value that needs more.
  - `name = <text>` — optional display name without whitespace.
  - Any other key, including `blendMode`, is `MCPX_SCHEMA_ERROR`: v1 text carries no blend mode.

After the attributes comes the layer's pixel data, in one of two forms.

#### Compact grid: `[grid]`

Each character is one symbol, so every symbol used must be a single character. A compact palette holds at most 63 colors (`.`, `0-9`, `A-Z`, `a-z`).

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

- Exactly `height` rows of exactly `width` characters, without separators.
- A wrong row length or row count is `INVALID_GRID_SIZE`; a symbol missing from `[palette]` is `MCPX_SEMANTIC_ERROR`.

#### Tokenized grid: `[grid tokens]`

Used when the palette has multi-character symbols or more than 63 colors (up to 4096).

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

- Tokens are separated by exactly one space; a double space is `MCPX_SYNTAX_ERROR`.
- Exactly `height` rows of exactly `width` tokens.
- The serializer writes `[grid]` when every palette symbol is one character and `[grid tokens]` otherwise. A canvas with more colors than the chosen form holds is `MCPX_PALETTE_OVERFLOW`; store it as PNG instead.

### 4.5 `[region <id>]` and its mask (optional)

Regions are named selection masks attached to the canvas, independent of layer pixels. Selection expressions reach them as `region:<id>`.

- **Region ID**: matches `^[A-Za-z0-9_.-]+$`. A duplicate ID is `MCPX_SEMANTIC_ERROR`.
- **Attributes**: `name = <text>` (optional, no whitespace) is the only key.
- **`[mask]`**: exactly `height` rows of exactly `width` cells; `.` is outside and `#` is inside.

```text
[region handle]
name = sword_grip

[mask]
....
.##.
.##.
....
```

- A wrong row length or row count is `INVALID_MASK_SIZE`; any cell other than `.` or `#` is `MCPX_SYNTAX_ERROR`.

---

## 5. The Lightweight `.grid` Format

A `.grid` file is a single-layer draft:

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

- No `mcpx 1` header and no `[canvas]`: the width comes from the first row and the height from the row count, and every row must match (`INVALID_GRID_SIZE`).
- Exactly one `[palette]` followed by exactly one `[grid]` or `[grid tokens]`; the file holds nothing else.
- The pixels land on a single layer named `base`. Metadata, extra layers, and regions belong in `.mcpx`.
- The palette and grid rules above apply unchanged, and errors report line numbers in the `.grid` file.
- Compile it with `mc-asset render <file.grid>` (`--output` for PNG, `--source` for the `.mcpx` source), or with the `render_pixel_asset` MCP tool (`gridPath` or `gridText`).

---

## 6. Full Example

A two-layer `.mcpx` with a region mask, in canonical form:

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

## 7. Error Codes

Every error carries `details.line` (1-based) and, where it applies, `details.section`.

| Error Code | Exit | Condition |
|---|---|---|
| `MCPX_SYNTAX_ERROR` | 2 | BOM or `\r`; missing header or non-integer version; missing `[canvas]`; unknown or out-of-order section; layer without `[grid]` or region without `[mask]`; key-value line without `=` or outside a section; comment or key-value line inside grid/mask data; tokenized row not separated by single spaces; mask cell other than `.` / `#`. |
| `MCPX_SCHEMA_ERROR` | 2 | Invalid, duplicate, or unknown key; malformed or out-of-range `width` / `height`; invalid color; `.` not transparent or transparent not `.`; unknown role or palette attribute; invalid `visible` / `opacity`; whitespace in a value or name; ID outside `[A-Za-z0-9_.-]`. |
| `MCPX_SEMANTIC_ERROR` | 2 | Duplicate layer or region ID; grid symbol missing from `[palette]`. |
| `INVALID_GRID_SIZE` | 2 | Grid row length differs from `width`, or row count differs from `height`. |
| `INVALID_MASK_SIZE` | 2 | Mask row length differs from `width`, or row count differs from `height`. |
| `MCPX_PALETTE_OVERFLOW` | 2 | Serializing a canvas with more colors than the grid form holds (63 compact, 4096 tokenized). |
| `MCPX_UNSUPPORTED_VERSION` | 5 | Header names an integer version other than `1`. |
| `RESOURCE_LIMIT_EXCEEDED` | 5 | More than 64 layers or 256 regions, or the canvas exceeds the 512 MB memory budget. |

---

## Related Documents

- [CLI Surface](cli-surface.md): the commands that read or write `.mcpx` and `.grid` (`render`, `build`, `import`, `transform`, `recolor`, `variant`, …).
- [MCP Guide](mcp-guide.md): `.mcpx` with `apply_asset_operations` and `build_asset`, and `.grid` drafting with `render_pixel_asset`.
- [MCP Surface](mcp-surface.md): the frozen MCP tool inputs and batch operation payloads.
