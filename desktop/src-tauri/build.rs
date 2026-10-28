fn main() {
    // The UI is embedded at compile time; rebuild when any of its files change.
    println!("cargo:rerun-if-changed=../ui");
    tauri_build::build()
}
