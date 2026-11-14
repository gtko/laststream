//! Services locaux (mode `{"server":"local"}` de shell.json, ou `--webui-url`) : mêmes règles que la coque Windows
//! (`apps/desktop/src/laststream_app/lastaddon.rs` et `laststream_server/`).
//!
//! - lastAddon : un service déjà actif sur `http://127.0.0.1:7000` (`/health` → `{"ok":true}`) est réutilisé tel quel ;
//!   sinon Node lance `lastaddon/lastaddon.cjs` (ressources de l'app) sur le premier port libre à partir de 7000,
//!   prêt quand il écrit `LASTADDON_READY … port=<n>` (20 s au plus) ; relancé une fois s'il s'arrête ensuite.
//! - Serveur de streaming : Node lance `server.js`, prêt sur `EngineFS server started at <url locale>` (30 s au plus).
//!
//! Les processus enfants sont arrêtés quand la coque se ferme (`stop_all`).

use std::collections::VecDeque;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use crate::laststream_app::constants::SRV_LOG_SIZE;
use crate::laststream_app::robust;

const ADDON_READY_PREFIX: &str = "LASTADDON_READY";
const ADDON_READY_TIMEOUT: Duration = Duration::from_secs(20);
const SERVER_READY_PREFIX: &str = "EngineFS server started at ";
const SERVER_READY_TIMEOUT: Duration = Duration::from_secs(30);
const FIRST_PORT: u16 = 7000;
const PORT_CANDIDATES: u16 = 100;
const SERVICE_URL: &str = "http://127.0.0.1:7000";
const POLL: Duration = Duration::from_millis(50);

/// Processus enfants vivants, arrêtés à la fermeture de la coque.
static CHILDREN: Mutex<Vec<Child>> = Mutex::new(Vec::new());

pub fn stop_all() {
    for mut child in robust::lock(&CHILDREN, "services locaux").drain(..) {
        child.kill().ok();
        child.wait().ok();
    }
}

#[cfg(windows)]
const EXE: &str = ".exe";
#[cfg(not(windows))]
const EXE: &str = "";

/// Dossier des ressources embarquées (macOS : Contents/Resources ; Windows : dossier d'installation).
pub fn resources<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path().resource_dir().unwrap_or_else(|_| {
        let mut dir = env::current_exe().unwrap_or_default();
        dir.pop();
        dir
    })
}

fn no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Lignes de sortie gardées pour le message d'erreur (les dernières `SRV_LOG_SIZE`).
type Logs = Arc<Mutex<VecDeque<String>>>;

fn with_logs(error: String, logs: &Logs) -> String {
    let logs = robust::lock(logs, "sorties du service");
    if logs.is_empty() {
        error
    } else {
        format!(
            "{error}\n\nDernières sorties du service :\n{}",
            logs.iter().cloned().collect::<Vec<_>>().join("\n")
        )
    }
}

fn read_lines(
    output: impl Read + Send + 'static,
    logs: Logs,
    ready: flume::Sender<String>,
    parse: fn(&str) -> Option<String>,
) {
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { return };
            eprintln!("{line}");
            {
                let mut logs = robust::lock(&logs, "sorties du service");
                logs.push_back(line.clone());
                if logs.len() > SRV_LOG_SIZE {
                    logs.pop_front();
                }
            }
            if let Some(url) = parse(&line) {
                ready.send(url).ok();
            }
        }
    });
}

/// Issue d'un lancement.
pub enum Outcome {
    /// Prêt sur cette URL ; `crashed` reçoit un message si le service s'arrête ensuite.
    Ready(String, flume::Receiver<String>),
    Failed(String),
}

/// Lance `command`, attend la ligne « prêt » (`parse`) au plus `timeout`, puis surveille le processus.
fn launch(
    mut command: Command,
    parse: fn(&str) -> Option<String>,
    timeout: Duration,
    what: &str,
) -> Outcome {
    no_window(&mut command);
    let mut child = match command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return Outcome::Failed(format!("Impossible de lancer {what} : {error}")),
    };
    let logs: Logs = Arc::new(Mutex::new(VecDeque::new()));
    let (ready_tx, ready_rx) = flume::unbounded();
    if let Some(out) = child.stdout.take() {
        read_lines(out, Arc::clone(&logs), ready_tx.clone(), parse);
    }
    if let Some(err) = child.stderr.take() {
        // Seule la sortie standard annonce « prêt ».
        read_lines(err, Arc::clone(&logs), ready_tx, |_| None);
    }
    let started = Instant::now();
    loop {
        if let Ok(url) = ready_rx.try_recv() {
            let pid = child.id();
            robust::lock(&CHILDREN, "services locaux").push(child);
            let (crash_tx, crash_rx) = flume::bounded(1);
            let what = what.to_owned();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(500));
                let mut children = robust::lock(&CHILDREN, "services locaux");
                let Some(index) = children.iter().position(|c| c.id() == pid) else {
                    return;
                };
                if let Ok(Some(status)) = children[index].try_wait() {
                    children.remove(index).wait().ok();
                    drop(children);
                    crash_tx
                        .send(with_logs(format!("{what} s'est arrêté ({status})."), &logs))
                        .ok();
                    return;
                }
            });
            return Outcome::Ready(url, crash_rx);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                thread::sleep(Duration::from_millis(200));
                return Outcome::Failed(with_logs(
                    format!("{what} s'est arrêté ({status})."),
                    &logs,
                ));
            }
            Ok(None) => {}
            Err(error) => {
                return Outcome::Failed(format!("Impossible de lire l'état de {what} : {error}"))
            }
        }
        if started.elapsed() >= timeout {
            child.kill().ok();
            child.wait().ok();
            return Outcome::Failed(with_logs(
                format!(
                    "{what} ne s'est pas annoncé prêt dans les {} secondes.",
                    timeout.as_secs()
                ),
                &logs,
            ));
        }
        thread::sleep(POLL);
    }
}

// ---------- lastAddon ----------

fn parse_addon_ready(line: &str) -> Option<String> {
    let fields = line.trim().strip_prefix(ADDON_READY_PREFIX)?;
    let port = fields
        .split_whitespace()
        .find_map(|f| f.strip_prefix("port=")?.parse::<u16>().ok())
        .filter(|p| *p != 0)?;
    Some(format!("http://127.0.0.1:{port}/"))
}

fn is_free(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_err()
        && TcpListener::bind(address).is_ok()
}

/// lastAddon permanent déjà actif sur le port 7000 (3 essais, 800 ms, 900 ms d'écart, sans proxy).
fn existing_addon() -> bool {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .no_proxy()
        .build()
    else {
        return false;
    };
    (0..3).any(|attempt| {
        if attempt > 0 {
            thread::sleep(Duration::from_millis(900));
        }
        client
            .get(format!("{SERVICE_URL}/health"))
            .send()
            .ok()
            .filter(|r| r.status().is_success())
            .and_then(|r| r.text().ok())
            .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
            .and_then(|v| v.get("ok").and_then(serde_json::Value::as_bool))
            == Some(true)
    })
}

fn addon_command(resources: &Path, data_dir: &Path, port: u16) -> Command {
    let mut command = Command::new(resources.join("lastaddon").join(format!("node{EXE}")));
    command
        .arg(resources.join("lastaddon").join("lastaddon.cjs"))
        .env("PORT", port.to_string())
        .env("LASTADDON_UI_DIR", resources.join("ui"))
        .env("LASTADDON_DATA_DIR", data_dir)
        .env("LASTADDON_ENV_FILE", data_dir.join(".env"))
        .env("LASTADDON_FFMPEG", resources.join(format!("ffmpeg{EXE}")))
        .env(
            "LASTADDON_ALLOWED_ORIGINS",
            format!("http://127.0.0.1:{port}"),
        );
    command
}

/// Démarre (ou réutilise) lastAddon. `Ready(url, crash)` ; `crash` ne reçoit rien pour un service permanent réutilisé.
pub fn start_addon<R: Runtime>(app: &AppHandle<R>) -> Outcome {
    if existing_addon() {
        return Outcome::Ready(format!("{SERVICE_URL}/"), flume::bounded(0).1);
    }
    let Some(port) = (FIRST_PORT..FIRST_PORT + PORT_CANDIDATES).find(|p| is_free(*p)) else {
        return Outcome::Failed(format!("Aucun port local libre à partir de {FIRST_PORT}."));
    };
    let Some(data_dir) = dirs::config_dir().map(|d| d.join("Laststream").join("lastaddon")) else {
        return Outcome::Failed("Impossible de localiser le dossier de données.".into());
    };
    if let Err(error) = fs::create_dir_all(&data_dir) {
        return Outcome::Failed(format!(
            "Impossible de créer {} : {error}",
            data_dir.display()
        ));
    }
    launch(
        addon_command(&resources(app), &data_dir, port),
        parse_addon_ready,
        ADDON_READY_TIMEOUT,
        "Le service Laststream",
    )
}

// ---------- Serveur de streaming ----------

/// `EngineFS server started at <url>` : URL http locale (loopback), port explicite non nul, chemin `/`, sans plus.
fn parse_server_ready(line: &str) -> Option<String> {
    let rest = line.strip_prefix(SERVER_READY_PREFIX)?.trim();
    let url = Url::parse(rest).ok()?;
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    );
    let ok = url.scheme() == "http"
        && loopback
        && url.port().is_some_and(|p| p != 0)
        && url.path() == "/"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    ok.then(|| url.to_string())
}

pub fn start_streaming_server<R: Runtime>(app: &AppHandle<R>) -> Outcome {
    let resources = resources(app);
    let script = resources.join("server.js");
    if !script.is_file() {
        return Outcome::Failed(
            "Le serveur de streaming n'est pas installé avec cette version.".into(),
        );
    }
    // Même Node que lastAddon (la coque Windows utilise un runtime Node 18 à part).
    let mut command = Command::new(resources.join("lastaddon").join(format!("node{EXE}")));
    command.arg(script);
    launch(
        command,
        parse_server_ready,
        SERVER_READY_TIMEOUT,
        "Le serveur de streaming",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addon_ready_line() {
        assert_eq!(
            parse_addon_ready("LASTADDON_READY version=1 port=7003"),
            Some("http://127.0.0.1:7003/".into())
        );
        assert_eq!(parse_addon_ready("LASTADDON_READY port=0"), None);
        assert_eq!(parse_addon_ready("ready port=7003"), None);
    }

    #[test]
    fn server_ready_line_accepts_only_loopback_root() {
        assert_eq!(
            parse_server_ready("EngineFS server started at http://127.0.0.1:11470/"),
            Some("http://127.0.0.1:11470/".into())
        );
        assert_eq!(
            parse_server_ready("EngineFS server started at http://example.com:11470/"),
            None
        );
        assert_eq!(
            parse_server_ready("EngineFS server started at http://127.0.0.1/"),
            None
        );
        assert_eq!(
            parse_server_ready("EngineFS server started at http://127.0.0.1:11470/x"),
            None
        );
        assert_eq!(
            parse_server_ready("EngineFS server started at http://u:p@127.0.0.1:11470/"),
            None
        );
    }
}
