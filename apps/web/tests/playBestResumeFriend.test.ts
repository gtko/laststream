// « Regarder avec lui » : playBest reçoit le relevé d'un ami (opts.startAt = relevé) et estime la reprise au démarrage,
// le temps de chargement compté. Lecture réelle (playBest de session.js), serveur et addon simulés au niveau fetch.
// Fichier à part de playBestSeek.test.ts : une seule session par fichier (une minuterie de session.js, onReady, lit la
// session globale et peut tomber sur la suivante).
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

describe('playBest : relevé d’ami (Regarder avec lui)', () => {
  it('relevé à 100 s en lecture, pris il y a 40 s : la reprise part après ces 40 s, pas à 100 s', async () => {
    network();
    const { playBest } = await import('../src/player/session.js');
    const at = Date.now() - 40_000;
    void playBest({ ...REQUEST }, null, { force: true, resume: 'none', startAt: { pos: 100, at, paused: false } }).catch(() => undefined);
    const video = await vi.waitFor(() => {
      const v = Array.from(document.querySelectorAll('video')).find((el) => el.getAttribute('src') === MEDIA_URL);
      expect(v).toBeDefined();
      return v as HTMLVideoElement;
    }, { timeout: 15_000 });
    // Le moteur HTML applique sa position de départ à loadedmetadata.
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBeGreaterThanOrEqual(140);
    expect(video.currentTime).toBeLessThan(150);
  });
});
