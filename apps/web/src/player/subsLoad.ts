/* Garde du chargement des sous-titres externes : un seul chargement à la fois, lié à la source (vue) courante. Logique pure, testée. */

export interface SubsLoadState {
  loading: boolean;
  loadedFor: number | null;
  /** Numéro du dernier chargement lancé ou invalidé : un chargement dont le numéro a changé est périmé. */
  loadSeq: number;
}

/** Démarre un chargement pour la vue `viewIndex` ; `null` si un chargement est en cours ou si cette vue est déjà chargée (hors `force`). */
export function beginSubsLoad(s: SubsLoadState, viewIndex: number, force?: boolean): number | null {
  if (s.loading || (!force && s.loadedFor === viewIndex)) return null;
  s.loading = true;
  s.loadSeq += 1;
  return s.loadSeq;
}

/** Le chargement `seq` est toujours le dernier : son résultat peut être appliqué. */
export function isCurrentSubsLoad(s: SubsLoadState, seq: number): boolean {
  return s.loadSeq === seq;
}

/** Fin du chargement `seq` ; `false` (rien changé) s'il est périmé, pour ne pas libérer la garde d'un chargement plus récent. */
export function endSubsLoad(s: SubsLoadState, seq: number): boolean {
  if (s.loadSeq !== seq) return false;
  s.loading = false;
  return true;
}

/** Changement de source : invalide le chargement en cours (son résultat est jeté) et libère la garde pour la nouvelle vue. */
export function resetSubsLoad(s: SubsLoadState): void {
  s.loading = false;
  s.loadedFor = null;
  s.loadSeq += 1;
}
