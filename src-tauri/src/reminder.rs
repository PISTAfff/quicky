//! The full-screen reminder: Quicky grows out of the bubble to cover the screen until the user
//! picks Doing, Done or Snooze. The window only exists while a reminder is showing.

use crate::bubble::{self, OVERLAY_UP};
use crate::main_window::show_main;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

static PAYLOAD: Mutex<Option<Value>> = Mutex::new(None);
/// When the next reminder is due (ms since the epoch, 0 = none), as the main page last said.
static WAKE: AtomicU64 = AtomicU64::new(0);

/// The main page: wake me when the next reminder is due (`at` in ms since the epoch, or none).
#[tauri::command]
pub fn reminder_wake_at(at: Option<f64>) {
    WAKE.store(at.map_or(0, |a| a.max(1.0) as u64), Ordering::Relaxed);
}

/// From the housekeeping loop: tells the main page to check for due reminders every 15 s, and
/// right when the next one is due. Its own timers can't do this: while it's hidden they only run
/// about once a minute.
pub fn tick(app: &AppHandle, last: &mut Instant) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let wake = WAKE.load(Ordering::Relaxed);
    let due = wake != 0 && now >= wake && WAKE.compare_exchange(wake, 0, Ordering::Relaxed, Ordering::Relaxed).is_ok();
    if due || last.elapsed() >= Duration::from_secs(15) {
        *last = Instant::now();
        let _ = app.emit_to("main", "reminder-tick", ());
    }
}
/// Same as `additionalBrowserArgs` in tauri.conf.json (Tauri's defaults + sound without a click).
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

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

    // Grow from the centre of the app's mini if one is up (that's where the user is), else the
    // bubble's if it's showing, else that screen's bottom-left.
    let bubble = [bubble::MINI_LABEL, bubble::BUBBLE_LABEL]
        .into_iter()
        .find_map(|l| app.get_webview_window(l).filter(|b| b.is_visible().unwrap_or(false)));
    let (ox, oy) = match bubble.and_then(|b| Some((b.outer_position().ok()?, b.outer_size().ok()?))) {
        Some((p, s)) => {
            let (x, y) = to_page(p.x, p.y);
            let half = s.width as f64 / scale / 2.0;
            (x + half, y + half)
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
        // Must match the other windows' args (one shared WebView2 environment); lets the chime play.
        .additional_browser_args(BROWSER_ARGS)
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

/// The id of the reminder showing now, as the page's answers carry it.
fn showing_id() -> Value {
    PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|p| p.get("id").cloned()).unwrap_or(json!(""))
}

/// Alt+F4 (or the system closing it) on the reminder: the same answer as Esc, snooze 10 minutes.
pub fn dismiss(app: &AppHandle) {
    let id = showing_id();
    close_reminder(app.clone(), json!({ "id": id, "action": "snooze", "minutes": 10 }));
}

/// The reminder window is gone. Unanswered (it was closed some other way), Quicky would otherwise
/// keep its bubble hidden and never show another reminder: answer it as a snooze.
pub fn destroyed(app: &AppHandle) {
    let Some(p) = PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
    OVERLAY_UP.store(false, Ordering::Relaxed);
    bubble::sync(app);
    let id = p.get("id").cloned().unwrap_or(json!(""));
    let _ = app.emit_to("main", "reminder-action", json!({ "id": id, "action": "snooze", "minutes": 10 }));
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
    crate::win::force_foreground(&win);
    let _ = win.set_focus();
}

/// Closes the reminder and hands the choice (doing / done / snooze / open) to the main page.
/// Done in Rust so the overlay always goes away, whatever state the main page is in.
#[tauri::command]
pub fn close_reminder(app: AppHandle, action: Value) {
    // Cleared first, so the window's Destroyed event knows this one was answered.
    *PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if let Some(win) = app.get_webview_window("reminder") {
        let _ = win.destroy();
    }
    OVERLAY_UP.store(false, Ordering::Relaxed);
    if action.get("action").and_then(Value::as_str) == Some("open") {
        show_main(&app);
    }
    bubble::sync(&app);
    let _ = app.emit_to("main", "reminder-action", action);
}
