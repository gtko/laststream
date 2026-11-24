# Forum communautaire

Le forum est intégré à l'app (`#/forum`, menu « Explorer » › Forum) et servi par `services/core` sous `/user/forum`.

## Qui y a accès

Chaque route ouvre une session (`sessionOf`) : sur le service en ligne, un compte sans abonnement de soutien reçoit
`402 subscription_required`, comme pour le reste de l'app (voir [abonnement.md](abonnement.md)). Un serveur
auto-hébergé sans Stripe ouvre le forum à tous ses comptes. Les invités du foyer d'un abonné y ont accès. Les profils
enfants n'y ont pas accès. On écrit au nom d'un profil (son `Nom#TAG`).

## Catégories

Fixées par la migration 37 : Annonces (équipe seulement), Remontée de bugs, Idées et demandes, Entraide, Guides et
astuces, Extensions Stremio et sources, Films et séries, Hors-sujet.

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

## Prévu ensuite

Lien des sujets avec les fiches de films, anti-spoiler selon la progression, votes sur les idées avec statut, temps
réel (nouvelles réponses en direct), notifications de mention et de réponse.
