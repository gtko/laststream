#!/usr/bin/env node
/**
 * Alertes Sentry versionnées (LAST-124) : crée ou met à jour, pour le projet serveur et le projet web, trois règles
 * d'alerte (nouvelle issue, pic d'événements, événement DebridEgressBlockedError).
 *
 * Idempotent : une règle portant déjà le même nom est mise à jour (PUT), sinon elle est créée (POST).
 * `--dry-run` affiche les requêtes (méthode, URL, corps) sans rien envoyer, sans jeton et sans réseau.
 *
 * Variables d'environnement :
 *   SENTRY_AUTH_TOKEN      jeton d'API Sentry (requis hors --dry-run) ; jamais affiché
 *   SENTRY_ORG             slug de l'organisation
 *   SENTRY_PROJECT_SERVER  slug du projet serveur (lastaddon-core)
 *   SENTRY_PROJECT_WEB     slug du projet web (laststream-app)
 *   SENTRY_API_URL         facultatif : https://sentry.io par défaut (ex. https://de.sentry.io)
 *
 * Documentation : docs/sentry-alerts.md.
 */

const DEFAULT_API_URL = 'https://sentry.io';
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
/** Hôtes autorisés en http (tests locaux uniquement) ; tout autre hôte exige https. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

const NOTIFY_OWNERS = { id: 'sentry.mail.actions.NotifyEmailAction', targetType: 'IssueOwners', fallthroughType: 'AllMembers' };

/** Règles d'alerte de projet (corps de l'API des règles). Aucune donnée personnelle, aucun secret. */
const ALERT_RULES = [
  {
    name: 'Laststream : nouvelle issue',
    conditions: [{ id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition' }],
    filters: [],
    actions: [NOTIFY_OWNERS],
    actionMatch: 'all',
    filterMatch: 'all',
    frequency: 5,
  },
  {
    name: 'Laststream : pic d’événements',
    conditions: [
      { id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition', value: 100, comparisonType: 'count', interval: '1h' },
    ],
    filters: [],
    actions: [NOTIFY_OWNERS],
    actionMatch: 'all',
    filterMatch: 'all',
    frequency: 30,
  },
  {
    name: 'Laststream : DebridEgressBlockedError',
    conditions: [{ id: 'sentry.rules.conditions.every_event.EveryEventCondition' }],
    filters: [
      { id: 'sentry.rules.filters.event_attribute.EventAttributeFilter', attribute: 'exception.type', match: 'eq', value: 'DebridEgressBlockedError' },
    ],
    actions: [NOTIFY_OWNERS],
    actionMatch: 'all',
    filterMatch: 'all',
    frequency: 5,
  },
];

class ConfigError extends Error {}

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

/** URL de la collection des règles d'un projet. */
function rulesUrl(origin, org, project) {
  return `${origin}/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/rules/`;
}

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

/** Appel à l'API : renvoie { body, link }. Le corps d'erreur n'est jamais affiché (il peut contenir des détails internes). */
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
  if (!res.ok) throw new Error(`${method} ${url} : statut ${res.status}`);
  return { body: text === '' ? null : JSON.parse(text), link: res.headers.get('link') };
}

/** Toutes les règles d'un projet (pages suivies par l'en-tête Link). */
async function listRules(config, url) {
  const rules = [];
  let next = url;
  while (next !== null) {
    const { body, link } = await api('GET', next, config.token);
    if (!Array.isArray(body)) throw new Error(`GET ${next} : réponse inattendue`);
    rules.push(...body);
    next = nextPageUrl(link, config.origin);
  }
  return rules;
}

async function main(argv, env) {
  const dryRun = argv.includes('--dry-run');
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) throw new ConfigError(`Option inconnue : ${unknown.join(' ')}. Usage : [--dry-run].`);
  const config = readConfig(env, dryRun);

  for (const project of config.projects) {
    const url = rulesUrl(config.origin, config.org, project);
    if (dryRun) {
      console.log(`[dry-run] GET ${url}`);
      for (const rule of ALERT_RULES) {
        console.log(`[dry-run] POST ${url} si « ${rule.name} » est absente, sinon PUT ${url}<id>/`);
        console.log(JSON.stringify(rule));
      }
      continue;
    }
    const existing = await listRules(config, url);
    for (const rule of ALERT_RULES) {
      const match = existing.find((candidate) => candidate.name === rule.name);
      if (match === undefined) {
        await api('POST', url, config.token, rule);
        console.log(`créée : ${project} — ${rule.name}`);
      } else {
        await api('PUT', `${url}${encodeURIComponent(String(match.id))}/`, config.token, rule);
        console.log(`mise à jour : ${project} — ${rule.name}`);
      }
    }
  }
}

main(process.argv.slice(2), process.env).catch((error) => {
  console.error(error instanceof ConfigError ? error.message : `Échec : ${error.message}`);
  process.exitCode = 1;
});
