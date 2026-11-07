# Alertes Sentry (LAST-124)

`scripts/sentry-alerts.mjs` crée ou met à jour trois alertes sur les projets Sentry serveur et web, avec le moteur « workflows » de Sentry. L'ancien endpoint `/api/0/projects/{org}/{project}/rules/` répond 404 sur de.sentry.io (organisation `odykit`).

Idempotent : pour chaque projet, le script trouve le detector `issue_stream`, puis met à jour (PUT) le workflow de même nom rattaché à ce detector, sinon le crée (POST). Les alertes sont au niveau de l'organisation : leur nom est suffixé par le projet, par exemple « Laststream : nouvelle issue (laststream-server) ».

Les filtres `project` et `type` de l'API ne sont pas fiables (filtres non appliqués constatés) : le script refiltre côté client sur `type === issue_stream` et sur `projectId` (lu par `GET /api/0/projects/{org}/{project}/` si le jeton le permet ; sinon, si plusieurs detectors restent, il s'arrête sans rien écrire). Une alerte n'est reconnue que si son nom ET ses `detectorIds` correspondent au detector du projet.

Toutes les lectures (detectors des deux projets, alertes existantes, couverture) sont faites et validées avant la première écriture. Un échec partiel en phase d'écriture se répare en relançant le script : il met à jour ce qui existe et crée le reste.

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
| Laststream : nouvelle issue (projet) | `first_seen_event` | 5 min |
| Laststream : pic d’événements (projet) | `every_event` + filtre `event_frequency_count` > 100 en `1h` | 30 min |
| Laststream : DebridEgressBlockedError (projet) | `every_event` + filtre `event_attribute` `exception.type` = `DebridEgressBlockedError` | 5 min |

Si une autre alerte rattachée au même detector filtre déjà `exception.type` = `DebridEgressBlockedError` (ex. « ODY-227 : appel serveur vers AllDebrid / débrideur bloqué »), le script ne crée pas la sienne et affiche « couverte par … » (il lit le détail `GET /workflows/{id}/` si la liste n'a pas les filtres).

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
- `event_frequency_count` est une condition de filtre (`action_filters[0].conditions`), avec `every_event` en déclencheur, comme l'alerte réelle ODY-227. Un refus (400) affiche le corps de la réponse.
- `every_event` (vu dans une alerte réelle) sert de déclencheur à DebridEgressBlockedError.
- Le PUT envoie le corps complet (la doc ne dit pas si la mise à jour est partielle).
