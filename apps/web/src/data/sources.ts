import { addonUrl, ltUrl } from './config';
import { tmdb } from './lt';
import { getBandwidthSetting, type BandwidthSetting } from './prefs';
import { getLaststream, type Lang, type LastStreamInfo, type Stream } from './stream';
import { cachedRequest, requestJson } from './transport';

/* Sources de lecture : récupération des streams lastAddon, tri par score, regroupement par qualité,
 * mesure du débit et choix de la source automatique. Fonctions pures testées dans tests/sources.test.ts. */

export type QualityGroupKey = '2160p' | '1080p' | '720p' | 'SD' | 'other';
export const QUALITY_GROUP_ORDER: readonly QualityGroupKey[] = ['2160p', '1080p', '720p', 'SD', 'other'];
export const QUALITY_LABEL: Record<QualityGroupKey, string> = {
  '2160p': '4K · 2160p', '1080p': 'Full HD · 1080p', '720p': 'HD · 720p', SD: 'SD', other: 'Autres',
};

export interface QualityGroup<T> {
  key: QualityGroupKey;
  streams: T[];
}

// ---------- Identifiants ----------

/** Identifiant Stremio d'un film (`tt…`) ou d'un épisode (`tt…:saison:épisode`). */
export function stremioId(imdbId: string, season?: number | null, episode?: number | null): string {
  return season != null && episode != null ? `${imdbId}:${season}:${episode}` : imdbId;
}

/** Correspondance TMDB → IMDb via `external_ids` (le titre doit avoir un identifiant IMDb). */
export async function imdbIdOf(type: 'movie' | 'tv', tmdbId: string | number): Promise<string | null> {
  const data = await tmdb<{ imdb_id?: string | null }>(`${type}/${tmdbId}/external_ids`);
  return typeof data?.imdb_id === 'string' && data.imdb_id !== '' ? data.imdb_id : null;
}

/** Streams d'un titre : GET {base}/{config}/stream/{movie|series}/{id}.json. */
export async function fetchStreams(type: 'movie' | 'tv', imdbId: string, season?: number | null, episode?: number | null): Promise<Stream[]> {
  const kind = type === 'tv' ? 'series' : 'movie';
  const id = type === 'tv' ? stremioId(imdbId, season ?? 1, episode ?? 1) : imdbId;
  const url = addonUrl(`stream/${kind}/${id}.json`);
  const res = await cachedRequest(url, () => requestJson<{ streams?: Stream[] }>(url), 60_000);
  return Array.isArray(res?.streams) ? res.streams : [];
}

/** Résultat d'une recherche de sources : streams et sources encore en cours d'interrogation (réponse partielle de lastAddon). */
export interface StreamsResult {
  streams: Stream[];
  pending: string[];
  /** Message de lastAddon (ex. « Configure AllDebrid ») : les torrents sont masqués faute de débrideur. */
  notice?: string;
  /** lastAddon ne débride pas : les torrents sont livrés sans lien (`debrid: "client"`), l'appareil vérifie le cache et débride. */
  clientDebrid?: boolean;
  /** Réglage « seulement les sources en cache » de la configuration : appliqué sur l'appareil quand le statut est connu. */
  onlyCached?: boolean;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/** Streams d'un titre avec la liste des sources encore en attente (`pending`) ; absente dans l'ancienne forme de réponse. */
export async function fetchStreamsResult(type: 'movie' | 'tv', imdbId: string, season?: number | null, episode?: number | null): Promise<StreamsResult> {
  const kind = type === 'tv' ? 'series' : 'movie';
  const id = type === 'tv' ? stremioId(imdbId, season ?? 1, episode ?? 1) : imdbId;
  const res = await requestJson<{ streams?: Stream[]; pending?: unknown; notice?: unknown; debrid?: unknown; onlyCached?: unknown }>(addonUrl(`stream/${kind}/${id}.json`));
  const notice = typeof res?.notice === 'string' && res.notice ? res.notice : undefined;
  return {
    streams: Array.isArray(res?.streams) ? res.streams : [],
    pending: strings(res?.pending),
    ...(notice ? { notice } : {}),
    ...(res?.debrid === 'client' ? { clientDebrid: true, onlyCached: res.onlyCached === true } : {}),
  };
}

export interface StreamsStatus {
  pending: string[];
  count: number;
}

/** État de la recherche en cours : GET {base}/{config}/lt/streams/status/:type/:id. Null si la route n'existe pas. */
export async function fetchStreamStatus(type: 'movie' | 'tv', imdbId: string, season?: number | null, episode?: number | null): Promise<StreamsStatus | null> {
  const kind = type === 'tv' ? 'series' : 'movie';
  const id = type === 'tv' ? stremioId(imdbId, season ?? 1, episode ?? 1) : imdbId;
  try {
    const res = await requestJson<{ pending?: unknown; count?: unknown }>(ltUrl(`streams/status/${kind}/${id}`));
    return { pending: strings(res?.pending), count: typeof res?.count === 'number' ? res.count : 0 };
  } catch {
    return null;
  }
}

// ---------- Tri, regroupement ----------

export function getStreamHttpUrl(stream: object): string | null {
  const url = (stream as { url?: unknown }).url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

export function getQualityGroupKey(stream: object): QualityGroupKey {
  switch (getLaststream(stream)?.resolution) {
    case '2160p': return '2160p';
    case '1080p': return '1080p';
    case '720p': return '720p';
    case '480p':
    case 'SD': return 'SD';
    default: return 'other';
  }
}

/** Tri par score décroissant (stable) ; les streams sans objet `laststream` passent après, dans l'ordre d'origine. */
export function sortStreams<T extends object>(streams: readonly T[]): T[] {
  const scored: Array<{ stream: T; score: number; index: number }> = [];
  const unscored: T[] = [];
  streams.forEach((stream, index) => {
    const info = getLaststream(stream);
    if (info) scored.push({ stream, score: info.score, index });
    else unscored.push(stream);
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return [...scored.map((s) => s.stream), ...unscored];
}

/** Regroupe par qualité (2160p, 1080p, 720p, SD, autres) ; les groupes vides sont omis. */
export function groupByQuality<T extends object>(streams: readonly T[]): QualityGroup<T>[] {
  const buckets = new Map<QualityGroupKey, T[]>();
  streams.forEach((stream) => {
    const key = getQualityGroupKey(stream);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(stream);
    else buckets.set(key, [stream]);
  });
  return QUALITY_GROUP_ORDER.filter((k) => buckets.has(k)).map((key) => ({ key, streams: buckets.get(key) ?? [] }));
}

/** Nombre de copies équivalentes (même qualité, source, codec, langues et taille à 0,1 Go près), soi-même compris. */
export function copiesOf<T extends object>(stream: T, all: readonly T[]): number {
  const sig = (s: T): string | null => {
    const i = getLaststream(s);
    if (!i) return null;
    return [i.resolution, i.source, i.codec, [...i.languages].sort().join('+'), i.sizeBytes ? Math.round(i.sizeBytes / 1e8) : '?'].join('|');
  };
  const mine = sig(stream);
  return mine === null ? 1 : all.filter((s) => sig(s) === mine).length;
}

// ---------- Libellés ----------

export function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / 1e9;
  return gb >= 1 ? gb.toFixed(1).replace('.', ',') + ' Go' : Math.round(bytes / 1e6) + ' Mo';
}

export function formatBitrate(kbps: number | null | undefined): string {
  if (!kbps || kbps <= 0) return '';
  return kbps >= 1000 ? (kbps / 1000).toFixed(1).replace('.', ',') + ' Mb/s' : Math.round(kbps) + ' kb/s';
}

const LANG_LABEL: Record<string, string> = { fr: 'FR', en: 'EN', es: 'ES', de: 'DE', it: 'IT', multi: 'MULTI', original: 'VO' };

/** Étiquette de langue : variante française (VFF, VOSTFR…) sinon langues détectées. */
export function languageLabel(info: LastStreamInfo): string {
  if (info.frVariant) return info.frVariant;
  return info.languages.map((l) => LANG_LABEL[l] ?? l.toUpperCase()).join(' · ');
}

/** Vrai si la langue est celle demandée (ou du multi-audio) et non un repli. */
export function matchesLanguage(info: LastStreamInfo, lang: Lang, alsoAccept: readonly Lang[] = []): boolean {
  // Langues acceptées d'office (mode apprentissage : VO, multi) : même quand le serveur les a signalées comme repli.
  if (alsoAccept.some((l) => info.languages.includes(l))) return true;
  if (info.languageFallback === true) return false;
  return info.languages.includes(lang) || info.languages.includes('multi');
}

// ---------- Débit ----------

export const BANDWIDTH_MEASURE_URL = 'https://speed.cloudflare.com/__down?bytes=8000000';
export const BANDWIDTH_MEASURE_BYTES = 8_000_000;
export const BANDWIDTH_MEASURE_MS = 3000;
export const BANDWIDTH_MIN_MEASURE_BYTES = 65_536;
export const BANDWIDTH_STORED_TTL_MS = 24 * 60 * 60 * 1000;
export const BANDWIDTH_STORAGE_KEY = 'laststream.bandwidth.measured';
/** Une source ne doit pas dépasser 80 % du débit retenu. */
export const BANDWIDTH_HEADROOM = 0.8;

export interface StoredBandwidth {
  kbps: number;
  expiresAt: number;
}

export type BandwidthPlan = { kind: 'manual'; kbps: number } | { kind: 'stored'; kbps: number } | { kind: 'measure' };

/** Réglage fixe > mesure stockée valable > nouvelle mesure. */
export function planBandwidth(setting: BandwidthSetting, stored: StoredBandwidth | null, now: number): BandwidthPlan {
  if (setting !== 'auto') return { kind: 'manual', kbps: setting * 1000 };
  if (stored && Number.isFinite(stored.kbps) && stored.kbps > 0 && stored.expiresAt > now) return { kind: 'stored', kbps: stored.kbps };
  return { kind: 'measure' };
}

export function readStoredBandwidth(): StoredBandwidth | null {
  try {
    const raw = globalThis.localStorage?.getItem(BANDWIDTH_STORAGE_KEY);
    if (!raw) return null;
    const e = JSON.parse(raw) as Partial<StoredBandwidth> | null;
    if (typeof e?.kbps === 'number' && typeof e.expiresAt === 'number') return { kbps: e.kbps, expiresAt: e.expiresAt };
  } catch {
    // Entrée illisible : aucune mesure connue.
  }
  return null;
}

function writeStoredBandwidth(entry: StoredBandwidth): void {
  try {
    globalThis.localStorage?.setItem(BANDWIDTH_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Quota dépassé : la mesure sera refaite.
  }
}

/**
 * Télécharge au plus 8 Mo en 3 s (flux lu morceau par morceau, puis annulé). Débit en kb/s,
 * ou null si trop peu d'octets ont été reçus ou si le téléchargement a échoué.
 */
export async function measureDownloadKbps(): Promise<number | null> {
  if (typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BANDWIDTH_MEASURE_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let received = 0;
  const startedAt = performance.now();
  try {
    const response = await fetch(BANDWIDTH_MEASURE_URL, { cache: 'no-store', signal: controller.signal });
    if (!response.ok || !response.body) return null;
    reader = response.body.getReader();
    while (received < BANDWIDTH_MEASURE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
    }
  } catch {
    // Délai dépassé ou réseau coupé : on garde ce qui a été reçu.
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => undefined);
    controller.abort();
  }
  const seconds = (performance.now() - startedAt) / 1000;
  const bytes = Math.min(received, BANDWIDTH_MEASURE_BYTES);
  if (bytes < BANDWIDTH_MIN_MEASURE_BYTES || seconds <= 0) return null;
  return (bytes * 8) / 1000 / seconds;
}

/** « Tester ma connexion » : mesure maintenant et garde le résultat 24 h. Débit en kb/s, ou null. */
export async function testBandwidthKbps(): Promise<number | null> {
  const kbps = await measureDownloadKbps();
  if (kbps !== null) writeStoredBandwidth({ kbps, expiresAt: Date.now() + BANDWIDTH_STORED_TTL_MS });
  return kbps;
}

/** Débit retenu pour choisir la source : réglage fixe, sinon mesure valable (24 h), sinon nouvelle mesure. */
export async function measureBandwidthKbps(): Promise<number | null> {
  const plan = planBandwidth(getBandwidthSetting(), readStoredBandwidth(), Date.now());
  if (plan.kind !== 'measure') return plan.kbps;
  return testBandwidthKbps();
}

export interface AutoplayPick<T> {
  stream: T;
  languageFallback: boolean;
  fallbackReason?: 'no-vf' | 'vf-too-heavy';
}

/**
 * Meilleure source qui tient dans 80 % du débit (`bwKbps` null : pas de filtre). Une VF qui tient est préférée,
 * même en qualité inférieure ; sinon repli VO. Null si aucune source ne tient le débit.
 */
export function pickAutoplay<T extends object>(streams: readonly T[], bwKbps: number | null, preferred: Lang = 'fr', alsoAccept: readonly Lang[] = []): AutoplayPick<T> | null {
  const budget = bwKbps === null || !Number.isFinite(bwKbps) ? Infinity : Math.max(0, bwKbps) * BANDWIDTH_HEADROOM;
  const scored: Array<{ stream: T; info: LastStreamInfo }> = [];
  sortStreams(streams).forEach((stream) => {
    const info = getLaststream(stream);
    if (info) scored.push({ stream, info });
  });
  const fitting = scored.filter(({ info }) => info.estBitrateKbps === null || info.estBitrateKbps <= budget);
  if (fitting.length === 0) return null;
  const pref = fitting.find(({ info }) => matchesLanguage(info, preferred, alsoAccept));
  if (pref) return { stream: pref.stream, languageFallback: false };
  const anyPref = scored.some(({ info }) => matchesLanguage(info, preferred, alsoAccept));
  return { stream: fitting[0].stream, languageFallback: true, fallbackReason: anyPref ? 'vf-too-heavy' : 'no-vf' };
}
