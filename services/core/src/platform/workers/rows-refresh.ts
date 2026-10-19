import { secretFromEnv } from '../../config/secret.js';
import type { AppDeps } from '../../deps.js';
import { createLtContext } from '../../lt/context.js';
import { refreshRows, type RowStatus } from '../../lt/rows.js';
import { runtimeEnv } from '../index.js';
import type { WorkerEnv } from './env.js';
import { createR2RowBlobs } from './meta-blobs.js';

/** Options du rafraîchissement (tests) : par défaut, le jeton TMDB et le secret viennent des variables du Worker. */
export interface RowsRefreshOptions {
  fetch?: typeof fetch;
  token?: string;
  secret?: string;
}

/**
 * Cron Trigger : reconstruit les rangées d'accueil communes dans R2 (bucket META, clés rows/<identifiant>.json) avec le
 * jeton TMDB du serveur (secret TMDB_TOKEN). Sans bucket, sans jeton ou sans secret : rien ; les rangées se calculent
 * alors à la demande. Renvoie le statut de chaque rangée, ou undefined si rien n'a été fait.
 */
export async function refreshRowsFromEnv(env: WorkerEnv, options: RowsRefreshOptions = {}): Promise<Record<string, RowStatus> | undefined> {
  const bucket = env.META;
  if (bucket === undefined) return undefined;
  try {
    const token = options.token ?? runtimeEnv().get('TMDB_TOKEN')?.trim();
    if (!token) {
      console.warn('[lt][rows] TMDB_TOKEN absent : rangées d\'accueil non précalculées');
      return undefined;
    }
    const secret = options.secret ?? secretFromEnv();
    if (secret === undefined) return undefined;
    const deps: AppDeps = { secret, allowPlain: false, fetch: options.fetch };
    return await refreshRows({ ctx: createLtContext(deps), blobs: createR2RowBlobs(bucket), now: () => Date.now() }, token);
  } catch (err) {
    console.error('[lt][rows] reconstruction échouée', err instanceof Error ? err.name : 'inconnue');
    return undefined;
  }
}
