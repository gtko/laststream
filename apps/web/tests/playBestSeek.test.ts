// « Regarder avec lui » : playBest transmet la position de départ (opts.startAt) jusqu'au moteur, sans reprise proposée.
// Lecture réelle (playBest de session.js), serveur et addon simulés au niveau fetch, comme deviceFetchPanel.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';

vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return { ...actual, measureBandwidthKbps: async () => 50_000 };
});

const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { clearSourceCache } = await import('../src/sources/load');

const ADDON_URL = 'https://mur.example.test/stream/movie/tt0013442.json';
const MEDIA_URL = 'https://archive.org/download/n/n.mp4';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = { type: 'movie', id: '10', name: 'Nosferatu', key: 'movie:10', imdb: 'tt0013442' };

function network() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('http://localhost:7000')) {
      if (url.includes('/lt/streams/status/')) return json({ pending: [], count: 0 });
      return json({ streams: [], deviceFetch: [{ addonId: 'Mur', url: ADDON_URL }] });
    }
    if (url === ADDON_URL) {
      return json({ streams: [{ name: 'Domaine public', title: 'Nosferatu (1922) 1080p MP4\narchive.org', url: MEDIA_URL }] });
    }
    throw new Error('appel inattendu ' + url);
  }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings(); clearCache(); clearSourceCache();
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  proto.play = () => Promise.resolve();
  proto.pause = () => undefined;
  proto.load = () => undefined;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('playBest : position de départ (Regarder avec lui)', () => {
  it('opts.startAt = 754 et resume « none » : le moteur démarre à 754 s, pas à 0', async () => {
    network();
    const { playBest } = await import('../src/player/session.js');
    void playBest({ ...REQUEST }, null, { force: true, resume: 'none', startAt: 754 }).catch(() => undefined);
    const video = await vi.waitFor(() => {
      const v = Array.from(document.querySelectorAll('video')).find((el) => el.getAttribute('src') === MEDIA_URL);
      expect(v).toBeDefined();
      return v as HTMLVideoElement;
    }, { timeout: 15_000 });
    // Le moteur HTML applique sa position de départ à loadedmetadata.
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(754);
  });
});
