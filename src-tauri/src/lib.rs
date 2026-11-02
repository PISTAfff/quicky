mod balloon;
mod bubble;
mod fx;
mod menu;
mod reminder;
// Native window calls behind one set of functions: Win32 on Windows, AppKit and CoreGraphics on
// macOS, X11 on Linux.
#[cfg_attr(windows, path = "win.rs")]
#[cfg_attr(target_os = "macos", path = "mac.rs")]
#[cfg_attr(target_os = "linux", path = "linux.rs")]
mod win;
#[cfg(not(windows))]
mod own;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const DATA_FILE: &str = "quicky.json";
const MEDIA_DIR: &str = "media";
const STARTUP_ARG: &str = "--startup";
/// The main window's smallest size (logical px), the same as `minWidth` / `minHeight` in
/// `tauri.conf.json`: Tauri holds the user's own resizing to it (on Windows counting the invisible
/// resize borders), and Quicky's own placing (inside an app, or squeezed by an app's edges) keeps
/// to it too.
pub const MAIN_MIN: (f64, f64) = (300.0, 260.0);

/// An app the bubble is stuck to: shown on that app's window (offset from its nearest corner)
/// whenever the app has focus.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StuckApp {
    pub exe: String,
    pub name: String,
    pub right: bool,
    pub bottom: bool,
    pub dx: i32,
    pub dy: i32,
    /// Where the app's own Quicky window sits inside it: gaps to its left/top/right/bottom edges
    /// (physical px). None = cover the app with a small margin.
    #[serde(default)]
    pub area: Option<[i32; 4]>,
    /// This mini is locked in place (each mini has its own lock, apart from the normal bubble's).
    #[serde(default)]
    pub locked: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    data_dir: Option<String>,
    show_bubble: bool,
    /// Start-with-Windows is switched on once on first run; after that it's the user's toggle.
    autostart_initialized: bool,
    /// Where the user dragged the bubble (physical px); None = bottom-left corner.
    bubble_pos: Option<(i32, i32)>,
    bubble_locked: bool,
    stuck_apps: Vec<StuckApp>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            data_dir: None,
            show_bubble: true,
            autostart_initialized: false,
            bubble_pos: None,
            bubble_locked: false,
            stuck_apps: Vec::new(),
        }
    }
}

/// The config is read constantly by the bubble loop, so it lives in memory; disk is only written.
static CONFIG: Mutex<Option<Config>> = Mutex::new(None);

#[derive(Serialize)]
struct Attachment {
    path: String,
    name: String,
    kind: String,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn read_config(app: &AppHandle) -> Config {
    let mut cache = CONFIG.lock().unwrap_or_else(|e| e.into_inner());
    cache.get_or_insert_with(|| load_config(app)).clone()
}

/// Read-modify-write under one lock, so the bubble thread and commands never overwrite each other.
pub fn update_config(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    let mut cache = CONFIG.lock().unwrap_or_else(|e| e.into_inner());
    let cfg = cache.get_or_insert_with(|| load_config(app));
    change(cfg);
    let json = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    write_atomic(&config_path(app)?, &json)
}

/// Writes via a temp file + rename so a crash or a sync client never sees half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = read_config(app).data_dir.ok_or("No data folder chosen")?;
    let dir = PathBuf::from(dir);
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err("Data folder is missing".into())
    }
}

fn allow_media(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

fn kind_of(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "svg" => "image",
        "mp4" | "webm" | "mov" | "mkv" | "m4v" => "video",
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac" | "opus" | "weba" => "audio",
        _ => "file",
    }
}

fn safe_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let clean: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if clean.is_empty() {
        "file".into()
    } else {
        clean
    }
}

/// Picks a free `media/<month>/<millis>-<name>` path and returns (absolute, relative).
fn media_target(root: &Path, month: &str, name: &str) -> Result<(PathBuf, String), String> {
    let month = safe_name(month);
    let dir = root.join(MEDIA_DIR).join(&month);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file = format!("{stamp}-{}", safe_name(name));
    Ok((dir.join(&file), format!("{MEDIA_DIR}/{month}/{file}")))
}

#[tauri::command]
fn get_data_dir(app: AppHandle) -> Option<String> {
    let dir = data_dir(&app).ok()?;
    allow_media(&app, &dir);
    Some(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn set_data_dir(app: AppHandle, path: String) -> Result<String, String> {
    let dir = quicky_folder(PathBuf::from(&path));
    fs::create_dir_all(dir.join(MEDIA_DIR)).map_err(|e| e.to_string())?;
    let path = dir.to_string_lossy().into_owned();
    update_config(&app, |c| c.data_dir = Some(path.clone()))?;
    allow_media(&app, &dir);
    Ok(path)
}

/// Always keeps data in its own "Quicky" folder inside whatever the user picked,
/// unless they picked a Quicky folder (or one that already holds Quicky data).
fn quicky_folder(picked: PathBuf) -> PathBuf {
    let is_quicky = picked
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("Quicky"));
    if is_quicky || picked.join(DATA_FILE).is_file() {
        picked
    } else {
        picked.join("Quicky")
    }
}

/// Title-bar close: hide to the tray and bring the bubble back straight away.
#[tauri::command]
fn hide_main(app: AppHandle) {
    bubble::remember_app_window(&app);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    bubble::sync(&app);
}

/// Tray click: show the general list by the tray, or tuck it away if it's already in front.
fn toggle_main(app: &AppHandle, at: (i32, i32)) {
    let Some(main) = app.get_webview_window("main") else { return };
    if main_on_screen(app) && main.is_focused().unwrap_or(false) {
        let _ = app.emit("flush", ());
        bubble::remember_app_window(app);
        let _ = main.hide();
        bubble::sync(app);
    } else {
        bubble::open_from_tray(app, at);
    }
}

#[tauri::command]
fn default_data_dir(app: AppHandle) -> Result<String, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Quicky").to_string_lossy().into_owned())
}

#[tauri::command]
fn load_data(app: AppHandle) -> Result<String, String> {
    let file = data_dir(&app)?.join(DATA_FILE);
    if !file.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(file).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_data(app: AppHandle, json: String) -> Result<(), String> {
    write_atomic(&data_dir(&app)?.join(DATA_FILE), json.as_bytes())
}

#[tauri::command]
fn import_files(
    app: AppHandle,
    paths: Vec<String>,
    month: String,
) -> Result<Vec<Attachment>, String> {
    let root = data_dir(&app)?;
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let src = PathBuf::from(&p);
        if !src.is_file() {
            continue;
        }
        let name = src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let (abs, rel) = media_target(&root, &month, &name)?;
        fs::copy(&src, &abs).map_err(|e| e.to_string())?;
        out.push(Attachment {
            kind: kind_of(&name).into(),
            path: rel,
            name,
        });
    }
    Ok(out)
}

/// Raw-body command: pasted images and recorded voice notes arrive as bytes, not JSON arrays.
#[tauri::command]
fn save_blob(app: AppHandle, request: Request<'_>) -> Result<Attachment, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let name = header("x-name").unwrap_or_else(|| "file".into());
    let month = header("x-month").unwrap_or_else(|| "misc".into());
    let (abs, rel) = media_target(&data_dir(&app)?, &month, &name)?;
    fs::write(&abs, bytes).map_err(|e| e.to_string())?;
    // .webm can be audio or video, so the page may say which.
    let kind = match header("x-kind").as_deref() {
        Some(k @ ("image" | "video" | "audio" | "file")) => k.to_string(),
        _ => kind_of(&name).into(),
    };
    Ok(Attachment {
        kind,
        path: rel,
        name,
    })
}

fn resolve_media(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    if !rel.starts_with("media/") || rel.contains("..") {
        return Err("Not a media path".into());
    }
    Ok(data_dir(app)?.join(rel))
}

#[tauri::command]
fn open_media(app: AppHandle, rel: String) -> Result<(), String> {
    let abs = resolve_media(&app, &rel)?;
    app.opener()
        .open_path(abs.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_media(app: AppHandle, rel: String) -> Result<(), String> {
    let abs = resolve_media(&app, &rel)?;
    if abs.exists() {
        fs::remove_file(abs).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    bubble::sync(app);
}

pub fn main_on_screen(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .is_some_and(|m| m.is_visible().unwrap_or(false) && !m.is_minimized().unwrap_or(false))
}

// ---- taskbar and tray icons in the accent colour ---------------------------------------------
// Both are Quicky's blob, drawn from layers in `live-icons/` (rendered from brand/logo): what sits
// under the body (its hard shadow), the body (white, tinted to the accent), and what sits over it
// (outline and face). The tray uses the small, outline-free blob.
const WINDOW_LAYERS: [&[u8]; 3] = [
    include_bytes!("../live-icons/window-under.png"),
    include_bytes!("../live-icons/window-body.png"),
    include_bytes!("../live-icons/window-over.png"),
];
const TRAY_LAYERS: [&[u8]; 2] = [include_bytes!("../live-icons/tray-body.png"), include_bytes!("../live-icons/tray-face.png")];
/// The Dock shows icons much bigger than a taskbar does.
#[cfg(target_os = "macos")]
const DOCK_LAYERS: [&[u8]; 3] = [
    include_bytes!("../live-icons/dock-under.png"),
    include_bytes!("../live-icons/dock-body.png"),
    include_bytes!("../live-icons/dock-over.png"),
];
const GRAPE: [u8; 3] = [0x6d, 0x4c, 0xff];

fn decode_rgba(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut dec = png::Decoder::new(bytes);
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = dec.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    (info.color_type == png::ColorType::Rgba && info.bit_depth == png::BitDepth::Eight).then_some((buf, info.width, info.height))
}

/// Paints straight-alpha pixel `s` over `d`.
fn paint_over(d: &mut [u8], s: &[u8]) {
    let (sa, da) = (s[3] as f32 / 255.0, d[3] as f32 / 255.0);
    let oa = sa + da * (1.0 - sa);
    if oa <= 0.0 {
        d.fill(0);
        return;
    }
    for c in 0..3 {
        d[c] = ((s[c] as f32 * sa + d[c] as f32 * da * (1.0 - sa)) / oa).round() as u8;
    }
    d[3] = (oa * 255.0).round() as u8;
}

/// Stacks the layers bottom to top, with layer `body` tinted to `rgb`.
fn blob_icon(layers: &[&[u8]], body: usize, rgb: [u8; 3]) -> Option<tauri::image::Image<'static>> {
    let mut out: Option<(Vec<u8>, u32, u32)> = None;
    for (i, bytes) in layers.iter().enumerate() {
        let (mut px, w, h) = decode_rgba(bytes)?;
        if i == body {
            px.chunks_mut(4).for_each(|p| p[..3].copy_from_slice(&rgb));
        }
        match out.as_mut() {
            None => out = Some((px, w, h)),
            Some((dst, ..)) => dst.chunks_mut(4).zip(px.chunks(4)).for_each(|(d, s)| paint_over(d, s)),
        }
    }
    out.map(|(px, w, h)| tauri::image::Image::new_owned(px, w, h))
}

/// Recolours the taskbar and tray icons to the accent picked in Settings ("#rrggbb").
#[tauri::command]
fn set_icon_color(app: AppHandle, color: String) {
    let hex = color.trim_start_matches('#');
    let Some(rgb) = (hex.len() == 6)
        .then(|| [0, 2, 4].map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()))
        .and_then(|[r, g, b]| Some([r?, g?, b?]))
    else {
        return;
    };
    if let (Some(main), Some(icon)) = (app.get_webview_window("main"), blob_icon(&WINDOW_LAYERS, 1, rgb)) {
        // The taskbar (Windows) or Dock (macOS) shows the big icon, which Tauri leaves alone.
        #[cfg(target_os = "macos")]
        let big = blob_icon(&DOCK_LAYERS, 1, rgb);
        #[cfg(not(target_os = "macos"))]
        let big = Some(icon.clone());
        if let Some(big) = big {
            win::set_big_icon(&main, big.rgba(), big.width(), big.height());
        }
        let _ = main.set_icon(icon);
    }
    if let (Some(tray), Some(icon)) = (app.tray_by_id("main"), blob_icon(&TRAY_LAYERS, 0, rgb)) {
        let _ = tray.set_icon(Some(icon));
    }
}

/// Reminders wait while this is true (when the user asked for that): a full-screen app is in front.
#[tauri::command]
fn system_busy() -> bool {
    win::busy()
}

fn quit(app: &AppHandle) {
    // Let the page flush its pending save before the process goes away.
    let _ = app.emit("flush", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Linux: GTK on X11 even in a Wayland session (through XWayland), because Wayland doesn't let
    // an app place its own windows and the bubble lives by placing itself. WebKitGTK's DMA-BUF
    // renderer is skipped too: it leaves windows blank on some graphics drivers.
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the first thing Quicky does, before any other thread exists.
        if std::env::var_os("DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
            unsafe { std::env::set_var("GDK_BACKEND", "x11") };
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        }
    }
    // Ctrl+Space, except on macOS where that switches keyboard input sources: Option+Space there.
    #[cfg(target_os = "macos")]
    let quick_key = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    #[cfg(not(target_os = "macos"))]
    let quick_key = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);

    tauri::Builder::default()
        // Launched by Windows at sign-in: start tucked away (tray + bubble only).
        .plugin(tauri_plugin_autostart::Builder::new().arg(STARTUP_ARG).build())
        // A second launch just brings up the running Quicky. `--preview-reminder` instead shows the
        // sample reminder (same as Settings → Reminders → Preview), handy for checking the overlay.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--preview-reminder") {
                let _ = app.emit_to("main", "preview-reminder", ());
            } else {
                show_main(app)
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &quick_key && event.state() == ShortcutState::Pressed {
                        // In Quicky itself: add to the list it shows. In an app with a mini Quicky:
                        // that app's tasks (the app in front right now, not a moment ago); anywhere
                        // else: the general list.
                        let in_quicky = app.get_webview_window("main").is_some_and(|m| m.is_focused().unwrap_or(false));
                        if !in_quicky {
                            bubble::note_focus();
                            bubble::open_for_context(app, false);
                        }
                        let _ = app.emit("quick-add", ());
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        // Updates from GitHub Releases (signed latest.json); the page asks, the user installs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            if let Err(e) = app.global_shortcut().register(quick_key) {
                eprintln!("The quick-add shortcut is taken by another app: {e}");
            }

            let handle = app.handle().clone();
            let cfg = read_config(&handle);
            if !cfg.autostart_initialized {
                let _ = app.autolaunch().enable();
                let _ = update_config(&handle, |c| c.autostart_initialized = true);
            }

            // Opened inside an app, the main window can't be moved or resized past the app's edges.
            if let Some(main) = app.get_webview_window("main") {
                win::keep_inside_host(&main);
            }
            bubble::SHOW.store(cfg.show_bubble, Ordering::Relaxed);
            bubble::place(&handle);
            if !std::env::args().any(|a| a == STARTUP_ARG) {
                show_main(&handle);
            }
            bubble::sync(&handle);
            bubble::housekeeping(&handle);

            let show = MenuItem::with_id(app, "show", "Show Quicky", true, None::<&str>)?;
            let bubble_item = MenuItem::with_id(app, "bubble", "Show bubble", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &bubble_item, &quit_item])?;
            TrayIconBuilder::with_id("main")
                .icon(blob_icon(&TRAY_LAYERS, 0, GRAPE).unwrap_or_else(|| app.default_window_icon().unwrap().clone()))
                .tooltip("Quicky")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => bubble::open_from_tray(app, win::cursor()),
                    "bubble" => {
                        let _ = bubble::set_show_bubble(app.clone(), true);
                    }
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = e
                    {
                        toggle_main(tray.app_handle(), (position.x as i32, position.y as i32));
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                // Closing the app hides it to the tray (Ctrl+Space and the bubble keep working);
                // closing the bubble (Alt+F4) just switches the bubble off. The reminder can only
                // be closed through its own buttons (Esc snoozes).
                WindowEvent::CloseRequested { api, .. } if !matches!(window.label(), "reminder" | "fx" | "balloon" | "menu") => {
                    api.prevent_close();
                    if window.label() == "bubble" {
                        // Only when the user closed it (Alt+F4 on it, so it's in front): closing the
                        // whole app from outside (taskkill, an installer) asks every window.
                        if window.is_focused().unwrap_or(false) {
                            let _ = bubble::set_show_bubble(app.clone(), false);
                        }
                    } else {
                        let _ = window.emit("flush", ());
                        bubble::remember_app_window(app);
                        let _ = window.hide();
                        bubble::sync(app);
                    }
                }
                // A popover: losing focus to another app tucks Quicky away (unless pinned).
                WindowEvent::Focused(false) if window.label() == "main" => bubble::on_main_blur(app),
                WindowEvent::ScaleFactorChanged { .. } if window.label() == "bubble" => bubble::place(app),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_data_dir,
            set_data_dir,
            default_data_dir,
            load_data,
            save_data,
            import_files,
            save_blob,
            open_media,
            remove_media,
            open_data_dir,
            hide_main,
            set_icon_color,
            system_busy,
            bubble::get_show_bubble,
            bubble::bubble_on_screen,
            bubble::set_show_bubble,
            bubble::get_bubble_locked,
            bubble::set_bubble_locked,
            bubble::reset_bubble,
            bubble::open_from_bubble,
            bubble::bubble_drag_start,
            bubble::bubble_context,
            bubble::stick_bubble,
            bubble::unstick_bubble,
            bubble::stuck_apps,
            bubble::mini_drag_start,
            bubble::pointer_track_start,
            bubble::mini_drag_end,
            bubble::mini_pop,
            bubble::set_pinned,
            bubble::app_icon,
            balloon::balloon_focus,
            balloon::balloon_peek,
            balloon::balloon_state,
            menu::menu_prewarm,
            menu::bubble_menu_open,
            menu::menu_pending,
            menu::menu_show,
            menu::menu_hide,
            fx::fx_payload,
            fx::fx_ready,
            fx::fx_handoff,
            fx::fx_done,
            reminder::show_reminder,
            reminder::reminder_payload,
            reminder::reminder_ready,
            reminder::close_reminder
        ])
        .build(tauri::generate_context!())
        .expect("error while building Quicky")
        .run(|app, event| match event {
            // Quitting from outside Quicky's own menu (Cmd+Q, logging out): save first.
            tauri::RunEvent::ExitRequested { code: None, api, .. } => {
                api.prevent_exit();
                quit(app);
            }
            // Clicking the Dock icon opens Quicky.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_take_the_accent_colour() {
        let pink = [0xd6, 0x33, 0x6c];
        for (layers, body, (x, y)) in [(&WINDOW_LAYERS[..], 1, (13, 42)), (&TRAY_LAYERS[..], 0, (6, 18))] {
            let icon = blob_icon(layers, body, pink).expect("icon layers decode");
            let (w, px) = (icon.width() as usize, icon.rgba());
            let at = |x: usize, y: usize| px[(y * w + x) * 4..(y * w + x) * 4 + 4].to_vec();
            assert_eq!(at(x, y), vec![0xd6, 0x33, 0x6c, 255], "body pixel takes the accent");
            assert_eq!(at(0, 0)[3], 0, "corners stay transparent");
        }
    }

    #[test]
    fn main_min_size_matches_the_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = conf["app"]["windows"].as_array().unwrap().iter().find(|w| w["label"] == "main").unwrap();
        assert_eq!((main["minWidth"].as_f64(), main["minHeight"].as_f64()), (Some(MAIN_MIN.0), Some(MAIN_MIN.1)));
    }

    #[test]
    fn picked_folder_gets_a_quicky_subfolder() {
        let tmp = std::env::temp_dir().join(format!("qk-test-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        assert_eq!(quicky_folder(tmp.clone()), tmp.join("Quicky"));
        assert_eq!(quicky_folder(tmp.join("quicky")), tmp.join("quicky"));

        // A folder that already holds Quicky data is reused as is.
        let existing = tmp.join("Tasks");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join(DATA_FILE), "{}").unwrap();
        assert_eq!(quicky_folder(existing.clone()), existing);
        let _ = fs::remove_dir_all(&tmp);
    }
}
