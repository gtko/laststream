import type { FriendView, Watching } from './socialV2Api';

/* « Regarder avec lui » et contexte cliquable des messages (Social v2, lot 3a). Le module est pur sauf l'appel de la
 * lecture, injecté : la lecture passe par le flux normal du lecteur (playBest) avec la source de l'utilisateur, jamais
 * celle de l'ami. Position de départ : `resumePosition`. Aucun texte n'est affiché ici (les messages d'erreur sont
 * renvoyés à l'appelant, qui les affiche avec textContent). */

/** Cible de lecture au format du lecteur (`request` de playBest) : type « tv » pour une série. */
export interface PlayRequest {
  type: 'movie' | 'tv';
  id: string;
  name: string;
  season: number | null;
  episode: number | null;
  key: string;
  imdb?: string;
}

/** Relevé d'un ami, tel que `resumePosition` le lit. */
export type WatchPoint = Pick<Watching, 'pos' | 'duration' | 'paused' | 'at'>;

/**
 * `resume: 'none'` ignore la progression propre de l'utilisateur. `startAt` est la position de départ (secondes), ou le
 * relevé de l'ami : sa position est alors estimée au moment où le lecteur démarre (`resumePosition`), pas au clic.
 */
interface PlayOpts {
  resume: 'none';
  startAt: number | WatchPoint;
}

type Launch = (request: PlayRequest, opener: Element | null, opts: PlayOpts) => unknown;

/** Média référencé par un relevé de lecture ou un contexte de message. */
export interface MediaRef {
  type: 'movie' | 'series';
  tmdbId: number;
  title?: string;
  imdbId?: string;
  season?: number;
  episode?: number;
}

export interface PlaybackDeps {
  launch: Launch;
  toast: (msg: string) => void;
}

export const LAUNCH_ERROR = 'Impossible de lancer la lecture.';
export const NOT_OPENABLE = 'Ce passage ne peut pas être ouvert : numéro d’épisode inconnu.';

/**
 * Position à reprendre pour regarder comme l'ami : relevé + temps écoulé depuis `at` si la lecture n'est pas en pause.
 * Bornée à [0, durée − 5 s] quand la durée est connue. Un relevé daté du futur n'avance pas la position.
 */
export function resumePosition(w: Pick<Watching, 'pos' | 'duration' | 'paused' | 'at'>, nowMs: number): number {
  const base = Number.isFinite(w.pos) ? w.pos : 0;
  const elapsed = !w.paused && Number.isFinite(w.at) && Number.isFinite(nowMs) ? Math.max(0, nowMs - w.at) / 1000 : 0;
  let pos = Math.max(0, base + elapsed);
  const duration = w.duration;
  if (duration !== undefined && Number.isFinite(duration) && duration > 0) pos = Math.min(pos, Math.max(0, duration - 5));
  return pos;
}

/**
 * Cible de lecture d'un média au format du lecteur. Une série sans saison (0 ou plus) ni épisode (1 ou plus) n'a pas de
 * cible : null.
 */
export function playRequestOf(m: MediaRef): PlayRequest | null {
  if (!Number.isInteger(m.tmdbId) || m.tmdbId <= 0) return null;
  const id = String(m.tmdbId);
  if (m.type === 'movie') {
    const movie: PlayRequest = { type: 'movie', id, name: m.title ?? '', season: null, episode: null, key: 'movie:' + id };
    return m.imdbId ? { ...movie, imdb: m.imdbId } : movie;
  }
  const { season, episode } = m;
  if (season === undefined || !Number.isInteger(season) || season < 0) return null;
  if (episode === undefined || !Number.isInteger(episode) || episode < 1) return null;
  const series: PlayRequest = { type: 'tv', id, name: m.title ?? '', season, episode, key: 'tv:' + id };
  return m.imdbId ? { ...series, imdb: m.imdbId } : series;
}

/**
 * Ouvre un média à `startAt` (secondes, ou relevé d'un ami) par le flux normal. Renvoie false (et affiche un toast) si le
 * média n'a pas de cible. Une erreur de lancement, synchrone ou non, affiche un toast ; elle ne remonte pas.
 */
export function playAt(deps: PlaybackDeps, media: MediaRef, startAt: number | WatchPoint, opener: Element | null = null): boolean {
  const request = playRequestOf(media);
  if (!request) {
    deps.toast(NOT_OPENABLE);
    return false;
  }
  const start = typeof startAt === 'number' ? (Number.isFinite(startAt) && startAt > 0 ? startAt : 0) : startAt;
  try {
    const started = deps.launch(request, opener, { resume: 'none', startAt: start });
    Promise.resolve(started).catch(() => deps.toast(LAUNCH_ERROR));
  } catch {
    deps.toast(LAUNCH_ERROR);
    return false;
  }
  return true;
}

/**
 * Handler de « Regarder avec lui » (setWatchWithHandler) : `friend` est la fiche de l'ami, ou null si elle a disparu.
 * Sans relevé de lecture, un toast le dit ; sinon le même titre ou épisode part. Le relevé est transmis tel quel : la
 * position n'est estimée qu'au démarrage effectif, après le chargement des sources.
 */
export function createWatchWithHandler(deps: PlaybackDeps): (friend: FriendView | null) => void {
  return (friend) => {
    const name = friend?.handle?.name || 'Cet ami';
    const w = friend?.watching;
    if (!w) {
      deps.toast(name + ' ne regarde rien pour le moment.');
      return;
    }
    const point: WatchPoint = { pos: w.pos, at: w.at, paused: w.paused, duration: w.duration };
    playAt(deps, { type: w.type, tmdbId: w.tmdbId, title: w.title, imdbId: w.imdbId, season: w.season, episode: w.episode }, point, null);
  };
}
