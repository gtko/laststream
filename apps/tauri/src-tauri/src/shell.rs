//! État de la coque et répartition des commandes de la page (même liste blanche, mêmes réponses que la coque Windows,
//! voir `apps/desktop/src/laststream_app/app.rs`). Les commandes sont traitées une à une, dans l'ordre d'arrivée,
//! sur le fil `ipc-dispatch` ; une panique dans l'une n'empêche pas les suivantes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::laststream_app::{
    addon_http, box_playlist,
    constants::safe_url,
    downloads,
    ipc::{check_command, CacheDirectoryRequest, RPCRequest, RPCResponse},
    native_http, native_range,
    robust::{self, report_error},
    shell_config,
};
use crate::player::Player;
use crate::{external, media, web::MAIN, window_ops};

/// Ce que la coque sait de la page et des services, partagé entre fils.
pub struct Shell<R: Runtime> {
    pub app: AppHandle<R>,
    /// Messages vers la page (enveloppes `ipc::RPCResponse` déjà sérialisées).
    pub web_tx: flume::Sender<String>,
    /// Origine de l'interface chargée : seuls ses messages sont acceptés (rien avant la première navigation).
    pub trusted_origin: Mutex<Option<String>>,
    /// Serveur de streaming local (`streamingServerUrl` de la poignée de main), seulement en mode local.
    pub local_server_url: Mutex<Option<String>>,
    pub player: Arc<dyn Player>,
    pub media: media::OpenMedia,
    pub updater_tx: Mutex<Option<flume::Sender<String>>>,
    download_picker_open: AtomicBool,
    cache_picker_open: AtomicBool,
    dispatch_tx: flume::Sender<RPCRequest>,
}

impl<R: Runtime> Shell<R> {
    pub fn new(
        app: AppHandle<R>,
        web_tx: flume::Sender<String>,
        player: Arc<dyn Player>,
    ) -> Arc<Self> {
        let (dispatch_tx, dispatch_rx) = flume::unbounded::<RPCRequest>();
        let shell = Arc::new(Shell {
            media: media::OpenMedia::new(web_tx.clone()),
            app,
            web_tx,
            trusted_origin: Mutex::new(None),
            local_server_url: Mutex::new(None),
            player,
            updater_tx: Mutex::new(None),
            download_picker_open: AtomicBool::new(false),
            cache_picker_open: AtomicBool::new(false),
            dispatch_tx,
        });
        let worker = Arc::clone(&shell);
        thread::Builder::new()
            .name("ipc-dispatch".into())
            .spawn(move || {
                for request in dispatch_rx.iter() {
                    if let Err(payload) =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            worker.dispatch(request)
                        }))
                    {
                        report_error(
                            "commande IPC arrêtée par une panique",
                            &robust::panic_message(payload.as_ref()),
                        );
                    }
                }
            })
            .expect("fil ipc-dispatch");
        shell
    }

    pub fn send(&self, message: String) {
        self.web_tx.send(message).ok();
    }

    pub fn signal(&self, name: &str, payload: Value) {
        self.send(RPCResponse::response_message(Some(json!([name, payload]))));
    }

    /// Message brut de la page (`chrome.webview.postMessage`), déjà filtré par origine.
    pub fn receive(&self, raw: &str) {
        // Message illisible : ignoré, comme la coque Windows.
        let Ok(request) = serde_json::from_str::<RPCRequest>(raw) else {
            return;
        };
        self.dispatch_tx.send(request).ok();
    }

    /// `url` est-elle de l'origine de l'interface chargée ?
    pub fn is_trusted(&self, url: &url::Url) -> bool {
        let origin = url.origin().ascii_serialization();
        robust::lock(&self.trusted_origin, "origine de confiance").as_deref()
            == Some(origin.as_str())
    }

    pub fn set_trusted(&self, url: &url::Url) {
        *robust::lock(&self.trusted_origin, "origine de confiance") =
            Some(url.origin().ascii_serialization());
    }

    fn dispatch(self: &Arc<Self>, msg: RPCRequest) {
        if let Some(method) = msg.get_method() {
            if let Err(reason) = check_command(method, msg.get_params()) {
                eprintln!("Refused IPC command {method:?}: {reason}");
                return;
            }
        }
        let local_server_url = robust::lock(&self.local_server_url, "URL du serveur local").clone();
        let params = msg.get_params().cloned();
        match msg.get_method() {
            None if msg.is_handshake() => {
                self.send(RPCResponse::get_handshake(
                    local_server_url.as_deref(),
                    &self.player.backends_json(),
                ));
            }
            Some("download-folder-pick") => self.pick_download_folder(),
            Some(method) if downloads::is_worker_method(method) => {
                downloads::submit(method, params.unwrap_or(Value::Null), self.web_tx.clone());
            }
            Some("pick-cache-directory") => {
                if let Some(request) =
                    params.and_then(|p| serde_json::from_value::<CacheDirectoryRequest>(p).ok())
                {
                    self.pick_cache_directory(request, local_server_url);
                }
            }
            Some("native-http") => {
                if let Some(request) = params
                    .and_then(|p| serde_json::from_value::<native_http::NativeHttpRequest>(p).ok())
                {
                    let tx = self.web_tx.clone();
                    thread::spawn(move || {
                        tx.send(RPCResponse::native_http_response(native_http::run(
                            &request,
                        )))
                        .ok();
                    });
                }
            }
            Some("native-addon-http") => {
                if let Some(request) = params
                    .and_then(|p| serde_json::from_value::<addon_http::AddonHttpRequest>(p).ok())
                {
                    let tx = self.web_tx.clone();
                    thread::spawn(move || {
                        tx.send(RPCResponse::native_http_response(addon_http::run(&request)))
                            .ok();
                    });
                }
            }
            Some("native-box-playlist") => {
                if let Some(request) = params.and_then(|p| {
                    serde_json::from_value::<box_playlist::BoxPlaylistRequest>(p).ok()
                }) {
                    let tx = self.web_tx.clone();
                    thread::spawn(move || {
                        tx.send(RPCResponse::native_http_response(box_playlist::run(
                            &request,
                        )))
                        .ok();
                    });
                }
            }
            Some("native-range") => match params.as_ref().and_then(|p| {
                serde_json::from_value::<native_range::NativeRangeRequest>(p.clone()).ok()
            }) {
                Some(request) => native_range::start(request, self.web_tx.clone()),
                // Requête illisible : réponse finale quand même (jamais de silence).
                None => self.send(RPCResponse::native_range_response(
                    native_range::bad_request(params.as_ref()),
                )),
            },
            Some("native-range-cancel") => {
                if let Some(cancel) = params
                    .and_then(|p| serde_json::from_value::<native_range::NativeRangeCancel>(p).ok())
                {
                    native_range::cancel(cancel.id);
                }
            }
            Some("native-range-caps") => {
                self.send(RPCResponse::native_range_caps(native_range::caps()))
            }
            Some("win-set-interface-scale") => {
                if let Some(scale) = params
                    .and_then(|p| p.get("scale").and_then(Value::as_u64))
                    .filter(|s| (75..=175).contains(s))
                {
                    if let Some(webview) = self.app.get_webview_window(MAIN) {
                        webview.set_zoom(scale as f64 / 100.0).ok();
                    }
                }
            }
            Some("win-set-visibility") => {
                if let Some(fullscreen) =
                    params.and_then(|p| p.get("fullscreen").and_then(Value::as_bool))
                {
                    window_ops::set_fullscreen(self, fullscreen);
                }
            }
            Some("win-set-pip") => {
                if let Some(pip) = params.and_then(|p| p.get("pip").and_then(Value::as_bool)) {
                    window_ops::set_pip(self, pip);
                }
            }
            Some("win-drag") => window_ops::drag(self),
            Some("win-focus") => window_ops::focus(self),
            Some("quit") => crate::quit(&self.app),
            Some("app-ready") => {
                crate::splash::hide(&self.app);
                self.send(RPCResponse::visibility_change(true, 1, false));
                if let Some(tx) = robust::lock(&self.updater_tx, "canal de mise à jour").as_ref() {
                    if tx.send("check_for_update".to_owned()).is_err() {
                        report_error("app-ready", &"canal de mise à jour fermé");
                    }
                }
                self.media.ready();
                // Toujours après la réponse `init` : le bus de l'app n'existe qu'ensuite.
                self.player.send_capabilities();
            }
            Some("app-error") => {
                crate::splash::hide(&self.app);
                if let Some(arg) = params {
                    eprintln!("Web App Error: {arg}");
                }
            }
            Some("player-get-capabilities") => self.player.send_capabilities(),
            Some("player-set-backend") => self.player.set_backend(params.as_ref()),
            Some("open-external") => {
                // safe_url ne laisse passer que http(s).
                if let Some(url) = params.as_ref().and_then(Value::as_str).and_then(safe_url) {
                    open::that_detached(url).ok();
                }
            }
            Some("play-external") => {
                if let Some(arg) = params.as_ref().and_then(Value::as_str) {
                    if let Err(error) = external::play(&self.app, arg) {
                        eprintln!("External player request failed: {error}");
                    }
                }
            }
            Some("autoupdater-notif-clicked") => crate::update::install_and_quit(&self.app),
            Some(method) if method.starts_with("mpv-") => {
                match msg.args.as_ref().map(serde_json::to_string) {
                    Some(Ok(json)) => self.player.send(json),
                    Some(Err(error)) => report_error("commande lecteur illisible", &error),
                    None => report_error("commande lecteur", &"arguments absents"),
                }
            }
            Some(unknown) => eprintln!("Unsupported command {unknown}"),
            None => {}
        }
    }

    /// `download-folder-pick` : sélecteur natif, un seul à la fois, sur un fil à part (la boîte ne bloque pas les autres
    /// commandes) ; `downloads::finish_pick` teste l'écriture puis enregistre le dossier dans shell.json.
    fn pick_download_folder(self: &Arc<Self>) {
        if self.download_picker_open.swap(true, Ordering::SeqCst) {
            self.send(RPCResponse::download_reply(
                "download-folder-pick",
                json!({ "ok": false, "code": "io", "message": "a folder picker is already open" }),
            ));
            return;
        }
        let shell = Arc::clone(self);
        thread::spawn(move || {
            let start = shell_config::downloads_dir().map(std::path::PathBuf::from);
            let selected = crate::dialogs::pick_folder(
                &shell.app,
                "Choisir le dossier de téléchargement",
                start,
            );
            shell.download_picker_open.store(false, Ordering::SeqCst);
            shell.send(RPCResponse::download_reply(
                "download-folder-pick",
                downloads::finish_pick(selected),
            ));
        });
    }

    /// `pick-cache-directory` (protocole Stremio, réservé au serveur de streaming local de la coque).
    fn pick_cache_directory(
        self: &Arc<Self>,
        request: CacheDirectoryRequest,
        local_server_url: Option<String>,
    ) {
        let refused = if local_server_url.as_deref() != Some(request.server_url.as_str()) {
            Some("The folder picker is only available for the shell's local server")
        } else if self.cache_picker_open.swap(true, Ordering::SeqCst) {
            Some("A folder picker is already open")
        } else {
            None
        };
        if let Some(error) = refused {
            self.send(RPCResponse::cache_directory_selected(
                request.request_id,
                Err(error.to_owned()),
            ));
            return;
        }
        let shell = Arc::clone(self);
        thread::spawn(move || {
            let start = request.directory.map(std::path::PathBuf::from);
            let selected =
                crate::dialogs::pick_folder(&shell.app, "Choisir le dossier du cache", start);
            shell.cache_picker_open.store(false, Ordering::SeqCst);
            shell.send(RPCResponse::cache_directory_selected(
                request.request_id,
                selected,
            ));
        });
    }
}
