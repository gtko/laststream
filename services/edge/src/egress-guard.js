// Garde de sortie du Worker « laststream-edge » (ODY-227) : le Worker ne contacte JAMAIS AllDebrid ni *.debrid.it.
// Un appel serveur depuis une IP Cloudflare a fait suspendre le compte : ces appels se font côté appareil uniquement.
// Aucune dépendance npm. Seul fichier du code serveur autorisé à nommer ces hôtes (voir test/egress-guard.test.js).

/** Hôtes d'un débrideur : alldebrid.<tld> (TLD multi-labels et punycode compris) et debrid.it, sous-domaines compris. */
export const DEBRID_HOST = /(^|\.)(alldebrid\.[a-z0-9.-]+|debrid\.it)$/i;

const EVENT = 'server_side_debrid_call_blocked';
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export class DebridEgressBlockedError extends Error {
  constructor(host) {
    super('Appel vers un débrideur refusé côté serveur.');
    this.name = 'DebridEgressBlockedError';
    this.code = 'server_side_disabled';
    this.host = host;
  }
}

/** Forme canonique d'un hôte : minuscules, sans crochets ni point final. */
function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, '');
  return host === '' ? null : host;
}

/** Hôte d'une valeur sans schéma (« api.exemple.com:443 », « [::1] », « //hôte/chemin », « user@hôte »). */
function bareHost(value) {
  const authority = value.replace(/^\/\//, '').split(/[/?#\\]/)[0];
  const afterUserinfo = authority.slice(authority.lastIndexOf('@') + 1);
  if (afterUserinfo.startsWith('[')) {
    const end = afterUserinfo.indexOf(']');
    return end === -1 ? afterUserinfo.slice(1) : afterUserinfo.slice(1, end);
  }
  return afterUserinfo.replace(/:\d*$/, '');
}

/** Hôte normalisé d'un hôte nu, d'une URL (chaîne ou URL), sinon null. */
export function hostOf(value) {
  if (value instanceof URL) return normalizeHost(value.hostname);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (SCHEME.test(text)) {
    try {
      return normalizeHost(new URL(text).hostname);
    } catch {
      return null;
    }
  }
  return normalizeHost(bareHost(text));
}

/** Vrai si l'hôte (ou l'URL) désigne AllDebrid ou debrid.it. */
export function isDebridHost(value) {
  const host = hostOf(value);
  return host !== null && DEBRID_HOST.test(host);
}

/** URL analysée d'une cible (chaîne, URL ou Request), sinon null. */
function urlOf(target) {
  try {
    if (target instanceof URL) return target;
    if (typeof target === 'string') return new URL(target);
    if (target && typeof target.url === 'string') return new URL(target.url);
  } catch {
    return null;
  }
  return null;
}

/** Hôte d'une valeur de Location, résolue par rapport à la cible. */
function locationHost(location, base) {
  try {
    return normalizeHost(new URL(location, base ?? undefined).hostname);
  } catch {
    return null;
  }
}

/** Journalise et construit l'erreur de blocage (sans jamais inclure d'URL). */
function refuse(host, options) {
  reportBlockedDebrid({ host, trigger: options.trigger, requestId: options.requestId }, options.env, options.ctx);
  return new DebridEgressBlockedError(host);
}

/**
 * Envoie `target` via `fetchFn(target, init)` sauf si l'hôte est un débrideur : dans ce cas fetchFn n'est jamais appelé.
 * En mode de redirection « follow » (défaut), une redirection (301/302/303/307/308) dont le Location vise un débrideur
 * n'est pas suivie : erreur de blocage. En mode « manual » (repli tunnel), la redirection est rendue telle quelle au client,
 * qui l'ouvre lui-même : ni erreur ni rapport.
 * Options : { init, trigger, env, ctx, requestId }.
 */
export async function guardedFetch(fetchFn, target, { init, trigger, env, ctx, requestId } = {}) {
  const options = { trigger, env, ctx, requestId: requestId ?? crypto.randomUUID() };
  const url = urlOf(target);
  const host = url === null ? null : normalizeHost(url.hostname);
  if (host !== null && DEBRID_HOST.test(host)) throw refuse(host, options);

  const response = await fetchFn(target, init);
  const followed = (init?.redirect ?? target?.redirect ?? 'follow') === 'follow';
  if (followed && REDIRECT_STATUS.has(response.status)) {
    const location = response.headers?.get?.('location') ?? null;
    const next = location === null ? null : locationHost(location, url);
    if (next !== null && DEBRID_HOST.test(next)) {
      try {
        await response.body?.cancel();
      } catch {
        // Le corps n'est pas utile : on le libère au mieux.
      }
      throw refuse(next, options);
    }
  }
  return response;
}

/** DSN Sentry valide : https, clé publique (utilisateur de l'URL) et identifiant de projet numérique ; sinon null. */
export function parseSentryDsn(dsn) {
  if (typeof dsn !== 'string' || dsn.length === 0 || dsn.length > 300) return null;
  let url;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username === '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  if (isDebridHost(url.hostname)) return null;
  const segments = url.pathname.split('/').filter((part) => part !== '');
  const projectId = segments.pop();
  if (projectId === undefined || !/^\d+$/.test(projectId)) return null;
  const prefix = segments.map((part) => `/${part}`).join('');
  return { key: url.username, endpoint: `https://${url.host}${prefix}/api/${projectId}/envelope/` };
}

function sentryEnvelope(eventId, event) {
  return [
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event', content_type: 'application/json' }),
    JSON.stringify(event),
  ].join('\n') + '\n';
}

/** Version publiée : variable RELEASE, sinon identifiant de version Cloudflare (CF_VERSION_METADATA), sinon « unknown ». */
export function releaseOf(env) {
  const explicit = typeof env?.RELEASE === 'string' ? env.RELEASE.trim() : '';
  if (explicit !== '') return explicit.slice(0, 64);
  const versionId = typeof env?.CF_VERSION_METADATA?.id === 'string' ? env.CF_VERSION_METADATA.id.trim() : '';
  return versionId !== '' ? versionId.slice(0, 64) : 'unknown';
}

/** Texte sûr pour Sentry : URL masquées, valeurs de paramètres sensibles masquées, 200 caractères au plus. */
function safeText(text) {
  return String(text)
    .replace(/[a-z][a-z\d+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [masqué]')
    .replace(/([\w-]*(?:token|key|secret|pass(?:word)?|auth|sig(?:nature)?)[\w-]*)("?\s*[=:]\s*"?)[^\s&"',;]+/gi, '$1$2[masqué]')
    .slice(0, 200);
}

/** Envoie un événement à Sentry (enveloppe) si SENTRY_DSN est valide. Tags platform « edge » et release sur tous les événements. */
async function postSentryEvent({ tags = {}, ...fields }, env) {
  const dsn = parseSentryDsn(env?.SENTRY_DSN);
  if (dsn === null) return;
  const eventId = crypto.randomUUID().replaceAll('-', '');
  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    server_name: 'laststream-edge',
    release: releaseOf(env),
    ...fields,
    tags: { platform: 'edge', release: releaseOf(env), ...tags },
  };
  await fetch(dsn.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.key}`,
    },
    body: sentryEnvelope(eventId, event),
  });
}

/** Événement de blocage : ne contient que l'hôte bloqué, jamais l'URL, le chemin, la requête ni les en-têtes. */
function sendSentryEvent({ host, trigger, requestId }, env) {
  return postSentryEvent(
    {
      message: EVENT,
      fingerprint: ['server_side_debrid_call'],
      tags: { blocked_host: String(host ?? ''), trigger: String(trigger ?? ''), request_id: String(requestId ?? '') },
    },
    env,
  );
}

const UNHANDLED_EVENT = 'unhandled_exception';

/** Type et message assaini d'une valeur levée ; accepte les valeurs qui ne sont pas des Error. Ne lève jamais. */
function describeError(error) {
  try {
    const isError = error instanceof Error;
    const type = isError && typeof error.name === 'string' ? error.name : 'Error';
    const raw = isError ? error.message : error;
    return { type: type.slice(0, 64), message: safeText(raw ?? '') };
  } catch {
    return { type: 'Error', message: '' };
  }
}

/**
 * Journalise une ligne JSON d'erreur puis, si SENTRY_DSN est posé, envoie l'événement à Sentry via ctx.waitUntil.
 * Ne lève jamais. Renvoie la promesse d'envoi (toujours résolue).
 */
export function reportBlockedDebrid(info, env, ctx) {
  const { host, trigger, requestId } = info ?? {};
  try {
    console.error(JSON.stringify({ level: 'error', event: EVENT, host, trigger, requestId }));
  } catch {
    // Journalisation best-effort.
  }
  const sending = sendSentryEvent({ host, trigger, requestId }, env).catch(() => {});
  try {
    ctx?.waitUntil?.(sending);
  } catch {
    // Pas de contexte d'exécution : l'envoi reste lancé.
  }
  return sending;
}

/**
 * Exception non gérée du handler : journal JSON (type et identifiant de requête, jamais le message brut) puis, si SENTRY_DSN
 * est posé, envoi à Sentry via ctx.waitUntil avec un message assaini. Ne lève jamais. Renvoie la promesse d'envoi (toujours résolue).
 */
export function reportUnhandledError(error, env, ctx, requestId) {
  const { type, message } = describeError(error);
  try {
    console.error(JSON.stringify({ level: 'error', event: UNHANDLED_EVENT, errorName: type, requestId }));
  } catch {
    // Journalisation best-effort.
  }
  const sending = postSentryEvent(
    {
      exception: { values: [{ type, value: message }] },
      fingerprint: [UNHANDLED_EVENT, type],
      tags: { trigger: 'unhandled', request_id: String(requestId ?? '') },
    },
    env,
  ).catch(() => {});
  try {
    ctx?.waitUntil?.(sending);
  } catch {
    // Pas de contexte d'exécution : l'envoi reste lancé.
  }
  return sending;
}
