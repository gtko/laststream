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

- **Adresse du serveur** et clés des services (TMDB, MDBList, TVDB, OpenRouter…), langues, résolutions, tailles, sources (addons Stremio, qui débrident eux-mêmes), débrideurs facultatifs dans « Avancé ». Les formulaires suivent `GET {base}/config/schema` ; les clés déjà enregistrées s'affichent en masque (`POST /config/decode`) et un champ vide les conserve ; l'enregistrement passe par `POST /config/encode` avec `previous`. Les boutons « Tester » appellent `POST /config/test`.
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
tests/                  vitest
```

### Comptes, profils et mode enfant

Au démarrage, `src/data/auth.ts` détecte l'API `/user` de lastAddon (`GET {base}/user/me`). Sans session : écran de connexion / création de compte (jeton d'amorçage facultatif pour le premier compte). La connexion est obligatoire : sans serveur joignable, l'écran de connexion le signale. Avec session : choix du profil façon Netflix (avatars colorés, badge « Enfant », clavier PIN, « Gérer les profils »). Le jeton de profil (30 jours) part en `X-Profile-Token`. La bibliothèque locale rejoint le premier profil ouvert, une seule fois par compte ; les préférences (thème, région, lecture, sauts) suivent le profil via `/settings`. L'import depuis Stremio, Nuvio, Simkl et Plex est dans Réglages (voir « Migration »).

Profil enfant : accueil et « Tout voir » dédiés (`src/ui/kids.js`) alimentés par `discover` avec `certification_country` (région), `certification.lte` (âge du profil, table par pays dans `kid.ts`) et les genres jeunesse (Animation, Famille, Kids) ; héros jeunesse avec bande-annonce ; recherche et personnalités limitées aux genres jeunesse ; rubriques activables par le parent dans « Gérer les profils » (TV jeunesse désactivée par défaut). Ces paramètres TMDB (`certification_country`, `certification.lte`, `with_companies`) doivent être dans la liste blanche du proxy lastAddon ; sinon le contrôle titre par titre ci-dessous reste le filet de sécurité. Pas de Réglages, pas d'IA ; chaque tuile est vérifiée avec la classification TMDB de la région (`src/data/kid.ts`) et retirée si elle dépasse l'âge du profil ou si elle est inconnue ; quitter le profil demande le PIN d'un profil adulte. Si le serveur est absent ou injoignable, l'adaptateur local (localStorage) prend le relais.

### Données utilisateur

Toute lecture et écriture de la bibliothèque, de la progression, de « Reprendre la lecture » et des épisodes vus passe par `src/data/userStore.ts`. Deux adaptateurs : `LocalUserStore` (localStorage, repli hors ligne) et `ServerUserStore` (API utilisateur de lastAddon, cache hydraté à l'ouverture du profil, écritures optimistes), installé par `auth.ts` avec `setUserStore()`. Le « vu » par épisode reste local.

### Migration depuis Stremio, Nuvio, Simkl et Plex

Carte « Importer depuis une autre app » (Réglages > Compte, `src/ui/migration.js`), couche données dans `src/data/migration/` :

- **Sources** : compte Stremio (lu depuis l'appareil sur `api.strem.io`, routes de lecture seulement, session fermée aussitôt : les identifiants ne passent jamais par lastAddon), fichier d'export Stremio, sauvegarde Nuvio, export Simkl (JSON ou CSV), historique d'un serveur Plex (autorisation par code PIN plex.tv, jeton gardé en mémoire). Les fichiers sont lus sur l'appareil, sans envoi réseau.
- **Aperçu** avant toute écriture : catégories à cocher (bibliothèque, « À voir », favoris, vus, progression) ; pas d'import silencieux. Avant la saisie Stremio, un avertissement explique que le compte Stremio n'est jamais modifié.
- **Écriture** (`runner.ts`) : un élément à la fois, titres résolus sur TMDB (`find` IMDb ou TVDB), routes idempotentes ; journal par profil dans `localStorage['laststream.migration.job:<profil>']`. Une coupure réseau met l'import en pause ; il reprend (bouton ou retour du réseau) sans doublon. Épisodes vus Stremio : champ « watched » décodé avec la liste d'épisodes Cinemeta. Les favoris et la liste à voir deviennent des listes Laststream modifiables (« À voir · Stremio »…), ou la bibliothèque sans compte.
- **Rapport** : réussis, ignorés, échoués, et la raison de chacun ; copiable ou téléchargeable.
- **Marques du profil** (`profileMarks.ts`) : catégorie « anime » de Simkl et Nuvio (filtre « Anime » de la bibliothèque et de « Vus ») et date réelle des visionnages importés.
- **Addons** (`addons.ts`) : étape séparée, désactivée par défaut, rien de coché d'avance ; jamais dans les versions App Store et Google Play (`src/data/distribution.ts` : `VITE_DISTRIBUTION=play|appstore`, `LaststreamStore/<canal>` dans l'agent utilisateur de la coque, ou iOS natif). Les addons choisis rejoignent le registre local des catalogues (marqués `imported`, jamais envoyés au serveur) ; journal lisible par addon.

### Chromecast

Bouton « Caster » du lecteur (navigateurs Chromium, hors coque Windows et app Android) : SDK Google Cast chargé à la demande (`src/player/cast.ts`), récepteur par défaut, lecture reprise sur le téléviseur à la position exacte de l'appareil ; la progression continue de s'écrire pendant la diffusion, « Reprendre ici » revient à la position du téléviseur. Les sources injoignables par le Chromecast (adresse locale, serveur de lecture de l'appareil, fichier téléchargé) sont refusées avec un message (`src/player/castLogic.ts`).

### Accueil, suivis et notes

- **Accueil long** : après les rangées fixes (carrousel des tendances, Reprendre, suivis de la semaine, IA, Top 10, Prochainement, En direct), les rangées viennent du registre `src/data/rows.ts` (plus de 45 adultes, 20 enfants), chargées à la demande (`src/ui/registry.js`), avec au plus deux apparitions par titre, un minimum de 8 titres et « Tout voir » paginé (`#/browse/:id`). Les rangées qui exigent des paramètres TMDB hors liste blanche (`with_keywords`, `with_companies`, `vote_average.gte`…) n'apparaissent que si lastAddon les applique (sonde automatique).
- **IA** : une liste de 50 titres par jour et par profil (réglages du profil `aiRecs*`, repli local), exclusions = vus + bibliothèque + notés ; la raison n'apparaît que dans l'aperçu au survol.
- **Vu**, **Suivre** (films, séries, personnes), **notes** par demi-étoile, **calendrier** (`#/calendar`), badge « +N » : les routes serveur correspondantes (`/watched`, `/follows`, `/ratings`, `DELETE /continue`) sont optionnelles ; sur une 404 l'application garde l'état en local. Toute modification est affichée tout de suite et annulée si le serveur la refuse.
- **Menu contextuel** unifié : clic droit, appui long, bouton « … », Maj+F10.

### Séries : numérotation canonique et listes infinies

- La fiche d'une série lit `GET {base}/{config}/lt/series/:tmdbId/episodes?language=…` (saisons et épisodes dans l'ordre diffusé de TheTVDB ou d'un groupe TMDB, numéros absolus, visuels rattachés). Sélecteur de saison, compteur « nouveaux épisodes », prochain épisode, clés « vu » et progression, Reprendre et identifiants de flux `tt:saison:épisode` suivent cette numérotation ; sur une 404, repli sur les saisons TMDB (`src/data/series.ts`, `src/ui/seasons.js`).
- Les grilles paginées (Tout voir, bibliothèque, filmographie, chaînes TV, recherche) chargent la page suivante avant la fin (`src/ui/infinite.js`), mémorisent leur contenu pour le retour en arrière et gardent un lien « Charger plus » au clavier.

### TV en direct

Catalogue Free-TV / iptv-org via `/lt/tv/channels` (pays, langue, catégorie, source, recherche, pagination) et `/lt/tv/facets` pour les compteurs ; filtres par défaut : pays de la région, français, chaînes fiables. Tolérant : un ancien serveur (liste complète sans champs étendus) fonctionne, filtré côté client. Si un flux échoue, les `alternatives` de la chaîne sont essayées avant « Cette chaîne ne répond pas ». Les playlists HLS ne passent jamais par le cache JSON (hls.js les lit directement, avec reprise sur erreur réseau ou média).

### Lecture

Le bouton « Lecture » ouvre le tiroir **Sources** : `GET {base}/{config}/stream/{movie|series}/{id}.json` (id IMDb obtenu par `external_ids` TMDB ; épisode : `tt:saison:épisode`), triées par `laststream.score` et groupées par qualité (langue, taille, débit, cache, copies). Un clic ouvre l'URL dans un lecteur `<video>` plein écran basique, qui enregistre la progression. Les torrents sans lien direct ne sont pas lisibles. Le lecteur complet (sous-titres, pistes audio, saut d'intro, lecture automatique) est à venir.

## Application Android : interface distante, mise à jour en un tap, mini-lecteur

- **Interface chargée depuis le serveur** : `capacitor.config.json` (`server.url` = `PUBLIC_BASE` de `src/data/config.ts`, un test vérifie l'égalité, ainsi que `androidScheme: https` et `allowNavigation` limité à ce domaine). Le pont Capacitor (LaststreamPlayer, CapacitorHttp, LaststreamUpdate…) est injecté sur l'origine du serveur (script de début de document restreint à l'origine de `server.url`) : `Capacitor.isNativePlatform()` reste vrai. Si le serveur ne répond pas au démarrage, `public/offline.html` (embarquée dans l'APK) s'affiche avec « Réessayer ». Les appels à un serveur perso d'une autre origine (PC en http) partent du code natif (`src/data/crossFetch.ts`), sans contenu mixte ni CORS. Le `localStorage` change d'origine (`http://localhost` devient le domaine du serveur) : pas de migration, reconnexion simple (la configuration, la bibliothèque et les préférences suivent le compte).
- **Mise à jour en un tap** : le build donne un `versionCode` AAAAMMJJNN (compteur du jour dans `android/app/version-counter.properties`, non versionné, incrémenté à chaque `assemble*`). `node scripts/publish-android.mjs` lit `output-metadata.json`, calcule le SHA-256 et écrit `public/app/android/latest.json` ({versionCode, versionName, url, sha256, size, notes}) ; l'APK (≈ 50 Mo, au-delà des 25 Mo par fichier des Workers Assets) est copiée dans `../dist/laststream-android/publish/laststream-<versionCode>.apk` pour être servie à l'adresse `url` (R2 public derrière le Worker). L'application compare le versionCode au lancement puis toutes les 24 h, affiche « Mise à jour disponible (vX) — Installer », télécharge en https, vérifie le SHA-256, puis ouvre l'installeur système (autorisation « sources inconnues » guidée).
- **Signature** : toutes les APK (debug et release) sont signées avec la clé de debug de ce PC (`~/.android/debug.keystore`) : Android n'accepte une mise à jour que signée par la même clé, il faut donc toujours builder depuis ce PC ou copier cette clé. Perdre la clé impose de désinstaller l'application avant d'installer la nouvelle.
- **Mini-lecteur natif** : bouton Réduire, geste vers le bas ou retour Android pendant la lecture ; la vidéo continue dans une vignette flottante au-dessus de l'interface (`PlaybackCore`, `MiniPlayer`).
