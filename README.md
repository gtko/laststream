# Laststream

Mono-repo de Laststream : applications, services Cloudflare et contrat partagé. Chaque dossier garde ses propres
`package.json`, tests et README ; l'historique de chaque ancien dépôt est conservé (tags préfixés par projet).

| Dossier | Contenu | Ancien dépôt | Mise en production |
| --- | --- | --- | --- |
| `apps/web` | Interface (Vite) | `gtko/laststream-app` | servie par lastaddon-core (voir `services/core`) |
| `apps/mobile` | Application Android (Capacitor, interface chargée depuis le serveur) | `gtko/laststream-app` (`android/`) | APK publiée dans R2 (`apps/web/scripts/publish-android.mjs`) |
| `apps/desktop` | Application Windows (Rust, mpv) | `gtko/laststream-shell-ng` | tag `desktop-vX.Y.Z` + workflow « Desktop release » |
| `apps/site` | Site vitrine www.laststream.app | `gtko/laststream-site` | Workers Builds (laststream-www, dossier racine `apps/site`) |
| `services/core` | Worker lastaddon-core : API, salons, sert `apps/web` | `gtko/lastaddon` | Workers Builds (dossier racine `services/core`, build `npm run build:cloudflare`) |
| `services/edge` | Worker laststream-edge : app.laststream.app, APK/EXE depuis R2 | `gtko/laststream-edge` | Workers Builds (dossier racine `services/edge`) |
| `packages/protocol` | `@laststream/protocol` : types partagés web/serveur | `gtko/laststream-protocol` | dépendance locale (`file:../../packages/protocol`) |

## Démarrer

```bash
git lfs install                 # binaires de apps/desktop (dll, exe, archives libmpv) en Git LFS
git clone https://github.com/gtko/laststream
cd laststream/apps/web && npm ci && npm run dev
```

Pour travailler sans les binaires Windows : `GIT_LFS_SKIP_SMUDGE=1 git clone …` (pointeurs LFS seulement).

## CI

Un workflow par projet, à la racine (`.github/workflows/`), déclenché seulement par les changements de son dossier :
`web-ci.yml` et `core-ci.yml` (aussi sur `packages/protocol`), `edge-ci.yml`, `desktop-ci.yml`. Tous tournent sur les runners
hébergés par GitHub : web, core et edge sur `ubuntu-latest`, desktop sur `windows-latest`.

## Tags

Préfixés par projet : `core-vX.Y.Z`, `edge-vX.Y.Z`, `desktop-vX.Y.Z`, `site-vX.Y.Z`, `protocol-vX.Y.Z`, `web-vX.Y.Z`.
Les tags des anciens dépôts ont été renommés ainsi à l'import (ex. `v0.4.3` de lastaddon → `core-v0.4.3`).
Les releases automatiques du produit (installeur Windows + APK Android) portent le tag non préfixé `vX.Y.Z`.

### Releases automatiques

Le workflow `.github/workflows/release.yml` se déclenche à chaque PR fusionnée sur `main` : bump de version (patch par défaut,
label `release:minor` ou `release:major` sur la PR pour monter d'un cran), `CHANGELOG.md` à la racine, commit `release: vX.Y.Z`
et tag annoté `vX.Y.Z` sur `main`, build de l'installeur Windows (`desktop-release.yml` appelé en `workflow_call`) et de l'APK
Android, puis release GitHub publiée avec bannière, changelog et assets (installeur, `latest.json` + `.sig`, APK).
Le label `release:skip` sur la PR désactive la release. Pas de build macOS. Relance manuelle des builds d'un tag existant :
Actions → Release → Run workflow avec `tag` = `vX.Y.Z` (sans nouveau bump).

Reprise et limites :

- Si l'étape `prepare` échoue après le push du tag, « Re-run » ne refait rien : `main` pointe déjà sur le commit `release: vX.Y.Z`.
  Relancer via Actions → Release → Run workflow avec `tag` = `vX.Y.Z` (rejoue les builds et la publication, sans nouveau bump).
- Deux merges très rapprochés peuvent être livrés dans la même release : le second n'apparaît pas dans le changelog et ses labels
  `release:*` sont ignorés.
- Les PR venant de forks ne déclenchent pas de release ; leur commit est repris dans le changelog de la release suivante.

Réglages requis sur le dépôt :

- Secrets : `ANDROID_DEBUG_KEYSTORE_B64` (keystore de signature de l'APK, en base64) et `LASTSTREAM_UPDATE_SIGNING_KEY` (clé ed25519
  de signature de `latest.json`).
- APK Android : chaque release joint `android-latest.json` (versionCode, URL de l'APK de la release, SHA-256). Le Worker
  `laststream-edge` le relit sur `releases/latest/download/` et le sert sur `https://app.laststream.app/app/android/latest.json`
  (bouton « Télécharger l'APK » du site, mise à jour en un tap de l'app). Aucun secret supplémentaire.
- Settings → Actions → General → Workflow permissions : « Read and write permissions ».
- Si `main` est protégée, autoriser GitHub Actions à contourner la protection (bypass) : le workflow pousse le commit de release
  et le tag directement.

Pour Windows, le téléversement R2 et l'activation de l'auto-update restent manuels (`apps/desktop/upload.ps1`).
