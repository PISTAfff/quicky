//! The little always-on-top Quicky bubble: where it sits, when it shows, and sticking it to apps.
//!
//! There is one bubble window. It lives in one of two places:
//! - mini: when the focused app has its own mini Quicky (made by dropping the bubble on it), it
//!   shrinks and sits on that app's window at the chosen spot, following the window around;
//! - normal: everywhere else, at the spot the user dragged it to (or the bottom-left corner).
//! It glides between spots rather than jumping, and only shows while the main window is off
//! screen and no reminder is up.

use crate::fx::{self, Kind};
use crate::win::{self, AppWindow, Rect};
use crate::{main_on_screen, read_config, show_main, update_config, StuckApp};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize};

/// Logical px; matches the bubble window in tauri.conf.json (room around the blob to bounce).
pub const SIZE: f64 = 104.0;
const MARGIN: f64 = -6.0; // the blob sits ~23 px inside its (roomy) window

pub static SHOW: AtomicBool = AtomicBool::new(true);
/// A full-screen reminder is up: keep the bubble out of its way.
pub static OVERLAY_UP: AtomicBool = AtomicBool::new(false);

/// Logical px of the mini Quicky shown inside an app (smaller window, smaller blob).
pub const MINI: f64 = 64.0;

struct State {
    /// The user is dragging the bubble; don't move it, save where it lands.
    dragging: bool,
    /// The last app (not Quicky) that had focus.
    focus: Option<AppWindow>,
    /// Where the window is now (top-left, sub-pixel, for smooth gliding) and where it's heading.
    at: Option<(f64, f64)>,
    goal: Option<(i32, i32)>,
    /// What the bubble is showing as: None = not set yet, Some(None) = the normal bubble,
    /// Some(Some(key)) = the mini of the app with that space key.
    mode: Option<Option<String>>,
    /// The main window is currently open as this app's Quicky (inside the app's window), and the
    /// frame we gave it, so we only remember a size the user actually changed.
    space: Option<(String, win::Hwnd)>,
    placed_frame: Option<Rect>,
    /// Size and spot of the general (non-app) window, to restore after an app's window.
    general: Option<(i32, i32, u32, u32)>,
    /// A big moment (dividing, popping) is playing in the overlay: hold everything still.
    held: bool,
    /// A mini is being dragged around inside its app (the app's window is its walls).
    wall: Option<WallDrag>,
    /// Streaming the cursor to the page for a tug on a locked bubble.
    tracking: bool,
}

struct WallDrag {
    exe: String,
    rect: Rect,
    start: (i32, i32),
    at: (i32, i32),
    /// Pointer position when the drag began (physical px): the drag follows the real cursor,
    /// which keeps working after the pointer leaves the little bubble window.
    cursor0: (i32, i32),
    popped: bool,
    /// Builds up while the mini is pressed against a wall (0..1); it pops at 1. Works even when
    /// the wall is the screen edge and the pointer can't go any further.
    strain: f64,
    /// Which way it's being pushed (unit length), for the burst.
    push: (f64, f64),
    last: Instant,
}

/// How far past a wall (logical px) a mini must be pushed to pop out of its app.
const POP_AT: f64 = 90.0;

static STATE: Mutex<State> = Mutex::new(State {
    dragging: false,
    focus: None,
    at: None,
    goal: None,
    mode: None,
    space: None,
    placed_frame: None,
    general: None,
    held: false,
    wall: None,
    tracking: false,
});

/// How quickly the bubble glides to a new spot (time constant, ms): small = snappy.
const GLIDE_MS: f64 = 70.0;

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

fn window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("bubble")
}

/// Work area (screen minus taskbar) of the primary monitor, in physical px, plus its scale.
pub fn work_area(app: &AppHandle) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)> {
    let m = app.primary_monitor().ok()??;
    let wa = m.work_area();
    Some((wa.position, wa.size, m.scale_factor()))
}

/// Work area of whichever monitor contains a point (any monitor, not just the main one).
fn work_area_at(app: &AppHandle, x: i32, y: i32) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)> {
    app.available_monitors().ok()?.into_iter().find_map(|m| {
        let wa = m.work_area();
        let (p, s) = (wa.position, wa.size);
        let inside = x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32;
        inside.then(|| (p, s, m.scale_factor()))
    })
}

fn scale(app: &AppHandle) -> f64 {
    window(app)
        .and_then(|b| b.scale_factor().ok())
        .or_else(|| work_area(app).map(|w| w.2))
        .unwrap_or(1.0)
}

/// The bubble window's current width in physical px (normal or mini).
fn side(app: &AppHandle) -> i32 {
    window(app)
        .and_then(|b| b.outer_size().ok())
        .map(|s| s.width as i32)
        .unwrap_or((SIZE * scale(app)) as i32)
}

/// Spot the user dragged it to, nudged fully onto whichever screen it's mostly on. Falls back to
/// the main screen's bottom-left corner only if that screen is gone.
fn normal_spot(app: &AppHandle) -> Option<(i32, i32)> {
    if let Some((x, y)) = read_config(app).bubble_pos {
        let half = (SIZE / 2.0) as i32;
        if let Some((pos, size, scale)) = work_area_at(app, x + half, y + half) {
            let s = (SIZE * scale) as i32;
            let (right, bottom) = (pos.x + size.width as i32 - s, pos.y + size.height as i32 - s);
            return Some((x.clamp(pos.x, right.max(pos.x)), y.clamp(pos.y, bottom.max(pos.y))));
        }
    }
    let (pos, size, scale) = work_area(app)?;
    Some((pos.x + (MARGIN * scale) as i32, pos.y + size.height as i32 - ((SIZE + MARGIN) * scale) as i32))
}

/// Where the mini sits in an app: its centre as an offset from the app window's nearest corner,
/// so it stays put when the window moves or resizes.
fn anchor(rect: Rect, (cx, cy): (i32, i32)) -> (bool, bool, i32, i32) {
    let right = cx - rect.left > rect.right - cx;
    let bottom = cy - rect.top > rect.bottom - cy;
    let dx = cx - if right { rect.right } else { rect.left };
    let dy = cy - if bottom { rect.bottom } else { rect.top };
    (right, bottom, dx, dy)
}

/// Centre of the mini for an app whose window is at `rect`.
fn stuck_spot(entry: &StuckApp, rect: Rect) -> (i32, i32) {
    let x = if entry.right { rect.right } else { rect.left } + entry.dx;
    let y = if entry.bottom { rect.bottom } else { rect.top } + entry.dy;
    (x, y)
}

/// The stuck app currently in focus, with its window frame.
fn active_stuck(app: &AppHandle) -> Option<(StuckApp, AppWindow, Rect)> {
    let focus = state().focus.clone()?;
    let entry = read_config(app).stuck_apps.into_iter().find(|s| s.exe.eq_ignore_ascii_case(&focus.exe))?;
    if !win::usable(focus.hwnd) {
        return None;
    }
    let rect = win::frame(focus.hwnd)?;
    Some((entry, focus, rect))
}

/// The task-space key for an app (its .exe path, lower-cased).
pub fn space_key(exe: &str) -> String {
    exe.to_lowercase()
}

/// Top-left to put the bubble at, and which app's mini it is (None = the normal bubble).
fn target(app: &AppHandle) -> Option<((i32, i32), Option<String>)> {
    match active_stuck(app) {
        Some((entry, _, rect)) => {
            let (cx, cy) = stuck_spot(&entry, rect);
            let half = (MINI * scale(app) / 2.0) as i32;
            Some(((cx - half, cy - half), Some(space_key(&entry.exe))))
        }
        None => normal_spot(app).map(|p| (p, None)),
    }
}

/// Works out where the bubble should be. Off screen (or forced) it jumps straight there; on
/// screen it only sets the goal and `glide` moves it there smoothly.
fn apply(app: &AppHandle, force: bool) {
    // Never yank it out from under the user's pointer (e.g. while a drag crosses screens),
    // and hold still while the overlay plays a big moment.
    {
        let st = state();
        if st.dragging || st.wall.is_some() || st.held {
            return;
        }
    }
    let (Some(b), Some((spot, space))) = (window(app), target(app)) else { return };
    let mini = space.is_some();
    let locked = locked_for(app, space.as_deref());
    let visible = b.is_visible().unwrap_or(false);
    let mut st = state();
    let was_mini = st.mode.as_ref().map(|m| m.is_some());
    if force || was_mini != Some(mini) {
        // Switching between the normal bubble and an app's mini: resize around the same centre
        // (so it shrinks/grows in place, then glides).
        let old = b.outer_size().map(|s| s.width as f64).unwrap_or(0.0);
        let size = if mini { MINI } else { SIZE };
        let _ = b.set_size(LogicalSize::new(size, size));
        let new = size * scale(app);
        if let Some((x, y)) = st.at {
            let shift = (old - new) / 2.0;
            st.at = Some((x + shift, y + shift));
            win::move_to(&b, (x + shift).round() as i32, (y + shift).round() as i32);
        }
    }
    if force || st.mode.as_ref() != Some(&space) {
        // Tell the page which it is now (and whose task count to show on the badge).
        let _ = app.emit_to("bubble", "bubble-mini", serde_json::json!({ "mini": mini, "space": space, "locked": locked }));
        st.mode = Some(space);
    }
    st.goal = Some(spot);
    if force || !visible || st.at.is_none() {
        win::move_to(&b, spot.0, spot.1);
        st.at = Some((spot.0 as f64, spot.1 as f64));
    }
}

/// One step of gliding towards the goal. Returns true while still on the way.
fn glide(app: &AppHandle, dt_ms: f64) -> bool {
    let Some(b) = window(app) else { return false };
    let mut st = state();
    if st.dragging || st.wall.is_some() || st.held {
        return false;
    }
    let (Some((x, y)), Some((gx, gy))) = (st.at, st.goal) else { return false };
    let (gx, gy) = (gx as f64, gy as f64);
    if (gx - x).abs() < 0.5 && (gy - y).abs() < 0.5 {
        return false;
    }
    let k = 1.0 - (-dt_ms / GLIDE_MS).exp();
    let (mut nx, mut ny) = (x + (gx - x) * k, y + (gy - y) * k);
    if (gx - nx).abs() < 0.6 && (gy - ny).abs() < 0.6 {
        (nx, ny) = (gx, gy);
    }
    let (px, py) = (x.round() as i32, y.round() as i32);
    let (rx, ry) = (nx.round() as i32, ny.round() as i32);
    if (rx, ry) != (px, py) {
        win::move_to(&b, rx, ry);
    }
    st.at = Some((nx, ny));
    true
}

/// Sizes the bubble exactly and puts it where it belongs (startup, reset, display changes).
pub fn place(app: &AppHandle) {
    if let Some(b) = window(app) {
        // Windows pads small captioned windows to a minimum width; drop that floor.
        let _ = b.set_min_size(Some(LogicalSize::new(1.0, 1.0)));
    }
    apply(app, true);
}

/// Shown only while the app is off screen, no reminder is up, and the user wants it.
pub fn sync(app: &AppHandle) {
    let Some(b) = window(app) else { return };
    let want = SHOW.load(Ordering::Relaxed) && !OVERLAY_UP.load(Ordering::Relaxed) && !main_on_screen(app);
    // Win32 both ways: showing must not steal focus, and Tauri's own show/hide bookkeeping
    // would get out of step if the two were mixed.
    if want != b.is_visible().unwrap_or(false) {
        win::show(&b, want);
    }
}

/// Where a drag ended decides what happens:
/// - dropped on an app's window: that app gets (or moves) its mini Quicky to that spot;
/// - dropped on the desktop: it's the normal bubble's new spot, and if it was an app's mini that
///   was dragged out, that app no longer has one.
fn save_drop(app: &AppHandle) {
    let Some(pos) = window(app).and_then(|b| b.outer_position().ok()) else { return };
    let side = side(app);
    let center = (pos.x + side / 2, pos.y + side / 2);
    let was = active_stuck(app).map(|(entry, _, _)| entry.exe);
    match win::app_under(center.0, center.1).and_then(|w| win::frame(w.hwnd).map(|r| (w, r))) {
        Some((under, rect)) => {
            let (right, bottom, dx, dy) = anchor(rect, center);
            let is_new = !read_config(app).stuck_apps.iter().any(|s| s.exe.eq_ignore_ascii_case(&under.exe));
            // Moving an existing mini keeps its window size and its lock.
            let old = read_config(app).stuck_apps.into_iter().find(|s| s.exe.eq_ignore_ascii_case(&under.exe));
            let (area, locked) = old.map_or((None, false), |s| (s.area, s.locked));
            let entry = StuckApp { exe: under.exe.clone(), name: pretty_name(&under.exe), right, bottom, dx, dy, area, locked };
            let _ = update_config(app, |c| {
                c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(&entry.exe));
                c.stuck_apps.push(entry);
            });
            state().focus = Some(under.clone());
            if is_new {
                // A new mini is born: Quicky divides, one half stays, the other heads home.
                if let Some(home) = home_center(app) {
                    let mut st = state();
                    st.at = Some((pos.x as f64, pos.y as f64));
                    st.goal = None;
                    drop(st);
                    let _ = app.emit("stuck-apps", ());
                    fx::play(app, Kind::Split, center, home, Some(space_key(&under.exe)), (0.0, 0.0));
                    return;
                }
            }
        }
        None => {
            let normal = (SIZE * scale(app)) as i32;
            let spot = (center.0 - normal / 2, center.1 - normal / 2);
            let _ = update_config(app, |c| {
                if let Some(w) = &was {
                    c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(w));
                }
                c.bubble_pos = Some(spot);
            });
        }
    }
    let _ = app.emit("stuck-apps", ());
    let mut st = state();
    st.at = Some((pos.x as f64, pos.y as f64));
    st.goal = None;
}

/// Background loop: drag tracking, focus tracking, staying on top of the taskbar, following a
/// stuck app's window, and nudging the main page to check reminders.
pub fn housekeeping(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last_tick = Instant::now();
        let mut last_frame = Instant::now();
        let mut gliding = false;
        loop {
            // ~60 fps while gliding; otherwise follow windows quickly only when some app has a
            // mini, and idle slowly when none does.
            let fast = !read_config(&app).stuck_apps.is_empty();
            std::thread::sleep(Duration::from_millis(if gliding { 16 } else if fast { 50 } else { 400 }));

            if last_tick.elapsed() >= Duration::from_secs(15) {
                last_tick = Instant::now();
                let _ = app.emit_to("main", "reminder-tick", ());
            }

            sync(&app);
            let Some(b) = window(&app) else { continue };

            // A walled mini drag whose page lost track of the mouse: finish it where it is.
            // Walled drag of a mini: follow the real cursor until the button comes up.
            if state().wall.is_some() {
                if win::left_button_down() {
                    wall_step(&app);
                    gliding = true; // keep the loop at ~60 fps
                    continue;
                }
                mini_drag_end(app.clone());
                let _ = app.emit_to("bubble", "bubble-calm", ());
            }
            // Tug on a locked bubble: stream the cursor to the page until the button comes up.
            if state().tracking {
                if win::left_button_down() {
                    let (x, y) = win::cursor();
                    let s = scale(&app);
                    let _ = app.emit_to("bubble", "pointer-at", serde_json::json!({ "x": x as f64 / s, "y": y as f64 / s }));
                    gliding = true;
                    continue;
                }
                state().tracking = false;
                let _ = app.emit_to("bubble", "pointer-up", ());
            }

            let dragging = state().dragging;
            if dragging {
                if win::left_button_down() {
                    continue;
                }
                state().dragging = false;
                save_drop(&app);
                continue;
            }

            // Clicking the bubble or the app itself keeps the previous context; anything else
            // (another app, the desktop) replaces it.
            if !win::foreground_is_ours() {
                state().focus = win::foreground_app();
            }

            if !OVERLAY_UP.load(Ordering::Relaxed) && b.is_visible().unwrap_or(false) {
                win::keep_topmost(&b);
            }
            apply(&app, false);
            let dt = last_frame.elapsed().as_secs_f64() * 1000.0;
            last_frame = Instant::now();
            gliding = glide(&app, dt.min(100.0));
        }
    });
}

/// Opens the main window next to the bubble: above it when there's room, otherwise below,
/// lined up with the bubble's side of the screen and kept inside the work area.
fn place_main_near(app: &AppHandle) {
    let (Some(main), Some(b)) = (app.get_webview_window("main"), window(app)) else { return };
    let (Ok(m), Ok(bp)) = (main.outer_size(), b.outer_position()) else { return };
    // The screen the bubble is on, so the app opens next to it even on a second monitor.
    let Some((wa, size, scale)) = work_area_at(app, bp.x + side(app) / 2, bp.y + side(app) / 2).or_else(|| work_area(app))
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

/// Centre of the normal bubble's spot (physical px).
fn home_center(app: &AppHandle) -> Option<(i32, i32)> {
    let (x, y) = normal_spot(app)?;
    let half = (SIZE * scale(app) / 2.0) as i32;
    Some((x + half, y + half))
}

/// Held still while the overlay plays a big moment (see `fx`).
pub fn hold(on: bool) {
    state().held = on;
}

/// After a big moment: straight into the new form and spot (the page is still invisible).
pub fn settle(app: &AppHandle) {
    apply(app, true);
}

fn center(app: &AppHandle) -> Option<(i32, i32)> {
    let p = window(app)?.outer_position().ok()?;
    let s = side(app);
    Some((p.x + s / 2, p.y + s / 2))
}

/// "chrome.exe" and "WINWORD.EXE" read as "Chrome" and "Winword"; names that already mix cases,
/// like macOS app bundles ("Visual Studio Code.app"), stay as they are.
fn pretty_name(exe: &str) -> String {
    let stem = Path::new(exe).file_stem().and_then(|s| s.to_str()).unwrap_or("app");
    if stem.chars().any(char::is_uppercase) && stem.chars().any(char::is_lowercase) {
        return stem.to_string();
    }
    let mut c = stem.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase()).unwrap_or_default()
}

// ---- commands -----------------------------------------------------------------------------

#[tauri::command]
pub fn get_show_bubble(app: AppHandle) -> bool {
    read_config(&app).show_bubble
}

#[tauri::command]
pub fn set_show_bubble(app: AppHandle, show: bool) -> Result<(), String> {
    update_config(&app, |c| c.show_bubble = show)?;
    SHOW.store(show, Ordering::Relaxed);
    let _ = app.emit("bubble-pref", show);
    sync(&app);
    Ok(())
}

/// Each mini has its own lock; `None` is the normal bubble's.
fn locked_for(app: &AppHandle, space: Option<&str>) -> bool {
    let cfg = read_config(app);
    match space {
        Some(key) => cfg.stuck_apps.iter().any(|s| s.locked && space_key(&s.exe) == key),
        None => cfg.bubble_locked,
    }
}

/// Whether the bubble, as it shows right now (normal or an app's mini), is locked in place.
#[tauri::command]
pub fn get_bubble_locked(app: AppHandle) -> bool {
    let mode = state().mode.clone().flatten();
    locked_for(&app, mode.as_deref())
}

/// Locks or unlocks the normal bubble (`space` = None) or the mini of that task space.
#[tauri::command]
pub fn set_bubble_locked(app: AppHandle, locked: bool, space: Option<String>) -> Result<(), String> {
    update_config(&app, |c| match &space {
        Some(key) => c.stuck_apps.iter_mut().filter(|s| space_key(&s.exe) == *key).for_each(|s| s.locked = locked),
        None => c.bubble_locked = locked,
    })
}

/// Puts the bubble back in the bottom-left corner.
#[tauri::command]
pub fn reset_bubble(app: AppHandle) -> Result<(), String> {
    update_config(&app, |c| c.bubble_pos = None)?;
    place(&app);
    Ok(())
}

/// Bubble click: open Quicky. From an app's mini that's the app's own Quicky, inside the app;
/// from the normal bubble it's the general list, right next to the bubble.
#[tauri::command]
pub fn open_from_bubble(app: AppHandle) {
    open_for_context(&app, true);
}

/// Opens Quicky for whatever the user is in: the focused app's own space if that app has a
/// mini, otherwise the general list.
pub fn open_for_context(app: &AppHandle, near_bubble: bool) {
    let Some(main) = app.get_webview_window("main") else { return };
    remember_app_window(app);
    // Only open inside an app whose window can hold Quicky (with its margin).
    let margin = (14.0 * scale(app)) as i32;
    let fits = |r: &Rect| r.right - r.left >= 260 + 2 * margin && r.bottom - r.top >= 160 + 2 * margin;
    match active_stuck(app).filter(|(_, _, rect)| fits(rect)) {
        Some((entry, focus, rect)) => {
            // Leaving the general window: remember its size and spot to restore later.
            if state().space.is_none() {
                if let Some(f) = win::own_frame(&main) {
                    state().general = Some((f.left, f.top, (f.right - f.left) as u32, (f.bottom - f.top) as u32));
                }
            }
            // Inside the app, covering it with a small margin unless the user resized it there.
            // From here on it can't be moved or resized past the app's edges.
            win::HOST.store(focus.hwnd, Ordering::Relaxed);
            let [l, t, r, b] = entry.area.unwrap_or([margin; 4]).map(|v| v.max(0));
            let (x, y) = (rect.left + l, rect.top + t);
            let w = (rect.right - r - x).max(260);
            let h = (rect.bottom - b - y).max(160);
            set_visible_frame(&main, x, y, w, h);
            let mut st = state();
            st.space = Some((entry.exe.clone(), focus.hwnd));
            st.placed_frame = win::own_frame(&main);
            drop(st);
            let _ = app.emit_to("main", "open-space", serde_json::json!({ "key": space_key(&entry.exe), "name": entry.name }));
        }
        None => {
            leave_space(&main);
            let _ = app.emit_to("main", "open-space", serde_json::json!({ "key": null }));
            if near_bubble {
                place_main_near(app);
            }
        }
    }
    show_main(app);
}

/// Back to the general list: no walls, and the general window's own size and spot.
fn leave_space(main: &tauri::WebviewWindow) {
    win::HOST.store(0, Ordering::Relaxed);
    if state().space.take().is_some() {
        if let Some((x, y, w, h)) = state().general {
            set_visible_frame(main, x, y, w as i32, h as i32);
        }
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
    let frame = win::own_frame(&main);
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
/// borders around it, so measure them and compensate.
fn set_visible_frame(w: &tauri::WebviewWindow, x: i32, y: i32, width: i32, height: i32) {
    let (Ok(outer), Ok(inner)) = (w.outer_position(), w.inner_size()) else { return };
    let (bl, bt, extra_w, extra_h) = match win::own_frame(w) {
        Some(f) => (f.left - outer.x, f.top - outer.y, (f.right - f.left) - inner.width as i32, (f.bottom - f.top) - inner.height as i32),
        None => (0, 0, 0, 0),
    };
    win::PLACING.store(true, Ordering::Relaxed);
    let _ = w.set_size(PhysicalSize::new((width - extra_w).max(1) as u32, (height - extra_h).max(1) as u32));
    let _ = w.set_position(PhysicalPosition::new(x - bl, y - bt));
    win::PLACING.store(false, Ordering::Relaxed);
}

/// If the main window is open as an app's Quicky, remember where it sits inside that app.
pub fn remember_app_window(app: &AppHandle) {
    let Some((exe, app_hwnd)) = state().space.clone() else { return };
    let Some(main) = app.get_webview_window("main") else { return };
    if !main.is_visible().unwrap_or(false) {
        return;
    }
    let (Some(q), Some(rect)) = (win::own_frame(&main), win::frame(app_hwnd)) else { return };
    // Untouched since we placed it: nothing to remember (keeps the cover-with-a-margin default).
    if state().placed_frame == Some(q) {
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
        sync(&app);
    });
}

/// Called by the bubble right before it starts a native drag.
#[tauri::command]
pub fn bubble_drag_start() {
    state().dragging = true;
}

// ---- dragging a mini inside its app ---------------------------------------------------------

/// Starts dragging the mini of the app in focus. Returns false if the bubble isn't a mini now
/// (then the page drags the normal bubble freely instead).
#[tauri::command]
pub fn mini_drag_start(app: AppHandle) -> bool {
    let Some((entry, _, rect)) = active_stuck(&app) else { return false };
    let Some(p) = window(&app).and_then(|b| b.outer_position().ok()) else { return false };
    state().wall = Some(WallDrag { exe: entry.exe, rect, start: (p.x, p.y), at: (p.x, p.y), cursor0: win::cursor(), popped: false, strain: 0.0, push: (0.0, 0.0), last: Instant::now() });
    true
}

/// One step of a walled drag, from the real cursor: move inside the app's window, tell the page
/// how hard it's pushing against the wall (for the squash), and pop it when pushed hard enough.
fn wall_step(app: &AppHandle) {
    let s = scale(app);
    let side = side(app);
    let Some(bubble) = window(app) else { return };
    let (cx, cy) = win::cursor();
    let mut st = state();
    let Some(w) = st.wall.as_mut() else { return };
    if w.popped {
        return;
    }
    let (wx, wy) = ((w.start.0 + cx - w.cursor0.0) as f64, (w.start.1 + cy - w.cursor0.1) as f64);
    let (l, t) = (w.rect.left as f64, w.rect.top as f64);
    let (r, b) = ((w.rect.right - side) as f64, (w.rect.bottom - side) as f64);
    let (x, y) = (wx.clamp(l, r.max(l)), wy.clamp(t, b.max(t)));
    let at = (x.round() as i32, y.round() as i32);
    if at != w.at {
        win::move_to(&bubble, at.0, at.1);
        w.at = at;
    }
    // How hard it's being pushed: how far the pointer is past the mini's middle on each axis it's
    // pinned against a wall. Held there, strain builds up; let go of the wall and it relaxes.
    let now = Instant::now();
    let dt = now.duration_since(w.last).as_secs_f64().min(0.1);
    w.last = now;
    let half = side as f64 / 2.0;
    let pinned_x = wx < l || wx > r;
    let pinned_y = wy < t || wy > b;
    let ox = if pinned_x { (cx as f64 - (x + half)) / s } else { 0.0 };
    let oy = if pinned_y { (cy as f64 - (y + half)) / s } else { 0.0 };
    let reach = ox.hypot(oy);
    if reach > 12.0 {
        w.strain += dt * (0.45 + (reach / 90.0).min(1.5));
    } else {
        w.strain = (w.strain - dt * 2.5).max(0.0);
    }
    let far = ((wx - x) / s).hypot((wy - y) / s) / POP_AT; // big pushes where the screen allows
    let strain = w.strain.max(far * 0.8).min(1.0);
    let (dx, dy) = if reach > 0.5 { (ox / reach, oy / reach) } else { (0.0, 0.0) };
    let popped = strain >= 1.0;
    w.popped = popped;
    if reach > 0.5 {
        w.push = (dx, dy);
    }
    st.at = Some((x, y));
    st.goal = Some(at);
    drop(st);
    let (px, py) = (dx * strain * POP_AT, dy * strain * POP_AT);
    let _ = app.emit_to("bubble", "wall-push", serde_json::json!({ "x": px, "y": py }));
    if popped {
        let _ = app.emit_to("bubble", "bubble-pop", ());
    }
}

/// While the button is held on a locked bubble, stream the real cursor position to the page so
/// tugging keeps working once the pointer leaves the little window.
#[tauri::command]
pub fn pointer_track_start() {
    state().tracking = true;
}

/// Drag finished inside the app: that's the mini's new spot.
#[tauri::command]
pub fn mini_drag_end(app: AppHandle) {
    let Some(w) = state().wall.take() else { return };
    let half = side(&app) / 2;
    let (right, bottom, dx, dy) = anchor(w.rect, (w.at.0 + half, w.at.1 + half));
    let _ = update_config(&app, |c| {
        if let Some(s) = c.stuck_apps.iter_mut().find(|s| s.exe.eq_ignore_ascii_case(&w.exe)) {
            (s.right, s.bottom, s.dx, s.dy) = (right, bottom, dx, dy);
        }
    });
}

/// Pushed hard enough against the wall: the mini pops out and that app no longer has one
/// (drop Quicky on the app again to bring it back).
#[tauri::command]
pub fn mini_pop(app: AppHandle) {
    let wall = state().wall.take();
    let push = wall.as_ref().map_or((0.0, 0.0), |w| w.push);
    let exe = wall.map(|w| w.exe).or_else(|| active_stuck(&app).map(|(e, _, _)| e.exe));
    let from = center(&app);
    if let Some(exe) = &exe {
        let _ = update_config(&app, |c| c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(exe)));
        let _ = app.emit("stuck-apps", ());
    }
    match (from, home_center(&app)) {
        (Some(from), Some(home)) => fx::play(&app, Kind::Pop, from, home, exe.map(|e| space_key(&e)), push),
        _ => apply(&app, false),
    }
}

#[derive(Serialize)]
pub struct BubbleContext {
    exe: String,
    name: String,
    stuck: bool,
}

/// Which app the bubble's menu should offer to stick to (or unstick from).
#[tauri::command]
pub fn bubble_context(app: AppHandle) -> Option<BubbleContext> {
    if let Some((entry, _, _)) = active_stuck(&app) {
        return Some(BubbleContext { exe: entry.exe, name: entry.name, stuck: true });
    }
    let (x, y) = center(&app)?;
    let under = win::app_under(x, y)?;
    let stuck = read_config(&app).stuck_apps.iter().any(|s| s.exe.eq_ignore_ascii_case(&under.exe));
    Some(BubbleContext { name: pretty_name(&under.exe), exe: under.exe, stuck })
}

/// Sticks the bubble, right where it is, to the app window underneath it.
#[tauri::command]
pub fn stick_bubble(app: AppHandle) -> Result<String, String> {
    let (x, y) = center(&app).ok_or("Bubble not found")?;
    let under = win::app_under(x, y).ok_or("Drag the bubble onto an app window first")?;
    let rect = win::frame(under.hwnd).ok_or("Couldn't read that window")?;
    let (right, bottom, dx, dy) = anchor(rect, (x, y));
    let name = pretty_name(&under.exe);
    let old = read_config(&app).stuck_apps.into_iter().find(|s| s.exe.eq_ignore_ascii_case(&under.exe));
    let is_new = old.is_none();
    let (area, locked) = old.map_or((None, false), |s| (s.area, s.locked));
    let entry = StuckApp { exe: under.exe.clone(), name: name.clone(), right, bottom, dx, dy, area, locked };
    update_config(&app, |c| {
        c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(&entry.exe));
        c.stuck_apps.push(entry);
    })?;
    state().focus = Some(under.clone());
    let _ = app.emit("stuck-apps", ());
    if let (true, Some(home)) = (is_new, home_center(&app)) {
        fx::play(&app, Kind::Split, (x, y), home, Some(space_key(&under.exe)), (0.0, 0.0));
    }
    Ok(name)
}

#[tauri::command]
pub fn unstick_bubble(app: AppHandle, exe: String) -> Result<(), String> {
    // Hiding the mini that's on screen right now: it puffs out and flies home.
    let showing = state().mode.clone().flatten().is_some_and(|k| k == space_key(&exe))
        && window(&app).is_some_and(|b| b.is_visible().unwrap_or(false));
    let from = center(&app);
    update_config(&app, |c| c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(&exe)))?;
    let _ = app.emit("stuck-apps", ());
    match (showing, from, home_center(&app)) {
        (true, Some(from), Some(home)) => fx::play(&app, Kind::Hide, from, home, Some(space_key(&exe)), (0.0, 0.0)),
        _ => apply(&app, true),
    }
    Ok(())
}

/// An app's own icon as a data URL, for the task-list menu. Cached once found.
#[tauri::command]
pub async fn app_icon(exe: String) -> Option<String> {
    use base64::Engine as _;
    use std::collections::HashMap;
    static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);
    if let Some(hit) = CACHE.lock().ok()?.get_or_insert_with(HashMap::new).get(&exe) {
        return hit.clone();
    }
    let url = win::exe_icon_png(&exe, 48)
        .map(|png| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)));
    // Not cached when missing: on Linux the icon can only be read once a window of the app was seen.
    if url.is_some() {
        CACHE.lock().ok()?.get_or_insert_with(HashMap::new).insert(exe, url.clone());
    }
    url
}

#[derive(Serialize)]
pub struct StuckInfo {
    exe: String,
    name: String,
}

#[tauri::command]
pub fn stuck_apps(app: AppHandle) -> Vec<StuckInfo> {
    read_config(&app).stuck_apps.into_iter().map(|s| StuckInfo { exe: s.exe, name: s.name }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_to_the_nearest_corner_and_back() {
        let rect = Rect { left: 100, top: 100, right: 900, bottom: 700 };
        for spot in [(120, 130), (800, 120), (110, 600), (790, 610)] {
            let (right, bottom, dx, dy) = anchor(rect, spot);
            let entry = StuckApp { exe: String::new(), name: String::new(), right, bottom, dx, dy, area: None, locked: false };
            assert_eq!(stuck_spot(&entry, rect), spot);
        }
        // Near the bottom-right: follows that corner when the window grows.
        let (right, bottom, dx, dy) = anchor(rect, (790, 610));
        let entry = StuckApp { exe: String::new(), name: String::new(), right, bottom, dx, dy, area: None, locked: false };
        assert_eq!(stuck_spot(&entry, Rect { right: 1000, bottom: 800, ..rect }), (890, 710));
    }

    #[test]
    #[cfg(windows)]
    fn reads_a_real_app_icon_as_png() {
        let png = win::exe_icon_png(r"C:\Windows\explorer.exe", 48).expect("explorer has an icon");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(png.len() > 300, "suspiciously small icon: {} bytes", png.len());
    }

    #[test]
    fn app_names_read_nicely() {
        assert_eq!(pretty_name(r"C:\Program Files\Google\Chrome\chrome.exe"), "Chrome");
        assert_eq!(pretty_name(r"C:\x\WINWORD.EXE"), "Winword");
        assert_eq!(pretty_name("/Applications/Visual Studio Code.app"), "Visual Studio Code");
        assert_eq!(pretty_name("/usr/lib/firefox/firefox"), "Firefox");
    }
}
