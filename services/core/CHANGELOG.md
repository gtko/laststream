# Changelog

## 0.4.3 (2026-11-07)

Watch party (LAST-1615, PR #51)

- Le salon accepte le message `source` : l’hôte annonce sa version et sa langue, sans effet sur la lecture. Seules l’empreinte et la langue circulent, jamais un lien, et les invités sans compte ne reçoivent pas l’empreinte.
- Un nom de fichier en forme d’URL ou une langue invalide sont refusés sur ce message.
- Protocole v0.5.0 : les réactions couvrent tous les emojis du sélecteur du lecteur.

Soirées planifiées (LAST-1611, PR #50)

- Un profil adulte du foyer peut être invité à une soirée planifiée.

## 0.4.2 (2026-11-01)

TV en direct (LAST-1411, PR #49)

- Seuls les flux officiels ou licenciés entrent dans le catalogue : les flux d'iptv-org et de Free-TV sur adresse IP brute, avec identifiants ou jeton dans l'URL, ou au schéma d'abonnement IPTV sont écartés (42 chaînes de rediffusions non officielles retirées du catalogue de production, 7 basculent sur une autre source).
- Le contrôle de santé des flux garde la date du dernier succès de chaque flux et produit un rapport par passage du Cron (chaînes testées, retirées, remises, disjoncteur), conservé dans `probe.json` et journalisé.
- Une chaîne n'est toujours retirée qu'après 3 échecs de suite (environ 18 h) et revient dès que son flux répond de nouveau ; un refus 401, 403, 429 ou 451 n'est ni une panne ni un succès.
