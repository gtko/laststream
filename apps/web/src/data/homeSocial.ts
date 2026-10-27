import type { MediaKind } from '@laststream/protocol/social';
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

let eveningSource: () => readonly Evening[] = () => [];
let eveningJoin: (id: string) => Promise<boolean> | boolean = () => false;

/** Branche la source des soirées proposées (vide tant que le serveur n'en sert pas). */
export function setEveningSource(fn: () => readonly Evening[]): void {
  eveningSource = fn;
}

/** Branche l'action « Je viens » ; elle rend vrai si l'inscription a réussi. */
export function setEveningJoin(fn: (id: string) => Promise<boolean> | boolean): void {
  eveningJoin = fn;
}

export const joinEvening = (id: string): Promise<boolean> => Promise.resolve(eveningJoin(id));

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
