# laststream-edge

Worker Cloudflare `laststream` (https://laststream.gtux-prog.workers.dev) : adresse publique fixe de Laststream.

- Toutes les routes sont relayées vers le Worker `lastaddon-core` par Service Binding (`CORE`), avec réessais (502/503/504, erreurs réseau),
  page d'attente HTML FR si rien ne répond, et les en-têtes `x-laststream-edge` (secret `EDGE_SECRET`) et `x-laststream-client-ip` (IP réelle) ;
  lastAddon ne les croit que si son `EDGE_SECRET` est identique.
- `/:config/lt/tv/hls` est refusé (403) : la vidéo ne transite pas par Cloudflare.
- Repli vers le PC : si `lastaddon-core` renvoie 5xx (ou échoue) ET qu'un tunnel est enregistré (`POST /__laststream/register`, en-tête
  `x-register-secret`, KV `LASTSTREAM_ROUTE`), la requête est rejouée sur le tunnel `https://*.trycloudflare.com` (Prowlarr, miniatures ffmpeg, TV
  quand le PC est allumé). **Désactiver le repli** : variable `TUNNEL_FALLBACK` = `"0"` dans `wrangler.jsonc`, puis `npx wrangler deploy`
  (ou la changer dans le tableau de bord Cloudflare). Sans tunnel enregistré, le repli est inopérant.
- Limites de connexion/inscription : binding Rate Limiting dans `lastaddon-core` (10 tentatives par minute et par IP / par identifiant ; la période
  d'un binding est limitée à 10 ou 60 s).

Secrets (jamais dans le dépôt) : `wrangler secret put REGISTER_SECRET` et `wrangler secret put EDGE_SECRET` (valeurs lues sur stdin depuis
`%APPDATA%\Laststream\tunnel.secret` et `edge.secret`). Déploiement : `npx wrangler deploy`. Tests : `npm test`.

## Garde de sortie

- Ce Worker ne contacte **jamais** AllDebrid (`alldebrid.<tld>`, TLD multi-labels compris) ni `*.debrid.it` : un appel serveur depuis une IP Cloudflare a fait suspendre le compte. Ces appels se font côté appareil uniquement.
- La garde (`src/egress-guard.js`) contrôle l'hôte de chaque appel sortant du repli tunnel. Le repli envoie en mode `redirect: 'manual'` : une redirection n'est donc pas suivie par le Worker, elle est rendue telle quelle au client, qui l'ouvre lui-même (aucun rapport). Le mode `follow` ne serait pas protégé contre une redirection (le fetch natif la suit avant la garde) : le repli ne l'utilise jamais. Un hôte interdit n'est jamais contacté : le client reçoit la réponse de repli habituelle (5xx de `lastaddon-core` ou page d'attente), sans détail.
- Chaque refus est journalisé (ligne JSON `server_side_debrid_call_blocked` avec l'hôte bloqué, le déclencheur et l'identifiant de requête). Si le secret `SENTRY_DSN` est posé, il est aussi remonté à Sentry, avec l'hôte seulement : jamais l'URL, le chemin, la requête ni les en-têtes.
- `SENTRY_DSN` est optionnel et ne doit jamais être écrit dans le dépôt : `npx wrangler secret put SENTRY_DSN` (valeur saisie à l'invite).
- `test/egress-guard.test.js` échoue si un fichier de `src/` nomme ces hôtes en dehors de `egress-guard.js`.
