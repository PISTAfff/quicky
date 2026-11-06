//! Opening and closing animations for Quicky's own windows (the main window, extension windows):
//! the window squishes into the bubble (or its own middle) and springs back out of it. Nothing
//! fades: it stays solid the whole way.
//!
//! A window can't be scaled, so a picture of it plays the part (`win::snapshot`) in the `squish`
//! overlay, a click-through see-through window parked as one pixel between animations
//! (`squish.html`).
//! Closing: the overlay draws the picture exactly over the window, then the real one hides under
//! it (`squish_covered`) and the picture squishes away. Opening: the window is shown invisible
//! (`win::set_invisible`: cloaked) so it paints and takes focus, the picture grows out of the bubble, and
//! the real one turns visible under its last frame (`squish_landed`). Systems without a snapshot
//! (macOS, Linux) squish the page's own content instead (`win-anim`, `src/lib/winanim.ts`).
//!
//! One animation plays at a time: a newer one first finishes whatever the older still had to do.

use crate::reminder::BROWSER_ARGS;
use crate::win::{self, Rect};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "squish";
const CLOSE: Duration = Duration::from_millis(240);
const OPEN: Duration = Duration::from_millis(300);
/// Room around the window and the bubble (logical px) for the droplets and the shadow.
const PAD: f64 = 200.0;

/// The system asks for less motion (the main page reports `prefers-reduced-motion`): windows
/// just appear and disappear.
static REDUCE: AtomicBool = AtomicBool::new(false);
static RUN: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn set_reduced_motion(reduce: bool) {
    REDUCE.store(reduce, Ordering::Relaxed);
}

type Job = Box<dyn FnOnce() + Send>;

/// The bubble a window's droplets fly into (closing) or out of (opening): the middle of its
/// window (physical px) and its label, so it gulps them.
#[derive(Clone, Copy)]
pub struct Target {
    pub at: (i32, i32),
    pub label: &'static str,
}

/// What the playing animation still has to do: once the overlay covers the window, and once the
/// picture has landed.
struct Pending {
    run: u64,
    covered: Option<Job>,
    landed: Option<Job>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
/// The playing animation's picture (RGBA) and what the page needs to draw it.
static FRAME: Mutex<Option<Vec<u8>>> = Mutex::new(None);
static PAYLOAD: Mutex<Option<Value>> = Mutex::new(None);
/// The last pictures of each window (label, frame, RGBA), one per size: an opening window springs
/// out with one straight away and the fresh picture takes over mid-flight. Taking a picture
/// first would hold the opening up, so without one the window's content springs open instead.
static LAST: Mutex<Vec<(String, Rect, Vec<u8>)>> = Mutex::new(Vec::new());

fn remember(label: &str, frame: Rect, px: &[u8]) {
    let size = |r: &Rect| (r.right - r.left, r.bottom - r.top);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    last.retain(|(l, f, _)| !(l == label && size(f) == size(&frame)));
    last.push((label.to_string(), frame, px.to_vec()));
    // A few sizes per window (the general list, and inside the apps it opens in).
    while last.len() > 6 {
        last.remove(0);
    }
}

/// The last picture of a window, if it was the same size as `frame`.
fn recall(label: &str, frame: Rect) -> Option<Vec<u8>> {
    let size = |r: &Rect| (r.right - r.left, r.bottom - r.top);
    let last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    last.iter().find(|(l, f, _)| l == label && size(f) == size(&frame)).map(|(.., px)| px.clone())
}

fn pending() -> MutexGuard<'static, Option<Pending>> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts a new run, finishing what the one before it still had to do (outside the lock).
fn begin(covered: Option<Job>, landed: Option<Job>) -> u64 {
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let old = pending().replace(Pending { run, covered, landed });
    run_jobs(old);
    run
}

/// Runs the jobs `run` still has, if it's still the playing one (`which`: covered, landed or both).
fn take(run: u64, covered: bool, landed: bool) {
    let jobs = {
        let mut g = pending();
        match g.as_mut() {
            Some(p) if p.run == run => {
                let c = if covered { p.covered.take() } else { None };
                let l = if landed { p.landed.take() } else { None };
                (c, l)
            }
            _ => (None, None),
        }
    };
    if let Some(j) = jobs.0 {
        j();
    }
    if let Some(j) = jobs.1 {
        j();
    }
}

fn run_jobs(p: Option<Pending>) {
    if let Some(p) = p {
        for j in [p.covered, p.landed].into_iter().flatten() {
            j();
        }
    }
}

fn current(run: u64) -> bool {
    RUN.load(Ordering::SeqCst) == run
}

/// Makes the overlay ahead of time, so the first animation is smooth too.
pub fn prewarm(app: &AppHandle) {
    if !win::CAN_SNAPSHOT {
        return;
    }
    let app = app.clone();
    // Never from the main thread inside a command (it deadlocks on Windows).
    std::thread::spawn(move || {
        let _ = overlay(&app);
    });
}

fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    // Only where windows' pictures can be taken: elsewhere it would just sit on top, unused.
    if !win::CAN_SNAPSHOT {
        return None;
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("squish.html".into()))
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
    park(&w);
    Some(w)
}

/// Between animations: one see-through pixel in the corner, still shown (see `place_overlay`;
/// cloaking it instead would count as hidden too, and its frames would come late).
fn park(ov: &WebviewWindow) {
    win::place_overlay(ov, 0, 0, 1, 1);
}

/// Tells a page without a snapshot to squish its own content.
fn tell(w: &WebviewWindow, phase: &str, ms: Duration) {
    let _ = w.emit_to(w.label(), "win-anim", json!({ "phase": phase, "origin": null, "ms": ms.as_millis() as u64 }));
}

fn showing(w: &WebviewWindow) -> bool {
    w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
}

/// Closes (hides or destroys) a window after it squishes into `target` (a point on screen,
/// physical px; None: the window's own middle). `done` does the real hiding: right away when
/// reduced motion is on or the window isn't showing.
pub fn close<F>(w: &WebviewWindow, target: Option<Target>, done: F)
where
    F: FnOnce(&WebviewWindow) + Send + 'static,
{
    let w = w.clone();
    if REDUCE.load(Ordering::Relaxed) || !showing(&w) {
        begin(None, None);
        return done(&w);
    }
    let w2 = w.clone();
    // Unseen first, so the system doesn't play its own hiding transition over ours. It stays
    // unseen while hidden (Tauri may hide or destroy it a moment later); `open` makes it seen.
    let hide: Job = Box::new(move || {
        win::set_invisible(&w2, true);
        done(&w2);
    });
    let run = begin(Some(hide), None);
    // The picture takes a moment: never on the main thread (it can be the caller's).
    std::thread::spawn(move || {
        // The overlay moves over the window first (still see-through), so it's ready to show
        // the picture the moment it arrives.
        if let (Some(frame), Some(ov)) = (win::own_frame(&w), overlay(w.app_handle())) {
            let (l, t, r, b) = area(frame, target, w.scale_factor().unwrap_or(1.0));
            win::place_overlay(&ov, l, t, r - l, b - t);
        }
        match win::snapshot(&w) {
            Some((px, frame)) if current(run) => {
                remember(w.label(), frame, &px);
                play(&w, run, "close", px, frame, target)
            }
            Some(_) => {}
            None => {
                tell(&w, "close", CLOSE);
                std::thread::sleep(CLOSE);
                take(run, true, true);
            }
        }
    });
}

/// The overlay's spot for a window at `frame` going to `target`: both, with room around them.
fn area(frame: Rect, target: Option<Target>, scale: f64) -> (i32, i32, i32, i32) {
    let to = target.map_or(((frame.left + frame.right) / 2, (frame.top + frame.bottom) / 2), |t| t.at);
    // Droplets spray around the window's middle too.
    let pad = (PAD * scale) as i32;
    (frame.left.min(to.0) - pad, frame.top.min(to.1) - pad, frame.right.max(to.0) + pad, frame.bottom.max(to.1) + pad)
}


/// Shows a window springing out of `target` (None: its own middle). `show` does the real
/// showing (and focusing), right away, so callers can rely on the window being on screen once
/// this returns. A window that's already open is just shown.
pub fn open<F>(w: &WebviewWindow, target: Option<Target>, show: F)
where
    F: FnOnce(&WebviewWindow),
{
    // Whatever was playing ends first (a window still on its way out is hidden now).
    let run = begin(None, None);
    if REDUCE.load(Ordering::Relaxed) || showing(w) {
        win::set_invisible(w, false);
        return show(w);
    }
    if !win::CAN_SNAPSHOT {
        show(w);
        tell(w, "open", OPEN);
        return;
    }
    // On screen but not seen yet (it paints and takes focus), so its frame can be measured: a
    // hidden window reports another size. The last picture of it at that size starts it
    // straight away.
    win::set_invisible(w, true);
    show(w);
    let quick = win::own_frame(w).and_then(|f| Some((recall(w.label(), f)?, f)));
    if quick.is_none() {
        win::set_invisible(w, false);
        tell(w, "open", OPEN);
        // For next time.
        let w = w.clone();
        std::thread::spawn(move || {
            std::thread::sleep(OPEN + Duration::from_millis(100));
            if let (true, Some((px, frame))) = (showing(&w), win::snapshot(&w)) {
                remember(w.label(), frame, &px);
            }
        });
        return;
    }
    // Seen once the picture lands; a fresh one is taken from it meanwhile.
    let w2 = w.clone();
    let reveal: Job = Box::new(move || win::set_invisible(&w2, false));
    *pending() = Some(Pending { run, covered: None, landed: Some(reveal) });
    let w = w.clone();
    std::thread::spawn(move || {
        if let Some((px, frame)) = quick {
            let w = w.clone();
            std::thread::spawn(move || play(&w, run, "open", px, frame, target));
        }
        // A frame or two for the page to paint after being hidden, then the real picture, which
        // the page swaps in mid-flight (same size).
        std::thread::sleep(Duration::from_millis(40));
        if let Some((px, frame)) = win::snapshot(&w).filter(|_| current(run)) {
            remember(w.label(), frame, &px);
            *FRAME.lock().unwrap_or_else(|e| e.into_inner()) = Some(px);
            let _ = w.emit_to(LABEL, "squish-refresh", run);
        }
    });
}

/// Plays one animation in the overlay. A safety net makes sure the window ends up as asked even
/// if the overlay's page never answers.
fn play(w: &WebviewWindow, run: u64, phase: &str, px: Vec<u8>, frame: Rect, target: Option<Target>) {
    let app = w.app_handle().clone();
    let Some(ov) = overlay(&app) else { return take(run, true, true) };
    let scale = w.scale_factor().unwrap_or(1.0);
    let (fw, fh) = (frame.right - frame.left, frame.bottom - frame.top);
    let (left, top, right, bottom) = area(frame, target, scale);
    let page = |v: i32| v as f64 / scale;
    let payload = json!({
        "run": run,
        "phase": phase,
        "w": fw,
        "h": fh,
        "rect": { "x": page(frame.left - left), "y": page(frame.top - top), "w": page(fw), "h": page(fh) },
        "to": target.map(|t| json!({ "x": page(t.at.0 - left), "y": page(t.at.1 - top) })),
        "gulp": target.map(|t| t.label),
    });
    *FRAME.lock().unwrap_or_else(|e| e.into_inner()) = Some(px);
    *PAYLOAD.lock().unwrap_or_else(|e| e.into_inner()) = Some(payload.clone());
    // See-through until the page has drawn the picture, so moving it over the window changes
    // nothing yet.
    win::place_overlay(&ov, left, top, right - left, bottom - top);
    let _ = app.emit_to(LABEL, "squish-play", payload);
    std::thread::sleep(Duration::from_millis(2500));
    if current(run) {
        take(run, true, true);
        park(&ov);
    }
}

// ---- commands (from squish.html) ------------------------------------------------------------

/// The playing animation's picture, raw RGBA (its size is in the payload).
#[tauri::command]
pub fn squish_frame() -> tauri::ipc::Response {
    tauri::ipc::Response::new(FRAME.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default())
}

/// The page has the picture over the window: a closing window really hides now.
#[tauri::command]
pub fn squish_covered(run: u64) {
    take(run, true, false);
}

/// The picture has arrived: an opening window turns visible under it.
#[tauri::command]
pub fn squish_landed(run: u64) {
    take(run, true, true);
}

/// The page has cleared itself: the overlay goes back to its corner.
#[tauri::command]
pub fn squish_done(app: AppHandle, run: u64) {
    take(run, true, true);
    if let Some(ov) = app.get_webview_window(LABEL).filter(|_| current(run)) {
        park(&ov);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    #[test]
    fn a_newer_animation_finishes_the_older_first() {
        let hits = Arc::new(AtomicUsize::new(0));
        let (a, b) = (hits.clone(), hits.clone());
        let old = begin(Some(Box::new(move || {
            a.fetch_add(1, Ordering::SeqCst);
        })), Some(Box::new(move || {
            b.fetch_add(10, Ordering::SeqCst);
        })));
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        let new = begin(None, None);
        assert_eq!(hits.load(Ordering::SeqCst), 11, "both of the old run's jobs ran");
        assert!(!current(old) && current(new));
        // A late answer from the old run's page does nothing.
        squish_covered(old);
        assert_eq!(hits.load(Ordering::SeqCst), 11);
    }
}
