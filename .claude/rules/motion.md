---
paths:
  - "bubble.html"
  - "reminder.html"
  - "src/bubble.ts"
  - "src/reminder.ts"
  - "src/reminder.css"
  - "src/styles.css"
  - "src/ui/LiveWave.tsx"
  - "src/lib/sfx.ts"
  - "fx.html"
  - "src/fx.ts"
---

# Motion, physics and sound rules
- Quicky's personality is "squishy, bouncy, never stiff": overshoot easings like `cubic-bezier(0.2, 0.9, 0.3, 1.3–1.5)`, 150–350 ms for UI, ~0.5–1 s for the bubble's big moments (appear, divide, reminder flood).
- Every animation has a `prefers-reduced-motion: reduce` escape (the stylesheets already end with one; keep new animations inside its reach).
- The locked-bubble jelly is a spring sim in `src/bubble.ts` (`STIFF`, `DAMP`, `MAX_PULL`, `outline()`); tune constants, don't swap it for CSS keyframes. Keep any deformation inside the bubble window (104 px normal, 64 px mini) or it clips.
- Classes that replay an animation must be removed on `animationend` (see `replay()` in `src/bubble.ts`); a leftover `appear` class once made the bubble fade out after a tug.
- The bubble's face reads its mood from `--anger` (0 calm/smiling → 1 furious); always return it to 0 when an interaction ends (`calm()`), including when Rust ends a drag (`bubble-calm`).
- Sounds are synthesized in `src/lib/sfx.ts` (oscillators + envelopes, no files); add new ones there, keep them under ~0.4 s, and respect `readSfx()` (on/off + volume). Throttle anything fired per frame (see `sfx.squish`).
- Squash and pop strength come from Rust (`wall-push`, `bubble-pop` events); the page only visualizes them.
- Moments that need room (dividing into a new mini, popping or hiding one) play in the `fx` overlay, not the bubble window: its first and last frames must match the bubble exactly (same paths and sizes as `bubble.html`), the main beat stays near 1 s (the twin's trip home may run to about 1.4 s), and reduced motion skips straight to the handoff.
