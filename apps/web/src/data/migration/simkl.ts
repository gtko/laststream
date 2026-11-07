/* Lecture d'un export Simkl (fichier lu en mémoire). JSON au format de `sync/all-items` (`movies`, `shows`, `anime`, chaque
 * entrée avec `status`, `last_watched_at`, `movie` ou `show` et ses `ids`, `seasons[].episodes[]`), ou CSV avec en-têtes
 * (titre, type, statut, identifiants IMDb / TMDB / TVDB, date). Les titres du groupe « anime » gardent cette catégorie. */

import {
  hasRef, imdbOf, isObject, num, posInt, str, timeOf, yearOf,
  type EpisodeRef, type MigrationBundle, type MigrationItem, type TitleRef,
} from './types';

type Kind = 'movie' | 'show' | 'anime';

const idsOf = (ids: unknown): TitleRef => {
  const o = isObject(ids) ? ids : {};
  const tmdb = posInt(o.tmdb);
  const imdb = imdbOf(o.imdb);
  const tvdb = posInt(o.tvdb);
  return { ...(tmdb ? { tmdb } : {}), ...(imdb ? { imdb } : {}), ...(tvdb ? { tvdb } : {}) };
};

function episodesOf(seasons: unknown): EpisodeRef[] {
  if (!Array.isArray(seasons)) return [];
  const out: EpisodeRef[] = [];
  for (const s of seasons) {
    if (!isObject(s)) continue;
    const season = num(s.number);
    if (season === undefined || season <= 0 || !Array.isArray(s.episodes)) continue;
    for (const e of s.episodes) {
      const episode = isObject(e) ? num(e.number) : undefined;
      if (episode !== undefined && episode > 0) out.push({ season, episode });
    }
  }
  return out;
}

/** Éléments d'une entrée Simkl, selon son statut. */
function entryItems(kind: Kind, status: string, media: { ids: TitleRef; title: string; year?: string; animeMovie?: boolean }, at: number, episodes: EpisodeRef[]): MigrationItem[] {
  const type = kind === 'movie' || media.animeMovie ? 'movie' : 'tv';
  const anime = kind === 'anime';
  const key = 'simkl:' + (media.ids.tmdb ?? media.ids.imdb ?? media.ids.tvdb ?? media.title) + ':' + type;
  const base = { type, ref: media.ids, title: media.title, ...(media.year ? { year: media.year } : {}), at, ...(anime ? { anime } : {}) } as const;
  if (!hasRef(media.ids)) return [{ ...base, uid: key + ':library', action: 'library', skipReason: 'Aucun identifiant TMDB, IMDb ni TVDB dans l’export' }];
  const s = status.toLowerCase();
  if (s === 'dropped') return [{ ...base, uid: key + ':library', action: 'library', skipReason: 'Marqué « abandonné » sur Simkl' }];
  if (s === 'plantowatch' || s === 'plan to watch') return [{ ...base, uid: key + ':watchlist', action: 'list', list: 'watchlist' }];
  const out: MigrationItem[] = [{ ...base, uid: key + ':library', action: 'library' }];
  if (type === 'movie' && s === 'completed') out.push({ ...base, uid: key + ':watched', action: 'watched' });
  if (type === 'tv' && episodes.length) out.push({ ...base, uid: key + ':watched', action: 'watched', episodes });
  return out;
}

function parseJson(root: Record<string, unknown>): MigrationItem[] {
  const out: MigrationItem[] = [];
  for (const kind of ['movies', 'shows', 'anime'] as const) {
    const list = root[kind];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!isObject(e)) continue;
      const media = isObject(e.movie) ? e.movie : isObject(e.show) ? e.show : isObject(e.anime) ? e.anime : {};
      const k: Kind = kind === 'movies' ? 'movie' : kind === 'shows' ? 'show' : 'anime';
      out.push(...entryItems(k, str(e.status), {
        ids: idsOf(media.ids), title: str(media.title) || 'Sans titre', year: yearOf(media.year),
        animeMovie: k === 'anime' && str(e.anime_type).toLowerCase() === 'movie',
      }, timeOf(e.last_watched_at) || timeOf(e.added_to_watchlist_at), episodesOf(e.seasons)));
    }
  }
  return out;
}

// ---------- CSV ----------

/** Découpe un CSV (guillemets doublés, virgule ou point-virgule). */
export function parseCsv(text: string): string[][] {
  const sep = (text.split('\n', 1)[0].match(/;/g)?.length ?? 0) > (text.split('\n', 1)[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const HEADERS: Record<string, RegExp> = {
  title: /^(title|name|titre)$/i,
  type: /^(type|kind|media ?type)$/i,
  status: /^(status|list|watchlist|statut)$/i,
  imdb: /imdb/i,
  tmdb: /tmdb/i,
  tvdb: /tvdb/i,
  year: /^(year|ann[ée]e)$/i,
  at: /(last.?watched|watched.?at|date)/i,
  season: /^season$/i,
  episode: /^episode$/i,
};

function parseCsvItems(text: string): MigrationItem[] {
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  if (!head) return [];
  const col: Partial<Record<keyof typeof HEADERS, number>> = {};
  head.forEach((h, i) => {
    for (const [k, re] of Object.entries(HEADERS)) if (col[k as keyof typeof HEADERS] === undefined && re.test(h.trim())) col[k as keyof typeof HEADERS] = i;
  });
  const cell = (r: string[], k: keyof typeof HEADERS): string => (col[k] !== undefined ? (r[col[k] as number] ?? '').trim() : '');
  // Une ligne par titre, ou une ligne par épisode vu : les épisodes d'une même série sont regroupés.
  const groups = new Map<string, { kind: Kind; status: string; ids: TitleRef; title: string; year?: string; at: number; episodes: EpisodeRef[] }>();
  for (const r of rows) {
    const t = cell(r, 'type').toLowerCase();
    const kind: Kind = t.includes('anime') ? 'anime' : t.includes('movie') || t.includes('film') ? 'movie' : 'show';
    const ids = idsOf({ imdb: cell(r, 'imdb'), tmdb: cell(r, 'tmdb'), tvdb: cell(r, 'tvdb') });
    const title = cell(r, 'title') || 'Sans titre';
    const key = kind + ':' + (ids.tmdb ?? ids.imdb ?? ids.tvdb ?? title);
    const g = groups.get(key) ?? { kind, status: cell(r, 'status') || 'completed', ids, title, year: yearOf(cell(r, 'year')), at: 0, episodes: [] };
    g.at = Math.max(g.at, timeOf(cell(r, 'at')));
    const season = num(cell(r, 'season'));
    const episode = num(cell(r, 'episode'));
    if (season !== undefined && season > 0 && episode !== undefined && episode > 0) g.episodes.push({ season, episode });
    groups.set(key, g);
  }
  return [...groups.values()].flatMap((g) => entryItems(g.kind, g.status, { ids: g.ids, title: g.title, year: g.year, animeMovie: g.kind === 'anime' && /movie/i.test(g.status) }, g.at, g.episodes));
}

/** Lit un export Simkl (texte du fichier : JSON ou CSV). */
export function parseSimklExport(text: string): MigrationBundle {
  let items: MigrationItem[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json: unknown = JSON.parse(trimmed);
      if (isObject(json)) items = parseJson(json);
    } catch { /* JSON illisible : signalé ci-dessous */ }
  } else {
    items = parseCsvItems(text);
  }
  return { source: 'simkl', items, addons: [], notes: items.length ? [] : ['Aucun film, série ni anime Simkl reconnu dans ce fichier.'] };
}
