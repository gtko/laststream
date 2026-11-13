//! Position et taille de la fenêtre, gardées entre deux lancements. Même fichier et même schéma que la coque Windows
//! (`<config>/Laststream/window-state.json` : `show_cmd` 1 normale / 3 agrandie, `normal_position {left,top,right,bottom}`
//! en pixels physiques), pour retrouver sa fenêtre en passant d'une coque à l'autre. Rien n'est enregistré en plein
//! écran, en PiP ni fenêtre réduite.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

use crate::window_ops;

#[derive(Serialize, Deserialize, Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[derive(Serialize, Deserialize, Default)]
struct Point {
    x: i32,
    y: i32,
}

#[derive(Serialize, Deserialize, Default)]
struct State {
    show_cmd: u32,
    #[serde(default)]
    min_position: Point,
    #[serde(default)]
    max_position: Point,
    normal_position: Rect,
}

fn path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("Laststream").join("window-state.json"))
}

/// Applique l'état enregistré ; faux s'il n'y en a pas (la fenêtre garde sa taille par défaut, centrée).
pub fn restore<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    let Some(state) = path().and_then(|p| fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<State>(&t).ok()) else {
        return false;
    };
    let r = &state.normal_position;
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    if w < 200 || h < 150 {
        return false;
    }
    // Fenêtre visible sur un des écrans actuels, sinon on laisse la position par défaut.
    let on_screen = window.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        r.left < p.x + s.width as i32 && r.right > p.x && r.top < p.y + s.height as i32 && r.bottom > p.y
    });
    window.set_size(PhysicalSize::new(w as u32, h as u32)).ok();
    if on_screen {
        window.set_position(PhysicalPosition::new(r.left, r.top)).ok();
    }
    if state.show_cmd == 3 {
        window.maximize().ok();
    }
    true
}

pub fn save<R: Runtime>(window: &WebviewWindow<R>) {
    if window.is_fullscreen().unwrap_or(false) || window_ops::is_pip() || window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    // Agrandie : on garde la dernière position normale déjà enregistrée.
    let mut state = path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<State>(&t).ok())
        .unwrap_or_default();
    state.show_cmd = if maximized { 3 } else { 1 };
    if !maximized {
        if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
            state.normal_position = Rect { left: pos.x, top: pos.y, right: pos.x + size.width as i32, bottom: pos.y + size.height as i32 };
        }
    }
    let Some(path) = path() else { return };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).ok();
    }
    if let Ok(text) = serde_json::to_string(&state) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, text).is_ok() {
            fs::rename(&tmp, &path).ok();
        }
    }
}
