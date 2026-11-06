//! Installed extensions: their files on this PC and the window each one opens in.
//! The page downloads a bundle from Quicky's server (and checks its sha256) before handing it
//! here. Each extension is one HTML file in the app's data folder, shown by `extension.html` in a
//! sandboxed frame that can't reach Quicky's commands, files or sign-in.

use std::fs;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};
#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Window labels are `ext-<id>`; capabilities match them with `ext-*`.
#[cfg(desktop)]
pub const LABEL_PREFIX: &str = "ext-";

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (2..=41).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("extensions");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    // The extension's frame loads its file through the asset protocol.
    let _ = app.asset_protocol_scope().allow_directory(&d, false);
    Ok(d)
}

fn file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Not a valid extension id".into());
    }
    Ok(dir(app)?.join(format!("{id}.html")))
}

/// Saves a downloaded bundle (raw body; the id in the `x-id` header), replacing any older version.
#[tauri::command]
pub fn extension_save(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let id = request.headers().get("x-id").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let path = file(&app, id)?;
    let tmp = path.with_extension("html.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn extension_remove(app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window(&format!("{LABEL_PREFIX}{id}")) {
        let _ = w.destroy();
    }
    let path = file(&app, &id)?;
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Where an installed extension's file is, for the frame (None: not installed).
#[tauri::command]
pub fn extension_file(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let path = file(&app, &id)?;
    Ok(path.is_file().then(|| path.to_string_lossy().into_owned()))
}

/// Opens (or brings forward) an extension's own window, framed like Quicky's (its own title bar in
/// `extension.html`, no system frame), that really closes.
/// Async: making a window from a sync command deadlocks on Windows.
#[cfg(desktop)]
#[tauri::command]
pub async fn open_extension(app: AppHandle, id: String, title: String) -> Result<(), String> {
    if !file(&app, &id)?.is_file() {
        return Err("That extension isn't installed".into());
    }
    let label = format!("{LABEL_PREFIX}{id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("extension.html".into()))
        .title(title)
        // Must match the other windows' args (one shared WebView2 environment).
        .additional_browser_args(crate::reminder::BROWSER_ARGS)
        .decorations(false)
        .shadow(true)
        .inner_size(1180.0, 760.0)
        .min_inner_size(640.0, 420.0)
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::valid_id;

    #[test]
    fn extension_ids_are_plain_slugs() {
        assert!(valid_id("project"));
        assert!(valid_id("my-board2"));
        assert!(!valid_id("a"));
        assert!(!valid_id("Project"));
        assert!(!valid_id("../evil"));
        assert!(!valid_id("-start"));
        assert!(!valid_id(&"x".repeat(42)));
    }
}
