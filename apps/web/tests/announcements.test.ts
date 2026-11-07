// Annonces publiques : GET {base}/announcements sans authentification ni X-Profile-Id, même lorsqu'une session est ouverte.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchPublicAnnouncements } from '../src/data/announcements';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { setActiveProfile, setSession } from '../src/data/session';

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
});

describe('annonces publiques', () => {
  it('appel sans /admin, sans en-tête d’authentification ni de profil, même connecté', async () => {
    setSession('jeton-session', new Date(Date.now() + 600_000).toISOString(), 'greg');
    setActiveProfile('profil-1');
    const body = { announcements: [{ id: 'a1', title: 'Maintenance', message: 'Ce soir à 22 h.', level: 'warning' }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const list = await fetchPublicAnnouncements();

    expect(list).toEqual(body.announcements);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:7000/announcements');
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-profile-id')).toBe(false);
    expect(headers.has('x-profile-token')).toBe(false);
    expect(headers.has('x-admin-elevation')).toBe(false);
  });

  it('réponse sans liste : tableau vide', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await expect(fetchPublicAnnouncements()).resolves.toEqual([]);
  });
});
