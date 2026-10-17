# lastAddon

Addon Stremio agrégateur de streams pour Laststream. Il interroge plusieurs sources (upstreams HTTP et indexeurs Torznab), filtre les résultats selon les préférences de l'utilisateur (langues, résolutions, tailles, tags exclus) et les renvoie à Stremio.

Ce dépôt contient le **lot 1** : le socle du serveur, la validation et le chiffrement de la configuration, les endpoints d'administration et les stubs des endpoints de streams (voir [Endpoints](#endpoints)).

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
| `LASTADDON_SECRET` | généré | Clé de chiffrement des configurations (AES-256-GCM). Si elle est absente, une valeur aléatoire de 32 octets est générée au premier démarrage et enregistrée dans `.env`. |
| `LASTADDON_ALLOW_PLAIN` | `0` | Mettre `1` pour accepter les configurations en JSON brut encodé en base64url, sans chiffrement. Déconseillé. |
| `PORT` | `7000` | Port d'écoute HTTP. |

**Important :** si `LASTADDON_SECRET` change, toutes les configurations déjà chiffrées (et donc toutes les URL de manifest installées) deviennent invalides. Sauvegardez cette valeur. Ne la committez jamais : `.env` est dans `.gitignore`.

Les clés API (sources, debrid) sont contenues dans la configuration. Le serveur ne les journalise jamais.

## Endpoints

| Méthode | Chemin | Description | Statut |
| --- | --- | --- | --- |
| GET | `/health` | Santé du serveur : `{"ok":true}` | Actif |
| GET | `/manifest.json` | Manifest Stremio générique | Actif |
| GET | `/:config/manifest.json` | Manifest Stremio pour une configuration chiffrée | Actif |
| GET | `/config/schema` | JSON Schema de la configuration | Actif |
| POST | `/config/encode` | Valide une configuration JSON et renvoie `{"config":"..."}` | Actif |
| GET | `/:config/stream/:type/:id.json` | Liste de streams Stremio | Stub : renvoie `{"streams":[]}` |
| POST | `/config/test` | Test des sources d'une configuration | Stub : renvoie `{"sources":[]}` |
| GET | `/:config/play/:infoHash/:fileIdx?` | Lecture d'un stream via debrid | Stub : répond `501` |

Toutes les routes renvoient `Access-Control-Allow-Origin: *`. Les erreurs de validation renvoient `400` avec la liste des chemins invalides, sans écho des valeurs saisies.

## Format de la configuration

La configuration est un objet JSON. Tous les champs sont optionnels : les valeurs par défaut s'appliquent. Le JSON Schema complet est disponible sur `GET /config/schema`.

| Champ | Type | Défaut | Description |
| --- | --- | --- | --- |
| `languages.preferred` | tableau de `fr`, `en`, `es`, `de`, `it`, `multi`, `original` | `["fr","multi"]` | Langues préférées |
| `languages.acceptVostfr` | booléen | `true` | Accepter les VOSTFR |
| `resolutions.allowed` | tableau de `2160p`, `1080p`, `720p`, `480p`, `SD` | toutes | Résolutions autorisées |
| `resolutions.max` | résolution | aucun | Résolution maximale |
| `excludedTags` | tableau de chaînes | `["CAM","TS","SCR"]` | Tags de qualité exclus |
| `size.minGb` / `size.maxGb` | nombre positif | aucun | Taille globale min / max (Go) |
| `size.perResolution` | objet `résolution -> {minGb?, maxGb?}` | aucun | Bornes de taille par résolution |
| `maxResults` | entier entre 1 et 500 | `30` | Nombre maximal de streams renvoyés |
| `sources` | tableau de sources (voir ci-dessous) | `[]` | Sources à interroger |
| `debrid` | `{"service":"alldebrid","apiKey":"..."}` | aucun | Service debrid optionnel |
| `onlyCached` | booléen | `false` | Ne garder que les torrents déjà en cache debrid |

Chaque source est discriminée par son champ `type` :

- `{"type":"upstream","name":"...","url":"https://..."}` : addon Stremio ou API HTTP en amont.
- `{"type":"torznab","name":"...","baseUrl":"https://...","apiKey":"...","categories":[2000]}` : indexeur Torznab (`categories` est optionnel).

Les URL doivent être en `http` ou `https`.

## Exemple

Fichier `config.json` :

```json
{
  "languages": { "preferred": ["fr", "multi"], "acceptVostfr": true },
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

## Structure du projet

```
src/
  server.ts          point d'entrée (démarre si exécuté directement)
  app.ts             createApp() : routes, CORS, gestion d'erreurs
  deps.ts            dépendances injectées (secret, allowPlain)
  types.ts           types partagés
  config/
    schema.ts        schéma zod, défauts, parseConfig, JSON Schema
    codec.ts         chiffrement AES-256-GCM de la configuration
    secret.ts        lecture de LASTADDON_SECRET et du .env
  routes/
    stream.ts        stub GET /:config/stream/:type/:id.json
    test.ts          stub POST /config/test
    play.ts          stub GET /:config/play/:infoHash/:fileIdx?
tests/
  config.test.ts     schéma et codec
  app.test.ts        endpoints HTTP
```

## Licence

MIT. Voir le fichier [LICENSE](./LICENSE). Copyright (c) 2026 gtko.
