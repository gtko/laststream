//! Fenêtre principale : plein écran, image dans l'image (PiP), déplacement, premier plan, masquage dans la barre système.
//! Mêmes signaux que la coque Windows : `win-pip-changed {pip}` puis `win-visibility-changed {visible, visibility, isFullscreen}`
//! après chaque changement, `win-state-changed {state}` (1 réduite, 2 agrandie, 4 plein écran, 8 active).

use std::sync::Mutex;

use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Runtime, Size, WebviewWindow};

use crate::laststream_app::{
    constants::{WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH},
    ipc::RPCResponse,
    robust,
};
use crate::shell::Shell;
use crate::web::MAIN;

/// Taille de la fenêtre PiP (points logiques), marge au coin bas-droit de la zone de travail, taille minimale en PiP.
const PIP_SIZE: (f64, f64) = (480.0, 270.0);
const PIP_MARGIN: f64 = 24.0;
const PIP_MIN: (f64, f64) = (240.0, 135.0);

/// Géométrie et état d'avant le PiP, rétablis à la sortie.
struct Saved {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    always_on_top: bool,
    maximized: bool,
}

static PIP: Mutex<Option<Saved>> = Mutex::new(None);
/// « Toujours au premier plan » choisi dans la barre système (rétabli en sortant du PiP).
pub static ALWAYS_ON_TOP: Mutex<bool> = Mutex::new(false);

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN)
}

pub fn is_pip() -> bool {
    robust::lock(&PIP, "état PiP").is_some()
}

/// Signaux d'état envoyés à la page après un changement.
pub fn announce<R: Runtime>(shell: &Shell<R>) {
    let Some(window) = main_window(&shell.app) else { return };
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let visible = window.is_visible().unwrap_or(true);
    shell.send(RPCResponse::pip_change(is_pip()));
    shell.send(RPCResponse::visibility_change(visible, fullscreen as u32, fullscreen));
    announce_state(shell);
}

/// `win-state-changed {state}` (drapeaux compatibles Qt).
pub fn announce_state<R: Runtime>(shell: &Shell<R>) {
    let Some(window) = main_window(&shell.app) else { return };
    let mut state = 0u32;
    if window.is_minimized().unwrap_or(false) {
        state |= 1;
    }
    if window.is_maximized().unwrap_or(false) {
        state |= 2;
    }
    if window.is_fullscreen().unwrap_or(false) {
        state |= 4;
    }
    if window.is_focused().unwrap_or(false) {
        state |= 8;
    }
    shell.send(RPCResponse::state_change(state));
}

/// `win-set-visibility {fullscreen}` : quitte d'abord le PiP, puis plein écran réel (macOS : plein écran natif).
pub fn set_fullscreen<R: Runtime>(shell: &Shell<R>, fullscreen: bool) {
    if let Some(window) = main_window(&shell.app) {
        if fullscreen && is_pip() {
            leave_pip(&window);
        }
        window.set_fullscreen(fullscreen).ok();
        crate::tray::refresh(&shell.app);
    }
    announce(shell);
}

/// `win-set-pip {pip}` : fenêtre sans cadre, toujours au premier plan, 480×270 en bas à droite de l'écran courant.
pub fn set_pip<R: Runtime>(shell: &Shell<R>, pip: bool) {
    if let Some(window) = main_window(&shell.app) {
        if pip {
            enter_pip(&window);
        } else {
            leave_pip(&window);
        }
        crate::tray::refresh(&shell.app);
    }
    announce(shell);
}

fn enter_pip<R: Runtime>(window: &WebviewWindow<R>) {
    let mut saved = robust::lock(&PIP, "état PiP");
    if saved.is_some() {
        return;
    }
    if window.is_fullscreen().unwrap_or(false) {
        window.set_fullscreen(false).ok();
    }
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        window.unmaximize().ok();
    }
    *saved = Some(Saved {
        position: window.outer_position().unwrap_or(PhysicalPosition::new(0, 0)),
        size: window.inner_size().unwrap_or(PhysicalSize::new(1280, 720)),
        always_on_top: *robust::lock(&ALWAYS_ON_TOP, "premier plan"),
        maximized,
    });
    drop(saved);
    window.set_decorations(false).ok();
    window.set_min_size(Some(Size::Logical(LogicalSize::new(PIP_MIN.0, PIP_MIN.1)))).ok();
    window.set_always_on_top(true).ok();
    let scale = window.scale_factor().unwrap_or(1.0);
    window.set_size(Size::Logical(LogicalSize::new(PIP_SIZE.0, PIP_SIZE.1))).ok();
    if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area();
        let w = (PIP_SIZE.0 * scale) as i32;
        let h = (PIP_SIZE.1 * scale) as i32;
        let margin = (PIP_MARGIN * scale) as i32;
        let x = area.position.x + area.size.width as i32 - w - margin;
        let y = area.position.y + area.size.height as i32 - h - margin;
        window.set_position(PhysicalPosition::new(x, y)).ok();
    }
}

fn leave_pip<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(saved) = robust::lock(&PIP, "état PiP").take() else { return };
    window.set_decorations(true).ok();
    window.set_always_on_top(saved.always_on_top).ok();
    window.set_min_size(Some(Size::Logical(LogicalSize::new(WINDOW_MIN_WIDTH as f64, WINDOW_MIN_HEIGHT as f64)))).ok();
    window.set_size(Size::Physical(saved.size)).ok();
    window.set_position(saved.position).ok();
    if saved.maximized {
        window.maximize().ok();
    }
}

/// `win-drag` : déplacement natif de la fenêtre (PiP sans cadre).
pub fn drag<R: Runtime>(shell: &Shell<R>) {
    if let Some(window) = main_window(&shell.app) {
        window.start_dragging().ok();
    }
}

/// `win-focus` : montre la fenêtre et la met au premier plan.
pub fn focus<R: Runtime>(shell: &Shell<R>) {
    show(&shell.app);
    announce_state(shell);
}

pub fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = main_window(app) {
        window.show().ok();
        window.unminimize().ok();
        window.set_focus().ok();
    }
}

/// Bouton Fermer : la fenêtre se cache dans la barre système (seul « Quitter » ferme l'app), comme la coque Windows.
pub fn hide_to_tray<R: Runtime>(shell: &Shell<R>) {
    if let Some(window) = main_window(&shell.app) {
        crate::window_state::save(&window);
        window.hide().ok();
    }
    crate::tray::refresh(&shell.app);
    announce(shell);
}
