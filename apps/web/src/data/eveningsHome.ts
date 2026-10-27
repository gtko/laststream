import { friendName, setEveningJoin, setEveningSource, type Evening as HomeEvening } from './homeSocial';
import { answerEvening, getEveningList, loadEvenings } from './eveningsStore';
import type { Evening } from './socialV3Api';

/* Soirées planifiées sur l'accueil (LAST-199) : branche les soirées à venir du magasin sur « Ensemble, ce soir » de l'accueil
 * (homeSocial.ts) et l'action « Je viens » sur la vraie réponse. Le cache est celui du magasin (EVENINGS_MAX_AGE_MS) ; les trames
 * le tiennent à jour. */

/** Au-delà, une soirée n'est plus « proposée » sur l'accueil. */
const HORIZON_MS = 7 * 24 * 3600 * 1000;
/** Nombre maximal de soirées sur l'accueil. */
const HOME_MAX = 4;

/** Soirées de l'accueil : à venir dans la semaine, ni annulées ni refusées ; `going` : ceux qui viennent. */
export function toHomeEvenings(items: readonly Evening[], now: number = Date.now()): HomeEvening[] {
  return items
    .filter((e) => e.status === 'scheduled' && e.myResponse !== 'no' && e.startsAt >= now && e.startsAt - now <= HORIZON_MS)
    .sort((a, b) => a.startsAt - b.startsAt)
    .slice(0, HOME_MAX)
    .map((e) => ({
      id: e.id,
      startsAt: e.startsAt,
      title: e.title,
      host: e.isHost ? undefined : friendName(e.host),
      going: e.guests.filter((g) => g.response === 'yes').map((g) => g.profile.pid),
      joinable: !e.isHost && e.myResponse !== 'yes',
    }));
}

/** Enregistre la source et l'action « Je viens » (idempotent). */
export function connectHomeEvenings(): void {
  setEveningSource(() => toHomeEvenings(getEveningList('upcoming').items));
  setEveningJoin((id) => answerEvening(id, 'yes'));
}

/** Lit les soirées à venir si le cache n'est plus frais. */
export const loadHomeEvenings = (): Promise<void> => loadEvenings('upcoming');
