/* Confidentialité des événements Sentry. Tout passe par ce filtre : beforeSend (événements) et beforeBreadcrumb (fils
 * d'Ariane). Fonctions pures, testées : rien de ce qui identifie un compte, un addon, une clé de débrideur ou un flux
 * ne doit sortir de l'appareil.
 *  - URL : query string retirée ; segment de chemin de plus de 40 caractères (config d'addon en base64/JSON) remplacé
 *    par [config] ; hors de l'application, seul l'hôte est gardé s'il est autorisé, sinon [host] (adresse littérale :
 *    [ip]) ; stremio: traité comme une URL ; débrideurs, magnet: et flux complets (.m3u8, .mkv, .mp4) supprimés ;
 *    jeton de réinitialisation (#/reset/…) masqué.
 *  - Texte libre : URL réécrites comme ci-dessus, magnets retirés, clés de débrideur et apikey / token / password…
 *    masqués, segments de chemin de plus de 40 caractères remplacés.
 *  - Fil d'Ariane fetch/xhr vers un hôte tiers : seulement l'hôte et le statut. Clics, saisies et console écartés.
 *  - Écartés : bruit du navigateur (ResizeObserver), annulations (AbortError), lecture média attendue (source absente,
 *    lecture interrompue ou bloquée par le navigateur), erreurs venant d'extensions navigateur. */
import { isIpLiteral, isLocalName, reduceHost, scrubPath } from '@laststream/protocol/scrub';
import type { Breadcrumb, ErrorEvent, Exception } from '@sentry/browser';

const DEBRID = /alldebrid|real-?debrid|torbox|premiumize/i;
const MEDIA_FILE = /\.(m3u8|mkv|mp4)$/i;
const MAGNET = /magnet:\?[^\s"'<>]*/gi;
/** URL (et stremio:) jusqu'au premier espace ou guillemet : une clé après « | » ne doit pas fuir. */
const URL_IN_TEXT = /(?:(?:https?|wss?):\/\/|stremio:)[^\s"'<>]+/gi;
/** Jeton d'invité d'un salon en paramètre court (`?t=` / `&t=`) dans un texte libre, hors d'une URL absolue. */
const SHORT_TOKEN_PARAM = /([?&])t=[^&\s"'<>;,]*/g;
/** Clés de débrideur en texte libre (hors d'une URL) : valeur masquée jusqu'au séparateur (&, /, |, espace). */
const DEBRID_PARAM = /\b((?:all|real)-?debrid\w*|torbox|premiumize|debridoptions)(\s*=\s*)[^\s&"',;}|/]+/gi;
const LONG_SEGMENT_IN_TEXT = /\/[^\s/]{41,}/g;
const SECRET = /(["']?\b(?:apikey|api_key|token|password|passwd|secret)\b["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi;
const EXTENSION = /^(?:chrome|moz|safari|safari-web|ms-browser|edge)-extension:\/\//i;
/** Catégories de fil d'Ariane écartées : clics, saisies et console. */
const NO_BREADCRUMB: ReadonlySet<string> = new Set(['ui.click', 'ui.input', 'console']);

/** Erreurs à ne pas envoyer (vérifiées sur le message et les types d'exception). */
const NOISE: readonly RegExp[] = [
  /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i,
  /\bAbortError\b|The user aborted a request|signal is aborted without reason|The operation was aborted/i,
  /The play\(\) request was interrupted|play\(\) failed because the user didn['’]t interact|no supported sources?|Failed to load because no supported source|fetching process for the media resource was aborted|MEDIA_ERR_SRC_NOT_SUPPORTED/i,
  /(?:chrome|moz|safari|safari-web|ms-browser|edge)-extension:\/\//i,
];

const MAX_DEPTH = 20;

const currentOrigin = (): string => (typeof location === 'undefined' ? '' : location.origin);

/** Fragment (routes #/…) : jeton de réinitialisation et pseudo d'ami masqués, paramètres après « ? » retirés. */
function scrubHash(hash: string): string {
  if (!hash) return '';
  if (/^#\/reset\/.+/.test(hash)) return '#/reset/[jeton]';
  if (/^#\/friend\/.+/.test(hash)) return '#/friend/[pseudo]';
  return scrubPath(hash.replace(/\?.*$/, ''));
}

/** Adresse absolue ou relative à l'application → forme sûre ; null si elle ne doit jamais être envoyée. */
export function scrubUrl(raw: string, appOrigin: string = currentOrigin()): string | null {
  const value = raw.trim();
  if (!value || /^magnet:/i.test(value) || DEBRID.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, appOrigin);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'stremio:') return null;
  if (MEDIA_FILE.test(url.pathname)) return null;
  const host = url.hostname.toLowerCase();
  // Application elle-même (hors adresse locale) : chemin et route gardés, segments de configuration masqués.
  if (url.origin === appOrigin && !isIpLiteral(host) && !isLocalName(host)) {
    return `${url.origin}${scrubPath(url.pathname)}${scrubHash(url.hash)}`;
  }
  // Hors de l'application (addon, TMDB, serveur perso) : hôte seul, et seulement s'il est autorisé.
  return reduceHost(url);
}

/** Texte libre (message, valeur de donnée) : URL réécrites, magnets retirés, clés secrètes et de débrideur masquées. */
export function scrubText(text: string, appOrigin: string = currentOrigin()): string {
  return text
    .replace(MAGNET, '[magnet retiré]')
    .replace(URL_IN_TEXT, (match) => {
      const trailing = /[.,;:!?)\]}]*$/.exec(match)?.[0] ?? '';
      const core = match.slice(0, match.length - trailing.length);
      return (scrubUrl(core, appOrigin) ?? '[url retirée]') + trailing;
    })
    .replace(SHORT_TOKEN_PARAM, '$1t=[retiré]')
    .replace(DEBRID_PARAM, '$1$2[retiré]')
    .replace(LONG_SEGMENT_IN_TEXT, '/[config]')
    .replace(SECRET, '$1[retiré]');
}

/** Applique `fn` à chaque chaîne d'une structure, en place. Au-delà de la profondeur maximale, rien n'est gardé. */
function mapStrings(value: unknown, fn: (s: string) => string, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return fn(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[tronqué]';
  if (seen.has(value)) return value;
  seen.add(value);
  const container = value as Record<string, unknown>;
  for (const key of Object.keys(container)) {
    container[key] = mapStrings(container[key], fn, depth + 1, seen);
  }
  return value;
}

/** Erreur de bruit, attendue ou venant d'une extension navigateur (cadre le plus récent). */
export function isNoise(event: ErrorEvent): boolean {
  const values: Exception[] = event.exception?.values ?? [];
  const texts = [event.message, ...values.flatMap((v) => [v.type, v.value])];
  if (texts.some((t) => typeof t === 'string' && NOISE.some((re) => re.test(t)))) return true;
  if (values.some((v) => v.type === 'AbortError')) return true;
  return values.some((v) => {
    const top = [...(v.stacktrace?.frames ?? [])].reverse().find((f) => f.filename);
    return typeof top?.filename === 'string' && EXTENSION.test(top.filename);
  });
}

/** Événement à envoyer, nettoyé en place ; null s'il doit être écarté. */
export function scrubEvent(event: ErrorEvent, appOrigin: string = currentOrigin()): ErrorEvent | null {
  if (isNoise(event)) return null;
  mapStrings(event, (s) => scrubText(s, appOrigin));
  if (event.request) {
    delete event.request.cookies;
    delete event.request.query_string;
  }
  // Compte : identifiant seulement (jamais pseudo, e-mail ou adresse IP).
  if (event.user) {
    if (event.user.id) event.user = { id: event.user.id };
    else delete event.user;
  }
  return event;
}

/** Fil d'Ariane nettoyé en place ; null s'il doit être écarté. */
export function scrubBreadcrumb(crumb: Breadcrumb, appOrigin: string = currentOrigin()): Breadcrumb | null {
  // Clics, saisies et console : écartés (breadcrumbs désactivés côté client, voir sentry.ts).
  if (NO_BREADCRUMB.has(crumb.category ?? '')) return null;
  const scrub = (s: string): string => scrubText(s, appOrigin);
  const data = crumb.data ?? {};
  if (crumb.category === 'fetch' || crumb.category === 'xhr') {
    if (typeof data.url !== 'string') return null;
    let url: URL;
    try {
      url = new URL(data.url, appOrigin);
    } catch (_) {
      return null;
    }
    // Hôte tiers : seulement l'hôte (ou [host]) et le statut de la réponse. Sinon : URL réduite, le reste gardé.
    crumb.data = url.origin !== appOrigin
      ? { host: reduceHost(url), status_code: data.status_code }
      : { ...data, url: scrubUrl(url.href, appOrigin) ?? '[url retirée]' };
  }
  if (crumb.category === 'navigation' && crumb.data) {
    for (const key of ['from', 'to']) {
      const value = crumb.data[key];
      if (typeof value === 'string') crumb.data[key] = scrubUrl(value, appOrigin) ?? '[url retirée]';
    }
  }
  if (crumb.message) crumb.message = scrub(crumb.message);
  if (crumb.data) mapStrings(crumb.data, scrub);
  return crumb;
}
