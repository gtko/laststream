import { createLibres } from '../../lt/libres.js';
import type { WorkerEnv } from './env.js';
import { createR2RowBlobs } from './meta-blobs.js';

/** Cron dédié aux classiques libres (wrangler.jsonc) : une fois par jour, séparé des passes TV pour ne pas partager leurs sous-requêtes. */
export const LIBRES_CRON = '23 4 * * *';

/**
 * Cron Trigger : reconstruit l'index des classiques libres dans R2 (bucket META, clé libres/index.json) s'il date de plus
 * d'une semaine (lt/libres.ts). Sans bucket : rien. Renvoie le statut, ou undefined si rien n'a été fait.
 */
export async function refreshLibresFromEnv(env: WorkerEnv, options: { fetch?: typeof fetch } = {}): Promise<'written' | 'fresh' | 'failed' | undefined> {
  const bucket = env.META;
  if (bucket === undefined) return undefined;
  const service = createLibres({
    store: createR2RowBlobs(bucket),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    now: () => Date.now(),
    background: () => undefined,
  });
  return await service.refresh();
}
