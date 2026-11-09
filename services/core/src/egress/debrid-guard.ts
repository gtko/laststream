/**
 * Garde de sortie unique : le serveur (Worker, cron, Node) ne contacte JAMAIS AllDebrid ni un hôte de débridage.
 * AllDebrid suspend les comptes appelés depuis des IP de serveurs : le débridage se fait sur l'appareil
 * (laststream-app, src/sources/debrid/). Toute tentative est un incident : la requête n'est pas envoyée, l'erreur
 * `server_side_disabled` est levée et un événement de niveau `error` part vers Sentry (hôte, déclencheur, identifiant
 * de requête ; jamais l'URL, le chemin, la chaîne de requête ni une clé).
 *
 * Module sans dépendance sur le SDK : le récepteur Sentry est installé par l'entrée du Worker (worker.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Hôtes de débridage interdits côté serveur : alldebrid.<suffixe> (tout suffixe : .com, .co.uk, punycode…), debrid.it et
 * leurs sous-domaines. Bloquer un peu trop est voulu. Limite : le filtre porte sur le nom, pas sur une IP littérale.
 */
const DEBRID_HOST = /(^|\.)(alldebrid\.[a-z0-9.-]+|debrid\.it)$/i;

/** Code d'erreur renvoyé quand la garde refuse un appel. */
export const SERVER_SIDE_DISABLED = 'server_side_disabled';

/** Hôte nu : minuscules, sans crochets IPv6 ni point final. */
function bareHost(host: string): string {
  return host.trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

/** Hôte d'un service de débridage ou d'un proxy de débridage (StremThru, ElfHosted, Lumio…) : son lien déclenche un débridage côté tiers. */
const RESOLVER_HOST = /debrid|stremthru|elfhosted|torbox|premiumize|lumio/i;
/**
 * Segment de chemin des liens de résolution de débrideur (`/resolve/alldebrid/<clé>/…`, `/playback/<config>/…`,
 * `/play/<jeton>` de Lumio).
 */
const RESOLVER_SEGMENT = /^(resolve|playback|play|streaming_provider|alldebrid|debrid|realdebrid|torbox|premiumize)$/i;

/**
 * Lien de résolution d'un débrideur (hôte ou segment de chemin) : une requête du serveur, même une simple sonde, ferait
 * débrider le lien chez le tiers avec une IP de serveur (erreur « Wrong IP » d'ElfHosted, compte AllDebrid suspendu).
 * Heuristique volontairement large : la sonde de sources s'en abstient ; le lien reste rendu à l'appareil.
 */
export function isDebridResolverUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (RESOLVER_HOST.test(url.hostname)) return true;
    return url.pathname.split('/').some((segment) => RESOLVER_SEGMENT.test(segment));
  } catch {
    return false;
  }
}

/** Cet hôte est-il un hôte de débridage ? */
export function isDebridHost(host: string): boolean {
  return DEBRID_HOST.test(bareHost(host));
}

/** Contexte de l'exécution en cours (requête ou cron), pour situer un appel bloqué. */
export interface EgressContext {
  /** « request » ou « cron » : jamais de chemin (il peut porter une configuration chiffrée). */
  trigger: string;
  requestId?: string;
}

const contextStore = new AsyncLocalStorage<EgressContext>();

/** Exécute `work` avec le contexte de sortie : les appels bloqués pendant `work` y sont rattachés. */
export function runWithEgressContext<T>(context: EgressContext, work: () => T): T {
  return contextStore.run(context, work);
}

/** Appel serveur vers un hôte de débridage, bloqué avant envoi. Ne porte que l'hôte : jamais l'URL. */
export class DebridEgressBlockedError extends Error {
  readonly code = SERVER_SIDE_DISABLED;
  readonly host: string;
  readonly trigger: string;
  readonly requestId: string | undefined;

  constructor(host: string, trigger: string, requestId: string | undefined) {
    super('appel serveur vers un hôte de débridage bloqué');
    this.name = 'DebridEgressBlockedError';
    this.host = host;
    this.trigger = trigger;
    this.requestId = requestId;
  }
}

/** Récepteur d'un appel bloqué (Sentry, côté Worker). Sans récepteur, la trace reste dans la console. */
export type DebridBlockReporter = (error: DebridEgressBlockedError) => void;

let reporter: DebridBlockReporter | undefined;

export function setDebridBlockReporter(next: DebridBlockReporter | undefined): void {
  reporter = next;
}

/** Au plus un événement par hôte et déclencheur toutes les 10 min et par isolat : le refus et la console restent systématiques. */
const REPORT_INTERVAL_MS = 10 * 60_000;
const MAX_TRACKED = 200;
const lastReported = new Map<string, number>();

/** Remet l'étouffement à zéro (tests). */
export function resetDebridReportThrottle(): void {
  lastReported.clear();
}

function dueForReport(error: DebridEgressBlockedError, now: number): boolean {
  const key = `${error.host}|${error.trigger}`;
  const last = lastReported.get(key);
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) return false;
  if (lastReported.size >= MAX_TRACKED) lastReported.clear();
  lastReported.set(key, now);
  return true;
}

/** Journalise l'incident (console + récepteur, ce dernier étouffé). Ne lève jamais : un échec de remontée ne change pas le refus. */
function report(error: DebridEgressBlockedError): void {
  try {
    console.error(
      JSON.stringify({ level: 'error', event: 'server_side_debrid_call_blocked', host: error.host, trigger: error.trigger, requestId: error.requestId }),
    );
  } catch {
    // Sans effet sur le refus.
  }
  try {
    if (reporter !== undefined && dueForReport(error, Date.now())) reporter(error);
  } catch {
    // Sans effet sur le refus.
  }
}

/**
 * Refuse une URL qui vise un hôte de débridage : n'envoie rien, journalise, lève DebridEgressBlockedError.
 * `site` nomme le chemin serveur qui appelle (« fetch-bytes », « tv-health », « probe »…).
 */
export function assertNotDebrid(target: string | URL, site: string): void {
  let host: string;
  try {
    host = (typeof target === 'string' ? new URL(target) : target).hostname;
  } catch {
    return;
  }
  if (!isDebridHost(host)) return;
  const context = contextStore.getStore();
  const trigger = [context?.trigger, site].filter((part): part is string => part !== undefined).join('/');
  const error = new DebridEgressBlockedError(bareHost(host), trigger, context?.requestId);
  report(error);
  throw error;
}

type FetchFn = typeof fetch;

/** Au plus autant de sauts que le fetch natif. */
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const WRAPPED = new WeakSet<object>();

function targetOf(input: Parameters<FetchFn>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** Corps qu'on peut renvoyer tel quel après une redirection 307/308. */
function isReplayable(body: RequestInit['body']): boolean {
  return body === undefined || body === null || typeof body === 'string' || body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

/** Réponse finale d'une chaîne suivie à la main : `url` et `redirected` décrivent le dernier saut, comme le fetch natif. */
function withFinalUrl(response: Response, url: string): Response {
  try {
    Object.defineProperty(response, 'url', { value: url, configurable: true });
    Object.defineProperty(response, 'redirected', { value: true, configurable: true });
  } catch {
    // Plateforme qui refuse de redéfinir : l'appelant retombe sur l'URL demandée.
  }
  return response;
}

/**
 * Enrobe un fetch : l'hôte est contrôlé AVANT chaque envoi, redirections comprises. Une requête qui suit les
 * redirections (mode « follow », défaut) est suivie ici, saut par saut, pour refuser un saut vers un hôte de débridage
 * avant de l'envoyer (le fetch natif aurait déjà contacté l'hôte). Les modes « manual » et « error » ne suivent rien :
 * seul l'hôte demandé est contrôlé, et le saut suivant repasse par la garde.
 */
export function guardedFetch(inner: FetchFn, site: string): FetchFn {
  if (WRAPPED.has(inner)) return inner;
  const guarded: FetchFn = async (input, init) => {
    let current = targetOf(input);
    assertNotDebrid(current, site);
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
    if (mode !== 'follow') return inner(input, init);

    // Requête passée en objet : méthode, en-têtes, signal, cache et cf valent pour tous les sauts, pas seulement le premier.
    const fromRequest: RequestInit & { cf?: unknown } = {};
    if (input instanceof Request) {
      Object.assign(fromRequest, { method: input.method, headers: input.headers, signal: input.signal });
      // workerd n'accepte que no-store et no-cache : « default » (valeur par défaut d'un Request) n'est pas recopié.
      if (input.cache !== 'default') Object.assign(fromRequest, { cache: input.cache });
      const cf = (input as { cf?: unknown }).cf;
      if (cf !== undefined) fromRequest.cf = cf;
    }
    let hopInput: Parameters<FetchFn>[0] = input;
    let hopInit: RequestInit = { ...fromRequest, ...init, redirect: 'manual' };
    for (let hops = 0; ; hops += 1) {
      const response = await inner(hopInput, hopInit);
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
      if (location === null) return hops === 0 ? response : withFinalUrl(response, current);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      // Avant tout envoi : un saut vers un hôte de débridage est refusé, la requête ne part pas.
      assertNotDebrid(next, site);
      if (hops + 1 > MAX_REDIRECTS) throw new TypeError('fetch failed: too many redirects');
      const method = (hopInit.method ?? (hopInput instanceof Request ? hopInput.method : 'GET')).toUpperCase();
      const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST');
      const consumed = hopInput instanceof Request && hopInput.body !== null && hopInit.body === undefined;
      // 307/308 avec un corps qu'on ne peut pas rejouer : la redirection est rendue telle quelle.
      if (!toGet && (consumed || !isReplayable(hopInit.body))) return response;
      const headers = new Headers(hopInit.headers ?? (hopInput instanceof Request ? hopInput.headers : undefined));
      if (next.origin !== new URL(current).origin) {
        headers.delete('authorization');
        headers.delete('proxy-authorization');
        headers.delete('cookie');
      }
      if (toGet) {
        headers.delete('content-type');
        headers.delete('content-length');
        const { body: _body, ...rest } = hopInit;
        hopInit = { ...rest, method: 'GET', headers, redirect: 'manual' };
      } else {
        hopInit = { ...hopInit, headers, redirect: 'manual' };
      }
      hopInput = next.href;
      current = next.href;
    }
  };
  WRAPPED.add(guarded);
  return guarded;
}

const INSTALLED = Symbol.for('laststream.egress-guard');

/** Pose la garde sur le fetch global du processus (une seule fois) : couvre aussi les bibliothèques. */
export function installEgressGuard(): void {
  const holder = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (holder[INSTALLED] === true) return;
  holder[INSTALLED] = true;
  globalThis.fetch = guardedFetch(globalThis.fetch.bind(globalThis), 'global-fetch');
}
