//! Démarrage de l'interface et des services, selon `shell.json` (même fichier et mêmes règles que la coque Windows) :
//! - public (par défaut) ou URL personnalisée : sonde `<url>/health` (3 essais), puis chargement ; en cas d'échec,
//!   boîte « Réessayer / Quitter » avec la cause ;
//! - local : serveur de streaming et lastAddon embarqués (`local.rs`), page chargée quand lastAddon est prêt ;
//! - `--webui-url` : page chargée une fois le serveur de streaming prêt ; `--development` : page chargée tout de suite.

use std::sync::Arc;
use std::thread;

use tauri::Runtime;

use crate::laststream_app::robust;
use crate::laststream_app::shell_config::{self, PROBE_ATTEMPTS, PROBE_BACKOFF, PROBE_TIMEOUT};
use crate::local::{self, Outcome};
use crate::shell::Shell;
use crate::{dialogs, Opt};

pub fn start<R: Runtime>(shell: Arc<Shell<R>>, opt: Opt, explicit: Option<String>) {
    if opt.development {
        if let Some(url) = explicit {
            crate::navigate(&shell, &url);
        }
        return;
    }
    if let Some(url) = explicit {
        // `--webui-url` : le serveur de streaming d'abord (son URL va dans la poignée de main), puis la page.
        let server_shell = Arc::clone(&shell);
        thread::spawn(move || start_streaming_server(&server_shell));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(31);
        while robust::lock(&shell.local_server_url, "URL du serveur local").is_none()
            && std::time::Instant::now() < deadline
        {
            thread::sleep(std::time::Duration::from_millis(100));
        }
        crate::navigate(&shell, &url);
        return;
    }
    let plan = shell_config::load().plan(false);
    if let Some(url) = plan.remote_url {
        load_remote(&shell, &url);
        return;
    }
    // Mode local : serveur de streaming en parallèle, lastAddon puis la page.
    let server_shell = Arc::clone(&shell);
    thread::spawn(move || start_streaming_server(&server_shell));
    run_addon(&shell);
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
                let message = format!(
                    "Impossible de joindre le service Laststream ({url}).\n\nCause : {cause}.\n\nVérifiez votre connexion puis réessayez."
                );
                if !dialogs::retry(&shell.app, "Laststream indisponible", &message) {
                    crate::quit(&shell.app);
                    return;
                }
            }
        }
    }
}

/// lastAddon : prêt → page chargée ; arrêt inattendu → une relance (page rechargée) ; échec → Réessayer / Quitter.
fn run_addon<R: Runtime>(shell: &Arc<Shell<R>>) {
    let mut restarts = 0;
    loop {
        match local::start_addon(&shell.app) {
            Outcome::Ready(url, crashed) => {
                crate::splash::hide(&shell.app);
                crate::navigate(shell, &url);
                let Ok(error) = crashed.recv() else { return };
                if restarts < 1 {
                    restarts += 1;
                    eprintln!("{error} Redémarrage du service Laststream.");
                    continue;
                }
                if !fail(
                    shell,
                    "Le service local de Laststream est indisponible.",
                    &error,
                ) {
                    return;
                }
            }
            Outcome::Failed(error) => {
                if !fail(
                    shell,
                    "Le service local de Laststream est indisponible.",
                    &error,
                ) {
                    return;
                }
            }
        }
        restarts = 0;
    }
}

/// Serveur de streaming : son URL alimente `streamingServerUrl` (poignée de main) tant qu'il tourne.
fn start_streaming_server<R: Runtime>(shell: &Arc<Shell<R>>) {
    loop {
        match local::start_streaming_server(&shell.app) {
            Outcome::Ready(url, crashed) => {
                *robust::lock(&shell.local_server_url, "URL du serveur local") = Some(url);
                let Ok(error) = crashed.recv() else { return };
                *robust::lock(&shell.local_server_url, "URL du serveur local") = None;
                shell.media.reset();
                if !fail(
                    shell,
                    "Le serveur de streaming de Laststream s'est arrêté.",
                    &error,
                ) {
                    return;
                }
            }
            Outcome::Failed(error) => {
                if !fail(
                    shell,
                    "Le serveur de streaming de Laststream est indisponible.",
                    &error,
                ) {
                    return;
                }
            }
        }
    }
}

/// Boîte d'échec : vrai si l'utilisateur réessaie ; sinon l'app se ferme.
fn fail<R: Runtime>(shell: &Arc<Shell<R>>, title: &str, error: &str) -> bool {
    if dialogs::retry(&shell.app, "Laststream", &format!("{title}\n\n{error}")) {
        true
    } else {
        crate::quit(&shell.app);
        false
    }
}

/// Arrête les services enfants.
pub fn stop_all() {
    local::stop_all();
}
