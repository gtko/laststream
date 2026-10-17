import { gunzipSync } from 'node:zlib';
import { isRecord } from '../sources/http.js';
import { LtError, ltDownload, ltRequest, recordAt, type LtContext, TTL } from './context.js';
import { parseSafeUrl } from './guard.js';
import {
  buildCatalog,
  CATEGORY_BY_ID,
  normName,
  SOURCE_IDS,
  selectChannels,
  tvgEpgId,
  type FastEntry,
  type IptvOrgRaw,
  type M3uEntry,
  type TvCatalog,
  type TvChannel,
  type TvFacets,
  type TvQuery,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from './tv-catalog.js';

/**
 * TV en direct, sources légales uniquement : chaînes gratuites Free-TV (playlist maîtresse), catalogue iptv-org
 * (API JSON : chaînes, flux, feeds, logos, pays, langues, liste de blocage), chaînes FAST (Pluto TV, Samsung TV Plus
 * via i.mjh.nz) et playlist de l'utilisateur (importée à la demande, jamais stockée).
 */
const IPTV_API = 'https://iptv-org.github.io/api/';
/** Fichiers iptv-org lus (une requête chacun). */
const IPTV_FILES = ['channels', 'streams', 'feeds', 'logos', 'countries', 'languages', 'blocklist'] as const;

const TV_SOURCES = {
  freetv: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
  pluto: 'https://i.mjh.nz/PlutoTV/.channels.json',
  samsung: 'https://i.mjh.nz/SamsungTVPlus/.channels.json',
  epg: [
    'https://xmltvfr.fr/xmltv/xmltv_tnt.xml.gz',
    'https://iptv-epg.org/files/epg-fr.xml.gz',
    'https://i.mjh.nz/PlutoTV/fr.xml.gz',
    'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz',
  ],
} as const;

const TV_HEADERS = { 'user-agent': 'Mozilla/5.0 Laststream', accept: '*/*' };
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_IPTVORG_BYTES = 32 * 1024 * 1024;
const MAX_EPG_BYTES = 32 * 1024 * 1024;
const MAX_EPG_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 6 * 1024 * 1024;
const MAX_HLS_BYTES = 2 * 1024 * 1024;

interface Programme {
  start: number;
  stop: number;
  title: string;
  desc: string;
  icon: string;
  category: string;
}

export interface TvStats {
  counts: Record<string, number>;
  reliability: Record<string, number>;
  total: number;
  epgCoverage: number;
  epgStats: { url: string; programmes: number; ok: boolean }[];
}

/** Programmes EPG (cache 3 h) et état de chaque source. */
interface TvEpgData {
  epg: Map<string, Programme[]>;
  epgStats: TvStats['epgStats'];
}

/** EPG indisponible : les chaînes restent servies, sans programmes. */
const NO_EPG: TvEpgData = { epg: new Map(), epgStats: [] };

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export function parseM3U(text: string): M3uEntry[] {
  const out: M3uEntry[] = [];
  let current: { attrs: Record<string, string>; name: string } | null = null;
  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs: Record<string, string> = {};
      line.replace(/([\w-]+)="([^"]*)"/g, (_match, key: string, value: string) => {
        attrs[key.toLowerCase()] = value;
        return '';
      });
      current = { attrs, name: line.slice(line.lastIndexOf(',') + 1).trim() };
    } else if (line.startsWith('#')) {
      continue;
    } else if (current !== null) {
      out.push({ ...current, url: line });
      current = null;
    }
  }
  return out;
}

/** Chaînes FAST (format i.mjh.nz, région française). `slug` contient {id} pour l'URL de lecture. */
function fromMjh(json: unknown, source: 'pluto' | 'samsung', prefix: string, slug: string): FastEntry[] {
  const channels = recordAt(json, 'regions', 'fr', 'channels');
  return Object.keys(channels).map((id) => {
    const info = recordAt(channels, id);
    return {
      key: prefix + ':' + id,
      epgId: id,
      name: typeof info.name === 'string' && info.name !== '' ? info.name : id,
      logo: typeof info.logo === 'string' ? info.logo : '',
      group: typeof info.group === 'string' && info.group !== '' ? info.group : 'FAST',
      source,
      url: slug.replace('{id}', id),
      country: 'FR',
      languages: ['fra'],
    };
  });
}

/** Décodage des entités XML et des sections CDATA. */
const xmlDecode = (value: string | undefined): string =>
  String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

/** Horodatage XMLTV (AAAAMMJJHHMMSS +HHMM) en secondes Unix ; 0 si invalide. */
function xmltvTime(value: string | undefined): number {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/.exec(String(value ?? ''));
  if (!match) return 0;
  const tz = match[7] ? match[7].slice(0, 3) + ':' + match[7].slice(3) : 'Z';
  const time = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${tz}`);
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

/** Ajoute les programmes de la fenêtre [lo, hi] au magasin. Une source antérieure fait foi pour une chaîne. */
function ingestXmltv(xml: string, store: Map<string, Programme[]>, lo: number, hi: number): number {
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  const seenHere = new Set<string>();
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    (match[1] ?? '').replace(/([\w:-]+)="([^"]*)"/g, (_m, key: string, value: string) => {
      attrs[key] = value;
      return '';
    });
    const start = xmltvTime(attrs.start);
    const stop = xmltvTime(attrs.stop);
    if (!attrs.channel || !start || !stop || stop < lo || start > hi) continue;
    const body = match[2] ?? '';
    const pick = (tag: string): string => {
      const found = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(body);
      return found ? xmlDecode(found[1]) : '';
    };
    const icon = /<icon\b[^>]*src="([^"]*)"/.exec(body);
    const channel = xmlDecode(attrs.channel);
    if (store.has(channel) && !seenHere.has(channel)) continue;
    seenHere.add(channel);
    const list = store.get(channel) ?? [];
    list.push({
      start,
      stop,
      title: pick('title'),
      desc: pick('desc'),
      icon: icon ? xmlDecode(icon[1]) : '',
      category: pick('category'),
    });
    store.set(channel, list);
    count++;
  }
  return count;
}

/** Télécharge une source TV (plafond de taille, délai). */
function tvGet(ctx: LtContext, url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  return ltDownload(ctx, url, { headers: TV_HEADERS }, timeoutMs, { maxBytes });
}

function parseJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Catalogue TV : toutes les sources en parallèle. Une source en échec est absente (catalogue partiel, gardé moins
 * longtemps). Si Free-TV, iptv-org et les deux FAST échouent tous : 502, rien n'est mis en cache.
 */
async function buildCatalogFromSources(ctx: LtContext): Promise<TvCatalog> {
  const [freetv, pluto, samsung, ...iptv] = await Promise.allSettled([
    tvGet(ctx, TV_SOURCES.freetv, 60000, MAX_SOURCE_BYTES),
    tvGet(ctx, TV_SOURCES.pluto, 60000, MAX_SOURCE_BYTES),
    tvGet(ctx, TV_SOURCES.samsung, 60000, MAX_SOURCE_BYTES),
    ...IPTV_FILES.map((file) => tvGet(ctx, `${IPTV_API}${file}.json`, 120000, MAX_IPTVORG_BYTES)),
  ]);
  const json = (result: PromiseSettledResult<Buffer>): unknown => (result.status === 'fulfilled' ? parseJson(result.value) : undefined);
  const iptvJson = new Map(IPTV_FILES.map((file, i) => [file, json(iptv[i])]));
  const iptvRaw: IptvOrgRaw | null =
    Array.isArray(iptvJson.get('channels')) && Array.isArray(iptvJson.get('streams'))
      ? {
          channels: iptvJson.get('channels'),
          streams: iptvJson.get('streams'),
          feeds: iptvJson.get('feeds'),
          logos: iptvJson.get('logos'),
          countries: iptvJson.get('countries'),
          languages: iptvJson.get('languages'),
          blocklist: iptvJson.get('blocklist'),
        }
      : null;
  const freetvEntries = freetv.status === 'fulfilled' ? parseM3U(freetv.value.toString('utf8')) : null;
  const plutoJson = json(pluto);
  const samsungJson = json(samsung);
  const fast: FastEntry[] = [
    ...(plutoJson === undefined ? [] : fromMjh(plutoJson, 'pluto', 'plu', 'https://jmp2.uk/plu-{id}.m3u8')),
    ...(samsungJson === undefined ? [] : fromMjh(samsungJson, 'samsung', 'stv', 'https://jmp2.uk/stvp-{id}')),
  ];
  const plutoOk = plutoJson !== undefined;
  const samsungOk = samsungJson !== undefined;
  if (freetvEntries === null && iptvRaw === null && !plutoOk && !samsungOk) throw new LtError(502, 'tv_unavailable');
  return buildCatalog({
    freetv: freetvEntries,
    iptv: iptvRaw,
    fast,
    partial: freetvEntries === null || iptvRaw === null || !plutoOk || !samsungOk,
  });
}

function loadCatalog(ctx: LtContext): Promise<TvCatalog> {
  return ctx.state.cache.get(
    'tv:catalog',
    (catalog: TvCatalog) => (catalog.partial ? TTL.tvPartial : TTL.tvChannels),
    () => buildCatalogFromSources(ctx),
  );
}

/** EPG : en cas d'échec, les chaînes restent disponibles sans programmes. */
function loadEpg(ctx: LtContext): Promise<TvEpgData> {
  return ctx.state.cache.get('tv:epg', TTL.tvEpg, () => buildEpg(ctx)).catch(() => NO_EPG);
}

/**
 * Programmes EPG (fenêtre -6 h / +30 h, une source par chaîne). Si toutes les sources échouent, rien n'est mis en
 * cache (erreur non mémorisée).
 */
async function buildEpg(ctx: LtContext): Promise<TvEpgData> {
  const now = Math.floor(Date.now() / 1000);
  const epg = new Map<string, Programme[]>();
  const epgStats: TvStats['epgStats'] = [];
  for (const url of TV_SOURCES.epg) {
    const label = url.replace(/^https:\/\//, '');
    try {
      const raw = await tvGet(ctx, url, 90000, MAX_EPG_BYTES);
      const xml = /\.gz$/i.test(url) ? gunzipSync(raw, { maxOutputLength: MAX_EPG_OUTPUT_BYTES }) : raw;
      const programmes = ingestXmltv(xml.toString('utf8'), epg, now - 6 * 3600, now + 30 * 3600);
      epgStats.push({ url: label, programmes, ok: true });
    } catch {
      epgStats.push({ url: label, programmes: 0, ok: false });
    }
  }
  if (epgStats.every((source) => !source.ok)) throw new LtError(502, 'tv_unavailable');
  for (const list of epg.values()) list.sort((a, b) => a.start - b.start);
  return { epg, epgStats };
}

/** Chaînes filtrées et paginées (catalogue en cache 12 h ; filtres et page calculés à chaque requête). */
export async function tvChannels(ctx: LtContext, query: TvQuery): Promise<{ total: number; items: TvChannel[] }> {
  return selectChannels(await loadCatalog(ctx), query);
}

/** Compteurs par pays, langue, catégorie et source (filtres de l'interface). */
export async function tvFacets(ctx: LtContext): Promise<TvFacets> {
  return (await loadCatalog(ctx)).facets;
}

export async function tvStats(ctx: LtContext): Promise<TvStats> {
  const [catalog, epg] = await Promise.all([loadCatalog(ctx), loadEpg(ctx)]);
  const withEpg = catalog.channels.filter((c) => c.epgId !== '' && epg.epg.has(c.epgId)).length;
  return {
    counts: { ...catalog.counts },
    reliability: { ...catalog.reliability },
    total: catalog.channels.length,
    epgCoverage: catalog.channels.length ? Math.round((withEpg / catalog.channels.length) * 100) : 0,
    epgStats: epg.epgStats,
  };
}

/** Valide les paramètres de /tv/channels. Toute valeur hors format : 400 bad_request. */
export function parseTvQuery(raw: Record<string, string>): TvQuery {
  const bad = (): never => {
    throw new LtError(400, 'bad_request');
  };
  const query: TvQuery = {};
  const country = (raw.country ?? '').trim();
  if (country !== '') {
    if (!/^[a-z]{2}$/i.test(country)) bad();
    query.country = country.toUpperCase();
  }
  const language = (raw.language ?? '').trim().toLowerCase();
  if (language !== '') {
    if (!/^[a-z]{3}$/.test(language)) bad();
    query.language = language;
  }
  const category = (raw.category ?? '').trim();
  if (category !== '') {
    if (!CATEGORY_BY_ID.has(category)) bad();
    query.category = category;
  }
  const source = (raw.source ?? '').trim();
  if (source !== '') {
    if (!(SOURCE_IDS as readonly string[]).includes(source)) bad();
    query.source = source;
  }
  const q = (raw.q ?? '').trim();
  if (q !== '') query.q = q.slice(0, 100);
  if (raw.page !== undefined) {
    const page = Number(raw.page);
    if (!Number.isInteger(page) || page < 1 || page > 100000) bad();
    query.page = page;
  }
  if (raw.limit !== undefined) {
    const limit = Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) bad();
    query.limit = limit;
  }
  if (query.page !== undefined && query.limit === undefined) query.limit = DEFAULT_LIMIT;
  return query;
}

/** Programmes des chaînes demandées (`ids`, jusqu'à 60) sur une fenêtre de 8 h au plus. */
export async function tvEpg(ctx: LtContext, query: Record<string, string>): Promise<unknown[]> {
  const [catalog, epg] = await Promise.all([loadCatalog(ctx), loadEpg(ctx)]);
  const now = Math.floor(Date.now() / 1000);
  const toSec = (value: string | undefined, fallback: number): number => {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (Number.isFinite(n)) return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.floor(time / 1000) : fallback;
  };
  const from = toSec(query.from, now - 3600);
  const to = Math.min(toSec(query.to, from + 6 * 3600), from + 8 * 3600);
  const ids = (query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60);
  const epgIdOf = new Map(catalog.channels.map((c) => [c.id, c.epgId]));
  const out: unknown[] = [];
  for (const id of ids) {
    // Accepte un id de chaîne ou un id EPG (playlists utilisateur).
    const epgId = epgIdOf.get(id) ?? id;
    const list = epg.epg.get(epgId);
    if (list === undefined) continue;
    for (const p of list) {
      if (p.stop <= from || p.start >= to) continue;
      out.push({ channelId: id, start: p.start, stop: p.stop, title: p.title, desc: p.desc, icon: p.icon, category: p.category });
    }
  }
  return out;
}

/** Chaîne d'une playlist utilisateur : aucune métadonnée de catalogue, qualité ni flux de repli. */
const userChannel = (entry: Pick<TvChannel, 'id' | 'name' | 'logo' | 'group' | 'url' | 'epgId'>): TvChannel => ({
  ...entry,
  cat: 'Ma playlist',
  source: 'user',
  fast: false,
  flaky: false,
  country: '',
  countryName: '',
  languages: [],
  categories: [],
  quality: '',
  reliability: 'high',
  alternatives: [],
});

/** Import d'une playlist M3U (URL) ou d'un compte Xtream. Rien n'est stocké. */
export async function tvImport(ctx: LtContext, body: Record<string, unknown>): Promise<{ channels: TvChannel[]; count: number }> {
  let list: TvChannel[];
  if (body.type === 'm3u') {
    const url = parseSafeUrl(typeof body.url === 'string' ? body.url : null);
    if (url === null) throw new LtError(400, 'bad_url');
    const buffer = await ltDownload(ctx, url.toString(), { headers: TV_HEADERS }, 30000, {
      maxBytes: MAX_PLAYLIST_BYTES,
      guard: ctx.guard,
    });
    list = parseM3U(buffer.toString('utf8'))
      .filter((entry) => parseSafeUrl(entry.url) !== null)
      .slice(0, 3000)
      .map((entry, i) =>
        userChannel({
          id: 'usr:' + i + ':' + normName(entry.name).slice(0, 24),
          name: entry.name.replace(/\s+/g, ' ').trim(),
          logo: entry.attrs['tvg-logo'] ?? '',
          group: entry.attrs['group-title'] || 'Ma playlist',
          url: entry.url,
          epgId: tvgEpgId(entry.attrs['tvg-id']),
        }),
      );
  } else if (body.type === 'xtream') {
    let server = typeof body.server === 'string' ? body.server.trim() : '';
    if (server !== '' && !/^https?:\/\//i.test(server)) server = 'http://' + server;
    const serverUrl = parseSafeUrl(server);
    const user = typeof body.username === 'string' ? body.username : '';
    const pass = typeof body.password === 'string' ? body.password : '';
    if (serverUrl === null || user === '' || pass === '') throw new LtError(400, 'bad_request');
    const base = serverUrl.origin + serverUrl.pathname.replace(/\/+$/, '');
    const api = (action: string): string =>
      `${base}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=${action}`;
    const opts = { maxBytes: MAX_PLAYLIST_BYTES, guard: ctx.guard };
    const headers = { headers: TV_HEADERS };
    const [cats, streams] = await Promise.all([
      ltDownload(ctx, api('get_live_categories'), headers, 30000, opts),
      ltDownload(ctx, api('get_live_streams'), headers, 45000, opts),
    ]);
    let categoriesJson: unknown;
    let streamsJson: unknown;
    try {
      categoriesJson = JSON.parse(cats.toString('utf8')) as unknown;
      streamsJson = JSON.parse(streams.toString('utf8')) as unknown;
    } catch {
      throw new LtError(502, 'bad_playlist');
    }
    if (!Array.isArray(streamsJson)) throw new LtError(401, 'xtream_refused');
    const names = new Map(
      (Array.isArray(categoriesJson) ? categoriesJson.filter(isRecord) : []).map((c): [string, string] => [
        String(c.category_id),
        String(c.category_name ?? ''),
      ]),
    );
    list = streamsJson
      .filter(isRecord)
      .slice(0, 3000)
      .map((s) => {
        const streamId = String(s.stream_id ?? '');
        return userChannel({
          id: 'usr:' + streamId,
          name: String(s.name || streamId).trim(),
          logo: typeof s.stream_icon === 'string' ? s.stream_icon : '',
          group: names.get(String(s.category_id)) || 'Ma playlist',
          url: `${base}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(streamId)}.m3u8`,
          epgId: typeof s.epg_channel_id === 'string' ? s.epg_channel_id : '',
        });
      });
  } else {
    throw new LtError(400, 'bad_request');
  }
  return { channels: list, count: list.length };
}

/**
 * Signature d'une URL de flux pour une configuration (`sig` des chaînes et de l'import). Null si l'URL n'est pas
 * publique. La clé de signature ne quitte jamais le serveur.
 */
export function signTvUrl(ctx: LtContext, scope: string, rawUrl: string): string | null {
  const url = parseSafeUrl(rawUrl);
  return url === null ? null : ctx.signer.sign(scope, url.toString());
}

/** Chemin du proxy HLS pour une URL absolue, avec sa signature pour la configuration `scope`. */
function hlsProxyPath(ctx: LtContext, scope: string, absolute: string): string {
  return `/${scope}/lt/tv/hls?u=${encodeURIComponent(absolute)}&s=${ctx.signer.sign(scope, absolute)}`;
}

/**
 * Réécrit une playlist HLS : sous-playlists et médias passent par le proxy signé ; les segments et clés restent des
 * URL directes (le proxy ne relaie que des playlists).
 */
function hlsRewrite(ctx: LtContext, scope: string, text: string, baseUrl: string): string {
  const abs = (value: string): string | null => {
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return null;
    }
  };
  const viaProxy = (value: string): string => {
    const absolute = abs(value);
    return absolute === null ? value : hlsProxyPath(ctx, scope, absolute);
  };
  const isPlaylist = (value: string): boolean => /\.m3u8?(\?|#|$)/i.test(value);
  let nextIsVariant = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (/^#EXT-X-STREAM-INF/.test(trimmed)) nextIsVariant = true;
        return line.replace(/URI="([^"]*)"/g, (whole: string, uri: string) => {
          const absolute = abs(uri);
          if (absolute === null) return whole;
          if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/.test(trimmed) && isPlaylist(uri)) return 'URI="' + viaProxy(uri) + '"';
          return 'URI="' + absolute + '"';
        });
      }
      if (nextIsVariant || isPlaylist(trimmed)) {
        nextIsVariant = false;
        return viaProxy(trimmed);
      }
      return abs(trimmed) ?? line;
    })
    .join('\n');
}

/**
 * Proxy HLS. Seule une URL signée pour cette configuration est acceptée (403 sinon) : l'autorisation tient à la
 * signature, pas à une liste d'hôtes. L'hôte est résolu et contrôlé à la connexion, à chaque saut.
 * Renvoie le texte réécrit ; les erreurs sont des LtError.
 */
export async function tvHls(ctx: LtContext, scope: string, rawUrl: string | null, sig: string | null): Promise<string> {
  const url = parseSafeUrl(rawUrl);
  if (url === null) throw new LtError(400, 'bad_url');
  if (!ctx.signer.verify(scope, url.toString(), sig)) throw new LtError(403, 'invalid_signature');
  const res = await ltRequest(ctx, url.toString(), { headers: TV_HEADERS }, 15000, {
    maxBytes: MAX_HLS_BYTES,
    guard: ctx.guard,
  });
  if (!res.ok) throw new LtError(502, `upstream_${res.status}`);
  const text = stripBom(new TextDecoder('utf-8').decode(res.bytes));
  if (!/^\s*#EXTM3U/.test(text)) throw new LtError(415, 'not_a_playlist');
  return hlsRewrite(ctx, scope, text, res.url);
}
