//! Mise à jour de l'app (flux signé ed25519). Branché à l'étape « mise à jour » : rien n'est lancé pour l'instant.

use std::sync::Arc;

use tauri::{AppHandle, Runtime};

use crate::shell::Shell;
use crate::Opt;

pub fn start<R: Runtime>(_shell: &Arc<Shell<R>>, _opt: &Opt) {}

pub fn install_and_quit<R: Runtime>(_app: &AppHandle<R>) {}
