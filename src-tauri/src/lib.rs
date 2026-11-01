use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
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
}

impl Default for Config {
    fn default() -> Self {
        Self { data_dir: None, show_bubble: true, autostart_initialized: false }
    }
}

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
    if let Some(b) = app.get_webview_window("bubble") {
        if show {
            place_bubble(&app);
            let _ = b.show();
        } else {
            let _ = b.hide();
        }
    }
    Ok(())
}

/// Bubble click: open the app just above the bubble, or tuck it away if it's already in front.
#[tauri::command]
fn toggle_main(app: AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    let visible = main.is_visible().unwrap_or(false) && !main.is_minimized().unwrap_or(false);
    if visible && main.is_focused().unwrap_or(false) {
        let _ = app.emit("flush", ());
        let _ = main.hide();
        return;
    }
    if !visible {
        place_main_above_bubble(&app);
    }
    show_main(&app);
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
}

const BUBBLE: f64 = 72.0; // logical px, matches the bubble window size in tauri.conf.json
const MARGIN: f64 = 12.0;

/// Work area (screen minus taskbar) of the primary monitor, in physical px, plus its scale.
fn work_area(app: &AppHandle) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)> {
    let m = app.primary_monitor().ok()??;
    let wa = m.work_area();
    Some((wa.position, wa.size, m.scale_factor()))
}

/// Pins the bubble to the bottom-left corner, just above the taskbar.
fn place_bubble(app: &AppHandle) {
    let (Some(b), Some((pos, size, scale))) = (app.get_webview_window("bubble"), work_area(app)) else { return };
    let x = pos.x + (MARGIN * scale) as i32;
    let y = pos.y + size.height as i32 - ((BUBBLE + MARGIN) * scale) as i32;
    // Windows pads small captioned windows to a minimum width; drop that floor and size it exactly.
    let _ = b.set_min_size(Some(LogicalSize::new(1.0, 1.0)));
    let _ = b.set_size(LogicalSize::new(BUBBLE, BUBBLE));
    let _ = b.set_position(PhysicalPosition::new(x, y));
}

/// The taskbar jumps above other always-on-top windows whenever it's shown or clicked
/// (always, with auto-hide). Re-assert the bubble's place on top twice a second; it's one cheap
/// Win32 call that never activates or moves the window.
#[cfg(windows)]
fn keep_bubble_above_taskbar(app: &AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    };
    let Some(hwnd) = app.get_webview_window("bubble").and_then(|b| b.hwnd().ok()) else { return };
    let hwnd = hwnd.0 as isize;
    std::thread::spawn(move || loop {
        unsafe {
            SetWindowPos(hwnd as _, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    });
}

/// Opens the main window growing up from the bubble, kept inside the work area.
fn place_main_above_bubble(app: &AppHandle) {
    let (Some(main), Some((pos, size, scale))) = (app.get_webview_window("main"), work_area(app)) else { return };
    let Ok(outer) = main.outer_size() else { return };
    let x = pos.x + (MARGIN * scale) as i32;
    let bottom = pos.y + size.height as i32 - ((BUBBLE + MARGIN * 2.0) * scale) as i32;
    let y = (bottom - outer.height as i32).max(pos.y);
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

            if cfg.show_bubble {
                place_bubble(&handle);
                if let Some(b) = app.get_webview_window("bubble") {
                    let _ = b.show();
                }
            }
            #[cfg(windows)]
            keep_bubble_above_taskbar(&handle);
            if !std::env::args().any(|a| a == STARTUP_ARG) {
                show_main(&handle);
            }

            let show = MenuItem::with_id(app, "show", "Show Quicky", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit_item])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Quicky")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
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
                        toggle_main(tray.app_handle().clone());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides to the tray so Ctrl+Space keeps working.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("flush", ());
                let _ = window.hide();
            }
            // Keep the bubble in its corner when the taskbar or resolution changes.
            if window.label() == "bubble" && matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
                place_bubble(window.app_handle());
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
            toggle_main
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