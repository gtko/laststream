/** Calendrier des suivis : grille du mois, libellés de sortie, regroupement par jour. */

export interface CalEvent {
  /** AAAA-MM-JJ. */
  date: string;
  kind: 'episode' | 'movie' | 'person';
  /** Clé du titre à ouvrir (`tv:1399`, `movie:550`). */
  key: string;
  title: string;
  poster: string;
  /** « S2 É5 », « Au cinéma », « En streaming », « Dans {nom} ». */
  label: string;
  /** Plusieurs épisodes le même jour : nombre. */
  count?: number;
  /** Épisodes : détails pour la carte « Bientôt ». */
  season?: number;
  episode?: number;
  epTitle?: string;
  backdrop?: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');
export const isoDate = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** Grille du mois (semaines du lundi au dimanche). `month` de 1 à 12. */
export function monthGrid(year: number, month: number): Array<Array<{ date: string; inMonth: boolean }>> {
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7; // lundi = 0
  const start = new Date(year, month - 1, 1 - lead);
  const days = Math.ceil((lead + new Date(year, month, 0).getDate()) / 7) * 7;
  const weeks: Array<Array<{ date: string; inMonth: boolean }>> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ date: isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate()), inMonth: d.getMonth() === month - 1 });
  }
  return weeks;
}

export const episodeLabel = (season: number, episode: number): string => `S${season} É${episode}`;

/** Types de sortie TMDB : 1 avant-première, 2 salles (limitée), 3 salles, 4 numérique, 5 physique, 6 télévision. */
export function releaseLabel(type: number): string {
  if (type === 1 || type === 2 || type === 3) return 'Au cinéma';
  if (type === 4) return 'En streaming';
  if (type === 5) return 'En DVD / Blu-ray';
  return 'À la télévision';
}

interface ReleaseResult {
  iso_3166_1: string;
  release_dates: Array<{ type: number; release_date: string }>;
}

/** Sorties d'un film dans le pays : la plus proche pour chaque libellé (cinéma, streaming…). */
export function movieReleases(results: ReleaseResult[] | undefined, region: string, fallback?: string): Array<{ date: string; label: string }> {
  const country = (results ?? []).find((r) => r.iso_3166_1 === region);
  const best = new Map<string, string>();
  (country?.release_dates ?? []).forEach((r) => {
    const date = String(r.release_date || '').slice(0, 10);
    if (!date) return;
    const label = releaseLabel(r.type);
    if (!best.has(label) || date < best.get(label)!) best.set(label, date);
  });
  if (!best.size && fallback) return [{ date: fallback.slice(0, 10), label: 'Au cinéma' }];
  return [...best].map(([label, date]) => ({ label, date })).sort((a, b) => a.date.localeCompare(b.date));
}

export function groupByDate(events: CalEvent[]): Map<string, CalEvent[]> {
  const map = new Map<string, CalEvent[]>();
  [...events].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'fr')).forEach((e) => {
    (map.get(e.date) ?? map.set(e.date, []).get(e.date)!).push(e);
  });
  return map;
}

/** Épisodes d'un même titre le même jour : un seul événement « S2 É5-É7 ». */
export function mergeEpisodes(events: CalEvent[]): CalEvent[] {
  const out: CalEvent[] = [];
  const idx = new Map<string, CalEvent>();
  events.forEach((e) => {
    if (e.kind !== 'episode') { out.push(e); return; }
    const k = e.date + e.key;
    const cur = idx.get(k);
    if (!cur) { const c = { ...e, count: 1 }; idx.set(k, c); out.push(c); }
    else {
      cur.count = (cur.count ?? 1) + 1;
      cur.label = cur.label.replace(/ É\d+(?:–É\d+)?$/, '') + ' É' + (cur.label.match(/É(\d+)/)?.[1] ?? '') + '–É' + (e.label.match(/É(\d+)/)?.[1] ?? '');
    }
  });
  return out;
}
