fn main() {
    // macOS : calque OpenGL qui affiche mpv sous la WKWebView (mac/mpv_layer.m), en-têtes mpv de Homebrew (pkg-config).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=mac/mpv_layer.m");
        let mut build = cc::Build::new();
        build
            .file("mac/mpv_layer.m")
            .flag("-fobjc-arc")
            .flag("-Wno-deprecated-declarations");
        // Empaquetage : libmpv et ses dépendances préparées (install name @rpath) dans LASTSTREAM_MPV_LIB_DIR,
        // prioritaire sur Homebrew ; l'app les trouve dans Contents/Frameworks.
        println!("cargo:rerun-if-env-changed=LASTSTREAM_MPV_LIB_DIR");
        if let Ok(dir) = std::env::var("LASTSTREAM_MPV_LIB_DIR") {
            println!("cargo:rustc-link-search=native={dir}");
        }
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        match pkg_config::Config::new().cargo_metadata(false).probe("mpv") {
            Ok(lib) => {
                for path in lib.include_paths {
                    build.include(path);
                }
                for path in lib.link_paths {
                    println!("cargo:rustc-link-search=native={}", path.display());
                }
            }
            Err(_) => {
                build
                    .include("/opt/homebrew/include")
                    .include("/usr/local/include");
                println!("cargo:rustc-link-search=native=/opt/homebrew/lib");
                println!("cargo:rustc-link-search=native=/usr/local/lib");
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
