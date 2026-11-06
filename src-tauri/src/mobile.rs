//! The Android app: one full-screen window (`mobile.html`), no bubble, tray or shortcut. It keeps
//! its tasks in a `Quicky` folder inside the app's own storage (the offline copy; with an account
//! the server's copy is synced in by the page, like on a PC) and shares the data and extension
//! commands with the desktop. Notifications and home-screen widgets live in the
//! `tauri-plugin-quicky-android` plugin (`src-tauri/android-plugin`).

use crate::config::read_config;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_quicky_android::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // No folder to choose on a phone: the app's own storage, from the first start.
            if read_config(&handle).data_dir.is_none() {
                let dir = handle.path().app_data_dir()?.join("Quicky");
                crate::data::set_data_dir(handle.clone(), dir.to_string_lossy().into_owned())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::data::get_data_dir,
            crate::data::load_data,
            crate::data::save_data,
            crate::data::data_changed,
            crate::data::save_blob,
            crate::data::remove_media,
            crate::data::media_exists,
            crate::data::read_media,
            crate::data::write_media,
            crate::extensions::extension_save,
            crate::extensions::extension_remove,
            crate::extensions::extension_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quicky");
}
