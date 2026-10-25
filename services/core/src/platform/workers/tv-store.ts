import type { R2Bucket } from '@cloudflare/workers-types';
import type { TvAdmin, TvCronState } from '../../admin/cache-types.js';
import { DEFAULT_TV_COUNTRIES, fullPlan, refreshTv, type RefreshResult, TV_EPG_URLS, type TvBlobStore } from '../../lt/tv-build.js';
import { alertsOf, applyOutcomes, type PassPlan, planResume, type TvPassTrace } from '../../lt/tv-passes.js';
import { reportWarning } from '../../observability/report.js';
import type { WorkerEnv } from './env.js';
import { workersScheduler } from './scheduler.js';

/** Stockage du catalogue TV et de l'EPG dans R2 (JSON texte). */
export function createR2TvBlobs(bucket: R2Bucket): TvBlobStore {
  return {
    async get(key) {
      const object = await bucket.get(key);
      return object === null ? undefined : object.text();
    },
    async put(key, value) {
      await bucket.put(key, value, { httpMetadata: { contentType: 'application/json' } });
    },
  };
}

/** Clé R2 de la trace du dernier passage du cron (lue par l'administration, voir createWorkersTvAdmin). */
export const TV_CRON_KEY = 'cron-state.json';

type StoredCron = TvCronState & { v: 1 };

const LOCK_KEY = 'tv:refresh-lock';
/** Durée du verrou (s) : une construction complète dure quelques minutes au plus. */
const LOCK_TTL_S = 900;

function countriesOf(env: WorkerEnv): string[] {
  const raw = env.TV_COUNTRIES;
  const list = typeof raw === 'string' ? raw.split(',').map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)) : [];
  return list.length > 0 ? list : [...DEFAULT_TV_COUNTRIES];
}

/**
 * Lance une construction et en garde la trace dans R2 (`TV_CRON_KEY`) : début, fin, durée, succès, nombre de chaînes
 * et de programmes, EPG reconstruit, code d'erreur. Quand la construction remplit la trace (`build` la reçoit), la trace
 * porte aussi l'état de chaque source, les sondes et les sondages restants ; un journal JSON décrit le passage, et une
 * source qui échoue deux passages de suite déclenche une alerte. Une erreur de construction n'est pas relancée (le
 * résultat est undefined) ; l'échec d'écriture de la trace non plus, car la trace est une aide et non une condition du service.
 */
export async function recordTvRun(
  blobs: TvBlobStore,
  build: (trace: TvPassTrace) => Promise<RefreshResult>,
  now: () => number = Date.now,
  kind: PassPlan['kind'] = 'full',
): Promise<RefreshResult | undefined> {
  const startedMs = now();
  const trace: TvPassTrace = { sources: {} };
  let result: RefreshResult | undefined;
  let outcome: Pick<TvCronState, 'ok' | 'channels' | 'programmes' | 'epgOk' | 'error'>;
  try {
    result = await build(trace);
    outcome = { ok: true, channels: result.channels, programmes: result.programmes, epgOk: result.epgOk, error: null };
  } catch (err) {
    console.error('[tv] construction échouée', err instanceof Error ? err.message : 'inconnue');
    outcome = { ok: false, channels: null, programmes: null, epgOk: false, error: 'construction_echouee' };
  }
  const finishedMs = now();
  const finishedAt = new Date(finishedMs).toISOString();
  const durationMs = Math.max(0, finishedMs - startedMs);
  // L'état par source n'existe que pour les passes qui tracent les sources : sans trace, la forme v1 reste inchangée.
  let fields: Partial<StoredCron> = {};
  // Une reprise qui ne fait que finir les sondages n'exécute aucune source : la trace porte alors les sondes seules.
  if (Object.keys(trace.sources).length > 0 || trace.probes !== undefined) {
    const previous = await readTvCron(blobs).catch(() => null);
    const sources = applyOutcomes(previous?.sources, trace.sources, finishedAt);
    fields = { sources, ...(trace.probes === undefined ? {} : { probes: trace.probes }), ...(trace.probesPending === undefined ? {} : { probesPending: trace.probesPending }) };
    for (const id of alertsOf(sources, trace.sources)) {
      reportWarning('tv_source_consecutive_failures', { source: id, consecutiveFailures: sources[id]?.consecutiveFailures ?? 0, kind });
    }
  }
  const state: StoredCron = {
    v: 1,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt,
    durationMs,
    ...outcome,
    ...fields,
  };
  await blobs.put(TV_CRON_KEY, JSON.stringify(state)).catch(() => console.error('[tv] trace du passage non écrite'));
  console.log(
    JSON.stringify({
      event: 'tv_pass',
      kind,
      ok: outcome.ok,
      durationMs,
      probes: trace.probes ?? null,
      probesPending: trace.probesPending ?? null,
      sources: trace.sources,
      failed: Object.entries(trace.sources)
        .filter(([, source]) => !source.ok)
        .map(([id]) => id),
    }),
  );
  return result;
}

/** Dernier passage enregistré, ou null (absent, illisible ou d'une autre version). */
export async function readTvCron(blobs: TvBlobStore): Promise<TvCronState | null> {
  const text = await blobs.get(TV_CRON_KEY);
  if (text === undefined) return null;
  let raw: Partial<StoredCron>;
  try {
    raw = JSON.parse(text) as Partial<StoredCron>;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || raw.v !== 1 || typeof raw.startedAt !== 'string' || typeof raw.finishedAt !== 'string') return null;
  const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const trace = raw as { sources?: unknown; probes?: unknown; probesPending?: unknown };
  const extra: Partial<TvCronState> = {};
  if (typeof trace.sources === 'object' && trace.sources !== null && !Array.isArray(trace.sources)) extra.sources = trace.sources as TvCronState['sources'];
  if (typeof trace.probes === 'number') extra.probes = trace.probes;
  if (typeof trace.probesPending === 'boolean') extra.probesPending = trace.probesPending;
  return {
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    durationMs: count(raw.durationMs) ?? 0,
    ok: raw.ok === true,
    channels: count(raw.channels),
    programmes: count(raw.programmes),
    epgOk: raw.epgOk === true,
    error: typeof raw.error === 'string' ? raw.error : null,
    ...extra,
  };
}

/** Options d'une passe du Cron TV. `resume` : ne relancer que les sources en échec et les sondages restants. */
export interface TvPassOptions {
  countries: readonly string[];
  /** Sondages des flux (passe complète). */
  probe: boolean;
  resume?: boolean;
  /** Plafond de sondages par passe (défaut : 800). */
  maxProbes?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Une passe du Cron TV : complète, ou reprise d'après la trace du passage précédent. Rend undefined si la reprise n'a
 * rien à faire (toutes les sources sont à jour, aucun sondage en attente, ou aucun état encore).
 */
export async function runTvPass(blobs: TvBlobStore, options: TvPassOptions): Promise<RefreshResult | undefined> {
  let plan: PassPlan | undefined = fullPlan(options.probe);
  if (options.resume === true) {
    const previous = await readTvCron(blobs);
    plan = planResume(previous?.sources, TV_EPG_URLS, previous?.probesPending === true);
  }
  if (plan === undefined) {
    console.log(JSON.stringify({ event: 'tv_pass', kind: 'resume', skipped: 'rien_a_reprendre' }));
    return undefined;
  }
  const pass = plan;
  return recordTvRun(
    blobs,
    (trace) => refreshTv(blobs, { countries: options.countries, probe: options.probe, maxProbes: options.maxProbes, fetch: options.fetch, now: options.now, plan: pass, trace }),
    options.now ?? Date.now,
    pass.kind,
  );
}

/**
 * Construit le catalogue et l'EPG dans R2 (Cron Trigger, ou première demande quand R2 est vide). Un verrou KV évite deux
 * constructions simultanées. `probe` : sonde aussi les flux (CORS) ; la construction lancée par une requête s'en dispense.
 * `resume` : passe de reprise (Cron de 30 min), voir runTvPass.
 */
export async function refreshTvFromEnv(env: WorkerEnv, options: { probe: boolean; resume?: boolean }): Promise<RefreshResult | undefined> {
  const bucket = env.TV;
  if (bucket === undefined) return undefined;
  if ((await env.CACHE.get(LOCK_KEY)) !== null) {
    console.log(JSON.stringify({ event: 'tv_pass', skipped: 'verrou' }));
    return undefined;
  }
  await env.CACHE.put(LOCK_KEY, String(Date.now()), { expirationTtl: LOCK_TTL_S });
  try {
    return await runTvPass(createR2TvBlobs(bucket), { countries: countriesOf(env), probe: options.probe, resume: options.resume });
  } finally {
    await env.CACHE.delete(LOCK_KEY).catch(() => undefined);
  }
}

/**
 * Administration TV sous Workers : dernier passage (trace R2) et relance en arrière-plan. Absente sans bucket TV
 * (les routes /admin/tv répondent alors 501).
 */
export function createWorkersTvAdmin(env: WorkerEnv): TvAdmin | undefined {
  const bucket = env.TV;
  if (bucket === undefined) return undefined;
  return {
    lastCron: () => readTvCron(createR2TvBlobs(bucket)),
    rerun: () => {
      workersScheduler.background(refreshTvFromEnv(env, { probe: false }));
      return Promise.resolve(undefined);
    },
  };
}
