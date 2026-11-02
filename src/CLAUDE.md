# Front end (`src/`)

Four pages share this folder: the main window (`index.tsx` → `App.tsx`, SolidJS), the always-on-top bubble (`bubble.ts`, plain TS, no framework so it stays tiny), the full-screen reminder (`reminder.ts`, plain TS) and the short-lived overlay for the bubble's big moments (`fx.ts`, plain TS). They talk to Rust through Tauri `invoke` / events and to each other through Rust events and shared `localStorage`.

## Stack
SolidJS 1.9 (stores + signals), TypeScript, Vite; `@tauri-apps/api` v2 plus the dialog and autostart plugins. No CSS framework: one stylesheet per page (`styles.css`, `reminder.css`, inline `<style>` in `bubble.html`).

## How we do things here
- State: one Solid store `data` in `lib/store.ts`; change it only through the exported actions (they call `mutate`, which schedules the debounced atomic save). Never write to `data` directly from components.
- Pure logic (rollover, reminders, labels) lives in `lib/model.ts` with no Tauri imports, so `tests/` can run it in Node.
- Task spaces: `space()` is the current list (`null` = General, else the app's lower-cased .exe path); list UIs use `spaceTasks()` / `spaceRepeats()`, never `data.tasks` directly. Reminders and badge counts are global on purpose.
- UI-only state (open panel, staged attachments, pinned) lives in `ui/state.ts`; panels are `Sheet` kinds rendered by `ui/Sheets.tsx`.
- Theme: colours are CSS variables on `:root` (`--accent`, `--on-accent`, `--edge`, `--solid`, …) set by `lib/theme.ts`; dark mode overrides them under `:root[data-mode="dark"]`. Don't hard-code colours in components; text on the accent uses `var(--on-accent)`.
- Settings that every window needs (theme, sounds) go in `localStorage` (shared origin; other windows react to the `storage` event). Per-machine app settings go through Rust config commands.
- Icons are inline stroke SVGs in `ui/icons.tsx`; app icons come from `invoke("app_icon")`.
- Accessibility: real `<button>`/`<label>`, `aria-label` on icon buttons, focus-visible outlines.

## Gotchas
- `lib/store.ts` `flush()` must run before hiding the window (title-bar close does it); Rust also emits `flush` on quit.
- The bubble page receives `bubble-mini` events that can fire before it loads; treat its mode as unknown until the first one.
- Native `<input type="time">` shows the OS locale (AM/PM here); values are still 24-hour strings.
- Reminder/bubble pages can't rely on a user gesture for audio; WebView2 is started with `--autoplay-policy=no-user-gesture-required` (see `src-tauri/CLAUDE.md`).

## Owners
PISTA (@PISTAfff)
