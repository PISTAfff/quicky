//! Quicky's own settings (`config.json` in the app's config folder): where the data lives, the
//! bubble's spot and lock, and the apps that have a mini.

use crate::data::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// An app the bubble is stuck to: shown on that app's window (offset from its nearest corner)
/// whenever the app has focus.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StuckApp {
    pub exe: String,
    pub name: String,
    pub right: bool,
    pub bottom: bool,
    pub dx: i32,
    pub dy: i32,
    /// Where the app's own Quicky window sits inside it: gaps to its left/top/right/bottom edges
    /// (physical px). None = cover the app with a small margin.
    #[serde(default)]
    pub area: Option<[i32; 4]>,
    /// This mini is locked in place (each mini has its own lock, apart from the normal bubble's).
    #[serde(default)]
    pub locked: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    pub(crate) data_dir: Option<String>,
    pub(crate) show_bubble: bool,
    /// Start-with-Windows is switched on once on first run; after that it's the user's toggle.
    pub(crate) autostart_initialized: bool,
    /// Where the user dragged the bubble (physical px); None = bottom-left corner.
    pub(crate) bubble_pos: Option<(i32, i32)>,
    pub(crate) bubble_locked: bool,
    pub(crate) stuck_apps: Vec<StuckApp>,
    /// The sticky trail a dragged bubble or mini leaves is switched off (on unless the user says).
    pub(crate) trail_off: bool,
    /// Global shortcuts the user changed (`shortcuts.rs`): action id → its keys in the shortcut
    /// plugin's format ("Ctrl+Shift+D"); an empty list is no shortcut. Absent: the default.
    pub(crate) shortcuts: HashMap<String, Vec<String>>,
    /// Where the screen tools save screenshots and recordings (None: Pictures\Quicky and
    /// Videos\Quicky).
    pub(crate) shots_dir: Option<String>,
    pub(crate) videos_dir: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            data_dir: None,
            show_bubble: true,
            autostart_initialized: false,
            bubble_pos: None,
            bubble_locked: false,
            stuck_apps: Vec::new(),
            trail_off: false,
            shortcuts: HashMap::new(),
            shots_dir: None,
            videos_dir: None,
        }
    }
}

/// The config is read constantly by the bubble loop, so it lives in memory; disk is only written.
static CONFIG: Mutex<Option<Config>> = Mutex::new(None);

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn read_config(app: &AppHandle) -> Config {
    let mut cache = CONFIG.lock().unwrap_or_else(|e| e.into_inner());
    cache.get_or_insert_with(|| load_config(app)).clone()
}

/// Read-modify-write under one lock, so the bubble thread and commands never overwrite each other.
pub fn update_config(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    let mut cache = CONFIG.lock().unwrap_or_else(|e| e.into_inner());
    let cfg = cache.get_or_insert_with(|| load_config(app));
    change(cfg);
    let json = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    write_atomic(&config_path(app)?, &json)
}
