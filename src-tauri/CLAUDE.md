# Backend (`src-tauri/`)

Rust side of the Tauri 2 app: creates and places the windows (main, bubble, reminder), runs the bubble housekeeping loop, does all file I/O for the user's data folder, keeps the app config, and wraps the Win32 calls the bubble needs.

## Stack
Tauri 2 (`protocol-asset`, `tray-icon`), plugins: dialog, opener, autostart, global-shortcut, single-instance. `windows-sys` 0.59 for Win32, `png` + `base64` for app icons. Release profile is size-optimized.

## Commands (run from the repo root)
- Tests: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- Quick compile check: `cargo check --manifest-path src-tauri/Cargo.toml`

## Layout
- `src/lib.rs`: config (`Config`, `StuckApp`), data/media commands, tray, global shortcut, window events, command registration.
- `src/bubble.rs`: bubble placement (normal spot vs. an app's mini), gliding, walled mini drags, popping, dividing, per-app windows (`open_for_context`), popover auto-hide.
- `src/reminder.rs`: the on-demand full-screen reminder window.
- `src/fx.rs`: the short-lived, click-through overlay that plays dividing, popping and hiding a mini (the bubble holds still and is veiled meanwhile, then handed back).
- `src/win.rs`: thin Win32 wrappers (foreground app, window under a point, visible frame, icon extraction, cursor, focus stealing).

## How we do things here
- Config: read with `read_config` (in-memory cache) and change with `update_config(|c| …)`; never read `config.json` from disk in a loop. New fields get `#[serde(default)]`; rename a field instead of reusing it when old saved values would be wrong.
- Data writes go through `write_atomic` (temp file + rename).
- The housekeeping thread (`bubble::housekeeping`) is the single place that polls: focus tracking, keeping the bubble topmost, gliding, walled drags (~60 fps while active), cursor streaming for tugs, and the 15 s `reminder-tick` to the main page.
- Commands that create windows must be `async` (sync commands deadlock on Windows).
- New commands must be added to `generate_handler!` in `lib.rs`; new windows to `capabilities/default.json`.

## Gotchas
- Show/hide the bubble only via `win::show` (Win32, no focus steal); mixing it with Tauri's `show()/hide()` desyncs Tauri's visibility bookkeeping.
- Place windows by their *visible* frame (`set_visible_frame`): undecorated windows have invisible resize borders.
- WebView2 loses the pointer when it leaves a small window, so drags/tugs that go past the bubble are driven here from `win::cursor()` and end on the real button release (`win::left_button_down`).
- All windows share one WebView2 environment: `additionalBrowserArgs` in `tauri.conf.json` and `BROWSER_ARGS` in `reminder.rs` must stay identical.
- Positions are physical pixels across all monitors; use `work_area_at` for the monitor under a point, not just the primary one.
- Store apps all report `ApplicationFrameHost.exe`, so they share one mini/space.
- Explorer draws the taskbar, tray popup, Alt+Tab and desktop too: `win::usable` only counts its folder windows (`CabinetWClass`), or shell surfaces get treated as apps.
- Opened inside an app, the main window is kept within it by a window subclass (`win::keep_inside_host`, `HOST`). The procedure runs on the main thread: use only atomics there, never `STATE` or the config lock. Set `HOST` before placing the window and clear it before restoring the general one.
- Taskbar and tray icons are tinted at runtime (`set_icon_color`, from `live-icons/`); the .exe's own icon is the static one in `icons/`.

## Owners
PISTA (@PISTAfff)
