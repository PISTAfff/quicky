//! Taskbar, Dock and tray icons in the accent colour.
//!
//! Both are Quicky's blob, drawn from layers in `live-icons/` (rendered from brand/logo): what sits
//! under the body (its hard shadow), the body (white, tinted to the accent), and what sits over it
//! (outline and face). The tray uses the small, outline-free blob.

use crate::win;
use tauri::{AppHandle, Manager};

const WINDOW_LAYERS: [&[u8]; 3] = [
    include_bytes!("../live-icons/window-under.png"),
    include_bytes!("../live-icons/window-body.png"),
    include_bytes!("../live-icons/window-over.png"),
];
pub(crate) const TRAY_LAYERS: [&[u8]; 2] = [include_bytes!("../live-icons/tray-body.png"), include_bytes!("../live-icons/tray-face.png")];
/// The Dock shows icons much bigger than a taskbar does.
#[cfg(target_os = "macos")]
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
    fn light_accents_get_an_ink_face() {
        assert!(!dark_face(GRAPE));
        assert!(!dark_face([0x00, 0x00, 0x00]));
        assert!(dark_face([0xff, 0xd1, 0x66])); // a pale yellow
        assert!(dark_face([0xff, 0xff, 0xff]));
    }
}
