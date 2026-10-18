import { langName, normalizeLang, type SubtitleTrack } from './tracks';

/** Mots d'un nom de release (« Show.S01E03.1080p.WEB-DL.x264-GRP » → show, s01e03, 1080p, web, dl, x264, grp). */
export function releaseTokens(name: string): string[] {
  return name.toLowerCase().replace(/\.(srt|ass|ssa|vtt|sub|mkv|mp4|avi)$/i, '').split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

/** Ressemblance (0 à 1) entre le nom du fichier vidéo et celui de la release du sous-titre (indice de Jaccard sur les mots). */
export function releaseSimilarity(a: string, b: string): number {
  const x = new Set(releaseTokens(a));
  const y = new Set(releaseTokens(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  x.forEach((t) => { if (y.has(t)) inter++; });
  return inter / (x.size + y.size - inter);
}

/* Sous-titres externes : réponses des ressources `subtitles` Stremio (lastAddon, OpenSubtitles) → pistes.
 * Fonctions pures pour la normalisation, deux appels réseau tolérants aux pannes. */

export const OPENSUBTITLES_BASE = 'https://opensubtitles-v3.strem.io';

export interface ExternalSubtitleQuery {
  type: 'movie' | 'series';
  /** `tt…` ou `tt…:saison:épisode`. */
  id: string;
  hash?: string | null;
  size?: number | null;
  filename?: string;
}

export function openSubtitlesUrl(q: ExternalSubtitleQuery): string {
  const extra: string[] = [];
  if (q.hash) extra.push('videoHash=' + encodeURIComponent(q.hash));
  if (q.size) extra.push('videoSize=' + q.size);
  if (q.filename) extra.push('filename=' + encodeURIComponent(q.filename));
  return OPENSUBTITLES_BASE + '/subtitles/' + q.type + '/' + encodeURIComponent(q.id) + (extra.length ? '/' + extra.join('&') : '') + '.json';
}

/** Pistes d'une réponse `{ subtitles: [{ id, url, lang }] }` ; les entrées sans URL http(s) sont ignorées. */
export function normalizeExternal(resp: unknown, source: string): SubtitleTrack[] {
  const list = (resp as { subtitles?: unknown } | null)?.subtitles;
  if (!Array.isArray(list)) return [];
  const out: Array<SubtitleTrack & { source: string }> = [];
  list.forEach((raw, i) => {
    const s = raw as { id?: unknown; url?: unknown; lang?: unknown; m?: unknown; moviehash_match?: unknown; release?: unknown; filename?: unknown; SubFileName?: unknown; downloads?: unknown; rating?: unknown } | null;
    if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) return;
    const lang = normalizeLang(typeof s.lang === 'string' ? s.lang : '');
    const release = [s.release, s.filename, s.SubFileName].find((x): x is string => typeof x === 'string' && x !== '') ?? '';
    // Les réponses OpenSubtitles marquent `m: 'h'` / `moviehash_match` quand le sous-titre vient d'une empreinte de fichier.
    const hashMatch = s.moviehash_match === true || s.moviehash_match === 1 || s.m === 'h' || s.m === 'hash';
    out.push({
      id: 'x:' + source + ':' + (typeof s.id === 'string' || typeof s.id === 'number' ? String(s.id) : i), lang, codec: '', forced: false,
      origin: 'external', renderable: true, url: s.url, selected: false, source, release, hashMatch,
      downloads: typeof s.downloads === 'number' ? s.downloads : undefined, rating: typeof s.rating === 'number' ? s.rating : undefined,
      label: lang ? langName(lang) : typeof s.lang === 'string' ? s.lang : 'Sous-titres',
    });
  });
  return out;
}

/** Fusionne sans doublon d'URL, langue préférée d'abord, au plus `perLang` pistes par langue. */
export function mergeExternal(lists: ReadonlyArray<readonly SubtitleTrack[]>, preferredLang: string, perLang = 4, filename = ''): SubtitleTrack[] {
  const seen = new Set<string>();
  const count = new Map<string, number>();
  const merged: SubtitleTrack[] = [];
  for (const l of lists) {
    for (const t of l) {
      if (!t.url || seen.has(t.url)) continue;
      const n = count.get(t.lang) ?? 0;
      if (n >= perLang) continue;
      seen.add(t.url);
      count.set(t.lang, n + 1);
      merged.push(t);
    }
  }
  const pref = normalizeLang(preferredLang);
  const rank = (t: SubtitleTrack): number => (t.lang === pref ? 0 : t.lang === '' ? 2 : 1);
  // À langue égale : empreinte du fichier d'abord, puis nom de release le plus proche, puis popularité.
  const quality = (t: SubtitleTrack): number => (t.hashMatch ? 10 : 0) + (filename && t.release ? releaseSimilarity(filename, t.release) * 5 : 0) + Math.min(1, (t.downloads ?? 0) / 100000);
  // Numérote les pistes d'une même langue : « Français 2 ».
  const sorted = merged.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || quality(b.t) - quality(a.t) || a.i - b.i).map(({ t }) => t);
  const seq = new Map<string, number>();
  return sorted.map((t) => {
    const k = (seq.get(t.lang) ?? 0) + 1;
    seq.set(t.lang, k);
    return (count.get(t.lang) ?? 0) > 1 ? { ...t, label: t.label + ' ' + k } : t;
  });
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Interroge lastAddon (s'il propose des sous-titres) et OpenSubtitles. Ne rejette jamais. */
export async function fetchExternalSubtitles(q: ExternalSubtitleQuery, addonSubtitlesUrl: string | null, preferredLang: string): Promise<SubtitleTrack[]> {
  const [addon, open] = await Promise.all([
    addonSubtitlesUrl ? getJson(addonSubtitlesUrl, 8000) : Promise.resolve(null),
    getJson(openSubtitlesUrl(q), 10_000),
  ]);
  return mergeExternal([normalizeExternal(addon, 'lastAddon'), normalizeExternal(open, 'OpenSubtitles')], preferredLang, 4, q.filename ?? '');
}
