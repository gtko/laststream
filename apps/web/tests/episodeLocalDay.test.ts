import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import { autoNextEpisode, localDay, normalizeCanonical, type EpisodeInfo } from '../src/player/episodes';
import { clearSourceCache, loadSources } from '../src/sources/load';

/*
 * « Aujourd'hui » est le jour civil de l'appareil, pas le jour UTC. À 01 h 03 le 19 octobre à Paris (23 h 03 UTC le 18),
 * l'épisode diffusé le 19 est diffusé : il ne doit ni être marqué « pas encore diffusé », ni bloquer l'enchaînement.
 * Le fuseau est fixé ici pour que le test vaille quelle que soit la machine qui l'exécute.
 */
const savedTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = 'Europe/Paris';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T23:03:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const resp = {
  seasons: [{ number: 3, episodeCount: 2 }],
  episodes: [
    { season: 3, episode: 206, name: 'Épisode 695', airDate: '2026-10-19', streamId: 'tt29694831:3:206' },
    { season: 3, episode: 207, name: 'Épisode 696', airDate: '2026-10-20', streamId: 'tt29694831:3:207' },
  ],
};

describe('jour de l’appareil (fuseau de Paris, pas UTC)', () => {
  it('à 01 h 03 le 19 octobre à Paris, le jour est le 19', () => {
    expect(localDay(new Date())).toBe('2026-10-19');
  });

  it('l’épisode du jour est diffusé (pas « bientôt ») et reste lisible', () => {
    const eps = normalizeCanonical(resp)!.episodes.get(3)!;
    const today = eps.find((e) => e.episode === 206)!;
    expect(today.aired).toBe(true);
    expect(today.playable).toBe(true);
    expect(today.streamId).toBe('tt29694831:3:206');
  });

  it('l’épisode de demain reste « bientôt » (lisible, pas encore diffusé)', () => {
    const eps = normalizeCanonical(resp)!.episodes.get(3)!;
    const tomorrow = eps.find((e) => e.episode === 207)!;
    expect(tomorrow.aired).toBe(false);
    expect(tomorrow.playable).toBe(true);
  });

  it('l’enchaînement automatique lance l’épisode diffusé aujourd’hui', () => {
    const episodes: Map<number, EpisodeInfo[]> = normalizeCanonical(resp)!.episodes;
    expect(autoNextEpisode({ season: 3, episode: 206 }, episodes)).toEqual({ season: 3, episode: 206 });
  });
});

describe('recherche de sources de l’épisode du jour : identifiant envoyé et sources reçues', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
    reloadSettings();
    clearCache();
    clearSourceCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('interroge /stream avec le streamId du serveur et renvoie les sources de l’addon', async () => {
    const calls: string[] = [];
    const source = {
      url: 'https://x/play/1',
      laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 60, estBitrateKbps: 5000 },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ streams: [source] }), { status: 200 });
    }));

    const loaded = await loadSources({
      type: 'tv', id: '243117', name: 'Plus belle la vie', key: 'tv:243117',
      imdb: 'tt29694831', season: 3, episode: 206, streamId: 'tt29694831:3:206',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/stream/series/tt29694831:3:206.json');
    expect(loaded.views).toHaveLength(1);
  });
});
