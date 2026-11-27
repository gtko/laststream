# laststream-site

Site vitrine de Laststream (FR et EN écrits à la main, autres langues générées), servi par un Worker Cloudflare nommé `laststream-www` (voir `wrangler.jsonc`).
`src/worker.js` répond à `/api/android` et `/api/windows` en relayant le `latest.json` de l'app (binding `APP`) ;
toutes les autres requêtes sont servies depuis `public/` (binding `ASSETS`).

## Commandes

- `npm run deploy` : lance `wrangler deploy`.
- Dev et build : aucun script dans `package.json`, rien à lancer.

## Contenus

- `src/worker.js` : le Worker (relais `/api/android` et `/api/windows`, sinon repli sur les assets).
- `public/` : tout ce qui est publié tel quel.
  - `index.html` (FR) et `en/index.html` (EN) : accueil, avec `home.css`, `home.js` et `app.js` (liens de téléchargement).
  - `beta-migrants/` : programme bêta des personnes venues de Stremio ou Nuvio, avec le journal daté des retours et corrections (à tenir à jour à la main, du plus récent au plus ancien).
  - `guides/` : guides illustrés, un dossier par guide (`index.html`, `img/`, `clip.mp4`), styles `style.css` et `guides/guides.css`.
  - `assets/` : logos, icônes, polices, captures (`shots/`), image de partage (`og.png`).
  - `robots.txt` et `sitemap.xml` : indexation.
- `i18n/` et `scripts/i18n-site.mjs` : autres langues (LAST-1658). Les pages anglaises servent de source ; chaque
  catalogue `i18n/<code>.json` (texte anglais → traduction) produit `public/<code>/`, avec les liens hreflang, le menu
  des langues et `sitemap.xml`. Après une modification des pages anglaises : `npm run i18n:extract`, traduire les textes
  nouveaux de `i18n/messages.json`, puis `npm run i18n:check` et `npm run i18n:build`. Les pages générées ne se
  modifient pas à la main.
- `guides-capture/` : outil de captures pour les guides (scripts Node et Playwright headless, données fictives), hors publication. Voir `guides-capture/README.md`.

## Déploiement

Déploiement : depuis master à jour uniquement.
