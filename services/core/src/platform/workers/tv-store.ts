import type { R2Bucket } from '@cloudflare/workers-types';
import type { TvAdmin, TvCronState } from '../../admin/cache-types.js';
import { DEFAULT_TV_COUNTRIES, refreshTv, type RefreshResult, type TvBlobStore } from '../../lt/tv-build.js';
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
 * et de programmes, EPG reconstruit, code d'erreur. Une erreur de construction n'est pas relancée (le résultat est
 * undefined) ; l'échec d'écriture de la trace non plus, car la trace est une aide et non une condition du service.
 */
export async function recordTvRun(
  blobs: TvBlobStore,
  build: () => Promise<RefreshResult>,
  now: () => number = Date.now,
): Promise<RefreshResult | undefined> {
  const startedMs = now();
  let result: RefreshResult | undefined;
  let outcome: Pick<TvCronState, 'ok' | 'channels' | 'programmes' | 'epgOk' | 'error'>;
  try {
    result = await build();
    outcome = { ok: true, channels: result.channels, programmes: result.programmes, epgOk: result.epgOk, error: null };
  } catch (err) {
    console.error('[tv] construction échouée', err instanceof Error ? err.message : 'inconnue');
    outcome = { ok: false, channels: null, programmes: null, epgOk: false, error: 'construction_echouee' };
  }
  const finishedMs = now();
  const state: StoredCron = {
    v: 1,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: Math.max(0, finishedMs - startedMs),
    ...outcome,
  };
  await blobs.put(TV_CRON_KEY, JSON.stringify(state)).catch(() => console.error('[tv] trace du passage non écrite'));
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
  return {
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    durationMs: count(raw.durationMs) ?? 0,
    ok: raw.ok === true,
    channels: count(raw.channels),
    programmes: count(raw.programmes),
    epgOk: raw.epgOk === true,
    error: typeof raw.error === 'string' ? raw.error : null,
  };
}

/**
 * Construit le catalogue et l'EPG dans R2 (Cron Trigger, ou première demande quand R2 est vide). Un verrou KV évite deux
 * constructions simultanées. `probe` : sonde aussi les flux (CORS) ; la construction lancée par une requête s'en dispense.
 */
export async function refreshTvFromEnv(env: WorkerEnv, options: { probe: boolean }): Promise<RefreshResult | undefined> {
  const bucket = env.TV;
  if (bucket === undefined) return undefined;
  if ((await env.CACHE.get(LOCK_KEY)) !== null) return undefined;
  await env.CACHE.put(LOCK_KEY, String(Date.now()), { expirationTtl: LOCK_TTL_S });
  try {
    const origin = typeof env.LASTADDON_RANGE_BASE === 'string' ? env.LASTADDON_RANGE_BASE : undefined;
    const blobs = createR2TvBlobs(bucket);
    return await recordTvRun(blobs, () => refreshTv(blobs, { countries: countriesOf(env), probe: options.probe, probeOrigin: origin }));
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
