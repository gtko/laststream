# laststream-edge

Worker Cloudflare `laststream` (https://laststream.gtux-prog.workers.dev) : adresse publique fixe de Laststream.

- Toutes les routes sont relayées vers le Worker `lastaddon-core` par Service Binding (`CORE`), avec réessais (502/503/504, erreurs réseau),
  page d'attente HTML FR si rien ne répond, et les en-têtes `x-laststream-edge` (secret `EDGE_SECRET`) et `x-laststream-client-ip` (IP réelle) ;
  lastAddon ne les croit que si son `EDGE_SECRET` est identique.
- `/__laststream/range` : relais de plages d'octets debrid signées (miniatures).
- `/:config/lt/tv/hls` est refusé (403) : la vidéo ne transite pas par Cloudflare.
- Repli vers le PC : si `lastaddon-core` renvoie 5xx (ou échoue) ET qu'un tunnel est enregistré (`POST /__laststream/register`, en-tête
  `x-register-secret`, KV `LASTSTREAM_ROUTE`), la requête est rejouée sur le tunnel `https://*.trycloudflare.com` (Prowlarr, miniatures ffmpeg, TV
  quand le PC est allumé). **Désactiver le repli** : variable `TUNNEL_FALLBACK` = `"0"` dans `wrangler.jsonc`, puis `npx wrangler deploy`
  (ou la changer dans le tableau de bord Cloudflare). Sans tunnel enregistré, le repli est inopérant.
- Limites de connexion/inscription : binding Rate Limiting dans `lastaddon-core` (10 tentatives par minute et par IP / par identifiant ; la période
  d'un binding est limitée à 10 ou 60 s).

Secrets (jamais dans le dépôt) : `wrangler secret put REGISTER_SECRET` et `wrangler secret put EDGE_SECRET` (valeurs lues sur stdin depuis
`%APPDATA%\Laststream\tunnel.secret` et `edge.secret`). Déploiement : `npx wrangler deploy`. Tests : `npm test`.
