// Initialisation Sentry : options (confidentialité, pas de performance ni de Session Replay), environnement, et aucun envoi en test.
import { getClient, getDefaultIntegrations, type Breadcrumb, type ErrorEvent } from '@sentry/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';
import { buildSentryOptions, initSentry, resolveEnvironment } from '../src/observability/sentry';

const platform = vi.hoisted(() => ({ native: false }));
vi.mock('@capacitor/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@capacitor/core')>();
  return { ...real, Capacitor: { ...real.Capacitor, isNativePlatform: () => platform.native } };
});

const ev = (e: Record<string, unknown>): ErrorEvent => e as unknown as ErrorEvent;

afterEach(() => {
  platform.native = false;
  delete (window as unknown as { chrome?: unknown }).chrome;
  auth.accountId = '';
});

const opts = buildSentryOptions('https://key@o1.ingest.de.sentry.io/1', 'web', 'laststream-app@0.1.0');

describe('options Sentry', () => {
  it('pas de performance, pas de données personnelles, 50 fils au plus', () => {
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.dataCollection).toMatchObject({ userInfo: false, cookies: false, httpHeaders: false, urlQueryParams: false });
    expect(opts.maxBreadcrumbs).toBe(50);
    expect(opts.environment).toBe('web');
    expect(opts.release).toBe('laststream-app@0.1.0');
  });

  it('pas de Session Replay ni de traces dans les intégrations par défaut', () => {
    expect(opts).not.toHaveProperty('replaysSessionSampleRate');
    expect(opts).not.toHaveProperty('replaysOnErrorSampleRate');
    const names = getDefaultIntegrations({}).map((i) => i.name);
    expect(names).not.toContain('Replay');
    expect(names).not.toContain('BrowserTracing');
  });

  it('événements : profil principal, compte par identifiant seulement, filtre appliqué', () => {
    const beforeSend = opts.beforeSend as (e: ErrorEvent, h: unknown) => ErrorEvent | null;
    auth.accountId = 'acc-42';
    const out = beforeSend(ev({ message: 'boom', user: { id: 'x', username: 'greg', email: 'g@example.com' } }), {});
    expect(out?.tags).toEqual({ profileKind: 'principal' });
    expect(out?.user).toEqual({ id: 'acc-42' });
  });

  it('événements sans compte connu : aucun utilisateur ajouté', () => {
    const beforeSend = opts.beforeSend as (e: ErrorEvent, h: unknown) => ErrorEvent | null;
    const out = beforeSend(ev({ message: 'boom' }), {});
    expect(out?.user).toBeUndefined();
  });

  it('fils d’Ariane : passent par le filtre (débrideur réduit à l’hôte)', () => {
    const beforeBreadcrumb = opts.beforeBreadcrumb as (c: Breadcrumb) => Breadcrumb | null;
    const out = beforeBreadcrumb(
      { category: 'xhr', data: { url: 'https://api.alldebrid.com/v4/x?apikey=K', status_code: 403 } } as unknown as Breadcrumb,
    );
    expect(out?.data).toEqual({ host: '[host]', status_code: 403 });
  });

  it('fils d’Ariane : intégration Console retirée, Breadcrumbs reconfiguré une seule fois', () => {
    const defaults = getDefaultIntegrations({});
    expect(defaults.map((i) => i.name)).toContain('Console');
    type Integrations = ReturnType<typeof getDefaultIntegrations>;
    const build = opts.integrations as (list: Integrations) => Integrations;
    const names = build(defaults).map((i) => i.name);
    expect(names).not.toContain('Console');
    expect(names.filter((name) => name === 'Breadcrumbs')).toHaveLength(1);
  });
});

describe('environnement', () => {
  it('navigateur par défaut', () => {
    expect(resolveEnvironment()).toBe('web');
  });

  it('application Windows : coque WebView2', () => {
    (window as unknown as { chrome: unknown }).chrome = { webview: { postMessage: () => undefined } };
    expect(resolveEnvironment()).toBe('windows');
  });

  it('application Android : Capacitor natif', () => {
    platform.native = true;
    expect(resolveEnvironment()).toBe('android');
  });
});

describe('initialisation', () => {
  it('sans effet en test : aucun client Sentry créé', () => {
    initSentry();
    expect(getClient()).toBeUndefined();
  });
});
