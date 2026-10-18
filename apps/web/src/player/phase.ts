/* États du lecteur : CHARGEMENT (recherche, choix, préparation, première image) puis PRÊT. Logique pure, testée. */

export type Phase = 'loading' | 'ready';

/** `open` : nouvelle lecture (ou nouvelle source) ; `media` : le moteur peut montrer une image. */
export type PhaseEvent = 'open' | 'media';

export function nextPhase(cur: Phase, ev: PhaseEvent): Phase {
  if (ev === 'open') return 'loading';
  return cur === 'loading' ? 'ready' : cur;
}

export interface MediaSnapshot {
  duration: number;
  buffering: boolean;
  paused?: boolean;
}

/** Première image prête : durée connue et plus de tampon à remplir (lecture lancée, ou en pause si le navigateur attend un geste). */
export function shouldBeReady(st: MediaSnapshot): boolean {
  return st.duration > 0 && !st.buffering;
}

export interface Chrome {
  /** Barre de position, boutons de transport, icônes de la barre haute. */
  controls: boolean;
  /** Gros bouton lecture / pause et boutons ±10 s au centre. */
  centerButtons: boolean;
  /** `card` : carte de chargement ; `small` : petit anneau (tampon en cours de lecture) ; `none`. */
  spinner: 'card' | 'small' | 'none';
}

/** Ce qui est affiché selon l'état : le chargement ne montre que retour, titre et « Sources » ; un tampon ne montre qu'un petit anneau. */
export function chromeFor(phase: Phase, st: MediaSnapshot): Chrome {
  if (phase === 'loading') return { controls: false, centerButtons: false, spinner: 'card' };
  if (st.buffering) return { controls: true, centerButtons: false, spinner: 'small' };
  return { controls: true, centerButtons: true, spinner: 'none' };
}
