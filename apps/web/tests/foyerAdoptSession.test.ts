// adoptSession (invitation au foyer) : si la session du lien ne peut pas s'ouvrir (profils injoignables, profil verrouillé
// introuvable), la session posée par le lien est effacée : le lien est déjà consommé, rien ne doit rester à moitié ouvert.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { getSession, reloadSession } from '../src/data/session';

const BASE = 'http://srv.test';
const TOKEN = 'tok-redeem-' + 'y'.repeat(24);
const future = () => new Date(Date.now() + 3e9).toISOString();

const profileDto = (id: string) => ({
  id, name: id, avatarColor: '#ff5a36', avatar: null, isKid: false, kidMaxAge: null, hasPin: false,
  allowedCatalogs: [], isMainProfile: false, createdAt: '2026-01-01T00:00:00Z',
});

let profilesDown = false;
let lockedProfile: string | null = 'inv-1';
let profiles = [profileDto('inv-1')];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: '' }));
  reloadSettings();
  reloadSession();
  profilesDown = false;
  lockedProfile = 'inv-1';
  profiles = [profileDto('inv-1')];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url).replace(BASE, '');
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u === '/user/me') return json({ account: { id: 'acc-host', username: 'hote', role: 'member' }, lockedProfileId: lockedProfile });
    if (u === '/user/profiles') return profilesDown ? json({ error: 'internal' }, 500) : json({ profiles });
    if (u === '/user/logout') return new Response(null, { status: 204 });
    if (u.endsWith('/settings')) return json({ settings: {} });
    if (u === '/user/account/config' || u === '/user/account/tv-sources') return json({ config: null, lists: null });
    return json({ error: 'not_found' }, 404);
  }));
});

afterEach(async () => {
  const { signOut } = await import('../src/data/auth');
  await signOut(true);
  vi.unstubAllGlobals();
});

describe('adoptSession : échec → session effacée', () => {
  it('profils injoignables : l’appel échoue et la session posée par le lien est effacée', async () => {
    const a = await import('../src/data/auth');
    profilesDown = true;
    await expect(a.adoptSession({ token: TOKEN, expiresAt: future(), profileId: 'inv-1' })).rejects.toThrow();
    expect(getSession()).toBeNull();
  });

  it('profil verrouillé introuvable : l’appel échoue et la session est effacée', async () => {
    const a = await import('../src/data/auth');
    lockedProfile = 'ghost';
    await expect(a.adoptSession({ token: TOKEN, expiresAt: future(), profileId: 'ghost' })).rejects.toThrow();
    expect(getSession()).toBeNull();
  });
});
