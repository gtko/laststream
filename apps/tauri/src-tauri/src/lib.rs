//! Coque Tauri de Laststream (macOS et Windows) : même protocole que la coque Windows historique (`apps/desktop`),
//! l'interface web n'a rien à changer. Voir README.md pour l'architecture et la correspondance avec l'ancienne coque.

pub mod laststream_app;

mod commands;
mod dialogs;
mod external;
mod local;
mod media;
mod migrate;
mod player;
mod services;
mod shell;
mod splash;
mod tray;
mod update;
mod web;
mod window_ops;
mod window_state;

use std::sync::Arc;
use std::thread;

use clap::Parser;
use tauri::{
    AppHandle, LogicalSize, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use url::Url;

use crate::laststream_app::{
    constants::{
        DEV_ENDPOINT, LASTSTREAM_SERVER_DEV_MODE, SERVER_IPC_KEY, WINDOW_MIN_HEIGHT,
        WINDOW_MIN_WIDTH,
    },
    robust, sentry_report,
};
use crate::shell::Shell;
use crate::web::MAIN;

/// Options de la ligne de commande : les mêmes que la coque Windows (`apps/desktop/src/main.rs`).
#[derive(Parser, Debug, Clone)]
#[clap(version)]
pub struct Opt {
    /// Fichier ou lien à ouvrir (aimant, .torrent).
    pub command: Option<String>,
    #[clap(
        long,
        help = "Start the app only in system tray and keep the window hidden"
    )]
    pub start_hidden: bool,
    #[clap(long, help = "Do not show the splash image")]
    pub no_splash: bool,
    #[clap(
        long,
        alias = "dev-tools",
        help = "Enable the web developer tools in a release build"
    )]
    pub devtools: bool,
    #[clap(long, help = "Disable the server and load the WebUI from localhost")]
    pub development: bool,
    #[clap(long, help = "Override the WebUI URL")]
    pub webui_url: Option<String>,
    #[clap(
        long,
        help = "Check this endpoint for updates instead of the default Laststream feed"
    )]
    pub autoupdater_endpoint: Option<Url>,
    #[clap(
        long,
        help = "Disable the autoupdater: no update check and no network call for it"
    )]
    pub no_autoupdater: bool,
    #[clap(long, help = "Forces reinstalling current version")]
    pub force_update: bool,
    #[clap(
        long,
        default_value = "",
        help = "Secret key for communication with the server (random by default)"
    )]
    pub server_ipc_key: String,
}

/// Exécute `f` avec l'état de la coque, s'il existe déjà.
pub fn with_shell<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&Arc<Shell<R>>)) {
    if let Some(shell) = app.try_state::<Arc<Shell<R>>>() {
        f(shell.inner());
    }
}

/// Quitter pour de bon (menu « Quitter », commande `quit`) : état de la fenêtre enregistré, services arrêtés.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        window_state::save(&window);
    }
    with_shell(app, |shell| shell.player.shutdown());
    services::stop_all();
    app.exit(0);
}

const BRIDGE_JS: &str = include_str!("bridge.js");

/// `window.laststream_server_ipc_key` (attendu par le serveur de streaming façon Stremio), échappé comme la coque Windows.
fn ipc_key_script(key: &str) -> String {
    let literal = serde_json::to_string(key)
        .unwrap_or_else(|_| "\"\"".into())
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("window.laststream_server_ipc_key = {literal};")
}

pub fn run() {
    robust::install_panic_hook();
    let _sentry = sentry_report::init();
    let opt = Opt::parse();

    // Clé partagée avec les services enfants (comme la coque Windows) : celle donnée, sinon une UUID v4.
    let ipc_key = if opt.server_ipc_key.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        opt.server_ipc_key.clone()
    };
    std::env::set_var(SERVER_IPC_KEY, &ipc_key);
    std::env::set_var(
        LASTSTREAM_SERVER_DEV_MODE,
        if opt.development { "true" } else { "false" },
    );

    let startup_opt = opt.clone();
    tauri::Builder::default()
        // Instance unique : un second lancement transmet son argument (aimant, .torrent) puis s'arrête.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            window_ops::show(app);
            if let Some(input) = argv.get(1).filter(|a| !a.starts_with("--")) {
                let input = input.clone();
                with_shell(app, |shell| shell.media.push(input));
            }
            with_shell(app, |shell| window_ops::announce_state(shell));
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![commands::shell_post])
        .setup(move |app| {
            let handle = app.handle().clone();
            let web_tx = web::start(handle.clone());
            create_main_window(&handle, &startup_opt, &ipc_key)?;
            // La surface vidéo se place sous la WebView de la fenêtre principale : mpv démarre après elle.
            let player = player::start(&handle, web_tx.clone());
            let shell = Shell::new(handle.clone(), web_tx, player);
            app.manage(Arc::clone(&shell));
            tray::build(&handle)?;
            if let Some(command) = startup_opt.command.clone() {
                shell.media.push(command);
            }
            update::start(&shell, &startup_opt);
            let opt = startup_opt.clone();
            thread::Builder::new()
                .name("startup".into())
                .spawn(move || start_ui(shell, opt))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("coque Tauri")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(window) = app.get_webview_window(MAIN) {
                    window_state::save(&window);
                }
                services::stop_all();
            }
        });
}

fn create_main_window<R: Runtime>(
    app: &AppHandle<R>,
    opt: &Opt,
    ipc_key: &str,
) -> tauri::Result<()> {
    let nav_app = app.clone();
    let new_window_app = app.clone();
    let devtools = cfg!(debug_assertions) || opt.devtools || opt.development;
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Laststream")
        .inner_size(1280.0, 720.0)
        .min_inner_size(WINDOW_MIN_WIDTH as f64, WINDOW_MIN_HEIGHT as f64)
        .center()
        .visible(!opt.start_hidden)
        // Page transparente : la vidéo mpv, sous la page, apparaît là où la page ne dessine rien.
        .transparent(true)
        .devtools(devtools)
        .initialization_script(BRIDGE_JS)
        .initialization_script(ipc_key_script(ipc_key))
        // Navigation hors de l'origine de l'interface : annulée, et ouverte dans le navigateur si c'est du http(s).
        .on_navigation(move |url| {
            let local = matches!(url.scheme(), "tauri" | "asset")
                || url.host_str() == Some("tauri.localhost");
            let mut allowed = local;
            with_shell(&nav_app, |shell| allowed = allowed || shell.is_trusted(url));
            if !allowed && matches!(url.scheme(), "http" | "https") {
                open::that_detached(url.as_str()).ok();
            }
            allowed
        })
        // `window.open` / cible _blank : ouvert dans le navigateur, et signal `dragdrop` comme la coque Windows.
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                open::that_detached(url.as_str()).ok();
            }
            let decoded = urlencoding::decode(url.as_str())
                .map(|s| s.into_owned())
                .unwrap_or_else(|_| url.to_string());
            with_shell(&new_window_app, |shell| {
                shell.signal("dragdrop", serde_json::json!([decoded]))
            });
            tauri::webview::NewWindowResponse::Deny
        });
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Visible);
    // Windows : profil WebView2 fixe, repris de la coque historique au premier lancement (connexion, réglages).
    let builder = match migrate::webview_data_dir() {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    };
    let window = builder.build()?;
    if !window_state::restore(&window) {
        // 70 % du plus petit côté de l'écran, en 16:9, au moins 1000×600.
        if let Ok(Some(monitor)) = window.current_monitor() {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let width =
                (size.width.min(size.height * 16.0 / 9.0) * 0.7).max(WINDOW_MIN_WIDTH as f64);
            window
                .set_size(LogicalSize::new(
                    width,
                    (width * 9.0 / 16.0).max(WINDOW_MIN_HEIGHT as f64),
                ))
                .ok();
            window.center().ok();
        }
    }
    let events_app = app.clone();
    window.on_window_event(move |event| match event {
        // Bouton Fermer : la fenêtre se cache dans la barre système.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            with_shell(&events_app, |shell| window_ops::hide_to_tray(shell));
        }
        WindowEvent::Resized(size) => {
            if let Some(surface) = events_app.try_state::<player::SurfaceHandle>() {
                surface.0.resized(size.width, size.height);
            }
            with_shell(&events_app, |shell| window_ops::announce_state(shell));
        }
        WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
            if let Some(surface) = events_app.try_state::<player::SurfaceHandle>() {
                surface.0.scale_changed(*scale_factor);
            }
        }
        WindowEvent::Focused(_) => {
            with_shell(&events_app, |shell| window_ops::announce_state(shell));
        }
        _ => {}
    });
    Ok(())
}

/// Choisit et charge l'interface : public (par défaut), URL personnalisée, mode local, `--webui-url`, `--development`.
fn start_ui<R: Runtime>(shell: Arc<Shell<R>>, opt: Opt) {
    let explicit = opt
        .webui_url
        .clone()
        .or_else(|| opt.development.then(|| DEV_ENDPOINT.to_owned()));
    services::start(shell, opt, explicit);
}

/// Charge `url` dans la fenêtre principale ; son origine devient la seule écoutée. Même URL (au fragment près) :
/// fragment puis rechargement, comme la coque Windows.
pub fn navigate<R: Runtime>(shell: &Shell<R>, url: &str) {
    let Ok(target) = Url::parse(url) else { return };
    let Some(window) = shell.app.get_webview_window(MAIN) else {
        return;
    };
    shell.set_trusted(&target);
    shell.media.reset();
    let same_page = window.url().ok().is_some_and(|current| {
        let mut a = current.clone();
        let mut b = target.clone();
        a.set_fragment(None);
        b.set_fragment(None);
        a == b
    });
    if same_page {
        let fragment = serde_json::to_string(target.fragment().unwrap_or(""))
            .unwrap_or_else(|_| "\"\"".into());
        window
            .eval(format!(
                "window.location.hash = {fragment}; window.location.reload();"
            ))
            .ok();
    } else if window.navigate(target).is_err() {
        dialogs::error(
            &shell.app,
            "Laststream",
            "Impossible de charger l'interface Laststream.",
        );
    }
}
