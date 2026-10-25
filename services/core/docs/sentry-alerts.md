# Alertes Sentry (LAST-124)

`scripts/sentry-alerts.mjs` crée ou met à jour trois règles d'alerte sur les projets Sentry serveur (lastaddon-core) et web (laststream-app). Idempotent : une règle de même nom est mise à jour (PUT), sinon créée (POST).

## Règles

| Nom | Déclenchement |
|---|---|
| Laststream : nouvelle issue | Première occurrence d'une issue (`FirstSeenEventCondition`) |
| Laststream : pic d’événements | Plus de 100 événements en 1 h (`EventFrequencyCondition`) |
| Laststream : DebridEgressBlockedError | `type` = `DebridEgressBlockedError` (`EveryEventCondition` + `EventAttributeFilter`) |

Notification aux propriétaires (repli : tous les membres), au plus toutes les 5 min (30 min pour le pic).

## Variables d'environnement

- `SENTRY_AUTH_TOKEN` : jeton d'API, requis hors `--dry-run` ; jamais écrit dans le dépôt ni affiché.
- `SENTRY_ORG` : slug de l'organisation.
- `SENTRY_PROJECT_SERVER` / `SENTRY_PROJECT_WEB` : slugs du projet serveur (lastaddon-core) et du projet web (laststream-app).
- `SENTRY_API_URL` (facultatif) : `https://sentry.io` par défaut ; https obligatoire, sauf localhost.

## Usage

Vérifier sans réseau ni jeton, puis appliquer :

```sh
SENTRY_ORG=mon-org SENTRY_PROJECT_SERVER=lastaddon-core SENTRY_PROJECT_WEB=laststream-app node scripts/sentry-alerts.mjs --dry-run
SENTRY_AUTH_TOKEN=… SENTRY_ORG=mon-org SENTRY_PROJECT_SERVER=lastaddon-core SENTRY_PROJECT_WEB=laststream-app node scripts/sentry-alerts.mjs
```

Sortie : une ligne `créée :` ou `mise à jour :` par règle et par projet. Une erreur n'affiche que le statut HTTP.

## Point à vérifier

Attributs EventAttributeFilter / EveryEventCondition à confirmer au premier lancement. Si l'API refuse la règle DebridEgressBlockedError, corriger l'identifiant dans `ALERT_RULES` de `scripts/sentry-alerts.mjs`, puis relancer en `--dry-run`.
