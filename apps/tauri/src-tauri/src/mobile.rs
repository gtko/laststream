//! App Android : l'interface est chargée depuis le serveur Laststream, comme dans l'app Capacitor (`apps/mobile`), et
//! retrouve l'API Capacitor qu'elle attend (`window.Capacitor`, plugins natifs) par `capacitor.js`, injecté avant ses
//! scripts. Les plugins Kotlin de l'app Capacitor (lecteur libVLC, téléchargements, mise à jour, écran) sont repris tels
//! quels par le projet Gradle (`gen/android`) et servis par le plugin Tauri `capacitor` (`CapacitorBridgePlugin`).
//!
//! Démarrage : `android.html` (dans `splash/`) sonde le serveur puis s'y rend ; hors ligne, elle propose de réessayer.

use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// Interface Laststream, seule origine à qui l'API native est ouverte (voir `capabilities/mobile.json`).
const APP_HOST: &str = "app.laststream.app";

const CAPACITOR_JS: &str = include_str!("capacitor.js");

/// Poignée du plugin Kotlin, pour ouvrir un lien externe depuis le Rust.
struct Bridge<R: Runtime>(PluginHandle<R>);

/// Navigation permise dans la WebView : la page de démarrage locale et l'interface Laststream.
fn is_inside(url: &Url) -> bool {
    match url.scheme() {
        "https" => url.host_str() == Some(APP_HOST),
        "http" => url.host_str() == Some("tauri.localhost"),
        "tauri" | "asset" | "about" | "data" | "blob" => true,
        _ => false,
    }
}

fn capacitor_plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("capacitor")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.laststream.app.bridge", "CapacitorBridgePlugin")?;
            app.manage(Bridge(handle));
            Ok(())
        })
        .build()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(capacitor_plugin())
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("android.html".into()))
                .initialization_script(CAPACITOR_JS)
                // Lien hors de l'interface (aide, connexion d'un service…) : ouvert dans le navigateur, comme Capacitor.
                .on_navigation(move |url| {
                    if is_inside(url) {
                        return true;
                    }
                    // Hors du fil de la WebView : l'appel au Kotlin attend sa réponse.
                    let handle = handle.clone();
                    let target = url.to_string();
                    std::thread::spawn(move || {
                        if let Some(bridge) = handle.try_state::<Bridge<tauri::Wry>>() {
                            let _ = bridge.0.run_mobile_plugin::<serde_json::Value>(
                                "openExternal",
                                serde_json::json!({ "url": target }),
                            );
                        }
                    });
                    false
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("app Android");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_on_the_interface() {
        let ok = |s: &str| is_inside(&Url::parse(s).unwrap());
        assert!(ok("https://app.laststream.app/#/home"));
        assert!(ok("http://tauri.localhost/android.html"));
        assert!(!ok("https://app.laststream.app.evil.com/"));
        assert!(!ok("http://app.laststream.app/"));
        assert!(!ok("https://real-debrid.com/device"));
        assert!(!ok("intent://scan/#Intent;end"));
    }
}
