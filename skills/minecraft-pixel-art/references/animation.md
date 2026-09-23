# Animated textures

## Format (Java Edition)

- Frames are stacked **vertically** in one PNG: a 16×16 texture with 4 frames
  is a 16×64 strip, frame 0 at the top.
- A sibling `<name>.png.mcmeta` turns the strip on:

```json
{ "animation": { "frametime": 2, "interpolate": false, "frames": [0, 1, 2, 3, 2, 1] } }
```

- `frametime` is in game ticks (20 ticks = 1 second) per frame, default 1.
- `frames` (optional) reorders or repeats frames, and an entry can be
  `{ "index": 2, "time": 10 }` to hold one frame longer.
- `interpolate: true` blends between frames — useful for slow glows, wrong for
  anything with hard pixel motion.
- Bedrock uses `flipbook_texture.json` with `ticks_per_frame` instead; the
  artwork is the same vertical strip.

## Art guidance

- Every frame follows all the static rules: same palette, same light
  direction, tiles on its own (for blocks).
- Keep the palette identical across frames; animate by moving clusters, not by
  inventing new colors per frame.
- Loops must close: the last frame should lead naturally back into frame 0.
- Liquids and fire: move clusters a consistent number of pixels per frame
  (typically 1) in one direction; vanilla lava and water are long strips with
  many frames and a short `frametime`.
- Glows and pulses: grow or shift a highlight cluster over 3–6 frames and
  reverse with the `frames` list rather than drawing the way back.
- Check the loop at game speed; a strip that looks fine as stills can flicker
  when played.
