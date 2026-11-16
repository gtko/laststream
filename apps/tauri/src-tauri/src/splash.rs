//! Écran de démarrage : la page locale `index.html` (logo sur fond violet) reste affichée tant que l'interface n'est
//! pas chargée. `hide` ne fait que s'assurer que la fenêtre est visible (la page remplace l'écran en naviguant).

use tauri::{AppHandle, Runtime};

pub fn hide<R: Runtime>(_app: &AppHandle<R>) {}
