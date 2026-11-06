// The commands live in Kotlin (`android/`); listing them here generates their permissions.
const COMMANDS: &[&str] = &["widgets", "schedule", "actions", "permission"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
