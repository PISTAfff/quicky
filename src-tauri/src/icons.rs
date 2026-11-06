//! Taskbar, Dock and tray icons in the accent colour.
//!
//! Both are Quicky's blob, drawn from layers in `live-icons/` (rendered from brand/logo): what sits
//! under the body (its hard shadow), the body (white, tinted to the accent), and what sits over it
//! (outline and face). The tray uses the small, outline-free blob.

use crate::win;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};

const WINDOW_LAYERS: [&[u8]; 3] = [
    include_bytes!("../live-icons/window-under.png"),
    include_bytes!("../live-icons/window-body.png"),
    include_bytes!("../live-icons/window-over.png"),
];
pub(crate) const TRAY_LAYERS: [&[u8]; 2] = [include_bytes!("../live-icons/tray-body.png"), include_bytes!("../live-icons/tray-face.png")];
/// The Dock shows icons much bigger than a taskbar does. Extension windows' icons are drawn from
/// these too (shrunk, to make room for the badge).
const DOCK_LAYERS: [&[u8]; 3] = [
    include_bytes!("../live-icons/dock-under.png"),
    include_bytes!("../live-icons/dock-body.png"),
    include_bytes!("../live-icons/dock-over.png"),
];
pub(crate) const GRAPE: [u8; 3] = [0x6d, 0x4c, 0xff];
/// The outline colour. On a light accent the face (white in the layers) is drawn in it instead.
const INK: [u8; 3] = [0x2b, 0x25, 0x40];

/// Whether the face reads better in ink than in white on this accent: the same rule as the
/// app's `onAccent` (whichever contrasts more).
fn dark_face(rgb: [u8; 3]) -> bool {
    let lin = |c: u8| {
        let c = c as f64 / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let lum = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    1.05 / (lum + 0.05) < (lum + 0.05) / 0.072
}

fn decode_rgba(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let mut dec = png::Decoder::new(bytes);
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = dec.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    (info.color_type == png::ColorType::Rgba && info.bit_depth == png::BitDepth::Eight).then_some((buf, info.width, info.height))
}

/// Paints straight-alpha pixel `s` over `d`.
fn paint_over(d: &mut [u8], s: &[u8]) {
    let (sa, da) = (s[3] as f32 / 255.0, d[3] as f32 / 255.0);
    let oa = sa + da * (1.0 - sa);
    if oa <= 0.0 {
        d.fill(0);
        return;
    }
    for c in 0..3 {
        d[c] = ((s[c] as f32 * sa + d[c] as f32 * da * (1.0 - sa)) / oa).round() as u8;
    }
    d[3] = (oa * 255.0).round() as u8;
}

/// Stacks the layers bottom to top, with layer `body` tinted to `rgb` (and the face over it in ink
/// when `rgb` is light).
pub(crate) fn blob_icon(layers: &[&[u8]], body: usize, rgb: [u8; 3]) -> Option<tauri::image::Image<'static>> {
    let ink_face = dark_face(rgb);
    let mut out: Option<(Vec<u8>, u32, u32)> = None;
    for (i, bytes) in layers.iter().enumerate() {
        let (mut px, w, h) = decode_rgba(bytes)?;
        if i == body {
            px.chunks_mut(4).for_each(|p| p[..3].copy_from_slice(&rgb));
        } else if i > body && ink_face {
            // The face is the white part of what sits over the body; the outline is already ink.
            px.chunks_mut(4).filter(|p| p[0] > 200 && p[1] > 200 && p[2] > 200).for_each(|p| p[..3].copy_from_slice(&INK));
        }
        match out.as_mut() {
            None => out = Some((px, w, h)),
            Some((dst, ..)) => dst.chunks_mut(4).zip(px.chunks(4)).for_each(|(d, s)| paint_over(d, s)),
        }
    }
    out.map(|(px, w, h)| tauri::image::Image::new_owned(px, w, h))
}

/// The accent the icons were last tinted to.
static ACCENT: Mutex<[u8; 3]> = Mutex::new(GRAPE);
/// Each extension window's badge (its page draws it: `ICON` px RGBA, see `src/lib/ext-icon.ts`),
/// kept to tint the icon again when the accent changes.
static BADGES: Mutex<Vec<(String, Vec<u8>)>> = Mutex::new(Vec::new());
/// An extension window icon's size, the same as the window layers (and the page's canvas).
pub const ICON: u32 = 64;
/// The blob's size in an extension's icon, in its top-left corner; the badge takes the rest.
const BADGED_BLOB: u32 = 46;

/// Shrinks an RGBA image to `n` x `n` px by averaging (alpha-weighted, so edges don't darken).
fn shrink(px: &[u8], w: u32, h: u32, n: u32) -> Vec<u8> {
    let mut out = vec![0u8; (n * n * 4) as usize];
    for dy in 0..n {
        let (y0, y1) = (dy * h / n, ((dy + 1) * h / n).max(dy * h / n + 1));
        for dx in 0..n {
            let (x0, x1) = (dx * w / n, ((dx + 1) * w / n).max(dx * w / n + 1));
            let mut acc = [0f64; 4];
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = &px[((y * w + x) * 4) as usize..][..4];
                    let a = p[3] as f64;
                    acc[0] += p[0] as f64 * a;
                    acc[1] += p[1] as f64 * a;
                    acc[2] += p[2] as f64 * a;
                    acc[3] += a;
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as f64;
            let o = &mut out[((dy * n + dx) * 4) as usize..][..4];
            if acc[3] > 0.0 {
                for c in 0..3 {
                    o[c] = (acc[c] / acc[3]).round() as u8;
                }
                o[3] = (acc[3] / count).round() as u8;
            }
        }
    }
    out
}

/// An extension window's icon: Quicky's blob in the accent, a little smaller, with the
/// extension's badge (`badge`, `ICON` px, mostly see-through) painted over it.
pub(crate) fn badged_icon(badge: &[u8], rgb: [u8; 3]) -> Option<tauri::image::Image<'static>> {
    let n = ICON as usize;
    if badge.len() != n * n * 4 {
        return None;
    }
    let big = blob_icon(&DOCK_LAYERS, 1, rgb)?;
    let blob = shrink(big.rgba(), big.width(), big.height(), BADGED_BLOB);
    let mut px = vec![0u8; n * n * 4];
    let b = BADGED_BLOB as usize;
    for y in 0..b {
        px[(y + 1) * n * 4..][..b * 4].copy_from_slice(&blob[y * b * 4..][..b * 4]);
    }
    px.chunks_mut(4).zip(badge.chunks(4)).for_each(|(d, s)| paint_over(d, s));
    Some(tauri::image::Image::new_owned(px, ICON, ICON))
}

fn paint_badged(w: &WebviewWindow, badge: &[u8], rgb: [u8; 3]) {
    let Some(icon) = badged_icon(badge, rgb) else { return };
    // On macOS the big icon is the whole app's Dock icon: never an extension's.
    #[cfg(not(target_os = "macos"))]
    win::set_big_icon(w, icon.rgba(), icon.width(), icon.height());
    let _ = w.set_icon(icon);
}

/// An extension window's page hands over its badge (a PNG, base64, `ICON` px square): the window
/// and its taskbar button get the blob with that badge.
#[tauri::command]
pub fn extension_icon(window: WebviewWindow, png: String) -> Result<(), String> {
    use base64::Engine as _;
    if !window.label().starts_with(crate::extensions::LABEL_PREFIX) {
        return Err("Only extension windows have badges".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(png.as_bytes()).map_err(|e| e.to_string())?;
    let (px, w, h) = decode_rgba(&bytes).ok_or("Not a PNG")?;
    if (w, h) != (ICON, ICON) {
        return Err(format!("The badge must be {ICON} px square"));
    }
    let rgb = *ACCENT.lock().unwrap_or_else(|e| e.into_inner());
    {
        let mut badges = BADGES.lock().unwrap_or_else(|e| e.into_inner());
        badges.retain(|(l, _)| l != window.label());
        badges.push((window.label().to_string(), px.clone()));
    }
    paint_badged(&window, &px, rgb);
    Ok(())
}

/// Forgets a closed extension window's badge.
pub fn forget_badge(label: &str) {
    BADGES.lock().unwrap_or_else(|e| e.into_inner()).retain(|(l, _)| l != label);
}

/// Recolours the taskbar and tray icons to the accent picked in Settings ("#rrggbb").
#[tauri::command]
pub fn set_icon_color(app: AppHandle, color: String) {
    let hex = color.trim_start_matches('#');
    let Some(rgb) = (hex.len() == 6)
        .then(|| [0, 2, 4].map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()))
        .and_then(|[r, g, b]| Some([r?, g?, b?]))
    else {
        return;
    };
    *ACCENT.lock().unwrap_or_else(|e| e.into_inner()) = rgb;
    let badges = BADGES.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for (label, badge) in badges {
        if let Some(w) = app.get_webview_window(&label) {
            paint_badged(&w, &badge, rgb);
        }
    }
    if let (Some(main), Some(icon)) = (app.get_webview_window("main"), blob_icon(&WINDOW_LAYERS, 1, rgb)) {
        // The taskbar (Windows) or Dock (macOS) shows the big icon, which Tauri leaves alone.
        #[cfg(target_os = "macos")]
        let big = blob_icon(&DOCK_LAYERS, 1, rgb);
        #[cfg(not(target_os = "macos"))]
        let big = Some(icon.clone());
        if let Some(big) = big {
            win::set_big_icon(&main, big.rgba(), big.width(), big.height());
        }
        let _ = main.set_icon(icon);
    }
    if let (Some(tray), Some(icon)) = (app.tray_by_id("main"), blob_icon(&TRAY_LAYERS, 0, rgb)) {
        let _ = tray.set_icon(Some(icon));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_take_the_accent_colour() {
        let pink = [0xd6, 0x33, 0x6c];
        for (layers, body, (x, y)) in [(&WINDOW_LAYERS[..], 1, (13, 42)), (&TRAY_LAYERS[..], 0, (6, 18))] {
            let icon = blob_icon(layers, body, pink).expect("icon layers decode");
            let (w, px) = (icon.width() as usize, icon.rgba());
            let at = |x: usize, y: usize| px[(y * w + x) * 4..(y * w + x) * 4 + 4].to_vec();
            assert_eq!(at(x, y), vec![0xd6, 0x33, 0x6c, 255], "body pixel takes the accent");
            assert_eq!(at(0, 0)[3], 0, "corners stay transparent");
        }
    }

    #[test]
    fn extension_icons_are_the_blob_with_a_badge() {
        let n = ICON as usize;
        // A badge that's one solid ink square in the bottom-right corner.
        let mut badge = vec![0u8; n * n * 4];
        for y in 48..60 {
            for x in 48..60 {
                badge[(y * n + x) * 4..][..4].copy_from_slice(&[0x2b, 0x25, 0x40, 255]);
            }
        }
        let pink = [0xd6, 0x33, 0x6c];
        let icon = badged_icon(&badge, pink).expect("icon");
        let px = icon.rgba();
        let at = |x: usize, y: usize| px[(y * n + x) * 4..][..4].to_vec();
        assert_eq!(at(54, 54), vec![0x2b, 0x25, 0x40, 255], "the badge sits on top");
        assert_eq!(at(63, 0)[3], 0, "the corner stays see-through");
        let body = (0..BADGED_BLOB as usize).flat_map(|y| (0..BADGED_BLOB as usize).map(move |x| (x, y))).any(|(x, y)| at(x, y + 1) == vec![0xd6, 0x33, 0x6c, 255]);
        assert!(body, "the shrunk blob takes the accent");
        assert!(badged_icon(&badge[4..], pink).is_none(), "a badge of the wrong size is refused");
    }

    #[test]
    fn light_accents_get_an_ink_face() {
        assert!(!dark_face(GRAPE));
        assert!(!dark_face([0x00, 0x00, 0x00]));
        assert!(dark_face([0xff, 0xd1, 0x66])); // a pale yellow
        assert!(dark_face([0xff, 0xff, 0xff]));
    }
}
