import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import { DEVICE_FETCH_TIMEOUT_MS } from '../src/sources/deviceFetch';
import { awaitLaunchable, clearSourceCache, loadSources, recommendFor, watchSources, type LoadedSources, type SourceRequest } from '../src/sources/load';

/*
 * Repli « via l'appareil » jusqu'à l'écran : le serveur ne renvoie aucun flux et un `deviceFetch`, l'appareil interroge l'addon.
 * Les flux de l'appareil doivent apparaître dans la liste (sans attendre le cache « liste vide ») et permettre le lancement.
 */

const URL_B = 'https://lumio.example.test/realdebrid=SECRET-KEY-1234/stream/movie/tt0000001.json';
const REQ: SourceRequest = { type: 'movie', id: '1', name: 'Film', key: 'movie:1', imdb: 'tt0000001' };
const cdn = (n: number) => ({ name: 'Lumio\n1080p', title: `Film.2024.MULTi.1080p.WEB-DL.x264-GRP ${n}`, url: `https://cdn.example.test/${n}.mkv` });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Faux lastAddon : 0 flux serveur + `deviceFetch` ; `addon(n)` répond à l'addon amont (n = rang de l'appel). */
function fakeNetwork(addon: (call: number) => Promise<Response> | Response): { addonCalls: () => number } {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('http://localhost:7000')) {
      if (url.includes('/lt/streams/status/')) return json({ pending: [], count: 0 });
      return json({ streams: [], deviceFetch: [{ addonId: 'Lumio', url: URL_B }] });
    }
    if (url === URL_B) {
      calls += 1;
      return addon(calls);
    }
    throw new Error('appel inattendu ' + url);
  }));
  return { addonCalls: () => calls };
}

/** Surveille la liste comme le fait le sélecteur : renvoie la liste quand plus rien n'est en attente. */
function settle(start: LoadedSources): Promise<LoadedSources> {
  if (!start.pending.length) return Promise.resolve(start);
  return new Promise<LoadedSources>((resolve, reject) => {
    let last = start;
    const stop = watchSources(REQ, start, (next) => {
      last = next;
      if (!next.pending.length) { stop(); resolve(next); }
    }, { every: 10, maxMs: 4_000 });
    setTimeout(() => { stop(); reject(new Error('liste jamais terminée (' + last.pending.join(',') + ')')); }, 5_000);
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  reloadSettings();
  clearCache();
  clearSourceCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('repli appareil : flux visibles et lecture lancée', () => {
  it('serveur à 0 flux + deviceFetch, addon à 1 flux HTTP : liste à 1 et lecture lancée', async () => {
    fakeNetwork(async () => json({ streams: [cdn(1)] }));

    const first = await loadSources(REQ);
    expect(first.views).toHaveLength(0);
    expect(first.pending).toEqual(['Lumio']);

    const settled = await settle(first);
    expect(settled.views).toHaveLength(1);
    expect(settled.views[0]?.viaDevice).toBe(true);

    const t0 = Date.now();
    const { loaded, rec } = await awaitLaunchable(first, {
      request: REQ,
      since: t0,
      readable: (views) => views.some((v) => v.playable && !v.client),
      recommend: (views) => recommendFor(views, 10_000),
      good: (r) => !!r,
    });
    expect(loaded.views).toHaveLength(1);
    expect(rec?.view.stream.url).toBe('https://cdn.example.test/1.mkv');
  });

  it('un addon plus lent que l’ancien délai de 8 s reste attendu : ses flux apparaissent quand il répond', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const latency = 9_000;
    expect(latency).toBeLessThan(DEVICE_FETCH_TIMEOUT_MS);
    fakeNetwork(() => new Promise<Response>((resolve) => setTimeout(() => resolve(json({ streams: [cdn(1)] })), latency)));

    const first = await loadSources(REQ);
    await vi.advanceTimersByTimeAsync(latency + 100);

    const later = await loadSources(REQ);
    expect(later.views).toHaveLength(1);
    expect(later.pending).toEqual([]);
  });

  it('un appareil terminé sans flux n’est pas gardé 60 s : la recherche suivante réinterroge l’addon et affiche ses flux', async () => {
    const network = fakeNetwork((call) => (call === 1 ? json({ error: 'indisponible' }, 500) : json({ streams: [cdn(2)] })));

    const first = await loadSources(REQ);
    const emptied = await settle(first);
    expect(emptied.views).toHaveLength(0);
    expect(network.addonCalls()).toBe(1);

    const retried = await loadSources(REQ);
    expect(network.addonCalls()).toBe(2);
    const settled = await settle(retried);
    expect(settled.views.map((v) => v.stream.url)).toEqual(['https://cdn.example.test/2.mkv']);
  });
});
