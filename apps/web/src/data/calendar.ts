/** Calendrier des suivis : grille du mois, libellés de sortie, regroupement par jour. */

import { pad2 } from './format';

export interface CalEvent {
  /** AAAA-MM-JJ. */
  date: string;
  kind: 'episode' | 'movie' | 'person' | 'airing';
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
  /** Diffusions TV : horodatage de début (tri dans la journée), identifiant de l'émission. */
  start?: number;
  showId?: number;
  channelId?: string | null;
}

export const isoDate = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

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
function releaseLabel(type: number): string {
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
  [...events].sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0) || a.title.localeCompare(b.title, 'fr')).forEach((e) => {
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

// ---------- Page Calendrier : logique pure (affichage, sélection, statuts) ----------

export type CalKind = 'movie' | 'tv' | 'airing' | 'person';

/** Types de sortie, dans l'ordre des filtres : `key` sert aux filtres, `label` au pluriel des pastilles, `name` au singulier des cartes. */
export const CAL_KINDS: ReadonlyArray<{ key: CalKind; label: string; name: string }> = [
  { key: 'movie', label: 'Films', name: 'Film' },
  { key: 'tv', label: 'Séries', name: 'Série' },
  { key: 'airing', label: 'TV', name: 'TV' },
  { key: 'person', label: 'Personnes', name: 'Personne' },
];

/** Type d'affichage d'une sortie : un épisode est une « série », une sortie d'une personne reste « personne ». */
export const kindOfEvent = (e: Pick<CalEvent, 'kind'>): CalKind => (e.kind === 'episode' ? 'tv' : e.kind === 'movie' ? 'movie' : e.kind === 'airing' ? 'airing' : 'person');

/** Nombre de sorties par type (à compter avant le filtrage). */
export function countByKind(events: ReadonlyArray<Pick<CalEvent, 'kind'>>): Record<CalKind, number> {
  const out: Record<CalKind, number> = { movie: 0, tv: 0, airing: 0, person: 0 };
  events.forEach((e) => { out[kindOfEvent(e)] += 1; });
  return out;
}

export const filterByKinds = <T extends Pick<CalEvent, 'kind'>>(events: ReadonlyArray<T>, kinds: ReadonlySet<string>): T[] => events.filter((e) => kinds.has(kindOfEvent(e)));

const DAY = 86_400_000;
const addIso = (iso: string, n: number): string => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const monthBounds = (y: number, m: number): [string, string] => [isoDate(y, m, 1), isoDate(y, m, new Date(y, m, 0).getDate())];

/** Jour sélectionné à l'arrivée sur un mois : aujourd'hui s'il en fait partie, sinon le premier jour avec une sortie, sinon le 1er. */
export function pickSelectedDate(year: number, month: number, events: ReadonlyArray<Pick<CalEvent, 'date'>>, today: string): string {
  const [first, last] = monthBounds(year, month);
  if (today >= first && today <= last) return today;
  const dates = events.map((e) => e.date).filter((d) => d >= first && d <= last).sort();
  return dates[0] ?? first;
}

/**
 * Jour sélectionné après une touche du clavier : flèches ±1 / ±7 jours, Home / End = début / fin de la semaine.
 * Reste dans le mois : une flèche qui en sortirait ne bouge pas (la sélection renvoyée est inchangée).
 */
export function moveSelection(sel: string, key: string, year: number, month: number): string {
  const [first, last] = monthBounds(year, month);
  const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  if (key in step) {
    const t = addIso(sel, step[key]);
    return t < first || t > last ? sel : t;
  }
  if (key === 'Home' || key === 'End') {
    const dow = (new Date(sel + 'T00:00:00Z').getUTCDay() + 6) % 7; // lundi = 0
    const t = addIso(sel, key === 'Home' ? -dow : 6 - dow);
    return t < first ? first : t > last ? last : t;
  }
  return sel;
}

/** Affiches d'une cellule du mois : jusqu'à 3 ; au-delà, 2 affiches et une tuile « +N » (N = total - 2). */
export function cellPreview<T>(events: ReadonlyArray<T>): { shown: T[]; more: number } {
  if (events.length <= 3) return { shown: [...events], more: 0 };
  return { shown: events.slice(0, 2), more: events.length - 2 };
}

/** Points de la mini-grille mobile : un par type présent (3 au plus), `more` si un quatrième existe. */
export function dotKinds(events: ReadonlyArray<Pick<CalEvent, 'kind'>>): { shown: CalKind[]; more: boolean } {
  const kinds = CAL_KINDS.map((k) => k.key).filter((k) => events.some((e) => kindOfEvent(e) === k));
  return { shown: kinds.slice(0, 3), more: kinds.length > 3 };
}

/** « 21 octobre, 4 sorties » : nom accessible d'une cellule. */
export function dayAriaLabel(date: string, count: number): string {
  const d = new Date(date + 'T00:00:00');
  const day = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  return day + ', ' + (count === 0 ? 'aucune sortie' : count + (count > 1 ? ' sorties' : ' sortie'));
}

/** « mercredi 21 octobre » : titre du panneau du jour. */
export const dayTitle = (date: string): string => new Date(date + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/** Deux initiales d'un titre, pour l'affiche absente. */
export const initials = (title: string): string => title.split(/\s+/).filter(Boolean).map((w) => Array.from(w)[0]).join('').slice(0, 2).toUpperCase();

/** Teinte (0-359) stable d'un titre, pour le dégradé de l'affiche absente. */
export function hueOf(title: string): number {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * Pastille de statut d'une sortie selon la date du jour : passé « Sorti », aujourd'hui « Ce soir » (épisode, avec l'heure
 * pour une diffusion TV) ou « Aujourd’hui », futur : `future(date)` (« Demain », « Dans N jours »).
 */
export function eventStatus(e: Pick<CalEvent, 'kind' | 'date' | 'label'>, today: string, future: (iso: string) => string): { text: string; hot: boolean } {
  const time = e.kind === 'airing' ? /^\d{1,2}:\d{2}/.exec(e.label)?.[0] : undefined;
  if (e.date < today) return { text: e.kind === 'airing' ? 'Diffusé' : 'Sorti', hot: false };
  if (e.date === today) {
    if (e.kind === 'airing') return { text: time ? 'Ce soir · ' + time : 'Ce soir', hot: true };
    return e.kind === 'episode' ? { text: 'Ce soir', hot: true } : { text: 'Aujourd’hui', hot: false };
  }
  const when = future(e.date);
  return { text: time ? when + ' · ' + time : when, hot: false };
}

/** Sous-titre d'une carte : « S1 É50 · titre » (titre d'épisode seulement s'il est utile), chaîne pour une diffusion, sinon le libellé. */
export function eventSubtitle(e: Pick<CalEvent, 'kind' | 'label' | 'epTitle' | 'count'>, hasRealEpTitle: boolean): string {
  if (e.kind === 'airing') {
    const channel = e.label.replace(/^\d{1,2}:\d{2}\s*·\s*/, '');
    return channel || e.label;
  }
  if (e.kind === 'episode' && hasRealEpTitle && e.epTitle && (e.count ?? 1) <= 1) return e.label + ' · ' + e.epTitle;
  return e.label;
}
