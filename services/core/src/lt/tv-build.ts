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

/**
 * Construction du catalogue TV et de l'EPG sur Cloudflare Workers (Cron Trigger), en flux : aucune source n'est lue en
 * entier en mémoire (128 Mo par isolat). Les fichiers iptv-org (jusqu'à 32 Mo de JSON) sont parcourus élément par
 * élément et filtrés aux pays retenus ; l'EPG XMLTV (jusqu'à 256 Mo décompressé) est décompressé en flux et filtré aux
 * chaînes retenues, fenêtre maintenant → +24 h. Le résultat tient dans R2 (voir TvBlobStore).
 */

export const TV_SOURCES = {
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
  const fetcher = options.fetch ?? fetch;
  const countries = new Set((options.countries ?? DEFAULT_TV_COUNTRIES).map((code) => code.toUpperCase()));
  const [iptv, freetv, pluto, samsung] = await Promise.allSettled([
    loadIptvOrg(fetcher, countries),
    loadFreeTv(fetcher, countries),
    loadFast(fetcher, TV_SOURCES.pluto, 'pluto', 'plu', 'https://jmp2.uk/plu-{id}.m3u8'),
    loadFast(fetcher, TV_SOURCES.samsung, 'samsung', 'stv', 'https://jmp2.uk/stvp-{id}'),
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
  const fetcher = options.fetch ?? fetch;
  const nowMs = (options.now ?? Date.now)();
  const now = Math.floor(nowMs / 1000);
  const store = new Map<string, Programme[]>();
  const epgStats: EpgSnapshot['epgStats'] = [];
  for (const url of TV_SOURCES.epg) {
    const label = url.replace(/^https:\/\//, '');
    const ingest = new XmltvIngest(store, now - EPG_BEHIND_SECONDS, now + EPG_AHEAD_SECONDS, wanted);
    try {
      await ingestEpgSource(fetcher, url, ingest);
      epgStats.push({ url: label, programmes: ingest.count, ok: true });
    } catch {
      epgStats.push({ url: label, programmes: ingest.count, ok: false });
    }
  }
  if (epgStats.every((source) => !source.ok)) throw new Error('tv_unavailable');
  const programmes: Record<string, Programme[]> = {};
  for (const [id, list] of store) programmes[id] = list.sort((a, b) => a.start - b.start);
  return { v: 1, builtAt: nowMs, epgStats, programmes };
}

/** Réponse à une requête d'une page web : le flux répond-il avec CORS pour cette origine ? Inconnu (undefined) si injoignable. */
export async function probeDirect(fetcher: typeof fetch, url: string, origin: string): Promise<boolean | undefined> {
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
export async function applyDirect(
  catalog: TvCatalog,
  previous: ProbeSnapshot | undefined,
  options: TvBuildOptions,
): Promise<ProbeSnapshot> {
  const fetcher = options.fetch ?? fetch;
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
  if (options.probe === true) {
    const todo = [...urls].filter((url) => url.startsWith('https://') && results[url] === undefined).slice(0, options.maxProbes ?? 800);
    const origin = options.probeOrigin ?? 'https://laststream.gtux-prog.workers.dev';
    const deadline = Date.now() + (options.probeBudgetMs ?? 5 * 60_000);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length && Date.now() < deadline) {
        const url = todo[next++];
        if (url === undefined) break;
        const direct = await probeDirect(fetcher, url, origin);
        if (direct !== undefined) results[url] = [direct ? 1 : 0, nowSec];
      }
    };
    await Promise.all(Array.from({ length: 8 }, () => worker()));
  }
  const known = (url: string): boolean | undefined => {
    if (!url.startsWith('https://')) return false;
    const entry = results[url];
    return entry === undefined ? undefined : entry[0] === 1;
  };
  for (const channel of catalog.channels) tagDirect(channel, known);
  return { v: 1, results };
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
}

/**
 * Cycle complet du Cron : catalogue, sondage, EPG, puis écriture dans le stockage. Une erreur de l'EPG laisse l'ancien
 * EPG en place (les chaînes restent servies) ; une erreur de catalogue laisse l'ancien catalogue.
 */
export async function refreshTv(store: TvBlobStore, options: TvBuildOptions = {}): Promise<RefreshResult> {
  const catalog = await buildCatalogStreaming(options);
  const previous = parse<ProbeSnapshot>(await store.get(TV_KEYS.probe));
  const probes = await applyDirect(catalog, previous, options);
  const builtAt = (options.now ?? Date.now)();
  const snapshot: CatalogSnapshot = { v: 1, builtAt, catalog };
  await store.put(TV_KEYS.catalog, JSON.stringify(snapshot));
  await store.put(TV_KEYS.probe, JSON.stringify(probes));
  let programmes = 0;
  let epgOk = false;
  try {
    const epg = await buildEpgStreaming(epgIdsOf(catalog), options);
    programmes = Object.values(epg.programmes).reduce((sum, list) => sum + list.length, 0);
    await store.put(TV_KEYS.epg, JSON.stringify(epg));
    epgOk = true;
  } catch {
    // ancien EPG conservé
  }
  return { channels: catalog.channels.length, programmes, epgOk };
}

export { parse as parseSnapshot };
