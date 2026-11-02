//! Quicky's own right-click menu for the bubble and its minis, drawn in the app's colours (the
//! system menu can't follow Quicky's theme). The bubble page decides the items and runs the one
//! picked; this window only draws them. It's made, hidden, the first time the pointer reaches the
//! bubble, so the first right-click opens at once.

use crate::bubble;
use crate::reminder::BROWSER_ARGS;
use crate::win;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "menu";

static BUILDING: AtomicBool = AtomicBool::new(false);
static OPEN: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU32 = AtomicU32::new(0);
/// A request to open: its number, the items, and the pointer (physical px) it opens from.
type Request = (u32, Value, (i32, i32));
/// The latest request.
static PENDING: Mutex<Option<Request>> = Mutex::new(None);
/// The bubble window that opened the menu: it runs the pick and hears when the menu closes.
static OWNER: Mutex<&'static str> = Mutex::new(bubble::BUBBLE_LABEL);

fn owner() -> &'static str {
    *OWNER.lock().unwrap_or_else(|e| e.into_inner())
}

/// The pointer reached the bubble: get the window ready.
#[tauri::command]
pub fn menu_prewarm(app: AppHandle) {
    if app.get_webview_window(LABEL).is_none() {
        build(&app);
    }
}

/// A bubble page (the bubble or a mini): open the menu at the pointer with these items.
#[tauri::command]
pub fn bubble_menu_open(app: AppHandle, window: WebviewWindow, items: Value) {
    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    *OWNER.lock().unwrap_or_else(|e| e.into_inner()) = bubble::label_of(&window);
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some((seq, items.clone(), win::cursor()));
    if app.get_webview_window(LABEL).is_some() {
        let _ = app.emit_to(LABEL, "menu-items", json!({ "seq": seq, "items": items, "owner": owner() }));
    } else {
        build(&app);
    }
}

/// The menu page asks, once loaded, for a request sent before it was listening.
#[tauri::command]
pub fn menu_pending() -> Option<Value> {
    let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    pending.as_ref().map(|(seq, items, _)| json!({ "seq": seq, "items": items, "owner": owner() }))
}

/// The menu page has drawn the items and measured them (logical px): size the window, put it at
/// the pointer (flipped to stay on screen) and bring it to the front. Tells the page which way it
/// opened, for its pop.
#[tauri::command]
pub fn menu_show(app: AppHandle, seq: u32, width: f64, height: f64) -> Value {
    let at = {
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        match pending.take() {
            Some((s, _, at)) if s == seq => at,
            other => {
                *pending = other;
                return Value::Null;
            }
        }
    };
    let Some(w) = app.get_webview_window(LABEL) else { return Value::Null };
    let Some((wa, size, scale)) = bubble::work_area_at(&app, at.0, at.1).or_else(|| bubble::work_area(&app)) else {
        return Value::Null;
    };
    let menu = ((width * scale).ceil() as i32, (height * scale).ceil() as i32);
    let (x, y, left, up) = place(at, menu, (wa.x, wa.y, size.width as i32, size.height as i32));
    // Moved first: arriving on a screen with another scale makes Windows resize the window.
    win::move_to(&w, x, y);
    let _ = w.set_size(PhysicalSize::new(menu.0 as u32, menu.1 as u32));
    OPEN.store(true, Ordering::SeqCst);
    win::show(&w, true);
    win::keep_topmost(&w);
    // Focus lets it close when the user clicks anywhere else, and take the arrow keys. (Tauri's own
    // set_focus does nothing on Windows here: it was shown through `win::show`.)
    win::force_foreground(&w);
    json!({ "left": left, "up": up })
}

/// Picked, Esc, or focus went elsewhere.
#[tauri::command]
pub fn menu_hide(app: AppHandle) {
    hide(&app);
}

pub fn hide(app: &AppHandle) {
    if OPEN.swap(false, Ordering::SeqCst) && let Some(w) = app.get_webview_window(LABEL) {
        win::show(&w, false);
    }
    let _ = app.emit_to(owner(), "bubble-menu-closed", ());
}

pub fn is_open() -> bool {
    OPEN.load(Ordering::Relaxed)
}

/// Each tick of the bubble loop: close the menu on a click anywhere else (focus doesn't move the
/// same way on every system, so losing it can't be the only signal) or when its bubble goes away;
/// otherwise keep it above the bubble.
pub fn watch(app: &AppHandle) {
    if !is_open() {
        return;
    }
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let bubble_up = app.get_webview_window(owner()).is_some_and(|b| b.is_visible().unwrap_or(false));
    let (cx, cy) = win::cursor();
    let inside = win::own_frame(&w).is_some_and(|r| cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom);
    if !bubble_up || (win::left_button_down() && !inside) {
        hide(app);
    } else {
        win::keep_topmost(&w);
    }
}

/// Where the menu goes (all physical px): from the pointer down and to the right, flipped left or
/// up when it would leave the work area `(x, y, width, height)`, and kept inside it.
fn place(at: (i32, i32), menu: (i32, i32), area: (i32, i32, i32, i32)) -> (i32, i32, bool, bool) {
    let (ax, ay, aw, ah) = area;
    let left = at.0 + menu.0 > ax + aw;
    let up = at.1 + menu.1 > ay + ah;
    let x = if left { at.0 - menu.0 } else { at.0 };
    let y = if up { at.1 - menu.1 } else { at.1 };
    (x.clamp(ax, (ax + aw - menu.0).max(ax)), y.clamp(ay, (ay + ah - menu.1).max(ay)), left, up)
}

fn build(app: &AppHandle) {
    if BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    // Windows can't be created from the main thread inside a command, so always a thread of its own.
    std::thread::spawn(move || {
        let _ = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("menu.html".into()))
            .title("Quicky menu")
            .additional_browser_args(BROWSER_ARGS)
            .inner_size(200.0, 120.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .accept_first_mouse(true)
            .build();
        BUILDING.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::place;

    const AREA: (i32, i32, i32, i32) = (0, 0, 1920, 1040);

    #[test]
    fn opens_down_and_right_from_the_pointer() {
        assert_eq!(place((100, 200), (220, 180), AREA), (100, 200, false, false));
    }

    #[test]
    fn flips_away_from_the_edges() {
        // Near the bottom right corner: opens up and to the left of the pointer.
        assert_eq!(place((1900, 1000), (220, 180), AREA), (1680, 820, true, true));
        // Near the bottom only.
        assert_eq!(place((40, 1000), (220, 180), AREA), (40, 820, false, true));
    }

    #[test]
    fn stays_on_a_second_screen() {
        let right_screen = (1920, 0, 1920, 1040);
        assert_eq!(place((1925, 10), (220, 180), right_screen), (1925, 10, false, false));
        assert_eq!(place((3830, 10), (220, 180), right_screen), (3610, 10, true, false));
    }
}
