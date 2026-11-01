mod bubble;
mod reminder;
#[cfg(windows)]
mod win;

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
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    bubble::sync(&app);
}

/// Tray click: show the app, or tuck it away if it's already in front.
fn toggle_main(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    if main_on_screen(app) && main.is_focused().unwrap_or(false) {
        let _ = app.emit("flush", ());
        let _ = main.hide();
        bubble::sync(app);
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
            let cfg = read_config(&handle);
            if !cfg.autostart_initialized {
                let _ = app.autolaunch().enable();
                let _ = update_config(&handle, |c| c.autostart_initialized = true);
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
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Quicky")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
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
                // closing the bubble (Alt+F4) just switches the bubble off. The reminder can only
                // be closed through its own buttons (Esc snoozes).
                WindowEvent::CloseRequested { api, .. } if window.label() != "reminder" => {
                    api.prevent_close();
                    if window.label() == "bubble" {
                        let _ = bubble::set_show_bubble(app.clone(), false);
                    } else {
                        let _ = window.emit("flush", ());
                        let _ = window.hide();
                        bubble::sync(app);
                    }
                }
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
            bubble::get_show_bubble,
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
            bubble::mini_drag_to,
            bubble::mini_drag_end,
            bubble::mini_pop,
            reminder::show_reminder,
            reminder::reminder_payload,
            reminder::reminder_ready,
            reminder::close_reminder
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
