# Laststream (application web)

Interface de Laststream identique au prototype d'accueil (`prototype-home`), portée en modules ES (Vite), avec **lastAddon** comme unique backend : catalogue TMDB, notes MDBList, saisons TVDB, IA, TV en direct et sources de lecture.

## Lancer

```bash
npm install
npm run dev        # serveur de développement sur http://localhost:8080
npm run build      # vérification des types, lint, puis build dans dist/
npm run preview    # sert dist/ sur http://localhost:8080 (écoute sur 0.0.0.0)
npm test           # vitest : couche données/transport + test de fumée de l'interface (jsdom)
                   # LASTADDON_USER_TEST_URL=http://localhost:7099 npm test : ajoute le test d'intégration de l'API utilisateur
                   # (serveur lastAddon isolé : LASTADDON_ALLOW_SIGNUP=1 LASTADDON_DATA_DIR=<tmp> PORT=7099)
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

### Comptes, profils et mode enfant

Au démarrage, `src/data/auth.ts` détecte l'API `/user` de lastAddon (`GET {base}/user/me`). Sans session : écran de connexion / création de compte (jeton d'amorçage facultatif pour le premier compte), avec « Continuer sans compte ». Avec session : choix du profil façon Netflix (avatars colorés, badge « Enfant », clavier PIN, « Gérer les profils »). Le jeton de profil (30 jours) part en `X-Profile-Token`. La bibliothèque locale rejoint le premier profil ouvert, une seule fois par compte ; les préférences (thème, région, lecture, sauts) suivent le profil via `/settings`. L'import Stremio est dans Réglages.

Profil enfant : accueil et « Tout voir » dédiés (`src/ui/kids.js`) alimentés par `discover` avec `certification_country` (région), `certification.lte` (âge du profil, table par pays dans `kid.ts`) et les genres jeunesse (Animation, Famille, Kids) ; héros jeunesse avec bande-annonce ; recherche et personnalités limitées aux genres jeunesse ; rubriques activables par le parent dans « Gérer les profils » (TV jeunesse désactivée par défaut). Ces paramètres TMDB (`certification_country`, `certification.lte`, `with_companies`) doivent être dans la liste blanche du proxy lastAddon ; sinon le contrôle titre par titre ci-dessous reste le filet de sécurité. Pas de Réglages, pas d'IA ; chaque tuile est vérifiée avec la classification TMDB de la région (`src/data/kid.ts`) et retirée si elle dépasse l'âge du profil ou si elle est inconnue ; quitter le profil demande le PIN d'un profil adulte. Si le serveur est absent ou injoignable, l'adaptateur local (localStorage) prend le relais.

### Données utilisateur

Toute lecture et écriture de la bibliothèque, de la progression, de « Reprendre la lecture » et des épisodes vus passe par `src/data/userStore.ts`. Deux adaptateurs : `LocalUserStore` (localStorage, repli hors ligne) et `ServerUserStore` (API utilisateur de lastAddon, cache hydraté à l'ouverture du profil, écritures optimistes), installé par `auth.ts` avec `setUserStore()`. Le « vu » par épisode reste local.

### Accueil, suivis et notes

- **Accueil long** : après les rangées fixes (carrousel des tendances, Reprendre, suivis de la semaine, IA, Top 10, Prochainement, En direct), les rangées viennent du registre `src/data/rows.ts` (plus de 45 adultes, 20 enfants), chargées à la demande (`src/ui/registry.js`), avec au plus deux apparitions par titre, un minimum de 8 titres et « Tout voir » paginé (`#/browse/:id`). Les rangées qui exigent des paramètres TMDB hors liste blanche (`with_keywords`, `with_companies`, `vote_average.gte`…) n'apparaissent que si lastAddon les applique (sonde automatique).
- **IA** : une liste de 50 titres par jour et par profil (réglages du profil `aiRecs*`, repli local), exclusions = vus + bibliothèque + notés ; la raison n'apparaît que dans l'aperçu au survol.
- **Vu**, **Suivre** (films, séries, personnes), **notes** par demi-étoile, **calendrier** (`#/calendar`), badge « +N » : les routes serveur correspondantes (`/watched`, `/follows`, `/ratings`, `DELETE /continue`) sont optionnelles ; sur une 404 l'application garde l'état en local. Toute modification est affichée tout de suite et annulée si le serveur la refuse.
- **Menu contextuel** unifié : clic droit, appui long, bouton « … », Maj+F10.

### TV en direct

Catalogue Free-TV / iptv-org via `/lt/tv/channels` (pays, langue, catégorie, source, recherche, pagination) et `/lt/tv/facets` pour les compteurs ; filtres par défaut : pays de la région, français, chaînes fiables. Tolérant : un ancien serveur (liste complète sans champs étendus) fonctionne, filtré côté client. Si un flux échoue, les `alternatives` de la chaîne sont essayées avant « Cette chaîne ne répond pas ». Les playlists HLS ne passent jamais par le cache JSON (hls.js les lit directement, avec reprise sur erreur réseau ou média).

### Lecture

Le bouton « Lecture » ouvre le tiroir **Sources** : `GET {base}/{config}/stream/{movie|series}/{id}.json` (id IMDb obtenu par `external_ids` TMDB ; épisode : `tt:saison:épisode`), triées par `laststream.score` et groupées par qualité (langue, taille, débit, cache, copies). Un clic ouvre l'URL dans un lecteur `<video>` plein écran basique, qui enregistre la progression. Les torrents sans lien direct ne sont pas lisibles. Le lecteur complet (sous-titres, pistes audio, saut d'intro, lecture automatique) est à venir.
