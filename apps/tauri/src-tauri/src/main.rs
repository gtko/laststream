// Pas de console sous Windows en version finale.
#![cfg_attr(all(not(test), not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    laststream_tauri_lib::run();
}
