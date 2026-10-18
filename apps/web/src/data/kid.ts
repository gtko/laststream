/** Profil enfant : âge minimal déduit des classifications TMDB (release_dates / content_ratings) de la région. */

const TEXT_AGES: Record<string, number> = {
  // France, Suisse, Luxembourg, Belgique
  U: 0, TP: 0, ALL: 0, AL: 0, AT: 0, 'TOUS PUBLICS': 0, 'TOUT PUBLIC': 0, KT: 0, KIJKWIJZER: 0,
  // États-Unis / Canada
  G: 0, 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, PG: 8, 'TV-PG': 8, 'PG-13': 13, 'TV-14': 14, '14A': 14,
  '18A': 18, R: 17, 'NC-17': 18, 'TV-MA': 18, X: 18, A: 18,
};

/** Âge minimal (ans) d'une classification, ou null si elle est vide ou inconnue. */
export function certAge(cert: string | null | undefined): number | null {
  const c = String(cert ?? '').trim().toUpperCase().replace(/^[-+]/, '');
  if (!c) return null;
  if (/^\d{1,2}\+?$/.test(c)) return Number(c.replace('+', ''));
  const m = /^(?:FSK|BBFC|ESRB)[ -]?(\d{1,2})$/.exec(c);
  if (m) return Number(m[1]);
  return c in TEXT_AGES ? TEXT_AGES[c] : null;
}

/**
 * Un titre est autorisé si sa classification est connue et ne dépasse pas l'âge du profil.
 * Classification absente ou inconnue : refusé (un profil enfant reste prudent).
 */
export function kidAllows(cert: string | null | undefined, maxAge: number): boolean {
  const age = certAge(cert);
  return age !== null && age <= maxAge;
}

/** Genres jeunesse TMDB : Animation 16, Famille 10751, Kids 10762 (séries). */
export const KID_GENRES: readonly number[] = [16, 10751, 10762];

/** Un titre ne passe que s'il a au moins un genre jeunesse (genres inconnus : refusé). */
export const kidGenreOk = (ids: readonly number[] | null | undefined): boolean =>
  !!ids && ids.some((g) => KID_GENRES.includes(g));

/**
 * Valeur `certification.lte` de TMDB pour un âge maximal, par pays (les valeurs sont celles des listes de
 * certifications TMDB du pays). Null : pas de borne connue, le contrôle titre par titre fait foi.
 */
const CERT_LTE: Record<string, Array<[number, string]>> = {
  // [âge maximal du profil, certification TMDB]
  FR: [[10, '10'], [12, '12'], [16, '16'], [18, '18']],
  CH: [[10, '10'], [12, '12'], [16, '16'], [18, '18']],
  BE: [[10, '9'], [12, '12'], [16, '16'], [18, '16']],
  LU: [[10, '6'], [12, '12'], [16, '16'], [18, '18']],
  CA: [[10, 'PG'], [12, 'PG'], [16, '14A'], [18, '18A']],
};

export function certLteFor(region: string, maxAge: number): string | null {
  const table = CERT_LTE[region.toUpperCase()];
  if (!table) return null;
  return (table.find(([age]) => maxAge <= age) ?? table[table.length - 1])[1];
}

/** Sections du catalogue enfant que le parent peut activer. `tv` (TV jeunesse) est désactivée par défaut. */
export const KID_SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['dessins', 'Dessins animés'],
  ['famille', 'Films en famille'],
  ['series', 'Séries jeunesse'],
  ['disney', 'Classiques Disney et Pixar'],
  ['anime', 'Animés pour les jeunes'],
  ['nouveautes', 'Nouveautés jeunesse'],
  ['plateformes', 'Plateformes (Disney+, Netflix)'],
  ['tv', 'TV jeunesse'],
];

/** Liste vide = tout sauf la TV jeunesse ; sinon seulement les sections cochées. */
export function sectionAllowed(allowed: readonly string[] | null | undefined, id: string): boolean {
  if (!allowed || allowed.length === 0) return id !== 'tv';
  return allowed.includes(id);
}
