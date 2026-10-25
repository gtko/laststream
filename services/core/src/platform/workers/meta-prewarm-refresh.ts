import { secretFromEnv } from '../../config/secret.js';
import type { AppDeps } from '../../deps.js';
import { createLtContext } from '../../lt/context.js';
import { collectPrewarmTargets, type PrewarmReport, prewarmMetaFiches } from '../../lt/meta-prewarm.js';
import type { MetaRuntime, MetaServices } from '../../lt/meta.js';
import type { MetaRepo } from '../../user/repo.js';
import { runtimeEnv } from '../index.js';
import type { WorkerEnv } from './env.js';
import { createR2MetaBlobs } from './meta-blobs.js';
import { workersQuotaGate } from './metrics.js';
import { createDurableObjectUserBackend } from './user-backend.js';

/**
 * Cron Trigger : préchauffe les fiches des rangées d'accueil et du Top 10 dans R2 (bucket META, lt/meta-prewarm.ts), avec les
 * clés de service du serveur (secrets du Worker). Le budget quotidien MDBList passe par le Durable Object Metrics quand il
 * est lié. Sans bucket, sans jeton TMDB ou sans secret : rien. Renvoie le bilan du passage, ou undefined si rien n'a été fait.
 */
export async function prewarmMetaFromEnv(env: WorkerEnv): Promise<PrewarmReport | undefined> {
  const bucket = env.META;
  if (bucket === undefined) return undefined;
  const vars = runtimeEnv();
  const token = vars.get('TMDB_TOKEN')?.trim();
  if (!token) {
    console.warn('[lt][meta-prewarm] TMDB_TOKEN absent : préchauffage des fiches ignoré');
    return undefined;
  }
  const secret = secretFromEnv();
  if (secret === undefined) return undefined;
  const deps: AppDeps = {
    secret,
    allowPlain: false,
    ...(env.METRICS === undefined ? {} : { mdblistQuota: workersQuotaGate(env.METRICS) }),
  };
  const ctx = createLtContext(deps);
  const targets = await collectPrewarmTargets(ctx, token, Date.now());
  const svc: MetaServices = {
    tmdbToken: token,
    mdblistApiKey: vars.get('MDBLIST_API_KEY')?.trim() || undefined,
    tvdbApiKey: vars.get('TVDB_API_KEY')?.trim() || undefined,
    tvdbPin: vars.get('TVDB_PIN')?.trim() || undefined,
  };
  const meta: MetaRuntime = {
    ctx,
    blobs: createR2MetaBlobs(bucket),
    index: (): MetaRepo => createDurableObjectUserBackend(env.USER_STORE).meta(),
    now: () => Date.now(),
    background: (work) => {
      work.catch(() => undefined);
    },
  };
  return prewarmMetaFiches({ meta, svc }, targets);
}
