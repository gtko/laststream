//! Boîtes natives : choix de dossier et messages d'erreur (Retry/Cancel), via tauri-plugin-dialog.

use std::path::PathBuf;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

/// Ok(None) si annulé ; erreur si le chemin choisi n'est pas de l'Unicode valide (même message que la coque Windows).
pub fn pick_folder<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    start: Option<PathBuf>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(dir) = start.filter(|d| d.is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    match dialog.blocking_pick_folder() {
        None => Ok(None),
        Some(path) => path
            .into_path()
            .map_err(|e| e.to_string())
            .and_then(|p| {
                p.into_os_string()
                    .into_string()
                    .map_err(|_| "The selected folder path is not valid Unicode".to_owned())
            })
            .map(Some),
    }
}

/// Boîte « Réessayer / Quitter » ; vrai si l'utilisateur réessaie. Selon la plateforme, le bouton personnalisé
/// revient en `Ok` ou en `Custom(libellé)` : les deux sont acceptés ; fermer la boîte vaut « Quitter ».
pub fn retry<R: Runtime>(app: &AppHandle<R>, title: &str, message: &str) -> bool {
    const RETRY: &str = "Réessayer";
    let answer = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            RETRY.into(),
            "Quitter".into(),
        ))
        .blocking_show_with_result();
    match answer {
        MessageDialogResult::Ok | MessageDialogResult::Yes => true,
        MessageDialogResult::Custom(label) => label == RETRY,
        _ => false,
    }
}

pub fn error<R: Runtime>(app: &AppHandle<R>, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
}
