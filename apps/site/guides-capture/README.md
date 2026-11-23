# guides-capture : captures headless des guides de Laststream

Ce dossier produit les captures (WebP 2560x1600, poster 1280x800, clip MP4 H.264 sans audio) des guides du site,
dans `out/`. Tout est local : navigateur Playwright toujours headless, données fictives, aucune ressource de production
touchée. Chaque script refuse une adresse non locale et bloque toute requête vers un autre hôte que localhost (les
hôtes externes apparaissent dans son rapport, « hôtes bloqués », sans être appelés).

## Scripts disponibles

| Script | Produit |
| --- | --- |
| `capture-guides.mjs` | captures annotées des 12 guides, en français et en anglais (`out/guides/<lang>/<guide>/`) |
| `build-guides.mjs` | pages HTML des guides FR (`public/guides/`) et EN (`public/en/guides/`), d'après `guides-content.mjs` |
| `capture-site.mjs` | `site/` : captures de la page d'accueil du site (`public/assets/shots`) |
| `smoke.mjs` | `smoke-qui-regarde.png`, `smoke.webm` (historique) |

## Guides illustrés (`capture-guides.mjs`, `build-guides.mjs`)

Chaque guide est rejoué dans l'app, pour chaque langue, sur un stockage neuf : le script lance l'API lastAddon locale
(`services/core`, port 7004 par défaut, `CAPTURE_API_PORT`), crée un compte jetable, l'addon d'exemple (port 7101) et la
TV d'exemple (port 7102). Le catalogue est celui de `mock-catalog.mjs` (titres inventés, jaquettes générées par IA) :
aucune affiche réelle.

Les guides qui ont besoin des fonctions sociales (amis, watch party, billets, bibliothèque partagée, import) tournent sur
le Worker de l'API (`backend: 'worker'` dans `GUIDES`) : `wrangler dev --local`, avec Durable Objects et stockage jetable
(le serveur Node n'a pas de watch party). Les guides à deux (amis, watch party) créent un second compte « Léo » dans un
autre contexte du même navigateur (`secondAccount`). Le guide d'import (`stremio: true`) répond à la place de
`api.strem.io` avec un faux compte Stremio (`STREMIO_LIBRARY`) : aucun appel à Stremio.

Les captures sont prises sans annotation (la vidéo `clip.mp4` reste propre), puis annotées : cadre jaune autour de
l'endroit où cliquer, pastille numérotée et bulle de texte dans la langue du guide. Les zones et les textes des bulles
sont décrits dans les scénarios du script (`snap(s, nom, [{ loc, label: L(fr, en), n, place }])`).

L'app n'existe qu'en français : pour l'anglais, `i18n-en.mjs` traduit l'interface à l'affichage, dans le navigateur de
test seulement. Le script liste en fin de rapport les textes visibles restés en français (« NON TRADUIT ») : ajoute-les
à `i18n-en.mjs` s'ils font partie de l'interface (les titres du catalogue factice restent en français).

```bash
cd services/core && npm ci                       # une fois (API locale)
cd apps/web && npm ci && npx vite --port 8093 --strictPort   # terminal 1
cd apps/site/guides-capture
CAPTURE_APP_URL=http://localhost:8093 node capture-guides.mjs              # tous les guides, FR et EN
node capture-guides.mjs profil-enfant --lang en                            # un guide, une langue
node capture-guides.mjs --install      # après relecture de out/guides : copie dans public/
node build-guides.mjs                  # régénère les pages (texte : guides-content.mjs)
```

Les pages `public/guides/<guide>/index.html` et `public/en/guides/<slug>/index.html` sont générées : modifie
`guides-content.mjs` (texte) ou `build-guides.mjs` (gabarit), pas le HTML. Le sommaire français
`public/guides/index.html` reste écrit à la main.
`CAPTURE_PLAYWRIGHT` désigne un autre paquet playwright que celui de `apps/web` (par exemple un paquet installé avec ses
navigateurs). ffmpeg doit être dans le PATH.

## Captures de la page d'accueil (`capture-site.mjs`)

Ouvre l'app en mode démo (`?demo=1&clean=1`, profils Alex et Léo), sans compte ni API : la config publique, le
catalogue et les images sont servis par le script (catalogue factice ci-dessus, sans bande-annonce sauf pour l'accueil
enfant, qui n'en met pas d'autre en avant). Seules les polices Google Fonts sont chargées de l'extérieur.

```bash
cd apps/web && npx vite --port 8093 --strictPort      # terminal 1
cd apps/site/guides-capture && CAPTURE_APP_URL=http://localhost:8093 node capture-site.mjs   # terminal 2
```

Produit `out/site/<nom>.webp` (2400x1500, ou 1170x2532 pour `mobile-*`) avec ses variantes `-1200` et `-600`. Relis-les,
puis copie celles à remplacer dans `public/assets/shots/`. `settings` n'affiche aucune affiche : inutile de la remplacer.
Si le Chromium de Playwright manque, `CAPTURE_CHROMIUM` désigne un autre exécutable.

`mock-catalog.mjs` fournit le catalogue factice servi dans le navigateur de test : titres inventés, avec pour chacun une
jaquette (`posters/titres/<id>.webp`) et, pour les titres mis en avant, un fond large (`posters/fonds/<id>.webp`). Ces
images sont générées par IA (OpenRouter, modèle `meta/muse-image`) d'après le titre et le synopsis du catalogue : aucune
affiche ni photo de film réel, donc aucun problème de droits. Un titre sans image propre retombe sur l'image de son thème
(`posters/<thème>-800.webp`). Pour ajouter un titre, génère sa jaquette en 2:3 avec le titre écrit dessus et enregistre-la
en WebP 600x900 sous son identifiant.
Il est lu par `capture-site.mjs` et `capture-guides.mjs`. Règle : fantasy, horreur, noir et western sont classés 16+ ; les titres
visibles par un enfant de 12 ans ont une affiche famille, anime ou ocean. `capture-guides.mjs` s’appuie sur le film
« Les Gardiens du phare » (`tt9001001`) : ne pas retirer cet identifiant.

Les scripts de capture repartent d'un stockage neuf (dossiers `.capture-data*/`, ignorés par git) et ne tournent pas en
parallèle : lance-les un par un.

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
