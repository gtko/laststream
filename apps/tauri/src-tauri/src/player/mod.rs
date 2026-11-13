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
}

use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Runtime};

use crate::laststream_app::ipc::RPCResponse;

/// Moteur provisoire (le lecteur mpv arrive à l'étape suivante) : annonce mpv, ignore les commandes.
struct Pending {
    tx: flume::Sender<String>,
}

impl Player for Pending {
    fn send(&self, _args_json: String) {}
    fn backends_json(&self) -> String {
        "[\"mpv\"]".into()
    }
    fn send_capabilities(&self) {
        self.tx.send(RPCResponse::response_message(Some(json!(["player-capabilities", {"backends": ["mpv"]}])))).ok();
    }
    fn set_backend(&self, _params: Option<&Value>) {
        self.tx.send(RPCResponse::response_message(Some(json!(["player-backend", {"backend": "mpv"}])))).ok();
    }
}

pub fn start<R: Runtime>(_app: AppHandle<R>, tx: flume::Sender<String>) -> Arc<dyn Player> {
    Arc::new(Pending { tx })
}
