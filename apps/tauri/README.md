# Laststream : coque Tauri (macOS et Windows)

App desktop Laststream construite avec Tauri 2. Elle parle **exactement le même protocole** que la coque Windows
historique (`apps/desktop`) : l'interface web (`apps/web`) fonctionne sans aucun changement. La coque Windows historique
reste celle qui est publiée sous Windows tant que celle-ci n'a pas été validée.

## Architecture

| Élément | Coque Windows historique | Coque Tauri |
|---|---|---|
| WebView | WebView2 | WKWebView (macOS), WebView2 (Windows) |
| Pont page ↔ coque | `window.chrome.webview` natif | `src/bridge.js` recrée `window.chrome.webview` et le relais `qt.webChannelTransport` avant les scripts de la page ; une seule commande Tauri, `shell_post` |
| Vidéo | mpv dans la fenêtre (`wid`), sous la WebView2 transparente | Windows : idem (fenêtre enfant au fond, D3D11) ; macOS : API de rendu libmpv (OpenGL) dans un `CAOpenGLLayer` sous la WKWebView (`mac/mpv_layer.m`) |
| Code partagé | — | compilé directement depuis `apps/desktop/src/laststream_app/` par `#[path]` (`src/laststream_app/mod.rs`) : IPC et liste blanche, ponts `native-http` / `native-range` / `native-addon-http` / `native-box-playlist`, téléchargements, ouverture de médias, `shell.json`, mise à jour signée, diagnostics, protocole du lecteur |

Une correction dans un module partagé vaut pour les deux coques ; `tauri-ci.yml` compile et teste ces modules sous
Linux, macOS et Windows en plus de `desktop-ci.yml`.

### Correspondance des fichiers

- `src/shell.rs` : état de la coque et répartition des commandes (équivalent de `app.rs`).
- `src/web.rs` : messages vers la page (`window.__lsShell.deliver(...)`).
- `src/commands.rs` : `shell_post`, filtré sur l'origine de l'interface chargée.
- `src/player/mpv.rs` : moteur mpv (logique de `laststream_player/player.rs`) ; `src/player/video.rs` : surface vidéo.
- `src/window_ops.rs`, `src/window_state.rs`, `src/tray.rs` : plein écran, PiP, barre système, état de la fenêtre
  (`window-state.json`, même schéma).
- `src/services.rs`, `src/local.rs` : interface publique / personnalisée / locale (lastAddon, serveur de streaming).
- `src/external.rs` : VLC et lecteur du système. `src/update.rs` : mise à jour. `src/migrate.rs` : reprise du profil
  WebView2 de la coque Windows (connexion, réglages).

### Différences voulues avec la coque Windows historique

- La mise à jour s'installe vraiment : une boîte propose de redémarrer quand une version est prête (la page n'envoie pas
  `autoupdater-notif-clicked`, la coque historique téléchargeait donc sans installer).
- « Lecteur du système » accepte la liste `#EXTINF:-1,<titre>` que la page envoie (la coque historique la refusait).
- Pas de moteur libVLC ni de traitement GPU NVIDIA (`playerBackends` = `["mpv"]`, `gpuVideoProcessing=false`).

## Construire en local

macOS : `brew install mpv dylibbundler pkg-config`, puis :

```sh
cd apps/tauri && npm ci
cargo run --manifest-path src-tauri/Cargo.toml -- --devtools          # développement (libmpv de Homebrew)
bash scripts/stage-mpv-macos.sh                                       # paquet : libmpv et dépendances en @rpath
LASTSTREAM_MPV_LIB_DIR=$PWD/src-tauri/target/mpv-stage \
  npx tauri build --bundles app,dmg --config src-tauri/target/mpv-stage/frameworks.json
```

L'app n'est pas notarisée (pas de compte Apple Developer) : au premier lancement, clic droit → Ouvrir.

Windows : `libmpv-2.dll` (archive LFS `apps/desktop/libmpv-2_x64.zip`) est installée à côté de l'exécutable ; la liaison
utilise `apps/desktop/mpv-x64/mpv.lib`. Voir `.github/workflows/tauri-ci.yml`.

Linux (développement seulement) : WebKitGTK et `libmpv-dev` ; mpv ouvre sa propre fenêtre.

## Release et mise à jour

`release.yml` appelle `tauri-release.yml` à chaque release `vX.Y.Z` (version écrite par `scripts/release/version.mjs`) :

| Fichier de la release | Rôle |
|---|---|
| `Laststream-X.Y.Z-macos-aarch64.dmg`, `…-macos-x86_64.dmg` | installation macOS (Apple Silicon, Intel) |
| `Laststream-X.Y.Z-macos-aarch64.app.tar.gz`, `…-macos-x86_64.app.tar.gz` | mise à jour macOS |
| `Laststream-X.Y.Z-windows-x86_64.setup.exe` | installation et mise à jour Windows (NSIS) |
| `tauri-<plateforme>-latest.json` (+ `.sig`) | flux signé ed25519 (clé `LASTSTREAM_UPDATE_SIGNING_KEY`, celle de la coque Windows) |

Le Worker `laststream-edge` sert flux et fichiers sous `https://app.laststream.app/app/tauri/<plateforme>/` (seul hôte
accepté par l'updater). Un échec de la construction Tauri ne bloque pas la release Windows et Android.

## Reste à faire

- Mode local sous macOS : Node, `lastaddon.cjs`, l'interface et ffmpeg ne sont pas encore embarqués dans le paquet
  (le mode public, par défaut, n'en a pas besoin).
- Touches multimédia hors focus (Centre de contrôle macOS) : seules celles reçues par la fenêtre active sont relayées.
