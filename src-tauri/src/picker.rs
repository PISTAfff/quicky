//! The colour picker's eyedropper: reads the colour under the pointer anywhere on screen, sends it
//! to the page while the pointer moves, and returns the one under a left click (right click or
//! 30 seconds cancel). The page uses this when the web view has no EyeDropper of its own.

use crate::win;
use std::thread::sleep;
use std::time::{Duration, Instant};
use tauri::{Emitter, WebviewWindow};

fn hex((r, g, b): (u8, u8, u8)) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

#[tauri::command]
pub async fn pick_screen_color(window: WebviewWindow) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        // The click that started picking is still down: wait for it to end first.
        let start = Instant::now();
        while win::left_button_down() && start.elapsed() < Duration::from_secs(2) {
            sleep(Duration::from_millis(10));
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut last = None;
        loop {
            if Instant::now() > deadline || win::right_button_down() {
                return None;
            }
            let c = win::color_under_cursor();
            if c != last {
                if let Some(c) = c {
                    let _ = window.emit_to(window.label(), "picker-color", hex(c));
                }
                last = c;
            }
            if win::left_button_down() {
                return c.map(hex);
            }
            sleep(Duration::from_millis(16));
        }
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    #[test]
    fn colours_are_lower_case_hex() {
        assert_eq!(super::hex((255, 0, 18)), "#ff0012");
    }
}
