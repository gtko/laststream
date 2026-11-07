/* Rangée d'accueil « Tes chaînes favorites » : le programme en cours (à défaut le suivant, s'il commence bientôt) de chaque
 * chaîne mise en favori. Logique pure, testée. */
import type { Airing, EpgProgram, GuideChannel } from './shows';

/** Une chaîne favorite et ses programmes connus (guide de la fenêtre courante). */
export interface FavSource {
  channel: GuideChannel;
  progs: readonly EpgProgram[];
}

/** Au-delà de ce délai, le programme suivant n'est pas montré : la carte parlerait d'une heure trop lointaine. */
const NEXT_WITHIN_SEC = 3 * 3600;
export const FAV_ROW_MAX = 16;

/**
 * Une carte par favori, dans l'ordre reçu : programme en cours, sinon le suivant s'il démarre dans les 3 h ; une chaîne
 * sans programme connu est écartée (la carte serait vide). Au plus `max` cartes.
 */
export function favAirings(sources: readonly FavSource[], now: number, max = FAV_ROW_MAX): Airing[] {
  const out: Airing[] = [];
  for (const { channel, progs } of sources) {
    if (out.length >= max) break;
    const sorted = [...progs].sort((a, b) => a.start - b.start);
    const p = sorted.find((x) => x.start <= now && now < x.stop) ?? sorted.find((x) => x.start >= now && x.start - now <= NEXT_WITHIN_SEC);
    if (!p) continue;
    out.push({ channel, start: p.start, stop: p.stop, title: p.title, desc: p.desc ?? '', icon: p.icon ?? '', category: p.category ?? '' });
  }
  return out;
}
