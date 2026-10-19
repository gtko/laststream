// Mode démo vitrine : activation par l'URL seulement, jamais persistant, lecture et écritures serveur désactivées.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const encodeConfig = vi.hoisted(() => vi.fn(async () => 'CFG'));
vi.mock('../src/data/configApi', () => ({ encodeConfig }));

import { auth } from '../src/data/auth';
import { getBase, getConfig, saveSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { DEMO_PROFILES, demoAllows, detectDemo, isDemo, removeGuard, setDemoFlags, startDemo } from '../src/data/demo';
import { restoreStorage, substituteStorage } from '../src/demoBoot';
import { LEGACY_LOCAL_MODE_KEY, SESSION_KEY } from '../src/data/session';
import { userStore } from '../src/data/userStore';

const BASE = 'https://laststream.gtux-prog.workers.dev';
const OFF = { on: false, clean: false, profile: '' };
const realStorage = globalThis.localStorage;
const realSessionStorage = globalThis.sessionStorage;
const realFetch = globalThis.fetch;
const SESSION = JSON.stringify({ token: 'SECRET-TOKEN', expiresAt: '2999-01-01T00:00:00Z', username: 'vrai', profileId: null, profileTokens: {} });

describe('activation par l’URL', () => {
  it('?demo=1 et #/demo activent, rien d’autre', () => {
    expect(detectDemo('?demo=1', '').on).toBe(true);
    expect(detectDemo('', '#/demo').on).toBe(true);
    expect(detectDemo('', '#/demo?clean=1&profile=leo')).toEqual({ on: true, clean: true, profile: 'leo' });
    expect(detectDemo('?demo=1&clean=1', '').clean).toBe(true);
    expect(detectDemo('?demo=1', '').clean).toBe(false);
    expect(detectDemo('?demo=0', '#/home').on).toBe(false);
    expect(detectDemo('', '').on).toBe(false);
    expect(detectDemo('?demo', '#/demonstration').on).toBe(false);
  });
});

describe('garde réseau : liste blanche', () => {
  const b = [BASE];
  it('autorise le catalogue public et les fichiers statiques', () => {
    expect(demoAllows(`${BASE}/CFG/lt/tmdb/trending/movie/week?language=fr-FR`, 'GET', b)).toBe(true);
    expect(demoAllows(`${BASE}/CFG/lt/meta/movie/550`, 'GET', b)).toBe(true);
    expect(demoAllows(`${BASE}/CFG/lt/tv/channels`, 'GET', b)).toBe(true);
    expect(demoAllows(`${BASE}/assets/index-abc.js`, 'GET', b)).toBe(true);
    expect(demoAllows(`${BASE}/`, 'GET', b)).toBe(true);
    expect(demoAllows('https://image.tmdb.org/t/p/w500/a.jpg', 'GET', b)).toBe(true);
    expect(demoAllows('/src/main.js', 'GET', b, true)).toBe(true);
    expect(demoAllows('/src/main.js', 'GET', b, false)).toBe(false);
  });

  it('refuse flux, TV HLS, comptes, écritures et toute route inconnue', () => {
    expect(demoAllows(`${BASE}/CFG/lt/tv/hls?u=x`, 'GET', b)).toBe(false);
    expect(demoAllows(`${BASE}/CFG/stream/movie/tt1.json`, 'GET', b)).toBe(false);
    expect(demoAllows(`${BASE}/CFG/lt/range-source`, 'POST', b)).toBe(false);
    expect(demoAllows(`${BASE}/CFG/lt/tmdb/trending/movie/week`, 'POST', b)).toBe(false);
    expect(demoAllows(`${BASE}/CFG/lt/thumbs/k/1.webp`, 'GET', b)).toBe(false);
    for (const p of ['user/me', 'party/rooms', 'admin/x', 'config/encode', 'health', 'CFG/catalog/movie/top.json', 'CFG/manifest.json']) {
      expect(demoAllows(`${BASE}/${p}`, 'GET', b)).toBe(false);
    }
    expect(demoAllows('https://image.tmdb.org/t/p/w500/a.jpg', 'POST', b)).toBe(false);
  });

  it('refuse les détours de chemin : //, .., %2e, %2f, %5c, casse', () => {
    for (const p of [
      `${BASE}//user/me`, `${BASE}/CFG/lt/tmdb/../../stream/x`, `${BASE}/CFG/lt/tmdb/%2e%2e/stream/x`, `${BASE}/CFG/lt/tmdb/%2E%2E/x`,
      `${BASE}/CFG/lt/tmdb/a%2Fb`, `${BASE}/CFG/lt/tmdb/a%2fb`, `${BASE}/CFG/lt/tmdb/a%5Cb`, `${BASE}/CFG//lt/tmdb/x`,
      `${BASE}/assets/../user/me`, '//user/me', '/assets/%2e%2e/user/me', `${BASE}/USER/me`, `${BASE}/CFG/LT/TMDB/x`, `${BASE}/CFG/Stream/x`,
    ]) {
      expect(demoAllows(p, 'GET', b), p).toBe(false);
    }
  });
});

describe('démarrage impossible', () => {
  it('serveur injoignable : startDemo renvoie faux et rend les vrais stockages (repli sur la connexion)', async () => {
    realStorage.setItem(SESSION_KEY, SESSION);
    substituteStorage();
    expect(globalThis.localStorage).not.toBe(realStorage);
    encodeConfig.mockRejectedValueOnce(new Error('down'));
    setDemoFlags({ on: true, clean: false, profile: '' });
    expect(await startDemo()).toBe(false);
    expect(globalThis.localStorage).toBe(realStorage);
    expect(realStorage.getItem(SESSION_KEY)).toBe(SESSION);
    expect(globalThis.fetch).toBe(realFetch); // aucune garde installée
    setDemoFlags(OFF);
    realStorage.clear();
  });
});

describe('session existante dans le vrai stockage', () => {
  it('?demo=1 : le jeton n’est ni lu par l’app ni effacé', async () => {
    realStorage.setItem(SESSION_KEY, SESSION);
    history.replaceState(null, '', '/?demo=1');
    vi.resetModules();
    await import('../src/demoBoot'); // comme main.js : premier module
    expect(globalThis.localStorage).not.toBe(realStorage);
    const { getSession, clearSession } = await import('../src/data/session');
    expect(getSession()).toBeNull(); // l'app ne voit aucune session
    clearSession();
    expect(realStorage.getItem(SESSION_KEY)).toBe(SESSION); // le vrai jeton reste intact
    (await import('../src/demoBoot')).restoreStorage();
    history.replaceState(null, '', '/');
    realStorage.clear();
  });
});

describe('mode démo démarré', () => {
  const fetchMock = vi.fn(async (_u: unknown, _i?: unknown) => new Response('{}', { status: 200 }));

  beforeAll(async () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    realStorage.clear();
    realStorage.setItem(SESSION_KEY, SESSION);
    realStorage.setItem('laststream.prefs', 'REAL');
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    substituteStorage();
    setDemoFlags({ on: true, clean: true, profile: 'leo' });
    expect(await startDemo()).toBe(true);
  });
  afterAll(() => {
    removeGuard();
    restoreStorage();
    globalThis.fetch = realFetch;
    setDemoFlags(OFF);
    realStorage.clear();
  });

  it('profils factices, jamais un nom réel, profil enfant Léo demandé', () => {
    expect(isDemo()).toBe(true);
    expect(auth.profiles.map((p) => p.name)).toEqual(DEMO_PROFILES.map((p) => p.name));
    expect(DEMO_PROFILES.map((p) => p.name)).toEqual(['Alex', 'Sam', 'Léo']);
    expect(auth.profile?.name).toBe('Léo');
    expect(auth.profile?.isKid).toBe(true);
    expect(userStore.currentProfile().name).toBe('Léo');
    expect(JSON.stringify(userStore.getProfiles())).not.toMatch(/Greg/);
    expect(auth.status).toBe('local');
  });

  it('le vrai stockage n’est ni lu ni pollué', () => {
    expect(getBase()).toBe(BASE);
    expect(getConfig()).toBe('CFG');
    saveSettings({ base: BASE });
    userStore.toggleLibrary({ id: 1, type: 'movie', title: 'X', poster: '' });
    expect(userStore.inLibrary('movie:1')).toBe(true);
    localStorage.setItem('laststream.theme', 'x'); // écriture d'une préférence : en mémoire
    sessionStorage.setItem('k', 'v');
    expect(localStorage.getItem('laststream.prefs')).toBeNull(); // lecture : pas les préférences réelles
    expect(realStorage.getItem(SESSION_KEY)).toBe(SESSION);
    expect(realStorage.getItem('laststream.prefs')).toBe('REAL');
    expect(realStorage.length).toBe(2);
    expect(realSessionStorage.getItem('k')).toBeNull();
    expect(realStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_LOCAL_MODE_KEY)).toBeNull();
  });

  it('fetch : flux, comptes et écritures refusés, y compris via Request', async () => {
    fetchMock.mockClear();
    await expect(fetch(`${BASE}/CFG/stream/movie/tt1.json`)).rejects.toThrow();
    await expect(fetch(`${BASE}/user/me`, { headers: { authorization: 'Bearer SECRET-TOKEN' } })).rejects.toThrow();
    await expect(fetch(`${BASE}//user/me`)).rejects.toThrow();
    await expect(fetch(`${BASE}/CFG/lt/range-source`, { method: 'POST', body: '{}' })).rejects.toThrow();
    await expect(fetch(new Request(`${BASE}/CFG/lt/tmdb/trending/movie/week`, { method: 'POST', body: '{}' }))).rejects.toThrow();
    await expect(fetch(new Request(`${BASE}/CFG/lt/tmdb/trending/movie/week`), { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await fetch(`${BASE}/CFG/lt/tmdb/trending/movie/week`);
    await fetch(new Request(`${BASE}/CFG/lt/meta/movie/550`));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('XHR, sendBeacon et WebSocket refusés', () => {
    const x = new XMLHttpRequest();
    expect(() => x.open('GET', `${BASE}/CFG/stream/movie/tt1.json`)).toThrow();
    expect(() => x.open('POST', `${BASE}/CFG/lt/tmdb/x`)).toThrow();
    expect(() => x.open('GET', `${BASE}/CFG/lt/tmdb/trending/movie/week`)).not.toThrow();
    expect((navigator as unknown as { sendBeacon: (u: string) => boolean }).sendBeacon(`${BASE}/user/x`)).toBe(false);
    expect(() => new WebSocket('wss://laststream.gtux-prog.workers.dev/party/ws')).toThrow();
  });

  it('la lecture est désactivée : playBest, startSession et playSource ne cherchent aucune source', async () => {
    const { playBest, startSession, playSource } = await import('../src/player/session.js');
    fetchMock.mockClear();
    await playBest({ type: 'movie', id: '550', name: 'Fight Club', key: 'movie:550' }, null);
    await startSession({ type: 'movie', id: '550', name: 'Fight Club', key: 'movie:550' }, [], null, {});
    await playSource({ type: 'movie', id: '550', name: 'Fight Club', key: 'movie:550' }, [], null, null, {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
