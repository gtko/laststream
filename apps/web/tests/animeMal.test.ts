// Anime numérotés d'après MyAnimeList : la structure du serveur affiche les saisons et numéros MAL, mais les sources, les
// sous-titres et les segments de saut gardent la numérotation IMDb (`streamId`), complétée des identifiants MAL et Kitsu.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { altIdsOf, episodeIds, normalizeCanon } from '../src/data/series';
import { fetchStreamsResult } from '../src/data/sources';
import { clearCache } from '../src/data/transport';

/** Saison TMDB 3 en deux cours : la fiche MAL 38524 (2e cours) est la saison affichée 4, épisode 1 = tt…:3:13. */
const SERVER = {
  source: 'tvdb',
  numbering: 'mal',
  seasons: [
    { number: 3, name: 'Saison 3', episodes: [{ season: 3, episode: 12, name: 'A', streamId: 'tt2560140:3:12', mal: 35760, malEpisode: 12 }] },
    { number: 4, name: 'Saison 4', episodes: [{ season: 4, episode: 1, name: 'B', streamId: 'tt2560140:3:13', mal: 38524, malEpisode: 1, kitsu: 41982 }] },
  ],
};

describe('anime en numérotation MyAnimeList', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
    reloadSettings();
    clearCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('la structure garde les fiches MAL et Kitsu de chaque épisode', () => {
    const canon = normalizeCanon(SERVER)!;
    expect(canon.seasons[1]!.episodes[0]).toMatchObject({ season: 4, episode: 1, streamId: 'tt2560140:3:13', mal: 38524, malEpisode: 1, kitsu: 41982 });
    expect(canon.seasons[0]!.episodes[0]!.kitsu).toBeUndefined();
  });

  it('identifiants d’anime : MAL puis Kitsu ; rien hors anime', () => {
    expect(altIdsOf({ mal: 38524, malEpisode: 1, kitsu: 41982 })).toEqual(['mal:38524:1', 'kitsu:41982:1']);
    expect(altIdsOf({ mal: 35760, malEpisode: 12 })).toEqual(['mal:35760:12']);
    expect(altIdsOf({})).toEqual([]);
    expect(altIdsOf(null)).toEqual([]);
  });

  it('épisode affiché S4E1 : flux et segments en numérotation IMDb (S3E13), identifiants MAL et Kitsu', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SERVER), { status: 200 })));
    expect(await episodeIds({ id: '14290', season: 4, episode: 1 }, 'tt2560140')).toEqual({
      streamId: 'tt2560140:3:13',
      season: 3,
      episode: 13,
      altIds: ['mal:38524:1', 'kitsu:41982:1'],
    });
  });

  it('structure indisponible ou titre d’addon : identifiant calculé, sans identifiant d’anime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await episodeIds({ id: '14291', season: 2, episode: 5 }, 'tt1')).toEqual({ streamId: 'tt1:2:5', season: 2, episode: 5, altIds: [] });
    // Identifiant de flux d'un addon : pas de la forme tt:saison:épisode, saison et épisode de l'affichage gardés.
    expect(await episodeIds({ id: 'addon-x', season: 1, episode: 2, streamId: 'kitsu:99:2' }, 'tt1')).toEqual({ streamId: 'kitsu:99:2', season: 1, episode: 2, altIds: [] });
  });

  it('recherche de sources : les identifiants d’anime partent dans ?alt=', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ streams: [] }), { status: 200 });
    }));
    await fetchStreamsResult('tv', 'tt2560140', 4, 1, { torrents: true, streamId: 'tt2560140:3:13', altIds: ['mal:38524:1', 'kitsu:41982:1'] });
    expect(calls[0]).toContain('/stream/series/tt2560140:3:13.json?torrents=1&alt=mal%3A38524%3A1,kitsu%3A41982%3A1');
  });
});
