import { gunzipSync } from 'node:zlib';
import { isRecord } from '../sources/http.js';
import { LtError, ltDownload, ltRequest, recordAt, type LtContext, TTL } from './context.js';
import { parseSafeUrl } from './guard.js';

/**
 * TV en direct, sources légales uniquement : chaînes gratuites FR (iptv-org), chaînes FAST (Pluto TV,
 * Samsung TV Plus via i.mjh.nz) et playlist de l'utilisateur (importée à la demande, jamais stockée).
 */
const TV_SOURCES = {
  m3u: 'https://iptv-org.github.io/iptv/countries/fr.m3u',
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
const MAX_EPG_BYTES = 32 * 1024 * 1024;
const MAX_EPG_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 6 * 1024 * 1024;
const MAX_HLS_BYTES = 2 * 1024 * 1024;
const MAX_HLS_HOSTS = 5000;
const FLAKY_LABEL = 'iptv-org (peut ne pas fonctionner)';

export interface TvChannel {
  id: string;
  name: string;
  logo: string;
  group: string;
  cat: string;
  source: string;
  fast: boolean;
  url: string;
  epgId: string;
  flaky: boolean;
}

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
  total: number;
  epgCoverage: number;
  epgStats: { url: string; programmes: number; ok: boolean }[];
}

interface TvData {
  channels: TvChannel[];
  epg: Map<string, Programme[]>;
  stats: TvStats;
}

interface M3uEntry {
  attrs: Record<string, string>;
  name: string;
  url: string;
}

const stripAccents = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '');

const normName = (name: string): string =>
  stripAccents(name.toLowerCase())
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\bhd\b|\bfhd\b|\buhd\b|\b4k\b/g, ' ')
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]/g, '');

/** Catégorie affichée à partir du groupe de la playlist. */
function tvCategory(group: string): string {
  const g = stripAccents(group.toLowerCase());
  if (/sport/.test(g)) return 'Sport';
  if (/news|actualit|info/.test(g)) return 'Info';
  if (/kids|jeunesse|animation|anime|enfant|famil/.test(g)) return 'Jeunesse';
  if (/music|musique/.test(g)) return 'Musique';
  if (/document|voyage|nature|science|culture|education|outdoor|cuisine|gastronomie/.test(g)) return 'Documentaires';
  if (/movie|cinema|film|serie|crime|mystere|binge|policier/.test(g)) return 'Cinéma';
  return 'Divertissement';
}

/** Hôte d'une URL, ou undefined si elle n'est pas valide. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function parseM3U(text: string): M3uEntry[] {
  const out: M3uEntry[] = [];
  let current: { attrs: Record<string, string>; name: string } | null = null;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
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

const tvgToEpg = (id: string | undefined): string => String(id ?? '').replace(/@.*$/, '');

/** Playlist iptv-org : chaînes adultes exclues, URL non publique exclue. */
function fromIptvOrg(text: string): TvChannel[] {
  const list: TvChannel[] = [];
  for (const entry of parseM3U(text)) {
    const group = entry.attrs['group-title'] ?? '';
    if (/xxx|adult/i.test(group) || /xxx|adult/i.test(entry.name)) continue;
    if (parseSafeUrl(entry.url) === null) continue;
    const flaky = /\[(geo-blocked|not 24\/7)\]/i.test(entry.name);
    const name = entry.name
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\s*\((\d{3,4}p|\d+k)\)\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const epgId = tvgToEpg(entry.attrs['tvg-id']);
    list.push({
      id: 'fr:' + (epgId || normName(name)),
      name,
      logo: entry.attrs['tvg-logo'] ?? '',
      group: group.split(';')[0] || 'Général',
      cat: tvCategory(group),
      source: 'iptv-org',
      fast: false,
      url: entry.url,
      epgId,
      flaky,
    });
  }
  return list;
}

/** Chaînes FAST (format i.mjh.nz) d'une région. `slug` contient {id} pour l'URL de lecture. */
function fromMjh(json: unknown, region: string, prefix: string, slug: string, source: string): TvChannel[] {
  const channels = recordAt(json, 'regions', region, 'channels');
  return Object.keys(channels).map((id) => {
    const info = recordAt(channels, id);
    const group = typeof info.group === 'string' && info.group !== '' ? info.group : 'FAST';
    return {
      id: prefix + ':' + id,
      name: typeof info.name === 'string' && info.name !== '' ? info.name : id,
      logo: typeof info.logo === 'string' ? info.logo : '',
      group,
      cat: tvCategory(group),
      source,
      fast: true,
      url: slug.replace('{id}', id),
      epgId: id,
      flaky: false,
    };
  });
}

/** Une seule chaîne par nom normalisé : la source la plus fiable l'emporte (iptv-org, puis Pluto, puis Samsung). */
function dedupeChannels(all: TvChannel[]): TvChannel[] {
  const rank = (c: TvChannel): number => (c.flaky ? 10 : 0) + (c.source === 'iptv-org' ? 0 : c.source === 'pluto' ? 1 : 2);
  const best = new Map<string, TvChannel>();
  for (const channel of all) {
    const key = normName(channel.name);
    if (!key) continue;
    const current = best.get(key);
    if (current === undefined || rank(channel) < rank(current)) best.set(key, channel);
  }
  return Array.from(best.values());
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

/** Charge les chaînes et l'EPG (fenêtre -6 h / +30 h, une source par chaîne). Mis en cache 6 h. */
async function buildTv(ctx: LtContext): Promise<TvData> {
  const [m3u, pluto, samsung] = await Promise.allSettled([
    tvGet(ctx, TV_SOURCES.m3u, 30000, MAX_SOURCE_BYTES),
    tvGet(ctx, TV_SOURCES.pluto, 60000, MAX_SOURCE_BYTES),
    tvGet(ctx, TV_SOURCES.samsung, 60000, MAX_SOURCE_BYTES),
  ]);
  const value = (result: PromiseSettledResult<Buffer>): Buffer | null =>
    result.status === 'fulfilled' ? result.value : null;

  const counts: Record<string, number> = { 'iptv-org': 0, [FLAKY_LABEL]: 0, pluto: 0, samsung: 0 };
  const all: TvChannel[] = [];
  const m3uBuffer = value(m3u);
  if (m3uBuffer !== null) {
    const list = fromIptvOrg(m3uBuffer.toString('utf8'));
    for (const channel of list) counts[channel.flaky ? FLAKY_LABEL : 'iptv-org'] += 1;
    all.push(...list);
  }
  const plutoBuffer = value(pluto);
  if (plutoBuffer !== null) {
    const list = fromMjh(parseJson(plutoBuffer), 'fr', 'plu', 'https://jmp2.uk/plu-{id}.m3u8', 'pluto');
    counts.pluto = list.length;
    all.push(...list);
  }
  const samsungBuffer = value(samsung);
  if (samsungBuffer !== null) {
    const list = fromMjh(parseJson(samsungBuffer), 'fr', 'stv', 'https://jmp2.uk/stvp-{id}', 'samsung');
    counts.samsung = list.length;
    all.push(...list);
  }
  const channels = dedupeChannels(all);
  for (const channel of channels) {
    const host = hostOf(channel.url);
    if (host !== undefined) ctx.state.tvHosts.add(host);
  }

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
  for (const list of epg.values()) list.sort((a, b) => a.start - b.start);
  const withEpg = channels.filter((c) => c.epgId !== '' && epg.has(c.epgId)).length;
  return {
    channels,
    epg,
    stats: {
      counts,
      total: channels.length,
      epgCoverage: channels.length ? Math.round((withEpg / channels.length) * 100) : 0,
      epgStats,
    },
  };
}

function parseJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function loadTv(ctx: LtContext): Promise<TvData> {
  return ctx.state.cache.get('tv:data', TTL.tv, () => buildTv(ctx));
}

/** Chaînes publiques : mêmes champs que le prototype, booléens normalisés. */
function publicChannel(c: TvChannel): TvChannel {
  return { id: c.id, name: c.name, logo: c.logo, group: c.group, cat: c.cat, source: c.source, fast: c.fast, url: c.url, epgId: c.epgId, flaky: c.flaky };
}

export async function tvChannels(ctx: LtContext): Promise<TvChannel[]> {
  return (await loadTv(ctx)).channels.map(publicChannel);
}

export async function tvStats(ctx: LtContext): Promise<TvStats> {
  return (await loadTv(ctx)).stats;
}

/** Programmes des chaînes demandées (`ids`, jusqu'à 60) sur une fenêtre de 8 h au plus. */
export async function tvEpg(ctx: LtContext, query: Record<string, string>): Promise<unknown[]> {
  const data = await loadTv(ctx);
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
  const epgIdOf = new Map(data.channels.map((c) => [c.id, c.epgId]));
  const out: unknown[] = [];
  for (const id of ids) {
    // Accepte un id de chaîne ou un id EPG (playlists utilisateur).
    const epgId = epgIdOf.get(id) ?? id;
    const list = data.epg.get(epgId);
    if (list === undefined) continue;
    for (const p of list) {
      if (p.stop <= from || p.start >= to) continue;
      out.push({ channelId: id, start: p.start, stop: p.stop, title: p.title, desc: p.desc, icon: p.icon, category: p.category });
    }
  }
  return out;
}

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
      .map((entry, i) => ({
        id: 'usr:' + i + ':' + normName(entry.name).slice(0, 24),
        name: entry.name.replace(/\s+/g, ' ').trim(),
        logo: entry.attrs['tvg-logo'] ?? '',
        group: entry.attrs['group-title'] || 'Ma playlist',
        cat: 'Ma playlist',
        source: 'user',
        fast: false,
        url: entry.url,
        epgId: tvgToEpg(entry.attrs['tvg-id']),
        flaky: false,
      }));
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
      .map((s): TvChannel => {
        const streamId = String(s.stream_id ?? '');
        return {
          id: 'usr:' + streamId,
          name: String(s.name || streamId).trim(),
          logo: typeof s.stream_icon === 'string' ? s.stream_icon : '',
          group: names.get(String(s.category_id)) || 'Ma playlist',
          cat: 'Ma playlist',
          source: 'user',
          fast: false,
          url: `${base}/live/${encodeURIComponent(user)}/${encodeURIComponent(pass)}/${encodeURIComponent(streamId)}.m3u8`,
          epgId: typeof s.epg_channel_id === 'string' ? s.epg_channel_id : '',
          flaky: false,
        };
      });
  } else {
    throw new LtError(400, 'bad_request');
  }
  for (const channel of list) {
    const host = hostOf(channel.url);
    if (host !== undefined && ctx.state.tvHosts.size < MAX_HLS_HOSTS) ctx.state.tvHosts.add(host);
  }
  return { channels: list, count: list.length };
}

/**
 * Réécrit une playlist HLS : sous-playlists et clés/médias passent par le proxy (`proxyPrefix` + URL encodée),
 * les segments restent des URL directes. Les hôtes découverts rejoignent la liste autorisée.
 */
function hlsRewrite(ctx: LtContext, text: string, baseUrl: string, proxyPrefix: string): string {
  const abs = (value: string): string | null => {
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return null;
    }
  };
  const viaProxy = (value: string): string => {
    const absolute = abs(value);
    if (absolute === null) return value;
    const host = hostOf(absolute);
    if (host !== undefined && ctx.state.tvHosts.size < MAX_HLS_HOSTS) ctx.state.tvHosts.add(host);
    return proxyPrefix + encodeURIComponent(absolute);
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
 * Proxy HLS : uniquement des playlists d'hôtes connus (liste issue des playlists chargées), jamais d'IP privée.
 * Renvoie le texte réécrit ; les erreurs sont des LtError.
 */
export async function tvHls(ctx: LtContext, rawUrl: string | null, proxyPrefix: string): Promise<string> {
  const url = parseSafeUrl(rawUrl);
  if (url === null) throw new LtError(400, 'bad_url');
  await loadTv(ctx).catch(() => null); // alimente la liste d'hôtes autorisés
  if (!ctx.state.tvHosts.has(url.hostname)) throw new LtError(403, 'host_not_allowed');
  const res = await ltRequest(ctx, url.toString(), { headers: TV_HEADERS }, 15000, {
    maxBytes: MAX_HLS_BYTES,
    guard: ctx.guard,
  });
  if (!res.ok) throw new LtError(502, `upstream_${res.status}`);
  const text = new TextDecoder('utf-8').decode(res.bytes).replace(/^\uFEFF/, '');
  if (!/^\s*#EXTM3U/.test(text)) throw new LtError(415, 'not_a_playlist');
  return hlsRewrite(ctx, text, res.url, proxyPrefix);
}
