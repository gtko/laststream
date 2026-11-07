import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, reloadSession, setActiveProfile, setSession } from '../src/data/session';
import { getSettings, reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { CONFIG_OWNER_KEY } from '../src/data/configSync';

/*
 * Invitation au foyer : session verrouillée sur un profil invité (`lockedProfileId` de /user/me). L'app active ce profil
 * directement (jamais le sélecteur « Qui regarde ? »), et la session renvoyée par redeem démarre sur ce profil.
 */

const BASE = 'http://srv.test';
const future = () => new Date(Date.now() + 3e9).toISOString();
const TOKEN_LOGIN = 'tok-login-' + 'x'.repeat(24);
const TOKEN_REDEEM = 'tok-redeem-' + 'y'.repeat(24);

const profileDto = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, avatarColor: '#ff5a36', avatar: null, isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [],
  isMainProfile: false, createdAt: '2026-01-01T00:00:00Z', ...extra,
});
const PROFILES = [
  profileDto('main-h', { isMainProfile: true, name: 'Hôte' }),
  profileDto('inv-1', { name: 'Invitée' }),
  profileDto('kid-h', { isKid: true, kidMaxAge: 12, name: 'Petit' }),
];

let meLocked: string | null = null;
let meRole: 'owner' | 'member' = 'member';
let meFails = false;
let calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];

function fakeServer() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url).replace(BASE, '');
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ method: init?.method ?? 'GET', url: u, headers });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u === '/user/login') return json({ token: TOKEN_LOGIN, expiresAt: future() });
    if (u === '/user/me') {
      if (meFails) return json({ error: 'internal' }, 500);
      return json({ account: { id: 'acc-host', username: 'hote', role: meRole }, lockedProfileId: meLocked });
    }
    if (u === '/user/logout') return new Response(null, { status: 204 });
    if (u === '/user/profiles') return json({ profiles: PROFILES });
    if (u.endsWith('/settings')) return json({ settings: {} });
    if (u === '/user/account/config' || u === '/user/account/tv-sources') return json({ config: null, lists: null });
    return json({ error: 'not_found' }, 404);
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: '' }));
  reloadSettings();
  reloadSession();
  calls = [];
  meLocked = null;
  meRole = 'member';
  meFails = false;
  vi.stubGlobal('fetch', fakeServer());
});

afterEach(async () => {
  const { signOut } = await import('../src/data/auth');
  await signOut(true);
  vi.unstubAllGlobals();
});

describe('session verrouillée : profil invité activé directement', () => {
  it('initAuth : /user/me verrouillé sur un profil → ce profil est actif, jamais needs-profile, même après un profil enregistré', async () => {
    const a = await import('../src/data/auth');
    setSession(TOKEN_LOGIN, future(), 'hote');
    setActiveProfile('main-h');
    meLocked = 'inv-1';
    meRole = 'owner'; // un propriétaire verrouillé n'a pas les droits du compte
    const statuses: string[] = [];
    const off = a.onAuthChange(() => statuses.push(a.auth.status));
    const status = await a.initAuth();
    off();
    expect(status).toBe('ready');
    expect(a.auth.profile?.id).toBe('inv-1');
    expect(a.isProfileLocked()).toBe(true);
    expect(a.auth.locked).toBe(true);
    expect(a.auth.isOwner).toBe(false);
    expect(statuses).not.toContain('needs-profile');
    expect(getSession()?.profileId).toBe('inv-1');
  });

  it('initAuth : sans verrouillage, le sélecteur reste proposé comme avant', async () => {
    const a = await import('../src/data/auth');
    setSession(TOKEN_LOGIN, future(), 'hote');
    meLocked = null;
    const status = await a.initAuth();
    expect(status).toBe('needs-profile');
    expect(a.isProfileLocked()).toBe(false);
    expect(a.auth.profile).toBeNull();
  });

  it('initAuth : profil verrouillé supprimé entre-temps → session fermée, retour à la connexion (jamais le sélecteur)', async () => {
    const a = await import('../src/data/auth');
    setSession(TOKEN_LOGIN, future(), 'hote');
    meLocked = 'supprime';
    const status = await a.initAuth();
    expect(status).toBe('needs-login');
    expect(getSession()).toBeNull();
    expect(a.isProfileLocked()).toBe(false);
  });

  it('connexion (POST /user/login) avec un identifiant de profil : /user/me verrouillé → profil invité actif', async () => {
    const a = await import('../src/data/auth');
    meLocked = 'inv-1';
    const status = await a.signIn('invitee', 'x'.repeat(10));
    expect(status).toBe('ready');
    expect(a.auth.profile?.id).toBe('inv-1');
    expect(a.isProfileLocked()).toBe(true);
    expect(calls.some((c) => c.url === '/user/me')).toBe(true);
  });

  it('signOut : le verrou est levé', async () => {
    const a = await import('../src/data/auth');
    meLocked = 'inv-1';
    await a.signIn('invitee', 'x'.repeat(10));
    expect(a.isProfileLocked()).toBe(true);
    await a.signOut(true);
    expect(a.isProfileLocked()).toBe(false);
  });
});

describe('adoptSession : session du lien d’invitation, enregistrée comme après signIn', () => {
  it('enregistre le jeton et les dates, lit le compte avec le nouveau jeton, et démarre sur le profil invité', async () => {
    const a = await import('../src/data/auth');
    meLocked = 'inv-1';
    const status = await a.adoptSession({ token: TOKEN_REDEEM, expiresAt: future(), profileId: 'inv-1' });
    expect(status).toBe('ready');
    expect(getSession()?.token).toBe(TOKEN_REDEEM);
    expect(getSession()?.username).toBe('hote');
    expect(getSession()?.profileId).toBe('inv-1');
    expect(a.auth.username).toBe('hote');
    expect(a.auth.accountId).toBe('acc-host');
    expect(a.auth.profile?.id).toBe('inv-1');
    expect(a.isProfileLocked()).toBe(true);
    expect(a.auth.isOwner).toBe(false);
    const me = calls.find((c) => c.url === '/user/me');
    expect(me?.headers.authorization).toBe('Bearer ' + TOKEN_REDEEM);
    expect(calls.some((c) => c.url.startsWith('/user/household-invites'))).toBe(false);
  });

  it('sans /user/me utilisable : le profil du lien est tout de même activé et verrouillé', async () => {
    const a = await import('../src/data/auth');
    meFails = true;
    const status = await a.adoptSession({ token: TOKEN_REDEEM, expiresAt: future(), profileId: 'inv-1' });
    expect(status).toBe('ready');
    expect(a.auth.profile?.id).toBe('inv-1');
    expect(a.isProfileLocked()).toBe(true);
    expect(getSettings().config).toBe('');
  });

  it('ne garde pas la config locale d’un autre compte (sans /user/me, la config est vidée)', async () => {
    const a = await import('../src/data/auth');
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'CFG-AUTRE' }));
    reloadSettings();
    localStorage.setItem(CONFIG_OWNER_KEY, 'autre');
    meFails = true;
    await a.adoptSession({ token: TOKEN_REDEEM, expiresAt: future(), profileId: 'inv-1' });
    expect(getSettings().config).toBe('');
  });
});
