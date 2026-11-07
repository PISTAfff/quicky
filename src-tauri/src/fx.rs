//! Big bubble moments (dividing into a new app's mini, a mini popping out of its app or being
//! hidden) play in a short-lived, click-through overlay window covering the bubble and its home
//! spot, so they have room to move instead of being clipped to the little bubble window.
//!
//! The bubble pages it draws instead keep their blobs invisible meanwhile (`bubble-veil`: the
//! bubble and the new mini for a split, only the mini for a pop or hide), and both hold still
//! (`bubble::hold`). At the end the overlay asks for the handoff: they jump to their spots unseen,
//! then show again exactly where the overlay drew them.

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
/// The bubble windows the playing moment draws instead of.
static VEILS: Mutex<&'static [&'static str]> = Mutex::new(&[]);
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
    /// The bubble switched off: it (and a mini on screen, if any) wobbles, melts into a puddle
    /// with drips and splats, and soaks away. Which of the two are on screen.
    Bye { bubble: bool, mini: bool },
    /// The bubble switched on: a puddle bubbles up at its spot and it rises out of it.
    Hello,
}

impl Kind {
    /// The bubble windows the overlay draws instead of, while it plays.
    fn veils(self) -> &'static [&'static str] {
        match self {
            // The bubble divides; the new mini (still hidden) comes in at the handoff.
            Kind::Split => &[bubble::BUBBLE_LABEL, bubble::MINI_LABEL],
            // The mini bursts; its droplets fly into the bubble, which stays on screen.
            Kind::Pop | Kind::Hide => &[bubble::MINI_LABEL],
            Kind::Bye { bubble: true, mini: true } => &[bubble::BUBBLE_LABEL, bubble::MINI_LABEL],
            Kind::Bye { bubble: false, .. } => &[bubble::MINI_LABEL],
            Kind::Bye { .. } | Kind::Hello => &[bubble::BUBBLE_LABEL],
        }
    }

    /// Which blobs the overlay draws: the bubble's, the mini's.
    fn blobs(self) -> (bool, bool) {
        match self {
            Kind::Bye { bubble, mini } => (bubble, mini),
            Kind::Hello => (true, false),
            _ => (true, true),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Split => "split",
            Kind::Pop => "pop",
            Kind::Hide => "hide",
            Kind::Bye { .. } => "bye",
            Kind::Hello => "hello",
        }
    }
}

/// Plays a moment that starts at `from` and ends at the mini's spot `mini` and the bubble's own
/// spot `to` (window centres, physical px; for a pop or hide `mini` is `from`). The caller has
/// already changed the config; the bubbles show the result after the handoff. `space` is the
/// mini's task space, `push` the direction a popped mini was being pushed. False when another
/// moment is already playing (it hands over to the latest state anyway).
pub fn play(app: &AppHandle, kind: Kind, from: (i32, i32), mini: (i32, i32), to: (i32, i32), space: Option<String>, push: (f64, f64)) -> bool {
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return false;
    }
    HANDED.store(false, Ordering::SeqCst);
    *VEILS.lock().unwrap_or_else(|e| e.into_inner()) = kind.veils();
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    bubble::hold(true);
    if !matches!(kind, Kind::Pop | Kind::Hello) {
        // A little wind-up while the overlay loads (a popped mini is already squashed flat).
        let _ = app.emit_to(kind.veils()[0], "bubble-prep", ());
    }
    let app = app.clone();
    // Windows can't be created from the main thread inside a command (it deadlocks), so always
    // build it from a thread of its own.
    std::thread::spawn(move || {
        let scale = monitor_scale(&app, from).unwrap_or(1.0);
        let pad = (PAD * scale) as i32;
        let (left, top) = (from.0.min(to.0).min(mini.0) - pad, from.1.min(to.1).min(mini.1) - pad);
        let (right, bottom) = (from.0.max(to.0).max(mini.0) + pad, from.1.max(to.1).max(mini.1) + pad);
        let page = |(x, y): (i32, i32)| json!({ "x": (x - left) as f64 / scale, "y": (y - top) as f64 / scale });
        let (has_bubble, has_mini) = kind.blobs();
        let payload = json!({ "run": run, "kind": kind.name(), "from": page(from), "mini": page(mini), "to": page(to), "space": space, "push": { "x": push.0, "y": push.1 }, "bubble": has_bubble, "hasMini": has_mini });
        *PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()) = Some(payload.clone());

        // The window is kept between moments (a new web view each time stuttered while it started).
        let Some(w) = build(&app) else { return finish(&app) };
        let _ = w.set_position(PhysicalPosition::new(left, top));
        let _ = w.set_size(PhysicalSize::new((right - left) as u32, (bottom - top) as u32));
        let _ = app.emit_to(LABEL, "fx-play", payload);
        // Safety net: whatever happens to the page, the bubble always comes back.
        std::thread::sleep(Duration::from_millis(3500));
        if RUN.load(Ordering::SeqCst) == run && ACTIVE.load(Ordering::SeqCst) {
            finish(&app);
        }
    });
    true
}

/// The bubble being switched off (`show` false: it and a mini on screen melt away) or on (it
/// wells up out of a puddle at its spot). False when it can't play (nothing on screen to melt,
/// or another moment is playing): then the caller just hides or shows.
pub fn presence(app: &AppHandle, show: bool) -> bool {
    let showing = |w: &tauri::WebviewWindow| w.is_visible().unwrap_or(false);
    let centre = |w: &tauri::WebviewWindow| -> Option<(i32, i32)> {
        let (p, s) = (w.outer_position().ok()?, w.outer_size().ok()?);
        Some((p.x + s.width as i32 / 2, p.y + s.height as i32 / 2))
    };
    let b = bubble::window(app).filter(|w| show || showing(w)).and_then(|w| centre(&w));
    let m = if show { None } else { bubble::mini_window(app).filter(showing).and_then(|w| centre(&w)) };
    let Some(from) = b.or(m) else { return false };
    let kind = if show { Kind::Hello } else { Kind::Bye { bubble: b.is_some(), mini: m.is_some() } };
    play(app, kind, from, m.unwrap_or(from), from, None, (0.0, 0.0))
}

/// Ends the moment playing now (the bubble was switched back mid-way): straight to the handoff.
pub fn cut(app: &AppHandle) {
    if ACTIVE.load(Ordering::SeqCst) {
        RUN.fetch_add(1, Ordering::SeqCst);
        finish(app);
    }
}

/// Makes the (hidden) overlay window ahead of time, so the first moment plays smoothly too.
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
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("fx.html".into()))
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
    // Clicks go straight through to whatever is underneath.
    let _ = w.set_ignore_cursor_events(true);
    Some(w)
}

fn monitor_scale(app: &AppHandle, (x, y): (i32, i32)) -> Option<f64> {
    app.available_monitors().ok()?.into_iter().find_map(|m| {
        let (p, s) = (m.position(), m.size());
        (x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32).then(|| m.scale_factor())
    })
}

/// Whether a big moment is playing now (the sticky trail lets it take over).
pub fn playing() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Hands the bubble back (if the page hasn't yet) and puts the overlay away (kept for next time).
fn finish(app: &AppHandle) {
    handoff(app);
    if let Some(w) = app.get_webview_window(LABEL) {
        win::show(&w, false);
    }
    ACTIVE.store(false, Ordering::SeqCst);
}

fn handoff(app: &AppHandle) {
    if HANDED.swap(true, Ordering::SeqCst) {
        return;
    }
    bubble::hold(false);
    bubble::ENTERING.store(false, Ordering::SeqCst);
    // Into their new spots and shown (or hidden) while still veiled, then visible again.
    bubble::settle(app);
    bubble::sync(app);
    veil(app, false);
}

fn veil(app: &AppHandle, on: bool) {
    for label in *VEILS.lock().unwrap_or_else(|e| e.into_inner()) {
        let _ = app.emit_to(*label, "bubble-veil", json!({ "on": on }));
    }
}

// ---- commands (from fx.html) ------------------------------------------------------------

/// Whether the page's answer is about the moment playing now (older pages send no run).
fn current(run: Option<u64>) -> bool {
    run.is_none_or(|r| r == RUN.load(Ordering::SeqCst))
}

#[tauri::command]
pub fn fx_payload() -> Option<Value> {
    PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The page has drawn its first frame (the bubble as it is now): show it and hide the real one.
#[tauri::command]
pub fn fx_ready(app: AppHandle, run: Option<u64>) {
    if !current(run) {
        return;
    }
    let Some(w) = app.get_webview_window(LABEL) else { return };
    win::show(&w, true);
    win::keep_topmost(&w);
    veil(&app, true);
}

/// The overlay has drawn the bubbles in their final spots: bring the real ones back there.
#[tauri::command]
pub fn fx_handoff(app: AppHandle, run: Option<u64>) {
    if current(run) {
        handoff(&app);
    }
}

/// Everything has finished playing.
#[tauri::command]
pub fn fx_done(app: AppHandle, run: Option<u64>) {
    // A moment cut short (or replaced) doesn't get to end the one playing now.
    if !current(run) {
        return;
    }
    // Give the bubble a moment to show again before the overlay (drawing the same thing) goes.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        finish(&app);
    });
}
