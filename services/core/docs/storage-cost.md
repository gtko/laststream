# Coût de stockage (KV et R2) par requête

Issue LAST-138. Ce document sert à repérer les routes qui consomment le plus d'opérations Workers KV et R2, et fixe la règle
sur les durées de vie des clés KV. Les nombres ci-dessous sont des **estimations tirées du code et des tests**, pas des
mesures : à confirmer en production avec les journaux `storage_ops` (voir plus bas).

## Journal `storage_ops`

Chaque requête du Worker qui touche KV ou R2 écrit **une ligne JSON** à la fin (`src/platform/workers/storage-ops.ts`,
branchée dans `src/worker.ts`) :

```json
{"msg":"storage_ops","route":"/:config/catalog/movie/:id","kv":{"get":3,"put":1},"r2":{"get":1}}
```

- `kv` : `get` (y compris `getWithMetadata`), `put`, `delete`, `list`. `r2` : `get`, `put` (y compris multipart), `head`, `delete`, `list`.
  Un appel groupé (`get` de plusieurs clés, `delete` d'un tableau) compte pour une opération.
- `route` : étiquette épurée de `routeLabel` (`src/metrics/core.ts`) : le jeton de configuration et les identifiants deviennent
  `:config` et `:id`. Aucune clé, aucun préfixe, aucune identité n'entre dans la ligne.
- Pas de ligne si la requête n'a fait aucune opération. Le travail d'arrière-plan fini après la réponse (rafraîchissement SWR,
  `waitUntil`) n'est pas compté dans la ligne. Le Cron et les Durable Objects ne sont pas comptés.
- Aucun état global entre requêtes : le compteur est un `AsyncLocalStorage` ouvert par requête ; les liaisons `CACHE`, `TV`,
  `META` et `AVATARS` sont enveloppées une fois par isolat (sans état).

Lecture en production : `npx wrangler tail --format json | jq 'select(.logs[]?.message[0] | tostring | contains("storage_ops"))'`,
ou la recherche « storage_ops » dans les journaux Workers (observabilité activée). Sommer `kv.get`, `kv.put`, `r2.get` par `route`
sur une journée donne le coût réel par route.

## Routes les plus coûteuses (estimation par requête)

Hypothèses : isolat froid (niveau 1 mémoire vide) ; en régime chaud, la plupart des lectures sont servies par la mémoire de
l'isolat et le coût tombe à 0 opération.

| Route (étiquette) | KV | R2 | D'où ça vient |
| --- | --- | --- | --- |
| `/:config/stream/:type/:id` (lecture/streams) | 1 `get` par infoHash du lot (`pack:`), 1 par hôte (`down:`), 1 à 2 `get` d'URL émises ; `put` pour les nouveaux packs | 0 | `play/packs.ts` et `play/hosts.ts` lisent le KV clé par clé (`Promise.all`) : coût proportionnel au nombre de sources. Candidate n°1 à regrouper si les journaux la confirment. |
| `/:config/lt/meta/...` (fiche d'un titre) | 1 `get` + 1 `put` par appel TMDB/TVDB/MDBList raté en mémoire (cache à deux niveaux) ; 2 `get` MDBList (`r:` et `n:`) | 3 `get` (couches base, l10n, ratings) ; 3 `put` à la reconstruction | `lt/meta.ts`, `lt/mdblist.ts`, `cache/ttl-cache.ts` |
| `/:config/lt/series/.../episodes` | 1 `get` par appel TMDB/TVDB froid | 1 `get` par saison (`tv/<id>/season/<n>` en R2), `put` à la reconstruction | `lt/episodes.ts` : N saisons = N lectures R2 en parallèle |
| `/:config/catalog/:type/:id` | 0 (rangée servie depuis R2) ; repli sans R2 : 1 `get` par page + par titre neuf | 1 `get` (rangée `rows/...`) | `lt/rows.ts`. Depuis LAST-138, une page reconstruite ne rappelle plus `external_ids` pour les titres connus (30 jours). |
| `/lt/tv/*` (chaînes, EPG) | 0 | 1 `get` par ressource (catalogue, EPG, sondes) | `platform/workers/tv-store.ts`, mémoire de l'isolat 5 min |
| `/lt/tmdb/*` (relais) | 1 `get` (+1 `put` si raté) par chemin ; recherches `search/*` en mémoire seule : 0 | 0 | `lt/providers.ts` |
| `/avatars/*` | 0 | 1 `get` | `platform/workers/avatar-assets.ts` |
| Cron (6 h) | 1 `get` + 1 `put` + 1 `delete` (verrou TV) | quelques `put` (catalogue, EPG, rangées, fiches préchauffées) | `tv-store.ts`, `rows-refresh.ts`, `meta-prewarm-refresh.ts` |

Ordre de grandeur attendu des écritures : une écriture KV par entrée de cache TMDB/TVDB/Cinemeta/Jikan reconstruite (au plus une
fois par durée de vie), une par pack/URL/hôte nouveau. Les écritures sont limitées à 1 par seconde et par clé (limite KV).

## Règle : aucune clé KV sans expiration

- `KvCache.set(key, value, ttlSeconds)` : la durée est **obligatoire** dans le type (`src/platform/types.ts`).
- L'implémentation Workers (`platform/workers/kv-cache.ts`) pose toujours `expirationTtl` (minimum 60 s, imposé par KV). Une durée
  absente ou invalide (appel non typé) retombe sur 24 h (`KV_DEFAULT_TTL_SECONDS`) et ne crée jamais de clé permanente.
- Hors couche `KvCache`, la seule écriture directe sur `env.CACHE` est le verrou TV (`tv-store.ts`), avec `expirationTtl: 900`.
- Audit LAST-138 : toutes les écritures existantes passaient déjà une durée ; le manque était dans le type et dans
  l'implémentation (clé permanente possible), corrigé ci-dessus. L'implémentation mémoire (Node) accepte encore une clé sans
  durée, sans effet sur KV.

### Liste des durées de vie

| Espace de noms / clé | Durée | Source |
| --- | --- | --- |
| Cache à deux niveaux `tmdb` : détails, listes | 6 h (SWR : 12 h au total) | `TTL.tmdb` |
| `tmdb` : tendances et populaires | 3 h | `TTL.tmdbFast` |
| `tmdb` : tendances du jour (Top 10) | 1 h | `TTL.tmdbDay` |
| `tmdb` : fournisseurs de streaming | 12 h | `TTL.tmdbWatch` |
| `tmdb` : correspondance TMDB vers IMDb (`tmdb:imdbid:`) | 30 jours (absence d'id : 6 h) | `TTL.tmdbImdbId` (LAST-138) |
| `tvdb`, structure saisons/épisodes | 12 h | `TTL.tvdb`, `TTL.episodes` |
| `openrouter` : recommandations partagées | 24 h (vide : 5 min) ; texte « pourquoi » 7 jours | `TTL.aiRecommend`, `TTL.aiText` |
| `cinemeta` | 6 h (TMDB méta) | `engine/tmdb-meta.ts` |
| `jikan` : fillers | 7 jours (vide : 6 h) | `TTL.fillers` |
| Segments de saut | 7 jours (vide : 6 h) | `TTL.skip` |
| `mdb` : notes `r:` | 24 h si sortie récente, sinon 7 jours | `lt/mdblist.ts` |
| `mdb` : `n:` (absence) | 10 min (404), 2 min (autre erreur) | `lt/mdblist.ts` |
| `mdb` : `breaker` | 60 s à 24 h (1 h par défaut) | `lt/mdblist-guard.ts` |
| `issued` : URL émises | `ISSUED_TTL_MS` | `play/issued.ts` |
| `packs` : `pack:<hash>` | `DEFAULT_TTL_MS` | `play/packs.ts` |
| `hosts` : `down:<hôte>` | 1 h | `DEFAULT_HOST_DOWN_MS` |
| `torrents` : `torrent:<clé>` | `TORRENT_CACHE_TTL_MS` | `torrent/fetch-torrent.ts` |
| `tv:refresh-lock` (verrou du Cron TV) | 15 min | `tv-store.ts` |

Les entrées du cache à deux niveaux avec SWR vivent le double de leur fraîcheur dans KV (fraîcheur + fenêtre de service périmé).

### R2 (pas de TTL à l'écriture)

R2 n'a pas d'expiration par objet : les durées sont portées par la règle de cycle de vie du bucket. `META` (fiches, saisons,
rangées) : `scripts/r2-meta-lifecycle.sh` (objets en couches supprimés 365 jours après le dernier envoi, anciens objets à 60 jours).
`TV` : objets réécrits à chaque passage du Cron (clés fixes). `AVATARS` : envoyés à la main, lecture seule côté Worker.
