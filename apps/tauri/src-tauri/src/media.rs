//! Médias ouverts depuis la ligne de commande ou une seconde instance (aimant, fichier .torrent) : mis en file jusqu'à
//! `app-ready`, puis remis à la page (`open-media`, `open-torrent`, `open-error`, voir `open_media.rs` partagé).
//! Chaque navigation remet la file en attente (la nouvelle page n'est pas prête).

use std::sync::Mutex;
use std::thread;

use crate::laststream_app::{ipc::RPCResponse, open_media, robust};

pub struct OpenMedia {
    tx: flume::Sender<String>,
    state: Mutex<(bool, Vec<String>)>,
}

impl OpenMedia {
    pub fn new(tx: flume::Sender<String>) -> Self {
        OpenMedia { tx, state: Mutex::new((false, Vec::new())) }
    }

    /// Entrée brute (chemin ou URL), normalisée comme la coque Windows avant d'être traitée.
    pub fn push(&self, input: String) {
        if input.is_empty() {
            return;
        }
        let input = open_media::normalize(input);
        let mut state = robust::lock(&self.state, "file d'ouverture");
        if state.0 {
            self.deliver(input);
        } else {
            state.1.push(input);
        }
    }

    pub fn ready(&self) {
        let queued = {
            let mut state = robust::lock(&self.state, "file d'ouverture");
            state.0 = true;
            std::mem::take(&mut state.1)
        };
        for input in queued {
            self.deliver(input);
        }
    }

    pub fn reset(&self) {
        robust::lock(&self.state, "file d'ouverture").0 = false;
    }

    fn deliver(&self, input: String) {
        let tx = self.tx.clone();
        // Lecture d'un .torrent (jusqu'à 16 Mio) hors du fil appelant.
        thread::spawn(move || {
            tx.send(RPCResponse::response_message(Some(open_media::message(&input)))).ok();
        });
    }
}
