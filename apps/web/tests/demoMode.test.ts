// Mode démo vitrine : activation par l'URL seulement, jamais persistant, lecture et écritures serveur désactivées.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/configApi', () => ({ encodeConfig: vi.fn(async () => 'CFG') }));

import { auth } from '../src/data/auth';
import { getBase, getConfig, saveSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { DEMO_PROFILES, detectDemo, demoAllows, isDemo, setDemoFlags, startDemo } from '../src/data/demo';
import { LEGACY_LOCAL_MODE_KEY, SESSION_KEY } from '../src/data/session';
import { userStore } from '../src/data/userStore';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://laststream.gtux-prog.workers.dev';

describe('activation par l’URL', () => {
  it('?demo=1 et #/demo activent, rien d’autre', () => {
    expect(detectDemo('?demo=1', '').on).toBe(true);
    expect(detectDemo('', '#/demo').on).toBe(true);
    expect(detectDemo('', '#/demo?clean=1&profile=leo')).toEqual({ on: true, clean: true, profile: 'leo' });
    expect(detectDemo('?demo=1&clean=1', '').clean).toBe(true);
    expect(detectDemo('?demo=0', '#/home').on).toBe(false);
    expect(detectDemo('', '').on).toBe(false);
    expect(detectDemo('?demo', '#/demonstration').on).toBe(false);
    expect(detectDemo('', '').clean).toBe(false);
  });

  it('le bandeau reste affiché sans clean=1', () => {
    expect(detectDemo('?demo=1', '').clean).toBe(false);
  });
});

describe('garde réseau', () => {
  it('seules les routes publiques de catalogue partent vers le serveur', () => {
    const b = [BASE];
    expect(demoAllows(`${BASE}/CFG/lt/tmdb/trending/movie/week?language=fr-FR`, 'GET', b)).toBe(true);
    expect(demoAllows(`${BASE}/CFG/lt/meta/movie/550`, 'GET', b)).toBe(true);
    expect(demoAllows(`${BASE}/CFG/lt/tv/channels`, 'GET', b)).toBe(true);
    expect(demoAllows(`${BASE}/CFG/lt/tv/hls?u=x`, 'GET', b)).toBe(false);
    expect(demoAllows(`${BASE}/CFG/stream/movie/tt1.json`, 'GET', b)).toBe(false);
    expect(demoAllows(`${BASE}/CFG/lt/range-source`, 'POST', b)).toBe(false);
    expect(demoAllows(`${BASE}/CFG/lt/tmdb/trending/movie/week`, 'POST', b)).toBe(false);
    for (const p of ['user/me', 'user/library', 'party/rooms', 'admin/x', 'config/encode']) {
      expect(demoAllows(`${BASE}/${p}`, 'GET', b)).toBe(false);
    }
    expect(demoAllows('https://image.tmdb.org/t/p/w500/a.jpg', 'GET', b)).toBe(true);
    expect(demoAllows('https://image.tmdb.org/t/p/w500/a.jpg', 'POST', b)).toBe(false);
  });
});

describe('mode démo démarré', () => {
  const fetchMock = vi.fn(async (_u: unknown, _i?: unknown) => new Response('{}', { status: 200 }));
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    localStorage.clear();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setDemoFlags({ on: true, clean: true, profile: 'leo' });
    expect(await startDemo()).toBe(true);
  });
  afterAll(() => { globalThis.fetch = realFetch; setDemoFlags({ on: false, clean: false, profile: '' }); });

  it('profils factices, jamais un nom réel, profil enfant Léo demandé', () => {
    expect(isDemo()).toBe(true);
    expect(DEMO_PROFILES.map((p) => p.name)).toEqual(['Alex', 'Sam', 'Léo']);
    expect(auth.profiles.map((p) => p.name)).toEqual(['Alex', 'Sam', 'Léo']);
    expect(auth.profile?.name).toBe('Léo');
    expect(auth.profile?.isKid).toBe(true);
    expect(userStore.currentProfile().name).toBe('Léo');
    expect(JSON.stringify(userStore.getProfiles())).not.toMatch(/Greg/);
    expect(auth.status).toBe('local'); // aucune fonction de compte : amis, parties, invitations
  });

  it('rien n’est écrit dans le stockage : pas de session, pas de mode local, pas de réglages', () => {
    expect(getBase()).toBe(BASE);
    expect(getConfig()).toBe('CFG');
    saveSettings({ base: BASE });
    userStore.toggleLibrary({ id: 1, type: 'movie', title: 'X', poster: '' });
    expect(userStore.inLibrary('movie:1')).toBe(true); // en mémoire
    expect(localStorage.length).toBe(0);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_LOCAL_MODE_KEY)).toBeNull();
  });

  it('requêtes de flux et d’écriture refusées, catalogue autorisé', async () => {
    fetchMock.mockClear();
    await expect(fetch(`${BASE}/CFG/stream/movie/tt1.json`)).rejects.toThrow();
    await expect(fetch(`${BASE}/user/me`)).rejects.toThrow();
    await expect(fetch(`${BASE}/CFG/lt/range-source`, { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await fetch(`${BASE}/CFG/lt/tmdb/trending/movie/week`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('la lecture est désactivée : aucune recherche de source', async () => {
    const { playBest } = await import('../src/player/session.js');
    fetchMock.mockClear();
    await playBest({ type: 'movie', id: '550', name: 'Fight Club', key: 'movie:550' }, null);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sans paramètre d’URL', () => {
  it('le mode démo est désactivé au chargement normal', () => {
    expect(detectDemo('', '').on).toBe(false);
  });
});
