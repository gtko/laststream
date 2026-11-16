//! `play-external` : lecture dans un lecteur externe.
//! - `vlc://<url http(s)>` : lance VLC sur l'URL ;
//! - `data:application/octet-stream;charset=utf-8;base64,<m3u>` : liste `#EXTM3U` / `#EXTINF:…` / URL, écrite dans
//!   `<Téléchargements>/Laststream/playlist.m3u` puis ouverte par le lecteur par défaut du système.
//!
//! La page envoie `#EXTINF:-1,<titre>` (apps/web/src/player/external.ts) : accepté ici, alors que la coque Windows
//! historique n'acceptait que `#EXTINF:0` (le bouton « lecteur du système » n'y faisait rien).

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use tauri::{AppHandle, Runtime};
use url::Url;

const M3U_DATA_URI_PREFIX: &str = "data:application/octet-stream;charset=utf-8;base64,";

#[derive(Debug, PartialEq)]
enum Request {
    Vlc(Url),
    Playlist(Url, String),
}

pub fn play<R: Runtime>(app: &AppHandle<R>, input: &str) -> Result<(), &'static str> {
    match parse(input)? {
        Request::Vlc(url) => {
            if spawn_vlc(&url) {
                Ok(())
            } else {
                crate::dialogs::error(
                    app,
                    "Laststream",
                    "VLC est introuvable sur cet ordinateur. Installez-le puis réessayez.",
                );
                Err("VLC not found")
            }
        }
        Request::Playlist(url, title) => open_playlist(&url, &title),
    }
}

fn parse(input: &str) -> Result<Request, &'static str> {
    if let Some(encoded) = input.strip_prefix(M3U_DATA_URI_PREFIX) {
        return parse_playlist(encoded);
    }
    let (scheme, rest) = input
        .split_once("://")
        .ok_or("unsupported external player")?;
    match scheme.to_ascii_lowercase().as_str() {
        "vlc" => stream_url(rest).map(Request::Vlc),
        _ => Err("unsupported external player"),
    }
}

/// Exactement trois lignes : `#EXTM3U`, `#EXTINF:<durée>[,<titre>]`, URL http(s).
fn parse_playlist(encoded: &str) -> Result<Request, &'static str> {
    let decoded = BASE64.decode(encoded).map_err(|_| "invalid playlist")?;
    let playlist = String::from_utf8(decoded).map_err(|_| "invalid playlist")?;
    let mut lines = playlist.lines().filter(|l| !l.trim().is_empty());
    if lines.next().map(str::trim) != Some("#EXTM3U") {
        return Err("invalid playlist");
    }
    let info = lines.next().ok_or("invalid playlist")?.trim();
    let rest = info.strip_prefix("#EXTINF:").ok_or("invalid playlist")?;
    let (duration, title) = rest.split_once(',').unwrap_or((rest, ""));
    if duration.trim().parse::<f64>().is_err() {
        return Err("invalid playlist");
    }
    let url = stream_url(lines.next().ok_or("invalid playlist")?.trim())?;
    if lines.next().is_some() {
        return Err("invalid playlist");
    }
    // Le titre est réécrit dans le fichier : aucun saut de ligne ni caractère de contrôle.
    let title: String = title
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    Ok(Request::Playlist(url, title))
}

fn stream_url(input: &str) -> Result<Url, &'static str> {
    const ERROR: &str = "stream URL must be absolute HTTP(S)";
    if input
        .chars()
        .any(|c| c.is_ascii_whitespace() || c.is_control())
    {
        return Err(ERROR);
    }
    let url = Url::parse(input).map_err(|_| ERROR)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(ERROR);
    }
    Ok(url)
}

fn open_playlist(url: &Url, title: &str) -> Result<(), &'static str> {
    let dir = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .ok_or("no downloads folder")?
        .join("Laststream");
    fs::create_dir_all(&dir).map_err(|_| "cannot create playlist folder")?;
    let path = dir.join("playlist.m3u");
    let body = format!("#EXTM3U\n#EXTINF:-1,{title}\n{url}\n");
    fs::write(&path, body).map_err(|_| "cannot write playlist")?;
    open::that_detached(&path).map_err(|_| "cannot open playlist")
}

/// Lance VLC détaché de la coque. Faux si aucun VLC n'a pu être lancé.
fn spawn_vlc(url: &Url) -> bool {
    for program in candidates() {
        let mut command = Command::new(&program);
        command
            .arg("--")
            .arg(url.as_str())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        detach(&mut command);
        if command.spawn().is_ok() {
            return true;
        }
    }
    // macOS : Launch Services trouve VLC où qu'il soit installé ; le code de `open` dit s'il existe.
    #[cfg(target_os = "macos")]
    return Command::new("open")
        .args(["-a", "VLC", "--args", url.as_str()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(target_os = "macos")]
fn candidates() -> Vec<PathBuf> {
    let mut list = vec![PathBuf::from("/Applications/VLC.app/Contents/MacOS/VLC")];
    if let Some(home) = dirs::home_dir() {
        list.push(home.join("Applications/VLC.app/Contents/MacOS/VLC"));
    }
    list.retain(|p| p.is_file());
    list
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let mut list = Vec::new();
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        if let Ok(key) = RegKey::predef(root)
            .open_subkey(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\vlc.exe")
        {
            if let Ok(path) = key.get_value::<String, _>("") {
                list.push(PathBuf::from(path.trim_matches('"')));
            }
        }
    }
    if let Ok(key) =
        RegKey::predef(HKEY_CLASSES_ROOT).open_subkey(r"Applications\vlc.exe\shell\open\command")
    {
        if let Ok(command) = key.get_value::<String, _>("") {
            if let Some(exe) = command
                .trim()
                .strip_prefix('"')
                .and_then(|c| c.split('"').next())
            {
                list.push(PathBuf::from(exe));
            }
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(dir) = std::env::var_os(var) {
            list.push(PathBuf::from(dir).join(r"VideoLAN\VLC\vlc.exe"));
        }
    }
    list.retain(|p| p.is_file());
    list.push(PathBuf::from("vlc.exe"));
    list
}

#[cfg(not(any(windows, target_os = "macos")))]
fn candidates() -> Vec<PathBuf> {
    vec![PathBuf::from("vlc")]
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW : le lecteur survit à la coque.
    command.creation_flags(0x0100_0000 | 0x0800_0000);
}

#[cfg(not(windows))]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m3u(text: &str) -> String {
        format!("{M3U_DATA_URI_PREFIX}{}", BASE64.encode(text))
    }

    #[test]
    fn accepts_vlc_and_both_playlist_forms() {
        assert_eq!(
            parse("vlc://https://x.y/a.mkv"),
            Ok(Request::Vlc(Url::parse("https://x.y/a.mkv").unwrap()))
        );
        assert_eq!(
            parse(&m3u("#EXTM3U\n#EXTINF:0\nhttps://x.y/a")),
            Ok(Request::Playlist(
                Url::parse("https://x.y/a").unwrap(),
                String::new()
            ))
        );
        assert_eq!(
            parse(&m3u("#EXTM3U\n#EXTINF:-1,Dune\nhttps://x.y/a\n")),
            Ok(Request::Playlist(
                Url::parse("https://x.y/a").unwrap(),
                "Dune".into()
            ))
        );
    }

    #[test]
    fn refuses_other_inputs() {
        assert!(parse("file:///etc/passwd").is_err());
        assert!(parse("vlc://file:///x").is_err());
        assert!(parse(&m3u("#EXTM3U\n#EXTINF:x\nhttps://x.y/a")).is_err());
        assert!(parse(&m3u("#EXTM3U\n#EXTINF:0\nhttps://x.y/a\nhttps://x.y/b")).is_err());
        assert!(parse(&m3u("#EXTM3U\n#EXTINF:0\njavascript:alert(1)")).is_err());
    }
}
