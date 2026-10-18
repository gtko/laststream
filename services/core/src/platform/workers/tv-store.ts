import type { R2Bucket } from '@cloudflare/workers-types';
import { DEFAULT_TV_COUNTRIES, refreshTv, type RefreshResult, type TvBlobStore } from '../../lt/tv-build.js';
import type { WorkerEnv } from './env.js';

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

const LOCK_KEY = 'tv:refresh-lock';
/** Durée du verrou (s) : une construction complète dure quelques minutes au plus. */
const LOCK_TTL_S = 900;

function countriesOf(env: WorkerEnv): string[] {
  const raw = env.TV_COUNTRIES;
  const list = typeof raw === 'string' ? raw.split(',').map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)) : [];
  return list.length > 0 ? list : [...DEFAULT_TV_COUNTRIES];
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
    return await refreshTv(createR2TvBlobs(bucket), { countries: countriesOf(env), probe: options.probe, probeOrigin: origin });
  } catch (err) {
    console.error('[tv] construction échouée', err instanceof Error ? err.message : 'inconnue');
    return undefined;
  } finally {
    await env.CACHE.delete(LOCK_KEY).catch(() => undefined);
  }
}
