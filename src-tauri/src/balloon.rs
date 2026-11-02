//! The speech balloon over a bubble: the pinned task (over its app's mini when that's the one up,
//! else over the bubble), or (while the pointer rests on the bubble or a mini) a peek at the top
//! tasks of its list. A small click-through window of its own, made the first time it's needed,
//! that follows its bubble around. Its words come from the main page.

use crate::bubble;
use crate::reminder::BROWSER_ARGS;
use crate::win;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "balloon";
/// Logical px: room for a three-line peek. The page draws the balloon at the end nearest Quicky
/// and leaves the rest transparent.
const W: f64 = 240.0;
const H: f64 = 124.0;

/// A task is pinned, and the list it's in (None: the general list).
static FOCUS: AtomicBool = AtomicBool::new(false);
static FOCUS_SPACE: Mutex<Option<String>> = Mutex::new(None);
/// The pointer is resting on a bubble, and which one.
static PEEK: AtomicBool = AtomicBool::new(false);
static PEEK_AT: Mutex<&'static str> = Mutex::new(bubble::BUBBLE_LABEL);
static SHOWN: AtomicBool = AtomicBool::new(false);
static BUILDING: AtomicBool = AtomicBool::new(false);
/// Where it was last put: (x, y, below the bubble, tail x in page px).
static LAST: Mutex<Option<(i32, i32, bool, i32)>> = Mutex::new(None);

#[tauri::command]
pub fn balloon_focus(app: AppHandle, on: bool, space: Option<String>) {
    FOCUS.store(on, Ordering::Relaxed);
    *FOCUS_SPACE.lock().unwrap_or_else(|e| e.into_inner()) = space;
    sync(&app);
}

#[tauri::command]
pub fn balloon_peek(app: AppHandle, window: WebviewWindow, on: bool) {
    if on {
        *PEEK_AT.lock().unwrap_or_else(|e| e.into_inner()) = bubble::label_of(&window);
    }
    PEEK.store(on, Ordering::Relaxed);
    let _ = app.emit_to(LABEL, "balloon-mode", mode());
    sync(&app);
}

/// The balloon page asks what to show when it loads.
#[tauri::command]
pub fn balloon_state() -> serde_json::Value {
    let (below, tail) = LAST.lock().unwrap_or_else(|e| e.into_inner()).map_or((false, (W / 2.0) as i32), |l| (l.2, l.3));
    json!({ "mode": mode(), "below": below, "tail": tail })
}

fn mode() -> serde_json::Value {
    let peek_at = *PEEK_AT.lock().unwrap_or_else(|e| e.into_inner());
    let space = if peek_at == bubble::MINI_LABEL { bubble::mini_space() } else { None };
    json!({ "peek": PEEK.load(Ordering::Relaxed), "space": space })
}

/// The bubble window the balloon belongs over: the one being peeked at; else the pinned task's
/// app's mini when that's the mini up, else the bubble. None while that one is off screen.
fn anchor(app: &AppHandle) -> Option<WebviewWindow> {
    let label = if PEEK.load(Ordering::Relaxed) {
        *PEEK_AT.lock().unwrap_or_else(|e| e.into_inner())
    } else {
        let space = FOCUS_SPACE.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if space.is_some() && space == bubble::mini_space() { bubble::MINI_LABEL } else { bubble::BUBBLE_LABEL }
    };
    app.get_webview_window(label).filter(|b| b.is_visible().unwrap_or(false))
}

/// Called every tick of the bubble loop: shown while there's something to say and its bubble is
/// on screen and still, kept next to it, hidden otherwise.
pub fn sync(app: &AppHandle) {
    let wanted = FOCUS.load(Ordering::Relaxed) || PEEK.load(Ordering::Relaxed);
    let bubble = if wanted && bubble::settled() { anchor(app) } else { None };
    let up = bubble.is_some();
    let Some(w) = app.get_webview_window(LABEL) else {
        if up {
            build(app);
        }
        return;
    };
    if !up {
        if SHOWN.swap(false, Ordering::Relaxed) {
            win::show(&w, false);
        }
        return;
    }
    if let Some(b) = bubble {
        place(app, &b, &w);
    }
    if !SHOWN.swap(true, Ordering::Relaxed) {
        win::show(&w, true);
        win::keep_topmost(&w);
    }
}

/// Above its bubble, centred on it and kept on its screen; below it when there's no room above.
fn place(app: &AppHandle, b: &WebviewWindow, w: &WebviewWindow) {
    let (Ok(bp), Ok(bs)) = (b.outer_position(), b.outer_size()) else { return };
    let side = bs.width as i32;
    let (cx, cy) = (bp.x + side / 2, bp.y + side / 2);
    let Some((wa, size, scale)) = bubble::work_area_at(app, cx, cy).or_else(|| bubble::work_area(app)) else { return };
    let (bw, bh) = ((W * scale) as i32, (H * scale) as i32);
    // The blob fills about the middle half of its window.
    let reach = (side as f64 * 0.27) as i32;
    let above = cy - reach - bh;
    let below = above < wa.y;
    let y = if below { cy + reach } else { above };
    let right = wa.x + size.width as i32 - bw;
    let x = (cx - bw / 2).clamp(wa.x, right.max(wa.x));
    let tail = ((cx - x) as f64 / scale).round() as i32;
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if *last == Some((x, y, below, tail)) {
        return;
    }
    win::move_to(w, x, y);
    let geometry_changed = last.is_none_or(|l| (l.2, l.3) != (below, tail));
    *last = Some((x, y, below, tail));
    drop(last);
    if geometry_changed {
        let _ = app.emit_to(LABEL, "balloon-geom", json!({ "below": below, "tail": tail }));
    }
}

fn build(app: &AppHandle) {
    if BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    // Windows can't be created from the main thread inside a command, so always a thread of its own.
    std::thread::spawn(move || {
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("balloon.html".into()))
            .title("Quicky")
            .additional_browser_args(BROWSER_ARGS)
            .inner_size(W, H)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build();
        if let Ok(w) = built {
            // Clicks go straight through to whatever is underneath.
            let _ = w.set_ignore_cursor_events(true);
        }
        *LAST.lock().unwrap_or_else(|e| e.into_inner()) = None;
        SHOWN.store(false, Ordering::Relaxed);
        BUILDING.store(false, Ordering::SeqCst);
    });
}
