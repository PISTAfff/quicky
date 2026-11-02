//! Thin wrappers over the few Win32 calls Quicky needs: finding other apps' windows, keeping the
//! bubble on top without stealing focus, and pulling the reminder to the front.
//!
//! `mac.rs` and `linux.rs` offer the same functions for the other systems (lib.rs picks one).
//! Other apps' windows are `Hwnd`s; Quicky's own windows are passed as Tauri windows.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, GetAsyncKeyState, KEYEVENTF_KEYUP, VK_LBUTTON, VK_MENU};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowRect,
    GetWindowLongPtrW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, SendMessageW, SetForegroundWindow,
    SetWindowPos, ShowWindow, GA_ROOT, GA_ROOTOWNER, GWL_EXSTYLE, HWND_TOPMOST, MINMAXINFO, SWP_HIDEWINDOW, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WINDOWPOS, WM_GETMINMAXINFO, WM_MOVING,
    WM_SIZING, WM_WINDOWPOSCHANGING, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

/// Window handles cross threads as plain integers.
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
    /// Full path of the app's .exe; the key a bubble is stuck by.
    pub exe: String,
}

fn h(hwnd: Hwnd) -> HWND {
    hwnd as HWND
}

/// One of Quicky's own windows as a Win32 handle.
fn own(w: &tauri::WebviewWindow) -> Option<Hwnd> {
    w.hwnd().ok().map(|h| h.0 as Hwnd)
}

fn pid_of(hwnd: Hwnd) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h(hwnd), &mut pid) };
    pid
}

fn is_ours(hwnd: Hwnd) -> bool {
    pid_of(hwnd) == unsafe { GetCurrentProcessId() }
}

pub fn exe_of(hwnd: Hwnd) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid_of(hwnd));
        if process.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(process);
        (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn class_of(hwnd: Hwnd) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h(hwnd), buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn cloaked(hwnd: Hwnd) -> bool {
    let mut v = 0u32;
    let hr = unsafe {
        DwmGetWindowAttribute(h(hwnd), DWMWA_CLOAKED as _, &mut v as *mut u32 as _, std::mem::size_of::<u32>() as u32)
    };
    hr == 0 && v != 0
}

/// The visible frame of a window (without the invisible resize borders Windows 10/11 add).
pub fn frame(hwnd: Hwnd) -> Option<Rect> {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let hr = unsafe {
        DwmGetWindowAttribute(h(hwnd), DWMWA_EXTENDED_FRAME_BOUNDS as _, &mut r as *mut RECT as _, std::mem::size_of::<RECT>() as u32)
    };
    if hr != 0 && unsafe { GetWindowRect(h(hwnd), &mut r) } == 0 {
        return None;
    }
    Some(Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
}

/// The visible frame of one of Quicky's own windows.
pub fn own_frame(w: &tauri::WebviewWindow) -> Option<Rect> {
    frame(own(w)?)
}

/// A real app window: alive, visible, not minimized, not cloaked, and not part of the Windows
/// shell. Explorer draws the taskbar, the tray's hidden-icons popup, Alt+Tab and the desktop as
/// well as its folder windows, so of Explorer's windows only folder windows count.
pub fn usable(hwnd: Hwnd) -> bool {
    let alive = unsafe { IsWindow(h(hwnd)) != 0 && IsWindowVisible(h(hwnd)) != 0 && IsIconic(h(hwnd)) == 0 };
    if !alive || cloaked(hwnd) {
        return false;
    }
    // Overlays and helpers that only look like apps: click-through or never-focused windows (a
    // game overlay can cover the whole desktop) and tool windows that Alt+Tab leaves out.
    let ex = unsafe { GetWindowLongPtrW(h(hwnd), GWL_EXSTYLE) } as u32;
    if ex & (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE) != 0 || (ex & WS_EX_TOOLWINDOW != 0 && ex & WS_EX_APPWINDOW == 0) {
        return false;
    }
    let class = class_of(hwnd);
    if matches!(class.as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Progman" | "WorkerW" | "Windows.UI.Core.CoreWindow") {
        return false;
    }
    class == "CabinetWClass" || !exe_of(hwnd).is_some_and(|e| e.to_ascii_lowercase().ends_with("\\explorer.exe"))
}

/// The app the user is in right now. `None` while one of Quicky's own windows has focus.
pub fn foreground_app() -> Option<AppWindow> {
    let fg = unsafe { GetForegroundWindow() } as Hwnd;
    if fg == 0 || is_ours(fg) || !usable(fg) {
        return None;
    }
    let root = unsafe { GetAncestor(h(fg), GA_ROOT) } as Hwnd;
    Some(AppWindow { hwnd: root, exe: exe_of(root)? })
}

pub fn foreground_is_ours() -> bool {
    let fg = unsafe { GetForegroundWindow() } as Hwnd;
    fg != 0 && is_ours(fg)
}

/// Whether focus went somewhere that still belongs to `owner`: one of our own windows (file
/// dialogs, the reminder), a window it owns, or a WebView2 popup (colour/date pickers, menus).
/// No foreground at all (mid-switch) also counts, to be safe.
pub fn foreground_is_related(w: &tauri::WebviewWindow) -> bool {
    let Some(owner) = own(w) else { return true };
    let fg = unsafe { GetForegroundWindow() } as Hwnd;
    if fg == 0 || is_ours(fg) {
        return true;
    }
    if unsafe { GetAncestor(h(fg), GA_ROOTOWNER) } as Hwnd == owner {
        return true;
    }
    exe_of(fg).is_some_and(|e| e.to_ascii_lowercase().ends_with("msedgewebview2.exe"))
}

/// The topmost real app window under a screen point (Quicky's own windows are skipped).
pub fn app_under(x: i32, y: i32) -> Option<AppWindow> {
    struct Search {
        x: i32,
        y: i32,
        found: Hwnd,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let s = unsafe { &mut *(lparam as *mut Search) };
        let hwnd = hwnd as Hwnd;
        if is_ours(hwnd) || !usable(hwnd) {
            return 1;
        }
        match frame(hwnd) {
            Some(r) if s.x >= r.left && s.x < r.right && s.y >= r.top && s.y < r.bottom => {
                s.found = hwnd;
                0 // EnumWindows walks top to bottom, so the first hit is the visible one
            }
            _ => 1,
        }
    }
    let mut s = Search { x, y, found: 0 };
    unsafe { EnumWindows(Some(visit), &mut s as *mut Search as LPARAM) };
    if s.found == 0 {
        return None;
    }
    let root = unsafe { GetAncestor(h(s.found), GA_ROOT) } as Hwnd;
    Some(AppWindow { hwnd: root, exe: exe_of(root)? })
}

/// An app's icon (from its .exe) as a PNG, `size` px square. None if it has no icon.
pub fn exe_icon_png(exe: &str, size: i32) -> Option<Vec<u8>> {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO};

    let wide: Vec<u16> = exe.encode_utf16().chain(std::iter::once(0)).collect();
    let mut path = [0u16; 260];
    let n = wide.len().min(path.len());
    path[..n].copy_from_slice(&wide[..n]);
    let mut icon: HICON = std::ptr::null_mut();
    let got = unsafe { PrivateExtractIconsW(path.as_ptr(), 0, size, size, &mut icon, std::ptr::null_mut(), 1, 0) };
    if got == 0 || got == u32::MAX || icon.is_null() {
        return None;
    }
    let mut ii: ICONINFO = unsafe { std::mem::zeroed() };
    if unsafe { GetIconInfo(icon, &mut ii) } == 0 {
        unsafe { DestroyIcon(icon) };
        return None;
    }
    let read = |bmp| -> Option<Vec<u8>> {
        let mut bi: BITMAPINFO = unsafe { std::mem::zeroed() };
        bi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size,
            biHeight: -size, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..unsafe { std::mem::zeroed() }
        };
        let mut buf = vec![0u8; (size * size * 4) as usize];
        let dc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
        let lines = unsafe { GetDIBits(dc, bmp, 0, size as u32, buf.as_mut_ptr() as _, &mut bi, DIB_RGB_COLORS) };
        unsafe { DeleteDC(dc) };
        (lines > 0).then_some(buf)
    };
    let color = if ii.hbmColor.is_null() { None } else { read(ii.hbmColor) };
    let mask = if ii.hbmMask.is_null() { None } else { read(ii.hbmMask) };
    unsafe {
        if !ii.hbmColor.is_null() {
            DeleteObject(ii.hbmColor);
        }
        if !ii.hbmMask.is_null() {
            DeleteObject(ii.hbmMask);
        }
        DestroyIcon(icon);
    }
    let mut px = color?;
    // Old-style icons carry no alpha: take transparency from the mask instead.
    let has_alpha = px.chunks(4).any(|p| p[3] != 0);
    for (i, p) in px.chunks_mut(4).enumerate() {
        p.swap(0, 2); // BGRA → RGBA
        if !has_alpha {
            let transparent = mask.as_ref().is_some_and(|m| m[i * 4] != 0);
            p[3] = if transparent { 0 } else { 255 };
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, size as u32, size as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&px).ok()?;
    }
    Some(out)
}

/// Where the mouse pointer is right now (physical px, whole desktop).
pub fn cursor() -> (i32, i32) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

pub fn left_button_down() -> bool {
    (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16 & 0x8000) != 0
}

pub fn keep_topmost(w: &tauri::WebviewWindow) {
    let Some(hwnd) = own(w) else { return };
    unsafe {
        SetWindowPos(h(hwnd), HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
}

pub fn move_to(w: &tauri::WebviewWindow, x: i32, y: i32) {
    let Some(hwnd) = own(w) else { return };
    unsafe { SetWindowPos(h(hwnd), std::ptr::null_mut(), x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) };
}

pub fn show(w: &tauri::WebviewWindow, visible: bool) {
    let Some(hwnd) = own(w) else { return };
    unsafe { ShowWindow(h(hwnd), if visible { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
}

/// Brings a window to the front even when Windows' focus-stealing guard would normally only flash
/// its taskbar button: a synthetic Alt tap plus borrowing the current foreground thread's input.
/// When Quicky is already in front (the user just clicked the bubble) it simply moves there: the
/// Alt tap would leave the window in menu-bar mode and eat the next key press.
pub fn force_foreground(w: &tauri::WebviewWindow) {
    let Some(hwnd) = own(w) else { return };
    unsafe {
        let fg = GetForegroundWindow();
        if is_ours(fg as Hwnd) {
            BringWindowToTop(h(hwnd));
            SetForegroundWindow(h(hwnd));
            return;
        }
        let fg_thread = GetWindowThreadProcessId(fg, std::ptr::null_mut());
        let me = GetCurrentThreadId();
        keybd_event(VK_MENU as u8, 0, 0, 0);
        keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, 1) != 0;
        BringWindowToTop(h(hwnd));
        SetForegroundWindow(h(hwnd));
        if attached {
            AttachThreadInput(me, fg_thread, 0);
        }
    }
}

// ---- keeping Quicky inside the app it is opened in ---------------------------------------------

/// The app window Quicky is open inside (0 = none). Moving and resizing Quicky stop at its edges.
/// Read inside the window procedure, so it is an atomic rather than behind a lock.
pub static HOST: AtomicIsize = AtomicIsize::new(0);
/// Set while Quicky places its own window: its resize-then-move steps pass through in-between
/// rectangles that must not be clamped.
pub static PLACING: AtomicBool = AtomicBool::new(false);

/// Hooks the main window's messages so drags, resizes, snapping and maximizing all stay inside
/// `HOST` while one is set. Call once, on the thread that created the window.
pub fn keep_inside_host(w: &tauri::WebviewWindow) {
    let Some(hwnd) = own(w) else { return };
    unsafe { SetWindowSubclass(h(hwnd), Some(host_walls), 1, 0) };
}

/// Where the window's outer rectangle may go: the host's visible frame, widened by our own
/// invisible resize borders (Windows measures moves and sizes by the outer rectangle).
fn host_bounds(hwnd: HWND) -> Option<RECT> {
    let host = HOST.load(Ordering::Relaxed);
    // No walls while the app is gone, hidden or minimized (its frame is then far off screen).
    if host == 0 || unsafe { IsWindow(h(host)) == 0 || IsWindowVisible(h(host)) == 0 || IsIconic(h(host)) != 0 } {
        return None;
    }
    let app = frame(host)?;
    // Maximized (Win+Up, double-clicking the title bar): fill the app exactly; a maximized
    // window has no invisible borders to allow for.
    if unsafe { IsZoomed(hwnd) } != 0 {
        return Some(RECT { left: app.left, top: app.top, right: app.right, bottom: app.bottom });
    }
    let me = frame(hwnd as Hwnd)?;
    let mut outer = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { GetWindowRect(hwnd, &mut outer) } == 0 {
        return None;
    }
    Some(RECT {
        left: app.left - (me.left - outer.left),
        top: app.top - (me.top - outer.top),
        right: app.right + (outer.right - me.right),
        bottom: app.bottom + (outer.bottom - me.bottom),
    })
}

/// The smallest outer size the window allows (Tauri's `minWidth` / `minHeight` plus its frame).
/// Asked of the window itself, so it suits the window's current scale.
fn min_track(hwnd: HWND) -> (i32, i32) {
    let mut mmi: MINMAXINFO = unsafe { std::mem::zeroed() };
    unsafe { SendMessageW(hwnd, WM_GETMINMAXINFO, 0, &mut mmi as *mut MINMAXINFO as LPARAM) };
    (mmi.ptMinTrackSize.x, mmi.ptMinTrackSize.y)
}

/// Slides a rectangle (same size) back inside the bounds; if it's bigger, it lines up top-left.
fn slide_inside(r: &mut RECT, b: &RECT) {
    let (w, ht) = (r.right - r.left, r.bottom - r.top);
    let x = r.left.min(b.right - w).max(b.left);
    let y = r.top.min(b.bottom - ht).max(b.top);
    *r = RECT { left: x, top: y, right: x + w, bottom: y + ht };
}

unsafe extern "system" fn host_walls(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        // Dragging: the window stops at the app's edges instead of crossing them.
        WM_MOVING => {
            let res = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            if let Some(b) = host_bounds(hwnd) {
                slide_inside(unsafe { &mut *(lparam as *mut RECT) }, &b);
                return 1;
            }
            res
        }
        // Resizing: the edge being dragged stops at the app's edge, unless that would make Quicky
        // smaller than its minimum (an app window can be smaller than that).
        WM_SIZING => {
            let res = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            if let Some(b) = host_bounds(hwnd) {
                let r = unsafe { &mut *(lparam as *mut RECT) };
                let (min_w, min_h) = min_track(hwnd);
                let c = RECT { left: r.left.max(b.left), top: r.top.max(b.top), right: r.right.min(b.right), bottom: r.bottom.min(b.bottom) };
                if c.right - c.left >= min_w {
                    (r.left, r.right) = (c.left, c.right);
                }
                if c.bottom - c.top >= min_h {
                    (r.top, r.bottom) = (c.top, c.bottom);
                }
                return 1;
            }
            res
        }
        // Everything else that moves or sizes it (snapping, maximizing, Win+arrows).
        WM_WINDOWPOSCHANGING if !PLACING.load(Ordering::Relaxed) => {
            let wp = unsafe { &mut *(lparam as *mut WINDOWPOS) };
            let moving = wp.flags & SWP_NOMOVE == 0 || wp.flags & SWP_NOSIZE == 0;
            if moving && wp.flags & SWP_HIDEWINDOW == 0 && unsafe { IsIconic(hwnd) } == 0 && wp.x > -30000 {
                if let Some(b) = host_bounds(hwnd) {
                    let mut now = RECT { left: 0, top: 0, right: 0, bottom: 0 };
                    unsafe { GetWindowRect(hwnd, &mut now) };
                    let (x, y) = if wp.flags & SWP_NOMOVE != 0 { (now.left, now.top) } else { (wp.x, wp.y) };
                    let (cw, ch) = if wp.flags & SWP_NOSIZE != 0 { (now.right - now.left, now.bottom - now.top) } else { (wp.cx, wp.cy) };
                    let (min_w, min_h) = min_track(hwnd);
                    let (cw, ch) = (cw.min(b.right - b.left).max(min_w), ch.min(b.bottom - b.top).max(min_h));
                    let mut r = RECT { left: x, top: y, right: x + cw, bottom: y + ch };
                    slide_inside(&mut r, &b);
                    (wp.x, wp.y, wp.cx, wp.cy) = (r.left, r.top, r.right - r.left, r.bottom - r.top);
                    wp.flags &= !(SWP_NOMOVE | SWP_NOSIZE);
                }
            }
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

/// Sets a window's big icon (the one its taskbar button shows) from RGBA pixels. Tauri's
/// `set_icon` only replaces the small one, so the taskbar would keep the .exe's icon.
pub fn set_big_icon(w: &tauri::WebviewWindow, rgba: &[u8], width: u32, height: u32) {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, DestroyIcon, SendMessageW, ICONINFO, ICON_BIG, WM_SETICON};
    /// The icon we set last, destroyed once it's replaced.
    static LAST: AtomicIsize = AtomicIsize::new(0);
    let Some(hwnd) = own(w) else { return };
    if rgba.len() < (width * height * 4) as usize {
        return;
    }
    unsafe {
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = width as i32;
        bi.bmiHeader.biHeight = -(height as i32); // top-down rows, like the RGBA buffer
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;
        let mut bits = std::ptr::null_mut();
        let color = CreateDIBSection(std::ptr::null_mut(), &bi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        if color.is_null() || bits.is_null() {
            return;
        }
        let px = std::slice::from_raw_parts_mut(bits as *mut u8, (width * height * 4) as usize);
        for (d, s) in px.chunks_mut(4).zip(rgba.chunks(4)) {
            d.copy_from_slice(&[s[2], s[1], s[0], s[3]]); // BGRA
        }
        let mask = CreateBitmap(width as i32, height as i32, 1, 1, std::ptr::null());
        let info = ICONINFO { fIcon: 1, xHotspot: 0, yHotspot: 0, hbmMask: mask, hbmColor: color };
        let icon = CreateIconIndirect(&info);
        DeleteObject(color);
        DeleteObject(mask);
        if icon.is_null() {
            return;
        }
        SendMessageW(h(hwnd), WM_SETICON, ICON_BIG as usize, icon as isize);
        let old = LAST.swap(icon as isize, Ordering::Relaxed);
        if old != 0 {
            DestroyIcon(old as _);
        }
    }
}

/// A full-screen app, game or presentation is in front, so reminders should wait.
pub fn busy() -> bool {
    use windows_sys::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
    let mut state = 0;
    let ok = unsafe { SHQueryUserNotificationState(&mut state) } == 0;
    ok && matches!(state, QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
}

/// The main taskbar's rectangle and which screen edge it's on (0 left, 1 top, 2 right, 3 bottom).
/// Works with an auto-hiding taskbar too, where the work area is the whole screen.
pub fn taskbar() -> Option<(Rect, u32)> {
    use windows_sys::Win32::UI::Shell::{SHAppBarMessage, ABM_GETTASKBARPOS, APPBARDATA};
    let mut d: APPBARDATA = unsafe { std::mem::zeroed() };
    d.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
    if unsafe { SHAppBarMessage(ABM_GETTASKBARPOS, &mut d) } == 0 {
        return None;
    }
    Some((Rect { left: d.rc.left, top: d.rc.top, right: d.rc.right, bottom: d.rc.bottom }, d.uEdge))
}
