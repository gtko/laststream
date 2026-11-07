# Changelog

## 0.1.1 (2026-11-01)

- Relais de toutes les routes vers `lastaddon-core` par Service Binding (`CORE`), avec réessais sur erreurs amont transitoires (502/503/504, erreurs réseau) et page d'attente en français.
- Transfert des WebSocket de watch party (`/party/:id/ws`), des salons et du direct social (`/user/social/live`) vers `lastaddon-core`.
- Fichiers servis depuis R2 : APK Android (`/app/android/laststream-<version>.apk`, plages d'octets, lecture seule), installateur, flux de version Windows `/app/windows/latest.json` (HEAD et plage) et sa signature `latest.json.sig`.
- Suppression du relais de plages `/__laststream/range` et du relais de miniatures (lecture AllDebrid depuis une IP Cloudflare = risque de suspension du compte), avec garde de sortie anti-AllDebrid.
- Suppression du repli par tunnel `cloudflared` : le Worker ne contacte plus que `lastaddon-core` (hors rapports Sentry) ; documentation mise à jour.
- Exceptions non gérées remontées à Sentry, avec tags `release` et `platform`.
- CI : tests et compilation Wrangler à blanc.
- Déploiement depuis un tag (`scripts/deploy.mjs`) avec verrou entre sessions, et script de release (`scripts/release.mjs`).
