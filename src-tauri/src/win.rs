//! Thin wrappers over the few Win32 calls Quicky needs: finding other apps' windows, keeping the
//! bubble on top without stealing focus, and pulling the reminder to the front.

use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, GetAsyncKeyState, KEYEVENTF_KEYUP, VK_LBUTTON, VK_MENU};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow, SetWindowPos, ShowWindow,
    GA_ROOT, GA_ROOTOWNER, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE,
    SW_SHOWNOACTIVATE,
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

/// A real app window: alive, visible, not minimized, not cloaked, not the desktop or taskbar.
pub fn usable(hwnd: Hwnd) -> bool {
    let alive = unsafe { IsWindow(h(hwnd)) != 0 && IsWindowVisible(h(hwnd)) != 0 && IsIconic(h(hwnd)) == 0 };
    alive
        && !cloaked(hwnd)
        && !matches!(class_of(hwnd).as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Progman" | "WorkerW")
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
pub fn foreground_is_related(owner: Hwnd) -> bool {
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

pub fn keep_topmost(hwnd: Hwnd) {
    unsafe {
        SetWindowPos(h(hwnd), HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
}

pub fn move_to(hwnd: Hwnd, x: i32, y: i32) {
    unsafe { SetWindowPos(h(hwnd), std::ptr::null_mut(), x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) };
}

pub fn show(hwnd: Hwnd, visible: bool) {
    unsafe { ShowWindow(h(hwnd), if visible { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
}

/// Brings a window to the front even when Windows' focus-stealing guard would normally only flash
/// its taskbar button: a synthetic Alt tap plus borrowing the current foreground thread's input.
pub fn force_foreground(hwnd: Hwnd) {
    unsafe {
        let fg = GetForegroundWindow();
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
