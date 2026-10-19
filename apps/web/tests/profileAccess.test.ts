import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettings, reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { claimLocalConfig, CONFIG_OWNER_KEY } from '../src/data/configSync';
import { reloadSession } from '../src/data/session';
import type { Profile } from '../src/data/userStore';

/*
 * Accès aux profils : gestion réservée au profil principal, verrou parental du profil enfant (code du principal,
 * 5 essais puis blocage), et config lastAddon locale jamais héritée par un autre compte.
 */

const BASE = 'http://srv.test';
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const press = (digits: string) => digits.split('').forEach((d) => (document.querySelector(`[data-pin-key="${d}"]`) as HTMLElement).click());

const profile = (id: string, extra: Partial<Profile> = {}): Profile =>
  ({ id, name: id, avatarColor: '#ff5a36', isKid: false, kidMaxAge: 12, hasPin: false, allowedCatalogs: [], isMainProfile: false, ...extra }) as Profile;

const GOOD = '1234';
let failures = 0;
let calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
/** Config serveur par compte (réglages du profil principal). */
const serverConfig: Record<string, string> = {};
let currentUser = 'a';

function fakeServer() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url).replace(BASE, '');
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = String(init?.body ?? '');
    calls.push({ method: init?.method ?? 'GET', url: u, headers, body });
    const json = (o: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...h } });
    if (u === '/user/login') {
      currentUser = JSON.parse(body).username;
      return json({ token: 'tok-' + currentUser + '-'.padEnd(24, 'x'), expiresAt: new Date(Date.now() + 1e9).toISOString() });
    }
    if (u === '/user/me') return json({ account: { username: currentUser, role: 'member' } });
    if (u === '/user/logout') return new Response(null, { status: 204 });
    if (u === '/user/profiles' && (init?.method ?? 'GET') === 'GET') return json({ profiles: [{ id: 'main-' + currentUser, name: 'Principal', avatarColor: '#fff', isKid: false, hasPin: false, isMainProfile: true }, { id: 'kid-' + currentUser, name: 'Petit', avatarColor: '#fff', isKid: true, hasPin: false, isMainProfile: false }] });
    if (u === '/user/account/config') {
      if (init?.method === 'PUT') {
        if (headers['x-profile-id'] !== 'main-' + currentUser) return json({ error: 'main_profile_required' }, 403);
        serverConfig[currentUser] = JSON.parse(body).config;
        return json({ config: serverConfig[currentUser] });
      }
      return json({ config: serverConfig[currentUser] ?? null });
    }
    if (/\/user\/profiles\/[^/]+\/settings$/.test(u)) return json({ settings: {} });
    if (/\/unlock$/.test(u)) {
      if (failures >= 5) return json({ error: 'pin_locked' }, 429, { 'retry-after': '300' });
      if (JSON.parse(body).pin === GOOD) return json({ token: 'pt', expiresAt: new Date(Date.now() + 3e9).toISOString() });
      failures += 1;
      return failures >= 5 ? json({ error: 'pin_locked' }, 429, { 'retry-after': '300' }) : json({ error: 'invalid_pin' }, 403);
    }
    if (u === '/config/encode') return json({ config: 'DEFAUT-' + currentUser });
    return json({ error: 'not_found' }, 404);
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: '' }));
  reloadSettings();
  reloadSession();
  calls = [];
  failures = 0;
  for (const k of Object.keys(serverConfig)) delete serverConfig[k];
  document.querySelectorAll('.pin-back').forEach((n) => n.remove());
  document.querySelector('#auth')?.replaceChildren();
  vi.stubGlobal('fetch', fakeServer());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('config lastAddon locale : jamais héritée par un autre compte', () => {
  it('claimLocalConfig : conserve pour le même compte, vide pour un autre, adopte une config sans propriétaire si demandé', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'CFG-A' }));
    reloadSettings();
    claimLocalConfig('a', true); // sans propriétaire mémorisé (restauration de session) : la config est celle de ce compte
    expect(getSettings().config).toBe('CFG-A');
    expect(localStorage.getItem(CONFIG_OWNER_KEY)).toBe('a');
    claimLocalConfig('a');
    expect(getSettings().config).toBe('CFG-A');
    claimLocalConfig('b');
    expect(getSettings().config).toBe('');
    expect(getSettings().base).toBe(BASE);
    expect(localStorage.getItem(CONFIG_OWNER_KEY)).toBe('b');
  });

  it('sans propriétaire connu hors mode local : vidée', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'CFG-A' }));
    reloadSettings();
    claimLocalConfig('b');
    expect(getSettings().config).toBe('');
  });

  it('compte A configuré, déconnexion, compte B : aucune URL d’addon de A visible ni utilisée', async () => {
    const { chooseProfile, signIn, signOut } = await import('../src/data/auth');
    serverConfig.a = 'CFG-A-AVEC-CLE-DEBRIDEUR';
    await signIn('a', 'x'.repeat(10));
    await chooseProfile('main-a');
    expect(getSettings().config).toBe('CFG-A-AVEC-CLE-DEBRIDEUR');
    localStorage.setItem('laststream.homeFilters.main-a', '{"hidden":[1]}');
    await signOut();
    expect(getSettings().config).toBe('');
    expect(getSettings().base).toBe(BASE);
    expect(localStorage.getItem('laststream.homeFilters.main-a')).toBeNull();
    await signIn('b', 'x'.repeat(10));
    await chooseProfile('main-b');
    await tick();
    expect(getSettings().config).toBe('DEFAUT-b');
    expect(getSettings().config).not.toContain('CFG-A');
    expect(JSON.stringify(localStorage)).not.toContain('CFG-A');
    expect(calls.some((c) => c.body.includes('CFG-A') || c.url.includes('CFG-A'))).toBe(false);
  });

  it('même sans déconnexion propre (propriétaire différent mémorisé) : B ne reprend pas la config de A', async () => {
    const { chooseProfile, signIn } = await import('../src/data/auth');
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'CFG-A' }));
    localStorage.setItem(CONFIG_OWNER_KEY, 'a');
    reloadSettings();
    await signIn('b', 'x'.repeat(10));
    await chooseProfile('main-b');
    expect(getSettings().config).not.toContain('CFG-A');
    expect(calls.some((c) => c.method === 'PUT' && c.body.includes('CFG-A'))).toBe(false);
  });
});

describe('config lastAddon du compte : lisible par tous les profils', () => {
  it('enfant choisi juste après la connexion : config du compte reprise sans PIN du principal, sans écriture', async () => {
    const { chooseProfile, signIn } = await import('../src/data/auth');
    serverConfig.a = 'CFG-COMPTE';
    await signIn('a', 'x'.repeat(10));
    await chooseProfile('kid-a');
    expect(getSettings().config).toBe('CFG-COMPTE');
    const read = calls.find((c) => c.url === '/user/account/config');
    expect(read?.headers['x-profile-id']).toBe('kid-a');
    expect(read?.headers['x-profile-token']).toBeUndefined();
    expect(calls.some((c) => c.method === 'PUT' && c.url === '/user/account/config')).toBe(false);
  });

  it('le principal enregistre la config au niveau du compte', async () => {
    const { chooseProfile, signIn, pushConfig } = await import('../src/data/auth');
    serverConfig.a = 'CFG-COMPTE';
    await signIn('a', 'x'.repeat(10));
    await chooseProfile('main-a');
    pushConfig('NOUVELLE');
    await tick();
    expect(serverConfig.a).toBe('NOUVELLE');
  });
});

describe('gestion des profils réservée au profil principal', () => {
  async function setup(active: Profile | null, mainPin = false) {
    const a = await import('../src/data/auth');
    const ui = await import('../src/ui/auth-ui.js');
    const main = profile('gtko', { isMainProfile: true, hasPin: mainPin });
    const list = [main, profile('jessica'), profile('theo', { isKid: true })];
    a.auth.profiles = list;
    a.auth.profile = active ? list.find((p) => p.id === active.id)! : null;
    a.auth.status = active ? 'ready' : 'needs-profile';
    a.grantManager(null);
    ui.openPicker();
    return { a, ui };
  }
  const has = (sel: string) => document.querySelector(sel) !== null;

  it('profil principal actif : « Gérer les profils » et « Ajouter un profil » visibles', async () => {
    await setup(profile('gtko'));
    expect(has('[data-pf-manage]')).toBe(true);
    expect(has('[data-pf-add]')).toBe(true);
  });

  it('profil secondaire adulte (Jessica) : les deux sont masqués', async () => {
    await setup(profile('jessica'));
    expect(has('[data-pf-manage]')).toBe(false);
    expect(has('[data-pf-add]')).toBe(false);
  });

  it('profil enfant (Théo) : masqués aussi', async () => {
    await setup(profile('theo'));
    expect(has('[data-pf-manage]')).toBe(false);
    expect(has('[data-pf-add]')).toBe(false);
  });

  it('sans profil actif : « Ajouter » masqué ; « Gérer » demande le code du principal', async () => {
    await setup(null, true);
    expect(has('[data-pf-add]')).toBe(false);
    (document.querySelector('[data-pf-manage]') as HTMLElement).click();
    await tick();
    expect(document.querySelector('.pin-title')!.textContent).toBe('Code du profil principal');
    press(GOOD);
    await tick();
    expect(has('[data-pf-add]')).toBe(true);
  });
});

describe('verrou parental du profil enfant', () => {
  async function kidSetup(mainHasPin: boolean) {
    const a = await import('../src/data/auth');
    const ui = await import('../src/ui/auth-ui.js');
    const list = [profile('gtko', { isMainProfile: true, hasPin: mainHasPin }), profile('jessica'), profile('theo', { isKid: true })];
    a.auth.profiles = list;
    a.auth.profile = list[2];
    a.auth.status = 'ready';
    a.grantManager(null);
    return { a, ui };
  }

  it('quitter le profil enfant demande le code parental avant « Qui regarde ? »', async () => {
    const { a, ui } = await kidSetup(true);
    expect(a.parentalLockActive()).toBe(true);
    ui.leaveKidProfile();
    expect(document.querySelector('.pin-title')!.textContent).toBe('Code parental');
    expect(document.querySelector('.pf-grid')).toBeNull();
    press('0000');
    await tick();
    expect(document.querySelector('.pin-msg')!.textContent).toBe('Code incorrect.');
    expect(document.querySelector('.pf-grid')).toBeNull();
    press(GOOD);
    await tick();
    expect(document.querySelector('.pin-title')).toBeNull();
    expect(document.querySelector('.pf-grid')).not.toBeNull();
    // Le parent reconnu par son code peut gérer les profils ; « Fermer » ramène au profil enfant.
    expect(has('[data-pf-add]')).toBe(true);
    expect(has('[data-auth-close]')).toBe(true);
    (document.querySelector('[data-auth-close]') as HTMLElement).click();
    expect(a.auth.profile!.id).toBe('theo');
    // Le code n'est jamais gardé en clair côté client.
    expect(JSON.stringify(localStorage)).not.toContain(GOOD);
  });

  it('5 essais faux : blocage annoncé (5 minutes), même le bon code est refusé', async () => {
    const { ui } = await kidSetup(true);
    ui.leaveKidProfile();
    for (let i = 0; i < 5; i += 1) { press('0000'); await tick(); }
    expect(document.querySelector('.pin-msg')!.textContent).toContain('bloqué');
    expect(document.querySelector('.pin-msg')!.textContent).toContain('5 min');
    press(GOOD);
    await tick();
    expect(document.querySelector('.pf-grid')).toBeNull();
    expect(calls.filter((c) => c.url.endsWith('/unlock')).length).toBeGreaterThanOrEqual(6);
  });

  it('sans code défini : l’écran s’ouvre et les réglages du principal proposent d’en définir un', async () => {
    const { a, ui } = await kidSetup(false);
    expect(a.parentalLockActive()).toBe(false);
    expect(a.parentalCodeMissing()).toBe(true);
    ui.leaveKidProfile();
    expect(document.querySelector('.pf-grid')).not.toBeNull();
  });

  function has(sel: string) { return document.querySelector(sel) !== null; }
});
