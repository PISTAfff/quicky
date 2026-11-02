# Quicky

## What this is
A tiny task manager for Windows, macOS and Linux: quick-add mini tasks (To do / Doing / Done), daily carry-over, repeats, due dates, steps, reminders with quiet hours, media attachments, and an always-on-top "Quicky" bubble that can live inside other apps as per-app minis with their own task lists. Tauri 2 (Rust and the system web view) hosts five pages: the main window (SolidJS), the bubble, the full-screen reminder, the overlay for the bubble's big moments, and the speech balloon over the bubble.

## Map
- `src/`: front end (main window in SolidJS, bubble page and reminder page in plain TS). Has its own CLAUDE.md.
- `src-tauri/`: Rust backend (windows, bubble placement/physics driving, Win32 calls, config, file I/O). Has its own CLAUDE.md.
- `index.html`, `bubble.html`, `reminder.html`, `fx.html`, `balloon.html`: the five page entry points (all listed in `vite.config.ts` inputs).
- `tests/`: Node test runner tests for the pure data model (`src/lib/model.ts`).
- `brand/`: logo, mascot, screenshots and portfolio images (see `brand/README.md`); not bundled into the app.
- `.github/workflows/release.yml`: on `v*` tags, builds Windows (NSIS), macOS (universal .dmg) and Linux (.AppImage, .deb) into one draft release, then `.github/scripts/latest_json.py` writes `latest.json` and publishes it.
- `.github/workflows/build.yml`: every branch push checks, tests and builds all three (installers kept a week as run artifacts).

## Commands
- Install: `pnpm install`
- Run the app (dev): `pnpm tauri dev`
- Front-end tests: `pnpm test`
- Type-check: `pnpm check`
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- Installer: `pnpm tauri build` → `src-tauri/target/release/bundle/nsis/Quicky_<version>_x64-setup.exe` on Windows (macOS and Linux builds come from CI; this PC can't link them). Needs `TAURI_SIGNING_PRIVATE_KEY` (the updater key, `%USERPROFILE%\.tauri\quicky.key`, never in the repo) and an empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Releasing
- Bump the version in all three: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and the example tag in `README.md`).
- Run `pnpm check`, `pnpm test` and the Rust tests, then push a `v<version>` tag; CI publishes the release (tag name comes from the app version, `v__VERSION__`) with a signed `latest.json` for the in-app updater (repository secret `TAURI_SIGNING_PRIVATE_KEY`). The public key is in `tauri.conf.json`; changing the key pair strands existing installs.
- Never move or force-push an existing tag; bump to a new version instead.

## Standards (everywhere)
- Runs on Windows, macOS and Linux. Native calls live behind `win::` in `src-tauri` (one file per system, see its CLAUDE.md); every function there exists on all three. Words and shortcuts that differ come from `src/lib/platform.ts`.
- Keep it light: no new UI or animation libraries; sounds are synthesized (`src/lib/sfx.ts`), fonts are bundled Latin subsets.
- User data lives in the user's chosen folder as `quicky.json` + `media/<YYYY-MM>/`; it must stay readable by older and newer versions (add fields, never repurpose them; migrate on read).
- Times are stored 24-hour ("HH:MM") and always shown 12-hour AM/PM via `time12` in `src/lib/model.ts`.
- Commit messages: short summary line with the version in parentheses for releases, a bullet body, and the `Co-Authored-By` trailer when Claude writes it.

## Do not touch
- `src-tauri/gen/`, `src-tauri/target/`, `dist/`, `node_modules/` (generated).
- `src-tauri/icons/*` except `source.svg`; regenerate the rest with `pnpm tauri icon src-tauri/icons/source.svg` (then delete the `android/` and `ios/` folders it creates).
- `src-tauri/live-icons/*.png`: layers of the blob (under / body / over) that Rust tints to the accent for the taskbar and tray icons; re-render them together from `brand/logo/` if the blob changes.
- `pnpm-lock.yaml` / `Cargo.lock` by hand.

## Testing on a real install (Claude desktop app)
- Commands run from the Claude desktop app are sandboxed: anything they launch writes `%APPDATA%`/`%LOCALAPPDATA%` into the Claude package's private storage. To install or launch Quicky for real, hand a `.cmd` to `explorer.exe` (e.g. one that runs the installer with `/S`), never `Start-Process` the installer directly.
- Only one Quicky runs at a time (single-instance); `quicky.exe --preview-reminder` asks the running one to show a sample reminder.
- Synthetic mouse tests need absolute moves (`MOUSEEVENTF_MOVE|ABSOLUTE|VIRTUALDESK`); `SetCursorPos` alone doesn't reach WebView2 during a held drag. Check whether the bubble is locked first.

## Keeping this context accurate
- When you create a new app, service or package, or a folder with its own conventions, add its CLAUDE.md (or a `.claude/rules/` file) using the `context-md-hierarchy` skill in `.claude/skills/`. Do not write it freehand.
- When you change a command, path or convention described in a CLAUDE.md, update that file in the same change.
- Never repeat a parent file's content in a child file.
