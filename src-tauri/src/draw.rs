//! The screen tools: a see-through window over every screen (`draw.html`) with three modes:
//! Screenshot (the default each time: the screen is frozen as it was, the user picks an area or a
//! window, may draw on it, and it's copied and saved), Draw (pen, shapes, text, spotlight, laser
//! over the live screen) and Record (`record.rs`). Opened by its global shortcuts, the bubble's
//! menu or the extension's window, and only while that extension (`draw`) is installed. The
//! window is made each time and destroyed on leaving, so leaving clears the drawing.
//! Click-through (Draw, and the stop bar and toasts): the window lets the pointer through to the
//! apps underneath except over the toolbar (a loop here watches the pointer, since the page can't
//! see it while clicks pass).

use crate::reminder::BROWSER_ARGS;
use crate::win;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The extension that gates it.
pub const EXTENSION: &str = "draw";
pub const LABEL: &str = "draw";
/// The modes it opens in.
pub const MODES: [&str; 3] = ["shot", "draw", "record"];

/// Where the window is (physical px: all the screens together), the screens and app windows in
/// it (relative to it, app windows topmost first) and the screen the pointer was on, and the
/// mode it opened in.
#[derive(Clone, Serialize)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    screen: [i32; 4],
    screens: Vec<[i32; 4]>,
    windows: Vec<[i32; 4]>,
    mode: &'static str,
}

static GEOM: Mutex<Option<Geometry>> = Mutex::new(None);
/// The screen as it was when Screenshot began (RGBA, the window's size).
static FROZEN: Mutex<Option<Vec<u8>>> = Mutex::new(None);
/// Files saved this time (only these can be opened or shown in their folder from the page).
static SAVED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
/// Each opening; the loop of an older one stops.
static RUN: AtomicU64 = AtomicU64::new(0);
static OPENING: AtomicBool = AtomicBool::new(false);
/// Click-through is on.
static PASS: AtomicBool = AtomicBool::new(false);
/// The part that still catches the pointer in click-through (physical px, relative to the
/// window: left, top, right, bottom).
static BAR: Mutex<[i32; 4]> = Mutex::new([0; 4]);

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A mode this system can do (Screenshot needs a picture of the screen, Record a recorder);
/// anything else opens in Draw.
fn usable_mode(mode: &str) -> &'static str {
    match mode {
        "shot" if win::CAN_CAPTURE => "shot",
        "record" if win::can_record() => "record",
        _ => "draw",
    }
}

/// A shortcut (or `--draw`): opens in `mode`, or leaves when it's open. While recording it stops
/// the recording instead (the page saves it and says where).
pub fn toggle(app: &AppHandle, mode: &str) {
    if crate::record::active() {
        let _ = app.emit_to(LABEL, "draw-stop", ());
    } else if window(app).is_some() {
        close(app);
    } else {
        open(app, mode);
    }
}

/// Opens it (or brings it forward). Builds on a thread of its own: callers may be on the main
/// thread, where making a window deadlocks on Windows.
pub fn open(app: &AppHandle, mode: &str) {
    if !crate::extensions::installed(app, EXTENSION) || OPENING.swap(true, Ordering::SeqCst) {
        return;
    }
    let mode = usable_mode(mode);
    let app = app.clone();
    std::thread::spawn(move || {
        build(&app, mode);
        OPENING.store(false, Ordering::SeqCst);
    });
}

fn build(app: &AppHandle, mode: &'static str) {
    if let Some(w) = window(app) {
        win::force_foreground(&w);
        return;
    }
    let (cx, cy) = win::cursor();
    let Some((origin, size, _)) = crate::trail::desk(app, (cx, cy)) else { return };
    let rel = |l: i32, t: i32, w: i32, h: i32| [l - origin.0, t - origin.1, w, h];
    let mut screen = [0, 0, size.0 as i32, size.1 as i32];
    let mut screens = Vec::new();
    for m in app.available_monitors().unwrap_or_default() {
        let (p, s) = (m.position(), m.size());
        let r = rel(p.x, p.y, s.width as i32, s.height as i32);
        if cx >= p.x && cy >= p.y && cx < p.x + s.width as i32 && cy < p.y + s.height as i32 {
            screen = r;
        }
        screens.push(r);
    }
    // Screenshot shows the screen as it was when asked, before this window is on it.
    let mut windows = Vec::new();
    *lock(&FROZEN) = None;
    if mode == "shot" {
        // A moment for whatever asked to get off the screen (the bubble's menu hides as its pick
        // arrives here).
        std::thread::sleep(Duration::from_millis(90));
        *lock(&FROZEN) = win::capture(origin.0, origin.1, size.0, size.1);
    }
    if mode != "draw" {
        windows = win::window_rects().into_iter().map(|r| rel(r.left, r.top, r.right - r.left, r.bottom - r.top)).collect();
    }
    *lock(&GEOM) = Some(Geometry { x: origin.0, y: origin.1, width: size.0, height: size.1, screen, screens, windows, mode });
    lock(&SAVED).clear();
    PASS.store(false, Ordering::SeqCst);
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let Ok(w) = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("draw.html".into()))
        .title("Screen tools")
        .additional_browser_args(BROWSER_ARGS)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
    else {
        return;
    };
    let _ = w.set_position(PhysicalPosition::new(origin.0, origin.1));
    let _ = w.set_size(PhysicalSize::new(size.0, size.1));
    // Shown once its page has painted (`draw_ready`); this is only the safety net.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2500));
        if RUN.load(Ordering::SeqCst) == run && let Some(w) = window(&app) && !w.is_visible().unwrap_or(true) {
            reveal(&app, &w, run);
        }
    });
}

fn reveal(app: &AppHandle, w: &WebviewWindow, run: u64) {
    let _ = w.show();
    win::keep_topmost(w);
    win::force_foreground(w);
    let app = app.clone();
    std::thread::spawn(move || keep(&app, run));
}

/// While it's open: on top of everything (other always-on-top windows can climb over it), and in
/// click-through, catching the pointer only over the toolbar.
fn keep(app: &AppHandle, run: u64) {
    let mut ignoring = false;
    let mut steps: u32 = 0;
    while RUN.load(Ordering::SeqCst) == run {
        let Some(w) = window(app) else { break };
        let want = PASS.load(Ordering::SeqCst) && {
            let g = lock(&GEOM).as_ref().map(|g| (g.x, g.y));
            let [l, t, r, b] = *lock(&BAR);
            let (x, y) = win::cursor();
            g.is_none_or(|(gx, gy)| {
                let (x, y) = (x - gx, y - gy);
                // A little margin, so the pointer is caught before it reaches a button.
                !(x >= l - 8 && x < r + 8 && y >= t - 8 && y < b + 8)
            })
        };
        if want != ignoring {
            let _ = w.set_ignore_cursor_events(want);
            ignoring = want;
        }
        steps += 1;
        if steps.is_multiple_of(20) {
            win::keep_topmost(&w);
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

/// Leaves: a recording still going is finished first (a cut-off MP4 doesn't play), then the
/// window goes, and the drawing with it.
pub fn close(app: &AppHandle) {
    let _ = crate::record::stop(app);
    RUN.fetch_add(1, Ordering::SeqCst);
    PASS.store(false, Ordering::SeqCst);
    *lock(&FROZEN) = None;
    if let Some(w) = window(app) {
        let _ = w.destroy();
    }
}

/// The window went away some other way (Alt+F4): don't leave a recording unfinished.
pub fn destroyed(app: &AppHandle) {
    RUN.fetch_add(1, Ordering::SeqCst);
    *lock(&FROZEN) = None;
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = crate::record::stop(&app);
    });
}

/// Opens it: the bubble's menu and the extension's buttons (`mode`: shot, draw or record).
#[tauri::command]
pub async fn draw_open(app: AppHandle, mode: Option<String>) -> Result<(), String> {
    if !crate::extensions::installed(&app, EXTENSION) {
        return Err("Install the screen tools from Settings → Extensions first".into());
    }
    let mode = mode.unwrap_or_else(|| "shot".into());
    if !MODES.contains(&mode.as_str()) {
        return Err("No such mode".into());
    }
    open(&app, &mode);
    Ok(())
}

#[tauri::command]
pub async fn draw_close(app: AppHandle) {
    close(&app);
}

/// The page has painted: it shows.
#[tauri::command]
pub async fn draw_ready(app: AppHandle) {
    let run = RUN.load(Ordering::SeqCst);
    if let Some(w) = window(&app) && !w.is_visible().unwrap_or(true) {
        reveal(&app, &w, run);
    }
}

/// Where the window is, what's on the screens, and what this system can do.
#[tauri::command]
pub fn draw_info() -> Value {
    let g = lock(&GEOM).clone();
    json!({ "geometry": g, "canCapture": win::CAN_CAPTURE, "canRecord": win::can_record() })
}

/// The frozen screen (RGBA, the window's size; empty when there's none).
#[tauri::command]
pub fn draw_frozen() -> Response {
    Response::new(lock(&FROZEN).clone().unwrap_or_default())
}

/// Screenshot again after Draw or Record: the window steps aside while the screen is read (its
/// drawing stays in the page and goes on top).
#[tauri::command]
pub async fn draw_refreeze(app: AppHandle) -> Result<(), String> {
    let w = window(&app).ok_or("The screen tools aren't open")?;
    let g = lock(&GEOM).clone().ok_or("The screen tools aren't open")?;
    #[cfg(windows)]
    win::set_invisible(&w, true);
    #[cfg(not(windows))]
    let _ = w.hide();
    std::thread::sleep(Duration::from_millis(if cfg!(windows) { 120 } else { 250 }));
    let shot = win::capture(g.x, g.y, g.width, g.height);
    #[cfg(windows)]
    win::set_invisible(&w, false);
    #[cfg(not(windows))]
    {
        let _ = w.show();
        win::force_foreground(&w);
    }
    let shot = shot.ok_or("Couldn't take a picture of the screen")?;
    *lock(&FROZEN) = Some(shot);
    Ok(())
}

/// The app windows on screen now (relative to the window, topmost first), for picking one by
/// clicking it after switching to Screenshot or Record.
#[tauri::command]
pub fn draw_windows() -> Vec<[i32; 4]> {
    let mut geom = lock(&GEOM);
    let Some(g) = geom.as_mut() else { return Vec::new() };
    g.windows = win::window_rects().into_iter().map(|r| [r.left - g.x, r.top - g.y, r.right - r.left, r.bottom - r.top]).collect();
    g.windows.clone()
}

/// Click-through on or off.
#[tauri::command]
pub async fn draw_passthrough(app: AppHandle, on: bool) {
    PASS.store(on, Ordering::SeqCst);
    if !on && let Some(w) = window(&app) {
        let _ = w.set_ignore_cursor_events(false);
    }
}

/// The part that catches the pointer in click-through (physical px, relative to the window).
#[tauri::command]
pub fn draw_toolbar(rect: [i32; 4]) {
    *lock(&BAR) = rect;
}

/// A file name the page suggested, kept to plain characters.
pub(crate) fn clean_name(name: &str) -> String {
    let s: String = name.chars().filter(|c| c.is_alphanumeric() || " -_.".contains(*c)).take(80).collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "Screenshot".into() } else { s }
}

/// Where screenshots (`videos` false) or recordings go: the user's choice, else Pictures\Quicky
/// or Videos\Quicky.
pub(crate) fn folder(app: &AppHandle, videos: bool) -> Result<PathBuf, String> {
    let cfg = crate::config::read_config(app);
    let chosen = if videos { cfg.videos_dir } else { cfg.shots_dir };
    let dir = match chosen {
        Some(d) => PathBuf::from(d),
        None => {
            let base = if videos { app.path().video_dir() } else { app.path().picture_dir() };
            base.map_err(|e| e.to_string())?.join("Quicky")
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't use the folder {}: {e}", dir.display()))?;
    Ok(dir)
}

/// A new file in `dir` named `name` (with " (2)" and up when it's taken).
pub(crate) fn fresh_path(dir: &std::path::Path, name: &str, ext: &str) -> PathBuf {
    let mut path = dir.join(format!("{name}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{name} ({n}).{ext}"));
        n += 1;
    }
    path
}

pub(crate) fn remember(path: &std::path::Path) {
    lock(&SAVED).push(path.to_path_buf());
}

fn decode_png(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut dec = png::Decoder::new(bytes);
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = dec.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());
    let (w, h) = (info.width, info.height);
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf.chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        _ => return Err("Unexpected picture".into()),
    };
    Ok((rgba, w, h))
}

/// Saves a screenshot the page made (raw body: a PNG; `x-name`: the file name) and copies it.
/// Answers where it went and whether it was copied.
#[tauri::command]
pub async fn draw_save_png(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
    let png = crate::data::body_bytes(&request)?.into_owned();
    let name = clean_name(request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or_default());
    let dir = folder(&app, false)?;
    let path = fresh_path(&dir, &name, "png");
    std::fs::write(&path, &png).map_err(|e| e.to_string())?;
    remember(&path);
    let copied = decode_png(&png).is_ok_and(|(rgba, w, h)| win::copy_image(&rgba, w, h));
    Ok(json!({ "path": path.to_string_lossy(), "folder": dir.to_string_lossy(), "copied": copied }))
}

fn saved(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if lock(&SAVED).contains(&p) { Ok(p) } else { Err("Not a file Quicky saved".into()) }
}

/// Shows a screenshot or recording saved this time in its folder.
#[tauri::command]
pub async fn draw_reveal(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(saved(&path)?).map_err(|e| e.to_string())
}

/// Opens a screenshot or recording saved this time in its app.
#[tauri::command]
pub async fn draw_open_file(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(saved(&path)?, None::<&str>).map_err(|e| e.to_string())
}

/// Where screenshots and recordings go now, and whether that's the default.
#[tauri::command]
pub fn capture_dirs(app: AppHandle) -> Value {
    let cfg = crate::config::read_config(&app);
    let show = |videos: bool| folder(&app, videos).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    json!({ "shots": show(false), "videos": show(true), "shotsCustom": cfg.shots_dir.is_some(), "videosCustom": cfg.videos_dir.is_some() })
}

/// A new folder for screenshots (`kind` "shots") or recordings ("videos"); None: the default.
#[tauri::command]
pub fn set_capture_dir(app: AppHandle, kind: String, path: Option<String>) -> Result<(), String> {
    if let Some(p) = &path
        && !std::path::Path::new(p).is_dir()
    {
        return Err("That folder doesn't exist".into());
    }
    crate::config::update_config(&app, |c| match kind.as_str() {
        "videos" => c.videos_dir = path,
        _ => c.shots_dir = path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_stay_plain() {
        assert_eq!(clean_name("Screenshot 2026-11-07 at 14.03.22"), "Screenshot 2026-11-07 at 14.03.22");
        assert_eq!(clean_name("../../evil\\name"), "evilname");
        assert_eq!(clean_name("..."), "Screenshot");
        assert_eq!(clean_name(""), "Screenshot");
    }

    #[test]
    fn taken_names_get_a_number() {
        let dir = std::env::temp_dir().join(format!("quicky-names-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = fresh_path(&dir, "Shot", "png");
        assert_eq!(first.file_name().unwrap(), "Shot.png");
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(fresh_path(&dir, "Shot", "png").file_name().unwrap(), "Shot (2).png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn modes_fall_back_to_draw_where_they_cant_work() {
        assert_eq!(usable_mode("draw"), "draw");
        assert_eq!(usable_mode("nonsense"), "draw");
        assert_eq!(usable_mode("shot"), if win::CAN_CAPTURE { "shot" } else { "draw" });
        assert_eq!(usable_mode("record"), if win::can_record() { "record" } else { "draw" });
    }
}
