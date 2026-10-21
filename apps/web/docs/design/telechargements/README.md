# Maquettes : téléchargements hors ligne (ODY-197)

Référence de conception pour ODY-198 à ODY-204 (chapeau : ODY-183).

- Canvas de design (modifiable, privé) : https://claude.ai/artifact/ShZc3L9JutoEjMnGsMYdMm
- Sources versionnées : `project/` (une maquette par fichier `.dc.html`, plan du canvas dans `project/canvas.json`). Le canvas publié et ces fichiers sont identiques ; en cas de modification dans le canvas, recopier les fichiers ici.
- `project/Main.dc.html` : guide (états du bouton, règles, plateformes, jetons, lecture pour les issues).

## Écrans

| Plateforme | Fichiers |
|---|---|
| Mobile (390 × 844) | `mobile-fiche-film`, `mobile-fiche-serie` (épisodes), `mobile-choix-qualite`, `mobile-telechargements`, `mobile-erreur`, `mobile-vide`, `mobile-hors-ligne`, `mobile-quota`, `mobile-suppression`, `mobile-reglages` |
| Desktop (Windows) | `desktop-fiche`, `desktop-telechargements`, `desktop-etats` (vide, erreur, quota, suppression) |
| Web | `web-telechargements` (quota navigateur, stockage persistant, avertissements) |
| TV (D-pad) | `tv-telechargements`, `tv-fiche` |

## Décisions de design

- **États du bouton** : disponible, en attente, en cours, en pause, terminé, erreur, indisponible. Les cinq premiers sont ceux du socle (ODY-198) ; « disponible » et « indisponible » sont dérivés de la source (une source HLS sans fichier direct n'est pas téléchargeable : bouton désactivé avec la raison).
- **Bouton large sur la fiche**, à côté de « Lire » : la progression remplit le bouton. **Pastille ronde de 44 px sur chaque épisode** : anneau de progression. Un toucher met en pause ou reprend ; un titre terminé ouvre « Lire hors ligne » et « Supprimer ».
- **Choix de qualité et de langues** dans une feuille basse au premier téléchargement (mémorisé ensuite dans Réglages > Lecture > Stockage).
- **Accès** : compte connecté, barre mobile à 4 onglets (`src/ui/home.js`) : cinquième onglet « Téléchargés » avec pastille du nombre en cours ; sans compte social, la barre a déjà 5 onglets (`src/ui/constants.js`) : carte « Téléchargements » en tête de Bibliothèque ; profil enfant : masqué (comme Statistiques et Réglages) ; bouton rond avec pastille dans la barre du haut desktop, web et TV ; route `#/downloads`.
- **Espace** : jauge sur l'écran Téléchargements ; limite choisie (5, 10, 20, 50 Go, sans limite) ; avertissement à 90 %, feuille « Espace plein » à 100 %.
- **Hors ligne** : bandeau fixe, seuls les titres téléchargés restent actifs.
- **Suppression** : toujours confirmée ; toast « Annuler » après suppression d'un titre.
- **Vert de réussite** : seul jeton nouveau, `--ok: #6fd8a8` (le reste vient de `src/styles/styles.css`).
- **Web** : télécharge tant que l'onglet est ouvert ; bouton « Activer le stockage persistant » ; avertissement Safari et iOS (purge possible).

## Points ouverts

- Profil enfant : masquer les téléchargements est une hypothèse ; à confirmer.
- `support.js` (runtime du canvas) est référencé par chaque maquette mais non versionné : les `.dc.html` se lisent comme du HTML, le rendu complet passe par le canvas.
- Barres de progression : prévoir `role="progressbar"` avec `aria-valuenow` à l'implémentation (ODY-204).
- Validation des maquettes par l'utilisateur (critère d'ODY-197).
- Valeurs par défaut de la limite d'espace par plateforme et seuil d'avertissement.
- Lien de téléchargement expiré : le renouvellement automatique dépend du socle (ODY-198).
- Téléchargement de saison entière : taille estimée affichée, une seule confirmation (à valider avec ODY-198).
