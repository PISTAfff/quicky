//! The full-screen reminder: Quicky grows out of the bubble to cover the screen until the user
//! picks Doing, Done or Snooze. The window only exists while a reminder is showing.

use crate::bubble::{self, OVERLAY_UP};
use crate::show_main;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

static PAYLOAD: Mutex<Option<Value>> = Mutex::new(None);

/// All screens together (physical px), so the reminder can cover every display.
fn all_screens(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    let ms = app.available_monitors().ok()?;
    let mut it = ms.iter().map(|m| (m.position().x, m.position().y, m.position().x + m.size().width as i32, m.position().y + m.size().height as i32));
    let first = it.next()?;
    Some(it.fold(first, |(l, t, r, b), (l2, t2, r2, b2)| (l.min(l2), t.min(t2), r.max(r2), b.max(b2))))
}

/// Shows a reminder. `payload` comes from the main page (task id, title, note, time label).
/// The colour floods every screen; the words and buttons sit on the screen the bubble is on.
#[tauri::command]
pub async fn show_reminder(app: AppHandle, mut payload: Value) -> Result<(), String> {
    let focus = app
        .get_webview_window("bubble")
        .and_then(|b| b.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("No monitor")?;
    let scale = focus.scale_factor();
    let (left, top, right, bottom) = all_screens(&app).ok_or("No monitor")?;
    let to_page = |x: i32, y: i32| ((x - left) as f64 / scale, (y - top) as f64 / scale);

    let (fx, fy) = to_page(focus.position().x, focus.position().y);
    let (fw, fh) = (focus.size().width as f64 / scale, focus.size().height as f64 / scale);
    payload["focus"] = json!({ "x": fx, "y": fy, "w": fw, "h": fh });

    // Grow from the bubble's centre if it's showing, else that screen's bottom-left.
    let bubble = app.get_webview_window("bubble").filter(|b| b.is_visible().unwrap_or(false));
    let (ox, oy) = match bubble.and_then(|b| b.outer_position().ok()) {
        Some(p) => {
            let (x, y) = to_page(p.x, p.y);
            (x + bubble::SIZE / 2.0, y + bubble::SIZE / 2.0)
        }
        None => (fx + 50.0, fy + fh - 50.0),
    };
    payload["origin"] = json!({ "x": ox, "y": oy });
    *PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()) = Some(payload.clone());
    if let Some(win) = app.get_webview_window("reminder") {
        let _ = win.emit("reminder", payload);
        return Ok(());
    }
    OVERLAY_UP.store(true, Ordering::Relaxed);
    bubble::sync(&app);
    WebviewWindowBuilder::new(&app, "reminder", WebviewUrl::App("reminder.html".into()))
        .title("Quicky reminder")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .map(|win| {
            // Exact physical bounds: one window spanning every screen.
            let _ = win.set_position(PhysicalPosition::new(left, top));
            let _ = win.set_size(PhysicalSize::new((right - left) as u32, (bottom - top) as u32));
        })
        .map_err(|e| {
            OVERLAY_UP.store(false, Ordering::Relaxed);
            e.to_string()
        })?;
    Ok(())
}

/// The reminder page asks for its content once it has loaded.
#[tauri::command]
pub fn reminder_payload() -> Option<Value> {
    PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The page has painted: show it and pull it in front of whatever the user is doing.
#[tauri::command]
pub fn reminder_ready(app: AppHandle) {
    let Some(win) = app.get_webview_window("reminder") else { return };
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    #[cfg(windows)]
    if let Ok(h) = win.hwnd() {
        crate::win::force_foreground(h.0 as crate::win::Hwnd);
    }
    let _ = win.set_focus();
}

/// Closes the reminder and hands the choice (doing / done / snooze / open) to the main page.
/// Done in Rust so the overlay always goes away, whatever state the main page is in.
#[tauri::command]
pub fn close_reminder(app: AppHandle, action: Value) {
    if let Some(win) = app.get_webview_window("reminder") {
        let _ = win.destroy();
    }
    *PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()) = None;
    OVERLAY_UP.store(false, Ordering::Relaxed);
    if action.get("action").and_then(Value::as_str) == Some("open") {
        show_main(&app);
    }
    bubble::sync(&app);
    let _ = app.emit_to("main", "reminder-action", action);
}
