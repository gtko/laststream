import { afterEach, describe, expect, it, vi } from 'vitest';
import { newApp } from '../src/http/app-env.js';
import { errorHandler } from '../src/http/common.js';
import { reportUnhandledError, setUnhandledErrorReporter } from '../src/observability/report.js';

afterEach(() => {
  setUnhandledErrorReporter(undefined);
  vi.restoreAllMocks();
});

describe('reportUnhandledError : récepteur des erreurs 500', () => {
  it('ne fait rien sans récepteur', () => {
    expect(() => reportUnhandledError(new Error('boom'))).not.toThrow();
  });

  it('transmet l\'erreur au récepteur installé, et ne propage jamais une panne du récepteur', () => {
    const error = new Error('boom');
    const reporter = vi.fn();
    setUnhandledErrorReporter(reporter);
    reportUnhandledError(error);
    expect(reporter).toHaveBeenCalledWith(error);

    setUnhandledErrorReporter(() => {
      throw new Error('récepteur en panne');
    });
    expect(() => reportUnhandledError(error)).not.toThrow();
  });
});

describe('errorHandler : remontée seulement pour les 500', () => {
  it('remonte une erreur interne et répond 500 sans contenu', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reporter = vi.fn();
    setUnhandledErrorReporter(reporter);
    const app = newApp();
    app.onError(errorHandler);
    const internal = new TypeError('valeur interne');
    app.get('/boom', () => {
      throw internal;
    });

    const res = await app.request('/boom');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(internal);
  });

  it('ne remonte pas les erreurs 4xx du parseur ou de l\'application', async () => {
    const reporter = vi.fn();
    setUnhandledErrorReporter(reporter);
    const app = newApp();
    app.onError(errorHandler);
    app.get('/refus', () => {
      throw Object.assign(new Error('payload trop grand'), { status: 413 });
    });

    const res = await app.request('/refus');

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'bad_request' });
    expect(reporter).not.toHaveBeenCalled();
  });
});
