# lastAddon

Addon Stremio agrégateur de streams pour Laststream. Il interroge en parallèle les addons Stremio amont configurés par l'utilisateur (leur seule source : ils débrident eux-mêmes, la clé du débrideur est dans l'addon, par exemple Lumio), filtre les résultats selon les préférences de l'utilisateur (langues, résolutions, qualités, tailles, débit, formats audio, limite d'âge), regroupe les copies d'une même release, les classe, puis les renvoie à Stremio. Il ne débride jamais côté serveur : les torrents sont livrés à l'appareil, qui débride lui-même avec sa propre clé AllDebrid.

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
| `npm run typecheck` | Vérification des types de `src/`, `tests/` et `tests-workers/` |
| `npm run test:workers` | Tests dans le runtime Workers (workerd) : stores sur le Durable Object, routes `/user` (voir « Cloudflare Workers ») |
| `npm run deploy:worker` | Copie le build de l'interface dans `worker-ui/` puis `wrangler deploy` (Worker `lastaddon-core`) |
| `npm run bundle` | Bundle mono-fichier `dist-bundle/lastaddon.cjs` (voir « Distribution ») |
| `npm run seed:demo` | Compte de démonstration local `demo` / `demo` dans la base locale (voir « Compte démo avec toutes les clés ») |

## Compte démo avec toutes les clés

`npm run seed:demo -- --with-keys` crée ou remet à zéro le compte local `demo` et lui applique les clés de services
(TMDB, MDBList, TheTVDB, OpenRouter, Fanart.tv, IntroDB, SkipDB, Anime Skip) lues dans 1Password. Il sert à tester
l'addon avec toutes les clés, sans les saisir à la main.

Prérequis :

- CLI 1Password `op` installée et connectée (`op signin`, ou application 1Password ouverte avec l'intégration CLI) ;
- l'item `Stremio API` contient un champ par clé, dont les noms sont donnés dans `scripts/demo-keys.map.json` ;
- serveur local lancé (`npm run dev`) : le script y lance le test de configuration. Sans lui, le test est ignoré ;
- `LASTADDON_SECRET` présent (dans l'environnement ou dans `.env`) : le serveur le génère au premier lancement.

Commande :

```bash
npm run seed:demo -- --with-keys
```

Variables facultatives : `LASTADDON_OP_VAULT` (coffre, `Private` par défaut), `LASTADDON_SEED_URL` (serveur local,
`http://127.0.0.1:<PORT>` par défaut).

Garde-fous :

- le script n'agit que sur un serveur local (`localhost`, `127.0.0.1` ou `[::1]`) et refuse tout autre hôte, dont `*.workers.dev` ;
- la base écrite doit se trouver dans `LASTADDON_DATA_DIR` (ou `data/`) ; le script refuse tout autre emplacement ;
- aucune valeur de clé n'est affichée, journalisée ni écrite dans le dépôt : le script affiche seulement les noms des
  services configurés et ignorés, et le résultat du test (OK ou échec) ;
- un champ absent de l'item est ignoré avec un avertissement qui ne cite que son nom ;
- la configuration est chiffrée avec `LASTADDON_SECRET` comme celle des comptes réels ; les clés AllDebrid n'y entrent jamais ;
- ne jamais lancer ce script contre la production : le mot de passe du compte `demo` est public.
- le script refuse de suivre une redirection lors du test de configuration (une redirection vers un hôte distant ferait sortir la configuration chiffrée de la machine) ;
- la lecture d'une clé par `op read` attend jusqu'à 60 s (premier déverrouillage biométrique de 1Password).

Après la fusion de la pull request : le commit `f35ce4e` (compte local de démo) n'existe que sur le `main` local de ce dépôt et a été repris dans la branche. Réaligner alors le `main` local sur `origin/main` (`git fetch && git reset --hard origin/main`, jamais `git push`) pour ne pas pousser un commit équivalent.

## Variables d'environnement

Les variables peuvent être passées dans l'environnement ou dans un fichier `.env` à la racine du projet (lu automatiquement, sans dépendance `dotenv`). Un modèle est fourni dans `.env.example`.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LASTADDON_SECRET` | généré | Clé de chiffrement des configurations (AES-256-GCM). **Au moins 32 caractères** : sinon le serveur refuse de démarrer. Si elle est absente, 32 octets aléatoires (base64url) sont générés au premier démarrage et enregistrés dans `.env` à la racine du projet. Elle sert aussi à signer les jetons de lecture `/play/c`. |
| `LASTADDON_ALLOW_PLAIN` | `0` | Mettre `1` pour accepter les configurations en JSON brut encodé en base64url, sans chiffrement. Déconseillé. |
| `LASTADDON_PUBLIC_URL` | aucun | Base publique du serveur (ex. `https://addon.example.com`), utilisée pour construire les URL de lecture `/play`. Validée au démarrage : URL absolue en `http` ou `https` uniquement, sinon le serveur refuse de démarrer. Obligatoire si `LASTADDON_PUBLIC=1`. Sans elle, la base est le protocole et l'hôte de la requête (hors mode public). |
| `LASTADDON_TRUST_PROXY` | `0` | Mettre `1` seulement derrière un reverse proxy de confiance : `X-Forwarded-Proto` et `X-Forwarded-Host` servent alors à construire les liens de lecture. Sans cela, ces en-têtes sont ignorés. |
| `LASTADDON_EDGE_SECRET` | aucun | Secret (16 caractères minimum) partagé avec un relais de confiance, par exemple un Worker Cloudflare. Une requête portant ce secret dans `X-Laststream-Edge` est crue sur `X-Laststream-Client-IP` (IP réelle du client, donc limitation par client) et sur `X-Forwarded-Proto`/`X-Forwarded-Host`. Sans secret valide, ces en-têtes sont ignorés. |
| `TMDB_TOKEN`, `MDBLIST_API_KEY`, `TVDB_API_KEY` (+ `TVDB_PIN`), `OPENROUTER_API_KEY`, `FANART_API_KEY` | aucun | Clés de services **du serveur**, partagées par tous les comptes (secrets Worker : `wrangler secret put`). Précédence : la base serveur (saisie par le propriétaire, chiffrée) prime, puis la variable d'environnement, puis la clé du compte. OpenRouter fait exception : clé du compte, puis `OPENROUTER_API_KEY` (jamais stocké en base). TheTVDB : clé et PIN forment une paire d'une seule source, base (clé + PIN) sinon variables (clé + PIN) ; un PIN seul, en base ou en variable, est ignoré. Jamais renvoyées au client ni journalisées ; `/lt/health` annonce seulement des booléens. Aucune clé de débrideur côté serveur. |
| `LASTADDON_PUBLIC` | `0` | Mettre `1` pour exposer le serveur sur Internet (mode public). Les URL des addons amont saisies dans la configuration ne peuvent plus pointer vers une adresse privée, de boucle locale ou de lien local (voir « Sécurité »). Exige `LASTADDON_PUBLIC_URL`. |
| `LASTADDON_FFMPEG` / `LASTADDON_FFPROBE` | PATH | Binaires de la détection locale des segments de saut (voir « Segments de saut détectés localement »). Sans eux : PATH, puis `bin/` à côté de l'application. `LASTADDON_SKIP_DETECT=0` désactive la détection ; `LASTADDON_SKIP_DETECT_MAX_MB` (400) plafonne les octets lus par job. |
| `LASTADDON_ALLOWED_ORIGINS` | `http://localhost:8089,http://localhost:8080` | Origines (liste séparée par des virgules) autorisées en CORS sur les endpoints `/config/*` et `/user/*`. Les routes manifest et stream restent ouvertes (`*`). |
| `LASTADDON_DATA_DIR` | `./data` | Dossier de la base SQLite des données utilisateur (`laststream.db`). Relatif à la racine du projet. Voir « Données utilisateur ». |
| `LASTADDON_UI_DIR` | aucun | Dossier de l'interface web compilée (contient `index.html`), servi à la racine. Chemin absolu conseillé. Équivalent de `--ui`. Voir « Distribution ». |
| `LASTADDON_STREAMING_SERVER` | `http://127.0.0.1:11470` | Serveur de streaming local relayé sous `/_ss/*` quand l'interface est servie. Origine locale uniquement (`localhost`, `127.0.0.1` ou `[::1]`). Voir « Distribution ». |
| `LASTADDON_ENV_FILE` | `.env` à la racine du projet | Emplacement du fichier `.env` (secret). Chemin absolu conseillé pour une application packagée. Voir « Distribution ». |
| `LASTADDON_ALLOW_SIGNUP` | `0` | Mettre `1` pour ouvrir l'inscription libre (serveur perso). Sinon seul le premier compte s'inscrit sans lien ; les suivants exigent un lien de parrainage (voir [docs/social.md](docs/social.md)). |
| `LASTADDON_BOOTSTRAP_TOKEN` | aucun | Si défini, le premier compte exige l'en-tête `X-Bootstrap-Token` avec cette valeur. Voir « Données utilisateur ». |
| `PORT` | `7000` | Port d'écoute HTTP. |

**Important :** si `LASTADDON_SECRET` change, toutes les configurations déjà chiffrées (et donc toutes les URL de manifest installées) deviennent invalides, ainsi que les liens `/play/c` déjà émis. Sauvegardez cette valeur. Ne la committez jamais : `.env` est dans `.gitignore`.

Les clés API (debrid, services) sont contenues dans la configuration. Le serveur ne les journalise jamais, ne les renvoie jamais, et masque celles qui apparaîtraient dans un message d'erreur.

## Endpoints

| Méthode | Chemin | Description |
| --- | --- | --- |
| GET | `/health` | Santé du serveur, par exemple `{"ok":true,"degraded":false,"release":"lastaddon-core@0.1.0","deps":{"kv":{"ok":true,"ms":3},"r2":{"ok":true,"ms":5},"base":{"ok":true,"ms":12}}}`. `ok` reste `true` tant que le Worker répond ; `degraded` passe à `true` si une dépendance (KV, R2, base) est en panne ou ne répond pas dans 1,5 s. `deps` donne l'état et la durée de chaque sonde. Rapport mis en cache 15 s par instance ; toujours HTTP 200. |
| GET | `/manifest.json` | Manifest Stremio générique (non bloquant, sans configuration) |
| GET | `/:config/manifest.json` | Manifest Stremio pour une configuration chiffrée. Avec `services.tmdbToken`, annonce aussi des catalogues. |
| GET | `/:config/stream/:type/:id.json` | Liste de streams Stremio pour un film ou un épisode |
| GET | `/:config/play/c/:token` | Lecture d'un jeton de copies : essai des copies dans l'ordre (failover), `302` vers le premier lien résolu |
| GET | `/config/schema` | JSON Schema de la configuration, plus la liste des préréglages (`presets`) |
| POST | `/config/encode` | Valide une configuration JSON et renvoie `{"config":"..."}` (chiffrée). Forme `{previous, config}` pour ne pas ressaisir les clés |
| POST | `/config/decode` | Déchiffre `{"config":"..."}` pour le configurateur : chaque secret est remplacé par `{"set":true,"last4":"…xxxx"}`, jamais par sa valeur |
| POST | `/config/test` | Teste chaque source amont et les services d'une configuration (JSON brut, non chiffré) |

Les routes manifest et stream renvoient `Access-Control-Allow-Origin: *`, comme les lectures GET `lt` et catalogues. Les endpoints `/config/*` n'acceptent que les origines de `LASTADDON_ALLOWED_ORIGINS`. Les autres routes, dont `/play`, n'envoient aucun en-tête CORS.

### `GET /:config/stream/:type/:id.json`

- `:type` : `movie` ou `series`. Tout autre type renvoie `{"streams":[]}`.
- `:id` : `tt1234567` pour un film, `tt1234567:S:E` pour un épisode (Stremio encode les deux-points en `%3A`). Un identifiant hors de ce format renvoie `{"streams":[]}`.
- Réponse `200` : `{"streams":[...]}`, avec `Cache-Control: max-age=60`.
- Configuration illisible ou invalide : `400` `{"error":"invalid_config"}`, sans détail sur son contenu.
- Une source en erreur n'empêche jamais les autres de répondre : son erreur n'est pas renvoyée à Stremio.

### `GET /:config/play/c/:token`

Lecture d'un jeton de copies à lien direct, essayées dans l'ordre (voir « Groupement des copies et lecture »). Le moteur n'émet plus de jeton : cette route ne sert qu'aux jetons déjà émis. Le jeton est signé, pas chiffré.

- Réponse `302` : `Location` pointe vers le lien résolu. Réponse jamais mise en cache (`Cache-Control: no-store`).
- Échec : une page HTML en français, ou un JSON `{"error":"play_failed","reason":"...","message":"..."}` si `Accept` demande du JSON. Le statut dépend de la raison (tableau ci-dessous).
- `400` `{"error":"invalid_token"}` si le jeton est malformé ou signé avec une autre clé ; `400` `{"error":"invalid_config"}` si la configuration est illisible.

### `POST /config/test`

Corps : une configuration JSON brute (non chiffrée). Chaque source amont et les services renseignés sont testés en parallèle. Une source d'un ancien type (`torznab`, `prowlarr`, `jackett`) n'est jamais interrogée et est rapportée en erreur.

```json
{
  "sources": [
    { "name": "Mon addon", "type": "upstream", "ok": true }
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
    { "type": "upstream", "name": "Mon addon", "url": "https://exemple.com/stream" }
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
| `resolutions.allowed` | tableau de `2160p`, `1440p`, `1080p`, `720p`, `480p`, `SD` (toutes) | Résolutions autorisées (les streams de résolution inconnue sont gardés) |
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
| `filters.includeHosterLinks` | booléen (`true`) | Conservé pour la compatibilité des configurations : sans effet, le serveur ne contrôle plus les liens d'hébergeurs. |

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
| `debrid` | `{"service":"alldebrid","apiKey":"..."}` (aucun) | Clé AllDebrid utilisée par l'appareil : le serveur ne l'appelle jamais. Un torrent n'est livré sans lien qu'à un appareil qui ajoute `?torrents=1`. |
| `onlyCached` | booléen (`false`) | Ne garder que les torrents déjà en cache debrid et les URL directes. Le serveur ne vérifie pas le cache : ce filtre est appliqué par l'appareil. |
| `preset` | `essentiel`, `zen`, `cinephile`, `nomade` (aucun) | Préréglage de départ (voir « Préréglages ») |
| `services.tmdbToken` | chaîne (aucun) | Jeton de lecture TMDB (API v4). Sert aux métadonnées (durée, certification, date de sortie), aux titres FR et EN, et aux catalogues. Sans lui, la limite d'âge exclut tous les flux. |
| `services.tmdbApiKey`, `services.mdblistApiKey`, `services.tvdbApiKey`, `services.openrouterApiKey`, `services.fanartApiKey`, `services.openrouterModel` | chaînes facultatives (`openai/gpt-4o-mini` pour le modèle) | Clés des services annexes, utilisées par les routes `lt` (non détaillées ici) |

Chaque source est discriminée par son champ `type` :

- `{"type":"upstream","name":"...","url":"https://..."}` : addon Stremio ou API HTTP en amont. L'URL peut être la base de l'addon ou celle de son `manifest.json`.
- Les types `torznab`, `prowlarr` et `jackett` restent acceptés pour la compatibilité des configurations existantes, mais ne sont plus interrogés : leurs sources sont ignorées par la collecte.

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
- **Jeton de lecture** : le moteur n'émet plus de jeton `/play/c/:token`. Les torrents sont livrés à l'appareil (sans URL, avec `?torrents=1`) et les liens directs restent des URL directes. Un jeton émis avant cette version reste lisible : il est signé (HMAC, clé dérivée de `LASTADDON_SECRET`), pas chiffré, et ne contient ni clé API, ni passkey, ni configuration.
- **Basculement** : à la lecture, les copies à lien direct sont essayées une à une dans l'ordre, dans le budget `play.budgetMs` (12 s par défaut). Chaque tentative reçoit le temps restant. Une copie au schéma non http(s) passe à la suivante ; le dépassement du budget arrête tout. Un hôte signalé en panne est marqué pendant 1 h, et ses copies sont sautées.
- **Contrôles avant lecture** : une date de sortie future renvoie `not_released` ; une certification connue au-dessus de la limite d'âge de la configuration renvoie `age_limit`. Aucune lecture n'est tentée dans ces cas.
- **Torrents** : jamais lus par `/play` ; l'appareil les résout lui-même avec `?torrents=1`. Seuls les liens directs restent lisibles côté serveur.
- **Torrents privés** : leurs octets ne peuvent pas être transmis à un débrideur depuis le serveur, donc un torrent privé n'est jamais livré à l'appareil.

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

- **Ce qui est sondé** : les liens directs http(s) uniquement. Un torrent n'est jamais sondé côté serveur.
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
- **Liens vérifiés** (`filters.directVerifiedOnly`) : ne garde que les liens directs dont la disponibilité a été vérifiée par une sonde réussie.
- **Tri** (`sort`) :
  - `default` : score composite (flux non déclassés, langue, résolution, source, préférences audio et mots, HDR, cache), puis la plus petite taille, puis le plus grand nombre de seeders.
  - `heaviest` : niveau de langue, puis le plus lourd d'abord, puis score et seeders.
  - `lightest` : niveau de langue, puis le plus léger d'abord, puis score et seeders.
  - Une taille inconnue passe toujours en dernier.
  - Les flux déclassés (format non supporté en mode `deprioritize`) passent après tous les autres.

### Torrents sans infoHash et torrents privés

- Un release sans infoHash ni magnet, mais avec un lien `.torrent` HTTP(S), est lu : jusqu'à 12 liens par requête, 3 lectures en parallèle, 10 s de délai chacune. L'infoHash et les fichiers du pack sont extraits. Un lien qui redirige vers un magnet est accepté directement.
- Le lien `.torrent` peut contenir une passkey : il reste en mémoire et n'est jamais renvoyé dans une réponse.
- Le flag `private` du .torrent est lu. Les octets d'un torrent privé sont gardés 6 h, par guid de release (200 entrées au plus). Ils ne sont jamais envoyés à un débrideur par le serveur.

### Robustesse

- **Isolation** : chaque étape du pipeline (métadonnées, titres, collecte, lecture des .torrent, sonde, classement) est isolée. Un échec désactive son étape sans faire échouer la requête. Une erreur de source n'est jamais renvoyée à Stremio.
- **Cache des résultats** : LRU de 200 entrées, durée de vie 5 minutes. La clé dépend de la configuration (hachée), du contenu et de la base de lecture. Un résultat où une source a échoué n'est pas mis en cache.
- **Autres caches** : métadonnées TMDB 6 h ; titres TMDB 7 jours ; .torrent 6 h (200 entrées) ; sondes audio 30 jours (5 000 entrées).
- **Hôtes en panne** : un hôte qui renvoie `host_unavailable` pendant une lecture est marqué en panne pendant 1 h. Ses copies sont sautées par le failover.
- **Apprentissage des packs** : les fichiers d'un torrent sont mémorisés dès qu'ils sont connus (lecture du .torrent), jusqu'à 2 000 torrents pendant 30 jours. Pour un épisode de série, le fichier correspondant du pack est retrouvé et remplace le fichier indiqué par la copie. Ce magasin est en mémoire : il est vidé au redémarrage.
- **Remappage anime : partiel.** Le module `src/anime/mapping.ts` (table de correspondance anime vers IMDb, TVDB et TMDB, lecture de la liste de correspondances et des groupes d'épisodes TMDB) est couvert par `tests/anime-mapping.test.ts`, et le pipeline sait l'utiliser (`animeMapper`), mais **le serveur ne l'injecte pas** : aucun numéro absolu n'est remappé aujourd'hui. Les releases en numérotation absolue (« Titre - 05 ») ne sont donc pas écartées faute de remappage, et les requêtes Prowlarr « Titre 05 » ne sont pas envoyées.

### Segments de saut détectés localement

Quand aucune base externe n'a de données, lastAddon détecte lui-même intro, générique de fin, reprise et aperçu, en arrière-plan (un job à la fois, 2 jobs par minute au plus, 400 Mo lus au plus par job (`LASTADDON_SKIP_DETECT_MAX_MB`), ffmpeg tué au délai). Le lecteur rapporte le média réellement lu :

`POST /:config/lt/skip/analyze` avec `{ "type": "series", "imdbId": "tt…", "season": 1, "episode": 3, "mediaUrl": "https://…", "duration": 1440 }` répond 202 `{ "queued": true }` (ou `{ "queued": false, "reason": "known|retry_later|rate_limited|queue_full|no_ffmpeg|disabled" }`). `mediaUrl` doit être en http(s), sans identifiants, ni nom local ni IP privée (seule exception : le serveur de streaming local `127.0.0.1:11470`). L'URL reste en mémoire, jamais en base ni dans les journaux, et ffmpeg ne la voit pas : il lit un relais local qui compte les octets.

Méthodes, par ordre : (1) chapitres du conteneur (`ffprobe -show_chapters`, titres FR/EN/JA), confiance 0,95 ; (2) empreinte audio entre épisodes de la même saison (début : 25 % ou 6 min au plus, fin : 4 min ; Chromaprint via ffmpeg si le muxer existe, sinon empreinte spectrale interne), confiance 0,8 : il faut deux épisodes rapportés pour la première saison analysée (deux appariements tentés par saison au plus, arrêt dès qu'une correspondance sûre est trouvée), ensuite l'empreinte de référence de la saison suffit à reconnaître les suivants ; (3) fichier unique : zone noire de 25 s au moins jusqu'à la fin (blackdetect, silencedetect), confiance 0,6 à 0,7. Les segments sont enregistrés dans `skip_segments` (source `auto`, colonnes `confidence` et `method`) et les empreintes de saison dans `skip_fingerprints`.

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
- `url` : l'URL d'origine d'un lien direct. Absente pour un torrent, livré à l'appareil avec son infoHash.
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
4. **Parsing et premier filtre** : résolution, source, codec, HDR, audio, canaux, langues, variante FR, taille, seeders et infoHash sont analysés. Le premier filtre applique résolutions, tags exclus, qualités, tailles, débit, limite d'âge, non-sortis, 3D, mots bannis, formats audio et langues (avec repli). Les exigences qui dépendent de la sonde sont appliquées à l'étape 6.
5. **Groupement** des copies (voir « Groupement des copies et lecture »).
6. **Classement** et limite par résolution, puis **sonde audio** des `audio.probeTopN` premiers candidats éligibles, puis **second filtre** (langues vérifiées, cache seul, liens vérifiés) et second classement.
10. **Apprentissage des packs** (épisodes trouvés dans un pack connu), puis **formatage** selon le gabarit, tronqué à `maxResults`.

Le résultat complet est gardé 5 minutes dans un cache LRU, sauf si une source a échoué.

## Données utilisateur (`/user/*`)

lastAddon peut stocker pour chaque utilisateur sa bibliothèque, sa progression, ses profils et ses réglages (base SQLite, module `node:sqlite`, Node 22.13 ou plus récent).

**Emplacement.** La base est `data/laststream.db` à la racine du projet, ou `LASTADDON_DATA_DIR/laststream.db` si la variable est définie (chemin relatif à la racine du projet). Le dossier est créé à la première requête sur `/user`. Sous Linux et macOS, le fichier est en `0600`. Sous Windows, ces droits POSIX n'existent pas : protégez le dossier par ses ACL. Pour une sauvegarde à chaud, utilisez `sqlite3 laststream.db ".backup sauvegarde.db"` plutôt que de copier le fichier pendant l'écriture.

**Premier compte (risque à connaître).** Le premier compte créé devient propriétaire. Si `LASTADDON_BOOTSTRAP_TOKEN` est défini, il faut l'en-tête `X-Bootstrap-Token` avec cette valeur pour créer ce premier compte. Sans cette variable, quiconque atteint le serveur avant vous peut créer ce compte. Pour un usage local mono-utilisateur, ce risque est acceptable. Pour un serveur exposé sur Internet, définissez `LASTADDON_BOOTSTRAP_TOKEN`.

**Inscription.** Les comptes suivants ne sont créés qu'avec un lien de parrainage (`invite` dans le corps de `/user/register`), ou si `LASTADDON_ALLOW_SIGNUP=1`. Amis, présence, bibliothèques partagées, titres masqués et watch party : [docs/social.md](docs/social.md). Un nom déjà pris renvoie `409 username_taken`, ce qui révèle qu'il existe. Ce choix est assumé : `/user/register` est limité à 10 requêtes par minute et par IP.

**Sessions.** Un jeton de 256 bits, valable 180 jours, renouvelé par `POST /user/refresh` (l'ancien jeton cesse de valoir). Un compte garde au plus 20 sessions : la plus ancienne est supprimée au-delà. `POST /user/logout-all` ferme toutes les sessions. `POST /user/password` change le mot de passe et ferme les autres sessions. `DELETE /user/account` supprime le compte et toutes ses données, après confirmation du mot de passe.

**Profils protégés par PIN.** Le PIN fait 4 chiffres. Après 5 échecs, le profil est bloqué 5 minutes (`429 pin_locked`, en-tête `Retry-After`) et le PIN n'est même pas vérifié pendant ce blocage. Le déverrouillage (`POST /user/profiles/:id/unlock`) renvoie un jeton valable 30 jours, lié à la session et à la version du PIN : il est refusé après une déconnexion ou un changement de PIN. Le client appelle `POST /user/profiles/:id/lock` au changement de profil (sans effet côté serveur). Toutes les routes de données d'un profil protégé (bibliothèque, progression, réglages, import) exigent ce jeton dans l'en-tête `X-Profile-Token`. **Gestion des profils** (création, modification, suppression) : réservée au profil principal du compte (`X-Profile-Id` = profil principal, plus son jeton de PIN s’il en a un), sinon `403 main_profile_required` ; seule exception, un profil adulte peut changer son propre PIN.

**Limites de débit** (en mémoire, par processus, par IP et par minute) : lectures 300, écritures 120, routes sensibles 10 (`/register`, `/login`, `/password`, `DELETE /account`, `/unlock`, import Stremio). `/login` est aussi limité à 10 tentatives par minute et par nom d'utilisateur.

**Import Stremio.** `POST /user/profiles/:id/import/stremio` lit la bibliothèque d'un compte Stremio (au plus 5000 entrées). Les identifiants Stremio servent une seule fois, ne sont ni stockés ni journalisés.

## Distribution

lastAddon peut être livré comme un fichier unique, `dist-bundle/lastaddon.cjs`, avec l'interface Laststream, pour une application de bureau ou mobile. Le bundle est un CommonJS pour Node 22 qui inclut toutes les dépendances npm. Seuls les modules `node:` restent externes, dont `node:sqlite` pour les données utilisateur. Il faut Node.js 22.13 ou plus récent, où `node:sqlite` est disponible sans option.

### Construction

```
npm run bundle
```

La commande produit `dist-bundle/lastaddon.cjs` avec esbuild (`platform: node`, `target: node22`). Le dossier `dist-bundle/` est ignoré par Git.

### Lancement

```
node dist-bundle/lastaddon.cjs --port 7000 --ui ./ui --data ./donnees
```

| Option | Équivalent | Rôle |
| --- | --- | --- |
| `--port <n>` | `PORT` | Port d'écoute. Prioritaire sur `PORT`. |
| `--ui <dossier>` | `LASTADDON_UI_DIR` | Interface web compilée, servie à la racine. Le dossier doit contenir `index.html`, sinon le serveur refuse de démarrer. |
| `--data <dossier>` | `LASTADDON_DATA_DIR` | Dossier de la base `laststream.db` (données utilisateur). |

Les chemins passés en ligne de commande sont résolus depuis le répertoire courant. Une option inconnue ou sans valeur arrête le démarrage avec un message.

**Interface web.** Quand `LASTADDON_UI_DIR` ou `--ui` est défini, l'interface est servie à la racine :

- `index.html` et `service-worker.js` ne sont jamais mis en cache (`no-cache`). Les fichiers de `/assets/*` le sont longtemps (`max-age=31536000, immutable`).
- Une navigation inconnue (GET avec `Accept: text/html`) reçoit `index.html`. Les requêtes de scripts ou d'images inconnues renvoient 404.
- Les routes de l'API restent prioritaires : `/health`, `/manifest.json`, `/config/*`, `/user/*` et `/:config/…`.
- L'origine du même site est ajoutée automatiquement aux origines CORS : `http://localhost:<port>`, `http://127.0.0.1:<port>`, et l'origine de `LASTADDON_PUBLIC_URL` si elle est définie.

**Relais du streaming (`/_ss/*`).** Le serveur Stremio local n'envoie du CORS qu'aux domaines strem.io. Quand l'interface est servie, `/_ss/<chemin>?<requête>` est donc relayé vers `LASTADDON_STREAMING_SERVER/<chemin>?<requête>` (défaut `http://127.0.0.1:11470`) :

- le corps est transmis en flux, sans tampon, avec `Range`, `206`, `Content-Range`, `Accept-Ranges`, `Content-Type` et `Content-Length` (playlists et segments HLS, `/hlsv2/*`, sous-titres, `/probe`, etc.) ;
- seuls GET et HEAD sont acceptés (405 sinon) ; les en-têtes `Cookie`, `Authorization` et les jetons de profil ne sont jamais transmis ;
- la cible doit être une origine locale (`localhost`, `127.0.0.1` ou `[::1]`), sans chemin : sinon le serveur refuse de démarrer ;
- le délai maximal est de 60 secondes pour recevoir les en-têtes, sans délai global sur le flux. Si le client part, la connexion amont est fermée. Si le serveur de streaming est injoignable, la réponse est un `502` (`streaming_server_unavailable`).

**Signal de disponibilité.** Une fois à l'écoute, le serveur écrit sur sa sortie standard la ligne `LASTADDON_READY port=<n>`. L'application packagée attend cette ligne avant d'ouvrir l'interface. Une ligne lisible « lastAddon en écoute » est écrite juste avant.

### Emplacements des fichiers

Les défauts restent ceux du projet : `.env` et `data/` à la racine du projet. Dans le bundle, la racine est le dossier de `lastaddon.cjs`. Une application packagée doit donc fixer les deux emplacements :

| Variable | Contenu |
| --- | --- |
| `LASTADDON_DATA_DIR` (ou `--data`) | Base `laststream.db`. Créée au besoin. |
| `LASTADDON_ENV_FILE` | Fichier `.env` avec `LASTADDON_SECRET`. |

Exemple PowerShell sous Windows, avec les données dans `%APPDATA%` :

```
$env:LASTADDON_UI_DIR = "C:\Laststream\ui"
$env:LASTADDON_DATA_DIR = "$env:APPDATA\Laststream\lastaddon"
$env:LASTADDON_ENV_FILE = "$env:APPDATA\Laststream\lastaddon\.env"
node dist-bundle\lastaddon.cjs --port 7000
```

Si `LASTADDON_SECRET` est absent, une clé est générée dans le fichier `.env` au premier démarrage. Si ce fichier change d'emplacement, les configurations déjà chiffrées ne se déchiffrent plus : conservez le fichier `.env` avec les données.

## Cloudflare Workers

Le même code tourne sur Node et sur Cloudflare Workers (`src/worker.ts`, configuration `wrangler.jsonc`, Worker `lastaddon-core`). Seule la plateforme change (`src/platform/node/` ou `src/platform/workers/`) :

| Besoin | Node | Workers |
| --- | --- | --- |
| Variables | `process.env` | variables et secrets du Worker (`EDGE_SECRET` lu comme `LASTADDON_EDGE_SECRET`) |
| Données utilisateur | SQLite local (`node:sqlite`) | Durable Object SQLite `UserStoreDO` (objet global « users », appelé en RPC) |
| Caches partagés | mémoire du processus | KV (`CACHE`) : fichiers des packs, URL émises, .torrent privés, hébergeurs en panne |
| Tâches d'arrière-plan | timers | `ctx.waitUntil` |
| Interface web | dossier (`LASTADDON_UI_DIR`) | Workers Assets (`worker-ui/`, build de laststream-app) |
| IP du client | socket | `CF-Connecting-IP` |
| ffmpeg (miniatures serveur, détection des segments de saut), proxy HLS TV | oui | non (miniatures lues sur l'appareil) |

**Stockage.** `UserStore` et `SkipSegmentStore` sont synchrones et ne dépendent que de `SqlDb` (`src/user/sql.ts`) : `node:sqlite` sous Node, le SQLite du Durable Object sous Workers (transactions par `transactionSync`). Le code applicatif n'appelle que les dépôts asynchrones `UserRepo` / `SkipRepo` (`src/user/repo.ts`), fournis par `platform().createUserBackend()`. Limite : un seul Durable Object traite toutes les requêtes une à la fois (quelques centaines par seconde, 10 Go) ; au-delà, partitionner par compte. Les limites de débit restent en mémoire, par isolat.

**Déploiement.** Secrets (stdin, jamais affichés) : `LASTADDON_SECRET`, `EDGE_SECRET`, et `LASTADDON_BOOTSTRAP_TOKEN` pour protéger le premier compte. Facultatifs, relais TURN de la watch party (Cloudflare Realtime TURN, identifiants de 24 h remis à chaque participant) : `TURN_KEY_ID` et `TURN_KEY_API_TOKEN` ; absents, la watch party reste en STUN seul. Puis `npm run deploy:worker` (option `--ui <dossier>` ou `LASTADDON_UI_SOURCE` pour le build de l'interface). Tests : `npm run test:workers`.

### TV en direct sur Workers (Cron + R2)

Un Worker ne peut ni télécharger 32 Mo de JSON iptv-org ni décompresser 256 Mo d'EPG dans la mémoire d'un isolat (128 Mo). Un Cron Trigger (`0 */6 * * *`, `wrangler.jsonc`) exécute donc `scheduled()` (`src/worker.ts`) : `src/lt/tv-build.ts` lit les sources **en flux** (`src/lt/json-stream.ts`, `DecompressionStream` pour l'XMLTV), ne garde que les chaînes des pays `TV_COUNTRIES` (défaut `FR,BE,CH,LU,CA,MC`) et l'EPG de ces chaînes de maintenant à +24 h, puis écrit `catalog.json`, `epg.json` et `probe.json` dans le bucket R2 `lastaddon-tv` (à créer une fois : `npx wrangler r2 bucket create lastaddon-tv`). Les routes `/lt/tv/*` lisent R2 (cache mémoire de 5 min) ; R2 encore vide : `503 tv_building` et construction lancée en arrière-plan (verrou KV).

Le proxy HLS reste désactivé (`tvHls: false`, annoncé par `/lt/health`) : les chaînes sont renvoyées avec `sig: null` et le lecteur lit l'URL du flux directement (hls.js, mpv, libVLC). Le Cron sonde chaque flux https (requête avec l'origine de l'application, réponse `Access-Control-Allow-Origin`) et renseigne `direct` (`true` lisible depuis une page web, `false` : http ou sans CORS, absent : inconnu). `GET /lt/tv/channels?direct=1` écarte les chaînes dont aucun flux n'est lisible sans relais (pages web) ; mpv et libVLC n'en ont pas besoin et gardent tout.

### Migration des données vers le Durable Object

`npx tsx scripts/export-cloud.ts [--db fichier] [--url https://…] [--force] [--dry-run] [--verify-only]` copie les tables utilisateur d'une base
SQLite locale (ouverte en lecture seule ; arrêter le service local avant l'export final) vers le Durable Object, par lots transactionnels, via la
route `/__admin/` du Worker (en-tête `x-admin-secret`, secret wrangler `ADMIN_SECRET`, lu dans `%APPDATA%\Laststreamdmin.secret` ou la variable
`ADMIN_SECRET`). L'import est refusé si le Durable Object n'est pas vide (sauf `--force`, qui le vide d'abord). Le script compare ensuite nombre
de lignes et SHA-256 par table (`GET /__admin/counts`). La route répond 404 sans `ADMIN_SECRET` : `wrangler secret delete ADMIN_SECRET` la ferme.

Connexion et inscription : binding Rate Limiting (`AUTH_LIMITER_IP`, `AUTH_LIMITER_USER`), 10 tentatives par minute (la période d'un binding vaut 10 ou
60 s, pas 15 minutes ; le comptage est par emplacement Cloudflare et approximatif).

Routes sensibles (`/config`, `/lt`, `/user`, `/admin`, `/party`, tickets du flux social, frappe) et mises à niveau WebSocket : la Map en mémoire de `src/rate-limit.ts` est par isolat (la limite réelle croît avec le nombre d'instances), donc chaque limite ajoute une seconde barrière, les bindings `RL_*` de `wrangler.jsonc` (`src/rate-limit-shared.ts` ; sans binding, la Map locale reste seule). Chaque refus partagé journalise un identifiant d'isolat aléatoire (`wrangler tail`, filtre `[rate-limit] refus`) : le nombre d'identifiants distincts estime le nombre d'instances actives. Dans les Durable Objects (singletons, donc réellement globaux), le flux social plafonne les trames (30 par minute glissante et par profil, fermeture 4008) et les connexions (5 par profil, les plus anciennes évincées) ; un salon ferme 4008 une connexion au-delà de 500 trames par 10 s (`src/ws-limits.ts`).

## Sécurité

**Risque SSRF.** Les URL des sources (addons amont) sont saisies par l'utilisateur et appelées par le serveur. Sans précaution, une URL peut viser le réseau interne (ex. `http://192.168.1.1`, `http://169.254.169.254` sur un cloud). Protections appliquées à chaque requête :

- schémas `http` et `https` uniquement ;
- redirections gérées à la main (`redirect: manual`) : au plus 3, chaque saut est revalidé ;
- corps de réponse limité à 2 Mo, lecture interrompue au-delà ;
- délai maximal par requête (8 s par défaut).

**Mode public (`LASTADDON_PUBLIC=1`).** Pour un serveur exposé sur Internet, l'hôte de chaque URL est contrôlé et la requête est refusée si une adresse est privée, de boucle locale, lien local, CGNAT (100.64/10), ULA (fc00::/7) ou autre plage non publique, en IPv4 comme en IPv6. Les connexions passent par un agent au DNS épinglé : l'adresse est contrôlée au moment de la connexion, et pas seulement avant, ce qui couvre aussi le DNS rebinding. Les lectures de fichiers (sondes média, .torrent) suivent la même règle. Un pare-feu sortant reste recommandé.

**Autres protections.** Les endpoints `/config/*` acceptent le CORS uniquement pour `LASTADDON_ALLOWED_ORIGINS` et sont limités à 30 requêtes par minute et par IP (compteur en mémoire, par processus). Les messages d'erreur masquent les clés API sous leurs formes brute, URL-encodée et base64. Les jetons `/play/c` sont signés avec une clé dérivée de `LASTADDON_SECRET` ; ils ne contiennent ni clé API ni passkey. Les URL de téléchargement des indexeurs (qui peuvent porter une passkey) ne sont jamais renvoyées.

### Garde de sortie (AllDebrid interdit côté serveur)

AllDebrid suspend les comptes appelés depuis des IP de serveurs. Le serveur, Worker `lastaddon-core` compris, ne contacte donc jamais AllDebrid ni les hôtes `*.debrid.it` : le débridage, la lecture et les miniatures passent par l'appareil, avec son IP et sa propre clé.

- Toute tentative d'envoi vers AllDebrid ou `*.debrid.it` est bloquée avant l'envoi : elle échoue avec le code `server_side_disabled`.
- Chaque blocage émet un événement Sentry de niveau `error`.
- Le test `tests/no-server-debrid.test.ts` veille à ce qu'aucun code de `src/` ne réintroduise un appel vers AllDebrid côté serveur.

## Tests

```bash
npm test
```

Les tests n'effectuent aucun appel réseau : les sources, Cinemeta, TMDB et les sondes sont simulés par un `fetch` injecté dans les dépendances. Les clés de test sont factices.

| Fichier | Couverture |
| --- | --- |
| `tests/config.test.ts`, `tests/config-v2.test.ts`, `tests/config-presets.test.ts`, `tests/config-env.test.ts` | Schéma, défauts, préréglages, chiffrement, variables d'environnement |
| `tests/app.test.ts`, `tests/app-cors.test.ts`, `tests/http-layer.test.ts` | Endpoints HTTP, validation d'entrée, CORS, socle Hono (corps JSON, ETag, 404, IP du client) |
| `tests/platform.test.ts` | Plateforme Node : variables d'exécution, cache KV, planificateur, fichiers de l'interface |
| `tests/parse-*.test.ts` | Parseurs (vidéo, taille, seeders, langues) et intégration `parseRelease` / `parseRawStream` |
| `tests/sources-*.test.ts` | Sources amont, collecte, partage des sources |
| `tests/engine-*.test.ts`, `tests/pipeline-v2.test.ts` | Filtre, filtres v2, groupement des copies, classement, formatage, gabarits, sonde, Cinemeta, TMDB, pipeline |
| `tests/play*.test.ts` | Endpoint de lecture, jeton de copies, failover, raisons d'échec, hôtes en panne, packs |
| `tests/media-*.test.ts`, `tests/torrent-*.test.ts` | Sonde MKV/MP4, cache de sondes, pistes audio, lecture des .torrent |
| `tests/cache-lru.test.ts`, `tests/anime-mapping.test.ts` | Cache LRU, remappage anime (module seul) |
| `tests/e2e.test.ts` | Parcours complet sur un serveur réel : agrégation, cache debrid, série, config chiffrée, journalisation |

## Structure du projet

```
src/
  server.ts          point d'entrée Node (installe la plateforme Node, sert createApp() avec @hono/node-server)
  bundle.ts          point d'entrée du bundle mono-fichier (npm run bundle)
  cli.ts             options de ligne de commande (--port, --ui, --data)
  ui.ts              interface web statique, repli de navigation, origines du même site
  streaming-proxy.ts relais same-origin /_ss/* vers le serveur de streaming local
  app.ts             createApp() : application Hono (routes, CORS, limites de débit, gestion d'erreurs)
  http/              socle Hono commun : types d'application, corps JSON (64 ko), ETag, 404/500, IP du client
  worker.ts          point d'entrée Cloudflare Workers (installe la plateforme Workers, sert createApp())
  platform/          interfaces d'hôte : RuntimeEnv, KvCache, HttpClient, Scheduler, Capabilities, UiAssets, UserBackend (+ node/, workers/)
  deps.ts            dépendances injectées (secret, allowPlain, fetch)
  pipeline.ts        getStreams() : orchestration du pipeline (métadonnées, collecte, groupement, cache, sonde, formatage)
  types.ts           types partagés (RawStream, ParsedRelease, StremioStream, ContentRef)
  cache/
    lru.ts           cache LRU à durée de vie, clé de configuration hachée
  config/
    schema.ts        schéma zod, défauts, parseConfig, JSON Schema
    presets.ts       préréglages Essentiel, Zen, Cinéphile, Nomade
    codec.ts         chiffrement AES-256-GCM de la configuration
    secret.ts        LASTADDON_SECRET (via RuntimeEnv) ; la lecture et la création du .env sont dans platform/node/secret-file.ts
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
    query-titles.ts  titres FR et EN (TMDB) et requêtes texte
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
    tmdb-meta.ts     certification FR, date de sortie, durée (TMDB)
    cinemeta.ts      durées (Cinemeta, avec cache)
    templates.ts     gabarits d'affichage (Détaillé, Netflix, Compact, Direct)
    format.ts        formatage des streams Stremio, jetons /play/c, objet laststream
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
    play.ts          GET /:config/play/c/:token
tests/               voir la section Tests
```

## Licence

MIT. Voir le fichier [LICENSE](./LICENSE). Copyright (c) 2026 gtko.
