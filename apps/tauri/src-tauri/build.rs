fn main() {
    // `shell_post` : unique commande Tauri, appelée par le polyfill `window.chrome.webview` (src/bridge.js).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["shell_post"])),
    )
    .expect("tauri-build");
}
