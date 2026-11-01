//! The full-screen reminder: Quicky grows out of the bubble to cover the screen until the user
//! picks Doing, Done or Snooze. The window only exists while a reminder is showing.

use crate::bubble::{self, OVERLAY_UP};
use crate::show_main;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static PAYLOAD: Mutex<Option<Value>> = Mutex::new(None);

/// Where on the screen to grow from: the bubble's centre if it's showing, else the bottom-left.
fn origin(app: &AppHandle, mon_x: i32, mon_y: i32, mon_h: f64, scale: f64) -> (f64, f64) {
    if let Some(b) = app.get_webview_window("bubble").filter(|b| b.is_visible().unwrap_or(false)) {
        if let Ok(p) = b.outer_position() {
            let half = bubble::SIZE / 2.0;
            return ((p.x - mon_x) as f64 / scale + half, (p.y - mon_y) as f64 / scale + half);
        }
    }
    (50.0, mon_h - 50.0)
}

/// Shows a reminder. `payload` comes from the main page (task id, title, note, time label).
#[tauri::command]
pub async fn show_reminder(app: AppHandle, mut payload: Value) -> Result<(), String> {
    let monitor = app
        .get_webview_window("bubble")
        .and_then(|b| b.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("No monitor")?;
    let scale = monitor.scale_factor();
    let (pos, size) = (monitor.position(), monitor.size());
    let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);
    let (ox, oy) = origin(&app, pos.x, pos.y, h, scale);
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
        .position(pos.x as f64 / scale, pos.y as f64 / scale)
        .inner_size(w, h)
        .build()
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
