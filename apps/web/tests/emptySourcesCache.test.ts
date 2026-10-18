import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import { clearSourceCache, loadSources, type SourceRequest } from '../src/sources/load';

/* Un épisode du jour peut recevoir une liste vide avant la sortie : elle ne reste pas en cache plus de 60 s. */
const REQ: SourceRequest = {
  type: 'tv', id: '243117', name: 'Plus belle la vie', key: 'tv:243117',
  imdb: 'tt29694831', season: 3, episode: 206, streamId: 'tt29694831:3:206',
};

const source = {
  url: 'https://x/play/1',
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 60, estBitrateKbps: 5000 },
};

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

/** Faux lastAddon : chaque appel renvoie la liste donnée et est compté. */
function fakeStreams(streams: unknown[]): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ streams }), { status: 200 });
  }));
  return calls;
}

describe('cache des listes de sources : vide au plus 60 s, complète 90 s', () => {
  it('liste vide : la requête suivante, 61 s plus tard, interroge à nouveau le serveur', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    const calls = fakeStreams([]);
    await loadSources(REQ);
    const first = calls.length;
    vi.setSystemTime(new Date('2026-10-18T10:01:01Z'));
    await loadSources(REQ);
    expect(calls.length).toBeGreaterThan(first);
  });

  it('liste non vide : toujours gardée 90 s (pas de nouvelle requête à 61 s)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    const calls = fakeStreams([source]);
    const first = await loadSources(REQ);
    expect(first.views).toHaveLength(1);
    const count = calls.length;
    vi.setSystemTime(new Date('2026-10-18T10:01:01Z'));
    await loadSources(REQ);
    expect(calls.length).toBe(count);
  });
});
