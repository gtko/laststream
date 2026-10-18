# API d'administration (`/admin/*`)

Réservée au **propriétaire** (le premier compte). Mêmes routes sous Node et sous Workers ; les fonctions qui dépendent de Cloudflare (KV, salons) répondent `501` sous Node. Toutes les réponses sont en JSON, `Cache-Control: no-store`. Les erreurs ont la forme `{ "error": "code" }`.

## Accès

- Session du compte propriétaire : `Authorization: Bearer <jeton de session>` (celui de `POST /user/login`).
- `401 unauthorized` sans session valide ; `403 owner_only` pour tout autre compte.
- **Profils enfants** : l'app envoie l'en-tête `X-Profile-Id: <profil actif>`. Un profil enfant est refusé (`403 kid_profile`), un profil d'un autre compte aussi (`profile_invalid`), un profil protégé par PIN exige `X-Profile-Token` (`403 pin_required`). Sans cet en-tête, seule la session compte : l'app doit donc toujours l'envoyer.
- `GET /admin/me` → `{ account: { id, username }, elevationTtlSec }` (test d'accès pour l'app).
- Limites de débit par IP : 120 lectures/min, 30 écritures/min (`429 rate_limited`, en-tête `Retry-After`). Ré-authentification : 5 essais par 10 min.

## Ré-authentification (actions destructrices)

`POST /admin/elevate` `{ "password": "…" }` → `{ token, expiresAt }` (10 minutes). Le jeton se passe dans l'en-tête `X-Admin-Elevation` des actions marquées **[élév.]**. Il est lié à la session : déconnexion, rotation (`/user/refresh`) ou révocation l'invalident.
Erreurs : `403 elevation_required` (absent/invalide), `403 elevation_expired` (à redemander), `403 invalid_password`.

## Comptes

| Route | Effet |
|---|---|
| `GET /admin/accounts?q&status=active\|suspended&referrer&createdFrom&createdTo&order=newest\|oldest&limit&cursor` | Liste paginée : `{ accounts, nextCursor, total }`. Chaque compte : `id, username, isOwner, createdAt, status, suspendedAt, referrer, lastActivityAt, profileCount, libraryCount, inviteQuota, invitesUsed`. `q` : fragment de pseudo. |
| `GET /admin/accounts/:id` | Détail : `account`, `profiles` (nom, enfant, PIN oui/non, bibliothèque), `invitees`, `sessions`. |
| `GET /admin/referrals` | Arbre de parrainage `{ roots: [{ id, username, createdAt, status, children }], total, truncated }`. |
| `PUT /admin/accounts/:id/invite-quota` `{ quota }` | Quota de liens (0 à 100). |
| `POST /admin/accounts/:id/suspend` **[élév.]** | Suspend : connexion refusée (`403 account_suspended`), sessions révoquées et refusées. |
| `POST /admin/accounts/:id/reactivate` | Réactive. |
| `POST /admin/accounts/:id/revoke-sessions` **[élév.]** | Révoque toutes les sessions (`204`). |
| `DELETE /admin/accounts/:id` **[élév.]** | Supprime le compte et ses données, ferme ses salons (`204`). |
| `POST /admin/accounts/:id/reset-link` **[élév.]** | Lien à usage unique, 24 h : `{ token, expiresAt, url }` (`201`). Le jeton n'est montré qu'ici ; un nouveau lien remplace le précédent. |

Le propriétaire ne peut ni se suspendre ni se supprimer (`403 cannot_target_owner`).

**Réinitialisation (route publique)** : `POST /user/password-reset` `{ token, password }` (mot de passe ≥ 8 caractères) → `204` ; toutes les sessions du compte sont révoquées. `400 reset_invalid` si le lien est inconnu, expiré ou déjà utilisé. `url` vaut `<LASTADDON_PUBLIC_URL>/reset-password?token=…` : l'app peut afficher sa propre page et appeler cette route.

## Réglages globaux

`GET /admin/settings` / `PUT /admin/settings` (corps partiel) :

```json
{ "inviteDefaultQuota": 4, "invitesOpen": true, "maintenance": { "enabled": false, "message": "" } }
```

- `inviteDefaultQuota` : quota donné aux **nouveaux** comptes (les existants gardent le leur).
- `invitesOpen: false` : les inscriptions par lien sont refusées (`403 invites_closed`, lien non consommé). Le premier compte n'est pas concerné.
- `maintenance` : activer exige **[élév.]**. Tout répond alors `503` (`{ "error": "maintenance", "message" }`, ou page HTML pour un navigateur, `Retry-After: 300`) **sauf** `/admin/*`, `/health`, `GET /user/signup-info` et `POST /user/login` (un non-propriétaire reçoit 503 après vérification du mot de passe). L'état est mis en cache ~5 s par instance.

## Métriques

`GET /admin/metrics?range=1h|24h|7d` (défaut `1h`). Tranches de 5 minutes (pas d'1 h pour `7d`), rétention 7 jours, latences en ms (histogramme, p50/p95 interpolés).

```
{ range, from, to, stepSec,
  totals / groups.{stream,play,lt_tmdb,lt,user,party,ui,other}: { requests, status:{2xx,3xx,4xx,5xx}, p50, p95, avgMs },
  series: [{ t, requests, errors5xx, p95 }],
  upstreams: [{ host, calls, failures, timeouts, avgMs }],      // addons amont, par hôte (sans chemin ni jeton)
  alldebrid: { unlock|magnet|other: { ok, errors: { <code>: n } } },
  caches: [{ prefix, hits, misses, hitRate }],
  errors: [{ at, route, status, message }] }                     // 100 dernières 5xx, route sans paramètre, message épuré
```

Écriture non bloquante : chaque instance additionne en mémoire et envoie un lot au Durable Object `Metrics` au plus toutes les ~10 s (`ctx.waitUntil`). Un isolat arrêté perd au plus 10 s. Sous Node : mémoire du processus. Le CPU n'est pas mesuré.

## Caches (Workers)

- `GET /admin/caches?range=24h` → `{ caches: [{ prefix, keys, exact, hits, misses, hitRate }] }`. Préfixes : `issued, packs, hosts, torrents, alldebrid`. Le nombre de clés vient d'un `list` KV borné à 10 pages de 1000 : au-delà, `exact: false` et `keys` est un minimum.
- `POST /admin/caches/:prefix/purge` **[élév.]** → `202` + job `{ id, prefix, status: running|done|failed, deleted, startedAt, updatedAt, error }`. Purge asynchrone par lots (alarme du Durable Object), reprise automatique. `404 unknown_cache` pour un préfixe inconnu.
- `GET /admin/caches/purges` et `GET /admin/caches/purges/:id` : progression.
- Sous Node : `501 cache_admin_unavailable`.

## TV

`GET /admin/tv` → `{ lastCron }` ; `POST /admin/tv/rerun` → `202`. `501 tv_admin_unavailable` tant que l'API TV n'est pas branchée (`AppDeps.tvAdmin`).

## Watch parties

- `GET /admin/party/rooms` : salons actifs, privés compris (`id, host, visibility, title, mediaType, createdAt, participants, maxParticipants`) ; l'annuaire est recoupé avec les salons vivants.
- `DELETE /admin/party/rooms/:id` **[élév.]** : fermeture forcée (`204`).
- `GET /admin/party/reports?status=open|deleted|suspended|ignored` : file des messages signalés (alimentée par le salon au moment du signalement) : `id, roomId, messageId, by, against, text, reason, at, status`.
- `POST /admin/party/reports/:id/action` `{ action: "delete"|"suspend"|"ignore" }` : `delete` retire le message du salon (les clients reçoivent `{ t: "removed", messageId }`), `suspend` suspend l'auteur **[élév.]**, `ignore` clôt. `409 report_closed` si déjà traité.
- `501 party_unavailable` sous Node.

## Journal d'audit

`GET /admin/audit?limit&before&action` → `{ entries: [{ id, at, actor, actorId, action, target, detail }], nextBefore }` (récents d'abord, 10 000 entrées conservées). Chaque action est inscrite **avant** d'être exécutée (ré-authentifications échouées comprises : `elevate.failed`). Jamais de mot de passe, jeton ou hash.

## Informations publiques pour l'app

- `GET /user/signup-info` (sans session) → `{ serverEmpty, inviteOnly, maintenance }`, rien d'autre. Répond même en maintenance.
- `GET /user/me` → `account` contient `role: "owner" | "member"` en plus de `isOwner` (équivalents : `isAdmin` côté app = `role === "owner"`).

## Sécurité, en bref

Aucune réponse ne contient de hash, de PIN, de jeton de session, de configuration chiffrée ou de clé. Les vues sont des listes explicites de champs. Les messages d'erreur des métriques sont épurés (URL, adresses IP, e-mails et suites longues masqués). Les jetons de réinitialisation ne sont stockés que sous forme d'empreinte.
