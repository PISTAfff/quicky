//! The main window, a popover: where it opens (next to the bubble, by the tray, inside or over
//! the app it's for) and when it tucks itself away. Its size never goes below `MAIN_MIN`.

use crate::bubble::{self, SIZE};
use crate::config::update_config;
use crate::win::{self, Rect};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

/// The main window's smallest size (logical px), the same as `minWidth` / `minHeight` in
/// `tauri.conf.json`: Tauri holds the user's own resizing to it (on Windows counting the invisible
/// resize borders), and Quicky's own placing (inside an app, or squeezed by an app's edges) keeps
/// to it too.
pub const MAIN_MIN: (f64, f64) = (300.0, 260.0);

/// `MAIN_MIN` in physical px at a display scale.
pub fn min_size(scale: f64) -> (i32, i32) {
    ((MAIN_MIN.0 * scale).round() as i32, (MAIN_MIN.1 * scale).round() as i32)
}

/// Where the main window is open: as an app's Quicky (that app, and the frame we gave it, so only
/// a size the user actually changed is remembered), and the general window's own size and spot,
/// to restore after an app's.
struct Placement {
    space: Option<(String, win::Hwnd)>,
    placed_frame: Option<Rect>,
    general: Option<(i32, i32, u32, u32)>,
}

static PLACEMENT: Mutex<Placement> = Mutex::new(Placement { space: None, placed_frame: None, general: None });

fn placement() -> MutexGuard<'static, Placement> {
    PLACEMENT.lock().unwrap_or_else(|e| e.into_inner())
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

/// Title-bar close: hide to the tray and bring the bubble back straight away.
#[tauri::command]
pub fn hide_main(app: AppHandle) {
    remember_app_window(&app);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    bubble::sync(&app);
}

/// Tray click: show the general list by the tray, or tuck it away if it's already in front.
pub fn toggle_main(app: &AppHandle, at: (i32, i32)) {
    let Some(main) = app.get_webview_window("main") else { return };
    if main_on_screen(app) && main.is_focused().unwrap_or(false) {
        let _ = app.emit("flush", ());
        remember_app_window(app);
        let _ = main.hide();
        bubble::sync(app);
    } else {
        open_from_tray(app, at);
    }
}

/// The quick-add shortcut (Ctrl+Space, Option+Space on macOS). In Quicky itself: add to the list
/// it shows. In an app with a mini Quicky: that app's tasks (the app in front right now, not a
/// moment ago); anywhere else: the general list.
pub fn quick_add(app: &AppHandle) {
    let in_quicky = app.get_webview_window("main").is_some_and(|m| m.is_focused().unwrap_or(false));
    if !in_quicky {
        bubble::note_focus();
        open_for_context(app, false);
    }
    let _ = app.emit("quick-add", ());
}

/// Opens Quicky for whatever the user is in: the focused app's own space if that app has a
/// mini (inside the app when its window can hold Quicky, over it when not), otherwise the
/// general list.
pub fn open_for_context(app: &AppHandle, near_bubble: bool) {
    let Some(main) = app.get_webview_window("main") else { return };
    remember_app_window(app);
    let s = bubble::scale(app);
    let margin = (14.0 * s) as i32;
    let (min_w, min_h) = min_size(s);
    match bubble::active_stuck(app) {
        Some((entry, focus, rect)) => {
            // An app's Quicky gets a frame of its own, so a maximized general window comes down first.
            if main.is_maximized().unwrap_or(false) {
                let _ = main.unmaximize();
            }
            // Leaving the general window: remember its size and spot to restore later.
            // (Each placement() lock is let go before the next: it isn't re-entrant.)
            let from_general = placement().space.is_none();
            if let (true, Some(f)) = (from_general, win::own_frame(&main)) {
                placement().general = Some((f.left, f.top, (f.right - f.left) as u32, (f.bottom - f.top) as u32));
            }
            if rect.right - rect.left >= min_w + 2 * margin && rect.bottom - rect.top >= min_h + 2 * margin {
                // Inside the app, covering it with a small margin unless the user resized it there.
                // From here on it can't be moved or resized past the app's edges.
                win::HOST.store(focus.hwnd, Ordering::Relaxed);
                let [l, t, r, b] = entry.area.unwrap_or([margin; 4]).map(|v| v.max(0));
                let (x, y) = (rect.left + l, rect.top + t);
                let w = (rect.right - r - x).max(min_w);
                let h = (rect.bottom - b - y).max(min_h);
                set_visible_frame(&main, x, y, w, h);
            } else {
                // The app's window is too small to hold Quicky: still that app's list, centred
                // over the app (kept on its screen) and free to move.
                win::HOST.store(0, Ordering::Relaxed);
                let (cx, cy) = ((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
                let (mut x, mut y) = (cx - min_w / 2, cy - min_h / 2);
                if let Some((wa, size, _)) = bubble::work_area_at(app, cx, cy) {
                    x = x.clamp(wa.x, (wa.x + size.width as i32 - min_w).max(wa.x));
                    y = y.clamp(wa.y, (wa.y + size.height as i32 - min_h).max(wa.y));
                }
                set_visible_frame(&main, x, y, min_w, min_h);
            }
            let mut p = placement();
            p.space = Some((entry.exe.clone(), focus.hwnd));
            p.placed_frame = win::own_frame(&main);
            drop(p);
            let _ = app.emit_to("main", "open-space", serde_json::json!({ "key": bubble::space_key(&entry.exe), "name": entry.name }));
        }
        None => {
            leave_space(&main);
            let _ = app.emit_to("main", "open-space", serde_json::json!({ "key": null }));
            // Maximized, it already fills the screen: nothing to place.
            if near_bubble && !main.is_maximized().unwrap_or(false) {
                place_main_near(app);
            }
        }
    }
    show_main(app);
}

/// Opens the main window next to the bubble: above it when there's room, otherwise below,
/// lined up with the bubble's side of the screen and kept inside the work area.
fn place_main_near(app: &AppHandle) {
    let (Some(main), Some(b)) = (app.get_webview_window("main"), bubble::window(app)) else { return };
    let (Ok(m), Ok(bp)) = (main.outer_size(), b.outer_position()) else { return };
    // The screen the bubble is on, so the app opens next to it even on a second monitor.
    let Some((wa, size, scale)) = bubble::work_area_at(app, bp.x + bubble::side(app) / 2, bp.y + bubble::side(app) / 2).or_else(|| bubble::work_area(app))
    else {
        return;
    };
    let s = (SIZE * scale) as i32;
    let gap = (8.0 * scale) as i32;
    let (mw, mh) = (m.width as i32, m.height as i32);
    let (left, top) = (wa.x, wa.y);
    let (right, bottom) = (wa.x + size.width as i32, wa.y + size.height as i32);

    let on_right = bp.x + s / 2 > (left + right) / 2;
    let x = if on_right { bp.x + s - mw } else { bp.x };
    let y = if bp.y - gap - mh >= top { bp.y - gap - mh } else { bp.y + s + gap };
    let _ = main.set_position(PhysicalPosition::new(
        x.clamp(left, (right - mw).max(left)),
        y.clamp(top, (bottom - mh).max(top)),
    ));
}

/// Back to the general list: no walls, and the general window's own size and spot.
fn leave_space(main: &tauri::WebviewWindow) {
    win::HOST.store(0, Ordering::Relaxed);
    let left = placement().space.take().is_some();
    let general = placement().general;
    if let (true, Some((x, y, w, h))) = (left, general) {
        set_visible_frame(main, x, y, w as i32, h as i32);
    }
}

/// Tray click (or its menu's Show): the general list, just inside the work area next to the
/// tray, brought to the front so the tray's hidden-icons popup closes.
pub fn open_from_tray(app: &AppHandle, (x, y): (i32, i32)) {
    let Some(main) = app.get_webview_window("main") else { return };
    remember_app_window(app);
    leave_space(&main);
    let _ = app.emit_to("main", "open-space", serde_json::json!({ "key": null }));
    let monitor = app.available_monitors().ok().and_then(|ms| {
        ms.into_iter().find(|m| {
            let (p, s) = (m.position(), m.size());
            x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
        })
    });
    let frame = win::own_frame(&main).filter(|_| !main.is_maximized().unwrap_or(false));
    if let (Some(m), Some(f)) = (monitor, frame) {
        let (w, h) = (f.right - f.left, f.bottom - f.top);
        let wa = m.work_area();
        let (left, top) = (wa.position.x, wa.position.y);
        let (right, bottom) = (left + wa.size.width as i32, top + wa.size.height as i32);
        let (mp, ms) = (m.position(), m.size());
        let gap = (12.0 * m.scale_factor()) as i32;
        let along_x = (x - w / 2).clamp(left + gap, (right - w - gap).max(left + gap));
        let along_y = (y - h / 2).clamp(top + gap, (bottom - h - gap).max(top + gap));
        // Open against the taskbar, lined up with the tray icon. Ask Windows where the taskbar
        // really is: when it auto-hides, the work area is the whole screen.
        let on_this_screen = |r: &Rect| r.left < mp.x + ms.width as i32 && r.right > mp.x && r.top < mp.y + ms.height as i32 && r.bottom > mp.y;
        let (nx, ny) = match win::taskbar().filter(|(r, _)| on_this_screen(r)) {
            Some((r, 0)) => (r.right + gap, along_y),
            Some((r, 1)) => (along_x, r.bottom + gap),
            Some((r, 2)) => (r.left - w - gap, along_y),
            Some((r, _)) => (along_x, r.top - h - gap),
            None if top > mp.y => (along_x, top + gap),
            None if left > mp.x => (left + gap, along_y),
            None if right < mp.x + ms.width as i32 => (right - w - gap, along_y),
            None => (along_x, bottom - h - gap),
        };
        set_visible_frame(&main, nx, ny, w, h);
    }
    show_main(app);
    win::force_foreground(&main);
}

/// Places a window so its *visible* frame is exactly (x, y, w, h): Windows adds invisible resize
/// borders around it, so measure them and compensate. Never smaller than the main window's minimum.
fn set_visible_frame(w: &tauri::WebviewWindow, x: i32, y: i32, width: i32, height: i32) {
    let (Ok(outer), Ok(inner), Ok(size), Ok(s)) = (w.outer_position(), w.inner_size(), w.outer_size(), w.scale_factor()) else { return };
    let (bl, bt, extra_w, extra_h) = match win::own_frame(w) {
        Some(f) => (f.left - outer.x, f.top - outer.y, (f.right - f.left) - inner.width as i32, (f.bottom - f.top) - inner.height as i32),
        None => (0, 0, 0, 0),
    };
    // The minimum counts the whole window, invisible borders too (as Tauri's own does).
    let (min_w, min_h) = min_size(s);
    let min = (min_w - (size.width - inner.width) as i32, min_h - (size.height - inner.height) as i32);
    win::PLACING.store(true, Ordering::Relaxed);
    let _ = w.set_size(PhysicalSize::new((width - extra_w).max(min.0) as u32, (height - extra_h).max(min.1) as u32));
    let _ = w.set_position(PhysicalPosition::new(x - bl, y - bt));
    win::PLACING.store(false, Ordering::Relaxed);
}

/// If the main window is open as an app's Quicky, remember where it sits inside that app.
pub fn remember_app_window(app: &AppHandle) {
    let Some((exe, app_hwnd)) = placement().space.clone() else { return };
    let Some(main) = app.get_webview_window("main") else { return };
    if !main.is_visible().unwrap_or(false) {
        return;
    }
    let (Some(q), Some(rect)) = (win::own_frame(&main), win::frame(app_hwnd)) else { return };
    // Untouched since we placed it (keeps the cover-with-a-margin default), or opened over an app
    // too small to hold it: nothing to remember.
    if placement().placed_frame == Some(q) || win::HOST.load(Ordering::Relaxed) == 0 {
        return;
    }
    let insets = [
        (q.left - rect.left).max(0),
        (q.top - rect.top).max(0),
        (rect.right - q.right).max(0),
        (rect.bottom - q.bottom).max(0),
    ];
    let _ = update_config(app, |c| {
        if let Some(s) = c.stuck_apps.iter_mut().find(|s| s.exe.eq_ignore_ascii_case(&exe)) {
            s.area = Some(insets);
        }
    });
}

/// Pinned (📌) keeps the window open when it loses focus.
pub static PINNED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn set_pinned(pinned: bool) {
    PINNED.store(pinned, Ordering::Relaxed);
}

/// Quicky is a popover: when the main window loses focus to another app, it tucks itself away
/// and the bubble / the app's mini comes back. Its own dialogs and pickers don't count.
pub fn on_main_blur(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(180));
        let Some(main) = app.get_webview_window("main") else { return };
        if PINNED.load(Ordering::Relaxed) || main.is_focused().unwrap_or(true) || !main_on_screen(&app) {
            return;
        }
        if win::foreground_is_related(&main) {
            return;
        }
        let _ = app.emit_to("main", "flush", ());
        remember_app_window(&app);
        let _ = main.hide();
        bubble::sync(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_min_size_matches_the_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = conf["app"]["windows"].as_array().unwrap().iter().find(|w| w["label"] == "main").unwrap();
        assert_eq!((main["minWidth"].as_f64(), main["minHeight"].as_f64()), (Some(MAIN_MIN.0), Some(MAIN_MIN.1)));
    }
}
