//! The tray icon: a left click opens the general list by the tray (or tucks it away); its menu
//! has Show Quicky, Show bubble and Quit.

use crate::{bubble, icons, main_window, win};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::App;

pub fn create(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Quicky", true, None::<&str>)?;
    let bubble_item = MenuItem::with_id(app, "bubble", "Show bubble", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &bubble_item, &quit_item])?;
    TrayIconBuilder::with_id("main")
        .icon(icons::blob_icon(&icons::TRAY_LAYERS, 0, icons::GRAPE).unwrap_or_else(|| app.default_window_icon().unwrap().clone()))
        .tooltip("Quicky")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => main_window::open_from_tray(app, win::cursor()),
            "bubble" => {
                let _ = bubble::set_show_bubble(app.clone(), true);
            }
            "quit" => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = e
            {
                main_window::toggle_main(tray.app_handle(), (position.x as i32, position.y as i32));
            }
        })
        .build(app)?;
    Ok(())
}
