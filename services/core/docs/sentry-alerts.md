# Alertes Sentry (LAST-124)

`scripts/sentry-alerts.mjs` crée ou met à jour trois alertes sur les projets Sentry serveur et web, avec le moteur « workflows » de Sentry. L'ancien endpoint `/api/0/projects/{org}/{project}/rules/` répond 404 sur de.sentry.io (organisation `odykit`).

Idempotent : pour chaque projet, le script trouve le detector d'erreurs, puis met à jour (PUT) le workflow de même nom du projet, sinon le crée (POST).

## Endpoints (API d'organisation)

| Usage | Appel |
|---|---|
| Detector « Issue Stream » du projet (celui des alertes d'issue par défaut ; l'autre detector, `error`, n'est pas utilisé) | `GET /api/0/organizations/{org}/detectors/?project={slug}&type=issue_stream` |
| Alertes existantes du projet | `GET /api/0/organizations/{org}/workflows/?project={slug}` |
| Création | `POST /api/0/organizations/{org}/workflows/` |
| Mise à jour | `PUT /api/0/organizations/{org}/workflows/{id}/` |

Scopes du jeton : `alerts:read` pour `--check`, `alerts:write` pour appliquer (`org:read`, `org:write`, `org:admin` sont aussi acceptés par l'API).

## Alertes

| Nom | Déclencheur | Fréquence |
|---|---|---|
| Laststream : nouvelle issue | `first_seen_event` | 5 min |
| Laststream : pic d’événements | `event_frequency_count` > 100 en `1h` | 30 min |
| Laststream : DebridEgressBlockedError | `every_event` + filtre `event_attribute` `exception.type` = `DebridEgressBlockedError` | 5 min |

Si une autre alerte du projet filtre déjà `exception.type` = `DebridEgressBlockedError` (ex. « ODY-227 : appel serveur vers AllDebrid / débrideur bloqué »), le script ne crée pas la sienne et affiche « couverte par … » (il lit le détail `GET /workflows/{id}/` si la liste n'a pas les filtres).

Action : e-mail aux propriétaires de l'issue (`email`, `targetType: issue_owners`, repli `AllMembers`).

## Variables d'environnement

- `SENTRY_AUTH_TOKEN` : jeton d'API, requis hors `--dry-run` ; jamais écrit dans le dépôt ni affiché.
- `SENTRY_ORG` : slug de l'organisation (`odykit`).
- `SENTRY_PROJECT_SERVER` / `SENTRY_PROJECT_WEB` : slugs des projets (`laststream-server`, `laststream-web`).
- `SENTRY_API_URL` (facultatif) : `https://sentry.io` par défaut (`https://de.sentry.io` pour la région DE) ; https obligatoire, sauf localhost.

## Usage

```sh
export SENTRY_ORG=odykit SENTRY_PROJECT_SERVER=laststream-server SENTRY_PROJECT_WEB=laststream-web SENTRY_API_URL=https://de.sentry.io
node scripts/sentry-alerts.mjs --dry-run   # sans réseau ni jeton : affiche les requêtes
SENTRY_AUTH_TOKEN=… node scripts/sentry-alerts.mjs --check   # lecture seule : detectors et alertes existants
SENTRY_AUTH_TOKEN=… node scripts/sentry-alerts.mjs           # applique (alerts:write)
```

Sortie : une ligne `créée :` ou `mise à jour :` par alerte et par projet. Sur une erreur d'API, le script affiche l'URL, le statut (avec un rappel du scope `alerts:write` sur 401/403) et le corps de la réponse tronqué, jeton expurgé.

## Points à vérifier avec `--check` puis au premier lancement

- Le detector `issue_stream` existe pour chaque projet (sinon erreur explicite).
- `event_frequency_count` est documenté parmi les filtres, pas parmi les déclencheurs : s'il est refusé (400), le déplacer dans `action_filters[0].conditions` en gardant `reappeared_event` en déclencheur (`ALERTS` dans le script).
- `every_event` (vu dans une alerte réelle) sert de déclencheur à DebridEgressBlockedError.
- Le PUT envoie le corps complet (la doc ne dit pas si la mise à jour est partielle).
