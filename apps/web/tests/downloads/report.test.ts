// Journal Sentry des échecs de téléchargement (ODY-240) : plateforme, codes et tailles seulement.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ broken: false }));
const captureMessage = vi.fn();
vi.mock('@sentry/browser', () => ({
  captureMessage: (...args: unknown[]) => {
    captureMessage(...args);
    if (state.broken) throw new Error('boom');
  },
}));

const { reportDownloadEvent } = await import('../../src/downloads/report');

beforeEach(() => {
  captureMessage.mockReset();
  state.broken = false;
});

describe('reportDownloadEvent', () => {
  it('un échec part avec la plateforme, le code, la cause et les tailles, sans titre ni lien', () => {
    reportDownloadEvent('shell', 'failed', { code: 'store_denied', detail: 'io', bytes: 2048, total: 4096 });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = captureMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('download_failed');
    expect(context).toMatchObject({
      level: 'warning',
      tags: { appPlatform: 'shell', code: 'store_denied', detail: 'io' },
      extra: { bytesDone: 2048, bytesTotal: 4096 },
    });
    expect(JSON.stringify(context)).not.toMatch(/https?:|apikey/i);
  });

  it('les autres événements du gestionnaire ne sont pas envoyés', () => {
    reportDownloadEvent('web', 'retry', { attempts: 1 });
    reportDownloadEvent('web', 'failed', undefined);
    reportDownloadEvent('web', 'failed', { code: 'quota_exceeded' });
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('une panne de Sentry ne casse jamais le téléchargement', () => {
    state.broken = true;
    expect(() => reportDownloadEvent('android', 'failed', { code: 'store_full' })).not.toThrow();
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
});
