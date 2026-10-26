#!/usr/bin/env node
/**
 * Alertes Sentry versionnées (LAST-124) : crée ou met à jour, pour le projet serveur et le projet web, trois alertes
 * (nouvelle issue, pic d'événements, événement DebridEgressBlockedError) avec le moteur « workflows » de Sentry.
 *
 * L'ancien endpoint `/api/0/projects/{org}/{project}/rules/` répond 404 sur de.sentry.io : les alertes sont désormais
 * des workflows d'organisation rattachés à des detectors (« monitors »). Endpoints utilisés :
 *   GET  /api/0/organizations/{org}/detectors/?project={slug}&type=issue_stream   detector « Issue Stream » du projet
 *   GET  /api/0/organizations/{org}/workflows/?project={slug}              alertes existantes (recherche par nom)
 *   POST /api/0/organizations/{org}/workflows/                             création
 *   PUT  /api/0/organizations/{org}/workflows/{id}/                        mise à jour
 *
 * Idempotent : un workflow de même nom rattaché au detector du projet est mis à jour (PUT), sinon créé (POST). Les noms
 * sont suffixés par le projet (alertes au niveau organisation). Les lectures de tous les projets sont faites et validées
 * avant la première écriture ; après un échec partiel, relancer le script répare (met à jour l'existant, crée le reste).
 * `--dry-run` affiche les requêtes (méthode, URL, corps) sans rien envoyer, sans jeton et sans réseau.
 * `--check` lit seulement (GET detectors + workflows) et affiche l'existant : valide le jeton et les droits.
 *
 * Scopes du jeton : `alerts:read` suffit pour --check ; `alerts:write` est requis pour appliquer.
 * (org:read / org:write / org:admin sont aussi acceptés par l'API.)
 *
 * Variables d'environnement :
 *   SENTRY_AUTH_TOKEN      jeton d'API Sentry (requis hors --dry-run) ; jamais affiché
 *   SENTRY_ORG             slug de l'organisation (ex. odykit)
 *   SENTRY_PROJECT_SERVER  slug du projet serveur (ex. laststream-server)
 *   SENTRY_PROJECT_WEB     slug du projet web (ex. laststream-web)
 *   SENTRY_API_URL         facultatif : https://sentry.io par défaut (ex. https://de.sentry.io)
 *
 * Exemple :
 *   SENTRY_AUTH_TOKEN=… SENTRY_ORG=odykit SENTRY_PROJECT_SERVER=laststream-server SENTRY_PROJECT_WEB=laststream-web \
 *   SENTRY_API_URL=https://de.sentry.io node scripts/sentry-alerts.mjs --check
 *
 * Documentation : docs/sentry-alerts.md.
 */

const DEFAULT_API_URL = 'https://sentry.io';
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
/** Hôtes autorisés en http (tests locaux uniquement) ; tout autre hôte exige https. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** Type de detector auquel Sentry rattache les alertes d'issue par défaut (« Issue Stream »), vérifié avec --check ; l'autre detector du projet est de type error. */
const DETECTOR_TYPE = 'issue_stream';
const MAX_ERROR_BODY = 500;

/**
 * Action e-mail : propriétaires de l'issue (« Suggested Assignees »), repli sur tous les membres.
 * Forme documentée (Create an Alert for an Organization) : type `email`, config.targetType `issue_owners`,
 * data.fallthroughType `AllMembers`, targetIdentifier vide, integrationId nul.
 */
const NOTIFY_OWNERS = {
  type: 'email',
  integrationId: null,
  data: { fallthroughType: 'AllMembers' },
  config: { targetType: 'issue_owners', targetDisplay: null, targetIdentifier: '' },
  status: 'active',
};

const condition = (type, comparison) => ({ type, comparison, conditionResult: true });
/** Groupe de filtres unique : toutes les conditions doivent être vraies, puis notification. */
const notifyWhen = (conditions) => [{ logicType: 'all', conditions, actions: [NOTIFY_OWNERS] }];

/**
 * Alertes (corps de l'API des workflows, `detector_ids` ajouté à l'envoi). Aucune donnée personnelle.
 * Les alertes sont au niveau de l'organisation : le nom est suffixé par le projet.
 *
 * Certitude par champ :
 *  - name, enabled, detector_ids, config.frequency, triggers.logicType, action_filters[].logicType/actions : documentés.
 *  - first_seen_event (comparison: true) en déclencheur, event_attribute { attribute: 'exception.type', match: 'eq', value }
 *    et event_frequency_count { value, interval } en filtres : documentés.
 *  - every_event (comparison: true) en déclencheur : vu dans une alerte réelle (ODY-227). Le pic d'événements et
 *    DebridEgress l'utilisent avec une condition de filtre ; si l'API répond 400, le corps de l'erreur est affiché.
 */
const DEBRID_ATTRIBUTE = { attribute: 'exception.type', match: 'eq', value: 'DebridEgressBlockedError' };
const buildAlerts = (project) => [
  {
    name: `Laststream : nouvelle issue (${project})`,
    enabled: true,
    config: { frequency: 5 },
    triggers: { logicType: 'any-short', conditions: [condition('first_seen_event', true)] },
    action_filters: notifyWhen([]),
  },
  {
    name: `Laststream : pic d’événements (${project})`,
    enabled: true,
    config: { frequency: 30 },
    triggers: { logicType: 'any-short', conditions: [condition('every_event', true)] },
    action_filters: notifyWhen([condition('event_frequency_count', { value: 100, interval: '1h' })]),
  },
  {
    name: `Laststream : DebridEgressBlockedError (${project})`,
    enabled: true,
    config: { frequency: 5 },
    triggers: { logicType: 'any-short', conditions: [condition('every_event', true)] },
    action_filters: notifyWhen([condition('event_attribute', DEBRID_ATTRIBUTE)]),
    /** Ne pas créer si une autre alerte du même detector filtre déjà exactement ce type d'exception (évite les doublons). */
    skipIfCovered: true,
  },
];

class ConfigError extends Error {}

/** Erreur d'API : message déjà prêt à afficher (statut, indice de scope, corps expurgé du jeton). */
class ApiError extends Error {}

/** Lit et valide la configuration. Le jeton n'est exigé que hors --dry-run. */
function readConfig(env, dryRun) {
  const required = ['SENTRY_ORG', 'SENTRY_PROJECT_SERVER', 'SENTRY_PROJECT_WEB'];
  if (!dryRun) required.push('SENTRY_AUTH_TOKEN');
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) throw new ConfigError(`Variables manquantes : ${missing.join(', ')}.`);
  for (const name of ['SENTRY_ORG', 'SENTRY_PROJECT_SERVER', 'SENTRY_PROJECT_WEB']) {
    if (!SLUG.test(env[name])) throw new ConfigError(`${name} : slug invalide.`);
  }
  let apiUrl;
  try {
    apiUrl = new URL(env.SENTRY_API_URL || DEFAULT_API_URL);
  } catch {
    throw new ConfigError('SENTRY_API_URL : URL invalide.');
  }
  if (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && LOCAL_HOSTS.has(apiUrl.hostname))) {
    throw new ConfigError('SENTRY_API_URL doit être en https (le jeton ne doit pas circuler en clair).');
  }
  return {
    org: env.SENTRY_ORG,
    projects: [env.SENTRY_PROJECT_SERVER, env.SENTRY_PROJECT_WEB],
    origin: apiUrl.origin,
    token: env.SENTRY_AUTH_TOKEN,
  };
}

const orgBase = (config) => `${config.origin}/api/0/organizations/${encodeURIComponent(config.org)}`;
const detectorsUrl = (config, project) =>
  `${orgBase(config)}/detectors/?project=${encodeURIComponent(project)}&type=${DETECTOR_TYPE}&per_page=100`;
const workflowsUrl = (config, project) => `${orgBase(config)}/workflows/?project=${encodeURIComponent(project)}&per_page=100`;
const workflowCollection = (config) => `${orgBase(config)}/workflows/`;
const workflowItem = (config, id) => `${orgBase(config)}/workflows/${encodeURIComponent(String(id))}/`;

/** Page suivante de l'en-tête Link, seulement si elle reste sur l'origine configurée (le jeton ne suit pas ailleurs). */
function nextPageUrl(linkHeader, origin) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(/,\s*(?=<)/)) {
    if (!/rel="next"/.test(part) || !/results="true"/.test(part)) continue;
    const match = /<([^>]+)>/.exec(part);
    if (match === null) return null;
    return new URL(match[1]).origin === origin ? match[1] : null;
  }
  return null;
}

/** Message d'erreur d'API : statut, indice de scope sur 401/403, corps tronqué et expurgé du jeton pour diagnostic. */
function describeFailure(method, url, status, bodyText, token) {
  let message = `${method} ${url} : statut ${status}`;
  if (status === 401 || status === 403) {
    message += ' — jeton refusé ou droits insuffisants : le scope alerts:write est requis pour créer ou modifier (alerts:read pour --check).';
  } else if (status === 404) {
    message += ' — introuvable : vérifier SENTRY_ORG, SENTRY_API_URL (région, ex. https://de.sentry.io) et le slug du projet.';
  }
  const body = (token ? bodyText.split(token).join('[jeton]') : bodyText).trim().slice(0, MAX_ERROR_BODY);
  return body === '' ? message : `${message}\nRéponse : ${body}`;
}

/** Appel à l'API : renvoie { body, link }. */
async function api(method, url, token, payload) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(describeFailure(method, url, res.status, text, token));
  try {
    return { body: text === '' ? null : JSON.parse(text), link: res.headers.get('link') };
  } catch {
    throw new ApiError(`${method} ${url} : réponse non JSON`);
  }
}

/** Tous les éléments d'une collection (pages suivies par l'en-tête Link). */
async function listAll(config, url) {
  const items = [];
  let next = url;
  while (next !== null) {
    const { body, link } = await api('GET', next, config.token);
    if (!Array.isArray(body)) throw new ApiError(`GET ${next} : réponse inattendue (liste attendue)`);
    items.push(...body);
    next = nextPageUrl(link, config.origin);
  }
  return items;
}

const detectorIdsOf = (workflow) => (Array.isArray(workflow.detectorIds) ? workflow.detectorIds.map(String) : []);
const attachedTo = (workflow, detector) => detectorIdsOf(workflow).includes(String(detector.id));

/**
 * Identifiant numérique du projet (pour départager les detectors si le filtre `project` du serveur est ignoré).
 * Au mieux : nécessite la lecture du projet ; null si indisponible.
 */
async function resolveProjectId(config, project) {
  try {
    const { body } = await api('GET', `${config.origin}/api/0/projects/${encodeURIComponent(config.org)}/${encodeURIComponent(project)}/`, config.token);
    return body?.id === undefined ? null : String(body.id);
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

/**
 * Detectors « issue_stream » d'un projet. Les filtres `project` et `type` de l'API ne sont pas fiables : on refiltre côté
 * client sur le type, puis sur projectId si l'identifiant du projet est lisible.
 */
async function listProjectDetectors(config, project) {
  const detectors = (await listAll(config, detectorsUrl(config, project))).filter((candidate) => candidate.type === DETECTOR_TYPE);
  const projectId = await resolveProjectId(config, project);
  return projectId === null ? detectors : detectors.filter((candidate) => candidate.projectId === undefined || String(candidate.projectId) === projectId);
}

/** Detector « Issue Stream » d'un projet ; erreur claire s'il n'existe pas ou s'il est ambigu. */
async function findDetector(config, project) {
  const detectors = await listProjectDetectors(config, project);
  if (detectors.length === 0) {
    throw new ApiError(
      `Aucun detector de type « ${DETECTOR_TYPE} » trouvé pour le projet ${project} (organisation ${config.org}) : ` +
        'vérifier le slug du projet et que le projet existe, puis lancer --check.',
    );
  }
  if (detectors.length > 1) {
    throw new ApiError(
      `Plusieurs detectors « ${DETECTOR_TYPE} » (${detectors.map((d) => d.id).join(', ')}) pour le projet ${project} : ` +
        'le filtre de projet de l’API n’est pas appliqué et l’identifiant du projet est illisible avec ce jeton ; abandon (rien n’est écrit).',
    );
  }
  return detectors[0];
}

/** Vrai si un groupe de filtres contient event_attribute exception.type == DebridEgressBlockedError. */
function filtersCoverDebrid(actionFilters) {
  if (!Array.isArray(actionFilters)) return false;
  return actionFilters.some(
    (group) =>
      Array.isArray(group?.conditions) &&
      group.conditions.some(
        (c) =>
          c?.type === 'event_attribute' &&
          c.comparison?.attribute === DEBRID_ATTRIBUTE.attribute &&
          c.comparison?.match === DEBRID_ATTRIBUTE.match &&
          c.comparison?.value === DEBRID_ATTRIBUTE.value,
      ),
  );
}

/** Première alerte rattachée au detector qui filtre déjà DebridEgressBlockedError (détail lu par GET si la liste n'a pas les filtres). */
async function findCoveringAlert(config, workflows, detector) {
  for (const workflow of workflows.filter((candidate) => attachedTo(candidate, detector))) {
    let filters = workflow.actionFilters;
    if (!Array.isArray(filters)) {
      const { body } = await api('GET', workflowItem(config, workflow.id), config.token);
      filters = body?.actionFilters;
    }
    if (filtersCoverDebrid(filters)) return workflow;
  }
  return undefined;
}

async function check(config) {
  for (const project of config.projects) {
    const detectors = await listProjectDetectors(config, project);
    console.log(`${project} : ${detectors.length} detector(s) ${DETECTOR_TYPE}`);
    for (const detector of detectors) console.log(`  detector ${detector.id} « ${detector.name} » (${detector.type})`);
    const workflows = (await listAll(config, workflowsUrl(config, project))).filter((workflow) =>
      detectors.some((detector) => attachedTo(workflow, detector)),
    );
    console.log(`${project} : ${workflows.length} alerte(s) rattachée(s) à ce detector`);
    for (const workflow of workflows) {
      console.log(`  workflow ${workflow.id} « ${workflow.name} » (activée : ${workflow.enabled}, detectors : ${JSON.stringify(detectorIdsOf(workflow))})`);
    }
    const known = new Set(workflows.map((workflow) => workflow.name));
    for (const alert of buildAlerts(project)) console.log(`  ${known.has(alert.name) ? 'présente' : 'absente '} : ${alert.name}`);
  }
}

/**
 * Applique en deux phases : 1) lectures et validation pour tous les projets (detectors, alertes existantes, couverture) ;
 * 2) écritures. Une erreur en phase 1 n'écrit rien ; un échec en phase 2 est réparé en relançant le script (idempotent).
 */
async function apply(config) {
  const plan = [];
  for (const project of config.projects) {
    const detector = await findDetector(config, project);
    const existing = await listAll(config, workflowsUrl(config, project));
    for (const alert of buildAlerts(project)) {
      const { skipIfCovered, ...definition } = alert;
      const match = existing.find((candidate) => candidate.name === alert.name && attachedTo(candidate, detector));
      if (match === undefined && skipIfCovered) {
        const coveredBy = await findCoveringAlert(config, existing, detector);
        if (coveredBy !== undefined) {
          plan.push({ project, alert, covered: coveredBy });
          continue;
        }
      }
      plan.push({ project, alert, match, payload: { ...definition, detector_ids: [Number(detector.id)] } });
    }
  }
  for (const { project, alert, match, payload, covered } of plan) {
    if (covered !== undefined) {
      console.log(`couverte par « ${covered.name} » : ${project} — ${alert.name} (non créée)`);
    } else if (match === undefined) {
      await api('POST', workflowCollection(config), config.token, payload);
      console.log(`créée : ${project} — ${alert.name}`);
    } else {
      await api('PUT', workflowItem(config, match.id), config.token, { ...payload, id: String(match.id) });
      console.log(`mise à jour : ${project} — ${alert.name}`);
    }
  }
}

function dryRun(config) {
  for (const project of config.projects) {
    console.log(`[dry-run] GET ${detectorsUrl(config, project)}`);
    console.log(`[dry-run] GET ${workflowsUrl(config, project)}`);
    for (const alert of buildAlerts(project)) {
      const { skipIfCovered: _skip, ...definition } = alert;
      const payload = { ...definition, detector_ids: [`<id du detector « ${DETECTOR_TYPE} » de ${project}>`] };
      console.log(`[dry-run] POST ${workflowCollection(config)} si « ${alert.name} » est absente, sinon PUT ${workflowCollection(config)}<id>/`);
      console.log(JSON.stringify(payload));
    }
  }
}

async function main(argv, env) {
  const flags = new Set(argv);
  const unknown = argv.filter((arg) => arg !== '--dry-run' && arg !== '--check');
  if (unknown.length > 0) throw new ConfigError(`Option inconnue : ${unknown.join(' ')}. Usage : [--dry-run | --check].`);
  if (flags.has('--dry-run') && flags.has('--check')) throw new ConfigError('--dry-run et --check s’excluent.');
  const config = readConfig(env, flags.has('--dry-run'));
  if (flags.has('--dry-run')) dryRun(config);
  else if (flags.has('--check')) await check(config);
  else await apply(config);
}

main(process.argv.slice(2), process.env).catch((error) => {
  console.error(error instanceof ConfigError || error instanceof ApiError ? error.message : `Échec : ${error.message}`);
  process.exitCode = 1;
});
