# Laststream : app Tauri (macOS, Windows, Linux, Android)

App desktop Laststream construite avec Tauri 2. Elle parle **exactement le même protocole** que la coque Windows
historique (`apps/desktop`) : l'interface web (`apps/web`) fonctionne sans aucun changement. C'est la seule app desktop
publiée depuis la v1.0.61 ; la coque Windows historique n'est plus construite, mais chaque release lui sert encore un flux
`latest.json` (installeur NSIS de cette app) pour qu'elle passe à l'app Tauri (voir « Mises à jour »).

## Architecture

| Élément | Coque Windows historique | Coque Tauri |
|---|---|---|
| WebView | WebView2 | WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux) |
| Pont page ↔ coque | `window.chrome.webview` natif | `src/bridge.js` recrée `window.chrome.webview` et le relais `qt.webChannelTransport` avant les scripts de la page ; une seule commande Tauri, `shell_post` |
| Vidéo | mpv dans la fenêtre (`wid`), sous la WebView2 transparente | Windows : idem (fenêtre enfant au fond, D3D11) ; macOS : API de rendu libmpv (OpenGL) dans un `CAOpenGLLayer` sous la WKWebView (`mac/mpv_layer.m`) ; Linux : API de rendu libmpv dans un `GtkGLArea` sous la WebKitGTK transparente (`GtkOverlay`) |
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

## Android

Même app que l'app Capacitor (`apps/mobile`) : même identifiant (`com.laststream.app`, `src-tauri/tauri.android.conf.json`),
même clé de signature et même `versionCode` (AAAAMMJJNN) ; l'APK Tauri s'installe par-dessus l'APK Capacitor. L'interface
est chargée depuis `https://app.laststream.app` (page de démarrage `splash/android.html` : sonde du serveur, écran hors
ligne) et retrouve l'API Capacitor qu'elle attend :

| Élément | Où |
|---|---|
| `window.Capacitor` (plateforme `android`, `PluginHeaders`, `nativePromise`, `nativeCallback`) | `src-tauri/src/capacitor.js`, injecté avant les scripts de la page |
| Commandes `capacitor|call`, `registerListener`, `removeListener` | plugin Tauri `capacitor` (`src/mobile.rs`, permission `capacitor:default` réservée à `app.laststream.app`) |
| Plugins natifs (lecteur libVLC, téléchargements, mise à jour, écran) | **repris tels quels** de `apps/mobile/android/app/src/main/java` (Gradle `sourceSets`), avec ses ressources |
| API `com.getcapacitor` dont ils se servent (`Plugin`, `PluginCall`, `JSObject`…) | `gen/android/app/src/main/java/com/getcapacitor`, sur `CapacitorBridgePlugin` |
| `CapacitorHttp`, `@capacitor/app` (retour, `minimizeApp`) | `gen/android/app/src/main/java/com/laststream/app/bridge` |

`scripts/capacitor.test.mjs` vérifie `capacitor.js` avec le vrai `@capacitor/core` et que ses listes de méthodes suivent
les `@PluginMethod` Kotlin. Les tests unitaires Kotlin de `apps/mobile` tournent aussi dans le projet Tauri.

```sh
export ANDROID_HOME=… NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
rustup target add aarch64-linux-android armv7-linux-androideabi
cd apps/tauri && npm ci && npx tauri android build --target aarch64 --target armv7 --apk
```

## Construire en local

macOS : `brew install mpv dylibbundler pkg-config`, puis :

```sh
cd apps/tauri && npm ci
cargo run --manifest-path src-tauri/Cargo.toml -- --devtools          # développement (libmpv de Homebrew)
bash scripts/stage-mpv-macos.sh                                       # paquet : libmpv et dépendances en @rpath
LASTSTREAM_MPV_LIB_DIR=$PWD/src-tauri/target/mpv-stage \
  npx tauri build --bundles app,dmg --config src-tauri/target/mpv-stage/frameworks.json
```

Sans les secrets Apple, la release est signée ad hoc et non notarisée : au premier lancement, macOS la bloque (Réglages
Système → Confidentialité et sécurité → « Ouvrir quand même »). Voir « Signature et notarisation macOS ».

Windows : `libmpv-2.dll` (archive LFS `apps/desktop/libmpv-2_x64.zip`) est installée à côté de l'exécutable ; la liaison
utilise `apps/desktop/mpv-x64/mpv.lib`. Voir `.github/workflows/tauri-ci.yml`.

Linux (x86_64) : WebKitGTK et `libmpv-dev` pour compiler. AppImage (libmpv incluse, mise à jour automatique : le fichier
`$APPIMAGE` est remplacé) et `.deb` (dépend de `libmpv2`, mis à jour par le gestionnaire de paquets).

## Release et mise à jour

`release.yml` appelle `tauri-release.yml` à chaque release `vX.Y.Z` (version écrite par `scripts/release/version.mjs`) :

| Fichier de la release | Rôle |
|---|---|
| `Laststream-X.Y.Z-macos-aarch64.dmg`, `…-macos-x86_64.dmg` | installation macOS (Apple Silicon, Intel) |
| `Laststream-X.Y.Z-macos-aarch64.app.tar.gz`, `…-macos-x86_64.app.tar.gz` | mise à jour macOS |
| `Laststream-X.Y.Z-windows-x86_64.setup.exe` | installation et mise à jour Windows (NSIS) |
| `Laststream-X.Y.Z-linux-x86_64.AppImage`, `….deb` | installation Linux (l'AppImage se met à jour seule) |
| `Laststream-X.Y.Z-android-tauri.apk` | Android (à essayer : `android-latest.json` reste celui de l'APK Capacitor) |
| `tauri-<plateforme>-latest.json` (+ `.sig`) | flux signé ed25519 (clé `LASTSTREAM_UPDATE_SIGNING_KEY`, celle de la coque Windows) |

Le Worker `laststream-edge` sert flux et fichiers sous `https://app.laststream.app/app/tauri/<plateforme>/` (seul hôte
accepté par l'updater). Un échec de la construction Tauri ne bloque pas la release Windows et Android.

## Reste à faire

- Mode local sous macOS : Node, `lastaddon.cjs`, l'interface et ffmpeg ne sont pas encore embarqués dans le paquet
  (le mode public, par défaut, n'en a pas besoin).
- Touches multimédia hors focus (Centre de contrôle macOS) : seules celles reçues par la fenêtre active sont relayées.

## Mises à jour

Flux signés ed25519 (clé `LASTSTREAM_UPDATE_SIGNING_KEY`, clé publique dans `apps/desktop/src/laststream_app/constants.rs`),
servis par laststream-edge depuis la dernière release GitHub :

| App | Flux | Fichier installé |
|---|---|---|
| macOS (aarch64, x86_64) | `app.laststream.app/app/tauri/macos-<arch>/latest.json` | `.app.tar.gz` : l'app est remplacée puis relancée |
| Windows | `app.laststream.app/app/tauri/windows-x86_64/latest.json` | installeur NSIS en silencieux (`/S`), puis relance |
| Linux (AppImage) | `app.laststream.app/app/tauri/linux-x86_64/latest.json` | l'AppImage (`$APPIMAGE`) est remplacée ; le `.deb` ne se met pas à jour seul (aucun contrôle) |
| Android | `app.laststream.app/app/android/latest.json` | APK, installeur système (même paquet et même certificat que l'ancien APK Capacitor) |
| Ancienne coque Windows (`apps/desktop`) | `app.laststream.app/app/windows/latest.json` | même installeur NSIS, publié aussi sous `Laststream-Setup-X.Y.Z.exe` ; la page affiche « La nouvelle app Laststream est prête — Installer » (`initShellUpdateBanner`), l'installeur s'ouvre en mode normal |

## Signature et notarisation macOS

`tauri-release.yml` signe avec un certificat Developer ID, active le runtime renforcé (droits :
`src-tauri/mac/Entitlements.plist`), fait notariser et agrafer l'app puis le `.dmg`, dès que ces 5 secrets du dépôt existent
(Settings → Secrets and variables → Actions). Aucun : build ad hoc comme avant. Une partie seulement : la release échoue.

| Secret | Contenu |
|---|---|
| `APPLE_CERTIFICATE` | certificat **Developer ID Application** exporté en `.p12` depuis le Trousseau (avec sa clé privée), encodé en base64 : `base64 -i certificat.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | mot de passe choisi à l'export du `.p12` |
| `APPLE_ID` | e-mail du compte Apple Developer |
| `APPLE_PASSWORD` | mot de passe **pour app** créé sur account.apple.com (Connexion et sécurité → Mots de passe pour app), pas le mot de passe du compte |
| `APPLE_TEAM_ID` | identifiant d'équipe à 10 caractères (developer.apple.com → Membership details) |

L'identité de signature est lue dans le certificat (aucun secret de plus). Les apps déjà installées (signées ad hoc) passent
à la version notarisée par la mise à jour habituelle : le remplacement se fait sans quarantaine, donc sans blocage.

