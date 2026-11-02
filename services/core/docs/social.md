# API sociale de lastAddon

Fonctions sociales côté serveur : parrainage, amis, présence, bibliothèques partagées, titres masqués et salons de visionnage (watch party). Tout vit dans le Worker `lastaddon-core` (Cloudflare) et fonctionne aussi sur le serveur Node, **sauf la watch party et le flux temps réel social en WebSocket** (Workers uniquement ; sous Node, toutes les routes `/party` répondent `501 {"error":"party_unavailable"}`).

Deux générations coexistent :

- **Social v2** (section suivante, routes `/user/social/*`) : l'entité sociale est le **profil**. C'est l'API à utiliser.
- **v1** : parrainage, visibilité de la bibliothèque, titres masqués et salons n'ont pas d'équivalent v2 et restent en v1. Les routes d'amis et de présence par compte (`/user/friends*` sauf la bibliothèque, `/user/presence`) ont été **retirées** : l'application passe par `/user/social`. Reste `GET /user/friends/:username/library`, à retirer après déploiement de l'application qui lit la bibliothèque d'un ami par pid (section 4).

## Conventions

- Base : `https://core.laststream.app` (ou le serveur Node). Toutes les routes `/user/*` et `/party/*` sont en JSON, jamais en cache (`Cache-Control: no-store`), avec CORS limité aux origines de l'application.
- Authentification : `Authorization: Bearer <jeton de session>` (celui de `POST /user/login`). Sans session : `401 {"error":"unauthorized"}`.
- Profils : les routes `/user/profiles/:id/...` exigent que le profil appartienne au compte et, s'il a un PIN, l'en-tête `X-Profile-Token` (comme le reste de l'API).
- Erreurs : `{ "error": "<code stable>", "issues"?: [...] }`. Limites de débit : `429 rate_limited` avec `Retry-After`.
- Pseudo = `username` du compte (3 à 32 caractères, minuscules), identité v1. En v2, l'identité publique est le handle `Nom#TAG` et le `pid` (voir ci-dessous). **En v1, seuls le pseudo et la couleur d'avatar sont exposés aux autres comptes** : jamais d'identifiant de compte, de profil, de session ni de donnée debrid.

## Social v2 (par profil)

Contrat côté application : `docs/social-v2-contract.md` (dépôt laststream). Cette section décrit le code livré ; les écarts avec le contrat sont listés à la fin.

### Modèle

- **Profil** : entité sociale. Chaque profil **non enfant** a :
  - un **handle** `Nom#TAG`. `Nom` est dérivé du nom du profil : lettres, chiffres, espaces, `_` et `-` conservés, le reste remplacé par un espace, 20 caractères au plus, repli `Profil` si moins de 2 caractères. `TAG` = 4 caractères tirés au hasard dans `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (sans 0, O, 1, I, L), retirés en cas de collision. Unicité : nom normalisé (minuscules) + tag. Saisie insensible à la casse ; un caractère hors alphabet est refusé (400).
  - un **pid** : 16 caractères base32 aléatoires (80 bits). C'est le seul identifiant exposé aux autres comptes et utilisé dans les URL. L'id interne ne sort jamais.
- **Renommer** un profil garde son tag, sauf si le couple (nom, tag) est déjà pris : un nouveau tag est alors tiré.
- **Foyer** : les autres profils non enfants du même compte. Ils se voient sans demande (présence, messages, notes, bibliothèque complète, historique). Ils n'apparaissent pas dans `friends` ; on ne peut ni leur demander d'amitié (`409 already_friends`) ni les retirer.
- **Amis** : amitié entre deux profils de comptes différents, par demande et acceptation (ou demande croisée). Table `profile_friendships`.
- **Profil enfant** : aucune identité (ni handle, ni pid), donc ni amis, ni présence, ni messages, ni notes. Toute route `/user/social/*` avec un profil enfant répond `403 kid_profile`. Un profil qui devient enfant **perd** ses amitiés, sa présence, ses messages (dans les deux sens) et ses notes.
- Ces règles s'appliquent à la création, au renommage et au passage enfant / adulte d'un profil (`syncProfileIdentity`, `src/user/social-handles.ts`, appelé depuis `src/user/store.ts`).

### En-têtes

- `Authorization: Bearer <session>` : sinon `401 unauthorized`.
- `X-Profile-Id: <id du profil agissant>` : obligatoire (absent : `400 profile_required`). Le profil doit appartenir au compte (sinon `404 profile_not_found`).
- Si le profil a un PIN : `X-Profile-Token` (sinon `403 pin_required`).

### Tables

| Table | Contenu | Migration |
| --- | --- | --- |
| `profiles` (colonnes ajoutées) | `handle_name`, `handle_key`, `handle_tag`, `pid` ; index uniques sur `(handle_key, handle_tag)` et `pid` | v14 |
| `profile_friendships` | une ligne par paire (`low_pid < high_pid`), `requested_by`, `status` `pending` ou `accepted` | v14 |
| `profile_presence` | statut choisi, `watching` (JSON), `updated_at` (ms ; 0 = déconnecté) | v14 |
| `messages` | `from_pid`, `to_pid`, `body`, `context` (JSON), `created_at`, `read_at` | v15 |
| `notes` | `author_pid`, `type`, `tmdb_id`, `season`, `episode` (0 pour un film), `pos`, `kind`, `body`, `created_at` | v15 |

- Les tables v1 `friendships` et `presence` (niveau compte) restent en place.
- Backfill v14, exécuté **une seule fois** : les amitiés de compte à compte deviennent des amitiés entre profils principaux (premier profil non enfant créé) ; la présence du compte est rattachée à ce profil (`online`, ou `invisible` si le compte l'était, sans titre).
- Suppression d'un profil : `ON DELETE CASCADE` sur ses amitiés, sa présence, ses messages et ses notes.

### Routes `/user/social`

Réponses : JSON. Erreurs : `{ "error": "<code>" }` (+ `issues` pour `invalid_body`). Un `pid` mal formé équivaut à un `pid` inconnu.

| Méthode | Chemin | Effet | Réponse et erreurs |
| --- | --- | --- | --- |
| GET | `/me` | Profil agissant et statut choisi | `{ pid, handle, status, avatarColor }` |
| PUT | `/status` `{ status }` | Statut `online`, `away`, `dnd` ou `invisible` | `{ status }` |
| GET | `/friends` | Amis, foyer, demandes reçues et envoyées | `{ friends, household, incoming, outgoing }` |
| POST | `/requests` `{ handle }` | Demande par handle exact | 201 `{ request }` ; 200 `{ friend }` si demande croisée ; 404 `handle_not_found`, 400 `self`, 409 `already_friends` / `already_requested`, 429 `friend_limit_reached` |
| POST | `/requests/:pid/accept` | Accepte une demande reçue | `{ friend }` ; 404 `request_not_found`, 429 `friend_limit_reached` |
| DELETE | `/requests/:pid` | Refuse une demande reçue ou annule une demande envoyée | 204 ; 404 `request_not_found` |
| DELETE | `/friends/:pid` | Retire un ami (le foyer ne se retire pas) | 204 ; 404 `friend_not_found` |
| GET | `/friends/:pid/library?type&limit&offset` | Bibliothèque : ami = titres en `friends` ; foyer = tout | `{ items, total, limit, offset }` ; 404 `friend_not_found` |
| GET | `/friends/:pid/history?limit` | Historique récent (titres avec identifiant TMDB), du plus récent au plus ancien | `{ items }` ; 404 `friend_not_found` |
| GET | `/home/watching?limit=` | Accueil « ce que regardent tes amis » : une entrée par ami accepté (ni foyer, ni enfant, ni bloqué), sa progression la plus récente des 30 derniers jours (hors vu manuel), réglages et sourdine du lecteur appliqués ; `limit` de 1 à 50, 20 par défaut. `live` : titre en cours visible. Champs `friend` (pid, handle, avatarColor, avatar?, nickname?), `media`, `pos`, `duration?`, `finished`, `live`, `updatedAt` | `{ items }` ; 403 `kid_profile` |
| GET | `/home/progress?titles=movie:603,series:1399` | Progression des amis sur ces titres (20 au plus, `type:tmdbId`) : pour chaque ami qui passe le même garde-fou, sa progression la plus avancée (saison, épisode, position) des 30 derniers jours | `{ items }` ; 400 `invalid_body` (titres absents, mal formés ou plus de 20) ; 403 `kid_profile` |
| PUT | `/recommendations` `{ type, tmdbId, title, poster?, word }` | Mon coup de cœur sur un titre (un par titre : un nouveau mot remplace l'ancien et remonte en tête). `word` : 1 à 140 caractères après rognage ; `poster` gardée seulement si c'est un chemin ou une URL TMDB | 204 ; 400 `invalid_body` ; 403 `kid_profile` ; 429 `recommendation_limit_reached` (500 coups de cœur par profil au plus : une nouvelle clé au-delà est refusée, remplacer une clé existante reste permis). `tmdbId` de 1 à 999 999 999 |
| DELETE | `/recommendations/:type/:tmdbId` | Retire mon coup de cœur sur ce titre. Idempotent ; celui d'un autre profil n'est jamais touché | 204 ; 400 `invalid_body` ; 403 `kid_profile` |
| GET | `/home/recommendations?before=&limit=` | Coups de cœur des amis, du plus récent au plus ancien. Ni foyer, ni enfant, ni bloqué, ni non-ami. Un ami invisible reste visible ; sourdine et masquage posés par le lecteur appliqués. `limit` de 1 à 50 (20 par défaut) ; `before=<ms>` : strictement plus ancien (deux coups de cœur à la même milliseconde en bout de page peuvent donc être sautés). `next` (date du dernier) seulement si la page est pleine. Champs `friend`, `media`, `word`, `createdAt` | `{ items, next? }` ; 400 `invalid_body` ; 403 `kid_profile` |
| PUT | `/presence` `{ watching? }` | Battement (≈ 30 s, et à chaque lecture, pause, seek ou changement de média) ; `watching` absent ou `null` = en ligne | 204 ; 400 `invalid_body` |
| DELETE | `/presence` | Hors ligne immédiatement | 204 |
| POST | `/live-ticket` | Ticket de 60 s pour le flux temps réel | `{ wsPath }` ; 403 `kid_profile`, 429 `rate_limited` |
| GET | `/conversations` | Conversations avec amis et foyer (dernier message, non-lus) | `{ conversations }` |
| GET | `/messages/:pid?before&limit` | Fil avec un ami ou un membre du foyer, du plus ancien au plus récent | `{ messages }` ; 400 `self`, 403 `not_friend`, 404 `profile_not_found` |
| POST | `/messages/:pid` `{ body, context? }` | Envoi de message | 201 `{ message }` ; 400 `invalid_body`, 403 `not_friend`, 429 `rate_limited` |
| PUT | `/messages/:pid/read` | Marque lus les messages reçus de `:pid` | 204 ; mêmes erreurs que le fil |
| GET | `/notes?type&tmdbId&season&episode` | Notes d'un titre : les miennes, celles des amis et du foyer | `{ notes }` |
| POST | `/notes` `{ type, tmdbId, season?, episode?, pos, kind, body }` | Pose une note à une position | 201 `{ note }` ; 400 `invalid_body`, 429 `rate_limited` |
| PATCH | `/notes/:id` `{ kind, body }` | Modifie le texte ou l'emoji d'une note (auteur seulement ; position, date et titre inchangés, hors quota) | 200 `{ note }` ; 400 `invalid_body`, 404 `note_not_found` |
| GET | `/friends/:pid/notes?limit&before` | Notes d'un ami ou du foyer (ou les miennes), du plus récent au plus ancien ; `limit` de 1 à 50 (30 par défaut), `before` = createdAt en ms, exclu. Chaque note porte `media` (`{ type, tmdbId, season?, episode? }`, saison et épisode pour une série). Anti-spoiler : hors de mes propres notes, si mon `antiSpoiler` est vrai et que ma progression sur ce titre exact (type, TMDB, saison, épisode) n'est pas terminée et n'atteint pas `pos − 1` s (ou n'existe pas), la note sort avec `hidden: true` et `body: ""` | `{ notes }` ; 404 `friend_not_found` ; 403 `hidden` pour un ami dont `historyVisible` est faux (le foyer et soi-même voient toujours) |
| DELETE | `/notes/:id` | Supprime une note (auteur seulement) | 204 ; 404 `note_not_found` |

### Temps réel (WebSocket)

- **Ticket** : `POST /user/social/live-ticket` renvoie `{ "wsPath": "/user/social/live?ticket=…" }`. Ticket HMAC valable 60 s, lié au pid du profil agissant (portée `social-live:<pid>`), dont la finalité est distincte de celle des tickets de salon.
- **Connexion** : `GET /user/social/live?ticket=…` en WebSocket. Le Worker (`src/worker.ts`, `src/user/social-v2-live-ws.ts`) vérifie le ticket, l'en-tête `Origin` (403 `origin_forbidden` s'il n'est pas autorisé ; absent, le contrôle ne s'applique pas) et le débit de mise à niveau. Il transmet ensuite la connexion au Durable Object `UserStoreDO` avec le pid dans l'en-tête interne `x-social-live-pid`, que le client ne peut pas poser. Refus : 401 `invalid_ticket`, 426 hors mise à niveau, 429 `rate_limited`.
- **Une connexion par profil** : la nouvelle ferme l'ancienne avec le code `4000`. Les sockets utilisent l'API d'hibernation du Durable Object, étiquetées par pid.
- **Trames client** : seul `{"t":"ping"}` est reconnu, il reçoit `{"t":"pong"}`. Les autres trames sont ignorées. Une trame de plus de 1024 caractères ferme la connexion en `4013`. Au-delà de 30 trames par minute (ping compris), fermeture en `4008`.
- **Trames serveur** :

| `t` | Charge | Destinataires |
| --- | --- | --- |
| `message` | `message` | le destinataire |
| `read` | `pid` (le lecteur), `at` (ms) | l'expéditeur |
| `presence` | `friend` (vue ; `household` vrai pour le foyer) | amis, puis foyer, au changement de statut visible ou de titre |
| `request` | `request` (le demandeur) | le destinataire de la demande |
| `friend` | `friend` | les deux, à l'acceptation ou à la demande croisée |
| `unfriend` | `pid` | les deux |
| `note` | `media`, `note` | amis et foyer de l'auteur, à la pose et à la modification (le client remplace la note par son `id`) |
| `note_removed` | `media`, `id` | amis et foyer de l'auteur, à la suppression |

- **Émission** : après chaque écriture, `deps.socialEvents` appelle `UserStoreDO.liveBroadcast` en tâche d'arrière-plan. Une trame n'est remise qu'aux sockets ouvertes : rien n'est stocké ni rejoué. Après une coupure, relire `GET /social/friends` et `GET /social/conversations` (le contrat prévoit un repli en polling de 20 s).
- **Relais** : d'après le contrat, la connexion passe par `laststream-edge`, comme celle des salons. Cette configuration n'est pas dans ce dépôt.
- **Node** : ni porte WebSocket ni diffusion. Le `wsPath` renvoyé n'a pas de route.

### Limites

| Limite | Valeur | Portée | Dépassement |
| --- | --- | --- | --- |
| Amis acceptés | 200 | profil | 429 `friend_limit_reached` |
| Demandes envoyées en attente | 50 | profil | 429 `friend_limit_reached` |
| Messages envoyés | 30 par minute (fenêtre glissante) | expéditeur (profil) | 429 `rate_limited` + `Retry-After` |
| Notes posées | 20 par minute (fenêtre glissante) | auteur (profil) | 429 `rate_limited` + `Retry-After` |
| Texte d'un message | 1 à 1000 caractères, sans caractère de contrôle (saut de ligne admis) | | 400 `invalid_body` |
| Texte d'une note | 1 à 140 caractères sans contrôle, ou exactement un emoji | | 400 `invalid_body` |
| Notes d'un titre | 500 au plus, triées par position | | |
| Fil de messages | `limit` 1 à 50 (défaut 50) | | 400 |
| Historique | `limit` 1 à 50 (défaut 20) | | 400 |
| Bibliothèque | `limit` 1 à 100 (défaut 50), `offset` ≥ 0 | | 400 |
| Titre en cours | `title` 1 à 200 caractères, `pos` ≤ 10 000 000 s | | 400 |
| Ticket temps réel | 20 par minute | profil (mémoire de l'instance) | 429 `rate_limited` |
| Mise à niveau WebSocket | 30 par minute | IP (mémoire de l'instance) | 429 `rate_limited` |
| Trames WebSocket client | 30 par minute, 1024 caractères max | profil (mémoire du Durable Object) | 4008 ; trame trop grande : 4013 |
| Connexion temps réel | une par profil | profil | l'ancienne ferme en 4000 |
| Ensemble des routes `/user/*` | 300 lectures et 120 écritures par minute | IP | 429 `rate_limited` |

Les ticket, mise à niveau et trames sont en mémoire : elles repartent de zéro au redémarrage d'une instance et ne sont pas partagées entre instances. Les quotas de messages et de notes sont comptés en SQL.

### Sécurité

- Toute route exige une session et un profil agissant du compte, hors profil enfant (PIN déverrouillé si besoin).
- Bibliothèque, historique : un pid sans lien, inconnu ou mal formé reçoit le même `404 friend_not_found`. **Exception** : pour les messages, un pid existant sans lien répond `403 not_friend` et un pid inconnu `404`. L'existence d'un pid est donc révélée ; le risque reste faible, le pid étant aléatoire sur 80 bits.
- `POST /requests` révèle l'existence d'un handle (404 contre 201 ou 409). Le handle est fait pour être partagé.
- Champs exposés aux autres profils : `pid`, handle, couleur d'avatar, statut vu, `lastSeen` et titre en cours (ami ou foyer seulement, jamais hors ligne ni en mode invisible). Jamais de compte, de session, d'id interne ni de donnée debrid.
- Ticket : HMAC, 60 s, nonce, finalité et portée liées au pid ; un ticket de salon n'est pas accepté. Il transite dans l'URL (un navigateur ne pose pas d'en-tête sur une WebSocket) et le Worker retire la query avant de transmettre au Durable Object, qui fait confiance à `x-social-live-pid` : il ne doit être atteint que par le Worker.
- Contenu : messages et notes sont contrôlés en longueur et en caractères de contrôle (une note emoji doit être exactement un emoji). Il n'y a pas de filtre d'insultes ni de liens (contrairement au chat des salons). L'affichage doit échapper le texte.

### Compatibilité v1

- Les routes `/user/friends` (liste, demandes, acceptation, suppression) et `/user/presence` n'existent plus (sections 2 et 3). Les tables `friendships` et `presence` (niveau compte) servent encore au parrainage, à la bibliothèque v1 d'un ami et à l'administration.
- Une amitié créée en v1 n'apparaît pas en v2, et réciproquement. Une présence v1 n'est pas visible en v2. Le contrat prévoyait un mappage des routes v1 sur le profil principal : il n'est pas implémenté.
- Le parrainage (section 1) crée une amitié de compte uniquement : en v2, le filleul n'est pas ami du parrain tant que l'un des deux n'a pas envoyé de demande par handle.
- La bibliothèque d'un ami a la même forme d'élément en v1 (`GET /user/friends/:username/library`) et en v2 (`GET /user/social/friends/:pid/library`). La visibilité `private` / `friends` vaut dans les deux cas.

### Écarts avec le contrat et points d'attention

- Trame client trop grande : le contrat dit `1009`, le code ferme en `4013` (un Worker ne peut pas envoyer `1009`).
- Refus ou annulation de demande (`DELETE /requests/:pid`) : aucun événement temps réel. Le client doit relire `GET /social/friends`.
- Un profil passé en enfant perd définitivement ses messages et ses notes.
- Les événements ne sont ni stockés ni rejoués (voir Temps réel).

### Social v3 : groupes, liens publics, limites et confidentialité

Le contrat v3 (`docs/social-v3-contract.md`) est hors dépôt. Cette section décrit ce que le code applique, migration 23 comprise (table `rate_hits`, propriétaire des groupes).

**Groupes** (`/user/social/groups*`)

- Le créateur est le **propriétaire** : `Conversation.group.ownerPid` (nouveau champ, peut être le pid du profil qui lit). Seul lui renomme et ajoute ou retire des membres (`PUT /groups/:id` : 403 `owner_only` pour un autre membre, 404 `group_not_found` pour un non-membre).
- Chacun peut partir (`DELETE /groups/:id/me`). Si le propriétaire part (ou que son profil est supprimé ou devient enfant), la propriété passe au plus ancien membre (`joined_at`, puis pid). Un groupe sans membre est supprimé. La migration 23 applique la même règle aux groupes existants.
- À la création et à l'ajout, chaque membre ajouté doit être ami du propriétaire, accepter ses messages (préférence `messagesFrom` du membre ajouté) et ne pas être bloqué (dans un sens ou l'autre). Sinon 403 `not_allowed` avec `issues` = pids refusés ; `not_friend` garde la priorité si l'un des pids n'est pas un ami.
- 429 `rate_limited` au-delà de 10 créations de groupe par heure et par profil.
- **Blocage dans un groupe** : si A et B sont bloqués (dans un sens ou l'autre), A ne reçoit plus rien de B (événements `message`, `reaction`, `poll`, `typing`), `GET /conv/g:<id>/messages`, le dernier message et les non-lus de A ignorent les messages de B, et inversement. A ne peut pas réagir ni voter sur les messages de B (404). Personne n'est retiré du groupe.
- **Membre sans lien** : pour un membre de groupe ou de liste partagée qui n'est ni ami ni du foyer (ou bloqué), la vue `FriendView` ne contient que `pid`, `handle`, `avatarColor`, `avatar`, avec `status: "offline"` : jamais de titre en cours, de `lastSeen` ni de statut personnalisé.

**Conversations** (`/user/social/conv/*`)

- `POST /conv/:conv/messages` avec `kind: "party"` : 400 `kind_not_allowed`. Seule `POST /party/:id/invite` crée une invitation de salon.
- Frappe (`typing`) et réactions en DM : 403 `not_allowed` si le destinataire n'accepte pas les messages de l'expéditeur (`messagesFrom`) ; un blocage répond 404 `profile_not_found`.
- Réactions : 429 `rate_limited` au-delà de 60 par minute et par profil ; 409 `too_many_reactions` au-delà de 6 emojis distincts d'un profil sur un même message (retirer un emoji reste permis).
- `POST /join-requests/:pid` : `partyId` doit respecter `^[A-Za-z0-9_-]{4,64}$` (400 sinon).

**Demandes de rejoindre et signalements**

- `POST /friends/:pid/join-request` : 429 `rate_limited` au-delà de 5 demandes par tranche de 10 minutes vers le même ami. Une demande identique de moins de 60 s répond 204 comme avant, sans nouvel événement `join_request`.
- `POST /reports` : 429 `rate_limited` au-delà de 10 signalements par jour et par profil.

**Liens publics et listes partagées**

| Méthode | Chemin | Effet | Réponse et erreurs |
| --- | --- | --- | --- |
| POST | `/share-links` | Crée un lien (30 par heure et par profil) | 201 `{ url, code, inviteCode? }` ; 429 `rate_limited` ou `invite_quota_reached` |
| GET | `/share-links` | **Mes liens**, les plus récents d'abord, expirés compris | `{ links: [{ code, url, type, tmdbId, title, poster?, pos?, note?, inviteCode?, createdAt, expiresAt, expired }] }` |
| GET | `/share-links/:code` | Lecture publique, sans session | 200 ; 404 `share_not_found` ; **410 `expired`** après 30 jours ; 429 `rate_limited` (60 par minute et par IP) ; **400 `ip_required`** si l'adresse du client est inconnue |
| DELETE | `/share-links/:code` | Supprime mon lien et libère l'invitation qu'il réservait | 204 ; 404 `share_not_found` (inconnu ou pas de moi) |
| POST | `/lists` | Crée une liste (10 par heure et par profil, 50 possédées au plus) | 429 `rate_limited` ou `list_limit_reached` |

- Un lien expire 30 jours après sa création. À l'expiration (lecture, liste de mes liens ou création d'un nouveau lien), l'invitation réservée redevient libre (état `free`) si elle n'a pas été consommée.
- La page `/t/:code` (repli de l'interface) est servie avec `Referrer-Policy: no-referrer` et `X-Robots-Tag: noindex`.
- Images (`poster`, `still`, affiche du titre en cours) : un chemin TMDB strict (`^/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$`) ou une URL `https://image.tmdb.org/t/p/<taille>/<nom>.<ext>`, sans caractère de contrôle. Un titre ou un moment avec une autre valeur est refusé (400 `invalid_body`) ; une affiche de lien, de liste ou de titre en cours est retirée sans erreur.

**Limites persistantes** : les limites ci-dessus sont comptées en SQL (fenêtre glissante, table `rate_hits` pour les réactions, demandes de rejoindre, groupes, listes, liens et lectures publiques ; table `reports` pour les signalements). Elles survivent au redémarrage et sont partagées entre instances. Pour les lectures publiques, seul un condensat de l'IP est stocké. La frappe (une notification par tiers de seconde) reste limitée en mémoire.

**Identité retirée** : un profil qui devient enfant, ou qui est supprimé, perd toutes ses données sociales : activité, liens publics (invitation réservée libérée), listes possédées avec leurs éléments et membres, éléments ajoutés dans les listes des autres, appartenances aux listes et groupes, en plus des amitiés, messages, notes, blocages et préférences. `syncProfileIdentity` ne lève plus d'erreur de clé étrangère.

### Soirées planifiées (LAST-198)

Soirées ponctuelles ou séries hebdomadaires entre amis et membres du foyer (autres profils adultes du même compte, y compris ceux rattachés par invitation foyer ; LAST-1611), sous `/user/social/evenings*`, avec le profil agissant (`X-Profile-Id`). Un profil enfant reçoit 403 `kid_profile` sur les onze routes. Une soirée n'est visible que de son hôte et de ses invités non retirés. Code : `src/user/social-evenings-{store,routes,live,validation}.ts` ; types `Evening` et `EveningEvent` dans `@laststream/protocol` v0.4.0.

**Routes**

| Méthode | Chemin | Effet | Réponse et erreurs |
| --- | --- | --- | --- |
| GET | `/evenings?scope=&cursor=&limit=` | `upcoming` (défaut, annulées comprises), `past` (commencées, plus récentes d'abord), `invites` (à venir, hôte exclu, sans réponse) | `{ items, nextCursor }` ; 400 `invalid_body` |
| GET | `/evenings/:id` | Détail | 200 ; 404 `evening_not_found` |
| POST | `/evenings` | Crée une soirée ; `recurrence` (`weekly`, `interval` 1 ou 2, `until`) crée une série | 201 ; 400 ; 403 `not_friend` ; 429 `too_many_evenings` |
| PATCH | `/evenings/:id` | Titre ou début, sur `scope` `occurrence` ou `series` (`scope` seul : 400) | 204 ; 403 `not_host` ; 409 `evening_closed` |
| DELETE | `/evenings/:id?scope=` | `occurrence` annule ; `series` arrête la série | 204 ; 400 (`series` sur une ponctuelle) ; 403 `not_host` |
| POST | `/evenings/:id/guests` | Ajoute des amis (`pids`, 1 à 19) | 204 ; 400 ; 403 `not_friend` ou `not_host` |
| DELETE | `/evenings/:id/guests/:pid` | Retire un invité ; pid inconnu : 204 sans effet ; l'hôte ne se retire pas | 204 ; 400 (hôte) ; 403 `not_host` |
| PUT | `/evenings/:id/response` | Ma réponse : `yes`, `maybe` ou `no` | 204 ; 403 `not_host` ; 409 `evening_closed` |
| POST | `/evenings/:id/leave` | `occurrence` met « non » ; `series` retire mes occurrences futures et ne me génère plus | 204 ; 400 ; 403 `not_host` ; 409 |
| POST | `/evenings/:id/stop` | Arrête la série : occurrences futures annulées | 204 ; 400 (ponctuelle) ; 409 si déjà arrêtée |
| POST | `/evenings/:id/open` | Ouvre le salon de visionnage (voir plus bas) | 200 avec la soirée ; 403 `not_host` ; 409 `evening_not_open` ; 429 `too_many_rooms` ; 501 `party_unavailable` (Node) |

Erreurs communes : 404 `evening_not_found` pour un non-participant, un identifiant mal formé ou inconnu (même réponse) ; 409 `evening_closed` pour une soirée annulée, commencée ou dont la série est arrêtée.

**Droits**

- Un non-participant, y compris un autre profil du même compte, reçoit 404, jamais 403. Le foyer n'est pas une amitié : un profil ne peut ni inviter ni être invité par son jumeau.
- Invitation : ami accepté seulement. Demande en attente, blocage dans un sens ou dans l'autre, profil enfant et pid inconnu donnent le même corps `not_friend`.
- Blocage ou fin d'amitié : chacun est retiré des soirées futures de l'autre, séries comprises. Un invité bloqué avec un co-invité est masqué de la liste d'invités de l'autre, dans les deux sens, comme pour les groupes ; il reste participant.
- Passage en profil enfant : les soirées hébergées par le profil et ses invitations sont supprimées.

**Trames temps réel** (`t: "evening"`, émises après écriture ; ni stockées ni rejouées). Audience : l'hôte et les invités qui n'ont pas dit « non », hors profils bloqués avec l'acteur. Sous Node, pas de diffusion.

| `type` | Déclencheur | Destinataires |
| --- | --- | --- |
| `evening_invite` | Création, ajout d'invité | les invités ajoutés, jamais l'hôte |
| `evening_update` `updated` | Modification | l'audience |
| `evening_update` `cancelled` | Annulation, arrêt de série | l'audience |
| `evening_update` `cancelled` | Retrait d'un invité, blocage ou fin d'amitié | l'invité retiré ; l'hôte reçoit `updated`, sauf en cas de blocage entre eux |
| `evening_response` | Réponse, sortie | les autres participants (ni le répondant, ni les « non ») |
| `evening_reminder` | Rappel T-15 min | l'audience |
| `evening_open` | Ouverture du salon | l'audience |

**Rappel et alarme**

- Un rappel par soirée, à T-15 min, pour l'hôte et les invités qui n'ont pas dit « non ». Une modification de l'heure le réarme ; une soirée annulée n'en a pas.
- Sous Node, une minuterie passe chaque minute. Sous Workers, l'alarme du Durable Object est recalée après chaque écriture et à chaque réveil. Le tick est idempotent : `reminded_at` est posé dans la transaction qui lit le rappel.
- Le même tick complète la fenêtre de quatre occurrences de chaque série active, arrête les séries arrivées à leur fin et purge.

**Salon de visionnage** (`POST /evenings/:id/open`)

- Hôte seul, de T-15 min à T+2 h, soirée non annulée. Crée un salon privé au titre de la soirée et le rattache. Idempotent : un salon déjà rattaché est renvoyé sans trame. En cas d'ouverture simultanée, le premier rattachement gagne.
- `party: { partyId, title }` n'apparaît dans la soirée qu'après rattachement, pour les participants seulement.

**Plafonds**

| Limite | Valeur | Dépassement |
| --- | --- | --- |
| Soirées ponctuelles à venir, par hôte | 10 (une annulée libère sa place) | 429 `too_many_evenings` |
| Séries actives, par hôte | 5 (les occurrences ne comptent pas) | 429 `too_many_evenings` |
| Invités, hôte non compris | 19 | 400 `invalid_body` |
| Titre, après `trim` | 1 à 80 caractères | 400 |
| Début | entre 1 minute et 90 jours | 400 |
| Fin de série (`until`) | au plus 365 jours | 400 |
| Début d'une série | doit tomber sur la règle (jour, heure, cadence) | 400 |
| Liste | `limit` 1 à 50 (20 par défaut) | 400 |
| Rétention | soirées commencées depuis plus de 30 jours, purgées au tick | |

**Points d'attention**

- Le contrat v3 ne couvre pas les soirées : cette section décrit le code. Le masquage des co-invités bloqués suit la règle des groupes ; à valider côté produit.
- Après une coupure, relire la liste ou le détail : les trames ne sont pas rejouées.

## 1. Parrainage (inscription par lien)

L'inscription n'est possible qu'avec un lien de parrainage. Le tout premier compte d'un serveur vide s'inscrit sans lien (il devient propriétaire). `LASTADDON_ALLOW_SIGNUP=1` rouvre l'inscription libre : option réservée aux serveurs personnels, absente du Worker public.

Chaque compte possède 4 liens (quota ajustable par le propriétaire). Un lien = une inscription. Le filleul devient **automatiquement ami** du parrain (amitié de compte en v1 ; voir Compatibilité v1 pour la v2).

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

## 2. Amis et présence (retirés)

Les routes de v1 `GET /user/friends`, `POST /user/friends/requests`, `POST /user/friends/requests/:username/accept`, `DELETE /user/friends/requests/:username`, `DELETE /user/friends/:username`, `PUT /user/presence` et `DELETE /user/presence` ont été supprimées : plus aucun client ne les appelle. Utiliser `/user/social/friends`, `/user/social/requests` et `/user/social/presence` (Social v2). Le parrainage continue de créer une amitié de **compte** (table `friendships`).

## 4. Bibliothèques partagées

Chaque titre de bibliothèque porte `visibility` : `private` (défaut) ou `friends`. `GET /user/profiles/:id/library` renvoie ce champ pour chaque élément. Ré-ajouter un titre ne change pas sa visibilité. La visibilité vaut aussi en v2. La lecture de la bibliothèque d'un ami est en v1 `GET /user/friends/:username/library`, et en v2 `GET /user/social/friends/:pid/library`.

| Route | Effet |
| --- | --- |
| `PUT /user/profiles/:id/library/:type/:itemId/visibility` `{ "visibility" }` | Un titre (`204`, `404 library_item_not_found`) |
| `PUT /user/profiles/:id/library/visibility` `{ "visibility", "type"? }` | Toute la bibliothèque, ou tous les films / séries : `200 { "updated": n }` |
| `GET /user/friends/:username/library?type=&limit=&offset=` | Bibliothèque visible d'un ami (v1, **à retirer après déploiement de l'application** qui lit désormais `GET /user/social/friends/:pid/library`) |

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
| `{t:"ctl", action:"play"\|"pause"\|"seek", pos:<s>}` | tous | lecture partagée : change l'état, diffusé à tous ; `rev` croît |
| `{t:"ctl", action:"sync", pos:<s>}` | **hôte** | rapport périodique de position, horloge de référence (toutes les ~5 s) ; rediffusé seulement si l'écart dépasse 0,75 s |
| `{t:"episode", season, episode, fingerprint?}` | **hôte** | changement d'épisode (séries) ; position remise à 0, en pause |
| `{t:"chat", text}` | tous | message (500 caractères, filtré) |
| `{t:"react", emoji}` | tous | réaction parmi 👍 ❤️ 😂 😮 😢 👏 🔥 🎉 |
| `{t:"buf", ready, ahead:<s>}` | tous | déclare son tampon : `ready` = assez d'avance pour lire, `ahead` = secondes bufferisées devant la position (0 à 600) ; 20 déclarations / 10 s. Un participant qui n'est pas prêt retient la lecture (voir `wait`) |
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
| `wait` | `who` (pseudos des retardataires en tampon ; vide = fin d'attente), `since` (début, ms serveur), `maxMs` (délai avant reprise sans eux : 45 s), `resumeAhead` (avance en s à partir de laquelle un participant est prêt : 10). Fin d'attente : tous prêts, retardataire parti ou exclu, ou délai dépassé. La lecture reprend si l'attente l'avait suspendue ; seule une pause explicite annule cette reprise |
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
4. Tout participant envoie un `ctl` `play`, `pause` ou `seek` à chaque action locale (y compris l'hôte) ; l'hôte envoie en plus `ctl` `sync` avec sa position environ toutes les 5 s. Chacun applique à son lecteur chaque `state` reçu (pause et reprise comprises) sans renvoyer ce changement (anti-écho : pas de commande pendant l'application d'un état reçu, et une commande locale n'est pas annulée avant l'écho du serveur). Si un participant a changé de version (autre fichier, autre durée), il peut se recaler avec `{t:"sync"}`.

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

- Migrations SQL : `src/user/migrations.ts`, versions 7 (fonctions sociales v1 : `invites`, `friendships`, `presence`, `hidden_titles`, `hidden_import`, `party_rooms`, colonnes `accounts.invite_quota` et `library_items.visibility`) à 17 (v13 : agrégat `title_starts` ; Social v2 : v14 identités et amitiés par profil, v15 messages et notes, v16 journal `note_creations`, v17 nonces `live_ticket_nonces`). Appliquées automatiquement au démarrage (Node) et par le Durable Object `UserStoreDO`.
- Durable Objects (`wrangler.jsonc`) : `PARTY_ROOM` → classe `PartyRoom` (migration `v2`, SQLite) ; `USER_STORE` → `UserStoreDO`, qui porte aussi le flux temps réel social. Déploiement : `npm run deploy:worker`.
- Comptes de test sur un serveur public : la route d'administration `POST /__admin/invite` (en-tête `x-admin-secret`, secret `ADMIN_SECRET` posé temporairement) crée une invitation « système » (sans parrain, donc sans amitié) ; `DELETE /__admin/invite/<code>` la supprime. Supprimer ensuite le secret avec `wrangler secret delete ADMIN_SECRET`.
- Tests : `npm test` (Node, dont le cœur du salon et `tests/social-v2-*.test.ts`) et `npm run test:workers` (parrainage, amis, présence, visibilité, masqués et Social v2 contre le Durable Object ; salons avec vraies WebSocket, et temps réel social dans `tests-workers/social-live.test.ts`).
