/* État partagé du lecteur : ouvert / réduit en miniature. Module sans dépendance (session.js l'alimente, l'interface le lit).
   « Plein écran » = ouvert et non réduit : seul cet état masque le fond et coupe les bandes-annonces. */

export interface PlayerState { open: boolean; mini: boolean }

let state: PlayerState = { open: false, mini: false };
const listeners = new Set<(s: PlayerState) => void>();

export const get = (): PlayerState => ({ ...state });

/** Met à jour l'état ; n'avertit que d'un vrai changement. Émet aussi `lsplayer:state` sur window. */
export function set(patch: Partial<PlayerState>): void {
  const next = { ...state, ...patch };
  if (next.open === state.open && next.mini === state.mini) return;
  state = next;
  const snap = get();
  listeners.forEach((fn) => { try { fn(snap); } catch (_) { /* un abonné fautif n'empêche pas les autres */ } });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lsplayer:state', { detail: snap }));
}

/** Abonnement ; renvoie la fonction de désabonnement. */
export function onChange(fn: (s: PlayerState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Plein écran : le lecteur couvre la fenêtre. */
export const isFull = (): boolean => state.open && !state.mini;
/** Aperçus (survol, carrousel, mises en avant muettes) : permis tant que le lecteur ne couvre pas la page (miniature comprise). */
export const trailersAllowed = (): boolean => !isFull();
/** Bande-annonce de la fiche : en pause dès que le lecteur est ouvert, miniature comprise. */
export const fullTrailerAllowed = (): boolean => !state.open;
