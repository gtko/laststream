import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({ native: true }));
vi.mock('@capacitor/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@capacitor/core')>();
  return { ...mod, Capacitor: { ...mod.Capacitor, isNativePlatform: () => cap.native } };
});

import { DEFAULT_BASE, getSettings, PUBLIC_BASE, reloadSettings, saveSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { reconcileConfig } from '../src/data/configSync';
import { effectiveBase, isLocalHttpBase, prepareServer, setDevLocalProbe, setRelaunch, setServedOrigin, switchServer, type ServerContext } from '../src/data/serverMode';
import { ensureServerSetup } from '../src/ui/server-setup.js';

const LAN = 'http://192.168.1.20:7000';
const NAS = 'https://nas.example.com';
const ORIGIN = 'http://localhost:7000';
const ANDROID: ServerContext = { native: true, servedOrigin: null };
const WEB: ServerContext = { native: false, servedOrigin: null };
const SERVED: ServerContext = { native: false, servedOrigin: ORIGIN };

const health = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const down = (): Response => { throw new TypeError('Failed to fetch'); };

function stubFetch(route: (url: string) => Response) {
  const f = vi.fn(async (url: string) => route(String(url)));
  vi.stubGlobal('fetch', f);
  return f;
}
const calls = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.map((c) => String(c[0]));

function seed(value: Record<string, unknown>) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(value));
  reloadSettings();
}

const relaunch = vi.fn<() => void>();
beforeEach(() => {
  cap.native = true;
  localStorage.clear();
  reloadSettings();
  setServedOrigin(null);
  relaunch.mockClear();
  setRelaunch(relaunch);
  // Sonde du lastAddon local désactivée par défaut : elle n'existe qu'en développement (vitest y est en DEV).
  setDevLocalProbe(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.classList.remove('modal-open');
});

describe('adresse effective selon le choix et la plateforme', () => {
  it.each([
    ['perso choisi (Android)', { mode: 'custom' as const, custom: LAN, base: '' }, ANDROID, LAN],
    ['Laststream par défaut (Android)', { mode: 'public' as const, base: LAN, custom: LAN }, ANDROID, PUBLIC_BASE],
    ['perso choisi sur une page servie', { mode: 'custom' as const, custom: LAN, base: ORIGIN }, SERVED, LAN],
    ['Laststream par défaut sur une page servie', { mode: 'public' as const, base: '', custom: LAN }, SERVED, ORIGIN],
    ['perso vide : Laststream', { mode: 'custom' as const, custom: '', base: '' }, ANDROID, PUBLIC_BASE],
    ['web hors lastAddon : adresse enregistrée, inchangée', { base: 'http://example.com:9000' }, WEB, 'http://example.com:9000'],
  ])('%s', (_name, choice, ctx, expected) => {
    expect(effectiveBase(choice, ctx)).toBe(expected);
  });

  it.each([
    ['http://localhost:7000', true],
    ['http://192.168.1.20:7000', true],
    ['http://10.0.0.5:7000', true],
    [PUBLIC_BASE, false],
    ['http://example.com', false],
    ['pas une adresse', false],
  ])('isLocalHttpBase(%s) = %s', (base, local) => {
    expect(isLocalHttpBase(base)).toBe(local);
  });
});

describe('Android : serveur Laststream par défaut', () => {
  it('premier lancement sans adresse : serveur Laststream, sans écran de saisie', async () => {
    const f = stubFetch(() => health());
    await ensureServerSetup();
    expect(document.querySelector('#srv-setup')).toBeNull();
    expect(getSettings()).toMatchObject({ base: PUBLIC_BASE, mode: 'public' });
    expect(calls(f)).toEqual([`${PUBLIC_BASE}/health`]);
  });

  it('serveur Laststream injoignable au premier lancement : écran de saisie, « Réessayer » le relance', async () => {
    stubFetch(() => down());
    let resolved = false;
    const p = ensureServerSetup().then(() => { resolved = true; });
    await vi.waitFor(() => expect(document.querySelector('#srv-setup')).not.toBeNull());
    const input = document.querySelector('#srv-setup input[name="base"]') as HTMLInputElement;
    expect(input.value).toBe(PUBLIC_BASE);
    expect(getSettings().base).toBe('');

    (document.querySelector('[data-srv-retry]') as HTMLElement).click();
    await vi.waitFor(() => expect(document.querySelector('#srv-msg')?.textContent).toMatch(/ne répond toujours pas/));
    expect(resolved).toBe(false);

    stubFetch(() => health());
    (document.querySelector('[data-srv-retry]') as HTMLElement).click();
    await p;
    expect(resolved).toBe(true);
    expect(document.querySelector('#srv-setup')).toBeNull();
    expect(getSettings()).toMatchObject({ base: PUBLIC_BASE, mode: 'public' });
  });

  it('une page HTML (fallback SPA) n’est pas lastAddon : écran de saisie', async () => {
    stubFetch(() => new Response('<!doctype html><html></html>', { status: 200 }));
    expect(await prepareServer()).toBe(false);
    expect(getSettings().base).toBe('');
  });

  it('lancement suivant : rien n’est sondé', async () => {
    seed({ mode: 'public', base: PUBLIC_BASE, config: 'CFG' });
    const f = stubFetch(() => down());
    await ensureServerSetup();
    expect(f).not.toHaveBeenCalled();
    expect(getSettings()).toMatchObject({ base: PUBLIC_BASE, config: 'CFG' });
  });
});

describe('migration de l’ancienne adresse locale (écran précédent)', () => {
  it('adresse locale qui répond : devient le serveur perso, config conservée', async () => {
    seed({ base: LAN, config: 'CFG' });
    const f = stubFetch(() => health());
    expect(await prepareServer()).toBe(true);
    expect(getSettings()).toMatchObject({ mode: 'custom', custom: LAN, base: LAN, config: 'CFG' });
    expect(calls(f)).toEqual([`${LAN}/health`]);
  });

  it('adresse locale injoignable, serveur Laststream OK : serveur Laststream, config remise à zéro', async () => {
    seed({ base: LAN, config: 'CFG' });
    stubFetch((url) => (url.startsWith(PUBLIC_BASE) ? health() : down()));
    expect(await prepareServer()).toBe(true);
    expect(getSettings()).toMatchObject({ mode: 'public', base: PUBLIC_BASE, config: '' });
  });

  it('adresse locale et serveur Laststream injoignables : écran de saisie', async () => {
    seed({ base: LAN, config: 'CFG' });
    stubFetch(() => down());
    expect(await prepareServer()).toBe(false);
  });

  it('adresse https enregistrée : perso, sans sonde', async () => {
    seed({ base: NAS, config: 'CFG' });
    const f = stubFetch(() => down());
    expect(await prepareServer()).toBe(true);
    expect(getSettings()).toMatchObject({ mode: 'custom', custom: NAS, base: NAS, config: 'CFG' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('pages servies par lastAddon et web : comportement inchangé', () => {
  it('app Windows sans choix : l’origine de la page', async () => {
    cap.native = false;
    setServedOrigin(ORIGIN);
    seed({ base: LAN, config: 'CFG' });
    const f = stubFetch(() => down());
    expect(await prepareServer()).toBe(true);
    expect(getSettings().base).toBe(ORIGIN);
    expect(f).not.toHaveBeenCalled();
  });

  it('app Windows avec serveur perso : son adresse partout', async () => {
    cap.native = false;
    setServedOrigin(ORIGIN);
    seed({ mode: 'custom', custom: NAS, base: ORIGIN, config: 'CFG' });
    await prepareServer();
    expect(getSettings().base).toBe(NAS);
  });

  it('web hors lastAddon sans adresse, serveur public muet : rien de forcé, pas d’écran', async () => {
    cap.native = false;
    const f = stubFetch(() => down());
    await ensureServerSetup();
    expect(document.querySelector('#srv-setup')).toBeNull();
    expect(getSettings().base).toBe('');
    expect(calls(f)).toEqual([PUBLIC_BASE + '/health']);
  });
});

describe('changement de serveur', () => {
  it('nouveau serveur : config du nouveau serveur, cache vidé, application relancée', () => {
    seed({ mode: 'public', base: PUBLIC_BASE, config: 'CFG' });
    expect(switchServer({ mode: 'custom', custom: NAS }, 'NOUVEAU')).toBe(true);
    expect(getSettings()).toMatchObject({ mode: 'custom', custom: NAS, base: NAS, config: 'NOUVEAU' });
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('retour au serveur Laststream : config de l’ancien serveur effacée', () => {
    seed({ mode: 'custom', custom: NAS, base: NAS, config: 'OLD' });
    expect(switchServer({ mode: 'public' })).toBe(true);
    expect(getSettings()).toMatchObject({ mode: 'public', base: PUBLIC_BASE, config: '', custom: NAS });
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('même serveur : rien n’est déconnecté, la config est gardée', () => {
    seed({ mode: 'public', base: PUBLIC_BASE, config: 'CFG' });
    expect(switchServer({ mode: 'public' })).toBe(false);
    expect(getSettings()).toMatchObject({ mode: 'public', base: PUBLIC_BASE, config: 'CFG' });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('le choix est mémorisé dans le stockage (mode et URL perso)', () => {
    seed({ base: PUBLIC_BASE, config: '' });
    switchServer({ mode: 'custom', custom: NAS }, 'X');
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}')).toMatchObject({ mode: 'custom', custom: NAS, base: NAS });
  });
});

describe('synchronisation de la config avec le compte', () => {
  it('une config tirée du compte va vers le serveur perso choisi', async () => {
    seed({ mode: 'custom', custom: LAN, base: '', config: '' });
    expect(await reconcileConfig({ lastaddonConfig: 'CHIFFRE' })).toBe('pulled');
    expect(getSettings()).toMatchObject({ base: LAN, config: 'CHIFFRE' });
  });
});

describe('première visite dans un navigateur vierge (hors lastAddon)', () => {
  beforeEach(() => { cap.native = false; setServedOrigin(null); localStorage.clear(); reloadSettings(); });
  afterEach(() => { cap.native = true; vi.unstubAllGlobals(); });

  it('le serveur public répond : il devient le serveur (écran de connexion, pas « non configuré »)', async () => {
    stubFetch(() => health());
    expect(await prepareServer()).toBe(true);
    expect(getSettings().base).toBe(PUBLIC_BASE);
  });

  it('le serveur public ne répond pas : rien n’est enregistré', async () => {
    stubFetch(down);
    expect(await prepareServer()).toBe(true);
    expect(getSettings().base).toBe('');
  });
});

describe('développement : lastAddon local avant le serveur public (navigateur vierge)', () => {
  beforeEach(() => { cap.native = false; setServedOrigin(null); setDevLocalProbe(true); localStorage.clear(); reloadSettings(); });
  afterEach(() => { cap.native = true; setDevLocalProbe(false); vi.unstubAllGlobals(); });

  it('le lastAddon local répond : son adresse est enregistrée (sans mode perso), le serveur public n’est pas sondé', async () => {
    const f = stubFetch((url) => (url.startsWith(DEFAULT_BASE) ? health() : down()));
    expect(await prepareServer()).toBe(true);
    expect(getSettings()).toMatchObject({ base: DEFAULT_BASE });
    expect(getSettings().mode).toBeUndefined();
    expect(getSettings().custom).toBe('');
    expect(calls(f)).toEqual([`${DEFAULT_BASE}/health`]);
  });

  it('après la sonde locale, une adresse saisie à la main est gardée au démarrage suivant', async () => {
    const f = stubFetch((url) => (url.startsWith(DEFAULT_BASE) ? health() : down()));
    expect(await prepareServer()).toBe(true);
    saveSettings({ base: PUBLIC_BASE });
    expect(await prepareServer()).toBe(true);
    expect(getSettings().base).toBe(PUBLIC_BASE);
    expect(calls(f)).toEqual([`${DEFAULT_BASE}/health`]);
  });

  it('le lastAddon local est muet : repli sur le serveur public', async () => {
    const f = stubFetch((url) => (url.startsWith(PUBLIC_BASE) ? health() : down()));
    expect(await prepareServer()).toBe(true);
    expect(getSettings()).toMatchObject({ mode: 'public', base: PUBLIC_BASE });
    expect(calls(f)).toEqual([`${DEFAULT_BASE}/health`, `${PUBLIC_BASE}/health`]);
  });

  it('hors développement : le lastAddon local n’est pas sondé, comportement inchangé', async () => {
    setDevLocalProbe(false);
    const f = stubFetch(() => health());
    expect(await prepareServer()).toBe(true);
    expect(getSettings()).toMatchObject({ mode: 'public', base: PUBLIC_BASE });
    expect(calls(f)).toEqual([`${PUBLIC_BASE}/health`]);
  });

  it('réglages déjà enregistrés : le lastAddon local n’est pas sondé, comportement inchangé', async () => {
    seed({ mode: 'public', base: '', config: '' });
    const f = stubFetch(() => health());
    expect(await prepareServer()).toBe(true);
    expect(getSettings()).toMatchObject({ mode: 'public', base: PUBLIC_BASE });
    expect(calls(f)).toEqual([`${PUBLIC_BASE}/health`]);
  });
});
