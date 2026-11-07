// Première visite : une adresse de serveur suffit pour afficher l'écran de connexion (la config est générée après).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBase, getMode, PUBLIC_BASE, reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { auth, initAuth, offlineWithoutSession } from '../src/data/auth';
import { LEGACY_LOCAL_MODE_KEY } from '../src/data/session';

const unauthorized = () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });

describe('première visite', () => {
  beforeEach(() => { localStorage.clear(); reloadSettings(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('serveur connu mais config vide, sans session : écran de connexion', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'https://srv.example', config: '' }));
    reloadSettings();
    vi.stubGlobal('fetch', vi.fn(async () => unauthorized()));
    expect(await initAuth()).toBe('needs-login');
    expect(auth.status).toBe('needs-login');
  });

  it('aucune adresse, pas de mode local : serveur Laststream par défaut, puis écran de connexion', async () => {
    const fetchMock = vi.fn(async (_url: string) => unauthorized());
    vi.stubGlobal('fetch', fetchMock);
    expect(await initAuth()).toBe('needs-login');
    expect(auth.status).toBe('needs-login');
    expect(getBase()).toBe(PUBLIC_BASE);
    expect(getMode()).toBe('public');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(PUBLIC_BASE + '/user/me');
  });

  it('aucune adresse et serveur injoignable, sans session : statut hors ligne (l’écran de connexion le signale), jamais le mode local', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string) => { throw new TypeError('Failed to fetch'); }));
    expect(await initAuth()).toBe('offline');
    expect(offlineWithoutSession()).toBe(true);
    expect(getBase()).toBe(PUBLIC_BASE);
  });

  it('ancien choix « continuer sans compte » (clé laststream.localmode) : effacé, connexion demandée, pas de mode local', async () => {
    localStorage.setItem(LEGACY_LOCAL_MODE_KEY, '1');
    const fetchMock = vi.fn(async (_url: string) => unauthorized());
    vi.stubGlobal('fetch', fetchMock);
    expect(await initAuth()).toBe('needs-login');
    expect(auth.status).toBe('needs-login');
    expect(localStorage.getItem(LEGACY_LOCAL_MODE_KEY)).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(PUBLIC_BASE + '/user/me');
  });
});
