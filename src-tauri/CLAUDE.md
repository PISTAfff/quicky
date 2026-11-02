# Backend (`src-tauri/`)

Rust side of the Tauri 2 app: creates and places the windows (main, bubble, mini, reminder, fx, balloon, menu), runs the bubble housekeeping loop, does all file I/O for the user's data folder, keeps the app config, and wraps the native calls the bubble needs on Windows, macOS and Linux.

## Stack
Tauri 2 (`protocol-asset`, `tray-icon`, `macos-private-api`), plugins: dialog, opener, autostart, global-shortcut, single-instance, updater, process. Native: `windows-sys` 0.59 (Windows), `objc2` / `objc2-app-kit` 0.3 plus raw CoreGraphics calls (macOS), `x11rb` 0.13 (Linux). `png` + `base64` for icons. Release profile is size-optimized. `tauri.macos.conf.json` and `tauri.linux.conf.json` hold each system's bundle targets.

## Commands (run from the repo root)
- Tests: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- Quick compile check: `cargo check --manifest-path src-tauri/Cargo.toml`

## Layout
- `src/lib.rs`: wiring only: plugins, startup, window events, command registration. Each job below has a module of its own.
- `src/config.rs`: Quicky's settings (`Config`, `StuckApp`, `read_config` / `update_config`).
- `src/data.rs`: the user's data folder and media commands (`write_atomic`).
- `src/main_window.rs`: the main window as a popover: opening next to the bubble, by the tray, or inside or over an app (`open_for_context`), tucking away on blur, the quick-add shortcut, `MAIN_MIN`.
- `src/bubble.rs`: the two bubble windows: Quicky's own bubble (always at its spot) and the `mini` window (the focused app's mini, shown only while that app is in front), focus tracking, gliding, walled mini drags, popping, dividing.
- `src/tray.rs`: the tray icon and its menu. `src/icons.rs`: taskbar, Dock and tray icons in the accent colour.
- `src/reminder.rs`: the on-demand full-screen reminder window.
- `src/fx.rs`: the short-lived, click-through overlay that plays dividing, popping and hiding a mini (the bubbles hold still and the ones it draws are veiled meanwhile, then handed back).
- `src/win.rs`: thin Win32 wrappers (foreground app, window under a point, visible frame, icon extraction, cursor, focus stealing, full-screen check).
- `src/mac.rs`, `src/linux.rs`: the same functions for macOS (CoreGraphics window list, NSWorkspace) and Linux (X11). `lib.rs` compiles one of the three as `mod win`, so call sites never change.
- `src/own.rs`: macOS and Linux versions of the calls on Quicky's own windows (through Tauri, which hops to the main thread for AppKit/GTK).
- `src/balloon.rs`: the click-through speech balloon over the bubble (pinned task, peek), made on demand and kept next to the bubble by the housekeeping loop.
- `src/menu.rs`: the bubble's themed right-click menu window: made hidden when the pointer first reaches the bubble, sized to what the page measured, placed at the pointer (flipped at screen edges), and closed on Esc, a pick, lost focus, or a click elsewhere (the housekeeping loop watches).

## How we do things here
- Config: read with `read_config` (in-memory cache) and change with `update_config(|c| …)`; never read `config.json` from disk in a loop. New fields get `#[serde(default)]`; rename a field instead of reusing it when old saved values would be wrong.
- Data writes go through `write_atomic` (temp file + rename).
- The housekeeping thread (`bubble::housekeeping`) is the single place that polls: focus tracking, keeping the bubble topmost, gliding, walled drags (~60 fps while active), cursor streaming for tugs, and the 15 s `reminder-tick` to the main page.
- Commands that create windows must be `async` or build on a thread of their own (as `balloon.rs` and `menu.rs` do): a sync command runs on the main thread and deadlocks on Windows.
- New commands must be added to `generate_handler!` in `lib.rs`; new windows to `capabilities/default.json`.
- Shared state is a `Mutex` per module (`bubble`'s `STATE`, `main_window`'s `PLACEMENT`, `config`'s `CONFIG`), never re-entrant: take what you need into a local before locking again (an `if let` keeps its lock for the whole block).

## Gotchas
- Other apps' windows are `win::Hwnd` ids (HWND, CoreGraphics window number, X11 window); Quicky's own windows are passed as `&WebviewWindow`. A new native function needs a version in all three files; check with `cargo check --target aarch64-apple-darwin` / `x86_64-unknown-linux-gnu` or let the Build workflow do it.
- macOS: CoreGraphics measures in points from the top-left of the main screen; Tauri's physical pixels are points times that screen's scale (`mac.rs` converts). Transparent windows need `macOSPrivateApi`. Quick add is Option+Space there.
- Linux: `run()` sets `GDK_BACKEND=x11` before GTK starts, because Wayland won't let the bubble place itself; tray icons there don't report clicks, only menu choices.
- Show/hide the bubble only via `win::show` (Win32, no focus steal); mixing it with Tauri's `show()/hide()` desyncs Tauri's visibility bookkeeping.
- Place windows by their *visible* frame (`set_visible_frame`): undecorated windows have invisible resize borders.
- WebView2 loses the pointer when it leaves a small window, so drags/tugs that go past the bubble are driven here from `win::cursor()` and end on the real button release (`win::left_button_down`).
- All windows share one WebView2 environment: `additionalBrowserArgs` in `tauri.conf.json` and `BROWSER_ARGS` in `reminder.rs` must stay identical.
- Positions are physical pixels across all monitors; use `work_area_at` for the monitor under a point, not just the primary one.
- The main window's minimum is `MAIN_MIN` in `main_window.rs` (a test keeps it equal to `minWidth`/`minHeight` in `tauri.conf.json`). Windows only applies that to the user's own resizing, so Quicky's placing (`set_visible_frame`) and the in-app clamps (`win::keep_inside_host`, `own.rs`) keep to it themselves through `min_size()`.
- Store apps all report `ApplicationFrameHost.exe`, so they share one mini/space.
- Explorer draws the taskbar, tray popup, Alt+Tab and desktop too: `win::usable` only counts its folder windows (`CabinetWClass`), or shell surfaces get treated as apps.
- Opened inside an app, the main window is kept within it by a window subclass (`win::keep_inside_host`, `HOST`). The procedure runs on the main thread: use only atomics there, never `STATE` or the config lock. Set `HOST` before placing the window and clear it before restoring the general one.
- Taskbar, Dock and tray icons are tinted at runtime (`icons::set_icon_color`, from `live-icons/`; the Dock uses the 512 px `dock-*` layers); the app's own icon is the static one in `icons/`.

## Owners
PISTA (@PISTAfff)
