import { guardedFetch } from '../egress/debrid-guard.js';
import { scanJson, scanJsonArray, scanLines } from './json-stream.js';
import {
  buildCatalog,
  type CatalogInput,
  type FastEntry,
  type IptvOrgRaw,
  type TvCatalog,
  type TvChannel,
  tvgEpgId,
} from './tv-catalog.js';
import { fastEntry, M3uAccumulator, type Programme, XmltvIngest } from './tv-feed.js';
import { applyHealth, type HealthMap, type HealthOptions } from './tv-health.js';
import { epgSourceId, type PassPlan, type TvPassTrace } from './tv-passes.js';

/**
 * Construction du catalogue TV et de l'EPG sur Cloudflare Workers (Cron Trigger), en flux : aucune source n'est lue en
 * entier en mémoire (128 Mo par isolat). Les fichiers iptv-org (jusqu'à 32 Mo de JSON) sont parcourus élément par
 * élément et filtrés aux pays retenus ; l'EPG XMLTV (jusqu'à 256 Mo décompressé) est décompressé en flux et filtré aux
 * chaînes retenues, fenêtre maintenant → +24 h. Le résultat tient dans R2 (voir TvBlobStore).
 */

const TV_SOURCES = {
  freetv: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
  pluto: 'https://i.mjh.nz/PlutoTV/.channels.json',
  samsung: 'https://i.mjh.nz/SamsungTVPlus/.channels.json',
  iptvApi: 'https://iptv-org.github.io/api/',
  epg: [
    'https://xmltvfr.fr/xmltv/xmltv_tnt.xml.gz',
    'https://iptv-epg.org/files/epg-fr.xml.gz',
    'https://i.mjh.nz/PlutoTV/fr.xml.gz',
    'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz',
  ],
} as const;

/** Pays gardés par défaut (France d'abord, pays francophones voisins). Surchargé par la variable TV_COUNTRIES. */
export const DEFAULT_TV_COUNTRIES: readonly string[] = ['FR', 'BE', 'CH', 'LU', 'CA', 'MC'];

/** Clés R2. */
export const TV_KEYS = { catalog: 'catalog.json', epg: 'epg.json', probe: 'probe.json' } as const;

/** URL XMLTV lues pour l'EPG, dans l'ordre de priorité (la première source gagne pour une chaîne). */
export const TV_EPG_URLS: readonly string[] = TV_SOURCES.epg;

/** Plan d'une passe complète ; `probe` active les sondages et le contrôle de santé des flux. */
export function fullPlan(probe: boolean): PassPlan {
  return { kind: 'full', catalog: true, epg: TV_EPG_URLS, probes: probe, health: probe };
}

/** Code court d'une erreur de source (jamais de message brut : une URL ou une clé pourrait y figurer). */
function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'delai_depasse';
    if (/^(upstream_\d{3}|source_too_large|epg_too_large)$/.test(error.message)) return error.message;
  }
  return 'erreur_reseau';
}

/** Exécute le travail d'une source et range son résultat dans la trace (échec compris ; l'erreur est relancée). */
async function timedSource<T>(trace: TvPassTrace | undefined, id: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const value = await work();
    if (trace !== undefined) trace.sources[id] = { ok: true, durationMs: Date.now() - started };
    return value;
  } catch (error) {
    if (trace !== undefined) trace.sources[id] = { ok: false, durationMs: Date.now() - started, error: errorCode(error) };
    throw error;
  }
}

/** Stockage d'objets (R2 sous Workers). Le contenu est du JSON texte. */
export interface TvBlobStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

export interface CatalogSnapshot {
  v: 1;
  builtAt: number;
  catalog: TvCatalog;
}

export interface EpgSnapshot {
  v: 1;
  builtAt: number;
  epgStats: { url: string; programmes: number; ok: boolean }[];
  programmes: Record<string, Programme[]>;
}

/** Résultats de sondage « lisible sans relais depuis une page web » : url → [1 oui / 0 non, date du sondage en s]. */
export interface ProbeSnapshot {
  v: 1;
  results: Record<string, [0 | 1, number]>;
  /** Sondes en échec (LAST-137) : url → date de la dernière tentative en s. En reprise, les URL jamais tentées passent avant. */
  failed?: Record<string, number>;
  /** Test de santé des flux (tv-health.ts) : url → [échecs consécutifs, date du dernier contrôle en s]. */
  health?: HealthMap;
}

export interface TvBuildOptions {
  fetch?: typeof fetch;
  countries?: readonly string[];
  /** Origine de la page web, présentée aux flux pour savoir s'ils répondent avec CORS. */
  probeOrigin?: string;
  /** Sonder les flux (CORS). Désactivé pour une première construction rapide. */
  probe?: boolean;
  /** Plafond de sondages par exécution (nombre de sous-requêtes) et durée maximale du sondage. */
  maxProbes?: number;
  probeBudgetMs?: number;
  now?: () => number;
  /** Réutilisation des sondages : durée de validité (s). */
  probeTtlSec?: number;
  /** Réglages du test de santé des flux (seuil, budget…). Les contrôles ne tournent qu'avec `probe`. */
  health?: Omit<HealthOptions, 'fetch' | 'now' | 'check'>;
  /** Plan de la passe (reprise du cron, LAST-137). Absent : passe complète, selon `probe`. */
  plan?: PassPlan;
  /** Trace du passage : résultat de chaque source et sondes. Remplie même si la construction échoue. */
  trace?: TvPassTrace;
  /** EPG : seules ces URL sont lues. Absent : toutes. */
  epgOnly?: readonly string[];
  /** EPG : snapshot précédent à compléter (reprise d'une source EPG en échec). */
  epgSeed?: EpgSnapshot;
}

const HEADERS = { 'user-agent': 'Mozilla/5.0 Laststream', accept: '*/*' };
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
const MAX_EPG_COMPRESSED_BYTES = 96 * 1024 * 1024;
const MAX_EPG_CHARS = 768 * 1024 * 1024;
const EPG_AHEAD_SECONDS = 24 * 3600;
const EPG_BEHIND_SECONDS = 1800;

/** Flux qui échoue au-delà de `max` octets (source démesurée). */
function limited(stream: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) throw new Error('source_too_large');
        controller.enqueue(chunk);
      },
    }),
  );
}

async function openStream(fetcher: typeof fetch, url: string, timeoutMs: number, maxBytes: number): Promise<ReadableStream<Uint8Array>> {
  const res = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || res.body === null) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`upstream_${res.status}`);
  }
  return limited(res.body as ReadableStream<Uint8Array>, maxBytes);
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Tableau JSON racine d'iptv-org, élément par élément : `pick` renvoie l'élément réduit à garder, ou null. */
async function collect(
  fetcher: typeof fetch,
  file: string,
  pick: (record: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const stream = await openStream(fetcher, TV_SOURCES.iptvApi + file + '.json', 120000, MAX_JSON_BYTES);
  await scanJsonArray(stream, (record) => {
    const kept = pick(record);
    if (kept !== null) out.push(kept);
  });
  return out;
}

/** Fichiers iptv-org réduits aux pays retenus : chaînes, flux, feeds et logos de ces chaînes seulement. */
async function loadIptvOrg(fetcher: typeof fetch, countries: ReadonlySet<string>): Promise<IptvOrgRaw> {
  const channels = await collect(fetcher, 'channels', (r) => {
    const country = str(r.country).toUpperCase();
    if (!countries.has(country)) return null;
    return {
      id: r.id,
      name: r.name,
      country,
      categories: r.categories,
      alt_names: r.alt_names,
      closed: r.closed,
      is_nsfw: r.is_nsfw,
    };
  });
  const ids = new Set(channels.map((channel) => str(channel.id)));
  const [streams, feeds, logos, countryList, languages, blocklist] = await Promise.all([
    collect(fetcher, 'streams', (r) =>
      ids.has(str(r.channel)) ? { channel: r.channel, feed: r.feed, url: r.url, quality: r.quality, labels: r.labels } : null,
    ),
    collect(fetcher, 'feeds', (r) => (ids.has(str(r.channel)) ? { channel: r.channel, id: r.id, languages: r.languages } : null)),
    collect(fetcher, 'logos', (r) =>
      ids.has(str(r.channel)) && r.in_use === true ? { channel: r.channel, feed: r.feed, in_use: true, url: r.url } : null,
    ),
    collect(fetcher, 'countries', (r) => ({ code: r.code, name: r.name, languages: r.languages })),
    collect(fetcher, 'languages', (r) => ({ code: r.code, name: r.name })),
    collect(fetcher, 'blocklist', (r) => (ids.has(str(r.channel)) ? { channel: r.channel } : null)),
  ]);
  return { channels, streams, feeds, logos, countries: countryList, languages, blocklist };
}

/** Playlist Free-TV, ligne à ligne, limitée aux pays retenus. */
async function loadFreeTv(fetcher: typeof fetch, countries: ReadonlySet<string>) {
  const acc = new M3uAccumulator((entry) => countries.has((entry.attrs['tvg-country'] ?? '').toUpperCase()));
  await scanLines(await openStream(fetcher, TV_SOURCES.freetv, 60000, MAX_PLAYLIST_BYTES), (line) => acc.push(line));
  return acc.entries;
}

/** Chaînes FAST françaises (Pluto TV, Samsung TV Plus) : seul `regions.fr.channels` est parcouru. */
async function loadFast(fetcher: typeof fetch, url: string, source: 'pluto' | 'samsung', prefix: string, slug: string): Promise<FastEntry[]> {
  const out: FastEntry[] = [];
  await scanJson(await openStream(fetcher, url, 60000, MAX_JSON_BYTES), ['regions', 'fr', 'channels'], (text) => {
    try {
      const entry = JSON.parse('{' + text + '}') as Record<string, unknown>;
      for (const [id, info] of Object.entries(entry)) {
        if (typeof info === 'object' && info !== null) out.push(fastEntry(id, info as Record<string, unknown>, source, prefix, slug));
      }
    } catch {
      // entrée illisible : ignorée
    }
  });
  return out;
}

/** Catalogue : toutes les sources en parallèle ; une source en échec est absente (catalogue partiel). */
export async function buildCatalogStreaming(options: TvBuildOptions = {}): Promise<TvCatalog> {
  const fetcher = guardedFetch(options.fetch ?? fetch, 'tv-build');
  const countries = new Set((options.countries ?? DEFAULT_TV_COUNTRIES).map((code) => code.toUpperCase()));
  const trace = options.trace;
  const [iptv, freetv, pluto, samsung] = await Promise.allSettled([
    timedSource(trace, 'iptv', () => loadIptvOrg(fetcher, countries)),
    timedSource(trace, 'freetv', () => loadFreeTv(fetcher, countries)),
    timedSource(trace, 'pluto', () => loadFast(fetcher, TV_SOURCES.pluto, 'pluto', 'plu', 'https://jmp2.uk/plu-{id}.m3u8')),
    timedSource(trace, 'samsung', () => loadFast(fetcher, TV_SOURCES.samsung, 'samsung', 'stv', 'https://jmp2.uk/stvp-{id}')),
  ]);
  const input: CatalogInput = {
    iptv: iptv.status === 'fulfilled' ? iptv.value : null,
    freetv: freetv.status === 'fulfilled' ? freetv.value : null,
    fast: [...(pluto.status === 'fulfilled' ? pluto.value : []), ...(samsung.status === 'fulfilled' ? samsung.value : [])],
    partial: [iptv, freetv, pluto, samsung].some((result) => result.status === 'rejected'),
  };
  if ([iptv, freetv, pluto, samsung].every((result) => result.status === 'rejected')) throw new Error('tv_unavailable');
  return buildCatalog(input);
}

/** Identifiants EPG des chaînes d'un catalogue. */
export function epgIdsOf(catalog: TvCatalog): Set<string> {
  const ids = new Set<string>();
  for (const channel of catalog.channels) {
    const id = tvgEpgId(channel.epgId);
    if (id !== '') ids.add(id);
    if (channel.epgId !== '') ids.add(channel.epgId);
  }
  return ids;
}

/** Programmes d'une source XMLTV (gzip ou non) lus en flux, décompression comprise. */
async function ingestEpgSource(fetcher: typeof fetch, url: string, ingest: XmltvIngest): Promise<void> {
  let stream: ReadableStream<Uint8Array> = await openStream(fetcher, url, 120000, MAX_EPG_COMPRESSED_BYTES);
  if (/\.gz$/i.test(url)) stream = stream.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let chars = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      chars += text.length;
      if (chars > MAX_EPG_CHARS) throw new Error('epg_too_large');
      ingest.push(text);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** EPG réduit : chaînes retenues, de maintenant (moins 30 min) à +24 h. Toutes les sources en échec : exception. */
export async function buildEpgStreaming(wanted: ReadonlySet<string>, options: TvBuildOptions = {}): Promise<EpgSnapshot> {
  const fetcher = guardedFetch(options.fetch ?? fetch, 'tv-build');
  const nowMs = (options.now ?? Date.now)();
  const now = Math.floor(nowMs / 1000);
  const from = now - EPG_BEHIND_SECONDS;
  const to = now + EPG_AHEAD_SECONDS;
  const store = new Map<string, Programme[]>();
  // Reprise : on repart des programmes du passage précédent, dans la fenêtre courante. Une chaîne déjà présente n'est
  // pas remplacée par une source relue : la priorité exacte revient à la passe complète suivante.
  for (const [id, list] of Object.entries(options.epgSeed?.programmes ?? {})) {
    const kept = list.filter((programme) => programme.stop >= from && programme.start <= to);
    if (kept.length > 0) store.set(id, kept);
  }
  const stats = new Map<string, EpgSnapshot['epgStats'][number]>();
  for (const stat of options.epgSeed?.epgStats ?? []) stats.set(stat.url, stat);
  let okCount = 0;
  for (const url of options.epgOnly ?? TV_EPG_URLS) {
    const label = url.replace(/^https:\/\//, '');
    const ingest = new XmltvIngest(store, from, to, wanted);
    try {
      await timedSource(options.trace, epgSourceId(url), () => ingestEpgSource(fetcher, url, ingest));
      okCount += 1;
      stats.set(label, { url: label, programmes: ingest.count, ok: true });
    } catch {
      stats.set(label, { url: label, programmes: ingest.count, ok: false });
    }
  }
  if (okCount === 0) throw new Error('tv_unavailable');
  const labels = new Set(TV_EPG_URLS.map((url) => url.replace(/^https:\/\//, '')));
  const epgStats = [...stats.values()].filter((stat) => labels.has(stat.url));
  const programmes: Record<string, Programme[]> = {};
  for (const [id, list] of store) programmes[id] = list.sort((a, b) => a.start - b.start);
  return { v: 1, builtAt: nowMs, epgStats, programmes };
}

/** Réponse à une requête d'une page web : le flux répond-il avec CORS pour cette origine ? Inconnu (undefined) si injoignable. */
async function probeDirect(fetcher: typeof fetch, url: string, origin: string): Promise<boolean | undefined> {
  if (!url.startsWith('https://')) return false; // http : bloqué comme contenu mixte sur une page https
  try {
    const res = await fetcher(url, { headers: { ...HEADERS, origin }, redirect: 'follow', signal: AbortSignal.timeout(6000) });
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 400) return undefined;
    const allow = res.headers.get('access-control-allow-origin');
    return allow === '*' || allow === origin;
  } catch {
    return undefined;
  }
}

/**
 * Renseigne `direct` sur chaque flux : http → false ; https sondé → résultat du sondage ; sinon inconnu (absent).
 * Les sondages récents de `previous` sont réutilisés ; les nouveaux sont ajoutés à `results`.
 */
/** Bilan d'un passage de sondages : sondes faites, sondages restants faute de budget (reprise à la passe suivante). */
export interface DirectRun {
  snapshot: ProbeSnapshot;
  probed: number;
  pending: number;
}

export async function applyDirect(catalog: TvCatalog, previous: ProbeSnapshot | undefined, options: TvBuildOptions): Promise<ProbeSnapshot> {
  return (await probeDirectStreams(catalog, previous, options)).snapshot;
}

/** Sondages de `applyDirect`, avec leur bilan. */
export async function probeDirectStreams(catalog: TvCatalog, previous: ProbeSnapshot | undefined, options: TvBuildOptions): Promise<DirectRun> {
  const fetcher = guardedFetch(options.fetch ?? fetch, 'tv-build');
  const nowSec = Math.floor((options.now ?? Date.now)() / 1000);
  const ttl = options.probeTtlSec ?? 24 * 3600;
  const results: ProbeSnapshot['results'] = {};
  for (const [url, entry] of Object.entries(previous?.results ?? {})) if (nowSec - entry[1] < ttl) results[url] = entry;

  const urls = new Set<string>();
  for (const channel of catalog.channels) {
    // Flux principal et deux premiers de repli : les suivants servent rarement.
    urls.add(channel.url);
    for (const alt of channel.alternatives.slice(0, 2)) urls.add(alt.url);
  }
  // Échecs de sondage (LAST-137) : url → date de la dernière tentative. Ils ne vont pas dans `results` (inconnu ≠ non).
  const attempts = new Map<string, number>();
  for (const [url, at] of Object.entries(previous?.failed ?? {})) if (urls.has(url) && results[url] === undefined) attempts.set(url, at);
  let probed = 0;
  let pending = 0;
  if (options.probe === true) {
    const all = [...urls].filter((url) => url.startsWith('https://') && results[url] === undefined);
    // Les URL jamais sondées passent avant les échecs, et ceux-ci du plus anciennement tentés au plus récent : un flux
    // en échec en tête de liste ne doit pas occuper le budget à chaque passe et priver le reste du catalogue de sondes.
    const untried = all.filter((url) => !attempts.has(url));
    const retry = all.filter((url) => attempts.has(url)).sort((a, b) => (attempts.get(a) ?? 0) - (attempts.get(b) ?? 0));
    const todo = [...untried, ...retry].slice(0, options.maxProbes ?? 800);
    const origin = options.probeOrigin ?? 'https://app.laststream.app';
    const deadline = Date.now() + (options.probeBudgetMs ?? 5 * 60_000);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length && Date.now() < deadline) {
        const url = todo[next++];
        if (url === undefined) break;
        const direct = await probeDirect(fetcher, url, origin);
        if (direct === undefined) {
          attempts.set(url, nowSec);
        } else {
          results[url] = [direct ? 1 : 0, nowSec];
          attempts.delete(url);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    probed = Math.min(next, todo.length);
    // Seules les URL jamais tentées restent dues : les échecs ne sont retentés qu'à la passe complète.
    pending = Math.max(0, untried.length - probed);
  }
  const known = (url: string): boolean | undefined => {
    if (!url.startsWith('https://')) return false;
    const entry = results[url];
    return entry === undefined ? undefined : entry[0] === 1;
  };
  for (const channel of catalog.channels) tagDirect(channel, known);
  const failed = Object.fromEntries(attempts);
  return { snapshot: attempts.size > 0 ? { v: 1, results, failed } : { v: 1, results }, probed, pending };
}

function tagDirect(channel: TvChannel, known: (url: string) => boolean | undefined): void {
  const main = known(channel.url);
  if (main !== undefined) channel.direct = main;
  for (const alt of channel.alternatives) {
    const value = known(alt.url);
    if (value !== undefined) alt.direct = value;
  }
}

const parse = <T extends { v: number }>(text: string | undefined): T | undefined => {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as T;
    return value.v === 1 ? value : undefined;
  } catch {
    return undefined;
  }
};

export interface RefreshResult {
  channels: number;
  programmes: number;
  epgOk: boolean;
  /** Chaînes retirées du catalogue par le test de santé des flux. */
  removed?: number;
}

/**
 * Cycle complet du Cron : catalogue, sondage, EPG, puis écriture dans le stockage. Une erreur de l'EPG laisse l'ancien
 * EPG en place (les chaînes restent servies) ; une erreur de catalogue laisse l'ancien catalogue.
 */
export async function refreshTv(store: TvBlobStore, options: TvBuildOptions = {}): Promise<RefreshResult> {
  const plan = options.plan ?? fullPlan(options.probe === true);
  const cached = parse<CatalogSnapshot>(await store.get(TV_KEYS.catalog));
  // Reprise sans échec de catalogue : le catalogue déjà écrit sert, il n'est pas reconstruit.
  const reused = cached !== undefined && !plan.catalog;
  const catalog = cached !== undefined && reused ? cached.catalog : await buildCatalogStreaming(options);
  const previous = parse<ProbeSnapshot>(await store.get(TV_KEYS.probe));
  const direct = await probeDirectStreams(catalog, previous, { ...options, probe: plan.probes });
  const probes = direct.snapshot;
  const health = await applyHealth(catalog, previous?.health, { ...options.health, fetch: options.fetch, now: options.now, check: plan.health });
  // Trace des sondes seulement quand ce passage sondait (absent sinon, voir TvPassTrace.probes).
  if (options.trace !== undefined && plan.probes) {
    options.trace.probes = direct.probed;
    options.trace.probesPending = direct.pending > 0;
  }
  probes.health = health.health;
  console.log(`[tv] santé des flux : ${health.checked} contrôlés, ${health.dead} flux écartés, ${health.removed} chaînes retirées${health.tripped ? ' (disjoncteur : pannes de ce passage ignorées)' : ''}`);
  const builtAt = (options.now ?? Date.now)();
  const snapshot: CatalogSnapshot = cached !== undefined && reused ? { ...cached, catalog } : { v: 1, builtAt, catalog };
  await store.put(TV_KEYS.catalog, JSON.stringify(snapshot));
  await store.put(TV_KEYS.probe, JSON.stringify(probes));
  // EPG : en reprise, seules les sources en échec sont relues, sur le snapshot précédent. Sans source EPG à relire,
  // le snapshot précédent reste servi tel quel.
  const previousEpg = plan.kind === 'resume' || plan.epg.length === 0 ? parse<EpgSnapshot>(await store.get(TV_KEYS.epg)) : undefined;
  let programmes = 0;
  let epgOk = false;
  if (plan.epg.length === 0) {
    epgOk = previousEpg !== undefined;
    programmes = previousEpg === undefined ? 0 : Object.values(previousEpg.programmes).reduce((sum, list) => sum + list.length, 0);
  } else {
    try {
      const epg = await buildEpgStreaming(epgIdsOf(catalog), { ...options, epgOnly: plan.epg, epgSeed: plan.kind === 'resume' ? previousEpg : undefined });
      programmes = Object.values(epg.programmes).reduce((sum, list) => sum + list.length, 0);
      await store.put(TV_KEYS.epg, JSON.stringify(epg));
      epgOk = true;
    } catch {
      // ancien EPG conservé
    }
  }
  return { channels: catalog.channels.length, programmes, epgOk, removed: health.removed };
}

export { parse as parseSnapshot };
