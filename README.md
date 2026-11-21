# Laststream

Mono-repo de Laststream : applications, services Cloudflare et contrat partagé. Chaque dossier garde ses propres
`package.json`, tests et README ; l'historique de chaque ancien dépôt est conservé (tags préfixés par projet).
L'ancienne app Windows (`apps/desktop`, Rust + WebView2) et l'ancienne app Android Capacitor (`apps/mobile`), remplacées
par `apps/tauri`, ont été retirées du dépôt : leur code reste dans l'historique git.

| Dossier | Contenu | Ancien dépôt | Mise en production |
| --- | --- | --- | --- |
| `apps/web` | Interface (Vite) | `gtko/laststream-app` | servie par lastaddon-core (voir `services/core`) |
| `apps/tauri` | Application Tauri : macOS, Windows, Linux, Android (interface chargée depuis le serveur, lecteur mpv / libVLC) | `gtko/laststream-shell-ng` et `gtko/laststream-app` (`android/`) | release automatique `vX.Y.Z` (voir plus bas) |
| `apps/site` | Site vitrine www.laststream.app | `gtko/laststream-site` | Workers Builds (laststream-www, dossier racine `apps/site`) |
| `services/core` | Worker lastaddon-core : API, salons, sert `apps/web` | `gtko/lastaddon` | Workers Builds (dossier racine `services/core`, build `npm run build:cloudflare`) |
| `services/edge` | Worker laststream-edge : app.laststream.app, APK/EXE depuis R2 | `gtko/laststream-edge` | Workers Builds (dossier racine `services/edge`) |
| `packages/protocol` | `@laststream/protocol` : types partagés web/serveur | `gtko/laststream-protocol` | dépendance locale (`file:../../packages/protocol`) |

## Démarrer

```bash
git lfs install                 # libmpv pour Windows (apps/tauri/mpv : dll, archive) en Git LFS
git clone https://github.com/gtko/laststream
cd laststream/apps/web && npm ci && npm run dev
```

Pour travailler sans les binaires Windows : `GIT_LFS_SKIP_SMUDGE=1 git clone …` (pointeurs LFS seulement). App Tauri :
voir `apps/tauri/README.md`.

## CI

Un workflow par projet, à la racine (`.github/workflows/`), déclenché seulement par les changements de son dossier :
`web-ci.yml` et `core-ci.yml` (aussi sur `packages/protocol`), `edge-ci.yml`, `tauri-ci.yml`. Tous tournent sur les runners
hébergés par GitHub : web, core et edge sur `ubuntu-latest`, Tauri sur Linux, Android, macOS et Windows.

## Tags

Préfixés par projet : `core-vX.Y.Z`, `edge-vX.Y.Z`, `site-vX.Y.Z`, `protocol-vX.Y.Z`, `web-vX.Y.Z` (et `desktop-vX.Y.Z`
pour les anciennes versions de l'app Windows). Les tags des anciens dépôts ont été renommés ainsi à l'import (ex. `v0.4.3`
de lastaddon → `core-v0.4.3`). Les releases automatiques du produit (app Tauri pour toutes les plateformes + APK Android)
portent le tag non préfixé `vX.Y.Z`.

### Releases automatiques

Le workflow `.github/workflows/release.yml` se déclenche à chaque PR fusionnée sur `main` : bump de version (patch par défaut,
label `release:minor` ou `release:major` sur la PR pour monter d'un cran), `CHANGELOG.md` à la racine, commit `release: vX.Y.Z`
et tag annoté `vX.Y.Z` sur `main`, build de l'app Tauri (`apps/tauri`) pour macOS (Apple Silicon et Intel), Windows et Linux
(`tauri-release.yml` appelé en `workflow_call`) et de son APK Android, puis release GitHub publiée avec bannière, changelog et
assets (`.dmg`, `.app.tar.gz`, `.setup.exe`, `.AppImage`, `.deb`, flux `tauri-<plateforme>-latest.json` + `.sig`, APK,
`android-latest.json`). La version est écrite dans `apps/tauri/src-tauri/Cargo.toml` et `Cargo.lock` (`scripts/release/version.mjs`).
Le label `release:skip` sur la PR désactive la release. Relance manuelle des builds d'un tag existant :
Actions → Release → Run workflow avec `tag` = `vX.Y.Z` (sans nouveau bump).

Reprise et limites :

- Si l'étape `prepare` échoue après le push du tag, « Re-run » ne refait rien : `main` pointe déjà sur le commit `release: vX.Y.Z`.
  Relancer via Actions → Release → Run workflow avec `tag` = `vX.Y.Z` (rejoue les builds et la publication, sans nouveau bump).
- Deux merges très rapprochés peuvent être livrés dans la même release : le second n'apparaît pas dans le changelog et ses labels
  `release:*` sont ignorés.
- Les PR venant de forks ne déclenchent pas de release ; leur commit est repris dans le changelog de la release suivante.

Réglages requis sur le dépôt :

- Secrets : `ANDROID_DEBUG_KEYSTORE_B64` (keystore de signature de l'APK, en base64) et `LASTSTREAM_UPDATE_SIGNING_KEY` (clé ed25519
  de signature des flux de mise à jour).
- APK Android : chaque release joint `android-latest.json` (versionCode, URL de l'APK de la release, SHA-256). Le Worker
  `laststream-edge` le relit sur `releases/latest/download/` et le sert sur `https://app.laststream.app/app/android/latest.json`
  (bouton « Télécharger l'APK » du site, mise à jour en un tap de l'app). Aucun secret supplémentaire.
- Settings → Actions → General → Workflow permissions : « Read and write permissions ».
- Si `main` est protégée, autoriser GitHub Actions à contourner la protection (bypass) : le workflow pousse le commit de release
  et le tag directement.

Pour toutes les plateformes, le Worker `laststream-edge` relit le flux de version et l'installeur sur la dernière release publiée : le site et la mise à jour automatique suivent chaque release, une fois le Worker déployé.
