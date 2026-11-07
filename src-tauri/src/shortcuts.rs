//! Quicky's global shortcuts: quick add (open or close Quicky), show or hide the bubble, and the
//! screen tools (opening in Screenshot, or straight in Draw or Record). Each has default keys per
//! system (Draw and Record none: Ctrl+Shift+S and Ctrl+Shift+R are Save As and reload in most
//! apps, too common to take from every app); Settings → Shortcuts changes them (`shortcuts` in
//! the config, per PC). They're registered here, live: changing one re-registers them all, and a
//! combination another app owns is reported as taken (the old keys stay).
//! The screen tools' keys are only registered while their extension (`draw`) is installed, so
//! Quicky doesn't take Ctrl+Shift+D from other apps for nothing.

use crate::config::{read_config, update_config, Config};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Action {
    Quick,
    Bubble,
    /// The screen tools, opening in this mode (`draw::MODES`).
    Screen(&'static str),
}

/// Every global shortcut and its id (the config's and the page's name for it).
const ACTIONS: [(Action, &str); 5] = [
    (Action::Quick, "quick"),
    (Action::Bubble, "bubble"),
    (Action::Screen("shot"), "screen"),
    (Action::Screen("draw"), "draw"),
    (Action::Screen("record"), "record"),
];

/// The keys each action has until the user changes them. macOS also gets Option versions of the
/// Ctrl ones: Ctrl+Space switches keyboard input sources there, and macOS keeps it when that's on.
fn defaults(id: &str, mac: bool) -> Vec<String> {
    let keys: &[&str] = match (id, mac) {
        ("quick", true) => &["Alt+Space", "Ctrl+Space"],
        ("quick", false) => &["Ctrl+Space"],
        ("bubble", true) => &["Alt+Shift+Space", "Ctrl+Shift+Space"],
        ("bubble", false) => &["Ctrl+Shift+Space"],
        ("screen", true) => &["Alt+Shift+D"],
        ("screen", false) => &["Ctrl+Shift+D"],
        _ => &[],
    };
    keys.iter().map(|k| k.to_string()).collect()
}

const MAC: bool = cfg!(target_os = "macos");

/// The keys an action has now (the user's, else the defaults).
fn keys_of(cfg: &Config, id: &str) -> Vec<String> {
    cfg.shortcuts.get(id).cloned().unwrap_or_else(|| defaults(id, MAC))
}

/// What's registered now, for the handler: each shortcut and what it does.
static ACTIVE: Mutex<Vec<(Shortcut, Action)>> = Mutex::new(Vec::new());
/// Keys that couldn't be registered (another app has them), by action id.
static TAKEN: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
/// One `apply` at a time: two at once (a pause ending while new keys are saved) would each find
/// the other's keys registered and report them taken.
static APPLYING: Mutex<()> = Mutex::new(());
/// Settings is recording a new combination: nothing is registered meanwhile, so the keys reach
/// the page (a registered one never does).
static PAUSED: AtomicBool = AtomicBool::new(false);
static PAUSE_RUN: AtomicU64 = AtomicU64::new(0);

/// The same keys written one way: modifiers as Ctrl, Alt, Shift, Super in that order, then the
/// key (letters and digits bare, everything else by its key code name, like "Space" or "F5").
/// `src/lib/keys.ts` writes them the same way.
pub fn canonical(s: &Shortcut) -> String {
    let mut out = String::new();
    for (m, name) in [(Modifiers::CONTROL, "Ctrl"), (Modifiers::ALT, "Alt"), (Modifiers::SHIFT, "Shift"), (Modifiers::SUPER, "Super")] {
        if s.mods.contains(m) {
            out.push_str(name);
            out.push('+');
        }
    }
    let key = s.key.to_string();
    let bare = key.strip_prefix("Key").or_else(|| key.strip_prefix("Digit")).filter(|k| k.len() == 1);
    out.push_str(bare.unwrap_or(&key));
    out
}

/// Checks keys for a global shortcut: a key Quicky understands, held with Ctrl, Alt or
/// Super (⌘) so it doesn't swallow typing, and not Esc or Backspace (they cancel and clear
/// while recording). Gives the canonical form.
pub fn validate(keys: &str) -> Result<(Shortcut, String), &'static str> {
    let s: Shortcut = keys.parse().map_err(|_| "Quicky doesn't know that key")?;
    if !s.mods.intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER) {
        return Err("Hold Ctrl, Alt or the system key with it");
    }
    if matches!(s.key, Code::Escape | Code::Backspace) {
        return Err("Esc and Backspace can't be shortcuts");
    }
    Ok((s, canonical(&s)))
}

/// Runs the action of a global shortcut that was pressed.
pub fn fire(app: &AppHandle, shortcut: &Shortcut) {
    let action = ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(s, _)| s == shortcut).map(|(_, a)| *a);
    match action {
        Some(Action::Quick) => crate::main_window::quick_add(app),
        Some(Action::Bubble) => {
            // The saved choice, not what's on screen: a goodbye still playing counts as hidden.
            let show = !read_config(app).show_bubble;
            let _ = crate::bubble::set_show_bubble(app.clone(), show);
        }
        Some(Action::Screen(mode)) => crate::draw::toggle(app, mode),
        None => {}
    }
}

/// Registers every shortcut as the config says (after letting go of the old ones). Waits on the
/// main thread: call it from start-up or another thread, never from a sync command.
pub fn apply(app: &AppHandle) {
    // Held across the main-thread waits: nothing on the main thread takes it.
    let _one = APPLYING.lock().unwrap_or_else(|e| e.into_inner());
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut active = Vec::new();
    let mut taken = Vec::new();
    if !PAUSED.load(Ordering::SeqCst) {
        let cfg = read_config(app);
        let draw = crate::extensions::installed(app, crate::draw::EXTENSION);
        for (action, id) in ACTIONS {
            if matches!(action, Action::Screen(_)) && !draw {
                continue;
            }
            for keys in keys_of(&cfg, id) {
                let Ok((s, _)) = validate(&keys) else { continue };
                // The same keys twice (an old config): the first action keeps them.
                if active.iter().any(|(a, _): &(Shortcut, Action)| a.id() == s.id()) {
                    continue;
                }
                match gs.register(s) {
                    Ok(()) => active.push((s, action)),
                    Err(e) => {
                        eprintln!("The {id} shortcut {keys} is taken by another app: {e}");
                        taken.push((id.to_string(), keys));
                    }
                }
            }
        }
    }
    *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = active;
    *TAKEN.lock().unwrap_or_else(|e| e.into_inner()) = taken;
    let _ = app.emit("shortcuts-changed", ());
}

/// `apply` from a thread of its own (for code on the main thread).
pub fn apply_later(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || apply(&app));
}

#[derive(Serialize)]
pub struct ShortcutInfo {
    id: &'static str,
    keys: Vec<String>,
    defaults: Vec<String>,
    /// Keys another app owns (they do nothing in Quicky).
    taken: Vec<String>,
    /// The screen tools without their extension: the keys are kept, but not registered.
    available: bool,
}

/// Every global shortcut, its keys and whether they work.
#[tauri::command]
pub fn shortcuts_get(app: AppHandle) -> Vec<ShortcutInfo> {
    let cfg = read_config(&app);
    let taken = TAKEN.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let draw = crate::extensions::installed(&app, crate::draw::EXTENSION);
    ACTIONS
        .iter()
        .map(|&(action, id)| ShortcutInfo {
            id,
            keys: keys_of(&cfg, id),
            defaults: defaults(id, MAC),
            taken: taken.iter().filter(|(t, _)| t == id).map(|(_, k)| k.clone()).collect(),
            available: !matches!(action, Action::Screen(_)) || draw,
        })
        .collect()
}

/// Gives an action new keys (`None`: back to its defaults; an empty list: no shortcut). Refused
/// when they're not valid, already used by another action, or another app owns them (then the
/// old keys stay).
#[tauri::command]
pub async fn shortcut_set(app: AppHandle, id: String, keys: Option<Vec<String>>) -> Result<(), String> {
    PAUSED.store(false, Ordering::SeqCst);
    let Some(&(_, id)) = ACTIONS.iter().find(|(_, i)| *i == id) else { return Err("No such shortcut".into()) };
    let keys = keys.unwrap_or_else(|| defaults(id, MAC));
    let mut clean = Vec::new();
    let cfg = read_config(&app);
    for k in &keys {
        let (s, c) = validate(k)?;
        for &(_, other) in ACTIONS.iter().filter(|(_, o)| *o != id) {
            if keys_of(&cfg, other).iter().any(|o| validate(o).is_ok_and(|(os, _)| os.id() == s.id())) {
                return Err(format!("Already used to {}", what(other)));
            }
        }
        if !clean.contains(&c) {
            clean.push(c);
        }
    }
    let old = cfg.shortcuts.get(id).cloned();
    let store = |v: Option<Vec<String>>| {
        update_config(&app, |c| match v {
            Some(v) if v != defaults(id, MAC) => {
                c.shortcuts.insert(id.to_string(), v);
            }
            _ => {
                c.shortcuts.remove(id);
            }
        })
    };
    store(Some(clean.clone()))?;
    apply(&app);
    let taken = TAKEN.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(t, k)| t == id && clean.contains(k));
    if taken {
        store(old)?;
        apply(&app);
        return Err("Taken by another app".into());
    }
    Ok(())
}

/// Every shortcut back to its defaults.
#[tauri::command]
pub async fn shortcuts_reset(app: AppHandle) -> Result<(), String> {
    PAUSED.store(false, Ordering::SeqCst);
    update_config(&app, |c| c.shortcuts.clear())?;
    apply(&app);
    Ok(())
}

/// Settings is recording keys (`true`) or done (`false`). A pause ends by itself after a while,
/// in case the page never says it's done.
#[tauri::command]
pub async fn shortcuts_pause(app: AppHandle, paused: bool) {
    let run = PAUSE_RUN.fetch_add(1, Ordering::SeqCst) + 1;
    if PAUSED.swap(paused, Ordering::SeqCst) == paused {
        return;
    }
    apply(&app);
    if paused {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(30));
            if PAUSE_RUN.load(Ordering::SeqCst) == run && PAUSED.swap(false, Ordering::SeqCst) {
                apply(&app);
            }
        });
    }
}

/// Tries the shortcuts another app had again (it may have let go of them).
#[tauri::command]
pub async fn shortcuts_retry(app: AppHandle) {
    if !PAUSED.load(Ordering::SeqCst) && !TAKEN.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
        apply(&app);
    }
}

/// What an action does, for "Already used to …".
fn what(id: &str) -> &'static str {
    match id {
        "quick" => "open Quicky",
        "bubble" => "show or hide the bubble",
        "screen" => "open the screen tools",
        "draw" => "draw on screen",
        _ => "record the screen",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(keys: &str) -> String {
        validate(keys).map(|(_, c)| c).unwrap_or_else(|e| panic!("{keys}: {e}"))
    }

    #[test]
    fn keys_are_written_one_way() {
        assert_eq!(ok("Ctrl+Shift+D"), "Ctrl+Shift+D");
        assert_eq!(ok("shift+control+KeyD"), "Ctrl+Shift+D");
        assert_eq!(ok("alt+space"), "Alt+Space");
        assert_eq!(ok("Super+Digit1"), "Super+1");
        assert_eq!(ok("Command+F5"), "Super+F5");
        assert_eq!(ok("Option+Shift+ArrowUp"), "Alt+Shift+ArrowUp");
        assert_eq!(ok("Ctrl+Numpad1"), "Ctrl+Numpad1");
        assert_eq!(ok("Ctrl+Comma"), "Ctrl+Comma");
    }

    #[test]
    fn global_keys_need_a_real_modifier() {
        assert!(validate("D").is_err());
        assert!(validate("Shift+D").is_err());
        assert!(validate("Ctrl+Escape").is_err());
        assert!(validate("Alt+Backspace").is_err());
        assert!(validate("Ctrl+Shift").is_err());
        assert!(validate("Ctrl+NotAKey").is_err());
        assert!(validate("").is_err());
    }

    #[test]
    fn defaults_are_valid_and_dont_clash() {
        for mac in [false, true] {
            let mut seen = Vec::new();
            for (_, id) in ACTIONS {
                let keys = defaults(id, mac);
                // Draw and Record start unbound (see the top of this file).
                assert_eq!(keys.is_empty(), matches!(id, "draw" | "record"), "{id}'s default");
                for k in keys {
                    let (s, c) = validate(&k).unwrap();
                    assert_eq!(c, k, "defaults are written canonically");
                    assert!(!seen.contains(&s.id()), "{k} is used twice");
                    seen.push(s.id());
                }
            }
        }
    }
}
