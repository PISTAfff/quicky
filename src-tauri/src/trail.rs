//! The sticky trail: while the bubble is dragged (left or right button) a strand of goo stretches
//! from where it started to the bubble, drawn by `trail.html` in a click-through window covering
//! that screen. This side streams where the bubble is (the drag's own cursor offset while the
//! button is held, then the bubble's glide), and says how it ends:
//! - `merge`: a left drag let go, or a right drag dropped on an app: the puddle slurps into the
//!   bubble where it is;
//! - `back`: a right drag let go anywhere else: the bubble glides home along the strand.

use crate::bubble;
use crate::fx;
use crate::reminder::BROWSER_ARGS;
use crate::win;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "trail";
/// How often the strand hears where the bubble is.
const STEP: Duration = Duration::from_millis(12);

/// Which drag: a left drag moves the bubble, a right one carries it (home again unless it's
/// dropped on an app), and an app's mini is moved inside its app with either button.
#[derive(Clone, Copy, PartialEq)]
pub enum Drag {
    Move,
    Carry,
    Mini { right: bool },
}

static RUN: AtomicU64 = AtomicU64::new(0);
/// The drag going on now, for a page that loads after it started.
static START: Mutex<Option<Value>> = Mutex::new(None);

/// Makes the (hidden) window ahead of time, so the first drag shows its strand at once.
pub fn prewarm(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    let app = app.clone();
    // Never from the main thread inside a command (it deadlocks on Windows).
    std::thread::spawn(move || {
        let _ = build(&app);
    });
}

fn build(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("trail.html".into()))
        .title("Quicky")
        .additional_browser_args(BROWSER_ARGS)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .ok()?;
    let _ = w.set_ignore_cursor_events(true);
    Some(w)
}

/// All the screens together: the top-left and size (physical px) of the area they cover, and the
/// scale of the one under `at` (the strand can be dragged onto any of them).
type Desk = ((i32, i32), (u32, u32), f64);

fn desk(app: &AppHandle, (x, y): (i32, i32)) -> Option<Desk> {
    let screens = app.available_monitors().ok()?;
    let (mut l, mut t, mut r, mut b) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    let mut scale = None;
    for m in &screens {
        let (p, s) = (m.position(), m.size());
        let (w, h) = (s.width as i32, s.height as i32);
        (l, t, r, b) = (l.min(p.x), t.min(p.y), r.max(p.x + w), b.max(p.y + h));
        if x >= p.x && y >= p.y && x < p.x + w && y < p.y + h {
            scale = Some(m.scale_factor());
        }
    }
    (r > l && b > t).then(|| ((l, t), ((r - l) as u32, (b - t) as u32), scale.unwrap_or(1.0)))
}

/// A drag of the bubble (or a mini) began, its window centred at `center` (physical px).
pub fn start(app: &AppHandle, center: (i32, i32), drag: Drag) {
    if crate::config::read_config(app).trail_off {
        return;
    }
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let cursor0 = win::cursor();
    let off = (center.0 - cursor0.0, center.1 - cursor0.1);
    let half = bubble::side(app) / 2;
    let app = app.clone();
    std::thread::spawn(move || {
        let Some((origin, size, scale)) = desk(&app, center) else { return };
        let page = move |(x, y): (i32, i32)| json!({ "x": (x - origin.0) as f64 / scale, "y": (y - origin.1) as f64 / scale });
        let small = matches!(drag, Drag::Mini { .. });
        let hello = json!({ "run": run, "from": page(center), "small": small });
        *START.lock().unwrap_or_else(|e| e.into_inner()) = Some(hello.clone());
        let Some(w) = build(&app) else { return };
        let _ = w.set_position(PhysicalPosition::new(origin.0, origin.1));
        let _ = w.set_size(PhysicalSize::new(size.0, size.1));
        let _ = app.emit_to(LABEL, "trail-start", hello);
        win::show(&w, true);
        // Above other always-on-top windows too (a meeting's picture-in-picture, PowerToys'
        // Always On Top): showing alone leaves it under whichever came to the top last.
        win::keep_topmost(&w);
        // The bubbles stay on top of their own strand.
        for b in [bubble::window(&app), bubble::mini_window(&app)].into_iter().flatten() {
            win::keep_topmost(&b);
        }

        let right = matches!(drag, Drag::Carry | Drag::Mini { right: true });
        let held: fn() -> bool = if right { win::right_button_down } else { win::left_button_down };
        let mut at = center;
        let mut sent = None;
        let mut steps: u32 = 0;
        // A mini pushed out of its app pops (and is gone) while the button is still held.
        let pops = bubble::MINI_POPS.load(Ordering::SeqCst);
        let mut popped = false;
        while held() && RUN.load(Ordering::SeqCst) == run {
            if matches!(drag, Drag::Mini { .. }) && bubble::MINI_POPS.load(Ordering::SeqCst) != pops {
                popped = true;
                break;
            }
            // Where it really is when Quicky moves it (a carried bubble, a mini held in by its
            // app's walls); a left drag of the bubble on Windows is the system's, so the cursor.
            let (cx, cy) = win::cursor();
            at = match drag {
                Drag::Carry => bubble::carry_center(half),
                Drag::Mini { .. } => bubble::wall_center(),
                Drag::Move => None,
            }
            .unwrap_or((cx + off.0, cy + off.1));
            if sent != Some(at) {
                let _ = app.emit_to(LABEL, "trail-move", json!({ "run": run, "at": page(at) }));
                sent = Some(at);
            }
            // Something else that keeps itself on top (a picture-in-picture call) can climb back
            // over the strand: put it and the bubbles back on top now and then.
            steps += 1;
            if steps.is_multiple_of(40) {
                win::keep_topmost(&w);
                for b in [bubble::window(&app), bubble::mini_window(&app)].into_iter().flatten() {
                    win::keep_topmost(&b);
                }
            }
            std::thread::sleep(STEP);
        }
        if RUN.load(Ordering::SeqCst) != run {
            return;
        }
        *START.lock().unwrap_or_else(|e| e.into_inner()) = None;
        // Whatever happens to the page, the window goes away after a while (a page that loaded too
        // late to see this drag would never ask, and a see-through window over every screen slows
        // everything down).
        {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(4000));
                if RUN.load(Ordering::SeqCst) == run && let Some(w) = app.get_webview_window(LABEL) {
                    win::show(&w, false);
                }
            });
        }
        if popped {
            let _ = app.emit_to(LABEL, "trail-end", json!({ "run": run, "mode": "pop", "at": page(at) }));
            return;
        }
        if drag != Drag::Carry {
            let _ = app.emit_to(LABEL, "trail-end", json!({ "run": run, "mode": "merge", "at": page(at) }));
            return;
        }
        // A right drag: dropped on an app, Quicky divides there: the new mini stays and the twin
        // travels home along the strand (the fx overlay tells the page where it is); anywhere
        // else the bubble glides home along the strand.
        std::thread::sleep(Duration::from_millis(60));
        if fx::playing() {
            let _ = app.emit_to(LABEL, "trail-end", json!({ "run": run, "mode": "split", "at": page(at) }));
            return;
        }
        let _ = app.emit_to(LABEL, "trail-end", json!({ "run": run, "mode": "back", "at": page(at) }));
        let began = Instant::now();
        while began.elapsed() < Duration::from_millis(1100) && RUN.load(Ordering::SeqCst) == run {
            let Some(c) = bubble::glide_center(half) else { break };
            let _ = app.emit_to(LABEL, "trail-move", json!({ "run": run, "at": page(c) }));
            if (c.0 - center.0).abs() <= 2 && (c.1 - center.1).abs() <= 2 {
                break;
            }
            std::thread::sleep(STEP);
        }
        let _ = app.emit_to(LABEL, "trail-home", json!({ "run": run }));
    });
}

#[tauri::command]
pub fn get_trail(app: AppHandle) -> bool {
    !crate::config::read_config(&app).trail_off
}

/// Switches the sticky trail on or off (Settings).
#[tauri::command]
pub fn set_trail(app: AppHandle, on: bool) -> Result<(), String> {
    crate::config::update_config(&app, |c| c.trail_off = !on)
}

/// The drag going on now (the page asks once it's loaded).
#[tauri::command]
pub fn trail_state() -> Option<Value> {
    START.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The page finished its last animation: put the window away (unless a newer drag began).
#[tauri::command]
pub fn trail_done(app: AppHandle, run: u64) {
    if run == RUN.load(Ordering::SeqCst) && let Some(w) = app.get_webview_window(LABEL) {
        win::show(&w, false);
    }
}
