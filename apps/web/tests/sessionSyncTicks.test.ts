// LAST-142 : playSource remet la phase à « loading » et doit réaligner les boucles (moteurs singletons, pause qui survit à la source),
// sinon le délai de démarrage (StallWatch) n'est jamais évalué ; la boucle d'interface porte aussi le suivi du salon.
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
const { loadAddonSources } = await import('../src/sources/addonSources');
const { stopTicks, syncTicks, ticksAsleep } = await import('../src/player/sessionTick.js');

const STREAM_URL = 'https://addon.test/stream/anime/fk%3A123.json';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const REQUEST = {
  type: 'tv', id: 'fk:123', name: 'Anime test', key: 'addon:anime:fk:123', season: 1, episode: 1,
  addon: { key: 'https://addon.test', base: 'https://addon.test', type: 'anime', id: 'fk:123', title: 'Anime test', videos: [{ id: 'fk:123:1:1', season: 1, episode: 1 }] },
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings(); clearCache(); clearSourceCache();
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  proto.play = () => Promise.resolve();
  proto.pause = () => undefined;
  proto.load = () => undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === STREAM_URL) return json({ streams: [{ name: 'Direct', title: 'Anime 1080p MP4\ncdn', url: 'https://cdn.test/ep1.mp4' }] });
    throw new Error('appel inattendu ' + url);
  }));
});
afterEach(async () => {
  const { closePlayer } = await import('../src/player/session.js');
  closePlayer();
  vi.unstubAllGlobals();
});

describe('playSource réaligne les boucles (LAST-142)', () => {
  it('changement de source : les boucles repartent dès le retour à « loading »', async () => {
    const views = await loadAddonSources({ manifestUrl: 'https://addon.test/manifest.json', name: 'Addon' }, 'anime', 'fk:123');
    const { playSource } = await import('../src/player/session.js');
    await playSource(REQUEST, views, views[0], null, { resume: 'none' });
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('video')).map((v) => v.getAttribute('src') || v.src).find((s) => s)).toBe('https://cdn.test/ep1.mp4'), { timeout: 15_000 });
    // Boucles dormantes (pause ou onglet caché avant le changement de source) : la nouvelle source doit les réveiller.
    stopTicks();
    expect(ticksAsleep()).toBe(true);
    const { playView } = await import('../src/player/sessionPlay.js');
    const next = playView(views[0], 0);
    await vi.waitFor(() => expect(ticksAsleep()).toBe(false), { timeout: 2000 });
    await next;
  });

  it('le salon est suivi à chaque pas de l’interface (250 ms), pas seulement à la seconde', async () => {
    const views = await loadAddonSources({ manifestUrl: 'https://addon.test/manifest.json', name: 'Addon' }, 'anime', 'fk:123');
    const { playSource } = await import('../src/player/session.js');
    const { partyBridge } = await import('../src/party/bridge');
    await playSource(REQUEST, views, views[0], null, { resume: 'none' });
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('video')).map((v) => v.getAttribute('src') || v.src).find((s) => s)).toBe('https://cdn.test/ep1.mp4'), { timeout: 15_000 });
    // Minuteries simulées : la boucle d'interface est réarmée sous horloge fictive (aucune attente réelle, donc aucun pas perdu sous charge).
    stopTicks();
    const tick = vi.spyOn(partyBridge, 'tick').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      syncTicks();
      await vi.advanceTimersByTimeAsync(1100);
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(4); // 250 ms ; la boucle lente seule n'en ferait qu'un
    } finally {
      stopTicks();
      vi.useRealTimers();
      tick.mockRestore();
    }
  });
});
