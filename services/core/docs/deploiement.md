# Déploiement et releases (LAST-150)

On ne déploie que depuis un tag `vX.Y.Z` posé sur `main` (lastaddon) ou `master` (laststream-edge). Les scripts refusent tout le reste.
La garde est dans `scripts/lib/deploy-guard.mjs` (copie identique dans `laststream-edge/scripts/lib/`) ; tests : `tests/deploy-guard.test.ts`.

## Procédure

1. Fusionner les PR dans `main`, se placer sur `main` à jour (`git switch main && git pull`).
2. Créer la release : `npm run release -- 0.2.0` (idem dans laststream-edge). Le script vérifie que la branche est propre et à jour,
   que la version est supérieure à la dernière étiquette, crée le tag annoté `v0.2.0` (notes : titres des commits depuis le tag précédent),
   le pousse, puis lance `gh release create v0.2.0 --notes-file …`. `--dry-run` affiche les notes sans rien créer.
3. Déployer depuis ce tag : `git checkout v0.2.0` (HEAD détaché sur le tag), puis `npm run deploy:worker -- --ui ../laststream-app/dist`
   (edge : `npm run deploy`). `--dry-run` fait toutes les vérifications sans copier ni déployer.
4. Revenir sur la branche (`git switch main`).

## Ce que la garde refuse (code de sortie 1, message listant toutes les raisons)

- arbre suivi sale (les fichiers non suivis ne comptent pas) ;
- branche autre que `main` (lastaddon) / `master` (edge) ;
- HEAD différent de `origin/<branche>` après `git fetch` (copie locale en retard ou en avance) ;
- HEAD n'est pas exactement un tag `vX.Y.Z` (`git describe --exact-match --tags`), ou ce tag n'existe pas sur `origin` ;
- avec `--ui` (lastaddon) : le dépôt `laststream-app` du build doit aussi être propre, sur `main`, égal à `origin/main`. Son SHA est
  enregistré dans le message du déploiement (`<tag> <sha> ui:<sha>`). La garde ne prouve pas que `dist/` a été construit depuis ce SHA :
  reconstruire le build (`npm run build` dans laststream-app) juste avant.

Un HEAD détaché sur le tag (`git checkout v0.2.0`) est accepté : il doit alors être égal à `origin/main` (ou `origin/master`), donc être la pointe
de la branche de référence. Depuis une branche de feature, ou un tag posé sur un commit plus ancien que la pointe, le déploiement est refusé.

## Verrou entre sessions

Deux déploiements simultanés (deux sessions, deux machines) sont refusés par une clé KV :

| Dépôt | Namespace KV (lié au Worker) | Clé |
| --- | --- | --- |
| lastaddon-core | `CACHE` (`wrangler.jsonc`, `kv_namespaces`) | `deploy-lock:lastaddon-core` |
| laststream-edge | `LASTSTREAM_ROUTE` (son `wrangler.jsonc`) | `deploy-lock:laststream-edge` |

- Écriture via `wrangler kv key put --remote --ttl 900` : le verrou expire seul après 15 minutes. Valeur : hôte, PID, horodatage, SHA, tag, jeton.
- Refus si la clé existe et n'est pas expirée (le script contrôle aussi `expiresAt`, le TTL de KV pouvant traîner).
- Supprimé en fin de script, succès ou échec (`finally`), et sur Ctrl+C. Il n'efface que son propre verrou (jeton).
- `--force-unlock` écrase un verrou existant : à n'utiliser que si son propriétaire est mort et que l'expiration n'est pas attendue.
- Pourquoi ces namespaces : `CACHE` est déjà lié à lastaddon-core et ne sert qu'à des caches à clés préfixées ; `LASTSTREAM_ROUTE` est déjà lié
  à l'edge. Aucun namespace nouveau, et une clé `deploy-lock:*` n'entre en collision avec aucune clé existante.
- Limite : KV est cohérent à terme. Le script relit la clé après écriture pour détecter une course, mais deux démarrages à la même seconde
  restent théoriquement possibles. C'est une barrière anti-collision entre sessions, pas un verrou strict.

## Version déployée

- `wrangler deploy --tag vX.Y.Z --message "vX.Y.Z <sha>"` : la version Cloudflare porte le tag (`wrangler versions list`, tableau de bord).
- lastaddon-core reçoit aussi `--var LASTADDON_RELEASE:vX.Y.Z`. `serverRelease()` (`src/app.ts`) l'utilise pour `/health` (`release`) et pour la release
  Sentry (`lastaddon-core@vX.Y.Z`). Sans la variable (serveur Node, `wrangler dev`, déploiement manuel) ou si elle n'a pas la forme `vX.Y.Z`,
  repli sur `MANIFEST.version`. La variable n'est pas dans `wrangler.jsonc` : un déploiement manuel retombe sur le manifeste au lieu d'un tag périmé.

## Retour arrière

Retour arrière : `npx wrangler rollback` (ou `wrangler rollback <version-id>`) ; on ne redéploie pas un ancien tag (HEAD doit égaler origin/main).

## Ordre de déploiement

1. **lastaddon-core** d'abord (le Worker appelé), avec l'interface de laststream-app qu'il sert (`--ui`, copiée dans `worker-ui/` puis téléversée
   comme Workers Assets).
2. **laststream-edge** ensuite (l'appelant, Service Binding `CORE` vers lastaddon-core) : il ne doit jamais appeler une route que le core ne connaît pas encore.
   Un changement d'edge seul se déploie sans toucher au core.

## Autres cibles

- **Interface web** : servie par lastaddon-core ; elle part avec `npm run deploy:worker -- --ui <build>`, depuis un tag lastaddon.
- **Shell (laststream-shell-ng)** : release sur tag par workflow GitHub, suivie dans LAST-159 ; non couverte par ces scripts.
- Secrets : jamais par ces scripts (`wrangler secret put`).
