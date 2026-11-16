//! Lecteur : reçoit les messages `mpv-*` / `player-set-backend` de la page, dans l'ordre, et répond par les signaux
//! `mpv-prop-change`, `mpv-event-ended`, `mpv-event-video-ready`, `player-capabilities`, `player-backend`
//! (protocole de `communication.rs`, partagé avec la coque Windows).

use serde_json::Value;

pub trait Player: Send + Sync {
    /// Message brut `[méthode, paramètre]` (JSON) de la page.
    fn send(&self, args_json: String);
    /// Tableau JSON des moteurs disponibles, pour la poignée de main (`playerBackends`).
    fn backends_json(&self) -> String;
    /// Signal `player-capabilities {backends}`.
    fn send_capabilities(&self);
    /// `player-set-backend {backend}` : cette coque n'a que mpv ; acquitte `player-backend {backend:"mpv"}`.
    fn set_backend(&self, params: Option<&Value>);
    /// Fermeture de l'app : plus de relance de mpv.
    fn shutdown(&self) {}
}

pub mod mpv;
pub mod video;

use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};

use crate::web::MAIN;

/// Démarre mpv sur la surface vidéo de la fenêtre principale. Sans mpv (bibliothèque absente), la page reçoit
/// quand même ses réponses (`player-capabilities`) et retombe sur la lecture dans la page.
pub fn start<R: Runtime>(app: &AppHandle<R>, tx: flume::Sender<String>) -> Arc<dyn Player> {
    let Some(window) = app.get_webview_window(MAIN) else {
        return Arc::new(Unavailable { tx });
    };
    let surface = video::create(&window);
    app.manage(SurfaceHandle(Arc::clone(&surface)));
    let lost_app = app.clone();
    let on_lost: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        crate::dialogs::error(
            &lost_app,
            "Laststream",
            "Le lecteur a rencontré trop d'erreurs. Redémarrez l'app.",
        );
    });
    match mpv::MpvPlayer::start(tx.clone(), surface, on_lost) {
        Ok(player) => player,
        Err(error) => {
            crate::laststream_app::robust::report_error("lecteur", &error);
            Arc::new(Unavailable { tx })
        }
    }
}

/// Surface vidéo, gardée pour la suivre quand la fenêtre change de taille ou d'écran.
pub struct SurfaceHandle(pub Arc<dyn video::VideoSurface>);

use serde_json::json;

use crate::laststream_app::ipc::RPCResponse;

/// mpv indisponible : aucun moteur annoncé ; la page lit dans le navigateur.
struct Unavailable {
    tx: flume::Sender<String>,
}

impl Player for Unavailable {
    fn send(&self, _args_json: String) {}
    fn backends_json(&self) -> String {
        "[]".into()
    }
    fn send_capabilities(&self) {
        self.tx
            .send(RPCResponse::response_message(Some(
                json!(["player-capabilities", {"backends": []}]),
            )))
            .ok();
    }
    fn set_backend(&self, _params: Option<&Value>) {
        self.tx
            .send(RPCResponse::response_message(Some(
                json!(["player-backend", {"backend": "mpv"}]),
            )))
            .ok();
    }
}
