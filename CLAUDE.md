# Quicky

## What this is
A tiny Windows task manager: quick-add mini tasks (To do / Doing / Done), daily carry-over, repeats, reminders, media attachments, and an always-on-top "Quicky" bubble that can live inside other apps as per-app minis with their own task lists. Tauri 2 (Rust, WebView2) hosts three SolidJS/TS pages: the main window, the bubble, and a full-screen reminder.

## Map
- `src/` — front end: main window (SolidJS), bubble page and reminder page (plain TS). Has its own CLAUDE.md.
- `src-tauri/` — Rust backend: windows, bubble placement/physics driving, Win32 calls, config, file I/O. Has its own CLAUDE.md.
- `index.html`, `bubble.html`, `reminder.html` — the three page entry points (all listed in `vite.config.ts` inputs).
- `tests/` — Node test runner tests for the pure data model (`src/lib/model.ts`).
- `.github/workflows/release.yml` — builds the NSIS installer and publishes a GitHub Release on `v*` tags.

## Commands
- Install: `pnpm install`
- Run the app (dev): `pnpm tauri dev`
- Front-end tests: `pnpm test`
- Type-check: `pnpm check`
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- Installer: `pnpm tauri build` → `src-tauri/target/release/bundle/nsis/Quicky_<version>_x64-setup.exe`

## Releasing
- Bump the version in all three: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and the example tag in `README.md`).
- Run `pnpm check`, `pnpm test` and the Rust tests, then push a `v<version>` tag; CI publishes the release (tag name comes from the app version, `v__VERSION__`).
- Never move or force-push an existing tag; bump to a new version instead.

## Standards (everywhere)
- Windows-only app (Win32 code is `#[cfg(windows)]` but nothing else is supported).
- Keep it light: no new UI or animation libraries; sounds are synthesized (`src/lib/sfx.ts`), fonts are bundled Latin subsets.
- User data lives in the user's chosen folder as `quicky.json` + `media/<YYYY-MM>/`; it must stay readable by older and newer versions (add fields, never repurpose them; migrate on read).
- Times are stored 24-hour ("HH:MM") and always shown 12-hour AM/PM via `time12` in `src/lib/model.ts`.
- Commit messages: short summary line with the version in parentheses for releases, a bullet body, and the `Co-Authored-By` trailer when Claude writes it.

## Do not touch
- `src-tauri/gen/`, `src-tauri/target/`, `dist/`, `node_modules/` (generated).
- `src-tauri/icons/*` except `source.svg`; regenerate the rest with `pnpm tauri icon src-tauri/icons/source.svg` (then delete the `android/` and `ios/` folders it creates).
- `pnpm-lock.yaml` / `Cargo.lock` by hand.

## Testing on a real install (Claude desktop app)
- Commands run from the Claude desktop app are sandboxed: anything they launch writes `%APPDATA%`/`%LOCALAPPDATA%` into the Claude package's private storage. To install or launch Quicky for real, hand a `.cmd` to `explorer.exe` (e.g. one that runs the installer with `/S`), never `Start-Process` the installer directly.
- Only one Quicky runs at a time (single-instance); `quicky.exe --preview-reminder` asks the running one to show a sample reminder.
- Synthetic mouse tests need absolute moves (`MOUSEEVENTF_MOVE|ABSOLUTE|VIRTUALDESK`); `SetCursorPos` alone doesn't reach WebView2 during a held drag. Check whether the bubble is locked first.

## Keeping this context accurate
- When you create a new app, service or package, or a folder with its own conventions, add its CLAUDE.md (or a `.claude/rules/` file) using the `context-md-hierarchy` skill in `.claude/skills/`. Do not write it freehand.
- When you change a command, path or convention described in a CLAUDE.md, update that file in the same change.
- Never repeat a parent file's content in a child file.
