# Gabarit d'un guide

Gabarit des pages `public/guides/<slug>/index.html`, à copier pour chaque nouveau guide (`guides/<slug>/index.html`).

Ce texte était le commentaire d'en-tête des guides publiés. Il est déplacé ici : ce fichier reste hors `public/`, donc il n'est pas publié.

## Structure

- **Head** : charset, viewport, `<title>` « Titre - Guides Laststream », meta description, canonical, og/twitter, favicons, preload des deux polices, `/style.css` puis `/guides/guides.css`.
- **Header et footer** : identiques à l'accueil, avec brand `href="/"` et liens `"/#ancre"` (pas `"#ancre"`).

1. **Fil d'Ariane** : `<nav class="guide-crumbs"><ol>` Guides (lien `/guides/`) › `<li aria-current="page">Titre</li>`.
2. **En-tête** (`<header class="guide-hero">`) : `<h1>` ; un chapô d'une phrase en `<p class="lead">` ; badges `<ul class="guide-badges">` avec `<li class="is-time">2 min</li>` puis une `<li>` par plateforme.
3. **Vidéo du parcours** en tête (facultatif, dans le hero) :
   - avec le fichier : `<figure class="shot"><video class="clip" src="./clip.mp4" poster="./img/poster.webp" controls autoplay muted loop playsinline></video></figure>`
   - sans fichier : `<figure class="shot">` + classe `todo`, avec `<span>Vidéo à venir</span>`
4. **Prérequis** (facultatif) : `<section class="guide-prereq">` avec `<h2>` et `<ul>`.
5. **Étapes** : `<ol class="guide-steps">` ; chaque `<li>` = `<p>` + figure facultative.
   - avec capture : `<figure class="shot"><img src="./img/NN-nom.webp" width="…" height="…" loading="lazy" alt="…"></figure>`
   - sans capture : `<figure class="shot">` + classe `todo`, avec `<span>Capture à venir</span>` (ratio 16/10, texte neutre, aucune image cassée ; remplacer dès que la capture existe)
6. **Bon à savoir** : `<aside class="guide-tip" aria-label="Bon à savoir"><p class="guide-tip-title">Bon à savoir</p>` + `<ul>`.
7. **Guides voisins** : `<nav class="guide-pager">` avec `<a class="next">` (« Guide suivant ») et/ou `<a class="prev">`.
8. **Code** (guides techniques) : `<pre><code>…</code></pre>`, stylé par `guides.css`.
9. **Script de bas de page** : ne rien changer. Il coupe l'autoplay des vidéos si `prefers-reduced-motion` est actif.

Pas de dépendance externe, pas de framework. Une seule feuille locale en plus de `/style.css`.

## Check-list « créer un guide » (à faire avant de publier)

- [ ] ajouter l'URL du guide dans `public/sitemap.xml` ;
- [ ] dans `guides/index.html`, passer la carte du guide de `is-soon` à un lien (href vers le guide) ;
- [ ] adapter le JSON-LD `BreadcrumbList` (nom et URL du guide en position 2) ;
- [ ] copier tel quel le script de fin de page (reduced-motion), sans le modifier ;
- [ ] mettre à jour « Guide précédent » / « Guide suivant » sur les guides voisins.
