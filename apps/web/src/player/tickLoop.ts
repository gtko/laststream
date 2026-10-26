/* Cadence adaptative de la boucle du lecteur (LAST-142). Deux boucles : l'interface (sous-titres, barre de lecture) toutes les
 * 250 ms, et la boucle lente (présence, salon, blocage, saut, progression) toutes les secondes. Elles s'arrêtent quand rien n'est à
 * rafraîchir (lecture en pause, onglet caché) et repartent au `play` ou au retour de l'onglet. Logique pure, testée : la session
 * lui donne le contexte (`plan`) et les deux relevés (`fast`, `slow`). */

/** Pas de la boucle d'interface. */
export const UI_TICK_MS = 250;
/** Pas de la boucle lente : présence, salon (watch party), blocage, saut, carte suivante, progression. */
export const SLOW_TICK_MS = 1000;

export interface TickContext {
  /** Une session de lecture est ouverte. */
  open: boolean;
  /** Onglet ou fenêtre caché (`document.hidden`). */
  hidden: boolean;
  /** Le moteur est en pause (ou la lecture terminée). */
  paused: boolean;
  /** Première image passée. Avant, la boucle surveille le démarrage (délai, blocage) même en pause ou en arrière-plan. */
  settled: boolean;
  /** Moteur : « html » joue dans la page ; mpv et le lecteur natif jouent hors de la page, qui peut être cachée en pleine lecture. */
  kind: string;
  /** Salon (watch party) ouvert : le lecteur doit suivre le salon, y compris en pause ou en arrière-plan. */
  party: boolean;
}

export interface TickPlan {
  /** Boucle d'interface (250 ms) à faire tourner. */
  fast: boolean;
  /** Boucle lente (1 s) à faire tourner. */
  slow: boolean;
  /** Quelqu'un voit l'écran : un événement (saut, sous-titre choisi) peut rafraîchir l'affichage même boucle arrêtée. */
  show: boolean;
}

/**
 * Quelles boucles tournent. Lecture en cours et onglet visible : les deux. En pause : aucune, sauf la lente dans un salon (un
 * invité doit reprendre quand l'hôte reprend). Onglet caché : aucune pour un moteur web (le navigateur le ralentit de toute façon et
 * l'événement `visibilitychange` enregistre la position), la lente pour mpv et le lecteur natif (leur progression passe par elle).
 */
export function tickPlan(c: TickContext): TickPlan {
  if (!c.open) return { fast: false, slow: false, show: false };
  const show = !c.hidden;
  if (!c.settled) return { fast: true, slow: true, show };
  return { fast: show && !c.paused, slow: c.party || (!c.paused && (show || c.kind !== 'html')), show };
}

interface TickTimers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

export interface TickLoopOptions {
  plan: () => TickPlan;
  /** Relevé de l'interface. */
  fast: () => void;
  /** Relevé lent. */
  slow: () => void;
  /** Rafraîchit seulement l'affichage (sous-titre) pendant que la boucle d'interface dort. */
  nudge?: () => void;
  /** La boucle lente repart après un sommeil : les mesures d'avant (blocage) ne valent plus. */
  wake?: () => void;
  /** Horloges (tests) ; `setInterval` et `clearInterval` du navigateur par défaut. */
  timers?: TickTimers;
}

export interface TickLoop {
  /** Aligne les boucles sur `plan()` ; à appeler quand le contexte change (pause, reprise, visibilité, moteur). */
  sync(): void;
  /** Arrête tout, sans dernier relevé (fermeture de la session). */
  stop(): void;
  /** Rafraîchissement ponctuel de l'affichage si la boucle d'interface dort et que l'écran est vu. */
  nudge(): void;
  running(): { fast: boolean; slow: boolean };
}

const browserTimers: TickTimers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export function createTickLoop(o: TickLoopOptions): TickLoop {
  const timers = o.timers ?? browserTimers;
  let fastId: unknown = null;
  let slowId: unknown = null;
  let slept = false;
  let syncing = false;
  let again = false;
  const pass = () => {
      const want = o.plan();
      // Arrêts d'abord, avec un dernier relevé : la présence et le salon voient l'état final (pause), l'interface aussi.
      if (!want.slow && slowId !== null) { timers.clear(slowId); slowId = null; slept = true; o.slow(); }
      if (!want.fast && fastId !== null) { timers.clear(fastId); fastId = null; o.fast(); }
      if (want.slow && slowId === null) {
        slowId = timers.set(o.slow, SLOW_TICK_MS);
        if (slept) { slept = false; o.wake?.(); }
        o.slow();
      }
      if (want.fast && fastId === null) {
        fastId = timers.set(o.fast, UI_TICK_MS);
        o.fast();
      }
  };
  return {
    sync() {
      // Un sync demandé pendant un autre (un relevé qui change la pause) n'est pas perdu : un second passage relit `plan()`.
      if (syncing) { again = true; return; }
      syncing = true;
      try {
        do { again = false; pass(); } while (again);
      } finally { syncing = false; again = false; }
    },
    stop() {
      if (fastId !== null) timers.clear(fastId);
      if (slowId !== null) timers.clear(slowId);
      fastId = null;
      slowId = null;
      slept = false;
    },
    nudge() {
      if (fastId === null && o.plan().show) o.nudge?.();
    },
    running: () => ({ fast: fastId !== null, slow: slowId !== null }),
  };
}
