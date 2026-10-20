/* Progression de lecture : cadence d'enregistrement, reprise, seuil « vu ». Fonctions pures, testées. */

const SAVE_EVERY_MS = 10_000;
const WATCHED_RATIO = 0.9;
const RESUME_MIN_RATIO = 0.02;
const RESUME_MAX_RATIO = 0.95;

export function shouldSave(now: number, lastSavedAt: number, force: boolean, duration: number): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  return force || now - lastSavedAt >= SAVE_EVERY_MS;
}

export function isWatched(position: number, duration: number): boolean {
  return duration > 0 && position / duration >= WATCHED_RATIO;
}

export interface ResumeDecision {
  /** Proposer « Reprendre à … » / « Recommencer ». */
  prompt: boolean;
  position: number;
}

/** Une position enregistrée entre 2 % et 95 % de la durée (et au moins 30 s) mérite une proposition de reprise. */
export function resumeDecision(saved: { position: number; duration: number } | null | undefined, duration = saved?.duration ?? 0): ResumeDecision {
  if (!saved || !(saved.duration > 0)) return { prompt: false, position: 0 };
  const ratio = saved.position / saved.duration;
  const ok = ratio >= RESUME_MIN_RATIO && ratio < RESUME_MAX_RATIO && saved.position >= 30;
  return { prompt: ok, position: ok ? Math.min(saved.position, Math.max(0, (duration || saved.duration) - 5)) : 0 };
}

/** 1:02:03 ou 23:14. */
export function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
}

/** Fin de la plage tamponnée qui contient `time` (secondes), ou `time` si rien n'est tamponné autour. */
export function bufferedEnd(ranges: ReadonlyArray<readonly [number, number]>, time: number): number {
  for (const [s, e] of ranges) if (time >= s - 0.3 && time <= e) return e;
  return time;
}

export interface EpisodeRef { season: number; episode: number }

/** Épisode suivant dans la liste ordonnée des saisons `{season, count}` (saison 0 ignorée), ou null en fin de série. */
export function nextEpisode(seasons: ReadonlyArray<{ season: number; count: number }>, cur: EpisodeRef): EpisodeRef | null {
  const list = seasons.filter((s) => s.season > 0 && s.count > 0).sort((a, b) => a.season - b.season);
  const i = list.findIndex((s) => s.season === cur.season);
  if (i < 0) return null;
  if (cur.episode < list[i].count) return { season: cur.season, episode: cur.episode + 1 };
  const n = list[i + 1];
  return n ? { season: n.season, episode: 1 } : null;
}
