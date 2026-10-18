# lastAddon

Addon Stremio agrégateur de streams pour Laststream. Il interroge en parallèle plusieurs sources (addons Stremio amont, indexeurs Torznab, Prowlarr et Jackett), filtre les résultats selon les préférences de l'utilisateur (langues, résolutions, qualités, tailles, débit, formats audio, limite d'âge), regroupe les copies d'une même release, les classe, puis les renvoie à Stremio. Avec AllDebrid, il indique quels torrents sont déjà en cache, débride la lecture à la demande en passant à la copie suivante en cas d'échec, et peut proposer les liens d'hébergeurs débridés.

## Prérequis

- Node.js **22 ou plus récent**
- npm

## Installation

```bash
npm install
```

## Lancement

Développement (rechargement automatique) :

```bash
npm run dev
```

Production :

```bash
npm run build
npm start
```

Le serveur écoute sur le port `PORT` (défaut `7000`). Vérification rapide :

```bash
curl http://localhost:7000/health
# {"ok":true}
```

## Scripts

| Script | Rôle |
| --- | --- |
| `npm run dev` | Serveur en mode développement (`tsx watch`) |
| `npm run build` | Compilation TypeScript vers `dist/` |
| `npm start` | Lance `dist/server.js` |
| `npm test` | Tests unitaires et d'intégration (vitest) |
| `npm run lint` | ESLint (configuration flat, typescript-eslint) |
| `npm run typecheck` | Vérification des types de `src/` et `tests/` |

## Variables d'environnement

Les variables peuvent être passées dans l'environnement ou dans un fichier `.env` à la racine du projet (lu automatiquement, sans dépendance `dotenv`). Un modèle est fourni dans `.env.example`.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LASTADDON_SECRET` | généré | Clé de chiffrement des configurations (AES-256-GCM). **Au moins 32 caractères** : sinon le serveur refuse de démarrer. Si elle est absente, 32 octets aléatoires (base64url) sont générés au premier démarrage et enregistrés dans `.env` à la racine du projet. Elle sert aussi à signer les jetons de lecture `/play/c`. |
| `LASTADDON_ALLOW_PLAIN` | `0` | Mettre `1` pour accepter les configurations en JSON brut encodé en base64url, sans chiffrement. Déconseillé. |
| `LASTADDON_PUBLIC_URL` | aucun | Base publique du serveur (ex. `https://addon.example.com`), utilisée pour construire les URL de lecture `/play`. Validée au démarrage : URL absolue en `http` ou `https` uniquement, sinon le serveur refuse de démarrer. Obligatoire si `LASTADDON_PUBLIC=1`. Sans elle, la base est le protocole et l'hôte de la requête (hors mode public). |
| `LASTADDON_TRUST_PROXY` | `0` | Mettre `1` seulement derrière un reverse proxy de confiance : `X-Forwarded-Proto` et `X-Forwarded-Host` servent alors à construire les liens de lecture. Sans cela, ces en-têtes sont ignorés. |
| `LASTADDON_PUBLIC` | `0` | Mettre `1` pour exposer le serveur sur Internet (mode public). Les URL saisies dans les sources (upstream, Torznab, Prowlarr, Jackett) ne peuvent plus pointer vers une adresse privée, de boucle locale ou de lien local (voir « Sécurité »). Exige `LASTADDON_PUBLIC_URL`. |
| `LASTADDON_FFMPEG` / `LASTADDON_FFPROBE` | PATH | Binaires de la détection locale des segments de saut (voir « Segments de saut détectés localement »). Sans eux : PATH, puis `bin/` à côté de l'application. `LASTADDON_SKIP_DETECT=0` désactive la détection. |
| `LASTADDON_ALLOWED_ORIGINS` | `http://localhost:8089,http://localhost:8080` | Origines (liste séparée par des virgules) autorisées en CORS sur les endpoints `/config/*` et `/user/*`. Les routes manifest et stream restent ouvertes (`*`). |
| `LASTADDON_DATA_DIR` | `./data` | Dossier de la base SQLite des données utilisateur (`laststream.db`). Relatif à la racine du projet. Voir « Données utilisateur ». |
| `LASTADDON_ALLOW_SIGNUP` | `0` | Mettre `1` pour ouvrir l'inscription sur `/user/register`. Sinon seul le premier compte peut être créé. |
| `LASTADDON_BOOTSTRAP_TOKEN` | aucun | Si défini, le premier compte exige l'en-tête `X-Bootstrap-Token` avec cette valeur. Voir « Données utilisateur ». |
| `LASTADDON_PROWLARR_AUTO` | `1` (`0` en mode public) | Détection d'un Prowlarr local. `0` la désactive. En mode public (`LASTADDON_PUBLIC=1`), elle n'est active que si `1` est défini explicitement. Sans effet si la configuration a des sources (voir « Prowlarr local »). |
| `LASTADDON_PROWLARR_URL` | `http://localhost:9696` | Base du Prowlarr local à interroger. Remplace l'adresse par défaut. |
| `LASTADDON_PROWLARR_KEY` | aucun | Clé API du Prowlarr local. Prioritaire sur le fichier de configuration. Lue une seule fois au démarrage, jamais renvoyée ni journalisée. |
| `LASTADDON_PROWLARR_CONFIG_PATH` | `C:\ProgramData\Prowlarr\config.xml` (Windows), `~/.config/Prowlarr/config.xml` (Linux) | Fichier `config.xml` de Prowlarr, dont la balise `<ApiKey>` sert de clé si `LASTADDON_PROWLARR_KEY` est absente. |
| `PORT` | `7000` | Port d'écoute HTTP. |

**Important :** si `LASTADDON_SECRET` change, toutes les configurations déjà chiffrées (et donc toutes les URL de manifest installées) deviennent invalides, ainsi que les liens `/play/c` déjà émis. Sauvegardez cette valeur. Ne la committez jamais : `.env` est dans `.gitignore`.

Les clés API (sources Torznab, Prowlarr, Jackett, debrid, services) sont contenues dans la configuration. Le serveur ne les journalise jamais, ne les renvoie jamais, et masque celles qui apparaîtraient dans un message d'erreur d'indexeur. La clé du Prowlarr local n'est pas dans la configuration : elle n'apparaît dans aucune réponse, ni dans `/config/*`, ni dans les erreurs.

### Prowlarr local

Détection automatique, sans rien saisir : si la configuration n'a aucune source, le serveur utilise un Prowlarr installé sur la même machine (par défaut `http://localhost:9696`). La clé API est lue dans `LASTADDON_PROWLARR_KEY`, sinon dans le `config.xml` de Prowlarr. L'instance est validée par un appel à `GET /api/v1/indexer` (délai 3 s), et le résultat est mis en cache 60 secondes. Les sources explicites ne sont jamais remplacées. Pour désactiver ce repli pour une configuration donnée, réglez « Utiliser le Prowlarr local détecté » sur faux (`autoProwlarr: false`).

`/config/schema` et `/config/test` indiquent la présence du Prowlarr local dans `localProwlarr` : `{"detected": true, "indexers": 12, "label": "Prowlarr local détecté (12 indexeurs)"}`, sans URL ni clé.

## Endpoints

| Méthode | Chemin | Description |
| --- | --- | --- |
| GET | `/health` | Santé du serveur : `{"ok":true}` |
| GET | `/manifest.json` | Manifest Stremio générique (non bloquant, sans configuration) |
| GET | `/:config/manifest.json` | Manifest Stremio pour une configuration chiffrée. Avec `services.tmdbToken`, annonce aussi des catalogues. |
| GET | `/:config/stream/:type/:id.json` | Liste de streams Stremio pour un film ou un épisode |
| GET | `/:config/play/c/:token` | Lecture d'un jeton de copies : essai des copies dans l'ordre (failover), `302` vers le premier lien résolu |
| GET | `/:config/play/:infoHash/:fileIdx?` | Lecture débridée d'un torrent (forme historique) : redirection `302` vers le lien AllDebrid |
| GET | `/config/schema` | JSON Schema de la configuration, plus la liste des préréglages (`presets`) |
| POST | `/config/encode` | Valide une configuration JSON et renvoie `{"config":"..."}` (chiffrée). Forme `{previous, config}` pour ne pas ressaisir les clés |
| POST | `/config/decode` | Déchiffre `{"config":"..."}` pour le configurateur : chaque secret est remplacé par `{"set":true,"last4":"…xxxx"}`, jamais par sa valeur |
| POST | `/config/test` | Teste chaque source, le compte AllDebrid et les services d'une configuration (JSON brut, non chiffré) |
| POST | `/config/indexers` | Liste les indexeurs d'une source Prowlarr ou Jackett (voir « Prowlarr et Jackett ») |

Les routes manifest et stream renvoient `Access-Control-Allow-Origin: *`, comme les lectures GET `lt` et catalogues. Les endpoints `/config/*` n'acceptent que les origines de `LASTADDON_ALLOWED_ORIGINS`. Les autres routes, dont `/play`, n'envoient aucun en-tête CORS.

### `GET /:config/stream/:type/:id.json`

- `:type` : `movie` ou `series`. Tout autre type renvoie `{"streams":[]}`.
- `:id` : `tt1234567` pour un film, `tt1234567:S:E` pour un épisode (Stremio encode les deux-points en `%3A`). Un identifiant hors de ce format renvoie `{"streams":[]}`.
- Réponse `200` : `{"streams":[...]}`, avec `Cache-Control: max-age=60`.
- Configuration illisible ou invalide : `400` `{"error":"invalid_config"}`, sans détail sur son contenu.
- Une source en erreur n'empêche jamais les autres de répondre : son erreur n'est pas renvoyée à Stremio.

### `GET /:config/play/c/:token`

Lecture d'un flux dont le jeton porte la liste ordonnée de ses copies (voir « Groupement des copies et lecture »). Le jeton est émis par le moteur ; il est signé, pas chiffré.

- Réponse `302` : `Location` pointe vers le lien résolu. Réponse jamais mise en cache (`Cache-Control: no-store`).
- Échec : une page HTML en français, ou un JSON `{"error":"play_failed","reason":"...","message":"..."}` si `Accept` demande du JSON. Le statut dépend de la raison (tableau ci-dessous).
- `400` `{"error":"invalid_token"}` si le jeton est malformé ou signé avec une autre clé ; `400` `{"error":"invalid_config"}` si la configuration est illisible.

### `GET /:config/play/:infoHash/:fileIdx?`

Forme historique, pour un torrent isolé. Paramètres optionnels `?s=S&e=E` pour un épisode (durée et sélection du fichier vidéo), `?filename=NOM&size=OCTETS` pour le nom et la taille attendus du fichier (ajoutés par le moteur avec un index de fichier). Le fichier est choisi par nom attendu, puis taille attendue, puis épisode, et l'index n'est retenu que si sa taille correspond. Réponses :

| Statut | Cas |
| --- | --- |
| `302` | Lien AllDebrid prêt : `Location` pointe vers le fichier débridé |
| `400` | Hash ou index de fichier invalide, ou configuration invalide |
| `404` | Configuration sans debrid |
| `503` | Torrent pas encore prêt chez AllDebrid (`Retry-After: 5`) |
| autre | Statut de la raison d'échec (voir tableau des raisons) |

Cette réponse n'est jamais mise en cache (`Cache-Control: no-store`).

### `POST /config/test`

Corps : une configuration JSON brute (non chiffrée). Chaque source, le compte AllDebrid et les services renseignés sont testés en parallèle.

```json
{
  "sources": [
    { "name": "Mon addon", "type": "upstream", "ok": true },
    { "name": "Indexeur", "type": "torznab", "ok": false, "error": "Source \"Indexeur\" : erreur Torznab : ..." },
    { "name": "AllDebrid", "type": "alldebrid", "ok": true }
  ],
  "services": [
    { "name": "TMDB (jeton v4)", "type": "tmdbToken", "ok": true }
  ]
}
```

`error` est absent quand `ok` vaut `true`. Une source désactivée (`"enabled": false`) n'est pas interrogée : elle est rapportée avec `"enabled": false`, `"ok": false` et `"error": "désactivée"`. Pour une source `upstream` qui répond, `manifest` donne les métadonnées publiques de l'addon (`name`, `logo`, `version`, `description`, `types`, `hasStream`), lues sur son manifest et gardées une heure. Ni l'URL ni le jeton de l'addon ne sont renvoyés, et un échec n'ajoute que le statut. Un corps invalide renvoie `400` `{"error":"invalid_config","issues":[...]}`, qui ne contient que des chemins et des messages, jamais les valeurs saisies.

### `POST /config/encode`

Corps : une configuration JSON, ou `{"previous":"<chaîne chiffrée>","config":{...}}`. Dans la seconde forme, chaque secret vide, absent ou masqué (`{"set":true}` ou `"…xxxx"`) garde la valeur de `previous`. Une section `services` absente garde tous ses secrets ; un objet `debrid` absent retire le debrid. Réponse : `{"config":"<chaîne chiffrée>"}`. Un corps invalide renvoie `400` avec la liste des chemins fautifs.

### `POST /config/decode`

Corps : `{"config":"<chaîne chiffrée>"}`. Réponse : la configuration déchiffrée, avec `services.*` (dont `tvdbPin`), `debrid.apiKey` et `sources[].apiKey` remplacés par leur masque. Jamais de valeur secrète, `Cache-Control: no-store`.

## Configuration

La configuration est un objet JSON. Tous les champs sont optionnels : les valeurs par défaut s'appliquent. Le JSON Schema complet est disponible sur `GET /config/schema`.

### Exemple

Fichier `config.json` (les clés sont des espaces réservés, à remplacer par vos valeurs) :

```json
{
  "languages": { "preferred": ["fr", "multi"], "acceptVostfr": true, "fallbackToOthers": true },
  "resolutions": { "allowed": ["2160p", "1080p", "720p"], "max": "1080p" },
  "excludedTags": ["CAM", "TS", "SCR"],
  "size": { "minGb": 0.5, "maxGb": 30, "perResolution": { "1080p": { "maxGb": 15 } } },
  "maxResults": 30,
  "sources": [
    { "type": "upstream", "name": "Mon addon", "url": "https://exemple.com/stream" },
    { "type": "torznab", "name": "Indexeur", "baseUrl": "https://indexeur.example.com/api", "apiKey": "VOTRE_CLE", "categories": [2000, 5000] },
    { "type": "prowlarr", "name": "Prowlarr", "baseUrl": "https://prowlarr.example.com", "apiKey": "VOTRE_CLE" },
    { "type": "jackett", "name": "Jackett", "baseUrl": "https://jackett.example.com", "apiKey": "VOTRE_CLE", "indexers": "all" }
  ],
  "debrid": { "service": "alldebrid", "apiKey": "VOTRE_CLE" },
  "onlyCached": false,
  "filters": {
    "ageLimit": 12,
    "hideUnreleased": true,
    "qualities": ["REMUX", "BluRay", "WEB-DL", "WEBRip", "HDTV", "DVDRip", "unknown"],
    "bitrate": { "maxMbps": 25 },
    "maxPerResolution": { "1080p": 10 },
    "allow3d": false,
    "bannedWords": ["hardsub"],
    "preferredWords": ["Dolby Vision"],
    "directVerifiedOnly": false,
    "includeHosterLinks": true
  },
  "audio": {
    "multichannel": "prefer5_1",
    "atmos": "prefer",
    "unsupportedFormats": ["DTS-HD", "TrueHD"],
    "unsupportedMode": "deprioritize",
    "verifiedLanguagesOnly": false,
    "probeTopN": 5
  },
  "sort": "default",
  "display": { "template": "detaille" },
  "play": { "budgetMs": 12000 },
  "services": { "tmdbToken": "VOTRE_JETON_TMDB" }
}
```

Chiffrer la configuration (le serveur doit tourner) :

```bash
curl -X POST http://localhost:7000/config/encode \
  -H "Content-Type: application/json" \
  -d @config.json
# {"config":"<chaîne chiffrée>"}
```

Installer l'addon dans Stremio avec l'URL suivante, où `<chaîne chiffrée>` est la valeur renvoyée :

```
http://localhost:7000/<chaîne chiffrée>/manifest.json
```

### Préréglages

Le champ `preset` (`essentiel`, `zen`, `cinephile` ou `nomade`) applique un jeu de valeurs de départ. Sans `preset`, les options se règlent une à une.

Ordre de fusion : valeurs du préréglage, puis (si un debrid est configuré) ses valeurs debrid, puis les valeurs explicites de la configuration, qui l'emportent. Les objets sont fusionnés champ par champ ; les tableaux saisis remplacent ceux du préréglage.

| Réglage | Essentiel | Zen | Cinéphile | Nomade |
| --- | --- | --- | --- | --- |
| Résolutions autorisées | 2160p, 1080p | toutes | 2160p, 1080p | toutes |
| Résolution maximale | aucune | 1080p | aucune | 1080p |
| Langues préférées | fr, multi | fr, multi | fr, multi | fr, multi |
| Repli vers les autres langues | oui | non | oui | oui |
| VOSTFR acceptés | oui | non | oui | oui |
| Qualités | par défaut | par défaut | REMUX, BluRay, WEB-DL | par défaut |
| Mots préférés | aucun | aucun | Dolby Vision, DV, HDR | aucun |
| Dolby Atmos | aucune préférence | aucune préférence | préféré | aucune préférence |
| Multicanal | aucune préférence | aucune préférence | 7.1 préféré | aucune préférence |
| Formats audio non supportés | aucun | aucun | aucun | DTS-HD, TrueHD, Atmos (exclus) |
| Débit maximal | aucun | aucun | aucun | 8 Mbit/s |
| Taille maximale | aucune | aucune | aucune | 4 Go (1080p : 3 Go, 720p : 1,5 Go) |
| Tri | par défaut | par défaut | le plus lourd d'abord | le plus léger d'abord |
| Affichage | détaillé | compact | détaillé | compact |
| Nombre de résultats | 30 | 5 | 20 | 10 |
| Avec debrid : seuls les flux en cache (ou directs) | non | oui | non | non |

Ces valeurs sont celles renvoyées par `GET /config/schema` (champ `presets`).

### Référence

Tous les champs ci-dessous sont facultatifs. Les valeurs entre parenthèses sont les défauts.

**Langues et résolutions**

| Champ | Type | Description |
| --- | --- | --- |
| `languages.preferred` | tableau de `fr`, `en`, `es`, `de`, `it`, `multi`, `original` (`["fr","multi"]`) | Langues préférées, de la plus à la moins souhaitée |
| `languages.acceptVostfr` | booléen (`true`) | Accepter les VOSTFR (sous-titres français seuls) |
| `languages.fallbackToOthers` | booléen (`true`) | Afficher les autres langues s'il n'y a rien dans ma langue. Si aucun stream ne correspond aux langues préférées, les streams des autres langues sont renvoyés (mêmes filtres de qualité, taille et tags exclus), avec le préfixe « Autre langue · » sur la première ligne de description et `laststream.languageFallback: true`. Si au moins un stream est dans une langue préférée, le comportement est strict. |
| `resolutions.allowed` | tableau de `2160p`, `1080p`, `720p`, `480p`, `SD` (toutes) | Résolutions autorisées (les streams de résolution inconnue sont gardés) |
| `resolutions.max` | résolution (aucun) | Résolution maximale |
| `excludedTags` | tableau de chaînes (`["CAM","TS","SCR"]`) | Tags exclus, par mot entier dans le nom du flux ou par source |

**Taille et nombre**

| Champ | Type | Description |
| --- | --- | --- |
| `size.minGb` / `size.maxGb` | nombre positif (aucun) | Taille globale min / max (Go) |
| `size.perResolution` | objet `résolution -> {minGb?, maxGb?}` (aucun) | Bornes de taille par résolution |
| `filters.maxPerResolution` | objet `résolution -> entier >= 1` (aucun) | Nombre maximal de flux conservés par résolution, après classement |
| `maxResults` | entier de 1 à 500 (`30`) | Nombre maximal de streams renvoyés |

**Filtres** (`filters`)

| Champ | Type | Description |
| --- | --- | --- |
| `filters.ageLimit` | `none`, `10`, `12`, `16`, `18` (`none`) | Limite d'âge française. Voir « Filtres et tris ». |
| `filters.hideUnreleased` | booléen (`true`) | Masque les films et épisodes non encore sortis |
| `filters.qualities` | tableau de `REMUX`, `BluRay`, `WEB-DL`, `WEBRip`, `HDTV`, `DVDRip`, `unknown` (sans CAM, TS, SCR) | Sources de release acceptées |
| `filters.bitrate.minMbps` / `maxMbps` | nombre positif (aucun) | Débit minimal / maximal du flux, en Mbit/s |
| `filters.allow3d` | booléen (`false`) | Garde les flux 3D (noms contenant 3D, SBS, HSBS ou HOU) |
| `filters.bannedWords` | tableau de chaînes (`[]`) | Les flux dont le nom contient un de ces mots (mot entier) sont retirés |
| `filters.preferredWords` | tableau de chaînes (`[]`) | Les flux dont le nom contient un de ces mots remontent dans le classement |
| `filters.directVerifiedOnly` | booléen (`false`) | Ne garde que les liens directs dont la disponibilité a été vérifiée |
| `filters.includeHosterLinks` | booléen (`true`) | Inclut les liens d'hébergeurs débridés par AllDebrid (voir « Liens d'hébergeurs ») |

**Audio** (`audio`)

| Champ | Type | Description |
| --- | --- | --- |
| `audio.multichannel` | `none`, `prefer5_1`, `require5_1`, `prefer7_1`, `require7_1` (`none`) | Préférence ou exigence de canaux |
| `audio.atmos` | `none`, `prefer`, `require` (`none`) | Dolby Atmos préféré ou exigé |
| `audio.unsupportedFormats` | tableau de `DTS-HD`, `TrueHD`, `EAC3`, `Atmos` (`[]`) | Formats que le lecteur ne gère pas |
| `audio.unsupportedMode` | `exclude` ou `deprioritize` (`deprioritize`) | Exclure les flux concernés, ou les reléguer en fin de liste |
| `audio.verifiedLanguagesOnly` | booléen (`false`) | Seulement les langues vérifiées par sonde. Voir « Langues audio vérifiées ». |
| `audio.probeTopN` | entier de 0 à 20 (`5`) | Nombre de meilleurs flux dont l'audio est sondé. `0` désactive la sonde. |

**Tri, affichage, lecture**

| Champ | Type | Description |
| --- | --- | --- |
| `sort` | `default`, `heaviest`, `lightest` (`default`) | Ordre d'affichage. Voir « Filtres et tris ». |
| `display.template` | `direct`, `netflix`, `compact`, `detaille` (`detaille`) | Présentation des streams. Voir « Format des streams ». |
| `play.budgetMs` | entier de 1 000 à 60 000 (`12000`) | Temps maximal accordé à la résolution d'un lien `/play/c`, failover compris |

**Sources, debrid, services**

| Champ | Type | Description |
| --- | --- | --- |
| `sources` | tableau de sources (`[]`) | Sources à interroger (voir ci-dessous) |
| `debrid` | `{"service":"alldebrid","apiKey":"..."}` (aucun) | Service debrid optionnel |
| `onlyCached` | booléen (`false`) | Ne garder que les torrents déjà en cache debrid et les URL directes. Sans debrid, seules les URL directes restent. |
| `preset` | `essentiel`, `zen`, `cinephile`, `nomade` (aucun) | Préréglage de départ (voir « Préréglages ») |
| `services.tmdbToken` | chaîne (aucun) | Jeton de lecture TMDB (API v4). Sert aux métadonnées (durée, certification, date de sortie), aux titres FR et EN, et aux catalogues. Sans lui, la limite d'âge exclut tous les flux et la recherche des indexeurs par titre est désactivée. |
| `services.tmdbApiKey`, `services.mdblistApiKey`, `services.tvdbApiKey`, `services.openrouterApiKey`, `services.fanartApiKey`, `services.openrouterModel` | chaînes facultatives (`openai/gpt-4o-mini` pour le modèle) | Clés des services annexes, utilisées par les routes `lt` (non détaillées ici) |

Chaque source est discriminée par son champ `type` :

- `{"type":"upstream","name":"...","url":"https://..."}` : addon Stremio ou API HTTP en amont. L'URL peut être la base de l'addon ou celle de son `manifest.json`.
- `{"type":"torznab","name":"...","baseUrl":"https://...","apiKey":"...","categories":[2000]}` : indexeur Torznab (Jackett, Prowlarr ou compatible). `categories` est optionnel.
- `{"type":"prowlarr","name":"...","baseUrl":"https://...","apiKey":"...","indexerIds":[1,2],"categories":[2000]}` : une instance Prowlarr, plusieurs indexeurs. `indexerIds` et `categories` sont optionnels ; sans `indexerIds`, tous les indexeurs torrent activés sont interrogés.
- `{"type":"jackett","name":"...","baseUrl":"https://...","apiKey":"...","indexers":"all"}` : une instance Jackett. `indexers` vaut `"all"` (défaut) ou une liste d'identifiants d'indexeurs.

Chaque source accepte `"enabled"` (défaut `true`, libellé « Activée »). Une source à `false` est ignorée partout : collecte et `POST /config/test`. **L'ordre de `sources` est la priorité** : la première source est la plus prioritaire. Elle départage les scores égaux (avant la taille, en tri par défaut), et, parmi des releases identiques, la copie la plus prioritaire se lit en premier (cachées d'abord, puis priorité de source, puis seeders).

Les URL doivent être en `http` ou `https`.

### Mode JSON brut (déconseillé)

Avec `LASTADDON_ALLOW_PLAIN=1`, une configuration peut être passée sans chiffrement, comme JSON encodé en base64url :

```bash
node -p "Buffer.from(require('fs').readFileSync('config.json','utf8')).toString('base64url')"
```

Sans cette variable, seules les configurations chiffrées par `/config/encode` sont acceptées.

## Fonctionnalités v2

### Groupement des copies et lecture avec failover

Plusieurs sources peuvent renvoyer la même release. Le moteur les regroupe en une seule entrée Stremio, avec la liste de ses copies.

- **Ce qui rapproche deux copies** : un même infoHash (et le même index de fichier), une même URL directe, un même nom normalisé (sans extension vidéo, casse et ponctuation ignorées), ou une taille identique à ±0,5 % près avec le même groupe de release et la même résolution.
- **Représentant** : la copie cachée d'abord, puis celle qui a le plus de seeders, puis le lien direct. Ses métadonnées sont fusionnées avec celles des autres copies (langues, audio, HDR, variante FR).
- **Ordre des copies** : cachées d'abord, puis seeders décroissants, puis liens directs en fin de liste. Le segment « N copies » de l'affichage Détaillé n'apparaît qu'à partir de 2.
- **Jeton de lecture** : les flux torrent et les liens d'hébergeurs débridés portent leurs copies dans un jeton `/play/c/:token`. Le jeton est signé (HMAC, clé dérivée de `LASTADDON_SECRET`) mais **pas chiffré** : son contenu est lisible par qui détient l'URL. Il ne contient ni clé API, ni passkey, ni configuration. Huit copies au plus par jeton (64 au décodage), 4 Ko au plus. Un lien direct ordinaire n'entre pas dans le jeton : il reste une URL directe.
- **Basculement** : à la lecture, les copies sont essayées une à une dans l'ordre, dans le budget `play.budgetMs` (12 s par défaut). Chaque tentative reçoit le temps restant. Une erreur propre à la copie passe à la suivante ; une erreur globale (clé, abonnement, quota) ou le dépassement du budget arrête tout. Un hébergeur signalé indisponible est marqué en panne pendant 1 h, et ses copies sont sautées.
- **Contrôles avant débridage** : une date de sortie future renvoie `not_released` ; une certification connue au-dessus de la limite d'âge de la configuration renvoie `age_limit`. Aucun appel au debrid n'est fait dans ces cas.
- **Sans debrid** : les copies torrent et les liens d'hébergeurs sont ignorés. Seuls les liens directs restent lisibles.
- **Torrents privés** : un .torrent privé est mis en cache par guid de release (6 h). Au débridage, ses octets sont envoyés à AllDebrid comme fichier (`POST /v4/magnet/upload/file`), jamais comme magnet public. Si les octets ne sont plus en cache, la copie vaut `no_copy`. Limite actuelle : un torrent privé sans guid n'est pas mis en cache et est résolu par son infoHash (voir « Torrents sans infoHash et torrents privés »).

Raisons d'échec de `/play/c`, avec leur statut HTTP et leur titre affiché (texte en français, fixe, sans donnée de la requête) :

| Raison | Statut | Titre |
| --- | --- | --- |
| `not_cached` | 404 | Pas en cache |
| `dead_link` | 410 | Lien mort |
| `host_unavailable` | 503 | Hébergeur indisponible |
| `age_limit` | 403 | Limite d'âge |
| `subscription_expired` | 402 | Abonnement AllDebrid expiré |
| `invalid_key` | 401 | Clé API invalide |
| `file_not_found` | 404 | Fichier introuvable dans le pack |
| `not_released` | 404 | Épisode non sorti (libellé commun aux films et aux épisodes) |
| `no_copy` | 404 | Aucune copie disponible |
| `unsupported_format` | 415 | Format non lu |
| `timeout` | 504 | Délai dépassé |
| `quota` | 429 | Quota atteint |
| `unknown` | 500 | Erreur inconnue |

### Langues audio vérifiées

Les langues annoncées par le nom de release ne sont pas toujours celles de la piste audio. Pour les meilleurs candidats, le serveur lit l'en-tête du fichier et relève les pistes audio réelles.

- **Ce qui est sondé** : les liens directs http(s), et les torrents cachés chez AllDebrid (leur lien est alors obtenu pour la sonde). Un torrent non caché n'est pas sondé. **Sans AllDebrid, seuls les liens directs sont sondés.**
- **Comment** : requêtes HTTP `Range` sur les conteneurs MKV/WebM (EBML) et MP4/MOV. L'en-tête (3 Mo) suffit en général ; pour un MP4 dont l'index est en fin de fichier, une requête complémentaire de 2 Mo au plus est faite. Le fichier n'est jamais téléchargé en entier. Chaque requête a un délai de 4 s ; trois sondes tournent en parallèle, dans un budget global de 4 s.
- **Quels candidats** : `audio.probeTopN` (défaut 5, de 0 à 20) premiers candidats éligibles, dans l'ordre du classement. `0` désactive la sonde. Les candidats qui partagent une même copie ne sont sondés qu'une fois.
- **Affichage** : les langues vérifiées s'affichent avec leur drapeau, suivies de `✓` ; les langues seulement annoncées sont suffixées de `?` (Détaillé, Compact) ou de « (annoncé) » (Netflix). Deux langues vérifiées ou plus ajoutent `multi`.
- **Option « Seulement les langues vérifiées »** (`audio.verifiedLanguagesOnly`) : ne garde que les flux sondés. Le filtre de langue ne compte alors que les langues vérifiées.
- **Cache** : les sondes réussies sont gardées 30 jours, en mémoire, jusqu'à 5 000 entrées. Un échec n'est pas mis en cache.

### Filtres et tris

- **Limite d'âge française** (`filters.ageLimit`) : la certification FR vient de TMDB (films : `release_dates` ; séries : `content_ratings`, la plus stricte). Une limite active exclut les contenus sans certification FR connue, donc **sans `services.tmdbToken`, une limite active exclut tous les flux**.
- **Contenus non sortis** (`filters.hideUnreleased`, vrai par défaut) : date de sortie du film, ou date d'antenne de l'épisode, depuis TMDB. Une date future est exclue ; une date inconnue est gardée.
- **Débit** (`filters.bitrate`) : débit moyen = taille × 8 ÷ durée réelle, en Mbit/s. La durée vient de TMDB, avec Cinemeta en repli. Un débit non calculable (taille ou durée inconnue) est gardé. Le même débit est exposé dans `laststream.bitrateMbps`.
- **Qualités** (`filters.qualities`) : la source de la release doit figurer dans la liste ; `unknown` est accepté par défaut. CAM, TS et SCR sont exclues par défaut.
- **Tailles et nombre par résolution** : `size.minGb`, `size.maxGb`, `size.perResolution` filtrent par taille ; `filters.maxPerResolution` ne garde que les N premiers flux de chaque résolution après le classement.
- **Canaux audio** (`audio.multichannel`) : le rang de canaux est lu dans le nom de release. `prefer5_1` et `require5_1` visent 5.1 ou plus (7.1 compris) ; `prefer7_1` et `require7_1` visent 7.1 seulement. Les variantes `prefer` ajoutent un bonus de classement ; les variantes `require` excluent les flux en dessous. Un canal inconnu ne prouve rien et est exclu avec `require`.
- **Dolby Atmos** (`audio.atmos`) : détecté dans le nom de release ou la piste. `prefer` donne un bonus ; `require` exclut les flux sans Atmos détecté.
- **Formats non supportés** (`audio.unsupportedFormats`) : DTS-HD, TrueHD, EAC3 (DD+, DDP, E-AC-3) et Atmos sont détectés dans le nom de release. `exclude` retire les flux concernés ; `deprioritize` (défaut) les met en fin de liste.
- **3D** : écartée par défaut (`filters.allow3d`), par mot entier dans le nom (3D, SBS, HSBS, HOU).
- **Mots bannis et mots préférés** (`filters.bannedWords`, `filters.preferredWords`) : correspondance par mot entier, séparateurs espace, point, tiret ou souligné acceptés. Un mot préféré remonte le flux dans le classement par défaut, après la langue, la résolution et la source.
- **Liens vérifiés** (`filters.directVerifiedOnly`) : ne garde que les liens directs dont la disponibilité a été vérifiée, soit par AllDebrid (liens d'hébergeurs), soit par une sonde réussie.
- **Tri** (`sort`) :
  - `default` : score composite (flux non déclassés, langue, résolution, source, préférences audio et mots, HDR, cache), puis la plus petite taille, puis le plus grand nombre de seeders.
  - `heaviest` : niveau de langue, puis le plus lourd d'abord, puis score et seeders.
  - `lightest` : niveau de langue, puis le plus léger d'abord, puis score et seeders.
  - Une taille inconnue passe toujours en dernier.
  - Les flux déclassés (format non supporté en mode `deprioritize`) passent après tous les autres.

### Liens d'hébergeurs (AllDebrid)

AllDebrid débride aussi les liens des hébergeurs qu'il prend en charge. Cette fonctionnalité demande un `debrid` configuré.

- **Catalogue** : `GET /v4/user/hosts`, gardé 12 h. Un lien relève d'un hébergeur par son domaine (sous-domaines compris) ou par une expression régulière du catalogue. Aucun hébergeur n'est codé en dur.
- **Contrôle** (`POST /v4/link/infos`) : 8 liens au plus par requête, par lots de 20, dans un budget de 5 s. Un lien mort est retiré. Un lien vivant reçoit son nom de fichier, sa taille et son hébergeur, et est marqué vérifié. Un hébergeur signalé en panne est écarté sans contrôle.
- **Débridage à la lecture** (`/play/c`) : `POST /v4/link/unlock`. Si le lien est différé, `POST /v4/link/delayed` est interrogé une fois par seconde, dans un budget de 10 s par défaut (60 s au maximum) ; sans lien à l'issue, la copie est en `not_ready`, donc passe à la suivante. Si l'hébergeur propose des flux, le meilleur (par qualité) est demandé via `POST /v4/link/streaming`, avec repli sur le lien direct.
- **Option « Inclure les liens directs (hébergeurs) »** (`filters.includeHosterLinks`, vraie par défaut) : quand elle est fausse, les liens d'hébergeur sont retirés avant le groupement. Les liens directs ordinaires (hors catalogue AllDebrid) restent des liens directs.
- Dans l'affichage, un lien d'hébergeur s'affiche « Lien direct · <hébergeur> », avec le nom fourni par AllDebrid.

### Prowlarr et Jackett

- **Types de source** : `prowlarr` (une instance, plusieurs indexeurs) et `jackett` (une instance, tous les indexeurs configurés ou une liste). Les indexeurs Torznab isolés restent pris en charge (`torznab`).
- **Découverte** : `POST /config/indexers` avec la source en JSON brut (non chiffré) renvoie les indexeurs disponibles :

  ```json
  {
    "indexers": [
      { "id": 1, "name": "Mon indexeur", "protocol": "torrent", "privacy": "private", "enabled": true, "health": { "status": "ok", "avgLatencyMs": 820 } }
    ]
  }
  ```

  Seuls les indexeurs torrent activés sont listés pour Prowlarr ; Jackett ne liste que les indexeurs configurés. `health.status` vaut `ok`, `slow` (latence moyenne au-delà de 5 s sur les 10 dernières requêtes), `error` (la dernière requête a échoué) ou `unknown` (jamais interrogé). Aucune clé ni URL n'est renvoyée. Erreurs : `400 invalid_config` (chemins et messages seulement), `413 payload_too_large` au-delà de 16 Ko, `502 indexers_unavailable` si la découverte échoue.
- **Recherche Prowlarr** : `GET /api/v1/search`, clé dans l'en-tête `X-Api-Key`. Les indexeurs qui acceptent la recherche par identifiant IMDb reçoivent une requête par identifiant, qui porte aussi le titre (et le TVDB si connu) ; pour une série, la saison et l'épisode s'y ajoutent si l'indexeur accepte la recherche par saison. Les packs et l'intégrale sont demandés en texte à tous les indexeurs, et la requête texte « Titre SxxEyy » seulement à ceux qui n'acceptent pas l'identifiant. Les autres reçoivent une recherche texte par titre, une par variante de titre. Les catégories par défaut sont 2000 (films) et 5000 (séries).
- **Recherche Jackett** : une requête Torznab par cible (`all`, ou chaque identifiant de la liste), sur `/api/v2.0/indexers/<cible>/results/torznab`.
- **Titres FR et EN** : pour la recherche texte, les titres français et anglais viennent de TMDB (cache 7 jours). Sans `services.tmdbToken`, aucune requête texte n'est lancée. Au plus 8 requêtes texte sont construites par contenu, avec l'année filtrée dans les résultats.
- **Budgets** : 3 requêtes en parallèle au plus, 12 s pour la recherche entière, 10 s par requête.

### Torrents sans infoHash et torrents privés

- Un release sans infoHash ni magnet, mais avec un lien `.torrent` HTTP(S), est lu : jusqu'à 12 liens par requête, 3 lectures en parallèle, 10 s de délai chacune. L'infoHash et les fichiers du pack sont extraits. Un lien qui redirige vers un magnet est accepté directement.
- Le lien `.torrent` peut contenir une passkey : il reste en mémoire et n'est jamais renvoyé dans une réponse.
- Le flag `private` du .torrent est lu. Les octets d'un torrent privé sont gardés 6 h, par guid de release (200 entrées au plus). Au débridage, ils sont envoyés à AllDebrid comme fichier, jamais comme magnet public.
- **Limite actuelle** : la garantie ci-dessus suppose un guid. Un torrent privé sans guid n'a pas d'octets en cache et est résolu par son infoHash, comme un torrent public. Un release Prowlarr ou Torznab fournit normalement un guid.

### Robustesse

- **Isolation** : chaque étape du pipeline (métadonnées, titres, collecte, lecture des .torrent, sonde, hébergeurs, classement) est isolée. Un échec désactive son étape sans faire échouer la requête. Une erreur de source n'est jamais renvoyée à Stremio.
- **Cache des résultats** : LRU de 200 entrées, durée de vie 5 minutes. La clé dépend de la configuration (hachée), du contenu et de la base de lecture. Un résultat où une source a échoué n'est pas mis en cache.
- **Autres caches** : métadonnées TMDB 6 h ; titres TMDB 7 jours ; .torrent 6 h (200 entrées) ; sondes audio 30 jours (5 000 entrées) ; catalogue des hébergeurs AllDebrid 12 h ; statut « cache » AllDebrid (voir « Méthode de cache-check AllDebrid »).
- **Hôtes en panne** : un hébergeur qui renvoie `host_unavailable` pendant une lecture est marqué en panne pendant 1 h. Ses copies sont sautées par le failover, et ses liens sont écartés sans contrôle au calcul des streams.
- **Apprentissage des packs** : les fichiers d'un torrent sont mémorisés dès qu'ils sont connus (lecture du .torrent, ou liste des fichiers chez AllDebrid), jusqu'à 2 000 torrents pendant 30 jours. Pour un épisode de série, le fichier correspondant du pack est retrouvé et remplace le fichier indiqué par la copie. Ce magasin est en mémoire : il est vidé au redémarrage.
- **Remappage anime : partiel.** Le module `src/anime/mapping.ts` (table de correspondance anime vers IMDb, TVDB et TMDB, lecture de la liste de correspondances et des groupes d'épisodes TMDB) est couvert par `tests/anime-mapping.test.ts`, et le pipeline sait l'utiliser (`animeMapper`), mais **le serveur ne l'injecte pas** : aucun numéro absolu n'est remappé aujourd'hui. Les releases en numérotation absolue (« Titre - 05 ») ne sont donc pas écartées faute de remappage, et les requêtes Prowlarr « Titre 05 » ne sont pas envoyées.

### Segments de saut détectés localement

Quand aucune base externe n'a de données, lastAddon détecte lui-même intro, générique de fin, reprise et aperçu, en arrière-plan (un job à la fois, 2 jobs par minute au plus, 40 Mo lus au plus par job, ffmpeg tué au délai). Le lecteur rapporte le média réellement lu :

`POST /:config/lt/skip/analyze` avec `{ "type": "series", "imdbId": "tt…", "season": 1, "episode": 3, "mediaUrl": "https://…", "duration": 1440 }` répond 202 `{ "queued": true }` (ou `{ "queued": false, "reason": "known|retry_later|rate_limited|queue_full|no_ffmpeg|disabled" }`). `mediaUrl` doit être en http(s), sans identifiants, ni nom local ni IP privée (seule exception : le serveur de streaming local `127.0.0.1:11470`). L'URL reste en mémoire, jamais en base ni dans les journaux, et ffmpeg ne la voit pas : il lit un relais local qui compte les octets.

Méthodes, par ordre : (1) chapitres du conteneur (`ffprobe -show_chapters`, titres FR/EN/JA), confiance 0,95 ; (2) empreinte audio entre épisodes de la même saison (début : 25 % ou 10 min au plus, fin : 6 min ; Chromaprint via ffmpeg si le muxer existe, sinon empreinte spectrale interne), confiance 0,8 : il faut deux épisodes rapportés pour la première saison analysée, ensuite l'empreinte de référence de la saison suffit à reconnaître les suivants ; (3) fichier unique : zone noire de 25 s au moins jusqu'à la fin (blackdetect, silencedetect), confiance 0,6 à 0,7. Les segments sont enregistrés dans `skip_segments` (source `auto`, colonnes `confidence` et `method`) et les empreintes de saison dans `skip_fingerprints`.

`GET /:config/lt/skip/…` ne bloque jamais : priorité par type de segment, bases externes, puis communauté, puis détection locale (chapitres avant empreinte), puis déduction de saison (0,5). La réponse porte `"analyzing": true` tant qu'un job de l'épisode est en attente ou en cours (réponse alors sans cache) : relire quelques secondes plus tard.

### Séries : épisode, packs et intégrales

Pour un épisode demandé, une release est gardée si son nom désigne cet épisode (`SxxEyy`, `4x04`, « Saison 4 Episode 4 »), le pack de sa saison, ou une intégrale ou un multi-saisons qui la couvre. Une release d'un autre épisode est écartée, de même qu'une release dont le nom ne contient aucun titre de la série. Les liens directs et les flux sans texte ne sont pas filtrés. Les titres TMDB sont complétés du titre Cinemeta s'il manque (pas de jeton TMDB, ou TMDB en panne). Côté AllDebrid, un pack qui ne contient pas l'épisode demandé échoue au lieu de jouer le plus gros fichier.

## Format des streams

Chaque stream renvoyé suit le format Stremio, avec un champ `laststream` propre à lastAddon. Le nom et la description dépendent du gabarit `display.template`.

### Gabarits d'affichage

Les quatre gabarits ci-dessous présentent le même flux : une release 1080p WEB-DL VFF, cachée chez AllDebrid, avec deux copies, dont les langues française et anglaise sont vérifiées par sonde. Le débit est calculé à partir d'une durée de 2 h 16 min.

**Détaillé** (`detaille`, défaut) : nom avec le préfixe `[AD⚡]` si débridé et en cache, `[AD⏳]` si débridé sans cache, et la résolution ; rien de tel pour un flux direct ou P2P. Trois lignes de description : (1) source, HDR, débit, langues, taille, seeders (P2P seulement), indexeurs et nombre de copies ; (2) lien d'hébergeur éventuel, codec, audio, groupe ; (3) nom de fichier.

```
name: [AD⚡] lastAddon 1080p
description:
WEB-DL • 📶 10 Mb/s 🇫🇷 🇬🇧 ✓ • 💾 9,5 Go • 🔎 Mon indexeur | Autre indexeur · 2 copies
🎧 AVC • 5.1 DDP • TEAM
🗂️ Dune.Deuxieme.Partie.2024.1080p.WEB-DL.DDP5.1.H.264.VFF-TEAM.mkv
```

**Netflix** : nom sobre, langues en toutes lettres, qualité et taille. Une langue seulement annoncée porte la mention « (annoncé) ».

```
name: lastAddon 1080p
description: Français, Anglais
WEB-DL · 9,5 Go
```

**Compact** : résolution, source, drapeaux et taille dans le nom ; statut et codecs dans la description. Le statut vaut « AllDebrid (en cache) », « AllDebrid (pas en cache) », « P2P (N seeders) », « Direct » ou « Lien direct · <hébergeur> ».

```
name: 1080p · WEB-DL · 🇫🇷🇬🇧✓ · 10 Go
description: AllDebrid (en cache) · AVC · 5.1 DDP
```

**Direct** : style technique, sans émoji ni préfixe AD. Pour un lien d'hébergeur, la première ligne devient « Lien direct · <hébergeur> ».

```
name: lastAddon
description: 1080p · WEB-DL · 9,5 Go · TEAM
```

Le gabarit ne change ni les URL, ni les champs `behaviorHints` et `laststream`. Les textes libres (source, groupe, nom de fichier, nom d'indexeur) sont nettoyés : balises retirées, caractères de contrôle remplacés, nom de fichier tronqué à 140 caractères.

### Champs d'un stream

- `name` et `description` : selon le gabarit ci-dessus.
- `url` : pour un lien direct, l'URL d'origine ; pour un torrent ou un hébergeur quand un debrid est configuré, l'URL `/:config/play/c/:token`. Absent en P2P.
- `infoHash`, `fileIdx`, `sources` : présents en P2P, sans debrid.
- `behaviorHints` : `filename`, `videoSize` (octets), `bingeGroup` (`lastaddon|<résolution>|<variante>|<source>`, par exemple `lastaddon|1080p|vff|WEB-DL`), `notWebReady` (HEVC, AV1, REMUX, ou audio DTS/TrueHD). Les en-têtes d'une URL directe amont sont recopiés quand ils existent.
- `laststream` : données structurées pour les clients. Jamais d'URL, de guid ni de lien débridé.

| Champ | Contenu |
| --- | --- |
| `resolution`, `height` | Résolution (`1080p`, ...) et hauteur en pixels |
| `source`, `codec`, `hdr` | Source (`WEB-DL`, `REMUX`, ...), codec (`HEVC`, `AVC`, `AV1`), formats HDR |
| `languages`, `frVariant` | Langues détectées (nom de release, puis sonde) et variante française éventuelle |
| `verifiedLanguages` | Langues lues dans l'audio par la sonde. Vide si le flux n'a pas été sondé. |
| `languageFallback` | Présent et `true` quand le flux est un repli hors langue préférée |
| `sizeBytes`, `seeders` | Taille en octets et nombre de seeders, si connus |
| `cached` | `true` si le torrent est en cache debrid |
| `copies` | Nombre de copies regroupées derrière ce flux (au moins 1) |
| `bitrateMbps` | Débit moyen en Mbit/s (taille × 8 ÷ durée réelle), `null` si inconnu |
| `estBitrateKbps` | Même débit en kb/s, `null` si la durée ou la taille est inconnue |
| `certification` | Âge minimal FR du contenu (`0`, `10`, `12`, `16`, `18`), `null` si inconnu |
| `indexers` | Noms des indexeurs ayant renvoyé une copie de cette release |
| `score` | Score de classement (entier, plus haut = meilleur) |

Exemple d'objet `laststream` pour le flux illustré ci-dessus :

```json
{
  "resolution": "1080p",
  "height": 1080,
  "source": "WEB-DL",
  "codec": "AVC",
  "hdr": [],
  "languages": ["fr", "en"],
  "frVariant": "VFF",
  "sizeBytes": 10200547328,
  "cached": true,
  "seeders": 42,
  "score": 110545,
  "estBitrateKbps": 10001,
  "bitrateMbps": 10,
  "copies": 2,
  "verifiedLanguages": ["fr", "en"],
  "certification": 12,
  "indexers": ["Mon indexeur", "Autre indexeur"]
}
```

## Fonctionnement

Pour une requête de streams, le pipeline (`src/pipeline.ts`) enchaîne les étapes suivantes. Chaque étape est isolée : son échec la désactive sans lever d'erreur.

1. **Métadonnées** (en parallèle) : certification FR, date de sortie et durée (TMDB, avec Cinemeta en repli pour la durée), titres FR et EN (TMDB). Une lecture en échec laisse sa valeur inconnue.
2. **Collecte** : toutes les sources sont interrogées en parallèle. Une source en erreur est ignorée ; les autres résultats sont conservés.
3. **Fichiers .torrent** : les liens `.torrent` sans infoHash sont lus (voir « Torrents sans infoHash et torrents privés »). Les copies d'un même infoHash venues de plusieurs indexeurs sont fusionnées.
4. **Parsing et premier filtre** : résolution, source, codec, HDR, audio, canaux, langues, variante FR, taille, seeders et infoHash sont analysés. Le premier filtre applique résolutions, tags exclus, qualités, tailles, débit, limite d'âge, non-sortis, 3D, mots bannis, formats audio et langues (avec repli). Les exigences qui dépendent d'AllDebrid ou de la sonde sont appliquées à l'étape 9.
5. **Liens d'hébergeurs** : retirés ici si `filters.includeHosterLinks` est faux.
6. **Groupement** des copies (voir « Groupement des copies et lecture »).
7. **Statut « cache »** : avec un debrid, les infoHash des premiers groupes classés (8 au plus, copies comprises) sont interrogés auprès d'AllDebrid.
8. **Contrôle des liens d'hébergeurs** : 8 liens au plus, budget de 5 s. Les liens morts sont retirés, les hôtes en panne écartés.
9. **Classement** et limite par résolution, puis **sonde audio** des `audio.probeTopN` premiers candidats éligibles, puis **second filtre** (langues vérifiées, cache seul, liens vérifiés) et second classement.
10. **Apprentissage des packs** (épisodes trouvés dans un pack connu), puis **formatage** selon le gabarit, tronqué à `maxResults`.

Le résultat complet est gardé 5 minutes dans un cache LRU, sauf si une source a échoué.

### Méthode de cache-check AllDebrid

L'état « en cache » est déterminé par un contrôle sans téléchargement :

La documentation AllDebrid ne décrit aucun endpoint de disponibilité instantanée : le contrôle passe donc par l'ajout du magnet au compte.

1. Les 8 premiers infoHash du classement (sans URL directe, sans doublon) sont envoyés par lots de 20 à `POST /v4/magnet/upload`, après lecture de la liste des magnets du compte (`POST /v4.1/magnet/status` sans id).
2. Un magnet dont la réponse est `ready` est en cache : il est marqué `cached`.
3. Un magnet non prêt n'est supprimé (`POST /v4/magnet/delete`, 3 à la fois) que si son id était absent de la liste lue juste avant l'envoi. Un magnet déjà présent (téléchargement en cours de l'utilisateur) ou utilisé par une résolution en cours n'est jamais supprimé. Il est considéré comme non caché.
4. Une erreur, une liste de compte illisible, ou un hash absent de la réponse vaut « non caché » (et n'est pas renouvelé pendant 30 s). Une erreur n'interrompt jamais la requête.
5. Le résultat est mis en cache par client : 6 heures pour un hash caché, 30 minutes pour un hash non caché.
6. Après HTTP 429 ou 503, aucun appel à AllDebrid n'est fait pendant le délai indiqué par `Retry-After` (30 s par défaut, plafonné à 10 minutes) ; les contrôles renvoient « inconnu » sans nouvel essai.

Les magnets prêts restent dans le compte AllDebrid. Un hash déjà en cache n'y est pas téléchargé, mais il apparaît dans la liste des torrents du compte.

Lorsque `onlyCached` est vrai, seuls les streams cachés et les URL directes sont gardés. **Sans debrid configuré**, aucun stream P2P n'est cachable : seules les URL directes restent.

## Données utilisateur (`/user/*`)

lastAddon peut stocker pour chaque utilisateur sa bibliothèque, sa progression, ses profils et ses réglages (base SQLite, module `node:sqlite`, Node 22.13 ou plus récent).

**Emplacement.** La base est `data/laststream.db` à la racine du projet, ou `LASTADDON_DATA_DIR/laststream.db` si la variable est définie (chemin relatif à la racine du projet). Le dossier est créé à la première requête sur `/user`. Sous Linux et macOS, le fichier est en `0600`. Sous Windows, ces droits POSIX n'existent pas : protégez le dossier par ses ACL. Pour une sauvegarde à chaud, utilisez `sqlite3 laststream.db ".backup sauvegarde.db"` plutôt que de copier le fichier pendant l'écriture.

**Premier compte (risque à connaître).** Le premier compte créé devient propriétaire. Si `LASTADDON_BOOTSTRAP_TOKEN` est défini, il faut l'en-tête `X-Bootstrap-Token` avec cette valeur pour créer ce premier compte. Sans cette variable, quiconque atteint le serveur avant vous peut créer ce compte. Pour un usage local mono-utilisateur, ce risque est acceptable. Pour un serveur exposé sur Internet, définissez `LASTADDON_BOOTSTRAP_TOKEN`.

**Inscription.** Les comptes suivants ne sont créés que si `LASTADDON_ALLOW_SIGNUP=1`. Un nom déjà pris renvoie `409 username_taken`, ce qui révèle qu'il existe. Ce choix est assumé : `/user/register` est limité à 10 requêtes par minute et par IP.

**Sessions.** Un jeton de 256 bits, valable 180 jours, renouvelé par `POST /user/refresh` (l'ancien jeton cesse de valoir). Un compte garde au plus 20 sessions : la plus ancienne est supprimée au-delà. `POST /user/logout-all` ferme toutes les sessions. `POST /user/password` change le mot de passe et ferme les autres sessions. `DELETE /user/account` supprime le compte et toutes ses données, après confirmation du mot de passe.

**Profils protégés par PIN.** Le PIN fait 4 chiffres. Après 5 échecs, le profil est bloqué 15 minutes (`429 pin_locked`, en-tête `Retry-After`) et le PIN n'est même pas vérifié pendant ce blocage. Le déverrouillage (`POST /user/profiles/:id/unlock`) renvoie un jeton valable 30 jours, lié à la session et à la version du PIN : il est refusé après une déconnexion ou un changement de PIN. Le client appelle `POST /user/profiles/:id/lock` au changement de profil (sans effet côté serveur). Toutes les routes de données d'un profil protégé (bibliothèque, progression, réglages, import) exigent ce jeton dans l'en-tête `X-Profile-Token`.

**Limites de débit** (en mémoire, par processus, par IP et par minute) : lectures 300, écritures 120, routes sensibles 10 (`/register`, `/login`, `/password`, `DELETE /account`, `/unlock`, import Stremio). `/login` est aussi limité à 10 tentatives par minute et par nom d'utilisateur.

**Import Stremio.** `POST /user/profiles/:id/import/stremio` lit la bibliothèque d'un compte Stremio (au plus 5000 entrées). Les identifiants Stremio servent une seule fois, ne sont ni stockés ni journalisés.

## Sécurité

**Risque SSRF.** Les URL des sources (addons amont, indexeurs Torznab, Prowlarr, Jackett) sont saisies par l'utilisateur et appelées par le serveur. Sans précaution, une URL peut viser le réseau interne (ex. `http://192.168.1.1`, `http://169.254.169.254` sur un cloud). Protections appliquées à chaque requête :

- schémas `http` et `https` uniquement ;
- redirections gérées à la main (`redirect: manual`) : au plus 3, chaque saut est revalidé ;
- corps de réponse limité à 2 Mo, lecture interrompue au-delà ;
- délai maximal par requête (8 s par défaut).

**Mode public (`LASTADDON_PUBLIC=1`).** Pour un serveur exposé sur Internet, l'hôte de chaque URL est contrôlé et la requête est refusée si une adresse est privée, de boucle locale, lien local, CGNAT (100.64/10), ULA (fc00::/7) ou autre plage non publique, en IPv4 comme en IPv6. Les connexions passent par un agent au DNS épinglé : l'adresse est contrôlée au moment de la connexion, et pas seulement avant, ce qui couvre aussi le DNS rebinding. Les lectures de fichiers (sondes média, .torrent) suivent la même règle. Un pare-feu sortant reste recommandé.

**Autres protections.** Les endpoints `/config/*` acceptent le CORS uniquement pour `LASTADDON_ALLOWED_ORIGINS` et sont limités à 30 requêtes par minute et par IP (compteur en mémoire, par processus). Les messages d'erreur masquent les clés API sous leurs formes brute, URL-encodée et base64. Les jetons `/play/c` sont signés avec une clé dérivée de `LASTADDON_SECRET` ; ils ne contiennent ni clé API ni passkey. Les URL de téléchargement des indexeurs (qui peuvent porter une passkey) ne sont jamais renvoyées.

## Tests

```bash
npm test
```

Hors smoke test (ci-dessous), les tests n'effectuent aucun appel réseau : les sources, Cinemeta, TMDB, AllDebrid et les sondes sont simulés par un `fetch` injecté dans les dépendances. Les clés de test sont factices.

| Fichier | Couverture |
| --- | --- |
| `tests/config.test.ts`, `tests/config-v2.test.ts`, `tests/config-presets.test.ts`, `tests/config-env.test.ts` | Schéma, défauts, préréglages, chiffrement, variables d'environnement |
| `tests/app.test.ts`, `tests/app-cors.test.ts` | Endpoints HTTP, validation d'entrée, CORS |
| `tests/parse-*.test.ts` | Parseurs (vidéo, taille, seeders, langues) et intégration `parseRelease` / `parseRawStream` |
| `tests/sources-*.test.ts`, `tests/alldebrid.test.ts`, `tests/routes-indexers.test.ts` | Sources amont, Torznab, Prowlarr, Jackett, client AllDebrid, `POST /config/indexers` |
| `tests/engine-*.test.ts`, `tests/pipeline-v2.test.ts` | Filtre, filtres v2, déduplication, groupement des copies, classement, formatage, gabarits, sonde, hébergeurs, Cinemeta, TMDB, pipeline |
| `tests/play*.test.ts` | Endpoint de lecture, jeton de copies, failover, raisons d'échec, hôtes en panne, packs |
| `tests/media-*.test.ts`, `tests/torrent-*.test.ts` | Sonde MKV/MP4, cache de sondes, pistes audio, lecture des .torrent |
| `tests/cache-lru.test.ts`, `tests/anime-mapping.test.ts`, `tests/indexer-health.test.ts` | Cache LRU, remappage anime (module seul), santé des indexeurs |
| `tests/e2e.test.ts` | Parcours complet sur un serveur réel : agrégation, cache debrid, série, config chiffrée, journalisation |

### Smoke test live (optionnel)

`tests/live.test.ts` interroge de vrais services. Il est ignoré si les variables ne sont pas définies :

- `ALLDEBRID_API_KEY` : vérifie la clé et le cache-check sur le hash public de Big Buck Bunny (`dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c`).
- `TORZNAB_URL` et `TORZNAB_KEY` : vérifie que l'indexeur répond à `t=caps`.

```bash
# bash
ALLDEBRID_API_KEY=... TORZNAB_URL=https://... TORZNAB_KEY=... npm test -- tests/live.test.ts
```

```powershell
# PowerShell
$env:ALLDEBRID_API_KEY = "..."; $env:TORZNAB_URL = "https://..."; $env:TORZNAB_KEY = "..."
npm test -- tests/live.test.ts
```

Le test n'affiche ni la clé ni les réponses brutes. Il ajoute un magnet au compte AllDebrid pendant le contrôle.

## Structure du projet

```
src/
  server.ts          point d'entrée (démarre si exécuté directement)
  app.ts             createApp() : routes, CORS, limites de débit, gestion d'erreurs
  deps.ts            dépendances injectées (secret, allowPlain, fetch, client AllDebrid)
  pipeline.ts        getStreams() : orchestration du pipeline (métadonnées, collecte, groupement, cache, sonde, formatage)
  types.ts           types partagés (RawStream, ParsedRelease, StremioStream, ContentRef)
  cache/
    lru.ts           cache LRU à durée de vie, clé de configuration hachée
  config/
    schema.ts        schéma zod, défauts, parseConfig, JSON Schema
    presets.ts       préréglages Essentiel, Zen, Cinéphile, Nomade
    codec.ts         chiffrement AES-256-GCM de la configuration
    secret.ts        lecture de LASTADDON_SECRET et du .env
    runtime-env.ts   variables d'environnement (mode public, proxy, origines)
  parse/
    index.ts         parseRelease, parseRawStream
    video.ts         résolution, source, codec, HDR, audio, canaux, groupe
    language.ts      langues, variante FR, sous-titres
    meta.ts          taille, seeders, infoHash, saison et épisode
  media/
    probe.ts         sonde distante (requêtes Range) : pistes audio et sous-titres
    ebml.ts, mp4.ts  lecture des conteneurs MKV/WebM et MP4/MOV
    tracks.ts        normalisation des langues, codecs, Atmos
    probe-cache.ts   cache des sondes (30 jours)
  sources/
    collect.ts       interrogation parallèle des sources, erreurs isolées
    upstream.ts      addons Stremio amont
    torznab.ts       indexeurs Torznab
    prowlarr.ts      Prowlarr : découverte des indexeurs, recherche par capacité
    jackett.ts       Jackett : découverte et recherche Torznab
    indexers.ts      types et utilitaires communs aux indexeurs
    indexer-health.ts  santé des indexeurs (ok, slow, error)
    query-titles.ts  titres FR et EN (TMDB) et requêtes texte
    query-merge.ts   requêtes bornées, fusion sans doublon
    alldebrid.ts     client AllDebrid (cache-check, résolution, clé API)
    hosters.ts       hébergeurs AllDebrid : catalogue, contrôle, débridage
    http.ts          fetch avec délai, masquage des URL et des secrets, agent DNS épinglé
  torrent/
    fetch-torrent.ts lecture des .torrent (cache par guid, octets des torrents privés)
    enrich.ts        infoHash des liens .torrent, fichiers des packs
    bencode.ts       décodage bencode
  engine/
    group.ts         groupement des copies d'une même release
    filter.ts        filtres (âge, débit, audio, mots, langues, tailles)
    score.ts         classement et tris
    audio.ts         canaux, Atmos, formats audio non supportés
    probe-step.ts    étape de sonde audio
    hosters-step.ts  contrôle des liens d'hébergeurs
    tmdb-meta.ts     certification FR, date de sortie, durée (TMDB)
    cinemeta.ts      durées (Cinemeta, avec cache)
    templates.ts     gabarits d'affichage (Détaillé, Netflix, Compact, Direct)
    format.ts        formatage des streams Stremio, jetons /play/c, objet laststream
    dedupe.ts        déduplication (ancienne version, utilisée par runEngine)
    index.ts         barrel du moteur et runEngine (variante pure, sans groupement ni sonde)
    types.ts         candidats, rangs, métadonnées de contenu
  play/
    token.ts         jeton signé des copies (/play/c)
    failover.ts      essai des copies dans le budget, erreurs globales
    errors.ts        raisons d'échec de /play (titres, statuts, pages et JSON)
    hosts.ts         hôtes en panne (1 h)
    packs.ts         apprentissage des fichiers des packs
    state.ts         état partagé de /play (singletons, injectable en test)
  anime/
    mapping.ts       correspondances anime (module seul, non branché)
  lt/                routes lt et catalogues (hors de ce README)
  routes/
    stream.ts        GET /:config/stream/:type/:id.json
    test.ts          POST /config/test
    play.ts          GET /:config/play/c/:token et GET /:config/play/:infoHash/:fileIdx?
    indexers.ts      POST /config/indexers
tests/               voir la section Tests
```

## Licence

MIT. Voir le fichier [LICENSE](./LICENSE). Copyright (c) 2026 gtko.
