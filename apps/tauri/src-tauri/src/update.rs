//! Mise à jour de l'app : flux signé ed25519 vérifié par `updater.rs` (partagé avec la coque Windows : hôte autorisé
//! `app.laststream.app`, https, signature vérifiée avant toute lecture, SHA-256 du fichier, `.part` supprimé en cas
//! d'échec). Flux propre à cette coque et à l'architecture : `https://app.laststream.app/app/tauri/<os>-<arch>/latest.json`
//! (`macos-aarch64`, `macos-x86_64`, `windows-x86_64`, `linux-x86_64`).
//!
//! Premier contrôle après `app-ready`, puis toutes les 12 h. Une version prête : signal `autoupdater-show-notif` (comme
//! la coque Windows) et boîte « Redémarrer maintenant / Plus tard » (la page n'envoie jamais `autoupdater-notif-clicked`,
//! la coque Windows téléchargeait donc sans jamais installer).
//! - macOS : archive `.app.tar.gz` extraite, l'app remplacée puis relancée (après la fermeture de la coque) ;
//! - Windows : installeur NSIS lancé en silencieux, puis l'app relancée ;
//! - Linux : l'AppImage remplacée puis relancée (le .deb suit le gestionnaire de paquets).

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use url::Url;

use crate::laststream_app::constants::UPDATE_INTERVAL;
use crate::laststream_app::ipc::RPCResponse;
use crate::laststream_app::robust::{self, report_error};
use crate::laststream_app::updater::{self, Update, Updater};
use crate::shell::Shell;
use crate::Opt;

/// Installeur vérifié en attente (version, fichier, SHA-256).
static READY: Mutex<Option<Update>> = Mutex::new(None);

fn default_endpoint() -> Url {
    Url::parse(&format!(
        "https://app.laststream.app/app/tauri/{}-{}/latest.json",
        std::env::consts::OS,
        std::env::consts::ARCH
    ))
    .expect("URL du flux valide")
}

pub fn start<R: Runtime>(shell: &Arc<Shell<R>>, opt: &Opt) {
    let disabled = opt.no_autoupdater || opt.development;
    let Some(endpoint) = updater::resolve_endpoint(
        opt.autoupdater_endpoint
            .clone()
            .or_else(|| Some(default_endpoint())),
        disabled,
    ) else {
        return;
    };
    let (tx, rx) = flume::unbounded::<String>();
    *robust::lock(&shell.updater_tx, "canal de mise à jour") = Some(tx);
    let force = opt.force_update;
    let shell = Arc::clone(shell);
    thread::Builder::new()
        .name("autoupdater".into())
        .spawn(move || {
            // Rien avant le premier `app-ready`.
            if rx.recv().is_err() {
                return;
            }
            let Ok(current) = env!("CARGO_PKG_VERSION").parse::<semver::Version>() else {
                return;
            };
            let mut ready_version = None;
            loop {
                let mut updater = Updater::new(current.clone(), &endpoint, force);
                updater.ready_version = ready_version.clone();
                match updater.autoupdate() {
                    Ok(Some(update)) => {
                        ready_version = Some(update.version.clone());
                        let version = update.version.to_string();
                        *robust::lock(&READY, "mise à jour prête") = Some(update);
                        shell.send(RPCResponse::update_available());
                        if ask_restart(&shell.app, &version) {
                            install_and_quit(&shell.app);
                            return;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => eprintln!("Failed to fetch updates: {error}"),
                }
                thread::sleep(Duration::from_secs(UPDATE_INTERVAL));
            }
        })
        .ok();
}

fn ask_restart<R: Runtime>(app: &AppHandle<R>, version: &str) -> bool {
    const NOW: &str = "Redémarrer maintenant";
    let answer = app
        .dialog()
        .message(format!(
            "La version {version} de Laststream est prête. Redémarrer l'app pour l'installer ?"
        ))
        .title("Mise à jour disponible")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            NOW.into(),
            "Plus tard".into(),
        ))
        .blocking_show_with_result();
    match answer {
        MessageDialogResult::Ok | MessageDialogResult::Yes => true,
        MessageDialogResult::Custom(label) => label == NOW,
        _ => false,
    }
}

/// `autoupdater-notif-clicked` ou « Redémarrer maintenant » : installeur revérifié (SHA-256) juste avant d'être lancé.
pub fn install_and_quit<R: Runtime>(app: &AppHandle<R>) {
    let Some(file) = updater::verified_installer_to_run(&READY) else {
        return;
    };
    match launch_installer(&file) {
        Ok(()) => crate::quit(app),
        Err(error) => report_error("mise à jour", &error),
    }
}

#[cfg(target_os = "macos")]
fn launch_installer(archive: &Path) -> Result<(), String> {
    // …/Laststream.app/Contents/MacOS/<exe> → …/Laststream.app
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe
        .ancestors()
        .nth(3)
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
        .ok_or("app hors d'un paquet .app")?
        .to_path_buf();
    let staging = archive.with_extension("extract");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let status = Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(&staging)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("archive de mise à jour illisible".into());
    }
    let new_app = std::fs::read_dir(&staging)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .ok_or("aucune app dans l'archive")?;
    // Remplacement après la fermeture de la coque (pid attendu), puis relance ; l'ancienne app est rétablie en cas d'échec.
    let script = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
rm -rf "$2.old"
if mv "$2" "$2.old" && /usr/bin/ditto "$3" "$2"; then rm -rf "$2.old"; else rm -rf "$2"; mv "$2.old" "$2"; fi
rm -rf "$4"
/usr/bin/open "$2""#;
    detached(
        Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .arg("laststream-update")
            .arg(std::process::id().to_string())
            .arg(&bundle)
            .arg(&new_app)
            .arg(&staging),
    )
}

#[cfg(windows)]
fn launch_installer(installer: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Installeur NSIS silencieux (il attend la fermeture de l'app), puis relance.
    let setup = installer.with_extension("setup.exe");
    std::fs::rename(installer, &setup).map_err(|e| e.to_string())?;
    // Ligne de commande passée telle quelle à cmd (guillemets de `start ""` compris).
    let mut command = Command::new("cmd");
    command
        .raw_arg(format!(
            "/C start \"\" /wait \"{}\" /S & start \"\" \"{}\"",
            setup.display(),
            exe.display()
        ))
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    detached(&mut command)
}

/// Linux : seule l'AppImage se met à jour elle-même (variable APPIMAGE : son chemin) ; le paquet .deb suit le
/// gestionnaire de paquets. La nouvelle AppImage remplace l'ancienne après la fermeture de la coque, puis se lance.
#[cfg(target_os = "linux")]
fn launch_installer(appimage: &Path) -> Result<(), String> {
    let current =
        std::env::var_os("APPIMAGE").ok_or("mise à jour automatique réservée à l'AppImage")?;
    let script = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
if cp "$3" "$2.new" && chmod +x "$2.new" && mv -f "$2.new" "$2"; then rm -f "$3"; else rm -f "$2.new"; fi
exec "$2""#;
    detached(
        Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .arg("laststream-update")
            .arg(std::process::id().to_string())
            .arg(current)
            .arg(appimage),
    )
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn launch_installer(_installer: &Path) -> Result<(), String> {
    Err("mise à jour automatique non prise en charge sur cette plateforme".into())
}

fn detached(command: &mut Command) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}
