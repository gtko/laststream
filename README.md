# Laststream

Mono-repo de Laststream : applications, services Cloudflare et contrat partagé. Chaque dossier garde ses propres
`package.json`, tests et README ; l'historique de chaque ancien dépôt est conservé (tags préfixés par projet).

| Dossier | Contenu | Ancien dépôt | Mise en production |
| --- | --- | --- | --- |
| `apps/web` | Interface (Vite) | `gtko/laststream-app` | servie par lastaddon-core (voir `services/core`) |
| `apps/mobile` | Application Android (Capacitor, interface chargée depuis le serveur) | `gtko/laststream-app` (`android/`) | APK publiée dans R2 (`apps/web/scripts/publish-android.mjs`) |
| `apps/desktop` | Application Windows (Rust, mpv) | `gtko/laststream-shell-ng` | tag `desktop-vX.Y.Z` + workflow « Desktop release » |
| `apps/site` | Site vitrine www.laststream.app | `gtko/laststream-site` | Workers Builds (laststream-www, dossier racine `apps/site`) |
| `services/core` | Worker lastaddon-core : API, salons, sert `apps/web` | `gtko/lastaddon` | tag `core-vX.Y.Z` → workflow « Core deploy » |
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
