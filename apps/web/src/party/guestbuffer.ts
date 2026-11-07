/* Rapport de tampon de cet invité au salon de watch party. Machine d'état pure : ni horloge ni socket réels (l'horloge et
 * l'envoi sont injectés). Le salon retient la lecture tant qu'un invité n'a pas assez d'avance (`ready=false`), et la
 * reprend quand tous sont prêts :
 *  - au démarrage, après un saut local et à chaque reconnexion, l'invité attend (`reset`) jusqu'à `resumeAhead` secondes de
 *    tampon devant lui (seuil du salon, à défaut PARTY_RESUME_AHEAD_SEC) ;
 *  - pendant la lecture, moins de BUFFER_UNDERRUN_SEC de tampon le remet en attente ; il ne redevient prêt qu'au seuil
 *    (hystérésis : pas d'aller-retour à chaque seconde) ;
 *  - près de la fin du média, le seuil se réduit à la durée restante, que le tampon ne peut pas dépasser ;
 *  - envoi seulement aux changements d'état, et un battement toutes les BUFFER_REPORT_MS tant qu'il attend. Le lecteur
 *    appelle `update` environ une fois par seconde : c'est ce rythme qui cadence le battement. */
import { PARTY_RESUME_AHEAD_SEC } from './protocol';


/** Tampon (s) sous lequel la lecture en cours se met en attente. */
export const BUFFER_UNDERRUN_SEC = 2;
/** Battement (ms) tant que l'invité attend du tampon. */
export const BUFFER_REPORT_MS = 2000;
/** Tolérance (s) pour « le tampon couvre la fin du média » : la fin est atteinte à quelques millisecondes près. */
const END_TOLERANCE_SEC = 0.25;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const nonNegative = (n: unknown): number => (finite(n) ? Math.max(0, n) : 0);

export interface BufferUpdate {
  /** Secondes de tampon devant la position (valeur non finie : 0). */
  ahead: number;
  /** La lecture roule : un tampon faible ne compte que pendant la lecture. */
  playing: boolean;
  /** Saut en cours : pas d'état « prêt » tant qu'il n'est pas résolu. */
  seeking: boolean;
  /** Secondes restant jusqu'à la fin du média, si elles sont connues. */
  remaining?: number;
  /** Seuil de reprise imposé par le salon (s) ; absent : PARTY_RESUME_AHEAD_SEC. */
  resumeAhead?: number;
}

export interface BufferReporterDeps {
  /** Envoie l'état au salon : `ready` et `ahead` (secondes). */
  send(ready: boolean, ahead: number): void;
  /** Horloge (ms). */
  now(): number;
}

export interface BufferReporter {
  /** Met à jour l'état à partir du lecteur. */
  update(next: BufferUpdate): void;
  /** Saut local ou reconnexion au salon : l'invité repart en attente (`ready=false`). */
  reset(): void;
  /** Lecteur déchargé : s'il attendait, le salon est prévenu qu'il ne retient plus la lecture (`ready=true`). Sans effet ensuite. */
  stop(): void;
}

/** Seuil de reprise effectif (s) : celui du salon, réduit à la durée restante quand elle est plus courte. */
export function readyThreshold(next: Pick<BufferUpdate, 'remaining' | 'resumeAhead'>): number {
  const base = finite(next.resumeAhead) ? Math.max(0, next.resumeAhead) : PARTY_RESUME_AHEAD_SEC;
  return finite(next.remaining) ? Math.min(base, Math.max(0, next.remaining)) : base;
}

/** Le tampon couvre tout ce qui reste du média. */
function coversEnd(next: Pick<BufferUpdate, 'ahead' | 'remaining'>): boolean {
  return finite(next.remaining) && nonNegative(next.ahead) + END_TOLERANCE_SEC >= next.remaining;
}

/** Sous-alimentation : la lecture roule avec moins de BUFFER_UNDERRUN_SEC devant elle, sans que le tampon couvre déjà la fin. */
export function isUnderrun(next: Pick<BufferUpdate, 'ahead' | 'playing' | 'remaining'>): boolean {
  if (!next.playing || coversEnd(next)) return false;
  return nonNegative(next.ahead) < BUFFER_UNDERRUN_SEC;
}

/** Le tampon atteint le seuil de reprise, ou couvre la fin du média. */
function reachesThreshold(next: BufferUpdate): boolean {
  return coversEnd(next) || nonNegative(next.ahead) >= readyThreshold(next);
}

export function createBufferReporter(deps: BufferReporterDeps): BufferReporter {
  /** Vrai tant que l'invité attend du tampon ; faux une fois prêt. */
  let waiting = true;
  let stopped = false;
  let lastAhead = 0;
  let lastSentAt = 0;

  const send = (ready: boolean, ahead: number): void => {
    lastSentAt = deps.now();
    deps.send(ready, ahead);
  };
  const wait = (ahead: number): void => {
    waiting = true;
    send(false, ahead);
  };

  // Annonce initiale : l'invité attend, le salon le sait tout de suite.
  wait(0);

  return {
    update(next) {
      if (stopped) return;
      const ahead = nonNegative(next.ahead);
      lastAhead = ahead;
      const state: BufferUpdate = { ...next, ahead };
      if (!waiting) {
        if (next.seeking || isUnderrun(state)) wait(ahead);
        return;
      }
      if (!next.seeking && reachesThreshold(state)) {
        waiting = false;
        send(true, ahead);
        return;
      }
      if (deps.now() - lastSentAt >= BUFFER_REPORT_MS) send(false, ahead);
    },
    reset() {
      if (stopped) return;
      lastAhead = 0;
      wait(0);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (waiting) send(true, lastAhead);
    },
  };
}
