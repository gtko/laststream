import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';

/** Cron Trigger (src/worker.ts, scheduled) : le préchauffage des fiches ne bloque ni ne fait échouer TV ni les rangées. */

const mocks = vi.hoisted(() => ({
  refreshTv: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
  refreshRows: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
  prewarm: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
}));

vi.mock('../src/platform/workers/index.js', () => ({
  createWorkersPlatform: () => undefined,
  createWorkersTvAdmin: () => undefined,
  ensureWorkersPlatform: () => undefined,
  refreshRowsFromEnv: mocks.refreshRows,
  refreshTvFromEnv: mocks.refreshTv,
  prewarmMetaFromEnv: mocks.prewarm,
  runInRequest: <T>(_ctx: unknown, work: () => T): T => work(),
  Metrics: class {},
  PartyRoom: class {},
  UserStoreDO: class {},
}));

const { default: worker } = await import('../src/worker.js');

/** Contexte d'exécution : collecte les travaux passés à waitUntil. */
function executionContext(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

const controller = { cron: '0 */6 * * *', scheduledTime: Date.now(), noRetry: () => undefined } as unknown as ScheduledController;

describe('scheduled : préchauffage isolé des tâches TV et rangées', () => {
  it('préchauffage qui lève une erreur de façon synchrone : TV et rangées lancées, rien ne se propage', async () => {
    mocks.refreshTv.mockClear();
    mocks.refreshRows.mockClear();
    mocks.prewarm.mockImplementationOnce(() => {
      throw new Error('préchauffage cassé');
    });
    const { ctx, pending } = executionContext();

    expect(() => worker.scheduled(controller, {} as never, ctx)).not.toThrow();
    await Promise.allSettled(pending);

    expect(mocks.refreshTv).toHaveBeenCalledTimes(1);
    expect(mocks.refreshRows).toHaveBeenCalledTimes(1);
    expect(mocks.prewarm).toHaveBeenCalledTimes(1);
  });

  it('préchauffage qui échoue en asynchrone : travail rejeté absorbé, TV et rangées lancées', async () => {
    mocks.refreshTv.mockClear();
    mocks.refreshRows.mockClear();
    mocks.prewarm.mockImplementationOnce(() => Promise.reject(new Error('amont en panne')));
    const { ctx, pending } = executionContext();

    worker.scheduled(controller, {} as never, ctx);
    const settled = await Promise.allSettled(pending);

    expect(settled.some((entry) => entry.status === 'rejected' && entry.reason instanceof Error && entry.reason.message === 'amont en panne')).toBe(false);
    expect(mocks.prewarm).toHaveBeenCalledTimes(1);
    expect(mocks.refreshTv).toHaveBeenCalledTimes(1);
    expect(mocks.refreshRows).toHaveBeenCalledTimes(1);
  });
});
