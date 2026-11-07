/** Règle « sorti » : sauf Prochainement, Calendrier et cartes « Bientôt », seuls les titres disponibles sont montrés. */

export interface ReleaseRegion {
  iso_3166_1: string;
  release_dates: Array<{ type: number; release_date: string }>;
}

export interface Availability {
  /** Le film peut être regardé : un fournisseur dans la région, ou une sortie numérique / physique / télé passée. */
  available: boolean;
  /** Film uniquement en salle : date de sortie en salle (déjà passée). */
  cinemaSince: string | null;
}

/** Une date de sortie (AAAA-MM-JJ) est passée ou aujourd'hui ; vide : inconnue, donc non sortie. */
export const releasedByDate = (date: string | null | undefined, today: string): boolean => !!date && String(date).slice(0, 10) <= today;

/** Au moins un fournisseur dans la région : abonnement, gratuit, publicité, location ou achat. */
export function hasProviders(providers: { results?: Record<string, Record<string, unknown[]>> } | null | undefined, region: string): boolean {
  const r = providers?.results?.[region];
  if (!r) return false;
  return ['flatrate', 'free', 'ads', 'rent', 'buy'].some((k) => Array.isArray(r[k]) && r[k].length > 0);
}

const day = (d: string): string => String(d).slice(0, 10);

/**
 * Disponibilité d'un film dans la région : fournisseur, ou sortie numérique (4), physique (5) ou télévision (6) passée.
 * Sans aucune date pour la région, on regarde les États-Unis puis n'importe quelle région ; sans aucune donnée,
 * la date de sortie principale fait foi. Une simple sortie en salle ne suffit pas : le film est alors « au cinéma ».
 */
export function movieAvailability(
  results: ReleaseRegion[] | undefined,
  region: string,
  primary: string | null | undefined,
  today: string,
  providers: boolean,
): Availability {
  const all = results ?? [];
  const own = all.find((r) => r.iso_3166_1 === region)?.release_dates ?? [];
  const usable = own.length ? own : (all.find((r) => r.iso_3166_1 === 'US')?.release_dates ?? all.flatMap((r) => r.release_dates));
  if (!usable.length) return { available: providers || releasedByDate(primary, today), cinemaSince: null };
  const digital = usable.some((r) => [4, 5, 6].includes(r.type) && day(r.release_date) <= today);
  if (providers || digital) return { available: true, cinemaSince: null };
  const theatrical = usable.filter((r) => [1, 2, 3].includes(r.type) && day(r.release_date) <= today).map((r) => day(r.release_date)).sort();
  return { available: false, cinemaSince: theatrical[0] ?? null };
}
