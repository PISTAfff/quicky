fn main() {
    // Recording the screen uses Media Foundation, which Windows N editions leave out unless the
    // Media Feature Pack is installed: load its DLLs only when Record is used (`win::can_record`
    // checks first), so Quicky still starts without them.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        for dll in ["mfplat.dll", "mfreadwrite.dll"] {
            println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
        }
        println!("cargo:rustc-link-lib=delayimp");
    }
    tauri_build::build()
}
