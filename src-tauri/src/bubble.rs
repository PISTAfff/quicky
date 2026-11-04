//! The little always-on-top Quicky bubbles: where they sit, when they show, and sticking them to apps.
//!
//! There are two bubble windows, both drawn by bubble.html:
//! - the bubble (`bubble`): Quicky's own, always at the spot the user dragged it to (or the
//!   bottom-left corner), counting the general list;
//! - the mini (`mini`): while the focused app has its own mini Quicky (made by dropping the
//!   bubble on it), a smaller blob on that app's window at the chosen spot, following the window
//!   around and counting that app's list.
//!
//! Both glide to their spots rather than jumping, and only show while the main window is off
//! screen and no reminder is up. Dragged with the left button the bubble just moves, wherever
//! it's let go; dragged with the right button it gives the app it's dropped on a mini.

use crate::balloon;
use crate::fx::{self, Kind};
use crate::menu;
use crate::win::{self, AppWindow, Rect};
use crate::config::{read_config, update_config, StuckApp};
use crate::main_window::{self, main_on_screen};
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Logical px; matches the bubble window in tauri.conf.json (room around the blob to bounce).
pub const SIZE: f64 = 104.0;
const MARGIN: f64 = -6.0; // the blob sits ~23 px inside its (roomy) window

pub static SHOW: AtomicBool = AtomicBool::new(true);
/// A full-screen reminder is up: keep the bubbles out of its way.
pub static OVERLAY_UP: AtomicBool = AtomicBool::new(false);

/// Logical px of the mini Quicky shown inside an app (smaller window, smaller blob).
pub const MINI: f64 = 64.0;

/// Window labels: Quicky's own bubble, and the mini of the app in front.
pub const BUBBLE_LABEL: &str = "bubble";
pub const MINI_LABEL: &str = "mini";

/// Logical px kept between the bubble's centre and a new mini's: their windows (half widths 52 and
/// 32) don't overlap, so neither hides the other or takes its clicks.
const APART: f64 = 88.0;

/// Where a bubble window is now (top-left, sub-pixel, for smooth gliding) and where it's heading.
struct Glide {
    at: Option<(f64, f64)>,
    goal: Option<(i32, i32)>,
}

struct State {
    /// The user is dragging the bubble; don't move it, save where it lands.
    dragging: bool,
    /// The bubble is being carried with the right button, to give an app a mini.
    carry: Option<Carry>,
    /// The last app (not Quicky) that had focus.
    focus: Option<AppWindow>,
    bubble: Glide,
    mini: Glide,
    /// Whose mini the mini window shows: None = not set yet, Some(None) = no app's (it's away),
    /// Some(Some(key)) = the app with that space key.
    space: Option<Option<String>>,
    /// A big moment (dividing, popping) is playing in the overlay: hold everything still.
    held: bool,
    /// A mini is being dragged around inside its app (the app's window is its walls).
    wall: Option<WallDrag>,
    /// Streaming the cursor to that window's page for a tug on it while it's locked.
    tracking: Option<&'static str>,
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
    /// The push last told to the page (logical px), so it only hears about changes.
    sent: (f64, f64),
    last: Instant,
    /// The mini window's width (physical px), the screen's scale and a way to move it: read once,
    /// since asking Tauri for them waits on the main thread.
    side: i32,
    scale: f64,
    mover: win::Mover,
}

/// The bubble carried with the right button to give the app it's dropped on a mini: where the
/// pointer and the window started and where the window is now (physical px). It follows the real
/// cursor, which keeps working after the pointer leaves the little bubble window.
struct Carry {
    cursor0: (i32, i32),
    start: (i32, i32),
    at: (i32, i32),
    mover: win::Mover,
}

/// How far past a wall (logical px) a mini must be pushed to pop out of its app.
const POP_AT: f64 = 90.0;

static STATE: Mutex<State> = Mutex::new(State {
    dragging: false,
    carry: None,
    focus: None,
    bubble: Glide { at: None, goal: None },
    mini: Glide { at: None, goal: None },
    space: None,
    held: false,
    wall: None,
    tracking: None,
});

/// How quickly a bubble glides to a new spot (time constant, ms): small = snappy.
const GLIDE_MS: f64 = 70.0;

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Quicky's own bubble.
pub(crate) fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(BUBBLE_LABEL)
}

/// The window that shows the focused app's mini.
pub(crate) fn mini_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MINI_LABEL)
}

/// Which of the two a page is, as a label that lives forever (for events back to it).
pub(crate) fn label_of(w: &WebviewWindow) -> &'static str {
    if w.label() == MINI_LABEL { MINI_LABEL } else { BUBBLE_LABEL }
}

/// Work area (screen minus taskbar) of the primary monitor, in physical px, plus its scale.
pub fn work_area(app: &AppHandle) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)> {
    let m = app.primary_monitor().ok()??;
    let wa = m.work_area();
    Some((wa.position, wa.size, m.scale_factor()))
}

/// Work area of whichever monitor contains a point (any monitor, not just the main one).
pub fn work_area_at(app: &AppHandle, x: i32, y: i32) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)> {
    app.available_monitors().ok()?.into_iter().find_map(|m| {
        let wa = m.work_area();
        let (p, s) = (wa.position, wa.size);
        let inside = x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32;
        inside.then(|| (p, s, m.scale_factor()))
    })
}

pub(crate) fn scale(app: &AppHandle) -> f64 {
    window(app)
        .and_then(|b| b.scale_factor().ok())
        .or_else(|| work_area(app).map(|w| w.2))
        .unwrap_or(1.0)
}

/// The bubble window's width in physical px.
pub(crate) fn side(app: &AppHandle) -> i32 {
    window(app)
        .and_then(|b| b.outer_size().ok())
        .map(|s| s.width as i32)
        .unwrap_or((SIZE * scale(app)) as i32)
}

/// The mini window's width in physical px.
fn mini_side(app: &AppHandle) -> i32 {
    mini_window(app)
        .and_then(|m| m.outer_size().ok())
        .map(|s| s.width as i32)
        .unwrap_or((MINI * scale(app)) as i32)
}

/// Centre of a bubble window (physical px).
fn center_of(w: &WebviewWindow) -> Option<(i32, i32)> {
    let p = w.outer_position().ok()?;
    let s = w.outer_size().ok()?.width as i32;
    Some((p.x + s / 2, p.y + s / 2))
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

/// A new mini's centre, moved out from under the bubble (centre `home`) when the two would
/// overlap: straight away from it, or towards the middle of the app if that leaves the app's
/// window. `reach` is the distance to keep, `half` the mini's half width (physical px).
fn clear_of(home: (i32, i32), rect: Rect, spot: (i32, i32), reach: f64, half: i32) -> (i32, i32) {
    let away = |(dx, dy): (f64, f64)| {
        let d = dx.hypot(dy).max(1e-6);
        let (x, y) = ((home.0 as f64 + dx / d * reach).round() as i32, (home.1 as f64 + dy / d * reach).round() as i32);
        let (l, t) = (rect.left + half, rect.top + half);
        (x.clamp(l, (rect.right - half).max(l)), y.clamp(t, (rect.bottom - half).max(t)))
    };
    let far = |(x, y): (i32, i32)| ((x - home.0) as f64).hypot((y - home.1) as f64) >= reach - 1.0;
    if far(spot) {
        return spot;
    }
    let mid = (((rect.left + rect.right) / 2 - home.0) as f64, ((rect.top + rect.bottom) / 2 - home.1) as f64);
    let off = ((spot.0 - home.0) as f64, (spot.1 - home.1) as f64);
    let first = if off.0.hypot(off.1) > 0.5 { away(off) } else { away(mid) };
    if far(first) { first } else { away(mid) }
}

/// A mini's spot in an app, kept clear of the bubble's own spot.
fn clear_of_home(app: &AppHandle, rect: Rect, spot: (i32, i32)) -> (i32, i32) {
    let Some(home) = home_center(app) else { return spot };
    let s = scale(app);
    clear_of(home, rect, spot, APART * s, (MINI * s / 2.0) as i32)
}

/// The stuck app currently in focus, with its window frame.
pub(crate) fn active_stuck(app: &AppHandle) -> Option<(StuckApp, AppWindow, Rect)> {
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

/// Top-left for the mini of the app in focus, and that app's space key.
fn mini_target(app: &AppHandle) -> Option<((i32, i32), String)> {
    let (entry, _, rect) = active_stuck(app)?;
    let (cx, cy) = stuck_spot(&entry, rect);
    let half = (MINI * scale(app) / 2.0) as i32;
    Some(((cx - half, cy - half), space_key(&entry.exe)))
}

/// Works out where both should be. Off screen (or forced) a window jumps straight there; on
/// screen it only gets a goal and `glide` moves it there smoothly.
fn apply(app: &AppHandle, force: bool) {
    // Never yank one out from under the user's pointer (e.g. while a drag crosses screens),
    // and hold still while the overlay plays a big moment.
    if !settled() {
        return;
    }
    if let (Some(b), Some(spot)) = (window(app), normal_spot(app)) {
        let visible = b.is_visible().unwrap_or(false);
        aim(&b, &mut state().bubble, spot, force || !visible);
    }
    let Some(m) = mini_window(app) else { return };
    let target = mini_target(app);
    let space = target.as_ref().map(|(_, key)| key.clone());
    let locked = locked_for(app, space.as_deref());
    let visible = m.is_visible().unwrap_or(false);
    let mut st = state();
    if force || st.space.as_ref() != Some(&space) {
        // Tell the page whose mini it is now (whose tasks its badge counts, and its lock).
        let _ = app.emit_to(MINI_LABEL, "bubble-mini", json!({ "space": space, "locked": locked }));
        st.space = Some(space);
    }
    if let Some((spot, _)) = target {
        aim(&m, &mut st.mini, spot, force || !visible);
    }
}

/// Points a window at `spot`: straight there when `jump`, otherwise `glide` takes it there.
fn aim(w: &WebviewWindow, g: &mut Glide, spot: (i32, i32), jump: bool) {
    g.goal = Some(spot);
    if jump || g.at.is_none() {
        win::move_to(w, spot.0, spot.1);
        g.at = Some((spot.0 as f64, spot.1 as f64));
    }
}

/// One step of gliding both towards their goals. Returns true while either is still on the way.
fn glide(app: &AppHandle, dt_ms: f64) -> bool {
    if !settled() {
        return false;
    }
    let k = 1.0 - (-dt_ms / GLIDE_MS).exp();
    let (b, m) = (window(app), mini_window(app));
    let mut st = state();
    let bubble = b.is_some_and(|b| step(&b, &mut st.bubble, k));
    let mini = m.is_some_and(|m| step(&m, &mut st.mini, k));
    bubble || mini
}

/// Moves a window a step (`k` of the way) towards its goal. Returns true while still on the way.
fn step(w: &WebviewWindow, g: &mut Glide, k: f64) -> bool {
    let (Some((x, y)), Some((gx, gy))) = (g.at, g.goal) else { return false };
    let (gx, gy) = (gx as f64, gy as f64);
    if (gx - x).abs() < 0.5 && (gy - y).abs() < 0.5 {
        return false;
    }
    let (mut nx, mut ny) = (x + (gx - x) * k, y + (gy - y) * k);
    if (gx - nx).abs() < 0.6 && (gy - ny).abs() < 0.6 {
        (nx, ny) = (gx, gy);
    }
    let (px, py) = (x.round() as i32, y.round() as i32);
    let (rx, ry) = (nx.round() as i32, ny.round() as i32);
    if (rx, ry) != (px, py) {
        win::move_to(w, rx, ry);
    }
    g.at = Some((nx, ny));
    true
}

/// Sizes both exactly and puts them where they belong (startup, reset, display changes).
pub fn place(app: &AppHandle) {
    for (w, size) in [(window(app), SIZE), (mini_window(app), MINI)] {
        let Some(w) = w else { continue };
        // Windows pads small captioned windows to a minimum width; drop that floor.
        let _ = w.set_min_size(Some(LogicalSize::new(1.0, 1.0)));
        let _ = w.set_size(LogicalSize::new(size, size));
    }
    apply(app, true);
}

/// Shown only while the app is off screen, no reminder is up, and the user wants them; the mini
/// only while the app in front has one. While the overlay plays a big moment the mini stays as it
/// is (the overlay shows or hides it at the handoff).
pub fn sync(app: &AppHandle) {
    let want = SHOW.load(Ordering::Relaxed) && !OVERLAY_UP.load(Ordering::Relaxed) && !main_on_screen(app);
    if let Some(b) = window(app) {
        show(app, &b, want);
    }
    let (held, has_mini) = {
        let st = state();
        (st.held, matches!(st.space, Some(Some(_))))
    };
    if let (false, Some(m)) = (held, mini_window(app)) {
        show(app, &m, want && has_mini);
    }
}

fn show(app: &AppHandle, w: &WebviewWindow, want: bool) {
    // Win32 both ways: showing must not steal focus, and Tauri's own show/hide bookkeeping
    // would get out of step if the two were mixed.
    if want != w.is_visible().unwrap_or(false) {
        win::show(w, want);
        // The page can't tell for itself: a hidden window's page still counts as visible.
        if want {
            let _ = app.emit_to(label_of(w), "bubble-shown", ());
        }
    }
}

/// Whether this bubble is on screen right now (for a moment the page wants the user to see).
#[tauri::command]
pub fn bubble_on_screen(window: WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false)
}

/// A left drag of the bubble ended: wherever it is now is its own spot, over an app or not (the
/// right button carries it to an app to give that app a mini).
fn save_drop(app: &AppHandle) {
    let Some(b) = window(app) else { return };
    let (Some(center), Ok(pos)) = (center_of(&b), b.outer_position()) else { return };
    {
        let mut st = state();
        st.bubble.at = Some((pos.x as f64, pos.y as f64));
        st.bubble.goal = None;
    }
    set_home(app, center);
}

/// Makes the spot centred at `center` (physical px) the bubble's own.
fn set_home(app: &AppHandle, center: (i32, i32)) {
    let normal = (SIZE * scale(app)) as i32;
    let spot = (center.0 - normal / 2, center.1 - normal / 2);
    let _ = update_config(app, |c| c.bubble_pos = Some(spot));
}

/// Runs a drag that follows the real cursor on a thread of its own, every few ms (the
/// housekeeping loop is too slow and busy for that): `step` while the button is held and it
/// returns true, then `end` once.
fn follow(app: &AppHandle, right: bool, step: fn(&AppHandle) -> bool, end: fn(&AppHandle)) {
    let app = app.clone();
    std::thread::spawn(move || {
        let held: fn() -> bool = if right { win::right_button_down } else { win::left_button_down };
        while held() && step(&app) {
            std::thread::sleep(Duration::from_millis(4));
        }
        end(&app);
    });
}

/// One step of carrying the bubble: it keeps the same offset from the real cursor.
fn carry_step(_app: &AppHandle) -> bool {
    let (cx, cy) = win::cursor();
    let (mover, at) = {
        let mut st = state();
        let Some(c) = st.carry.as_mut() else { return false };
        let at = (c.start.0 + cx - c.cursor0.0, c.start.1 + cy - c.cursor0.1);
        if at == c.at {
            return true;
        }
        c.at = at;
        let mover = c.mover.clone();
        st.bubble.at = Some((at.0 as f64, at.1 as f64));
        (mover, at)
    };
    mover.move_to(at.0, at.1);
    true
}

/// The right button came up: dropped on an app's window, that app gets its mini there (or its
/// mini moves there); anywhere else nothing changes. Either way the bubble goes back to its spot.
fn carry_end(app: &AppHandle) {
    let Some(at) = state().carry.as_ref().map(|c| c.at) else { return };
    let _ = app.emit_to(BUBBLE_LABEL, "bubble-carried", ());
    let half = side(app) / 2;
    let center = (at.0 + half, at.1 + half);
    {
        let mut st = state();
        st.bubble.at = Some((at.0 as f64, at.1 as f64));
        st.bubble.goal = None;
    }
    if let Some((under, rect)) = win::app_under(center.0, center.1).and_then(|w| win::frame(w.hwnd).map(|r| (w, r))) {
        let spot = clear_of_home(app, rect, center);
        if stick(app, &under, rect, spot).unwrap_or(false) && let Some(home) = home_center(app) {
            // A new mini is born: Quicky divides, one half stays as the mini, the other heads home.
            // (The overlay holds the bubble still before the carry ends, so it can't glide off first.)
            fx::play(app, Kind::Split, center, spot, home, Some(space_key(&under.exe)), (0.0, 0.0));
        }
    }
    state().carry = None;
}

/// Gives an app its mini centred at `spot` (or moves its mini there, keeping its window size and
/// lock). Returns true when the app had none.
fn stick(app: &AppHandle, under: &AppWindow, rect: Rect, spot: (i32, i32)) -> Result<bool, String> {
    let (right, bottom, dx, dy) = anchor(rect, spot);
    let old = read_config(app).stuck_apps.into_iter().find(|s| s.exe.eq_ignore_ascii_case(&under.exe));
    let is_new = old.is_none();
    let (area, locked) = old.map_or((None, false), |s| (s.area, s.locked));
    let entry = StuckApp { exe: under.exe.clone(), name: pretty_name(&under.exe), right, bottom, dx, dy, area, locked };
    update_config(app, |c| {
        c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(&entry.exe));
        c.stuck_apps.push(entry);
    })?;
    state().focus = Some(under.clone());
    let _ = app.emit("stuck-apps", ());
    Ok(is_new)
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
            // mini or the right-click menu is open (it watches for clicks elsewhere), and idle
            // slowly when neither is.
            let fast = !read_config(&app).stuck_apps.is_empty() || menu::is_open();
            std::thread::sleep(Duration::from_millis(if gliding { 16 } else if fast { 50 } else { 400 }));

            if last_tick.elapsed() >= Duration::from_secs(15) {
                last_tick = Instant::now();
                let _ = app.emit_to("main", "reminder-tick", ());
            }

            sync(&app);
            balloon::sync(&app);
            menu::watch(&app);

            // Tug on a locked bubble: stream the cursor to its page until the button comes up.
            let tracking = state().tracking;
            if let Some(label) = tracking {
                if win::left_button_down() {
                    let (x, y) = win::cursor();
                    let s = scale(&app);
                    let _ = app.emit_to(label, "pointer-at", json!({ "x": x as f64 / s, "y": y as f64 / s }));
                    gliding = true;
                    continue;
                }
                state().tracking = None;
                let _ = app.emit_to(label, "pointer-up", ());
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

            note_focus();

            // While its menu is open, the menu stays on top instead.
            if !OVERLAY_UP.load(Ordering::Relaxed) && !menu::is_open() {
                for w in [window(&app), mini_window(&app)].into_iter().flatten() {
                    if w.is_visible().unwrap_or(false) {
                        win::keep_topmost(&w);
                    }
                }
            }
            apply(&app, false);
            let dt = last_frame.elapsed().as_secs_f64() * 1000.0;
            last_frame = Instant::now();
            gliding = glide(&app, dt.min(100.0));
        }
    });
}

/// Centre of the bubble's own spot (physical px).
fn home_center(app: &AppHandle) -> Option<(i32, i32)> {
    let (x, y) = normal_spot(app)?;
    let half = (SIZE * scale(app) / 2.0) as i32;
    Some((x + half, y + half))
}

/// Held still while the overlay plays a big moment (see `fx`).
pub fn hold(on: bool) {
    state().held = on;
}

/// Not being dragged, moved, tugged around inside an app, or held for a big moment.
pub fn settled() -> bool {
    let st = state();
    !st.dragging && st.carry.is_none() && st.wall.is_none() && !st.held
}

/// The task space of the mini the mini window shows (None when no app's mini is up).
pub fn mini_space() -> Option<String> {
    state().space.clone().flatten()
}

/// After a big moment: straight into the new spots (the pages are still invisible).
pub fn settle(app: &AppHandle) {
    apply(app, true);
}

/// "chrome.exe" and "WINWORD.EXE" read as "Chrome" and "Winword"; names that already mix cases,
/// like macOS app bundles ("Visual Studio Code.app"), stay as they are.
fn pretty_name(exe: &str) -> String {
    // Either kind of separator: names are worked out the same way on every system.
    let file = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    let stem = file.rsplit_once('.').map_or(file, |(s, _)| s);
    let stem = if stem.is_empty() { "app" } else { stem };
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

/// Each mini has its own lock; `None` is the bubble's.
fn locked_for(app: &AppHandle, space: Option<&str>) -> bool {
    let cfg = read_config(app);
    match space {
        Some(key) => cfg.stuck_apps.iter().any(|s| s.locked && space_key(&s.exe) == key),
        None => cfg.bubble_locked,
    }
}

/// What a bubble page shows as when it loads: whose mini it is (None for the bubble) and whether
/// it's locked in place. The mini hears of later changes through `bubble-mini` events.
#[tauri::command]
pub fn bubble_mode(app: AppHandle, window: WebviewWindow) -> serde_json::Value {
    let space = if window.label() == MINI_LABEL { mini_space() } else { None };
    json!({ "space": space, "locked": locked_for(&app, space.as_deref()) })
}

/// Locks or unlocks the bubble (`space` = None) or the mini of that task space.
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
/// from the bubble it's the general list, right next to the bubble.
#[tauri::command]
pub fn open_from_bubble(app: AppHandle, window: WebviewWindow) {
    if window.label() == MINI_LABEL {
        main_window::open_for_context(&app, true);
    } else {
        main_window::open_general(&app, true);
    }
}

/// The task pinned to a bubble got done: the mini cheers when it's that app's task and the mini
/// is that app's, otherwise the bubble does (as soon as it's back on screen, if it's away now).
#[tauri::command]
pub fn bubble_cheer(app: AppHandle, space: Option<String>) {
    let to = if space.is_some() && space == mini_space() { MINI_LABEL } else { BUBBLE_LABEL };
    let _ = app.emit_to(to, "bubble-cheer", ());
}

/// Notes the app in front as the one Quicky is "for" (its mini, its list). Clicking a bubble or
/// Quicky itself keeps the previous one; anything else (another app, the desktop) replaces it.
pub fn note_focus() {
    if !win::foreground_is_ours() {
        state().focus = win::foreground_app();
    }
}

/// Called by the bubble right before it starts a native drag.
#[tauri::command]
pub fn bubble_drag_start() {
    state().dragging = true;
}

/// The bubble is being dragged with the right button: it follows the pointer, and dropped on an
/// app's window it gives that app a mini (a left drag just moves it).
#[tauri::command]
pub fn bubble_carry_start(app: AppHandle) {
    let Some(b) = window(&app) else { return };
    let (Ok(p), Some(mover)) = (b.outer_position(), win::Mover::new(&b)) else { return };
    state().carry = Some(Carry { cursor0: win::cursor(), start: (p.x, p.y), at: (p.x, p.y), mover });
    follow(&app, true, carry_step, carry_end);
}

// ---- dragging a mini inside its app ---------------------------------------------------------

/// Starts dragging the mini of the app in focus, with the left or the `right` button. Returns
/// false if that app has none now.
#[tauri::command]
pub fn mini_drag_start(app: AppHandle, right: Option<bool>) -> bool {
    let Some((entry, _, rect)) = active_stuck(&app) else { return false };
    let Some(m) = mini_window(&app) else { return false };
    let (Ok(p), Some(mover)) = (m.outer_position(), win::Mover::new(&m)) else { return false };
    let (side, scale) = (mini_side(&app), scale(&app));
    let right = right.unwrap_or(false);
    state().wall = Some(WallDrag {
        exe: entry.exe,
        rect,
        start: (p.x, p.y),
        at: (p.x, p.y),
        cursor0: win::cursor(),
        popped: false,
        strain: 0.0,
        push: (0.0, 0.0),
        sent: (0.0, 0.0),
        last: Instant::now(),
        side,
        scale,
        mover,
    });
    follow(&app, right, wall_step, wall_end);
    true
}

/// The button came up: that's the mini's new spot (unless it popped: `mini_pop` takes over).
fn wall_end(app: &AppHandle) {
    if state().wall.as_ref().is_some_and(|w| !w.popped) {
        mini_drag_end(app.clone());
        let _ = app.emit_to(MINI_LABEL, "bubble-calm", ());
    }
}

/// One step of a walled drag, from the real cursor: move inside the app's window, tell the page
/// how hard it's pushing against the wall (for the squash), and pop it when pushed hard enough.
fn wall_step(app: &AppHandle) -> bool {
    let (cx, cy) = win::cursor();
    let mut st = state();
    let Some(w) = st.wall.as_mut() else { return false };
    if w.popped {
        return true;
    }
    let (s, side) = (w.scale, w.side);
    let (wx, wy) = ((w.start.0 + cx - w.cursor0.0) as f64, (w.start.1 + cy - w.cursor0.1) as f64);
    let (l, t) = (w.rect.left as f64, w.rect.top as f64);
    let (r, b) = ((w.rect.right - side) as f64, (w.rect.bottom - side) as f64);
    let (x, y) = (wx.clamp(l, r.max(l)), wy.clamp(t, b.max(t)));
    let at = (x.round() as i32, y.round() as i32);
    let mover = (at != w.at).then(|| w.mover.clone());
    w.at = at;
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
    let (px, py) = (dx * strain * POP_AT, dy * strain * POP_AT);
    // At this rate only changes are worth telling the page.
    let tell = (px - w.sent.0).abs() > 0.5 || (py - w.sent.1).abs() > 0.5;
    if tell {
        w.sent = (px, py);
    }
    st.mini.at = Some((x, y));
    st.mini.goal = Some(at);
    drop(st);
    if let Some(m) = mover {
        m.move_to(at.0, at.1);
    }
    if tell {
        let _ = app.emit_to(MINI_LABEL, "wall-push", json!({ "x": px, "y": py }));
    }
    if popped {
        let _ = app.emit_to(MINI_LABEL, "bubble-pop", ());
    }
    true
}

/// While the button is held on a locked bubble, stream the real cursor position to its page so
/// tugging keeps working once the pointer leaves the little window.
#[tauri::command]
pub fn pointer_track_start(window: WebviewWindow) {
    state().tracking = Some(label_of(&window));
}

/// Drag finished inside the app: that's the mini's new spot.
#[tauri::command]
pub fn mini_drag_end(app: AppHandle) {
    let Some(w) = state().wall.take() else { return };
    let half = w.side / 2;
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
    let from = mini_window(&app).and_then(|m| center_of(&m));
    if let Some(exe) = &exe {
        let _ = update_config(&app, |c| c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(exe)));
        let _ = app.emit("stuck-apps", ());
    }
    match (from, home_center(&app)) {
        (Some(from), Some(home)) => fx::play(&app, Kind::Pop, from, from, home, exe.map(|e| space_key(&e)), push),
        _ => apply(&app, false),
    }
}

#[derive(Serialize)]
pub struct BubbleContext {
    exe: String,
    name: String,
    stuck: bool,
}

/// Which app the right-clicked bubble's menu is about: a mini's own app, or the app window under
/// the bubble (to offer it a mini).
#[tauri::command]
pub fn bubble_context(app: AppHandle, window: WebviewWindow) -> Option<BubbleContext> {
    if window.label() == MINI_LABEL {
        let (entry, _, _) = active_stuck(&app)?;
        return Some(BubbleContext { exe: entry.exe, name: entry.name, stuck: true });
    }
    let (x, y) = center_of(&window)?;
    let under = win::app_under(x, y)?;
    let stuck = read_config(&app).stuck_apps.iter().any(|s| s.exe.eq_ignore_ascii_case(&under.exe));
    Some(BubbleContext { name: pretty_name(&under.exe), exe: under.exe, stuck })
}

/// Gives the app window under the bubble a mini Quicky, right next to the bubble.
#[tauri::command]
pub fn stick_bubble(app: AppHandle) -> Result<String, String> {
    let center = window(&app).and_then(|b| center_of(&b)).ok_or("Bubble not found")?;
    let under = win::app_under(center.0, center.1).ok_or("Drag the bubble onto an app window first")?;
    let rect = win::frame(under.hwnd).ok_or("Couldn't read that window")?;
    let spot = clear_of_home(&app, rect, center);
    let name = pretty_name(&under.exe);
    if stick(&app, &under, rect, spot)? && let Some(home) = home_center(&app) {
        fx::play(&app, Kind::Split, center, spot, home, Some(space_key(&under.exe)), (0.0, 0.0));
    }
    Ok(name)
}

#[tauri::command]
pub fn unstick_bubble(app: AppHandle, exe: String) -> Result<(), String> {
    // Hiding the mini that's on screen right now: it puffs out and flies home.
    let key = space_key(&exe);
    let showing = mini_space().is_some_and(|k| k == key);
    let from = mini_window(&app).filter(|m| showing && m.is_visible().unwrap_or(false)).and_then(|m| center_of(&m));
    update_config(&app, |c| c.stuck_apps.retain(|s| !s.exe.eq_ignore_ascii_case(&exe)))?;
    let _ = app.emit("stuck-apps", ());
    match (from, home_center(&app)) {
        (Some(from), Some(home)) => fx::play(&app, Kind::Hide, from, from, home, Some(key), (0.0, 0.0)),
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
    fn new_minis_keep_clear_of_the_bubble() {
        let rect = Rect { left: 0, top: 0, right: 1920, bottom: 1040 };
        let home = (50, 990);
        let dist = |(x, y): (i32, i32)| ((x - home.0) as f64).hypot((y - home.1) as f64);
        // Far enough already: stays where it was dropped.
        assert_eq!(clear_of(home, rect, (400, 500), 60.0, 32), (400, 500));
        // A little to the right of the bubble: pushed further right, same line.
        let (x, y) = clear_of(home, rect, (70, 990), 60.0, 32);
        assert!(dist((x, y)) >= 59.0 && y == 990 && x > 70, "got {x},{y}");
        // Right on top of it ("Make a mini here"): towards the middle of the app.
        let (x, y) = clear_of(home, rect, home, 60.0, 32);
        assert!(dist((x, y)) >= 59.0 && x > home.0 && y < home.1, "got {x},{y}");
        // Pushing away would leave the app's window (bubble at its bottom-left): towards the middle instead.
        let (x, y) = clear_of(home, rect, (40, 1000), 60.0, 32);
        assert!(dist((x, y)) >= 59.0 && x >= 32 && y <= 1008, "got {x},{y}");
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
