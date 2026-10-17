# lastAddon

Addon Stremio agrégateur de streams pour Laststream. Il interroge en parallèle plusieurs sources (addons Stremio amont et indexeurs Torznab), filtre les résultats selon les préférences de l'utilisateur (langues, résolutions, tailles, tags exclus), supprime les doublons, les classe, puis les renvoie à Stremio. Avec AllDebrid, il indique quels torrents sont déjà en cache et débride la lecture à la demande.

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
| `LASTADDON_SECRET` | généré | Clé de chiffrement des configurations (AES-256-GCM). **Au moins 32 caractères** : sinon le serveur refuse de démarrer. Si elle est absente, 32 octets aléatoires (base64url) sont générés au premier démarrage et enregistrés dans `.env` à la racine du projet. |
| `LASTADDON_ALLOW_PLAIN` | `0` | Mettre `1` pour accepter les configurations en JSON brut encodé en base64url, sans chiffrement. Déconseillé. |
| `LASTADDON_PUBLIC_URL` | aucun | Base publique du serveur (ex. `https://addon.example.com`), utilisée pour construire les URL de lecture `/play`. Validée au démarrage : URL absolue en `http` ou `https` uniquement, sinon le serveur refuse de démarrer. Obligatoire si `LASTADDON_PUBLIC=1`. Sans elle, la base est le protocole et l'hôte de la requête (hors mode public). |
| `LASTADDON_TRUST_PROXY` | `0` | Mettre `1` seulement derrière un reverse proxy de confiance : `X-Forwarded-Proto` et `X-Forwarded-Host` servent alors à construire les liens de lecture. Sans cela, ces en-têtes sont ignorés. |
| `LASTADDON_PUBLIC` | `0` | Mettre `1` pour exposer le serveur sur Internet (mode public). Les URL saisies dans les sources (upstream, Torznab) ne peuvent plus pointer vers une adresse privée, de boucle locale ou de lien local (voir « Sécurité »). Exige `LASTADDON_PUBLIC_URL`. |
| `LASTADDON_ALLOWED_ORIGINS` | `http://localhost:8089,http://localhost:8080` | Origines (liste séparée par des virgules) autorisées en CORS sur les endpoints `/config/*`. Les routes manifest et stream restent ouvertes (`*`). |
| `PORT` | `7000` | Port d'écoute HTTP. |

**Important :** si `LASTADDON_SECRET` change, toutes les configurations déjà chiffrées (et donc toutes les URL de manifest installées) deviennent invalides. Sauvegardez cette valeur. Ne la committez jamais : `.env` est dans `.gitignore`.

Les clés API (sources Torznab, debrid) sont contenues dans la configuration. Le serveur ne les journalise jamais, ne les renvoie jamais, et masque celles qui apparaîtraient dans un message d'erreur d'indexeur.

## Endpoints

| Méthode | Chemin | Description |
| --- | --- | --- |
| GET | `/health` | Santé du serveur : `{"ok":true}` |
| GET | `/manifest.json` | Manifest Stremio générique (non bloquant, sans configuration) |
| GET | `/:config/manifest.json` | Manifest Stremio pour une configuration chiffrée |
| GET | `/:config/stream/:type/:id.json` | Liste de streams Stremio pour un film ou un épisode |
| GET | `/:config/play/:infoHash/:fileIdx?` | Lecture débridée d'un torrent : redirection `302` vers le lien AllDebrid |
| GET | `/config/schema` | JSON Schema de la configuration |
| POST | `/config/encode` | Valide une configuration JSON et renvoie `{"config":"..."}` (chiffrée). Forme `{previous, config}` pour ne pas ressaisir les clés |
| POST | `/config/decode` | Déchiffre `{"config":"..."}` pour le configurateur : chaque secret est remplacé par `{"set":true,"last4":"…xxxx"}`, jamais par sa valeur |
| POST | `/config/test` | Teste chaque source d'une configuration (JSON brut, non chiffré) |

Toutes les routes renvoient `Access-Control-Allow-Origin: *`.

### `GET /:config/stream/:type/:id.json`

- `:type` : `movie` ou `series`. Tout autre type renvoie `{"streams":[]}`.
- `:id` : `tt1234567` pour un film, `tt1234567:S:E` pour un épisode (Stremio encode les deux-points en `%3A`). Un identifiant hors de ce format renvoie `{"streams":[]}`.
- Réponse `200` : `{"streams":[...]}`, avec `Cache-Control: max-age=60`.
- Configuration illisible ou invalide : `400` `{"error":"invalid_config"}`, sans détail sur son contenu.
- Une source en erreur n'empêche jamais les autres de répondre : son erreur n'est pas renvoyée à Stremio.

### `GET /:config/play/:infoHash/:fileIdx?`

Paramètres optionnels `?s=S&e=E` pour un épisode (durée et sélection du fichier vidéo), `?filename=NOM&size=OCTETS` pour le nom et la taille attendus du fichier (ajoutés par le moteur avec un index de fichier). Le fichier est choisi par nom attendu, puis taille attendue, puis épisode, et l'index n'est retenu que si sa taille correspond. Réponses :

| Statut | Cas |
| --- | --- |
| `302` | Lien AllDebrid prêt : `Location` pointe vers le fichier débridé |
| `400` | Hash ou index de fichier invalide, ou configuration invalide |
| `404` | Configuration sans debrid |
| `503` | Torrent pas encore prêt chez AllDebrid (`Retry-After: 5`) |
| `502` | Erreur AllDebrid |

Cette réponse n'est jamais mise en cache (`Cache-Control: no-store`).

### `POST /config/test`

Corps : une configuration JSON brute (non chiffrée). Chaque source et le compte AllDebrid sont testés en parallèle.

```json
{
  "sources": [
    { "name": "Mon addon", "type": "upstream", "ok": true },
    { "name": "Indexeur", "type": "torznab", "ok": false, "error": "Source \"Indexeur\" : erreur Torznab : ..." },
    { "name": "AllDebrid", "type": "alldebrid", "ok": true }
  ]
}
```

`error` est absent quand `ok` vaut `true`. Un corps invalide renvoie `400` `{"error":"invalid_config","issues":[...]}`, qui ne contient que des chemins et des messages, jamais les valeurs saisies.

### `POST /config/encode`

Corps : une configuration JSON, ou `{"previous":"<chaîne chiffrée>","config":{...}}`. Dans la seconde forme, chaque secret vide, absent ou masqué (`{"set":true}` ou `"…xxxx"`) garde la valeur de `previous`. Une section `services` absente garde tous ses secrets ; un objet `debrid` absent retire le debrid. Réponse : `{"config":"<chaîne chiffrée>"}`. Un corps invalide renvoie `400` avec la liste des chemins fautifs.

### `POST /config/decode`

Corps : `{"config":"<chaîne chiffrée>"}`. Réponse : la configuration déchiffrée, avec `services.*` (dont `tvdbPin`), `debrid.apiKey` et `sources[].apiKey` remplacés par leur masque. Jamais de valeur secrète, `Cache-Control: no-store`.

## Format de la configuration

La configuration est un objet JSON. Tous les champs sont optionnels : les valeurs par défaut s'appliquent. Le JSON Schema complet est disponible sur `GET /config/schema`.

| Champ | Type | Défaut | Description |
| --- | --- | --- | --- |
| `languages.preferred` | tableau de `fr`, `en`, `es`, `de`, `it`, `multi`, `original` | `["fr","multi"]` | Langues préférées, de la plus à la moins souhaitée |
| `languages.acceptVostfr` | booléen | `true` | Accepter les VOSTFR (sous-titres français seuls) |
| `languages.fallbackToOthers` | booléen | `true` | Afficher les autres langues s'il n'y a rien dans ma langue. Si aucun stream ne correspond aux langues préférées, les streams des autres langues sont renvoyés (mêmes filtres de qualité, taille et tags exclus), avec le préfixe « Autre langue · » sur la première ligne de description et `laststream.languageFallback: true`. Si au moins un stream est dans une langue préférée, le comportement est strict. |
| `resolutions.allowed` | tableau de `2160p`, `1080p`, `720p`, `480p`, `SD` | toutes | Résolutions autorisées (les streams de résolution inconnue sont gardés) |
| `resolutions.max` | résolution | aucun | Résolution maximale |
| `excludedTags` | tableau de chaînes | `["CAM","TS","SCR"]` | Tags de qualité exclus (correspondance par mot entier) |
| `size.minGb` / `size.maxGb` | nombre positif | aucun | Taille globale min / max (Go) |
| `size.perResolution` | objet `résolution -> {minGb?, maxGb?}` | aucun | Bornes de taille par résolution |
| `maxResults` | entier entre 1 et 500 | `30` | Nombre maximal de streams renvoyés |
| `sources` | tableau de sources (voir ci-dessous) | `[]` | Sources à interroger |
| `debrid` | `{"service":"alldebrid","apiKey":"..."}` | aucun | Service debrid optionnel |
| `onlyCached` | booléen | `false` | Ne garder que les torrents déjà en cache debrid et les URL directes |

Chaque source est discriminée par son champ `type` :

- `{"type":"upstream","name":"...","url":"https://..."}` : addon Stremio ou API HTTP en amont. L'URL peut être la base de l'addon ou celle de son `manifest.json`.
- `{"type":"torznab","name":"...","baseUrl":"https://...","apiKey":"...","categories":[2000]}` : indexeur Torznab (Jackett, Prowlarr ou compatible). `categories` est optionnel.

Les URL doivent être en `http` ou `https`.

## Exemple

Fichier `config.json` :

```json
{
  "languages": { "preferred": ["fr", "multi"], "acceptVostfr": true, "fallbackToOthers": true },
  "resolutions": { "allowed": ["1080p", "720p"], "max": "1080p" },
  "excludedTags": ["CAM", "TS", "SCR"],
  "size": { "minGb": 0.5, "maxGb": 30, "perResolution": { "1080p": { "maxGb": 15 } } },
  "maxResults": 30,
  "sources": [
    { "type": "upstream", "name": "Mon addon", "url": "https://exemple.com/stream" },
    { "type": "torznab", "name": "Indexeur", "baseUrl": "https://indexeur.example.com/api", "apiKey": "VOTRE_CLE", "categories": [2000, 5000] }
  ],
  "debrid": { "service": "alldebrid", "apiKey": "VOTRE_CLE" },
  "onlyCached": false
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

### Mode JSON brut (déconseillé)

Avec `LASTADDON_ALLOW_PLAIN=1`, une configuration peut être passée sans chiffrement, comme JSON encodé en base64url :

```bash
node -p "Buffer.from(require('fs').readFileSync('config.json','utf8')).toString('base64url')"
```

Sans cette variable, seules les configurations chiffrées par `/config/encode` sont acceptées.

## Format des streams

Chaque stream renvoyé suit le format Stremio, avec un champ `laststream` propre à lastAddon.

- `name` : `lastAddon` suivi d'un saut de ligne et de la résolution (`?` si elle est inconnue).
- `description` : trois lignes, sans emoji, par exemple :

  ```
  1080p · WEB-DL · AVC · HDR10
  VFF · 5.1 DDP
  4,2 Go · AllDebrid · Cache · Mon addon
  ```

  Ligne 1 : résolution, source, codec, HDR. Ligne 2 : variante de langue (`VFF`, `VFQ`, `TRUEFRENCH`, `MULTi`, `VF`, `VOSTFR`, `VO`) et audio. Ligne 3 : taille en Go ou Mo, mode de livraison (`AllDebrid` ou `P2P · N seeders`), `Cache` si le torrent est déjà en cache, nom de la source.
- `url` : pour une URL directe amont, l'URL d'origine. Avec AllDebrid, l'URL `/:config/play/:infoHash[/:fileIdx]`. Absent en P2P.
- `infoHash` et `fileIdx` (et `sources`) : présents en P2P, sans debrid.
- `behaviorHints` : `filename`, `videoSize` (octets), `bingeGroup` (`lastaddon|<résolution>|<langue>|<source>`), `notWebReady` (HEVC, AV1, REMUX ou audio DTS/TrueHD).
- `laststream` :

| Champ | Contenu |
| --- | --- |
| `resolution`, `height` | Résolution (`1080p`, ...) et hauteur en pixels |
| `source`, `codec`, `hdr` | Source (`WEB-DL`, `REMUX`, ...), codec (`HEVC`, `AVC`, `AV1`), formats HDR |
| `languages`, `frVariant` | Langues détectées et variante française éventuelle |
| `sizeBytes`, `seeders` | Taille en octets et nombre de seeders, si connus |
| `cached` | `true` si le torrent est en cache debrid |
| `score` | Score de classement (entier, plus haut = meilleur) |
| `estBitrateKbps` | Débit moyen estimé en kb/s : taille × 8 ÷ durée. `null` si la durée ou la taille est inconnue. La durée vient de Cinemeta (épisode si connu, sinon film ou série). |

## Fonctionnement

Pour une requête de streams, le pipeline est le suivant :

1. **Collecte** : toutes les sources sont interrogées en parallèle. Une source en erreur est ignorée ; les autres résultats sont conservés.
2. **Parsing** : le nom, le nom de fichier et la description de chaque stream sont analysés (résolution, source, codec, HDR, audio, langues, variante FR, taille, seeders, infoHash). Les champs structurés fournis par la source (taille, seeders, infoHash, index de fichier) l'emportent sur ceux extraits du texte.
3. **Filtre** : résolution, tags exclus, bornes de taille, langues. Une VO sans sous-titres ni langue préférée est écartée.
4. **Déduplication** : deux streams sont fusionnés s'ils ont le même infoHash (et le même index de fichier), ou le même nom normalisé et une taille égale au Mo près. Le meilleur représentant est gardé : cache, puis seeders, puis URL directe.
5. **Cache debrid** (si `debrid` est configuré) : voir la section suivante.
6. **Classement** : par langue, puis résolution, puis source, puis HDR, puis cache. À égalité, la plus petite taille gagne, puis le plus grand nombre de seeders. La langue la plus préférée passe avant les autres ; une variante FR exacte (`VFF`, `TRUEFRENCH`, `VF2`, `FRENCH`) passe devant un `MULTi` du même rang.
7. **Formatage** : les streams sont tronqués à `maxResults`.

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

## Sécurité

**Risque SSRF.** Les URL des sources (addons amont, indexeurs Torznab) sont saisies par l'utilisateur et appelées par le serveur. Sans précaution, une URL peut viser le réseau interne (ex. `http://192.168.1.1`, `http://169.254.169.254` sur un cloud). Protections appliquées à chaque requête :

- schémas `http` et `https` uniquement ;
- redirections gérées à la main (`redirect: manual`) : au plus 3, chaque saut est revalidé ;
- corps de réponse limité à 2 Mo, lecture interrompue au-delà ;
- délai maximal par requête (8 s par défaut).

**Mode public (`LASTADDON_PUBLIC=1`).** Pour un serveur exposé sur Internet, l'hôte de chaque URL est résolu (DNS) et la requête est refusée si une adresse est privée, de boucle locale, lien local, CGNAT (100.64/10), ULA (fc00::/7) ou autre plage non publique, en IPv4 comme en IPv6. Limite connue : la résolution est vérifiée avant la connexion, sans l'épingler ; un DNS qui change sa réponse entre les deux (DNS rebinding) n'est pas couvert. Un pare-feu sortant reste recommandé.

**Autres protections.** Les endpoints `/config/*` acceptent le CORS uniquement pour `LASTADDON_ALLOWED_ORIGINS` et sont limités à 30 requêtes par minute et par IP (compteur en mémoire, par processus). Les messages d'erreur masquent les clés API sous leurs formes brute, URL-encodée et base64.

## Tests

```bash
npm test
```

Hors smoke test (ci-dessous), les tests n'effectuent aucun appel réseau : les sources, Cinemeta et AllDebrid sont simulés par un `fetch` injecté dans les dépendances. Les clés de test sont factices.

| Fichier | Couverture |
| --- | --- |
| `tests/config.test.ts` | Schéma, défauts, chiffrement |
| `tests/app.test.ts` | Endpoints HTTP, validation d'entrée |
| `tests/parse-*.test.ts` | Parseurs (vidéo, taille, seeders, langues) et intégration `parseRelease` / `parseRawStream` |
| `tests/sources-*.test.ts`, `tests/alldebrid.test.ts` | Sources amont, Torznab, client AllDebrid |
| `tests/engine-*.test.ts` | Filtre, déduplication, classement, formatage, Cinemeta |
| `tests/play.test.ts` | Endpoint de lecture |
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
  app.ts             createApp() : routes, CORS, gestion d'erreurs
  deps.ts            dépendances injectées (secret, allowPlain, fetch, client AllDebrid)
  pipeline.ts        getStreams() : collecte, parsing, filtre, dédoublonnage, cache, classement, formatage
  types.ts           types partagés (RawStream, ParsedRelease, StremioStream, ContentRef)
  config/
    schema.ts        schéma zod, défauts, parseConfig, JSON Schema
    codec.ts         chiffrement AES-256-GCM de la configuration
    secret.ts        lecture de LASTADDON_SECRET et du .env
  parse/
    index.ts         parseRelease, parseRawStream
    video.ts         résolution, source, codec, HDR, audio, canaux, groupe
    language.ts      langues, variante FR, sous-titres
    meta.ts          taille, seeders, infoHash, saison et épisode
  sources/
    collect.ts       interrogation parallèle des sources, erreurs isolées
    upstream.ts      addons Stremio amont
    torznab.ts       indexeurs Torznab
    alldebrid.ts     client AllDebrid (cache-check, résolution, clé API)
    http.ts          fetch avec délai, masquage des URL et des secrets
  engine/
    filter.ts        filtre
    dedupe.ts        déduplication
    score.ts         classement et sélection pour le cache-check
    format.ts        formatage des streams Stremio
    cinemeta.ts      durées (Cinemeta, avec cache)
    types.ts         candidats et rangs
  routes/
    stream.ts        GET /:config/stream/:type/:id.json
    test.ts          POST /config/test
    play.ts          GET /:config/play/:infoHash/:fileIdx?
tests/               voir la section Tests
```

## Licence

MIT. Voir le fichier [LICENSE](./LICENSE). Copyright (c) 2026 gtko.
