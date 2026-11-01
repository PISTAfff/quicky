//! The little always-on-top Quicky bubble: where it sits, when it shows, and sticking it to apps.
//!
//! There is one bubble window. It lives in one of two places:
//! - mini: when the focused app has its own mini Quicky (made by dropping the bubble on it), it
//!   shrinks and sits on that app's window at the chosen spot, following the window around;
//! - normal: everywhere else, at the spot the user dragged it to (or the bottom-left corner).
//! It glides between spots rather than jumping, and only shows while the main window is off
//! screen and no reminder is up.

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
    mini: Option<bool>,
    /// A "dividing" animation is playing in the page; hold everything still until it ends.
    split_until: Option<Instant>,
    /// A mini is being dragged around inside its app (the app's window is its walls).
    wall: Option<WallDrag>,
}

struct WallDrag {
    exe: String,
    rect: Rect,
    start: (i32, i32),
    at: (i32, i32),
}

static STATE: Mutex<State> = Mutex::new(State {
    dragging: false,
    focus: None,
    at: None,
    goal: None,
    mini: None,
    split_until: None,
    wall: None,
});

/// How quickly the bubble glides to a new spot (time constant, ms): small = snappy.
const GLIDE_MS: f64 = 70.0;

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

fn window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("bubble")
}

fn hwnd(app: &AppHandle) -> Option<win::Hwnd> {
    window(app)?.hwnd().ok().map(|h| h.0 as win::Hwnd)
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

/// Top-left to put the bubble at, and whether it's the mini (inside a focused app) or the normal one.
fn target(app: &AppHandle) -> Option<((i32, i32), bool)> {
    match active_stuck(app) {
        Some((entry, _, rect)) => {
            let (cx, cy) = stuck_spot(&entry, rect);
            let half = (MINI * scale(app) / 2.0) as i32;
            Some(((cx - half, cy - half), true))
        }
        None => normal_spot(app).map(|p| (p, false)),
    }
}

/// Works out where the bubble should be. Off screen (or forced) it jumps straight there; on
/// screen it only sets the goal and `glide` moves it there smoothly.
fn apply(app: &AppHandle, force: bool) {
    // Never yank it out from under the user's pointer (e.g. while a drag crosses screens),
    // and hold still while the page plays the dividing animation.
    {
        let st = state();
        if st.dragging || st.wall.is_some() || st.split_until.is_some_and(|t| Instant::now() < t) {
            return;
        }
    }
    let (Some(b), Some(h), Some((spot, mini))) = (window(app), hwnd(app), target(app)) else { return };
    let visible = b.is_visible().unwrap_or(false);
    let mut st = state();
    st.split_until = None;
    if force || st.mini != Some(mini) {
        // Switching between the normal bubble and an app's mini: resize around the same centre
        // (so it shrinks/grows in place, then glides), and tell the page.
        let old = b.outer_size().map(|s| s.width as f64).unwrap_or(0.0);
        let size = if mini { MINI } else { SIZE };
        let _ = b.set_size(LogicalSize::new(size, size));
        let new = size * scale(app);
        if let Some((x, y)) = st.at {
            let shift = (old - new) / 2.0;
            st.at = Some((x + shift, y + shift));
            win::move_to(h, (x + shift).round() as i32, (y + shift).round() as i32);
        }
        let _ = app.emit_to("bubble", "bubble-mini", mini);
        st.mini = Some(mini);
    }
    st.goal = Some(spot);
    if force || !visible || st.at.is_none() {
        win::move_to(h, spot.0, spot.1);
        st.at = Some((spot.0 as f64, spot.1 as f64));
    }
}

/// One step of gliding towards the goal. Returns true while still on the way.
fn glide(app: &AppHandle, dt_ms: f64) -> bool {
    let Some(h) = hwnd(app) else { return false };
    let mut st = state();
    if st.dragging || st.wall.is_some() {
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
        win::move_to(h, rx, ry);
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
    let (Some(b), Some(h)) = (window(app), hwnd(app)) else { return };
    let want = SHOW.load(Ordering::Relaxed) && !OVERLAY_UP.load(Ordering::Relaxed) && !main_on_screen(app);
    // Win32 both ways: showing must not steal focus, and Tauri's own show/hide bookkeeping
    // would get out of step if the two were mixed.
    if want != b.is_visible().unwrap_or(false) {
        win::show(h, want);
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
            let entry = StuckApp { exe: under.exe.clone(), name: pretty_name(&under.exe), right, bottom, dx, dy };
            let _ = update_config(app, |c| {
                c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(&entry.exe));
                c.stuck_apps.push(entry);
            });
            if is_new {
                // A new mini is born: Quicky divides, one half stays, the other heads home.
                let s = scale(app);
                let home = normal_spot(app).map(|(x, y)| (x + (SIZE * s / 2.0) as i32, y + (SIZE * s / 2.0) as i32));
                let (hx, hy) = home.map_or((0.0, 1.0), |(x, y)| ((x - center.0) as f64 / s, (y - center.1) as f64 / s));
                let _ = app.emit_to("bubble", "bubble-split", serde_json::json!({ "dx": hx, "dy": hy }));
                state().split_until = Some(Instant::now() + Duration::from_millis(1000));
            }
            state().focus = Some(under);
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
            let Some(h) = hwnd(&app) else { continue };

            // A walled mini drag whose page lost track of the mouse: finish it where it is.
            if state().wall.is_some() && !win::left_button_down() {
                mini_drag_end(app.clone());
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

            if !OVERLAY_UP.load(Ordering::Relaxed) && window(&app).is_some_and(|b| b.is_visible().unwrap_or(false)) {
                win::keep_topmost(h);
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

fn center(app: &AppHandle) -> Option<(i32, i32)> {
    let p = window(app)?.outer_position().ok()?;
    let s = side(app);
    Some((p.x + s / 2, p.y + s / 2))
}

fn pretty_name(exe: &str) -> String {
    let stem = Path::new(exe).file_stem().and_then(|s| s.to_str()).unwrap_or("app");
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

#[tauri::command]
pub fn get_bubble_locked(app: AppHandle) -> bool {
    read_config(&app).bubble_locked
}

#[tauri::command]
pub fn set_bubble_locked(app: AppHandle, locked: bool) -> Result<(), String> {
    update_config(&app, |c| c.bubble_locked = locked)
}

/// Puts the bubble back in the bottom-left corner.
#[tauri::command]
pub fn reset_bubble(app: AppHandle) -> Result<(), String> {
    update_config(&app, |c| c.bubble_pos = None)?;
    place(&app);
    Ok(())
}

/// Bubble click: open the app right next to wherever the bubble is.
#[tauri::command]
pub fn open_from_bubble(app: AppHandle) {
    place_main_near(&app);
    show_main(&app);
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
    state().wall = Some(WallDrag { exe: entry.exe, rect, start: (p.x, p.y), at: (p.x, p.y) });
    true
}

#[derive(Serialize)]
pub struct Push {
    x: f64,
    y: f64,
}

/// Moves the mini by the pointer's offset (logical px) but keeps it inside the app's window.
/// Returns how far past the wall the pointer is pushing (logical px), so the page can squash
/// the blob against it and pop it out when pushed hard enough.
#[tauri::command]
pub fn mini_drag_to(app: AppHandle, dx: f64, dy: f64) -> Push {
    let s = scale(&app);
    let side = side(&app);
    let Some(h) = hwnd(&app) else { return Push { x: 0.0, y: 0.0 } };
    let mut st = state();
    let Some(w) = st.wall.as_mut() else { return Push { x: 0.0, y: 0.0 } };
    let (wx, wy) = (w.start.0 as f64 + dx * s, w.start.1 as f64 + dy * s);
    let (l, t) = (w.rect.left as f64, w.rect.top as f64);
    let (r, b) = ((w.rect.right - side) as f64, (w.rect.bottom - side) as f64);
    let (x, y) = (wx.clamp(l, r.max(l)), wy.clamp(t, b.max(t)));
    let at = (x.round() as i32, y.round() as i32);
    if at != w.at {
        win::move_to(h, at.0, at.1);
        w.at = at;
    }
    st.at = Some((x, y));
    st.goal = Some(at);
    Push { x: (wx - x) / s, y: (wy - y) / s }
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
    let exe = state().wall.take().map(|w| w.exe).or_else(|| active_stuck(&app).map(|(e, _, _)| e.exe));
    if let Some(exe) = exe {
        let _ = update_config(&app, |c| c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(&exe)));
        let _ = app.emit("stuck-apps", ());
    }
    apply(&app, false);
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
    let entry = StuckApp { exe: under.exe.clone(), name: name.clone(), right, bottom, dx, dy };
    update_config(&app, |c| {
        c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(&entry.exe));
        c.stuck_apps.push(entry);
    })?;
    state().focus = Some(under);
    let _ = app.emit("stuck-apps", ());
    Ok(name)
}

#[tauri::command]
pub fn unstick_bubble(app: AppHandle, exe: String) -> Result<(), String> {
    update_config(&app, |c| c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(&exe)))?;
    let _ = app.emit("stuck-apps", ());
    apply(&app, true);
    Ok(())
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
            let entry = StuckApp { exe: String::new(), name: String::new(), right, bottom, dx, dy };
            assert_eq!(stuck_spot(&entry, rect), spot);
        }
        // Near the bottom-right: follows that corner when the window grows.
        let (right, bottom, dx, dy) = anchor(rect, (790, 610));
        let entry = StuckApp { exe: String::new(), name: String::new(), right, bottom, dx, dy };
        assert_eq!(stuck_spot(&entry, Rect { right: 1000, bottom: 800, ..rect }), (890, 710));
    }

    #[test]
    fn app_names_read_nicely() {
        assert_eq!(pretty_name(r"C:\Program Files\Google\Chrome\chrome.exe"), "Chrome");
        assert_eq!(pretty_name(r"C:\x\WINWORD.EXE"), "Winword");
    }
}
