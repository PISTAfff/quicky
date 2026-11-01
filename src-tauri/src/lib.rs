use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const DATA_FILE: &str = "quicky.json";
const MEDIA_DIR: &str = "media";
const STARTUP_ARG: &str = "--startup";

#[derive(Serialize, Deserialize)]
#[serde(default)]
struct Config {
    data_dir: Option<String>,
    show_bubble: bool,
    /// Start-with-Windows is switched on once on first run; after that it's the user's toggle.
    autostart_initialized: bool,
    /// Where the user dragged the bubble (physical px); None = bottom-left corner.
    bubble_pos: Option<(i32, i32)>,
    bubble_locked: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            data_dir: None,
            show_bubble: true,
            autostart_initialized: false,
            bubble_pos: None,
            bubble_locked: false,
        }
    }
}

static SHOW_BUBBLE: AtomicBool = AtomicBool::new(true);
/// Latest bubble position from a drag, saved by the housekeeping thread (not on every pixel).
static MOVED_TO: Mutex<Option<(i32, i32)>> = Mutex::new(None);

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

fn read_config(app: &AppHandle) -> Config {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, cfg: &Config) -> Result<(), String> {
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
    let mut cfg = read_config(&app);
    cfg.data_dir = Some(path.clone());
    write_config(&app, &cfg)?;
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

#[tauri::command]
fn get_show_bubble(app: AppHandle) -> bool {
    read_config(&app).show_bubble
}

#[tauri::command]
fn set_show_bubble(app: AppHandle, show: bool) -> Result<(), String> {
    let mut cfg = read_config(&app);
    cfg.show_bubble = show;
    write_config(&app, &cfg)?;
    SHOW_BUBBLE.store(show, Ordering::Relaxed);
    let _ = app.emit("bubble-pref", show);
    sync_bubble(&app);
    Ok(())
}

#[tauri::command]
fn get_bubble_locked(app: AppHandle) -> bool {
    read_config(&app).bubble_locked
}

#[tauri::command]
fn set_bubble_locked(app: AppHandle, locked: bool) -> Result<(), String> {
    let mut cfg = read_config(&app);
    cfg.bubble_locked = locked;
    write_config(&app, &cfg)
}

/// Puts the bubble back in the bottom-left corner.
#[tauri::command]
fn reset_bubble(app: AppHandle) -> Result<(), String> {
    let mut cfg = read_config(&app);
    cfg.bubble_pos = None;
    write_config(&app, &cfg)?;
    place_bubble(&app);
    Ok(())
}

/// Bubble click: open the app right next to wherever the bubble is.
#[tauri::command]
fn open_from_bubble(app: AppHandle) {
    place_main_near_bubble(&app);
    show_main(&app);
}

/// Title-bar close: hide to the tray and bring the bubble back straight away.
#[tauri::command]
fn hide_main(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    sync_bubble(&app);
}

/// Tray click: show the app, or tuck it away if it's already in front.
fn toggle_main(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    if main_on_screen(app) && main.is_focused().unwrap_or(false) {
        let _ = app.emit("flush", ());
        let _ = main.hide();
        sync_bubble(app);
    } else {
        show_main(app);
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

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    sync_bubble(app);
}

fn main_on_screen(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .is_some_and(|m| m.is_visible().unwrap_or(false) && !m.is_minimized().unwrap_or(false))
}

/// The bubble is only around while the app itself is off screen (hidden to the tray or minimized),
/// and only if the user hasn't switched it off.
fn sync_bubble(app: &AppHandle) {
    let Some(b) = app.get_webview_window("bubble") else { return };
    let want = SHOW_BUBBLE.load(Ordering::Relaxed) && !main_on_screen(app);
    let shown = b.is_visible().unwrap_or(false);
    if want != shown {
        set_bubble_visible(&b, want);
    }
}

/// Shows the bubble without stealing focus from whatever the user is typing in. Both directions go
/// through Win32 directly: Tauri tracks visibility itself, so mixing the two would leave its
/// `hide()` thinking the window is already hidden.
fn set_bubble_visible(w: &tauri::WebviewWindow, visible: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = w.hwnd() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE};
        unsafe { ShowWindow(hwnd.0 as _, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
        return;
    }
    let _ = if visible { w.show() } else { w.hide() };
}

const BUBBLE: f64 = 88.0; // logical px, matches the bubble window size in tauri.conf.json (room to bounce)
const MARGIN: f64 = 2.0; // the blob already sits ~15 px inside its window

/// Work area (screen minus taskbar) of the primary monitor, in physical px, plus its scale.
fn work_area(app: &AppHandle) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)> {
    let m = app.primary_monitor().ok()??;
    let wa = m.work_area();
    Some((wa.position, wa.size, m.scale_factor()))
}

/// Puts the bubble where the user last dragged it, or in the bottom-left corner above the taskbar.
fn place_bubble(app: &AppHandle) {
    let (Some(b), Some((pos, size, scale))) = (app.get_webview_window("bubble"), work_area(app)) else { return };
    // Windows pads small captioned windows to a minimum width; drop that floor and size it exactly.
    let _ = b.set_min_size(Some(LogicalSize::new(1.0, 1.0)));
    let _ = b.set_size(LogicalSize::new(BUBBLE, BUBBLE));
    let side = (BUBBLE * scale) as i32;
    let inside = |(x, y): (i32, i32)| {
        x >= pos.x && y >= pos.y && x + side <= pos.x + size.width as i32 && y + side <= pos.y + size.height as i32
    };
    let corner = (pos.x + (MARGIN * scale) as i32, pos.y + size.height as i32 - ((BUBBLE + MARGIN) * scale) as i32);
    let (x, y) = read_config(app).bubble_pos.filter(|p| inside(*p)).unwrap_or(corner);
    let _ = b.set_position(PhysicalPosition::new(x, y));
}

/// Background housekeeping, twice a second: keep the bubble above the taskbar (which jumps above
/// other always-on-top windows whenever it's shown, constantly with auto-hide), hide/show it as the
/// app comes and goes (minimize included), and save where the user dragged it.
fn bubble_housekeeping(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(400));
        sync_bubble(&app);
        #[cfg(windows)]
        if let Some(hwnd) = app.get_webview_window("bubble").and_then(|b| b.hwnd().ok()) {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
            };
            unsafe {
                SetWindowPos(hwnd.0 as _, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
            }
        }
        if let Some(p) = MOVED_TO.lock().ok().and_then(|mut m| m.take()) {
            let mut cfg = read_config(&app);
            cfg.bubble_pos = Some(p);
            let _ = write_config(&app, &cfg);
        }
    });
}

/// Opens the main window next to the bubble: above it when there's room, otherwise below,
/// lined up with the bubble's side of the screen and kept inside the work area.
fn place_main_near_bubble(app: &AppHandle) {
    let (Some(main), Some(b), Some((wa, size, scale))) =
        (app.get_webview_window("main"), app.get_webview_window("bubble"), work_area(app))
    else {
        return;
    };
    let (Ok(m), Ok(bp)) = (main.outer_size(), b.outer_position()) else { return };
    let side = (BUBBLE * scale) as i32;
    let gap = (8.0 * scale) as i32;
    let (mw, mh) = (m.width as i32, m.height as i32);
    let (left, top) = (wa.x, wa.y);
    let (right, bottom) = (wa.x + size.width as i32, wa.y + size.height as i32);

    let on_right = bp.x + side / 2 > (left + right) / 2;
    let x = if on_right { bp.x + side - mw } else { bp.x };
    let y = if bp.y - gap - mh >= top { bp.y - gap - mh } else { bp.y + side + gap };
    let x = x.clamp(left, (right - mw).max(left));
    let y = y.clamp(top, (bottom - mh).max(top));
    let _ = main.set_position(PhysicalPosition::new(x, y));
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
    let quick_key = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);

    tauri::Builder::default()
        // Launched by Windows at sign-in: start tucked away (tray + bubble only).
        .plugin(tauri_plugin_autostart::Builder::new().arg(STARTUP_ARG).build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &quick_key && event.state() == ShortcutState::Pressed {
                        show_main(app);
                        let _ = app.emit("quick-add", ());
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            if let Err(e) = app.global_shortcut().register(quick_key) {
                eprintln!("Ctrl+Space is taken by another app: {e}");
            }

            let handle = app.handle().clone();
            let mut cfg = read_config(&handle);
            if !cfg.autostart_initialized {
                let _ = app.autolaunch().enable();
                cfg.autostart_initialized = true;
                let _ = write_config(&handle, &cfg);
            }

            SHOW_BUBBLE.store(cfg.show_bubble, Ordering::Relaxed);
            place_bubble(&handle);
            if !std::env::args().any(|a| a == STARTUP_ARG) {
                show_main(&handle);
            }
            sync_bubble(&handle);
            bubble_housekeeping(&handle);

            let show = MenuItem::with_id(app, "show", "Show Quicky", true, None::<&str>)?;
            let bubble = MenuItem::with_id(app, "bubble", "Show bubble", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &bubble, &quit_item])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Quicky")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "bubble" => {
                        let _ = set_show_bubble(app.clone(), true);
                    }
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = e
                    {
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                // Closing the app hides it to the tray (Ctrl+Space and the bubble keep working);
                // closing the bubble (Alt+F4) just switches the bubble off.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if window.label() == "bubble" {
                        let _ = set_show_bubble(app.clone(), false);
                    } else {
                        let _ = window.emit("flush", ());
                        let _ = window.hide();
                        sync_bubble(app);
                    }
                }
                WindowEvent::Moved(p) if window.label() == "bubble" => {
                    if let Ok(mut m) = MOVED_TO.lock() {
                        *m = Some((p.x, p.y));
                    }
                }
                WindowEvent::ScaleFactorChanged { .. } if window.label() == "bubble" => place_bubble(app),
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
            get_show_bubble,
            set_show_bubble,
            get_bubble_locked,
            set_bubble_locked,
            reset_bubble,
            open_from_bubble,
            hide_main
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quicky");
}

#[cfg(test)]
mod tests {
    use super::*;

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