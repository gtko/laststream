import type { HomeTitleProgress, MediaKind } from '@laststream/protocol/social';
import type { SocialState } from './socialStore';
import type { FriendV3 } from './socialV3Api';

/* Accueil social : amis qui veulent voir un titre et soirée proposée (ligne du héros). Aucun appel réseau : tout vient de l'état du
 * store social (activité reçue en direct, listes partagées déjà chargées). Les soirées planifiées n'existent pas encore côté serveur
 * (LAST-198) : leur source est vide ; le futur client l'enregistre avec setEveningSource sans toucher à l'interface. */

/** Fenêtre d'une envie : un ajout à une liste ou un favori plus ancien n'en est plus une. */
export const WANT_WINDOW_MS = 30 * 24 * 3600 * 1000;
const WANT_KINDS: readonly string[] = ['listed', 'favorited'];

/** Soirée proposée sur un titre ; `going` : pid des amis déjà inscrits. */
export interface Evening {
  id: string;
  type: MediaKind;
  tmdbId: number;
  startsAt: number;
  going?: readonly string[];
  /** Habillage de la carte « Ensemble, ce soir » ; absents, la carte reste neutre. */
  title?: string;
  poster?: string;
  host?: string;
}

type EveningJoin = (id: string) => Promise<boolean> | boolean;

let eveningSource: () => readonly Evening[] = () => [];
let eveningJoin: EveningJoin | null = null;

/** Branche la source des soirées proposées (vide tant que le serveur n'en sert pas). */
export function setEveningSource(fn: () => readonly Evening[]): void {
  eveningSource = fn;
}

/** Branche l'action « Je viens » ; elle rend vrai si l'inscription a réussi. `null` la débranche. */
export function setEveningJoin(fn: EveningJoin | null): void {
  eveningJoin = fn;
}

/** Vrai si une action « Je viens » est branchée : sans elle, aucun bouton d'inscription n'est proposé. */
export const hasEveningJoin = (): boolean => eveningJoin !== null;

export const joinEvening = (id: string): Promise<boolean> => Promise.resolve(eveningJoin ? eveningJoin(id) : false);

/** Soirées à venir (pas encore commencées), la plus proche d'abord. */
export const upcomingEvenings = (now: number = Date.now()): Evening[] =>
  eveningSource().filter((e) => e.startsAt >= now).sort((a, b) => a.startsAt - b.startsAt);

/** Prochaine soirée proposée sur ce titre (pas encore commencée), ou null. */
export function eveningFor(type: MediaKind, tmdbId: number, now: number = Date.now()): Evening | null {
  const next = eveningSource()
    .filter((e) => e.type === type && e.tmdbId === tmdbId && e.startsAt >= now)
    .sort((a, b) => a.startsAt - b.startsAt)[0];
  return next ?? null;
}

/** Nom affiché d'un ami : le surnom privé, sinon le nom. */
export const friendName = (f: Pick<FriendV3, 'nickname' | 'handle'>): string => f.nickname || f.handle.name;

/**
 * Amis qui veulent voir ce titre : ils l'ont ajouté à une liste ou en favori (activité des 30 derniers jours), l'ont mis dans une
 * liste partagée, ou sont inscrits à sa soirée. Amis acceptés seulement, sans les relations en sourdine ; ordre alphabétique.
 */
export function wantersOf(s: SocialState, type: MediaKind, tmdbId: number, now: number = Date.now()): FriendV3[] {
  const friends = new Map(s.friends.filter((f) => !f.muted).map((f) => [f.pid, f]));
  const pids = new Set<string>();
  for (const a of s.activity) {
    if (WANT_KINDS.includes(a.kind) && a.media.type === type && a.media.tmdbId === tmdbId && now - a.at <= WANT_WINDOW_MS) pids.add(a.pid);
  }
  for (const d of Object.values(s.listDetails)) {
    for (const it of d.items) if (it.type === type && it.tmdbId === tmdbId) pids.add(it.addedBy);
  }
  eveningFor(type, tmdbId, now)?.going?.forEach((pid) => pids.add(pid));
  return [...pids]
    .map((pid) => friends.get(pid))
    .filter((f): f is FriendV3 => !!f)
    .sort((a, b) => friendName(a).localeCompare(friendName(b), 'fr'));
}

/** Noms en gras attendus par l'appelant : « Léa », « Léa et Tom », « Léa, Tom et Sam », « Léa, Tom, Sam et 2 autres ». */
export function wantNames(names: readonly string[]): { shown: string[]; more: number } {
  return names.length > 3 ? { shown: names.slice(0, 3), more: names.length - 3 } : { shown: [...names], more: 0 };
}

/** Verbe qui suit les noms : « veut le voir » pour un seul ami, « veulent le voir » sinon. */
export const wantVerb = (count: number): string => (count > 1 ? 'veulent le voir' : 'veut le voir');

/** Heure d'une soirée : « 21 h », « 21 h 30 ». */
export function eveningTime(ts: number): string {
  const d = new Date(ts);
  const m = d.getMinutes();
  return `${d.getHours()} h${m ? ' ' + String(m).padStart(2, '0') : ''}`;
}

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Jour d'une soirée pour son étiquette : « Ce soir » le jour même, « Demain », puis le jour de la semaine (ou la date au-delà d'une semaine). */
export function eveningDay(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const days = Math.round((dayStart(d) - dayStart(new Date(now))) / 86_400_000);
  if (days <= 0) return 'Ce soir';
  if (days === 1) return 'Demain';
  if (days < 7) return WEEKDAYS[d.getDay()];
  return d.getDate() + '/' + String(d.getMonth() + 1).padStart(2, '0');
}

/** Ma progression sur un titre de « Reprendre la lecture » (`suggested` : épisode proposé, pas encore commencé). */
export interface MineProgress {
  kind: MediaKind;
  season?: number | null;
  episode?: number | null;
  position: number;
  duration?: number;
  finished?: boolean;
  suggested?: boolean;
}

/** Avance d'un ami sur un titre : repère sur la barre (0 à 100, absent hors du même épisode ou plus loin) et mention. */
export interface FriendAhead {
  friend: HomeTitleProgress['friend'];
  marker: number | null;
  text: string;
}

const fraction = (pos: number, duration: number | undefined, finished: boolean | undefined): number =>
  finished ? 1 : duration && duration > 0 ? Math.max(0, Math.min(1, pos / duration)) : 0;

/**
 * Où en est l'ami le plus avancé sur ce titre, par rapport à moi. `items` : réponses de /home/progress pour ce titre (un ami en
 * sourdine ne compte pas). Rend null si aucun ami n'a ce titre. Série : écart en numéros d'épisode dans la même saison
 * (« Léa a 2 épisodes d'avance »), repère à sa position si c'est le même épisode, en fin de barre s'il est plus loin ; film :
 * repère à sa position, sans mention. Un ami en retard n'a ni repère ni mention.
 */
export function friendAhead(mine: MineProgress, items: readonly HomeTitleProgress[], muted: ReadonlySet<string> = new Set()): FriendAhead | null {
  const list = items.filter((i) => i.type === mine.kind && !muted.has(i.friend.pid));
  if (!list.length) return null;
  const mSeason = mine.season ?? 0;
  const mEp = mine.episode ?? 1;
  // Épisode « en cours » et fraction vue : un épisode terminé compte comme le suivant, pas commencé.
  const here = (ep: number, pos: number, duration: number | undefined, finished: boolean | undefined): [number, number] =>
    finished ? [ep + 1, 0] : [ep, fraction(pos, duration, false)];
  const [mEpisode] = mine.suggested ? [mEp] : here(mEp, mine.position, mine.duration, mine.finished);
  const rank = (i: HomeTitleProgress): [number, number, number] => {
    if (mine.kind !== 'series') return [0, 0, fraction(i.pos, i.duration, i.finished)];
    const [ep, frac] = here(i.episode ?? mEp, i.pos, i.duration, i.finished);
    return [i.season ?? mSeason, ep, frac];
  };
  const best = list.reduce((a, b) => {
    const [as, ae, af] = rank(a);
    const [bs, be, bf] = rank(b);
    return bs !== as ? (bs > as ? b : a) : be !== ae ? (be > ae ? b : a) : bf > af ? b : a;
  });
  const [fSeason, fEpisode, fFrac] = rank(best);
  if (mine.kind !== 'series') return { friend: best.friend, marker: Math.round(fFrac * 100), text: '' };
  const name = friendName(best.friend);
  if (fSeason < mSeason) return { friend: best.friend, marker: null, text: '' };
  if (fSeason > mSeason) return { friend: best.friend, marker: 100, text: `${name} est à S${fSeason} · É${fEpisode}` };
  const gap = fEpisode - mEpisode;
  const marker = gap === 0 ? Math.round(fFrac * 100) : gap > 0 ? 100 : null;
  return { friend: best.friend, marker, text: gap >= 1 ? `${name} a ${gap} épisode${gap > 1 ? 's' : ''} d'avance` : '' };
}

/** Mention d'un titre que personne d'autre n'a commencé. */
export const NOBODY_ELSE = "Personne d'autre ne l'a commencé";
