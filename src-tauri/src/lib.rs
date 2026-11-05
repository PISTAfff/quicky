//! Quicky's backend: wires the plugins, windows, tray, shortcut and commands together. Each job
//! lives in a module of its own; this file only connects them.

mod balloon;
mod bubble;
mod config;
mod data;
mod extensions;
mod fx;
mod trail;
mod icons;
mod main_window;
mod menu;
mod picker;
mod reminder;
mod tray;
// Native window calls behind one set of functions: Win32 on Windows, AppKit and CoreGraphics on
// macOS, X11 on Linux.
#[cfg_attr(windows, path = "win.rs")]
#[cfg_attr(target_os = "macos", path = "mac.rs")]
#[cfg_attr(target_os = "linux", path = "linux.rs")]
mod win;
#[cfg(not(windows))]
mod own;

use crate::config::{read_config, update_config};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const STARTUP_ARG: &str = "--startup";

/// Reminders wait while this is true (when the user asked for that): a full-screen app is in front.
#[tauri::command]
fn system_busy() -> bool {
    win::busy()
}

pub(crate) fn quit(app: &AppHandle) {
    // Let the page flush its pending save before the process goes away.
    let _ = app.emit("flush", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Linux: GTK on X11 even in a Wayland session (through XWayland), because Wayland doesn't let
    // an app place its own windows and the bubble lives by placing itself. WebKitGTK's DMA-BUF
    // renderer is skipped too: it leaves windows blank on some graphics drivers.
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the first thing Quicky does, before any other thread exists.
        if std::env::var_os("DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
            unsafe { std::env::set_var("GDK_BACKEND", "x11") };
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        }
    }
    // Ctrl+Space. macOS also gets Option+Space: Ctrl+Space switches keyboard input sources there,
    // and when that's turned on macOS keeps the key for itself (its own shortcuts come first).
    let ctrl_space = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
    #[cfg(target_os = "macos")]
    let quick_keys = [Shortcut::new(Some(Modifiers::ALT), Code::Space), ctrl_space];
    #[cfg(not(target_os = "macos"))]
    let quick_keys = [ctrl_space];

    tauri::Builder::default()
        // Launched by Windows at sign-in: start tucked away (tray + bubble only).
        .plugin(tauri_plugin_autostart::Builder::new().arg(STARTUP_ARG).build())
        // A second launch just brings up the running Quicky. `--preview-reminder` instead shows the
        // sample reminder (same as Settings → Reminders → Preview), handy for checking the overlay.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--preview-reminder") {
                let _ = app.emit_to("main", "preview-reminder", ());
            } else {
                main_window::show_main(app)
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if quick_keys.contains(shortcut) && event.state() == ShortcutState::Pressed {
                        main_window::quick_add(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        // Updates from GitHub Releases (signed latest.json); the page asks, the user installs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            for key in quick_keys {
                if let Err(e) = app.global_shortcut().register(key) {
                    eprintln!("The quick-add shortcut {key:?} is taken by another app: {e}");
                }
            }

            let handle = app.handle().clone();
            let cfg = read_config(&handle);
            if !cfg.autostart_initialized {
                let _ = app.autolaunch().enable();
                let _ = update_config(&handle, |c| c.autostart_initialized = true);
            }

            // Opened inside an app, the main window can't be moved or resized past the app's edges.
            if let Some(main) = app.get_webview_window("main") {
                win::keep_inside_host(&main);
            }
            bubble::SHOW.store(cfg.show_bubble, Ordering::Relaxed);
            bubble::place(&handle);
            if !std::env::args().any(|a| a == STARTUP_ARG) {
                main_window::show_main(&handle);
            }
            bubble::sync(&handle);
            bubble::housekeeping(&handle);

            tray::create(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                // Alt+F4 on the reminder answers it like Esc (snooze), so it's never left unanswered.
                WindowEvent::CloseRequested { api, .. } if window.label() == "reminder" => {
                    api.prevent_close();
                    reminder::dismiss(app);
                }
                WindowEvent::Destroyed if window.label() == "reminder" => reminder::destroyed(app),
                // Closing the app hides it to the tray (Ctrl+Space and the bubble keep working);
                // closing the bubble (Alt+F4) just switches the bubble off.
                WindowEvent::CloseRequested { api, .. } if !matches!(window.label(), "fx" | "balloon" | "menu") && !window.label().starts_with(extensions::LABEL_PREFIX) => {
                    api.prevent_close();
                    if matches!(window.label(), bubble::BUBBLE_LABEL | bubble::MINI_LABEL) {
                        // Only when the user closed one (Alt+F4 on it, so it's in front): closing the
                        // whole app from outside (taskkill, an installer) asks every window.
                        if window.is_focused().unwrap_or(false) {
                            let _ = bubble::set_show_bubble(app.clone(), false);
                        }
                    } else {
                        let _ = window.emit("flush", ());
                        main_window::remember_app_window(app);
                        let _ = window.hide();
                        bubble::sync(app);
                    }
                }
                // A popover: losing focus to another app tucks Quicky away (unless pinned).
                WindowEvent::Focused(false) if window.label() == "main" => main_window::on_main_blur(app),
                // Minimized: tucked away like closing (also when it wasn't in focus).
                WindowEvent::Resized(_) if window.label() == "main" => {
                    main_window::tuck_if_minimized(app);
                }
                WindowEvent::ScaleFactorChanged { .. } if matches!(window.label(), bubble::BUBBLE_LABEL | bubble::MINI_LABEL) => bubble::place(app),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            data::get_data_dir,
            data::set_data_dir,
            data::default_data_dir,
            data::load_data,
            data::save_data,
            data::data_changed,
            data::import_files,
            data::save_blob,
            data::open_media,
            data::remove_media,
            data::media_exists,
            data::read_media,
            data::write_media,
            data::open_data_dir,
            main_window::hide_main,
            main_window::set_pinned,
            icons::set_icon_color,
            system_busy,
            bubble::get_show_bubble,
            bubble::bubble_on_screen,
            bubble::set_show_bubble,
            bubble::bubble_mode,
            bubble::bubble_cheer,
            bubble::set_bubble_locked,
            bubble::reset_bubble,
            bubble::open_from_bubble,
            bubble::bubble_drag_start,
            bubble::bubble_carry_start,
            bubble::bubble_context,
            bubble::stick_bubble,
            bubble::unstick_bubble,
            bubble::stuck_apps,
            bubble::mini_drag_start,
            bubble::pointer_track_start,
            bubble::mini_drag_end,
            bubble::mini_pop,
            bubble::app_icon,
            balloon::balloon_focus,
            balloon::balloon_peek,
            balloon::balloon_state,
            menu::menu_prewarm,
            menu::bubble_menu_open,
            menu::menu_pending,
            menu::menu_show,
            menu::menu_hide,
            trail::trail_state,
            trail::trail_done,
            fx::fx_payload,
            fx::fx_ready,
            fx::fx_handoff,
            fx::fx_done,
            reminder::show_reminder,
            reminder::reminder_payload,
            reminder::reminder_wake_at,
            reminder::reminder_ready,
            reminder::close_reminder,
            extensions::extension_save,
            extensions::extension_remove,
            extensions::extension_file,
            extensions::open_extension,
            picker::pick_screen_color
        ])
        .build(tauri::generate_context!())
        .expect("error while building Quicky")
        .run(|app, event| match event {
            // Quitting from outside Quicky's own menu (Cmd+Q, logging out): save first.
            tauri::RunEvent::ExitRequested { code: None, api, .. } => {
                api.prevent_exit();
                quit(app);
            }
            // Clicking the Dock icon opens Quicky.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => main_window::show_main(app),
            _ => {}
        });
}

