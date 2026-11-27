# Forum communautaire

Le forum est intégré à l'app (`#/forum`, menu « Explorer » › Forum) et servi par `services/core` sous `/user/forum`.

## Qui y a accès

Le forum n'existe que sur le service en ligne : sans abonnement de soutien configuré (`STRIPE_SECRET_KEY` et
`STRIPE_PRICE_ID`, voir [abonnement.md](abonnement.md)), c'est-à-dire sur un serveur auto-hébergé, toutes les routes
répondent `404 forum_unavailable` et l'app masque l'entrée Forum (elle lit `subscription.enabled` de `/user/me`).
Sur le service en ligne :

- **Lire est libre**, même sans compte. Sans jeton ou sans `X-Profile-Id`, les routes de lecture (`GET /forum`,
  catégories, recherche, sujet) répondent pour un visiteur (`me.guest`). Dans l'app, `#/forum` s'ouvre sans écran de
  connexion pour un visiteur ou un compte sans abonnement (`isForumVisitor`, voir `main.js`). Toute autre page ramène à
  la connexion. L'écran d'abonnement propose « Lire le forum de la communauté ».
- **Écrire demande une connexion** : session et profil non enfant, avec ou sans abonnement (le forum est exempté du 402,
  voir `billing/access.ts`). Sans session : 401. On écrit au nom d'un profil (son `Nom#TAG`).
- **Sections réservées** : une catégorie `paid_only` (migration 39 : Watch parties seulement) est réservée aux abonnés de
  soutien (accès payé, offert ou période gratuite) et à l'équipe. Pour les autres, ses sujets apparaissent dans les
  listes sans titre ni extrait ni salon (`restricted: true`), et l'app floute ces cartes. Ouvrir un tel sujet ou y écrire
  (sujet, réponse, réaction, signalement, inscription, salon) répond `403 paid_only`. La recherche ignore ces sections.
  Pour réserver une autre catégorie : `UPDATE forum_categories SET paid_only = 1 WHERE id = '…'`.

Les invités du foyer d'un abonné en profitent aussi. Les profils enfants n'y ont pas accès (403).

## Catégories

Fixées par la migration 37 : Annonces (équipe seulement), Remontée de bugs, Idées et demandes, Entraide, Guides et
astuces, Extensions Stremio et sources, Films et séries, Watch parties, Hors-sujet.

## Accueil

`GET /user/forum` rend aussi `pulse` : chiffres (sujets, messages, membres qui écrivent, messages des dernières 24 h),
8 dernières discussions avec un extrait en texte brut du dernier message (spoilers remplacés), 5 sujets les plus actifs
sur 7 jours, 8 membres les plus actifs sur 30 jours et les 6 prochaines séances. L'app y ajoute les salons publics en
direct (`GET /party`) et rafraîchit l'accueil toutes les minutes tant qu'il est affiché.

## Watch parties

Un sujet de la catégorie Watch parties porte une séance (`startsAt`, de 5 min à 90 jours à l'avance, obligatoire là et
refusé ailleurs) ; son auteur y est inscrit. `PUT /forum/topics/:id/rsvp {on}` inscrit ou désinscrit (fermé 3 h après
le début). `POST /forum/topics/:id/open` (auteur ou équipe, de T-15 min à T+3 h) ouvre un salon de visionnage public au
titre du sujet et le rattache ; un salon terminé est remplacé. Sans salons (serveur Node) : 501 `party_unavailable`.

## Écrire

- Sujets et réponses en Markdown réduit (gras, italique, barré, code, citations, listes, liens http(s), `||spoiler||`,
  mentions `@Nom#TAG`). Le rendu est construit en nœuds DOM (`apps/web/src/ui/forumMarkdown.js`), jamais en HTML.
- Titre de 3 à 120 caractères, message de 10 000 caractères au plus.
- Réactions : palette fixe de 8 emojis.
- Limites par profil : 5 sujets par heure, 20 messages par 10 minutes, 20 signalements par heure (l'équipe n'est pas
  limitée en écriture).
- On modifie et supprime ses messages. Supprimer le premier message d'un sujet sans réponse retire le sujet.

## Modération

- Rôles : le propriétaire du serveur est toujours modérateur ; il nomme d'autres modérateurs par `Nom#TAG`
  (`#/forum/mod`).
- Signalement d'un message (spam, harcèlement, piratage, spoiler, hors-sujet, autre). Au 3ᵉ signalement distinct, le
  message est masqué en attendant l'équipe (jamais celui d'un membre de l'équipe).
- L'équipe épingle, verrouille, masque, déplace un sujet ; masque ou rétablit un message ; classe des signalements ;
  exclut un membre (1, 7, 30 jours ou sans limite). Un exclu lit le forum mais n'écrit plus.

## Feedback de l'app

Le bouton « Envoyer un feedback » de l'app (menu du profil, lecteur, lien « Signaler » d'une erreur interceptée, LAST-1654)
publie par `POST /user/forum/feedback {kind, code?, title?, message, version?, platform?, sentryEventId?}`, au nom du profil
et avec les mêmes règles que l'écriture ordinaire (exclusion, limites de débit) :

- `kind: 'bug'` va dans « Remontée de bugs », `kind: 'idea'` dans « Idées et demandes ».
- Un bug avec `code` (empreinte de l'erreur, ex. `player:lecture-impossible:http-503`) rejoint le dernier sujet ouvert
  (visible, non verrouillé) de même empreinte en réponse « Moi aussi » ; sinon un sujet est ouvert. Verrouiller ou masquer
  le sujet (bug corrigé) fait ouvrir un sujet neuf au signalement suivant.
- Le texte est composé par le serveur : titre de l'erreur, message, version et type d'appareil. Le détail technique part
  vers Sentry, jamais sur le forum ; seule la référence de l'événement Sentry est gardée (table `forum_feedback`,
  migration 38).
- `GET /forum/topics/:id` rend `feedback: { reporters }` (profils distincts) sur ces sujets, plus `sentryEventIds` (20
  plus récentes) pour l'équipe.

Réponse : 201 `{ topic, grouped, reporters }`.

## Prévu ensuite

Lien des sujets et des séances avec les fiches de films, anti-spoiler selon la progression, votes sur les idées avec statut, temps
réel (nouvelles réponses en direct), notifications de mention et de réponse.
