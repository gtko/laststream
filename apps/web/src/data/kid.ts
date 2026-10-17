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
