//! The macOS side of `win`: other apps' windows come from CoreGraphics' window list (frames and
//! owners are readable without any permission), apps and icons from NSWorkspace. Window ids are
//! CoreGraphics window numbers. CoreGraphics measures in points from the top-left of the main
//! screen; Tauri's physical pixels are points times the screen's scale, so we convert.

use objc2::rc::autoreleasepool;
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace, NSGraphicsContext,
    NSImage, NSRunningApplication, NSWorkspace,
};
use objc2_foundation::{NSData, NSDictionary, NSPoint, NSRect, NSSize, NSString};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Mutex;
use tauri::WebviewWindow;

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
    /// The app's bundle (e.g. /Applications/Safari.app), or its executable if it has none.
    pub exe: String,
}

// ---- CoreGraphics and CoreFoundation ------------------------------------------------------

type CFRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    static kCGWindowOwnerPID: CFRef;
    static kCGWindowNumber: CFRef;
    static kCGWindowLayer: CFRef;
    static kCGWindowBounds: CFRef;
    static kCGWindowAlpha: CFRef;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFRef;
    fn CGRectMakeWithDictionaryRepresentation(dict: CFRef, rect: *mut CGRect) -> bool;
    fn CGEventCreate(source: CFRef) -> CFRef;
    fn CGEventGetLocation(event: CFRef) -> CGPoint;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    fn CGGetDisplaysWithPoint(point: CGPoint, max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CGDisplayCopyDisplayMode(display: u32) -> CFRef;
    fn CGDisplayModeGetWidth(mode: CFRef) -> usize;
    fn CGDisplayModeGetPixelWidth(mode: CFRef) -> usize;
    fn CGDisplayModeRelease(mode: CFRef);
    fn CGDisplayCreateImageForRect(display: u32, rect: CGRect) -> CFRef;
    fn CGImageGetDataProvider(image: CFRef) -> CFRef;
    fn CGDataProviderCopyData(provider: CFRef) -> CFRef;
    fn CGImageGetBitsPerPixel(image: CFRef) -> usize;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFArrayGetCount(array: CFRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFRef, index: isize) -> CFRef;
    fn CFDictionaryGetValue(dict: CFRef, key: CFRef) -> CFRef;
    fn CFNumberGetValue(number: CFRef, kind: isize, out: *mut c_void) -> bool;
    fn CFRelease(cf: CFRef);
    fn CFDataGetBytePtr(data: CFRef) -> *const u8;
    fn CFDataGetLength(data: CFRef) -> isize;
}

const ON_SCREEN_ONLY: u32 = 1 << 0;
const INCLUDING_WINDOW: u32 = 1 << 3;
const EXCLUDE_DESKTOP: u32 = 1 << 4;
const CF_SINT64: isize = 4;
const CF_FLOAT64: isize = 6;

/// One entry of the window list.
struct Info {
    id: u32,
    pid: i32,
    layer: i64,
    alpha: f64,
    bounds: CGRect,
}

impl Info {
    /// An ordinary app window (not a menu, the Dock, a tooltip or an invisible helper).
    fn normal(&self) -> bool {
        self.layer == 0 && self.alpha > 0.0 && self.bounds.size.width >= 80.0 && self.bounds.size.height >= 60.0
    }
}

unsafe fn number(dict: CFRef, key: CFRef, kind: isize) -> Option<f64> {
    let v = unsafe { CFDictionaryGetValue(dict, key) };
    if v.is_null() {
        return None;
    }
    if kind == CF_FLOAT64 {
        let mut out = 0f64;
        unsafe { CFNumberGetValue(v, kind, &mut out as *mut f64 as *mut c_void) }.then_some(out)
    } else {
        let mut out = 0i64;
        unsafe { CFNumberGetValue(v, kind, &mut out as *mut i64 as *mut c_void) }.then_some(out as f64)
    }
}

/// The window list, front to back.
fn windows(option: u32, relative_to: u32) -> Vec<Info> {
    unsafe {
        let list = CGWindowListCopyWindowInfo(option, relative_to);
        if list.is_null() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for i in 0..CFArrayGetCount(list) {
            let d = CFArrayGetValueAtIndex(list, i);
            let mut bounds = CGRect::default();
            let b = CFDictionaryGetValue(d, kCGWindowBounds);
            if b.is_null() || !CGRectMakeWithDictionaryRepresentation(b, &mut bounds) {
                continue;
            }
            let (Some(id), Some(pid)) = (number(d, kCGWindowNumber, CF_SINT64), number(d, kCGWindowOwnerPID, CF_SINT64)) else {
                continue;
            };
            out.push(Info {
                id: id as u32,
                pid: pid as i32,
                layer: number(d, kCGWindowLayer, CF_SINT64).unwrap_or(0.0) as i64,
                alpha: number(d, kCGWindowAlpha, CF_FLOAT64).unwrap_or(1.0),
                bounds,
            });
        }
        CFRelease(list);
        out
    }
}

/// Backing scale of the screen under a point (2.0 on Retina screens).
fn scale_of(display: u32) -> f64 {
    unsafe {
        let mode = CGDisplayCopyDisplayMode(display);
        if mode.is_null() {
            return 1.0;
        }
        let (w, px) = (CGDisplayModeGetWidth(mode), CGDisplayModeGetPixelWidth(mode));
        CGDisplayModeRelease(mode);
        if w == 0 { 1.0 } else { px as f64 / w as f64 }
    }
}

fn scale_at(p: CGPoint) -> f64 {
    let (mut id, mut count) = (0u32, 0u32);
    let found = unsafe { CGGetDisplaysWithPoint(p, 1, &mut id, &mut count) } == 0 && count > 0;
    scale_of(if found { id } else { unsafe { CGMainDisplayID() } })
}

fn to_physical(r: CGRect) -> Rect {
    let s = scale_at(CGPoint { x: r.origin.x + r.size.width / 2.0, y: r.origin.y + r.size.height / 2.0 });
    let px = |v: f64| (v * s).round() as i32;
    Rect { left: px(r.origin.x), top: px(r.origin.y), right: px(r.origin.x + r.size.width), bottom: px(r.origin.y + r.size.height) }
}

/// A physical-pixel point back in points, using the scale of the screen it falls on.
fn to_points(x: i32, y: i32) -> CGPoint {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    for &id in &ids[..count as usize] {
        let (b, s) = (unsafe { CGDisplayBounds(id) }, scale_of(id));
        let (px, py) = (x as f64 / s, y as f64 / s);
        if px >= b.origin.x && py >= b.origin.y && px < b.origin.x + b.size.width && py < b.origin.y + b.size.height {
            return CGPoint { x: px, y: py };
        }
    }
    let s = scale_of(unsafe { CGMainDisplayID() });
    CGPoint { x: x as f64 / s, y: y as f64 / s }
}

// ---- apps -----------------------------------------------------------------------------------

fn our_pid() -> i32 {
    std::process::id() as i32
}

fn front_pid() -> Option<i32> {
    autoreleasepool(|_| NSWorkspace::sharedWorkspace().frontmostApplication().map(|a| a.processIdentifier()))
}

/// The app bundle a process belongs to. Cached: it's asked for many times a second.
fn exe_for(pid: i32) -> Option<String> {
    static CACHE: Mutex<Option<HashMap<i32, String>>> = Mutex::new(None);
    if let Some(hit) = CACHE.lock().ok()?.get_or_insert_with(HashMap::new).get(&pid) {
        return Some(hit.clone());
    }
    let exe = autoreleasepool(|_| {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
        let url = app.bundleURL().or_else(|| app.executableURL())?;
        Some(url.path()?.to_string())
    })?;
    CACHE.lock().ok()?.get_or_insert_with(HashMap::new).insert(pid, exe.clone());
    Some(exe)
}

pub fn frame(hwnd: Hwnd) -> Option<Rect> {
    windows(INCLUDING_WINDOW, hwnd as u32).into_iter().find(|w| w.id == hwnd as u32).map(|w| to_physical(w.bounds))
}

/// A real app window that's on screen right now (not minimized, not on another desktop).
pub fn usable(hwnd: Hwnd) -> bool {
    windows(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0).iter().any(|w| w.id == hwnd as u32 && w.pid != our_pid() && w.normal())
}

/// The app the user is in right now, by its front window. `None` while Quicky has focus.
pub fn foreground_app() -> Option<AppWindow> {
    let pid = front_pid()?;
    if pid == our_pid() {
        return None;
    }
    let w = windows(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0).into_iter().find(|w| w.pid == pid && w.normal())?;
    Some(AppWindow { hwnd: w.id as Hwnd, exe: exe_for(pid)? })
}

pub fn foreground_is_ours() -> bool {
    front_pid() == Some(our_pid())
}

/// Focus is still with Quicky (its dialogs and pickers are part of the same app here).
pub fn foreground_is_related(_w: &WebviewWindow) -> bool {
    front_pid().is_none_or(|p| p == our_pid())
}

/// The frontmost app window under a screen point (Quicky's own windows are skipped).
pub fn app_under(x: i32, y: i32) -> Option<AppWindow> {
    let p = to_points(x, y);
    let inside = |r: &CGRect| p.x >= r.origin.x && p.y >= r.origin.y && p.x < r.origin.x + r.size.width && p.y < r.origin.y + r.size.height;
    let w = windows(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0).into_iter().find(|w| w.pid != our_pid() && w.normal() && inside(&w.bounds))?;
    Some(AppWindow { hwnd: w.id as Hwnd, exe: exe_for(w.pid)? })
}

/// An app's icon as a PNG, `size` px square.
pub fn exe_icon_png(exe: &str, size: i32) -> Option<Vec<u8>> {
    autoreleasepool(|_| unsafe {
        let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(exe));
        let rep = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            size as isize,
            size as isize,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )?;
        let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&ctx));
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size as f64, size as f64));
        icon.drawInRect_fromRect_operation_fraction(rect, NSRect::ZERO, NSCompositingOperation::Copy, 1.0);
        NSGraphicsContext::restoreGraphicsState_class();
        let png = rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())?;
        Some(png.to_vec())
    })
}

// ---- pointer ----------------------------------------------------------------------------------

/// Where the mouse pointer is right now (physical px).
pub fn cursor() -> (i32, i32) {
    unsafe {
        let e = CGEventCreate(std::ptr::null());
        if e.is_null() {
            return (0, 0);
        }
        let p = CGEventGetLocation(e);
        CFRelease(e);
        let s = scale_at(p);
        ((p.x * s).round() as i32, (p.y * s).round() as i32)
    }
}

pub fn left_button_down() -> bool {
    unsafe { CGEventSourceButtonState(0, 0) }
}

pub fn right_button_down() -> bool {
    unsafe { CGEventSourceButtonState(0, 1) }
}

/// The colour of the screen pixel under the pointer. Without Screen Recording permission macOS
/// only shows Quicky's own windows and the desktop, so other apps read as the wallpaper.
pub fn color_under_cursor() -> Option<(u8, u8, u8)> {
    unsafe {
        let e = CGEventCreate(std::ptr::null());
        if e.is_null() {
            return None;
        }
        let p = CGEventGetLocation(e);
        CFRelease(e);
        let mut display = 0u32;
        let mut count = 0u32;
        if CGGetDisplaysWithPoint(p, 1, &mut display, &mut count) != 0 || count == 0 {
            return None;
        }
        let b = CGDisplayBounds(display);
        let rect = CGRect { origin: CGPoint { x: p.x - b.origin.x, y: p.y - b.origin.y }, size: CGSize { width: 1.0, height: 1.0 } };
        let image = CGDisplayCreateImageForRect(display, rect);
        if image.is_null() {
            return None;
        }
        let bpp = CGImageGetBitsPerPixel(image);
        let data = CGDataProviderCopyData(CGImageGetDataProvider(image));
        let mut out = None;
        if !data.is_null() {
            let ptr = CFDataGetBytePtr(data);
            if bpp >= 32 && CFDataGetLength(data) >= 4 && !ptr.is_null() {
                // Screen images are 32-bit BGRA (little-endian, alpha first).
                let px = std::slice::from_raw_parts(ptr, 4);
                out = Some((px[2], px[1], px[0]));
            }
            CFRelease(data);
        }
        CFRelease(image);
        out
    }
}

// ---- Quicky's own windows -------------------------------------------------------------------

/// The Dock icon, from RGBA pixels (Tauri's `set_icon` doesn't touch it).
pub fn set_big_icon(w: &WebviewWindow, rgba: &[u8], width: u32, height: u32) {
    let mut png = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let Ok(mut writer) = enc.write_header() else { return };
        if writer.write_image_data(rgba).is_err() {
            return;
        }
    }
    let _ = w.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        if let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(&png)) {
            unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
        }
    });
}

/// No picture of a window here: `anim` squishes the page's own content instead.
pub const CAN_SNAPSHOT: bool = false;

pub fn snapshot(_w: &WebviewWindow) -> Option<(Vec<u8>, Rect)> {
    None
}

/// Only needed alongside `snapshot`.
pub fn set_invisible(_w: &WebviewWindow, _invisible: bool) {}

/// macOS has one Dock icon per app, whatever its windows: nothing to group.
pub fn set_window_group(_w: &WebviewWindow, _id: Option<&str>) {}

/// The app in front fills its whole screen (a full-screen app, game, video or presentation).
pub fn busy() -> bool {
    let Some(pid) = front_pid().filter(|&p| p != our_pid()) else { return false };
    let Some(w) = windows(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0).into_iter().find(|w| w.pid == pid && w.layer == 0) else { return false };
    let c = CGPoint { x: w.bounds.origin.x + w.bounds.size.width / 2.0, y: w.bounds.origin.y + w.bounds.size.height / 2.0 };
    let (mut id, mut count) = (0u32, 0u32);
    if unsafe { CGGetDisplaysWithPoint(c, 1, &mut id, &mut count) } != 0 || count == 0 {
        return false;
    }
    let d = unsafe { CGDisplayBounds(id) };
    w.bounds.size.width >= d.size.width && w.bounds.size.height >= d.size.height
}

/// The menu bar is at the top and the Dock is out of the way; the work area already allows for both.
pub fn taskbar() -> Option<(Rect, u32)> {
    None
}
