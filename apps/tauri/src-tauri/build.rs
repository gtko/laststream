fn main() {
    // macOS : calque OpenGL qui affiche mpv sous la WKWebView (mac/mpv_layer.m), en-têtes mpv de Homebrew (pkg-config).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=mac/mpv_layer.m");
        let mut build = cc::Build::new();
        build
            .file("mac/mpv_layer.m")
            .flag("-fobjc-arc")
            .flag("-Wno-deprecated-declarations");
        match pkg_config::Config::new().cargo_metadata(false).probe("mpv") {
            Ok(lib) => {
                for path in lib.include_paths {
                    build.include(path);
                }
            }
            Err(_) => {
                build
                    .include("/opt/homebrew/include")
                    .include("/usr/local/include");
            }
        }
        build.compile("ls_mpv_layer");
        for framework in ["Cocoa", "QuartzCore", "OpenGL"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    // Windows : liaison avec libmpv par la bibliothèque d'import de la coque Windows (apps/desktop/mpv-<arch>/mpv.lib) ;
    // la DLL libmpv-2.dll est embarquée à l'empaquetage.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("aarch64") => "arm64",
            _ => "x64",
        };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../desktop")
            .join(format!("mpv-{arch}"));
        println!("cargo:rustc-link-search=native={}", dir.display());
    }
    // `shell_post` : unique commande Tauri, appelée par le polyfill `window.chrome.webview` (src/bridge.js).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["shell_post"])),
    )
    .expect("tauri-build");
}
