//! Démarrage de l'interface et des services, selon `shell.json` (même fichier et mêmes règles que la coque Windows) :
//!  - public (par défaut) ou URL personnalisée : sonde `<url>/health` (3 essais), puis chargement ; en cas d'échec,
//!    boîte « Réessayer / Quitter » avec la cause ;
//!  - `--webui-url` / `--development` : page chargée telle quelle.
//!  - local : service lastAddon embarqué et serveur de streaming (voir `local.rs`, étape « services locaux »).

use std::sync::Arc;

use tauri::Runtime;

use crate::laststream_app::shell_config::{self, PROBE_ATTEMPTS, PROBE_BACKOFF, PROBE_TIMEOUT};
use crate::shell::Shell;
use crate::{dialogs, Opt};

pub fn start<R: Runtime>(shell: Arc<Shell<R>>, _opt: Opt, explicit: Option<String>) {
    if let Some(url) = explicit {
        crate::navigate(&shell, &url);
        return;
    }
    let plan = shell_config::load().plan(false);
    match plan.remote_url {
        Some(url) => load_remote(&shell, &url),
        None => {
            // Mode local : pas encore pris en charge par cette coque, on reste sur le service public.
            load_remote(&shell, shell_config::PUBLIC_URL);
        }
    }
}

fn load_remote<R: Runtime>(shell: &Arc<Shell<R>>, url: &str) {
    loop {
        match shell_config::probe(url, PROBE_TIMEOUT, PROBE_ATTEMPTS, PROBE_BACKOFF) {
            Ok(()) => {
                crate::splash::hide(&shell.app);
                crate::navigate(shell, url);
                return;
            }
            Err(cause) => {
                let message = format!("Impossible de joindre le service Laststream ({url}).\n\nCause : {cause}.\n\nVérifiez votre connexion puis réessayez.");
                if !dialogs::retry(&shell.app, "Laststream indisponible", &message) {
                    crate::quit(&shell.app);
                    return;
                }
            }
        }
    }
}

/// Arrête les services enfants (aucun pour l'instant).
pub fn stop_all() {}
