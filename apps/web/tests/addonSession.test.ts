// Lecture d'un titre d'addon (ODY-252) dans la vraie session du lecteur : sources de l'addon seulement, aucun appel TMDB / IMDb / serveur,
// aucune écriture dans la progression TMDB, et `playSource` avec une demande addon ne lève pas.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import { getAddonProgress } from '../src/data/addonUserStore';
import { PROGRESS_KEY } from '../src/data/userStore';

vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return { ...actual, measureBandwidthKbps: async () => 50_000 };
});
// Espions qui laissent passer l'appel réel : le nom de l'addon transmis à la lecture, et les demandes de note.
vi.mock('../src/sources/addonSources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/addonSources')>();
  return { ...actual, loadAddonSources: vi.fn(actual.loadAddonSources) };
});
vi.mock('../src/ui/rate.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, showRatePrompt: vi.fn() };
});

const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { clearSourceCache } = await import('../src/sources/load');
const { loadAddonSources } = await import('../src/sources/addonSources');

const STREAM_URL = 'https://addon.test/stream/anime/fk%3A123.json';
const MP4 = 'https://cdn.test/ep1.mp4';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = (over: Record<string, unknown> = {}) => ({
  type: 'tv', id: 'fk:123', name: 'Anime test', key: 'addon:anime:fk:123', season: 1, episode: 1,
  addon: { key: 'https://addon.test', base: 'https://addon.test', type: 'anime', id: 'fk:123', title: 'Anime test', videos: [{ id: 'fk:123:1:1', season: 1, episode: 1 }, { id: 'fk:123:1:2', season: 1, episode: 2 }] },
  ...over,
});

let calls: string[] = [];
function network() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    if (url === STREAM_URL) return json({ streams: [{ name: 'Direct', title: 'Anime 1080p MP4\ncdn', url: MP4 }] });
    throw new Error('appel inattendu ' + url);
  }));
}
/** Toute route qui passerait par TMDB, IMDb ou les sources du serveur lastAddon. */
const forbidden = (u: string) => /themoviedb|imdb|\/lt\/(meta|tmdb|streams)|\/stream\/|\/series\//i.test(u) && u !== STREAM_URL;
const videoOf = () => Array.from(document.querySelectorAll('video')).find((v) => v.getAttribute('src') || v.src);
const videoSrc = () => Array.from(document.querySelectorAll('video')).map((v) => v.getAttribute('src') || v.src).find((s) => s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Film TMDB (id et IMDb), sources lues chez un addon de l'appareil : même montage que playBestSeek.test.ts.
const TMDB_REQUEST = { type: 'movie', id: '10', name: 'Nosferatu', key: 'movie:10', imdb: 'tt0013442' };
const TMDB_ADDON = 'https://mur.example.test/stream/movie/tt0013442.json';
const TMDB_MEDIA = 'https://archive.test/film.mp4';
function tmdbNetwork() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('http://localhost:7000')) {
      if (url.includes('/lt/streams/status/')) return json({ pending: [], count: 0 });
      return json({ streams: [], deviceFetch: [{ addonId: 'Mur', url: TMDB_ADDON }] });
    }
    if (url === TMDB_ADDON) return json({ streams: [{ name: 'Domaine public', title: 'Film 1080p MP4\narchive.org', url: TMDB_MEDIA }] });
    throw new Error('appel inattendu ' + url);
  }));
}

beforeEach(() => {
  localStorage.clear();
  // lastAddon configuré (miniatures, état du serveur) mais sans réponse : le titre d'addon n'en dépend pas.
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings(); clearCache(); clearSourceCache();
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  proto.play = () => Promise.resolve();
  proto.pause = () => undefined;
  proto.load = () => undefined;
});
afterEach(async () => {
  const { closePlayer } = await import('../src/player/session.js');
  closePlayer();
  vi.unstubAllGlobals();
});

describe('session : titre d’addon', () => {
  it('playBest : sources de l’addon, jamais TMDB / IMDb / serveur, jamais de « no-imdb »', async () => {
    network();
    const { playBest } = await import('../src/player/session.js');
    void playBest(REQUEST(), null, { force: true }).catch(() => undefined);
    await vi.waitFor(() => expect(videoSrc()).toBe(MP4), { timeout: 15_000 });
    expect(calls).toContain(STREAM_URL);
    expect(calls.filter(forbidden)).toEqual([]);
    expect(document.body.textContent).not.toContain('Aucun identifiant IMDb');
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  });

  it('playSource : une demande addon avec ses sources lance la lecture sans lever', async () => {
    network();
    const views = await loadAddonSources({ manifestUrl: 'https://addon.test/manifest.json', name: 'Addon' }, 'anime', 'fk:123');
    expect(views.length).toBe(1);
    calls = [];
    const { playSource } = await import('../src/player/session.js');
    await expect(playSource(REQUEST(), views, views[0], null, { resume: 'none' })).resolves.not.toThrow();
    await vi.waitFor(() => expect(videoSrc()).toBe(MP4), { timeout: 15_000 });
    expect(calls.filter(forbidden)).toEqual([]);
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  });

  it('la progression va dans addonUserStore (épisode compris), jamais dans PROGRESS_KEY', async () => {
    network();
    const { playBest, closePlayer } = await import('../src/player/session.js');
    void playBest(REQUEST(), null, { force: true, resume: 'none' }).catch(() => undefined);
    await vi.waitFor(() => expect(videoSrc()).toBe(MP4), { timeout: 15_000 });
    const video = Array.from(document.querySelectorAll('video')).find((v) => v.getAttribute('src') || v.src) as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 120 });
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 1000 });
    closePlayer(); // la fermeture enregistre la position
    expect(getAddonProgress('addon:anime:fk:123')).toMatchObject({ t: 120, d: 1000, episode: { season: 1, episode: 1 } });
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  });

  it('titre d’addon sans nom ni registre : la lecture le nomme « Addon », jamais par son adresse', async () => {
    network();
    vi.mocked(loadAddonSources).mockClear();
    const { playBest } = await import('../src/player/session.js');
    void playBest(REQUEST({ addon: { ...(REQUEST().addon), title: '' } }), null, { force: true }).catch(() => undefined);
    await vi.waitFor(() => expect(videoSrc()).toBe(MP4), { timeout: 15_000 });
    expect(vi.mocked(loadAddonSources).mock.calls[0][0].name).toBe('Addon');
  });

  it('titre d’addon de série : pas de panneau Épisodes, mais l’épisode suivant reste proposé', async () => {
    network();
    const { playBest } = await import('../src/player/session.js');
    void playBest(REQUEST(), null, { force: true, resume: 'none' }).catch(() => undefined);
    const next = await vi.waitFor(() => {
      const el = document.querySelector('[data-role="next"]') as HTMLElement;
      expect(el.hidden).toBe(false);
      return el;
    }, { timeout: 15_000 });
    expect(next.hidden).toBe(false);
    expect((document.querySelector('[data-role="episodes"]') as HTMLElement).hidden).toBe(true);
  });

  it('fin de lecture d’un titre d’addon : aucune demande de note', async () => {
    network();
    const rate = await import('../src/ui/rate.js');
    vi.mocked(rate.showRatePrompt).mockClear();
    const { playBest } = await import('../src/player/session.js');
    void playBest(REQUEST({ season: 1, episode: 2 }), null, { force: true, resume: 'none' }).catch(() => undefined);
    await vi.waitFor(() => expect(videoSrc()).toBe(MP4), { timeout: 15_000 });
    videoOf()?.dispatchEvent(new Event('ended'));
    await wait(900);
    expect(rate.showRatePrompt).not.toHaveBeenCalled();
  });

});

describe('session : contrôle TMDB (la demande de note reste en place)', () => {
  it('fin de lecture d’un film TMDB : la demande de note part pour « movie:10 »', async () => {
    tmdbNetwork();
    const rate = await import('../src/ui/rate.js');
    vi.mocked(rate.showRatePrompt).mockClear();
    const { playBest } = await import('../src/player/session.js');
    void playBest({ ...TMDB_REQUEST }, null, { force: true, resume: 'none' }).catch(() => undefined);
    await vi.waitFor(() => expect(videoSrc()).toBe(TMDB_MEDIA), { timeout: 15_000 });
    videoOf()?.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(rate.showRatePrompt).toHaveBeenCalledWith('movie:10'), { timeout: 3_000 });
  });

});
