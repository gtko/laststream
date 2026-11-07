/* Résolution d'un titre importé en titre TMDB (identifiant, titre, affiche), et liste des épisodes Stremio d'une série.
 * TMDB passe par lastAddon (route `find`, comme l'import serveur) ; la fiche Cinemeta (addon officiel de Stremio, métadonnées
 * seulement) est lue depuis l'appareil pour décoder le champ « watched ». Résultats gardés en mémoire pour la durée de l'import. */

import { appFetch } from '../crossFetch';
import { tmdb } from '../lt';
import type { ResolvedTitle } from './sink';
import type { MigrationItem } from './types';
import type { BitfieldVideo } from './watchedBitfield';

export const CINEMETA = 'https://v3-cinemeta.strem.io/meta/series/';

/** Titre introuvable (l'absence est établie) : le rapport l'indique, l'import continue. */
export class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFound';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const fromTmdb = (type: 'movie' | 'tv', r: any, fallbackTitle: string, imdb?: string): ResolvedTitle => ({
  type, id: r.id, title: r.title || r.name || fallbackTitle, poster: r.poster_path || '',
  ...(String(r.release_date || r.first_air_date || '').slice(0, 4) ? { year: String(r.release_date || r.first_air_date).slice(0, 4) } : {}),
  ...(imdb ? { imdb } : {}),
});

export type Resolver = (item: MigrationItem) => Promise<ResolvedTitle>;

/** Résolveur avec mémoire : un titre présent plusieurs fois (bibliothèque, vus, progression) n'est cherché qu'une fois. */
export function createResolver(tmdbFn: (path: string, params?: Record<string, string>) => Promise<any> = tmdb): Resolver {
  const memo = new Map<string, Promise<ResolvedTitle>>();
  const find = async (item: MigrationItem): Promise<ResolvedTitle> => {
    const { ref, type, title } = item;
    if (ref.tmdb) {
      // Identifiant TMDB fourni : on garde le titre de la source, l'affiche sera complétée par l'interface.
      return { type, id: ref.tmdb, title, poster: '', ...(item.year ? { year: item.year } : {}), ...(ref.imdb ? { imdb: ref.imdb } : {}) };
    }
    const tries: Array<[string, string]> = [];
    if (ref.imdb) tries.push([ref.imdb, 'imdb_id']);
    if (ref.tvdb) tries.push([String(ref.tvdb), 'tvdb_id']);
    for (const [id, source] of tries) {
      const found = await tmdbFn('find/' + id, { external_source: source });
      const movie = found?.movie_results?.[0];
      const tv = found?.tv_results?.[0];
      const pick = item.typeUnknown ? (movie ? 'movie' : tv ? 'tv' : null) : type === 'movie' ? (movie ? 'movie' : null) : (tv ? 'tv' : null);
      if (pick) return fromTmdb(pick, pick === 'movie' ? movie : tv, title, ref.imdb);
    }
    const ids = [ref.imdb && 'IMDb ' + ref.imdb, ref.tvdb && 'TVDB ' + ref.tvdb].filter(Boolean).join(', ');
    throw new NotFound('Introuvable sur TMDB' + (ids ? ' (' + ids + ')' : ''));
  };
  return (item) => {
    const key = (item.typeUnknown ? '?' : item.type) + ':' + (item.ref.tmdb ?? item.ref.imdb ?? item.ref.tvdb);
    let p = memo.get(key);
    if (!p) {
      p = find(item);
      memo.set(key, p);
      p.catch(() => memo.delete(key)); // un échec réseau sera retenté à la reprise
    }
    return p;
  };
}

export type VideoLister = (imdb: string) => Promise<BitfieldVideo[]>;

/** Épisodes d'une série selon Cinemeta, dans le format attendu par le décodage du champ « watched ». */
export function createVideoLister(fetchFn: (url: string) => Promise<Response> = (u) => appFetch(u)): VideoLister {
  const memo = new Map<string, Promise<BitfieldVideo[]>>();
  return (imdb) => {
    let p = memo.get(imdb);
    if (!p) {
      p = (async () => {
        const res = await fetchFn(CINEMETA + encodeURIComponent(imdb) + '.json');
        if (!res.ok) throw new NotFound('Liste des épisodes Stremio indisponible (HTTP ' + res.status + ')');
        const data: any = await res.json();
        const videos: any[] = Array.isArray(data?.meta?.videos) ? data.meta.videos : [];
        return videos.filter((v) => v && typeof v.id === 'string').map((v) => ({
          id: v.id, season: typeof v.season === 'number' ? v.season : undefined,
          episode: typeof v.episode === 'number' ? v.episode : typeof v.number === 'number' ? v.number : undefined,
          released: typeof v.released === 'string' ? v.released : undefined,
        }));
      })();
      memo.set(imdb, p);
      p.catch(() => memo.delete(imdb));
    }
    return p;
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
