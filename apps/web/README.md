# Laststream (application web)

Interface de Laststream identique au prototype d'accueil (`prototype-home`), portée en modules ES (Vite), avec **lastAddon** comme unique backend : catalogue TMDB, notes MDBList, saisons TVDB, IA, TV en direct et sources de lecture.

## Lancer

```bash
npm install
npm run dev        # serveur de développement sur http://localhost:8080
npm run build      # vérification des types, lint, puis build dans dist/
npm run preview    # sert dist/ sur http://localhost:8080 (écoute sur 0.0.0.0)
npm test           # vitest : couche données/transport + test de fumée de l'interface (jsdom)
```

Prérequis : Node 20 ou plus, et un lastAddon joignable (par défaut `http://localhost:7000`).

## Configuration

Au premier lancement, ouvre **Réglages** (clic sur l'avatar, ou `#/settings`) :

- **Adresse du serveur** et clés des services (TMDB, MDBList, TVDB, OpenRouter…), langues, résolutions, tailles, sources (addon amont, Torznab), AllDebrid. Les formulaires suivent `GET {base}/config/schema` ; les clés déjà enregistrées s'affichent en masque (`POST /config/decode`) et un champ vide les conserve ; l'enregistrement passe par `POST /config/encode` avec `previous`. Les boutons « Tester » appellent `POST /config/test`.
- **Lecture** : lecture automatique, débit (automatique ou fixé, « Tester ma connexion »), saut d'intro / récap, épisode suivant.
- **Apparence** : thème Laststream (corail, par défaut), Stremio, Teal, Amber ou couleur personnalisée.
- **Région** : France par défaut ; Suisse, Belgique, Canada, Luxembourg. Elle pilote `region`, `watch_region` et la classification par âge.

La configuration chiffrée est stockée dans `localStorage['laststream.lastaddon'] = {base, config}`, la même clé que l'application précédente (même origine) : une configuration existante est reprise telle quelle. Autres clés conservées : `laststream.autoplay`, `laststream.bandwidth.setting`, `laststream.bandwidth.measured`, `laststream.skip.*`, `laststream.theme` (`{id, accent}`), `laststream.library`.

## Architecture

```
index.html              coque (conteneurs #app, #detail, modale, lecteur TV, lecteur vidéo)
src/main.js             démarrage : thème, route initiale, accueil
src/styles/             styles.css (feuille du prototype, inchangée sauf l'accent en variable) + app.css (réglages, sources, lecteur)
src/data/               couche données et transport (TypeScript, testée)
  config.ts             {base, config} dans localStorage, construction des URL {base}/{config}/lt/…
  transport.ts          cache client (mémoire + sessionStorage), requêtes partagées, 6 requêtes en vol max, retry 429
  lt.ts                 client des routes lt : tmdb, mdblist, tvdb, recommend, why, person-why, tv/*, skip
  configApi.ts          /config/schema, /decode, /encode, /test
  sources.ts, stream.ts streams lastAddon : tri par score, groupes de qualité, débit, choix auto
  userStore.ts          interface UserStore (bibliothèque, progression, vus, profils) + adaptateur localStorage
  prefs.ts, theme.ts    préférences (région, lecture, sauts) et thèmes
src/ui/                 interface (JavaScript, DOM par gabarits de chaînes comme le prototype)
  router.js, home.js, fiche.js (+ ficheModel, ficheSections, providers, heroVideo), person.js, services.js,
  library.js, tv.js + player.js (TV en direct, hls.js), tiles.js / rows.js / ratings.js (tuiles, rangées),
  preview.js + hover.js (aperçus vidéo), ctxmenu.js, modal.js, sources-ui.js (tiroir Sources + lecteur),
  settings.js, events.js (délégation des clics et du clavier)
tools/port-prototype.mjs  script ponctuel ayant découpé app.js du prototype en modules (historique)
tests/                  vitest
```

### Données utilisateur

Toute lecture et écriture de la bibliothèque, de la progression, de « Reprendre la lecture » et des épisodes vus passe par `src/data/userStore.ts`. L'implémentation actuelle est locale. **TODO** : écrire un adaptateur pour l'API utilisateur de lastAddon (comptes, profils, bibliothèque, progression, import Stremio) et l'installer avec `setUserStore(adapter)` au démarrage.

### Lecture

Le bouton « Lecture » ouvre le tiroir **Sources** : `GET {base}/{config}/stream/{movie|series}/{id}.json` (id IMDb obtenu par `external_ids` TMDB ; épisode : `tt:saison:épisode`), triées par `laststream.score` et groupées par qualité (langue, taille, débit, cache, copies). Un clic ouvre l'URL dans un lecteur `<video>` plein écran basique, qui enregistre la progression. Les torrents sans lien direct ne sont pas lisibles. Le lecteur complet (sous-titres, pistes audio, saut d'intro, lecture automatique) est à venir.
