# API sociale de lastAddon

Fonctions sociales côté serveur : parrainage, amis, présence, bibliothèques partagées, titres masqués et salons de visionnage (watch party). Tout vit dans le Worker `lastaddon-core` (Cloudflare) et fonctionne aussi sur le serveur Node, **sauf la watch party en temps réel** (Workers uniquement ; sous Node, toutes les routes `/party` répondent `501 {"error":"party_unavailable"}`).

## Conventions

- Base : `https://lastaddon-core.gtux-prog.workers.dev` (ou le serveur Node). Toutes les routes `/user/*` et `/party/*` sont en JSON, jamais en cache (`Cache-Control: no-store`), avec CORS limité aux origines de l'application.
- Authentification : `Authorization: Bearer <jeton de session>` (celui de `POST /user/login`). Sans session : `401 {"error":"unauthorized"}`.
- Profils : les routes `/user/profiles/:id/...` exigent que le profil appartienne au compte et, s'il a un PIN, l'en-tête `X-Profile-Token` (comme le reste de l'API).
- Erreurs : `{ "error": "<code stable>", "issues"?: [...] }`. Limites de débit : `429 rate_limited` avec `Retry-After`.
- Pseudo = `username` du compte (3 à 32 caractères, minuscules). **Seuls le pseudo et la couleur d'avatar sont exposés aux autres comptes** : jamais d'identifiant de compte, de profil, de session ni de donnée debrid.

## 1. Parrainage (inscription par lien)

L'inscription n'est possible qu'avec un lien de parrainage. Le tout premier compte d'un serveur vide s'inscrit sans lien (il devient propriétaire). `LASTADDON_ALLOW_SIGNUP=1` rouvre l'inscription libre : option réservée aux serveurs personnels, absente du Worker public.

Chaque compte possède 4 liens (quota ajustable par le propriétaire). Un lien = une inscription. Le filleul devient **automatiquement ami** du parrain.

### `POST /user/register`

```json
{ "username": "bob", "password": "…", "invite": "<code du lien>" }
```

`201 { account }`. Erreurs : `403 signup_disabled` (pas de lien), `403 invite_invalid` (inconnu, déjà utilisé ou révoqué), `409 username_taken` (le lien n'est alors pas consommé). Le lien se partage sous la forme qui convient à l'application, par exemple `https://…/?invite=<code>`.

### `GET /user/invites`

```json
{
  "quota": 4,
  "invites": [
    { "id": "…", "code": "Kq3…", "state": "free", "createdAt": "…", "sentAt": null, "usedAt": null, "invitee": null },
    { "id": "…", "code": "Zp9…", "state": "used", "createdAt": "…", "sentAt": "…", "usedAt": "…", "invitee": "bob" }
  ]
}
```

- `state` : `free` (jamais envoyé), `sent` (marqué envoyé), `used` (utilisé ; `invitee` = pseudo du filleul, `null` si son compte a été supprimé).
- Les emplacements manquants sont créés à la volée jusqu'au quota. Les liens utilisés restent toujours listés.

### `PUT /user/invites/:id/sent`

`{ "sent": true | false }` → `204`. Indicatif (pour l'état « envoyé » du tableau de bord) ; `409 invite_used` si le lien est utilisé.

### `DELETE /user/invites/:id` (révocation)

Révoque un lien **non utilisé** : l'ancien code cesse de fonctionner et l'emplacement reçoit un nouveau lien libre (« récupérer » le lien). Réponse `200 { "invite": { …nouveau lien… } }`. `409 invite_used` si le lien est déjà utilisé, `404 invite_not_found` sinon.

### `GET /user/invites/check?code=<code>` (sans session)

`{ "valid": true, "inviter": "alice" }` ou `{ "valid": false, "inviter": null }`. Sert à afficher « invité par alice » avant l'inscription.

### `PUT /user/accounts/:username/invite-quota` (propriétaire)

`{ "quota": 0..100 }` → `200 { "username", "quota" }`. `403 owner_only` pour tout autre compte, `404 account_not_found`. Réduire le quota supprime les liens libres en trop, jamais un lien utilisé.

## 2. Amis

Identifiés par **pseudo exact** (pas de recherche partielle).

| Route | Effet |
| --- | --- |
| `GET /user/friends` | `{ friends, incoming, outgoing }` |
| `POST /user/friends/requests` `{ "username" }` | Demande. `201 {status:"sent"}` ; `200 {status:"accepted"}` si l'autre avait déjà demandé |
| `POST /user/friends/requests/:username/accept` | Accepte une demande reçue (`204`) |
| `DELETE /user/friends/requests/:username` | Refuse une demande reçue ou annule une demande envoyée (`204`) |
| `DELETE /user/friends/:username` | Supprime un ami (`204`) |

Erreurs : `404 user_not_found`, `400 cannot_befriend_self`, `409 already_friends`, `409 request_pending`, `404 request_not_found`, `404 friend_not_found`, `429 friend_limit_reached` (200 amis, 50 demandes envoyées).

Élément de `friends` :

```json
{ "username": "bob", "avatarColor": "#3b82f6", "status": "watching", "since": "…",
  "watching": { "type": "series", "tmdbId": 1399, "imdbId": null, "title": "Game of Thrones", "season": 2, "episode": 4 } }
```

`status` : `online`, `watching` (titre dans `watching`) ou `offline`. `incoming` / `outgoing` : `{ username, avatarColor, requestedAt }`.

## 3. Présence

### `PUT /user/presence`

Battement de cœur léger, à envoyer **toutes les 30 à 60 s** tant que l'application est ouverte (un seul UPSERT côté serveur) :

```json
{ "profileId": "<profil actif>", "watching": { "type": "series", "tmdbId": 1399, "title": "Game of Thrones", "season": 2, "episode": 4 }, "invisible": false }
```

- `watching` : `null` ou absent = simplement en ligne. `tmdbId` ou `imdbId` requis. Les amis voient « en train de regarder : titre ».
- Sans nouveau battement pendant **90 s**, le compte apparaît hors ligne.
- Un **profil enfant n'annonce jamais de titre** (seulement « en ligne »).
- `invisible: true` : apparaît hors ligne à ses amis.
- `DELETE /user/presence` (`204`) : hors ligne immédiat (fermeture de l'application).

## 4. Bibliothèques partagées

Chaque titre de bibliothèque porte `visibility` : `private` (défaut) ou `friends`. `GET /user/profiles/:id/library` renvoie ce champ pour chaque élément. Ré-ajouter un titre ne change pas sa visibilité.

| Route | Effet |
| --- | --- |
| `PUT /user/profiles/:id/library/:type/:itemId/visibility` `{ "visibility" }` | Un titre (`204`, `404 library_item_not_found`) |
| `PUT /user/profiles/:id/library/visibility` `{ "visibility", "type"? }` | Toute la bibliothèque, ou tous les films / séries : `200 { "updated": n }` |
| `GET /user/friends/:username/library?type=&limit=&offset=` | Bibliothèque visible d'un ami |

- Lecture d'un ami : titres en visibilité `friends` de ses profils **non enfants**, fusionnés sans doublon. `limit` 1 à 100 (défaut 50), `offset` ≥ 0. Réponse : `{ items: [{ type, tmdbId, imdbId, title, poster, addedAt }], total, limit, offset }`.
- Un non-ami et un pseudo inconnu reçoivent la **même** réponse `404 friend_not_found` (l'existence des comptes n'est pas révélée).
- Un profil enfant ne peut rien partager : `403 kid_profile`.

## 5. Titres masqués

Remplace les réglages découpés `homeHidden`, `homeHidden0..11` (plafond ≈ 400). Table par profil, jusqu'à **20 000** titres. Clé : `movie:550` ou `tv:1399`, comme le client.

| Route | Effet |
| --- | --- |
| `GET /user/profiles/:id/hidden?q=&limit=&cursor=` | Liste paginée, du plus récent au plus ancien |
| `PUT /user/profiles/:id/hidden` | Masque des titres (500 par appel) → `{ "total" }` |
| `POST /user/profiles/:id/hidden/remove` `{ "keys": [...] }` | Réaffiche (500 clés par appel) → `{ "removed" }` |
| `DELETE /user/profiles/:id/hidden/:key` | Réaffiche un titre (`204`) |

- `GET` : `limit` 1 à 500 (défaut 100) ; `q` filtre par titre (sous-chaîne, sans casse). Réponse `{ items: [{ key, title, poster, addedAt }], total, nextCursor }`. Pour la page suivante, renvoyer `cursor=<nextCursor>` ; `nextCursor: null` = fin. `total` tient compte de `q`.
- `PUT` : `{ "entries": [{ "key", "title", "poster"?, "addedAt"? }] }` (`addedAt` en millisecondes ; absent = maintenant). Un titre déjà masqué garde sa date d'origine. `409 hidden_limit_reached` au-delà de 20 000 (rien n'est écrit).
- **Import automatique** : au premier accès d'un profil à l'une de ces routes, les anciens morceaux `homeHidden`/`homeHidden0..11` des réglages sont lus (entrées valides seulement), insérés dans la table, puis **supprimés des réglages**. L'import n'a lieu qu'une fois par profil : si une ancienne version de l'application réécrit ensuite ces clés, elles sont ignorées. L'application doit donc cesser d'écrire `homeHidden*` et passer par ces routes.

## 6. Watch party (Workers uniquement)

Un salon est un Durable Object `PartyRoom` (WebSocket avec l'API d'hibernation). **Aucun lien de lecture ni donnée debrid ne circule** : le salon ne porte que l'identité du titre (type, TMDB/IMDb, saison, épisode) et l'« empreinte » de la version lue par l'hôte (nom de fichier, taille, hash si connus). Chaque participant résout sa propre source, de préférence la plus proche de l'empreinte.

Seuls les comptes Laststream y accèdent. Les **profils enfants** ne peuvent ni créer, ni lister, ni rejoindre un salon **public** ; ils peuvent créer ou rejoindre un salon **privé** (par lien).

### REST

| Route | Effet |
| --- | --- |
| `POST /party` | Crée un salon (profil actif dans `profileId`) |
| `GET /party?profileId=&language=&limit=&cursor=` | Salons publics, paginés (du plus récent au plus ancien) |
| `GET /party/:id` | Détail d'un salon (un salon privé se retrouve par son identifiant) |
| `POST /party/:id/join` `{ "profileId" }` | Ticket de connexion WebSocket |
| `DELETE /party/:id` | Termine le salon (hôte, ou propriétaire du serveur) |
| `GET /party/:id/reports` | Signalements reçus (hôte, ou propriétaire du serveur) |

**Création** :

```json
{
  "profileId": "<profil actif>",
  "visibility": "public",
  "title": "Severance",
  "poster": "/abc123.jpg",
  "language": "fr",
  "media": { "type": "series", "tmdbId": 95396, "season": 1, "episode": 1 },
  "fingerprint": { "fileName": "Severance.S01E01.1080p.mkv", "size": 3000000000, "hash": "…" },
  "maxParticipants": 20
}
```

`visibility` : `private` (défaut) ou `public`. `media` : `tmdbId` ou `imdbId` requis ; saison / épisode pour une série. `maxParticipants` : 2 à 20 (défaut 20). `201 { room }`. Au plus **3 salons ouverts par hôte** (`429 too_many_rooms`). Erreurs : `403 kid_profile` (public avec un profil enfant), `400 invalid_body`, `404 profile_not_found`.

`room` : `{ id, visibility, title, poster, language, media, fingerprint, host, participants, maxParticipants, createdAt }`.

**Liste publique** : `{ rooms: [{ id, title, poster, language, mediaType, host, participants, maxParticipants, createdAt }], nextCursor }` — pseudo et affiche uniquement. `limit` 1 à 50 (défaut 20). Passer `profileId` (profil actif) : un profil enfant reçoit `403 kid_profile`. Les salons terminés ou expirés disparaissent de la liste.

**Rejoindre** : `POST /party/:id/join` vérifie le profil, le salon et les exclusions, puis renvoie :

```json
{ "ticket": "…", "expiresAt": "…", "wsPath": "/party/<id>/ws?ticket=…", "room": { … } }
```

Erreurs : `404 room_not_found`, `403 kid_profile` (salon public), `403 banned` (exclu), `409 room_full`.

Le ticket est valable **60 secondes**, lié au salon et au compte (HMAC). Un navigateur ne pouvant pas poser d'en-tête sur une WebSocket et le jeton de session ne devant pas finir dans une URL, on ouvre ensuite : `wss://<hôte>/party/<id>/ws?ticket=<ticket>`. Erreurs de connexion : `401 invalid_ticket`, `403 banned`, `409 room_full`, `426` (pas une mise à niveau WebSocket), `403 origin_forbidden`.

### Protocole WebSocket

Messages JSON, une trame = un message, 4 Ko au plus. Le client envoie `{ "t": …}` ; le serveur répond de même.

**Client → serveur**

| Message | Qui | Effet |
| --- | --- | --- |
| `{t:"ping", c:<horloge client ms>}` | tous | répond `pong` |
| `{t:"sync"}` | tous | répond l'état courant |
| `{t:"ctl", action:"play"\|"pause"\|"seek", pos:<s>}` | **hôte** | change l'état, diffusé à tous |
| `{t:"ctl", action:"sync", pos:<s>}` | **hôte** | rapport périodique de position (toutes les ~5 s) ; rediffusé seulement si l'écart dépasse 0,75 s |
| `{t:"episode", season, episode, fingerprint?}` | **hôte** | changement d'épisode (séries) ; position remise à 0, en pause |
| `{t:"chat", text}` | tous | message (500 caractères, filtré) |
| `{t:"react", emoji}` | tous | réaction parmi 👍 ❤️ 😂 😮 😢 👏 🔥 🎉 |
| `{t:"report", messageId, reason?}` | tous | signale un message d'un autre participant |
| `{t:"mute", user, muted}` | **hôte** | rend muet / rétablit (par pseudo) |
| `{t:"kick", user}` | **hôte** | exclut définitivement du salon |
| `{t:"transfer", user}` | **hôte** | cède le rôle d'hôte |
| `{t:"end"}` | **hôte** | termine le salon |

**Serveur → client**

| Message | Contenu |
| --- | --- |
| `welcome` | `you {username, host, muted}`, `room`, `state`, `serverTime`, `participants [{username, avatarColor, host, muted, joinedAt}]`, `chat` (50 derniers messages) |
| `pong` | `c` (écho), `s` (horloge serveur ms) |
| `state` | `state {playing, pos, at, rev}`, `serverTime`, `by` |
| `media` | `media`, `fingerprint`, `state`, `serverTime` (changement d'épisode) |
| `join` / `leave` | `participant` / `user` |
| `chat` | `line {id, from, text, at}` |
| `react` | `user`, `emoji`, `at` |
| `muted` | `user`, `muted` |
| `host` | `user` (nouvel hôte) |
| `reported` | confirmation au signaleur ; à l'hôte : `by`, `against`, `text` |
| `error` | `code` : `not_host`, `muted`, `rate_limited`, `invalid_message`, `invalid_reaction`, `empty_message`, `message_not_found`, `cannot_report_self`, `cannot_target_self`, `user_not_found`, `not_series` |
| `ended` | `reason` (`host_ended`, `closed`, `expired`, `empty`), puis fermeture 4000 |

Codes de fermeture : `4000` salon terminé, `4003` exclu, `4008` débit abusif, `4009` connexion remplacée (le même compte s'est reconnecté), `4010` salon plein, `1009` trame trop grande.

### Synchronisation (horloge serveur)

`state` = position `pos` (secondes) à l'instant serveur `at` (ms), avec `playing`. La position attendue à l'instant serveur `now` est `playing ? pos + (now - at) / 1000 : pos`.

1. **Estimer l'horloge serveur** : envoyer `ping` avec `c = Date.now()` (t0), lire `pong` à t1 ; `offset = s − (t0 + t1) / 2`. Répéter quelques fois et garder l'échantillon au plus petit aller-retour. L'instant serveur estimé est `Date.now() + offset`.
2. **Appliquer** chaque `state` / `media` / `welcome` : `expected = pos + (Date.now() + offset − at) / 1000` si `playing`.
3. **Corriger la dérive** toutes les secondes ou deux (`local` = position du lecteur) :
   - écart < **0,3 s** : rien ;
   - de 0,3 s à 2 s : vitesse **0,95** (en avance) ou **1,05** (en retard) jusqu'à rattrapage ;
   - ≥ 2 s (ou lecture à l'arrêt) : saut direct à `expected`.
4. L'hôte envoie `ctl` `sync` avec sa position environ toutes les 5 s, et un `ctl` à chaque action. Si un participant a changé de version (autre fichier, autre durée), il peut se recaler avec `{t:"sync"}`.

Ces formules sont implémentées et testées dans `src/party/sync.ts` (`expectedPosition`, `estimateOffset`, `driftAction`).

### Modération et limites

- **Hôte** : crée le salon ; peut exclure, rendre muet, transférer, terminer. Si l'hôte est absent plus d'une minute, le plus ancien participant devient hôte.
- **Participants** : 20 au plus (réglable à la création, 2 à 20). Une reconnexion du même compte remplace l'ancienne connexion.
- **Débit par participant** : chat 5 messages / 10 s, réactions 10 / 10 s, signalements 5 / min, contrôles 30 / 10 s. Au-delà : `error rate_limited` ; au-delà du double, fermeture `4008`.
- **Filtrage du chat** : caractères de contrôle et de renversement de texte retirés, liens remplacés par `[lien]`, courte liste d'insultes masquée (accents et chiffres d'argot compris). Ce n'est pas une modération exhaustive : utiliser le signalement.
- **Signalement** : retrouve le message par son `id`, l'enregistre (50 derniers) et prévient l'hôte ; lisible via `GET /party/:id/reports` (hôte ou propriétaire).
- **Durée de vie** : un salon vide est supprimé après 10 minutes, tout salon après 12 heures.
- Un participant exclu ne peut plus rejoindre ce salon (REST et WebSocket).

## 7. Déploiement et exploitation

- Migrations SQL : `src/user/migrations.ts`, version 7 (`invites`, `friendships`, `presence`, `hidden_titles`, `hidden_import`, `party_rooms`, colonnes `accounts.invite_quota` et `library_items.visibility`). Appliquées automatiquement au démarrage (Node) et par le Durable Object `UserStoreDO`.
- Durable Objects (`wrangler.jsonc`) : `PARTY_ROOM` → classe `PartyRoom` (migration `v2`, SQLite). Déploiement : `npm run deploy:worker`.
- Comptes de test sur un serveur public : la route d'administration `POST /__admin/invite` (en-tête `x-admin-secret`, secret `ADMIN_SECRET` posé temporairement) crée une invitation « système » (sans parrain, donc sans amitié) ; `DELETE /__admin/invite/<code>` la supprime. Supprimer ensuite le secret avec `wrangler secret delete ADMIN_SECRET`.
- Tests : `npm test` (Node, dont le cœur du salon) et `npm run test:workers` (parrainage, amis, présence, visibilité, masqués contre le Durable Object ; salons avec vraies WebSocket).
