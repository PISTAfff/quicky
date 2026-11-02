//! Quicky's own windows on macOS and Linux: Tauri's window calls already do the right thing there
//! (and hop to the main thread, which AppKit and GTK need), so `mac.rs` and `linux.rs` share these.

use super::win::{self, Rect};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

/// The app window Quicky is open inside (0 = none). Moving and resizing Quicky stop at its edges.
pub static HOST: AtomicIsize = AtomicIsize::new(0);
/// Set while Quicky places its own window, so its in-between steps aren't pushed back.
pub static PLACING: AtomicBool = AtomicBool::new(false);

pub fn own_frame(w: &WebviewWindow) -> Option<Rect> {
    let (p, s) = (w.outer_position().ok()?, w.outer_size().ok()?);
    Some(Rect { left: p.x, top: p.y, right: p.x + s.width as i32, bottom: p.y + s.height as i32 })
}

pub fn move_to(w: &WebviewWindow, x: i32, y: i32) {
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

pub fn show(w: &WebviewWindow, visible: bool) {
    let _ = if visible { w.show() } else { w.hide() };
}

/// The window was made always-on-top when it was created; nothing to renew here.
pub fn keep_topmost(_w: &WebviewWindow) {}

pub fn force_foreground(w: &WebviewWindow) {
    let _ = w.set_focus();
}

/// Keeps the main window inside `HOST` while one is set: whenever it's moved or resized past the
/// app's edges, it's put straight back (the system has no hook to stop it beforehand).
pub fn keep_inside_host(w: &WebviewWindow) {
    let me = w.clone();
    w.on_window_event(move |e| {
        if matches!(e, WindowEvent::Moved(_) | WindowEvent::Resized(_)) && !PLACING.load(Ordering::Relaxed) {
            push_inside(&me);
        }
    });
}

fn push_inside(w: &WebviewWindow) {
    let host = HOST.load(Ordering::Relaxed);
    // No walls while the app is gone, minimized or on another desktop.
    let (true, Some(b)) = (host != 0, win::frame(host)) else { return };
    let (Ok(p), Ok(s), Ok(scale)) = (w.outer_position(), w.outer_size(), w.scale_factor()) else { return };
    // Never below the main window's minimum, even in an app window smaller than that.
    let min = ((crate::MAIN_MIN.0 * scale).round() as i32, (crate::MAIN_MIN.1 * scale).round() as i32);
    let (width, height) = ((s.width as i32).min(b.right - b.left).max(min.0), (s.height as i32).min(b.bottom - b.top).max(min.1));
    if (width, height) != (s.width as i32, s.height as i32) {
        let _ = w.set_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
    }
    let x = p.x.min(b.right - width).max(b.left);
    let y = p.y.min(b.bottom - height).max(b.top);
    if (x, y) != (p.x, p.y) {
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
}
