//! Seule commande Tauri exposée à la page : `shell_post`, le `chrome.webview.postMessage` du polyfill.
//! Origine vérifiée à chaque message : seule l'interface chargée par la coque est écoutée (comme la coque Windows).

use tauri::{Manager, Runtime, Webview};

use crate::web::MAIN;

#[tauri::command]
pub fn shell_post<R: Runtime>(webview: Webview<R>, message: String) {
    if webview.label() != MAIN {
        return;
    }
    let Ok(url) = webview.url() else { return };
    crate::with_shell(webview.app_handle(), |shell| {
        if shell.is_trusted(&url) {
            shell.receive(&message);
        }
    });
}
