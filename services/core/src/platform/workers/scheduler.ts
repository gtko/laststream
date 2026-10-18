import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionContext } from '@cloudflare/workers-types';
import type { Scheduler } from '../types.js';

/** Contexte d'exécution de la requête en cours : sert à garder en vie le travail d'arrière-plan (waitUntil). */
const requestContext = new AsyncLocalStorage<ExecutionContext>();

/** Exécute `work` dans le contexte de la requête : `Scheduler.background` y rattache ses tâches. */
export function runInRequest<T>(ctx: ExecutionContext, work: () => T): T {
  return requestContext.run(ctx, work);
}

/**
 * Planification sous Workers. Il n'y a pas de processus durable : `after` et `every` ne vivent que le temps de la
 * requête (timers de l'isolat) ; le travail d'arrière-plan passe par `ctx.waitUntil`.
 */
export const workersScheduler: Scheduler = {
  after(delayMs, task) {
    const timer = setTimeout(() => void Promise.resolve(task()).catch(() => undefined), delayMs);
    return () => clearTimeout(timer);
  },
  every(intervalMs, task) {
    const timer = setInterval(() => void Promise.resolve(task()).catch(() => undefined), intervalMs);
    return () => clearInterval(timer);
  },
  background(work) {
    const settled = work.catch(() => undefined);
    const ctx = requestContext.getStore();
    if (ctx !== undefined) ctx.waitUntil(settled);
  },
};
