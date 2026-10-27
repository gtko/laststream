import type { AppDeps } from '../deps.js';
import type { Scheduler } from '../platform/types.js';
import type { UserBackend } from './repo.js';
import type { TickOutcome } from './social-evenings-store.js';
import { emitSocialEvent, type SocialEvent } from './social-v2-events.js';

/**
 * Temps réel des soirées planifiées (LAST-198, lot L3) : conversion des rappels de `EveningStore.tick` en trames, et
 * minuterie de la plateforme Node. Sous Workers, c'est l'alarme du Durable Object des données qui appelle le même tick.
 */

/** Période du tick sous Node : un rappel part au plus une minute après T-15 min. */
const EVENING_TICK_MS = 60_000;

export interface EveningFrame {
  pids: string[];
  event: SocialEvent;
}

/** Trames `evening_reminder` d'un tick : une par soirée rappelée, vers les participants qui n'ont pas dit non. */
export function reminderFrames(outcome: TickOutcome): EveningFrame[] {
  return outcome.effects.map((effect) => ({
    pids: effect.pids,
    event: {
      t: 'evening',
      event: { type: 'evening_reminder', eveningId: effect.event.eveningId, title: effect.event.title, startsAt: effect.event.startsAt, tz: effect.event.tz },
    },
  }));
}

/**
 * Lance le tick des soirées toutes les minutes (Node) : complète les séries, purge les soirées passées depuis plus de 30 jours,
 * émet les rappels. Un tick en cours n'est jamais doublé (la base en mémoire du processus est la seule source de vérité) ; une
 * base jamais créée n'est pas ouverte. Renvoie la fonction d'arrêt.
 */
export function startEveningTicker(deps: Pick<AppDeps, 'socialEvents'>, backend: UserBackend, scheduler: Scheduler): () => void {
  let running = false;
  return scheduler.every(EVENING_TICK_MS, async () => {
    if (running || backend.hasData?.() === false) return;
    running = true;
    try {
      const outcome = await backend.socialEvenings().tick(Date.now());
      for (const frame of reminderFrames(outcome)) emitSocialEvent(deps.socialEvents, frame.pids, frame.event);
    } finally {
      running = false;
    }
  });
}

/**
 * Après un blocage ou la fin d'une amitié entre `a` et `b` : chacun est retiré des soirées futures de l'autre (voir
 * `EveningStore.detach`). Le profil retiré reçoit `evening_update` « cancelled » (la soirée disparaît pour lui) ; l'hôte reçoit
 * « updated », sauf en cas de blocage entre eux (un blocage ne se devine pas par une trame).
 */
export async function detachEvenings(deps: Pick<AppDeps, 'socialEvents'>, backend: UserBackend, a: string, b: string): Promise<void> {
  const removed = await backend.socialEvenings().detach(a, b, Date.now());
  if (removed.length === 0) return;
  const blocked = await backend.socialV2().isBlockedEither(a, b);
  for (const entry of removed) {
    emitSocialEvent(deps.socialEvents, [entry.guestPid], { t: 'evening', event: { type: 'evening_update', eveningId: entry.eveningId, change: 'cancelled' } });
    if (!blocked) {
      emitSocialEvent(deps.socialEvents, [entry.hostPid], { t: 'evening', event: { type: 'evening_update', eveningId: entry.eveningId, change: 'updated' } });
    }
  }
}
