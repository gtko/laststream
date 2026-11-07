/* Fiche et sources d'un titre dont l'identifiant est propre à un addon Stremio (ex. `fk:123`, ODY-252).
 * Tout vient de l'addon lui-même (routes `meta` puis `stream`), lues depuis l'appareil : ni TMDB, ni IMDb, ni serveur Laststream,
 * donc jamais d'erreur `no-imdb`. Aucune des deux fonctions ne lève : l'échec donne `error` (fiche) ou une liste vide (sources). */

import {
  addonBaseOf, CATALOG_MAX_BODY_BYTES, CATALOG_TIMEOUT_MS, metaUrl, streamUrl,
  type AddonCatalogEntry, type CatalogError, type Meta,
} from '../data/addonCatalog';
import { sortStreams } from '../data/sources';
import type { Stream } from '../data/stream';
import { browserCaps, inShell } from '../player/caps';
import { serverLikelyUp } from '../player/server';
import { deviceHttp, fetchDeviceStreams } from './deviceFetch';
import type { HttpFn } from './debrid/http';
import { debrid } from './debridClient';
import { playableStreams, toSourceViews, withWebPlayback, type SourceView } from './info';
import { annotateClientViews } from './load';

/** Épisode d'une série dans la fiche de l'addon. `id` est l'identifiant à passer à la route `stream`. */
export interface AddonVideo {
  id: string;
  title?: string;
  season?: number;
  episode?: number;
  released?: string;
  thumbnail?: string;
}

/** Fiche complète d'un titre (route `meta`). Les autres champs de l'addon sont conservés tels quels. */
export interface AddonMeta extends Meta {
  background?: string;
  logo?: string;
  description?: string;
  genres?: string[];
  releaseInfo?: string;
  year?: string;
  runtime?: string;
  imdb_id?: string;
  videos?: AddonVideo[];
}

type AddonRef = Pick<AddonCatalogEntry, 'manifestUrl' | 'name'> & Partial<Pick<AddonCatalogEntry, 'resources'>>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);

function videosOf(raw: unknown): AddonVideo[] {
  if (!Array.isArray(raw)) return [];
  const out: AddonVideo[] = [];
  for (const v of raw) {
    if (!isObject(v)) continue;
    const id = str(v.id);
    if (!id) continue;
    const video: AddonVideo = { id };
    const title = str(v.title) ?? str(v.name);
    if (title) video.title = title;
    const season = num(v.season);
    if (season !== undefined) video.season = season;
    const episode = num(v.episode) ?? num(v.number);
    if (episode !== undefined) video.episode = episode;
    const released = str(v.released);
    if (released) video.released = released;
    const thumbnail = str(v.thumbnail);
    if (thumbnail) video.thumbnail = thumbnail;
    out.push(video);
  }
  return out;
}

/** Fiche normalisée : `id` et `name` obligatoires, genres et épisodes nettoyés, le reste conservé. */
function metaOf(raw: unknown, fallbackId: string): AddonMeta | undefined {
  if (!isObject(raw)) return undefined;
  const name = str(raw.name);
  if (!name) return undefined;
  const meta: AddonMeta = { ...raw, id: str(raw.id) ?? fallbackId, name };
  if (Array.isArray(raw.genres)) meta.genres = raw.genres.filter((g): g is string => typeof g === 'string' && g.trim() !== '');
  if (Array.isArray(raw.videos)) meta.videos = videosOf(raw.videos);
  return meta;
}

/**
 * Fiche d'un titre d'addon (route `meta`). Ne rejette jamais. Addon sans ressource `meta` : pas d'appel, `{}` (la fiche se
 * contente de ce que le catalogue a donné). Échec réseau, CORS, HTTP, corps trop gros ou illisible : `error`, sans fiche.
 */
export async function fetchAddonMeta(entry: AddonRef, type: string, id: string, http?: HttpFn): Promise<{ meta?: AddonMeta; error?: CatalogError }> {
  if (entry.resources?.meta === false) return {};
  const base = addonBaseOf(entry.manifestUrl);
  if (!base) return { error: 'invalid' };
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = metaUrl(base, type, id);
    const transport = http ?? deviceHttp(new Set([url]));
    const work = (async () => transport({ url, headers: { Accept: 'application/json' }, timeoutMs: CATALOG_TIMEOUT_MS, signal: ctl.signal }))();
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; ctl.abort(); reject(new Error('timeout')); }, CATALOG_TIMEOUT_MS);
    });
    const res = await Promise.race([work, expired]);
    if (res.status < 200 || res.status >= 300) return { error: 'http' };
    const size = res.body?.byteLength;
    if (typeof size !== 'number') return { error: 'invalid' };
    if (size > CATALOG_MAX_BODY_BYTES) return { error: 'too_large' };
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(res.body));
    } catch {
      return { error: 'invalid' };
    }
    const meta = isObject(data) ? metaOf(data.meta, id) : undefined;
    return meta ? { meta } : { error: 'invalid' };
  } catch {
    return { error: timedOut ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sources d'un titre ou d'un épisode d'addon (route `stream` de l'addon, interrogée depuis l'appareil), triées et mises en fiches
 * comme `sources/load.ts` (même étape finale). `id` est celui de la fiche, ou celui de l'épisode (`videos[].id`) pour une série.
 * Addon injoignable, 500, CORS, corps trop gros ou illisible : liste vide, sans exception.
 */
export async function loadAddonSources(entry: Pick<AddonCatalogEntry, 'manifestUrl' | 'name'>, type: string, id: string, http?: HttpFn): Promise<SourceView[]> {
  try {
    const base = addonBaseOf(entry.manifestUrl);
    if (!base) return [];
    let all: Stream[] = [];
    await fetchDeviceStreams([{ addonId: entry.name, url: streamUrl(base, type, id) }], { http, onAddon: (_t, streams) => { all = streams; } });
    // Torrents sans lien : lus seulement si l'appareil a un débrideur (clé locale, jamais le serveur).
    const clientOk = debrid().hasAny();
    const streams = sortStreams(playableStreams(all, clientOk));
    const views = withWebPlayback(toSourceViews(streams), inShell() ? null : browserCaps(), { appAudio: !inShell() && !serverLikelyUp() });
    return clientOk ? await annotateClientViews(views) : views;
  } catch {
    return [];
  }
}
