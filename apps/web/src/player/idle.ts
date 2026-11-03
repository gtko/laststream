// Horloge d'inactivité unique du lecteur (LAST-1613) : commandes, titre, panneau de salle, « regarde aussi » et bulle de message
// partagent la classe `is-ui` de la racine `.lp`, retirée après UI_IDLE_MS sans mouvement, toucher ni touche.

/** Délai d'inactivité avant masquage en fondu de toutes les surcouches du lecteur. */
export const UI_IDLE_MS = 10_000;

/** Surcouches qui retiennent l'affichage tant que la souris les survole. */
export const OVERLAY_HOVER_SELECTOR = '.lp-top, .lp-bottom, .lp-watchchip, .ps-band, .ps-event, .lp-bubble-form, .lp-party';

/** Événement (qui remonte) demandant de réafficher brièvement les surcouches : nouvelle invitation, désynchronisation, message reçu. */
export const WAKE_EVENT = 'lp-wake';

/** Réaffiche les surcouches du lecteur depuis n'importe quel élément monté dans `.lp` (sans effet hors lecteur). */
export function requestWake(from: Element | null | undefined): void {
  from?.dispatchEvent(new Event(WAKE_EVENT, { bubbles: true }));
}

/** Vrai si la saisie (chat, formulaire) a le focus dans le lecteur : on ne masque rien pendant qu'on écrit. */
export function isTypingIn(root: Element, active: Element | null): boolean {
  if (!active || !root.contains(active)) return false;
  return active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(active.type)) || (active as HTMLElement).isContentEditable;
}

/** Le survol ne compte que pour une vraie souris : sur écran tactile `:hover` reste collé au dernier élément touché. */
export function hasMouse(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
}
