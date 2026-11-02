# Front end (`src/`)

Six pages share this folder: the main window (`index.tsx` → `App.tsx`, SolidJS), the always-on-top bubble and the focused app's mini (`bubble.ts` in two windows, `bubble` and `mini`, plain TS, no framework so it stays tiny), the full-screen reminder (`reminder.ts`, plain TS), the short-lived overlay for the bubble's big moments (`fx.ts`, plain TS), the speech balloon over the bubble (`balloon.ts`, plain TS: the pinned task, or a peek at the bubble's list) and the bubble's right-click menu (`menu.ts`, plain TS). They talk to Rust through Tauri `invoke` / events and to each other through Rust events and shared `localStorage`.

## Stack
SolidJS 1.9 (stores + signals), TypeScript, Vite; `@tauri-apps/api` v2 plus the dialog and autostart plugins. No CSS framework: one stylesheet per page (`styles.css`, `reminder.css`, inline `<style>` in the small pages), plus `tokens.css` (colours, fonts) and `menu.css` (both menus) shared between pages.

## How we do things here
- State: one Solid store `data` in `lib/store.ts`; change it only through the exported actions (they call `mutate`, which schedules the debounced atomic save). Never write to `data` directly from components.
- Pure logic (rollover, reminders, labels) lives in `lib/model.ts` with no Tauri imports, so `tests/` can run it in Node.
- Task spaces: `space()` is the current list (`null` = General, else the app's lower-cased .exe path); list UIs use `spaceTasks()` / `spaceRepeats()`, never `data.tasks` directly. Reminders and badge counts are global on purpose.
- UI-only state (open panel, staged attachments, pinned) lives in `ui/state.ts`; panels are `Sheet` kinds that `ui/Sheets.tsx` picks between, one file per panel in `ui/sheets/` (each inside `sheets/Panel.tsx`).
- Theme: colours are CSS variables on `:root` (`--accent`, `--on-accent`, `--edge`, `--solid`, …) in `tokens.css` (with the fonts), set by `lib/theme.ts`; dark mode overrides them under `:root[data-mode="dark"]`. A small page that should look like the app links `tokens.css` and calls `followTheme()`; one that only takes the accent calls `followAccent()` (both in `lib/theme-colors.ts`, never its own copy). Don't hard-code colours in components; text on the accent uses `var(--on-accent)`.
- Settings that every window needs (theme, sounds) go in `localStorage` (shared origin; other windows react to the `storage` event). Per-machine app settings go through Rust config commands.
- Icons are inline stroke SVGs in `ui/icons.tsx`; app icons come from `invoke("app_icon")`.
- Right-click menus in the main window go through `openMenu()` in `ui/ContextMenu.tsx`. Its look is `menu.css`, shared with the bubble's `menu.html`; arrow keys and the bubble menu's item type are in `lib/menus.ts`. The web view's own menu is turned off on every page, except in text fields (copy and paste).
- Anything that differs by system (shortcut labels, "Start with Windows" vs "Open at login", Ctrl vs ⌘) goes through `lib/platform.ts`; never hard-code "Windows" or "Ctrl" in UI text.
- The main page owns the data: other pages send it events (`bubble-drop`, `balloon-ready`, `bubble-ready`) and it answers (`counts`, `balloon-data`).
- The bubble's menu is Quicky's own window, not a system menu (those can't take the theme): the bubble page builds the items and runs the one picked (`bubble_menu_open` → `bubble-menu-pick`); `menu.ts` only draws them.
- Accessibility: real `<button>`/`<label>`, `aria-label` on icon buttons, focus-visible outlines.

## Gotchas
- `lib/store.ts` `flush()` must run before hiding the window (title-bar close does it); Rust also emits `flush` on quit.
- `bubble.ts` tells the two apart by its window label (`mini` or `bubble`). The mini's app (its `space`) and lock come from `bubble_mode` at load and `bubble-mini` events after; an event can arrive before the page listens, so never rely on events alone.
- Commands the bubble pages call (open, lock, peek, menu, context) take the calling window in Rust; events back go to that window's label, never a hard-coded "bubble".
- `listen` from `@tauri-apps/api/event` hears events sent to *any* window. A page that shares its event names with another window (the bubble and the mini) listens with `getCurrentWindow().listen` instead.
- Native `<input type="time">` shows the OS locale (AM/PM here); values are still 24-hour strings.
- Reminder/bubble pages can't rely on a user gesture for audio; WebView2 is started with `--autoplay-policy=no-user-gesture-required` (see `src-tauri/CLAUDE.md`).
- The bubble window has `dragDropEnabled: false`, so its page gets the browser's own drop events (text, links and `File`s, no paths); the main window keeps Tauri's file drop (paths).
- Data folder paths use `\` on Windows and `/` elsewhere; build file URLs with `mediaUrl()`.

## Owners
PISTA (@PISTAfff)
