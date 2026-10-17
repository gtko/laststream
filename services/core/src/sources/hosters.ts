/**
 * Hébergeurs AllDebrid (1fichier, Uptobox…) : liste des hôtes et de leurs regexps (cache 12 h), contrôle de
 * disponibilité par lot (/v4/link/infos) et débridage en lien direct (/v4/link/unlock, /v4/link/delayed,
 * /v4/link/streaming). Générique : la liste vient d'AllDebrid, aucun hébergeur n'est codé ici.
 *
 * Sécurité : ni la clé, ni une URL, ni un lien débridé n'entrent dans une erreur ou un journal. Les erreurs
 * AllDebrid sont traduites en codes du failover (RESOLVE_ERROR_CODES), portés par AllDebridError.code.
 *
 * Formes de réponse : parsées de façon tolérante (liste ou objet indexé par domaine pour /user/hosts). À vérifier
 * contre la documentation officielle AllDebrid avant mise en production.
 */

import { AllDebridError, type AllDebridClient } from './alldebrid.js';
import { isRecord } from './http.js';
import { hostFromUrl, normalizeHost } from '../play/hosts.js';
import { RESOLVE_ERROR_CODES, type ResolveErrorCode } from '../play/failover.js';

const HOSTS_TTL_MS = 12 * 60 * 60 * 1_000;
const INFOS_BATCH_SIZE = 20;
const MAX_HOSTERS = 500;
const MAX_DOMAINS_PER_HOSTER = 50;
const MAX_PATTERNS_PER_HOSTER = 50;
const MAX_PATTERN_LENGTH = 500;
const MAX_STREAMS = 20;
const MAX_TEXT_LENGTH = 512;
const DELAYED_INTERVAL_MS = 1_000;
const DEFAULT_DELAY_BUDGET_MS = 10_000;
const MAX_DELAY_BUDGET_MS = 60_000;
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_]{1,60}$/;

/** Codes AllDebrid connus, traduits en codes du failover. Tout autre code devient `unknown`. */
const ALLDEBRID_CODES: ReadonlyMap<string, ResolveErrorCode> = new Map<string, ResolveErrorCode>([
  ['AUTH_BAD_APIKEY', 'invalid_key'],
  ['AUTH_MISSING_APIKEY', 'invalid_key'],
  ['AUTH_BLOCKED', 'invalid_key'],
  ['MUST_BE_PREMIUM', 'subscription_expired'],
  ['FREE_TRIAL_LIMIT_REACHED', 'quota'],
  ['LINK_HOST_UNAVAILABLE', 'host_unavailable'],
  ['LINK_HOST_FULL', 'host_unavailable'],
  ['LINK_TEMPORARY_UNAVAILABLE', 'host_unavailable'],
  ['LINK_DOWN', 'dead_link'],
  ['LINK_ERROR', 'dead_link'],
  ['LINK_HOST_NOT_SUPPORTED', 'unsupported'],
  ['LINK_PASS_PROTECTED', 'unsupported'],
]);

/** Hébergeur listé par AllDebrid : nom affiché, domaines (sous-domaines inclus) et regexps d'URL compilées. */
export interface HosterInfo {
  name: string;
  domains: string[];
  patterns: RegExp[];
}

/** Résultat de /v4/link/infos pour un lien. `alive` faux : AllDebrid signale une erreur (lien mort ou non supporté). */
export interface LinkInfo {
  url: string;
  alive: boolean;
  filename?: string;
  size?: number;
  hostDomain?: string;
  /** Code AllDebrid de l'erreur (ex. LINK_DOWN). Absent si le lien est vivant. */
  errorCode?: string;
}

/** Lien débridé. L'URL est sensible : elle ne doit jamais être journalisée. */
export interface HosterLink {
  url: string;
  filename?: string;
  size?: number;
}

export interface UnlockOptions {
  /** Attente totale accordée à un lien différé (défaut 10 s, plafond 60 s). */
  delayBudgetMs?: number;
  /** Pause entre deux interrogations d'un lien différé (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Annulation de l'appelant : l'attente d'un lien différé s'arrête. */
  signal?: AbortSignal;
}

export interface HosterClientOptions {
  /** Horloge en millisecondes (défaut : Date.now). Injectable pour les tests. */
  now?: () => number;
}

/** Ce qu'un HosterClient attend d'un client AllDebrid : l'appel brut de l'API. */
export type HosterApi = Pick<AllDebridClient, 'call'>;

interface Catalog {
  hosters: HosterInfo[];
  byDomain: Map<string, HosterInfo>;
  expiresAt: number;
}

interface StreamOption {
  id: string;
  quality: number;
  size?: number;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TEXT_LENGTH ? trimmed : undefined;
}

function positiveBytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Identifiant AllDebrid (entier ou chaîne alphanumérique courte). */
function idText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && ID_PATTERN.test(value)) return value;
  return undefined;
}

/** Qualité d'un flux : nombre (1080) ou libellé (« 1080p »). 0 si inconnue. */
function qualityOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = /(\d{3,4})/.exec(value);
    if (match !== null) return Number(match[1]);
  }
  return 0;
}

/** Code d'erreur d'un champ `error` : undefined si absent (lien vivant), sinon le code (ou `unknown`). */
function errorCodeOf(value: unknown): string | undefined {
  if (!hasValue(value)) return undefined;
  if (isRecord(value) && typeof value.code === 'string' && ERROR_CODE_PATTERN.test(value.code)) return value.code;
  return 'unknown';
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Code du failover pour un code AllDebrid ou un code local. Tout code inconnu devient `unknown`. */
function resolveCodeOf(code: string): ResolveErrorCode {
  const mapped = ALLDEBRID_CODES.get(code);
  if (mapped !== undefined) return mapped;
  return (RESOLVE_ERROR_CODES as readonly string[]).includes(code) ? (code as ResolveErrorCode) : 'unknown';
}

/** Erreur du client à transmettre au failover : code traduit, message sans contenu sensible. */
function toHosterError(err: unknown): AllDebridError {
  const code = err instanceof AllDebridError ? resolveCodeOf(err.code) : 'unknown';
  return new AllDebridError(code, `AllDebrid : ${code}`);
}

async function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw toHosterError(err);
  }
}

function addDomain(domains: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const domain = normalizeHost(value);
  if (domain !== undefined && DOMAIN_PATTERN.test(domain)) domains.add(domain);
}

/** Regexps fournies par AllDebrid. Une regexp invalide ou trop longue est ignorée. */
function compilePatterns(value: unknown): RegExp[] {
  const sources: unknown[] = Array.isArray(value) ? value : [];
  const patterns: RegExp[] = [];
  for (const source of sources.slice(0, MAX_PATTERNS_PER_HOSTER)) {
    if (typeof source !== 'string' || source.length === 0 || source.length > MAX_PATTERN_LENGTH) continue;
    try {
      patterns.push(new RegExp(source, 'i'));
    } catch {
      // Regexp invalide : ignorée.
    }
  }
  return patterns;
}

/**
 * Liste des hébergeurs. Accepte une liste d'objets { name, domains, regexps } ou un objet indexé par domaine
 * (la clé est alors un domaine de l'hébergeur).
 */
function parseHosters(raw: unknown): HosterInfo[] {
  const entries: [string | undefined, unknown][] = Array.isArray(raw)
    ? raw.map((entry): [string | undefined, unknown] => [undefined, entry])
    : isRecord(raw)
      ? Object.entries(raw)
      : [];
  const hosters: HosterInfo[] = [];
  for (const [key, entry] of entries.slice(0, MAX_HOSTERS)) {
    if (!isRecord(entry)) continue;
    const domains = new Set<string>();
    if (key !== undefined) addDomain(domains, key);
    const listed: unknown[] = Array.isArray(entry.domains) ? entry.domains : [];
    for (const domain of listed.slice(0, MAX_DOMAINS_PER_HOSTER)) addDomain(domains, domain);
    const list = [...domains];
    const patterns = compilePatterns(entry.regexps);
    const name = cleanText(entry.name) ?? list[0];
    if (name === undefined || (list.length === 0 && patterns.length === 0)) continue;
    hosters.push({ name, domains: list, patterns });
  }
  return hosters;
}

function indexByDomain(hosters: readonly HosterInfo[]): Map<string, HosterInfo> {
  const byDomain = new Map<string, HosterInfo>();
  for (const hoster of hosters) {
    for (const domain of hoster.domains) {
      if (!byDomain.has(domain)) byDomain.set(domain, hoster);
    }
  }
  return byDomain;
}

/** Cherche l'hôte puis ses domaines parents (sous-domaines inclus). Les domaines ont toujours un point. */
function findByDomain(byDomain: ReadonlyMap<string, HosterInfo>, host: string): HosterInfo | undefined {
  let domain: string | undefined = host;
  while (domain !== undefined) {
    const found = byDomain.get(domain);
    if (found !== undefined) return found;
    const dot = domain.indexOf('.');
    domain = dot < 0 ? undefined : domain.slice(dot + 1);
  }
  return undefined;
}

/**
 * Résultats de /v4/link/infos. L'entrée est associée à son lien par son écho (`link`) ; sans écho, par sa position
 * si la réponse a la même longueur que le lot. Les liens restent sous la forme exacte envoyée.
 */
function parseInfos(value: unknown, batch: readonly string[]): LinkInfo[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  const wanted = new Set(batch);
  const infos: LinkInfo[] = [];
  list.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    let url: string | undefined;
    if (typeof entry.link === 'string') {
      url = wanted.has(entry.link) ? entry.link : undefined;
    } else if (list.length === batch.length) {
      url = batch[index];
    }
    if (url === undefined) return;
    const errorCode = errorCodeOf(entry.error);
    const hostDomain = typeof entry.hostDomain === 'string' ? normalizeHost(entry.hostDomain) : undefined;
    infos.push({
      url,
      alive: errorCode === undefined,
      filename: cleanText(entry.filename),
      size: positiveBytes(entry.size ?? entry.filesize),
      hostDomain,
      errorCode,
    });
  });
  return infos;
}

function parseStreams(value: unknown): StreamOption[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  const streams: StreamOption[] = [];
  for (const entry of list.slice(0, MAX_STREAMS)) {
    if (!isRecord(entry)) continue;
    const id = idText(entry.id);
    if (id === undefined) continue;
    streams.push({ id, quality: qualityOf(entry.quality), size: positiveBytes(entry.filesize) });
  }
  return streams;
}

/** Flux de meilleure qualité ; à qualité égale, le premier de la liste. */
function bestStream(streams: readonly StreamOption[]): StreamOption | undefined {
  let best: StreamOption | undefined;
  for (const stream of streams) {
    if (best === undefined || stream.quality > best.quality) best = stream;
  }
  return best;
}

/**
 * Client des hébergeurs AllDebrid. Réutilise l'appel brut d'AllDebridClient (clé, recul 429/503, délais, erreurs).
 * Ne lève jamais depuis les méthodes de contrôle : linkInfos omet les lots en erreur ; getHosts et unlock lèvent
 * une AllDebridError dont le code est un code du failover.
 */
export class HosterClient {
  private readonly api: HosterApi;
  private readonly now: () => number;
  private catalog: Catalog | undefined;
  private loading: Promise<HosterInfo[]> | undefined;

  constructor(api: HosterApi, opts: HosterClientOptions = {}) {
    this.api = api;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Liste des hébergeurs (GET /v4/user/hosts), gardée 12 h. Les appels concurrents partagent une seule requête. */
  async getHosts(): Promise<HosterInfo[]> {
    const cached = this.catalog;
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.hosters;
    const pending = this.loading ?? this.loadHosts().finally(() => {
      this.loading = undefined;
    });
    this.loading = pending;
    return pending;
  }

  /**
   * Hébergeur dont l'URL relève (domaine, sous-domaine ou regexp), à partir du dernier catalogue chargé.
   * Undefined si le catalogue n'est pas chargé, si l'URL n'est pas http(s) ou si aucun hébergeur ne la reconnaît.
   */
  hosterFor(url: string): HosterInfo | undefined {
    const catalog = this.catalog;
    if (catalog === undefined) return undefined;
    const host = hostFromUrl(url);
    if (host === undefined) return undefined;
    const byDomain = findByDomain(catalog.byDomain, host);
    if (byDomain !== undefined) return byDomain;
    return catalog.hosters.find((hoster) => hoster.patterns.some((pattern) => pattern.test(url)));
  }

  /** Vrai si l'URL est un lien d'hébergeur listé par AllDebrid. Une URL http de streaming direct non listée est refusée. */
  isHosterUrl(url: string): boolean {
    return this.hosterFor(url) !== undefined;
  }

  /**
   * Contrôle des liens par lots (POST /v4/link/infos). Renvoie une Map indexée par l'URL envoyée. Un lien absent de
   * la Map est inconnu (lot en erreur, réponse incomplète). Ne lève jamais.
   */
  async linkInfos(urls: readonly string[]): Promise<Map<string, LinkInfo>> {
    const unique = [...new Set(urls.filter(isHttpUrl))];
    const result = new Map<string, LinkInfo>();
    for (const batch of chunk(unique, INFOS_BATCH_SIZE)) {
      try {
        const data = await mapErrors(() =>
          this.api.call('POST', '/v4/link/infos', new URLSearchParams(batch.map((url): [string, string] => ['link[]', url]))),
        );
        for (const info of parseInfos(data.infos, batch)) result.set(info.url, info);
      } catch {
        // Lot en erreur : ses liens restent inconnus.
      }
    }
    return result;
  }

  /**
   * Débride un lien d'hébergeur (POST /v4/link/unlock). Lien différé : interrogation de /v4/link/delayed jusqu'au
   * budget. Flux disponibles : choix du meilleur (/v4/link/streaming), avec repli sur le lien direct. Lève une
   * AllDebridError dont le code est un code du failover (not_ready si le budget est épuisé).
   */
  async unlock(url: string, opts: UnlockOptions = {}): Promise<HosterLink> {
    if (!isHttpUrl(url)) throw new AllDebridError('unsupported', 'AllDebrid : lien non HTTP');
    return mapErrors(async () => {
      let data = await this.api.call('POST', '/v4/link/unlock', new URLSearchParams([['link', url]]));
      if (hasValue(data.delayed)) data = await this.waitDelayed(data.delayed, opts);
      return this.toLink(data);
    });
  }

  private async loadHosts(): Promise<HosterInfo[]> {
    const data = await mapErrors(() => this.api.call('GET', '/v4/user/hosts'));
    const hosters = parseHosters(data.hosts);
    if (hosters.length === 0) throw new AllDebridError('unknown', 'AllDebrid : liste d\'hébergeurs invalide');
    this.catalog = { hosters, byDomain: indexByDomain(hosters), expiresAt: this.now() + HOSTS_TTL_MS };
    return hosters;
  }

  /** Interroge /v4/link/delayed jusqu'à obtenir un lien, dans la limite du budget (une interrogation par seconde). */
  private async waitDelayed(delayed: unknown, opts: UnlockOptions): Promise<Record<string, unknown>> {
    const id = idText(delayed);
    if (id === undefined) throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    const sleep = opts.sleep ?? defaultSleep;
    const budget = Math.min(Math.max(opts.delayBudgetMs ?? DEFAULT_DELAY_BUDGET_MS, 0), MAX_DELAY_BUDGET_MS);
    const attempts = Math.max(1, Math.floor(budget / DELAYED_INTERVAL_MS));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (opts.signal?.aborted === true) throw new AllDebridError('not_ready', 'interrompu');
      const data = await this.api.call('POST', '/v4/link/delayed', new URLSearchParams([['id', id]]));
      if (isHttpUrl(data.link)) return data;
      if (attempt < attempts) await sleep(DELAYED_INTERVAL_MS);
    }
    throw new AllDebridError('not_ready', 'not_ready');
  }

  private async toLink(data: Record<string, unknown>): Promise<HosterLink> {
    const filename = cleanText(data.filename);
    const size = positiveBytes(data.filesize);
    const directUrl = data.link;
    const best = bestStream(parseStreams(data.streams));
    const linkId = idText(data.id);
    if (best !== undefined && linkId !== undefined) {
      try {
        const streamed = await this.api.call(
          'POST',
          '/v4/link/streaming',
          new URLSearchParams([
            ['id', linkId],
            ['stream', best.id],
          ]),
        );
        const streamUrl = streamed.link;
        if (isHttpUrl(streamUrl)) return { url: streamUrl, filename, size: best.size ?? size };
      } catch (err) {
        // Repli sur le lien direct si l'hébergeur en a un ; sinon l'erreur remonte.
        if (!isHttpUrl(directUrl)) throw err;
      }
    }
    if (isHttpUrl(directUrl)) return { url: directUrl, filename, size };
    throw new AllDebridError('invalid_response', 'AllDebrid : lien invalide');
  }
}
