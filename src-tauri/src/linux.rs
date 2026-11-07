//! The Linux side of `win`, over X11 (Quicky asks GTK for X11 even in a Wayland session, see
//! lib.rs, because Wayland doesn't let an app place its own windows). Window ids are X11 window
//! ids. Apps running natively on Wayland aren't visible to X11, so they can't have minis.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::WebviewWindow;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, KeyButMask, MapState, Window};
use x11rb::rust_connection::RustConnection;

pub use crate::own::{force_foreground, keep_inside_host, keep_topmost, move_to, own_frame, show, Mover, HOST, PLACING, place_overlay};

pub type Hwnd = isize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Clone, Debug)]
pub struct AppWindow {
    pub hwnd: Hwnd,
    /// Full path of the app's executable; the key a mini is stuck by.
    pub exe: String,
}

x11rb::atom_manager! {
    Atoms: AtomsCookie {
        _NET_ACTIVE_WINDOW,
        _NET_CLIENT_LIST_STACKING,
        _NET_WM_PID,
        _NET_WM_STATE,
        _NET_WM_STATE_HIDDEN,
        _NET_WM_STATE_FULLSCREEN,
        _NET_WM_WINDOW_TYPE,
        _NET_WM_WINDOW_TYPE_NORMAL,
        _NET_WM_WINDOW_TYPE_DIALOG,
        _NET_FRAME_EXTENTS,
        _GTK_FRAME_EXTENTS,
        _NET_WM_ICON,
    }
}

struct X {
    conn: Mutex<RustConnection>,
    root: Window,
    atoms: Atoms,
}

/// The X server connection, made on first use. None without X11 (then there are no minis).
fn x() -> Option<&'static X> {
    static X11: OnceLock<Option<X>> = OnceLock::new();
    X11.get_or_init(|| {
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        let atoms = Atoms::new(&conn).ok()?.reply().ok()?;
        Some(X { conn: Mutex::new(conn), root, atoms })
    })
    .as_ref()
}

fn prop(x: &X, window: Window, atom: u32) -> Vec<u32> {
    prop_len(x, window, atom, 1024)
}

fn prop_len(x: &X, window: Window, atom: u32, len: u32) -> Vec<u32> {
    let conn = x.conn.lock().unwrap_or_else(|e| e.into_inner());
    conn.get_property(false, window, atom, AtomEnum::ANY, 0, len)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().map(|v| v.collect()))
        .unwrap_or_default()
}

fn pid_of(x: &X, window: Window) -> Option<u32> {
    prop(x, window, x.atoms._NET_WM_PID).first().copied()
}

fn exe_of(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|p| p.to_string_lossy().into_owned())
}

fn active(x: &X) -> Option<Window> {
    prop(x, x.root, x.atoms._NET_ACTIVE_WINDOW).first().copied().filter(|&w| w != 0)
}

fn is_ours(x: &X, window: Window) -> bool {
    pid_of(x, window) == Some(std::process::id())
}

pub fn frame(hwnd: Hwnd) -> Option<Rect> {
    let x = x()?;
    let w = hwnd as Window;
    let (geo, at) = {
        let conn = x.conn.lock().unwrap_or_else(|e| e.into_inner());
        (conn.get_geometry(w).ok()?.reply().ok()?, conn.translate_coordinates(w, x.root, 0, 0).ok()?.reply().ok()?)
    };
    let (mut l, mut t) = (at.dst_x as i32, at.dst_y as i32);
    let (mut r, mut b) = (l + geo.width as i32, t + geo.height as i32);
    // Server-side title bars sit outside the window; client-side ones draw a shadow inside it.
    if let [fl, fr, ft, fb] = prop(x, w, x.atoms._NET_FRAME_EXTENTS)[..] {
        (l, t, r, b) = (l - fl as i32, t - ft as i32, r + fr as i32, b + fb as i32);
    }
    if let [gl, gr, gt, gb] = prop(x, w, x.atoms._GTK_FRAME_EXTENTS)[..] {
        (l, t, r, b) = (l + gl as i32, t + gt as i32, r - gr as i32, b - gb as i32);
    }
    Some(Rect { left: l, top: t, right: r, bottom: b })
}

/// A real app window on screen: mapped, not minimized, and a normal window or dialog.
pub fn usable(hwnd: Hwnd) -> bool {
    let Some(x) = x() else { return false };
    let w = hwnd as Window;
    let viewable = {
        let conn = x.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.get_window_attributes(w).ok().and_then(|c| c.reply().ok()).is_some_and(|a| a.map_state == MapState::VIEWABLE)
    };
    if !viewable || is_ours(x, w) || prop(x, w, x.atoms._NET_WM_STATE).contains(&x.atoms._NET_WM_STATE_HIDDEN) {
        return false;
    }
    let kind = prop(x, w, x.atoms._NET_WM_WINDOW_TYPE);
    kind.is_empty() || kind.contains(&x.atoms._NET_WM_WINDOW_TYPE_NORMAL) || kind.contains(&x.atoms._NET_WM_WINDOW_TYPE_DIALOG)
}

/// A window seen for each app, to read its icon from later.
static SEEN: Mutex<Option<HashMap<String, Window>>> = Mutex::new(None);

fn app_window(x: &X, w: Window) -> Option<AppWindow> {
    let exe = exe_of(pid_of(x, w)?)?;
    SEEN.lock().ok()?.get_or_insert_with(HashMap::new).insert(exe.clone(), w);
    Some(AppWindow { hwnd: w as Hwnd, exe })
}

/// The app the user is in right now. `None` while one of Quicky's own windows has focus.
pub fn foreground_app() -> Option<AppWindow> {
    let x = x()?;
    let w = active(x)?;
    if is_ours(x, w) || !usable(w as Hwnd) {
        return None;
    }
    app_window(x, w)
}

pub fn foreground_is_ours() -> bool {
    x().is_some_and(|x| active(x).is_some_and(|w| is_ours(x, w)))
}

/// Focus is still with Quicky: one of its windows or dialogs.
pub fn foreground_is_related(_w: &WebviewWindow) -> bool {
    foreground_is_ours()
}

/// The topmost app window under a screen point (Quicky's own windows are skipped).
pub fn app_under(px: i32, py: i32) -> Option<AppWindow> {
    let x = x()?;
    // Bottom to top, so walk it backwards.
    prop(x, x.root, x.atoms._NET_CLIENT_LIST_STACKING).into_iter().rev().find_map(|w| {
        let r = frame(w as Hwnd)?;
        let hit = px >= r.left && px < r.right && py >= r.top && py < r.bottom;
        (hit && usable(w as Hwnd)).then(|| app_window(x, w)).flatten()
    })
}

/// An app's icon as a PNG, from one of its windows (`_NET_WM_ICON` holds several sizes; the
/// smallest one at least `size` px wide is used).
pub fn exe_icon_png(exe: &str, size: i32) -> Option<Vec<u8>> {
    let x = x()?;
    let w = *SEEN.lock().ok()?.get_or_insert_with(HashMap::new).get(exe)?;
    let data = prop_len(x, w, x.atoms._NET_WM_ICON, 1 << 20);
    let mut icons = Vec::new();
    let mut i = 0;
    while i + 2 <= data.len() {
        let (iw, ih) = (data[i] as usize, data[i + 1] as usize);
        let end = i + 2 + iw * ih;
        if iw == 0 || ih == 0 || end > data.len() {
            break;
        }
        icons.push((iw, ih, &data[i + 2..end]));
        i = end;
    }
    let (iw, ih, px) = icons
        .iter()
        .filter(|(w, ..)| *w as i32 >= size)
        .min_by_key(|(w, ..)| *w)
        .or_else(|| icons.iter().max_by_key(|(w, ..)| *w))
        .copied()?;
    // ARGB words to RGBA bytes.
    let rgba: Vec<u8> = px.iter().flat_map(|&p| [(p >> 16) as u8, (p >> 8) as u8, p as u8, (p >> 24) as u8]).collect();
    let mut png = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png, iw as u32, ih as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&rgba).ok()?;
    }
    Some(png)
}

/// Whether the system's own window move shows the window (Quicky moves the bubble itself on
/// Linux anyway).
pub fn live_window_drag() -> bool {
    true
}

/// Where the mouse pointer is right now (physical px).
pub fn cursor() -> (i32, i32) {
    pointer().map_or((0, 0), |(x, y, _)| (x, y))
}

pub fn left_button_down() -> bool {
    pointer().is_some_and(|(_, _, mask)| mask & u16::from(KeyButMask::BUTTON1) != 0)
}

pub fn right_button_down() -> bool {
    pointer().is_some_and(|(_, _, mask)| mask & u16::from(KeyButMask::BUTTON3) != 0)
}

/// The colour of the screen pixel under the pointer (read from the root window).
pub fn color_under_cursor() -> Option<(u8, u8, u8)> {
    use x11rb::protocol::xproto::ImageFormat;
    let (px, py, _) = pointer()?;
    let x = x()?;
    let conn = x.conn.lock().unwrap_or_else(|e| e.into_inner());
    let img = conn.get_image(ImageFormat::Z_PIXMAP, x.root, px as i16, py as i16, 1, 1, !0).ok()?.reply().ok()?;
    // 24- and 32-bit visuals store a pixel as B, G, R, (pad) on little-endian servers.
    (img.depth >= 24 && img.data.len() >= 3).then(|| (img.data[2], img.data[1], img.data[0]))
}

/// The pointer's position (physical px) and which buttons and modifiers are down.
fn pointer() -> Option<(i32, i32, u16)> {
    let x = x()?;
    let conn = x.conn.lock().unwrap_or_else(|e| e.into_inner());
    let p = conn.query_pointer(x.root).ok()?.reply().ok()?;
    Some((p.root_x as i32, p.root_y as i32, u16::from(p.mask)))
}

/// The window icon set with `set_icon` is the one taskbars and docks show on Linux.
pub fn set_big_icon(_w: &WebviewWindow, _rgba: &[u8], _width: u32, _height: u32) {}

/// No picture of a window here: `anim` squishes the page's own content instead.
pub const CAN_SNAPSHOT: bool = false;

pub fn snapshot(_w: &WebviewWindow) -> Option<(Vec<u8>, Rect)> {
    None
}

/// Only needed alongside `snapshot`.
pub fn set_invisible(_w: &WebviewWindow, _invisible: bool) {}

/// Docks group windows by their WM_CLASS, which GTK sets once when the window is made; each
/// window's own icon (Tauri's `set_icon`) still shows. Nothing more to do here.
pub fn set_window_group(_w: &WebviewWindow, _id: Option<&str>) {}

/// The window in front is full screen (a game, video or presentation).
pub fn busy() -> bool {
    let Some(x) = x() else { return false };
    active(x).is_some_and(|w| !is_ours(x, w) && prop(x, w, x.atoms._NET_WM_STATE).contains(&x.atoms._NET_WM_STATE_FULLSCREEN))
}

/// Panels differ between desktops; the work area already leaves room for them.
pub fn taskbar() -> Option<(Rect, u32)> {
    None
}

/// Pictures of the screen (Draw on screen's screenshot), read from the root window.
pub const CAN_CAPTURE: bool = true;

/// A picture of the screen (RGBA): the area at `px`, `py` (physical px).
pub fn capture(px: i32, py: i32, width: u32, height: u32) -> Option<Vec<u8>> {
    use x11rb::protocol::xproto::ImageFormat;
    let x = x()?;
    let conn = x.conn.lock().unwrap_or_else(|e| e.into_inner());
    let (w, h) = (width.min(u16::MAX as u32) as u16, height.min(u16::MAX as u32) as u16);
    let img = conn.get_image(ImageFormat::Z_PIXMAP, x.root, px as i16, py as i16, w, h, !0).ok()?.reply().ok()?;
    let n = w as usize * h as usize;
    // 24- and 32-bit visuals store a pixel as B, G, R, (pad) on little-endian servers.
    (img.depth >= 24 && img.data.len() >= n * 4).then(|| img.data.as_chunks::<4>().0.iter().take(n).flat_map(|p| [p[2], p[1], p[0], 255]).collect())
}

/// Pictures can't be put on the clipboard here yet (X11 hands them out on request): the
/// screenshot is only saved.
pub fn copy_image(_rgba: &[u8], _width: u32, _height: u32) -> bool {
    false
}

/// No picking a window by clicking it here yet: dragging an area and Full screen still work.
pub fn window_rects() -> Vec<Rect> {
    Vec::new()
}

pub fn exclude_from_capture(_w: &WebviewWindow, _exclude: bool) {}

/// Recording the screen isn't available on Linux yet: the screen tools' Record is turned off.
pub const CAN_RECORD: bool = false;

pub struct Recorder;

impl Recorder {
    pub fn start(_area: Rect, _path: &std::path::Path, _audio: bool, _clicks: bool, _fps: u32) -> Result<Self, String> {
        Err("Recording the screen isn't available on Linux yet".into())
    }
    pub fn frame(&mut self, _at: i64) -> Result<(), String> {
        Ok(())
    }
    pub fn audio(&mut self, _pcm: &[u8]) -> Result<(), String> {
        Ok(())
    }
    pub fn finish(self) -> Result<(), String> {
        Ok(())
    }
}
