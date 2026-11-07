# guides-capture : captures headless des guides de Laststream

Ce dossier produit les captures (WebP 2560x1600, poster 1280x800, clip MP4 H.264 sans audio) des guides du site,
dans `out/`. Tout est local : navigateur Playwright toujours headless, données fictives, aucune ressource de production
touchée. Chaque script refuse une adresse non locale et bloque toute requête vers un autre hôte que localhost (les
hôtes externes apparaissent dans son rapport, « hôtes bloqués », sans être appelés).

## Scripts disponibles

| Script | Produit (dans `out/`) | API lastAddon lancée par le script |
| --- | --- | --- |
| `smoke.mjs` | `smoke-qui-regarde.png`, `smoke.webm` | non (API lancée à la main, voir plus bas) |
| `capture-source.mjs` | `ajouter-une-source/` (4 images, poster, clip) | port 7001, addon d'exemple port 7101 |
| `capture-profils.mjs` | `creer-un-profil/` et `profil-enfant/` (images, poster, clip) | port de `CAPTURE_API_URL` (7000 par défaut) |
| `capture-tv.mjs` | `tv-en-direct/` (4 images, poster, clip) | port 7002 (`CAPTURE_TV_API_URL`), TV d'exemple port 7102 |

`mock-catalog.mjs` fournit le catalogue factice (titres inventés, affiches du site) servi dans le navigateur de test.
Il est lu par les trois scripts de capture. Règle : fantasy, horreur, noir et western sont classés 16+ ; les titres
visibles par un enfant de 12 ans ont une affiche famille, anime ou ocean. `capture-source.mjs` s'appuie sur le film
« Les Gardiens du phare » (`tt9001001`) : ne pas retirer cet identifiant.

Les scripts de capture repartent d'un stockage neuf (dossiers `.capture-data*/`, ignorés par git) et ne tournent pas en
parallèle : lance-les un par un.

## Ports et variables

| Service | Adresse par défaut | Variable pour la changer |
| --- | --- | --- |
| App Laststream (Vite) | `http://localhost:8080` | `CAPTURE_APP_URL` (captures) ; `SMOKE_APP_URL` (smoke) |
| API lastAddon de `capture-source.mjs` | `http://localhost:7001` | `CAPTURE_API_URL` |
| API lastAddon de `capture-profils.mjs` | `http://localhost:7000` | `CAPTURE_API_URL` |
| API lastAddon de `capture-tv.mjs` | `http://localhost:7002` | `CAPTURE_TV_API_URL` |
| API lastAddon du smoke test | `http://localhost:7000` | `SMOKE_API_URL` |
| Addon d'exemple (`example-addon/`) | `http://localhost:7101` | `EXAMPLE_ADDON_PORT` |
| TV d'exemple (`example-tv/`) | `http://localhost:7102` | fixe (`EXAMPLE_PORT`) |

Le port 7000 est souvent pris par l'API du smoke test : pour `capture-profils.mjs`, passe alors
`CAPTURE_API_URL=http://localhost:7003`. Ne pointe jamais une capture sur `lastaddon\data`.

`CAPTURE_APP_URL` doit désigner l'origine où tourne l'app (exemple : `http://localhost:8092`). Les scripts ajoutent
cette origine à `LASTADDON_ALLOWED_ORIGINS` de l'API qu'ils lancent, sinon le navigateur bloque les appels CORS.
Les origines `http://localhost:8080` et `http://localhost:8089` restent autorisées.

Serveurs d'exemple : `example-addon/server.mjs` (manifest, logo, flux factices) et `example-tv/server.mjs` (playlist M3U
et guide XMLTV fictifs). Ils sont démarrés et arrêtés par les scripts ; `node example-addon/server.mjs` ou
`node example-tv/server.mjs` les lancent seuls pour un test manuel.

## Lancer une capture

Prérequis : `npm install` dans `laststream-app` (Playwright y est en devDependency). Si le navigateur manque :
`npx playwright install chromium` dans `laststream-app`. ffmpeg doit être dans le PATH.

```powershell
# 1. App Laststream sur un port dédié (le Vite du port 8080 peut rester tel quel)
cd C:\Users\grego\Projets\laststream\laststream-app
npx vite --port 8092 --strictPort

# 2. Captures, une à une
cd C:\Users\grego\Projets\laststream\laststream-site\guides-capture
$env:CAPTURE_APP_URL = "http://localhost:8092"
node capture-source.mjs
$env:CAPTURE_API_URL = "http://localhost:7003"; node capture-profils.mjs; Remove-Item Env:CAPTURE_API_URL
node capture-tv.mjs
```

`capture-profils.mjs` est parfois instable au formulaire enfant (environ une fois sur deux) : relance-le jusqu'à 3 fois
si besoin. Il réécrit aussi `out/creer-un-profil/`, ce qui est voulu.

Les captures sont refaites à chaque passage : ne retouche pas `out/` à la main.

## Smoke test (historique)

`smoke.mjs` ouvre l'app, la connecte à une API lastAddon locale, se connecte avec un compte de test et enregistre
`out/smoke-qui-regarde.png` (1280x800) et `out/smoke.webm`.

```powershell
# 1. API lastAddon locale, sur un stockage vierge
Remove-Item -Recurse -Force "C:\Users\grego\Projets\laststream\laststream-site\guides-capture\.smoke-data" -ErrorAction SilentlyContinue
cd C:\Users\grego\Projets\laststream\lastaddon
$env:PORT = "7000"
$env:LASTADDON_DATA_DIR = "C:\Users\grego\Projets\laststream\laststream-site\guides-capture\.smoke-data"
npm run dev

# 2. App Laststream (Vite, http://localhost:8080)
cd C:\Users\grego\Projets\laststream\laststream-app
npm run dev

# 3. Smoke test
cd C:\Users\grego\Projets\laststream\laststream-site\guides-capture
node smoke.mjs
```

Le premier compte d'un stockage vierge s'inscrit sans lien d'invitation ; le script le crée au premier passage. Pour
repartir de zéro, arrête l'API, relance la commande 1 (elle vide `.smoke-data`), puis relance le script.

Pour changer le compte de test, supprime `.env.test` et `.smoke-data`, puis relance les commandes 1 et 3. Arrêt :
`Ctrl+C` dans les terminaux 1 et 2.

## Comment l'app est pointée vers l'API locale

L'app ne lit aucune variable d'environnement Vite pour son adresse d'API. Elle lit son réglage serveur dans le
`localStorage` (clé `laststream.lastaddon`, voir `src/data/config.ts`). Les scripts posent ce réglage (`base` = adresse
de l'API) dans le navigateur de test, via `addInitScript`. Le code de l'app n'est pas modifié, aucun `.env.local` n'est
créé.

## Fichiers

- `.env.test` : identifiants de test, générés au premier lancement (valeurs jamais affichées). Ignoré par git.
- `.smoke-data/`, `.capture-data*/` : bases SQLite des API locales. Ignorés par git.
- `out/` : captures et vidéos. Ignoré par git.
