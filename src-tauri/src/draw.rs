//! Draw on screen: a see-through window over every screen (`draw.html`) to draw, write and point
//! on, with its toolbar. Opened and closed by its global shortcut, the bubble's menu or the Draw
//! extension's window, and only while that extension is installed. The window is made each time
//! and destroyed on leaving, so leaving clears the drawing.
//! Click-through: the window lets the pointer through to the apps underneath except over the
//! toolbar (a loop here watches the pointer, since the page can't see it while clicks pass).
//! Screenshot: the page sends its drawing as a PNG; the window steps aside while the screen is
//! read (`win::capture`), the drawing goes on top, and the picture is saved to Pictures\Quicky and
//! copied (`win::copy_image`).

use crate::reminder::BROWSER_ARGS;
use crate::win;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The extension that gates it.
pub const EXTENSION: &str = "draw";
const LABEL: &str = "draw";

/// Where the window is (physical px: all the screens together) and the screen the pointer was on
/// when it opened, relative to the window (the toolbar starts at its top).
#[derive(Clone, Copy, Serialize)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    screen: [i32; 4],
}

static GEOM: Mutex<Option<Geometry>> = Mutex::new(None);
/// Each opening; the loop of an older one stops.
static RUN: AtomicU64 = AtomicU64::new(0);
static OPENING: AtomicBool = AtomicBool::new(false);
/// Click-through is on.
static PASS: AtomicBool = AtomicBool::new(false);
/// The toolbar (physical px, relative to the window: left, top, right, bottom).
static BAR: Mutex<[i32; 4]> = Mutex::new([0; 4]);

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// The shortcut: opens it, or leaves when it's open.
pub fn toggle(app: &AppHandle) {
    if window(app).is_some() {
        close(app);
    } else {
        open(app);
    }
}

/// Opens it (or brings it forward). Builds on a thread of its own: callers may be on the main
/// thread, where making a window deadlocks on Windows.
pub fn open(app: &AppHandle) {
    if !crate::extensions::installed(app, EXTENSION) || OPENING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        build(&app);
        OPENING.store(false, Ordering::SeqCst);
    });
}

fn build(app: &AppHandle) {
    if let Some(w) = window(app) {
        let _ = w.set_ignore_cursor_events(false);
        PASS.store(false, Ordering::SeqCst);
        win::force_foreground(&w);
        return;
    }
    let (cx, cy) = win::cursor();
    let Some((origin, size, _)) = crate::trail::desk(app, (cx, cy)) else { return };
    let mut screen = [0, 0, size.0 as i32, size.1 as i32];
    for m in app.available_monitors().unwrap_or_default() {
        let (p, s) = (m.position(), m.size());
        if cx >= p.x && cy >= p.y && cx < p.x + s.width as i32 && cy < p.y + s.height as i32 {
            screen = [p.x - origin.0, p.y - origin.1, s.width as i32, s.height as i32];
        }
    }
    *GEOM.lock().unwrap_or_else(|e| e.into_inner()) = Some(Geometry { x: origin.0, y: origin.1, width: size.0, height: size.1, screen });
    PASS.store(false, Ordering::SeqCst);
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let Ok(w) = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("draw.html".into()))
        .title("Draw on screen")
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
            let g = *GEOM.lock().unwrap_or_else(|e| e.into_inner());
            let [l, t, r, b] = *BAR.lock().unwrap_or_else(|e| e.into_inner());
            let (x, y) = win::cursor();
            g.is_none_or(|g| {
                let (x, y) = (x - g.x, y - g.y);
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

/// Leaves: the window goes, and the drawing with it.
pub fn close(app: &AppHandle) {
    RUN.fetch_add(1, Ordering::SeqCst);
    PASS.store(false, Ordering::SeqCst);
    if let Some(w) = window(app) {
        let _ = w.destroy();
    }
}

/// Opens it: the bubble's menu and the Draw extension's "Start drawing".
#[tauri::command]
pub async fn draw_open(app: AppHandle) -> Result<(), String> {
    if !crate::extensions::installed(&app, EXTENSION) {
        return Err("Install Draw on screen from Settings → Extensions first".into());
    }
    open(&app);
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

/// Where the window is, and whether a screenshot can be taken here.
#[tauri::command]
pub fn draw_info() -> Value {
    let g = *GEOM.lock().unwrap_or_else(|e| e.into_inner());
    json!({ "geometry": g, "canCapture": win::CAN_CAPTURE })
}

/// Click-through on or off.
#[tauri::command]
pub async fn draw_passthrough(app: AppHandle, on: bool) {
    PASS.store(on, Ordering::SeqCst);
    if !on && let Some(w) = window(&app) {
        let _ = w.set_ignore_cursor_events(false);
    }
}

/// Where the toolbar is now (physical px, relative to the window).
#[tauri::command]
pub fn draw_toolbar(rect: [i32; 4]) {
    *BAR.lock().unwrap_or_else(|e| e.into_inner()) = rect;
}

/// A file name the page suggested, kept to plain characters.
fn clean_name(name: &str) -> String {
    let s: String = name.chars().filter(|c| c.is_alphanumeric() || " -_.".contains(*c)).take(80).collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "Drawing".into() } else { s }
}

/// The drawing (RGBA, `ow`×`oh`) laid over the screen's picture (RGBA, `w`×`h`), stretched to
/// it if their sizes differ.
fn composite(shot: &mut [u8], w: u32, h: u32, over: &[u8], ow: u32, oh: u32) {
    if ow == 0 || oh == 0 {
        return;
    }
    for y in 0..h {
        let sy = (y as u64 * oh as u64 / h as u64) as usize;
        for x in 0..w {
            let sx = (x as u64 * ow as u64 / w as u64) as usize;
            let o = &over[(sy * ow as usize + sx) * 4..][..4];
            let a = o[3] as u32;
            if a == 0 {
                continue;
            }
            let d = &mut shot[((y * w + x) * 4) as usize..][..4];
            for i in 0..3 {
                d[i] = ((o[i] as u32 * a + d[i] as u32 * (255 - a) + 127) / 255) as u8;
            }
            d[3] = 255;
        }
    }
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

fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Saves a picture of the screen with the drawing on it (raw body: the drawing as a PNG the size
/// of the window; `x-name`: the file name) and copies it. Answers where it went and whether it
/// was copied.
#[tauri::command]
pub async fn draw_capture(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
    if !win::CAN_CAPTURE {
        return Err("Screenshots aren't available on this system yet".into());
    }
    let w = window(&app).ok_or("Draw on screen isn't open")?;
    let g = (*GEOM.lock().unwrap_or_else(|e| e.into_inner())).ok_or("Draw on screen isn't open")?;
    let drawing = crate::data::body_bytes(&request)?.into_owned();
    let name = clean_name(request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or_default());

    // The window steps aside (with its toolbar) while the screen is read.
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
    let mut rgba = shot.filter(|s| s.len() == g.width as usize * g.height as usize * 4).ok_or("Couldn't take a picture of the screen")?;
    let (over, ow, oh) = decode_png(&drawing)?;
    composite(&mut rgba, g.width, g.height, &over, ow, oh);
    let png = encode_png(&rgba, g.width, g.height)?;

    let dir = app.path().picture_dir().map_err(|e| e.to_string())?.join("Quicky");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut path = dir.join(format!("{name}.png"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{name} ({n}).png"));
        n += 1;
    }
    std::fs::write(&path, &png).map_err(|e| e.to_string())?;
    let copied = win::copy_image(&rgba, g.width, g.height);
    Ok(json!({ "path": path.to_string_lossy(), "copied": copied }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_stay_plain() {
        assert_eq!(clean_name("Drawing 2026-11-07 at 14.03.22"), "Drawing 2026-11-07 at 14.03.22");
        assert_eq!(clean_name("../../evil\\name"), "evilname");
        assert_eq!(clean_name("..."), "Drawing");
        assert_eq!(clean_name(""), "Drawing");
    }

    #[test]
    fn drawing_goes_on_top_of_the_screen() {
        let mut shot = vec![10, 20, 30, 255, 10, 20, 30, 255];
        // Opaque red over the first pixel, nothing over the second.
        composite(&mut shot, 2, 1, &[255, 0, 0, 255, 0, 0, 0, 0], 2, 1);
        assert_eq!(shot, vec![255, 0, 0, 255, 10, 20, 30, 255]);
        // Half see-through, stretched from one pixel to both.
        let mut shot = vec![0, 0, 0, 255, 0, 0, 0, 255];
        composite(&mut shot, 2, 1, &[255, 255, 255, 128], 1, 1);
        assert_eq!(&shot[..3], &[128, 128, 128]);
        assert_eq!(&shot[4..7], &[128, 128, 128]);
    }

    #[test]
    fn pictures_survive_a_round_trip() {
        let rgba = vec![1, 2, 3, 255, 4, 5, 6, 128];
        let png = encode_png(&rgba, 2, 1).unwrap();
        assert_eq!(decode_png(&png).unwrap(), (rgba, 2, 1));
    }
}
