//! Quicky's Android side. Everything here is Kotlin (`android/`): the page calls its commands
//! straight through `invoke("plugin:quicky-android|<command>")` (see `src/mobile/native.ts`), so
//! this crate only registers the Kotlin plugin class.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("quicky-android")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("app.quicky.android", "QuickyPlugin")?;
            Ok(())
        })
        .build()
}
