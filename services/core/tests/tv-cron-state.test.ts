import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshResult, TvBlobStore } from '../src/lt/tv-build.js';
import { readTvCron, recordTvRun, TV_CRON_KEY } from '../src/platform/workers/tv-store.js';

/** Stockage R2 simulé : une Map de clés → texte. */
function memoryBlobs(initial: Record<string, string> = {}): TvBlobStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => Promise.resolve(data.get(key)),
    put: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

/** Horloge qui avance de `step` ms à chaque lecture (début puis fin du passage). */
const clock = (start: number, step: number) => {
  let t = start;
  return () => {
    const now = t;
    t += step;
    return now;
  };
};

const RESULT: RefreshResult = { channels: 708, programmes: 15_230, epgOk: true };

describe('trace du passage du cron TV (recordTvRun)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succès : enregistre début, fin, durée, chaînes, programmes et EPG, puis rend le résultat', async () => {
    const blobs = memoryBlobs();
    const result = await recordTvRun(blobs, () => Promise.resolve(RESULT), clock(Date.parse('2026-10-18T03:00:00.000Z'), 252_000));
    expect(result).toEqual(RESULT);
    const stored = JSON.parse(blobs.data.get(TV_CRON_KEY) as string) as Record<string, unknown>;
    expect(stored).toEqual({
      v: 1, startedAt: '2026-10-18T03:00:00.000Z', finishedAt: '2026-10-18T03:04:12.000Z', durationMs: 252_000,
      ok: true, channels: 708, programmes: 15_230, epgOk: true, error: null,
    });
  });

  it('échec de construction : pas de relance, résultat undefined, code d\'erreur seul (pas de message brut)', async () => {
    const blobs = memoryBlobs();
    const result = await recordTvRun(blobs, () => Promise.reject(new Error('https://secret.example/key=abc failed')), clock(0, 5));
    expect(result).toBeUndefined();
    const stored = JSON.parse(blobs.data.get(TV_CRON_KEY) as string) as Record<string, unknown>;
    expect(stored).toMatchObject({ v: 1, ok: false, channels: null, programmes: null, epgOk: false, error: 'construction_echouee' });
    expect(JSON.stringify(stored)).not.toContain('secret.example');
  });

  it('EPG non reconstruit : le catalogue reste « réussi », l\'EPG est signalé', async () => {
    const blobs = memoryBlobs();
    await recordTvRun(blobs, () => Promise.resolve({ channels: 12, programmes: 0, epgOk: false }), clock(0, 1));
    expect(await readTvCron(blobs)).toMatchObject({ ok: true, channels: 12, programmes: 0, epgOk: false, error: null });
  });

  it('écriture de la trace en échec : le passage rend quand même son résultat', async () => {
    const blobs = memoryBlobs();
    blobs.put = () => Promise.reject(new Error('R2 indisponible'));
    await expect(recordTvRun(blobs, () => Promise.resolve(RESULT), clock(0, 1))).resolves.toEqual(RESULT);
  });
});

describe('lecture de la trace (readTvCron)', () => {
  it('absente : null', async () => {
    expect(await readTvCron(memoryBlobs())).toBeNull();
  });

  it('illisible ou d\'une autre version : null', async () => {
    expect(await readTvCron(memoryBlobs({ [TV_CRON_KEY]: '{pas du json' }))).toBeNull();
    expect(await readTvCron(memoryBlobs({ [TV_CRON_KEY]: JSON.stringify({ v: 2, startedAt: 'x', finishedAt: 'y' }) }))).toBeNull();
    expect(await readTvCron(memoryBlobs({ [TV_CRON_KEY]: JSON.stringify({ v: 1, finishedAt: 'y' }) }))).toBeNull();
  });

  it('ne rend que les champs prévus (pas de version), et normalise les types', async () => {
    const raw = { v: 1, startedAt: 'a', finishedAt: 'b', durationMs: '12', ok: 'oui', channels: 'x', programmes: null, epgOk: 1, error: 42, extra: 'non' };
    expect(await readTvCron(memoryBlobs({ [TV_CRON_KEY]: JSON.stringify(raw) }))).toEqual({
      startedAt: 'a', finishedAt: 'b', durationMs: 0, ok: false, channels: null, programmes: null, epgOk: false, error: null,
    });
  });
});
