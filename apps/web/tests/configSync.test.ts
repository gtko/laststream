import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettings, reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { configForAccount, reconcileConfig, servedByLastAddon } from '../src/data/configSync';

describe('synchronisation de la config avec le compte', () => {
  beforeEach(() => { localStorage.clear(); reloadSettings(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('refuse une config vide ou trop grosse', () => {
    expect(configForAccount('  ')).toBeNull();
    expect(configForAccount('x'.repeat(5000))).toBeNull();
    expect(configForAccount(' abc ')).toBe('abc');
  });

  it('détecte lastAddon sur l’origine courante via /health', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', f);
    expect(await servedByLastAddon()).toBe(true);
    expect(String((f.mock.calls as unknown[][])[0][0])).toMatch(/\/health$/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('x'); }));
    expect(await servedByLastAddon()).toBe(false);
  });

  it('reprend la config du compte quand rien en local (base = origine si servi par lastAddon)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    expect(await reconcileConfig({ lastaddonConfig: 'CHIFFRE' })).toBe('pulled');
    expect(getSettings().config).toBe('CHIFFRE');
    expect(getSettings().base).toBe(location.origin);
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}').config).toBe('CHIFFRE');
  });

  it('garde la base par défaut quand la page n’est pas servie par lastAddon', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await reconcileConfig({ lastaddonConfig: 'C2' })).toBe('pulled');
    expect(getSettings().base).not.toBe(location.origin);
  });

  it('compte neuf (ni config locale ni config au compte) : génère la config par défaut via /config/encode et la propose au compte', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'https://srv.example', config: '' }));
    reloadSettings();
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ config: 'DEFAUT' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    expect(await reconcileConfig({})).toBe('push');
    expect(getSettings().config).toBe('DEFAUT');
    expect(String(f.mock.calls[0][0])).toBe('https://srv.example/config/encode');
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({});
  });

  it('compte neuf, serveur injoignable : rien n’est inventé', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'https://srv.example', config: '' }));
    reloadSettings();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await reconcileConfig({})).toBe('none');
    expect(getSettings().config).toBe('');
  });

  it('le compte fait foi : une config locale différente est remplacée ; sans config au compte, la locale est proposée', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'LOCAL' }));
    reloadSettings();
    expect(await reconcileConfig({})).toBe('push');
    expect(getSettings().config).toBe('LOCAL');
    expect(await reconcileConfig({ lastaddonConfig: 'AUTRE' })).toBe('pulled');
    expect(getSettings().config).toBe('AUTRE');
    expect(getSettings().base).toBe('http://localhost:7000');
    expect(await reconcileConfig({ lastaddonConfig: 'AUTRE' })).toBe('none');
  });
});

describe('détection lastAddon : faux positifs', () => {
  it("refuse une origine qui renvoie index.html (fallback SPA, app Android)", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('HTML'); } })));
    const { servedByLastAddon } = await import('../src/data/configSync');
    expect(await servedByLastAddon()).toBe(false);
    vi.unstubAllGlobals();
  });
});
