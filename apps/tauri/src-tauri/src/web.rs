//! Messages de la coque vers la page : chaînes JSON déjà formées par `ipc::RPCResponse` (mêmes enveloppes que la coque
//! Windows), remises dans l'ordre par `window.__lsShell.deliver(...)` (polyfill `bridge.js`).
//!
//! Les modules partagés (téléchargements, ponts HTTP, lecteur) écrivent dans un `flume::Sender<String>` ; un fil unique
//! vide ce canal vers la WebView. Tant que la fenêtre n'existe pas, les messages attendent (rien n'est perdu).

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

pub const MAIN: &str = "main";

/// Expression JS qui remet `json` à la page. `json` devient un littéral de chaîne JS (échappement serde_json, plus
/// U+2028/U+2029 et `</` pour qu'aucun contenu ne puisse fermer la chaîne ni un `<script>`).
pub fn deliver_script(json: &str) -> String {
    let literal = serde_json::to_string(json)
        .unwrap_or_else(|_| "\"\"".to_owned())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
        .replace("</", "<\\/");
    format!("window.__lsShell&&window.__lsShell.deliver({literal})")
}

/// Démarre le fil d'envoi et renvoie l'émetteur à donner aux modules.
pub fn start<R: Runtime>(app: AppHandle<R>) -> flume::Sender<String> {
    let (tx, rx) = flume::unbounded::<String>();
    thread::Builder::new()
        .name("web-out".into())
        .spawn(move || {
            for message in rx.iter() {
                let script = deliver_script(&message);
                loop {
                    match app.get_webview_window(MAIN) {
                        Some(window) => {
                            let _ = window.eval(script.as_str());
                            break;
                        }
                        None => thread::sleep(Duration::from_millis(50)),
                    }
                }
            }
        })
        .expect("fil web-out");
    tx
}

#[cfg(test)]
mod tests {
    use super::deliver_script;

    #[test]
    fn deliver_script_escapes_the_message() {
        let s = deliver_script("{\"a\":\"</script>\u{2028}\"}");
        assert_eq!(s, "window.__lsShell&&window.__lsShell.deliver(\"{\\\"a\\\":\\\"<\\/script>\\u2028\\\"}\")");
    }
}
