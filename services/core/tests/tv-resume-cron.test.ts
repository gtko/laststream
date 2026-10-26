import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';

/** Cron Trigger (src/worker.ts, scheduled) : la reprise de 30 min ne relance que la TV ; la passe de 6 h garde tout. */

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

const schedule = (cron: string, scheduledTime: number): ScheduledController =>
  ({ cron, scheduledTime, noRetry: () => undefined }) as unknown as ScheduledController;

describe('scheduled : reprise TV toutes les 30 min, passe complète toutes les 6 h', () => {
  it('reprise à 12:30 UTC : TV en mode reprise seulement, ni rangées ni préchauffage', async () => {
    mocks.refreshTv.mockClear();
    mocks.refreshRows.mockClear();
    mocks.prewarm.mockClear();
    const { ctx, pending } = executionContext();

    worker.scheduled(schedule('*/30 * * * *', Date.UTC(2026, 9, 25, 12, 30)), {} as never, ctx);
    await Promise.allSettled(pending);

    expect(mocks.refreshTv).toHaveBeenCalledWith({}, { probe: true, resume: true });
    expect(mocks.refreshRows).not.toHaveBeenCalled();
    expect(mocks.prewarm).not.toHaveBeenCalled();
  });

  it('reprise à 06:00 UTC : laissée à la passe complète, qui part à la même heure', async () => {
    mocks.refreshTv.mockClear();
    const { ctx, pending } = executionContext();

    worker.scheduled(schedule('*/30 * * * *', Date.UTC(2026, 9, 25, 6, 0)), {} as never, ctx);
    await Promise.allSettled(pending);

    // Le wrapper Sentry pousse son propre flush dans waitUntil : seul le travail TV compte ici.
    expect(mocks.refreshTv).not.toHaveBeenCalled();
    expect(mocks.refreshRows).not.toHaveBeenCalled();
  });

  it('passe complète (6 h) : construction complète, rangées et préchauffage comme avant', async () => {
    mocks.refreshTv.mockClear();
    mocks.refreshRows.mockClear();
    mocks.prewarm.mockClear();
    const { ctx, pending } = executionContext();

    worker.scheduled(schedule('0 */6 * * *', Date.UTC(2026, 9, 25, 6, 0)), {} as never, ctx);
    await Promise.allSettled(pending);

    expect(mocks.refreshTv).toHaveBeenCalledWith({}, { probe: true });
    expect(mocks.refreshRows).toHaveBeenCalledTimes(1);
    expect(mocks.prewarm).toHaveBeenCalledTimes(1);
  });
});
