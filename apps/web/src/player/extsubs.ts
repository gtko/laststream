import { langName, normalizeLang, type SubtitleTrack } from './tracks';

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
    const s = raw as { id?: unknown; url?: unknown; lang?: unknown } | null;
    if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) return;
    const lang = normalizeLang(typeof s.lang === 'string' ? s.lang : '');
    out.push({
      id: 'x:' + source + ':' + (typeof s.id === 'string' || typeof s.id === 'number' ? String(s.id) : i), lang, codec: '', forced: false,
      origin: 'external', renderable: true, url: s.url, selected: false, source,
      label: lang ? langName(lang) : typeof s.lang === 'string' ? s.lang : 'Sous-titres',
    });
  });
  return out;
}

/** Fusionne sans doublon d'URL, langue préférée d'abord, au plus `perLang` pistes par langue. */
export function mergeExternal(lists: ReadonlyArray<readonly SubtitleTrack[]>, preferredLang: string, perLang = 4): SubtitleTrack[] {
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
  // Numérote les pistes d'une même langue : « Français 2 ».
  const sorted = merged.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map(({ t }) => t);
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
  return mergeExternal([normalizeExternal(addon, 'lastAddon'), normalizeExternal(open, 'OpenSubtitles')], preferredLang);
}
