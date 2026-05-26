fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        let profile = std::env::var("PROFILE").unwrap_or_default();
        if profile == "release" {
            println!("cargo:rustc-link-arg=/SUBSYSTEM:WINDOWS");
        }
    }
    tauri_build::build()
}
