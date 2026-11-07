// Repli appareil jusqu'au panneau « Sources » réel (rendu DOM du sélecteur), serveur et addon simulés au niveau fetch.
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
const { openSourcePicker, closeSourcePicker } = await import('../src/sources/picker.js');
const { clearSourceCache } = await import('../src/sources/load');

const ADDON_URL = 'https://mur.example.test/stream/movie/tt0013442.json';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = { type: 'movie', id: '10', name: 'Nosferatu', key: 'movie:10', imdb: 'tt0013442' };

function network(addon: () => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('http://localhost:7000')) {
      if (url.includes('/lt/streams/status/')) return json({ pending: [], count: 0 });
      return json({ streams: [], deviceFetch: [{ addonId: 'Mur', url: ADDON_URL }] });
    }
    if (url === ADDON_URL) return addon();
    throw new Error('appel inattendu ' + url);
  }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings(); clearCache(); clearSourceCache();
});
afterEach(() => { closeSourcePicker(); vi.unstubAllGlobals(); document.querySelectorAll('[data-test-host]').forEach((el) => el.remove()); });

describe('panneau Sources : repli appareil', () => {
  it('serveur à 0 source + deviceFetch, addon à 1 flux HTTP : le panneau affiche la source et sa recommandation', async () => {
    network(() => json({ streams: [{ name: 'Domaine public', title: 'Nosferatu (1922) 512kb MP4\narchive.org', url: 'https://archive.org/download/n/n.mp4' }] }));
    const host = document.createElement('div');
    host.dataset.testHost = '1';
    document.body.appendChild(host);
    await openSourcePicker({ ...REQUEST }, null, { host, views: [], pending: [] });
    await vi.waitFor(() => expect(host.querySelectorAll('[data-src]').length).toBeGreaterThan(0), { timeout: 8_000 });
    expect(host.textContent).toContain('1 source');
    expect(host.textContent).not.toContain('Aucune source');
  });
});

describe('lecture automatique (playBest réel) : repli appareil', () => {
  it('serveur à 0 source + deviceFetch, addon à 1 flux HTTP : playBest lance la source de l’appareil', async () => {
    const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
    proto.play = () => Promise.resolve();
    proto.pause = () => undefined;
    proto.load = () => undefined;
    network(() => json({ streams: [{ name: 'Domaine public', title: 'Nosferatu (1922) 1080p MP4\narchive.org', url: 'https://archive.org/download/n/n.mp4' }] }));
    const { playBest } = await import('../src/player/session.js');
    void playBest({ ...REQUEST }, null, { force: true }).catch(() => undefined);
    await vi.waitFor(() => {
      const src = Array.from(document.querySelectorAll('video')).map((v) => v.getAttribute('src') || v.src).find((s) => s);
      expect(src).toBe('https://archive.org/download/n/n.mp4');
    }, { timeout: 15_000 });
  });
});
