//! Big bubble moments (dividing into a new app's mini, a mini popping out of its app or being
//! hidden) play in a short-lived, click-through overlay window covering the bubble and its home
//! spot, so they have room to move instead of being clipped to the little bubble window.
//!
//! The bubble page keeps its blob invisible while the overlay draws it (`bubble-veil`), and the
//! bubble holds still (`bubble::hold`). At the end the overlay asks for the handoff: the bubble
//! jumps to its new form and spot unseen, then shows again exactly where the overlay drew it.

use crate::bubble;
use crate::reminder::BROWSER_ARGS;
use crate::win;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "fx";
/// Room around the start and end points (logical px) for squashes, sparks and droplets.
const PAD: f64 = 240.0;

static PAYLOAD: Mutex<Option<Value>> = Mutex::new(None);
/// A moment is playing; another one asked for meanwhile just happens without an animation.
static ACTIVE: AtomicBool = AtomicBool::new(false);
static HANDED: AtomicBool = AtomicBool::new(false);
/// Which moment this is, so a late safety timeout can't end a newer one.
static RUN: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
pub enum Kind {
    /// Dropped on a new app: Quicky divides; one half becomes the app's mini, the other goes home.
    Split,
    /// A mini pushed out of its app: it bursts, and its droplets fly home and join back up.
    Pop,
    /// A mini hidden from its menu: a gentle puff, then the same trip home.
    Hide,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Split => "split",
            Kind::Pop => "pop",
            Kind::Hide => "hide",
        }
    }
}

/// Plays a moment from `from` to `to` (centres of the bubble window, physical px). The caller has
/// already changed the config; the bubble shows the result after the handoff. `space` is the
/// mini's task space, `push` the direction a popped mini was being pushed.
pub fn play(app: &AppHandle, kind: Kind, from: (i32, i32), to: (i32, i32), space: Option<String>, push: (f64, f64)) {
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return; // the moment already playing hands over to the latest state anyway
    }
    HANDED.store(false, Ordering::SeqCst);
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    bubble::hold(true);
    if !matches!(kind, Kind::Pop) {
        // A little wind-up while the overlay loads (a popped mini is already squashed flat).
        let _ = app.emit_to("bubble", "bubble-prep", ());
    }
    let app = app.clone();
    // Windows can't be created from the main thread inside a command (it deadlocks), so always
    // build it from a thread of its own.
    std::thread::spawn(move || {
        let scale = monitor_scale(&app, from).unwrap_or(1.0);
        let pad = (PAD * scale) as i32;
        let (left, top) = (from.0.min(to.0) - pad, from.1.min(to.1) - pad);
        let (right, bottom) = (from.0.max(to.0) + pad, from.1.max(to.1) + pad);
        let page = |(x, y): (i32, i32)| json!({ "x": (x - left) as f64 / scale, "y": (y - top) as f64 / scale });
        *PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(json!({ "kind": kind.name(), "from": page(from), "to": page(to), "space": space, "push": { "x": push.0, "y": push.1 } }));

        if let Some(old) = app.get_webview_window(LABEL) {
            let _ = old.destroy();
        }
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("fx.html".into()))
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
            .build();
        match built {
            Ok(w) => {
                let _ = w.set_position(PhysicalPosition::new(left, top));
                let _ = w.set_size(PhysicalSize::new((right - left) as u32, (bottom - top) as u32));
                // Clicks go straight through to whatever is underneath.
                let _ = w.set_ignore_cursor_events(true);
            }
            Err(_) => return finish(&app),
        }
        // Safety net: whatever happens to the page, the bubble always comes back.
        std::thread::sleep(Duration::from_millis(3500));
        if RUN.load(Ordering::SeqCst) == run && ACTIVE.load(Ordering::SeqCst) {
            finish(&app);
        }
    });
}

fn monitor_scale(app: &AppHandle, (x, y): (i32, i32)) -> Option<f64> {
    app.available_monitors().ok()?.into_iter().find_map(|m| {
        let (p, s) = (m.position(), m.size());
        (x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32).then(|| m.scale_factor())
    })
}

/// Hands the bubble back (if the page hasn't yet) and removes the overlay.
fn finish(app: &AppHandle) {
    handoff(app);
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
    ACTIVE.store(false, Ordering::SeqCst);
}

fn handoff(app: &AppHandle) {
    if HANDED.swap(true, Ordering::SeqCst) {
        return;
    }
    bubble::hold(false);
    bubble::settle(app);
    let _ = app.emit_to("bubble", "bubble-veil", json!({ "on": false }));
}

// ---- commands (from fx.html) ------------------------------------------------------------

#[tauri::command]
pub fn fx_payload() -> Option<Value> {
    PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The page has drawn its first frame (the bubble as it is now): show it and hide the real one.
#[tauri::command]
pub fn fx_ready(app: AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    win::show(&w, true);
    win::keep_topmost(&w);
    let _ = app.emit_to("bubble", "bubble-veil", json!({ "on": true }));
}

/// The overlay has drawn the bubble in its final form and spot: bring the real one back there.
#[tauri::command]
pub fn fx_handoff(app: AppHandle) {
    handoff(&app);
}

/// Everything has finished playing.
#[tauri::command]
pub fn fx_done(app: AppHandle) {
    // Give the bubble a moment to show again before the overlay (drawing the same thing) goes.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        finish(&app);
    });
}
