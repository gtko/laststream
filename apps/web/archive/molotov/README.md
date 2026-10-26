# Molotov TV (archivé)

Intégration de la TV française Molotov : connexion au compte, catalogue et guide des chaînes, replay, lecture DASH protégée (Widevine).
Archivée par LAST-184 : elle n’est plus proposée dans l’app (réglages, TV en direct, lecteur, accueil, services). Sa logique est conservée ici, intacte, pour une réactivation.

Le code n’est pas supprimé. Il sort du périmètre de build, de test, de lint et d’analyse : archive/ est exclu de tsconfig, eslint, vitest et knip.

shaka-player 4.15.0 est conservé dans package.json pour la réactivation; types dans src/env.d.ts.

## Contenu

Les chemins gardent la structure du dépôt : pour réactiver, chaque fichier retourne à son emplacement d’origine.

- src/data/molotovApi.ts : client API (catalogue, guide, replay, lecture, licence)
- src/data/molotovAuth.ts : connexion par email et mot de passe, vérification en deux étapes
- src/player/molotov.ts : lecteur DASH Widevine (Shaka Player)
- src/ui/molotovReplay.js : grille replay de l’écran TV
- tests/molotovApi.test.ts, tests/molotovAuth.test.ts, tests/molotovGuide.test.ts, tests/molotovReplay.test.ts

Ces tests importent aussi des modules qui restent dans src (config, session) : ils ne tournent qu’une fois remis à leur emplacement d’origine.

Côté serveur (lastAddon, hors de ce dépôt), les routes /user/account/molotov/* ne sont plus appelées par l’app.

## Réactiver

1. Remettre chaque fichier de ce dossier à son chemin d’origine (git mv archive/molotov/src/... src/... ; idem pour tests/).
2. Retirer « archive/** » des exclusions de tsconfig.json, eslint.config.js (ignores), vite.config.ts (test.exclude) et knip.json (ignore).
3. Rétablir les points de rebranchement ci-dessous, aux lignes du commit de base daadf58 (avant LAST-184).
4. Lancer typecheck, lint, test et knip.

## Points de rebranchement (commit daadf58)

- src/ui/settings-tv.js : l.9-10 imports molotovApi et molotovAuth ; l.52 appel de molotovCardHTML() à la fin de dynamicHTML (rétablir le « + ») ; l.71 loadMolotovStatusSoon() dans tvPanelHTML ; l.83-273 état, formulaire, connexion, vérification, déconnexion et carte Molotov ; l.322-327 clics data-molotov-* ; l.338-344 écouteur input (email, mot de passe, code).
- src/ui/tv.js : l.5 et l.18 imports ; l.34-35 tv.molotov et tv.molotovLoading ; l.38 MOLOTOV_CAT ; l.52 allChannels ; l.94 playableChannels ; l.97-181 molotovChannel, loadMolotovChannels, molotovProgs, ensureMolotovEpg ; l.198 catégorie Molotov dans syncBox ; l.364-366 et l.389 guide Molotov dans ensureEpg ; l.397-400 repli nowNext sur c.program (programme annoncé par le catalogue) ; l.440 et l.443-444 tvFilter (Favoris, catégorie Molotov) ; l.455-456 chaînes Molotov après les playlists ; l.466-467 catCount ; l.481-482 catsHTML (catégories Molotov et replay) ; l.571 badge Molotov ; l.593-594 repli c.program dans fillEpgRow ; l.600-604 grille replay dans renderEpgGrid ; l.649-650 chargement catalogue et replay dans tvPageHTML ; l.706-712 setCategory (catégorie replay) ; l.722 toggleFav.
- src/ui/player.js : l.6-7 imports ; l.121 destroyMolotov() dans destroyStream ; l.241 store ls_tv_last avec la condition « pas un replay » (c.molotovPlay) et le champ molotovId ; l.282-283 routage vers startMolotov ; l.362-395 molotovFail et startMolotov (lecteur DASH, lien « Ouvrir Molotov dans le navigateur »).
- src/ui/events.js : l.17 import ; l.112-122 clics data-tvreplay et data-tvreplayplay.
- src/ui/shows.js : l.107 recherche de favori dans tv.molotov.
- src/ui/services.js : l.30 service Molotov (libellé, logo, couleur).
- src/ui/tvStatus.js : l.15-16 libellés des causes molotov et molotov_drm.
- src/styles/styles.css : l.1226-1227 règle .replay-grid.
- src/data/crossFetch.ts : fonction appFetchBinary (variante binaire du pont natif, licence DRM) retirée car sans usage hors Molotov : la rétablir depuis daadf58 (l.47-70) avant de réactiver molotovApi.ts.
- src/env.d.ts : l.8 commentaire sur le lecteur Molotov (les types Shaka sont conservés, rien à rétablir).
- eslint-suppressions.json : l.217-222 entrée src/ui/molotovReplay.js (no-restricted-syntax, count 2).
