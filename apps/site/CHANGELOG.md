# Changelog

## 1.0.1 (2026-11-01)

### Ajouté
- Redirection 301 de `www` vers le domaine racine, avec tests du Worker (LAST-205).
- Liaison `APP` vers le Worker `laststream-edge` pour relayer `/api/*` (LAST-205).
- README du site : contenu, commandes et déploiement (LAST-166).
- Page « Bêta des migrants » : retours publiés et corrections datées (LAST-380).

### Modifié
- Nouvelle homepage « Scroll story » avec thème Laststream sombre (ODY-311).
- Domaines en dur remplacés par `laststream.app` et `app.laststream.app` (LAST-205).

### Corrigé
- Versions Windows et Android lues dans `latest.json` via `/api/windows`, avec liens de secours (ODY-301).
