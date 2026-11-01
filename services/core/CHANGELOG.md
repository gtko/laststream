# Changelog

## 0.4.2 (2026-11-01)

TV en direct (LAST-1411, PR #49)

- Seuls les flux officiels ou licenciés entrent dans le catalogue : les flux d'iptv-org et de Free-TV sur adresse IP brute, avec identifiants ou jeton dans l'URL, ou au schéma d'abonnement IPTV sont écartés (42 chaînes de rediffusions non officielles retirées du catalogue de production, 7 basculent sur une autre source).
- Le contrôle de santé des flux garde la date du dernier succès de chaque flux et produit un rapport par passage du Cron (chaînes testées, retirées, remises, disjoncteur), conservé dans `probe.json` et journalisé.
- Une chaîne n'est toujours retirée qu'après 3 échecs de suite (environ 18 h) et revient dès que son flux répond de nouveau ; un refus 401, 403, 429 ou 451 n'est ni une panne ni un succès.
