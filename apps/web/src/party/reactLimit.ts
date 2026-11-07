/* Limite d'envoi des réactions de salon (LAST-1615) : une réaction par seconde et par appareil. Au-delà, l'envoi est ignoré sans erreur. */

const PARTY_REACT_GAP_MS = 1000;
let lastSent = Number.NEGATIVE_INFINITY;

/** Créneau d'envoi partagé par le panneau du salon et le « Réagir ici » : `ready` dit si une réaction peut partir, `sent` la prend. */
export const partyReactLimit = {
  ready: (now: number = Date.now()): boolean => now - lastSent >= PARTY_REACT_GAP_MS,
  sent: (now: number = Date.now()): void => { lastSent = now; },
};
