import type { Scheduler } from '../types.js';

/** Planificateur Node : timers qui n'empêchent pas l'arrêt du processus. */
export const nodeScheduler: Scheduler = {
  after(delayMs, task) {
    const timer = setTimeout(() => void Promise.resolve(task()).catch(() => undefined), delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
  every(intervalMs, task) {
    const timer = setInterval(() => void Promise.resolve(task()).catch(() => undefined), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
  background(work) {
    // Le processus reste vivant : il suffit de ne pas laisser une rejection non gérée.
    void work.catch(() => undefined);
  },
};
