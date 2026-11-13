//! Icône de la barre système (zone de notification Windows, barre des menus macOS) : clic gauche = montrer la fenêtre ;
//! menu « Afficher la fenêtre » (case), « Toujours au premier plan » (case, grisée en plein écran ou PiP), « Quitter ».

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::laststream_app::robust;
use crate::web::MAIN;
use crate::window_ops;

const SHOW: &str = "tray-show";
const ON_TOP: &str = "tray-on-top";
const QUIT: &str = "tray-quit";

pub struct TrayItems<R: Runtime> {
    show: CheckMenuItem<R>,
    on_top: CheckMenuItem<R>,
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = CheckMenuItem::with_id(app, SHOW, "Afficher la fenêtre", true, true, None::<&str>)?;
    let on_top = CheckMenuItem::with_id(
        app,
        ON_TOP,
        "Toujours au premier plan",
        true,
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, QUIT, "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &on_top, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    app.manage(TrayItems { show, on_top });
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Laststream")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW => {
                if let Some(window) = app.get_webview_window(MAIN) {
                    if window.is_visible().unwrap_or(false) {
                        crate::with_shell(app, |shell| window_ops::hide_to_tray(shell));
                    } else {
                        window_ops::show(app);
                        crate::with_shell(app, |shell| window_ops::announce(shell));
                    }
                }
                refresh(app);
            }
            ON_TOP => {
                let mut on_top = robust::lock(&window_ops::ALWAYS_ON_TOP, "premier plan");
                *on_top = !*on_top;
                if let Some(window) = app.get_webview_window(MAIN) {
                    window.set_always_on_top(*on_top).ok();
                }
                drop(on_top);
                refresh(app);
            }
            QUIT => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                window_ops::show(app);
                crate::with_shell(app, |shell| window_ops::announce(shell));
                refresh(app);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Recoche les cases selon l'état réel de la fenêtre.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(items) = app.try_state::<TrayItems<R>>() else {
        return;
    };
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    items
        .show
        .set_checked(window.is_visible().unwrap_or(false))
        .ok();
    let blocked = window.is_fullscreen().unwrap_or(false) || window_ops::is_pip();
    items.on_top.set_enabled(!blocked).ok();
    items
        .on_top
        .set_checked(*robust::lock(&window_ops::ALWAYS_ON_TOP, "premier plan"))
        .ok();
}
