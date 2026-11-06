//! The user's data folder: `quicky.json` plus `media/<YYYY-MM>/`. All reading and writing of it
//! happens here.

use crate::config::{read_config, update_config};
use serde::Serialize;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

const DATA_FILE: &str = "quicky.json";
const MEDIA_DIR: &str = "media";

#[derive(Serialize)]
pub struct Attachment {
    path: String,
    name: String,
    kind: String,
}

/// Writes via a temp file + rename so a crash or a sync client never sees half a file. The temp
/// file is flushed to disk before the rename (a power cut can't leave an empty file behind), has a
/// name of its own per process (two PCs syncing one folder never share it), and the rename is
/// retried for a moment when a sync client or virus scanner briefly holds the file.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("data");
    let tmp = path.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    let written = fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    let mut tries = 0;
    loop {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) if tries < 10 && held_by_another(&e) => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e.to_string());
            }
        }
    }
}

/// The file is open in another program for a moment (a sync client, a virus scanner): Windows
/// reports access denied, or a sharing or lock violation (errors 32 and 33).
fn held_by_another(e: &std::io::Error) -> bool {
    e.kind() == ErrorKind::PermissionDenied || (cfg!(windows) && matches!(e.raw_os_error(), Some(32 | 33)))
}

/// What this Quicky last read from or wrote to quicky.json, by content hash: `None` before the
/// first load, `Some(None)` when there was no file. A save checks the file still holds that, so
/// changes synced in from another PC aren't written over.
static KNOWN: Mutex<Option<Option<u64>>> = Mutex::new(None);

/// The page's cue that quicky.json changed on disk since it last read it (see `save_data`).
const CHANGED: &str = "CHANGED_ON_DISK";

fn hash(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// The file's text, or None when there's no file. Any other error is an error: a file that's
/// there but can't be read must never look like a fresh start.
fn read_text(file: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(file) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// The JSON in a quicky.json, or an error when it's empty (a crash or an unfinished sync can
/// leave an empty file; loading it as an empty list would save over whatever could be restored).
fn data_text(text: &str) -> Result<&str, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim_matches(|c: char| c.is_whitespace() || c == '\0').is_empty() {
        return Err("quicky.json is empty".into());
    }
    Ok(text)
}

fn known() -> std::sync::MutexGuard<'static, Option<Option<u64>>> {
    KNOWN.lock().unwrap_or_else(|e| e.into_inner())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = read_config(app).data_dir.ok_or("No data folder chosen")?;
    let dir = PathBuf::from(dir);
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err("Data folder is missing".into())
    }
}

fn allow_media(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

fn kind_of(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "svg" => "image",
        "mp4" | "webm" | "mov" | "mkv" | "m4v" => "video",
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac" | "opus" | "weba" => "audio",
        _ => "file",
    }
}

fn safe_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let clean: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if clean.is_empty() {
        "file".into()
    } else {
        clean
    }
}

/// Picks a free `media/<month>/<millis>-<name>` path and returns (absolute, relative).
fn media_target(root: &Path, month: &str, name: &str) -> Result<(PathBuf, String), String> {
    let month = safe_name(month);
    let dir = root.join(MEDIA_DIR).join(&month);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file = format!("{stamp}-{}", safe_name(name));
    Ok((dir.join(&file), format!("{MEDIA_DIR}/{month}/{file}")))
}

#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> Option<String> {
    let dir = data_dir(&app).ok()?;
    allow_media(&app, &dir);
    Some(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn set_data_dir(app: AppHandle, path: String) -> Result<String, String> {
    let dir = quicky_folder(PathBuf::from(&path));
    fs::create_dir_all(dir.join(MEDIA_DIR)).map_err(|e| e.to_string())?;
    let path = dir.to_string_lossy().into_owned();
    update_config(&app, |c| c.data_dir = Some(path.clone()))?;
    // Nothing read from the new folder yet: a save waits for the page to load it.
    *known() = None;
    allow_media(&app, &dir);
    Ok(path)
}

/// Always keeps data in its own "Quicky" folder inside whatever the user picked,
/// unless they picked a Quicky folder (or one that already holds Quicky data).
fn quicky_folder(picked: PathBuf) -> PathBuf {
    let is_quicky = picked
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("Quicky"));
    if is_quicky || picked.join(DATA_FILE).is_file() {
        picked
    } else {
        picked.join("Quicky")
    }
}

// Desktop only: the phone has no folder to pick or open, and its files come from a picker.
#[cfg(desktop)]
#[tauri::command]
pub fn default_data_dir(app: AppHandle) -> Result<String, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Quicky").to_string_lossy().into_owned())
}

// The data commands are async so reading, hashing and syncing to disk never stall the windows
// (sync commands run on the main thread).

/// quicky.json's JSON, or None when the folder has none yet (a fresh start). An empty or
/// unreadable file is an error, so nothing gets saved over it.
#[tauri::command]
pub async fn load_data(app: AppHandle) -> Result<Option<String>, String> {
    let file = data_dir(&app)?.join(DATA_FILE);
    let Some(text) = read_text(&file)? else {
        *known() = Some(None);
        return Ok(None);
    };
    let json = data_text(&text)?.to_string();
    *known() = Some(Some(hash(&text)));
    Ok(Some(json))
}

/// Saves quicky.json, unless it changed on disk since this Quicky last read or wrote it (another
/// PC synced its changes in): then it fails with `CHANGED`, and the page loads, merges and saves.
#[tauri::command]
pub async fn save_data(app: AppHandle, json: String) -> Result<(), String> {
    let file = data_dir(&app)?.join(DATA_FILE);
    if changed_on_disk(&file)? {
        return Err(CHANGED.into());
    }
    write_atomic(&file, json.as_bytes())?;
    *known() = Some(Some(hash(&json)));
    Ok(())
}

/// Whether quicky.json now holds something this Quicky hasn't seen (checked on focus and on the
/// reminder tick, so another PC's changes show up).
#[tauri::command]
pub async fn data_changed(app: AppHandle) -> Result<bool, String> {
    changed_on_disk(&data_dir(&app)?.join(DATA_FILE))
}

fn changed_on_disk(file: &Path) -> Result<bool, String> {
    let known = *known();
    // A file that's gone (moved away, or not synced back yet) is simply written again.
    let Some(text) = read_text(file)? else { return Ok(false) };
    // Never read here (the folder was just switched): whatever is there must be loaded first.
    Ok(known.is_none_or(|k| k != Some(hash(&text))))
}

#[cfg(desktop)]
#[tauri::command]
pub fn import_files(
    app: AppHandle,
    paths: Vec<String>,
    month: String,
) -> Result<Vec<Attachment>, String> {
    let root = data_dir(&app)?;
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let src = PathBuf::from(&p);
        if !src.is_file() {
            continue;
        }
        let name = src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let (abs, rel) = media_target(&root, &month, &name)?;
        fs::copy(&src, &abs).map_err(|e| e.to_string())?;
        out.push(Attachment {
            kind: kind_of(&name).into(),
            path: rel,
            name,
        });
    }
    Ok(out)
}

/// Raw-body command: pasted images and recorded voice notes arrive as bytes, not JSON arrays.
#[tauri::command]
pub fn save_blob(app: AppHandle, request: Request<'_>) -> Result<Attachment, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let name = header("x-name").unwrap_or_else(|| "file".into());
    let month = header("x-month").unwrap_or_else(|| "misc".into());
    let (abs, rel) = media_target(&data_dir(&app)?, &month, &name)?;
    fs::write(&abs, bytes).map_err(|e| e.to_string())?;
    // .webm can be audio or video, so the page may say which.
    let kind = match header("x-kind").as_deref() {
        Some(k @ ("image" | "video" | "audio" | "file")) => k.to_string(),
        _ => kind_of(&name).into(),
    };
    Ok(Attachment {
        kind,
        path: rel,
        name,
    })
}

fn resolve_media(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    if !rel.starts_with("media/") || rel.contains("..") {
        return Err("Not a media path".into());
    }
    Ok(data_dir(app)?.join(rel))
}

#[cfg(desktop)]
#[tauri::command]
pub fn open_media(app: AppHandle, rel: String) -> Result<(), String> {
    let abs = resolve_media(&app, &rel)?;
    app.opener()
        .open_path(abs.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_media(app: AppHandle, rel: String) -> Result<(), String> {
    let abs = resolve_media(&app, &rel)?;
    if abs.exists() {
        fs::remove_file(abs).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Task sync (`src/lib/sync.ts`) moves attached files to and from Quicky's server by their
// relative path, so another PC finds them where its tasks say they are.

/// Whether an attachment's file is in this PC's data folder.
#[tauri::command]
pub fn media_exists(app: AppHandle, rel: String) -> bool {
    resolve_media(&app, &rel).is_ok_and(|p| p.is_file())
}

/// An attachment's bytes, for uploading.
#[tauri::command]
pub async fn read_media(app: AppHandle, rel: String) -> Result<tauri::ipc::Response, String> {
    let abs = resolve_media(&app, &rel)?;
    fs::read(abs).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Raw-body command: a downloaded attachment, saved at its relative path (header `x-path`).
#[tauri::command]
pub fn write_media(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let rel = request.headers().get("x-path").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let abs = resolve_media(&app, rel)?;
    if let Some(dir) = abs.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_atomic(&abs, bytes)
}

#[cfg(desktop)]
#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picked_folder_gets_a_quicky_subfolder() {
        let tmp = std::env::temp_dir().join(format!("qk-test-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        assert_eq!(quicky_folder(tmp.clone()), tmp.join("Quicky"));
        assert_eq!(quicky_folder(tmp.join("quicky")), tmp.join("quicky"));

        // A folder that already holds Quicky data is reused as is.
        let existing = tmp.join("Tasks");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join(DATA_FILE), "{}").unwrap();
        assert_eq!(quicky_folder(existing.clone()), existing);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_missing_file_is_a_fresh_start_but_an_empty_one_is_an_error() {
        let tmp = std::env::temp_dir().join(format!("qk-read-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        assert_eq!(read_text(&tmp.join(DATA_FILE)), Ok(None));

        assert!(data_text("").is_err());
        assert!(data_text("  \r\n\0\0").is_err());
        assert!(data_text("\u{feff}").is_err());
        // A byte-order mark from a hand edit in Notepad is dropped, not a parse error.
        assert_eq!(data_text("\u{feff}{\"tasks\":[]}"), Ok("{\"tasks\":[]}"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn writes_replace_the_file_and_leave_no_temp_behind() {
        let tmp = std::env::temp_dir().join(format!("qk-write-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join(DATA_FILE);
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "two");
        assert_eq!(fs::read_dir(&tmp).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_save_notices_a_file_changed_by_another_pc() {
        let tmp = std::env::temp_dir().join(format!("qk-sync-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join(DATA_FILE);
        fs::write(&file, "{\"a\":1}").unwrap();
        *known() = Some(Some(hash("{\"a\":1}")));
        assert_eq!(changed_on_disk(&file), Ok(false));
        fs::write(&file, "{\"a\":2}").unwrap();
        assert_eq!(changed_on_disk(&file), Ok(true));
        // Gone from disk: just written again.
        fs::remove_file(&file).unwrap();
        assert_eq!(changed_on_disk(&file), Ok(false));
        // A folder never read (just switched to) must be loaded before anything is saved there.
        *known() = None;
        fs::write(&file, "{\"a\":3}").unwrap();
        assert_eq!(changed_on_disk(&file), Ok(true));
        let _ = fs::remove_dir_all(&tmp);
    }
}
