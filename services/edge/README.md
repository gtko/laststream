# laststream-edge

Worker Cloudflare `laststream` (https://laststream.gtux-prog.workers.dev) : adresse fixe qui relaie vers le lastAddon du PC
par un tunnel rapide cloudflared dont l'URL change à chaque démarrage.

- `POST /__laststream/register` (en-tête `x-register-secret`) : enregistre l'URL `https://*.trycloudflare.com` courante dans le KV `LASTSTREAM_ROUTE`.
- Tout le reste est relayé (méthode, chemin, query, corps et réponse en streaming). 503 JSON si aucun tunnel ou tunnel injoignable.
- `/:config/lt/tv/hls` est refusé (403) : la vidéo ne transite pas par Cloudflare.
- Le Worker ajoute `x-laststream-edge` (secret `EDGE_SECRET`) et `x-laststream-client-ip` ; lastAddon ne les croit que si `LASTADDON_EDGE_SECRET` est identique.

Secrets (jamais dans le dépôt) : `wrangler secret put REGISTER_SECRET` et `wrangler secret put EDGE_SECRET` (valeurs lues sur stdin depuis
`%APPDATA%\Laststream\tunnel.secret` et `edge.secret`). Déploiement : `npx wrangler deploy`. Tests : `npm test`.
