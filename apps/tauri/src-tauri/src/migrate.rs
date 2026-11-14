//! Données de la page (connexion, réglages, localStorage) reprises de la coque Windows historique, une seule fois.
//!
//! La coque Windows garde le profil WebView2 à côté de son exécutable : `%LOCALAPPDATA%\Programs\Laststream\
//! laststream.exe.WebView2`. Cette coque utilise son propre dossier, fixe : `%LOCALAPPDATA%\app.laststream.desktop\WebView2`. Au premier
//! lancement (dossier absent), l'ancien profil est copié s'il existe : l'utilisateur garde sa session. Une copie échouée
//! (profil en cours d'utilisation par l'ancienne app) est abandonnée proprement : la page repart d'un profil vierge.
//! macOS : aucune ancienne coque, rien à reprendre (WKWebView garde ses données dans le conteneur de l'app).

use std::path::PathBuf;

/// Dossier de données de la WebView (Windows) ; `None` ailleurs (emplacement par défaut).
pub fn webview_data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // Hors du dossier d’installation (%LOCALAPPDATA%\Laststream pour l’installeur NSIS) : jamais effacé par une mise à jour.
        let dir = dirs::data_local_dir()?
            .join("app.laststream.desktop")
            .join("WebView2");
        if !dir.exists() {
            if let Some(old) = dirs::data_local_dir().map(|d| {
                d.join("Programs")
                    .join("Laststream")
                    .join("laststream.exe.WebView2")
            }) {
                if old.is_dir() {
                    let staging = dir.with_extension("import");
                    let _ = std::fs::remove_dir_all(&staging);
                    match copy_dir(&old, &staging).and_then(|()| std::fs::rename(&staging, &dir)) {
                        Ok(()) => eprintln!("Profil de la coque Windows repris."),
                        Err(error) => {
                            let _ = std::fs::remove_dir_all(&staging);
                            eprintln!("Profil de la coque Windows non repris ({error}).");
                        }
                    }
                }
            }
        }
        Some(dir)
    }
    #[cfg(not(windows))]
    None
}

#[cfg(windows)]
fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
