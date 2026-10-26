# laststream-edge

Worker Cloudflare `laststream-edge` (https://app.laststream.app) : adresse publique fixe de Laststream.

- Toutes les routes sont relayées vers le Worker `lastaddon-core` par Service Binding (`CORE`), avec réessais (502/503/504, erreurs réseau),
  page d'attente HTML FR si rien ne répond, et les en-têtes `x-laststream-edge` (secret `EDGE_SECRET`) et `x-laststream-client-ip` (IP réelle) ;
  lastAddon ne les croit que si son `EDGE_SECRET` est identique.
- Une réponse 5xx de `lastaddon-core` est restituée telle quelle. Si core est injoignable, la page d'attente (503) est servie. Le Worker ne contacte
  pas d'autre adresse que `lastaddon-core` (hors rapports Sentry) : il n'a pas de repli.
- `/:config/lt/tv/hls` est refusé (403) : la vidéo ne transite pas par Cloudflare.
- Limites de connexion/inscription : binding Rate Limiting dans `lastaddon-core` (10 tentatives par minute et par IP / par identifiant ; la période
  d'un binding est limitée à 10 ou 60 s).

Secret (jamais dans le dépôt) : `wrangler secret put EDGE_SECRET`. Tests : `npm test`.

## Déploiement (LAST-150)

Depuis un tag `vX.Y.Z` de `master` uniquement. `npm run release -- <x.y.z>` crée le tag annoté, le pousse et crée la release GitHub ; puis `git checkout vX.Y.Z` et `npm run deploy`.
`npm run deploy` refuse (code 1) si l'arbre suivi est sale, hors `master`, si HEAD ≠ `origin/master`, ou si HEAD n'est pas exactement un tag publié ; `--dry-run` fait toutes les vérifications sans déployer.
Verrou entre sessions : clé KV `deploy-lock:laststream-edge` (TTL 15 min) dans le namespace `LASTSTREAM_ROUTE` (lié au Worker, non utilisé par son code), supprimée en fin de script ; `--force-unlock` l'écrase.
La version Cloudflare porte le tag et le SHA (`--tag`, `--message`). Ordre : déployer `lastaddon-core` avant ce Worker (Service Binding `CORE`). Procédure complète : `docs/deploiement.md` du dépôt lastaddon.
Retour arrière : `npx wrangler@4.151.1 rollback` (ou `wrangler rollback <version-id>`) ; on ne redéploie pas un ancien tag (HEAD doit égaler origin/master).

## Garde de sortie

- Ce Worker ne contacte **jamais** AllDebrid (`alldebrid.<tld>`, TLD multi-labels compris) ni `*.debrid.it` : un appel serveur depuis une IP Cloudflare a fait suspendre le compte. Ces appels se font côté appareil uniquement.
- La garde (`src/egress-guard.js`) reste en place : `guardedFetch` contrôle l'hôte de chaque appel sortant qu'on lui confie, et en mode `follow` refuse de suivre une redirection vers un débrideur. Le Worker n'a plus d'appel sortant de ce type depuis la suppression de son ancien repli (LAST-203).
- Chaque refus est journalisé (ligne JSON `server_side_debrid_call_blocked` avec l'hôte bloqué, le déclencheur et l'identifiant de requête). Si le secret `SENTRY_DSN` est posé, il est aussi remonté à Sentry, avec l'hôte seulement : jamais l'URL, le chemin, la requête ni les en-têtes.
- `SENTRY_DSN` est optionnel et ne doit jamais être écrit dans le dépôt : `npx wrangler secret put SENTRY_DSN` (valeur saisie à l'invite).
- Projet Sentry séparé : les alertes de ce Worker ne sont pas couvertes par `scripts/sentry-alerts.mjs` du dépôt lastaddon, qui ne configure que les projets `lastaddon-core` et `laststream-app`.
- `test/egress-guard.test.js` échoue si un fichier de `src/` nomme ces hôtes en dehors de `egress-guard.js`.
