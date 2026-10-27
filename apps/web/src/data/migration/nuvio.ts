/* Lecture d'une sauvegarde Nuvio (fichier JSON, lu en mémoire). Formats reconnus, à n'importe quel niveau du fichier :
 * - bibliothèque : `LibraryItem` (`id`, `type`, `name`, `savedAtEpochMs`, `imdbId`, `tmdbId`, `mediaCategory`, `listKeys`) ;
 * - progression : `WatchProgressEntry` (`parentMetaId`, `videoId`, `seasonNumber`, `episodeNumber`, `lastPositionMs`,
 *   `durationMs`, `lastUpdatedEpochMs`, `isCompleted`) ;
 * - vus : groupes `{ id, type, entries: [{ season, episode, markedAtEpochMs }] }` ou éléments `{ id, type, markedAtEpochMs }` ;
 * - ancienne app (React Native) : objet `watchProgress` `{ "<type>:<id>[:<épisode>]": { currentTime, duration, lastUpdated } }` ;
 * - addons : objets portant `transportUrl`.
 * La progression est reprise à la seconde près quand le fichier la contient (positions en ms ou en s selon le format). */

import { addonOfDescriptor } from './stremio';
import {
  hasRef, isObject, num, posInt, refOfMediaId, str, timeOf, typeOf,
  type EpisodeRef, type MigrationAddon, type MigrationBundle, type MigrationItem, type TitleRef,
} from './types';

/** Au-delà de ce taux, Nuvio compte l'épisode ou le film comme vu (WatchProgressCompletionPercentThreshold). */
const COMPLETED_RATIO = 0.9;

const refOf = (o: Record<string, unknown>, id: string): TitleRef => {
  const r = refOfMediaId(id);
  const tmdb = posInt(o.tmdbId);
  const imdb = refOfMediaId(str(o.imdbId)).imdb;
  return { ...r, ...(tmdb ? { tmdb } : {}), ...(imdb ? { imdb } : {}) };
};

const isAnimeCategory = (o: Record<string, unknown>): boolean => str(o.mediaCategory).toLowerCase() === 'anime' || str(o.type).toLowerCase() === 'anime';

function libraryItem(o: Record<string, unknown>): MigrationItem[] {
  const id = str(o.id);
  const type = typeOf(o.type);
  const ref = refOf(o, id);
  const title = str(o.name) || id;
  const at = timeOf(o.savedAtEpochMs);
  const anime = isAnimeCategory(o);
  if (!type || !hasRef(ref)) return [{ uid: 'nuvio:' + id + ':library', action: 'library', type: type ?? 'movie', ref, title, at, skipReason: !type ? 'Type « ' + str(o.type) + ' » non pris en charge' : 'Titre propre à un addon, sans équivalent TMDB' }];
  const out: MigrationItem[] = [{ uid: 'nuvio:' + id + ':library', action: 'library', type, ref, title, at, ...(anime ? { anime } : {}) }];
  const lists = Array.isArray(o.listKeys) ? o.listKeys.map((k) => str(k).toLowerCase()) : [];
  if (lists.some((k) => k.includes('watchlist') || k.includes('plan'))) out.push({ uid: 'nuvio:' + id + ':watchlist', action: 'list', list: 'watchlist', type, ref, title, at });
  if (lists.some((k) => k.includes('favorite') || k.includes('favourite') || k.includes('like'))) out.push({ uid: 'nuvio:' + id + ':favorites', action: 'list', list: 'favorites', type, ref, title, at });
  return out;
}

/** Épisode d'un `videoId` (`tt123:1:2`), à défaut des champs numérotés. */
function episodeOf(o: Record<string, unknown>, sKey: string, eKey: string): EpisodeRef | null {
  const season = num(o[sKey]);
  const episode = num(o[eKey]);
  if (season !== undefined && episode !== undefined && episode > 0) return { season, episode };
  const p = str(o.videoId).split(':');
  if (p.length >= 3) {
    const s = Number(p[p.length - 2]);
    const e = Number(p[p.length - 1]);
    if (Number.isInteger(s) && Number.isInteger(e) && e > 0) return { season: s, episode: e };
  }
  return null;
}

function progressEntry(o: Record<string, unknown>): MigrationItem[] {
  const id = str(o.parentMetaId) || str(o.videoId).split(':')[0];
  const type = typeOf(o.parentMetaType ?? o.contentType);
  const ref = refOf(o, id);
  const title = str(o.title) || id;
  if (!type || !hasRef(ref)) return [];
  const ep = type === 'tv' ? episodeOf(o, 'seasonNumber', 'episodeNumber') : null;
  if (type === 'tv' && !ep) return [];
  const pos = (num(o.lastPositionMs) ?? 0) / 1000;
  const dur = (num(o.durationMs) ?? 0) / 1000;
  const at = timeOf(o.lastUpdatedEpochMs);
  const key = 'nuvio:' + id + (ep ? ':' + ep.season + ':' + ep.episode : '');
  const done = o.isCompleted === true || (dur > 0 && pos / dur >= COMPLETED_RATIO);
  if (done) return [{ uid: key + ':watched', action: 'watched', type, ref, title, at, ...(ep ? { episodes: [ep] } : {}) }];
  if (pos <= 0 || dur <= 0) return [];
  return [{ uid: key + ':progress', action: 'progress', type, ref, title, at, positionSec: Math.floor(pos), durationSec: Math.floor(dur), ...(ep ?? {}) }];
}

function watchedGroup(o: Record<string, unknown>): MigrationItem[] {
  const id = str(o.id);
  const type = typeOf(o.type);
  const ref = refOf(o, id);
  if (!type || !hasRef(ref)) return [];
  const title = str(o.name) || id;
  const entries = Array.isArray(o.entries) ? o.entries.filter(isObject) : [o];
  const at = Math.max(0, ...entries.map((e) => timeOf(e.markedAtEpochMs)));
  if (type === 'movie') return [{ uid: 'nuvio:' + id + ':watched', action: 'watched', type, ref, title, at }];
  const episodes = entries.map((e) => episodeOf(e, 'season', 'episode')).filter((e): e is EpisodeRef => e !== null && e.season > 0);
  return episodes.length ? [{ uid: 'nuvio:' + id + ':watched:' + episodes.length, action: 'watched', type, ref, title, at, episodes }] : [];
}

/** Ancienne app : `{ "series:tt1:tt1:1:2": { currentTime, duration, lastUpdated } }` (secondes). */
function legacyProgress(map: Record<string, unknown>): MigrationItem[] {
  const out: MigrationItem[] = [];
  for (const [rawKey, v] of Object.entries(map)) {
    if (!isObject(v) || num(v.currentTime) === undefined) continue;
    const key = rawKey.replace(/^@watch_progress:/, '');
    const [t, ...rest] = key.split(':');
    const type = typeOf(t);
    const id = rest.join(':');
    const ref = refOfMediaId(id);
    if (!type || !hasRef(ref)) continue;
    const ep = type === 'tv' ? episodeOf({ videoId: id }, '', '') : null;
    if (type === 'tv' && !ep) continue;
    out.push(...progressEntry({
      parentMetaId: id.split(':')[0], parentMetaType: t, title: str(v.title), lastPositionMs: (num(v.currentTime) ?? 0) * 1000,
      durationMs: (num(v.duration) ?? 0) * 1000, lastUpdatedEpochMs: v.lastUpdated, ...(ep ? { seasonNumber: ep.season, episodeNumber: ep.episode } : {}),
    }));
  }
  return out;
}

function walk(v: unknown, depth: number, visit: (o: Record<string, unknown>, key: string) => void, key = ''): void {
  if (depth > 4) return;
  if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1, visit, key)); return; }
  if (!isObject(v)) return;
  visit(v, key);
  for (const [k, w] of Object.entries(v)) if (typeof w === 'object' && w !== null) walk(w, depth + 1, visit, k);
}

/** Lit une sauvegarde Nuvio. Rien n'est envoyé : le fichier est lu en mémoire. */
export function parseNuvioBackup(json: unknown): MigrationBundle {
  const items: MigrationItem[] = [];
  const addons: MigrationAddon[] = [];
  walk(json, 0, (o, key) => {
    if (typeof o.parentMetaId === 'string' && 'lastPositionMs' in o) items.push(...progressEntry(o));
    else if (typeof o.transportUrl === 'string') {
      const a = addonOfDescriptor(o.manifest ? o : { transportUrl: o.transportUrl, manifest: { name: o.name } });
      if (a && !addons.some((x) => x.manifestUrl === a.manifestUrl)) addons.push(a);
    } else if (typeof o.id === 'string' && typeof o.type === 'string' && (Array.isArray(o.entries) || 'markedAtEpochMs' in o)) items.push(...watchedGroup(o));
    else if (typeof o.id === 'string' && typeof o.type === 'string' && typeof o.name === 'string' && ('savedAtEpochMs' in o || 'listKeys' in o)) items.push(...libraryItem(o));
    else if (/progress/i.test(key) && Object.values(o).some((x) => isObject(x) && 'currentTime' in x)) items.push(...legacyProgress(o));
  });
  // Une même progression peut figurer deux fois (copie locale et copie synchronisée) : la plus récente l'emporte.
  const byUid = new Map<string, MigrationItem>();
  for (const it of items) {
    const prev = byUid.get(it.uid);
    if (!prev || (it.at ?? 0) > (prev.at ?? 0)) byUid.set(it.uid, it);
  }
  const notes = byUid.size || addons.length ? [] : ['Aucune bibliothèque, progression ni addon Nuvio reconnu dans ce fichier.'];
  return { source: 'nuvio', items: [...byUid.values()], addons, notes };
}
