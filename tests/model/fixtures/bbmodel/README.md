# Blockbench fixture provenance

Two projects live here and are not interchangeable:

- `seed_analyzer_journal.bbmodel` is a real save written by the Blockbench
  application.
- `synthetic.bbmodel` is a synthetic project written by `make-fixture.ts` from
  the format source; no Blockbench application wrote it.

## `seed_analyzer_journal.bbmodel` (real application save)

- Source repository: `AgriCraft/AgriCraft`.
- Commit: `e2779f836bf47fd44bf5fd2aa7b1c9cd3bdccd95`.
- Path in that commit: `modelling/blockbench/seed_analyzer_journal.bbmodel`.
- Downloaded verbatim from
  `https://raw.githubusercontent.com/AgriCraft/AgriCraft/e2779f836bf47fd44bf5fd2aa7b1c9cd3bdccd95/modelling/blockbench/seed_analyzer_journal.bbmodel`
  and copied without edits (SHA-256
  `57487e67bd0c17353bce548163f924e9f1354e31aa184eda5f771f4e14acf8be`).
- License: MIT, Copyright (c) 2014 InfinityRaider (full text below).
- Saved by Blockbench: `meta.format_version` is `3.6`, `meta.creation_time`
  is `1612534281` (2021-02-05T15:31:21Z), `meta.model_format` is
  `java_block`, and `meta.box_uv` is `false`.
- Contents: resolution 16×16, one `book` cube rotated 22.5° around Y with
  `origin` `[19, 12, 14]` and per-face UVs, plus one embedded 16×16 PNG
  (`texture.id` `"4"`, sprite
  `agricraft:block/seed_analyzer_pane`).
- Role in tests: the import acceptance case. The test imports this project,
  validates the generated model with no error, compares the written PNG with
  the embedded base64 texture byte for byte, and checks that the rotation,
  face UVs, face rotation, and display transforms survive.

## `synthetic.bbmodel` (synthetic case)

- Written by `make-fixture.ts`, not by Blockbench.
- The field list follows JannisX11/blockbench `master` at commit
  `ec0b2827104d0799c153bfb5f867579c0c44652f` (`js/formats/bbmodel.js`,
  `js/formats/java/java_block.ts`, `js/outliner/types/cube.js`,
  `js/outliner/abstract/face.ts`, `js/texturing/textures.js`).
- It covers what the real save does not: a 48×32 resolution with
  `texture_size`, a second unrotated cube, and a `gui` display transform.
- Regenerate it from the repository root; the writer is deterministic, so
  regeneration must produce byte-identical output:

  ```sh
  bun tests/model/fixtures/bbmodel/make-fixture.ts
  ```

## MIT license of `seed_analyzer_journal.bbmodel`

The MIT License (MIT)

Copyright (c) 2014 InfinityRaider

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
