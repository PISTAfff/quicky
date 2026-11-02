# Quicky brand kit

Logo, mascot, colours, type, app screenshots and portfolio images for Quicky. Everything here is built from what the app already ships: the blob from `bubble.html`, the colours in `src/styles.css`, and the Fredoka / Nunito fonts. Nothing in this folder is bundled into the app.

## Logo (`logo/`)
| File | Use it for |
|---|---|
| `quicky-mark.svg` | The main mark: grape blob, ink outline, hard ink shadow. Works on light and dark grounds. |
| `quicky-lockup-horizontal.svg` / `-dark.svg` | Mark + wordmark side by side (headers, banners). Use `-dark` on dark grounds. |
| `quicky-lockup-stacked.svg` / `-dark.svg` | Mark above the wordmark (square spaces, avatars, splash). |
| `quicky-wordmark.svg` / `-white.svg` | "Quicky" alone, Fredoka Bold converted to outlines (no font needed). |
| `quicky-mark-mono-ink.svg` / `-mono-white.svg` | One-colour mark with the face cut out (stamps, single-colour print, on photos). |
| `quicky-mark-small.svg` | 16–32 px (favicons, tiny UI): no outline or shadow, same as the app's title bar. |
| `quicky-app-icon.svg` | The app icon: the blob on its own (copy of `src-tauri/icons/source.svg`). The taskbar and tray icons are tinted to the user's accent at runtime. |

Rules:
- Keep clear space of at least half the blob's height around the mark or lockup.
- Below 32 px, use `quicky-mark-small.svg`; the outline and shadow clog at that size.
- On dark grounds, keep the dark outline (`#0C0A12`). Never swap it for a white outline.
- Don't stretch, re-colour the blob outside the accent palette, or re-type the wordmark in another font.

## Mascot (`mascot/`)
`quicky-happy.svg` (resting, always smiling), `quicky-clear.svg` (nothing left today), `quicky-angry.svg` (tugged while locked in place). Faces are the exact paths the bubble uses.

## Colour
| Name | Hex | Role |
|---|---|---|
| Grape | `#6D4CFF` | Accent, the blob |
| Ink | `#2B2540` | Text, outlines, hard shadows |
| Mochi | `#F4F1FF` | Background |
| Peach / Warm | `#FFD9C8` / `#7A3410` | Carried over, reminders |
| Blue / Doing | `#D3DDFF` / `#3D5BD9` | Doing |
| Mint / Done | `#7FE0B9` (column `#E3F7EE`) / `#1F8F6A` | Done |
| Night / Night card | `#17151F` / `#231F2D` | Dark mode background and cards (outline `#0C0A12`) |

Accent options in the app: Grape `#6D4CFF`, Bubblegum `#D6336C`, Mint `#1F8F6A`, Tangerine `#C2561A`, Ocean `#2F6FDB`, or any custom colour.

## Type
- Display: **Fredoka** 600–700 (titles, the date, the wordmark).
- Text: **Nunito** 600–800 (everything else).
Both are free on Google Fonts.

## Shape
Cards are white with a 2 px ink outline, 14 px corners and a hard `3px 3px 0` ink shadow, sitting at slight random tilts. Status is shown with the pastel pairs above, never with colour alone.

## Exports
- `png/`: every logo and mascot SVG as transparent PNG (the number in the name is the width in px).
- `screens/`: app screenshots at 2x with sample tasks (board and list, light and dark, and the reminder).
- `portfolio/`: case-study images at 3200 × 2400 (`01`–`06`), a 1200 × 630 link preview (Open Graph) and a 1280 × 640 GitHub social preview.

