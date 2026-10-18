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

  it('ne remplace pas une config locale et propose de l’envoyer si le compte n’en a pas', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'LOCAL' }));
    reloadSettings();
    expect(await reconcileConfig({ lastaddonConfig: 'AUTRE' })).toBe('none');
    expect(getSettings().config).toBe('LOCAL');
    expect(await reconcileConfig({})).toBe('push');
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
