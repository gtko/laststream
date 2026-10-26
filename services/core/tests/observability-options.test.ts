import { describe, expect, it } from 'vitest';
import { workerSentryOptions } from '../src/observability/options.js';

const opts = workerSentryOptions('https://key@o1.ingest.sentry.io/1', 'lastaddon-core@1.0.0');

describe('options Sentry du Worker', () => {
  it('collecte identique à l’application : aucune donnée personnelle', () => {
    expect(opts.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    });
  });

  it('aucun en-tête de trace transmis aux appels sortants', () => {
    expect(opts.tracePropagationTargets).toEqual([]);
  });

  it('filtres de confidentialité branchés sur les erreurs, les traces et le fil d’Ariane', () => {
    expect(typeof opts.beforeSend).toBe('function');
    expect(typeof opts.beforeSendTransaction).toBe('function');
    expect(typeof opts.beforeBreadcrumb).toBe('function');
  });

  it('tag platform posé pour tous les événements ; la version passe par `release` seul (pas de tag en double)', () => {
    expect(opts.initialScope).toEqual({
      tags: { platform: 'cloudflare-workers' },
    });
  });

  it('DSN et version transmis, environnement de production', () => {
    expect(opts.dsn).toBe('https://key@o1.ingest.sentry.io/1');
    expect(opts.release).toBe('lastaddon-core@1.0.0');
    expect(opts.environment).toBe('production');
    expect(workerSentryOptions(undefined, 'x').dsn).toBeUndefined();
  });
});
