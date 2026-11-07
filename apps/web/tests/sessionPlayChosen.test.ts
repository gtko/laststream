// Salon : lancement de la source choisie dans le salon d'attente (playChosen, LAST-1615). Lecture réelle (playBest de session.js),
// serveur et addon simulés au niveau fetch. Une seule session par test, la suivante remplace la précédente.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import { toSourceViews } from '../src/sources/info';

vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return { ...actual, measureBandwidthKbps: async () => 50_000 };
});

const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { clearSourceCache } = await import('../src/sources/load');

const ADDON_URL = 'https://mur.example.test/stream/movie/tt0013442.json';
const SEARCH_URL = 'https://archive.org/download/n/recherche.mp4';
const CHOSEN_URL = 'https://archive.org/download/n/choisie.mp4';
const OTHER_URL = 'https://archive.org/download/n/autre.mp4';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = { type: 'movie', id: '10', name: 'Nosferatu', key: 'movie:10', imdb: 'tt0013442' };
const stream = (url: string, languages: string[], score: number) => ({
  url,
  behaviorHints: { filename: url.split('/').pop(), videoSize: 1e9 },
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages, cached: true, score, estBitrateKbps: 5000 },
});
const loadedOf = (streams: unknown[]) => ({ imdb: 'tt0013442', views: toSourceViews(streams as never), pending: [] as string[] });

let calls: string[] = [];
function network() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url.startsWith('http://localhost:7000')) {
      if (url.includes('/lt/streams/status/')) return json({ pending: [], count: 0 });
      return json({ streams: [], deviceFetch: [{ addonId: 'Mur', url: ADDON_URL }] });
    }
    if (url === ADDON_URL) return json({ streams: [{ name: 'Domaine public', title: 'Nosferatu (1922) 1080p MP4\narchive.org', url: SEARCH_URL }] });
    return json({}, 404);
  }));
}
const searched = () => calls.some((u) => u === ADDON_URL || u.includes('/lt/streams'));
const videoWith = (src: string) => vi.waitFor(() => {
  const v = Array.from(document.querySelectorAll('video')).find((el) => el.getAttribute('src') === src);
  expect(v).toBeDefined();
  return v as HTMLVideoElement;
}, { timeout: 15_000 });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings(); clearCache(); clearSourceCache();
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  proto.play = () => Promise.resolve();
  proto.pause = () => undefined;
  proto.load = () => undefined;
  network();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('playChosen : source choisie dans le salon d’attente', () => {
  it('la source est lancée telle quelle, sans loadSources ni recherche, et la liste chargée sert de repli', async () => {
    const { playBest } = await import('../src/player/session.js');
    const { S } = await import('../src/player/sessionState.js');
    const loaded = loadedOf([stream(CHOSEN_URL, ['fr'], 60), stream(OTHER_URL, ['fr'], 50)]);
    void playBest({ ...REQUEST }, null, { force: true, resume: 'none', partyLang: 'fr', chosen: loaded.views[0], chosenLoaded: loaded }).catch(() => undefined);
    await videoWith(CHOSEN_URL);
    expect(searched()).toBe(false);
    // Le failover d'une source de la liste chargée : la liste du lecteur est celle du salon d'attente (repli sur l'autre source).
    expect((S.P as any).views.map((v: { stream: { url: string } }) => v.stream.url)).toEqual([CHOSEN_URL, OTHER_URL]);
    expect((S.P as any).loaded).toBe(loaded);
  });

  it('source choisie non jouable : la recherche habituelle prend le relais', async () => {
    const { playBest } = await import('../src/player/session.js');
    const loaded = loadedOf([stream(CHOSEN_URL, ['fr'], 60)]);
    const chosen = { ...loaded.views[0], playable: false };
    void playBest({ ...REQUEST }, null, { force: true, resume: 'none', partyLang: 'fr', chosen, chosenLoaded: loaded }).catch(() => undefined);
    await videoWith(SEARCH_URL);
    expect(searched()).toBe(true);
  });

  it('source hors de la langue du salon : l’avis « Lecture hors langue du salon » est annoncé', async () => {
    const { playBest } = await import('../src/player/session.js');
    const loaded = loadedOf([stream(CHOSEN_URL, ['en'], 60)]);
    void playBest({ ...REQUEST }, null, { force: true, resume: 'none', partyLang: 'fr', chosen: loaded.views[0], chosenLoaded: loaded }).catch(() => undefined);
    await videoWith(CHOSEN_URL);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Lecture hors langue du salon : VO EN'));
  });
});

describe('playChosen : bascule', () => {
  it('échec de la source choisie : la lecture bascule sur une autre source de la liste du salon d’attente, sans recherche', async () => {
    const { playBest } = await import('../src/player/session.js');
    const loaded = loadedOf([stream(CHOSEN_URL, ['fr'], 60), stream(OTHER_URL, ['fr'], 50)]);
    void playBest({ ...REQUEST }, null, { force: true, resume: 'none', partyLang: 'fr', chosen: loaded.views[0], chosenLoaded: loaded }).catch(() => undefined);
    const first = await videoWith(CHOSEN_URL);
    Object.defineProperty(first, 'error', { value: { code: 4, message: 'source illisible' }, configurable: true });
    first.dispatchEvent(new Event('error'));
    await videoWith(OTHER_URL);
    expect(searched()).toBe(false);
  });
});
